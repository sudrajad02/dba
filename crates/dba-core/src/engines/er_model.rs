use crate::drivers::{generate_table_design_ddl, qualified_table, quote_ident, SqlDriver};
use crate::engines::structure_sync::diff_table_metadata;
use crate::error::Result;
use crate::models::*;
use chrono::Utc;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use uuid::Uuid;

const CARD_W: f64 = 280.0;
const GAP_X: f64 = 90.0;
const GAP_Y: f64 = 70.0;

/// Layered topological auto-layout for ER Diagram nodes so referenced tables appear left/top
/// and referencing child tables flow cleanly to the right without overlapping.
pub fn auto_layout_er_model(model: &mut ErModel) {
    if model.tables.is_empty() {
        return;
    }

    let id_to_idx: HashMap<String, usize> = model
        .tables
        .iter()
        .enumerate()
        .map(|(i, t)| (t.id.clone(), i))
        .collect();

    // Compute in-degree (how many parent tables each table references)
    let mut deps: Vec<HashSet<usize>> = vec![HashSet::new(); model.tables.len()];
    for rel in &model.relationships {
        if let (Some(&src), Some(&tgt)) = (
            id_to_idx.get(&rel.source_table_id),
            id_to_idx.get(&rel.target_table_id),
        ) {
            if src != tgt {
                deps[src].insert(tgt);
            }
        }
    }

    // Assign layers iteratively (break cycles gracefully)
    let mut layer: Vec<usize> = vec![0; model.tables.len()];
    for _ in 0..model.tables.len() {
        let mut changed = false;
        for i in 0..model.tables.len() {
            let max_parent = deps[i].iter().map(|&p| layer[p] + 1).max().unwrap_or(0);
            if max_parent > layer[i] && max_parent <= model.tables.len() {
                layer[i] = max_parent;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }

    // Group tables by layer; if everything is in layer 0 (no FKs), wrap into a neat grid
    let max_layer = layer.iter().copied().max().unwrap_or(0);
    if max_layer == 0 {
        let cols = (model.tables.len() as f64).sqrt().ceil().max(1.0) as usize;
        let mut col_y = vec![40.0f64; cols];
        for (idx, tbl) in model.tables.iter_mut().enumerate() {
            let c = idx % cols;
            tbl.x = 40.0 + (c as f64) * (CARD_W + GAP_X);
            tbl.y = col_y[c];
            let est_h = 64.0 + (tbl.columns.len().max(2) as f64) * 24.0;
            col_y[c] += est_h + GAP_Y;
        }
        return;
    }

    let mut by_layer: HashMap<usize, Vec<usize>> = HashMap::new();
    for (idx, &l) in layer.iter().enumerate() {
        by_layer.entry(l).or_default().push(idx);
    }

    for l in 0..=max_layer {
        if let Some(indices) = by_layer.get(&l) {
            let mut y = 40.0f64;
            for &idx in indices {
                let tbl = &mut model.tables[idx];
                tbl.x = 40.0 + (l as f64) * (CARD_W + GAP_X);
                tbl.y = y;
                let est_h = 64.0 + (tbl.columns.len().max(2) as f64) * 24.0;
                y += est_h + GAP_Y;
            }
        }
    }
}

/// Pulls all tables and foreign keys from a live SQL database/schema into an interactive ErModel.
pub async fn reverse_engineer_schema(
    driver: Arc<dyn SqlDriver>,
    engine: DbEngine,
    req: &ReverseEngineerRequest,
) -> Result<ErModel> {
    let objs = driver
        .list_objects(req.database.as_deref(), req.schema.as_deref())
        .await?;

    let mut metas = Vec::new();
    for obj in objs.into_iter().filter(|o| o.kind == ObjectKind::Table) {
        if let Ok(meta) = driver
            .get_table_metadata(req.database.as_deref(), req.schema.as_deref(), &obj.name)
            .await
        {
            metas.push(meta);
        }
    }

    let mut table_name_to_id: HashMap<String, String> = HashMap::new();
    let mut tables = Vec::new();
    let palette = ["#3b82f6", "#10b981", "#8b5cf6", "#f59e0b", "#06b6d4", "#ec4899"];

    for (idx, meta) in metas.iter().enumerate() {
        let id = Uuid::new_v4().to_string();
        table_name_to_id.insert(meta.name.to_lowercase(), id.clone());
        let cols = meta
            .columns
            .iter()
            .map(|c| TableDesignColumn {
                name: c.name.clone(),
                original_name: Some(c.name.clone()),
                data_type: c.data_type.clone(),
                length: c.max_length.map(|l| l.to_string()),
                nullable: c.nullable,
                default_value: c.default_value.clone(),
                is_primary_key: c.is_primary_key,
                is_auto_increment: c.is_auto_increment,
                comment: c.comment.clone(),
            })
            .collect();

        tables.push(ErTableNode {
            id,
            name: meta.name.clone(),
            schema: meta.schema.clone().or_else(|| req.schema.clone()),
            x: 40.0,
            y: 40.0,
            color: Some(palette[idx % palette.len()].to_string()),
            group: None,
            columns: cols,
            indexes: meta.indexes.clone(),
        });
    }

    let mut relationships = Vec::new();
    for meta in &metas {
        if let Some(src_id) = table_name_to_id.get(&meta.name.to_lowercase()) {
            for fk in &meta.foreign_keys {
                if let Some(tgt_id) = table_name_to_id.get(&fk.ref_table.to_lowercase()) {
                    let src_col = fk.columns.first().cloned().unwrap_or_default();
                    let tgt_col = fk.ref_columns.first().cloned().unwrap_or_default();
                    let is_src_pk_only = meta
                        .columns
                        .iter()
                        .any(|c| c.name == src_col && c.is_primary_key);
                    relationships.push(ErRelationship {
                        id: Uuid::new_v4().to_string(),
                        name: fk.name.clone(),
                        source_table_id: src_id.clone(),
                        source_column: src_col,
                        target_table_id: tgt_id.clone(),
                        target_column: tgt_col,
                        cardinality: if is_src_pk_only {
                            ErCardinality::OneToOne
                        } else {
                            ErCardinality::OneToMany
                        },
                        on_update: fk.on_update.clone(),
                        on_delete: fk.on_delete.clone(),
                    });
                }
            }
        }
    }

    let default_name = req
        .model_name
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            format!(
                "{}{}",
                req.database.as_deref().unwrap_or("schema"),
                req.schema
                    .as_deref()
                    .map(|s| format!(".{}", s))
                    .unwrap_or_default()
            )
        });

    let mut model = ErModel {
        id: Uuid::new_v4().to_string(),
        name: default_name,
        engine,
        database: req.database.clone(),
        schema: req.schema.clone(),
        tables,
        relationships,
        updated_at: Utc::now().to_rfc3339(),
    };
    auto_layout_er_model(&mut model);
    Ok(model)
}

