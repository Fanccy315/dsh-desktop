/**
 * 映射表（alt-schema 库 → 数据契约）：
 * - md_item(基础) × item_planning(计划属性) × item_vendor(采购属性) → 物料主数据三表拼合
 * - inv_balance = ERP × WMS 合并单表 → qtyBook=erp_on_hand / qtyAllocated=erp_reserved /
 *   qtyInTransit=erp_open_po / qtyPhysical=wms_count / location=bin_code / lastMoveAt=last_txn_time
 * - stock_txn → movements：io_flag I→in、O→out；txn_qty→qty；txn_time→movedAt；txn_note→source
 * - mo_list → work_orders：mo_state REL/PLN=未完工；plan_start→startDate；mo_qty→qty
 * - bom_lines → bom：parent_code/comp_code/unit_usage
 * - po_incoming → purchase_orders：po_state OPEN=在途；due_date→eta
 * - 语义缺口：目标库无 alerts/suggestions/settings → connect 时自建 jc_ 前缀副表
 */
import type { DatabaseSync } from 'node:sqlite'
import type { AdapterConnectOptions, JcInventoryAdapterModule, JcInventoryData } from '../../contract.ts'
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
  Severity,
  StockQuery,
  StockView,
  SuggestionDecision,
  SuggestionRow,
  SuggestionStatus,
  WorkOrder,
  WorkOrderQuery,
} from '../../types.ts'

const QUERY_LIMIT = 50

interface AlertRowSql {
  id: number
  type: AlertRow['type']
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

class AltSqliteData implements JcInventoryData {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  close(): void {
    this.db.close()
  }

  listMaterials(query?: MaterialQuery): Material[] {
    const clauses: string[] = []
    const params: Array<string> = []
    if (query?.keyword) {
      clauses.push('(i.item_code LIKE ? OR i.item_name LIKE ?)')
      params.push(`%${query.keyword}%`, `%${query.keyword}%`)
    }
    if (query?.warehouse) {
      clauses.push('i.whs_name = ?')
      params.push(query.warehouse)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`
      SELECT i.item_code, i.item_name, i.model, i.whs_name, p.abc, p.xyz, p.unit_cost, p.ss_qty, p.lt_days, v.vendor
      FROM md_item i
      JOIN item_planning p ON p.item_code = i.item_code
      LEFT JOIN item_vendor v ON v.item_code = i.item_code
      ${where} ORDER BY i.item_code`).all(...params) as unknown as Array<{
      item_code: string; item_name: string; model: string; whs_name: string
      abc: Material['abcClass']; xyz: Material['xyzClass']
      unit_cost: number; ss_qty: number; lt_days: number; vendor: string | null
    }>
    return rows.map((r) => ({
      sku: r.item_code,
      name: r.item_name,
      spec: r.model,
      warehouse: r.whs_name,
      abcClass: r.abc,
      xyzClass: r.xyz,
      unitPrice: r.unit_cost,
      safetyStock: r.ss_qty,
      leadTimeDays: r.lt_days,
      supplier: r.vendor ?? '',
    }))
  }

  getBom(parentSku: string): BomLine[] {
    const rows = this.db.prepare(
      'SELECT parent_code, comp_code, unit_usage FROM bom_lines WHERE parent_code = ?',
    ).all(parentSku) as unknown as Array<{ parent_code: string; comp_code: string; unit_usage: number }>
    return rows.map((r) => ({ parentSku: r.parent_code, componentSku: r.comp_code, qtyPer: r.unit_usage }))
  }

