use dba_core::drivers::generate_table_design_ddl;
use dba_core::drivers::uri::parse_connection_uri;
use dba_core::error::SerializableError;
use dba_core::*;
use std::sync::Arc;
use tauri::State;

pub struct AppState {
    pub manager: Arc<ConnectionManager>,
    pub storage: Arc<StorageManager>,
}

type CmdResult<T> = std::result::Result<T, SerializableError>;

#[tauri::command]
fn list_connections(state: State<'_, AppState>) -> CmdResult<Vec<ConnectionProfile>> {
    state.storage.list_connections().map_err(Into::into)
}

#[tauri::command]
fn save_connection(
    state: State<'_, AppState>,
    input: ConnectionSaveInput,
) -> CmdResult<ConnectionProfile> {
    state
        .manager
        .save_connection_input(input)
        .map_err(Into::into)
}

#[tauri::command]
async fn delete_connection(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let _ = state.manager.disconnect(&id).await;
    state.storage.delete_connection(&id).map_err(Into::into)
}

#[tauri::command]
fn get_connection_secret(
    state: State<'_, AppState>,
    connection_id: String,
    kind: String,
) -> CmdResult<Option<String>> {
    let profile = match state
        .storage
        .get_connection(&connection_id)
        .map_err(SerializableError::from)?
    {
        Some(p) => p,
        None => return Ok(None),
    };
    let keyring_ref = match kind.as_str() {
        "db" => profile.keyring_ref.as_deref(),
        "ssh" => profile.ssh.keyring_ref.as_deref(),
        _ => return Ok(None),
    };
    match keyring_ref {
        Some(key) => state.storage.secrets.get_secret(key).map_err(Into::into),
        None => Ok(None),
    }
}

#[tauri::command]
fn parse_uri(uri: String) -> CmdResult<ParsedConnectionUri> {
    parse_connection_uri(&uri).map_err(Into::into)
}

#[tauri::command]
async fn test_connection(
    state: State<'_, AppState>,
    input: ConnectionSaveInput,
) -> CmdResult<ConnectionTestResult> {
    Ok(state.manager.test_connection(input).await)
}