/// Forward-engineers an ErModel into executable CREATE TABLE / INDEX / FOREIGN KEY SQL statements.
pub fn forward_engineer_model(req: &ForwardEngineerRequest) -> ForwardEngineerResult {
    let engine = req.target_engine;
    let id_to_table: HashMap<&str, &ErTableNode> = req
        .model
        .tables
        .iter()
        .map(|t| (t.id.as_str(), t))
        .collect();

    let mut statements = Vec::new();

    if req.include_drops {
        for tbl in req.model.tables.iter().rev() {
            let fq = qualified_table(engine, tbl.schema.as_deref().or(req.model.schema.as_deref()), &tbl.name);
            statements.push(format!("DROP TABLE IF EXISTS {};", fq));
        }
    }

    for tbl in &req.model.tables {
        let draft = TableDesignDraft {
            is_new_table: true,
            schema: tbl.schema.clone().or_else(|| req.model.schema.clone()),
            table_name: tbl.name.clone(),
            columns: tbl.columns.clone(),
            indexes: tbl.indexes.clone(),
            foreign_keys: Vec::new(),
            checks: Vec::new(),
        };
        let ddl_blob = generate_table_design_ddl(engine, &draft);
        for s in ddl_blob.split(';').map(str::trim).filter(|s| !s.is_empty()) {
            statements.push(format!("{};", s));
        }
    }

    // Add Foreign Key constraints after all tables exist (handles circular or out-of-order refs)
    for rel in &req.model.relationships {
        if let (Some(src), Some(tgt)) = (
            id_to_table.get(rel.source_table_id.as_str()),
            id_to_table.get(rel.target_table_id.as_str()),
        ) {
            if rel.source_column.trim().is_empty() || rel.target_column.trim().is_empty() {
                continue;
            }
            let src_fq = qualified_table(engine, src.schema.as_deref().or(req.model.schema.as_deref()), &src.name);
            let tgt_fq = qualified_table(engine, tgt.schema.as_deref().or(req.model.schema.as_deref()), &tgt.name);
            let fk_name = if rel.name.trim().is_empty() {
                format!("fk_{}_{}", src.name, rel.source_column)
            } else {
                rel.name.clone()
            };
            let mut stmt = format!(
                "ALTER TABLE {} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({})",
                src_fq,
                quote_ident(engine, &fk_name),
                quote_ident(engine, &rel.source_column),
                tgt_fq,
                quote_ident(engine, &rel.target_column),
            );
            if !rel.on_update.trim().is_empty() {
                stmt.push_str(&format!(" ON UPDATE {}", rel.on_update));
            }
            if !rel.on_delete.trim().is_empty() {
                stmt.push_str(&format!(" ON DELETE {}", rel.on_delete));
            }
            stmt.push(';');
            statements.push(stmt);
        }
    }

    let ddl = statements.join("\n\n");
    ForwardEngineerResult { ddl, statements }
}

