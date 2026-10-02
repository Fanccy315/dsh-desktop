/**
 * 数据契约：业务层可用的**语义化**数据访问接口。
 *
 * 这是整个插件的业务口径权威：
 * - 业务层（scans.ts / 工具）只依赖 `JcInventoryData`，
 *   永远不知道当前库的引擎、表名与 SQL；
 * - 每库一份适配器把数据搬运进契约；内置 sqlite-demo 是首个实例，
 *   也是元流程提示词里的生成范例（范例即文档，SPEC §5.2 第 6 步）；
 * - 元流程生成的代码**只**实现本接口；字段口径沉淀在本文件 JSDoc 与
 *   `defineJcInventoryProbes()` 探针断言里，生成代码必须全部通过才可激活。
 */

import type {
  AlertFilter,
  AlertRow,
  AlertStatus,
  BomLine,
  DailyOutflow,
  InboundOrder,
  InboundQuery,
  Material,
  MaterialQuery,
  Movement,
  MovementQuery,
  MovementTotal,
  MovementTotalQuery,
  NewAlert,
  NewSuggestion,
  StockQuery,
  StockView,
  SuggestionDecision,
  SuggestionRow,
  SuggestionStatus,
  WorkOrder,
  WorkOrderQuery,
} from "./types.ts";

/** 目标库方言（inv_connect_database 的 dialect）。 */
export type AdapterDialect = "sqlite" | "mysql" | "postgres";

/** 适配器自述信息（registry 状态与 inv_adapter_status 输出用）。 */
export interface AdapterInfo {
  /** registry 内唯一的适配器名称（内置如 sqlite-demo；生成产物按目标库命名）。 */
  name: string;
  dialect: AdapterDialect;
  /** builtin = 内置演示适配器（兼元流程范例）；generated = 元流程运行时产物。 */
  origin: "builtin" | "generated";
  /** 人类可读的一句话描述。 */
  description: string;
}

/** 适配器连接参数：sqlite 传库文件路径，mysql/postgres 传连接串；凭据只在内存存活。 */
export interface AdapterConnectOptions {
  path?: string;
  connectionString?: string;
}

/**
 * 一个数据适配器模块的形态（内置实现与元流程生成物一致）。
 * 纯模块、非 Cordis 插件：由 registry 动态 import 后 connect，切换走重绑定（SPEC §14）。
 */
export interface JcInventoryAdapterModule {
  info: AdapterInfo;
  /**
   * 建立连接并返回契约实现。
   * @throws 连接失败或库结构不满足最低语义（缺关键表/字段）时抛出可读错误；
   * 深层的口径缺口由探针套件在激活前报出（SPEC §5.2 第 4 步）。
   */
  connect(
    options?: AdapterConnectOptions,
  ): JcInventoryData | Promise<JcInventoryData>;
  /** 断开连接、释放资源；registry 切换适配器时调用。 */
  disconnect?(data: JcInventoryData): void;
}

/**
 * JC 库管智能体的全部数据访问语义。
 *
 * 实现约定（探针与代码评审共同把关）：
 * - 只读方法对缺失数据返回 null / 空数组，不抛异常；连接级故障才抛错；
 * - 写方法返回新行 id；条件更新未命中时返回 null；
 * - 所有时间字段为 ISO 8601 字符串（日期为 YYYY-MM-DD），可被 Date.parse 解析；
 * - 所有数量字段非 null 时 ≥ 0（movements.qty 恒 > 0，方向由 direction 表达）。
 */
export interface JcInventoryData {
  // —— 主数据 ——————————————————————————————————————————————

  /** 物料主数据查询；空条件返回全量（演示库 ≥ 3200 SKU）。 */
  listMaterials(query?: MaterialQuery): Material[];

  /**
   * BOM 展开：某成品的全部子件用量行。
   * @param parentSku 成品 SKU；无 BOM 或 SKU 不存在返回空数组。
   */
  getBom(parentSku: string): BomLine[];

  // —— 库存与流水 ——————————————————————————————————————————

  /**
   * 库存联合视图（ERP 账面 × WMS 实物合并）。
   * 不带 limit 返回全量（健康扫描、呆滞分析用）；带 keyword 为模糊查询。
   */
  getStockViews(query?: StockQuery): StockView[];

