/**
 * 第二套 schema 的演示库生成器（SPEC §7）：产出 data/jc-alt.db，
 * 供元流程验收——证明「换一个表结构不同、语义同构的库，不改代码接入」。
 *
 * 与 jc.db（SPEC §6）的物理差异刻意做足，逼生成的适配器做真映射：
 * - 表名/字段名全部不同（materials → md_item + item_planning + item_vendor 三表拆分）；
 * - stock_erp × stock_wms 合并为 inv_balance 单表（合并方向的反例）；
 * - 枚举换编码：direction in/out → io_flag I/O；工单/采购状态换单字码；
 * - 不含 alerts / suggestions / settings——智能体产出须由适配器自建副表（SPEC §6 注）。
 *
 * 语义与 jc.db 严格同构：先用 generateSample 在临时路径生成同 seed 的源库，
 * 逐行 ETL 后删除源库；自检用 alt-schema SQL 重算全部基线统计，
 * 要求与源库逐项相等（不是 ±10%，是同一份数据的换装）。
 * 运行：pnpm jc:gen:alt [--seed N] [--as-of YYYY-MM-DD]。
 */
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { generateSample } from './generate.ts'
import {
  CASE2_QTY_PER, CASE2_STOCK, CASE2_IN_TRANSIT, CASE2_WORK_ORDER, CASE2_WO_QTY,
  CASE3_QTY_BOOK, CASE3_QTY_PHYSICAL, CASE3_SKU,
} from './scenarios.ts'

const DAY = 86_400_000

/** alt 库 DDL：命名空间感的 ERP 风格，与 SPEC §6 的 schema 无一同名同列。 */
const SCHEMA = `
CREATE TABLE md_item (
  item_code TEXT PRIMARY KEY, item_name TEXT NOT NULL, model TEXT NOT NULL, whs_name TEXT NOT NULL
);
CREATE TABLE item_planning (
  item_code TEXT PRIMARY KEY, abc TEXT NOT NULL, xyz TEXT NOT NULL, unit_cost REAL NOT NULL,
  ss_qty INTEGER NOT NULL, lt_days INTEGER NOT NULL
);
CREATE TABLE item_vendor (item_code TEXT PRIMARY KEY, vendor TEXT NOT NULL);
CREATE TABLE inv_balance (
  item_code TEXT NOT NULL, whs_name TEXT NOT NULL,
  erp_on_hand INTEGER NOT NULL, erp_reserved INTEGER NOT NULL, erp_open_po INTEGER NOT NULL,
  wms_count INTEGER NOT NULL, bin_code TEXT NOT NULL, last_txn_time TEXT NOT NULL,
  PRIMARY KEY (item_code, whs_name)
);
CREATE TABLE stock_txn (
  txn_id INTEGER PRIMARY KEY AUTOINCREMENT, item_code TEXT NOT NULL, whs_name TEXT NOT NULL,
  io_flag TEXT NOT NULL CHECK (io_flag IN ('I', 'O')),
  txn_qty INTEGER NOT NULL, txn_time TEXT NOT NULL, txn_note TEXT NOT NULL
);
CREATE TABLE mo_list (
  mo_no TEXT PRIMARY KEY, item_code TEXT NOT NULL, mo_qty INTEGER NOT NULL,
  plan_start TEXT NOT NULL, mo_state TEXT NOT NULL
);
CREATE TABLE bom_lines (
  parent_code TEXT NOT NULL, comp_code TEXT NOT NULL, unit_usage REAL NOT NULL,
  PRIMARY KEY (parent_code, comp_code)
);
CREATE TABLE po_incoming (
  po_no TEXT PRIMARY KEY, item_code TEXT NOT NULL, po_qty INTEGER NOT NULL,
  due_date TEXT NOT NULL, po_state TEXT NOT NULL
);
CREATE INDEX idx_txn_item ON stock_txn (item_code, txn_time);
CREATE INDEX idx_bom_parent ON bom_lines (parent_code);
CREATE INDEX idx_mo_start ON mo_list (plan_start);
`

/** 工单状态原文 → alt 编码（语义上均未完工；已完工态在本库不存在）。 */
const MO_STATE: Record<string, string> = { 已下达: 'REL', 已排产: 'PLN' }

/** 基线统计的一组数：源库与 alt 库各算一遍，逐项相等才通过。 */
interface Baseline {
  itemCount: number
  txnCount: number
  rawValue: number
  highRisk: number
  meanDevPct: number
  deadValue: number
  horizonWo: number
  horizonShort: number
}

