use crate::drivers::mongodb::MongoDriver;
use crate::drivers::{
    generate_table_design_ddl, qualified_table, quote_ident, sql_literal, SqlDriver,
};
use crate::error::Result;
use crate::models::*;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

/// Returns the default customizable Type Mapping Matrix for a (source, target) engine pair.
pub fn default_type_mappings(source: DbEngine, target: DbEngine) -> Vec<TypeMappingRule> {
    if target == DbEngine::Mongodb {
        return vec![
            rule("integer", "Int32"),
            rule("bigint", "Int64"),
            rule("varchar", "String"),
            rule("text", "String"),
            rule("boolean", "Boolean"),
            rule("numeric", "Double"),
            rule("timestamp", "Date"),
            rule("jsonb", "Object"),
            rule("uuid", "String"),
        ];
    }

    match (source, target) {
        (_, DbEngine::Postgres) => vec![
            rule("int", "INTEGER"),
            rule("bigint", "BIGINT"),
            rule("smallint", "SMALLINT"),
            rule("tinyint", "SMALLINT"),
            rule("bit", "BOOLEAN"),
            rule("varchar", "VARCHAR"),
            rule("nvarchar", "VARCHAR"),
            rule("text", "TEXT"),
            rule("longtext", "TEXT"),
            rule("datetime", "TIMESTAMP"),
            rule("datetime2", "TIMESTAMP"),
            rule("decimal", "NUMERIC"),
            rule("double", "DOUBLE PRECISION"),
            rule("float", "DOUBLE PRECISION"),
            rule("json", "JSONB"),
            rule("uniqueidentifier", "UUID"),
            rule("blob", "BYTEA"),
            rule("varbinary", "BYTEA"),
            rule("bson", "TEXT"),
        ],
        (_, DbEngine::Mysql) => vec![
            rule("integer", "INT"),
            rule("int4", "INT"),
            rule("bigint", "BIGINT"),
            rule("int8", "BIGINT"),
            rule("smallint", "SMALLINT"),
            rule("boolean", "TINYINT(1)"),
            rule("bit", "TINYINT(1)"),
            rule("varchar", "VARCHAR(255)"),
            rule("nvarchar", "VARCHAR(255)"),
            rule("text", "TEXT"),
            rule("timestamp", "DATETIME"),
            rule("timestamptz", "DATETIME"),
            rule("datetime2", "DATETIME"),
            rule("numeric", "DECIMAL(18,4)"),
            rule("double precision", "DOUBLE"),
            rule("jsonb", "JSON"),
            rule("uuid", "CHAR(36)"),
            rule("uniqueidentifier", "CHAR(36)"),
            rule("bytea", "LONGBLOB"),
            rule("bson", "TEXT"),
        ],
        (_, DbEngine::Mssql) => vec![
            rule("integer", "INT"),
            rule("int4", "INT"),
            rule("bigint", "BIGINT"),
            rule("int8", "BIGINT"),
            rule("smallint", "SMALLINT"),
            rule("boolean", "BIT"),
            rule("varchar", "NVARCHAR(255)"),
            rule("text", "NVARCHAR(MAX)"),
            rule("longtext", "NVARCHAR(MAX)"),
            rule("timestamp", "DATETIME2"),
            rule("timestamptz", "DATETIMEOFFSET"),
            rule("datetime", "DATETIME2"),
            rule("numeric", "DECIMAL(18,4)"),
            rule("double precision", "FLOAT"),
            rule("double", "FLOAT"),
            rule("json", "NVARCHAR(MAX)"),
            rule("jsonb", "NVARCHAR(MAX)"),
            rule("uuid", "UNIQUEIDENTIFIER"),
            rule("bytea", "VARBINARY(MAX)"),
            rule("blob", "VARBINARY(MAX)"),
            rule("bson", "NVARCHAR(MAX)"),
        ],
        (_, DbEngine::Mongodb) => Vec::new(),
    }
}

fn rule(src: &str, tgt: &str) -> TypeMappingRule {
    TypeMappingRule {
        source_type: src.to_string(),
        target_type: tgt.to_string(),
    }
}

