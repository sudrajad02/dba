import type { Monaco } from "@monaco-editor/react";
import type { DbEngine } from "../types/dba";

export interface SqlAutocompleteContext {
  engine: DbEngine | undefined;
  database?: string;
  schema?: string;
  tables: Record<string, string[]>;
}

interface SqlFunctionDef {
  name: string;
  snippet: string;
  detail: string;
}

interface SqlSnippetDef {
  label: string;
  filterText: string;
  insertText: string;
  detail: string;
}

interface DialectDictionary {
  keywords: string[];
  dataTypes: string[];
  functions: SqlFunctionDef[];
}

// ============================================================================
// SQL Core & Per-Dialect Dictionaries
// ============================================================================

const CORE_KEYWORDS: string[] = [
  "SELECT",
  "FROM",
  "WHERE",
  "CREATE",
  "ALTER",
  "DROP",
  "INSERT",
  "INSERT INTO",
  "INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE",
  "DELETE FROM",
  "JOIN",
  "INNER JOIN",
  "LEFT JOIN",
  "LEFT OUTER JOIN",
  "RIGHT JOIN",
  "RIGHT OUTER JOIN",
  "FULL OUTER JOIN",
  "CROSS JOIN",
  "ON",
  "USING",
  "GROUP BY",
  "HAVING",
  "ORDER BY",
  "ASC",
  "DESC",
  "LIMIT",
  "OFFSET",
  "DISTINCT",
  "UNION",
  "UNION ALL",
  "INTERSECT",
  "EXCEPT",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "AS",
  "AND",
  "OR",
  "NOT",
  "IN",
  "NOT IN",
  "EXISTS",
  "NOT EXISTS",
  "BETWEEN",
  "LIKE",
  "NOT LIKE",
  "IS NULL",
  "IS NOT NULL",
  "NULL",
  "TRUE",
  "FALSE",
  "WITH",
  "PRIMARY KEY",
  "FOREIGN KEY",
  "REFERENCES",
  "UNIQUE",
  "CHECK",
  "DEFAULT",
  "NOT NULL",
  "CONSTRAINT",
  "INDEX",
  "VIEW",
  "TABLE",
  "DATABASE",
  "SCHEMA",
  "TRUNCATE",
  "EXPLAIN",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "TRANSACTION",
  "ALL",
  "ANY",
  "OVER",
  "PARTITION BY",
  "ADD",
  "COLUMN",
  "RENAME",
  "TO",
  "IF EXISTS",
  "IF NOT EXISTS",
  "CASCADE",
  "RESTRICT",
];

const CORE_FUNCTIONS: SqlFunctionDef[] = [
  { name: "COUNT", snippet: "COUNT(${1:*})", detail: "COUNT(expr) — Aggregate count" },
  { name: "SUM", snippet: "SUM(${1:expr})", detail: "SUM(expr) — Aggregate sum" },
  { name: "AVG", snippet: "AVG(${1:expr})", detail: "AVG(expr) — Aggregate average" },
  { name: "MIN", snippet: "MIN(${1:expr})", detail: "MIN(expr) — Minimum value" },
  { name: "MAX", snippet: "MAX(${1:expr})", detail: "MAX(expr) — Maximum value" },
  { name: "COALESCE", snippet: "COALESCE(${1:val1}, ${2:val2})", detail: "COALESCE(a, b, ...) — First non-null" },
  { name: "NULLIF", snippet: "NULLIF(${1:expr1}, ${2:expr2})", detail: "NULLIF(a, b) — Null if equal" },
  { name: "CAST", snippet: "CAST(${1:expr} AS ${2:type})", detail: "CAST(expr AS type) — Type conversion" },
  { name: "LOWER", snippet: "LOWER(${1:str})", detail: "LOWER(str) — Lowercase string" },
  { name: "UPPER", snippet: "UPPER(${1:str})", detail: "UPPER(str) — Uppercase string" },
  { name: "TRIM", snippet: "TRIM(${1:str})", detail: "TRIM(str) — Trim whitespace" },
  { name: "SUBSTRING", snippet: "SUBSTRING(${1:str}, ${2:1}, ${3:10})", detail: "SUBSTRING(str, start, len)" },
  { name: "REPLACE", snippet: "REPLACE(${1:str}, ${2:from}, ${3:to})", detail: "REPLACE(str, from, to)" },
  { name: "ROUND", snippet: "ROUND(${1:num}, ${2:2})", detail: "ROUND(num, decimals)" },
  { name: "ABS", snippet: "ABS(${1:num})", detail: "ABS(num) — Absolute value" },
  { name: "FLOOR", snippet: "FLOOR(${1:num})", detail: "FLOOR(num)" },
  { name: "CEIL", snippet: "CEIL(${1:num})", detail: "CEIL(num)" },
  { name: "ROW_NUMBER", snippet: "ROW_NUMBER() OVER (${1:ORDER BY id})", detail: "ROW_NUMBER() OVER (...)" },
  { name: "RANK", snippet: "RANK() OVER (${1:ORDER BY id})", detail: "RANK() OVER (...)" },
  { name: "DENSE_RANK", snippet: "DENSE_RANK() OVER (${1:ORDER BY id})", detail: "DENSE_RANK() OVER (...)" },
];

