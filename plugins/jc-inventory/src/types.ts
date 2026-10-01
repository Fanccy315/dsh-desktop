/**
 * JC 库管智能体共享类型——数据契约的语义视图，对齐 docs/SPEC.md §6。
 *
 * 物理库表为 snake_case，契约方法一律返回本文件的 camelCase 语义视图，
 * 新库的表名/字段名/拆分方式可异，适配器负责映射（SPEC §5.1）。
 *
 * 口径纪律：契约只搬运**原始数据**——偏差率、库龄、无出库天数、风险分级、
 * 预测等派生数值全部由业务层（src/scans.ts / src/predict.ts）确定性计算，
 * 适配器与元流程生成代码不做算术（SPEC §2 核心原则）。
 */

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
export interface Material {
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
export interface MaterialQuery {
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
export interface StockView {
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
export interface StockQuery {
  /** 模糊匹配 sku 或 name。 */
  keyword?: string
  warehouse?: string
  /** 返回行数上限（查询类工具防刷屏用）。 */
  limit?: number
}

/** 出入库流水行（WMS 流水语义）。 */
export interface Movement {
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
export interface MovementQuery {
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
export interface MovementTotal {
  sku: string
  totalQty: number
}

/** getMovementTotals 查询条件。 */
export interface MovementTotalQuery {
  direction: MoveDirection
  /** 近 N 天聚合窗口。 */
  sinceDays: number
  warehouse?: string
}

/** 某 SKU 逐日出库量（需求预测的输入序列；无出库日期由业务层补零）。 */
export interface DailyOutflow {
  /** 日期，YYYY-MM-DD。 */
  date: string
  qty: number
}

/** 未完工工单（MES 工单语义：getOpenWorkOrders 只返回尚未完工的行）。 */
export interface WorkOrder {
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
export interface WorkOrderQuery {
  /** 只返回开工日期不晚于参考时刻 + horizonDays 的工单（缺料展望期，默认 7）。 */
  horizonDays?: number
  limit?: number
}

/** BOM 行（父项 × 子项用量）。 */
export interface BomLine {
  parentSku: string
  componentSku: string
  /** 单台用量，恒 > 0（探针断言）。 */
  qtyPer: number
}

/** 在途采购单（ERP 在途语义：getInboundOrders 只返回已下单未到货的行）。 */
export interface InboundOrder {
  poId: string
  sku: string
  qty: number
  /** 预计到货日，YYYY-MM-DD（探针断言可解析）。 */
  eta: string
  /** 单据状态原文（各库编码不同，语义上均表示在途）。 */
  status: string
}

/** getInboundOrders 过滤条件，全部可选。 */
export interface InboundQuery {
  sku?: string
  limit?: number
}

/** alerts 行（智能体产出，适配器可落自管本地表，SPEC §6 注）。 */
export interface AlertRow {
  id: number
  type: AlertType
  /** 关联 SKU；库级预警为 null。 */
  sku: string | null
  severity: Severity
  title: string
  /** 结构化明细（各 Agent 报告的浓缩字段），适配器以 JSON 序列化存储。 */
  detail: Record<string, unknown>
  status: AlertStatus
  createdAt: string
}

/** 写入 alerts 的新记录（id/status/createdAt 由适配器补齐为 open/当前时刻）。 */
export interface NewAlert {
  type: AlertType
  sku: string | null
  severity: Severity
  title: string
  detail: Record<string, unknown>
}

/** listAlerts 过滤条件，全部可选。 */
export interface AlertFilter {
  type?: AlertType
  severity?: Severity
  status?: AlertStatus
}

/** suggestions 表行（智能体产出）。 */
export interface SuggestionRow {
  id: number
  sku: string
  suggestedQty: number
  /** 建议下单/到货日，YYYY-MM-DD。 */
  suggestedDate: string
  /** 建议依据（补货计算过程的结构化摘要）。 */
  reason: Record<string, unknown>
  status: SuggestionStatus
  buyerNote: string | null
}

/** 写入 suggestions 的新记录（id/status 由适配器补齐为 pending）。 */
export interface NewSuggestion {
  sku: string
  suggestedQty: number
  suggestedDate: string
  reason: Record<string, unknown>
}
