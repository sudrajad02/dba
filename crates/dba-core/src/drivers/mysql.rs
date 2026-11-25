use crate::drivers::{
    build_order_clause, build_staged_change_sql, build_where_clause, is_compound_ddl,
    qualified_table, quote_ident, split_sql_statements, SqlDriver,
};
use crate::error::{DbaError, Result};
use crate::models::*;
use async_trait::async_trait;
use mysql_async::prelude::*;
use mysql_async::{OptsBuilder, Pool, Row, SslOpts, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::Instant;
use tokio::sync::Mutex;

pub struct MysqlDriver {
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    default_db: Option<String>,
    ssl: SslConfig,
    pool: Pool,
    active_conn_ids: Mutex<HashMap<String, u32>>,
}

impl MysqlDriver {
    pub async fn connect(
        host: String,
        port: u16,
        username: String,
        password: Option<String>,
        database: Option<String>,
        ssl: SslConfig,
    ) -> Result<Self> {
        let mut builder = OptsBuilder::default()
            .ip_or_hostname(host.clone())
            .tcp_port(port)
            .user(Some(username.clone()))
            .pass(password.clone())
            .db_name(database.clone().filter(|s| !s.trim().is_empty()));

        if ssl.mode != SslMode::Disable {
            let mut ssl_opts = SslOpts::default();
            if matches!(ssl.mode, SslMode::Prefer | SslMode::Require) {
                ssl_opts = ssl_opts
                    .with_danger_accept_invalid_certs(true)
                    .with_danger_skip_domain_validation(true);
            } else if ssl.mode == SslMode::VerifyCa {
                ssl_opts = ssl_opts.with_danger_skip_domain_validation(true);
            }
            if let Some(ref ca) = ssl.ca_cert_path {
                if !ca.trim().is_empty() {
                    ssl_opts = ssl_opts.with_root_certs(vec![PathBuf::from(ca).into()]);
                }
            }
            builder = builder.ssl_opts(ssl_opts);
        }

        let pool = Pool::new(builder);
        // Verify connectivity
        let mut conn = pool.get_conn().await.map_err(map_mysql_error)?;
        let _: Option<i32> = conn.query_first("SELECT 1").await.map_err(map_mysql_error)?;

        Ok(Self {
            host,
            port,
            username,
            password,
            default_db: database.filter(|s| !s.trim().is_empty()),
            ssl,
            pool,
            active_conn_ids: Mutex::new(HashMap::new()),
        })
    }

    async fn get_conn(&self, database: Option<&str>) -> Result<mysql_async::Conn> {
        let mut conn = self.pool.get_conn().await.map_err(map_mysql_error)?;
        if let Some(db) = database.or(self.default_db.as_deref()).filter(|s| !s.trim().is_empty()) {
            conn.query_drop(format!("USE {}", quote_ident(DbEngine::Mysql, db)))
                .await
                .map_err(map_mysql_error)?;
        }
        Ok(conn)
    }

    fn effective_db<'a>(&'a self, database: Option<&'a str>, schema: Option<&'a str>) -> Option<&'a str> {
        database
            .filter(|s| !s.trim().is_empty())
            .or_else(|| schema.filter(|s| !s.trim().is_empty()))
            .or(self.default_db.as_deref())
    }
}

fn map_mysql_error(err: mysql_async::Error) -> DbaError {
    match &err {
        mysql_async::Error::Server(srv) => DbaError::Database {
            message: srv.message.clone(),
            code: Some(format!("{} ({})", srv.code, srv.state)),
            detail: None,
            line: None,
        },
        _ => DbaError::Database {
            message: err.to_string(),
            code: None,
            detail: None,
            line: None,
        },
    }
}