/// Converts an ErModel into TableMetadata entries and diffs it against a live target database.
pub async fn diff_er_model_to_db(
    tgt_driver: Arc<dyn SqlDriver>,
    tgt_engine: DbEngine,
    req: &ErModelSyncRequest,
) -> Result<StructureSyncPlan> {
    let id_to_table: HashMap<&str, &ErTableNode> = req
        .model
        .tables
        .iter()
        .map(|t| (t.id.as_str(), t))
        .collect();

    let src_metas: Vec<TableMetadata> = req
        .model
        .tables
        .iter()
        .map(|t| {
            let fks: Vec<ForeignKeyMeta> = req
                .model
                .relationships
                .iter()
                .filter(|r| r.source_table_id == t.id)
                .filter_map(|r| {
                    let tgt = id_to_table.get(r.target_table_id.as_str())?;
                    Some(ForeignKeyMeta {
                        name: if r.name.trim().is_empty() {
                            format!("fk_{}_{}", t.name, r.source_column)
                        } else {
                            r.name.clone()
                        },
                        columns: vec![r.source_column.clone()],
                        ref_schema: tgt.schema.clone().or_else(|| req.target_schema.clone()),
                        ref_table: tgt.name.clone(),
                        ref_columns: vec![r.target_column.clone()],
                        on_update: r.on_update.clone(),
                        on_delete: r.on_delete.clone(),
                    })
                })
                .collect();

            TableMetadata {
                schema: t.schema.clone().or_else(|| req.model.schema.clone()),
                name: t.name.clone(),
                columns: t
                    .columns
                    .iter()
                    .map(|c| ColumnMeta {
                        name: c.name.clone(),
                        data_type: c.data_type.clone(),
                        udt_name: None,
                        max_length: c.length.as_deref().and_then(|l| l.parse::<i64>().ok()),
                        numeric_precision: None,
                        numeric_scale: None,
                        nullable: c.nullable,
                        default_value: c.default_value.clone(),
                        is_primary_key: c.is_primary_key,
                        is_auto_increment: c.is_auto_increment,
                        comment: c.comment.clone(),
                    })
                    .collect(),
                indexes: t.indexes.clone(),
                foreign_keys: fks,
                checks: Vec::new(),
                row_estimate: None,
                ddl: None,
            }
        })
        .collect();

    let tgt_objs = tgt_driver
        .list_objects(req.target_database.as_deref(), req.target_schema.as_deref())
        .await?;
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
        req.model.engine,
        tgt_engine,
        req.target_schema.as_deref(),
        &src_metas,
        &tgt_metas,
        req.include_drops,
    ))
}

