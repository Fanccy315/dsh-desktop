/**
 * 四个 Agent 的确定性业务逻辑（SPEC §9.3–9.6）。
 * 工具插件的 execute 与调度器共用本模块；**只依赖数据契约 JcInventoryData**，
 * 阈值经 getNumberSetting 读 settings 表，数值计算全部在此完成，LLM 只做路由与文案。
 *
 * 口径纪律（SPEC §2）：旧实现把偏差率/库龄/跨表 JOIN 算在服务层 SQL 里，
 * v2 契约只搬原始数据——本模块用契约的原子方法在内存中拼装并完成全部派生计算。
 */

import type { JcInventoryData } from './contract.ts'
import { holtForecastTotal, movingAverage, stdev, zScore } from './predict.ts'
import type {
  DeadCause,
  DeadStockItem,
  DeadStockReport,
  DeviationRiskItem,
  HealthReport,
  Material,
  NewAlert,
  NewSuggestion,
  ReplenishItem,
  ReplenishReport,
  ShortageGap,
  ShortageReport,
  StockQueryRow,
  StockView,
} from './types.ts'

const DAY_MS = 86_400_000

/** 查询类工具返回行数上限，防止 3200+ SKU 全量刷屏。 */
const QUERY_LIMIT = 50

/** settings 缺省值（与生成器 insertSettings 一致，SPEC §8）。 */
const DEFAULTS = {
  deviationThresholdPct: 5,
  deadAgeDays: 180,
  deadNoMoveDays: 60,
  shortageHorizonDays: 7,
  serviceLevel: 0.95,
} as const

/** 呆滞成因中文标签（LLM 文案与卡片共用）。 */
export const DEAD_CAUSE_LABELS: Record<DeadCause, string> = {
  custom_part: '定制件客户终止',
  qc_held: '待检滞留',
  over_purchase: '超量采购',
}

/** 呆滞处置方向（金额依据在条目里，具体文案由 LLM 展开）。 */
const DISPOSAL: Record<DeadCause, string> = {
  custom_part: '联系客户协商结算后折价/报废评审（定制件难转用）',
  qc_held: '优先推动质检放行转正常库存，无法放行的安排退货',
  over_purchase: '先尝试调拨其他产线，再与供应商协商退换或折价出售',
}

/** 补货 Agent 面向的采购类库区（成品仓为自产件，不参与补货）。 */
const PURCHASABLE_WAREHOUSES = new Set(['原材料仓', '辅料仓', '半成品仓'])

/** 补货 ABC 类复查周期（天）：A 类盯得紧、C 类看得松。 */
const REVIEW_DAYS: Record<'A' | 'B' | 'C', number> = { A: 7, B: 10, C: 14 }

// —— 时间与派生助手 ——————————————————————————————————————————

/** 'YYYY-MM-DD HH:MM:SS'（UTC）→ 毫秒时间戳。 */
function parseUtc(ts: string): number {
  return Date.parse(ts.replace(' ', 'T') + 'Z')
}

/** 毫秒时间戳 → 'YYYY-MM-DD'（UTC，与库内日期口径一致）。 */
function toDateStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** 今天（UTC 零点）。 */
function todayUtc(): number {
  return Math.floor(Date.now() / DAY_MS) * DAY_MS
}

/** 在原始库存视图上追加偏差率与风险标记（口径：|账面 − 实物| / 账面，账面为 0/缺失为 null）。 */
function withDeviation(views: readonly StockView[], threshold: number): StockQueryRow[] {
  return views.map((v) => {
    const raw = v.qtyBook !== null && v.qtyBook > 0
      ? Math.abs(v.qtyBook - (v.qtyPhysical ?? 0)) / v.qtyBook * 100
      : null
    return {
      ...v,
      deviationPct: raw === null ? null : Math.round(raw * 10) / 10,
      riskFlag: raw !== null && raw > threshold,
    }
  })
}

/** 某 SKU 近 N 天逐日出库量序列（按日升序，无出库日期补 0）。 */
function dailyOutSeries(svc: JcInventoryData, sku: string, days: number): number[] {
  const outflow = svc.getDailyOutflow(sku, days)
  const byDay = new Map(outflow.map((o) => [o.date, o.qty]))
  const series: number[] = []
  const today = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * DAY_MS).toISOString().slice(0, 10)
    series.push(byDay.get(d) ?? 0)
  }
  return series
}

