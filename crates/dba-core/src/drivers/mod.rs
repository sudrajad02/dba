pub mod mongodb;
pub mod mssql;
pub mod mysql;
pub mod postgres;
pub mod safety;
pub mod ssh;
pub mod uri;

use crate::error::Result;
use crate::models::*;
use async_trait::async_trait;

#[async_trait]
pub trait SqlDriver: Send + Sync {
    async fn server_version(&self) -> Result<String>;
    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>>;
    async fn list_schemas(&self, database: Option<&str>) -> Result<Vec<SchemaInfo>>;
    async fn list_objects(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
    ) -> Result<Vec<DatabaseObject>>;
    async fn get_table_metadata(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
        table: &str,
    ) -> Result<TableMetadata>;
    async fn fetch_table_data(&self, req: &TableDataRequest) -> Result<QueryResultSet>;
    async fn execute_query(
        &self,
        database: Option<&str>,
        sql: &str,
        query_id: &str,
    ) -> Result<QueryExecutionResponse>;
    async fn cancel_query(&self, query_id: &str) -> Result<()>;
    async fn explain_query(&self, database: Option<&str>, sql: &str) -> Result<ExplainPlanResult>;
    async fn apply_staged_changes(&self, req: &ApplyChangesRequest) -> Result<u64>;
    async fn get_autocomplete_schema(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
    ) -> Result<AutocompleteSchema>;
    async fn execute_ddl(&self, database: Option<&str>, ddl: &str) -> Result<()>;
    async fn truncate_table(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
        table: &str,
    ) -> Result<()>;
    async fn drop_object(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
        name: &str,
        kind: ObjectKind,
    ) -> Result<()>;
    async fn duplicate_table(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
        source: &str,
        target: &str,
        with_data: bool,
    ) -> Result<()>;
    async fn get_object_ddl(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
        name: &str,
        kind: ObjectKind,
    ) -> Result<String> {
        let _ = (database, schema, name, kind);
        Err(crate::error::DbaError::UnsupportedEngine(
            "DDL extraction is not supported for this object/engine".into(),
        ))
    }
    async fn create_database(
        &self,
        name: &str,
        charset: Option<&str>,
        collation: Option<&str>,
    ) -> Result<()> {
        let _ = (name, charset, collation);
        Err(crate::error::DbaError::UnsupportedEngine(
            "Creating databases is not supported for this engine".into(),
        ))
    }
    async fn drop_database(&self, name: &str) -> Result<()> {
        let _ = name;
        Err(crate::error::DbaError::UnsupportedEngine(
            "Dropping databases is not supported for this engine".into(),
        ))
    }
    async fn rename_table(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
        old_name: &str,
        new_name: &str,
    ) -> Result<()> {
        let _ = (database, schema, old_name, new_name);
        Err(crate::error::DbaError::UnsupportedEngine(
            "Renaming tables is not supported for this engine".into(),
        ))
    }
    async fn create_schema(&self, database: Option<&str>, name: &str) -> Result<()> {
        let _ = (database, name);
        Err(crate::error::DbaError::UnsupportedEngine(
            "Creating schemas is not supported for this engine".into(),
        ))
    }
    async fn drop_schema(&self, database: Option<&str>, name: &str, cascade: bool) -> Result<()> {
        let _ = (database, name, cascade);
        Err(crate::error::DbaError::UnsupportedEngine(
            "Dropping schemas is not supported for this engine".into(),
        ))
    }
}

/// Validates a charset/collation/encoding token so it cannot inject SQL.
pub fn validate_sql_option_token(val: &str, label: &str) -> Result<String> {
    let trimmed = val.trim();
    if trimmed.is_empty()
        || !trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(crate::error::DbaError::Database {
            message: format!("Invalid {}: '{}'", label, val),
            code: None,
            detail: None,
            line: None,
        });
    }
    Ok(trimmed.to_string())
}

/// Quotes a SQL identifier safely for PostgreSQL (`"id"`), MySQL (`` `id` ``), or MSSQL (`[id]`).
pub fn quote_ident(engine: DbEngine, ident: &str) -> String {
    match engine {
        DbEngine::Mysql => format!("`{}`", ident.replace('`', "``")),
        DbEngine::Mssql => format!("[{}]", ident.replace(']', "]]")),
        _ => format!("\"{}\"", ident.replace('"', "\"\"")),
    }
}

