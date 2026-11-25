use crate::drivers::mongodb::MongoDriver;
use crate::drivers::mssql::MssqlDriver;
use crate::drivers::mysql::MysqlDriver;
use crate::drivers::postgres::PostgresDriver;
use crate::drivers::safety::evaluate_sql_safety;
use crate::drivers::ssh::SshTunnel;
use crate::drivers::{build_staged_change_sql, SqlDriver};
use crate::engines::{
    automation, data_gen, data_sync, dump, er_model, import_export, native_cli, structure_sync,
    transfer, JobCancelRegistry,
};
use crate::error::{DbaError, Result};
use crate::models::*;
use crate::storage::StorageManager;
use chrono::Utc;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::RwLock;
use uuid::Uuid;

struct ActiveConnection {
    profile: ConnectionProfile,
    driver: Arc<dyn SqlDriver>,
    mongo: Option<Arc<MongoDriver>>,
    _tunnel: Option<SshTunnel>,
}

pub struct ConnectionManager {
    pub storage: Arc<StorageManager>,
    active: RwLock<HashMap<String, ActiveConnection>>,
    pub job_cancels: JobCancelRegistry,
}

impl ConnectionManager {
    pub fn new(storage: Arc<StorageManager>) -> Self {
        Self {
            storage,
            active: RwLock::new(HashMap::new()),
            job_cancels: JobCancelRegistry::default(),
        }
    }

    pub fn save_connection_input(&self, mut input: ConnectionSaveInput) -> Result<ConnectionProfile> {
        let now = Utc::now();
        if input.profile.id.trim().is_empty() {
            input.profile.id = Uuid::new_v4().to_string();
            input.profile.created_at = now;
        }
        input.profile.updated_at = now;

        if let Some(pw) = input.password {
            if !pw.is_empty() {
                let key = input
                    .profile
                    .keyring_ref
                    .clone()
                    .unwrap_or_else(|| format!("db-{}", input.profile.id));
                self.storage.secrets.set_secret(&key, &pw)?;
                input.profile.keyring_ref = Some(key);
            }
        }

        if let Some(ssh_pw) = input.ssh_secret {
            if !ssh_pw.is_empty() {
                let key = input
                    .profile
                    .ssh
                    .keyring_ref
                    .clone()
                    .unwrap_or_else(|| format!("ssh-{}", input.profile.id));
                self.storage.secrets.set_secret(&key, &ssh_pw)?;
                input.profile.ssh.keyring_ref = Some(key);
            }
        }

        self.storage.save_connection(input.profile)
    }

    async fn build_driver(
        &self,
        profile: &ConnectionProfile,
        override_password: Option<String>,
        override_ssh_secret: Option<String>,
    ) -> Result<(Arc<dyn SqlDriver>, Option<Arc<MongoDriver>>, Option<SshTunnel>)> {
        let password = match override_password.filter(|s| !s.is_empty()) {
            Some(p) => Some(p),
            None => match &profile.keyring_ref {
                Some(key) => self.storage.secrets.get_secret(key)?,
                None => None,
            },
        };

        let (eff_host, eff_port, tunnel) = if profile.ssh.enabled {
            let ssh_secret = match override_ssh_secret.filter(|s| !s.is_empty()) {
                Some(s) => Some(s),
                None => match &profile.ssh.keyring_ref {
                    Some(key) => self.storage.secrets.get_secret(key)?,
                    None => None,
                },
            };
            let t = SshTunnel::open(
                &profile.ssh,
                &profile.host,
                profile.port,
                ssh_secret.as_deref(),
            )
            .await?;
            let lp = t.local_port;
            ("127.0.0.1".to_string(), lp, Some(t))
        } else {
            (profile.host.clone(), profile.port, None)
        };

        let (driver, mongo): (Arc<dyn SqlDriver>, Option<Arc<MongoDriver>>) = match profile.engine {
            DbEngine::Postgres => (
                Arc::new(
                    PostgresDriver::connect(
                        eff_host,
                        eff_port,
                        profile.username.clone(),
                        password,
                        profile.database.clone(),
                        profile.ssl.clone(),
                    )
                    .await?,
                ),
                None,
            ),
            DbEngine::Mysql => (
                Arc::new(
                    MysqlDriver::connect(
                        eff_host,
                        eff_port,
                        profile.username.clone(),
                        password,
                        profile.database.clone(),
                        profile.ssl.clone(),
                    )
                    .await?,
                ),
                None,
            ),
            DbEngine::Mssql => (
                Arc::new(
                    MssqlDriver::connect(
                        eff_host,
                        eff_port,
                        profile.username.clone(),
                        password,
                        profile.database.clone(),
                        profile.ssl.clone(),
                    )
                    .await?,
                ),
                None,
            ),
            DbEngine::Mongodb => {
                let mg = Arc::new(
                    MongoDriver::connect(
                        eff_host,
                        eff_port,
                        profile.username.clone(),
                        password,
                        profile.database.clone(),
                        profile.ssl.clone(),
                    )
                    .await?,
                );
                let sql_view: Arc<dyn SqlDriver> = mg.clone();
                (sql_view, Some(mg))
            }
        };

        Ok((driver, mongo, tunnel))
    }

