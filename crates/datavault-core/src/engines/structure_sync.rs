use crate::drivers::{generate_table_design_ddl, qualified_table, quote_ident, SqlDriver};
use crate::engines::transfer::{default_type_mappings, map_column_type};
use crate::error::Result;
use crate::models::*;
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use std::time::Instant;

fn normalize_type(raw: &str) -> String {
    let mut s = raw.trim().to_lowercase();
    while s.contains("  ") {
        s = s.replace("  ", " ");
    }
    if s.starts_with("character varying") {
        s = s.replacen("character varying", "varchar", 1);
    }
    s
}

fn col_meta_to_design(
    c: &ColumnMeta,
    source_engine: DbEngine,
    target_engine: DbEngine,
    rules: &[TypeMappingRule],
) -> TableDesignColumn {
    let mapped_type = if source_engine == target_engine {
        c.data_type.clone()
    } else {
        map_column_type(&c.data_type, target_engine, rules)
    };
    let length = if mapped_type.contains('(') {
        None
    } else {
        c.max_length.map(|l| l.to_string())
    };
    TableDesignColumn {
        name: c.name.clone(),
        original_name: Some(c.name.clone()),
        data_type: mapped_type,
        length,
        nullable: c.nullable,
        default_value: c.default_value.clone(),
        is_primary_key: c.is_primary_key,
        is_auto_increment: c.is_auto_increment,
        comment: c.comment.clone(),
    }
}

fn column_type_expr(c: &ColumnMeta, source_engine: DbEngine, target_engine: DbEngine, rules: &[TypeMappingRule]) -> String {
    let base = if source_engine == target_engine {
        c.data_type.clone()
    } else {
        map_column_type(&c.data_type, target_engine, rules)
    };
    if !base.contains('(') {
        let lower = base.to_lowercase();
        if let Some(len) = c.max_length {
            if len > 0 && lower.contains("char") {
                return format!("{}({})", base, len);
            }
        }
        if lower == "decimal" || lower == "numeric" {
            if let Some(prec) = c.numeric_precision {
                if prec > 0 {
                    return match c.numeric_scale {
                        Some(scale) if scale >= 0 => format!("{}({},{})", base, prec, scale),
                        _ => format!("{}({})", base, prec),
                    };
                }
            }
        }
    }
    base
}