#[tauri::command]
async fn connect_db(
    state: State<'_, AppState>,
    connection_id: String,
) -> CmdResult<ConnectionTestResult> {
    state
        .manager
        .connect(&connection_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn disconnect_db(state: State<'_, AppState>, connection_id: String) -> CmdResult<()> {
    state
        .manager
        .disconnect(&connection_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn get_connected_ids(state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    Ok(state.manager.connected_ids().await)
}

#[tauri::command]
async fn list_databases(
    state: State<'_, AppState>,
    connection_id: String,
) -> CmdResult<Vec<DatabaseInfo>> {
    state
        .manager
        .list_databases(&connection_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn list_schemas(
    state: State<'_, AppState>,
    connection_id: String,
    database: Option<String>,
) -> CmdResult<Vec<SchemaInfo>> {
    state
        .manager
        .list_schemas(&connection_id, database.as_deref())
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn list_objects(
    state: State<'_, AppState>,
    connection_id: String,
    database: Option<String>,
    schema: Option<String>,
) -> CmdResult<Vec<DatabaseObject>> {
    state
        .manager
        .list_objects(&connection_id, database.as_deref(), schema.as_deref())
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn get_table_metadata(
    state: State<'_, AppState>,
    connection_id: String,
    database: Option<String>,
    schema: Option<String>,
    table: String,
) -> CmdResult<TableMetadata> {
    state
        .manager
        .get_table_metadata(
            &connection_id,
            database.as_deref(),
            schema.as_deref(),
            &table,
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn fetch_table_data(
    state: State<'_, AppState>,
    request: TableDataRequest,
) -> CmdResult<QueryResultSet> {
    state
        .manager
        .fetch_table_data(&request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn check_sql_safety(
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
) -> CmdResult<SafetyCheckResult> {
    state
        .manager
        .check_sql_safety(&connection_id, &sql)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn execute_query(
    state: State<'_, AppState>,
    connection_id: String,
    database: Option<String>,
    sql: String,
    query_id: Option<String>,
    confirmed_safety: bool,
) -> CmdResult<QueryExecutionResponse> {
    state
        .manager
        .execute_query(
            &connection_id,
            database.as_deref(),
            &sql,
            query_id,
            confirmed_safety,
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn cancel_query(
    state: State<'_, AppState>,
    connection_id: String,
    query_id: String,
) -> CmdResult<()> {
    state
        .manager
        .cancel_query(&connection_id, &query_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn explain_query(
    state: State<'_, AppState>,
    connection_id: String,
    database: Option<String>,
    sql: String,
) -> CmdResult<ExplainPlanResult> {
    state
        .manager
        .explain_query(&connection_id, database.as_deref(), &sql)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn preview_staged_changes(
    state: State<'_, AppState>,
    request: ApplyChangesRequest,
) -> CmdResult<PreviewChangesResponse> {
    state
        .manager
        .preview_staged_changes(&request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn apply_staged_changes(
    state: State<'_, AppState>,
    request: ApplyChangesRequest,
) -> CmdResult<u64> {
    state
        .manager
        .apply_staged_changes(&request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn get_autocomplete_schema(
    state: State<'_, AppState>,
    connection_id: String,
    database: Option<String>,
    schema: Option<String>,
) -> CmdResult<AutocompleteSchema> {
    state
        .manager
        .get_autocomplete_schema(&connection_id, database.as_deref(), schema.as_deref())
        .await
        .map_err(Into::into)
}

#[tauri::command]
fn preview_table_ddl(engine: DbEngine, draft: TableDesignDraft) -> String {
    generate_table_design_ddl(engine, &draft)
}

#[tauri::command]
async fn execute_ddl(
    state: State<'_, AppState>,
    connection_id: String,
    database: Option<String>,
    ddl: String,
    confirmed_safety: bool,
) -> CmdResult<()> {
    state
        .manager
        .execute_ddl(&connection_id, database.as_deref(), &ddl, confirmed_safety)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn truncate_table(
    state: State<'_, AppState>,
    connection_id: String,
    database: Option<String>,
    schema: Option<String>,
    table: String,
    confirmed: bool,
) -> CmdResult<()> {
    state
        .manager
        .truncate_table(
            &connection_id,
            database.as_deref(),
            schema.as_deref(),
            &table,
            confirmed,
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn drop_object(
    state: State<'_, AppState>,
    connection_id: String,
    database: Option<String>,
    schema: Option<String>,
    name: String,
    kind: ObjectKind,
    confirmed: bool,
) -> CmdResult<()> {
    state
        .manager
        .drop_object(
            &connection_id,
            database.as_deref(),
            schema.as_deref(),
            &name,
            kind,
            confirmed,
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn create_database(
    state: State<'_, AppState>,
    connection_id: String,
    name: String,
    charset: Option<String>,
    collation: Option<String>,
) -> CmdResult<()> {
    state
        .manager
        .create_database(
            &connection_id,
            &name,
            charset.as_deref(),
            collation.as_deref(),
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn drop_database(
    state: State<'_, AppState>,
    connection_id: String,
    name: String,
    confirmed: bool,
) -> CmdResult<()> {
    state
        .manager
        .drop_database(&connection_id, &name, confirmed)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn duplicate_table(
    state: State<'_, AppState>,
    connection_id: String,
    database: Option<String>,
    schema: Option<String>,
    source: String,
    target: String,
    with_data: bool,
) -> CmdResult<()> {
    state
        .manager
        .duplicate_table(
            &connection_id,
            database.as_deref(),
            schema.as_deref(),
            &source,
            &target,
            with_data,
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn get_object_ddl(
    state: State<'_, AppState>,
    connection_id: String,
    database: Option<String>,
    schema: Option<String>,
    name: String,
    kind: ObjectKind,
) -> CmdResult<String> {
    state
        .manager
        .get_object_ddl(
            &connection_id,
            database.as_deref(),
            schema.as_deref(),
            &name,
            kind,
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
fn search_query_history(
    state: State<'_, AppState>,
    query: Option<String>,
    limit: Option<usize>,
) -> CmdResult<Vec<QueryHistoryEntry>> {
    state
        .storage
        .search_history(query.as_deref(), limit.unwrap_or(100))
        .map_err(Into::into)
}

#[tauri::command]
fn list_saved_queries(state: State<'_, AppState>) -> CmdResult<Vec<SavedQuery>> {
    state.storage.list_saved_queries().map_err(Into::into)
}

#[tauri::command]
fn save_query_file(
    state: State<'_, AppState>,
    folder: String,
    name: String,
    sql: String,
    connection_id: Option<String>,
    database: Option<String>,
    schema: Option<String>,
    engine: Option<DbEngine>,
    overwrite_path: Option<String>,
) -> CmdResult<SavedQuery> {
    state
        .storage
        .save_query_file(
            &folder,
            &name,
            &sql,
            connection_id.as_deref(),
            database.as_deref(),
            schema.as_deref(),
            engine,
            overwrite_path.as_deref(),
        )
        .map_err(Into::into)
}

#[tauri::command]
fn rename_saved_query(
    state: State<'_, AppState>,
    old_path: String,
    new_name: String,
) -> CmdResult<SavedQuery> {
    state
        .storage
        .rename_saved_query(&old_path, &new_name)
        .map_err(Into::into)
}

#[tauri::command]
fn duplicate_saved_query(
    state: State<'_, AppState>,
    path: String,
    new_name: String,
) -> CmdResult<SavedQuery> {
    state
        .storage
        .duplicate_saved_query(&path, &new_name)
        .map_err(Into::into)
}

#[tauri::command]
fn delete_saved_query(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    state.storage.delete_saved_query(&path).map_err(Into::into)
}

#[tauri::command]
fn list_snippets(state: State<'_, AppState>) -> CmdResult<Vec<CodeSnippet>> {
    state.storage.list_snippets().map_err(Into::into)
}

#[tauri::command]
fn save_snippet(state: State<'_, AppState>, snippet: CodeSnippet) -> CmdResult<Vec<CodeSnippet>> {
    state.storage.save_snippet(snippet).map_err(Into::into)
}

#[tauri::command]
fn save_recovery_state(state: State<'_, AppState>, key: String, payload: String) -> CmdResult<()> {
    state
        .storage
        .save_recovery_state(&key, &payload)
        .map_err(Into::into)
}

#[tauri::command]
fn load_recovery_state(state: State<'_, AppState>, key: String) -> CmdResult<Option<String>> {
    state.storage.load_recovery_state(&key).map_err(Into::into)
}

#[tauri::command]
async fn mongo_get_collection_metadata(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    collection: String,
) -> CmdResult<MongoCollectionMetadata> {
    state
        .manager
        .mongo_get_collection_metadata(&connection_id, &database, &collection)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn mongo_fetch_documents(
    state: State<'_, AppState>,
    request: MongoDocRequest,
) -> CmdResult<MongoDocResponse> {
    state
        .manager
        .mongo_fetch_documents(&request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn mongo_apply_document_changes(
    state: State<'_, AppState>,
    request: MongoApplyChangesRequest,
) -> CmdResult<u64> {
    state
        .manager
        .mongo_apply_document_changes(&request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn mongo_execute_mql(
    state: State<'_, AppState>,
    request: MongoQueryRequest,
) -> CmdResult<MongoQueryResponse> {
    state
        .manager
        .mongo_execute_mql(&request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn mongo_preview_aggregation_stages(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    collection: String,
    stages: Vec<MongoAggregationStage>,
) -> CmdResult<Vec<MongoAggregationStageResult>> {
    state
        .manager
        .mongo_preview_aggregation_stages(&connection_id, &database, &collection, &stages)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn mongo_create_index(
    state: State<'_, AppState>,
    request: MongoCreateIndexRequest,
) -> CmdResult<String> {
    state
        .manager
        .mongo_create_index(&request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn mongo_drop_index(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    collection: String,
    index_name: String,
) -> CmdResult<()> {
    state
        .manager
        .mongo_drop_index(&connection_id, &database, &collection, &index_name)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn mongo_update_validation(
    state: State<'_, AppState>,
    request: MongoValidationUpdateRequest,
) -> CmdResult<()> {
    state
        .manager
        .mongo_update_validation(&request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn mongo_explain_mql(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
    collection: String,
    filter_json: Option<String>,
) -> CmdResult<ExplainPlanResult> {
    state
        .manager
        .mongo_explain_mql(&connection_id, &database, &collection, filter_json.as_deref())
        .await
        .map_err(Into::into)
}

// ============================================================================
// Phase 3: Data Mobility Commands
// ============================================================================

#[tauri::command]
fn cancel_data_job(state: State<'_, AppState>, job_id: String) -> bool {
    state.manager.cancel_data_job(&job_id)
}

#[tauri::command]
async fn export_table_data(
    state: State<'_, AppState>,
    request: ExportRequest,
) -> CmdResult<DataJobResult> {
    state
        .manager
        .export_table_data(&request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
fn preview_import_file(
    state: State<'_, AppState>,
    request: ImportPreviewRequest,
) -> CmdResult<ImportPreviewResponse> {
    state
        .manager
        .preview_import_file(&request)
        .map_err(Into::into)
}

#[tauri::command]
async fn import_table_data(
    state: State<'_, AppState>,
    request: ImportRequest,
) -> CmdResult<DataJobResult> {
    state
        .manager
        .import_table_data(&request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn dump_sql(
    state: State<'_, AppState>,
    request: SqlDumpRequest,
) -> CmdResult<DataJobResult> {
    state.manager.dump_sql(&request).await.map_err(Into::into)
}

#[tauri::command]
async fn execute_sql_file(
    state: State<'_, AppState>,
    request: ExecuteSqlFileRequest,
) -> CmdResult<DataJobResult> {
    state
        .manager
        .execute_sql_file(&request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
fn detect_native_cli_tools(state: State<'_, AppState>) -> Vec<NativeCliToolInfo> {
    state.manager.detect_native_cli_tools()
}

#[tauri::command]
async fn run_native_cli(
    state: State<'_, AppState>,
    request: NativeCliRunRequest,
) -> CmdResult<NativeCliRunResult> {
    state
        .manager
        .run_native_cli(&request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
fn get_default_type_mappings(
    state: State<'_, AppState>,
    source_engine: DbEngine,
    target_engine: DbEngine,
) -> Vec<TypeMappingRule> {
    state
        .manager
        .get_default_type_mappings(source_engine, target_engine)
}

#[tauri::command]
async fn run_data_transfer(
    state: State<'_, AppState>,
    request: DataTransferRequest,
) -> CmdResult<DataTransferResult> {
    state
        .manager
        .run_data_transfer(&request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
fn list_job_profiles(
    state: State<'_, AppState>,
    kind: Option<String>,
) -> CmdResult<Vec<DataJobProfile>> {
    state
        .storage
        .list_job_profiles(kind.as_deref())
        .map_err(Into::into)
}

#[tauri::command]
fn save_job_profile(
    state: State<'_, AppState>,
    profile: DataJobProfile,
) -> CmdResult<DataJobProfile> {
    state
        .storage
        .save_job_profile(profile)
        .map_err(Into::into)
}

#[tauri::command]
fn delete_job_profile(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.storage.delete_job_profile(&id).map_err(Into::into)
}

// ============================================================================
// Phase 4: Schema Intelligence & Visual Design Commands
// ============================================================================

#[tauri::command]
async fn compute_structure_sync(
    state: State<'_, AppState>,
    request: StructureSyncRequest,
) -> CmdResult<StructureSyncPlan> {
    state
        .manager
        .compute_structure_sync(&request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn execute_sync_script(
    state: State<'_, AppState>,
    request: ExecuteSyncScriptRequest,
) -> CmdResult<SyncExecutionResult> {
    state
        .manager
        .execute_sync_script(&request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn compute_data_sync(
    state: State<'_, AppState>,
    request: DataSyncRequest,
) -> CmdResult<DataSyncPlan> {
    state
        .manager
        .compute_data_sync(&request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn reverse_engineer_schema(
    state: State<'_, AppState>,
    request: ReverseEngineerRequest,
) -> CmdResult<ErModel> {
    state
        .manager
        .reverse_engineer_schema(&request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
fn forward_engineer_model(
    state: State<'_, AppState>,
    request: ForwardEngineerRequest,
) -> ForwardEngineerResult {
    state.manager.forward_engineer_model(&request)
}

#[tauri::command]
fn auto_layout_er_model(state: State<'_, AppState>, model: ErModel) -> ErModel {
    state.manager.auto_layout_er_model(model)
}

#[tauri::command]
async fn diff_er_model_to_db(
    state: State<'_, AppState>,
    request: ErModelSyncRequest,
) -> CmdResult<StructureSyncPlan> {
    state
        .manager
        .diff_er_model_to_db(&request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
fn list_er_models(state: State<'_, AppState>) -> CmdResult<Vec<ErModel>> {
    state.storage.list_er_models().map_err(Into::into)
}

#[tauri::command]
fn save_er_model(state: State<'_, AppState>, model: ErModel) -> CmdResult<ErModel> {
    state.storage.save_er_model(model).map_err(Into::into)
}

#[tauri::command]
fn delete_er_model(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.storage.delete_er_model(&id).map_err(Into::into)
}

#[tauri::command]
fn generate_visual_query_sql(state: State<'_, AppState>, spec: VisualQuerySpec) -> String {
    state.manager.generate_visual_query_sql(&spec)
}

// ============================================================================
// Phase 5: Automation, Analytics (Charts/Dashboards) & Data Generation
// ============================================================================

#[tauri::command]
async fn infer_data_gen_rules(
    state: State<'_, AppState>,
    request: DataGenInferRequest,
) -> CmdResult<Vec<DataGenColumnRule>> {
    state
        .manager
        .infer_data_gen_rules(&request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn preview_data_gen(
    state: State<'_, AppState>,
    request: DataGenRequest,
) -> CmdResult<DataGenPreviewResult> {
    state
        .manager
        .preview_data_gen(&request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
async fn run_data_gen(
    state: State<'_, AppState>,
    request: DataGenRequest,
) -> CmdResult<DataGenResult> {
    state
        .manager
        .run_data_gen(&request)
        .await
        .map_err(Into::into)
}

#[tauri::command]
fn list_dashboards(state: State<'_, AppState>) -> CmdResult<Vec<ChartDashboard>> {
    state.storage.list_dashboards().map_err(Into::into)
}

#[tauri::command]
fn save_dashboard(
    state: State<'_, AppState>,
    dashboard: ChartDashboard,
) -> CmdResult<ChartDashboard> {
    state.storage.save_dashboard(dashboard).map_err(Into::into)
}

#[tauri::command]
fn delete_dashboard(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.storage.delete_dashboard(&id).map_err(Into::into)
}

#[tauri::command]
fn list_batch_jobs(state: State<'_, AppState>) -> CmdResult<Vec<BatchJob>> {
    state.storage.list_batch_jobs().map_err(Into::into)
}

#[tauri::command]
fn save_batch_job(state: State<'_, AppState>, job: BatchJob) -> CmdResult<BatchJob> {
    state.storage.save_batch_job(job).map_err(Into::into)
}

#[tauri::command]
fn delete_batch_job(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let _ = state.manager.remove_batch_job_timer(&id);
    state.storage.delete_batch_job(&id).map_err(Into::into)
}

#[tauri::command]
async fn run_batch_job(
    state: State<'_, AppState>,
    job_id: String,
    send_notify: Option<bool>,
) -> CmdResult<JobExecutionLog> {
    let job = state
        .storage
        .get_batch_job(&job_id)
        .map_err(SerializableError::from)?
        .ok_or_else(|| {
            SerializableError::from(dba_core::DbaError::Storage(format!(
                "Batch job '{}' not found",
                job_id
            )))
        })?;
    state
        .manager
        .run_batch_job(&job, send_notify.unwrap_or(true))
        .await
        .map_err(Into::into)
}

#[tauri::command]
fn list_job_logs(
    state: State<'_, AppState>,
    job_id: Option<String>,
    limit: Option<usize>,
) -> CmdResult<Vec<JobExecutionLog>> {
    state
        .storage
        .list_job_logs(job_id.as_deref(), limit.unwrap_or(50))
        .map_err(Into::into)
}

#[tauri::command]
fn clear_job_logs(state: State<'_, AppState>, job_id: Option<String>) -> CmdResult<()> {
    state
        .storage
        .clear_job_logs(job_id.as_deref())
        .map_err(Into::into)
}

#[tauri::command]
fn get_systemd_timer_status(
    state: State<'_, AppState>,
    job_id: String,
) -> CmdResult<SystemdTimerStatus> {
    state
        .manager
        .get_batch_job_timer_status(&job_id)
        .map_err(Into::into)
}

#[tauri::command]
fn sync_batch_job_timer(
    state: State<'_, AppState>,
    job: BatchJob,
) -> CmdResult<SystemdTimerStatus> {
    let saved = state
        .storage
        .save_batch_job(job)
        .map_err(SerializableError::from)?;
    state
        .manager
        .sync_batch_job_timer(&saved)
        .map_err(Into::into)
}

#[tauri::command]
fn remove_batch_job_timer(
    state: State<'_, AppState>,
    job_id: String,
) -> CmdResult<SystemdTimerStatus> {
    state
        .manager
        .remove_batch_job_timer(&job_id)
        .map_err(Into::into)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "dba_core=info,dba_tauri=info".into()),
        )
        .init();

    let storage = Arc::new(
        StorageManager::initialize().expect("Failed to initialize DBa local storage"),
    );
    let manager = Arc::new(ConnectionManager::new(storage.clone()));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AppState { manager, storage })
        .invoke_handler(tauri::generate_handler![
            list_connections,
            save_connection,
            delete_connection,
            get_connection_secret,
            parse_uri,
            test_connection,
            connect_db,
            disconnect_db,
            get_connected_ids,
            list_databases,
            list_schemas,
            list_objects,
            get_table_metadata,
            fetch_table_data,
            check_sql_safety,
            execute_query,
            cancel_query,
            explain_query,
            preview_staged_changes,
            apply_staged_changes,
            get_autocomplete_schema,
            preview_table_ddl,
            execute_ddl,
            truncate_table,
            drop_object,
            create_database,
            drop_database,
            duplicate_table,
            get_object_ddl,
            search_query_history,
            list_saved_queries,
            save_query_file,
            rename_saved_query,
            duplicate_saved_query,
            delete_saved_query,
            list_snippets,
            save_snippet,
            save_recovery_state,
            load_recovery_state,
            mongo_get_collection_metadata,
            mongo_fetch_documents,
            mongo_apply_document_changes,
            mongo_execute_mql,
            mongo_preview_aggregation_stages,
            mongo_create_index,
            mongo_drop_index,
            mongo_update_validation,
            mongo_explain_mql,
            cancel_data_job,
            export_table_data,
            preview_import_file,
            import_table_data,
            dump_sql,
            execute_sql_file,
            detect_native_cli_tools,
            run_native_cli,
            get_default_type_mappings,
            run_data_transfer,
            list_job_profiles,
            save_job_profile,
            delete_job_profile,
            compute_structure_sync,
            execute_sync_script,
            compute_data_sync,
            reverse_engineer_schema,
            forward_engineer_model,
            auto_layout_er_model,
            diff_er_model_to_db,
            list_er_models,
            save_er_model,
            delete_er_model,
            generate_visual_query_sql,
            infer_data_gen_rules,
            preview_data_gen,
            run_data_gen,
            list_dashboards,
            save_dashboard,
            delete_dashboard,
            list_batch_jobs,
            save_batch_job,
            delete_batch_job,
            run_batch_job,
            list_job_logs,
            clear_job_logs,
            get_systemd_timer_status,
            sync_batch_job_timer,
            remove_batch_job_timer,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DBa");
}
