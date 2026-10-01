# generator/ — 演示库生成器（W2）

从旧实现（demo/deepseek-harness/plugins/jc-inventory/generator/）迁移：
`generate.ts`（主脚本，--seed/--as-of 可复现，基线自检 ±10%）、
`scenarios.ts`（报告三案例定向注入）、`alt-schema.ts`（第二套 schema 库，
元流程验收用）。产出 `../data/jc.db`（gitignore）。