function baselineFromSource(db: DatabaseSync, asOfMs: number, cutoff180: string, horizonEnd: string): Baseline {
  const highRisk = db.prepare(`
    SELECT COUNT(*) AS n, AVG(dev) AS meanDev FROM (
      SELECT ABS(e.qty_book - w.qty_physical) * 100.0 / e.qty_book AS dev
      FROM stock_erp e JOIN stock_wms w ON w.sku = e.sku AND w.warehouse = e.warehouse
      WHERE e.qty_book > 0 AND ABS(e.qty_book - w.qty_physical) * 100.0 / e.qty_book > 5
    )`).get() as { n: number; meanDev: number }
  const deadValue = (db.prepare(`
    SELECT SUM(e.qty_book * m.unit_price) AS v FROM materials m
    JOIN stock_erp e ON e.sku = m.sku AND e.warehouse = m.warehouse
    JOIN stock_wms w ON w.sku = m.sku AND w.warehouse = m.warehouse
    WHERE m.warehouse = '原材料仓' AND w.last_move_at < ?`).get(cutoff180) as { v: number }).v
  const wos = db.prepare('SELECT wo_id, sku, qty FROM work_orders WHERE start_date <= ?').all(horizonEnd) as Array<{ wo_id: string; sku: string; qty: number }>
  const bomStmt = db.prepare(`
    SELECT b.qty_per, IFNULL(e.qty_book, 0) + IFNULL(e.qty_in_transit, 0) AS avail
    FROM bom b LEFT JOIN stock_erp e ON e.sku = b.component_sku
    WHERE b.parent_sku = ?`)
  let short = 0
  for (const wo of wos) {
    const rows = bomStmt.all(wo.sku) as Array<{ qty_per: number; avail: number }>
    if (rows.some((r) => wo.qty * r.qty_per > r.avail)) short++
  }
  return {
    itemCount: (db.prepare('SELECT COUNT(*) AS n FROM materials').get() as { n: number }).n,
    txnCount: (db.prepare('SELECT COUNT(*) AS n FROM movements').get() as { n: number }).n,
    rawValue: (db.prepare(`
      SELECT SUM(e.qty_book * m.unit_price) AS v FROM materials m
      JOIN stock_erp e ON e.sku = m.sku AND e.warehouse = m.warehouse
      WHERE m.warehouse = '原材料仓'`).get() as { v: number }).v,
    highRisk: highRisk.n,
    meanDevPct: highRisk.meanDev,
    deadValue,
    horizonWo: wos.length,
    horizonShort: short,
  }
}

function baselineFromAlt(db: DatabaseSync, cutoff180: string, horizonEnd: string): Baseline {
  const highRisk = db.prepare(`
    SELECT COUNT(*) AS n, AVG(dev) AS meanDev FROM (
      SELECT ABS(erp_on_hand - wms_count) * 100.0 / erp_on_hand AS dev
      FROM inv_balance WHERE erp_on_hand > 0 AND ABS(erp_on_hand - wms_count) * 100.0 / erp_on_hand > 5
    )`).get() as { n: number; meanDev: number }
  const deadValue = (db.prepare(`
    SELECT SUM(b.erp_on_hand * p.unit_cost) AS v
    FROM inv_balance b
    JOIN md_item i ON i.item_code = b.item_code AND i.whs_name = b.whs_name
    JOIN item_planning p ON p.item_code = b.item_code
    WHERE i.whs_name = '原材料仓' AND b.last_txn_time < ?`).get(cutoff180) as { v: number }).v
  const wos = db.prepare('SELECT mo_no, item_code, mo_qty FROM mo_list WHERE plan_start <= ?').all(horizonEnd) as Array<{ mo_no: string; item_code: string; mo_qty: number }>
  const bomStmt = db.prepare(`
    SELECT l.unit_usage, IFNULL(b.erp_on_hand, 0) + IFNULL(b.erp_open_po, 0) AS avail
    FROM bom_lines l LEFT JOIN inv_balance b ON b.item_code = l.comp_code
    WHERE l.parent_code = ?`)
  let short = 0
  for (const wo of wos) {
    const rows = bomStmt.all(wo.item_code) as Array<{ unit_usage: number; avail: number }>
    if (rows.some((r) => wo.mo_qty * r.unit_usage > r.avail)) short++
  }
  return {
    itemCount: (db.prepare('SELECT COUNT(*) AS n FROM md_item').get() as { n: number }).n,
    txnCount: (db.prepare('SELECT COUNT(*) AS n FROM stock_txn').get() as { n: number }).n,
    rawValue: (db.prepare(`
      SELECT SUM(b.erp_on_hand * p.unit_cost) AS v
      FROM inv_balance b
      JOIN md_item i ON i.item_code = b.item_code AND i.whs_name = b.whs_name
      JOIN item_planning p ON p.item_code = b.item_code
      WHERE i.whs_name = '原材料仓'`).get() as { v: number }).v,
    highRisk: highRisk.n,
    meanDevPct: highRisk.meanDev,
    deadValue,
    horizonWo: wos.length,
    horizonShort: short,
  }
}

