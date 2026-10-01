# jc-inventory — JC 公司库管智能体（DSH 插件）

独立本地 Cordis 插件包（SPEC：仓库根 `docs/SPEC.md` v2）。不进上游子模块、
不注册上游 workspace、不发布 npm；以 `file:` 安装进 DSH Desktop profile
或开发沙箱 `dsh web` profile。

## 结构（SPEC §3）

```
src/
├── contract.ts        # 数据契约：JcInventoryData + 适配器模块形态 + 探针套件（业务口径权威）
├── types.ts           # 契约语义类型（Material / StockView / Movement / ...）
├── data-service.ts    # jcInventoryData 服务，代理到 registry 当前适配器
├── adapters/
│   ├── sqlite-demo.ts # 内置演示适配器（W1 占位 → W2 完整实现 → W3 元流程范例）
│   └── generated/     # 元流程产物落盘（gitignore）
├── meta/              # W3：内省 / 生成 / 校验 / 提示词
├── tools/             # inv_* 工具（W1：meta.ts）
├── scans.ts           # W2：四 Agent 确定性业务逻辑
├── predict.ts         # W2：统计预测纯函数
├── prompts.ts         # W2/W4：系统提示词插件
└── scheduler.ts       # W2/W4：定时任务插件
generator/             # W2：演示库生成器（generate.ts / scenarios.ts / alt-schema.ts）
data/                  # 生成的 jc.db（gitignore）
```

## 安装与验证（开发沙箱）

```sh
# 在 deepseek-harness 子模块内（上游源码 + tsx 启动）：
export DSH_HOME=<隔离目录>          # 不动真实 ~/.dsh
pnpm dsh plugin add file:<本仓库>/plugins/jc-inventory --profile <name>
pnpm dsh --profile <name> web       # Web UI 中对话调用 inv_adapter_status
```

Desktop 正式路径：profile 内以 `file:` 依赖安装后重启进入下一次 Loader 组合
（Desktop 规则：不改子模块、不热改激活 profile）。

## 本地 typecheck

```sh
cd plugins/jc-inventory && pnpm exec tsc -p tsconfig.json
```

`tsconfig.json` 以相对 `paths` 映射到 `../../deepseek-harness` 的源码平面
（`vendor/cordis/src`、`packages/core/tools/src`），不依赖构建产物。

## 里程碑

- **W1（当前）**：包骨架、数据契约定稿（contract.ts + 探针）、registry +
  data-service + sqlite-demo 占位 + `inv_adapter_status`。
- W2：迁移业务层为只依赖契约；sqlite-demo 完整实现 + jc.db 生成器。
- W3：元流程 MVP（内省 → 生成 → 校验 → 热加载）。
- W4–W8：工具组完善、回溯测试、演示打磨（见 SPEC §11）。