    pub async fn test_connection(&self, input: ConnectionSaveInput) -> ConnectionTestResult {
        let start = Instant::now();
        match self
            .build_driver(&input.profile, input.password, input.ssh_secret)
            .await
        {
            Ok((driver, _, tunnel)) => {
                let version = driver.server_version().await.ok();
                if let Some(t) = tunnel {
                    t.close().await;
                }
                ConnectionTestResult {
                    ok: true,
                    latency_ms: start.elapsed().as_millis() as u64,
                    server_version: version,
                    message: "Connection successful".into(),
                }
            }
            Err(err) => ConnectionTestResult {
                ok: false,
                latency_ms: start.elapsed().as_millis() as u64,
                server_version: None,
                message: err.to_string(),
            },
        }
    }

    pub async fn connect(&self, connection_id: &str) -> Result<ConnectionTestResult> {
        let start = Instant::now();
        let profile = self
            .storage
            .get_connection(connection_id)?
            .ok_or_else(|| DbaError::ConnectionNotFound(connection_id.to_string()))?;

        let (driver, mongo, tunnel) = self.build_driver(&profile, None, None).await?;
        let version = driver.server_version().await.ok();

        let mut map = self.active.write().await;
        map.insert(
            connection_id.to_string(),
            ActiveConnection {
                profile,
                driver,
                mongo,
                _tunnel: tunnel,
            },
        );

        Ok(ConnectionTestResult {
            ok: true,
            latency_ms: start.elapsed().as_millis() as u64,
            server_version: version,
            message: "Connected".into(),
        })
    }

    pub async fn disconnect(&self, connection_id: &str) -> Result<()> {
        let mut map = self.active.write().await;
        if let Some(conn) = map.remove(connection_id) {
            if let Some(t) = conn._tunnel {
                t.close().await;
            }
        }
        Ok(())
    }

    pub async fn connected_ids(&self) -> Vec<String> {
        let map = self.active.read().await;
        map.keys().cloned().collect()
    }

    async fn get_active(&self, connection_id: &str) -> Result<(ConnectionProfile, Arc<dyn SqlDriver>)> {
        let map = self.active.read().await;
        let conn = map
            .get(connection_id)
            .ok_or_else(|| DbaError::NotConnected(connection_id.to_string()))?;
        Ok((conn.profile.clone(), conn.driver.clone()))
    }

    pub async fn list_databases(&self, connection_id: &str) -> Result<Vec<DatabaseInfo>> {
        let (_, drv) = self.get_active(connection_id).await?;
        drv.list_databases().await
    }

    pub async fn list_schemas(
        &self,
        connection_id: &str,
        database: Option<&str>,
    ) -> Result<Vec<SchemaInfo>> {
        let (_, drv) = self.get_active(connection_id).await?;
        drv.list_schemas(database).await
    }

    pub async fn list_objects(
        &self,
        connection_id: &str,
        database: Option<&str>,
        schema: Option<&str>,
    ) -> Result<Vec<DatabaseObject>> {
        let (_, drv) = self.get_active(connection_id).await?;
        drv.list_objects(database, schema).await
    }

    pub async fn get_table_metadata(
        &self,
        connection_id: &str,
        database: Option<&str>,
        schema: Option<&str>,
        table: &str,
    ) -> Result<TableMetadata> {
        let (_, drv) = self.get_active(connection_id).await?;
        drv.get_table_metadata(database, schema, table).await
    }

