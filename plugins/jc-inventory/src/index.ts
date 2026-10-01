/**
 * 包入口（SPEC §3 内置方式）：launcher Loader patch 以裸包名
 * `dsh-plugin-jc-inventory` 加载本模块，随安装包内置进每个 Host
 * generation（与 desktop-shell / webserver 同级，SPEC §0 代码位置）。
 *
 * 旧的 `dsh.bundle.patch`（file: 安装进 profile）已废弃；本入口改为
 * 组合包内全部插件：子插件各自声明 `inject`，加载顺序由服务依赖解析。
 */

import type { Context } from '@deepseek-ai/cordis'
import JcInventoryAdapterRegistry from './adapters/registry.ts'
import JcInventoryDataService from './data-service.ts'
import * as metaTools from './tools/meta.ts'
import * as queryTools from './tools/stock-query.ts'
import * as healthScanTools from './tools/health-scan.ts'
import * as shortageTools from './tools/shortage.ts'
import * as deadStockTools from './tools/dead-stock.ts'
import * as replenishTools from './tools/replenish.ts'
import * as scheduler from './scheduler.ts'
import * as prompts from './prompts.ts'

export const name = 'jc-inventory'
export const inject: readonly string[] = []

export function apply(ctx: Context): void {
  ctx.plugin(JcInventoryAdapterRegistry)
  ctx.plugin(JcInventoryDataService)
  ctx.plugin(metaTools)
  ctx.plugin(queryTools)
  ctx.plugin(healthScanTools)
  ctx.plugin(shortageTools)
  ctx.plugin(deadStockTools)
  ctx.plugin(replenishTools)
  ctx.plugin(scheduler)
  ctx.plugin(prompts)
}