fn mysql_value_to_json(val: Value) -> serde_json::Value {
    match val {
        Value::NULL => serde_json::Value::Null,
        Value::Int(i) => serde_json::Value::from(i),
        Value::UInt(u) => serde_json::Value::from(u),
        Value::Float(f) => serde_json::Number::from_f64(f as f64)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        Value::Double(d) => serde_json::Number::from_f64(d)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        Value::Bytes(b) => match String::from_utf8(b) {
            Ok(s) => serde_json::Value::String(s),
            Err(e) => {
                let hex: String = e.into_bytes().iter().map(|x| format!("{:02x}", x)).collect();
                serde_json::Value::String(format!("0x{}", hex))
            }
        },
        Value::Date(y, m, d, h, min, s, us) => {
            if h == 0 && min == 0 && s == 0 && us == 0 {
                serde_json::Value::String(format!("{:04}-{:02}-{:02}", y, m, d))
            } else if us == 0 {
                serde_json::Value::String(format!(
                    "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
                    y, m, d, h, min, s
                ))
            } else {
                serde_json::Value::String(format!(
                    "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:06}",
                    y, m, d, h, min, s, us
                ))
            }
        }
        Value::Time(neg, d, h, m, s, us) => {
            let sign = if neg { "-" } else { "" };
            let total_h = d * 24 + h as u32;
            if us == 0 {
                serde_json::Value::String(format!("{}{:02}:{:02}:{:02}", sign, total_h, m, s))
            } else {
                serde_json::Value::String(format!(
                    "{}{:02}:{:02}:{:02}.{:06}",
                    sign, total_h, m, s, us
                ))
            }
        }
    }
}

fn mysql_row_to_json(row: Row) -> Vec<serde_json::Value> {
    let vals = row.unwrap();
    vals.into_iter().map(mysql_value_to_json).collect()
}

#[async_trait]
impl SqlDriver for MysqlDriver {
    async fn server_version(&self) -> Result<String> {
        let mut conn = self.get_conn(None).await?;
        let v: Option<String> = conn
            .query_first("SELECT VERSION()")
            .await
            .map_err(map_mysql_error)?;
        Ok(v.unwrap_or_else(|| "MySQL".into()))
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let mut conn = self.get_conn(None).await?;
        let rows: Vec<(String, Option<i64>)> = conn
            .query(
                "SELECT s.SCHEMA_NAME,
                        CAST(SUM(COALESCE(t.DATA_LENGTH, 0) + COALESCE(t.INDEX_LENGTH, 0)) AS SIGNED) AS size_bytes
                 FROM information_schema.SCHEMATA s
                 LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
                 WHERE s.SCHEMA_NAME NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys')
                 GROUP BY s.SCHEMA_NAME
                 ORDER BY s.SCHEMA_NAME",
            )
            .await
            .map_err(map_mysql_error)?;
        Ok(rows
            .into_iter()
            .map(|(name, size_bytes)| DatabaseInfo { name, size_bytes })
            .collect())
    }

    async fn list_schemas(&self, _database: Option<&str>) -> Result<Vec<SchemaInfo>> {
        // MySQL maps database == schema
        Ok(Vec::new())
    }

    async fn list_objects(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
    ) -> Result<Vec<DatabaseObject>> {
        let db = self
            .effective_db(database, schema)
            .ok_or_else(|| DbaError::Database {
                message: "No database selected".into(),
                code: None,
                detail: None,
                line: None,
            })?;
        let mut conn = self.get_conn(Some(db)).await?;
        let mut objects = Vec::new();

        // Tables & Views
        let tables: Vec<(String, String, Option<i64>, Option<String>)> = conn
            .exec(
                "SELECT TABLE_NAME, TABLE_TYPE, CAST(TABLE_ROWS AS SIGNED), TABLE_COMMENT
                 FROM information_schema.TABLES
                 WHERE TABLE_SCHEMA = ?
                 ORDER BY TABLE_NAME",
                (db,),
            )
            .await
            .map_err(map_mysql_error)?;
        for (name, ttype, rows, comment) in tables {
            objects.push(DatabaseObject {
                name,
                schema: Some(db.to_string()),
                kind: if ttype == "VIEW" {
                    ObjectKind::View
                } else {
                    ObjectKind::Table
                },
                row_estimate: rows,
                comment: comment.filter(|s| !s.is_empty()),
            });
        }

        // Functions & Procedures
        let routines: Vec<(String, String)> = conn
            .exec(
                "SELECT ROUTINE_NAME, ROUTINE_TYPE
                 FROM information_schema.ROUTINES
                 WHERE ROUTINE_SCHEMA = ?
                 ORDER BY ROUTINE_NAME",
                (db,),
            )
            .await
            .map_err(map_mysql_error)?;
        for (name, rtype) in routines {
            objects.push(DatabaseObject {
                name,
                schema: Some(db.to_string()),
                kind: if rtype == "PROCEDURE" {
                    ObjectKind::Procedure
                } else {
                    ObjectKind::Function
                },
                row_estimate: None,
                comment: None,
            });
        }

        // Triggers
        let triggers: Vec<String> = conn
            .exec(
                "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME",
                (db,),
            )
            .await
            .map_err(map_mysql_error)?;
        for name in triggers {
            objects.push(DatabaseObject {
                name,
                schema: Some(db.to_string()),
                kind: ObjectKind::Trigger,
                row_estimate: None,
                comment: None,
            });
        }

        // Events
        let events: Vec<String> = conn
            .exec(
                "SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME",
                (db,),
            )
            .await
            .unwrap_or_default();
        for name in events {
            objects.push(DatabaseObject {
                name,
                schema: Some(db.to_string()),
                kind: ObjectKind::Event,
                row_estimate: None,
                comment: None,
            });
        }

        Ok(objects)
    }

