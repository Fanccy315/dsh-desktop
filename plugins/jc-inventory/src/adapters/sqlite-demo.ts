/**
 * 内置 SQLite 演示适配器（SPEC §3：元流程首个实例 + 提示词范例）。
 *
 * 本文件把 generator/ 产出的 data/jc.db（snake_case 物理表，SPEC §6）搬运进
 * JcInventoryData 契约：SQL 全部收敛于此，只返回**原始数据**的语义视图，
 * 不做任何派生计算（偏差率/库龄/风险分级/预测在 src/scans.ts，SPEC §2）。
 *
 * 它也是元流程提示词里的生成范例（范例即文档，SPEC §5.2 第 6 步）——新适配器
 * 的业务口径、错误处理、方言写法均以本文件为准。
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import type { AdapterConnectOptions, JcInventoryAdapterModule, JcInventoryData } from '../contract.ts'
import type {
  AlertFilter,
  AlertRow,
  AlertStatus,
  AlertType,
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
  Severity,
  StockQuery,
  StockView,
  SuggestionDecision,
  SuggestionRow,
  SuggestionStatus,
  WorkOrder,
  WorkOrderQuery,
} from '../types.ts'

/** 默认演示库：<包根>/data/jc.db（src/ 与 lib/ 编译态下 ../../ 均回到包根）。 */
const DEFAULT_DB_PATH = fileURLToPath(new URL('../../data/jc.db', import.meta.url))

/** SPEC §6 全部业务表；缺表在 connect 即失败（misconfiguration fails loud）。 */
const REQUIRED_TABLES = [
  'materials', 'stock_erp', 'stock_wms', 'movements', 'work_orders',
  'bom', 'purchase_orders', 'alerts', 'suggestions', 'settings',
] as const

/** 查询类默认行数上限，防止全量刷屏（健康扫描等批量路径不设限）。 */
const QUERY_LIMIT = 50

// —— snake_case 物理行（SQL 返回直映射）—————————————————————————

interface MaterialRow {
  sku: string
  name: string
  spec: string
  warehouse: string
  abc_class: Material['abcClass']
  xyz_class: Material['xyzClass']
  unit_price: number
  safety_stock: number
  lead_time_days: number
  supplier: string
}

interface StockRow {
  sku: string
  name: string
  warehouse: string
  abc_class: Material['abcClass']
  xyz_class: Material['xyzClass']
  unit_price: number
  qty_book: number | null
  qty_allocated: number | null
  qty_in_transit: number | null
  qty_physical: number | null
  location: string | null
  last_move_at: string | null
}

interface MovementRow {
  id: number
  sku: string
  warehouse: string
  direction: Movement['direction']
  qty: number
  moved_at: string
  source: string
}

interface WorkOrderRow {
  wo_id: string
  sku: string
  qty: number
  start_date: string
  status: string
}

interface BomRow {
  parent_sku: string
  component_sku: string
  qty_per: number
}

interface InboundRow {
  po_id: string
  sku: string
  qty: number
  eta: string
  status: string
}

interface AlertRowSql {
  id: number
  type: AlertType
  sku: string | null
  severity: Severity
  title: string
  detail_json: string
  status: AlertStatus
  created_at: string
}

interface SuggestionRowSql {
  id: number
  sku: string
  suggested_qty: number
  suggested_date: string
  reason_json: string
  status: SuggestionStatus
  buyer_note: string | null
}

/** 契约实现：open 一个 SQLite 数据库，只搬运原始数据。 */
class SqliteDemoData implements JcInventoryData {
  /** TS private 而非 #私有字段：与 service 层 traceable proxy 访问保持一致（SPEC §9.8.5）。 */
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  close(): void {
    this.db.close()
  }

  // —— 主数据 ——————————————————————————————————————————————

  listMaterials(query?: MaterialQuery): Material[] {
    const clauses: string[] = []
    const params: Array<string> = []
    if (query?.keyword) {
      clauses.push('(sku LIKE ? OR name LIKE ?)')
      params.push(`%${query.keyword}%`, `%${query.keyword}%`)
    }
    if (query?.warehouse) {
      clauses.push('warehouse = ?')
      params.push(query.warehouse)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`
      SELECT sku, name, spec, warehouse, abc_class, xyz_class, unit_price, safety_stock, lead_time_days, supplier
      FROM materials ${where} ORDER BY sku`).all(...params) as unknown as MaterialRow[]
    return rows.map((r) => ({
      sku: r.sku,
      name: r.name,
      spec: r.spec,
      warehouse: r.warehouse,
      abcClass: r.abc_class,
      xyzClass: r.xyz_class,
      unitPrice: r.unit_price,
      safetyStock: r.safety_stock,
      leadTimeDays: r.lead_time_days,
      supplier: r.supplier,
    }))
  }

