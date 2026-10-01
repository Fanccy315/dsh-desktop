/**
 * 内置 SQLite 演示适配器（SPEC §3：元流程首个实例 + 提示词范例）。
 *
 * 本文件有三重身份：
 * 1. W1：占位实现——契约形态就位，查询实现与演示库生成器在 W2 从
 *    deepseek-harness 侧（旧实现）迁移进来；
 * 2. W2：完整的演示数据源（generator/ 产出的 data/jc.db，schema 见 SPEC §6）；
 * 3. W3 起：元流程提示词的完整范例源码——新适配器的业务口径、错误处理、
 *    方言写法均以本文件为准（范例即文档，SPEC §5.2）。
 *
 * 迁移时的口径提醒：旧实现把偏差率/风险标记算在服务层 SQL 里；v2 契约
 * 只搬运原始数量（见 contract.ts 口径纪律），派生计算移入业务层。
 */

import type { JcInventoryAdapterModule } from '../contract.ts'

const sqliteDemoAdapter: JcInventoryAdapterModule = {
  info: {
    name: 'sqlite-demo',
    dialect: 'sqlite',
    origin: 'builtin',
    description: '内置 SQLite 演示适配器（W1 占位：W2 迁移查询实现与 data/jc.db 生成器）',
  },

  connect() {
    // W1 占位：W2 在此打开 data/jc.db（node:sqlite，惰性 import 避免
    // 实验警告打断启动——同旧实现 data-service.ts 的做法）并返回完整契约实现。
    throw new Error('sqlite-demo 尚未迁移查询实现（W2 里程碑）：当前为 W1 占位，仅验证插件加载与契约形态')
  },
}

export default sqliteDemoAdapter
export { sqliteDemoAdapter }
