use crate::drivers::{
    build_order_clause, build_staged_change_sql, build_where_clause, generate_table_design_ddl,
    is_compound_ddl, qualified_table, split_sql_statements, SqlDriver,
};
use crate::error::{DatavaultError, Result};
use crate::models::*;
use async_trait::async_trait;
use chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime};
use regex::Regex;
use std::collections::HashMap;
use std::time::Instant;
use tiberius::{AuthMethod, Client, ColumnData, Config, EncryptionLevel, Row};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

type MssqlClient = Client<Compat<TcpStream>>;

pub struct MssqlDriver {
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    default_db: Option<String>,
    ssl: SslConfig,
    active_spids: Mutex<HashMap<String, i16>>,
}

impl MssqlDriver {
    pub async fn connect(
        host: String,
        port: u16,
        username: String,
        password: Option<String>,
        database: Option<String>,
        ssl: SslConfig,
    ) -> Result<Self> {
        let driver = Self {
            host,
            port,
            username,
            password,
            default_db: database.filter(|s| !s.trim().is_empty()),
            ssl,
            active_spids: Mutex::new(HashMap::new()),
        };
        // Verify connectivity immediately
        let mut client = driver.open_client(driver.default_db.as_deref()).await?;
        let _ = client
            .simple_query("SELECT 1")
            .await
            .map_err(map_mssql_error)?
            .into_first_result()
            .await
            .map_err(map_mssql_error)?;
        Ok(driver)
    }

    async fn open_client(&self, database: Option<&str>) -> Result<MssqlClient> {
        let mut cfg = Config::new();
        cfg.host(&self.host);
        cfg.port(self.port);
        cfg.authentication(AuthMethod::sql_server(
            &self.username,
            self.password.as_deref().unwrap_or(""),
        ));

        if let Some(db) = database
            .filter(|s| !s.trim().is_empty())
            .or(self.default_db.as_deref())
        {
            cfg.database(db);
        }

        match self.ssl.mode {
            SslMode::Disable => {
                cfg.encryption(EncryptionLevel::NotSupported);
            }
            SslMode::Prefer => {
                cfg.encryption(EncryptionLevel::On);
                cfg.trust_cert();
            }
            SslMode::Require => {
                cfg.encryption(EncryptionLevel::Required);
                cfg.trust_cert();
            }
            SslMode::VerifyCa | SslMode::VerifyFull => {
                cfg.encryption(EncryptionLevel::Required);
                if let Some(ref ca) = self.ssl.ca_cert_path {
                    if !ca.trim().is_empty() {
                        cfg.trust_cert_ca(ca.trim());
                    }
                }
            }
        }

        let tcp = TcpStream::connect(cfg.get_addr()).await.map_err(|e| {
            DatavaultError::Database {
                message: format!("Failed to connect to SQL Server {}:{}: {}", self.host, self.port, e),
                code: None,
                detail: None,
                line: None,
            }
        })?;
        let _ = tcp.set_nodelay(true);

        Client::connect(cfg, tcp.compat_write())
            .await
            .map_err(map_mssql_error)
    }

    fn effective_schema<'a>(&self, schema: Option<&'a str>) -> &'a str {
        schema.filter(|s| !s.trim().is_empty()).unwrap_or("dbo")
    }
}

fn map_mssql_error(err: tiberius::error::Error) -> DatavaultError {
    match &err {
        tiberius::error::Error::Server(srv) => DatavaultError::Database {
            message: srv.message().to_string(),
            code: Some(format!("MSSQL {}", srv.code())),
            detail: Some(format!(
                "State {}, Class {}",
                srv.state(),
                srv.class()
            )),
            line: Some(srv.line()),
        },
        _ => DatavaultError::Database {
            message: err.to_string(),
            code: None,
            detail: None,
            line: None,
        },
    }
}

