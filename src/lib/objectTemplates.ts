import type { DbEngine, ObjectKind } from "../types/dba";

export function buildNewObjectTemplateSql(
  engine: DbEngine,
  kind: "view" | "function" | "procedure" | "trigger",
  schema?: string | null
): string {
  const prefix =
    schema && engine !== "mysql"
      ? engine === "mssql"
        ? `[${schema}].`
        : `"${schema}".`
      : "";

  if (kind === "view") {
    if (engine === "mssql") {
      return `CREATE OR ALTER VIEW ${prefix}[new_view] AS\nSELECT 1 AS id;\n`;
    }
    if (engine === "mysql") {
      return `CREATE OR REPLACE VIEW \`new_view\` AS\nSELECT 1 AS id;\n`;
    }
    return `CREATE OR REPLACE VIEW ${prefix}"new_view" AS\nSELECT 1 AS id;\n`;
  }

  if (kind === "function") {
    if (engine === "mysql") {
      return `CREATE FUNCTION \`new_function\`(p_input INT)\nRETURNS INT\nDETERMINISTIC\nBEGIN\n  RETURN p_input;\nEND;\n`;
    }
    if (engine === "mssql") {
      return `CREATE OR ALTER FUNCTION ${prefix}[new_function] (@p_input INT)\nRETURNS INT\nAS\nBEGIN\n  RETURN @p_input;\nEND;\n`;
    }
    return `CREATE OR REPLACE FUNCTION ${prefix}"new_function"(p_input INT)\nRETURNS INT\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  RETURN p_input;\nEND;\n$$;\n`;
  }

  if (kind === "procedure") {
    if (engine === "mysql") {
      return `CREATE PROCEDURE \`new_procedure\`(IN p_id INT)\nBEGIN\n  SELECT p_id;\nEND;\n`;
    }
    if (engine === "mssql") {
      return `CREATE OR ALTER PROCEDURE ${prefix}[new_procedure] @p_id INT\nAS\nBEGIN\n  SET NOCOUNT ON;\n  SELECT @p_id AS id;\nEND;\n`;
    }
    return `CREATE OR REPLACE PROCEDURE ${prefix}"new_procedure"(p_id INT)\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  RAISE NOTICE 'id = %', p_id;\nEND;\n$$;\n`;
  }

  // trigger
  if (engine === "mysql") {
    return `CREATE TRIGGER \`trg_new_trigger\`\nAFTER INSERT ON \`target_table\`\nFOR EACH ROW\nBEGIN\n  -- trigger body\nEND;\n`;
  }
  if (engine === "mssql") {
    return `CREATE OR ALTER TRIGGER ${prefix}[trg_new_trigger]\nON ${prefix}[target_table]\nAFTER INSERT\nAS\nBEGIN\n  SET NOCOUNT ON;\n  -- trigger body\nEND;\n`;
  }
  return `-- 1. Trigger function\nCREATE OR REPLACE FUNCTION ${prefix}"trg_new_trigger_fn"()\nRETURNS trigger\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  RETURN NEW;\nEND;\n$$;\n\n-- 2. Trigger binding\nCREATE TRIGGER "trg_new_trigger"\nAFTER INSERT ON ${prefix}"target_table"\nFOR EACH ROW\nEXECUTE FUNCTION ${prefix}"trg_new_trigger_fn"();\n`;
}

export function buildExecuteRoutineSql(
  engine: DbEngine,
  name: string,
  kind: ObjectKind,
  schema?: string | null
): string {
  const fq =
    engine === "mysql"
      ? schema
        ? `\`${schema}\`.\`${name}\``
        : `\`${name}\``
      : engine === "mssql"
      ? schema
        ? `[${schema}].[${name}]`
        : `[${name}]`
      : schema
      ? `"${schema}"."${name}"`
      : `"${name}"`;

  if (kind === "procedure") {
    if (engine === "mssql") return `EXEC ${fq};`;
    return `CALL ${fq}();`;
  }
  return `SELECT ${fq}();`;
}