    pub async fn fetch_table_data(&self, req: &TableDataRequest) -> Result<QueryResultSet> {
        let (_, drv) = self.get_active(&req.connection_id).await?;
        drv.fetch_table_data(req).await
    }

    pub async fn check_sql_safety(&self, connection_id: &str, sql: &str) -> Result<SafetyCheckResult> {
        let profile = self
            .storage
            .get_connection(connection_id)?
            .ok_or_else(|| DbaError::ConnectionNotFound(connection_id.to_string()))?;
        Ok(evaluate_sql_safety(&profile, sql))
    }

    pub async fn execute_query(
        &self,
        connection_id: &str,
        database: Option<&str>,
        sql: &str,
        query_id: Option<String>,
        confirmed_safety: bool,
    ) -> Result<QueryExecutionResponse> {
        let (profile, drv) = self.get_active(connection_id).await?;
        let safety = evaluate_sql_safety(&profile, sql);

        if !safety.allowed {
            return Err(DbaError::ReadOnlyBlocked(safety.warnings.join("; ")));
        }
        if safety.requires_confirmation && !confirmed_safety {
            return Err(DbaError::SafetyGuardBlocked(
                safety.warnings.join("; "),
            ));
        }

        let qid = query_id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let executed_at = Utc::now().to_rfc3339();
        let res = drv.execute_query(database, sql, &qid).await;

        match &res {
            Ok(resp) => {
                let row_count: u64 = resp
                    .result_sets
                    .iter()
                    .map(|rs| rs.rows_affected.unwrap_or(rs.rows.len() as u64))
                    .sum();
                let _ = self.storage.record_history(&QueryHistoryEntry {
                    id: qid.clone(),
                    connection_id: profile.id.clone(),
                    connection_name: profile.name.clone(),
                    database: database.map(|s| s.to_string()),
                    sql: sql.to_string(),
                    executed_at,
                    duration_ms: resp.total_execution_ms,
                    row_count: Some(row_count),
                    status: "ok".into(),
                    error_message: None,
                });
            }
            Err(err) => {
                let _ = self.storage.record_history(&QueryHistoryEntry {
                    id: qid.clone(),
                    connection_id: profile.id.clone(),
                    connection_name: profile.name.clone(),
                    database: database.map(|s| s.to_string()),
                    sql: sql.to_string(),
                    executed_at,
                    duration_ms: 0,
                    row_count: None,
                    status: "error".into(),
                    error_message: Some(err.to_string()),
                });
            }
        }

        res
    }

    pub async fn cancel_query(&self, connection_id: &str, query_id: &str) -> Result<()> {
        let (_, drv) = self.get_active(connection_id).await?;
        drv.cancel_query(query_id).await
    }

    pub async fn explain_query(
        &self,
        connection_id: &str,
        database: Option<&str>,
        sql: &str,
    ) -> Result<ExplainPlanResult> {
        let (_, drv) = self.get_active(connection_id).await?;
        drv.explain_query(database, sql).await
    }

    pub async fn preview_staged_changes(&self, req: &ApplyChangesRequest) -> Result<PreviewChangesResponse> {
        let (profile, _) = self.get_active(&req.connection_id).await?;
        if profile.read_only {
            return Err(DbaError::ReadOnlyBlocked(
                "Connection is in Read-Only Mode".into(),
            ));
        }
        let statements = build_staged_change_sql(
            profile.engine,
            req.schema.as_deref().or(req.database.as_deref()),
            &req.table,
            &req.changes,
        );
        let is_prod = profile.environment == EnvironmentTag::Production;
        let mut warnings = Vec::new();
        if is_prod {
            warnings.push(format!(
                "Applying {} write operation(s) to PRODUCTION connection '{}'",
                statements.len(),
                profile.name
            ));
        }
        Ok(PreviewChangesResponse {
            statements,
            requires_confirmation: is_prod,
            safety_warnings: warnings,
        })
    }

    pub async fn apply_staged_changes(&self, req: &ApplyChangesRequest) -> Result<u64> {
        let (profile, drv) = self.get_active(&req.connection_id).await?;
        if profile.read_only {
            return Err(DbaError::ReadOnlyBlocked(
                "Connection is in Read-Only Mode".into(),
            ));
        }
        if profile.environment == EnvironmentTag::Production && !req.confirmed_production {
            return Err(DbaError::SafetyGuardBlocked(
                "Production confirmation required before applying changes".into(),
            ));
        }
        drv.apply_staged_changes(req).await
    }