fn mssql_cell_to_json(row: &Row, idx: usize, data: &ColumnData<'_>) -> serde_json::Value {
    match data {
        ColumnData::U8(v) => v.map(serde_json::Value::from).unwrap_or(serde_json::Value::Null),
        ColumnData::I16(v) => v.map(serde_json::Value::from).unwrap_or(serde_json::Value::Null),
        ColumnData::I32(v) => v.map(serde_json::Value::from).unwrap_or(serde_json::Value::Null),
        ColumnData::I64(v) => v.map(serde_json::Value::from).unwrap_or(serde_json::Value::Null),
        ColumnData::F32(v) => v
            .and_then(|f| serde_json::Number::from_f64(f as f64).map(serde_json::Value::Number))
            .unwrap_or(serde_json::Value::Null),
        ColumnData::F64(v) => v
            .and_then(|f| serde_json::Number::from_f64(f).map(serde_json::Value::Number))
            .unwrap_or(serde_json::Value::Null),
        ColumnData::Bit(v) => v.map(serde_json::Value::from).unwrap_or(serde_json::Value::Null),
        ColumnData::String(v) => v
            .as_ref()
            .map(|s| serde_json::Value::String(s.to_string()))
            .unwrap_or(serde_json::Value::Null),
        ColumnData::Guid(v) => v
            .map(|u| serde_json::Value::String(u.to_string()))
            .unwrap_or(serde_json::Value::Null),
        ColumnData::Binary(v) => v
            .as_ref()
            .map(|b| {
                let hex: String = b.iter().map(|byte| format!("{:02x}", byte)).collect();
                serde_json::Value::String(format!("0x{}", hex))
            })
            .unwrap_or(serde_json::Value::Null),
        ColumnData::Numeric(v) => v
            .map(|n| serde_json::Value::String(n.to_string()))
            .unwrap_or(serde_json::Value::Null),
        ColumnData::Xml(v) => v
            .as_ref()
            .map(|x| serde_json::Value::String(x.to_string()))
            .unwrap_or(serde_json::Value::Null),
        ColumnData::DateTime(_) | ColumnData::SmallDateTime(_) | ColumnData::DateTime2(_) => {
            if let Ok(Some(dt)) = row.try_get::<NaiveDateTime, _>(idx) {
                serde_json::Value::String(dt.format("%Y-%m-%d %H:%M:%S%.3f").to_string())
            } else {
                serde_json::Value::Null
            }
        }
        ColumnData::Date(_) => {
            if let Ok(Some(d)) = row.try_get::<NaiveDate, _>(idx) {
                serde_json::Value::String(d.to_string())
            } else {
                serde_json::Value::Null
            }
        }
        ColumnData::Time(_) => {
            if let Ok(Some(t)) = row.try_get::<NaiveTime, _>(idx) {
                serde_json::Value::String(t.to_string())
            } else {
                serde_json::Value::Null
            }
        }
        ColumnData::DateTimeOffset(_) => {
            if let Ok(Some(dto)) = row.try_get::<DateTime<FixedOffset>, _>(idx) {
                serde_json::Value::String(dto.to_rfc3339())
            } else {
                serde_json::Value::Null
            }
        }
    }
}

fn mssql_rows_to_result_set(
    rows: &[Row],
    statement: String,
    execution_ms: u64,
) -> QueryResultSet {
    let columns: Vec<ResultColumn> = rows
        .first()
        .map(|r| {
            r.columns()
                .iter()
                .map(|c| ResultColumn {
                    name: c.name().to_string(),
                    data_type: format!("{:?}", c.column_type()),
                    is_primary_key: false,
                    fk_target: None,
                })
                .collect()
        })
        .unwrap_or_default();

    let mut json_rows = Vec::with_capacity(rows.len());
    for row in rows {
        let mut vals = Vec::with_capacity(columns.len());
        for (idx, (_, cell)) in row.cells().enumerate() {
            vals.push(mssql_cell_to_json(row, idx, cell));
        }
        json_rows.push(vals);
    }

    QueryResultSet {
        columns,
        rows: json_rows,
        rows_affected: None,
        total_count: None,
        execution_ms,
        statement,
    }
}