/// Pure metadata diff engine: compares source and target TableMetadata lists and produces selective DDL.
pub fn diff_table_metadata(
    source_engine: DbEngine,
    target_engine: DbEngine,
    target_schema: Option<&str>,
    source_tables: &[TableMetadata],
    target_tables: &[TableMetadata],
    include_drops: bool,
) -> StructureSyncPlan {
    let rules = default_type_mappings(source_engine, target_engine);
    let src_map: HashMap<String, &TableMetadata> = source_tables
        .iter()
        .map(|t| (t.name.to_lowercase(), t))
        .collect();
    let tgt_map: HashMap<String, &TableMetadata> = target_tables
        .iter()
        .map(|t| (t.name.to_lowercase(), t))
        .collect();

    let mut all_keys = BTreeSet::new();
    for k in src_map.keys() {
        all_keys.insert(k.clone());
    }
    for k in tgt_map.keys() {
        all_keys.insert(k.clone());
    }

    let mut diffs = Vec::new();
    let mut new_cnt = 0usize;
    let mut mod_cnt = 0usize;
    let mut del_cnt = 0usize;

    for key in all_keys {
        match (src_map.get(&key), tgt_map.get(&key)) {
            (Some(src), None) => {
                new_cnt += 1;
                let draft = TableDesignDraft {
                    is_new_table: true,
                    schema: target_schema.map(ToString::to_string),
                    table_name: src.name.clone(),
                    columns: src
                        .columns
                        .iter()
                        .map(|c| col_meta_to_design(c, source_engine, target_engine, &rules))
                        .collect(),
                    indexes: src.indexes.clone(),
                    foreign_keys: src.foreign_keys.clone(),
                    checks: src.checks.clone(),
                };
                let ddl_blob = generate_table_design_ddl(target_engine, &draft);
                let stmts: Vec<String> = ddl_blob
                    .split(';')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| format!("{};", s))
                    .collect();

                let column_diffs = src
                    .columns
                    .iter()
                    .map(|c| ColumnDiff {
                        name: c.name.clone(),
                        status: SyncDiffStatus::New,
                        source_type: Some(c.data_type.clone()),
                        target_type: None,
                        source_nullable: Some(c.nullable),
                        target_nullable: None,
                        source_default: c.default_value.clone(),
                        target_default: None,
                        details: "New table column".into(),
                    })
                    .collect();

                diffs.push(TableStructureDiff {
                    table_name: src.name.clone(),
                    status: SyncDiffStatus::New,
                    column_diffs,
                    index_diffs: Vec::new(),
                    fk_diffs: Vec::new(),
                    ddl_statements: stmts,
                });
            }
            (None, Some(tgt)) => {
                del_cnt += 1;
                let fq = qualified_table(target_engine, target_schema, &tgt.name);
                let stmts = if include_drops {
                    vec![format!("DROP TABLE IF EXISTS {};", fq)]
                } else {
                    Vec::new()
                };
                diffs.push(TableStructureDiff {
                    table_name: tgt.name.clone(),
                    status: SyncDiffStatus::Deleted,
                    column_diffs: Vec::new(),
                    index_diffs: Vec::new(),
                    fk_diffs: Vec::new(),
                    ddl_statements: stmts,
                });
            }
            (Some(src), Some(tgt)) => {
                let fq = qualified_table(target_engine, target_schema, &src.name);
                let mut col_diffs = Vec::new();
                let mut idx_diffs = Vec::new();
                let mut fk_diffs = Vec::new();
                let mut stmts = Vec::new();

                let src_cols: HashMap<String, &ColumnMeta> = src
                    .columns
                    .iter()
                    .map(|c| (c.name.to_lowercase(), c))
                    .collect();
                let tgt_cols: HashMap<String, &ColumnMeta> = tgt
                    .columns
                    .iter()
                    .map(|c| (c.name.to_lowercase(), c))
                    .collect();

                // Check new & modified columns
                for sc in &src.columns {
                    let k = sc.name.to_lowercase();
                    let col_q = quote_ident(target_engine, &sc.name);
                    let expr_type = column_type_expr(sc, source_engine, target_engine, &rules);
                    match tgt_cols.get(&k) {
                        None => {
                            let null_sql = if sc.nullable { "NULL" } else { "NOT NULL" };
                            let def_sql = sc
                                .default_value
                                .as_deref()
                                .filter(|d| !d.trim().is_empty())
                                .map(|d| format!(" DEFAULT {}", d))
                                .unwrap_or_default();
                            let add_stmt = match target_engine {
                                DbEngine::Mssql => format!(
                                    "ALTER TABLE {} ADD {} {} {}{};",
                                    fq, col_q, expr_type, null_sql, def_sql
                                ),
                                _ => format!(
                                    "ALTER TABLE {} ADD COLUMN {} {} {}{};",
                                    fq, col_q, expr_type, null_sql, def_sql
                                ),
                            };
                            stmts.push(add_stmt);
                            col_diffs.push(ColumnDiff {
                                name: sc.name.clone(),
                                status: SyncDiffStatus::New,
                                source_type: Some(sc.data_type.clone()),
                                target_type: None,
                                source_nullable: Some(sc.nullable),
                                target_nullable: None,
                                source_default: sc.default_value.clone(),
                                target_default: None,
                                details: format!("Add column ({})", expr_type),
                            });
                        }
                        Some(tc) => {
                            let tgt_type_expr =
                                column_type_expr(tc, target_engine, target_engine, &[]);
                            let type_changed =
                                normalize_type(&expr_type) != normalize_type(&tgt_type_expr);
                            let null_changed = sc.nullable != tc.nullable;
                            let def_changed = sc.default_value.as_deref().map(str::trim).filter(|s| !s.is_empty())
                                != tc.default_value.as_deref().map(str::trim).filter(|s| !s.is_empty());

                            if type_changed || null_changed || def_changed {
                                let mut reasons = Vec::new();
                                if type_changed {
                                    reasons.push(format!("type {} -> {}", tgt_type_expr, expr_type));
                                }
                                if null_changed {
                                    reasons.push(format!(
                                        "nullable {} -> {}",
                                        tc.nullable, sc.nullable
                                    ));
                                }
                                if def_changed {
                                    reasons.push("default changed".into());
                                }

                                match target_engine {
                                    DbEngine::Postgres => {
                                        if type_changed {
                                            stmts.push(format!(
                                                "ALTER TABLE {} ALTER COLUMN {} TYPE {};",
                                                fq, col_q, expr_type
                                            ));
                                        }
                                        if null_changed {
                                            let kw = if sc.nullable { "DROP NOT NULL" } else { "SET NOT NULL" };
                                            stmts.push(format!(
                                                "ALTER TABLE {} ALTER COLUMN {} {};",
                                                fq, col_q, kw
                                            ));
                                        }
                                        if def_changed {
                                            if let Some(ref d) = sc.default_value {
                                                stmts.push(format!(
                                                    "ALTER TABLE {} ALTER COLUMN {} SET DEFAULT {};",
                                                    fq, col_q, d
                                                ));
                                            } else {
                                                stmts.push(format!(
                                                    "ALTER TABLE {} ALTER COLUMN {} DROP DEFAULT;",
                                                    fq, col_q
                                                ));
                                            }
                                        }
                                    }
                                    DbEngine::Mysql => {
                                        let null_sql = if sc.nullable { "NULL" } else { "NOT NULL" };
                                        let def_sql = sc
                                            .default_value
                                            .as_deref()
                                            .filter(|d| !d.trim().is_empty())
                                            .map(|d| format!(" DEFAULT {}", d))
                                            .unwrap_or_default();
                                        stmts.push(format!(
                                            "ALTER TABLE {} MODIFY COLUMN {} {} {}{};",
                                            fq, col_q, expr_type, null_sql, def_sql
                                        ));
                                    }
                                    DbEngine::Mssql => {
                                        let null_sql = if sc.nullable { "NULL" } else { "NOT NULL" };
                                        stmts.push(format!(
                                            "ALTER TABLE {} ALTER COLUMN {} {} {};",
                                            fq, col_q, expr_type, null_sql
                                        ));
                                    }
                                    DbEngine::Mongodb => {}
                                }

                                col_diffs.push(ColumnDiff {
                                    name: sc.name.clone(),
                                    status: SyncDiffStatus::Modified,
                                    source_type: Some(expr_type),
                                    target_type: Some(tgt_type_expr),
                                    source_nullable: Some(sc.nullable),
                                    target_nullable: Some(tc.nullable),
                                    source_default: sc.default_value.clone(),
                                    target_default: tc.default_value.clone(),
                                    details: reasons.join(", "),
                                });
                            }
                        }
                    }
                }

                // Check dropped columns
                for tc in &tgt.columns {
                    if !src_cols.contains_key(&tc.name.to_lowercase()) {
                        if include_drops {
                            let col_q = quote_ident(target_engine, &tc.name);
                            stmts.push(format!("ALTER TABLE {} DROP COLUMN {};", fq, col_q));
                        }
                        col_diffs.push(ColumnDiff {
                            name: tc.name.clone(),
                            status: SyncDiffStatus::Deleted,
                            source_type: None,
                            target_type: Some(tc.data_type.clone()),
                            source_nullable: None,
                            target_nullable: Some(tc.nullable),
                            source_default: None,
                            target_default: tc.default_value.clone(),
                            details: "Present only in target".into(),
                        });
                    }
                }

                // Compare non-primary indexes
                let src_idx: HashMap<String, &IndexMeta> = src
                    .indexes
                    .iter()
                    .filter(|i| !i.is_primary)
                    .map(|i| (i.name.to_lowercase(), i))
                    .collect();
                let tgt_idx: HashMap<String, &IndexMeta> = tgt
                    .indexes
                    .iter()
                    .filter(|i| !i.is_primary)
                    .map(|i| (i.name.to_lowercase(), i))
                    .collect();

                for (ik, si) in &src_idx {
                    if !tgt_idx.contains_key(ik) && !si.columns.is_empty() {
                        let cols = si
                            .columns
                            .iter()
                            .map(|c| quote_ident(target_engine, c))
                            .collect::<Vec<_>>()
                            .join(", ");
                        let uniq = if si.is_unique { "UNIQUE " } else { "" };
                        stmts.push(format!(
                            "CREATE {}INDEX {} ON {} ({});",
                            uniq,
                            quote_ident(target_engine, &si.name),
                            fq,
                            cols
                        ));
                        idx_diffs.push(IndexDiff {
                            name: si.name.clone(),
                            status: SyncDiffStatus::New,
                            source_columns: si.columns.clone(),
                            target_columns: Vec::new(),
                            is_unique: si.is_unique,
                            details: "Create missing index".into(),
                        });
                    }
                }
                for (ik, ti) in &tgt_idx {
                    if !src_idx.contains_key(ik) {
                        if include_drops {
                            let drop_idx = match target_engine {
                                DbEngine::Mysql => format!(
                                    "DROP INDEX {} ON {};",
                                    quote_ident(target_engine, &ti.name),
                                    fq
                                ),
                                DbEngine::Mssql => format!(
                                    "DROP INDEX {} ON {};",
                                    quote_ident(target_engine, &ti.name),
                                    fq
                                ),
                                _ => format!(
                                    "DROP INDEX IF EXISTS {};",
                                    quote_ident(target_engine, &ti.name)
                                ),
                            };
                            stmts.push(drop_idx);
                        }
                        idx_diffs.push(IndexDiff {
                            name: ti.name.clone(),
                            status: SyncDiffStatus::Deleted,
                            source_columns: Vec::new(),
                            target_columns: ti.columns.clone(),
                            is_unique: ti.is_unique,
                            details: "Index exists only in target".into(),
                        });
                    }
                }

                // Compare foreign keys
                let src_fks: HashMap<String, &ForeignKeyMeta> = src
                    .foreign_keys
                    .iter()
                    .map(|f| (f.name.to_lowercase(), f))
                    .collect();
                let tgt_fks: HashMap<String, &ForeignKeyMeta> = tgt
                    .foreign_keys
                    .iter()
                    .map(|f| (f.name.to_lowercase(), f))
                    .collect();

                for (fk_k, sf) in &src_fks {
                    if !tgt_fks.contains_key(fk_k) && !sf.columns.is_empty() && !sf.ref_columns.is_empty() {
                        let cols = sf
                            .columns
                            .iter()
                            .map(|c| quote_ident(target_engine, c))
                            .collect::<Vec<_>>()
                            .join(", ");
                        let rcols = sf
                            .ref_columns
                            .iter()
                            .map(|c| quote_ident(target_engine, c))
                            .collect::<Vec<_>>()
                            .join(", ");
                        let ref_fq = qualified_table(
                            target_engine,
                            sf.ref_schema.as_deref().or(target_schema),
                            &sf.ref_table,
                        );
                        let mut clause = format!(
                            "ALTER TABLE {} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({})",
                            fq,
                            quote_ident(target_engine, &sf.name),
                            cols,
                            ref_fq,
                            rcols
                        );
                        if !sf.on_update.trim().is_empty() {
                            clause.push_str(&format!(" ON UPDATE {}", sf.on_update));
                        }
                        if !sf.on_delete.trim().is_empty() {
                            clause.push_str(&format!(" ON DELETE {}", sf.on_delete));
                        }
                        clause.push(';');
                        stmts.push(clause);
                        fk_diffs.push(ForeignKeyDiff {
                            name: sf.name.clone(),
                            status: SyncDiffStatus::New,
                            source_summary: Some(format!(
                                "({}) -> {}({})",
                                sf.columns.join(", "),
                                sf.ref_table,
                                sf.ref_columns.join(", ")
                            )),
                            target_summary: None,
                        });
                    }
                }
                for (fk_k, tf) in &tgt_fks {
                    if !src_fks.contains_key(fk_k) {
                        if include_drops {
                            let drop_fk = match target_engine {
                                DbEngine::Mysql => format!(
                                    "ALTER TABLE {} DROP FOREIGN KEY {};",
                                    fq,
                                    quote_ident(target_engine, &tf.name)
                                ),
                                _ => format!(
                                    "ALTER TABLE {} DROP CONSTRAINT {};",
                                    fq,
                                    quote_ident(target_engine, &tf.name)
                                ),
                            };
                            stmts.push(drop_fk);
                        }
                        fk_diffs.push(ForeignKeyDiff {
                            name: tf.name.clone(),
                            status: SyncDiffStatus::Deleted,
                            source_summary: None,
                            target_summary: Some(format!(
                                "({}) -> {}({})",
                                tf.columns.join(", "),
                                tf.ref_table,
                                tf.ref_columns.join(", ")
                            )),
                        });
                    }
                }

                let is_modified = !col_diffs.is_empty() || !idx_diffs.is_empty() || !fk_diffs.is_empty();
                if is_modified {
                    mod_cnt += 1;
                }
                diffs.push(TableStructureDiff {
                    table_name: src.name.clone(),
                    status: if is_modified {
                        SyncDiffStatus::Modified
                    } else {
                        SyncDiffStatus::Unchanged
                    },
                    column_diffs: col_diffs,
                    index_diffs: idx_diffs,
                    fk_diffs,
                    ddl_statements: stmts,
                });
            }
            (None, None) => {}
        }
    }

    let full_script = diffs
        .iter()
        .flat_map(|d| d.ddl_statements.iter())
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");

    StructureSyncPlan {
        source_engine,
        target_engine,
        summary: format!(
            "{} new, {} modified, {} target-only ({} total tables compared)",
            new_cnt,
            mod_cnt,
            del_cnt,
            diffs.len()
        ),
        tables: diffs,
        full_script,
    }
}

