/**
 * JC 模拟数据生成。产出 data/jc.db 供 jcInventoryData 服务只读。
 * 两个消费入口共用本模块：CLI 包装 generator/generate.ts（yarn gen，离线）与
 * 运行时工具 inv_prepare_demo_db（智能体在对话中生成演示库，SPEC §9.1）。
 *
 * 全部随机性经 mulberry32(seed)，同一 seed + 同一 as-of 重跑得到逐行一致的库。
 * 基线数值（高风险 SKU 数 / 平均偏差率 / 呆滞占比 / 齐套率）按报告口径定向校准，
 * 生成结束自检，超 ±10% 时 passed 为 false（CLI 形态据此置退出码，SPEC §11-3）。
 * 案例注入见 scenarios.ts。
 */
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  CASE1_SKU,
  CASE1_VALUE_YUAN,
  CASE2_IN_TRANSIT,
  CASE2_LEAD_DAYS,
  CASE2_PARENT,
  CASE2_QTY_PER,
  CASE2_STOCK,
  CASE2_UNIT_PRICE,
  CASE2_WO_QTY,
  CASE2_WORK_ORDER,
  CASE3_DEVIATION_PCT,
  CASE3_QTY_BOOK,
  CASE3_QTY_PHYSICAL,
  CASE3_SKU,
  type ScenarioContext,
  injectCase1,
  injectCase2,
  injectCase3,
} from "./scenarios.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;
/** 流水回溯窗口（天），即需求预测可用的历史长度。 */
const HISTORY_DAYS = 180;

/** 报告口径校准目标，验收容差 ±10%（SPEC §6 / §11-3）。 */
const CAL = {
  rawSkuCount: 1600,
  auxSkuCount: 800,
  semiSkuCount: 400,
  fgSkuCount: 425,
  rawValueTotal: 25_000_000, // 原材料库存总额 ≈ 2500 万元
  highRiskTotal: 187, // 偏差率 > 5% 的 SKU 数（含案例三）
  highRiskMeanDevPct: 18.3, // 高风险 SKU 内平均偏差率
  deviationThresholdPct: 5,
  deadStockSharePct: 16.7, // 呆滞占原材料库存总额
  horizonWoOk: 13, // 7 天展望期内齐套工单数
  horizonWoShort: 8, // 缺料工单数（含案例二）→ 齐套率 13/21 ≈ 62%
  beyondWoCount: 10, // 展望期外的排产工单（不计入齐套率）
  defaultSeed: 20260701,
} as const;

/** 缺省随机种子（CLI 与 inv_prepare_demo_db 共用，保证演示可复现）。 */
export const DEFAULT_SEED: number = CAL.defaultSeed;

const SCHEMA = `
CREATE TABLE materials (
  sku TEXT PRIMARY KEY, name TEXT NOT NULL, spec TEXT NOT NULL, warehouse TEXT NOT NULL,
  abc_class TEXT NOT NULL, xyz_class TEXT NOT NULL, unit_price REAL NOT NULL,
  safety_stock INTEGER NOT NULL, lead_time_days INTEGER NOT NULL, supplier TEXT NOT NULL
);
CREATE TABLE stock_erp (
  sku TEXT NOT NULL, warehouse TEXT NOT NULL, qty_book INTEGER NOT NULL,
  qty_allocated INTEGER NOT NULL, qty_in_transit INTEGER NOT NULL,
  PRIMARY KEY (sku, warehouse)
);
CREATE TABLE stock_wms (
  sku TEXT NOT NULL, warehouse TEXT NOT NULL, qty_physical INTEGER NOT NULL,
  location TEXT NOT NULL, last_move_at TEXT NOT NULL,
  PRIMARY KEY (sku, warehouse)
);
CREATE TABLE movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL, warehouse TEXT NOT NULL,
  direction TEXT NOT NULL, qty INTEGER NOT NULL, moved_at TEXT NOT NULL, source TEXT NOT NULL
);
CREATE TABLE work_orders (
  wo_id TEXT PRIMARY KEY, sku TEXT NOT NULL, qty INTEGER NOT NULL,
  start_date TEXT NOT NULL, status TEXT NOT NULL
);
CREATE TABLE bom (
  parent_sku TEXT NOT NULL, component_sku TEXT NOT NULL, qty_per REAL NOT NULL,
  PRIMARY KEY (parent_sku, component_sku)
);
CREATE TABLE purchase_orders (
  po_id TEXT PRIMARY KEY, sku TEXT NOT NULL, qty INTEGER NOT NULL,
  eta TEXT NOT NULL, status TEXT NOT NULL
);
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, sku TEXT,
  severity TEXT NOT NULL, title TEXT NOT NULL, detail_json TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL, suggested_qty INTEGER NOT NULL,
  suggested_date TEXT NOT NULL, reason_json TEXT NOT NULL, status TEXT NOT NULL,
  buyer_note TEXT
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX idx_movements_sku ON movements (sku, moved_at);
CREATE INDEX idx_bom_parent ON bom (parent_sku);
CREATE INDEX idx_wo_start ON work_orders (start_date);
`;

interface Family {
  readonly name: string;
  readonly specs: readonly string[];
  readonly price: readonly [number, number];
}

