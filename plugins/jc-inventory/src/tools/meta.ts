/**
 * 元流程工具组（SPEC §9.1）。
 *
 * - inv_connect_database：接入 → 内省 → LLM 生成适配器 → 静态/动态校验，
 *   全过后停在「待确认」，用户确认后再次调用（confirmActivation: true）激活
 *   ——不存在「生成即生效」（SPEC §5.3）；候选缓存于 pending，二次调用不重跑。
 * - inv_regenerate_adapter：对当前接入连接重跑生成+校验（校验失败重试或
 *   范例升级后刷新）。
 * - inv_prepare_demo_db：生成演示库 data/jc.db 并激活内置演示适配器
 *   （数据源不可用时的兜底，演示库兜底路径的运行时入口，SPEC §7）。
 * - inv_adapter_status：数据源状态与切换历史（W1 落地，保留）。
 *
 * 工具只做 schema 声明与结果转述，流程编排数值全部来自 meta/ 服务层。
 */

import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DEMO_DB_PATH } from '../adapters/sqlite-demo.ts'
import type { AdapterConnectOptions, AdapterDialect } from '../contract.ts'
import { generateSample, type GenerateResult } from '../demo-db/generate.ts'
import { introspectDatabase } from '../meta/introspect.ts'
import { runMetaGeneration, sanitizeAdapterName, type MetaFlowResult } from '../meta/generate.ts'

export const name = 'jc-inventory-tools-meta'
export const inject = ['tools', 'jcInventoryData', 'jcInventoryAdapters', 'llm']

/** 待确认的候选产物：确认激活前缓存，confirmActivation 二次调用免重跑生成。 */
interface PendingCandidate {
  name: string
  dialect: AdapterDialect
  options: AdapterConnectOptions
  result: MetaFlowResult
}
let pending: PendingCandidate | null = null

/** 工具返回构造：report 各分支字段不同，统一经 JsonValue 视图交给 output schema。 */
function ret(status: string, summary: string, report: Record<string, unknown>) {
  return { status, summary, report: report as import('@deepseek-ai/dsh-util-values').JsonValue }
}

/** 从库路径/连接串推导适配器名（去扩展名），避开内置名 sqlite-demo。 */
function deriveName(rawName: string | undefined, path: string): string {
  const base = rawName !== undefined && rawName.trim() !== ''
    ? rawName
    : basename(path).replace(/\.[^.]+$/, '')
  const name = sanitizeAdapterName(base)
  return name === 'sqlite-demo' ? 'sqlite-demo-gen' : name
}

