/**
 * JC 库管智能体共享类型——数据契约的语义视图，对齐 docs/SPEC.md §6。
 *
 * 物理库表为 snake_case，契约方法一律返回本文件的 camelCase 语义视图，
 * 新库的表名/字段名/拆分方式可异，适配器负责映射（SPEC §5.1）。
 *
 * 口径纪律：契约只搬运**原始数据**——偏差率、库龄、无出库天数、风险分级、
 * 预测等派生数值全部由业务层（src/scans.ts / src/predict.ts）确定性计算，
 * 适配器与元流程生成代码不做算术（SPEC §2 核心原则）。
 *
 * 声明形式：全部用 `type` 别名而非 `interface`——对象字面量类型可获得对
 * `JsonValue` 的隐式索引签名，工具 output schema 据此直接接收这些结构
 * 而无需 `as unknown as` 强转（同 src/adapters/registry.ts 的约定）。
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'

export type AbcClass = 'A' | 'B' | 'C'
export type XyzClass = 'X' | 'Y' | 'Z'
export type Severity = 'red' | 'yellow' | 'green'
export type AlertType = 'deviation' | 'shortage' | 'dead_stock'
export type AlertStatus = 'open' | 'ack' | 'resolved'
export type SuggestionStatus = 'pending' | 'confirmed' | 'adjusted' | 'rejected'
/** inv_suggestion_decide 的审核动作，映射到 suggestions.status 的非 pending 态。 */
export type SuggestionDecision = 'confirm' | 'adjust' | 'reject'
/** 出入库方向，仅 in/out 两个值（探针断言）。 */
export type MoveDirection = 'in' | 'out'

/** 物料主数据（ERP 主数据语义）。 */
export type Material = {
  /** 库内唯一编码。 */
  sku: string
  /** 物料名称（呆滞成因信号之一：名称前缀「定制」= 定制件）。 */
  name: string
  /** 规格型号。 */
  spec: string
  /** 所属库区（原材料仓/半成品仓/成品仓/辅料仓）。 */
  warehouse: string
  abcClass: AbcClass
  xyzClass: XyzClass
  /** 单价（元）。金额类派生指标（库存金额、呆滞金额）由业务层用量 × 单价计算。 */
  unitPrice: number
  /** 静态安全库存（ERP 设定；动态安全库存由补货 Agent 计算）。 */
  safetyStock: number
  /** 采购提前期（天），补货与紧急采购判断用。 */
  leadTimeDays: number
  /** 默认供应商。 */
  supplier: string
}

/** listMaterials 过滤条件，全部可选。 */
export type MaterialQuery = {
  /** 模糊匹配 sku 或 name（前后通配语义）。 */
  keyword?: string
  warehouse?: string
}

/**
 * 库存联合视图：ERP 账面 × WMS 实物按 sku + warehouse 对齐后的单行。
 *
 * 口径（探针断言依据）：
 * - 数量字段可为 null（= 该系统无此 SKU 记录），非 null 时必须 ≥ 0；
 * - lastMoveAt 为 WMS 最后动销时间（ISO 8601），null = 未知；
 *   库龄 = 参考时刻 − lastMoveAt，由业务层推算，契约不预计算；
 * - 账实偏差率 = |qtyBook − qtyPhysical| / qtyBook 同样由业务层计算。
 */
export type StockView = {
  sku: string
  name: string
  warehouse: string
  abcClass: AbcClass
  xyzClass: XyzClass
  unitPrice: number
  /** ERP 账面数量。 */
  qtyBook: number | null
  /** ERP 已分配（工单占用）数量。 */
  qtyAllocated: number | null
  /** ERP 在途数量（采购单未到货）。 */
  qtyInTransit: number | null
  /** WMS 实物数量。 */
  qtyPhysical: number | null
  /** WMS 库位（呆滞成因信号之一：前缀 `QC-` = 待检滞留）。 */
  location: string | null
  /** 最后动销时间，ISO 8601 字符串。 */
  lastMoveAt: string | null
}

/** getStockViews 过滤条件，全部可选；不带 limit 即全量（健康扫描用）。 */
export type StockQuery = {
  /** 模糊匹配 sku 或 name。 */
  keyword?: string
  warehouse?: string
  /** 返回行数上限（查询类工具防刷屏用）。 */
  limit?: number
}

/** 出入库流水行（WMS 流水语义）。 */
export type Movement = {
  /** 流水标识，仅用于展示排序，不承载业务语义。 */
  id: number
  sku: string
  warehouse: string
  direction: MoveDirection
  /** 数量，恒 > 0（方向由 direction 表达，探针断言）。 */
  qty: number
  /** 动销时间，ISO 8601 字符串（探针断言可被 Date.parse 解析）。 */
  movedAt: string
  /** 来源标注（如「紧急出库未录ERP」——健康扫描的偏差成因信号）。 */
  source: string
}

