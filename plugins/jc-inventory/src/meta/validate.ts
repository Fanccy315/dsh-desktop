/**
 * 元流程第 4 步：校验。两道确定性关卡，全过才可激活：
 *
 * 1. 静态：import 白名单扫描（仅驱动 / contract.ts / types.ts，且后者必须
 *    import type）+ 禁止 require / eval / new Function / process.env；
 *    再用 TypeScript 编译器做真类型检查（typescript 不可用时降级为
 *    node:module 的 stripTypeScriptTypes 语法检查并记 warning）。
 * 2. 动态：真实 connect 后逐条执行契约探针套件（defineJcInventoryProbes），
 *    断言结构与口径；写闭环探针对只读库降级为缺口报告而非失败（SPEC §5.1）。
 *
 * 所有失败信息都是给人也是给 LLM 看的——直接回喂修订提示词（上限 3 次）。
 */

import type {
  AdapterConnectOptions,
  ContractProbe,
  JcInventoryAdapterModule,
} from "../contract.ts";
import { defineJcInventoryProbes } from "../contract.ts";

// —— 静态校验 ——————————————————————————————————————————————

/** 静态校验结论。 */
export interface StaticValidation {
  ok: boolean;
  /** 逐条可读错误（回喂 LLM 用）。 */
  errors: string[];
  warnings: string[];
}

/** 允许的 import 来源：数据库驱动（按方言）+ 契约/类型（仅 import type）。 */
const DRIVER_SOURCES = new Set(["node:sqlite", "mysql2", "pg"]);
const TYPE_ONLY_SOURCES = new Set(["../../contract.ts", "../../types.ts"]);

/** 提取全部静态 import-from 的来源（含 export ... from；import type 单列）。 */
function extractImportSources(code: string): {
  typeImports: string[];
  valueImports: string[];
} {
  const typeImports: string[] = [];
  const valueImports: string[] = [];
  const fromMatches = code.matchAll(
    /(?:^|\n)\s*(?:import|export)\s+([\s\S]*?)from\s*['"]([^'"]+)['"]/g,
  );
  for (const match of fromMatches) {
    const clause = match[1] ?? "";
    const source = match[2] ?? "";
    if (/^type[\s{]/.test(clause.trim())) typeImports.push(source);
    else valueImports.push(source);
  }
  for (const match of code.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    valueImports.push(match[1] ?? "");
  }
  return { typeImports, valueImports };
}

/** 白名单扫描：来源不在允许集、契约做值导入、危险构造，任一命中即错误。 */
function scanWhitelist(code: string): string[] {
  const errors: string[] = [];
  const { typeImports, valueImports } = extractImportSources(code);
  for (const source of typeImports) {
    if (!TYPE_ONLY_SOURCES.has(source) && !DRIVER_SOURCES.has(source)) {
      errors.push(
        `import type 来源不在白名单：'${source}'（仅允许 ../../contract.ts / ../../types.ts 与数据库驱动）`,
      );
    }
  }
  for (const source of valueImports) {
    if (TYPE_ONLY_SOURCES.has(source))
      errors.push(`'${source}' 只能 import type（契约与类型无运行时导出）`);
    else if (!DRIVER_SOURCES.has(source))
      errors.push(
        `值导入来源不在白名单：'${source}'（仅允许数据库驱动 ${[...DRIVER_SOURCES].map((s) => `'${s}'`).join(" / ")}）`,
      );
  }
  for (const [pattern, label] of [
    [/require\s*\(/, "禁止 require(...)"],
    [/\beval\s*\(/, "禁止 eval(...)"],
    [/\bnew\s+Function\b/, "禁止 new Function"],
    [/process\.env\b/, "禁止读取 process.env（凭据经连接参数传入）"],
  ] as const) {
    if (pattern.test(code)) errors.push(label);
  }
  return errors;
}

/** TypeScript 编译检查；编译器不可用时降级为类型剥离语法检查。 */
async function compileCheck(
  tsPath: string,
  warnings: string[],
): Promise<string[]> {
  try {
    const ts = await import("typescript");
    const program = ts.createProgram([tsPath], {
      noEmit: true,
      strict: true,
      target: ts.ScriptTarget.ES2024,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      allowImportingTsExtensions: true,
      esModuleInterop: true,
      skipLibCheck: true,
      types: ["node"],
    });
    return ts
      .getPreEmitDiagnostics(program)
      .filter((diagnostic) => diagnostic.file !== undefined)
      .slice(0, 12)
      .map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      );
  } catch {
    try {
      const { stripTypeScriptTypes } = await import("node:module");
      const { readFileSync } = await import("node:fs");
      stripTypeScriptTypes(readFileSync(tsPath, "utf8"));
      warnings.push(
        "typescript 编译器不可用：仅完成语法级检查（类型检查降级），运行时探针仍然全量执行",
      );
      return [];
    } catch {
      return ["生成的代码无法通过 TypeScript 语法解析（strip 检查失败）"];
    }
  }
}

/** 静态校验入口：对已落盘的适配器源码做白名单 + 编译双重检查。 */
export async function staticValidateFile(
  tsPath: string,
): Promise<StaticValidation> {
  const { readFileSync } = await import("node:fs");
  const code = readFileSync(tsPath, "utf8");
  const warnings: string[] = [];
  const errors = [
    ...scanWhitelist(code),
    ...(await compileCheck(tsPath, warnings)),
  ];
  return { ok: errors.length === 0, errors, warnings };
}

// —— 动态校验（契约探针）—————————————————————————————————————

/** 单条探针结果。 */
export interface ProbeResult {
  id: string;
  description: string;
  /** 写闭环探针对只读库降级跳过时为 true（缺口而非失败）。 */
  degraded: boolean;
  ok: boolean;
  error?: string;
}

/** 动态校验结论：探针明细 + 语义缺口（给用户的降级说明）。 */
export interface DynamicValidation {
  ok: boolean;
  results: ProbeResult[];
  /** 降级缺口说明（如「目标库只读，预警写入不可用」）。 */
  gaps: string[];
}

const READONLY_HINT = /readonly|READONLY|OPENED_FOR_READONLY|read-only/i;

/**
 * 动态校验入口：connect 后逐条执行契约探针套件。
 * connect 本身抛错（缺关键表/库不可达）计为整体失败并原样回喂错误消息。
 */
export async function probeValidateAdapter(
  module: JcInventoryAdapterModule,
  options: AdapterConnectOptions,
  probes: ContractProbe[] = defineJcInventoryProbes(),
): Promise<DynamicValidation> {
  const results: ProbeResult[] = [];
  const gaps: string[] = [];
  let data;
  try {
    data = await module.connect(options);
  } catch (error) {
    return {
      ok: false,
      results: [
        {
          id: "connect",
          description: "connect 建立连接",
          degraded: false,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
      ],
      gaps,
    };
  }
  try {
    for (const probe of probes) {
      try {
        await probe.run(data);
        results.push({
          id: probe.id,
          description: probe.description,
          degraded: false,
          ok: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (probe.writes && READONLY_HINT.test(message)) {
          results.push({
            id: probe.id,
            description: probe.description,
            degraded: true,
            ok: false,
            error: message,
          });
          gaps.push(
            `目标库只读：${probe.description}——写闭环不可用，激活后预警/建议写入会失败`,
          );
        } else {
          results.push({
            id: probe.id,
            description: probe.description,
            degraded: false,
            ok: false,
            error: message,
          });
        }
      }
    }
  } finally {
    module.disconnect?.(data);
  }
  return { ok: results.every((r) => r.ok), results, gaps };
}