/** 生成报告的复述摘要（LLM 与用户读的都是这一段 + report 明细）。 */
function summarizeGeneration(result: MetaFlowResult): string {
  const attempts = result.attempts.length
  const last = result.attempts[attempts - 1]
  const gaps = [...new Set(result.attempts.flatMap((a) => a.warnings))]
  return [
    `适配器 ${result.name}：${attempts} 轮生成后${result.ok ? '通过全部校验' : '仍未通过校验'}（provider ${result.target.provider} / model ${result.target.model}）。`,
    result.ok ? `探针 ${result.dynamic?.results.length ?? 0} 条全部通过。` : `末轮错误：${last?.errors.join('；') ?? '无'}`,
    gaps.length > 0 ? `缺口说明：${gaps.join('；')}` : '',
  ].filter(Boolean).join('')
}

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'inv_connect_database',
    description: '元流程：接入一个新数据库（sqlite 库文件路径），自动内省 schema → 生成数据适配器 → 静态与契约探针双重校验。全部通过后返回映射表与缺口，待用户确认；用户确认后再次调用本工具（参数不变，另加 confirmActivation: true）完成激活，四个库存 Agent 随即对新库工作，全程不改代码不重启。',
    parameters: {
      dialect: { type: 'string', enum: ['sqlite', 'mysql', 'postgres'], required: true, description: '数据库方言（当前版本支持 sqlite）' },
      path: { type: 'string', required: true, description: 'sqlite 库文件绝对路径（mysql/postgres 预留：连接串）' },
      name: { type: 'string', description: '可选：数据源命名（缺省取文件名）' },
      confirmActivation: { type: 'boolean', description: '用户已确认激活时传 true：激活最近一次校验通过的候选适配器（其余参数保持与上次一致）' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', required: true, description: 'awaiting_confirmation / activated / introspect_failed / generation_failed / activation_failed' },
          summary: { type: 'string', required: true, description: '结论摘要（复述给用户）' },
          report: { type: 'json', required: true, description: '明细：映射表、探针结果、缺口、错误、当前数据源状态' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const registry = ctx.jcInventoryAdapters
      const path = args.path.trim()
      const name = deriveName(args.name, path)
      const dialect: AdapterDialect = args.dialect
      const options: AdapterConnectOptions = dialect === 'sqlite' ? { path } : { connectionString: path }

      // —— 确认激活分支：命中缓存的候选产物，热加载（SPEC §5.2 第 5 步）——
      if (args.confirmActivation) {
        if (pending === null || pending.name !== name) {
          return ret('activation_failed', `没有名为 ${name} 的待确认候选：请先不带 confirmActivation 调用本工具完成生成与校验。`, { pending: pending?.name ?? null })
        }
        await registry.activateGenerated(pending.name, pending.dialect, pending.options)
        const status = ctx.jcInventoryData.status()
        const ok = status.current.name === pending.name && status.current.available
        pending = ok ? null : pending
        return ret(
          ok ? 'activated' : 'activation_failed',
          ok
            ? `数据源已激活：${status.current.name}（${status.current.dialect}，元流程生成适配器）。四个库存 Agent 现在对新库工作，可立即查询验证。`
            : `激活失败：${status.current.unavailableReason ?? '连接失败（见切换历史）'}。原数据源继续服务。`,
          { adapterStatus: status },
        )
      }

      // —— 生成流程：内省 → 生成 → 校验（失败自动回喂重试 ≤3 次）——
      let summary
      try {
        summary = await introspectDatabase(dialect, options)
      } catch (error) {
        return ret('introspect_failed', `内省失败：${error instanceof Error ? error.message : String(error)}`, { dialect, path })
      }
      let result: MetaFlowResult
      try {
        result = await runMetaGeneration(ctx, { name, dialect, options, summary })
      } catch (error) {
        return ret('generation_failed', `生成失败：${error instanceof Error ? error.message : String(error)}`, {
          dialect,
          path,
          introspectedTables: summary.tables.map((t) => `${t.name}(${t.rowCount})`).join(', '),
        })
      }

      if (!result.ok) {
        return ret('generation_failed', `${summarizeGeneration(result)} 已达重试上限，请转人工处理（可先 inv_adapter_status 查看现状）。`, {
          attempts: result.attempts,
          tsPath: result.tsPath,
        })
      }
      pending = { name: result.name, dialect, options, result }
      registry.rememberConnection(result.name, dialect, options)
      return ret(
        'awaiting_confirmation',
        `${summarizeGeneration(result)} 请向用户复述映射表与缺口并请求确认；确认后再次调用本工具（参数不变，另加 confirmActivation: true）完成激活。`,
        {
          name: result.name,
          dialect,
          mappingNote: result.mappingNote,
          probes: result.dynamic?.results,
          gaps: result.dynamic?.gaps ?? [],
          attempts: result.attempts.length,
          introspectedTables: summary.tables.map((t) => `${t.name}(${t.rowCount}行)`),
          tsPath: result.tsPath,
        },
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'inv_regenerate_adapter',
    description: '元流程：对最近一次接入的数据库连接重跑「生成 + 校验」（用于校验失败后重试、或范例升级后刷新适配器）。当前是内置演示适配器（从未接入外部库）时不可用。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          report: { type: 'json', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      const registry = ctx.jcInventoryAdapters
      const conn = registry.currentConnection
      if (conn === null) {
        return ret('generation_failed', '当前是内置演示适配器（尚未接入外部库），无可重生成的连接。要接入新库请调用 inv_connect_database。', {
          adapterStatus: ctx.jcInventoryData.status(),
        })
      }
      let summary
      try {
        summary = await introspectDatabase(conn.dialect, conn.options)
      } catch (error) {
        return ret('introspect_failed', `内省失败：${error instanceof Error ? error.message : String(error)}`, {
          connection: { name: conn.name, dialect: conn.dialect },
        })
      }
      let result: MetaFlowResult
      try {
        result = await runMetaGeneration(ctx, { name: conn.name, dialect: conn.dialect, options: conn.options, summary })
      } catch (error) {
        return ret('generation_failed', `生成失败：${error instanceof Error ? error.message : String(error)}`, {
          connection: { name: conn.name, dialect: conn.dialect },
        })
      }
      if (!result.ok) {
        return ret('generation_failed', `${summarizeGeneration(result)} 已达重试上限，请转人工处理。当前数据源不受影响，继续服务。`, {
          attempts: result.attempts,
          tsPath: result.tsPath,
        })
      }
      pending = { name: result.name, dialect: conn.dialect, options: conn.options, result }
      return ret(
        'awaiting_confirmation',
        `${summarizeGeneration(result)} 确认后请用户在对话中确认，再调用 inv_connect_database（同参数 + confirmActivation: true）完成切换。`,
        {
          name: result.name,
          mappingNote: result.mappingNote,
          probes: result.dynamic?.results,
          gaps: result.dynamic?.gaps ?? [],
          attempts: result.attempts.length,
        },
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'inv_prepare_demo_db',
    description: '生成演示库 data/jc.db 并激活内置演示适配器（数据源不可用时的兜底，适合演示/试用；有真实数据库时改用 inv_connect_database 走元流程接入）。同 seed 结果逐行可复现，基线统计与报告口径对齐；当前已激活元流程生成的外部库时拒绝执行，避免把用户真实库切回演示库。',
    parameters: {
      seed: { type: 'number', description: '可选：随机种子（缺省用固定默认种子；基线校验未过时可换 seed 重跑）' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', required: true, description: 'prepared / already_available / baseline_failed / refused / generation_failed / activation_failed' },
          summary: { type: 'string', required: true, description: '结论摘要（复述给用户）' },
          report: { type: 'json', required: true, description: '明细：生成路径、seed、as-of、基线结论、当前数据源状态' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const registry = ctx.jcInventoryAdapters
      const before = ctx.jcInventoryData.status()
      if (before.current.origin === 'generated') {
        return ret('refused', `当前数据源是元流程接入的外部库（${before.current.name}），不切换回演示库。`, { adapterStatus: before })
      }
      if (before.current.name === 'sqlite-demo' && before.current.available) {
        return ret('already_available', '演示库已存在且内置适配器正在服务，无需生成。要改用外部数据库请调用 inv_connect_database。', { adapterStatus: before })
      }

      let result: GenerateResult
      try {
        result = await generateSample({ path: DEMO_DB_PATH, seed: args.seed, quiet: true })
      } catch (error) {
        return ret('generation_failed', `演示库生成失败：${error instanceof Error ? error.message : String(error)}`, { path: DEMO_DB_PATH })
      }
      await registry.reactivateDefault()
      const after = ctx.jcInventoryData.status()
      if (!after.current.available) {
        return ret('activation_failed', `演示库已生成（seed=${result.seed}）但激活失败：${after.current.unavailableReason ?? '连接失败（见切换历史）'}。`, {
          path: result.path,
          seed: result.seed,
          adapterStatus: after,
        })
      }
      const asOf = new Date(result.asOfMs).toISOString().slice(0, 10)
      return ret(
        result.passed ? 'prepared' : 'baseline_failed',
        result.passed
          ? `演示库已生成并激活（seed=${result.seed}，as-of=${asOf}），基线校验全部通过。四个库存 Agent 现在可用，可立即查询验证。`
          : `演示库已生成并激活（seed=${result.seed}，as-of=${asOf}），但基线统计超出报告口径 ±10%；可再次调用本工具换一个 seed 重跑。`,
        { path: result.path, seed: result.seed, asOf, baselinePassed: result.passed, adapterStatus: after },
      )
    },
  }))

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
            required: true,
            description: '当前激活的适配器（name/dialect/origin/description/available/activatedAt/unavailableReason）',
          },
          history: { type: 'json', required: true, description: '切换历史（name/origin/event/at/detail）' },
          note: { type: 'string', required: true, description: '里程碑说明，无则为空串' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      const status = ctx.jcInventoryData.status()
      const note = !status.current.available && status.current.origin === 'builtin'
        ? '内置演示适配器连接失败：可调用 inv_prepare_demo_db 生成演示库，或用 inv_connect_database 接入外部数据库'
        : ''
      return { current: status.current, history: status.history, note }
    },
  }))
}
