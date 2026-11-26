import { invoke } from "@tauri-apps/api/core";
import type {
  ApiError,
  ApplyChangesRequest,
  AutocompleteSchema,
  BatchJob,
  ChartDashboard,
  CodeSnippet,
  ConnectionProfile,
  ConnectionSaveInput,
  ConnectionTestResult,
  DataGenColumnRule,
  DataGenInferRequest,
  DataGenPreviewResult,
  DataGenRequest,
  DataGenResult,
  DataJobProfile,
  DataJobResult,
  DataSyncPlan,
  DataSyncRequest,
  DataTransferRequest,
  DataTransferResult,
  DatabaseInfo,
  DatabaseObject,
  DbEngine,
  ErModel,
  ErModelSyncRequest,
  ExecuteSqlFileRequest,
  ExecuteSyncScriptRequest,
  ExplainPlanResult,
  ExportRequest,
  ForwardEngineerRequest,
  ForwardEngineerResult,
  ImportPreviewRequest,
  ImportPreviewResponse,
  ImportRequest,
  JobExecutionLog,
  MongoAggregationStage,
  MongoAggregationStageResult,
  MongoApplyChangesRequest,
  MongoCollectionMetadata,
  MongoCreateIndexRequest,
  MongoDocRequest,
  MongoDocResponse,
  MongoQueryRequest,
  MongoQueryResponse,
  MongoValidationUpdateRequest,
  NativeCliRunRequest,
  NativeCliRunResult,
  NativeCliToolInfo,
  ObjectKind,
  ParsedConnectionUri,
  PreviewChangesResponse,
  QueryExecutionResponse,
  QueryHistoryEntry,
  QueryResultSet,
  ReverseEngineerRequest,
  SafetyCheckResult,
  SavedQuery,
  SchemaInfo,
  SqlDumpRequest,
  StructureSyncPlan,
  StructureSyncRequest,
  SyncExecutionResult,
  SystemdTimerStatus,
  TableDataRequest,
  TableDesignDraft,
  TableMetadata,
  TypeMappingRule,
  VisualQuerySpec,
} from "../types/dba";

export function formatApiError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as Partial<ApiError>;
    const parts: string[] = [];
    if (e.code) parts.push(`[${e.code}]`);
    if (e.message) parts.push(e.message);
    if (e.detail) parts.push(`— ${e.detail}`);
    if (e.line) parts.push(`(pos ${e.line})`);
    if (parts.length > 0) return parts.join(" ");
  }
  return String(err);
}