const DIALECT_DICTIONARIES: Record<"mysql" | "postgres" | "mssql", DialectDictionary> = {
  mysql: {
    keywords: [
      "SHOW TABLES",
      "SHOW DATABASES",
      "SHOW CREATE TABLE",
      "SHOW COLUMNS FROM",
      "SHOW INDEX FROM",
      "SHOW PROCESSLIST",
      "DESCRIBE",
      "USE",
      "AUTO_INCREMENT",
      "ENGINE=InnoDB",
      "DEFAULT CHARSET=utf8mb4",
      "ON DUPLICATE KEY UPDATE",
      "REPLACE INTO",
      "REGEXP",
      "UNSIGNED",
      "STRAIGHT_JOIN",
      "FORCE INDEX",
      "IGNORE INDEX",
      "LOCK TABLES",
      "UNLOCK TABLES",
      "COLLATE",
      "COMMENT",
      "AFTER",
      "FIRST",
      "MODIFY COLUMN",
      "CHANGE COLUMN",
    ],
    dataTypes: [
      "INT",
      "BIGINT",
      "SMALLINT",
      "TINYINT",
      "MEDIUMINT",
      "VARCHAR",
      "CHAR",
      "TEXT",
      "MEDIUMTEXT",
      "LONGTEXT",
      "DECIMAL",
      "FLOAT",
      "DOUBLE",
      "BOOLEAN",
      "DATE",
      "DATETIME",
      "TIMESTAMP",
      "TIME",
      "YEAR",
      "JSON",
      "ENUM",
      "SET",
      "BLOB",
      "BINARY",
      "VARBINARY",
    ],
    functions: [
      { name: "CONCAT", snippet: "CONCAT(${1:a}, ${2:b})", detail: "MySQL — Concatenate strings" },
      { name: "CONCAT_WS", snippet: "CONCAT_WS(${1:', '}, ${2:a}, ${3:b})", detail: "MySQL — Concatenate with separator" },
      { name: "IF", snippet: "IF(${1:cond}, ${2:true_val}, ${3:false_val})", detail: "MySQL — Conditional expression" },
      { name: "IFNULL", snippet: "IFNULL(${1:expr}, ${2:fallback})", detail: "MySQL — Null fallback" },
      { name: "NOW", snippet: "NOW()", detail: "MySQL — Current date & time" },
      { name: "CURDATE", snippet: "CURDATE()", detail: "MySQL — Current date" },
      { name: "CURTIME", snippet: "CURTIME()", detail: "MySQL — Current time" },
      { name: "DATE_FORMAT", snippet: "DATE_FORMAT(${1:date}, ${2:'%Y-%m-%d'})", detail: "MySQL — Format date" },
      { name: "DATEDIFF", snippet: "DATEDIFF(${1:date1}, ${2:date2})", detail: "MySQL — Days between dates" },
      { name: "DATE_ADD", snippet: "DATE_ADD(${1:date}, INTERVAL ${2:1} ${3:DAY})", detail: "MySQL — Add interval to date" },
      { name: "DATE_SUB", snippet: "DATE_SUB(${1:date}, INTERVAL ${2:1} ${3:DAY})", detail: "MySQL — Subtract interval from date" },
      { name: "GROUP_CONCAT", snippet: "GROUP_CONCAT(${1:col} SEPARATOR ${2:', '})", detail: "MySQL — Aggregate string join" },
      { name: "JSON_EXTRACT", snippet: "JSON_EXTRACT(${1:doc}, ${2:'$.key'})", detail: "MySQL — Extract JSON value" },
      { name: "JSON_UNQUOTE", snippet: "JSON_UNQUOTE(${1:json_val})", detail: "MySQL — Unquote JSON string" },
      { name: "JSON_OBJECT", snippet: "JSON_OBJECT(${1:'key'}, ${2:val})", detail: "MySQL — Build JSON object" },
      { name: "JSON_ARRAY", snippet: "JSON_ARRAY(${1:val1}, ${2:val2})", detail: "MySQL — Build JSON array" },
      { name: "LENGTH", snippet: "LENGTH(${1:str})", detail: "MySQL — Byte length" },
      { name: "CHAR_LENGTH", snippet: "CHAR_LENGTH(${1:str})", detail: "MySQL — Character length" },
      { name: "LTRIM", snippet: "LTRIM(${1:str})", detail: "MySQL — Trim leading spaces" },
      { name: "RTRIM", snippet: "RTRIM(${1:str})", detail: "MySQL — Trim trailing spaces" },
      { name: "UNIX_TIMESTAMP", snippet: "UNIX_TIMESTAMP(${1:})", detail: "MySQL — Unix epoch seconds" },
      { name: "FROM_UNIXTIME", snippet: "FROM_UNIXTIME(${1:ts})", detail: "MySQL — Epoch to datetime" },
    ],
  },
  postgres: {
    keywords: [
      "RETURNING",
      "ILIKE",
      "ON CONFLICT",
      "DO NOTHING",
      "DO UPDATE SET",
      "LATERAL",
      "MATERIALIZED VIEW",
      "ANALYZE",
      "VACUUM",
      "DISTINCT ON",
      "CONCURRENTLY",
      "RECURSIVE",
      "WINDOW",
      "FILTER",
      "TABLESAMPLE",
      "EXPLAIN ANALYZE",
      "FETCH FIRST",
      "NULLS FIRST",
      "NULLS LAST",
      "GENERATED ALWAYS AS IDENTITY",
      "OWNED BY",
    ],
    dataTypes: [
      "SERIAL",
      "BIGSERIAL",
      "SMALLSERIAL",
      "INTEGER",
      "INT",
      "BIGINT",
      "SMALLINT",
      "NUMERIC",
      "DECIMAL",
      "REAL",
      "DOUBLE PRECISION",
      "BOOLEAN",
      "TEXT",
      "VARCHAR",
      "CHAR",
      "UUID",
      "JSON",
      "JSONB",
      "DATE",
      "TIME",
      "TIMESTAMP",
      "TIMESTAMPTZ",
      "INTERVAL",
      "BYTEA",
      "INET",
      "CIDR",
    ],
    functions: [
      { name: "STRING_AGG", snippet: "STRING_AGG(${1:col}, ${2:', '})", detail: "PostgreSQL — Aggregate string join" },
      { name: "ARRAY_AGG", snippet: "ARRAY_AGG(${1:col})", detail: "PostgreSQL — Aggregate into array" },
      { name: "JSONB_AGG", snippet: "JSONB_AGG(${1:expr})", detail: "PostgreSQL — Aggregate into JSONB array" },
      { name: "JSONB_BUILD_OBJECT", snippet: "JSONB_BUILD_OBJECT(${1:'key'}, ${2:val})", detail: "PostgreSQL — Build JSONB object" },
      { name: "JSON_BUILD_OBJECT", snippet: "JSON_BUILD_OBJECT(${1:'key'}, ${2:val})", detail: "PostgreSQL — Build JSON object" },
      { name: "TO_CHAR", snippet: "TO_CHAR(${1:expr}, ${2:'YYYY-MM-DD'})", detail: "PostgreSQL — Format value as text" },
      { name: "TO_DATE", snippet: "TO_DATE(${1:str}, ${2:'YYYY-MM-DD'})", detail: "PostgreSQL — Parse date" },
      { name: "TO_TIMESTAMP", snippet: "TO_TIMESTAMP(${1:str}, ${2:'YYYY-MM-DD HH24:MI:SS'})", detail: "PostgreSQL — Parse timestamp" },
      { name: "DATE_TRUNC", snippet: "DATE_TRUNC(${1:'day'}, ${2:ts})", detail: "PostgreSQL — Truncate timestamp" },
      { name: "AGE", snippet: "AGE(${1:ts1}, ${2:ts2})", detail: "PostgreSQL — Interval between timestamps" },
      { name: "NOW", snippet: "NOW()", detail: "PostgreSQL — Current timestamp with TZ" },
      { name: "CURRENT_TIMESTAMP", snippet: "CURRENT_TIMESTAMP", detail: "PostgreSQL — Current timestamp" },
      { name: "EXTRACT", snippet: "EXTRACT(${1:YEAR} FROM ${2:ts})", detail: "PostgreSQL — Extract date/time field" },
      { name: "GENERATE_SERIES", snippet: "GENERATE_SERIES(${1:1}, ${2:10})", detail: "PostgreSQL — Generate series" },
      { name: "UNNEST", snippet: "UNNEST(${1:arr})", detail: "PostgreSQL — Expand array to rows" },
      { name: "REGEXP_REPLACE", snippet: "REGEXP_REPLACE(${1:str}, ${2:pattern}, ${3:replacement})", detail: "PostgreSQL — Regex replace" },
      { name: "GEN_RANDOM_UUID", snippet: "GEN_RANDOM_UUID()", detail: "PostgreSQL — Generate UUID v4" },
      { name: "LAG", snippet: "LAG(${1:col}) OVER (${2:ORDER BY id})", detail: "PostgreSQL — Previous row value" },
      { name: "LEAD", snippet: "LEAD(${1:col}) OVER (${2:ORDER BY id})", detail: "PostgreSQL — Next row value" },
      { name: "CONCAT", snippet: "CONCAT(${1:a}, ${2:b})", detail: "PostgreSQL — Concatenate strings" },
    ],
  },
  mssql: {
    keywords: [
      "TOP",
      "FETCH NEXT",
      "ROWS ONLY",
      "CROSS APPLY",
      "OUTER APPLY",
      "IDENTITY",
      "NOLOCK",
      "WITH (NOLOCK)",
      "MERGE",
      "OUTPUT",
      "EXEC",
      "EXECUTE",
      "DECLARE",
      "TRY",
      "CATCH",
      "OPTION",
      "RECOMPILE",
      "GO",
      "USE",
      "PRINT",
      "CLUSTERED",
      "NONCLUSTERED",
      "SET NOCOUNT ON",
    ],
    dataTypes: [
      "INT",
      "BIGINT",
      "SMALLINT",
      "TINYINT",
      "BIT",
      "DECIMAL",
      "NUMERIC",
      "FLOAT",
      "MONEY",
      "VARCHAR",
      "NVARCHAR",
      "CHAR",
      "NCHAR",
      "TEXT",
      "NTEXT",
      "UNIQUEIDENTIFIER",
      "DATE",
      "TIME",
      "DATETIME",
      "DATETIME2",
      "DATETIMEOFFSET",
      "VARBINARY",
      "XML",
    ],
    functions: [
      { name: "ISNULL", snippet: "ISNULL(${1:expr}, ${2:fallback})", detail: "MSSQL — Null fallback" },
      { name: "IIF", snippet: "IIF(${1:cond}, ${2:true_val}, ${3:false_val})", detail: "MSSQL — Inline IF" },
      { name: "GETDATE", snippet: "GETDATE()", detail: "MSSQL — Current server datetime" },
      { name: "GETUTCDATE", snippet: "GETUTCDATE()", detail: "MSSQL — Current UTC datetime" },
      { name: "SYSDATETIME", snippet: "SYSDATETIME()", detail: "MSSQL — High-precision datetime2" },
      { name: "DATEADD", snippet: "DATEADD(${1:day}, ${2:1}, ${3:date})", detail: "MSSQL — Add interval to date" },
      { name: "DATEDIFF", snippet: "DATEDIFF(${1:day}, ${2:start_date}, ${3:end_date})", detail: "MSSQL — Difference between dates" },
      { name: "DATEPART", snippet: "DATEPART(${1:year}, ${2:date})", detail: "MSSQL — Integer date part" },
      { name: "DATENAME", snippet: "DATENAME(${1:month}, ${2:date})", detail: "MSSQL — String date part" },
      { name: "EOMONTH", snippet: "EOMONTH(${1:date})", detail: "MSSQL — End of month" },
      { name: "CONVERT", snippet: "CONVERT(${1:VARCHAR(50)}, ${2:expr})", detail: "MSSQL — Convert expression type" },
      { name: "TRY_CAST", snippet: "TRY_CAST(${1:expr} AS ${2:INT})", detail: "MSSQL — Safe cast (returns NULL on fail)" },
      { name: "TRY_CONVERT", snippet: "TRY_CONVERT(${1:INT}, ${2:expr})", detail: "MSSQL — Safe convert" },
      { name: "STRING_AGG", snippet: "STRING_AGG(${1:col}, ${2:', '})", detail: "MSSQL — Aggregate string join" },
      { name: "STRING_SPLIT", snippet: "STRING_SPLIT(${1:str}, ${2:','})", detail: "MSSQL — Split string to rows" },
      { name: "LEN", snippet: "LEN(${1:str})", detail: "MSSQL — String length" },
      { name: "DATALENGTH", snippet: "DATALENGTH(${1:expr})", detail: "MSSQL — Byte length" },
      { name: "CHARINDEX", snippet: "CHARINDEX(${1:substr}, ${2:str})", detail: "MSSQL — Find substring index" },
      { name: "FORMAT", snippet: "FORMAT(${1:val}, ${2:'yyyy-MM-dd'})", detail: "MSSQL — Format date/number" },
      { name: "LEFT", snippet: "LEFT(${1:str}, ${2:10})", detail: "MSSQL — Left characters" },
      { name: "RIGHT", snippet: "RIGHT(${1:str}, ${2:10})", detail: "MSSQL — Right characters" },
      { name: "STUFF", snippet: "STUFF(${1:str}, ${2:1}, ${3:1}, ${4:''})", detail: "MSSQL — Replace substring by position" },
      { name: "NEWID", snippet: "NEWID()", detail: "MSSQL — Generate UNIQUEIDENTIFIER" },
      { name: "SCOPE_IDENTITY", snippet: "SCOPE_IDENTITY()", detail: "MSSQL — Last inserted identity" },
      { name: "CONCAT", snippet: "CONCAT(${1:a}, ${2:b})", detail: "MSSQL — Concatenate strings" },
    ],
  },
};