    pub async fn get_autocomplete_schema(
        &self,
        connection_id: &str,
        database: Option<&str>,
        schema: Option<&str>,
    ) -> Result<AutocompleteSchema> {
        let (_, drv) = self.get_active(connection_id).await?;
        drv.get_autocomplete_schema(database, schema).await
    }

    pub async fn execute_ddl(
        &self,
        connection_id: &str,
        database: Option<&str>,
        ddl: &str,
        confirmed_safety: bool,
    ) -> Result<()> {
        let (profile, drv) = self.get_active(connection_id).await?;
        if profile.read_only {
            return Err(DbaError::ReadOnlyBlocked(
                "Connection is in Read-Only Mode".into(),
            ));
        }
        if profile.environment == EnvironmentTag::Production && !confirmed_safety {
            return Err(DbaError::SafetyGuardBlocked(
                "Production confirmation required before executing DDL".into(),
            ));
        }
        drv.execute_ddl(database, ddl).await
    }

    pub async fn truncate_table(
        &self,
        connection_id: &str,
        database: Option<&str>,
        schema: Option<&str>,
        table: &str,
        confirmed: bool,
    ) -> Result<()> {
        let (profile, drv) = self.get_active(connection_id).await?;
        if profile.read_only {
            return Err(DbaError::ReadOnlyBlocked("Read-only mode enabled".into()));
        }
        if !confirmed {
            return Err(DbaError::SafetyGuardBlocked("Confirmation required for TRUNCATE".into()));
        }
        drv.truncate_table(database, schema, table).await
    }

    pub async fn drop_object(
        &self,
        connection_id: &str,
        database: Option<&str>,
        schema: Option<&str>,
        name: &str,
        kind: ObjectKind,
        confirmed: bool,
    ) -> Result<()> {
        let (profile, drv) = self.get_active(connection_id).await?;
        if profile.read_only {
            return Err(DbaError::ReadOnlyBlocked("Read-only mode enabled".into()));
        }
        if !confirmed {
            return Err(DbaError::SafetyGuardBlocked("Confirmation required for DROP".into()));
        }
        drv.drop_object(database, schema, name, kind).await
    }

    pub async fn duplicate_table(
        &self,
        connection_id: &str,
        database: Option<&str>,
        schema: Option<&str>,
        source: &str,
        target: &str,
        with_data: bool,
    ) -> Result<()> {
        let (profile, drv) = self.get_active(connection_id).await?;
        if profile.read_only {
            return Err(DbaError::ReadOnlyBlocked("Read-only mode enabled".into()));
        }
        drv.duplicate_table(database, schema, source, target, with_data)
            .await
    }

    pub async fn get_object_ddl(
        &self,
        connection_id: &str,
        database: Option<&str>,
        schema: Option<&str>,
        name: &str,
        kind: ObjectKind,
    ) -> Result<String> {
        let (_, drv) = self.get_active(connection_id).await?;
        drv.get_object_ddl(database, schema, name, kind).await
    }

