# dsh-plugin-jc-inventory — JC 公司库管智能体

独立 Cordis 插件包。
**随安装包内置**——每个 profile、每次 Host generation 都加载，用户不可误删。

## 内置链路

1. 根 `package.json` 的 `workspaces` 已登记 `plugins/jc-inventory`。
2. `dsh-plugin-desktop` 的 dependencies 声明 `dsh-plugin-jc-inventory: workspace:*`。
3. `dsh-plugin-desktop/src/profile.ts` launcher patch 组装处插入 `{ insert: [{ id: 'jc-inventory', name: 'dsh-plugin-jc-inventory' }] }`。

## 结构

```
src/
├── index.ts           # 包入口
├── contract.ts        # 数据契约
├── types.ts           # 契约语义类型
├── data-service.ts    # jcInventoryData 服务，代理到 registry 当前适配器
├── adapters/
│   ├── sqlite-demo.ts # 内置演示适配器
│   └── generated/     # 元流程产物（gitignore）
├── meta/              # 元流程：内省 / 生成 / 校验 / 提示词
├── demo-db/           # 演示库生成
├── tools/             # inv_* 工具
├── scans.ts           # 库管确定性业务逻辑
├── predict.ts         # 统计预测纯函数
└── prompts.ts         # 系统提示词插件
generator/             # 生成器 CLI 包装 + alt-schema + 元流程离线验收脚本
data/                  # 生成的 jc.db（gitignore）
```

每个业务文件是独立 Cordis 插件，入口 `src/index.ts` 互相组合；
子插件依赖（cordis / dsh-tools）装在本包 dependencies 内，
随 Desktop 依赖闭包打进安装包。
