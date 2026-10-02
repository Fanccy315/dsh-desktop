/**
 * 三个案例的定向注入。
 *
 * 案例 SKU 固定占用 90001/90002 编号段（下方常量），generate.ts 的随机生成
 * 不覆盖该段；每个 inject* 独立写全该案例的主数据/库存/流水/单据行，
 * 可任意顺序调用。呆滞成因不落新列：定制件 = 名称前缀「定制」、
 * 待检滞留 = 库位前缀 QC-、超量采购 = 其余，由 W3 呆滞料工具按信号归类。
 */
import type { DatabaseSync } from "node:sqlite";

/** 案例一（呆滞拦截）：成品仓定制控制器组件，库龄 120 天、近 60 天无出库、积压约 130 万元。 */
export const CASE1_SKU = "FG-90001";
/** 案例二（缺料预警）：铝合金锭及其用料工单，开工日 = 演示日 + 6 天，库存 + 在途不足。 */
export const CASE2_SKU = "RM-90001";
export const CASE2_PARENT = "FG-90002";
export const CASE2_WORK_ORDER = "WO-90002";
export const CASE2_PURCHASE_ORDER = "PO-90001";
/** 案例三（账实偏差）：内六角螺栓 M6×20，紧急出库未录 ERP。 */
export const CASE3_SKU = "AU-90001";

// —— 案例 SKU 的报告口径参数（generate.ts 验证时逐项断言）——
export const CASE3_QTY_BOOK = 5200;
export const CASE3_QTY_PHYSICAL = 4830;
/** 案例三偏差率（%）：370 / 5200。报告原文 7.2%，偏差方向修正为「账面 > 实物」。 */
export const CASE3_DEVIATION_PCT =
  ((CASE3_QTY_BOOK - CASE3_QTY_PHYSICAL) / CASE3_QTY_BOOK) * 100;
export const CASE2_WO_QTY = 400;
export const CASE2_QTY_PER = 12;
export const CASE2_STOCK = 1800;
export const CASE2_IN_TRANSIT = 800;
/** 案例二铝合金锭单价（元/件），generate.ts 计呆滞目标额时引用。 */
export const CASE2_UNIT_PRICE = 18.5;
export const CASE2_LEAD_DAYS = 6;
/** 案例一积压金额（元）：2450 × 530 ≈ 130 万。 */
export const CASE1_VALUE_YUAN = 2450 * 530;

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** 注入共用句柄：目标库、演示基准时刻（UTC 毫秒）与确定性随机整数。 */
export interface ScenarioContext {
  db: DatabaseSync;
  now: number;
  /** 毫秒 → 'YYYY-MM-DD HH:MM:SS'（UTC）。 */
  fmt: (ms: number) => string;
  /** now + N 天 → 'YYYY-MM-DD'。 */
  dateStr: (offsetDays: number) => string;
  int: (min: number, max: number) => number;
}

interface MaterialRow {
  sku: string;
  name: string;
  spec: string;
  warehouse: string;
  abc: string;
  xyz: string;
  price: number;
  safety: number;
  lead: number;
  supplier: string;
}