/// Fetches full table metadata for source & target connections and computes a StructureSyncPlan.
pub async fn compute_structure_sync(
    src_driver: Arc<dyn SqlDriver>,
    src_engine: DbEngine,
    tgt_driver: Arc<dyn SqlDriver>,
    tgt_engine: DbEngine,
    req: &StructureSyncRequest,
) -> Result<StructureSyncPlan> {
    let src_objs = src_driver
        .list_objects(req.source_database.as_deref(), req.source_schema.as_deref())
        .await?;
    let tgt_objs = tgt_driver
        .list_objects(req.target_database.as_deref(), req.target_schema.as_deref())
        .await?;

    let mut src_metas = Vec::new();
    for obj in src_objs.into_iter().filter(|o| o.kind == ObjectKind::Table) {
        if let Ok(meta) = src_driver
            .get_table_metadata(
                req.source_database.as_deref(),
                req.source_schema.as_deref(),
                &obj.name,
            )
            .await
        {
            src_metas.push(meta);
        }
    }

    let mut tgt_metas = Vec::new();
    for obj in tgt_objs.into_iter().filter(|o| o.kind == ObjectKind::Table) {
        if let Ok(meta) = tgt_driver
            .get_table_metadata(
                req.target_database.as_deref(),
                req.target_schema.as_deref(),
                &obj.name,
            )
            .await
        {
            tgt_metas.push(meta);
        }
    }

    Ok(diff_table_metadata(
        src_engine,
        tgt_engine,
        req.target_schema.as_deref(),
        &src_metas,
        &tgt_metas,
        req.include_drops,
    ))
}