/// Generates clean dialect-aware SQL from a VisualQuerySpec (Visual Query Builder).
pub fn generate_visual_query_sql(spec: &VisualQuerySpec) -> String {
    if spec.tables.is_empty() {
        return "-- Add at least one table to the Visual Query Builder canvas\n".into();
    }

    let engine = spec.engine;
    let alias_for = |table_id: &str| -> String {
        spec.tables
            .iter()
            .find(|t| t.id == table_id)
            .map(|t| {
                if !t.alias.trim().is_empty() {
                    quote_ident(engine, t.alias.trim())
                } else {
                    quote_ident(engine, &t.table)
                }
            })
            .unwrap_or_else(|| quote_ident(engine, table_id))
    };

    let selected_cols: Vec<String> = spec
        .columns
        .iter()
        .filter(|c| c.selected)
        .map(|c| {
            let expr_base = format!("{}.{}", alias_for(&c.table_id), quote_ident(engine, &c.column));
            let expr = match c.aggregate.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(agg) => format!("{}({})", agg.to_uppercase(), expr_base),
                None => expr_base,
            };
            match c.alias.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(a) => format!("{} AS {}", expr, quote_ident(engine, a)),
                None => expr,
            }
        })
        .collect();

    let select_body = if selected_cols.is_empty() {
        "*".to_string()
    } else {
        selected_cols.join(",\n  ")
    };

    let mut sql = String::new();
    sql.push_str("SELECT");
    if spec.distinct {
        sql.push_str(" DISTINCT");
    }
    if engine == DbEngine::Mssql {
        if let Some(lim) = spec.limit {
            sql.push_str(&format!(" TOP {}", lim));
        }
    }
    sql.push_str("\n  ");
    sql.push_str(&select_body);

    // FROM first table
    let first = &spec.tables[0];
    let first_fq = qualified_table(engine, first.schema.as_deref(), &first.table);
    sql.push_str(&format!("\nFROM {}", first_fq));
    if !first.alias.trim().is_empty() && first.alias.trim() != first.table {
        sql.push_str(&format!(" AS {}", quote_ident(engine, first.alias.trim())));
    }

    // Track tables already included in FROM/JOIN
    let mut joined: HashSet<&str> = HashSet::new();
    joined.insert(first.id.as_str());

    for j in &spec.joins {
        let kw = match j.join_type {
            QbJoinType::Inner => "INNER JOIN",
            QbJoinType::Left => "LEFT JOIN",
            QbJoinType::Right => "RIGHT JOIN",
            QbJoinType::Full => "FULL OUTER JOIN",
        };
        let target_id = if joined.contains(j.left_table_id.as_str()) {
            j.right_table_id.as_str()
        } else {
            j.left_table_id.as_str()
        };
        if let Some(tbl) = spec.tables.iter().find(|t| t.id == target_id) {
            let fq = qualified_table(engine, tbl.schema.as_deref(), &tbl.table);
            sql.push_str(&format!("\n{} {}", kw, fq));
            if !tbl.alias.trim().is_empty() && tbl.alias.trim() != tbl.table {
                sql.push_str(&format!(" AS {}", quote_ident(engine, tbl.alias.trim())));
            }
            sql.push_str(&format!(
                " ON {}.{} = {}.{}",
                alias_for(&j.left_table_id),
                quote_ident(engine, &j.left_column),
                alias_for(&j.right_table_id),
                quote_ident(engine, &j.right_column),
            ));
            joined.insert(tbl.id.as_str());
        }
    }

    // Any remaining unjoined tables become CROSS JOIN
    for tbl in &spec.tables {
        if !joined.contains(tbl.id.as_str()) {
            let fq = qualified_table(engine, tbl.schema.as_deref(), &tbl.table);
            sql.push_str(&format!("\nCROSS JOIN {}", fq));
            if !tbl.alias.trim().is_empty() && tbl.alias.trim() != tbl.table {
                sql.push_str(&format!(" AS {}", quote_ident(engine, tbl.alias.trim())));
            }
            joined.insert(tbl.id.as_str());
        }
    }

    // WHERE
    if !spec.where_conditions.is_empty() {
        sql.push_str("\nWHERE ");
        for (idx, cond) in spec.where_conditions.iter().enumerate() {
            if idx > 0 {
                let conj = if cond.conjunction.eq_ignore_ascii_case("OR") {
                    "OR"
                } else {
                    "AND"
                };
                sql.push_str(&format!("\n  {} ", conj));
            }
            let lhs = format!(
                "{}.{}",
                alias_for(&cond.table_id),
                quote_ident(engine, &cond.column)
            );
            let op = cond.operator.trim().to_uppercase();
            if op == "IS NULL" || op == "IS NOT NULL" {
                sql.push_str(&format!("{} {}", lhs, op));
            } else {
                let val = cond.value.as_deref().unwrap_or("");
                if op == "IN" {
                    sql.push_str(&format!("{} IN ({})", lhs, val));
                } else if val.parse::<f64>().is_ok() {
                    sql.push_str(&format!("{} {} {}", lhs, op, val));
                } else {
                    sql.push_str(&format!("{} {} '{}'", lhs, op, val.replace('\'', "''")));
                }
            }
        }
    }

    // GROUP BY
    if !spec.group_by.is_empty() {
        sql.push_str("\nGROUP BY ");
        sql.push_str(&spec.group_by.join(", "));
    }

    // HAVING
    if let Some(ref hav) = spec.having {
        if !hav.trim().is_empty() {
            sql.push_str(&format!("\nHAVING {}", hav.trim()));
        }
    }

    // ORDER BY
    if !spec.order_by.is_empty() {
        let items: Vec<String> = spec
            .order_by
            .iter()
            .map(|o| {
                let dir = if o.direction.eq_ignore_ascii_case("DESC") {
                    "DESC"
                } else {
                    "ASC"
                };
                format!(
                    "{}.{} {}",
                    alias_for(&o.table_id),
                    quote_ident(engine, &o.column),
                    dir
                )
            })
            .collect();
        sql.push_str(&format!("\nORDER BY {}", items.join(", ")));
    }

    if engine != DbEngine::Mssql {
        if let Some(lim) = spec.limit {
            sql.push_str(&format!("\nLIMIT {}", lim));
        }
    }

    sql.push(';');
    sql
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forward_engineers_er_model_with_fk_constraints() {
        let model = ErModel {
            id: "m1".into(),
            name: "shop".into(),
            engine: DbEngine::Postgres,
            database: Some("app".into()),
            schema: Some("public".into()),
            tables: vec![
                ErTableNode {
                    id: "t_users".into(),
                    name: "users".into(),
                    schema: Some("public".into()),
                    x: 0.0,
                    y: 0.0,
                    color: None,
                    group: None,
                    columns: vec![TableDesignColumn {
                        name: "id".into(),
                        original_name: None,
                        data_type: "BIGINT".into(),
                        length: None,
                        nullable: false,
                        default_value: None,
                        is_primary_key: true,
                        is_auto_increment: true,
                        comment: None,
                    }],
                    indexes: vec![],
                },
                ErTableNode {
                    id: "t_orders".into(),
                    name: "orders".into(),
                    schema: Some("public".into()),
                    x: 0.0,
                    y: 0.0,
                    color: None,
                    group: None,
                    columns: vec![
                        TableDesignColumn {
                            name: "id".into(),
                            original_name: None,
                            data_type: "BIGINT".into(),
                            length: None,
                            nullable: false,
                            default_value: None,
                            is_primary_key: true,
                            is_auto_increment: true,
                            comment: None,
                        },
                        TableDesignColumn {
                            name: "user_id".into(),
                            original_name: None,
                            data_type: "BIGINT".into(),
                            length: None,
                            nullable: false,
                            default_value: None,
                            is_primary_key: false,
                            is_auto_increment: false,
                            comment: None,
                        },
                    ],
                    indexes: vec![],
                },
            ],
            relationships: vec![ErRelationship {
                id: "r1".into(),
                name: "fk_orders_user".into(),
                source_table_id: "t_orders".into(),
                source_column: "user_id".into(),
                target_table_id: "t_users".into(),
                target_column: "id".into(),
                cardinality: ErCardinality::OneToMany,
                on_update: "CASCADE".into(),
                on_delete: "RESTRICT".into(),
            }],
            updated_at: "2026-01-01T00:00:00Z".into(),
        };

        let mut layout_model = model.clone();
        auto_layout_er_model(&mut layout_model);
        // orders depends on users -> orders should be placed to the right of users
        let u = layout_model.tables.iter().find(|t| t.id == "t_users").unwrap();
        let o = layout_model.tables.iter().find(|t| t.id == "t_orders").unwrap();
        assert!(o.x > u.x);

        let res = forward_engineer_model(&ForwardEngineerRequest {
            model,
            target_engine: DbEngine::Postgres,
            include_drops: true,
        });
        assert!(res.ddl.contains("DROP TABLE IF EXISTS"));
        assert!(res.ddl.contains("CREATE TABLE \"public\".\"users\""));
        assert!(res.ddl.contains("ADD CONSTRAINT \"fk_orders_user\" FOREIGN KEY"));
    }

    #[test]
    fn generates_visual_query_with_joins_and_aggregates() {
        let spec = VisualQuerySpec {
            engine: DbEngine::Postgres,
            distinct: false,
            tables: vec![
                QbTableItem {
                    id: "t1".into(),
                    schema: Some("public".into()),
                    table: "users".into(),
                    alias: "u".into(),
                    x: 0.0,
                    y: 0.0,
                },
                QbTableItem {
                    id: "t2".into(),
                    schema: Some("public".into()),
                    table: "orders".into(),
                    alias: "o".into(),
                    x: 300.0,
                    y: 0.0,
                },
            ],
            joins: vec![QbJoinItem {
                id: "j1".into(),
                left_table_id: "t1".into(),
                left_column: "id".into(),
                right_table_id: "t2".into(),
                right_column: "user_id".into(),
                join_type: QbJoinType::Left,
            }],
            columns: vec![
                QbSelectColumn {
                    table_id: "t1".into(),
                    column: "email".into(),
                    alias: None,
                    aggregate: None,
                    selected: true,
                },
                QbSelectColumn {
                    table_id: "t2".into(),
                    column: "id".into(),
                    alias: Some("order_count".into()),
                    aggregate: Some("COUNT".into()),
                    selected: true,
                },
            ],
            where_conditions: vec![QbWhereCondition {
                id: "w1".into(),
                conjunction: "AND".into(),
                table_id: "t1".into(),
                column: "active".into(),
                operator: "=".into(),
                value: Some("1".into()),
            }],
            group_by: vec!["\"u\".\"email\"".into()],
            having: Some("COUNT(\"o\".\"id\") > 0".into()),
            order_by: vec![QbOrderItem {
                table_id: "t1".into(),
                column: "email".into(),
                direction: "ASC".into(),
            }],
            limit: Some(50),
        };

        let sql = generate_visual_query_sql(&spec);
        assert!(sql.contains("COUNT(\"o\".\"id\") AS \"order_count\""));
        assert!(sql.contains("LEFT JOIN \"public\".\"orders\" AS \"o\" ON \"u\".\"id\" = \"o\".\"user_id\""));
        assert!(sql.contains("LIMIT 50;"));
    }
}
