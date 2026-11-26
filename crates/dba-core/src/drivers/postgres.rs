use crate::drivers::{
    build_order_clause, build_staged_change_sql, build_where_clause, qualified_table, quote_ident,
    split_sql_statements, SqlDriver,
};
use crate::error::{DbaError, Result};
use crate::models::*;
use async_trait::async_trait;
use chrono::{NaiveDate, NaiveDateTime, NaiveTime, Utc};
use native_tls::{Certificate, TlsConnector};
use postgres_native_tls::MakeTlsConnector;
use std::collections::HashMap;
use std::fs;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;
use tokio_postgres::types::{FromSql, Type};
use tokio_postgres::{CancelToken, Client, Config, NoTls, Row};
use uuid::Uuid;

struct PgAnyText(String);

impl<'a> FromSql<'a> for PgAnyText {
    fn from_sql(
        _ty: &Type,
        raw: &'a [u8],
    ) -> std::result::Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        match std::str::from_utf8(raw) {
            Ok(s) => Ok(PgAnyText(s.to_string())),
            Err(_) => {
                let hex: String = raw.iter().map(|b| format!("{:02x}", b)).collect();
                Ok(PgAnyText(format!("0x{}", hex)))
            }
        }
    }

    fn accepts(_ty: &Type) -> bool {
        true
    }
}

pub struct PostgresDriver {
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    default_db: String,
    ssl: SslConfig,
    clients: Mutex<HashMap<String, Arc<Client>>>,
    cancel_tokens: Mutex<HashMap<String, CancelToken>>,
}

impl PostgresDriver {
    pub async fn connect(
        host: String,
        port: u16,
        username: String,
        password: Option<String>,
        database: Option<String>,
        ssl: SslConfig,
    ) -> Result<Self> {
        let default_db = database
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "postgres".to_string());
        let driver = Self {
            host,
            port,
            username,
            password,
            default_db: default_db.clone(),
            ssl,
            clients: Mutex::new(HashMap::new()),
            cancel_tokens: Mutex::new(HashMap::new()),
        };
        // Verify connectivity immediately
        let _ = driver.get_client(Some(&default_db)).await?;
        Ok(driver)
    }

    fn build_tls(&self) -> Result<Option<MakeTlsConnector>> {
        if self.ssl.mode == SslMode::Disable {
            return Ok(None);
        }
        let mut builder = TlsConnector::builder();
        match self.ssl.mode {
            SslMode::Prefer | SslMode::Require => {
                builder.danger_accept_invalid_certs(true);
                builder.danger_accept_invalid_hostnames(true);
            }
            SslMode::VerifyCa => {
                builder.danger_accept_invalid_hostnames(true);
            }
            SslMode::VerifyFull | SslMode::Disable => {}
        }
        if let Some(ref ca_path) = self.ssl.ca_cert_path {
            if !ca_path.trim().is_empty() {
                let pem = fs::read(ca_path)
                    .map_err(|e| DbaError::Tls(format!("Failed to read CA cert: {}", e)))?;
                let cert = Certificate::from_pem(&pem)
                    .map_err(|e| DbaError::Tls(format!("Invalid CA cert PEM: {}", e)))?;
                builder.add_root_certificate(cert);
            }
        }
        let connector = builder
            .build()
            .map_err(|e| DbaError::Tls(format!("Failed to build TLS connector: {}", e)))?;
        Ok(Some(MakeTlsConnector::new(connector)))
    }

    async fn open_client(&self, dbname: &str) -> Result<Arc<Client>> {
        let mut cfg = Config::new();
        cfg.host(&self.host)
            .port(self.port)
            .user(&self.username)
            .dbname(dbname);
        if let Some(ref pw) = self.password {
            cfg.password(pw);
        }

        if let Some(tls) = self.build_tls()? {
            match cfg.connect(tls).await {
                Ok((client, conn)) => {
                    tokio::spawn(async move {
                        let _ = conn.await;
                    });
                    return Ok(Arc::new(client));
                }
                Err(err) if self.ssl.mode == SslMode::Prefer => {
                    tracing::debug!("TLS prefer fallback to plain connection: {}", err);
                }
                Err(err) => return Err(map_pg_error(err)),
            }
        }

        let (client, conn) = cfg.connect(NoTls).await.map_err(map_pg_error)?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        Ok(Arc::new(client))
    }

    async fn get_client(&self, database: Option<&str>) -> Result<Arc<Client>> {
        let db = database
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&self.default_db)
            .to_string();
        let mut guard = self.clients.lock().await;
        if let Some(client) = guard.get(&db) {
            if !client.is_closed() {
                return Ok(client.clone());
            }
        }
        let client = self.open_client(&db).await?;
        guard.insert(db, client.clone());
        Ok(client)
    }
}

fn map_pg_error(err: tokio_postgres::Error) -> DbaError {
    if let Some(db_err) = err.as_db_error() {
        DbaError::Database {
            message: db_err.message().to_string(),
            code: Some(db_err.code().code().to_string()),
            detail: db_err.detail().map(|s| s.to_string()),
            line: db_err.position().and_then(|p| match p {
                tokio_postgres::error::ErrorPosition::Original(pos) => Some(*pos),
                tokio_postgres::error::ErrorPosition::Internal { position, .. } => Some(*position),
            }),
        }
    } else {
        DbaError::Database {
            message: err.to_string(),
            code: None,
            detail: None,
            line: None,
        }
    }
}