const QUICK_SNIPPETS: SqlSnippetDef[] = [
  {
    label: "SELECT * FROM ...",
    filterText: "sel select * from",
    insertText: "SELECT *\nFROM ${1:table_name}\nWHERE ${2:1 = 1};",
    detail: "Snippet — Basic SELECT query",
  },
  {
    label: "CREATE TABLE ...",
    filterText: "cre create table",
    insertText:
      "CREATE TABLE ${1:table_name} (\n  id ${2:BIGINT} PRIMARY KEY,\n  ${3:name} VARCHAR(255) NOT NULL,\n  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n);",
    detail: "Snippet — Create table",
  },
  {
    label: "CREATE INDEX ...",
    filterText: "cre create index",
    insertText: "CREATE INDEX ${1:idx_name} ON ${2:table_name} (${3:column_name});",
    detail: "Snippet — Create index",
  },
  {
    label: "INSERT INTO ...",
    filterText: "ins insert into",
    insertText: "INSERT INTO ${1:table_name} (${2:col1, col2})\nVALUES (${3:val1, val2});",
    detail: "Snippet — Insert row",
  },
  {
    label: "UPDATE ... SET ...",
    filterText: "upd update set",
    insertText: "UPDATE ${1:table_name}\nSET ${2:column} = ${3:value}\nWHERE ${4:id = 1};",
    detail: "Snippet — Update rows",
  },
  {
    label: "DELETE FROM ...",
    filterText: "del delete from",
    insertText: "DELETE FROM ${1:table_name}\nWHERE ${2:id = 1};",
    detail: "Snippet — Delete rows",
  },
  {
    label: "WITH cte AS (...)",
    filterText: "with cte",
    insertText:
      "WITH ${1:cte_name} AS (\n  SELECT ${2:*}\n  FROM ${3:table_name}\n)\nSELECT * FROM ${1:cte_name};",
    detail: "Snippet — Common Table Expression",
  },
];