/** 去重写入预警：同 type + sku 已有 open 预警时跳过；返回是否新写入。 */
function writeAlertIfOpen(svc: JcInventoryData, alert: NewAlert): boolean {
  if (svc.findOpenAlert(alert.type, alert.sku) !== null) return false
  svc.writeAlert(alert)
  return true
}

/** 去重写入建议：同 SKU 已有 pending 建议时返回既有 id；否则新建并返回新 id。 */
function writeSuggestionIfPending(svc: JcInventoryData, suggestion: NewSuggestion): number {
  const existing = svc.findPendingSuggestion(suggestion.sku)
  return existing !== null ? existing.id : svc.writeSuggestion(suggestion)
}

/** 呆滞成因信号归类（SPEC §7：名称前缀「定制」/ 库位 QC- / 其余超量采购）。 */
function classifyCause(name: string, location: string): DeadCause {
  if (name.startsWith('定制')) return 'custom_part'
  if (location.startsWith('QC-')) return 'qc_held'
  return 'over_purchase'
}

// —— 库存查询（inv_query_stock 的确定性部分）————————————————

/** 按关键字/库区查库存并追加账实偏差派生字段。 */
export function queryStock(svc: JcInventoryData, keyword: string, warehouse?: string): StockQueryRow[] {
  const threshold = svc.getNumberSetting('deviation.thresholdPct', DEFAULTS.deviationThresholdPct)
  const views = svc.getStockViews({ keyword, warehouse, limit: QUERY_LIMIT })
  return withDeviation(views, threshold)
}

// —— 库存健康扫描（SPEC §9.3）———————————————————————————————

/**
 * 全量扫描：账实偏差分级、库龄分布、周转率、ABC 复核；
 * 高风险 SKU 写 deviation 预警（同 SKU 未处理预警不重复写）。
 */