const RAW_FAMILIES: readonly Family[] = [
  {
    name: "铝合金锭",
    specs: [
      "ADC12 φ150×480mm",
      "6063 板锭 640×240",
      "ZL104 φ220",
      "A356T6 φ180×560",
    ],
    price: [15, 24],
  },
  {
    name: "冷轧钢板",
    specs: [
      "SPCC 1.5×1250×2500",
      "SPCC 2.0×1250×2500",
      "DC01 0.8×1000×2000",
      "SPHC 3.0×1500×3000",
    ],
    price: [4, 7],
  },
  {
    name: "不锈钢圆棒",
    specs: ["304 φ20", "304 φ32", "316L φ25", "304 φ45"],
    price: [13, 22],
  },
  {
    name: "紫铜线",
    specs: ["T2 φ1.5", "T2 φ2.0", "TU1 φ0.8"],
    price: [58, 82],
  },
  {
    name: "ABS塑胶粒",
    specs: ["757K 25kg/袋", "HI-121 25kg/袋", "PA757K 阻燃"],
    price: [11, 18],
  },
  {
    name: "轴承钢",
    specs: ["GCr15 φ50", "GCr15 φ65", "SUJ2 φ40"],
    price: [8, 13],
  },
  {
    name: "硅钢片",
    specs: ["50WW800 0.5mm", "35WW300 0.35mm"],
    price: [6, 10],
  },
  {
    name: "环氧树脂",
    specs: ["E-44 200kg桶", "E-51 200kg桶", "固化剂 T-31"],
    price: [17, 28],
  },
];
const AUX_FAMILIES: readonly Family[] = [
  {
    name: "内六角螺栓",
    specs: [
      "M4×16 12.9级",
      "M5×20 12.9级",
      "M8×25 12.9级",
      "M10×30 12.9级",
      "M12×40 12.9级",
    ],
    price: [0.08, 0.9],
  },
  {
    name: "六角螺母",
    specs: ["M4 8级", "M8 8级", "M10 8级", "M12 8级"],
    price: [0.03, 0.3],
  },
  {
    name: "平垫圈",
    specs: ["M4 200型", "M8 200型", "M10 200型"],
    price: [0.01, 0.08],
  },
  {
    name: "波纹纸箱",
    specs: ["400×300×250 5层", "500×400×300 5层", "600×400×400 3层"],
    price: [1.2, 3.8],
  },
  {
    name: "缠绕膜",
    specs: ["500mm×300m 20μm", "450mm×150m 17μm"],
    price: [8, 15],
  },
  { name: "标签纸", specs: ["热敏 100×150", "铜版 60×40"], price: [0.02, 0.1] },
  { name: "液压油", specs: ["L-HM46 18L", "L-HM68 18L"], price: [180, 260] },
  { name: "轴承", specs: ["6205-2RS", "6308-ZZ", "6001-2RS"], price: [1.5, 9] },
];
const SEMI_FAMILIES: readonly Family[] = [
  {
    name: "机加工壳体",
    specs: ["CNC 工序20", "CNC 工序35 精铣"],
    price: [40, 220],
  },
  { name: "焊接支架", specs: ["Q235 氩弧焊", "304 激光焊"], price: [25, 120] },
  { name: "定子绕组", specs: ["0.75kW 铜线", "2.2kW 铜线"], price: [80, 300] },
  { name: "注塑面板", specs: ["ABS 黑色亚光", "PC 透明"], price: [8, 55] },
];
const FG_FAMILIES: readonly Family[] = [
  {
    name: "减速电机",
    specs: ["JX 系列 0.75kW", "JX 系列 2.2kW", "JX 系列 5.5kW"],
    price: [600, 2800],
  },
  {
    name: "伺服控制器",
    specs: ["SV-400 4轴", "SV-800 8轴"],
    price: [900, 3600],
  },
  { name: "工业泵", specs: ["离心泵 50mm", "齿轮泵 25mm"], price: [500, 2200] },
  { name: "变频器模块", specs: ["VFD-7.5kW", "VFD-15kW"], price: [700, 3000] },
];
const SUPPLIERS = [
  "华东铝业",
  "江城钢铁",
  "南方铜业",
  "汇泰标准件",
  "蓝鲸包装",
  "天工机械",
  "恒泰化工",
  "正大轴承",
  "鑫盛塑胶",
  "中实硅钢",
  "孚迪液压",
  "奥新金属",
] as const;

type AbcClass = "A" | "B" | "C";
type XyzClass = "X" | "Y" | "Z";
type Direction = "in" | "out";

interface MoveEvent {
  ms: number;
  direction: Direction;
  qty: number;
  source: string;
}

interface SkuPlan {
  code: string;
  name: string;
  spec: string;
  warehouse: string;
  price: number;
  qty: number;
  abc: AbcClass;
  xyz: XyzClass;
  weekly: number;
  lead: number;
  safety: number;
  supplier: string;
  dead: boolean;
  book: number;
  physical: number;
  inTransit: number;
  lastMoveMs: number;
  location: string;
  events: MoveEvent[];
}

