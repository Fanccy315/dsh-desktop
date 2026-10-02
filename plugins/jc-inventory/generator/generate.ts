/**
 * 演示库生成器 CLI 包装（SPEC §7）：yarn gen [--seed N] [--as-of YYYY-MM-DD]。
 * 生成核心在 src/demo-db/generate.ts（编译进 lib，运行时 inv_prepare_demo_db 共用）。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SEED, generateSample } from '../src/demo-db/generate.ts'

function parseArgs(argv: readonly string[]): { seed: number; asOfMs: number } {
  let seed = DEFAULT_SEED
  const today = new Date()
  let asOfMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--seed') seed = Number.parseInt(argv[i + 1] ?? '', 10)
    else if (argv[i] === '--as-of') asOfMs = Date.parse(`${argv[i + 1] ?? ''}T00:00:00Z`)
  }
  if (!Number.isFinite(seed) || seed < 0) throw new Error('--seed 需为非负整数')
  if (!Number.isFinite(asOfMs)) throw new Error('--as-of 需为 YYYY-MM-DD')
  return { seed, asOfMs }
}

const { seed, asOfMs } = parseArgs(process.argv.slice(2))
const dbPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'jc.db')
generateSample({ path: dbPath, seed, asOfMs }).then((result) => {
  if (!result.passed) process.exitCode = 1
}, (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