pub fn map_column_type(
    src_type: &str,
    target_engine: DbEngine,
    custom_rules: &[TypeMappingRule],
) -> String {
    let base = src_type
        .split('(')
        .next()
        .unwrap_or(src_type)
        .trim()
        .to_lowercase();

    for r in custom_rules {
        if r.source_type.trim().eq_ignore_ascii_case(&base)
            || r.source_type.trim().eq_ignore_ascii_case(src_type.trim())
        {
            return r.target_type.clone();
        }
    }

    match target_engine {
        DbEngine::Postgres => {
            if base.contains("int") {
                "BIGINT".into()
            } else if base.contains("bool") || base == "bit" {
                "BOOLEAN".into()
            } else if base.contains("char") || base.contains("text") || base == "bson" {
                "TEXT".into()
            } else if base.contains("date") || base.contains("time") {
                "TIMESTAMP".into()
            } else if base.contains("dec") || base.contains("num") {
                "NUMERIC".into()
            } else if base.contains("float") || base.contains("double") {
                "DOUBLE PRECISION".into()
            } else if base.contains("json") {
                "JSONB".into()
            } else {
                "TEXT".into()
            }
        }
        DbEngine::Mysql => {
            if base.contains("int") {
                "BIGINT".into()
            } else if base.contains("bool") || base == "bit" {
                "TINYINT(1)".into()
            } else if base.contains("date") || base.contains("time") {
                "DATETIME".into()
            } else if base.contains("dec") || base.contains("num") {
                "DECIMAL(18,4)".into()
            } else if base.contains("float") || base.contains("double") {
                "DOUBLE".into()
            } else if base.contains("json") {
                "JSON".into()
            } else {
                "TEXT".into()
            }
        }
        DbEngine::Mssql => {
            if base.contains("int") {
                "BIGINT".into()
            } else if base.contains("bool") || base == "bit" {
                "BIT".into()
            } else if base.contains("date") || base.contains("time") {
                "DATETIME2".into()
            } else if base.contains("dec") || base.contains("num") {
                "DECIMAL(18,4)".into()
            } else if base.contains("float") || base.contains("double") {
                "FLOAT".into()
            } else {
                "NVARCHAR(MAX)".into()
            }
        }
        DbEngine::Mongodb => "String".into(),
    }
}

/// Transfers one or more tables/collections between any two connections (same-engine or cross-engine).
#[allow(clippy::too_many_arguments)]
pub async fn run_data_transfer(
    src_driver: Arc<dyn SqlDriver>,
    src_engine: DbEngine,
    tgt_driver: Arc<dyn SqlDriver>,
    tgt_mongo: Option<Arc<MongoDriver>>,
    tgt_engine: DbEngine,
    req: &DataTransferRequest,
    job_id: String,
    cancel: Arc<AtomicBool>,
) -> Result<DataTransferResult> {
    let start = Instant::now();
    let batch_size = req.batch_size.unwrap_or(250).clamp(10, 2000);
    let effective_rules = if req.type_mappings.is_empty() {
        default_type_mappings(src_engine, tgt_engine)
    } else {
        req.type_mappings.clone()
    };

    let mut reports = Vec::new();
    let mut object_reports = Vec::new();
    let mut total_rows = 0u64;
    let mut cancelled = false;
    let mut stopped_on_error = false;

    // Pre-table objects: Enum types & Sequences (tables may depend on them)
    let (pre_objects, post_objects): (Vec<&TransferObjectSelection>, Vec<&TransferObjectSelection>) =
        req.objects
            .iter()
            .partition(|o| matches!(o.kind, ObjectKind::EnumType | ObjectKind::Sequence));

    for obj in pre_objects {
        if cancel.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
        let rep = transfer_single_object(
            src_driver.clone(),
            src_engine,
            tgt_driver.clone(),
            tgt_engine,
            req,
            obj,
        )
        .await;
        let failed = !rep.ok;
        object_reports.push(rep);
        if failed && req.error_policy == ImportErrorPolicy::StopOnError {
            stopped_on_error = true;
            break;
        }
    }

    if !cancelled && !stopped_on_error {
        for sel in &req.tables {
            if cancel.load(Ordering::SeqCst) {
                cancelled = true;
                break;
            }

            let target_table = if sel.target_table.trim().is_empty() {
                sel.source_table.clone()
            } else {
                sel.target_table.clone()
            };

            let table_res = transfer_single_table(
                src_driver.clone(),
                src_engine,
                tgt_driver.clone(),
                tgt_mongo.clone(),
                tgt_engine,
                req,
                &sel.source_table,
                &target_table,
                sel.include_data,
                &effective_rules,
                batch_size,
                &job_id,
                cancel.clone(),
            )
            .await;

            match table_res {
                Ok(rows) => {
                    total_rows += rows;
                    reports.push(TransferTableReport {
                        source_table: sel.source_table.clone(),
                        target_table,
                        rows_transferred: rows,
                        ok: true,
                        error: None,
                    });
                }
                Err(err) => {
                    reports.push(TransferTableReport {
                        source_table: sel.source_table.clone(),
                        target_table,
                        rows_transferred: 0,
                        ok: false,
                        error: Some(err.to_string()),
                    });
                    if req.error_policy == ImportErrorPolicy::StopOnError {
                        stopped_on_error = true;
                        break;
                    }
                }
            }
        }
    }

    // Post-table objects in dependency order: Views -> MaterializedViews -> Functions -> Procedures -> Triggers -> Events
    if !cancelled && !stopped_on_error && !post_objects.is_empty() {
        let mut ordered = post_objects;
        ordered.sort_by_key(|o| object_transfer_priority(o.kind));

        for obj in ordered {
            if cancel.load(Ordering::SeqCst) {
                cancelled = true;
                break;
            }
            let rep = transfer_single_object(
                src_driver.clone(),
                src_engine,
                tgt_driver.clone(),
                tgt_engine,
                req,
                obj,
            )
            .await;
            let failed = !rep.ok;
            object_reports.push(rep);
            if failed && req.error_policy == ImportErrorPolicy::StopOnError {
                break;
            }
        }
    }

    let ok_tables = reports.iter().filter(|r| r.ok).count();
    let ok_objects = object_reports.iter().filter(|r| r.ok).count();
    let all_ok = !cancelled
        && reports.iter().all(|r| r.ok)
        && object_reports.iter().all(|r| r.ok);

    let summary = if cancelled {
        format!("Transfer cancelled after {} row(s)", total_rows)
    } else if !object_reports.is_empty() && !reports.is_empty() {
        format!(
            "Transferred {} table(s), {} object(s), {} total row(s)",
            ok_tables, ok_objects, total_rows
        )
    } else if !object_reports.is_empty() {
        format!("Transferred {} object(s)", ok_objects)
    } else {
        format!(
            "Transferred {} table(s), {} total row(s)",
            ok_tables, total_rows
        )
    };

    Ok(DataTransferResult {
        job_id,
        ok: all_ok,
        cancelled,
        total_rows,
        duration_ms: start.elapsed().as_millis() as u64,
        summary,
        tables: reports,
        objects: object_reports,
    })
}

