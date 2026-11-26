import type { DbEngine } from "../types/dba";

export function formatCellValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function formatRawClipboardValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function quoteSqlIdent(name: string, engine?: DbEngine): string {
  if (engine === "mysql") {
    return `\`${name.replace(/`/g, "``")}\``;
  }
  if (engine === "mssql") {
    return `[${name.replace(/]/g, "]]")}]`;
  }
  return `"${name.replace(/"/g, '""')}"`;
}

export function formatSqlLiteral(val: unknown): string {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "number") return Number.isFinite(val) ? String(val) : "NULL";
  if (typeof val === "boolean") return val ? "TRUE" : "FALSE";
  const str = typeof val === "object" ? JSON.stringify(val) : String(val);
  return `'${str.replace(/'/g, "''")}'`;
}

export function formatTsv(
  rows: unknown[][],
  colNames: string[],
  includeHeaders = false
): string {
  const escapeTsv = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return s.replace(/\t/g, " ").replace(/\r?\n/g, " ");
  };
  const lines: string[] = [];
  if (includeHeaders) {
    lines.push(colNames.join("\t"));
  }
  for (const r of rows) {
    lines.push(r.map(escapeTsv).join("\t"));
  }
  return lines.join("\n");
}

export function formatCsv(
  rows: unknown[][],
  colNames: string[],
  includeHeaders = true
): string {
  const escapeCsv = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    if (/[",\r\n]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines: string[] = [];
  if (includeHeaders) {
    lines.push(colNames.map(escapeCsv).join(","));
  }
  for (const r of rows) {
    lines.push(r.map(escapeCsv).join(","));
  }
  return lines.join("\n");
}

export function formatJson(rows: unknown[][], colNames: string[]): string {
  const objs = rows.map((r) => {
    const obj: Record<string, unknown> = {};
    colNames.forEach((name, idx) => {
      obj[name] = r[idx] === undefined ? null : r[idx];
    });
    return obj;
  });
  return JSON.stringify(objs.length === 1 ? objs[0] : objs, null, 2);
}

export function formatInsertSql(
  table: string,
  schema: string | null | undefined,
  engine: DbEngine | undefined,
  rows: unknown[][],
  colNames: string[]
): string {
  const qualifiedTable =
    schema && (engine === "postgres" || engine === "mssql")
      ? `${quoteSqlIdent(schema, engine)}.${quoteSqlIdent(table, engine)}`
      : quoteSqlIdent(table, engine);
  const colsPart = colNames.map((c) => quoteSqlIdent(c, engine)).join(", ");
  return rows
    .map((r) => {
      const valsPart = r.map((v) => formatSqlLiteral(v)).join(", ");
      return `INSERT INTO ${qualifiedTable} (${colsPart}) VALUES (${valsPart});`;
    })
    .join("\n");
}