  getBom(parentSku: string): BomLine[] {
    const rows = this.db.prepare(
      'SELECT parent_sku, component_sku, qty_per FROM bom WHERE parent_sku = ?',
    ).all(parentSku) as unknown as BomRow[]
    return rows.map((r) => ({ parentSku: r.parent_sku, componentSku: r.component_sku, qtyPer: r.qty_per }))
  }

  // —— 库存与流水 ——————————————————————————————————————————

  getStockViews(query?: StockQuery): StockView[] {
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (query?.keyword) {
      clauses.push('(m.sku LIKE ? OR m.name LIKE ?)')
      params.push(`%${query.keyword}%`, `%${query.keyword}%`)
    }
    if (query?.warehouse) {
      clauses.push('m.warehouse = ?')
      params.push(query.warehouse)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = query?.limit
    const sql = `
      SELECT m.sku, m.name, m.warehouse, m.abc_class, m.xyz_class, m.unit_price,
             e.qty_book, e.qty_allocated, e.qty_in_transit,
             w.qty_physical, w.location, w.last_move_at
      FROM materials m
      LEFT JOIN stock_erp e ON e.sku = m.sku AND e.warehouse = m.warehouse
      LEFT JOIN stock_wms w ON w.sku = m.sku AND w.warehouse = m.warehouse
      ${where} ORDER BY m.sku${limit !== undefined ? ' LIMIT ?' : ''}`
    const rows = (limit !== undefined
      ? this.db.prepare(sql).all(...params, limit)
      : this.db.prepare(sql).all(...params)) as unknown as StockRow[]
    return rows.map((r) => ({
      sku: r.sku,
      name: r.name,
      warehouse: r.warehouse,
      abcClass: r.abc_class,
      xyzClass: r.xyz_class,
      unitPrice: r.unit_price,
      qtyBook: r.qty_book,
      qtyAllocated: r.qty_allocated,
      qtyInTransit: r.qty_in_transit,
      qtyPhysical: r.qty_physical,
      location: r.location,
      lastMoveAt: r.last_move_at,
    }))
  }

  getMovements(query?: MovementQuery): Movement[] {
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (query?.sku) { clauses.push('sku = ?'); params.push(query.sku) }
    if (query?.warehouse) { clauses.push('warehouse = ?'); params.push(query.warehouse) }
    if (query?.direction) { clauses.push('direction = ?'); params.push(query.direction) }
    if (query?.source) { clauses.push('source = ?'); params.push(query.source) }
    const sinceDays = query?.sinceDays ?? 7
    clauses.push('moved_at >= datetime(\'now\', ?)')
    params.push(`-${sinceDays} day`)
    const where = `WHERE ${clauses.join(' AND ')}`
    const limit = query?.limit
    const sql = `SELECT id, sku, warehouse, direction, qty, moved_at, source FROM movements ${where} ORDER BY moved_at DESC${limit !== undefined ? ' LIMIT ?' : ''}`
    const rows = (limit !== undefined
      ? this.db.prepare(sql).all(...params, limit)
      : this.db.prepare(sql).all(...params)) as unknown as MovementRow[]
    return rows.map((r) => ({ id: r.id, sku: r.sku, warehouse: r.warehouse, direction: r.direction, qty: r.qty, movedAt: r.moved_at, source: r.source }))
  }

  getMovementTotals(query: MovementTotalQuery): MovementTotal[] {
    const clauses = ['direction = ?', 'moved_at >= datetime(\'now\', ?)']
    const params: Array<string | number> = [query.direction, `-${query.sinceDays} day`]
    if (query.warehouse) { clauses.push('warehouse = ?'); params.push(query.warehouse) }
    const rows = this.db.prepare(`
      SELECT sku, SUM(qty) AS total_qty FROM movements
      WHERE ${clauses.join(' AND ')} GROUP BY sku`).all(...params) as unknown as Array<{ sku: string; total_qty: number }>
    return rows.map((r) => ({ sku: r.sku, totalQty: r.total_qty }))
  }

  getDailyOutflow(sku: string, days: number): DailyOutflow[] {
    const rows = this.db.prepare(`
      SELECT date(moved_at) AS d, SUM(qty) AS q FROM movements
      WHERE sku = ? AND direction = 'out' AND moved_at >= datetime('now', ?)
      GROUP BY date(moved_at) ORDER BY d`).all(sku, `-${days} day`) as unknown as Array<{ d: string; q: number }>
    return rows.map((r) => ({ date: r.d, qty: r.q }))
  }

  // —— 生产与在途 ——————————————————————————————————————————

  getOpenWorkOrders(query?: WorkOrderQuery): WorkOrder[] {
    const clauses = ["status <> '已完工'"]
    const params: Array<string | number> = []
    if (query?.horizonDays !== undefined) {
      clauses.push('start_date <= date(\'now\', ?)')
      params.push(`+${query.horizonDays} day`)
    }
    const limit = query?.limit
    const sql = `SELECT wo_id, sku, qty, start_date, status FROM work_orders WHERE ${clauses.join(' AND ')} ORDER BY start_date${limit !== undefined ? ' LIMIT ?' : ''}`
    const rows = (limit !== undefined
      ? this.db.prepare(sql).all(...params, limit)
      : this.db.prepare(sql).all(...params)) as unknown as WorkOrderRow[]
    return rows.map((r) => ({ woId: r.wo_id, parentSku: r.sku, qty: r.qty, startDate: r.start_date, status: r.status }))
  }

  getInboundOrders(query?: InboundQuery): InboundOrder[] {
    const clauses = ["status = '在途'"]
    const params: Array<string | number> = []
    if (query?.sku) { clauses.push('sku = ?'); params.push(query.sku) }
    const limit = query?.limit
    const sql = `SELECT po_id, sku, qty, eta, status FROM purchase_orders WHERE ${clauses.join(' AND ')} ORDER BY eta${limit !== undefined ? ' LIMIT ?' : ''}`
    const rows = (limit !== undefined
      ? this.db.prepare(sql).all(...params, limit)
      : this.db.prepare(sql).all(...params)) as unknown as InboundRow[]
    return rows.map((r) => ({ poId: r.po_id, sku: r.sku, qty: r.qty, eta: r.eta, status: r.status }))
  }

  // —— 智能体产出（alerts / suggestions）——————————————————————

  writeAlert(alert: NewAlert): number {
    const result = this.db.prepare(`
      INSERT INTO alerts (type, sku, severity, title, detail_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?)`)
      .run(alert.type, alert.sku, alert.severity, alert.title, JSON.stringify(alert.detail), new Date().toISOString())
    return Number(result.lastInsertRowid)
  }

  findOpenAlert(type: NewAlert['type'], sku: string | null): AlertRow | null {
    const row = (sku === null
      ? this.db.prepare("SELECT id, type, sku, severity, title, detail_json, status, created_at FROM alerts WHERE type = ? AND sku IS NULL AND status = 'open' ORDER BY id DESC LIMIT 1").get(type)
      : this.db.prepare("SELECT id, type, sku, severity, title, detail_json, status, created_at FROM alerts WHERE type = ? AND sku = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(type, sku)) as unknown as AlertRowSql | undefined
    return row === undefined ? null : this.mapAlert(row)
  }

  listAlerts(filter?: AlertFilter): AlertRow[] {
    const clauses: string[] = []
    const params: Array<string> = []
    if (filter?.type) { clauses.push('type = ?'); params.push(filter.type) }
    if (filter?.severity) { clauses.push('severity = ?'); params.push(filter.severity) }
    if (filter?.status) { clauses.push('status = ?'); params.push(filter.status) }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`
      SELECT id, type, sku, severity, title, detail_json, status, created_at
      FROM alerts ${where} ORDER BY id DESC LIMIT 100`).all(...params) as unknown as AlertRowSql[]
    return rows.map((r) => this.mapAlert(r))
  }

  updateAlertStatus(id: number, status: AlertStatus): AlertRow | null {
    const result = this.db.prepare('UPDATE alerts SET status = ? WHERE id = ?').run(status, id)
    if (result.changes === 0) return null
    const row = this.db.prepare('SELECT id, type, sku, severity, title, detail_json, status, created_at FROM alerts WHERE id = ?').get(id) as unknown as AlertRowSql | undefined
    return row === undefined ? null : this.mapAlert(row)
  }

  writeSuggestion(s: NewSuggestion): number {
    const result = this.db.prepare(`
      INSERT INTO suggestions (sku, suggested_qty, suggested_date, reason_json, status)
      VALUES (?, ?, ?, ?, 'pending')`)
      .run(s.sku, s.suggestedQty, s.suggestedDate, JSON.stringify(s.reason))
    return Number(result.lastInsertRowid)
  }

  findPendingSuggestion(sku: string): SuggestionRow | null {
    const row = this.db.prepare("SELECT id, sku, suggested_qty, suggested_date, reason_json, status, buyer_note FROM suggestions WHERE sku = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(sku) as unknown as SuggestionRowSql | undefined
    return row === undefined ? null : this.mapSuggestion(row)
  }

  listSuggestions(status?: SuggestionStatus): SuggestionRow[] {
    const rows = (status !== undefined
      ? this.db.prepare('SELECT id, sku, suggested_qty, suggested_date, reason_json, status, buyer_note FROM suggestions WHERE status = ? ORDER BY id DESC LIMIT 100').all(status)
      : this.db.prepare('SELECT id, sku, suggested_qty, suggested_date, reason_json, status, buyer_note FROM suggestions ORDER BY id DESC LIMIT 100').all()) as unknown as SuggestionRowSql[]
    return rows.map((r) => this.mapSuggestion(r))
  }

  decideSuggestion(id: number, action: SuggestionDecision, note?: string): SuggestionRow | null {
    const status: SuggestionStatus = action === 'confirm' ? 'confirmed' : action === 'adjust' ? 'adjusted' : 'rejected'
    const result = this.db.prepare("UPDATE suggestions SET status = ?, buyer_note = ? WHERE id = ? AND status = 'pending'").run(status, note ?? null, id)
    if (result.changes === 0) return null
    const row = this.db.prepare('SELECT id, sku, suggested_qty, suggested_date, reason_json, status, buyer_note FROM suggestions WHERE id = ?').get(id) as unknown as SuggestionRowSql | undefined
    return row === undefined ? null : this.mapSuggestion(row)
  }

  // —— 配置 ————————————————————————————————————————————————

  getNumberSetting(key: string, fallback: number): number {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as unknown as { value: string } | undefined
    const parsed = row === undefined ? NaN : Number(row.value)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  // —— 行映射 ——————————————————————————————————————————————

  private mapAlert(r: AlertRowSql): AlertRow {
    return {
      id: r.id,
      type: r.type,
      sku: r.sku,
      severity: r.severity,
      title: r.title,
      detail: JSON.parse(r.detail_json) as AlertRow['detail'],
      status: r.status,
      createdAt: r.created_at,
    }
  }

  private mapSuggestion(r: SuggestionRowSql): SuggestionRow {
    return {
      id: r.id,
      sku: r.sku,
      suggestedQty: r.suggested_qty,
      suggestedDate: r.suggested_date,
      reason: JSON.parse(r.reason_json) as SuggestionRow['reason'],
      status: r.status,
      buyerNote: r.buyer_note,
    }
  }
}

/** 校验库文件含 SPEC §6 全部业务表；缺表即抛错。 */
function assertSchema(db: DatabaseSync, path: string): void {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as Array<{ name: string }>
  const present = new Set(rows.map((row) => row.name))
  const missing = REQUIRED_TABLES.filter((table) => !present.has(table))
  if (missing.length > 0) {
    throw new Error(`jc-inventory：${path} 缺少表 ${missing.join(', ')}（需 SPEC §6 schema 的 SQLite 库文件）`)
  }
}

const sqliteDemoAdapter: JcInventoryAdapterModule = {
  info: {
    name: 'sqlite-demo',
    dialect: 'sqlite',
    origin: 'builtin',
    description: '内置 SQLite 演示适配器（读取 generator/ 产出的 data/jc.db，兼元流程生成范例）',
  },

  async connect(options?: AdapterConnectOptions): Promise<JcInventoryData> {
    // 惰性 import：与旧实现一致，避免 node:sqlite 的实验警告打断启动
    const { DatabaseSync } = await import('node:sqlite')
    const dbPath = options?.path ?? DEFAULT_DB_PATH
    if (!existsSync(dbPath)) {
      throw new Error(`演示库不存在：${dbPath}（先运行 yarn gen 生成 data/jc.db）`)
    }
    const db = new DatabaseSync(dbPath)
    try {
      assertSchema(db, dbPath)
    } catch (error) {
      db.close()
      throw error
    }
    return new SqliteDemoData(db)
  },

  disconnect(data) {
    if (data instanceof SqliteDemoData) data.close()
  },
}

export default sqliteDemoAdapter
export { sqliteDemoAdapter }
