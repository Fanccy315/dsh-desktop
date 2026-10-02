/**
 * 元流程第 2 步：schema 内省。按方言读取目标库的
 * 表 / 列 / 类型 / 主键 + 每表少量样本值，产出压缩后的 SchemaSummary，
 * 供生成提示词消费（`renderSchemaForPrompt`）。
 *
 * 样本值是映射质量的关键——编码列（如 io_flag 的 I/O、mo_state 的 REL/PLN）
 * 只有看到真实取值才能正确映射，DDL 类型不够。
 *
 * W3 实现 sqlite 方言（node:sqlite 只读连接）；mysql/postgres 为预留方言，
 * 接入前明确报「暂不支持」而不是半途失败（SPEC §0：演示只用 SQLite）。
 */

import { basename } from "node:path";
import type { AdapterConnectOptions, AdapterDialect } from "../contract.ts";

/** 单列摘要：DDL 事实 + 样本值（截断、去凭据语义——只有数据本身）。 */
export interface SchemaColumn {
  name: string;
  /** DDL 声明类型原文（INTEGER / TEXT / ...）。 */
  type: string;
  notNull: boolean;
  pk: boolean;
  /** 前 3 行样本值；string 截断到 48 字符，BLOB 摘要为占位符。 */
  samples: Array<string | number | null>;
}

/** 单表摘要。 */
export interface SchemaTable {
  name: string;
  rowCount: number;
  columns: SchemaColumn[];
}

/** 目标库的整体摘要（生成提示词的唯一 schema 事实来源）。 */
export interface SchemaSummary {
  dialect: AdapterDialect;
  /** 展示名（sqlite 为文件名；不含凭据信息）。 */
  database: string;
  tables: SchemaTable[];
}

/** sqlite 标识符内联：双引号转义，防注入来自 sqlite_master 的表名。 */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** 样本值规整：截断 / BLOB 摘要 / 保留 null 与数值。 */
function normalizeSample(value: unknown): string | number | null {
  if (value === null) return null;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array) return `<blob ${value.byteLength}B>`;
  const text = String(value);
  return text.length > 48 ? `${text.slice(0, 45)}…` : text;
}

/** 每表最多内省的表数与样本行数（压缩提示词体积）。 */
const MAX_TABLES = 64;
const SAMPLE_ROWS = 3;

export async function introspectDatabase(
  dialect: AdapterDialect,
  options: AdapterConnectOptions,
): Promise<SchemaSummary> {
  if (dialect !== "sqlite") {
    throw new Error(
      `元流程当前仅支持 sqlite 方言（收到 ${dialect}）；mysql/postgres 为预留方言`,
    );
  }
  if (options.path === undefined || options.path.trim() === "") {
    throw new Error("sqlite 方言需要库文件路径（path）");
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(options.path, { readOnly: true });
  try {
    const tableRows = db
      .prepare(
        `
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name LIMIT ${MAX_TABLES}`,
      )
      .all() as Array<{ name: string }>;
    const tables: SchemaTable[] = tableRows.map((t) => {
      const columns = (
        db.prepare(`PRAGMA table_info(${quoteIdent(t.name)})`).all() as Array<{
          name: string;
          type: string;
          notnull: number;
          pk: number;
        }>
      ).map((c) => ({
        name: c.name,
        type: c.type,
        notNull: c.notnull === 1,
        pk: c.pk > 0,
      }));
      const rowCount = (
        db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(t.name)}`).get() as {
          n: number;
        }
      ).n;
      const sampleRows = db
        .prepare(`SELECT * FROM ${quoteIdent(t.name)} LIMIT ${SAMPLE_ROWS}`)
        .all() as Array<Record<string, unknown>>;
      return {
        name: t.name,
        rowCount,
        columns: columns.map((c) => ({
          ...c,
          samples: sampleRows.map((row) => normalizeSample(row[c.name])),
        })),
      };
    });
    return { dialect, database: basename(options.path), tables };
  } finally {
    db.close();
  }
}

/** 把摘要渲染为提示词用的紧凑文本：DDL 事实 + 样本值。 */
export function renderSchemaForPrompt(summary: SchemaSummary): string {
  const lines: string[] = [
    `目标库：${summary.database}（方言 ${summary.dialect}，共 ${summary.tables.length} 张表）`,
    "",
  ];
  for (const table of summary.tables) {
    lines.push(`TABLE ${table.name}  -- ${table.rowCount} 行`);
    for (const column of table.columns) {
      const flags = [
        column.pk ? "PK" : null,
        column.notNull ? "NOT NULL" : null,
      ]
        .filter(Boolean)
        .join(" ");
      const samples = column.samples
        .map((v) =>
          v === null ? "null" : typeof v === "number" ? String(v) : `'${v}'`,
        )
        .join(", ");
      lines.push(
        `  ${column.name} ${column.type}${flags ? ` ${flags}` : ""}  -- 样本: ${samples}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
