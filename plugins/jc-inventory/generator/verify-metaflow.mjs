/**
 * W3 元流程离线验收（pnpm jc:verify:meta）。SPEC §12.3 的离线等价形式：
 * LLM 生成环节用参考夹具（fixtures/jc-alt.reference.ts，即「理想产出」）替代，
 * 其余环节（内省 → 白名单/编译静态校验 → 热加载 → 契约探针 → 四 Agent 双库
 * 数值对照）与运行时完全同路径。
 *
 * 前置：yarn gen && yarn gen:alt（生成 jc.db / jc-alt.db）。
 */
import { copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const P = join(dirname(fileURLToPath(import.meta.url)), '..')
const ALT_DB = join(P, 'data/jc-alt.db')
const DEMO_DB = join(P, 'data/jc.db')

const { introspectDatabase, renderSchemaForPrompt } = await import(`${P}/src/meta/introspect.ts`)
const { staticValidateFile, probeValidateAdapter } = await import(`${P}/src/meta/validate.ts`)
const { importGeneratedModule, generatedPath } = await import(`${P}/src/meta/generate.ts`)
const { runHealthScan, runShortageCheck, runDeadStock, runReplenish } = await import(`${P}/src/scans.ts`)
const { sqliteDemoAdapter } = await import(`${P}/src/adapters/sqlite-demo.ts`)

let failed = 0
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? `：${detail}` : ''}`)
  if (!pass) failed++
}

console.log('== 0. 摆放参考夹具（模拟元流程产物落盘）==')
copyFileSync(join(P, 'generator/fixtures/jc-alt.reference.ts'), generatedPath('jc-alt'))

console.log('== 1. 内省 jc-alt.db ==')
const summary = await introspectDatabase('sqlite', { path: ALT_DB })
const bizTables = summary.tables.filter((t) => !t.name.startsWith('jc_')).map((t) => t.name)
check('内省出 8 张业务表', bizTables.length === 8, bizTables.join(', '))
const ioFlag = summary.tables.find((t) => t.name === 'stock_txn')?.columns.find((c) => c.name === 'io_flag')
check('样本值含编码枚举（io_flag I/O）', ioFlag !== undefined && ioFlag.samples.some((s) => s === 'I'), JSON.stringify(ioFlag?.samples))
console.log(renderSchemaForPrompt(summary).split('\n').slice(0, 3).join('\n') + '\n  ...')

console.log('== 2. 静态校验 ==')
const good = await staticValidateFile(generatedPath('jc-alt'))
check('参考产物通过白名单+编译', good.ok, good.ok ? '' : good.errors.join(' | '))
const badPath = generatedPath('bad-fixture')
writeFileSync(badPath, "import { exec } from 'node:child_process'\nimport type { JcInventoryData } from '../../contract.ts'\nexport default { info: { name: 'x', dialect: 'sqlite', origin: 'generated', description: '' }, connect() {} }\n")
const bad = await staticValidateFile(badPath)
check('危险 import 反例被拒', !bad.ok, bad.errors.join(' | '))
const badFsPath = generatedPath('bad-fs')
writeFileSync(badFsPath, "import { writeFileSync } from 'node:fs'\nexport default { info: { name: 'x', dialect: 'sqlite', origin: 'generated', description: '' }, connect() {} }\n")
const badFs = await staticValidateFile(badFsPath)
check('node:fs 反例被拒', !badFs.ok, badFs.errors[0])
rmSync(badPath); rmSync(badFsPath)

console.log('== 3. 热加载 + 契约探针 ==')
const module = await importGeneratedModule('jc-alt')
check('产物可动态 import（default export 形态正确）', typeof module.connect === 'function')
const dynamic = await probeValidateAdapter(module, { path: ALT_DB })
check('契约探针全过', dynamic.ok, dynamic.results.map((r) => `${r.id}:${r.ok ? 'ok' : 'FAIL'}`).join(' '))
if (!dynamic.ok) console.log(dynamic.results.filter((r) => !r.ok))

console.log('== 4. 四 Agent 双库数值对照（demo vs alt）==')
const demo = await sqliteDemoAdapter.connect({ path: DEMO_DB })
const alt = await importGeneratedModule('jc-alt').then((m) => m.connect({ path: ALT_DB }))
try {
  const h1 = runHealthScan(demo), h2 = runHealthScan(alt)
  check('健康扫描 SKU 数', h1.scannedSkus === h2.scannedSkus, `${h1.scannedSkus} vs ${h2.scannedSkus}`)
  check('高风险 SKU 数（187）', h1.deviation.highRiskCount === h2.deviation.highRiskCount && h1.deviation.highRiskCount === 187, String(h2.deviation.highRiskCount))
  const m1 = h1.deviation.meanDeviationPct ?? 0, m2 = h2.deviation.meanDeviationPct ?? 0
  check('平均偏差率', Math.abs(m1 - m2) < 0.01, `${m1.toFixed(2)} vs ${m2.toFixed(2)}`)
  check('红/黄分级', h1.deviation.redCount === h2.deviation.redCount && h1.deviation.yellowCount === h2.deviation.yellowCount, `${h2.deviation.redCount}/${h2.deviation.yellowCount}`)
  check('库龄 >180 天金额占比', Math.abs(h1.ageBuckets[3].sharePct - h2.ageBuckets[3].sharePct) < 0.01, `${h1.ageBuckets[3].sharePct.toFixed(2)} vs ${h2.ageBuckets[3].sharePct.toFixed(2)}`)
  check('ABC 复核不符数', h1.abcMismatchCount === h2.abcMismatchCount, `${h1.abcMismatchCount} vs ${h2.abcMismatchCount}`)

  const s1 = runShortageCheck(demo), s2 = runShortageCheck(alt)
  check('展望期工单数', s1.workOrdersInHorizon === s2.workOrdersInHorizon, `${s1.workOrdersInHorizon} vs ${s2.workOrdersInHorizon}`)
  check('缺料工单数', s1.shortWorkOrders === s2.shortWorkOrders, `${s1.shortWorkOrders} vs ${s2.shortWorkOrders}`)
  check('齐套率', Math.abs(s1.kittingRatePct - s2.kittingRatePct) < 0.01, `${s1.kittingRatePct.toFixed(1)} vs ${s2.kittingRatePct.toFixed(1)}`)
  const gapKey = (r) => r.gaps.map((g) => `${g.componentSku}:${g.gapQty}`).sort().join(',')
  check('缺口清单逐项一致', gapKey(s1) === gapKey(s2), `${s1.gaps.length} vs ${s2.gaps.length} 项`)
  const case2 = s2.gaps.find((g) => g.componentSku === 'RM-90001')
  check('案例二（铝合金锭缺口 2200）', case2 !== undefined && case2.gapQty === 2200, case2 ? `gap=${case2.gapQty}` : '未命中')

  const d1 = runDeadStock(demo), d2 = runDeadStock(alt)
  check('呆滞清单条数', d1.items.length === d2.items.length, `${d1.items.length} vs ${d2.items.length}`)
  check('呆滞金额', Math.abs(d1.totalValueYuan - d2.totalValueYuan) < 1, `${(d1.totalValueYuan / 1e4).toFixed(1)} vs ${(d2.totalValueYuan / 1e4).toFixed(1)} 万元`)
  check('呆滞占比（≈16.7%）', d2.sharePct !== null && Math.abs(d2.sharePct - (d1.sharePct ?? 0)) < 0.01, `${d2.sharePct?.toFixed(2)}%`)
  check('成因归类一致', JSON.stringify(d1.byCause) === JSON.stringify(d2.byCause), JSON.stringify(d2.byCause))

  const r1 = runReplenish(demo), r2 = runReplenish(alt)
  check('补货建议条数', r1.items.length === r2.items.length, `${r1.items.length} vs ${r2.items.length}`)
  const repKey = (r) => r.items.map((i) => `${i.sku}:${i.suggestedQty}`).sort().join(',')
  check('补货量逐项一致', repKey(r1) === repKey(r2))
} finally {
  sqliteDemoAdapter.disconnect?.(demo)
  module.disconnect?.(alt)
}

console.log(failed === 0 ? '\nW3 离线验收全部通过 ✓' : `\n${failed} 项未通过 ✗`)
process.exitCode = failed === 0 ? 0 : 1