/** getMovements 过滤条件，全部可选；条件在适配器侧下推（SQL/查询），不拉全量到内存过滤。 */
export type MovementQuery = {
  sku?: string
  warehouse?: string
  direction?: MoveDirection
  /** 来源标注精确匹配（如「紧急出库未录ERP」）。 */
  source?: string
  /** 近 N 天，默认适配器取 7。 */
  sinceDays?: number
  /** 返回行数上限，按时间倒序截断。 */
  limit?: number
}

/** 按 SKU 聚合的流水总量（周转率、消耗速度用）。 */
export type MovementTotal = {
  sku: string
  totalQty: number
}

/** getMovementTotals 查询条件。 */
export type MovementTotalQuery = {
  direction: MoveDirection
  /** 近 N 天聚合窗口。 */
  sinceDays: number
  warehouse?: string
}

/** 某 SKU 逐日出库量（需求预测的输入序列；无出库日期由业务层补零）。 */
export type DailyOutflow = {
  /** 日期，YYYY-MM-DD。 */
  date: string
  qty: number
}

/** 未完工工单（MES 工单语义：getOpenWorkOrders 只返回尚未完工的行）。 */
export type WorkOrder = {
  woId: string
  /** 成品 SKU（BOM 展开的父项）。 */
  parentSku: string
  /** 工单数量。 */
  qty: number
  /** 开工日期，YYYY-MM-DD（探针断言可解析）。 */
  startDate: string
  /** 工单状态原文（各库编码不同，语义上均表示未完工）。 */
  status: string
}

/** getOpenWorkOrders 过滤条件，全部可选。 */
export type WorkOrderQuery = {
  /** 只返回开工日期不晚于参考时刻 + horizonDays 的工单（缺料展望期，默认 7）。 */
  horizonDays?: number
  limit?: number
}

/** BOM 行（父项 × 子项用量）。 */
export type BomLine = {
  parentSku: string
  componentSku: string
  /** 单台用量，恒 > 0（探针断言）。 */
  qtyPer: number
}

/** 在途采购单（ERP 在途语义：getInboundOrders 只返回已下单未到货的行）。 */
export type InboundOrder = {
  poId: string
  sku: string
  qty: number
  /** 预计到货日，YYYY-MM-DD（探针断言可解析）。 */
  eta: string
  /** 单据状态原文（各库编码不同，语义上均表示在途）。 */
  status: string
}

/** getInboundOrders 过滤条件，全部可选。 */
export type InboundQuery = {
  sku?: string
  limit?: number
}

/** alerts 行（智能体产出，适配器可落自管本地表，SPEC §6 注）。 */
export type AlertRow = {
  id: number
  type: AlertType
  /** 关联 SKU；库级预警为 null。 */
  sku: string | null
  severity: Severity
  title: string
  /** 结构化明细（各 Agent 报告的浓缩字段），适配器以 JSON 序列化存储。 */
  detail: Record<string, JsonValue>
  status: AlertStatus
  createdAt: string
}

/** 写入 alerts 的新记录（id/status/createdAt 由适配器补齐为 open/当前时刻）。 */
export type NewAlert = {
  type: AlertType
  sku: string | null
  severity: Severity
  title: string
  detail: Record<string, JsonValue>
}

/** listAlerts 过滤条件，全部可选。 */
export type AlertFilter = {
  type?: AlertType
  severity?: Severity
  status?: AlertStatus
}

/** suggestions 表行（智能体产出）。 */
export type SuggestionRow = {
  id: number
  sku: string
  suggestedQty: number
  /** 建议下单/到货日，YYYY-MM-DD。 */
  suggestedDate: string
  /** 建议依据（补货计算过程的结构化摘要）。 */
  reason: Record<string, JsonValue>
  status: SuggestionStatus
  buyerNote: string | null
}

/** 写入 suggestions 的新记录（id/status 由适配器补齐为 pending）。 */
export type NewSuggestion = {
  sku: string
  suggestedQty: number
  suggestedDate: string
  reason: Record<string, JsonValue>
}

// —— 四个 Agent 的结果类型（工具输出、调度器与 LLM 文案共用）——

/** 账实偏差风险行（健康扫描产出）。cause 来自近期「紧急出库未录ERP」流水标注。 */
export type DeviationRiskItem = {
  sku: string
  name: string
  warehouse: string
  abcClass: AbcClass
  qtyBook: number
  qtyPhysical: number
  deviationPct: number
  deviationValueYuan: number
  severity: 'red' | 'yellow'
  cause: string | null
}

