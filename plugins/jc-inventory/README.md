# dsh-plugin-jc-inventory — JC 公司库管智能体（DSH Desktop 内置插件）

独立 Cordis 插件包（SPEC：仓库根 `docs/SPEC.md` v2）。不进上游子模块、
不发布 npm；经 `dsh-plugin-desktop` 依赖闭包（`workspace:*`）+
launcher Loader patch **随安装包内置**——每个 profile、每次 Host
generation 都加载，用户不可误删（同 desktop-shell / webserver 的内置模式）。
旧的 `file:` 安装进 profile 与 `dsh.bundle.patch` 已废弃。

## 内置链路（SPEC §3「内置方式」）

1. 根 `package.json` 的 `workspaces` 已登记 `plugins/jc-inventory`（本包，正式包名）。
2. `dsh-plugin-desktop` 的 dependencies 声明
   `dsh-plugin-jc-inventory: workspace:*`。
3. `dsh-plugin-desktop/src/profile.ts` launcher patch 组装处插入
   `{ insert: [{ id: 'jc-inventory', name: 'dsh-plugin-jc-inventory' }] }`。
4. 原生依赖（如后续引入 better-sqlite3）需走仓库 asar 归档策略；
   当前 W1 无原生依赖（W2 演示库拟用 `node:sqlite`）。

## 结构（SPEC §3）

```
src/
├── index.ts           # 包入口：组合包内全部插件（launcher patch 加载点）
├── contract.ts        # 数据契约：JcInventoryData + 适配器模块形态 + 探针套件（业务口径权威）
├── types.ts           # 契约语义类型（Material / StockView / Movement / ...）
├── data-service.ts    # jcInventoryData 服务，代理到 registry 当前适配器
├── adapters/
│   ├── sqlite-demo.ts # 内置演示适配器（W1 占位 → W2 完整实现 → W3 元流程范例）
│   └── generated/     # 元流程产物落盘（gitignore）
├── meta/              # W3：内省 / 生成 / 校验 / 提示词
├── demo-db/           # 演示库生成核心（generate.ts / scenarios.ts，编译进 lib 供运行时调用）
├── tools/             # inv_* 工具（W1：meta.ts）
├── scans.ts           # W2：四 Agent 确定性业务逻辑
├── predict.ts         # W2：统计预测纯函数
└── prompts.ts         # W2/W4：系统提示词插件
generator/             # 生成器 CLI 包装 + alt-schema + 元流程离线验收脚本
data/                  # 生成的 jc.db（gitignore）
```

每个业务文件是独立 Cordis 插件，入口 `src/index.ts` 互相组合；
子插件依赖（cordis / dsh-tools）装在本包 dependencies 内，
随 Desktop 依赖闭包打进安装包。

## 构建与验证

```sh
# 仓库根（dsh-desktop）：
corepack yarn install --immutable     # 前置：git submodule update --init --recursive
corepack yarn dev                     # 开发：Desktop 启动即内置加载本插件
corepack yarn check                   # 门禁
corepack yarn build                   # 出包
```

本包自身：`yarn workspace dsh-plugin-jc-inventory build`（tsc 产 `lib/`，
供 Loader 以裸包名解析）、`... typecheck`（复用上游子模块 tsconfig 平面）。

W1 验收：`yarn dev` 启动后 Web UI 对话可调用 `inv_adapter_status`，
返回「内置演示适配器 W1 占位、W2 迁移」状态（SPEC §11）。

## 开发沙箱（可选，不影响交付形态）

开发期可在普通 `dsh web` 镜像直接指向本包源码调试（SPEC §3 构建命令），
内置路径只影响交付形态，不影响日常迭代。

## 里程碑

- **W1（当前）**：包骨架接入内置链路（workspaces + 依赖 + launcher
  patch）；数据契约定稿（contract.ts + 探针）；
  registry + data-service + sqlite-demo 占位 + `inv_adapter_status`。
- W2：迁移业务层为只依赖契约；sqlite-demo 完整实现 + jc.db 生成器。
- W3：元流程 MVP（内省 → 生成 → 校验 → 热加载）。
- W4–W8：工具组完善、回溯测试、演示打磨（见 SPEC §11）。