interface Check { name: string; actual: string; expect: string; pass: boolean }

const EQ = (actual: number, expect: number): boolean => Math.abs(actual - expect) < 1e-6

/** 逐项断言：alt 基线统计与源库相等、三案例语义落位、缺智能体产出表。 */
function verify(db: DatabaseSync, src: Baseline, alt: Baseline, horizonEnd: string): boolean {
  const case3 = db.prepare('SELECT erp_on_hand, wms_count FROM inv_balance WHERE item_code = ?').get(CASE3_SKU) as { erp_on_hand: number; wms_count: number } | undefined
  const case2Gap = db.prepare(`
    SELECT mo_qty, plan_start FROM mo_list WHERE mo_no = ?`).get(CASE2_WORK_ORDER) as { mo_qty: number; plan_start: string } | undefined
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name))
  const checks: Check[] = [
    { name: '物料行数 = 源库', actual: String(alt.itemCount), expect: String(src.itemCount), pass: alt.itemCount === src.itemCount },
    { name: '流水行数 = 源库', actual: String(alt.txnCount), expect: String(src.txnCount), pass: alt.txnCount === src.txnCount },
    { name: '原材料总额 = 源库', actual: alt.rawValue.toFixed(2), expect: src.rawValue.toFixed(2), pass: EQ(alt.rawValue, src.rawValue) },
    { name: '高风险 SKU 数 = 源库', actual: String(alt.highRisk), expect: String(src.highRisk), pass: alt.highRisk === src.highRisk },
    { name: '高风险平均偏差率 = 源库', actual: alt.meanDevPct.toFixed(3), expect: src.meanDevPct.toFixed(3), pass: EQ(alt.meanDevPct, src.meanDevPct) },
    { name: '呆滞价值 = 源库', actual: alt.deadValue.toFixed(2), expect: src.deadValue.toFixed(2), pass: EQ(alt.deadValue, src.deadValue) },
    { name: '展望期工单数 = 源库', actual: String(alt.horizonWo), expect: String(src.horizonWo), pass: alt.horizonWo === src.horizonWo },
    { name: '展望期缺料工单数 = 源库', actual: String(alt.horizonShort), expect: String(src.horizonShort), pass: alt.horizonShort === src.horizonShort },
    { name: '案例三：ERP/WMS（5200/4830）', actual: case3 === undefined ? '缺失' : `${case3.erp_on_hand}/${case3.wms_count}`, expect: `${CASE3_QTY_BOOK}/${CASE3_QTY_PHYSICAL}`, pass: case3 !== undefined && case3.erp_on_hand === CASE3_QTY_BOOK && case3.wms_count === CASE3_QTY_PHYSICAL },
    { name: '案例二：工单缺口（件）', actual: case2Gap === undefined ? '缺失' : String(case2Gap.mo_qty * CASE2_QTY_PER - (CASE2_STOCK + CASE2_IN_TRANSIT)), expect: '2200', pass: case2Gap !== undefined && case2Gap.mo_qty === CASE2_WO_QTY },
    { name: '不含 alerts/suggestions/settings 表', actual: [...tables].filter((t) => ['alerts', 'suggestions', 'settings'].includes(t)).join(',') || '（无）', expect: '（无）', pass: !tables.has('alerts') && !tables.has('suggestions') && !tables.has('settings') },
    { name: `案例二：${CASE2_WORK_ORDER} 在展望期内`, actual: case2Gap?.plan_start ?? '缺失', expect: `≤ ${horizonEnd}`, pass: case2Gap !== undefined && case2Gap.plan_start <= horizonEnd },
  ]
  const allPass = checks.every((c) => c.pass)
  console.log('\n=== alt-schema 基线自检（与源库逐项相等）===')
  for (const c of checks) console.log(`  ${c.pass ? '✓' : '✗'} ${c.name}: ${c.actual}（期望 ${c.expect}）`)
  console.log(allPass ? '\nalt-schema 库语义同构校验通过 ✓' : '\n存在超差项 ✗')
  return allPass
}