/** 库存健康扫描报告（inv_health_scan / 调度器共用）。 */
export type HealthReport = {
  warehouse: string | null
  scannedSkus: number
  totalValueYuan: number
  deviation: {
    highRiskCount: number
    highRiskSharePct: number
    meanDeviationPct: number | null
    redCount: number
    yellowCount: number
    top: DeviationRiskItem[]
  }
  /** 库龄（距最后动销天数）分桶，按库存金额。 */
  ageBuckets: Array<{ bucket: string; skus: number; valueYuan: number; sharePct: number }>
  /** 90 天出库金额 / 当前库存金额。 */
  turnover: { outbound90dYuan: number; stockValueYuan: number; ratioPct: number }
  /** ABC 类与实际价值排名不符的 SKU 数（复核口径：累计价值 70/20/10）。 */
  abcMismatchCount: number
  /** 本次新写入的 deviation 预警条数（去重后）。 */
  alertsWritten: number
  generatedAt: string
}

/** 缺料缺口行（inv_shortage_check 产出）。 */
export type ShortageGap = {
  componentSku: string
  name: string
  warehouse: string
  demandQty: number
  availableQty: number
  gapQty: number
  earliestStartDate: string
  daysToStart: number
  workOrders: string[]
  leadTimeDays: number
  supplier: string
  /** 距开工日不足提前期，需走紧急采购。 */
  urgent: boolean
  /** 建议采购量：缺口 + 10% 余量，向上取整到 10。 */
  purchaseQty: number
}

/** 缺料检查报告。 */
export type ShortageReport = {
  horizonDays: number
  workOrdersInHorizon: number
  shortWorkOrders: number
  kittingRatePct: number
  gaps: ShortageGap[]
  alertsWritten: number
  generatedAt: string
}

/** 呆滞成因（信号归类，SPEC §7：名称前缀「定制」/ 库位 QC- / 其余超量采购）。 */
export type DeadCause = 'custom_part' | 'qc_held' | 'over_purchase'

/** 呆滞行。tier：red = 库龄超阈值硬呆滞；yellow = 无出库超阈值的慢动疑似。 */
export type DeadStockItem = {
  sku: string
  name: string
  warehouse: string
  qtyBook: number
  unitPrice: number
  valueYuan: number
  /** 距最后动销天数。 */
  ageDays: number
  /** 距最后出库天数（null = 从未出库）。 */
  noOutDays: number | null
  /** 近 90 天周均出库量。 */
  weeklyOutQty: number
  /** 按近 90 天消耗速度耗尽库存所需月数；null = 近 90 天零出库。 */
  monthsToConsume: number | null
  cause: DeadCause
  tier: 'red' | 'yellow'
  /** 统计预测结论（移动平均 + Holt，供「未来也用不掉」判断的数据依据）。 */
  forecastNote: string
  /** 处置方向（工具给方向与金额依据，具体文案由 LLM 生成）。 */
  disposal: string
}

/** 呆滞料分析报告。 */
export type DeadStockReport = {
  ageDays: number
  noMoveDays: number
  items: DeadStockItem[]
  totalValueYuan: number
  /** 原材料库存总额（占比分母）；原材料仓无呆滞时为 null。 */
  rawStockValueYuan: number | null
  sharePct: number | null
  byCause: Array<{ cause: DeadCause; count: number; valueYuan: number }>
  alertsWritten: number
  generatedAt: string
}

/** 补货建议行（inv_replenish_suggest 产出并写 suggestions 表）。 */
export type ReplenishItem = {
  sku: string
  name: string
  warehouse: string
  abcClass: AbcClass
  supplier: string
  onHandQty: number
  inTransitQty: number
  /** 近 60 天日均出库（移动平均）。 */
  avgDailyDemand: number
  /** 覆盖期（提前期 + 复查期）预测需求（Holt）。 */
  forecastDemand: number
  /** 动态安全库存：z(服务水平) × 日需求标准差 × √提前期。 */
  safetyStock: number
  suggestedQty: number
  /** 建议下单日（预计库存跌破安全库存的日期）。 */
  suggestedDate: string
  suggestionId: number
}

/** 补货建议产出（items 已按建议日期升序、仅含需补货 SKU）。 */
export type ReplenishReport = {
  scannedSkus: number
  items: ReplenishItem[]
  generatedAt: string
}

/** 库存查询行（inv_query_stock 输出）：契约视图 + 业务层追加的账实偏差派生字段。 */
export type StockQueryRow = {
  sku: string
  name: string
  warehouse: string
  abcClass: AbcClass
  xyzClass: XyzClass
  unitPrice: number
  qtyBook: number | null
  qtyAllocated: number | null
  qtyInTransit: number | null
  qtyPhysical: number | null
  location: string | null
  lastMoveAt: string | null
  /** 账实偏差率 = |qtyBook − qtyPhysical| / qtyBook；账面为 0 或缺失时为 null。 */
  deviationPct: number | null
  /** 偏差率超过阈值（settings: deviation.thresholdPct，默认 5%）。 */
  riskFlag: boolean
}