fn object_transfer_priority(kind: ObjectKind) -> u8 {
    match kind {
        ObjectKind::EnumType => 0,
        ObjectKind::Sequence => 1,
        ObjectKind::View => 2,
        ObjectKind::MaterializedView => 3,
        ObjectKind::Function => 4,
        ObjectKind::Procedure => 5,
        ObjectKind::Trigger => 6,
        ObjectKind::Event => 7,
        _ => 8,
    }
}

fn rewrite_ddl_schema(
    ddl: &str,
    engine: DbEngine,
    src_schema: Option<&str>,
    tgt_schema: Option<&str>,
) -> String {
    let (Some(src), Some(tgt)) = (src_schema, tgt_schema) else {
        return ddl.to_string();
    };
    if src.is_empty() || tgt.is_empty() || src.eq_ignore_ascii_case(tgt) {
        return ddl.to_string();
    }
    let q_src = quote_ident(engine, src);
    let q_tgt = quote_ident(engine, tgt);
    ddl.replace(&format!("{}.", q_src), &format!("{}.", q_tgt))
        .replace(&format!("{}.", src), &format!("{}.", tgt))
}

async fn transfer_single_object(
    src_driver: Arc<dyn SqlDriver>,
    src_engine: DbEngine,
    tgt_driver: Arc<dyn SqlDriver>,
    tgt_engine: DbEngine,
    req: &DataTransferRequest,
    obj: &TransferObjectSelection,
) -> TransferObjectReport {
    if src_engine != tgt_engine {
        return TransferObjectReport {
            name: obj.name.clone(),
            kind: obj.kind,
            ok: false,
            error: Some(format!(
                "Cannot transfer {:?} '{}' across different engines ({:?} -> {:?}); DDL is engine-specific.",
                obj.kind, obj.name, src_engine, tgt_engine
            )),
        };
    }

    let raw_ddl = match src_driver
        .get_object_ddl(
            req.source_database.as_deref(),
            req.source_schema.as_deref(),
            &obj.name,
            obj.kind,
        )
        .await
    {
        Ok(d) => d,
        Err(err) => {
            return TransferObjectReport {
                name: obj.name.clone(),
                kind: obj.kind,
                ok: false,
                error: Some(err.to_string()),
            };
        }
    };

    let ddl = rewrite_ddl_schema(
        &raw_ddl,
        tgt_engine,
        req.source_schema.as_deref(),
        req.target_schema.as_deref(),
    );

    if req.mode == TransferTableMode::DropAndRecreate {
        let _ = tgt_driver
            .drop_object(
                req.target_database.as_deref(),
                req.target_schema.as_deref(),
                &obj.name,
                obj.kind,
            )
            .await;
    }

    match tgt_driver
        .execute_ddl(req.target_database.as_deref(), &ddl)
        .await
    {
        Ok(()) => TransferObjectReport {
            name: obj.name.clone(),
            kind: obj.kind,
            ok: true,
            error: None,
        },
        Err(err) => TransferObjectReport {
            name: obj.name.clone(),
            kind: obj.kind,
            ok: false,
            error: Some(err.to_string()),
        },
    }
}