/// Executes a list of sync DDL/DML statements against the target driver.
pub async fn execute_sync_statements(
    driver: Arc<dyn SqlDriver>,
    database: Option<&str>,
    statements: &[String],
    stop_on_error: bool,
) -> Result<SyncExecutionResult> {
    let start = Instant::now();
    let mut executed = 0u64;
    let mut failed = 0u64;
    let mut errors = Vec::new();

    for stmt in statements {
        let trimmed = stmt.trim();
        if trimmed.is_empty() || trimmed.starts_with("--") {
            continue;
        }
        match driver.execute_ddl(database, trimmed).await {
            Ok(_) => executed += 1,
            Err(err) => {
                failed += 1;
                errors.push(format!("{}: {}", trimmed.chars().take(80).collect::<String>(), err));
                if stop_on_error {
                    break;
                }
            }
        }
    }

    Ok(SyncExecutionResult {
        ok: failed == 0,
        statements_executed: executed,
        statements_failed: failed,
        duration_ms: start.elapsed().as_millis() as u64,
        summary: if failed == 0 {
            format!("Executed {} statement(s) successfully", executed)
        } else {
            format!("Executed {} statement(s) with {} error(s)", executed, failed)
        },
        errors,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_col(name: &str, dt: &str, nullable: bool, pk: bool) -> ColumnMeta {
        ColumnMeta {
            name: name.into(),
            data_type: dt.into(),
            udt_name: None,
            max_length: None,
            numeric_precision: None,
            numeric_scale: None,
            nullable,
            default_value: None,
            is_primary_key: pk,
            is_auto_increment: pk,
            comment: None,
        }
    }

    #[test]
    fn detects_new_modified_and_deleted_tables_and_columns() {
        let src = vec![
            TableMetadata {
                schema: Some("public".into()),
                name: "users".into(),
                columns: vec![
                    sample_col("id", "bigint", false, true),
                    sample_col("email", "varchar(255)", false, false),
                    sample_col("bio", "text", true, false),
                ],
                indexes: vec![],
                foreign_keys: vec![],
                checks: vec![],
                row_estimate: None,
                ddl: None,
            },
            TableMetadata {
                schema: Some("public".into()),
                name: "orders".into(),
                columns: vec![sample_col("id", "bigint", false, true)],
                indexes: vec![],
                foreign_keys: vec![],
                checks: vec![],
                row_estimate: None,
                ddl: None,
            },
        ];

        let tgt = vec![
            TableMetadata {
                schema: Some("public".into()),
                name: "users".into(),
                columns: vec![
                    sample_col("id", "bigint", false, true),
                    sample_col("email", "varchar(100)", true, false),
                    sample_col("legacy", "text", true, false),
                ],
                indexes: vec![],
                foreign_keys: vec![],
                checks: vec![],
                row_estimate: None,
                ddl: None,
            },
            TableMetadata {
                schema: Some("public".into()),
                name: "old_logs".into(),
                columns: vec![sample_col("id", "int", false, true)],
                indexes: vec![],
                foreign_keys: vec![],
                checks: vec![],
                row_estimate: None,
                ddl: None,
            },
        ];

        let plan = diff_table_metadata(
            DbEngine::Postgres,
            DbEngine::Postgres,
            Some("public"),
            &src,
            &tgt,
            true,
        );

        assert_eq!(plan.tables.len(), 3);
        let users = plan.tables.iter().find(|t| t.table_name == "users").unwrap();
        assert_eq!(users.status, SyncDiffStatus::Modified);
        assert!(users.ddl_statements.iter().any(|s| s.contains("ADD COLUMN \"bio\"")));
        assert!(users.ddl_statements.iter().any(|s| s.contains("DROP COLUMN \"legacy\"")));

        let orders = plan.tables.iter().find(|t| t.table_name == "orders").unwrap();
        assert_eq!(orders.status, SyncDiffStatus::New);
        assert!(orders.ddl_statements.iter().any(|s| s.contains("CREATE TABLE")));

        let old_logs = plan.tables.iter().find(|t| t.table_name == "old_logs").unwrap();
        assert_eq!(old_logs.status, SyncDiffStatus::Deleted);
        assert!(old_logs.ddl_statements.iter().any(|s| s.contains("DROP TABLE")));
    }

    #[test]
    fn identical_varchar_with_max_length_is_unchanged() {
        let mut col_src = sample_col("version_num", "varchar", false, false);
        col_src.max_length = Some(32);
        let mut col_tgt = sample_col("version_num", "varchar", false, false);
        col_tgt.max_length = Some(32);

        let mut dec_src = sample_col("amount", "decimal", false, false);
        dec_src.numeric_precision = Some(10);
        dec_src.numeric_scale = Some(2);
        let mut dec_tgt = sample_col("amount", "decimal", false, false);
        dec_tgt.numeric_precision = Some(10);
        dec_tgt.numeric_scale = Some(2);

        let make_table = |cols| {
            vec![TableMetadata {
                schema: Some("public".into()),
                name: "alembic_version".into(),
                columns: cols,
                indexes: vec![],
                foreign_keys: vec![],
                checks: vec![],
                row_estimate: None,
                ddl: None,
            }]
        };

        let plan = diff_table_metadata(
            DbEngine::Mysql,
            DbEngine::Mysql,
            None,
            &make_table(vec![col_src, dec_src]),
            &make_table(vec![col_tgt, dec_tgt]),
            false,
        );

        assert_eq!(plan.tables.len(), 1);
        assert_eq!(plan.tables[0].status, SyncDiffStatus::Unchanged);
        assert!(plan.tables[0].column_diffs.is_empty());
        assert!(plan.tables[0].ddl_statements.is_empty());
    }

    #[test]
    fn detects_varchar_length_change() {
        let mut col_src = sample_col("name", "varchar", false, false);
        col_src.max_length = Some(255);
        let mut col_tgt = sample_col("name", "varchar", false, false);
        col_tgt.max_length = Some(50);

        let make_table = |col| {
            vec![TableMetadata {
                schema: None,
                name: "migrations".into(),
                columns: vec![col],
                indexes: vec![],
                foreign_keys: vec![],
                checks: vec![],
                row_estimate: None,
                ddl: None,
            }]
        };

        let plan = diff_table_metadata(
            DbEngine::Mysql,
            DbEngine::Mysql,
            None,
            &make_table(col_src),
            &make_table(col_tgt),
            false,
        );

        assert_eq!(plan.tables[0].status, SyncDiffStatus::Modified);
        assert_eq!(plan.tables[0].column_diffs.len(), 1);
        assert_eq!(plan.tables[0].column_diffs[0].details, "type varchar(50) -> varchar(255)");
    }
}