/** mulberry32 确定性随机源；所有随机性必须经此，保证同 seed 可复现。 */
class Rng {
  #s: number;
  constructor(seed: number) {
    this.#s = seed >>> 0;
  }
  next(): number {
    this.#s = (this.#s + 0x6d2b79f5) >>> 0;
    let t = this.#s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
  int(min: number, max: number): number {
    return Math.floor(this.float(min, max + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

function shuffle<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 生成一组物料计划：编号、名称规格（族 × 规格 × 供应商区分）、单价、提前期。
 * @param qtyRange 非原材料组的库存量范围；原材料传 null，由价值校准回填。
 */
function buildGroup(
  prefix: string,
  count: number,
  families: readonly Family[],
  warehouse: string,
  leadRange: readonly [number, number],
  qtyRange: readonly [number, number] | null,
  rng: Rng,
): SkuPlan[] {
  const plans: SkuPlan[] = [];
  for (let i = 1; i <= count; i++) {
    const family = families[(i - 1) % families.length]!;
    const baseSpec =
      family.specs[
        Math.floor((i - 1) / families.length) % family.specs.length
      ]!;
    const supplier = rng.pick(SUPPLIERS);
    plans.push({
      code: `${prefix}-${String(i).padStart(5, "0")}`,
      name: family.name,
      spec: `${baseSpec} · ${supplier.slice(0, 2)}`,
      warehouse,
      price: round2(rng.float(family.price[0], family.price[1])),
      qty: qtyRange ? rng.int(qtyRange[0], qtyRange[1]) : 0,
      abc: "C",
      xyz: "X",
      weekly: 0,
      lead: rng.int(leadRange[0], leadRange[1]),
      safety: 0,
      supplier,
      dead: false,
      book: 0,
      physical: 0,
      inTransit: 0,
      lastMoveMs: 0,
      location: "",
      events: [],
    });
  }
  return plans;
}

/** 把价值残差加到组内价值最大的 SKU 数量上，使组总价值收敛到目标。 */
function absorbValue(plans: readonly SkuPlan[], value: number): void {
  if (plans.length === 0 || Math.round(value) === 0) return;
  const target = plans.reduce((a, b) =>
    b.qty * b.price > a.qty * a.price ? b : a,
  );
  target.qty = Math.max(1, target.qty + Math.round(value / target.price));
}

/** 原材料价值校准：对数正态权重分摊总价值 → 取整数量 → 残差吸收。 */
function calibrateValue(
  plans: readonly SkuPlan[],
  total: number,
  rng: Rng,
): void {
  const weights = plans.map(() => Math.exp(rng.float(-1.6, 1.6)));
  const wSum = weights.reduce((a, b) => a + b, 0);
  for (const [i, p] of plans.entries())
    p.qty = Math.max(1, Math.round((total * weights[i]!) / wSum / p.price));
  const actual = plans.reduce((s, p) => s + p.qty * p.price, 0);
  absorbValue(plans, total - actual);
}

/**
 * 选定呆滞集（仅原材料）：随机累加到目标价值，末件削减数量补齐，
 * 削掉的价值返还非呆滞件，原材料总额不变。成因三选一轮转：
 * 定制件（名称加前缀）/ 超量采购（普通库位）/ 待检滞留（QC 库位）。
 */
function chooseDead(
  rawPlans: SkuPlan[],
  valueTarget: number,
  rng: Rng,
  asOfMs: number,
): void {
  const pool = shuffle([...rawPlans], rng);
  const dead: SkuPlan[] = [];
  let acc = 0;
  for (const p of pool) {
    if (acc >= valueTarget) break;
    dead.push(p);
    acc += p.qty * p.price;
  }
  const last = dead[dead.length - 1]!;
  const over = acc - valueTarget;
  if (over > 0) {
    const cut = Math.min(last.qty - 1, Math.floor(over / last.price));
    if (cut > 0) {
      last.qty -= cut;
      absorbValue(
        rawPlans.filter((p) => !dead.includes(p)),
        cut * last.price,
      );
    }
  }
  const zone = (): string =>
    `A-${String(rng.int(1, 12)).padStart(2, "0")}-${String(rng.int(1, 30)).padStart(2, "0")}`;
  dead.forEach((p, i) => {
    p.dead = true;
    p.book = p.qty;
    p.physical = p.qty;
    p.lastMoveMs = asOfMs - rng.int(190, 400) * DAY + 10 * HOUR;
    if (i % 3 === 0) {
      p.name = `定制${p.name}`;
      p.location = zone();
    } else if (i % 3 === 1) p.location = zone();
    else p.location = `QC-待检-${String(rng.int(1, 20)).padStart(2, "0")}`;
  });
}

/** 组内按价值累计份额定 ABC（70%/90%），再按 ABC 概率定 XYZ 需求模式。 */
function assignAbcXyz(group: readonly SkuPlan[], rng: Rng): void {
  const sorted = [...group].sort((a, b) => b.qty * b.price - a.qty * a.price);
  const total = sorted.reduce((s, p) => s + p.qty * p.price, 0);
  let cum = 0;
  for (const p of sorted) {
    cum += p.qty * p.price;
    p.abc = cum / total <= 0.7 ? "A" : cum / total <= 0.9 ? "B" : "C";
  }
  for (const p of group) {
    const r = rng.next();
    p.xyz =
      p.abc === "A"
        ? r < 0.75
          ? "X"
          : "Y"
        : p.abc === "B"
          ? r < 0.45
            ? "X"
            : r < 0.8
              ? "Y"
              : "Z"
          : r < 0.1
            ? "X"
            : r < 0.4
              ? "Y"
              : "Z";
  }
}

/**
 * 单 SKU 180 天流水模拟：按 XYZ 模式周消耗，低于再订货点补货；
 * 期末用一笔收发货调整流水把账面锚定在校准目标 p.qty 上（保证原材料总额）。
 */
function simulate(p: SkuPlan, rng: Rng, asOfMs: number): void {
  const ts = (day: number): number =>
    asOfMs -
    (HISTORY_DAYS - day) * DAY +
    rng.int(8, 17) * HOUR +
    rng.int(0, 59) * MINUTE;
  const events: MoveEvent[] = [];
  const target = p.qty;
  const weekly = Math.max(1, Math.round(target / 12));
  const opening = Math.max(
    weekly * rng.int(5, 8),
    Math.round(target * rng.float(0.7, 1)),
  );
  events.push({ ms: ts(0), direction: "in", qty: opening, source: "正常" });
  let stock = opening;
  let lastMoveMs = events[0]!.ms;
  const dow = rng.int(0, 6);
  const trendUp = rng.chance(0.5);
  const phase = rng.float(0, Math.PI * 2);
  let pending: Array<{ day: number; qty: number }> = [];
  let orderedAt = -99;
  for (let day = 1; day < HISTORY_DAYS; day++) {
    for (const arrival of pending.filter((a) => a.day === day)) {
      stock += arrival.qty;
      const ms = ts(day);
      events.push({ ms, direction: "in", qty: arrival.qty, source: "正常" });
      lastMoveMs = Math.max(lastMoveMs, ms);
    }
    pending = pending.filter((a) => a.day !== day);
    if (day % 7 === dow) {
      const factor =
        p.xyz === "X"
          ? rng.float(0.85, 1.15)
          : p.xyz === "Y"
            ? (trendUp
                ? 0.6 + (1.6 * day) / HISTORY_DAYS
                : 0.7 +
                  0.6 * Math.sin((day / HISTORY_DAYS) * 4 * Math.PI + phase)) *
              rng.float(0.9, 1.1)
            : rng.chance(0.3)
              ? rng.float(2, 4)
              : 0;
      const qty = Math.round(weekly * factor);
      if (qty > 0 && stock > qty) {
        stock -= qty;
        const ms = ts(day);
        events.push({ ms, direction: "out", qty, source: "正常" });
        lastMoveMs = Math.max(lastMoveMs, ms);
      }
    }
    if (stock < weekly * 3 && day - orderedAt > 7 && day < HISTORY_DAYS - 21) {
      const qty = weekly * rng.int(3, 6);
      pending.push({
        day: Math.min(day + rng.int(3, Math.max(4, p.lead)), HISTORY_DAYS - 1),
        qty,
      });
      orderedAt = day;
    }
  }
  const adjust = target - stock;
  if (adjust !== 0) {
    const ms = ts(rng.int(170, 179));
    events.push({
      ms,
      direction: adjust > 0 ? "in" : "out",
      qty: Math.abs(adjust),
      source: "正常",
    });
    lastMoveMs = Math.max(lastMoveMs, ms);
    stock = target;
  }
  p.book = stock;
  p.physical = stock;
  p.lastMoveMs = lastMoveMs;
  p.events = events;
  const zone =
    p.warehouse === "原材料仓"
      ? "A"
      : p.warehouse === "半成品仓"
        ? "B"
        : p.warehouse === "成品仓"
          ? "C"
          : "D";
  p.location = `${zone}-${String(rng.int(1, 12)).padStart(2, "0")}-${String(rng.int(1, 30)).padStart(2, "0")}`;
}

/**
 * 采样 n 个高风险偏差率（双峰混合），两轮缩放钳位后总和精确等于 targetSum。
 * 钳位下限 5.6% 保证全部越过 5% 判定线，上限 55% 与紧急出库占账面上限一致。
 */
function sampleDeviations(n: number, targetSum: number, rng: Rng): number[] {
  const values = Array.from({ length: n }, (_, i) =>
    i % 5 < 3 ? rng.float(5.8, 12.5) : rng.float(13, 45),
  );
  for (let round = 0; round < 2; round++) {
    const sum = values.reduce((a, b) => a + b, 0);
    const scale = targetSum / sum;
    for (const [i, v] of values.entries())
      values[i] = Math.min(55, Math.max(5.6, v * scale));
  }
  return values;
}

/** 注入账实偏差：近 30 天内 1–3 笔「紧急出库未录ERP」流水，实物 = 账面 − 紧急量。 */
function injectDeviation(
  p: SkuPlan,
  devPct: number,
  rng: Rng,
  asOfMs: number,
): void {
  const ts = (day: number): number =>
    asOfMs -
    (HISTORY_DAYS - day) * DAY +
    rng.int(8, 17) * HOUR +
    rng.int(0, 59) * MINUTE;
  let qty = Math.max(1, Math.round((p.book * devPct) / 100));
  const cap = Math.floor(p.book * 0.55);
  if (qty > cap) qty = Math.max(1, cap);
  const parts = rng.int(1, 3);
  const base = Math.floor(qty / parts);
  for (let i = 0; i < parts; i++) {
    const part = i === parts - 1 ? qty - base * (parts - 1) : base;
    if (part <= 0) continue;
    const ms = ts(rng.int(150, 179));
    p.events.push({
      ms,
      direction: "out",
      qty: part,
      source: "紧急出库未录ERP",
    });
    p.lastMoveMs = Math.max(p.lastMoveMs, ms);
  }
  p.physical = p.book - qty;
}

/** 通用成品 BOM：3–7 种原材料 + 1–3 种辅料，单耗 1–12。 */
function buildBom(
  db: DatabaseSync,
  raws: readonly string[],
  auxs: readonly string[],
  fgPlans: readonly SkuPlan[],
  rng: Rng,
): void {
  const insert = db.prepare(
    "INSERT INTO bom (parent_sku, component_sku, qty_per) VALUES (?, ?, ?)",
  );
  for (const fg of fgPlans) {
    const comps = new Set<string>();
    while (comps.size < rng.int(3, 7)) comps.add(rng.pick(raws));
    const target = comps.size + rng.int(1, 3);
    while (comps.size < target) comps.add(rng.pick(auxs));
    for (const c of comps) insert.run(fg.code, c, rng.int(1, 12));
  }
}

interface WoCandidate {
  sku: string;
  ratioMin: number;
}

/**
 * 构造工单使 7 天展望期齐套率恰好 13/21：按组件可用量/单耗最小值升序，
 * 前 7 个成品造缺料工单（数量取 2.2× 最小比率，必缺），其余齐套工单取 0.55×。
 * 展望期外再排 10 张齐套工单，不计入齐套率。
 */
function buildWorkOrders(
  db: DatabaseSync,
  rng: Rng,
  dateStr: (offsetDays: number) => string,
): void {
  const fgSkus = shuffle(
    (
      db
        .prepare(
          "SELECT sku FROM materials WHERE warehouse = '成品仓' AND sku NOT IN (?, ?) ORDER BY sku",
        )
        .all(CASE1_SKU, CASE2_PARENT) as Array<{ sku: string }>
    ).map((r) => r.sku),
    rng,
  );
  const stmt = db.prepare(`
    SELECT b.qty_per, IFNULL(e.qty_book, 0) + IFNULL(e.qty_in_transit, 0) AS avail
    FROM bom b LEFT JOIN stock_erp e ON e.sku = b.component_sku
    WHERE b.parent_sku = ?`);
  const candidates: WoCandidate[] = fgSkus
    .slice(0, 40)
    .map((sku) => {
      const rows = stmt.all(sku) as Array<{ qty_per: number; avail: number }>;
      const ratioMin = Math.min(...rows.map((r) => r.avail / r.qty_per));
      return { sku, ratioMin };
    })
    .sort((a, b) => a.ratioMin - b.ratioMin);

  const insert = db.prepare(
    "INSERT INTO work_orders (wo_id, sku, qty, start_date, status) VALUES (?, ?, ?, ?, ?)",
  );
  let seq = 0;
  const addWo = (
    sku: string,
    qty: number,
    startDays: number,
    status: string,
  ): void => {
    seq += 1;
    insert.run(
      `WO-26-${String(seq).padStart(4, "0")}`,
      sku,
      qty,
      dateStr(startDays),
      status,
    );
  };
  for (const c of candidates.slice(0, CAL.horizonWoShort - 1)) {
    addWo(
      c.sku,
      Math.min(1200, Math.max(40, Math.ceil(c.ratioMin * 2.2))),
      rng.int(1, 7),
      "已下达",
    );
  }
  // 齐套工单要求 ratioMin ≥ 25，否则 floor(0.55×ratio) 取整后可能重新缺料
  for (const c of shuffle(
    candidates.slice(CAL.horizonWoShort - 1).filter((c) => c.ratioMin >= 25),
    rng,
  ).slice(0, CAL.horizonWoOk)) {
    addWo(
      c.sku,
      Math.min(1200, Math.max(10, Math.floor(c.ratioMin * 0.55))),
      rng.int(1, 7),
      "已下达",
    );
  }
  for (const c of candidates.slice(
    CAL.horizonWoShort - 1 + CAL.horizonWoOk,
    CAL.horizonWoShort - 1 + CAL.horizonWoOk + CAL.beyondWoCount,
  )) {
    addWo(
      c.sku,
      Math.min(1200, Math.max(10, Math.floor(c.ratioMin * 0.55))),
      rng.int(8, 14),
      "已排产",
    );
  }
}

function insertSettings(db: DatabaseSync): void {
  const insert = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
  insert.run("deviation.thresholdPct", "5");
  insert.run("deadstock.ageDays", "180");
  insert.run("deadstock.noMoveDays", "60");
  insert.run("shortage.horizonDays", "7");
  insert.run("replenish.serviceLevel", "0.95");
  insert.run("scan.intervalMinutes", "30");
}

interface Check {
  name: string;
  actual: string;
  target: string;
  pass: boolean;
}

function within(actual: number, target: number, tolerancePct: number): boolean {
  return (Math.abs(actual - target) / target) * 100 <= tolerancePct;
}

/** 逐项对齐报告口径自检（±10%），打印基线统计表；全部通过返回 true。 */
function verifyAndReport(
  db: DatabaseSync,
  asOfMs: number,
  fmt: (ms: number) => string,
  dateStr: (offsetDays: number) => string,
  quiet: boolean,
): boolean {
  const skuTotal = (
    db.prepare("SELECT COUNT(*) AS n FROM materials").get() as { n: number }
  ).n;
  const byWarehouse = db
    .prepare(
      "SELECT warehouse, COUNT(*) AS n FROM materials GROUP BY warehouse ORDER BY warehouse",
    )
    .all() as Array<{ warehouse: string; n: number }>;
  const rawValue = (
    db
      .prepare(
        `
    SELECT SUM(e.qty_book * m.unit_price) AS v FROM materials m
    JOIN stock_erp e ON e.sku = m.sku AND e.warehouse = m.warehouse
    WHERE m.warehouse = '原材料仓'`,
      )
      .get() as { v: number }
  ).v;
  const highRisk = db
    .prepare(
      `
    SELECT COUNT(*) AS n, AVG(dev) AS meanDev FROM (
      SELECT ABS(e.qty_book - w.qty_physical) * 100.0 / e.qty_book AS dev
      FROM stock_erp e JOIN stock_wms w ON w.sku = e.sku AND w.warehouse = e.warehouse
      WHERE e.qty_book > 0 AND ABS(e.qty_book - w.qty_physical) * 100.0 / e.qty_book > ${CAL.deviationThresholdPct}
    )`,
    )
    .get() as { n: number; meanDev: number };
  const deadValue = (
    db
      .prepare(
        `
    SELECT SUM(e.qty_book * m.unit_price) AS v FROM materials m
    JOIN stock_wms w ON w.sku = m.sku AND w.warehouse = m.warehouse
    JOIN stock_erp e ON e.sku = m.sku AND e.warehouse = m.warehouse
    WHERE m.warehouse = '原材料仓' AND w.last_move_at < ?`,
      )
      .get(fmt(asOfMs - 180 * DAY)) as { v: number }
  ).v;
  const movementCount = (
    db.prepare("SELECT COUNT(*) AS n FROM movements").get() as { n: number }
  ).n;

  // 7 天展望期齐套率：任一组件 需求(工单量×单耗) > 库存+在途 即缺料
  const wos = db
    .prepare("SELECT wo_id, sku, qty FROM work_orders WHERE start_date <= ?")
    .all(dateStr(7)) as Array<{ wo_id: string; sku: string; qty: number }>;
  const bomStmt = db.prepare(`
    SELECT b.qty_per, IFNULL(e.qty_book, 0) + IFNULL(e.qty_in_transit, 0) AS avail
    FROM bom b LEFT JOIN stock_erp e ON e.sku = b.component_sku
    WHERE b.parent_sku = ?`);
  let shortCount = 0;
  const shortWos: string[] = [];
  for (const wo of wos) {
    const rows = bomStmt.all(wo.sku) as Array<{
      qty_per: number;
      avail: number;
    }>;
    const short = rows.some((r) => wo.qty * r.qty_per > r.avail);
    if (short) {
      shortCount++;
      shortWos.push(wo.wo_id);
    }
  }
  const kitPct =
    wos.length > 0 ? ((wos.length - shortCount) / wos.length) * 100 : 0;

  const case2Avail = CASE2_STOCK + CASE2_IN_TRANSIT;
  const case1LastOut = (
    db
      .prepare(
        `
    SELECT MIN(moved_at) AS t FROM (
      SELECT moved_at FROM movements WHERE sku = ? AND direction = 'out'
        AND moved_at >= ? ORDER BY moved_at DESC LIMIT 1
    )`,
      )
      .get(CASE1_SKU, fmt(asOfMs - 60 * DAY)) as { t: string | null }
  ).t;
  const case3 = db
    .prepare(
      `
    SELECT e.qty_book AS book, w.qty_physical AS physical FROM stock_erp e
    JOIN stock_wms w ON w.sku = e.sku AND w.warehouse = e.warehouse WHERE e.sku = ?`,
    )
    .get(CASE3_SKU) as { book: number; physical: number };
  const case3Dev = (Math.abs(case3.book - case3.physical) / case3.book) * 100;

  const checks: Check[] = [
    {
      name: "SKU 总数（≥3200）",
      actual: String(skuTotal),
      target: "≥3200",
      pass: skuTotal >= 3200,
    },
    {
      name: "原材料库存总额（万元）",
      actual: (rawValue / 10_000).toFixed(1),
      target: "2500 ±10%",
      pass: within(rawValue, CAL.rawValueTotal, 10),
    },
    {
      name: "高风险 SKU 数（偏差>5%）",
      actual: String(highRisk.n),
      target: `${CAL.highRiskTotal} ±10%`,
      pass: within(highRisk.n, CAL.highRiskTotal, 10),
    },
    {
      name: "高风险 SKU 占比（%）",
      actual: ((highRisk.n / skuTotal) * 100).toFixed(2),
      target: "5.8 ±10%",
      pass: within((highRisk.n / skuTotal) * 100, 5.8, 10),
    },
    {
      name: "高风险平均偏差率（%）",
      actual: highRisk.meanDev.toFixed(1),
      target: "18.3 ±10%",
      pass: within(highRisk.meanDev, CAL.highRiskMeanDevPct, 10),
    },
    {
      name: "呆滞占原材料总额（%）",
      actual: ((deadValue / rawValue) * 100).toFixed(1),
      target: "16.7 ±10%",
      pass: within((deadValue / rawValue) * 100, CAL.deadStockSharePct, 10),
    },
    {
      name: "7 天展望期齐套率（%）",
      actual: `${kitPct.toFixed(1)}（${wos.length - shortCount}/${wos.length}）`,
      target: "62 ±10%",
      pass: within(kitPct, 62, 10),
    },
    {
      name: "案例一：近 60 天无出库",
      actual: case1LastOut === null ? "是" : `否（${case1LastOut}）`,
      target: "是",
      pass: case1LastOut === null,
    },
    {
      name: "案例一：积压金额（万元）",
      actual: (CASE1_VALUE_YUAN / 10_000).toFixed(1),
      target: "130 ±10%",
      pass: within(CASE1_VALUE_YUAN, 1_300_000, 10),
    },
    {
      name: "案例二：铝合金锭缺口（件）",
      actual: String(CASE2_WO_QTY * CASE2_QTY_PER - case2Avail),
      target: ">0（需4800-有2600=缺2200）",
      pass: CASE2_WO_QTY * CASE2_QTY_PER > case2Avail,
    },
    {
      name: `案例二：${CASE2_WORK_ORDER} 在缺料工单中`,
      actual: shortWos.includes(CASE2_WORK_ORDER) ? "是" : "否",
      target: `开工提前 ${CASE2_LEAD_DAYS} 天`,
      pass: shortWos.includes(CASE2_WORK_ORDER),
    },
    {
      name: "案例三：账面/实物",
      actual: `${case3.book}/${case3.physical}`,
      target: "5200/4830",
      pass:
        case3.book === CASE3_QTY_BOOK && case3.physical === CASE3_QTY_PHYSICAL,
    },
    {
      name: "案例三：偏差率（%）",
      actual: case3Dev.toFixed(2),
      target: "≈7.2 ±10%",
      pass: within(case3Dev, CASE3_DEVIATION_PCT, 10),
    },
  ];

  const allPass = checks.every((c) => c.pass);
  if (!quiet) {
    console.log("\n=== 基线统计（报告口径，容差 ±10%）===");
    for (const [warehouse, n] of byWarehouse.map(
      (r) => [r.warehouse, r.n] as const,
    )) {
      console.log(`  ${warehouse}: ${n} SKU`);
    }
    console.log(`  流水行数: ${movementCount}`);
    for (const c of checks) {
      console.log(
        `  ${c.pass ? "✓" : "✗"} ${c.name}: ${c.actual}（目标 ${c.target}）`,
      );
    }
    console.log(
      allPass ? "\n全部基线校验通过 ✓" : "\n存在超差项 ✗（调整校准参数后重跑）",
    );
  }
  return allPass;
}

/** 生成选项（generateSample）。 */
export interface GenerateOptions {
  /** 目标 .db 文件路径（含文件名）。 */
  path: string;
  /** 随机种子；缺省 CAL.defaultSeed。 */
  seed?: number;
  /** 演示基准时刻（UTC 毫秒）；缺省今天 UTC 零点。 */
  asOfMs?: number;
  /** 静默模式：不打印进度与基线统计表（自检结论仍体现在返回值）。 */
  quiet?: boolean;
}

/** 生成结果：写库路径、实际生效的 seed / as-of、基线自检结论。 */
export interface GenerateResult {
  path: string;
  seed: number;
  asOfMs: number;
  /** 全部基线校验（±10%）是否通过；CLI 形态据此置退出码。 */
  passed: boolean;
}

/**
 * 生成一套模拟库（SPEC §6）。同 seed + 同 as-of 逐行可复现；
 * 写库前删除目标文件及 -wal/-shm 残留。
 * @param options 见 {@link GenerateOptions}。
 */
export async function generateSample(
  options: GenerateOptions,
): Promise<GenerateResult> {
  const seed = options.seed ?? CAL.defaultSeed;
  const today = new Date();
  const asOfMs =
    options.asOfMs ??
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const rng = new Rng(seed);
  const fmt = (ms: number): string =>
    new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  const dateStr = (offsetDays: number): string =>
    fmt(asOfMs + offsetDays * DAY).slice(0, 10);
  if (!options.quiet)
    console.log(`生成 jc.db：seed=${seed}, as-of=${dateStr(0)}`);

  mkdirSync(dirname(options.path), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(options.path + suffix, { force: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(options.path);
  db.exec(SCHEMA);

  const rawPlans = buildGroup(
    "RM",
    CAL.rawSkuCount,
    RAW_FAMILIES,
    "原材料仓",
    [7, 45],
    null,
    rng,
  );
  const auxPlans = buildGroup(
    "AU",
    CAL.auxSkuCount,
    AUX_FAMILIES,
    "辅料仓",
    [3, 14],
    [500, 30000],
    rng,
  );
  const semiPlans = buildGroup(
    "SF",
    CAL.semiSkuCount,
    SEMI_FAMILIES,
    "半成品仓",
    [5, 20],
    [80, 4000],
    rng,
  );
  const fgPlans = buildGroup(
    "FG",
    CAL.fgSkuCount,
    FG_FAMILIES,
    "成品仓",
    [10, 30],
    [30, 1200],
    rng,
  );
  const allPlans = [...rawPlans, ...auxPlans, ...semiPlans, ...fgPlans];

  // 顺序敏感：先校准价值与呆滞集，再算周消耗/安全库存（依赖最终数量），最后模拟流水
  calibrateValue(rawPlans, CAL.rawValueTotal, rng);
  // 呆滞目标按含案例二铝合金锭的原材料总额计
  const deadTarget =
    (CAL.deadStockSharePct / 100) *
    (CAL.rawValueTotal + CASE2_STOCK * CASE2_UNIT_PRICE);
  chooseDead(rawPlans, deadTarget, rng, asOfMs);
  for (const p of allPlans) {
    p.weekly = Math.max(1, Math.round(p.qty / 12));
    p.safety = Math.max(1, Math.round(((p.weekly * p.lead) / 7) * 1.1));
  }
  for (const group of [rawPlans, auxPlans, semiPlans, fgPlans])
    assignAbcXyz(group, rng);
  const active = allPlans.filter((p) => !p.dead);
  for (const p of active) simulate(p, rng, asOfMs);

  // 高风险偏差注入：186 个随机 SKU + 案例三 = 187，均值校准到 18.3%
  const pool = shuffle(
    active.filter((p) => p.book >= 50),
    rng,
  );
  const deviating = pool.slice(0, CAL.highRiskTotal - 1);
  const devTargetSum =
    CAL.highRiskTotal * CAL.highRiskMeanDevPct - CASE3_DEVIATION_PCT;
  const deviations = sampleDeviations(deviating.length, devTargetSum, rng);
  deviating.forEach((p, i) => injectDeviation(p, deviations[i]!, rng, asOfMs));

  // 在途采购单（约 15% 活跃 SKU），stock_erp.qty_in_transit 与之合计一致
  const pos: Array<{ sku: string; qty: number; etaDays: number }> = [];
  for (const p of active) {
    if (p.book > 0 && rng.chance(0.15)) {
      const qty = p.weekly * rng.int(2, 5);
      p.inTransit = qty;
      pos.push({ sku: p.code, qty, etaDays: rng.int(2, 14) });
    }
  }

  // node:sqlite 无 db.transaction()，手工等价：失败回滚整批插入
  db.exec("BEGIN");
  try {
    const insertMaterial = db.prepare(`
      INSERT INTO materials (sku, name, spec, warehouse, abc_class, xyz_class, unit_price, safety_stock, lead_time_days, supplier)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertErp = db.prepare(
      "INSERT INTO stock_erp (sku, warehouse, qty_book, qty_allocated, qty_in_transit) VALUES (?, ?, ?, 0, ?)",
    );
    const insertWms = db.prepare(
      "INSERT INTO stock_wms (sku, warehouse, qty_physical, location, last_move_at) VALUES (?, ?, ?, ?, ?)",
    );
    const insertMove = db.prepare(
      "INSERT INTO movements (sku, warehouse, direction, qty, moved_at, source) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const p of allPlans) {
      insertMaterial.run(
        p.code,
        p.name,
        p.spec,
        p.warehouse,
        p.abc,
        p.xyz,
        p.price,
        p.safety,
        p.lead,
        p.supplier,
      );
      insertErp.run(p.code, p.warehouse, p.book, p.inTransit);
      insertWms.run(
        p.code,
        p.warehouse,
        p.physical,
        p.location,
        fmt(p.lastMoveMs),
      );
      for (const ev of p.events)
        insertMove.run(
          p.code,
          p.warehouse,
          ev.direction,
          ev.qty,
          fmt(ev.ms),
          ev.source,
        );
    }
    const insertPo = db.prepare(
      "INSERT INTO purchase_orders (po_id, sku, qty, eta, status) VALUES (?, ?, ?, ?, ?)",
    );
    for (const [i, po] of pos.entries())
      insertPo.run(
        `PO-26-${String(i + 1).padStart(5, "0")}`,
        po.sku,
        po.qty,
        dateStr(po.etaDays),
        "在途",
      );

    const ctx: ScenarioContext = {
      db,
      now: asOfMs,
      fmt,
      dateStr,
      int: (a, b) => rng.int(a, b),
    };
    injectCase1(ctx);
    injectCase2(ctx);
    injectCase3(ctx);

    buildBom(
      db,
      rawPlans.map((p) => p.code),
      auxPlans.map((p) => p.code),
      fgPlans,
      rng,
    );
    buildWorkOrders(db, rng, dateStr);
    insertSettings(db);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  db.exec("COMMIT");

  const ok = verifyAndReport(db, asOfMs, fmt, dateStr, options.quiet ?? false);
  db.close();
  return { path: options.path, seed, asOfMs, passed: ok };
}