/// Parses SQL Server SHOWPLAN_XML into an ExplainNode tree.
fn parse_showplan_xml(xml: &str) -> Option<ExplainNode> {
    let re_relop = Regex::new(r#"<RelOp\s+([^>]+)>"#).ok()?;
    let re_attr = Regex::new(r#"(\w+)="([^"]*)""#).ok()?;
    let re_obj = Regex::new(r#"<Object[^>]*Table="\[?([^"\]]+)\]?""#).ok()?;

    let mut nodes: Vec<ExplainNode> = Vec::new();
    let table_names: Vec<String> = re_obj
        .captures_iter(xml)
        .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))
        .collect();

    for (idx, cap) in re_relop.captures_iter(xml).enumerate() {
        let attrs_str = cap.get(1)?.as_str();
        let mut attrs: HashMap<String, String> = HashMap::new();
        for a in re_attr.captures_iter(attrs_str) {
            if let (Some(k), Some(v)) = (a.get(1), a.get(2)) {
                attrs.insert(k.as_str().to_string(), v.as_str().to_string());
            }
        }
        let physical_op = attrs
            .get("PhysicalOp")
            .cloned()
            .unwrap_or_else(|| "RelOp".into());
        let logical_op = attrs.get("LogicalOp").cloned().unwrap_or_default();
        let node_type = if !logical_op.is_empty() && logical_op != physical_op {
            format!("{} ({})", physical_op, logical_op)
        } else {
            physical_op.clone()
        };
        let is_full_scan = physical_op.contains("Table Scan")
            || physical_op.contains("Clustered Index Scan")
            || physical_op.contains("Index Scan");

        let total_cost = attrs
            .get("EstimatedTotalSubtreeCost")
            .and_then(|s| s.parse::<f64>().ok());
        let plan_rows = attrs
            .get("EstimateRows")
            .and_then(|s| s.parse::<f64>().ok());
        let extra = attrs
            .get("EstimateCPU")
            .map(|cpu| format!("Est. CPU: {}, Est. IO: {}", cpu, attrs.get("EstimateIO").map(String::as_str).unwrap_or("0")));

        nodes.push(ExplainNode {
            node_type,
            relation: table_names.get(idx).cloned(),
            startup_cost: None,
            total_cost,
            plan_rows,
            actual_time_ms: None,
            actual_rows: None,
            is_full_scan,
            extra,
            children: Vec::new(),
        });
    }

    if nodes.is_empty() {
        return None;
    }

    // Nest sequential RelOps as a parent -> child chain when XML nesting is flattened
    let mut root = nodes.remove(0);
    let mut current = &mut root;
    for child in nodes {
        current.children.push(child);
        current = &mut current.children[0];
    }
    Some(root)
}

#[async_trait]
impl SqlDriver for MssqlDriver {
    async fn server_version(&self) -> Result<String> {
        let mut client = self.open_client(None).await?;
        let rows = client
            .simple_query("SELECT @@VERSION")
            .await
            .map_err(map_mssql_error)?
            .into_first_result()
            .await
            .map_err(map_mssql_error)?;
        let ver = rows
            .first()
            .and_then(|r| r.get::<&str, _>(0))
            .unwrap_or("Microsoft SQL Server")
            .lines()
            .next()
            .unwrap_or("Microsoft SQL Server")
            .to_string();
        Ok(ver)
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let mut client = self.open_client(Some("master")).await?;
        let rows = client
            .simple_query(
                "SELECT d.name, CAST(SUM(mf.size) AS BIGINT) * 8192 AS size_bytes
                 FROM sys.databases d
                 LEFT JOIN sys.master_files mf ON d.database_id = mf.database_id
                 WHERE d.state_desc = 'ONLINE'
                 GROUP BY d.name
                 ORDER BY d.name",
            )
            .await
            .map_err(map_mssql_error)?
            .into_first_result()
            .await
            .map_err(map_mssql_error)?;

        Ok(rows
            .into_iter()
            .filter_map(|r| {
                let name = r.get::<&str, _>(0)?.to_string();
                let size_bytes = r.get::<i64, _>(1);
                Some(DatabaseInfo { name, size_bytes })
            })
            .collect())
    }

    async fn list_schemas(&self, database: Option<&str>) -> Result<Vec<SchemaInfo>> {
        let mut client = self.open_client(database).await?;
        let rows = client
            .simple_query(
                "SELECT name FROM sys.schemas
                 WHERE name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest', 'db_owner',
                   'db_accessadmin', 'db_securityadmin', 'db_ddladmin', 'db_backupoperator',
                   'db_datareader', 'db_datawriter', 'db_denydatareader', 'db_denydatawriter')
                 ORDER BY CASE WHEN name = 'dbo' THEN 0 ELSE 1 END, name",
            )
            .await
            .map_err(map_mssql_error)?
            .into_first_result()
            .await
            .map_err(map_mssql_error)?;

        Ok(rows
            .into_iter()
            .filter_map(|r| {
                r.get::<&str, _>(0)
                    .map(|s| SchemaInfo { name: s.to_string() })
            })
            .collect())
    }

    async fn list_objects(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
    ) -> Result<Vec<DatabaseObject>> {
        let sc = self.effective_schema(schema);
        let sc_lit = sc.replace('\'', "''");
        let mut client = self.open_client(database).await?;
        let mut out = Vec::new();

        // Tables with row estimates
        let t_rows = client
            .simple_query(format!(
                "SELECT t.name, CAST(SUM(p.rows) AS BIGINT) AS row_est
                 FROM sys.tables t
                 INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
                 LEFT JOIN sys.partitions p ON t.object_id = p.object_id AND p.index_id IN (0, 1)
                 WHERE s.name = '{}'
                 GROUP BY t.name
                 ORDER BY t.name",
                sc_lit
            ))
            .await
            .map_err(map_mssql_error)?
            .into_first_result()
            .await
            .map_err(map_mssql_error)?;

        for r in t_rows {
            if let Some(name) = r.get::<&str, _>(0) {
                out.push(DatabaseObject {
                    name: name.to_string(),
                    schema: Some(sc.to_string()),
                    kind: ObjectKind::Table,
                    row_estimate: r.get::<i64, _>(1),
                    comment: None,
                });
            }
        }

        // Views
        let v_rows = client
            .simple_query(format!(
                "SELECT v.name FROM sys.views v
                 INNER JOIN sys.schemas s ON v.schema_id = s.schema_id
                 WHERE s.name = '{}' ORDER BY v.name",
                sc_lit
            ))
            .await
            .map_err(map_mssql_error)?
            .into_first_result()
            .await
            .map_err(map_mssql_error)?;

        for r in v_rows {
            if let Some(name) = r.get::<&str, _>(0) {
                out.push(DatabaseObject {
                    name: name.to_string(),
                    schema: Some(sc.to_string()),
                    kind: ObjectKind::View,
                    row_estimate: None,
                    comment: None,
                });
            }
        }

        // Stored Procedures
        let p_rows = client
            .simple_query(format!(
                "SELECT p.name FROM sys.procedures p
                 INNER JOIN sys.schemas s ON p.schema_id = s.schema_id
                 WHERE s.name = '{}' ORDER BY p.name",
                sc_lit
            ))
            .await
            .map_err(map_mssql_error)?
            .into_first_result()
            .await
            .map_err(map_mssql_error)?;

        for r in p_rows {
            if let Some(name) = r.get::<&str, _>(0) {
                out.push(DatabaseObject {
                    name: name.to_string(),
                    schema: Some(sc.to_string()),
                    kind: ObjectKind::Procedure,
                    row_estimate: None,
                    comment: None,
                });
            }
        }

        // Functions
        let f_rows = client
            .simple_query(format!(
                "SELECT o.name FROM sys.objects o
                 INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                 WHERE s.name = '{}' AND o.type IN ('FN', 'IF', 'TF')
                 ORDER BY o.name",
                sc_lit
            ))
            .await
            .map_err(map_mssql_error)?
            .into_first_result()
            .await
            .map_err(map_mssql_error)?;

        for r in f_rows {
            if let Some(name) = r.get::<&str, _>(0) {
                out.push(DatabaseObject {
                    name: name.to_string(),
                    schema: Some(sc.to_string()),
                    kind: ObjectKind::Function,
                    row_estimate: None,
                    comment: None,
                });
            }
        }

        // Triggers
        let tr_rows = client
            .simple_query(format!(
                "SELECT tr.name FROM sys.triggers tr
                 INNER JOIN sys.tables t ON tr.parent_id = t.object_id
                 INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
                 WHERE s.name = '{}' ORDER BY tr.name",
                sc_lit
            ))
            .await
            .map_err(map_mssql_error)?
            .into_first_result()
            .await
            .map_err(map_mssql_error)?;

        for r in tr_rows {
            if let Some(name) = r.get::<&str, _>(0) {
                out.push(DatabaseObject {
                    name: name.to_string(),
                    schema: Some(sc.to_string()),
                    kind: ObjectKind::Trigger,
                    row_estimate: None,
                    comment: None,
                });
            }
        }

        // Indexes
        let idx_rows = client
            .simple_query(format!(
                "SELECT i.name FROM sys.indexes i
                 INNER JOIN sys.tables t ON i.object_id = t.object_id
                 INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
                 WHERE s.name = '{}' AND i.name IS NOT NULL
                 ORDER BY i.name",
                sc_lit
            ))
            .await
            .map_err(map_mssql_error)?
            .into_first_result()
            .await
            .map_err(map_mssql_error)?;

        for r in idx_rows {
            if let Some(name) = r.get::<&str, _>(0) {
                out.push(DatabaseObject {
                    name: name.to_string(),
                    schema: Some(sc.to_string()),
                    kind: ObjectKind::Index,
                    row_estimate: None,
                    comment: None,
                });
            }
        }

        Ok(out)
    }

    async fn get_table_metadata(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
        table: &str,
    ) -> Result<TableMetadata> {
        let sc = self.effective_schema(schema);
        let sc_lit = sc.replace('\'', "''");
        let tbl_lit = table.replace('\'', "''");
        let mut client = self.open_client(database).await?;

        // Columns + PK + Identity
        let col_rows = client
            .simple_query(format!(
                "SELECT c.name, ty.name AS data_type,
                        CAST(c.max_length AS BIGINT) AS max_len,
                        CAST(c.precision AS BIGINT) AS prec,
                        CAST(c.scale AS BIGINT) AS scale,
                        c.is_nullable,
                        dc.definition AS default_val,
                        c.is_identity,
                        CASE WHEN pk.column_id IS NOT NULL THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END AS is_pk
                 FROM sys.columns c
                 INNER JOIN sys.tables t ON c.object_id = t.object_id
                 INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
                 INNER JOIN sys.types ty ON c.user_type_id = ty.user_type_id
                 LEFT JOIN sys.default_constraints dc ON c.default_object_id = dc.object_id
                 LEFT JOIN (
                     SELECT ic.object_id, ic.column_id
                     FROM sys.indexes i
                     INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                     WHERE i.is_primary_key = 1
                 ) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
                 WHERE s.name = '{}' AND t.name = '{}'
                 ORDER BY c.column_id",
                sc_lit, tbl_lit
            ))
            .await
            .map_err(map_mssql_error)?
            .into_first_result()
            .await
            .map_err(map_mssql_error)?;

        let mut columns = Vec::new();
        for r in col_rows {
            let name = r.get::<&str, _>(0).unwrap_or("").to_string();
            let data_type = r.get::<&str, _>(1).unwrap_or("nvarchar").to_string();
            let raw_len = r.get::<i64, _>(2);
            let max_length = match raw_len {
                Some(l) if l > 0 => {
                    if data_type.eq_ignore_ascii_case("nvarchar")
                        || data_type.eq_ignore_ascii_case("nchar")
                    {
                        Some(l / 2)
                    } else {
                        Some(l)
                    }
                }
                _ => None,
            };
            columns.push(ColumnMeta {
                name,
                data_type: data_type.clone(),
                udt_name: Some(data_type),
                max_length,
                numeric_precision: r.get::<i64, _>(3),
                numeric_scale: r.get::<i64, _>(4),
                nullable: r.get::<bool, _>(5).unwrap_or(true),
                default_value: r.get::<&str, _>(6).map(|s| s.to_string()),
                is_auto_increment: r.get::<bool, _>(7).unwrap_or(false),
                is_primary_key: r.get::<bool, _>(8).unwrap_or(false),
                comment: None,
            });
        }

        // Indexes
        let idx_rows = client
            .simple_query(format!(
                "SELECT i.name, i.is_unique, i.is_primary_key, i.type_desc, c.name AS col_name
                 FROM sys.indexes i
                 INNER JOIN sys.tables t ON i.object_id = t.object_id
                 INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
                 INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                 INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
                 WHERE s.name = '{}' AND t.name = '{}' AND i.name IS NOT NULL
                 ORDER BY i.name, ic.key_ordinal",
                sc_lit, tbl_lit
            ))
            .await
            .map_err(map_mssql_error)?
            .into_first_result()
            .await
            .map_err(map_mssql_error)?;

        let mut idx_map: HashMap<String, IndexMeta> = HashMap::new();
        for r in idx_rows {
            let name = r.get::<&str, _>(0).unwrap_or("").to_string();
            let col = r.get::<&str, _>(4).unwrap_or("").to_string();
            let entry = idx_map.entry(name.clone()).or_insert_with(|| IndexMeta {
                name,
                columns: Vec::new(),
                is_unique: r.get::<bool, _>(1).unwrap_or(false),
                is_primary: r.get::<bool, _>(2).unwrap_or(false),
                method: r.get::<&str, _>(3).unwrap_or("NONCLUSTERED").to_string(),
                definition: None,
            });
            entry.columns.push(col);
        }
        let indexes: Vec<IndexMeta> = idx_map.into_values().collect();

        // Foreign Keys
        let fk_rows = client
            .simple_query(format!(
                "SELECT fk.name, pc.name AS col_name, rs.name AS ref_schema, rt.name AS ref_table,
                        rc.name AS ref_col, fk.update_referential_action_desc, fk.delete_referential_action_desc
                 FROM sys.foreign_keys fk
                 INNER JOIN sys.tables pt ON fk.parent_object_id = pt.object_id
                 INNER JOIN sys.schemas ps ON pt.schema_id = ps.schema_id
                 INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
                 INNER JOIN sys.columns pc ON fkc.parent_object_id = pc.object_id AND fkc.parent_column_id = pc.column_id
                 INNER JOIN sys.tables rt ON fk.referenced_object_id = rt.object_id
                 INNER JOIN sys.schemas rs ON rt.schema_id = rs.schema_id
                 INNER JOIN sys.columns rc ON fkc.referenced_object_id = rc.object_id AND fkc.referenced_column_id = rc.column_id
                 WHERE ps.name = '{}' AND pt.name = '{}'
                 ORDER BY fk.name, fkc.constraint_column_id",
                sc_lit, tbl_lit
            ))
            .await
            .map_err(map_mssql_error)?
            .into_first_result()
            .await
            .map_err(map_mssql_error)?;

        let mut fk_map: HashMap<String, ForeignKeyMeta> = HashMap::new();
        for r in fk_rows {
            let name = r.get::<&str, _>(0).unwrap_or("").to_string();
            let col = r.get::<&str, _>(1).unwrap_or("").to_string();
            let ref_col = r.get::<&str, _>(4).unwrap_or("").to_string();
            let entry = fk_map.entry(name.clone()).or_insert_with(|| ForeignKeyMeta {
                name,
                columns: Vec::new(),
                ref_schema: r.get::<&str, _>(2).map(|s| s.to_string()),
                ref_table: r.get::<&str, _>(3).unwrap_or("").to_string(),
                ref_columns: Vec::new(),
                on_update: r
                    .get::<&str, _>(5)
                    .unwrap_or("NO_ACTION")
                    .replace('_', " "),
                on_delete: r
                    .get::<&str, _>(6)
                    .unwrap_or("NO_ACTION")
                    .replace('_', " "),
            });
            entry.columns.push(col);
            entry.ref_columns.push(ref_col);
        }
        let foreign_keys: Vec<ForeignKeyMeta> = fk_map.into_values().collect();

        // Check Constraints
        let chk_rows = client
            .simple_query(format!(
                "SELECT cc.name, cc.definition
                 FROM sys.check_constraints cc
                 INNER JOIN sys.tables t ON cc.parent_object_id = t.object_id
                 INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
                 WHERE s.name = '{}' AND t.name = '{}'",
                sc_lit, tbl_lit
            ))
            .await
            .map_err(map_mssql_error)?
            .into_first_result()
            .await
            .map_err(map_mssql_error)?;

        let checks: Vec<CheckConstraintMeta> = chk_rows
            .into_iter()
            .map(|r| CheckConstraintMeta {
                name: r.get::<&str, _>(0).unwrap_or("").to_string(),
                expression: r.get::<&str, _>(1).unwrap_or("").to_string(),
            })
            .collect();

        let draft = TableDesignDraft {
            is_new_table: true,
            schema: Some(sc.to_string()),
            table_name: table.to_string(),
            columns: columns
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
                .collect(),
            indexes: indexes.clone(),
            foreign_keys: foreign_keys.clone(),
            checks: checks.clone(),
        };
        let ddl = Some(generate_table_design_ddl(DbEngine::Mssql, &draft));

        Ok(TableMetadata {
            schema: Some(sc.to_string()),
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
        let sc = self.effective_schema(req.schema.as_deref());
        let fq = qualified_table(DbEngine::Mssql, Some(sc), &req.table);
        let where_sql = build_where_clause(DbEngine::Mssql, &req.filters);
        let order_sql = if req.sorts.is_empty() {
            " ORDER BY (SELECT NULL)".to_string()
        } else {
            build_order_clause(DbEngine::Mssql, &req.sorts)
        };
        let page = req.page.max(1);
        let page_size = req.page_size.clamp(1, 5000);
        let offset = (page - 1) * page_size;

        let meta = self
            .get_table_metadata(req.database.as_deref(), Some(sc), &req.table)
            .await
            .ok();

        let mut client = self.open_client(req.database.as_deref()).await?;

        let count_sql = format!("SELECT CAST(COUNT(*) AS BIGINT) FROM {}{}", fq, where_sql);
        let total_count = match client.simple_query(&count_sql).await {
            Ok(stream) => stream
                .into_first_result()
                .await
                .ok()
                .and_then(|rows| rows.first().and_then(|r| r.get::<i64, _>(0)))
                .map(|c| c.max(0) as u64),
            Err(_) => None,
        };

        // T-SQL OFFSET FETCH pagination
        let data_sql = format!(
            "SELECT * FROM {}{}{} OFFSET {} ROWS FETCH NEXT {} ROWS ONLY",
            fq, where_sql, order_sql, offset, page_size
        );
        let rows = client
            .simple_query(&data_sql)
            .await
            .map_err(map_mssql_error)?
            .into_first_result()
            .await
            .map_err(map_mssql_error)?;

        let mut rs = mssql_rows_to_result_set(&rows, data_sql, start.elapsed().as_millis() as u64);
        rs.total_count = total_count;

        if let Some(m) = meta {
            for col in &mut rs.columns {
                if let Some(cm) = m.columns.iter().find(|c| c.name == col.name) {
                    col.is_primary_key = cm.is_primary_key;
                    col.data_type = cm.data_type.clone();
                }
                for fk in &m.foreign_keys {
                    if let Some(pos) = fk.columns.iter().position(|c| c == &col.name) {
                        if let Some(ref_col) = fk.ref_columns.get(pos) {
                            col.fk_target = Some(ForeignKeyTarget {
                                schema: fk.ref_schema.clone(),
                                table: fk.ref_table.clone(),
                                column: ref_col.clone(),
                            });
                        }
                    }
                }
            }
        }

        Ok(rs)
    }

    async fn execute_query(
        &self,
        database: Option<&str>,
        sql: &str,
        query_id: &str,
    ) -> Result<QueryExecutionResponse> {
        let total_start = Instant::now();
        let mut client = self.open_client(database).await?;

        // Track SPID for cancellation
        if let Ok(stream) = client.simple_query("SELECT CAST(@@SPID AS SMALLINT)").await {
            if let Ok(rows) = stream.into_first_result().await {
                if let Some(spid) = rows.first().and_then(|r| r.get::<i16, _>(0)) {
                    self.active_spids
                        .lock()
                        .await
                        .insert(query_id.to_string(), spid);
                }
            }
        }

        let statements = split_sql_statements(sql);
        let mut result_sets = Vec::new();

        for stmt in statements {
            let st_start = Instant::now();
            let upper = stmt.trim().to_uppercase();
            let returns_rows = upper.starts_with("SELECT")
                || upper.starts_with("WITH")
                || upper.starts_with("EXEC")
                || upper.starts_with("EXECUTE")
                || upper.starts_with("DBCC");

            if returns_rows {
                let sets = client
                    .simple_query(&stmt)
                    .await
                    .map_err(map_mssql_error)?
                    .into_results()
                    .await
                    .map_err(map_mssql_error)?;

                if sets.is_empty() {
                    result_sets.push(QueryResultSet {
                        columns: Vec::new(),
                        rows: Vec::new(),
                        rows_affected: Some(0),
                        total_count: None,
                        execution_ms: st_start.elapsed().as_millis() as u64,
                        statement: stmt,
                    });
                } else {
                    for s in sets {
                        result_sets.push(mssql_rows_to_result_set(
                            &s,
                            stmt.clone(),
                            st_start.elapsed().as_millis() as u64,
                        ));
                    }
                }
            } else {
                let exec_res = client
                    .execute(&stmt, &[])
                    .await
                    .map_err(map_mssql_error)?;
                result_sets.push(QueryResultSet {
                    columns: Vec::new(),
                    rows: Vec::new(),
                    rows_affected: Some(exec_res.total()),
                    total_count: None,
                    execution_ms: st_start.elapsed().as_millis() as u64,
                    statement: stmt,
                });
            }
        }

        self.active_spids.lock().await.remove(query_id);

        Ok(QueryExecutionResponse {
            query_id: query_id.to_string(),
            result_sets,
            total_execution_ms: total_start.elapsed().as_millis() as u64,
        })
    }

    async fn cancel_query(&self, query_id: &str) -> Result<()> {
        let spid = self.active_spids.lock().await.remove(query_id);
        if let Some(spid) = spid {
            if let Ok(mut killer) = self.open_client(Some("master")).await {
                let _ = killer.execute(format!("KILL {}", spid), &[]).await;
            }
        }
        Ok(())
    }

    async fn explain_query(&self, database: Option<&str>, sql: &str) -> Result<ExplainPlanResult> {
        let start = Instant::now();
        let mut client = self.open_client(database).await?;

        client
            .simple_query("SET SHOWPLAN_XML ON")
            .await
            .map_err(map_mssql_error)?
            .into_results()
            .await
            .map_err(map_mssql_error)?;

        let plan_res = client
            .simple_query(sql)
            .await
            .map_err(map_mssql_error)?
            .into_first_result()
            .await
            .map_err(map_mssql_error);

        let _ = client.simple_query("SET SHOWPLAN_XML OFF").await;

        let rows = plan_res?;
        let xml = rows
            .first()
            .and_then(|r| r.get::<&str, _>(0))
            .unwrap_or("")
            .to_string();

        let root = parse_showplan_xml(&xml);
        Ok(ExplainPlanResult {
            root,
            raw_json: serde_json::json!({ "showplanXml": xml }),
            execution_ms: start.elapsed().as_millis() as u64,
        })
    }

    async fn apply_staged_changes(&self, req: &ApplyChangesRequest) -> Result<u64> {
        let sc = self.effective_schema(req.schema.as_deref());
        let stmts = build_staged_change_sql(DbEngine::Mssql, Some(sc), &req.table, &req.changes);
        if stmts.is_empty() {
            return Ok(0);
        }

        let mut client = self.open_client(req.database.as_deref()).await?;
        client
            .execute("BEGIN TRANSACTION", &[])
            .await
            .map_err(map_mssql_error)?;

        let mut total = 0u64;
        for stmt in &stmts {
            match client.execute(stmt, &[]).await {
                Ok(r) => total += r.total(),
                Err(err) => {
                    let _ = client.execute("ROLLBACK TRANSACTION", &[]).await;
                    return Err(map_mssql_error(err));
                }
            }
        }

        client
            .execute("COMMIT TRANSACTION", &[])
            .await
            .map_err(map_mssql_error)?;
        Ok(total)
    }

    async fn get_autocomplete_schema(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
    ) -> Result<AutocompleteSchema> {
        let sc = self.effective_schema(schema);
        let sc_lit = sc.replace('\'', "''");
        let mut client = self.open_client(database).await?;

        let rows = client
            .simple_query(format!(
                "SELECT TABLE_NAME, COLUMN_NAME
                 FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = '{}'
                 ORDER BY TABLE_NAME, ORDINAL_POSITION",
                sc_lit
            ))
            .await
            .map_err(map_mssql_error)?
            .into_first_result()
            .await
            .map_err(map_mssql_error)?;

        let mut tables: HashMap<String, Vec<String>> = HashMap::new();
        for r in rows {
            if let (Some(t), Some(c)) = (r.get::<&str, _>(0), r.get::<&str, _>(1)) {
                tables
                    .entry(t.to_string())
                    .or_default()
                    .push(c.to_string());
            }
        }
        Ok(AutocompleteSchema { tables })
    }

    async fn execute_ddl(&self, database: Option<&str>, ddl: &str) -> Result<()> {
        let mut client = self.open_client(database).await?;
        if is_compound_ddl(ddl) {
            let trimmed = ddl.trim();
            if !trimmed.is_empty() {
                client
                    .execute(trimmed, &[])
                    .await
                    .map_err(map_mssql_error)?;
            }
            return Ok(());
        }
        for stmt in split_sql_statements(ddl) {
            client
                .execute(&stmt, &[])
                .await
                .map_err(map_mssql_error)?;
        }
        Ok(())
    }

    async fn truncate_table(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
        table: &str,
    ) -> Result<()> {
        let sc = self.effective_schema(schema);
        let fq = qualified_table(DbEngine::Mssql, Some(sc), table);
        let mut client = self.open_client(database).await?;
        client
            .execute(format!("TRUNCATE TABLE {}", fq), &[])
            .await
            .map_err(map_mssql_error)?;
        Ok(())
    }

    async fn drop_object(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
        name: &str,
        kind: ObjectKind,
    ) -> Result<()> {
        let sc = self.effective_schema(schema);
        let fq = qualified_table(DbEngine::Mssql, Some(sc), name);
        let kw = match kind {
            ObjectKind::Table => "TABLE",
            ObjectKind::View | ObjectKind::MaterializedView => "VIEW",
            ObjectKind::Procedure => "PROCEDURE",
            ObjectKind::Function => "FUNCTION",
            ObjectKind::Trigger => "TRIGGER",
            _ => "TABLE",
        };
        let mut client = self.open_client(database).await?;
        client
            .execute(format!("DROP {} {}", kw, fq), &[])
            .await
            .map_err(map_mssql_error)?;
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
        let sc = self.effective_schema(schema);
        let src_fq = qualified_table(DbEngine::Mssql, Some(sc), source);
        let tgt_fq = qualified_table(DbEngine::Mssql, Some(sc), target);
        let sql = if with_data {
            format!("SELECT * INTO {} FROM {}", tgt_fq, src_fq)
        } else {
            format!("SELECT * INTO {} FROM {} WHERE 1 = 0", tgt_fq, src_fq)
        };
        let mut client = self.open_client(database).await?;
        client.execute(&sql, &[]).await.map_err(map_mssql_error)?;
        Ok(())
    }

    async fn get_object_ddl(
        &self,
        database: Option<&str>,
        schema: Option<&str>,
        name: &str,
        kind: ObjectKind,
    ) -> Result<String> {
        match kind {
            ObjectKind::View
            | ObjectKind::MaterializedView
            | ObjectKind::Function
            | ObjectKind::Procedure
            | ObjectKind::Trigger => {
                let sc = self.effective_schema(schema);
                let obj_id = format!("{}.{}", sc.replace('\'', "''"), name.replace('\'', "''"));
                let mut client = self.open_client(database).await?;
                let row = client
                    .simple_query(format!(
                        "SELECT OBJECT_DEFINITION(OBJECT_ID(N'{}'))",
                        obj_id
                    ))
                    .await
                    .map_err(map_mssql_error)?
                    .into_row()
                    .await
                    .map_err(map_mssql_error)?;

                let def = row
                    .and_then(|r| r.get::<&str, _>(0).map(|s| s.to_string()))
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| DatavaultError::Database {
                        message: format!("Object definition for '{}.{}' not found", sc, name),
                        code: None,
                        detail: None,
                        line: None,
                    })?;
                Ok(def)
            }
            _ => Err(DatavaultError::UnsupportedEngine(format!(
                "MSSQL DDL extraction is not supported for {:?}",
                kind
            ))),
        }
    }
}