export function runHealthScan(svc: JcInventoryData, warehouse?: string): HealthReport {
  const threshold = svc.getNumberSetting('deviation.thresholdPct', DEFAULTS.deviationThresholdPct)
  const views = svc.getStockViews(warehouse ? { warehouse } : undefined)
  const rows = withDeviation(views, threshold)
  const stockRows = rows.filter((r): r is StockQueryRow & { qtyBook: number } => r.qtyBook !== null)
  const totalValueYuan = stockRows.reduce((sum, r) => sum + r.qtyBook * r.unitPrice, 0)

  // 偏差成因来源：近 30 天有「紧急出库未录ERP」流水的 SKU（一次 bulk 取全）
  const unrecordedOut = new Set(
    svc.getMovements({ direction: 'out', source: '紧急出库未录ERP', sinceDays: 30 }).map((m) => m.sku),
  )

  // 账实偏差：red = 偏差率 ≥ 2×阈值，yellow = 超阈值其余
  const highRisk = rows.filter((r) => r.riskFlag && r.deviationPct !== null)
  const riskItems: DeviationRiskItem[] = highRisk.map((r) => {
    const dev = r.deviationPct!
    const qtyBook = r.qtyBook ?? 0
    return {
      sku: r.sku,
      name: r.name,
      warehouse: r.warehouse,
      abcClass: r.abcClass,
      qtyBook,
      qtyPhysical: r.qtyPhysical ?? 0,
      deviationPct: dev,
      deviationValueYuan: Math.round(Math.abs(qtyBook - (r.qtyPhysical ?? 0)) * r.unitPrice),
      severity: dev >= threshold * 2 ? 'red' : 'yellow',
      cause: unrecordedOut.has(r.sku) ? '紧急出库未录ERP' : null,
    }
  })
  riskItems.sort((a, b) => b.deviationValueYuan - a.deviationValueYuan)
  const alertsWritten = riskItems
    .filter((item) => writeAlertIfOpen(svc, {
      type: 'deviation',
      sku: item.sku,
      severity: item.severity,
      title: `账实偏差 ${item.deviationPct}%：${item.name}（账面 ${item.qtyBook} / 实物 ${item.qtyPhysical}）`,
      detail: {
        deviationPct: item.deviationPct,
        qtyBook: item.qtyBook,
        qtyPhysical: item.qtyPhysical,
        deviationValueYuan: item.deviationValueYuan,
        cause: item.cause,
        thresholdPct: threshold,
      },
    })).length

  // 库龄（距最后动销）分桶，按库存金额
  const buckets = ['0-30', '31-90', '91-180', '>180'] as const
  const bucketAgg = buckets.map(() => ({ skus: 0, valueYuan: 0 }))
  for (const r of stockRows) {
    const ageDays = r.lastMoveAt ? Math.floor((Date.now() - parseUtc(r.lastMoveAt)) / DAY_MS) : 9999
    const idx = ageDays <= 30 ? 0 : ageDays <= 90 ? 1 : ageDays <= 180 ? 2 : 3
    bucketAgg[idx]!.skus++
    bucketAgg[idx]!.valueYuan += r.qtyBook * r.unitPrice
  }
  const ageBuckets = buckets.map((bucket, i) => ({
    bucket,
    skus: bucketAgg[i]!.skus,
    valueYuan: Math.round(bucketAgg[i]!.valueYuan),
    sharePct: totalValueYuan > 0 ? Math.round(bucketAgg[i]!.valueYuan / totalValueYuan * 1000) / 10 : 0,
  }))

  // 周转率：90 天出库金额 / 当前库存金额（出库总量 × 单价，单价来自本批库存视图）
  const priceMap = new Map(rows.map((r) => [r.sku, r.unitPrice]))
  const outbound90dYuan = svc.getMovementTotals({ direction: 'out', sinceDays: 90, warehouse })
    .reduce((sum, t) => sum + t.totalQty * (priceMap.get(t.sku) ?? 0), 0)
  const stockValueYuan = Math.round(totalValueYuan)
  const ratioPct = stockValueYuan > 0 ? Math.round(outbound90dYuan / stockValueYuan * 1000) / 10 : 0

  // ABC 复核：按实际库存价值排名重划（累计 70%/20%/10%），与主数据类比对不上即记一笔
  const ranked = [...stockRows].sort((a, b) => b.qtyBook * b.unitPrice - a.qtyBook * a.unitPrice)
  let cumulative = 0
  let abcMismatchCount = 0
  for (const r of ranked) {
    cumulative += r.qtyBook * r.unitPrice
    const share = totalValueYuan > 0 ? cumulative / totalValueYuan : 1
    const computed = share <= 0.7 ? 'A' : share <= 0.9 ? 'B' : 'C'
    if (computed !== r.abcClass) abcMismatchCount++
  }

  return {
    warehouse: warehouse ?? null,
    scannedSkus: rows.length,
    totalValueYuan: stockValueYuan,
    deviation: {
      highRiskCount: riskItems.length,
      highRiskSharePct: rows.length > 0 ? Math.round(riskItems.length / rows.length * 1000) / 10 : 0,
      meanDeviationPct: riskItems.length > 0
        ? Math.round(riskItems.reduce((s, i) => s + i.deviationPct, 0) / riskItems.length * 10) / 10
        : null,
      redCount: riskItems.filter((i) => i.severity === 'red').length,
      yellowCount: riskItems.filter((i) => i.severity === 'yellow').length,
      top: riskItems.slice(0, 20),
    },
    ageBuckets,
    turnover: { outbound90dYuan: Math.round(outbound90dYuan), stockValueYuan, ratioPct },
    abcMismatchCount,
    alertsWritten,
    generatedAt: new Date().toISOString(),
  }
}

// —— 缺料预警（SPEC §9.4）———————————————————————————————————

/**
 * 展望期工单 × BOM 净需求检查：缺口清单、预计断料日、紧急采购草案；
 * 写 shortage 预警与 suggestions（均去重）。
 */
