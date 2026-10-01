/**
 * 元流程提示词模板（SPEC §5.2 第 3 步）。
 *
 * 组装 = 生成任务说明与硬性约束 + 数据契约源码（口径权威）
 *      + 演示适配器完整源码（范例即文档）+ 目标库 schema 摘要
 *      + 方言注意事项；校验失败时把错误回喂（修订模式）。
 *
 * 契约 / 类型 / 范例的 .ts 源码在运行时从插件目录读取：
 * dev（dsh web 指向 src）与编译态（lib → ../../src）均可解析，
 * 源文件更新即提示词更新，无需另维护一份文档。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AdapterDialect } from '../contract.ts'
import type { SchemaSummary } from './introspect.ts'
import { renderSchemaForPrompt } from './introspect.ts'

/** 相对 src/ 的插件源码文件；生成提示词注入其完整内容。 */
const CONTRACT_SOURCE = readPluginSource('contract.ts')
const TYPES_SOURCE = readPluginSource('types.ts')
const DEMO_SOURCE = readPluginSource('adapters/sqlite-demo.ts')

/**
 * 读取插件自身源码：先按 import.meta.url 同级（dev：src/meta → src/），
 * 再按包根 src/（编译态：lib/meta → ../../src/）。两者皆失败返回占位
 * 提示（源码缺失不影响启动，只在生成时让 LLM 退化到内联说明）。
 */
function readPluginSource(relPath: string): string {
  for (const url of [new URL(`../${relPath}`, import.meta.url), new URL(`../../src/${relPath}`, import.meta.url)]) {
    try {
      return readFileSync(fileURLToPath(url), 'utf8')
    } catch {
      // 尝试下一个候选路径
    }
  }
  return `/* 源码文件 ${relPath} 不可读：请仅依据本提示词内的说明实现 */`
}

/** 方言注意事项（范例之外仅有的 SQL 写法指引）。 */
const DIALECT_NOTES: Record<AdapterDialect, string> = {
  sqlite: [
    '- 驱动用 node:sqlite 的 DatabaseSync（同步 API）：连接用 `new DatabaseSync(path)`，惰性加载用 `await import(\'node:sqlite\')`。',
    '- 参数绑定用 `?` 占位；日期比较直接用字符串比较（格式 YYYY-MM-DD HH:MM:SS 字典序即时间序）。',
    '- LIKE 模糊查询用 `... LIKE ?` 传 `%keyword%`；聚合用 SUM/GROUP BY。',
  ].join('\n'),
  mysql: '- mysql 方言暂未开放生成（本版本仅支持 sqlite）。',
  postgres: '- postgres 方言暂未开放生成（本版本仅支持 sqlite）。',
}

/** 生成任务说明与硬性约束（静态校验逐条对照，SPEC §5.3 白名单）。 */
const TASK_RULES = `你是资深数据集成工程师。为下面这个目标数据库生成一个 TypeScript 数据适配器模块，
把库中数据搬运进 JC 库管智能体的数据契约（JcInventoryData）。

输出要求（违反任何一条都会被静态校验拒绝）：
1. 只输出一个 TypeScript 代码块（\`\`\`ts ... \`\`\`），代码块之外不要有任何文字。
2. 代码顶部先写一个块注释「映射表」：每行一条 物理表.字段 → 契约方法/字段的映射，以及语义缺口（目标库没有的语义，如无在途列）。
3. 模块结尾 default export 一个 JcInventoryAdapterModule 对象（info.connect 语义照范例）。
4. import 只允许三类，其余一律禁止（含 require 与动态 import）：
   a. \`import type { ... } from '../../contract.ts'\` 与 \`import type { ... } from '../../types.ts'\`（产物位于 adapters/generated/，相对路径为 ../../）—— 必须是 import type；
   b. 数据库驱动：sqlite 方言仅 \`node:sqlite\`；
   c. 禁止 node:fs / node:child_process / node:http(s) / net / eval / new Function / process.env。
5. 只搬运原始数据：偏差率、库龄、无出库天数、风险分级、预测等派生计算一律在业务层，适配器不做任何算术（安全库存、库龄换算也不例外）。
6. 数量与时间口径严格按契约 JSDoc：数量非 null 时 ≥ 0、movements.qty 恒 > 0、时间为 ISO 8601 / YYYY-MM-DD；只读方法缺数据返回 null / 空数组而不抛错。
7. 目标库可能没有 alerts / suggestions / settings 表（智能体产出表）：在 connect 时对目标库执行 CREATE TABLE IF NOT EXISTS 自建副表（表名加 jc_ 前缀，列结构照范例），使写方法可用。
8. 写法（错误处理、分页 limit、LEFT JOIN 对齐、参数绑定）以范例为准；主键/去重语义见探针断言。范例中的 node:fs existsSync 预检不要照抄（白名单禁止 node:fs，库文件缺失时驱动自会报错）。`

/** 组装首轮生成提示词（system + user 拼一段，供一次性调用）。 */
export function buildGenerationPrompt(input: { summary: SchemaSummary }): string {
  return [
    TASK_RULES,
    '',
    '===== 数据契约（业务口径权威，JSDoc 即断言）=====',
    CONTRACT_SOURCE,
    '',
    '===== 契约语义类型 =====',
    TYPES_SOURCE,
    '',
    '===== 生成范例（内置 SQLite 演示适配器完整源码，写法以此为准）=====',
    DEMO_SOURCE,
    '',
    '===== 目标库 schema 摘要（含样本值；映射以真实取值为准）=====',
    renderSchemaForPrompt(input.summary),
    '',
    '===== 方言注意事项 =====',
    DIALECT_NOTES[input.summary.dialect],
    '',
    '现在输出适配器代码。',
  ].join('\n')
}

/** 组装修订提示词：回喂上一版代码与校验错误（SPEC §5.2 第 4 步失败重试）。 */
export function buildRevisionPrompt(input: { summary: SchemaSummary; previousCode: string; errors: readonly string[] }): string {
  return [
    buildGenerationPrompt(input),
    '',
    '===== 上一版代码（未通过校验，需修订）=====',
    '```ts',
    input.previousCode,
    '```',
    '',
    '===== 校验错误（逐条修复；映射表注释同步更新）=====',
    ...input.errors.map((error, i) => `${i + 1}. ${error}`),
    '',
    '输出修订后的完整代码（仍是单个代码块）。',
  ].join('\n')
}
