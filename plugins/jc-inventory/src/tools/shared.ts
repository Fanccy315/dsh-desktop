/**
 * 工具组共享常量：各工具文件复用的统一文案与守卫。
 */

import type { Context } from "@deepseek-ai/cordis";

/** 数据源不可用时返回给 LLM 的统一引导文案。 */
export const UNAVAILABLE = "库存数据源不可用";

/** 库存数据库是否可用。 */
export function unavailable(svc: Context["jcInventoryData"]): boolean {
  return !svc.available;
}
