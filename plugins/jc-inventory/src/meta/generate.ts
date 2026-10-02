/**
 * 元流程第 3 步 + 编排：组装提示词 → 调宿主 LLM 生成适配器
 * 代码 → 落盘 adapters/generated/ → 静态校验 → 动态探针；失败把错误回喂
 * LLM 修订，上限 3 次（runMetaGeneration）。
 *
 * LLM 访问走宿主的 llm 服务（dsh-llm，公开扩展点）：默认 deepseek /
 * deepseek-flash（SPEC §4），可用环境变量 JC_INV_LLM_PROVIDER /
 * JC_INV_LLM_MODEL 切换（如生产 deepseek-v4-pro）。此处只声明消费的
 * 最小接口面，不引入 dsh-llm 类型闭包（同 prompts.ts 对 systemPrompt
 * 的处理）；流式块只取 text-delta 与 finish。
 *
 * 产物是**可擦除类型**的 .ts 模块（import type 被运行时类型剥离擦除），
 * 以带缓存戳的动态 import 热加载；宿主运行时不支持 .ts 时回退为
 * typescript 转译 .js 再加载。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type {
  AdapterConnectOptions,
  AdapterDialect,
  JcInventoryAdapterModule,
} from "../contract.ts";
import type { SchemaSummary } from "./introspect.ts";
import { buildGenerationPrompt, buildRevisionPrompt } from "./prompts.ts";
import type { DynamicValidation, StaticValidation } from "./validate.ts";
import { probeValidateAdapter, staticValidateFile } from "./validate.ts";

// 宿主 llm 服务的最小消费面（完整定义见 dsh-llm；此处不引入类型闭包）。
declare module "@deepseek-ai/cordis" {
  interface Context {
    llm: {
      listProviders(): Array<{ id: string; name: string }>;
      listModels(
        provider: string,
      ): Promise<Array<{ id: string; name: string }>>;
      stream(options: {
        provider: string;
        model: string;
        system?: string;
        messages: Array<{
          role: "user";
          content: Array<{ type: "text"; text: string }>;
        }>;
        maxTokens?: number;
        temperature?: number;
        purpose?: string;
        signal?: AbortSignal;
      }): AsyncIterable<{
        type: string;
        text?: string;
        reason?: { kind: string };
      }>;
    };
  }
}

/** 生成/校验重试上限（SPEC §5.2 第 4 步）。 */
export const MAX_ATTEMPTS = 3;
/** 单次生成的输出上限（适配器源码 < 500 行，范例规模）。 */
const MAX_TOKENS = 16_000;

/** 产物目录：<src|lib>/adapters/generated/（相对本文件，gitignore）。 */
export function generatedDir(): string {
  return fileURLToPath(new URL("../adapters/generated/", import.meta.url));
}

/** 适配器产物名：小写字母数字与连字符，防路径逃逸。 */
export function sanitizeAdapterName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned === "" ? "generated" : cleaned;
}

/** 产物落盘路径（generated/<name>.ts）。 */
export function generatedPath(name: string): string {
  return join(generatedDir(), `${sanitizeAdapterName(name)}.ts`);
}

/** 解析本次生成用的 provider/model：默认 deepseek/deepseek-flash，env 可覆盖。 */
export async function resolveGenerationTarget(
  ctx: Context,
): Promise<{ provider: string; model: string }> {
  const providers = ctx.llm.listProviders();
  if (providers.length === 0) {
    throw new Error(
      "宿主未配置任何 LLM provider：请在 Web UI Models 页配置模型或设置 DEEPSEEK_API_KEY 后重试",
    );
  }
  const wantedProvider = process.env.JC_INV_LLM_PROVIDER ?? "deepseek";
  const wantedModel = process.env.JC_INV_LLM_MODEL ?? "deepseek-flash";
  const provider = providers.some((p) => p.id === wantedProvider)
    ? wantedProvider
    : providers[0]!.id;
  const models = await ctx.llm
    .listModels(provider)
    .catch(() => [] as Array<{ id: string }>);
  const model = models.some((m) => m.id === wantedModel)
    ? wantedModel
    : (models[0]?.id ?? wantedModel);
  return { provider, model };
}