    async fn get_table_metadata(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
        table: &str,
    ) -> Result<TableMetadata> {
        let db = self
            .effective_db(database, schema)
            .ok_or_else(|| DbaError::Database {
                message: "No database selected".into(),
                code: None,
                detail: None,
                line: None,
            })?;
        let mut conn = self.get_conn(Some(db)).await?;

        let col_rows: Vec<(
            String,
            String,
            String,
            Option<i64>,
            Option<i64>,
            Option<i64>,
            String,
            Option<String>,
            String,
            String,
            Option<String>,
        )> = conn
            .exec(
                "SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE,
                        CAST(CHARACTER_MAXIMUM_LENGTH AS SIGNED),
                        CAST(NUMERIC_PRECISION AS SIGNED),
                        CAST(NUMERIC_SCALE AS SIGNED),
                        IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT
                 FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                 ORDER BY ORDINAL_POSITION",
                (db, table),
            )
            .await
            .map_err(map_mysql_error)?;

        let columns: Vec<ColumnMeta> = col_rows
            .into_iter()
            .map(|r| ColumnMeta {
                name: r.0,
                data_type: r.1,
                udt_name: Some(r.2),
                max_length: r.3,
                numeric_precision: r.4,
                numeric_scale: r.5,
                nullable: r.6 == "YES",
                default_value: r.7,
                is_primary_key: r.8 == "PRI",
                is_auto_increment: r.9.to_lowercase().contains("auto_increment"),
                comment: r.10.filter(|s| !s.is_empty()),
            })
            .collect();

        // Indexes
        let idx_rows: Vec<(String, i32, String, String)> = conn
            .exec(
                "SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, INDEX_TYPE
                 FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                 ORDER BY INDEX_NAME, SEQ_IN_INDEX",
                (db, table),
            )
            .await
            .map_err(map_mysql_error)?;
        let mut idx_map: HashMap<String, IndexMeta> = HashMap::new();
        for (name, non_unique, col, method) in idx_rows {
            let entry = idx_map.entry(name.clone()).or_insert(IndexMeta {
                is_primary: name == "PRIMARY",
                is_unique: non_unique == 0,
                name,
                columns: Vec::new(),
                method,
                definition: None,
            });
            entry.columns.push(col);
        }
        let indexes: Vec<IndexMeta> = idx_map.into_values().collect();

        // Foreign keys
        let fk_rows: Vec<(String, String, String, String, String, String, String)> = conn
            .exec(
                "SELECT kcu.CONSTRAINT_NAME, kcu.COLUMN_NAME,
                        kcu.REFERENCED_TABLE_SCHEMA, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME,
                        rc.UPDATE_RULE, rc.DELETE_RULE
                 FROM information_schema.KEY_COLUMN_USAGE kcu
                 JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
                   ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
                 WHERE kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ? AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
                 ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION",
                (db, table),
            )
            .await
            .map_err(map_mysql_error)?;
        let mut fk_map: HashMap<String, ForeignKeyMeta> = HashMap::new();
        for (name, col, ref_schema, ref_table, ref_col, on_upd, on_del) in fk_rows {
            let entry = fk_map.entry(name.clone()).or_insert(ForeignKeyMeta {
                name,
                columns: Vec::new(),
                ref_schema: Some(ref_schema),
                ref_table,
                ref_columns: Vec::new(),
                on_update: on_upd,
                on_delete: on_del,
            });
            entry.columns.push(col);
            entry.ref_columns.push(ref_col);
        }
        let foreign_keys: Vec<ForeignKeyMeta> = fk_map.into_values().collect();

        // SHOW CREATE TABLE
        let ddl: Option<String> = conn
            .query_first::<(String, String), _>(format!(
                "SHOW CREATE TABLE {}",
                qualified_table(DbEngine::Mysql, Some(db), table)
            ))
            .await
            .ok()
            .flatten()
            .map(|(_, create_sql)| create_sql);

        Ok(TableMetadata {
            schema: Some(db.to_string()),
            name: table.to_string(),
            columns,
            indexes,
            foreign_keys,
            checks: Vec::new(),
            row_estimate: None,
            ddl,
        })
    }

