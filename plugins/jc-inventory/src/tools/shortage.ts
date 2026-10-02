/**
 * 缺料预警工具（SPEC §8.3）：展望期工单 × BOM 净需求，缺口与紧急采购草案。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { runShortageCheck } from '../scans.ts'

export const name = 'jc-inventory-tools-shortage'
export const inject = ['tools', 'jcInventoryData']

const UNAVAILABLE = '库存数据源不可用（原因可用 inv_adapter_status 查询）。请引导用户二选一：接入既有数据库（inv_connect_database，元流程自动生成适配器）或生成演示库（inv_prepare_demo_db）。'

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'inv_shortage_check',
    description: '缺料预警：检查未来 N 天（默认 7 天）工单的物料齐套情况，返回缺口清单（缺口量、最早开工日、涉及工单、距开工不足提前期的加急标记）与紧急采购建议草案，自动写入预警和建议。',
    parameters: {
      horizonDays: { type: 'integer', description: '展望期天数，默认取配置 7 天' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '结论摘要（工单数、齐套率、缺口数、加急数）' },
          report: { type: 'object', description: '缺口明细（每个缺口：需求/可用/缺口量、开工日、工单、建议采购量）', additionalProperties: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const svc = ctx.jcInventoryData
      if (!svc.available) return { summary: UNAVAILABLE, report: {} }
      const report = runShortageCheck(svc, args.horizonDays)
      const urgentCount = report.gaps.filter((g) => g.urgent).length
      const summary = [
        `未来 ${report.horizonDays} 天 ${report.workOrdersInHorizon} 张工单，齐套率 ${report.kittingRatePct}%；`,
        `缺料组件 ${report.gaps.length} 种，其中 ${urgentCount} 种距开工不足提前期需紧急采购，`,
        `已写入预警 ${report.alertsWritten} 条、采购建议草案已生成。`,
      ].join('')
      return { summary, report }
    },
  }))
}
