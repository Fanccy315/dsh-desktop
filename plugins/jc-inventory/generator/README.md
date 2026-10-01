# generator/ — 演示库生成器（W2）+ 元流程验收（W3）

- `generate.ts`：主脚本（--seed/--as-of 可复现，基线自检 ±10%），产出 `../data/jc.db`。
- `scenarios.ts`：报告三案例定向注入。
- `alt-schema.ts`（`pnpm jc:gen:alt`）：第二套 schema 演示库 `data/jc-alt.db`
  （物料三表拆分 / ERP×WMS 合并 / I-O 编码 / 无智能体产出表），
  自检要求与源库基线统计逐项相等——元流程验收道具。
- `fixtures/jc-alt.reference.ts`：「理想元流程产物」参考适配器（离线验收夹具）。
- `verify-metaflow.mjs`（`pnpm jc:verify:meta`）：W3 离线验收——内省 →
  静态校验（正/反例）→ 热加载 → 契约探针 → 四 Agent 双库数值对照。
  LLM 生成环节（DEEPSEEK_API_KEY）在 `yarn dev` 对话中走完整元流程验证。

`data/` 与 `src/adapters/generated/` 均 gitignore。
