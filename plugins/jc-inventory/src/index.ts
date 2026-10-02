/**
 * 包入口
 */

import type { Context } from "@deepseek-ai/cordis";
import JcInventoryAdapterRegistry from "./adapters/registry.ts";
import JcInventoryDataService from "./data-service.ts";
import * as metaTools from "./tools/meta.ts";
import * as queryTools from "./tools/stock-query.ts";
import * as healthScanTools from "./tools/health-scan.ts";
import * as shortageTools from "./tools/shortage.ts";
import * as deadStockTools from "./tools/dead-stock.ts";
import * as replenishTools from "./tools/replenish.ts";
import * as prompts from "./prompts.ts";

export const name = "jc-inventory";
export const inject: readonly string[] = [];

export function apply(ctx: Context): void {
  ctx.plugin(JcInventoryAdapterRegistry);
  ctx.plugin(JcInventoryDataService);
  ctx.plugin(metaTools);
  ctx.plugin(queryTools);
  ctx.plugin(healthScanTools);
  ctx.plugin(shortageTools);
  ctx.plugin(deadStockTools);
  ctx.plugin(replenishTools);
  ctx.plugin(prompts);
}