pub fn qualified_table(engine: DbEngine, schema: Option<&str>, table: &str) -> String {
    match schema {
        Some(s) if !s.is_empty() => {
            format!("{}.{}", quote_ident(engine, s), quote_ident(engine, table))
        }
        _ => quote_ident(engine, table),
    }
}

pub fn sql_literal(val: &serde_json::Value) -> String {
    match val {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::Bool(b) => {
            if *b {
                "TRUE".to_string()
            } else {
                "FALSE".to_string()
            }
        }
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => format!("'{}'", s.replace('\'', "''")),
        other => format!("'{}'", other.to_string().replace('\'', "''")),
    }
}

/// Generates SQL statements for staged changes (used for both Preview SQL and transactional execution).
pub fn build_staged_change_sql(
    engine: DbEngine,
    schema: Option<&str>,
    table: &str,
    changes: &[StagedChange],
) -> Vec<String> {
    let fq = qualified_table(engine, schema, table);
    let mut stmts = Vec::with_capacity(changes.len());

    for change in changes {
        match change {
            StagedChange::Insert { values } => {
                if values.is_empty() {
                    continue;
                }
                let mut cols: Vec<&String> = values.keys().collect();
                cols.sort();
                let col_list = cols
                    .iter()
                    .map(|c| quote_ident(engine, c))
                    .collect::<Vec<_>>()
                    .join(", ");
                let val_list = cols
                    .iter()
                    .map(|c| sql_literal(&values[*c]))
                    .collect::<Vec<_>>()
                    .join(", ");
                stmts.push(format!("INSERT INTO {} ({}) VALUES ({});", fq, col_list, val_list));
            }
            StagedChange::Update {
                primary_keys,
                changes,
            } => {
                if changes.is_empty() || primary_keys.is_empty() {
                    continue;
                }
                let mut set_cols: Vec<&String> = changes.keys().collect();
                set_cols.sort();
                let set_clause = set_cols
                    .iter()
                    .map(|c| format!("{} = {}", quote_ident(engine, c), sql_literal(&changes[*c])))
                    .collect::<Vec<_>>()
                    .join(", ");

                let mut pk_cols: Vec<&String> = primary_keys.keys().collect();
                pk_cols.sort();
                let where_clause = pk_cols
                    .iter()
                    .map(|c| {
                        let v = &primary_keys[*c];
                        if v.is_null() {
                            format!("{} IS NULL", quote_ident(engine, c))
                        } else {
                            format!("{} = {}", quote_ident(engine, c), sql_literal(v))
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(" AND ");

                stmts.push(format!("UPDATE {} SET {} WHERE {};", fq, set_clause, where_clause));
            }
            StagedChange::Delete { primary_keys } => {
                if primary_keys.is_empty() {
                    continue;
                }
                let mut pk_cols: Vec<&String> = primary_keys.keys().collect();
                pk_cols.sort();
                let where_clause = pk_cols
                    .iter()
                    .map(|c| {
                        let v = &primary_keys[*c];
                        if v.is_null() {
                            format!("{} IS NULL", quote_ident(engine, c))
                        } else {
                            format!("{} = {}", quote_ident(engine, c), sql_literal(v))
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(" AND ");
                stmts.push(format!("DELETE FROM {} WHERE {};", fq, where_clause));
            }
        }
    }
    stmts
}

/// Returns true when the SQL is a single compound routine/trigger/event DDL statement
/// (e.g. `CREATE PROCEDURE ... BEGIN ... ; END`) whose internal semicolons must NOT be
/// split by `split_sql_statements`.
pub fn is_compound_ddl(sql: &str) -> bool {
    let mut s = sql.trim_start();
    loop {
        if let Some(rest) = s.strip_prefix("--") {
            s = match rest.find('\n') {
                Some(idx) => rest[idx + 1..].trim_start(),
                None => "",
            };
        } else if let Some(rest) = s.strip_prefix("/*") {
            s = match rest.find("*/") {
                Some(idx) => rest[idx + 2..].trim_start(),
                None => "",
            };
        } else {
            break;
        }
    }

    let upper = s.to_ascii_uppercase();
    if !(upper.starts_with("CREATE ")
        || upper.starts_with("CREATE\t")
        || upper.starts_with("CREATE\n")
        || upper.starts_with("CREATE\r"))
    {
        return false;
    }

    let header_end = upper.find('(').unwrap_or(upper.len());
    let header = &upper[..header_end];
    for tok in header.split_whitespace() {
        match tok {
            "TABLE" | "INDEX" | "VIEW" | "DATABASE" | "SCHEMA" | "SEQUENCE" | "TYPE" => {
                return false;
            }
            "PROCEDURE" | "PROC" | "FUNCTION" | "TRIGGER" | "EVENT" => {
                return true;
            }
            _ => {}
        }
    }
    false
}

/// Splits a multi-statement SQL script while respecting single quotes, double quotes,
/// dollar-quoted strings (PostgreSQL `$$`), and `--` / `/* */` comments.
pub fn split_sql_statements(sql: &str) -> Vec<String> {
    let mut statements = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = sql.chars().collect();
    let len = chars.len();
    let mut i = 0;

    let mut in_single_quote = false;
    let mut in_double_quote = false;
    let mut in_dollar_quote = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;

    while i < len {
        let ch = chars[i];
        let next = if i + 1 < len { Some(chars[i + 1]) } else { None };

        if in_line_comment {
            current.push(ch);
            if ch == '\n' {
                in_line_comment = false;
            }
            i += 1;
            continue;
        }
        if in_block_comment {
            current.push(ch);
            if ch == '*' && next == Some('/') {
                current.push('/');
                in_block_comment = false;
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }
        if in_single_quote {
            current.push(ch);
            if ch == '\'' {
                if next == Some('\'') {
                    current.push('\'');
                    i += 2;
                    continue;
                }
                in_single_quote = false;
            }
            i += 1;
            continue;
        }
        if in_double_quote {
            current.push(ch);
            if ch == '"' {
                if next == Some('"') {
                    current.push('"');
                    i += 2;
                    continue;
                }
                in_double_quote = false;
            }
            i += 1;
            continue;
        }
        if in_dollar_quote {
            current.push(ch);
            if ch == '$' && next == Some('$') {
                current.push('$');
                in_dollar_quote = false;
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }

        if ch == '-' && next == Some('-') {
            in_line_comment = true;
            current.push(ch);
            current.push('-');
            i += 2;
            continue;
        }
        if ch == '/' && next == Some('*') {
            in_block_comment = true;
            current.push(ch);
            current.push('*');
            i += 2;
            continue;
        }
        if ch == '\'' {
            in_single_quote = true;
            current.push(ch);
            i += 1;
            continue;
        }
        if ch == '"' {
            in_double_quote = true;
            current.push(ch);
            i += 1;
            continue;
        }
        if ch == '$' && next == Some('$') {
            in_dollar_quote = true;
            current.push('$');
            current.push('$');
            i += 2;
            continue;
        }

        if ch == ';' {
            let trimmed = current.trim().to_string();
            if !trimmed.is_empty() {
                statements.push(trimmed);
            }
            current.clear();
            i += 1;
            continue;
        }

        current.push(ch);
        i += 1;
    }

    let trimmed = current.trim().to_string();
    if !trimmed.is_empty() {
        statements.push(trimmed);
    }

    statements
}

/// Builds WHERE clause from Visual Filter Builder conditions.
pub fn build_where_clause(engine: DbEngine, filters: &[FilterCondition]) -> String {
    if filters.is_empty() {
        return String::new();
    }
    let parts: Vec<String> = filters
        .iter()
        .filter_map(|f| {
            let col = quote_ident(engine, &f.column);
            let op = f.operator.trim().to_uppercase();
            match op.as_str() {
                "IS NULL" => Some(format!("{} IS NULL", col)),
                "IS NOT NULL" => Some(format!("{} IS NOT NULL", col)),
                "IN" => {
                    let val = f.value.as_deref().unwrap_or("").trim();
                    if val.is_empty() {
                        return None;
                    }
                    let items: Vec<String> = val
                        .split(',')
                        .map(|s| {
                            let s = s.trim();
                            if s.parse::<f64>().is_ok() {
                                s.to_string()
                            } else {
                                format!("'{}'", s.replace('\'', "''"))
                            }
                        })
                        .collect();
                    Some(format!("{} IN ({})", col, items.join(", ")))
                }
                "BETWEEN" => {
                    let v1 = f.value.as_deref().unwrap_or("").trim();
                    let v2 = f.value2.as_deref().unwrap_or("").trim();
                    if v1.is_empty() || v2.is_empty() {
                        return None;
                    }
                    Some(format!(
                        "{} BETWEEN '{}' AND '{}'",
                        col,
                        v1.replace('\'', "''"),
                        v2.replace('\'', "''")
                    ))
                }
                "LIKE" | "ILIKE" => {
                    let val = f.value.as_deref().unwrap_or("");
                    let effective_op = if op == "ILIKE" && engine != DbEngine::Postgres {
                        "LIKE"
                    } else {
                        op.as_str()
                    };
                    Some(format!("{} {} '{}'", col, effective_op, val.replace('\'', "''")))
                }
                "=" | "!=" | "<>" | ">" | "<" | ">=" | "<=" => {
                    let val = f.value.as_deref().unwrap_or("");
                    if val.parse::<f64>().is_ok() {
                        Some(format!("{} {} {}", col, op, val))
                    } else {
                        Some(format!("{} {} '{}'", col, op, val.replace('\'', "''")))
                    }
                }
                _ => None,
            }
        })
        .collect();

    if parts.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", parts.join(" AND "))
    }
}

/// Builds ORDER BY clause from SortSpec list.
pub fn build_order_clause(engine: DbEngine, sorts: &[SortSpec]) -> String {
    if sorts.is_empty() {
        return String::new();
    }
    let parts: Vec<String> = sorts
        .iter()
        .map(|s| {
            let dir = if s.direction.eq_ignore_ascii_case("DESC") {
                "DESC"
            } else {
                "ASC"
            };
            format!("{} {}", quote_ident(engine, &s.column), dir)
        })
        .collect();
    format!(" ORDER BY {}", parts.join(", "))
}

/// Generates CREATE TABLE or ALTER TABLE DDL preview for GUI Table Designer.
pub fn generate_table_design_ddl(engine: DbEngine, draft: &TableDesignDraft) -> String {
    let fq = qualified_table(engine, draft.schema.as_deref(), &draft.table_name);
    let mut lines = Vec::new();
    let mut pk_cols = Vec::new();

    for col in &draft.columns {
        let mut def = format!("  {} {}", quote_ident(engine, &col.name), col.data_type);
        if let Some(len) = col.length.as_deref().filter(|s| !s.trim().is_empty()) {
            if !col.data_type.contains('(') {
                def.push_str(&format!("({})", len.trim()));
            }
        }
        if col.is_auto_increment {
            match engine {
                DbEngine::Mysql => def.push_str(" AUTO_INCREMENT"),
                DbEngine::Postgres => {
                    if !col.data_type.to_lowercase().contains("serial") {
                        def.push_str(" GENERATED BY DEFAULT AS IDENTITY");
                    }
                }
                DbEngine::Mssql => {
                    if !col.data_type.to_lowercase().contains("identity") {
                        def.push_str(" IDENTITY(1,1)");
                    }
                }
                _ => {}
            }
        }
        if !col.nullable {
            def.push_str(" NOT NULL");
        }
        if let Some(d) = col.default_value.as_deref().filter(|s| !s.trim().is_empty()) {
            def.push_str(&format!(" DEFAULT {}", d.trim()));
        }
        if engine == DbEngine::Mysql {
            if let Some(c) = col.comment.as_deref().filter(|s| !s.trim().is_empty()) {
                def.push_str(&format!(" COMMENT '{}'", c.replace('\'', "''")));
            }
        }
        if col.is_primary_key {
            pk_cols.push(quote_ident(engine, &col.name));
        }
        lines.push(def);
    }

    if !pk_cols.is_empty() {
        lines.push(format!("  PRIMARY KEY ({})", pk_cols.join(", ")));
    }

    for fk in &draft.foreign_keys {
        if fk.columns.is_empty() || fk.ref_table.is_empty() || fk.ref_columns.is_empty() {
            continue;
        }
        let cols = fk
            .columns
            .iter()
            .map(|c| quote_ident(engine, c))
            .collect::<Vec<_>>()
            .join(", ");
        let ref_fq = qualified_table(engine, fk.ref_schema.as_deref(), &fk.ref_table);
        let ref_cols = fk
            .ref_columns
            .iter()
            .map(|c| quote_ident(engine, c))
            .collect::<Vec<_>>()
            .join(", ");
        let constraint_prefix = if fk.name.trim().is_empty() {
            String::new()
        } else {
            format!("CONSTRAINT {} ", quote_ident(engine, &fk.name))
        };
        lines.push(format!(
            "  {}FOREIGN KEY ({}) REFERENCES {} ({}) ON UPDATE {} ON DELETE {}",
            constraint_prefix, cols, ref_fq, ref_cols, fk.on_update, fk.on_delete
        ));
    }

    for chk in &draft.checks {
        if chk.expression.trim().is_empty() {
            continue;
        }
        let prefix = if chk.name.trim().is_empty() {
            String::new()
        } else {
            format!("CONSTRAINT {} ", quote_ident(engine, &chk.name))
        };
        lines.push(format!("  {}CHECK ({})", prefix, chk.expression.trim()));
    }

    let mut ddl = if draft.is_new_table {
        format!("CREATE TABLE {} (\n{}\n);", fq, lines.join(",\n"))
    } else {
        // For existing table edits, generate ALTER statements for newly added columns & indexes
        let mut alters = Vec::new();
        for col in &draft.columns {
            if col.original_name.is_none() {
                let add_kw = if engine == DbEngine::Mssql {
                    "ADD"
                } else {
                    "ADD COLUMN"
                };
                let mut def = format!(
                    "ALTER TABLE {} {} {} {}",
                    fq,
                    add_kw,
                    quote_ident(engine, &col.name),
                    col.data_type
                );
                if let Some(len) = col.length.as_deref().filter(|s| !s.trim().is_empty()) {
                    if !col.data_type.contains('(') {
                        def.push_str(&format!("({})", len.trim()));
                    }
                }
                if !col.nullable {
                    def.push_str(" NOT NULL");
                }
                if let Some(d) = col.default_value.as_deref().filter(|s| !s.trim().is_empty()) {
                    def.push_str(&format!(" DEFAULT {}", d.trim()));
                }
                def.push(';');
                alters.push(def);
            } else if let Some(ref orig) = col.original_name {
                if orig != &col.name {
                    if engine == DbEngine::Mssql {
                        let full_orig = match draft.schema.as_deref().filter(|s| !s.is_empty()) {
                            Some(s) => format!("{}.{}.{}", s, draft.table_name, orig),
                            None => format!("{}.{}", draft.table_name, orig),
                        };
                        alters.push(format!(
                            "EXEC sp_rename '{}', '{}', 'COLUMN';",
                            full_orig.replace('\'', "''"),
                            col.name.replace('\'', "''")
                        ));
                    } else {
                        alters.push(format!(
                            "ALTER TABLE {} RENAME COLUMN {} TO {};",
                            fq,
                            quote_ident(engine, orig),
                            quote_ident(engine, &col.name)
                        ));
                    }
                }
            }
        }
        if alters.is_empty() {
            format!("-- Table definition preview for {}\nCREATE TABLE {} (\n{}\n);", fq, fq, lines.join(",\n"))
        } else {
            alters.join("\n")
        }
    };

    for idx in &draft.indexes {
        if idx.is_primary || idx.columns.is_empty() || idx.name.trim().is_empty() {
            continue;
        }
        let unique = if idx.is_unique { "UNIQUE " } else { "" };
        let cols = idx
            .columns
            .iter()
            .map(|c| quote_ident(engine, c))
            .collect::<Vec<_>>()
            .join(", ");
        let using = if !idx.method.trim().is_empty() && engine == DbEngine::Postgres {
            format!(" USING {}", idx.method)
        } else {
            String::new()
        };
        ddl.push_str(&format!(
            "\nCREATE {}INDEX {} ON {}{} ({});",
            unique,
            quote_ident(engine, &idx.name),
            fq,
            using,
            cols
        ));
    }

    ddl
}

#[cfg(test)]
mod tests {
    use super::is_compound_ddl;

    #[test]
    fn detects_compound_routine_ddl() {
        assert!(is_compound_ddl(
            "CREATE PROCEDURE `p_add_column`(IN t VARCHAR(64))\nBEGIN\n  DECLARE x INT;\n  SET x = 1;\nEND"
        ));
        assert!(is_compound_ddl(
            "CREATE DEFINER=`root`@`%` FUNCTION `decode_id`(s VARCHAR(64)) RETURNS BIGINT\nBEGIN\n  RETURN 1;\nEND"
        ));
        assert!(is_compound_ddl(
            "CREATE TRIGGER trg_audit AFTER INSERT ON users FOR EACH ROW BEGIN INSERT INTO log VALUES (1); END"
        ));
        assert!(is_compound_ddl(
            "CREATE EVENT evt_clean ON SCHEDULE EVERY 1 DAY DO BEGIN DELETE FROM tmp; END"
        ));
        assert!(is_compound_ddl(
            "-- comment\nCREATE OR REPLACE PROC dbo.my_proc AS BEGIN SELECT 1; SELECT 2; END"
        ));
        assert!(!is_compound_ddl(
            "CREATE TABLE `users` (`id` INT, `procedure` VARCHAR(50)); CREATE INDEX idx ON users(id);"
        ));
        assert!(!is_compound_ddl(
            "CREATE VIEW v_test AS SELECT function_name FROM procs;"
        ));
    }
}