    pub async fn create_database(
        &self,
        connection_id: &str,
        name: &str,
        charset: Option<&str>,
        collation: Option<&str>,
    ) -> Result<()> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(DbaError::Database {
                message: "Database name cannot be empty".into(),
                code: None,
                detail: None,
                line: None,
            });
        }
        let (profile, drv) = self.get_active(connection_id).await?;
        if profile.read_only {
            return Err(DbaError::ReadOnlyBlocked("Read-only mode enabled".into()));
        }
        drv.create_database(trimmed, charset, collation).await
    }

    pub async fn drop_database(
        &self,
        connection_id: &str,
        name: &str,
        confirmed: bool,
    ) -> Result<()> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(DbaError::Database {
                message: "Database name cannot be empty".into(),
                code: None,
                detail: None,
                line: None,
            });
        }
        let (profile, drv) = self.get_active(connection_id).await?;
        if profile.read_only {
            return Err(DbaError::ReadOnlyBlocked("Read-only mode enabled".into()));
        }
        if !confirmed {
            return Err(DbaError::SafetyGuardBlocked(
                "Confirmation required for DROP DATABASE".into(),
            ));
        }
        drv.drop_database(trimmed).await
    }

    // ========================================================================
    // Phase 2: MongoDB Native Operations
    // ========================================================================

    async fn get_active_mongo(
        &self,
        connection_id: &str,
    ) -> Result<(ConnectionProfile, Arc<MongoDriver>)> {
        let map = self.active.read().await;
        let conn = map
            .get(connection_id)
            .ok_or_else(|| DbaError::NotConnected(connection_id.to_string()))?;
        let mg = conn.mongo.clone().ok_or_else(|| {
            DbaError::UnsupportedEngine("Connection is not a MongoDB instance".into())
        })?;
        Ok((conn.profile.clone(), mg))
    }

    pub async fn mongo_get_collection_metadata(
        &self,
        connection_id: &str,
        database: &str,
        collection: &str,
    ) -> Result<MongoCollectionMetadata> {
        let (_, mg) = self.get_active_mongo(connection_id).await?;
        mg.get_collection_metadata(database, collection).await
    }

    pub async fn mongo_fetch_documents(&self, req: &MongoDocRequest) -> Result<MongoDocResponse> {
        let (_, mg) = self.get_active_mongo(&req.connection_id).await?;
        mg.fetch_documents(req).await
    }

    pub async fn mongo_apply_document_changes(&self, req: &MongoApplyChangesRequest) -> Result<u64> {
        let (profile, mg) = self.get_active_mongo(&req.connection_id).await?;
        if profile.read_only {
            return Err(DbaError::ReadOnlyBlocked(
                "Connection is in Read-Only Mode".into(),
            ));
        }
        if profile.environment == EnvironmentTag::Production && !req.confirmed_production {
            return Err(DbaError::SafetyGuardBlocked(
                "Production confirmation required before modifying MongoDB documents".into(),
            ));
        }
        mg.apply_document_changes(req).await
    }

    pub async fn mongo_execute_mql(&self, req: &MongoQueryRequest) -> Result<MongoQueryResponse> {
        let (profile, mg) = self.get_active_mongo(&req.connection_id).await?;
        let is_write = matches!(
            req.operation.as_str(),
            "insertOne" | "updateMany" | "deleteMany" | "command"
        );
        if profile.read_only && is_write {
            return Err(DbaError::ReadOnlyBlocked(
                "Connection is in Read-Only Mode".into(),
            ));
        }
        if is_write && profile.environment == EnvironmentTag::Production && !req.confirmed_safety {
            return Err(DbaError::SafetyGuardBlocked(
                format!("Production confirmation required for MongoDB '{}'", req.operation),
            ));
        }
        let executed_at = Utc::now().to_rfc3339();
        let res = mg.execute_mql(req).await;
        let summary_sql = format!("db.{}.{}({})", req.collection, req.operation, req.filter_json.as_deref().unwrap_or("{}"));
        match &res {
            Ok(resp) => {
                let _ = self.storage.record_history(&QueryHistoryEntry {
                    id: Uuid::new_v4().to_string(),
                    connection_id: profile.id.clone(),
                    connection_name: profile.name.clone(),
                    database: Some(req.database.clone()),
                    sql: summary_sql,
                    executed_at,
                    duration_ms: resp.execution_ms,
                    row_count: Some(resp.affected_count.unwrap_or(resp.documents.len() as u64)),
                    status: "ok".into(),
                    error_message: None,
                });
            }
            Err(err) => {
                let _ = self.storage.record_history(&QueryHistoryEntry {
                    id: Uuid::new_v4().to_string(),
                    connection_id: profile.id.clone(),
                    connection_name: profile.name.clone(),
                    database: Some(req.database.clone()),
                    sql: summary_sql,
                    executed_at,
                    duration_ms: 0,
                    row_count: None,
                    status: "error".into(),
                    error_message: Some(err.to_string()),
                });
            }
        }
        res
    }

    pub async fn mongo_preview_aggregation_stages(
        &self,
        connection_id: &str,
        database: &str,
        collection: &str,
        stages: &[MongoAggregationStage],
    ) -> Result<Vec<MongoAggregationStageResult>> {
        let (_, mg) = self.get_active_mongo(connection_id).await?;
        mg.preview_aggregation_stages(database, collection, stages)
            .await
    }

    pub async fn mongo_create_index(&self, req: &MongoCreateIndexRequest) -> Result<String> {
        let (profile, mg) = self.get_active_mongo(&req.connection_id).await?;
        if profile.read_only {
            return Err(DbaError::ReadOnlyBlocked("Read-only mode enabled".into()));
        }
        mg.create_index(req).await
    }

    pub async fn mongo_drop_index(
        &self,
        connection_id: &str,
        database: &str,
        collection: &str,
        index_name: &str,
    ) -> Result<()> {
        let (profile, mg) = self.get_active_mongo(connection_id).await?;
        if profile.read_only {
            return Err(DbaError::ReadOnlyBlocked("Read-only mode enabled".into()));
        }
        mg.drop_index(database, collection, index_name).await
    }

    pub async fn mongo_update_validation(&self, req: &MongoValidationUpdateRequest) -> Result<()> {
        let (profile, mg) = self.get_active_mongo(&req.connection_id).await?;
        if profile.read_only {
            return Err(DbaError::ReadOnlyBlocked("Read-only mode enabled".into()));
        }
        if profile.environment == EnvironmentTag::Production && !req.confirmed_production {
            return Err(DbaError::SafetyGuardBlocked(
                "Production confirmation required before updating collection validation".into(),
            ));
        }
        mg.update_collection_validation(req).await
    }

    pub async fn mongo_explain_mql(
        &self,
        connection_id: &str,
        database: &str,
        collection: &str,
        filter_json: Option<&str>,
    ) -> Result<ExplainPlanResult> {
        let (_, mg) = self.get_active_mongo(connection_id).await?;
        mg.explain_mql(database, collection, filter_json).await
    }

    // ========================================================================
    // Phase 3: Data Mobility (Import/Export, Dump/Restore, Native CLI, Transfer)
    // ========================================================================

    pub fn cancel_data_job(&self, job_id: &str) -> bool {
        self.job_cancels.cancel(job_id)
    }

    pub async fn export_table_data(&self, req: &ExportRequest) -> Result<DataJobResult> {
        let (profile, drv) = self.get_active(&req.connection_id).await?;
        let job_id = req
            .job_id
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let cancel = self.job_cancels.register(&job_id);
        let res = import_export::run_export(drv, profile.engine, req, job_id.clone(), cancel).await;
        self.job_cancels.unregister(&job_id);
        res
    }

    pub fn preview_import_file(&self, req: &ImportPreviewRequest) -> Result<ImportPreviewResponse> {
        import_export::preview_import_file(req)
    }

    pub async fn import_table_data(&self, req: &ImportRequest) -> Result<DataJobResult> {
        let (profile, drv, mongo) = {
            let map = self.active.read().await;
            let conn = map
                .get(&req.connection_id)
                .ok_or_else(|| DbaError::NotConnected(req.connection_id.clone()))?;
            (conn.profile.clone(), conn.driver.clone(), conn.mongo.clone())
        };
        if profile.read_only {
            return Err(DbaError::ReadOnlyBlocked(
                "Connection is in Read-Only Mode".into(),
            ));
        }
        if profile.environment == EnvironmentTag::Production && !req.confirmed_production {
            return Err(DbaError::SafetyGuardBlocked(
                "Production confirmation required before importing data".into(),
            ));
        }
        let job_id = req
            .job_id
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let cancel = self.job_cancels.register(&job_id);
        let res =
            import_export::run_import(drv, mongo, profile.engine, req, job_id.clone(), cancel)
                .await;
        self.job_cancels.unregister(&job_id);
        res
    }

    pub async fn dump_sql(&self, req: &SqlDumpRequest) -> Result<DataJobResult> {
        let (profile, drv) = self.get_active(&req.connection_id).await?;
        let job_id = req
            .job_id
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let cancel = self.job_cancels.register(&job_id);
        let res = dump::run_sql_dump(drv, profile.engine, req, job_id.clone(), cancel).await;
        self.job_cancels.unregister(&job_id);
        res
    }

    pub async fn execute_sql_file(&self, req: &ExecuteSqlFileRequest) -> Result<DataJobResult> {
        let (profile, drv) = self.get_active(&req.connection_id).await?;
        if profile.read_only {
            return Err(DbaError::ReadOnlyBlocked(
                "Connection is in Read-Only Mode".into(),
            ));
        }
        if profile.environment == EnvironmentTag::Production && !req.confirmed_production {
            return Err(DbaError::SafetyGuardBlocked(
                "Production confirmation required before executing SQL file".into(),
            ));
        }
        let job_id = req
            .job_id
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let cancel = self.job_cancels.register(&job_id);
        let res = dump::run_execute_sql_file(drv, req, job_id.clone(), cancel).await;
        self.job_cancels.unregister(&job_id);
        res
    }

    pub fn detect_native_cli_tools(&self) -> Vec<NativeCliToolInfo> {
        native_cli::detect_native_cli_tools()
    }

    pub async fn run_native_cli(&self, req: &NativeCliRunRequest) -> Result<NativeCliRunResult> {
        let profile = self
            .storage
            .get_connection(&req.connection_id)?
            .ok_or_else(|| DbaError::ConnectionNotFound(req.connection_id.clone()))?;

        let is_restore = matches!(
            req.tool.as_str(),
            "pg_restore" | "psql" | "mysql" | "mongorestore"
        );
        if is_restore && profile.read_only {
            return Err(DbaError::ReadOnlyBlocked(
                "Connection is in Read-Only Mode".into(),
            ));
        }
        if is_restore
            && profile.environment == EnvironmentTag::Production
            && !req.confirmed_production
        {
            return Err(DbaError::SafetyGuardBlocked(
                "Production confirmation required before running native restore".into(),
            ));
        }

        let password = match &profile.keyring_ref {
            Some(key) => self.storage.secrets.get_secret(key)?,
            None => None,
        };
        native_cli::run_native_cli(&profile, password.as_deref(), req).await
    }

    pub fn get_default_type_mappings(
        &self,
        source_engine: DbEngine,
        target_engine: DbEngine,
    ) -> Vec<TypeMappingRule> {
        transfer::default_type_mappings(source_engine, target_engine)
    }

    pub async fn run_data_transfer(&self, req: &DataTransferRequest) -> Result<DataTransferResult> {
        let (src_profile, src_drv) = self.get_active(&req.source_connection_id).await?;
        let (tgt_profile, tgt_drv, tgt_mongo) = {
            let map = self.active.read().await;
            let conn = map
                .get(&req.target_connection_id)
                .ok_or_else(|| DbaError::NotConnected(req.target_connection_id.clone()))?;
            (conn.profile.clone(), conn.driver.clone(), conn.mongo.clone())
        };

        if tgt_profile.read_only {
            return Err(DbaError::ReadOnlyBlocked(
                "Target connection is in Read-Only Mode".into(),
            ));
        }
        if tgt_profile.environment == EnvironmentTag::Production && !req.confirmed_production {
            return Err(DbaError::SafetyGuardBlocked(
                "Production confirmation required before transferring data to target".into(),
            ));
        }

        let job_id = req
            .job_id
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let cancel = self.job_cancels.register(&job_id);
        let res = transfer::run_data_transfer(
            src_drv,
            src_profile.engine,
            tgt_drv,
            tgt_mongo,
            tgt_profile.engine,
            req,
            job_id.clone(),
            cancel,
        )
        .await;
        self.job_cancels.unregister(&job_id);
        res
    }

    // ========================================================================
    // Phase 4: Schema Intelligence & Visual Design (Sync, ER Model, Query Builder)
    // ========================================================================

    pub async fn compute_structure_sync(
        &self,
        req: &StructureSyncRequest,
    ) -> Result<StructureSyncPlan> {
        let (src_profile, src_drv) = self.get_active(&req.source_connection_id).await?;
        let (tgt_profile, tgt_drv) = self.get_active(&req.target_connection_id).await?;
        structure_sync::compute_structure_sync(
            src_drv,
            src_profile.engine,
            tgt_drv,
            tgt_profile.engine,
            req,
        )
        .await
    }

    pub async fn execute_sync_script(
        &self,
        req: &ExecuteSyncScriptRequest,
    ) -> Result<SyncExecutionResult> {
        let (profile, drv) = self.get_active(&req.connection_id).await?;
        if profile.read_only {
            return Err(DbaError::ReadOnlyBlocked(
                "Target connection is in Read-Only Mode".into(),
            ));
        }
        if profile.environment == EnvironmentTag::Production && !req.confirmed_production {
            return Err(DbaError::SafetyGuardBlocked(
                "Production confirmation required before applying sync script".into(),
            ));
        }
        structure_sync::execute_sync_statements(
            drv,
            req.database.as_deref(),
            &req.statements,
            req.stop_on_error,
        )
        .await
    }

    pub async fn compute_data_sync(&self, req: &DataSyncRequest) -> Result<DataSyncPlan> {
        let (_, src_drv) = self.get_active(&req.source_connection_id).await?;
        let (tgt_profile, tgt_drv) = self.get_active(&req.target_connection_id).await?;
        data_sync::compute_data_sync(src_drv, tgt_drv, tgt_profile.engine, req).await
    }

    pub async fn reverse_engineer_schema(&self, req: &ReverseEngineerRequest) -> Result<ErModel> {
        let (profile, drv) = self.get_active(&req.connection_id).await?;
        er_model::reverse_engineer_schema(drv, profile.engine, req).await
    }

    pub fn forward_engineer_model(&self, req: &ForwardEngineerRequest) -> ForwardEngineerResult {
        er_model::forward_engineer_model(req)
    }

    pub fn auto_layout_er_model(&self, mut model: ErModel) -> ErModel {
        er_model::auto_layout_er_model(&mut model);
        model
    }

    pub async fn diff_er_model_to_db(
        &self,
        req: &ErModelSyncRequest,
    ) -> Result<StructureSyncPlan> {
        let (tgt_profile, tgt_drv) = self.get_active(&req.target_connection_id).await?;
        er_model::diff_er_model_to_db(tgt_drv, tgt_profile.engine, req).await
    }

    pub fn generate_visual_query_sql(&self, spec: &VisualQuerySpec) -> String {
        er_model::generate_visual_query_sql(spec)
    }

    // ========================================================================
    // Phase 5: Automation, Analytics & Data Generation
    // ========================================================================

    pub async fn ensure_connected(&self, connection_id: &str) -> Result<()> {
        let already = {
            let map = self.active.read().await;
            map.contains_key(connection_id)
        };
        if !already {
            self.connect(connection_id).await?;
        }
        Ok(())
    }

    pub async fn infer_data_gen_rules(
        &self,
        req: &DataGenInferRequest,
    ) -> Result<Vec<DataGenColumnRule>> {
        let (_, drv) = self.get_active(&req.connection_id).await?;
        let meta = drv
            .get_table_metadata(req.database.as_deref(), req.schema.as_deref(), &req.table)
            .await?;
        Ok(data_gen::infer_column_rules(&meta))
    }

    pub async fn preview_data_gen(
        &self,
        req: &DataGenRequest,
    ) -> Result<DataGenPreviewResult> {
        let (profile, drv) = self.get_active(&req.connection_id).await?;
        let fk_pools = data_gen::load_fk_pools(
            drv,
            profile.engine,
            req.database.as_deref(),
            req.schema.as_deref(),
            &req.rules,
        )
        .await;
        Ok(data_gen::preview_data_gen(&req.rules, &fk_pools, req.seed, 10))
    }

    pub async fn run_data_gen(&self, req: &DataGenRequest) -> Result<DataGenResult> {
        let (profile, drv, mongo) = {
            let map = self.active.read().await;
            let conn = map
                .get(&req.connection_id)
                .ok_or_else(|| DbaError::NotConnected(req.connection_id.clone()))?;
            (conn.profile.clone(), conn.driver.clone(), conn.mongo.clone())
        };

        if profile.read_only {
            return Err(DbaError::ReadOnlyBlocked(
                "Target connection is in Read-Only Mode".into(),
            ));
        }
        if profile.environment == EnvironmentTag::Production && !req.confirmed_production {
            return Err(DbaError::SafetyGuardBlocked(
                "Production confirmation required before generating dummy data".into(),
            ));
        }

        let job_id = req
            .job_id
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let cancel = self.job_cancels.register(&job_id);
        let res = data_gen::run_data_gen(drv, mongo, profile.engine, req, job_id.clone(), cancel).await;
        self.job_cancels.unregister(&job_id);
        res
    }

    pub async fn run_batch_job(
        &self,
        job: &BatchJob,
        send_notify: bool,
    ) -> Result<JobExecutionLog> {
        automation::run_batch_job(self, job, send_notify).await
    }

    pub fn sync_batch_job_timer(&self, job: &BatchJob) -> Result<SystemdTimerStatus> {
        automation::sync_systemd_timer(job)
    }

    pub fn remove_batch_job_timer(&self, job_id: &str) -> Result<SystemdTimerStatus> {
        automation::remove_systemd_timer(job_id)
    }

    pub fn get_batch_job_timer_status(&self, job_id: &str) -> Result<SystemdTimerStatus> {
        automation::get_systemd_timer_status(job_id)
    }
}