fn pg_cell_to_json(row: &Row, idx: usize) -> serde_json::Value {
    let ty = row.columns()[idx].type_();
    match *ty {
        Type::BOOL => row
            .try_get::<_, Option<bool>>(idx)
            .ok()
            .flatten()
            .map(serde_json::Value::Bool)
            .unwrap_or(serde_json::Value::Null),
        Type::INT2 => row
            .try_get::<_, Option<i16>>(idx)
            .ok()
            .flatten()
            .map(|v| serde_json::Value::from(v))
            .unwrap_or(serde_json::Value::Null),
        Type::INT4 => row
            .try_get::<_, Option<i32>>(idx)
            .ok()
            .flatten()
            .map(|v| serde_json::Value::from(v))
            .unwrap_or(serde_json::Value::Null),
        Type::INT8 => row
            .try_get::<_, Option<i64>>(idx)
            .ok()
            .flatten()
            .map(|v| serde_json::Value::from(v))
            .unwrap_or(serde_json::Value::Null),
        Type::FLOAT4 => row
            .try_get::<_, Option<f32>>(idx)
            .ok()
            .flatten()
            .and_then(|v| serde_json::Number::from_f64(v as f64))
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        Type::FLOAT8 => row
            .try_get::<_, Option<f64>>(idx)
            .ok()
            .flatten()
            .and_then(serde_json::Number::from_f64)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        Type::JSON | Type::JSONB => row
            .try_get::<_, Option<serde_json::Value>>(idx)
            .ok()
            .flatten()
            .unwrap_or(serde_json::Value::Null),
        Type::UUID => row
            .try_get::<_, Option<Uuid>>(idx)
            .ok()
            .flatten()
            .map(|u| serde_json::Value::String(u.to_string()))
            .unwrap_or(serde_json::Value::Null),
        Type::TIMESTAMP => row
            .try_get::<_, Option<NaiveDateTime>>(idx)
            .ok()
            .flatten()
            .map(|d| serde_json::Value::String(d.format("%Y-%m-%d %H:%M:%S%.f").to_string()))
            .unwrap_or(serde_json::Value::Null),
        Type::TIMESTAMPTZ => row
            .try_get::<_, Option<chrono::DateTime<Utc>>>(idx)
            .ok()
            .flatten()
            .map(|d| serde_json::Value::String(d.to_rfc3339()))
            .unwrap_or(serde_json::Value::Null),
        Type::DATE => row
            .try_get::<_, Option<NaiveDate>>(idx)
            .ok()
            .flatten()
            .map(|d| serde_json::Value::String(d.to_string()))
            .unwrap_or(serde_json::Value::Null),
        Type::TIME => row
            .try_get::<_, Option<NaiveTime>>(idx)
            .ok()
            .flatten()
            .map(|t| serde_json::Value::String(t.to_string()))
            .unwrap_or(serde_json::Value::Null),
        Type::BYTEA => row
            .try_get::<_, Option<Vec<u8>>>(idx)
            .ok()
            .flatten()
            .map(|bytes| {
                let hex: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
                serde_json::Value::String(format!("0x{}", hex))
            })
            .unwrap_or(serde_json::Value::Null),
        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME | Type::UNKNOWN => row
            .try_get::<_, Option<String>>(idx)
            .ok()
            .flatten()
            .map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null),
        _ => row
            .try_get::<_, Option<PgAnyText>>(idx)
            .ok()
            .flatten()
            .map(|v| serde_json::Value::String(v.0))
            .unwrap_or(serde_json::Value::Null),
    }
}

