/**
 * 呆滞料分析工具（SPEC §8.4）：呆滞清单、成因归类、统计预测与处置方向。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DEAD_CAUSE_LABELS, runDeadStock } from '../scans.ts'

export const name = 'jc-inventory-tools-dead-stock'
export const inject = ['tools', 'jcInventoryData']

const UNAVAILABLE = '库存数据库不可用：数据服务初始化失败（见启动日志）。'

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'inv_dead_stock',
    description: '呆滞料分析：找出库龄超阈值或长期无出库的物料，给出金额、成因归类（定制件客户终止/待检滞留/超量采购）、基于移动平均与指数平滑的消耗预测和处置方向，自动写入预警。',
    parameters: {
      ageDays: { type: 'integer', description: '呆滞判定的库龄阈值天数，默认取配置 180 天' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '结论摘要（呆滞金额、占原材料总额比、三成因分布）' },
          report: { type: 'object', description: '呆滞明细（每条：库龄/无出库天数/金额/成因/预测结论/处置方向）', additionalProperties: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const svc = ctx.jcInventoryData
      if (!svc.available) return { summary: UNAVAILABLE, report: {} }
      const report = runDeadStock(svc, args.ageDays)
      const redValue = report.items.filter((i) => i.tier === 'red').reduce((s, i) => s + i.valueYuan, 0)
      const causeText = report.byCause
        .map((c) => `${DEAD_CAUSE_LABELS[c.cause]} ${c.count} 个/${(c.valueYuan / 10_000).toFixed(1)} 万元`)
        .join('、')
      const summary = [
        `呆滞（库龄 > ${report.ageDays} 天）金额 ${(redValue / 10_000).toFixed(1)} 万元`,
        report.sharePct !== null ? `，占原材料库存总额 ${report.sharePct}%` : '',
        `；成因分布：${causeText}。`,
        `另有无出库超 ${report.noMoveDays} 天的慢动物料（含报告案例场景），处置方向已逐条给出。`,
      ].join('')
      return { summary, report }
    },
  }))
}