  getStockViews(query?: StockQuery): StockView[] {
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (query?.keyword) {
      clauses.push('(i.item_code LIKE ? OR i.item_name LIKE ?)')
      params.push(`%${query.keyword}%`, `%${query.keyword}%`)
    }
    if (query?.warehouse) {
      clauses.push('i.whs_name = ?')
      params.push(query.warehouse)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = query?.limit
    const sql = `
      SELECT i.item_code, i.item_name, i.whs_name, p.abc, p.xyz, p.unit_cost,
             b.erp_on_hand, b.erp_reserved, b.erp_open_po, b.wms_count, b.bin_code, b.last_txn_time
      FROM md_item i
      JOIN item_planning p ON p.item_code = i.item_code
      LEFT JOIN inv_balance b ON b.item_code = i.item_code AND b.whs_name = i.whs_name
      ${where} ORDER BY i.item_code${limit !== undefined ? ' LIMIT ?' : ''}`
    const rows = (limit !== undefined
      ? this.db.prepare(sql).all(...params, limit)
      : this.db.prepare(sql).all(...params)) as unknown as Array<{
      item_code: string; item_name: string; whs_name: string
      abc: Material['abcClass']; xyz: Material['xyzClass']; unit_cost: number
      erp_on_hand: number | null; erp_reserved: number | null; erp_open_po: number | null
      wms_count: number | null; bin_code: string | null; last_txn_time: string | null
    }>
    return rows.map((r) => ({
      sku: r.item_code,
      name: r.item_name,
      warehouse: r.whs_name,
      abcClass: r.abc,
      xyzClass: r.xyz,
      unitPrice: r.unit_cost,
      qtyBook: r.erp_on_hand,
      qtyAllocated: r.erp_reserved,
      qtyInTransit: r.erp_open_po,
      qtyPhysical: r.wms_count,
      location: r.bin_code === null || r.bin_code === '' ? null : r.bin_code,
      lastMoveAt: r.last_txn_time === null || r.last_txn_time === '' ? null : r.last_txn_time,
    }))
  }

  getMovements(query?: MovementQuery): Movement[] {
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (query?.sku) { clauses.push('t.item_code = ?'); params.push(query.sku) }
    if (query?.warehouse) { clauses.push('t.whs_name = ?'); params.push(query.warehouse) }
    if (query?.direction) { clauses.push('t.io_flag = ?'); params.push(query.direction === 'in' ? 'I' : 'O') }
    if (query?.source) { clauses.push('t.txn_note = ?'); params.push(query.source) }
    const sinceDays = query?.sinceDays ?? 7
    clauses.push("t.txn_time >= datetime('now', ?)")
    params.push(`-${sinceDays} day`)
    const where = `WHERE ${clauses.join(' AND ')}`
    const limit = query?.limit
    const sql = `SELECT t.txn_id, t.item_code, t.whs_name, t.io_flag, t.txn_qty, t.txn_time, t.txn_note FROM stock_txn t ${where} ORDER BY t.txn_time DESC${limit !== undefined ? ' LIMIT ?' : ''}`
    const rows = (limit !== undefined
      ? this.db.prepare(sql).all(...params, limit)
      : this.db.prepare(sql).all(...params)) as unknown as Array<{
      txn_id: number; item_code: string; whs_name: string; io_flag: string; txn_qty: number; txn_time: string; txn_note: string
    }>
    return rows.map((r) => ({
      id: r.txn_id,
      sku: r.item_code,
      warehouse: r.whs_name,
      direction: r.io_flag === 'I' ? 'in' as const : 'out' as const,
      qty: r.txn_qty,
      movedAt: r.txn_time,
      source: r.txn_note,
    }))
  }

  getMovementTotals(query: MovementTotalQuery): MovementTotal[] {
    const clauses = ["io_flag = ?", "txn_time >= datetime('now', ?)"]
    const params: Array<string | number> = [query.direction === 'in' ? 'I' : 'O', `-${query.sinceDays} day`]
    if (query.warehouse) { clauses.push('whs_name = ?'); params.push(query.warehouse) }
    const rows = this.db.prepare(`
      SELECT item_code, SUM(txn_qty) AS total_qty FROM stock_txn
      WHERE ${clauses.join(' AND ')} GROUP BY item_code`).all(...params) as unknown as Array<{ item_code: string; total_qty: number }>
    return rows.map((r) => ({ sku: r.item_code, totalQty: r.total_qty }))
  }

  getDailyOutflow(sku: string, days: number): DailyOutflow[] {
    const rows = this.db.prepare(`
      SELECT date(txn_time) AS d, SUM(txn_qty) AS q FROM stock_txn
      WHERE item_code = ? AND io_flag = 'O' AND txn_time >= datetime('now', ?)
      GROUP BY date(txn_time) ORDER BY d`).all(sku, `-${days} day`) as unknown as Array<{ d: string; q: number }>
    return rows.map((r) => ({ date: r.d, qty: r.q }))
  }

  getOpenWorkOrders(query?: WorkOrderQuery): WorkOrder[] {
    const clauses = ["mo_state IN ('REL', 'PLN')"]
    const params: Array<string | number> = []
    if (query?.horizonDays !== undefined) {
      clauses.push("plan_start <= date('now', ?)")
      params.push(`+${query.horizonDays} day`)
    }
    const limit = query?.limit
    const sql = `SELECT mo_no, item_code, mo_qty, plan_start, mo_state FROM mo_list WHERE ${clauses.join(' AND ')} ORDER BY plan_start${limit !== undefined ? ' LIMIT ?' : ''}`
    const rows = (limit !== undefined
      ? this.db.prepare(sql).all(...params, limit)
      : this.db.prepare(sql).all(...params)) as unknown as Array<{
      mo_no: string; item_code: string; mo_qty: number; plan_start: string; mo_state: string
    }>
    return rows.map((r) => ({ woId: r.mo_no, parentSku: r.item_code, qty: r.mo_qty, startDate: r.plan_start, status: r.mo_state }))
  }

  getInboundOrders(query?: InboundQuery): InboundOrder[] {
    const clauses = ["po_state = 'OPEN'"]
    const params: Array<string | number> = []
    if (query?.sku) { clauses.push('item_code = ?'); params.push(query.sku) }
    const limit = query?.limit
    const sql = `SELECT po_no, item_code, po_qty, due_date, po_state FROM po_incoming WHERE ${clauses.join(' AND ')} ORDER BY due_date${limit !== undefined ? ' LIMIT ?' : ''}`
    const rows = (limit !== undefined
      ? this.db.prepare(sql).all(...params, limit)
      : this.db.prepare(sql).all(...params)) as unknown as Array<{
      po_no: string; item_code: string; po_qty: number; due_date: string; po_state: string
    }>
    return rows.map((r) => ({ poId: r.po_no, sku: r.item_code, qty: r.po_qty, eta: r.due_date, status: r.po_state }))
  }

  writeAlert(alert: NewAlert): number {
    const result = this.db.prepare(`
      INSERT INTO jc_alerts (type, sku, severity, title, detail_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?)`)
      .run(alert.type, alert.sku, alert.severity, alert.title, JSON.stringify(alert.detail), new Date().toISOString())
    return Number(result.lastInsertRowid)
  }

  findOpenAlert(type: NewAlert['type'], sku: string | null): AlertRow | null {
    const sql = sku === null
      ? "SELECT id, type, sku, severity, title, detail_json, status, created_at FROM jc_alerts WHERE type = ? AND sku IS NULL AND status = 'open' ORDER BY id DESC LIMIT 1"
      : "SELECT id, type, sku, severity, title, detail_json, status, created_at FROM jc_alerts WHERE type = ? AND sku = ? AND status = 'open' ORDER BY id DESC LIMIT 1"
    const row = (sku === null
      ? this.db.prepare(sql).get(type)
      : this.db.prepare(sql).get(type, sku)) as unknown as AlertRowSql | undefined
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
      FROM jc_alerts ${where} ORDER BY id DESC LIMIT 100`).all(...params) as unknown as AlertRowSql[]
    return rows.map((r) => this.mapAlert(r))
  }

  updateAlertStatus(id: number, status: AlertStatus): AlertRow | null {
    const result = this.db.prepare('UPDATE jc_alerts SET status = ? WHERE id = ?').run(status, id)
    if (result.changes === 0) return null
    const row = this.db.prepare('SELECT id, type, sku, severity, title, detail_json, status, created_at FROM jc_alerts WHERE id = ?').get(id) as unknown as AlertRowSql | undefined
    return row === undefined ? null : this.mapAlert(row)
  }

  writeSuggestion(s: NewSuggestion): number {
    const result = this.db.prepare(`
      INSERT INTO jc_suggestions (sku, suggested_qty, suggested_date, reason_json, status)
      VALUES (?, ?, ?, ?, 'pending')`)
      .run(s.sku, s.suggestedQty, s.suggestedDate, JSON.stringify(s.reason))
    return Number(result.lastInsertRowid)
  }

  findPendingSuggestion(sku: string): SuggestionRow | null {
    const row = this.db.prepare("SELECT id, sku, suggested_qty, suggested_date, reason_json, status, buyer_note FROM jc_suggestions WHERE sku = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(sku) as unknown as SuggestionRowSql | undefined
    return row === undefined ? null : this.mapSuggestion(row)
  }

  listSuggestions(status?: SuggestionStatus): SuggestionRow[] {
    const rows = (status !== undefined
      ? this.db.prepare('SELECT id, sku, suggested_qty, suggested_date, reason_json, status, buyer_note FROM jc_suggestions WHERE status = ? ORDER BY id DESC LIMIT 100').all(status)
      : this.db.prepare('SELECT id, sku, suggested_qty, suggested_date, reason_json, status, buyer_note FROM jc_suggestions ORDER BY id DESC LIMIT 100').all()) as unknown as SuggestionRowSql[]
    return rows.map((r) => this.mapSuggestion(r))
  }

  decideSuggestion(id: number, action: SuggestionDecision, note?: string): SuggestionRow | null {
    const status: SuggestionStatus = action === 'confirm' ? 'confirmed' : action === 'adjust' ? 'adjusted' : 'rejected'
    const result = this.db.prepare("UPDATE jc_suggestions SET status = ?, buyer_note = ? WHERE id = ? AND status = 'pending'").run(status, note ?? null, id)
    if (result.changes === 0) return null
    const row = this.db.prepare('SELECT id, sku, suggested_qty, suggested_date, reason_json, status, buyer_note FROM jc_suggestions WHERE id = ?').get(id) as unknown as SuggestionRowSql | undefined
    return row === undefined ? null : this.mapSuggestion(row)
  }

  getNumberSetting(key: string, fallback: number): number {
    const row = this.db.prepare('SELECT value FROM jc_settings WHERE key = ?').get(key) as unknown as { value: string } | undefined
    const parsed = row === undefined ? NaN : Number(row.value)
    return Number.isFinite(parsed) ? parsed : fallback
  }

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

const jcAltAdapter: JcInventoryAdapterModule = {
  info: {
    name: 'jc-alt',
    dialect: 'sqlite',
    origin: 'generated',
    description: '元流程生成：第二套 schema 的 SQLite 演示库（md_item/inv_balance/stock_txn 物理模型）',
  },

  async connect(options?: AdapterConnectOptions): Promise<JcInventoryData> {
    const { DatabaseSync } = await import('node:sqlite')
    const dbPath = options?.path
    if (dbPath === undefined) {
      throw new Error('sqlite 方言需要库文件路径（path）')
    }
    const db = new DatabaseSync(dbPath)
    try {
      const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as Array<{ name: string }>).map((r) => r.name))
      for (const required of ['md_item', 'item_planning', 'inv_balance', 'stock_txn', 'mo_list', 'bom_lines', 'po_incoming']) {
        if (!tables.has(required)) throw new Error(`目标库缺少表 ${required}（alt-schema 语义不完整）`)
      }
      // 语义缺口：目标库无智能体产出表 → 自建 jc_ 副表
      db.exec(`
        CREATE TABLE IF NOT EXISTS jc_alerts (
          id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, sku TEXT,
          severity TEXT NOT NULL, title TEXT NOT NULL, detail_json TEXT NOT NULL,
          status TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS jc_suggestions (
          id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL, suggested_qty INTEGER NOT NULL,
          suggested_date TEXT NOT NULL, reason_json TEXT NOT NULL, status TEXT NOT NULL, buyer_note TEXT
        );
        CREATE TABLE IF NOT EXISTS jc_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `)
    } catch (error) {
      db.close()
      throw error
    }
    return new AltSqliteData(db)
  },

  disconnect(data) {
    if (data instanceof AltSqliteData) data.close()
  },
}

export default jcAltAdapter