    async fn fetch_table_data(&self, req: &TableDataRequest) -> Result<QueryResultSet> {
        let start = Instant::now();
        let db = self.effective_db(req.database.as_deref(), req.schema.as_deref());
        let meta = self
            .get_table_metadata(db, db, &req.table)
            .await?;
        let mut conn = self.get_conn(db).await?;

        let fq = qualified_table(DbEngine::Mysql, db, &req.table);
        let where_sql = build_where_clause(DbEngine::Mysql, &req.filters);
        let order_sql = build_order_clause(DbEngine::Mysql, &req.sorts);
        let offset = req.page.saturating_sub(1) * req.page_size;

        let count_sql = format!("SELECT COUNT(*) FROM {}{}", fq, where_sql);
        let total_count: Option<u64> = conn
            .query_first::<u64, _>(&count_sql)
            .await
            .ok()
            .flatten();

        let data_sql = format!(
            "SELECT * FROM {}{}{} LIMIT {} OFFSET {}",
            fq, where_sql, order_sql, req.page_size, offset
        );
        let rows: Vec<Row> = conn.query(&data_sql).await.map_err(map_mysql_error)?;

        let pk_set: HashSet<String> = meta
            .columns
            .iter()
            .filter(|c| c.is_primary_key)
            .map(|c| c.name.clone())
            .collect();
        let mut fk_lookup: HashMap<String, ForeignKeyTarget> = HashMap::new();
        for fk in &meta.foreign_keys {
            for (i, col) in fk.columns.iter().enumerate() {
                if let Some(ref_col) = fk.ref_columns.get(i) {
                    fk_lookup.insert(
                        col.clone(),
                        ForeignKeyTarget {
                            schema: fk.ref_schema.clone(),
                            table: fk.ref_table.clone(),
                            column: ref_col.clone(),
                        },
                    );
                }
            }
        }

        let columns: Vec<ResultColumn> = if let Some(first) = rows.first() {
            first
                .columns_ref()
                .iter()
                .map(|c| {
                    let name = c.name_str().to_string();
                    ResultColumn {
                        is_primary_key: pk_set.contains(&name),
                        fk_target: fk_lookup.get(&name).cloned(),
                        name,
                        data_type: format!("{:?}", c.column_type()),
                    }
                })
                .collect()
        } else {
            meta.columns
                .iter()
                .map(|c| ResultColumn {
                    name: c.name.clone(),
                    data_type: c.data_type.clone(),
                    is_primary_key: c.is_primary_key,
                    fk_target: fk_lookup.get(&c.name).cloned(),
                })
                .collect()
        };

        let data_rows: Vec<Vec<serde_json::Value>> = rows.into_iter().map(mysql_row_to_json).collect();

        Ok(QueryResultSet {
            columns,
            rows: data_rows,
            rows_affected: None,
            total_count,
            execution_ms: start.elapsed().as_millis() as u64,
            statement: data_sql,
        })
    }