// Keywords that can immediately follow a table name and therefore are NOT aliases
const NON_ALIAS_KEYWORDS = new Set([
  "WHERE",
  "ON",
  "JOIN",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "CROSS",
  "OUTER",
  "NATURAL",
  "STRAIGHT_JOIN",
  "GROUP",
  "ORDER",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "UNION",
  "INTERSECT",
  "EXCEPT",
  "SET",
  "VALUES",
  "SELECT",
  "FROM",
  "AND",
  "OR",
  "AS",
  "USING",
  "RETURNING",
  "INTO",
  "FOR",
  "WINDOW",
  "FETCH",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "WITH",
  "GO",
  "FORCE",
  "USE",
  "IGNORE",
  "LATERAL",
  "APPLY",
  "OUTPUT",
  "OPTION",
  "WHERE",
  "PREWHERE",
  "QUALIFY",
]);

// ============================================================================
// Lightweight SQL Parser Helpers (Pure & Zero-Latency)
// ============================================================================

/**
 * Replaces single-quoted string literals and SQL comments (-- and /* ... *\/)
 * with spaces of identical length so character offsets stay aligned.
 */
export function maskStringsAndComments(sql: string): string {
  const chars = sql.split("");
  const n = chars.length;
  let i = 0;
  while (i < n) {
    // Line comment --
    if (chars[i] === "-" && chars[i + 1] === "-") {
      while (i < n && chars[i] !== "\n") {
        chars[i] = " ";
        i++;
      }
      continue;
    }
    // Block comment /* ... */
    if (chars[i] === "/" && chars[i + 1] === "*") {
      chars[i] = " ";
      chars[i + 1] = " ";
      i += 2;
      while (i < n && !(chars[i] === "*" && chars[i + 1] === "/")) {
        if (chars[i] !== "\n") chars[i] = " ";
        i++;
      }
      if (i < n) {
        chars[i] = " ";
        if (i + 1 < n) chars[i + 1] = " ";
        i += 2;
      }
      continue;
    }
    // Single-quoted string literal '...'
    if (chars[i] === "'") {
      chars[i] = " ";
      i++;
      while (i < n) {
        if (chars[i] === "'" && chars[i + 1] === "'") {
          chars[i] = " ";
          chars[i + 1] = " ";
          i += 2;
          continue;
        }
        if (chars[i] === "\\") {
          chars[i] = " ";
          if (i + 1 < n) chars[i + 1] = " ";
          i += 2;
          continue;
        }
        if (chars[i] === "'") {
          chars[i] = " ";
          i++;
          break;
        }
        if (chars[i] !== "\n") chars[i] = " ";
        i++;
      }
      continue;
    }
    i++;
  }
  return chars.join("");
}