export function runShortageCheck(svc: JcInventoryData, horizonDays?: number): ShortageReport {
  const horizon = horizonDays && horizonDays > 0
    ? horizonDays
    : svc.getNumberSetting('shortage.horizonDays', DEFAULTS.shortageHorizonDays)
  const orders = svc.getOpenWorkOrders({ horizonDays: horizon })
  const matMap = new Map(svc.listMaterials().map((m) => [m.sku, m]))
  // 组件可用量（账面 + 在途）：跨库区求和，对齐旧 workOrderRequirements 的 SUM 口径
  const availBySku = new Map<string, { qtyBook: number; qtyInTransit: number }>()
  for (const v of svc.getStockViews()) {
    const prev = availBySku.get(v.sku) ?? { qtyBook: 0, qtyInTransit: 0 }
    availBySku.set(v.sku, {
      qtyBook: prev.qtyBook + (v.qtyBook ?? 0),
      qtyInTransit: prev.qtyInTransit + (v.qtyInTransit ?? 0),
    })
  }

  interface ComponentAgg {
    demandQty: number
    availableQty: number
    earliestStart: string
    workOrders: Set<string>
    mat: Material
  }
  const byComponent = new Map<string, ComponentAgg>()
  const allWorkOrders = new Set<string>()
  const shortWorkOrders = new Set<string>()
  for (const wo of orders) {
    allWorkOrders.add(wo.woId)
    for (const line of svc.getBom(wo.parentSku)) {
      const mat = matMap.get(line.componentSku)
      if (mat === undefined) continue
      const demand = wo.qty * line.qtyPer
      const avail = availBySku.get(line.componentSku) ?? { qtyBook: 0, qtyInTransit: 0 }
      const available = avail.qtyBook + avail.qtyInTransit
      let agg = byComponent.get(line.componentSku)
      if (agg === undefined) {
        agg = { demandQty: 0, availableQty: available, earliestStart: wo.startDate, workOrders: new Set(), mat }
        byComponent.set(line.componentSku, agg)
      }
      agg.demandQty += demand
      if (wo.startDate < agg.earliestStart) agg.earliestStart = wo.startDate
      agg.workOrders.add(wo.woId)
      if (demand > available) shortWorkOrders.add(wo.woId)
    }
  }

  const gaps: ShortageGap[] = []
  let alertsWritten = 0
  for (const [componentSku, agg] of byComponent) {
    const gapQty = Math.ceil(agg.demandQty - agg.availableQty)
    if (gapQty <= 0) continue
    const { mat } = agg
    const daysToStart = Math.round((parseUtc(`${agg.earliestStart} 00:00:00`) - todayUtc()) / DAY_MS)
    const urgent = daysToStart < mat.leadTimeDays
    const purchaseQty = Math.ceil(gapQty * 1.1 / 10) * 10
    gaps.push({
      componentSku,
      name: mat.name,
      warehouse: mat.warehouse,
      demandQty: Math.round(agg.demandQty),
      availableQty: agg.availableQty,
      gapQty,
      earliestStartDate: agg.earliestStart,
      daysToStart,
      workOrders: [...agg.workOrders].sort(),
      leadTimeDays: mat.leadTimeDays,
      supplier: mat.supplier,
      urgent,
      purchaseQty,
    })
    if (writeAlertIfOpen(svc, {
      type: 'shortage',
      sku: componentSku,
      severity: urgent ? 'red' : 'yellow',
      title: `缺料：${mat.name} 缺口 ${gapQty}，最早开工 ${agg.earliestStart}（涉及 ${agg.workOrders.size} 张工单）`,
      detail: {
        gapQty,
        demandQty: Math.round(agg.demandQty),
        availableQty: agg.availableQty,
        earliestStartDate: agg.earliestStart,
        daysToStart,
        workOrders: [...agg.workOrders].sort(),
        urgent,
        suggestedPurchaseQty: purchaseQty,
        supplier: mat.supplier,
      },
    })) alertsWritten++
    writeSuggestionIfPending(svc, {
      sku: componentSku,
      suggestedQty: purchaseQty,
      suggestedDate: agg.earliestStart,
      reason: {
        type: 'emergency_purchase',
        gapQty,
        demandQty: Math.round(agg.demandQty),
        availableQty: agg.availableQty,
        earliestStartDate: agg.earliestStart,
        workOrders: [...agg.workOrders].sort(),
        urgent,
        supplier: mat.supplier,
        leadTimeDays: mat.leadTimeDays,
      },
    })
  }
  gaps.sort((a, b) => a.earliestStartDate.localeCompare(b.earliestStartDate) || b.gapQty - a.gapQty)

  const totalWo = allWorkOrders.size
  return {
    horizonDays: horizon,
    workOrdersInHorizon: totalWo,
    shortWorkOrders: shortWorkOrders.size,
    kittingRatePct: totalWo > 0 ? Math.round((totalWo - shortWorkOrders.size) / totalWo * 1000) / 10 : 100,
    gaps,
    alertsWritten,
    generatedAt: new Date().toISOString(),
  }
}

// —— 呆滞料分析（SPEC §9.5）—————————————————————————————————

/**
 * 呆滞扫描：red = 库龄超阈值（口径对齐报告 16.7% 基线）；
 * yellow = 无出库超阈值且按近 90 天速度半年耗不掉（含报告案例一的 120 天慢动件）。
 */