/** 一次性 LLM 调用：收集 text-delta 到 finish；异常终止/空输出抛可读错误。 */
async function callLlm(
  ctx: Context,
  target: { provider: string; model: string },
  prompt: string,
): Promise<string> {
  let text = "";
  let finish: { kind: string } | undefined;
  for await (const chunk of ctx.llm.stream({
    provider: target.provider,
    model: target.model,
    system:
      "你是严谨的数据集成工程师，只输出被要求的 TypeScript 代码，不输出多余解释。",
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    maxTokens: MAX_TOKENS,
    temperature: 0,
    purpose: "jc-inventory-metaflow",
  })) {
    if (chunk.type === "text-delta" && chunk.text !== undefined)
      text += chunk.text;
    else if (chunk.type === "finish" && chunk.reason !== undefined)
      finish = chunk.reason;
  }
  if (
    finish !== undefined &&
    finish.kind !== "stop" &&
    finish.kind !== "tool-calls"
  ) {
    throw new Error(`LLM 生成异常终止（${finish.kind}），请重试`);
  }
  if (text.trim() === "") throw new Error("LLM 返回了空内容");
  return text;
}

/** 从回复中抽取代码：优先 ```ts 围栏，其次裸源码形态。 */
function extractTsCode(response: string): string {
  const fenced = response.match(/```(?:ts|typescript)\r?\n([\s\S]*?)```/);
  if (fenced !== null) return fenced[1]!.trim();
  const trimmed = response.trim();
  if (
    trimmed.startsWith("/**") ||
    trimmed.startsWith("/*") ||
    /^import\b/m.test(trimmed)
  )
    return trimmed;
  throw new Error(
    "LLM 回复中未找到 TypeScript 代码块（要求只输出一个 ```ts 代码块）",
  );
}

/** 顶部块注释中的映射表（提示词第 2 条要求 LLM 输出，供用户审查）。 */
function extractMappingNote(code: string): string | null {
  const match = code.match(/^\s*\/\*\*?([\s\S]*?)\*\//);
  if (match === null) return null;
  const comment = match[1]!
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/, "").trim())
    .filter(Boolean)
    .join("\n");
  return comment === "" || !comment.includes("映射") ? null : comment;
}

/**
 * 动态加载产物模块（registry 激活与探针校验共用）：
 * 带时间戳查询串绕过 ESM 缓存；宿主运行时不识别 .ts 扩展时，
 * 用 typescript 转译成同名 .js 再加载（import type 已被擦除，无源依赖）。
 */
export async function importGeneratedModule(
  name: string,
): Promise<JcInventoryAdapterModule> {
  const tsPath = generatedPath(name);
  const bust = `?t=${Date.now()}`;
  let exports: { default?: unknown };
  try {
    exports = (await import(pathToFileURL(tsPath).href + bust)) as {
      default?: unknown;
    };
  } catch (tsError) {
    // 宿主运行时不识别 .ts（无类型剥离 / 产物位于 node_modules 下被禁）
    // 时，用 typescript 转译成同名 .js 再加载；import type 已被擦除。
    try {
      const ts = await import("typescript");
      const { readFileSync, writeFileSync: writeJs } = await import("node:fs");
      const source = readFileSync(tsPath, "utf8");
      const jsPath = tsPath.replace(/\.ts$/, ".js");
      writeJs(
        jsPath,
        ts.transpileModule(source, {
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2024,
          },
        }).outputText,
      );
      exports = (await import(pathToFileURL(jsPath).href + bust)) as {
        default?: unknown;
      };
    } catch {
      throw tsError;
    }
  }
  const module = exports.default;
  if (
    module === undefined ||
    typeof (module as JcInventoryAdapterModule).connect !== "function"
  ) {
    throw new Error(
      "产物模块必须 default export 一个 JcInventoryAdapterModule（含 info 与 connect）",
    );
  }
  return module as JcInventoryAdapterModule;
}

/** 单轮生成尝试的结果摘要（编排循环与最终报告共用）。 */
export interface MetaAttempt {
  attempt: number;
  /** 静态校验是否通过。 */
  staticOk: boolean;
  /** 本轮全部错误（静态失败取静态错误；动态失败取探针错误）。 */
  errors: string[];
  warnings: string[];
}

