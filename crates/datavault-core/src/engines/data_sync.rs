use crate::drivers::{qualified_table, quote_ident, sql_literal, SqlDriver};
use crate::error::Result;
use crate::models::*;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

/// Computes a deterministic hash for a row map given an ordered list of column names.
fn hash_row(columns: &[String], row: &HashMap<String, serde_json::Value>) -> u64 {
    let mut hasher = DefaultHasher::new();
    for col in columns {
        col.hash(&mut hasher);
        let val = row.get(col).unwrap_or(&serde_json::Value::Null);
        val.to_string().hash(&mut hasher);
    }
    hasher.finish()
}

fn composite_key(key_cols: &[String], row: &HashMap<String, serde_json::Value>) -> String {
    key_cols
        .iter()
        .map(|k| {
            row.get(k)
                .map(|v| v.to_string())
                .unwrap_or_else(|| "null".into())
        })
        .collect::<Vec<_>>()
        .join("\u{1f}")
}

fn build_where_pk(
    engine: DbEngine,
    key_cols: &[String],
    key_vals: &HashMap<String, serde_json::Value>,
) -> String {
    key_cols
        .iter()
        .map(|k| {
            let v = key_vals.get(k).unwrap_or(&serde_json::Value::Null);
            if v.is_null() {
                format!("{} IS NULL", quote_ident(engine, k))
            } else {
                format!("{} = {}", quote_ident(engine, k), sql_literal(v))
            }
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

/// Pure row-diff algorithm using key-indexed row hashing.
#[allow(clippy::too_many_arguments)]
pub fn diff_table_rows(
    target_engine: DbEngine,
    target_schema: Option<&str>,
    source_table: &str,
    target_table: &str,
    columns: &[String],
    key_columns: &[String],
    source_rows: &[HashMap<String, serde_json::Value>],
    target_rows: &[HashMap<String, serde_json::Value>],
    include_deletes: bool,
    max_samples: usize,
) -> TableDataDiff {
    let fq = qualified_table(target_engine, target_schema, target_table);

    let mut tgt_index: HashMap<String, (u64, &HashMap<String, serde_json::Value>)> =
        HashMap::with_capacity(target_rows.len());
    for row in target_rows {
        let k = composite_key(key_columns, row);
        let h = hash_row(columns, row);
        tgt_index.insert(k, (h, row));
    }

    let mut seen_keys = std::collections::HashSet::with_capacity(source_rows.len());
    let mut inserts = 0u64;
    let mut updates = 0u64;
    let mut deletes = 0u64;
    let mut unchanged = 0u64;
    let mut sample_diffs = Vec::new();
    let mut statements = Vec::new();

    for srow in source_rows {
        let k = composite_key(key_columns, srow);
        seen_keys.insert(k.clone());
        let sh = hash_row(columns, srow);
        let key_values: HashMap<String, serde_json::Value> = key_columns
            .iter()
            .map(|kc| (kc.clone(), srow.get(kc).cloned().unwrap_or(serde_json::Value::Null)))
            .collect();

        match tgt_index.get(&k) {
            None => {
                inserts += 1;
                let col_list = columns
                    .iter()
                    .map(|c| quote_ident(target_engine, c))
                    .collect::<Vec<_>>()
                    .join(", ");
                let val_list = columns
                    .iter()
                    .map(|c| sql_literal(srow.get(c).unwrap_or(&serde_json::Value::Null)))
                    .collect::<Vec<_>>()
                    .join(", ");
                let sql = format!("INSERT INTO {} ({}) VALUES ({});", fq, col_list, val_list);
                statements.push(sql.clone());
                if sample_diffs.len() < max_samples {
                    sample_diffs.push(RowDiffEntry {
                        kind: RowDiffKind::Insert,
                        key_values,
                        source_row: Some(srow.clone()),
                        target_row: None,
                        changed_columns: columns.to_vec(),
                        sql,
                    });
                }
            }
            Some((th, trow)) => {
                if *th == sh {
                    unchanged += 1;
                } else {
                    let changed: Vec<String> = columns
                        .iter()
                        .filter(|c| {
                            !key_columns.contains(*c)
                                && srow.get(*c).unwrap_or(&serde_json::Value::Null)
                                    != trow.get(*c).unwrap_or(&serde_json::Value::Null)
                        })
                        .cloned()
                        .collect();

                    if changed.is_empty() {
                        unchanged += 1;
                    } else {
                        updates += 1;
                        let set_clause = changed
                            .iter()
                            .map(|c| {
                                format!(
                                    "{} = {}",
                                    quote_ident(target_engine, c),
                                    sql_literal(srow.get(c).unwrap_or(&serde_json::Value::Null))
                                )
                            })
                            .collect::<Vec<_>>()
                            .join(", ");
                        let where_clause = build_where_pk(target_engine, key_columns, &key_values);
                        let sql = format!("UPDATE {} SET {} WHERE {};", fq, set_clause, where_clause);
                        statements.push(sql.clone());
                        if sample_diffs.len() < max_samples {
                            sample_diffs.push(RowDiffEntry {
                                kind: RowDiffKind::Update,
                                key_values,
                                source_row: Some(srow.clone()),
                                target_row: Some((*trow).clone()),
                                changed_columns: changed,
                                sql,
                            });
                        }
                    }
                }
            }
        }
    }

    if include_deletes {
        for trow in target_rows {
            let k = composite_key(key_columns, trow);
            if !seen_keys.contains(&k) {
                deletes += 1;
                let key_values: HashMap<String, serde_json::Value> = key_columns
                    .iter()
                    .map(|kc| (kc.clone(), trow.get(kc).cloned().unwrap_or(serde_json::Value::Null)))
                    .collect();
                let where_clause = build_where_pk(target_engine, key_columns, &key_values);
                let sql = format!("DELETE FROM {} WHERE {};", fq, where_clause);
                statements.push(sql.clone());
                if sample_diffs.len() < max_samples {
                    sample_diffs.push(RowDiffEntry {
                        kind: RowDiffKind::Delete,
                        key_values,
                        source_row: None,
                        target_row: Some(trow.clone()),
                        changed_columns: Vec::new(),
                        sql,
                    });
                }
            }
        }
    }

    TableDataDiff {
        source_table: source_table.to_string(),
        target_table: target_table.to_string(),
        key_columns: key_columns.to_vec(),
        inserts,
        updates,
        deletes,
        unchanged,
        sample_diffs,
        statements,
        error: None,
    }
}

async fn fetch_all_rows_as_maps(
    driver: Arc<dyn SqlDriver>,
    connection_id: &str,
    database: Option<String>,
    schema: Option<String>,
    table: &str,
) -> Result<(Vec<String>, Vec<String>, Vec<HashMap<String, serde_json::Value>>)> {
    let mut page = 1u64;
    let page_size = 1000u64;
    let mut columns = Vec::new();
    let mut pk_columns = Vec::new();
    let mut rows_out = Vec::new();

    loop {
        let rs = driver
            .fetch_table_data(&TableDataRequest {
                connection_id: connection_id.to_string(),
                database: database.clone(),
                schema: schema.clone(),
                table: table.to_string(),
                page,
                page_size,
                filters: Vec::new(),
                sorts: Vec::new(),
            })
            .await?;

        if columns.is_empty() {
            columns = rs.columns.iter().map(|c| c.name.clone()).collect();
            pk_columns = rs
                .columns
                .iter()
                .filter(|c| c.is_primary_key)
                .map(|c| c.name.clone())
                .collect();
        }

        let batch_len = rs.rows.len() as u64;
        for r in rs.rows {
            let mut map = HashMap::with_capacity(columns.len());
            for (idx, col) in columns.iter().enumerate() {
                map.insert(
                    col.clone(),
                    r.get(idx).cloned().unwrap_or(serde_json::Value::Null),
                );
            }
            rows_out.push(map);
        }

        if batch_len < page_size {
            break;
        }
        page += 1;
    }

    Ok((columns, pk_columns, rows_out))
}

/// Computes a full DataSyncPlan across selected tables between source and target connections.
pub async fn compute_data_sync(
    src_driver: Arc<dyn SqlDriver>,
    tgt_driver: Arc<dyn SqlDriver>,
    tgt_engine: DbEngine,
    req: &DataSyncRequest,
) -> Result<DataSyncPlan> {
    let max_samples = req.max_diff_rows_per_table.unwrap_or(100).clamp(10, 1000);
    let mut table_diffs = Vec::new();
    let mut total_inserts = 0u64;
    let mut total_updates = 0u64;
    let mut total_deletes = 0u64;

    for spec in &req.tables {
        let tgt_table = if spec.target_table.trim().is_empty() {
            spec.source_table.clone()
        } else {
            spec.target_table.clone()
        };

        let src_res = fetch_all_rows_as_maps(
            src_driver.clone(),
            &req.source_connection_id,
            req.source_database.clone(),
            req.source_schema.clone(),
            &spec.source_table,
        )
        .await;

        let tgt_res = fetch_all_rows_as_maps(
            tgt_driver.clone(),
            &req.target_connection_id,
            req.target_database.clone(),
            req.target_schema.clone(),
            &tgt_table,
        )
        .await;

        match (src_res, tgt_res) {
            (Ok((src_cols, src_pks, src_rows)), Ok((tgt_cols, _, tgt_rows))) => {
                let common_cols: Vec<String> = src_cols
                    .iter()
                    .filter(|c| tgt_cols.iter().any(|tc| tc.eq_ignore_ascii_case(c)))
                    .cloned()
                    .collect();

                let key_cols = if !spec.key_columns.is_empty() {
                    spec.key_columns.clone()
                } else if !src_pks.is_empty() {
                    src_pks
                } else if let Some(first) = common_cols.first() {
                    vec![first.clone()]
                } else {
                    Vec::new()
                };

                if key_cols.is_empty() {
                    table_diffs.push(TableDataDiff {
                        source_table: spec.source_table.clone(),
                        target_table: tgt_table,
                        key_columns: Vec::new(),
                        inserts: 0,
                        updates: 0,
                        deletes: 0,
                        unchanged: 0,
                        sample_diffs: Vec::new(),
                        statements: Vec::new(),
                        error: Some("No common columns or key columns found".into()),
                    });
                    continue;
                }

                let diff = diff_table_rows(
                    tgt_engine,
                    req.target_schema.as_deref(),
                    &spec.source_table,
                    &tgt_table,
                    &common_cols,
                    &key_cols,
                    &src_rows,
                    &tgt_rows,
                    req.include_deletes,
                    max_samples,
                );
                total_inserts += diff.inserts;
                total_updates += diff.updates;
                total_deletes += diff.deletes;
                table_diffs.push(diff);
            }
            (Err(e), _) | (_, Err(e)) => {
                table_diffs.push(TableDataDiff {
                    source_table: spec.source_table.clone(),
                    target_table: tgt_table,
                    key_columns: spec.key_columns.clone(),
                    inserts: 0,
                    updates: 0,
                    deletes: 0,
                    unchanged: 0,
                    sample_diffs: Vec::new(),
                    statements: Vec::new(),
                    error: Some(e.to_string()),
                });
            }
        }
    }

    let full_script = table_diffs
        .iter()
        .flat_map(|t| t.statements.iter())
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");

    Ok(DataSyncPlan {
        summary: format!(
            "{} insert(s), {} update(s), {} delete(s) across {} table(s)",
            total_inserts,
            total_updates,
            total_deletes,
            table_diffs.len()
        ),
        tables: table_diffs,
        total_inserts,
        total_updates,
        total_deletes,
        full_script,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(pairs: &[(&str, serde_json::Value)]) -> HashMap<String, serde_json::Value> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), v.clone()))
            .collect()
    }

    #[test]
    fn computes_inserts_updates_deletes_and_unchanged() {
        let cols = vec!["id".into(), "name".into(), "role".into()];
        let keys = vec!["id".into()];
        let src = vec![
            row(&[("id", json!(1)), ("name", json!("Alice")), ("role", json!("admin"))]),
            row(&[("id", json!(2)), ("name", json!("Bob Updated")), ("role", json!("user"))]),
            row(&[("id", json!(3)), ("name", json!("Charlie")), ("role", json!("user"))]),
        ];
        let tgt = vec![
            row(&[("id", json!(1)), ("name", json!("Alice")), ("role", json!("admin"))]),
            row(&[("id", json!(2)), ("name", json!("Bob")), ("role", json!("user"))]),
            row(&[("id", json!(4)), ("name", json!("Old User")), ("role", json!("guest"))]),
        ];

        let diff = diff_table_rows(
            DbEngine::Postgres,
            Some("public"),
            "users",
            "users",
            &cols,
            &keys,
            &src,
            &tgt,
            true,
            50,
        );

        assert_eq!(diff.unchanged, 1);
        assert_eq!(diff.inserts, 1);
        assert_eq!(diff.updates, 1);
        assert_eq!(diff.deletes, 1);
        assert_eq!(diff.statements.len(), 3);
        assert!(diff.statements[0].starts_with("UPDATE"));
        assert!(diff.statements[1].starts_with("INSERT"));
        assert!(diff.statements[2].starts_with("DELETE"));
    }
}
