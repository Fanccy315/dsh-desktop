/**
 * 定时任务插件（SPEC §10）：周期执行健康扫描、缺料检查、呆滞周报。
 * 间隔每次从 settings 表读取（演示时可改小立即生效），Cordis 卸载时自动清理定时器。
 * 预警写入均有 open 状态去重，周期重跑不会刷屏。
 */

import type { Context } from '@deepseek-ai/cordis'
import { runDeadStock, runHealthScan, runShortageCheck } from './scans.ts'

export const name = 'jc-inventory-scheduler'
export const inject = ['jcInventoryData']

/** settings 缺省间隔（分钟），SPEC §8/§10。 */
const DEFAULT_SCAN_MINUTES = 30
const DEFAULT_SHORTAGE_MINUTES = 10
const DEFAULT_DEADSTOCK_DAYS = 7

/** 启动后首次执行延迟（毫秒）：让演示一打开就有预警数据。 */
const FIRST_RUN_DELAY_MS = 10_000

/** 调度器可用的服务视图：jcInventoryData 服务（含 available 状态 + 契约方法）。 */
type Svc = Context['jcInventoryData']

interface Job {
  label: string
  intervalMinutes: (svc: Svc) => number
  run: (svc: Svc) => void
}

/** 各任务的间隔来源与执行体。 */
const JOBS: Job[] = [
  {
    label: '健康扫描',
    intervalMinutes: (svc) => svc.getNumberSetting('scan.intervalMinutes', DEFAULT_SCAN_MINUTES),
    run: (svc) => {
      const r = runHealthScan(svc)
      console.log(`[jc-scheduler] 健康扫描：${r.scannedSkus} SKU，高风险 ${r.deviation.highRiskCount}，新预警 ${r.alertsWritten}`)
    },
  },
  {
    label: '缺料检查',
    intervalMinutes: (svc) => svc.getNumberSetting('shortage.intervalMinutes', DEFAULT_SHORTAGE_MINUTES),
    run: (svc) => {
      const r = runShortageCheck(svc)
      console.log(`[jc-scheduler] 缺料检查：齐套率 ${r.kittingRatePct}%，缺口 ${r.gaps.length} 种，新预警 ${r.alertsWritten}`)
    },
  },
  {
    label: '呆滞周报',
    intervalMinutes: (svc) => svc.getNumberSetting('deadstock.intervalDays', DEFAULT_DEADSTOCK_DAYS) * 24 * 60,
    run: (svc) => {
      const r = runDeadStock(svc)
      const red = r.items.filter((i) => i.tier === 'red')
      const redValue = red.reduce((s, i) => s + i.valueYuan, 0)
      console.log(`[jc-scheduler] 呆滞周报：硬呆滞 ${red.length} 个/${(redValue / 10_000).toFixed(1)} 万元，占原材料 ${r.sharePct ?? '-'}%，新预警 ${r.alertsWritten}`)
    },
  },
]

export function apply(ctx: Context) {
  const svc = ctx.jcInventoryData
  const timers = new Set<NodeJS.Timeout>()

  function schedule(job: Job, delayMs: number): void {
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (!svc.available) {
        ctx.logger.warn(`[jc-scheduler] ${job.label}跳过：库存数据库不可用（初始化失败，见启动日志）`)
      } else {
        try {
          job.run(svc)
        } catch (error) {
          ctx.logger.warn(`[jc-scheduler] ${job.label}执行失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      schedule(job, Math.max(1, job.intervalMinutes(svc)) * 60_000)
    }, delayMs)
    timers.add(timer)
  }

  for (const job of JOBS) schedule(job, FIRST_RUN_DELAY_MS)

  ctx.effect(() => () => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  })
}
