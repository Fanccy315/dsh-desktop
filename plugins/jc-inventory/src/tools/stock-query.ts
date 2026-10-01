/**
 * 查询类工具（SPEC §9.2）：仓管员对话入口。
 * 数值全部来自 jcInventoryData 服务与 scans.ts 的确定性计算，LLM 只做路由与转述。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AlertFilter, AlertType, Severity, AlertStatus } from '../types.ts'
import { queryStock } from '../scans.ts'

export const name = 'jc-inventory-tools-query'
export const inject = ['tools', 'jcInventoryData']

const UNAVAILABLE_NOTE = '库存数据库不可用：数据服务初始化失败（见启动日志）。'

/** 库存数据库是否可用。 */
function unavailable(svc: Context['jcInventoryData']): boolean {
  return !svc.available
}

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'inv_query_stock',
    description: '按物料名称或编码模糊查询库存：返回账面/实物/在途/已分配数量、库位、账实偏差率与高风险标记。',
    parameters: {
      keyword: { type: 'string', required: true, description: '物料名称或 SKU 编码，模糊匹配（如「M6×20 螺栓」「AL-合金锭」）' },
      warehouse: { type: 'string', description: '可选：限定库区（原材料仓/半成品仓/成品仓/辅料仓）' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          total: { type: 'integer', description: '命中 SKU 数' },
          items: { type: 'array', description: '库存明细行（sku、数量、库位、偏差率、风险标记）' },
          note: { type: 'string', description: '附加说明（数据缺失提示或风险摘要），无则为空串' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      if (unavailable(ctx.jcInventoryData)) {
        return { total: 0, items: [], note: UNAVAILABLE_NOTE }
      }
      const items = queryStock(ctx.jcInventoryData, args.keyword, args.warehouse)
      const riskCount = items.filter((item) => item.riskFlag).length
      return {
        total: items.length,
        items,
        note: riskCount > 0 ? `${riskCount} 个 SKU 账实偏差超过阈值，需关注` : '',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'inv_query_recent_moves',
    description: '查询某 SKU 近 N 天（默认 7 天）的出入库流水，用于判断消耗趋势。',
    parameters: {
      sku: { type: 'string', required: true, description: 'SKU 编码' },
      days: { type: 'integer', description: '回看天数，默认 7' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          total: { type: 'integer', description: '流水条数' },
          items: { type: 'array', description: '出入库流水（方向、数量、时间、来源）' },
          note: { type: 'string', description: '附加说明，无则为空串' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      if (unavailable(ctx.jcInventoryData)) {
        return { total: 0, items: [], note: UNAVAILABLE_NOTE }
      }
      const days = args.days && args.days > 0 ? args.days : 7
      const items = ctx.jcInventoryData.getMovements({ sku: args.sku, sinceDays: days, limit: 200 })
      const outQty = items.filter((m) => m.direction === 'out').reduce((sum, m) => sum + m.qty, 0)
      return {
        total: items.length,
        items,
        note: `近 ${days} 天累计出库 ${outQty}`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'inv_list_alerts',
    description: '查询站内预警/通知列表，可按类型（deviation/shortage/dead_stock）、级别（red/yellow/green）、状态（open/ack/resolved）过滤。',
    parameters: {
      type: { type: 'string', enum: ['deviation', 'shortage', 'dead_stock'], description: '可选：预警类型' },
      severity: { type: 'string', enum: ['red', 'yellow', 'green'], description: '可选：级别' },
      status: { type: 'string', enum: ['open', 'ack', 'resolved'], description: '可选：状态，默认全部' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          total: { type: 'integer', description: '预警条数' },
          items: { type: 'array', description: '预警明细（类型、SKU、级别、标题、状态、时间）' },
          note: { type: 'string', description: '附加说明，无则为空串' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      if (unavailable(ctx.jcInventoryData)) {
        return { total: 0, items: [], note: UNAVAILABLE_NOTE }
      }
      const filter: AlertFilter = {
        type: args.type as AlertType | undefined,
        severity: args.severity as Severity | undefined,
        status: args.status as AlertStatus | undefined,
      }
      const items = ctx.jcInventoryData.listAlerts(filter)
      return {
        total: items.length,
        items,
        note: '',
      }
    },
  }))
}