/** 元流程生成循环的最终结果。 */
export interface MetaFlowResult {
  /** 适配器产物名（generated/<name>.ts）。 */
  name: string;
  dialect: AdapterDialect;
  /** 实际使用的 provider/model（报告与状态展示用）。 */
  target: { provider: string; model: string };
  attempts: MetaAttempt[];
  /** 是否全部通过（静态 + 动态），可交由用户确认激活。 */
  ok: boolean;
  /** 映射表注释（LLM 按提示词要求输出；缺失为 null）。 */
  mappingNote: string | null;
  /** 末轮动态校验明细（connect 失败时 undefined）。 */
  dynamic: DynamicValidation | null;
  /** 静态校验明细（末轮）。 */
  staticValidation: StaticValidation | null;
  tsPath: string;
}

/** 生成循环参数。 */
export interface MetaFlowParams {
  /** 适配器名（sanitizeAdapterName 规范化）。 */
  name: string;
  dialect: AdapterDialect;
  /** 连接参数（探针 connect 与激活时复用；凭据只在内存存活）。 */
  options: AdapterConnectOptions;
  /** 内省摘要（提示词注入）。 */
  summary: SchemaSummary;
}

/**
 * 元流程生成主循环：生成 → 落盘 → 静态校验 → 动态探针，
 * 任一失败回喂修订重试；MAX_ATTEMPTS 轮后仍失败则返回 ok:false
 * 与全部错误（由调用方向用户报告缺口，SPEC §5.2 第 4 步）。
 */
export async function runMetaGeneration(
  ctx: Context,
  params: MetaFlowParams,
): Promise<MetaFlowResult> {
  const name = sanitizeAdapterName(params.name);
  const tsPath = generatedPath(name);
  const target = await resolveGenerationTarget(ctx);
  const attempts: MetaAttempt[] = [];
  let code = "";
  let mappingNote: string | null = null;
  let staticValidation: StaticValidation | null = null;
  let dynamic: DynamicValidation | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const prompt =
      attempt === 1
        ? buildGenerationPrompt({ summary: params.summary })
        : buildRevisionPrompt({
            summary: params.summary,
            previousCode: code,
            errors: attempts[attempt - 2]?.errors ?? [],
          });
    code = extractTsCode(await callLlm(ctx, target, prompt));
    mappingNote = extractMappingNote(code);
    mkdirSync(dirname(tsPath), { recursive: true });
    writeFileSync(tsPath, `${code}\n`, "utf8");

    staticValidation = await staticValidateFile(tsPath);
    if (!staticValidation.ok) {
      attempts.push({
        attempt,
        staticOk: false,
        errors: staticValidation.errors,
        warnings: staticValidation.warnings,
      });
      continue;
    }

    let loadError: string | null = null;
    const module = await importGeneratedModule(name).catch((error: unknown) => {
      loadError = error instanceof Error ? error.message : String(error);
      return null;
    });
    if (module === null || loadError !== null) {
      attempts.push({
        attempt,
        staticOk: false,
        errors: [`产物模块加载失败：${loadError}`],
        warnings: staticValidation?.warnings ?? [],
      });
      continue;
    }
    dynamic = await probeValidateAdapter(module, params.options);
    if (dynamic.ok) {
      attempts.push({
        attempt,
        staticOk: true,
        errors: [],
        warnings: [...staticValidation.warnings, ...dynamic.gaps],
      });
      return {
        name,
        dialect: params.dialect,
        target,
        attempts,
        ok: true,
        mappingNote,
        dynamic,
        staticValidation,
        tsPath,
      };
    }
    const errors = dynamic.results
      .filter((r) => !r.ok && !r.degraded)
      .map(
        (r) => `探针 ${r.id}（${r.description}）失败：${r.error ?? "未知错误"}`,
      );
    attempts.push({
      attempt,
      staticOk: true,
      errors,
      warnings: [...staticValidation.warnings, ...dynamic.gaps],
    });
  }

  return {
    name,
    dialect: params.dialect,
    target,
    attempts,
    ok: false,
    mappingNote,
    dynamic,
    staticValidation,
    tsPath,
  };
}