export function runDeadStock(svc: JcInventoryData, ageDays?: number): DeadStockReport {
  const ageThreshold = ageDays && ageDays > 0 ? ageDays : svc.getNumberSetting('deadstock.ageDays', DEFAULTS.deadAgeDays)
  const noMoveDays = svc.getNumberSetting('deadstock.noMoveDays', DEFAULTS.deadNoMoveDays)
  const views = svc.getStockViews()
  const candidates = views.filter((v): v is StockView & { qtyBook: number } => v.qtyBook !== null && v.qtyBook > 0)

  // 近 90 天出库量 + 最近出库时间（演示库历史恰 180 天，bulk 一次取全避免逐 SKU 查询）
  const out90 = new Map(svc.getMovementTotals({ direction: 'out', sinceDays: 90 }).map((t) => [t.sku, t.totalQty]))
  const lastOutAt = new Map<string, string>()
  for (const mv of svc.getMovements({ direction: 'out', sinceDays: 180 })) {
    const cur = lastOutAt.get(mv.sku)
    if (cur === undefined || mv.movedAt > cur) lastOutAt.set(mv.sku, mv.movedAt)
  }

  const items: DeadStockItem[] = []
  let alertsWritten = 0
  for (const c of candidates) {
    const cAgeDays = c.lastMoveAt === null ? 9999 : Math.floor((Date.now() - parseUtc(c.lastMoveAt)) / DAY_MS)
    const outQty90 = out90.get(c.sku) ?? 0
    const lastOut = lastOutAt.get(c.sku)
    const noOutDays = lastOut === undefined ? null : Math.floor((Date.now() - parseUtc(lastOut)) / DAY_MS)
    const monthsToConsume = outQty90 > 0 ? Math.round(3 * c.qtyBook / outQty90 * 10) / 10 : null
    const isRed = cAgeDays > ageThreshold
    const isYellow = !isRed
      && (noOutDays === null || noOutDays > noMoveDays)
      && (monthsToConsume === null || monthsToConsume > 6)
    if (!isRed && !isYellow) continue
    const cause = classifyCause(c.name, c.location ?? '')
    const valueYuan = Math.round(c.qtyBook * c.unitPrice)
    const forecast90 = holtForecastTotal(dailyOutSeries(svc, c.sku, 90), 90)
    const forecastNote = monthsToConsume === null
      ? `近 90 天零出库，Holt 预测未来 90 天出库 ${Math.round(forecast90)} 件，库存无法自然消化`
      : `近 90 天周均出库 ${Math.round(outQty90 / 13 * 10) / 10}，Holt 预测未来 90 天出库 ${Math.round(forecast90)} 件，按此速度约需 ${monthsToConsume} 个月耗尽`
    items.push({
      sku: c.sku,
      name: c.name,
      warehouse: c.warehouse,
      qtyBook: c.qtyBook,
      unitPrice: c.unitPrice,
      valueYuan,
      ageDays: cAgeDays,
      noOutDays,
      weeklyOutQty: Math.round(outQty90 / 13 * 10) / 10,
      monthsToConsume,
      cause,
      tier: isRed ? 'red' : 'yellow',
      forecastNote,
      disposal: DISPOSAL[cause],
    })
    if (writeAlertIfOpen(svc, {
      type: 'dead_stock',
      sku: c.sku,
      severity: isRed ? 'red' : 'yellow',
      title: `呆滞（${DEAD_CAUSE_LABELS[cause]}）：${c.name} 库龄 ${cAgeDays} 天、金额 ${(valueYuan / 10_000).toFixed(1)} 万元`,
      detail: {
        tier: isRed ? 'red' : 'yellow',
        ageDays: cAgeDays,
        noOutDays,
        valueYuan,
        cause,
        causeLabel: DEAD_CAUSE_LABELS[cause],
        monthsToConsume,
        disposal: DISPOSAL[cause],
      },
    })) alertsWritten++
  }

  items.sort((a, b) => (a.tier === b.tier ? b.valueYuan - a.valueYuan : a.tier === 'red' ? -1 : 1))
  const redItems = items.filter((i) => i.tier === 'red')
  const yellowItems = items.filter((i) => i.tier === 'yellow')

  // 占比口径：red 呆滞中原材料部分 / 原材料库存总额（对齐报告 16.7%）
  const rawStockValue = candidates
    .filter((c) => c.warehouse === '原材料仓')
    .reduce((s, c) => s + c.qtyBook * c.unitPrice, 0)
  const rawRedValue = redItems
    .filter((i) => i.warehouse === '原材料仓')
    .reduce((s, i) => s + i.valueYuan, 0)
  const sharePct = rawStockValue > 0 ? Math.round(rawRedValue / rawStockValue * 1000) / 10 : null

  const byCause = (['custom_part', 'qc_held', 'over_purchase'] as const).map((cause) => {
    const subset = items.filter((i) => i.cause === cause)
    return { cause, count: subset.length, valueYuan: subset.reduce((s, i) => s + i.valueYuan, 0) }
  })

  return {
    ageDays: ageThreshold,
    noMoveDays,
    items: [...redItems, ...yellowItems.slice(0, 20)],
    totalValueYuan: items.reduce((s, i) => s + i.valueYuan, 0),
    rawStockValueYuan: rawStockValue > 0 ? Math.round(rawStockValue) : null,
    sharePct,
    byCause,
    alertsWritten,
    generatedAt: new Date().toISOString(),
  }
}