/** ETL：源库（SPEC §6 schema）逐行搬进 alt schema，编码映射见函数体。 */
function etl(src: DatabaseSync, dst: DatabaseSync): void {
  dst.exec('BEGIN')
  try {
    const insItem = dst.prepare('INSERT INTO md_item (item_code, item_name, model, whs_name) VALUES (?, ?, ?, ?)')
    const insPlan = dst.prepare('INSERT INTO item_planning (item_code, abc, xyz, unit_cost, ss_qty, lt_days) VALUES (?, ?, ?, ?, ?, ?)')
    const insVendor = dst.prepare('INSERT INTO item_vendor (item_code, vendor) VALUES (?, ?)')
    for (const m of src.prepare(`
      SELECT sku, name, spec, warehouse, abc_class, xyz_class, unit_price, safety_stock, lead_time_days, supplier
      FROM materials ORDER BY sku`).all() as Array<{
      sku: string; name: string; spec: string; warehouse: string; abc_class: string; xyz_class: string
      unit_price: number; safety_stock: number; lead_time_days: number; supplier: string
    }>) {
      insItem.run(m.sku, m.name, m.spec, m.warehouse)
      insPlan.run(m.sku, m.abc_class, m.xyz_class, m.unit_price, m.safety_stock, m.lead_time_days)
      insVendor.run(m.sku, m.supplier)
    }

    // stock_erp × stock_wms → inv_balance：按 (sku, warehouse) 全外连接语义合并
    const insBal = dst.prepare(`
      INSERT INTO inv_balance (item_code, whs_name, erp_on_hand, erp_reserved, erp_open_po, wms_count, bin_code, last_txn_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const r of src.prepare(`
      SELECT e.sku, e.warehouse, e.qty_book, e.qty_allocated, e.qty_in_transit,
             w.qty_physical, w.location, w.last_move_at
      FROM stock_erp e LEFT JOIN stock_wms w ON w.sku = e.sku AND w.warehouse = e.warehouse
      UNION ALL
      SELECT w.sku, w.warehouse, NULL, NULL, NULL, w.qty_physical, w.location, w.last_move_at
      FROM stock_wms w
      WHERE NOT EXISTS (SELECT 1 FROM stock_erp e WHERE e.sku = w.sku AND e.warehouse = w.warehouse)
      ORDER BY 1`).all() as Array<{
      sku: string; warehouse: string; qty_book: number | null; qty_allocated: number | null
      qty_in_transit: number | null; qty_physical: number | null; location: string | null; last_move_at: string | null
    }>) {
      insBal.run(r.sku, r.warehouse, r.qty_book ?? 0, r.qty_allocated ?? 0, r.qty_in_transit ?? 0, r.qty_physical ?? 0, r.location ?? '', r.last_move_at ?? '')
    }

    const insTxn = dst.prepare('INSERT INTO stock_txn (item_code, whs_name, io_flag, txn_qty, txn_time, txn_note) VALUES (?, ?, ?, ?, ?, ?)')
    for (const m of src.prepare(`
      SELECT sku, warehouse, direction, qty, moved_at, source FROM movements ORDER BY id`).all() as Array<{
      sku: string; warehouse: string; direction: 'in' | 'out'; qty: number; moved_at: string; source: string
    }>) {
      insTxn.run(m.sku, m.warehouse, m.direction === 'in' ? 'I' : 'O', m.qty, m.moved_at, m.source)
    }

    const insMo = dst.prepare('INSERT INTO mo_list (mo_no, item_code, mo_qty, plan_start, mo_state) VALUES (?, ?, ?, ?, ?)')
    for (const w of src.prepare('SELECT wo_id, sku, qty, start_date, status FROM work_orders ORDER BY wo_id').all() as Array<{
      wo_id: string; sku: string; qty: number; start_date: string; status: string
    }>) {
      const state = MO_STATE[w.status]
      if (state === undefined) throw new Error(`未知工单状态：${w.status}`)
      insMo.run(w.wo_id, w.sku, w.qty, w.start_date, state)
    }

    const insBom = dst.prepare('INSERT INTO bom_lines (parent_code, comp_code, unit_usage) VALUES (?, ?, ?)')
    for (const b of src.prepare('SELECT parent_sku, component_sku, qty_per FROM bom ORDER BY parent_sku, component_sku').all() as Array<{ parent_sku: string; component_sku: string; qty_per: number }>) {
      insBom.run(b.parent_sku, b.component_sku, b.qty_per)
    }

    const insPo = dst.prepare('INSERT INTO po_incoming (po_no, item_code, po_qty, due_date, po_state) VALUES (?, ?, ?, ?, ?)')
    for (const p of src.prepare('SELECT po_id, sku, qty, eta, status FROM purchase_orders ORDER BY po_id').all() as Array<{ po_id: string; sku: string; qty: number; eta: string; status: string }>) {
      insPo.run(p.po_id, p.sku, p.qty, p.eta, p.status === '在途' ? 'OPEN' : p.status)
    }
  } catch (error) {
    dst.exec('ROLLBACK')
    throw error
  }
  dst.exec('COMMIT')
}

/** 生成选项（generateAlt）。 */
export interface AltOptions {
  /** alt 库目标路径（含文件名）。 */
  path: string
  seed?: number
  asOfMs?: number
  quiet?: boolean
}

/** 生成结果。 */
export interface AltResult {
  path: string
  seed: number
  asOfMs: number
  /** 语义同构校验（与源库逐项相等）是否通过；CLI 据此置退出码。 */
  passed: boolean
}

/**
 * 生成第二套 schema 的演示库（SPEC §7）。同 seed + as-of 与 generateSample
 * 一致可复现；临时源库生成于 <path>.src.tmp，结束后删除。
 */
export async function generateAlt(options: AltOptions): Promise<AltResult> {
  const srcPath = `${options.path}.src.tmp`
  const generated = await generateSample({ path: srcPath, seed: options.seed, asOfMs: options.asOfMs, quiet: true })
  const { asOfMs } = generated
  const fmtDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
  const cutoff180 = new Date(asOfMs - 180 * DAY).toISOString().slice(0, 19).replace('T', ' ')
  const horizonEnd = fmtDay(asOfMs + 7 * DAY)
  if (!options.quiet) console.log(`生成 jc-alt.db：seed=${generated.seed}, as-of=${fmtDay(asOfMs)}`)

  for (const suffix of ['', '-wal', '-shm']) rmSync(options.path + suffix, { force: true })
  const { DatabaseSync } = await import('node:sqlite')
  const src = new DatabaseSync(srcPath, { readOnly: true })
  const dst = new DatabaseSync(options.path)
  let srcOpen = true
  try {
    dst.exec(SCHEMA)
    etl(src, dst)
    const pass = verify(dst, baselineFromSource(src, asOfMs, cutoff180, horizonEnd), baselineFromAlt(dst, cutoff180, horizonEnd), horizonEnd)
    dst.close()
    src.close()
    srcOpen = false
    return { path: options.path, seed: generated.seed, asOfMs, passed: pass && generated.passed }
  } finally {
    // node:sqlite 的属性访问在 close 后会抛错，用标志位而非 db.open 判断
    if (srcOpen) src.close()
    for (const suffix of ['', '-wal', '-shm']) rmSync(srcPath + suffix, { force: true })
  }
}

function parseArgs(argv: readonly string[]): { seed?: number; asOfMs?: number } {
  const out: { seed?: number; asOfMs?: number } = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--seed') out.seed = Number.parseInt(argv[i + 1] ?? '', 10)
    else if (argv[i] === '--as-of') out.asOfMs = Date.parse(`${argv[i + 1] ?? ''}T00:00:00Z`)
  }
  if (out.seed !== undefined && (!Number.isFinite(out.seed) || out.seed < 0)) throw new Error('--seed 需为非负整数')
  if (out.asOfMs !== undefined && !Number.isFinite(out.asOfMs)) throw new Error('--as-of 需为 YYYY-MM-DD')
  return out
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url))
  const args = parseArgs(process.argv.slice(2))
  generateAlt({ path: join(here, '..', 'data', 'jc-alt.db'), ...args }).then((result) => {
    if (!result.passed) process.exitCode = 1
  }, (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

// tsx/node 直跑入口（pnpm jc:gen:alt）；被 import 调用 generateAlt 时不执行
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