    async fn execute_query(
        &self,
        database: Option<&str>,
        sql: &str,
        query_id: &str,
    ) -> Result<QueryExecutionResponse> {
        let total_start = Instant::now();
        let mut conn = self.get_conn(database).await?;
        let conn_id = conn.id();
        {
            let mut active = self.active_conn_ids.lock().await;
            active.insert(query_id.to_string(), conn_id);
        }

        let statements = split_sql_statements(sql);
        let mut result_sets = Vec::new();

        for stmt_sql in statements {
            let stmt_start = Instant::now();
            let upper = stmt_sql.trim_start().to_uppercase();
            let expects_rows = upper.starts_with("SELECT")
                || upper.starts_with("SHOW")
                || upper.starts_with("DESCRIBE")
                || upper.starts_with("DESC")
                || upper.starts_with("EXPLAIN")
                || upper.starts_with("WITH");

            if expects_rows {
                match conn.query::<Row, _>(&stmt_sql).await {
                    Ok(rows) => {
                        let columns: Vec<ResultColumn> = rows
                            .first()
                            .map(|r| {
                                r.columns_ref()
                                    .iter()
                                    .map(|c| ResultColumn {
                                        name: c.name_str().to_string(),
                                        data_type: format!("{:?}", c.column_type()),
                                        is_primary_key: false,
                                        fk_target: None,
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        let data_rows: Vec<Vec<serde_json::Value>> =
                            rows.into_iter().map(mysql_row_to_json).collect();
                        result_sets.push(QueryResultSet {
                            columns,
                            rows: data_rows,
                            rows_affected: None,
                            total_count: None,
                            execution_ms: stmt_start.elapsed().as_millis() as u64,
                            statement: stmt_sql,
                        });
                    }
                    Err(e) => {
                        let mut active = self.active_conn_ids.lock().await;
                        active.remove(query_id);
                        return Err(map_mysql_error(e));
                    }
                }
            } else {
                match conn.query_drop(&stmt_sql).await {
                    Ok(()) => {
                        result_sets.push(QueryResultSet {
                            columns: Vec::new(),
                            rows: Vec::new(),
                            rows_affected: Some(conn.affected_rows()),
                            total_count: None,
                            execution_ms: stmt_start.elapsed().as_millis() as u64,
                            statement: stmt_sql,
                        });
                    }
                    Err(e) => {
                        let mut active = self.active_conn_ids.lock().await;
                        active.remove(query_id);
                        return Err(map_mysql_error(e));
                    }
                }
            }
        }

        {
            let mut active = self.active_conn_ids.lock().await;
            active.remove(query_id);
        }

        Ok(QueryExecutionResponse {
            query_id: query_id.to_string(),
            result_sets,
            total_execution_ms: total_start.elapsed().as_millis() as u64,
        })
    }

    async fn cancel_query(&self, query_id: &str) -> Result<()> {
        let conn_id = {
            let mut active = self.active_conn_ids.lock().await;
            active.remove(query_id)
        };
        if let Some(id) = conn_id {
            if let Ok(mut conn) = self.pool.get_conn().await {
                let _ = conn.query_drop(format!("KILL QUERY {}", id)).await;
            }
        }
        Ok(())
    }

    async fn explain_query(&self, database: Option<&str>, sql: &str) -> Result<ExplainPlanResult> {
        let start = Instant::now();
        let mut conn = self.get_conn(database).await?;
        let trimmed = sql.trim().trim_end_matches(';');
        let raw_str: Option<String> = conn
            .query_first(format!("EXPLAIN FORMAT=JSON {}", trimmed))
            .await
            .map_err(map_mysql_error)?;
        let raw_json: serde_json::Value = raw_str
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_else(|| serde_json::json!({}));

        let root = parse_mysql_explain(&raw_json);
        Ok(ExplainPlanResult {
            root,
            raw_json,
            execution_ms: start.elapsed().as_millis() as u64,
        })
    }

    async fn apply_staged_changes(&self, req: &ApplyChangesRequest) -> Result<u64> {
        let db = self.effective_db(req.database.as_deref(), req.schema.as_deref());
        let mut conn = self.get_conn(db).await?;
        let statements = build_staged_change_sql(DbEngine::Mysql, db, &req.table, &req.changes);
        if statements.is_empty() {
            return Ok(0);
        }
        conn.query_drop("START TRANSACTION")
            .await
            .map_err(map_mysql_error)?;
        let mut total = 0u64;
        for stmt in &statements {
            if let Err(e) = conn.query_drop(stmt).await {
                let _ = conn.query_drop("ROLLBACK").await;
                return Err(map_mysql_error(e));
            }
            total += conn.affected_rows();
        }
        conn.query_drop("COMMIT").await.map_err(map_mysql_error)?;
        Ok(total)
    }

    async fn get_autocomplete_schema(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
    ) -> Result<AutocompleteSchema> {
        let db = self.effective_db(database, schema).unwrap_or("");
        if db.is_empty() {
            return Ok(AutocompleteSchema {
                tables: HashMap::new(),
            });
        }
        let mut conn = self.get_conn(Some(db)).await?;
        let rows: Vec<(String, String)> = conn
            .exec(
                "SELECT TABLE_NAME, COLUMN_NAME
                 FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = ?
                 ORDER BY TABLE_NAME, ORDINAL_POSITION",
                (db,),
            )
            .await
            .map_err(map_mysql_error)?;
        let mut tables: HashMap<String, Vec<String>> = HashMap::new();
        for (t, c) in rows {
            tables.entry(t).or_default().push(c);
        }
        Ok(AutocompleteSchema { tables })
    }

    async fn execute_ddl(&self, database: Option<&str>, ddl: &str) -> Result<()> {
        let mut conn = self.get_conn(database).await?;
        if is_compound_ddl(ddl) {
            let trimmed = ddl.trim();
            if !trimmed.is_empty() {
                conn.query_drop(trimmed).await.map_err(map_mysql_error)?;
            }
            return Ok(());
        }
        for stmt in split_sql_statements(ddl) {
            conn.query_drop(&stmt).await.map_err(map_mysql_error)?;
        }
        Ok(())
    }

    async fn truncate_table(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
        table: &str,
    ) -> Result<()> {
        let db = self.effective_db(database, schema);
        let mut conn = self.get_conn(db).await?;
        let fq = qualified_table(DbEngine::Mysql, db, table);
        conn.query_drop(format!("TRUNCATE TABLE {}", fq))
            .await
            .map_err(map_mysql_error)?;
        Ok(())
    }

    async fn drop_object(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
        name: &str,
        kind: ObjectKind,
    ) -> Result<()> {
        let db = self.effective_db(database, schema);
        let mut conn = self.get_conn(db).await?;
        let fq = qualified_table(DbEngine::Mysql, db, name);
        let keyword = match kind {
            ObjectKind::Table => "TABLE",
            ObjectKind::View => "VIEW",
            ObjectKind::Function => "FUNCTION",
            ObjectKind::Procedure => "PROCEDURE",
            ObjectKind::Trigger => "TRIGGER",
            ObjectKind::Event => "EVENT",
            _ => "TABLE",
        };
        conn.query_drop(format!("DROP {} {}", keyword, fq))
            .await
            .map_err(map_mysql_error)?;
        Ok(())
    }

    async fn duplicate_table(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
        source: &str,
        target: &str,
        with_data: bool,
    ) -> Result<()> {
        let db = self.effective_db(database, schema);
        let mut conn = self.get_conn(db).await?;
        let src = qualified_table(DbEngine::Mysql, db, source);
        let dst = qualified_table(DbEngine::Mysql, db, target);
        conn.query_drop(format!("CREATE TABLE {} LIKE {}", dst, src))
            .await
            .map_err(map_mysql_error)?;
        if with_data {
            conn.query_drop(format!("INSERT INTO {} SELECT * FROM {}", dst, src))
                .await
                .map_err(map_mysql_error)?;
        }
        let _ = (&self.host, self.port, &self.username, &self.password, &self.ssl);
        Ok(())
    }

    async fn get_object_ddl(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
        name: &str,
        kind: ObjectKind,
    ) -> Result<String> {
        let db = self.effective_db(database, schema);
        let mut conn = self.get_conn(db).await?;
        let fq = qualified_table(DbEngine::Mysql, db, name);
        let (sql, col_idx) = match kind {
            ObjectKind::Table => (format!("SHOW CREATE TABLE {}", fq), 1usize),
            ObjectKind::View => (format!("SHOW CREATE VIEW {}", fq), 1usize),
            ObjectKind::Function => (format!("SHOW CREATE FUNCTION {}", fq), 2usize),
            ObjectKind::Procedure => (format!("SHOW CREATE PROCEDURE {}", fq), 2usize),
            ObjectKind::Trigger => (format!("SHOW CREATE TRIGGER {}", fq), 2usize),
            ObjectKind::Event => (format!("SHOW CREATE EVENT {}", fq), 3usize),
            _ => {
                return Err(DbaError::UnsupportedEngine(format!(
                    "MySQL DDL extraction is not supported for {:?}",
                    kind
                )))
            }
        };

        let row: Option<mysql_async::Row> = conn.query_first(sql).await.map_err(map_mysql_error)?;
        let row = row.ok_or_else(|| DbaError::Database {
            message: format!("Object '{}' not found", name),
            code: None,
            detail: None,
            line: None,
        })?;

        let raw_ddl: String = row
            .get_opt::<String, usize>(col_idx)
            .and_then(|r| r.ok())
            .ok_or_else(|| DbaError::Database {
                message: format!("Failed to read DDL for '{}' (check permissions)", name),
                code: None,
                detail: None,
                line: None,
            })?;

        // Strip DEFINER=`user`@`host` so the DDL executes cleanly on target servers without SUPER privilege
        let cleaned = strip_mysql_definer(&raw_ddl);
        Ok(cleaned)
    }
}

fn strip_mysql_definer(ddl: &str) -> String {
    if let Ok(re) =
        regex::Regex::new(r"(?i)\bDEFINER\s*=\s*(?:`[^`]+`|'[^']+'|[^\s@]+)@(?:`[^`]+`|'[^']+'|\S+)\s*")
    {
        re.replace(ddl, "").to_string()
    } else {
        ddl.to_string()
    }
}

fn parse_mysql_explain(val: &serde_json::Value) -> Option<ExplainNode> {
    let qb = val.get("query_block")?;
    let cost = qb
        .get("cost_info")
        .and_then(|c| c.get("query_cost"))
        .and_then(|v| v.as_str().and_then(|s| s.parse::<f64>().ok()).or_else(|| v.as_f64()));

    let mut children = Vec::new();
    if let Some(table) = qb.get("table") {
        children.push(parse_mysql_table_node(table));
    }
    if let Some(nested) = qb.get("nested_loop").and_then(|v| v.as_array()) {
        for item in nested {
            if let Some(table) = item.get("table") {
                children.push(parse_mysql_table_node(table));
            }
        }
    }

    Some(ExplainNode {
        node_type: "Query Block".into(),
        relation: None,
        startup_cost: None,
        total_cost: cost,
        plan_rows: None,
        actual_time_ms: None,
        actual_rows: None,
        is_full_scan: false,
        extra: None,
        children,
    })
}

fn parse_mysql_table_node(t: &serde_json::Value) -> ExplainNode {
    let access = t
        .get("access_type")
        .and_then(|v| v.as_str())
        .unwrap_or("scan");
    let is_full_scan = access.eq_ignore_ascii_case("ALL");
    let table_name = t
        .get("table_name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let rows = t.get("rows_examined_per_scan").and_then(|v| v.as_f64());
    let cost = t
        .get("cost_info")
        .and_then(|c| c.get("read_cost"))
        .and_then(|v| v.as_str().and_then(|s| s.parse::<f64>().ok()).or_else(|| v.as_f64()));
    let key = t
        .get("key")
        .and_then(|v| v.as_str())
        .map(|k| format!("Key: {}", k));

    ExplainNode {
        node_type: format!("Table Access ({})", access),
        relation: table_name,
        startup_cost: None,
        total_cost: cost,
        plan_rows: rows,
        actual_time_ms: None,
        actual_rows: None,
        is_full_scan,
        extra: key,
        children: Vec::new(),
    }
}