function insertMaterial(ctx: ScenarioContext, row: MaterialRow): void {
  ctx.db
    .prepare(
      `
    INSERT INTO materials (sku, name, spec, warehouse, abc_class, xyz_class, unit_price, safety_stock, lead_time_days, supplier)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.sku,
      row.name,
      row.spec,
      row.warehouse,
      row.abc,
      row.xyz,
      row.price,
      row.safety,
      row.lead,
      row.supplier,
    );
}

interface MoveRow {
  sku: string;
  warehouse: string;
  direction: "in" | "out";
  qty: number;
  movedAt: number;
  source: string;
}

function insertMoves(ctx: ScenarioContext, rows: readonly MoveRow[]): void {
  const stmt = ctx.db.prepare(
    "INSERT INTO movements (sku, warehouse, direction, qty, moved_at, source) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const r of rows)
    stmt.run(
      r.sku,
      r.warehouse,
      r.direction,
      r.qty,
      ctx.fmt(r.movedAt),
      r.source,
    );
}

function insertStock(
  ctx: ScenarioContext,
  sku: string,
  warehouse: string,
  book: number,
  physical: number,
  inTransit: number,
  location: string,
  lastMoveAt: number,
): void {
  ctx.db
    .prepare(
      "INSERT INTO stock_erp (sku, warehouse, qty_book, qty_allocated, qty_in_transit) VALUES (?, ?, ?, 0, ?)",
    )
    .run(sku, warehouse, book, inTransit);
  ctx.db
    .prepare(
      "INSERT INTO stock_wms (sku, warehouse, qty_physical, location, last_move_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(sku, warehouse, physical, location, ctx.fmt(lastMoveAt));
}

/**
 * 案例一：120 天前整批入库 2600 件（530 元/件），其后零星出库 150 件，
 * 最后一次出库在 65 天前 → 库龄 120 天、近 60 天无出库、账面 2450 件 ≈ 130 万元。
 */
export function injectCase1(ctx: ScenarioContext): void {
  const { now } = ctx;
  insertMaterial(ctx, {
    sku: CASE1_SKU,
    name: "定制控制器组件 CJ-X9",
    spec: "JX-Ctrl-X9 REV.B",
    warehouse: "成品仓",
    abc: "B",
    xyz: "Z",
    price: 530,
    safety: 200,
    lead: 30,
    supplier: "天工机械",
  });
  insertMoves(ctx, [
    {
      sku: CASE1_SKU,
      warehouse: "成品仓",
      direction: "in",
      qty: 2600,
      movedAt: now - 120 * DAY + 10 * HOUR,
      source: "正常",
    },
    {
      sku: CASE1_SKU,
      warehouse: "成品仓",
      direction: "out",
      qty: 40,
      movedAt: now - 110 * DAY + 9 * HOUR,
      source: "正常",
    },
    {
      sku: CASE1_SKU,
      warehouse: "成品仓",
      direction: "out",
      qty: 35,
      movedAt: now - 95 * DAY + 14 * HOUR,
      source: "正常",
    },
    {
      sku: CASE1_SKU,
      warehouse: "成品仓",
      direction: "out",
      qty: 45,
      movedAt: now - 80 * DAY + 11 * HOUR,
      source: "正常",
    },
    {
      sku: CASE1_SKU,
      warehouse: "成品仓",
      direction: "out",
      qty: 30,
      movedAt: now - 65 * DAY + 15 * HOUR,
      source: "正常",
    },
  ]);
  insertStock(
    ctx,
    CASE1_SKU,
    "成品仓",
    2450,
    2450,
    0,
    "C-02-11",
    now - 65 * DAY + 15 * HOUR,
  );
}

/**
 * 案例二：铝合金锭账面 1800、在途 800；工单 WO-90002（变速箱壳体 400 件）
 * 6 天后开工，单耗 12 → 需 4800 > 2600，缺口 2200，可在开工前 6 天预警。
 * 其余 4 种辅料件库存充足，保证缺口仅落在铝合金锭上。
 */
export function injectCase2(ctx: ScenarioContext): void {
  const { now, dateStr } = ctx;
  insertMaterial(ctx, {
    sku: CASE2_SKU,
    name: "铝合金锭",
    spec: "A356 φ178×550mm",
    warehouse: "原材料仓",
    abc: "A",
    xyz: "X",
    price: 18.5,
    safety: 1200,
    lead: 14,
    supplier: "华东铝业",
  });
  const outDays = [-38, -33, -28, -23, -18, -13, -8, -2];
  insertMoves(ctx, [
    {
      sku: CASE2_SKU,
      warehouse: "原材料仓",
      direction: "in",
      qty: 3400,
      movedAt: now - 40 * DAY + 9 * HOUR,
      source: "正常",
    },
    ...outDays.map(
      (d): MoveRow => ({
        sku: CASE2_SKU,
        warehouse: "原材料仓",
        direction: "out",
        qty: 200,
        movedAt: now + d * DAY + 13 * HOUR,
        source: "正常",
      }),
    ),
  ]);
  insertStock(
    ctx,
    CASE2_SKU,
    "原材料仓",
    CASE2_STOCK,
    CASE2_STOCK,
    CASE2_IN_TRANSIT,
    "A-05-08",
    now - 2 * DAY + 13 * HOUR,
  );
  ctx.db
    .prepare(
      "INSERT INTO purchase_orders (po_id, sku, qty, eta, status) VALUES (?, ?, ?, ?, ?)",
    )
    .run(CASE2_PURCHASE_ORDER, CASE2_SKU, CASE2_IN_TRANSIT, dateStr(4), "在途");

  insertMaterial(ctx, {
    sku: CASE2_PARENT,
    name: "铝合金变速箱壳体",
    spec: "JX-200 压铸件",
    warehouse: "成品仓",
    abc: "B",
    xyz: "X",
    price: 860,
    safety: 60,
    lead: 20,
    supplier: "华盛压铸",
  });
  insertMoves(ctx, [
    {
      sku: CASE2_PARENT,
      warehouse: "成品仓",
      direction: "in",
      qty: 500,
      movedAt: now - 30 * DAY + 8 * HOUR,
      source: "正常",
    },
    {
      sku: CASE2_PARENT,
      warehouse: "成品仓",
      direction: "out",
      qty: 80,
      movedAt: now - 27 * DAY + 10 * HOUR,
      source: "正常",
    },
    {
      sku: CASE2_PARENT,
      warehouse: "成品仓",
      direction: "out",
      qty: 100,
      movedAt: now - 20 * DAY + 9 * HOUR,
      source: "正常",
    },
    {
      sku: CASE2_PARENT,
      warehouse: "成品仓",
      direction: "out",
      qty: 90,
      movedAt: now - 12 * DAY + 14 * HOUR,
      source: "正常",
    },
    {
      sku: CASE2_PARENT,
      warehouse: "成品仓",
      direction: "out",
      qty: 110,
      movedAt: now - 5 * DAY + 11 * HOUR,
      source: "正常",
    },
  ]);
  insertStock(
    ctx,
    CASE2_PARENT,
    "成品仓",
    120,
    120,
    0,
    "C-04-02",
    now - 5 * DAY + 11 * HOUR,
  );

  // BOM：铝合金锭单耗 12；其余用料件库存 ≥ 2500、单耗 ≤ 2 → 400 件工单下必然齐套
  const ample = ctx.db
    .prepare(
      `
    SELECT m.sku FROM materials m
    JOIN stock_erp e ON e.sku = m.sku AND e.warehouse = m.warehouse
    WHERE m.warehouse = '原材料仓' AND m.sku <> ? AND e.qty_book >= 2500
    ORDER BY m.sku LIMIT 4`,
    )
    .all(CASE2_SKU) as Array<{ sku: string }>;
  const insertBom = ctx.db.prepare(
    "INSERT INTO bom (parent_sku, component_sku, qty_per) VALUES (?, ?, ?)",
  );
  insertBom.run(CASE2_PARENT, CASE2_SKU, CASE2_QTY_PER);
  ample.forEach((row, i) =>
    insertBom.run(CASE2_PARENT, row.sku, i === 0 ? 2 : 1),
  );

  ctx.db
    .prepare(
      "INSERT INTO work_orders (wo_id, sku, qty, start_date, status) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      CASE2_WORK_ORDER,
      CASE2_PARENT,
      CASE2_WO_QTY,
      dateStr(CASE2_LEAD_DAYS),
      "已下达",
    );
}

/**
 * 案例三：ERP 账面 5200、WMS 实物 4830，偏差 370 件（7.1%），
 * 来源为两次紧急出库未录 ERP（流水 source 已标注）。
 */
export function injectCase3(ctx: ScenarioContext): void {
  const { now } = ctx;
  insertMaterial(ctx, {
    sku: CASE3_SKU,
    name: "内六角螺栓 M6×20",
    spec: "12.9级 达克罗",
    warehouse: "辅料仓",
    abc: "A",
    xyz: "X",
    price: 0.35,
    safety: 1500,
    lead: 7,
    supplier: "汇泰标准件",
  });
  insertMoves(ctx, [
    {
      sku: CASE3_SKU,
      warehouse: "辅料仓",
      direction: "in",
      qty: 6000,
      movedAt: now - 21 * DAY + 8 * HOUR,
      source: "正常",
    },
    {
      sku: CASE3_SKU,
      warehouse: "辅料仓",
      direction: "out",
      qty: 300,
      movedAt: now - 19 * DAY + 10 * HOUR,
      source: "正常",
    },
    {
      sku: CASE3_SKU,
      warehouse: "辅料仓",
      direction: "out",
      qty: 280,
      movedAt: now - 15 * DAY + 9 * HOUR,
      source: "正常",
    },
    {
      sku: CASE3_SKU,
      warehouse: "辅料仓",
      direction: "out",
      qty: 220,
      movedAt: now - 10 * DAY + 15 * HOUR,
      source: "正常",
    },
    {
      sku: CASE3_SKU,
      warehouse: "辅料仓",
      direction: "out",
      qty: 210,
      movedAt: now - 9 * DAY + 11 * HOUR,
      source: "紧急出库未录ERP",
    },
    {
      sku: CASE3_SKU,
      warehouse: "辅料仓",
      direction: "out",
      qty: 160,
      movedAt: now - 3 * DAY + 16 * HOUR,
      source: "紧急出库未录ERP",
    },
  ]);
  insertStock(
    ctx,
    CASE3_SKU,
    "辅料仓",
    CASE3_QTY_BOOK,
    CASE3_QTY_PHYSICAL,
    0,
    "D-01-07",
    now - 3 * DAY + 16 * HOUR,
  );
}