  /**
   * 出入库流水查询，过滤条件在适配器侧下推；默认按时间倒序。
   * 偏差成因检查：`{sku, sinceDays: 90, direction: 'out', source: '紧急出库未录ERP'}`
   * 是否非空即「近期有未录 ERP 的紧急出库」。
   */
  getMovements(query?: MovementQuery): Movement[];

  /** 近 N 天按 SKU 聚合的流水总量（周转率与消耗速度的原始输入）。 */
  getMovementTotals(query: MovementTotalQuery): MovementTotal[];

  /**
   * 某 SKU 近 N 天逐日出库量（仅含有出库的日期，升序）。
   * 无出库日期的补零由业务层完成（预测序列需要连续天数）。
   */
  getDailyOutflow(sku: string, days: number): DailyOutflow[];

  // —— 生产与在途 ——————————————————————————————————————————

  /**
   * 展望期内开工的未完工工单（缺料预警的毛需求来源）。
   * 语义：已返回的行均未完工，且 startDate ≤ 参考时刻 + horizonDays。
   */
  getOpenWorkOrders(query?: WorkOrderQuery): WorkOrder[];

  /**
   * 在途采购单（已下单未到货；缺料预警的在途抵扣与补货的已有量来源）。
   */
  getInboundOrders(query?: InboundQuery): InboundOrder[];

  // —— 智能体产出（alerts / suggestions）——————————————————

  /** 写入一条预警（status 落 open），返回新行 id。 */
  writeAlert(alert: NewAlert): number;

  /**
   * 同 type + sku 是否已有 open 预警（去重写入的检查步，SPEC §9.8.2）；
   * sku 为 null 时按 type 匹配库级预警。无则返回 null。
   */
  findOpenAlert(type: NewAlert["type"], sku: string | null): AlertRow | null;

  /** 预警列表查询，近优先；三项过滤均可选。 */
  listAlerts(filter?: AlertFilter): AlertRow[];

  /** 更新预警状态（open → ack/resolved）；未命中返回 null。 */
  updateAlertStatus(id: number, status: AlertStatus): AlertRow | null;

  /** 写入一条补货/紧急采购建议（status 落 pending），返回新行 id。 */
  writeSuggestion(suggestion: NewSuggestion): number;

  /** 同 SKU 是否已有 pending 建议（去重写入的检查步）；无则返回 null。 */
  findPendingSuggestion(sku: string): SuggestionRow | null;

  /** 建议列表查询，近优先；status 过滤可选。 */
  listSuggestions(status?: SuggestionStatus): SuggestionRow[];

  /**
   * 采购员审核闭环：对 pending 建议执行 confirm/adjust/reject。
   * @returns 更新后的行；id 不存在或非 pending 时返回 null。
   */
  decideSuggestion(
    id: number,
    action: SuggestionDecision,
    note?: string,
  ): SuggestionRow | null;

  // —— 配置 ——————————————————————————————————————————————

  /**
   * 读 settings 数值项（阈值配置见 SPEC §8），缺失或非法时返回 fallback。
   * 阈值调优只改 settings，不改代码。
   */
  getNumberSetting(key: string, fallback: number): number;
}

// —— 契约探针套件 ————————————————————————————————————————————
// 激活任何适配器（含元流程生成物）前，逐条真实执行（SPEC §5.2 第 4 步动态校验）。
// 每条探针的断言即字段口径：失败信息直接回喂 LLM 修订，上限 3 次。

/** 单条契约探针：run 内任何 throw 即失败，错误消息须指出违反的口径。 */
export interface ContractProbe {
  /** 探针标识（校验报告与重试对话引用）。 */
  id: string;
  /** 一句话说明验证的口径。 */
  description: string;
  /** 是否需要写权限（对只读库以降级方式运行，W3 validate.ts 处理）。 */
  writes: boolean;
  /** 对被测契约实现执行查询并断言；同步或异步。 */
  run: (data: JcInventoryData) => void | Promise<void>;
}

/** ISO 8601 / YYYY-MM-DD 可解析性断言。 */
function assertDateParseable(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(
      `${field} 必须为可解析的 ISO 8601 时间，实际为 ${JSON.stringify(value)}`,
    );
  }
}