/**
 * Extracts the active SQL statement containing `cursorOffset` (bounded by `;`
 * outside strings/comments) along with the cursor's relative offset.
 */
export function extractActiveStatement(
  fullSql: string,
  cursorOffset: number
): { statement: string; beforeCursor: string } {
  const masked = maskStringsAndComments(fullSql);
  let start = 0;
  for (let i = Math.min(cursorOffset, masked.length) - 1; i >= 0; i--) {
    if (masked[i] === ";") {
      start = i + 1;
      break;
    }
  }
  let end = masked.length;
  for (let i = Math.max(cursorOffset, 0); i < masked.length; i++) {
    if (masked[i] === ";") {
      end = i;
      break;
    }
  }
  return {
    statement: masked.slice(start, end),
    beforeCursor: masked.slice(start, Math.min(cursorOffset, end)),
  };
}

function unquoteIdent(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith("`") && trimmed.endsWith("`")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Extracts table references and aliases from a single SQL statement.
 * Supports:
 * - FROM users u
 * - FROM `app`.`users` AS u
 * - INNER JOIN "orders" o ON ...
 * - UPDATE [dbo].[customers] c SET ...
 * - INSERT INTO logs ...
 */
export function extractTableAliases(statement: string): {
  aliasToTable: Map<string, string>;
  referencedTables: Set<string>;
} {
  const aliasToTable = new Map<string, string>();
  const referencedTables = new Set<string>();

  const ident = `(?:[\\\`"\\[]?[A-Za-z_][\\w$]*[\\\`"\\]]?)`;
  const qualifiedIdent = `(?:${ident}\\s*\\.\\s*)?${ident}`;
  // Match FROM / JOIN / UPDATE / INTO followed by table name and optional [AS] alias
  const regex = new RegExp(
    `\\b(?:FROM|JOIN|UPDATE|INTO)\\s+(${qualifiedIdent})(?:\\s+(?:AS\\s+)?(${ident}))?`,
    "gi"
  );

  let match: RegExpExecArray | null;
  while ((match = regex.exec(statement)) !== null) {
    const rawQualified = match[1];
    const parts = rawQualified.split(".").map((p) => unquoteIdent(p));
    const tableName = parts[parts.length - 1];
    if (!tableName) continue;

    const tableLower = tableName.toLowerCase();
    if (NON_ALIAS_KEYWORDS.has(tableName.toUpperCase())) continue;

    referencedTables.add(tableLower);

    if (match[2]) {
      const alias = unquoteIdent(match[2]);
      if (alias && !NON_ALIAS_KEYWORDS.has(alias.toUpperCase())) {
        aliasToTable.set(alias.toLowerCase(), tableName);
      }
    }
  }

  return { aliasToTable, referencedTables };
}

export type SqlClauseContext = "table" | "column" | "type" | "general";

export function detectSqlClauseContext(beforeCursor: string): SqlClauseContext {
  // Remove the partial identifier currently being typed at the end
  const stripped = beforeCursor.replace(/[`"\[]?[A-Za-z0-9_$]*$/, "").trimEnd();
  if (!stripped) return "general";

  // Check multi-word clauses first (normalized whitespace)
  const upperTail = stripped.replace(/\s+/g, " ").toUpperCase();

  // Table-expecting clauses
  if (
    /\b(?:FROM|JOIN|INTO|UPDATE|TABLE|TRUNCATE|DESCRIBE|DESC|SHOW CREATE TABLE|SHOW COLUMNS FROM|SHOW INDEX FROM)$/.test(
      upperTail
    )
  ) {
    return "table";
  }

  // Data-type expecting context: CAST(x AS <type> or ADD/MODIFY COLUMN <name> <type>
  if (/\bCAST\s*\([^)]+\bAS$/.test(upperTail)) {
    return "type";
  }

  // Column / expression expecting clauses
  if (
    /\b(?:SELECT|DISTINCT|WHERE|ON|AND|OR|NOT|GROUP BY|ORDER BY|HAVING|SET|CASE|WHEN|THEN|ELSE|BY|IN|LIKE|ILIKE|BETWEEN)$/.test(
      upperTail
    ) ||
    /[=<>!+\-*/,(\s]$/.test(stripped)
  ) {
    // Distinguish comma after FROM table vs comma in SELECT/WHERE/GROUP BY/ORDER BY
    if (stripped.endsWith(",")) {
      const lastClauseMatch = upperTail.match(
        /\b(SELECT|FROM|WHERE|JOIN|GROUP BY|ORDER BY|HAVING|SET|VALUES|INTO)\b(?!.*\b(?:SELECT|FROM|WHERE|JOIN|GROUP BY|ORDER BY|HAVING|SET|VALUES|INTO)\b)/
      );
      if (lastClauseMatch) {
        if (lastClauseMatch[1] === "FROM") return "table";
        return "column";
      }
    }
    if (/[=<>!+\-*/(]$/.test(stripped)) {
      return "column";
    }
    if (
      /\b(?:SELECT|DISTINCT|WHERE|ON|AND|OR|NOT|GROUP BY|ORDER BY|HAVING|SET|CASE|WHEN|THEN|ELSE|IN|LIKE|ILIKE|BETWEEN)$/.test(
        upperTail
      )
    ) {
      return "column";
    }
  }

  return "general";
}

function detectDotTrigger(beforeCursor: string): { qualifier: string } | null {
  const m = beforeCursor.match(/(?:[`"\[]?([A-Za-z_][\w$]*)[`"\]]?)\.[`"\[]?[A-Za-z0-9_$]*$/);
  if (!m) return null;
  return { qualifier: m[1] };
}

function findTableKeyCaseInsensitive(
  tables: Record<string, string[]>,
  target: string
): string | null {
  const lower = target.toLowerCase();
  for (const key of Object.keys(tables)) {
    if (key.toLowerCase() === lower) return key;
  }
  return null;
}

// ============================================================================
// Singleton Monaco Provider & Per-Model Context Registry
// ============================================================================

const contextByModelUri = new Map<string, SqlAutocompleteContext>();
let providerRegistered = false;

export function setSqlAutocompleteContext(
  modelUri: string,
  context: SqlAutocompleteContext
): void {
  contextByModelUri.set(modelUri, context);
}

export function removeSqlAutocompleteContext(modelUri: string): void {
  contextByModelUri.delete(modelUri);
}

export function registerSqlAutocompleteProvider(monaco: Monaco): void {
  if (providerRegistered) return;
  providerRegistered = true;

  monaco.languages.registerCompletionItemProvider("sql", {
    triggerCharacters: [".", " ", "`", '"'],
    provideCompletionItems: (model: any, position: any) => {
      const ctx = contextByModelUri.get(model.uri.toString());
      const engine = ctx?.engine;
      const tables = ctx?.tables ?? {};

      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const fullSql: string = model.getValue();
      const cursorOffset: number = model.getOffsetAt(position);
      const { statement, beforeCursor } = extractActiveStatement(fullSql, cursorOffset);
      const { aliasToTable, referencedTables } = extractTableAliases(statement);

      // 1. Dot-Completion: `users.` / `u.` / `public.`
      const dot = detectDotTrigger(beforeCursor);
      if (dot) {
        const qualLower = dot.qualifier.toLowerCase();
        const aliasedTable = aliasToTable.get(qualLower);
        const resolvedTable =
          (aliasedTable && findTableKeyCaseInsensitive(tables, aliasedTable)) ||
          findTableKeyCaseInsensitive(tables, dot.qualifier);

        if (resolvedTable) {
          const cols = tables[resolvedTable] ?? [];
          const suggestions = cols.map((col, idx) => ({
            label: col,
            kind: monaco.languages.CompletionItemKind.Field,
            insertText: col,
            detail: `${resolvedTable}.${col}`,
            sortText: `0_${String(idx).padStart(4, "0")}_${col}`,
            range,
          }));
          return { suggestions };
        }

        // Schema/Database dot completion (e.g. `public.` or `dbo.` or `mydb.`)
        const activeSchema = (ctx?.schema || "").toLowerCase();
        const activeDb = (ctx?.database || "").toLowerCase();
        if (
          qualLower === activeSchema ||
          qualLower === activeDb ||
          qualLower === "public" ||
          qualLower === "dbo"
        ) {
          const suggestions = Object.keys(tables).map((tableName) => ({
            label: tableName,
            kind: monaco.languages.CompletionItemKind.Struct,
            insertText: tableName,
            detail: "Table / View",
            sortText: `0_${tableName}`,
            range,
          }));
          return { suggestions };
        }

        return { suggestions: [] };
      }

      // 2. Context-Aware Ranking
      const clauseCtx = detectSqlClauseContext(beforeCursor);
      const dialectKey: "mysql" | "postgres" | "mssql" =
        engine === "postgres" ? "postgres" : engine === "mssql" ? "mssql" : "mysql";
      const dialect = DIALECT_DICTIONARIES[dialectKey];

      // Priority prefixes by context (lower sorts first in Monaco)
      const rank = {
        refColumn: clauseCtx === "column" ? "0" : clauseCtx === "table" ? "5" : "3",
        table: clauseCtx === "table" ? "0" : clauseCtx === "column" ? "4" : "2",
        otherColumn: clauseCtx === "column" ? "2" : clauseCtx === "table" ? "6" : "4",
        func: clauseCtx === "column" ? "1" : clauseCtx === "table" ? "5" : "3",
        keyword: clauseCtx === "general" ? "0" : clauseCtx === "table" ? "2" : "3",
        snippet: clauseCtx === "general" ? "1" : "5",
        dataType: clauseCtx === "type" ? "0" : "4",
      };

      const suggestions: any[] = [];
      const seenLabels = new Set<string>();

      // Tables & Views
      for (const [tableName, cols] of Object.entries(tables)) {
        const isRef = referencedTables.has(tableName.toLowerCase());
        suggestions.push({
          label: tableName,
          kind: monaco.languages.CompletionItemKind.Struct,
          insertText: tableName,
          detail: "Table / View",
          sortText: `${rank.table}_${isRef ? "0" : "1"}_${tableName}`,
          range,
        });

        // Columns
        const colRank = isRef ? rank.refColumn : rank.otherColumn;
        for (const col of cols) {
          suggestions.push({
            label: col,
            kind: monaco.languages.CompletionItemKind.Field,
            insertText: col,
            detail: `${tableName}.${col}`,
            sortText: `${colRank}_${col}_${tableName}`,
            range,
          });
        }
      }

      // Core + Dialect Keywords
      const allKeywords = [...CORE_KEYWORDS, ...dialect.keywords];
      for (const kw of allKeywords) {
        const key = `kw:${kw}`;
        if (seenLabels.has(key)) continue;
        seenLabels.add(key);
        suggestions.push({
          label: kw,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: kw,
          detail: engine ? `Keyword (${dialectKey.toUpperCase()})` : "SQL Keyword",
          sortText: `${rank.keyword}_${kw}`,
          range,
        });
      }

      // Dialect Data Types
      for (const dt of dialect.dataTypes) {
        const key = `dt:${dt}`;
        if (seenLabels.has(key)) continue;
        seenLabels.add(key);
        suggestions.push({
          label: dt,
          kind: monaco.languages.CompletionItemKind.TypeParameter,
          insertText: dt,
          detail: `Data Type (${dialectKey.toUpperCase()})`,
          sortText: `${rank.dataType}_${dt}`,
          range,
        });
      }

      // Core + Dialect Functions
      const allFunctions = [...CORE_FUNCTIONS, ...dialect.functions];
      for (const fn of allFunctions) {
        const key = `fn:${fn.name}`;
        if (seenLabels.has(key)) continue;
        seenLabels.add(key);
        suggestions.push({
          label: `${fn.name}()`,
          filterText: fn.name,
          kind: monaco.languages.CompletionItemKind.Function,
          insertText: fn.snippet,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: fn.detail,
          sortText: `${rank.func}_${fn.name}`,
          range,
        });
      }

      // Quick Snippets (only relevant in general / start context so they don't clutter column/table lists)
      if (clauseCtx === "general") {
        for (const snip of QUICK_SNIPPETS) {
          suggestions.push({
            label: snip.label,
            filterText: snip.filterText,
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: snip.insertText,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            detail: snip.detail,
            sortText: `${rank.snippet}_${snip.label}`,
            range,
          });
        }
      }

      return { suggestions };
    },
  });
}

/**
 * Returns true if the SQL text contains DDL statements that may alter
 * tables, views, or columns (CREATE / ALTER / DROP / RENAME).
 */
export function containsSchemaChangingDdl(sql: string): boolean {
  const masked = maskStringsAndComments(sql);
  return /\b(?:CREATE|ALTER|DROP|RENAME)\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:MATERIALIZED\s+)?(?:TABLE|VIEW|SCHEMA|DATABASE|INDEX|COLUMN)\b/i.test(
    masked
  );
}