// —— 智能补货建议（SPEC §9.6）———————————————————————————————

/**
 * 净需求预测 + 动态安全库存 → 补货建议（写 suggestions，pending 去重）。
 * 覆盖期 = 提前期 + ABC 复查期；安全库存 = z × 日需求标准差 × √提前期。
 * 只面向采购类库区（原材料/辅料/半成品，排除自产成品）。
 */
export function runReplenish(svc: JcInventoryData, sku?: string, warehouse?: string): ReplenishReport {
  const serviceLevel = svc.getNumberSetting('replenish.serviceLevel', DEFAULTS.serviceLevel)
  const z = zScore(serviceLevel)
  const materials = svc.listMaterials()
  const stockBySku = new Map(svc.getStockViews().map((v) => [v.sku, v]))
  const activeOut60 = new Set(svc.getMovementTotals({ direction: 'out', sinceDays: 60 }).map((t) => t.sku))

  const candidates = materials
    .filter((m) => {
      if (sku !== undefined && m.sku !== sku) return false
      if (warehouse !== undefined && m.warehouse !== warehouse) return false
      if (!PURCHASABLE_WAREHOUSES.has(m.warehouse)) return false
      if (!activeOut60.has(m.sku)) return false
      const st = stockBySku.get(m.sku)
      return st !== undefined && st.qtyBook !== null
    })
    .map((m) => {
      const st = stockBySku.get(m.sku)!
      return { material: m, qtyBook: st.qtyBook!, qtyInTransit: st.qtyInTransit ?? 0 }
    })

  const items: ReplenishItem[] = []
  for (const { material: c, qtyBook, qtyInTransit } of candidates) {
    const series = dailyOutSeries(svc, c.sku, 60)
    const avgDailyDemand = movingAverage(series, 60)
    const coverageDays = c.leadTimeDays + REVIEW_DAYS[c.abcClass]
    const forecastDemand = Math.round(holtForecastTotal(series, coverageDays))
    const safetyStock = Math.ceil(z * stdev(series) * Math.sqrt(c.leadTimeDays))
    const suggestedQty = Math.ceil(forecastDemand + safetyStock - qtyBook - qtyInTransit)
    if (suggestedQty <= 0) continue
    const daysUntilShort = avgDailyDemand > 0
      ? Math.max(0, Math.floor((qtyBook + qtyInTransit - safetyStock) / avgDailyDemand))
      : 0
    const suggestedDate = toDateStr(todayUtc() + daysUntilShort * DAY_MS)
    const suggestionId = writeSuggestionIfPending(svc, {
      sku: c.sku,
      suggestedQty,
      suggestedDate,
      reason: {
        type: 'replenish',
        avgDailyDemand: Math.round(avgDailyDemand * 100) / 100,
        forecastDemand,
        safetyStock,
        coverageDays,
        onHandQty: qtyBook,
        inTransitQty: qtyInTransit,
        abcClass: c.abcClass,
        leadTimeDays: c.leadTimeDays,
        serviceLevel,
      },
    })
    items.push({
      sku: c.sku,
      name: c.name,
      warehouse: c.warehouse,
      abcClass: c.abcClass,
      supplier: c.supplier,
      onHandQty: qtyBook,
      inTransitQty: qtyInTransit,
      avgDailyDemand: Math.round(avgDailyDemand * 100) / 100,
      forecastDemand,
      safetyStock,
      suggestedQty,
      suggestedDate,
      suggestionId,
    })
  }
  items.sort((a, b) => a.suggestedDate.localeCompare(b.suggestedDate) || b.suggestedQty - a.suggestedQty)

  return {
    scannedSkus: candidates.length,
    items,
    generatedAt: new Date().toISOString(),
  }
}