export const api = {
  listConnections: () => invoke<ConnectionProfile[]>("list_connections"),
  saveConnection: (input: ConnectionSaveInput) =>
    invoke<ConnectionProfile>("save_connection", { input }),
  deleteConnection: (id: string) => invoke<void>("delete_connection", { id }),
  getConnectionSecret: (connectionId: string, kind: "db" | "ssh") =>
    invoke<string | null>("get_connection_secret", { connectionId, kind }),
  parseUri: (uri: string) => invoke<ParsedConnectionUri>("parse_uri", { uri }),
  testConnection: (input: ConnectionSaveInput) =>
    invoke<ConnectionTestResult>("test_connection", { input }),
  connectDb: (connectionId: string) =>
    invoke<ConnectionTestResult>("connect_db", { connectionId }),
  disconnectDb: (connectionId: string) =>
    invoke<void>("disconnect_db", { connectionId }),
  getConnectedIds: () => invoke<string[]>("get_connected_ids"),

  listDatabases: (connectionId: string) =>
    invoke<DatabaseInfo[]>("list_databases", { connectionId }),
  createDatabase: (
    connectionId: string,
    name: string,
    charset?: string,
    collation?: string
  ) =>
    invoke<void>("create_database", {
      connectionId,
      name,
      charset,
      collation,
    }),
  dropDatabase: (connectionId: string, name: string, confirmed: boolean) =>
    invoke<void>("drop_database", { connectionId, name, confirmed }),
  listSchemas: (connectionId: string, database?: string) =>
    invoke<SchemaInfo[]>("list_schemas", { connectionId, database }),
  listObjects: (connectionId: string, database?: string, schema?: string) =>
    invoke<DatabaseObject[]>("list_objects", { connectionId, database, schema }),
  getTableMetadata: (
    connectionId: string,
    table: string,
    database?: string,
    schema?: string
  ) =>
    invoke<TableMetadata>("get_table_metadata", {
      connectionId,
      database,
      schema,
      table,
    }),

  fetchTableData: (request: TableDataRequest) =>
    invoke<QueryResultSet>("fetch_table_data", { request }),

  checkSqlSafety: (connectionId: string, sql: string) =>
    invoke<SafetyCheckResult>("check_sql_safety", { connectionId, sql }),

  executeQuery: (
    connectionId: string,
    sql: string,
    database?: string,
    queryId?: string,
    confirmedSafety = false
  ) =>
    invoke<QueryExecutionResponse>("execute_query", {
      connectionId,
      database,
      sql,
      queryId,
      confirmedSafety,
    }),

  cancelQuery: (connectionId: string, queryId: string) =>
    invoke<void>("cancel_query", { connectionId, queryId }),

  explainQuery: (connectionId: string, sql: string, database?: string) =>
    invoke<ExplainPlanResult>("explain_query", { connectionId, database, sql }),

  previewStagedChanges: (request: ApplyChangesRequest) =>
    invoke<PreviewChangesResponse>("preview_staged_changes", { request }),
  applyStagedChanges: (request: ApplyChangesRequest) =>
    invoke<number>("apply_staged_changes", { request }),

  getAutocompleteSchema: (
    connectionId: string,
    database?: string,
    schema?: string
  ) =>
    invoke<AutocompleteSchema>("get_autocomplete_schema", {
      connectionId,
      database,
      schema,
    }),

  previewTableDdl: (engine: DbEngine, draft: TableDesignDraft) =>
    invoke<string>("preview_table_ddl", { engine, draft }),
  executeDdl: (
    connectionId: string,
    ddl: string,
    database?: string,
    confirmedSafety = false
  ) =>
    invoke<void>("execute_ddl", {
      connectionId,
      database,
      ddl,
      confirmedSafety,
    }),

  truncateTable: (
    connectionId: string,
    table: string,
    confirmed: boolean,
    database?: string,
    schema?: string
  ) =>
    invoke<void>("truncate_table", {
      connectionId,
      database,
      schema,
      table,
      confirmed,
    }),

  dropObject: (
    connectionId: string,
    name: string,
    kind: ObjectKind,
    confirmed: boolean,
    database?: string,
    schema?: string
  ) =>
    invoke<void>("drop_object", {
      connectionId,
      database,
      schema,
      name,
      kind,
      confirmed,
    }),

  duplicateTable: (
    connectionId: string,
    source: string,
    target: string,
    withData: boolean,
    database?: string,
    schema?: string
  ) =>
    invoke<void>("duplicate_table", {
      connectionId,
      database,
      schema,
      source,
      target,
      withData,
    }),

  renameTable: (
    connectionId: string,
    oldName: string,
    newName: string,
    database?: string,
    schema?: string,
    confirmedProduction = false
  ) =>
    invoke<void>("rename_table", {
      connectionId,
      database,
      schema,
      oldName,
      newName,
      confirmedProduction,
    }),

  createSchema: (
    connectionId: string,
    name: string,
    database?: string,
    confirmedProduction = false
  ) =>
    invoke<void>("create_schema", {
      connectionId,
      database,
      name,
      confirmedProduction,
    }),

  dropSchema: (
    connectionId: string,
    name: string,
    confirmed: boolean,
    database?: string,
    cascade = false
  ) =>
    invoke<void>("drop_schema", {
      connectionId,
      database,
      name,
      cascade,
      confirmed,
    }),

  getObjectDdl: (
    connectionId: string,
    name: string,
    kind: ObjectKind,
    database?: string,
    schema?: string
  ) =>
    invoke<string>("get_object_ddl", {
      connectionId,
      database,
      schema,
      name,
      kind,
    }),

  searchQueryHistory: (query?: string, limit = 100) =>
    invoke<QueryHistoryEntry[]>("search_query_history", { query, limit }),
  listSavedQueries: () => invoke<SavedQuery[]>("list_saved_queries"),
  saveQueryFile: (
    folder: string,
    name: string,
    sql: string,
    options?: {
      connectionId?: string | null;
      database?: string | null;
      schema?: string | null;
      engine?: DbEngine | null;
      overwritePath?: string | null;
    }
  ) =>
    invoke<SavedQuery>("save_query_file", {
      folder,
      name,
      sql,
      connectionId: options?.connectionId ?? null,
      database: options?.database ?? null,
      schema: options?.schema ?? null,
      engine: options?.engine ?? null,
      overwritePath: options?.overwritePath ?? null,
    }),
  renameSavedQuery: (oldPath: string, newName: string) =>
    invoke<SavedQuery>("rename_saved_query", { oldPath, newName }),
  duplicateSavedQuery: (path: string, newName: string) =>
    invoke<SavedQuery>("duplicate_saved_query", { path, newName }),
  deleteSavedQuery: (path: string) => invoke<void>("delete_saved_query", { path }),

  listSnippets: () => invoke<CodeSnippet[]>("list_snippets"),
  saveSnippet: (snippet: CodeSnippet) =>
    invoke<CodeSnippet[]>("save_snippet", { snippet }),
  deleteSnippet: (id: string) =>
    invoke<CodeSnippet[]>("delete_snippet", { id }),

  saveRecoveryState: (key: string, payload: string) =>
    invoke<void>("save_recovery_state", { key, payload }),
  loadRecoveryState: (key: string) =>
    invoke<string | null>("load_recovery_state", { key }),

  // Phase 2: MongoDB Native Commands
  mongoGetCollectionMetadata: (
    connectionId: string,
    database: string,
    collection: string
  ) =>
    invoke<MongoCollectionMetadata>("mongo_get_collection_metadata", {
      connectionId,
      database,
      collection,
    }),
  mongoFetchDocuments: (request: MongoDocRequest) =>
    invoke<MongoDocResponse>("mongo_fetch_documents", { request }),
  mongoApplyDocumentChanges: (request: MongoApplyChangesRequest) =>
    invoke<number>("mongo_apply_document_changes", { request }),
  mongoExecuteMql: (request: MongoQueryRequest) =>
    invoke<MongoQueryResponse>("mongo_execute_mql", { request }),
  mongoPreviewAggregationStages: (
    connectionId: string,
    database: string,
    collection: string,
    stages: MongoAggregationStage[]
  ) =>
    invoke<MongoAggregationStageResult[]>("mongo_preview_aggregation_stages", {
      connectionId,
      database,
      collection,
      stages,
    }),
  mongoCreateIndex: (request: MongoCreateIndexRequest) =>
    invoke<string>("mongo_create_index", { request }),
  mongoDropIndex: (
    connectionId: string,
    database: string,
    collection: string,
    indexName: string
  ) =>
    invoke<void>("mongo_drop_index", {
      connectionId,
      database,
      collection,
      indexName,
    }),
  mongoUpdateValidation: (request: MongoValidationUpdateRequest) =>
    invoke<void>("mongo_update_validation", { request }),
  mongoExplainMql: (
    connectionId: string,
    database: string,
    collection: string,
    filterJson?: string
  ) =>
    invoke<ExplainPlanResult>("mongo_explain_mql", {
      connectionId,
      database,
      collection,
      filterJson,
    }),

  // Phase 3: Data Mobility Commands
  cancelDataJob: (jobId: string) => invoke<boolean>("cancel_data_job", { jobId }),
  exportTableData: (request: ExportRequest) =>
    invoke<DataJobResult>("export_table_data", { request }),
  previewImportFile: (request: ImportPreviewRequest) =>
    invoke<ImportPreviewResponse>("preview_import_file", { request }),
  importTableData: (request: ImportRequest) =>
    invoke<DataJobResult>("import_table_data", { request }),
  dumpSql: (request: SqlDumpRequest) => invoke<DataJobResult>("dump_sql", { request }),
  executeSqlFile: (request: ExecuteSqlFileRequest) =>
    invoke<DataJobResult>("execute_sql_file", { request }),
  detectNativeCliTools: () => invoke<NativeCliToolInfo[]>("detect_native_cli_tools"),
  runNativeCli: (request: NativeCliRunRequest) =>
    invoke<NativeCliRunResult>("run_native_cli", { request }),
  getDefaultTypeMappings: (sourceEngine: DbEngine, targetEngine: DbEngine) =>
    invoke<TypeMappingRule[]>("get_default_type_mappings", { sourceEngine, targetEngine }),
  runDataTransfer: (request: DataTransferRequest) =>
    invoke<DataTransferResult>("run_data_transfer", { request }),
  listJobProfiles: (kind?: string) => invoke<DataJobProfile[]>("list_job_profiles", { kind }),
  saveJobProfile: (profile: DataJobProfile) =>
    invoke<DataJobProfile>("save_job_profile", { profile }),
  deleteJobProfile: (id: string) => invoke<void>("delete_job_profile", { id }),

  // Phase 4: Schema Intelligence & Visual Design
  computeStructureSync: (request: StructureSyncRequest) =>
    invoke<StructureSyncPlan>("compute_structure_sync", { request }),
  executeSyncScript: (request: ExecuteSyncScriptRequest) =>
    invoke<SyncExecutionResult>("execute_sync_script", { request }),
  computeDataSync: (request: DataSyncRequest) =>
    invoke<DataSyncPlan>("compute_data_sync", { request }),
  reverseEngineerSchema: (request: ReverseEngineerRequest) =>
    invoke<ErModel>("reverse_engineer_schema", { request }),
  forwardEngineerModel: (request: ForwardEngineerRequest) =>
    invoke<ForwardEngineerResult>("forward_engineer_model", { request }),
  autoLayoutErModel: (model: ErModel) =>
    invoke<ErModel>("auto_layout_er_model", { model }),
  diffErModelToDb: (request: ErModelSyncRequest) =>
    invoke<StructureSyncPlan>("diff_er_model_to_db", { request }),
  listErModels: () => invoke<ErModel[]>("list_er_models"),
  saveErModel: (model: ErModel) => invoke<ErModel>("save_er_model", { model }),
  deleteErModel: (id: string) => invoke<void>("delete_er_model", { id }),
  generateVisualQuerySql: (spec: VisualQuerySpec) =>
    invoke<string>("generate_visual_query_sql", { spec }),

  // Phase 5: Automation, Analytics (Charts/Dashboards) & Data Generation
  inferDataGenRules: (request: DataGenInferRequest) =>
    invoke<DataGenColumnRule[]>("infer_data_gen_rules", { request }),
  previewDataGen: (request: DataGenRequest) =>
    invoke<DataGenPreviewResult>("preview_data_gen", { request }),
  runDataGen: (request: DataGenRequest) =>
    invoke<DataGenResult>("run_data_gen", { request }),

  listDashboards: () => invoke<ChartDashboard[]>("list_dashboards"),
  saveDashboard: (dashboard: ChartDashboard) =>
    invoke<ChartDashboard>("save_dashboard", { dashboard }),
  deleteDashboard: (id: string) => invoke<void>("delete_dashboard", { id }),

  listBatchJobs: () => invoke<BatchJob[]>("list_batch_jobs"),
  saveBatchJob: (job: BatchJob) => invoke<BatchJob>("save_batch_job", { job }),
  deleteBatchJob: (id: string) => invoke<void>("delete_batch_job", { id }),
  runBatchJob: (jobId: string, sendNotify = true) =>
    invoke<JobExecutionLog>("run_batch_job", { jobId, sendNotify }),
  listJobLogs: (jobId?: string, limit = 50) =>
    invoke<JobExecutionLog[]>("list_job_logs", { jobId, limit }),
  clearJobLogs: (jobId?: string) => invoke<void>("clear_job_logs", { jobId }),
  getSystemdTimerStatus: (jobId: string) =>
    invoke<SystemdTimerStatus>("get_systemd_timer_status", { jobId }),
  syncBatchJobTimer: (job: BatchJob) =>
    invoke<SystemdTimerStatus>("sync_batch_job_timer", { job }),
  removeBatchJobTimer: (jobId: string) =>
    invoke<SystemdTimerStatus>("remove_batch_job_timer", { jobId }),
};