fn parse_pg_explain_node(plan: &serde_json::Value) -> ExplainNode {
    let node_type = plan
        .get("Node Type")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown")
        .to_string();
    let is_full_scan = node_type.contains("Seq Scan");
    let children = plan
        .get("Plans")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().map(parse_pg_explain_node).collect())
        .unwrap_or_default();

    ExplainNode {
        node_type,
        relation: plan
            .get("Relation Name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        startup_cost: plan.get("Startup Cost").and_then(|v| v.as_f64()),
        total_cost: plan.get("Total Cost").and_then(|v| v.as_f64()),
        plan_rows: plan.get("Plan Rows").and_then(|v| v.as_f64()),
        actual_time_ms: plan.get("Actual Total Time").and_then(|v| v.as_f64()),
        actual_rows: plan.get("Actual Rows").and_then(|v| v.as_f64()),
        is_full_scan,
        extra: plan
            .get("Filter")
            .or_else(|| plan.get("Index Cond"))
            .or_else(|| plan.get("Hash Cond"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        children,
    }
}

#[async_trait]
impl SqlDriver for PostgresDriver {
    async fn server_version(&self) -> Result<String> {
        let client = self.get_client(None).await?;
        let row = client
            .query_one("SELECT version()", &[])
            .await
            .map_err(map_pg_error)?;
        Ok(row.get::<_, String>(0))
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let client = self.get_client(None).await?;
        let rows = client
            .query(
                "SELECT datname, pg_database_size(datname) FROM pg_database WHERE datistemplate = false ORDER BY datname",
                &[],
            )
            .await
            .map_err(map_pg_error)?;
        Ok(rows
            .into_iter()
            .map(|r| DatabaseInfo {
                name: r.get(0),
                size_bytes: r.try_get(1).ok(),
            })
            .collect())
    }

    async fn list_schemas(&self, database: Option<&str>) -> Result<Vec<SchemaInfo>> {
        let client = self.get_client(database).await?;
        let rows = client
            .query(
                "SELECT schema_name FROM information_schema.schemata
                 WHERE schema_name NOT LIKE 'pg_toast%'
                   AND schema_name NOT LIKE 'pg_temp%'
                   AND schema_name NOT IN ('pg_catalog', 'information_schema')
                 ORDER BY CASE WHEN schema_name = 'public' THEN 0 ELSE 1 END, schema_name",
                &[],
            )
            .await
            .map_err(map_pg_error)?;
        Ok(rows
            .into_iter()
            .map(|r| SchemaInfo { name: r.get(0) })
            .collect())
    }

    async fn list_objects(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
    ) -> Result<Vec<DatabaseObject>> {
        let client = self.get_client(database).await?;
        let schema_name = schema.unwrap_or("public");
        let mut objects = Vec::new();

        // Tables, Views, Materialized Views, Sequences
        let rel_rows = client
            .query(
                "SELECT c.relname, c.relkind::text, c.reltuples::bigint, obj_description(c.oid)
                 FROM pg_class c
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
                 ORDER BY c.relname",
                &[&schema_name],
            )
            .await
            .map_err(map_pg_error)?;

        for r in rel_rows {
            let name: String = r.get(0);
            let relkind: String = r.get(1);
            let row_est: Option<i64> = r.try_get(2).ok();
            let comment: Option<String> = r.try_get(3).ok();
            let kind = match relkind.as_str() {
                "r" | "p" => ObjectKind::Table,
                "v" => ObjectKind::View,
                "m" => ObjectKind::MaterializedView,
                "S" => ObjectKind::Sequence,
                _ => continue,
            };
            objects.push(DatabaseObject {
                name,
                schema: Some(schema_name.to_string()),
                kind,
                row_estimate: row_est.filter(|&v| v >= 0),
                comment,
            });
        }

        // Functions & Procedures
        let fn_rows = client
            .query(
                "SELECT p.proname, p.prokind::text
                 FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = $1
                 ORDER BY p.proname",
                &[&schema_name],
            )
            .await
            .map_err(map_pg_error)?;
        for r in fn_rows {
            let name: String = r.get(0);
            let pk: String = r.get(1);
            objects.push(DatabaseObject {
                name,
                schema: Some(schema_name.to_string()),
                kind: if pk == "p" {
                    ObjectKind::Procedure
                } else {
                    ObjectKind::Function
                },
                row_estimate: None,
                comment: None,
            });
        }

        // Triggers
        let trg_rows = client
            .query(
                "SELECT DISTINCT trigger_name FROM information_schema.triggers WHERE trigger_schema = $1 ORDER BY trigger_name",
                &[&schema_name],
            )
            .await
            .map_err(map_pg_error)?;
        for r in trg_rows {
            objects.push(DatabaseObject {
                name: r.get(0),
                schema: Some(schema_name.to_string()),
                kind: ObjectKind::Trigger,
                row_estimate: None,
                comment: None,
            });
        }

        // Indexes
        let idx_rows = client
            .query(
                "SELECT indexname FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname",
                &[&schema_name],
            )
            .await
            .map_err(map_pg_error)?;
        for r in idx_rows {
            objects.push(DatabaseObject {
                name: r.get(0),
                schema: Some(schema_name.to_string()),
                kind: ObjectKind::Index,
                row_estimate: None,
                comment: None,
            });
        }

        // Enums / Custom Types
        let enum_rows = client
            .query(
                "SELECT t.typname FROM pg_type t
                 JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = $1 AND t.typtype = 'e'
                 ORDER BY t.typname",
                &[&schema_name],
            )
            .await
            .map_err(map_pg_error)?;
        for r in enum_rows {
            objects.push(DatabaseObject {
                name: r.get(0),
                schema: Some(schema_name.to_string()),
                kind: ObjectKind::EnumType,
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
        let client = self.get_client(database).await?;
        let schema_name = schema.unwrap_or("public");

        // Primary key columns
        let pk_rows = client
            .query(
                "SELECT a.attname
                 FROM pg_index i
                 JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                 JOIN pg_class c ON c.oid = i.indrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary",
                &[&schema_name, &table],
            )
            .await
            .map_err(map_pg_error)?;
        let pk_set: std::collections::HashSet<String> =
            pk_rows.into_iter().map(|r| r.get::<_, String>(0)).collect();

        // Columns
        let col_rows = client
            .query(
                "SELECT c.column_name, c.data_type, c.udt_name,
                        c.character_maximum_length::bigint,
                        c.numeric_precision::bigint,
                        c.numeric_scale::bigint,
                        c.is_nullable,
                        c.column_default,
                        c.is_identity,
                        col_description((quote_ident(c.table_schema)||'.'||quote_ident(c.table_name))::regclass, c.ordinal_position)
                 FROM information_schema.columns c
                 WHERE c.table_schema = $1 AND c.table_name = $2
                 ORDER BY c.ordinal_position",
                &[&schema_name, &table],
            )
            .await
            .map_err(map_pg_error)?;

        let columns: Vec<ColumnMeta> = col_rows
            .into_iter()
            .map(|r| {
                let name: String = r.get(0);
                let default_val: Option<String> = r.try_get(7).ok();
                let is_identity: String = r.try_get(8).unwrap_or_default();
                let is_auto = is_identity == "YES"
                    || default_val
                        .as_deref()
                        .map(|d| d.contains("nextval("))
                        .unwrap_or(false);
                ColumnMeta {
                    is_primary_key: pk_set.contains(&name),
                    name,
                    data_type: r.get(1),
                    udt_name: r.try_get(2).ok(),
                    max_length: r.try_get(3).ok(),
                    numeric_precision: r.try_get(4).ok(),
                    numeric_scale: r.try_get(5).ok(),
                    nullable: r.get::<_, String>(6) == "YES",
                    default_value: default_val,
                    is_auto_increment: is_auto,
                    comment: r.try_get(9).ok(),
                }
            })
            .collect();

        // Indexes
        let idx_rows = client
            .query(
                "SELECT i.relname AS index_name,
                        ix.indisunique,
                        ix.indisprimary,
                        am.amname AS method,
                        pg_get_indexdef(ix.indexrelid),
                        ARRAY(
                            SELECT a.attname
                            FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
                            JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
                            ORDER BY k.ord
                        ) AS cols
                 FROM pg_class t
                 JOIN pg_namespace n ON n.oid = t.relnamespace
                 JOIN pg_index ix ON t.oid = ix.indrelid
                 JOIN pg_class i ON i.oid = ix.indexrelid
                 JOIN pg_am am ON i.relam = am.oid
                 WHERE n.nspname = $1 AND t.relname = $2
                 ORDER BY i.relname",
                &[&schema_name, &table],
            )
            .await
            .map_err(map_pg_error)?;

        let indexes: Vec<IndexMeta> = idx_rows
            .into_iter()
            .map(|r| IndexMeta {
                name: r.get(0),
                is_unique: r.get(1),
                is_primary: r.get(2),
                method: r.get(3),
                definition: r.try_get(4).ok(),
                columns: r.try_get(5).unwrap_or_default(),
            })
            .collect();

        // Foreign keys
        let fk_rows = client
            .query(
                "SELECT tc.constraint_name,
                        kcu.column_name,
                        ccu.table_schema AS ref_schema,
                        ccu.table_name AS ref_table,
                        ccu.column_name AS ref_column,
                        rc.update_rule,
                        rc.delete_rule
                 FROM information_schema.table_constraints tc
                 JOIN information_schema.key_column_usage kcu
                   ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
                 JOIN information_schema.constraint_column_usage ccu
                   ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
                 JOIN information_schema.referential_constraints rc
                   ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
                 WHERE tc.constraint_type = 'FOREIGN KEY'
                   AND tc.table_schema = $1 AND tc.table_name = $2
                 ORDER BY tc.constraint_name, kcu.ordinal_position",
                &[&schema_name, &table],
            )
            .await
            .map_err(map_pg_error)?;

        let mut fk_map: HashMap<String, ForeignKeyMeta> = HashMap::new();
        for r in fk_rows {
            let name: String = r.get(0);
            let col: String = r.get(1);
            let ref_schema: Option<String> = r.try_get(2).ok();
            let ref_table: String = r.get(3);
            let ref_col: String = r.get(4);
            let on_update: String = r.get(5);
            let on_delete: String = r.get(6);
            let entry = fk_map.entry(name.clone()).or_insert(ForeignKeyMeta {
                name,
                columns: Vec::new(),
                ref_schema,
                ref_table,
                ref_columns: Vec::new(),
                on_update,
                on_delete,
            });
            if !entry.columns.contains(&col) {
                entry.columns.push(col);
            }
            if !entry.ref_columns.contains(&ref_col) {
                entry.ref_columns.push(ref_col);
            }
        }
        let foreign_keys: Vec<ForeignKeyMeta> = fk_map.into_values().collect();

        // Check constraints
        let chk_rows = client
            .query(
                "SELECT con.conname, pg_get_constraintdef(con.oid)
                 FROM pg_constraint con
                 JOIN pg_class rel ON rel.oid = con.conrelid
                 JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
                 WHERE nsp.nspname = $1 AND rel.relname = $2 AND con.contype = 'c'",
                &[&schema_name, &table],
            )
            .await
            .map_err(map_pg_error)?;
        let checks: Vec<CheckConstraintMeta> = chk_rows
            .into_iter()
            .map(|r| CheckConstraintMeta {
                name: r.get(0),
                expression: r.get(1),
            })
            .collect();

        let draft = TableDesignDraft {
            is_new_table: true,
            schema: Some(schema_name.to_string()),
            table_name: table.to_string(),
            columns: columns
                .iter()
                .map(|c| TableDesignColumn {
                    name: c.name.clone(),
                    original_name: Some(c.name.clone()),
                    data_type: c.udt_name.clone().unwrap_or_else(|| c.data_type.clone()),
                    length: c.max_length.map(|l| l.to_string()),
                    nullable: c.nullable,
                    default_value: c.default_value.clone(),
                    is_primary_key: c.is_primary_key,
                    is_auto_increment: c.is_auto_increment,
                    comment: c.comment.clone(),
                })
                .collect(),
            indexes: indexes.clone(),
            foreign_keys: foreign_keys.clone(),
            checks: checks.clone(),
        };
        let ddl = Some(crate::drivers::generate_table_design_ddl(
            DbEngine::Postgres,
            &draft,
        ));

        Ok(TableMetadata {
            schema: Some(schema_name.to_string()),
            name: table.to_string(),
            columns,
            indexes,
            foreign_keys,
            checks,
            row_estimate: None,
            ddl,
        })
    }

    async fn fetch_table_data(&self, req: &TableDataRequest) -> Result<QueryResultSet> {
        let start = Instant::now();
        let client = self.get_client(req.database.as_deref()).await?;
        let schema_name = req.schema.as_deref().unwrap_or("public");
        let meta = self
            .get_table_metadata(req.database.as_deref(), Some(schema_name), &req.table)
            .await?;

        let fq = qualified_table(DbEngine::Postgres, Some(schema_name), &req.table);
        let where_sql = build_where_clause(DbEngine::Postgres, &req.filters);
        let order_sql = build_order_clause(DbEngine::Postgres, &req.sorts);
        let offset = req.page.saturating_sub(1) * req.page_size;

        let count_sql = format!("SELECT COUNT(*) FROM {}{}", fq, where_sql);
        let total_count: Option<u64> = client
            .query_one(&count_sql, &[])
            .await
            .ok()
            .map(|r| r.get::<_, i64>(0) as u64);

        let data_sql = format!(
            "SELECT * FROM {}{}{} LIMIT {} OFFSET {}",
            fq, where_sql, order_sql, req.page_size, offset
        );
        let rows = client.query(&data_sql, &[]).await.map_err(map_pg_error)?;

        let pk_set: std::collections::HashSet<String> = meta
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
                .columns()
                .iter()
                .map(|c| {
                    let name = c.name().to_string();
                    ResultColumn {
                        is_primary_key: pk_set.contains(&name),
                        fk_target: fk_lookup.get(&name).cloned(),
                        name,
                        data_type: c.type_().name().to_string(),
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

        let result_rows: Vec<Vec<serde_json::Value>> = rows
            .iter()
            .map(|row| (0..row.len()).map(|i| pg_cell_to_json(row, i)).collect())
            .collect();

        Ok(QueryResultSet {
            columns,
            rows: result_rows,
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
        let client = self.get_client(database).await?;
        let cancel_token = client.cancel_token();
        {
            let mut tokens = self.cancel_tokens.lock().await;
            tokens.insert(query_id.to_string(), cancel_token);
        }

        let statements = split_sql_statements(sql);
        let mut result_sets = Vec::new();

        for stmt_sql in statements {
            let stmt_start = Instant::now();
            let upper = stmt_sql.trim_start().to_uppercase();
            let expects_rows = upper.starts_with("SELECT")
                || upper.starts_with("WITH")
                || upper.starts_with("SHOW")
                || upper.starts_with("EXPLAIN")
                || upper.starts_with("VALUES")
                || upper.contains(" RETURNING ");

            if expects_rows {
                match client.query(&stmt_sql, &[]).await {
                    Ok(rows) => {
                        let columns: Vec<ResultColumn> = if let Some(first) = rows.first() {
                            first
                                .columns()
                                .iter()
                                .map(|c| ResultColumn {
                                    name: c.name().to_string(),
                                    data_type: c.type_().name().to_string(),
                                    is_primary_key: false,
                                    fk_target: None,
                                })
                                .collect()
                        } else {
                            // Prepare to get column names even if 0 rows returned
                            client
                                .prepare(&stmt_sql)
                                .await
                                .map(|st| {
                                    st.columns()
                                        .iter()
                                        .map(|c| ResultColumn {
                                            name: c.name().to_string(),
                                            data_type: c.type_().name().to_string(),
                                            is_primary_key: false,
                                            fk_target: None,
                                        })
                                        .collect()
                                })
                                .unwrap_or_default()
                        };

                        let data_rows: Vec<Vec<serde_json::Value>> = rows
                            .iter()
                            .map(|row| (0..row.len()).map(|i| pg_cell_to_json(row, i)).collect())
                            .collect();

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
                        let mut tokens = self.cancel_tokens.lock().await;
                        tokens.remove(query_id);
                        return Err(map_pg_error(e));
                    }
                }
            } else {
                match client.execute(&stmt_sql, &[]).await {
                    Ok(affected) => {
                        result_sets.push(QueryResultSet {
                            columns: Vec::new(),
                            rows: Vec::new(),
                            rows_affected: Some(affected),
                            total_count: None,
                            execution_ms: stmt_start.elapsed().as_millis() as u64,
                            statement: stmt_sql,
                        });
                    }
                    Err(e) => {
                        let mut tokens = self.cancel_tokens.lock().await;
                        tokens.remove(query_id);
                        return Err(map_pg_error(e));
                    }
                }
            }
        }

        {
            let mut tokens = self.cancel_tokens.lock().await;
            tokens.remove(query_id);
        }

        Ok(QueryExecutionResponse {
            query_id: query_id.to_string(),
            result_sets,
            total_execution_ms: total_start.elapsed().as_millis() as u64,
        })
    }

    async fn cancel_query(&self, query_id: &str) -> Result<()> {
        let token = {
            let mut tokens = self.cancel_tokens.lock().await;
            tokens.remove(query_id)
        };
        if let Some(tok) = token {
            if let Some(tls) = self.build_tls()? {
                let _ = tok.cancel_query(tls).await;
            } else {
                let _ = tok.cancel_query(NoTls).await;
            }
        }
        Ok(())
    }

    async fn explain_query(&self, database: Option<&str>, sql: &str) -> Result<ExplainPlanResult> {
        let start = Instant::now();
        let client = self.get_client(database).await?;
        let trimmed = sql.trim().trim_end_matches(';');
        let explain_sql = format!("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {}", trimmed);
        let row = client
            .query_one(&explain_sql, &[])
            .await
            .map_err(map_pg_error)?;
        let raw_json: serde_json::Value = row.try_get(0).map_err(map_pg_error)?;
        let root = raw_json
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(|obj| obj.get("Plan"))
            .map(parse_pg_explain_node);

        Ok(ExplainPlanResult {
            root,
            raw_json,
            execution_ms: start.elapsed().as_millis() as u64,
        })
    }

    async fn apply_staged_changes(&self, req: &ApplyChangesRequest) -> Result<u64> {
        let client = self.get_client(req.database.as_deref()).await?;
        let statements = build_staged_change_sql(
            DbEngine::Postgres,
            req.schema.as_deref(),
            &req.table,
            &req.changes,
        );
        if statements.is_empty() {
            return Ok(0);
        }
        client
            .batch_execute("BEGIN;")
            .await
            .map_err(map_pg_error)?;
        let mut total_affected = 0u64;
        for stmt in &statements {
            match client.execute(stmt, &[]).await {
                Ok(n) => total_affected += n,
                Err(e) => {
                    let _ = client.batch_execute("ROLLBACK;").await;
                    return Err(map_pg_error(e));
                }
            }
        }
        client
            .batch_execute("COMMIT;")
            .await
            .map_err(map_pg_error)?;
        Ok(total_affected)
    }

    async fn get_autocomplete_schema(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
    ) -> Result<AutocompleteSchema> {
        let client = self.get_client(database).await?;
        let schema_name = schema.filter(|s| !s.is_empty()).unwrap_or("public");
        let rows = client
            .query(
                "SELECT c.relname, a.attname
                 FROM pg_catalog.pg_class c
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                 JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
                 WHERE n.nspname = $1
                   AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
                   AND a.attnum > 0
                   AND NOT a.attisdropped
                 ORDER BY c.relname, a.attnum",
                &[&schema_name],
            )
            .await
            .map_err(map_pg_error)?;
        let mut tables: HashMap<String, Vec<String>> = HashMap::new();
        for r in rows {
            let t: String = r.get(0);
            let c: String = r.get(1);
            tables.entry(t).or_default().push(c);
        }
        Ok(AutocompleteSchema { tables })
    }

    async fn execute_ddl(&self, database: Option<&str>, ddl: &str) -> Result<()> {
        let client = self.get_client(database).await?;
        client.batch_execute(ddl).await.map_err(map_pg_error)?;
        Ok(())
    }

    async fn truncate_table(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
        table: &str,
    ) -> Result<()> {
        let client = self.get_client(database).await?;
        let fq = qualified_table(DbEngine::Postgres, schema, table);
        client
            .execute(&format!("TRUNCATE TABLE {}", fq), &[])
            .await
            .map_err(map_pg_error)?;
        Ok(())
    }

    async fn drop_object(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
        name: &str,
        kind: ObjectKind,
    ) -> Result<()> {
        let client = self.get_client(database).await?;
        let sc = schema
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("public");
        let fq = qualified_table(DbEngine::Postgres, Some(sc), name);

        match kind {
            ObjectKind::Trigger => {
                let row = client
                    .query_opt(
                        "SELECT c.relname
                         FROM pg_trigger t
                         JOIN pg_class c ON t.tgrelid = c.oid
                         JOIN pg_namespace n ON c.relnamespace = n.oid
                         WHERE t.tgname = $1 AND n.nspname = $2 AND NOT t.tgisinternal
                         LIMIT 1",
                        &[&name, &sc],
                    )
                    .await
                    .map_err(map_pg_error)?;
                let table_name: String = row
                    .map(|r| r.get(0))
                    .ok_or_else(|| DbaError::Database {
                        message: format!(
                            "Could not locate owning table for trigger \"{}\" in schema \"{}\"",
                            name, sc
                        ),
                        code: None,
                        detail: None,
                        line: None,
                    })?;
                let sql = format!(
                    "DROP TRIGGER {} ON {}",
                    quote_ident(DbEngine::Postgres, name),
                    qualified_table(DbEngine::Postgres, Some(sc), &table_name)
                );
                client.execute(&sql, &[]).await.map_err(map_pg_error)?;
                return Ok(());
            }
            ObjectKind::Function | ObjectKind::Procedure => {
                let keyword = if matches!(kind, ObjectKind::Procedure) {
                    "PROCEDURE"
                } else {
                    "FUNCTION"
                };
                let row = client
                    .query_opt(
                        "SELECT pg_get_function_identity_arguments(p.oid)
                         FROM pg_proc p
                         JOIN pg_namespace n ON p.pronamespace = n.oid
                         WHERE p.proname = $1 AND n.nspname = $2
                         ORDER BY p.oid
                         LIMIT 1",
                        &[&name, &sc],
                    )
                    .await
                    .map_err(map_pg_error)?;
                let sql = if let Some(r) = row {
                    let args: String = r.get(0);
                    format!("DROP {} {}({})", keyword, fq, args)
                } else {
                    format!("DROP {} {}", keyword, fq)
                };
                client.execute(&sql, &[]).await.map_err(map_pg_error)?;
                return Ok(());
            }
            _ => {}
        }

        let keyword = match kind {
            ObjectKind::Table => "TABLE",
            ObjectKind::View => "VIEW",
            ObjectKind::MaterializedView => "MATERIALIZED VIEW",
            ObjectKind::Sequence => "SEQUENCE",
            ObjectKind::Index => "INDEX",
            ObjectKind::EnumType => "TYPE",
            _ => "TABLE",
        };
        client
            .execute(&format!("DROP {} {}", keyword, fq), &[])
            .await
            .map_err(map_pg_error)?;
        Ok(())
    }

    async fn rename_table(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
        old_name: &str,
        new_name: &str,
    ) -> Result<()> {
        let client = self.get_client(database).await?;
        let fq_old = qualified_table(DbEngine::Postgres, schema, old_name);
        let sql = format!(
            "ALTER TABLE {} RENAME TO {}",
            fq_old,
            quote_ident(DbEngine::Postgres, new_name)
        );
        client.execute(&sql, &[]).await.map_err(map_pg_error)?;
        Ok(())
    }

    async fn create_schema(&self, database: Option<&str>, name: &str) -> Result<()> {
        let client = self.get_client(database).await?;
        let sql = format!("CREATE SCHEMA {}", quote_ident(DbEngine::Postgres, name));
        client.execute(&sql, &[]).await.map_err(map_pg_error)?;
        Ok(())
    }

    async fn drop_schema(&self, database: Option<&str>, name: &str, cascade: bool) -> Result<()> {
        let client = self.get_client(database).await?;
        let sql = if cascade {
            format!("DROP SCHEMA {} CASCADE", quote_ident(DbEngine::Postgres, name))
        } else {
            format!("DROP SCHEMA {}", quote_ident(DbEngine::Postgres, name))
        };
        client.execute(&sql, &[]).await.map_err(map_pg_error)?;
        Ok(())
    }

    async fn create_database(
        &self,
        name: &str,
        charset: Option<&str>,
        _collation: Option<&str>,
    ) -> Result<()> {
        let client = self.get_client(None).await?;
        let mut sql = format!("CREATE DATABASE {}", quote_ident(DbEngine::Postgres, name));
        if let Some(enc) = charset.map(str::trim).filter(|s| !s.is_empty()) {
            let safe_enc = crate::drivers::validate_sql_option_token(enc, "encoding")?;
            sql.push_str(&format!(" WITH ENCODING '{}'", safe_enc));
        }
        client.execute(&sql, &[]).await.map_err(map_pg_error)?;
        Ok(())
    }

    async fn drop_database(&self, name: &str) -> Result<()> {
        let client = self.get_client(None).await?;
        client
            .execute(
                &format!("DROP DATABASE {}", quote_ident(DbEngine::Postgres, name)),
                &[],
            )
            .await
            .map_err(map_pg_error)?;
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
        let client = self.get_client(database).await?;
        let src = qualified_table(DbEngine::Postgres, schema, source);
        let dst = qualified_table(DbEngine::Postgres, schema, target);
        let sql = if with_data {
            format!("CREATE TABLE {} AS TABLE {}", dst, src)
        } else {
            format!("CREATE TABLE {} (LIKE {} INCLUDING ALL)", dst, src)
        };
        client.execute(&sql, &[]).await.map_err(map_pg_error)?;
        let _ = quote_ident(DbEngine::Postgres, target);
        Ok(())
    }

    async fn get_object_ddl(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
        name: &str,
        kind: ObjectKind,
    ) -> Result<String> {
        let client = self.get_client(database).await?;
        let schema_name = schema.unwrap_or("public");
        let fq = qualified_table(DbEngine::Postgres, Some(schema_name), name);

        match kind {
            ObjectKind::View => {
                let row = client
                    .query_opt(
                        "SELECT pg_get_viewdef(c.oid, true)
                         FROM pg_class c
                         JOIN pg_namespace n ON n.oid = c.relnamespace
                         WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'v'",
                        &[&schema_name, &name],
                    )
                    .await
                    .map_err(map_pg_error)?
                    .ok_or_else(|| DbaError::Database {
                        message: format!("View '{}' not found", name),
                        code: None,
                        detail: None,
                        line: None,
                    })?;
                let def: String = row.get(0);
                Ok(format!("CREATE OR REPLACE VIEW {} AS\n{}", fq, def))
            }
            ObjectKind::MaterializedView => {
                let row = client
                    .query_opt(
                        "SELECT pg_get_viewdef(c.oid, true)
                         FROM pg_class c
                         JOIN pg_namespace n ON n.oid = c.relnamespace
                         WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'm'",
                        &[&schema_name, &name],
                    )
                    .await
                    .map_err(map_pg_error)?
                    .ok_or_else(|| DbaError::Database {
                        message: format!("Materialized view '{}' not found", name),
                        code: None,
                        detail: None,
                        line: None,
                    })?;
                let def: String = row.get(0);
                Ok(format!("CREATE MATERIALIZED VIEW {} AS\n{}", fq, def))
            }
            ObjectKind::Function | ObjectKind::Procedure => {
                let row = client
                    .query_opt(
                        "SELECT pg_get_functiondef(p.oid)
                         FROM pg_proc p
                         JOIN pg_namespace n ON n.oid = p.pronamespace
                         WHERE n.nspname = $1 AND p.proname = $2
                         LIMIT 1",
                        &[&schema_name, &name],
                    )
                    .await
                    .map_err(map_pg_error)?
                    .ok_or_else(|| DbaError::Database {
                        message: format!("Routine '{}' not found", name),
                        code: None,
                        detail: None,
                        line: None,
                    })?;
                let def: String = row.get(0);
                Ok(def)
            }
            ObjectKind::Trigger => {
                let row = client
                    .query_opt(
                        "SELECT pg_get_triggerdef(t.oid, true)
                         FROM pg_trigger t
                         JOIN pg_class c ON c.oid = t.tgrelid
                         JOIN pg_namespace n ON n.oid = c.relnamespace
                         WHERE n.nspname = $1 AND t.tgname = $2 AND NOT t.tgisinternal
                         LIMIT 1",
                        &[&schema_name, &name],
                    )
                    .await
                    .map_err(map_pg_error)?
                    .ok_or_else(|| DbaError::Database {
                        message: format!("Trigger '{}' not found", name),
                        code: None,
                        detail: None,
                        line: None,
                    })?;
                let def: String = row.get(0);
                Ok(def)
            }
            ObjectKind::Sequence => {
                let row = client
                    .query_opt(
                        "SELECT start_value::bigint, increment_by::bigint, min_value::bigint, max_value::bigint, cache_size::bigint, cycle
                         FROM pg_sequences
                         WHERE schemaname = $1 AND sequencename = $2",
                        &[&schema_name, &name],
                    )
                    .await
                    .map_err(map_pg_error)?
                    .ok_or_else(|| DbaError::Database {
                        message: format!("Sequence '{}' not found", name),
                        code: None,
                        detail: None,
                        line: None,
                    })?;
                let start: i64 = row.get(0);
                let inc: i64 = row.get(1);
                let min_v: i64 = row.get(2);
                let max_v: i64 = row.get(3);
                let cache: i64 = row.get(4);
                let cycle: bool = row.get(5);
                let cycle_sql = if cycle { "CYCLE" } else { "NO CYCLE" };
                Ok(format!(
                    "CREATE SEQUENCE IF NOT EXISTS {} START WITH {} INCREMENT BY {} MINVALUE {} MAXVALUE {} CACHE {} {};",
                    fq, start, inc, min_v, max_v, cache, cycle_sql
                ))
            }
            ObjectKind::EnumType => {
                let row = client
                    .query_opt(
                        "SELECT string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder)
                         FROM pg_type t
                         JOIN pg_namespace n ON n.oid = t.typnamespace
                         JOIN pg_enum e ON e.enumtypid = t.oid
                         WHERE n.nspname = $1 AND t.typname = $2",
                        &[&schema_name, &name],
                    )
                    .await
                    .map_err(map_pg_error)?
                    .ok_or_else(|| DbaError::Database {
                        message: format!("Enum type '{}' not found", name),
                        code: None,
                        detail: None,
                        line: None,
                    })?;
                let labels: Option<String> = row.get(0);
                let labels = labels.ok_or_else(|| DbaError::Database {
                    message: format!("Enum type '{}' has no labels", name),
                    code: None,
                    detail: None,
                    line: None,
                })?;
                Ok(format!("CREATE TYPE {} AS ENUM ({});", fq, labels))
            }
            _ => Err(DbaError::UnsupportedEngine(format!(
                "PostgreSQL DDL extraction is not supported for {:?}",
                kind
            ))),
        }
    }
}
