/**
 * 智能补货建议工具（SPEC §8.5）：净需求预测 + 动态安全库存 → 建议与采购审核闭环。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { runReplenish } from '../scans.ts'

export const name = 'jc-inventory-tools-replenish'
export const inject = ['tools', 'jcInventoryData']

const UNAVAILABLE = '库存数据源不可用（原因可用 inv_adapter_status 查询）。请引导用户二选一：接入既有数据库（inv_connect_database，元流程自动生成适配器）或生成演示库（inv_prepare_demo_db）。'

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'inv_replenish_suggest',
    description: '补货建议：对近 60 天有消耗的采购类物料做需求预测（移动平均 + Holt）与动态安全库存（服务水平 95%，按 ABC 类 × 需求波动 × 提前期）计算，返回建议补货量、建议下单日期与推荐供应商，写入待审核建议。只列需要补货的物料。',
    parameters: {
      sku: { type: 'string', description: '可选：只计算该 SKU 的补货建议' },
      warehouse: { type: 'string', description: '可选：限定库区（原材料仓/辅料仓/半成品仓）' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '结论摘要（扫描数、需补货数、最早建议日期）' },
          report: { type: 'object', description: '建议明细（每条：现库存/在途、日均需求、预测需求、安全库存、建议量与日期、供应商、建议编号）', additionalProperties: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const svc = ctx.jcInventoryData
      if (!svc.available) return { summary: UNAVAILABLE, report: {} }
      const report = runReplenish(svc, args.sku, args.warehouse)
      const earliest = report.items[0]?.suggestedDate
      const summary = report.items.length === 0
        ? `扫描 ${report.scannedSkus} 个活跃物料，当前库存与在途均能覆盖预测需求，无需补货。`
        : [
            `扫描 ${report.scannedSkus} 个活跃物料，${report.items.length} 个需要补货`,
            earliest ? `，最早建议下单日 ${earliest}` : '',
            '；建议已写入待审核列表（可用 inv_suggestion_decide 确认/调整/驳回）。',
          ].join('')
      return { summary, report }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'inv_suggestion_decide',
    description: '采购员审核一条补货/紧急采购建议：确认、调整或驳回，形成处置闭环。',
    parameters: {
      suggestionId: { type: 'integer', required: true, description: '建议编号（inv_replenish_suggest / inv_shortage_check 返回的 suggestionId，或 inv_list_alerts 相关建议里的 id）' },
      action: { type: 'string', required: true, enum: ['confirm', 'adjust', 'reject'], description: 'confirm=采纳、adjust=人工调整后执行、reject=驳回' },
      note: { type: 'string', description: '可选：审核备注（如调整后的数量、驳回原因）' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', description: '是否更新成功' },
          suggestion: { type: 'object', description: '更新后的建议行（编号、SKU、数量、日期、状态、备注）', additionalProperties: true },
          message: { type: 'string', description: '失败原因（编号不存在或已处理过）' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const svc = ctx.jcInventoryData
      if (!svc.available) {
        return { ok: false, suggestion: {}, message: UNAVAILABLE }
      }
      const row = svc.decideSuggestion(args.suggestionId, args.action, args.note)
      if (!row) {
        return { ok: false, suggestion: {}, message: `建议 ${args.suggestionId} 不存在或已处理过（只有 pending 状态可审核）` }
      }
      return { ok: true, suggestion: row, message: '' }
    },
  }))
}