#[allow(clippy::too_many_arguments)]
async fn transfer_single_table(
    src_driver: Arc<dyn SqlDriver>,
    src_engine: DbEngine,
    tgt_driver: Arc<dyn SqlDriver>,
    tgt_mongo: Option<Arc<MongoDriver>>,
    tgt_engine: DbEngine,
    req: &DataTransferRequest,
    source_table: &str,
    target_table: &str,
    include_data: bool,
    type_rules: &[TypeMappingRule],
    batch_size: usize,
    job_id: &str,
    cancel: Arc<AtomicBool>,
) -> Result<u64> {
    let meta = src_driver
        .get_table_metadata(
            req.source_database.as_deref(),
            req.source_schema.as_deref(),
            source_table,
        )
        .await?;

    // 1. Prepare target structure
    if tgt_engine == DbEngine::Mongodb {
        if req.mode == TransferTableMode::DropAndRecreate {
            let _ = tgt_driver
                .drop_object(
                    req.target_database.as_deref(),
                    None,
                    target_table,
                    ObjectKind::Collection,
                )
                .await;
        }
    } else {
        let tgt_fq = qualified_table(tgt_engine, req.target_schema.as_deref(), target_table);
        if req.mode == TransferTableMode::DropAndRecreate {
            let _ = tgt_driver
                .execute_ddl(
                    req.target_database.as_deref(),
                    &format!("DROP TABLE IF EXISTS {};", tgt_fq),
                )
                .await;
        }

        if matches!(
            req.mode,
            TransferTableMode::DropAndRecreate | TransferTableMode::CreateIfNotExists
        ) {
            let columns: Vec<TableDesignColumn> = meta
                .columns
                .iter()
                .map(|c| {
                    let mapped_type = if src_engine == tgt_engine {
                        c.udt_name.clone().unwrap_or_else(|| c.data_type.clone())
                    } else {
                        map_column_type(&c.data_type, tgt_engine, type_rules)
                    };
                    TableDesignColumn {
                        name: c.name.clone(),
                        original_name: None,
                        data_type: mapped_type,
                        length: None,
                        nullable: c.nullable,
                        default_value: None,
                        is_primary_key: c.is_primary_key,
                        is_auto_increment: false,
                        comment: None,
                    }
                })
                .collect();

            if !columns.is_empty() {
                let draft = TableDesignDraft {
                    is_new_table: true,
                    schema: req.target_schema.clone(),
                    table_name: target_table.to_string(),
                    columns,
                    indexes: Vec::new(),
                    foreign_keys: Vec::new(),
                    checks: Vec::new(),
                };
                let ddl = generate_table_design_ddl(tgt_engine, &draft);
                let create_res = tgt_driver
                    .execute_ddl(req.target_database.as_deref(), &ddl)
                    .await;
                if req.mode == TransferTableMode::DropAndRecreate {
                    create_res?;
                }
            }
        }
    }

    if !include_data {
        return Ok(0);
    }

    // 2. Stream rows in pages from Source -> Target
    let mut page = 1u64;
    let page_size = (batch_size as u64).max(200);
    let mut transferred = 0u64;
    let pk_cols: Vec<String> = meta
        .columns
        .iter()
        .filter(|c| c.is_primary_key)
        .map(|c| c.name.clone())
        .collect();

    loop {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        let rs = src_driver
            .fetch_table_data(&TableDataRequest {
                connection_id: req.source_connection_id.clone(),
                database: req.source_database.clone(),
                schema: req.source_schema.clone(),
                table: source_table.to_string(),
                page,
                page_size,
                filters: Vec::new(),
                sorts: Vec::new(),
            })
            .await?;

        if rs.rows.is_empty() {
            break;
        }

        let headers: Vec<String> = rs.columns.iter().map(|c| c.name.clone()).collect();

        if tgt_engine == DbEngine::Mongodb {
            if let Some(ref mg) = tgt_mongo {
                let db = req.target_database.as_deref().unwrap_or("admin").to_string();
                let changes: Vec<MongoDocChange> = rs
                    .rows
                    .iter()
                    .map(|r| {
                        let mut map = serde_json::Map::new();
                        for (h, v) in headers.iter().zip(r.iter()) {
                            map.insert(h.clone(), v.clone());
                        }
                        MongoDocChange::Insert {
                            document: serde_json::Value::Object(map),
                        }
                    })
                    .collect();
                let n = mg
                    .apply_document_changes(&MongoApplyChangesRequest {
                        connection_id: req.target_connection_id.clone(),
                        database: db,
                        collection: target_table.to_string(),
                        changes,
                        confirmed_production: req.confirmed_production,
                    })
                    .await?;
                transferred += n;
            }
        } else {
            let tgt_fq = qualified_table(tgt_engine, req.target_schema.as_deref(), target_table);
            let col_list = headers
                .iter()
                .map(|c| quote_ident(tgt_engine, c))
                .collect::<Vec<_>>()
                .join(", ");

            for chunk in rs.rows.chunks(batch_size) {
                if cancel.load(Ordering::SeqCst) {
                    break;
                }
                let tuples: Vec<String> = chunk
                    .iter()
                    .map(|r| {
                        let vals = r.iter().map(sql_literal).collect::<Vec<_>>().join(", ");
                        format!("({})", vals)
                    })
                    .collect();

                let mut sql = format!(
                    "INSERT INTO {} ({}) VALUES {}",
                    tgt_fq,
                    col_list,
                    tuples.join(", ")
                );

                if req.mode == TransferTableMode::Upsert && !pk_cols.is_empty() {
                    match tgt_engine {
                        DbEngine::Postgres => {
                            let pk = pk_cols
                                .iter()
                                .map(|c| quote_ident(tgt_engine, c))
                                .collect::<Vec<_>>()
                                .join(", ");
                            let sets = headers
                                .iter()
                                .filter(|h| !pk_cols.contains(h))
                                .map(|h| {
                                    let q = quote_ident(tgt_engine, h);
                                    format!("{} = EXCLUDED.{}", q, q)
                                })
                                .collect::<Vec<_>>()
                                .join(", ");
                            if sets.is_empty() {
                                sql.push_str(&format!(" ON CONFLICT ({}) DO NOTHING", pk));
                            } else {
                                sql.push_str(&format!(
                                    " ON CONFLICT ({}) DO UPDATE SET {}",
                                    pk, sets
                                ));
                            }
                        }
                        DbEngine::Mysql => {
                            let sets = headers
                                .iter()
                                .filter(|h| !pk_cols.contains(h))
                                .map(|h| {
                                    let q = quote_ident(tgt_engine, h);
                                    format!("{} = VALUES({})", q, q)
                                })
                                .collect::<Vec<_>>()
                                .join(", ");
                            if !sets.is_empty() {
                                sql.push_str(&format!(" ON DUPLICATE KEY UPDATE {}", sets));
                            }
                        }
                        _ => {}
                    }
                }
                sql.push(';');

                tgt_driver
                    .execute_query(req.target_database.as_deref(), &sql, job_id)
                    .await?;
                transferred += chunk.len() as u64;
            }
        }

        if (rs.rows.len() as u64) < page_size {
            break;
        }
        page += 1;
    }

    // Keep unused HashMap import clean if needed
    let _ = HashMap::<String, String>::new();
    Ok(transferred)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_mysql_to_postgres_types() {
        let rules = default_type_mappings(DbEngine::Mysql, DbEngine::Postgres);
        assert_eq!(map_column_type("varchar(255)", DbEngine::Postgres, &rules), "VARCHAR");
        assert_eq!(map_column_type("datetime", DbEngine::Postgres, &rules), "TIMESTAMP");
        assert_eq!(map_column_type("json", DbEngine::Postgres, &rules), "JSONB");
    }

    #[test]
    fn maps_postgres_to_mssql_types() {
        let rules = default_type_mappings(DbEngine::Postgres, DbEngine::Mssql);
        assert_eq!(map_column_type("uuid", DbEngine::Mssql, &rules), "UNIQUEIDENTIFIER");
        assert_eq!(map_column_type("boolean", DbEngine::Mssql, &rules), "BIT");
        assert_eq!(map_column_type("text", DbEngine::Mssql, &rules), "NVARCHAR(MAX)");
    }
}
