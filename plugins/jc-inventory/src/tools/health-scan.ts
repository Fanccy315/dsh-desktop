/**
 * 库存健康扫描工具（SPEC §8.2）：全量确定性计算，LLM 只转述报告与建议文案。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { runHealthScan } from '../scans.ts'
import { UNAVAILABLE } from './shared.ts'

export const name = 'jc-inventory-tools-health-scan'
export const inject = ['tools', 'jcInventoryData']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'inv_health_scan',
    description: '库存健康扫描：账实偏差红黄分级、库龄分布、90 天周转率、ABC 类复核，高风险 SKU 自动写入预警。返回扫描摘要与偏差金额最高的风险清单。',
    parameters: {
      warehouse: { type: 'string', description: '可选：限定库区（原材料仓/半成品仓/成品仓/辅料仓），缺省全库扫描' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '一段结论摘要（SKU 数、总额、高风险数、周转率）' },
          report: { type: 'object', description: '完整扫描报告（偏差分级、库龄分桶、周转、ABC 复核、top 风险行）', additionalProperties: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const svc = ctx.jcInventoryData
      if (!svc.available) return { summary: UNAVAILABLE, report: {} }
      const report = runHealthScan(svc, args.warehouse)
      const scope = report.warehouse ?? '全库'
      const summary = [
        `${scope}扫描 ${report.scannedSkus} 个 SKU，库存总额 ${(report.totalValueYuan / 10_000).toFixed(1)} 万元。`,
        `账实偏差超阈值 ${report.deviation.highRiskCount} 个（占 ${report.deviation.highRiskSharePct}%，组内平均偏差率 ${report.deviation.meanDeviationPct ?? '-'}%），`,
        `其中红色 ${report.deviation.redCount} 个、黄色 ${report.deviation.yellowCount} 个，已写入预警 ${report.alertsWritten} 条。`,
        `90 天周转率 ${report.turnover.ratioPct}%；库龄超 180 天金额占比 ${report.ageBuckets[3].sharePct}%；`,
        `ABC 类与实际价值排名不符 ${report.abcMismatchCount} 个。`,
      ].join('')
      return { summary, report }
    },
  }))
}
