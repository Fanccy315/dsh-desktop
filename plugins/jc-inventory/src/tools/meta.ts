/**
 * 元流程工具组（SPEC §9.1）。W1 先落 `inv_adapter_status`：
 * 它是数据接入层一切状态问答的入口，也是 W1 的验收工具。
 * `inv_connect_database` / `inv_regenerate_adapter` 随 W3 元流程 MVP 落地。
 *
 * 工具只做 schema 声明与结果转述，数值与状态全部来自服务层（SPEC §9.8.1）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'jc-inventory-tools-meta'
export const inject = ['tools', 'jcInventoryData']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'inv_adapter_status',
    description: '查询库存数据源状态：当前适配器（名称/方言/来源 builtin 或 generated/描述）、可用性及原因、激活与切换历史。接入新库或数据异常时先用本工具确认现状。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          current: {
            type: 'json',
            description: '当前激活的适配器（name/dialect/origin/description/available/activatedAt/unavailableReason）',
          },
          history: { type: 'json', description: '切换历史（name/origin/event/at/detail）' },
          note: { type: 'string', description: '里程碑说明，无则为空串' },
        },
        required: ['current', 'history', 'note'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      const status = ctx.jcInventoryData.status()
      const note = !status.current.available && status.current.origin === 'builtin'
        ? '内置演示适配器为 W1 占位：查询实现与 jc.db 生成器在 W2 迁移（SPEC §11）'
        : ''
      return { current: status.current, history: status.history, note }
    },
  }))
}