/** 数量非负断言。 */
function assertNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} 必须为有限数且 ≥ 0，实际为 ${String(value)}`);
  }
}

/**
 * 契约探针套件：覆盖每个契约方法的结构、类型与口径断言。
 * W3 的 meta/validate.ts 逐条执行；W1 定稿口径。
 */
export function defineJcInventoryProbes(): ContractProbe[] {
  return [
    {
      id: "materials-schema",
      description: "listMaterials 返回非空，枚举/数值字段满足口径",
      writes: false,
      run(data) {
        const materials = data.listMaterials();
        if (materials.length === 0)
          throw new Error("listMaterials 返回空：库内无物料主数据");
        for (const m of materials.slice(0, 50)) {
          if (
            m.sku.trim() === "" ||
            m.name.trim() === "" ||
            m.warehouse.trim() === ""
          ) {
            throw new Error(
              `物料 ${JSON.stringify(m.sku)} 的 sku/name/warehouse 必须非空`,
            );
          }
          if (!["A", "B", "C"].includes(m.abcClass)) {
            throw new Error(
              `物料 ${m.sku} abcClass 必须为 A/B/C，实际 ${JSON.stringify(m.abcClass)}`,
            );
          }
          if (!["X", "Y", "Z"].includes(m.xyzClass)) {
            throw new Error(
              `物料 ${m.sku} xyzClass 必须为 X/Y/Z，实际 ${JSON.stringify(m.xyzClass)}`,
            );
          }
          assertNonNegative(m.unitPrice, `物料 ${m.sku} unitPrice`);
          assertNonNegative(m.safetyStock, `物料 ${m.sku} safetyStock`);
          if (!Number.isInteger(m.leadTimeDays) || m.leadTimeDays < 0) {
            throw new Error(
              `物料 ${m.sku} leadTimeDays 必须为非负整数，实际 ${String(m.leadTimeDays)}`,
            );
          }
        }
      },
    },
    {
      id: "stock-views-schema",
      description: "getStockViews 数量字段 null 或 ≥ 0，时间为 null 或可解析",
      writes: false,
      run(data) {
        const views = data.getStockViews();
        if (views.length === 0)
          throw new Error("getStockViews 返回空：库内无库存数据");
        const seen = new Set<string>();
        for (const v of views) {
          const key = `${v.sku}\u0000${v.warehouse}`;
          if (seen.has(key))
            throw new Error(
              `getStockViews 存在重复行：sku=${v.sku} warehouse=${v.warehouse}`,
            );
          seen.add(key);
          for (const [field, qty] of [
            ["qtyBook", v.qtyBook],
            ["qtyAllocated", v.qtyAllocated],
            ["qtyInTransit", v.qtyInTransit],
            ["qtyPhysical", v.qtyPhysical],
          ] as const) {
            if (qty !== null) assertNonNegative(qty, `${v.sku}.${field}`);
          }
          if (v.lastMoveAt !== null)
            assertDateParseable(v.lastMoveAt, `${v.sku}.lastMoveAt`);
        }
      },
    },
    {
      id: "movements-schema",
      description: "getMovements 方向仅 in/out、qty > 0、时间可解析",
      writes: false,
      run(data) {
        const movements = data.getMovements({ sinceDays: 180, limit: 50 });
        if (movements.length === 0)
          throw new Error(
            "近 180 天无流水：无法验证 movements 口径（库缺少动销数据）",
          );
        for (const mv of movements) {
          if (mv.direction !== "in" && mv.direction !== "out") {
            throw new Error(
              `流水 ${mv.id} direction 仅可为 in/out，实际 ${JSON.stringify(mv.direction)}`,
            );
          }
          if (!Number.isFinite(mv.qty) || mv.qty <= 0) {
            throw new Error(
              `流水 ${mv.id} qty 恒 > 0（方向由 direction 表达），实际 ${String(mv.qty)}`,
            );
          }
          assertDateParseable(mv.movedAt, `流水 ${mv.id} movedAt`);
        }
      },
    },
    {
      id: "movement-aggregates",
      description: "getMovementTotals / getDailyOutflow 聚合值非负",
      writes: false,
      run(data) {
        const totals = data.getMovementTotals({
          direction: "out",
          sinceDays: 90,
        });
        for (const t of totals)
          assertNonNegative(t.totalQty, `物料 ${t.sku} 出库总量`);
        const sample =
          totals[0]?.sku ?? data.listMaterials({ keyword: "" })[0]?.sku;
        if (sample === undefined)
          throw new Error("库内无任何 SKU 可验证 getDailyOutflow");
        for (const day of data.getDailyOutflow(sample, 30)) {
          assertNonNegative(day.qty, `${sample} 于 ${day.date} 的出库量`);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date)) {
            throw new Error(
              `getDailyOutflow 日期须为 YYYY-MM-DD，实际 ${JSON.stringify(day.date)}`,
            );
          }
        }
      },
    },
    {
      id: "work-orders-schema",
      description: "getOpenWorkOrders 日期可解析、数量 ≥ 0",
      writes: false,
      run(data) {
        const orders = data.getOpenWorkOrders({ horizonDays: 30 });
        for (const wo of orders) {
          assertDateParseable(wo.startDate, `工单 ${wo.woId} startDate`);
          assertNonNegative(wo.qty, `工单 ${wo.woId} qty`);
        }
      },
    },
    {
      id: "bom-positive-usage",
      description: "getBom 单台用量 > 0 且子项非父项自身",
      writes: false,
      run(data) {
        const products = data
          .getOpenWorkOrders({ horizonDays: 30 })
          .map((wo) => wo.parentSku);
        const parents =
          products.length > 0
            ? products
            : data
                .listMaterials()
                .map((m) => m.sku)
                .slice(0, 20);
        let checked = 0;
        for (const parent of parents) {
          for (const line of data.getBom(parent)) {
            if (!(line.qtyPer > 0)) {
              throw new Error(
                `BOM ${line.parentSku}→${line.componentSku} qtyPer 恒 > 0，实际 ${String(line.qtyPer)}`,
              );
            }
            if (line.parentSku === line.componentSku) {
              throw new Error(`BOM 子项不可为父项自身：${line.parentSku}`);
            }
            checked++;
          }
          if (checked > 0) break;
        }
        if (checked === 0)
          throw new Error(
            "未找到任何 BOM 行：缺料预警无展开依据（库缺少 BOM 语义）",
          );
      },
    },
    {
      id: "inbound-schema",
      description: "getInboundOrders 到货日可解析、数量 ≥ 0",
      writes: false,
      run(data) {
        for (const po of data.getInboundOrders()) {
          assertDateParseable(po.eta, `采购单 ${po.poId} eta`);
          assertNonNegative(po.qty, `采购单 ${po.poId} qty`);
        }
      },
    },
    {
      id: "alert-roundtrip",
      description:
        "writeAlert → listAlerts → updateAlertStatus 读写闭环（自清理）",
      writes: true,
      run(data) {
        const title = "[契约探针] 读写闭环自检";
        const id = data.writeAlert({
          type: "deviation",
          sku: null,
          severity: "yellow",
          title,
          detail: { probe: true },
        });
        const hit = data
          .listAlerts({ status: "open" })
          .find((row) => row.id === id && row.title === title);
        if (hit === undefined)
          throw new Error(
            'writeAlert 写入后 listAlerts({status:"open"}) 查不到该行',
          );
        const closed = data.updateAlertStatus(id, "resolved");
        if (closed === null || closed.status !== "resolved")
          throw new Error("updateAlertStatus 未生效");
      },
    },
    {
      id: "suggestion-roundtrip",
      description:
        "writeSuggestion → findPendingSuggestion → decideSuggestion 闭环（自清理）",
      writes: true,
      run(data) {
        const sample = data.listMaterials()[0]?.sku;
        if (sample === undefined) throw new Error("库内无物料可验证建议闭环");
        const id = data.writeSuggestion({
          sku: sample,
          suggestedQty: 1,
          suggestedDate: new Date().toISOString().slice(0, 10),
          reason: { probe: true },
        });
        const pending = data.findPendingSuggestion(sample);
        if (pending === null || pending.id !== id)
          throw new Error("writeSuggestion 后 findPendingSuggestion 未命中");
        const decided = data.decideSuggestion(id, "reject", "[契约探针] 自检");
        if (decided === null || decided.status !== "rejected")
          throw new Error("decideSuggestion 未生效");
      },
    },
    {
      id: "settings-numeric",
      description: "getNumberSetting 返回有限数值",
      writes: false,
      run(data) {
        const value = data.getNumberSetting("deviation.thresholdPct", 5);
        if (!Number.isFinite(value))
          throw new Error("getNumberSetting 须返回有限数值");
      },
    },
  ];
}
