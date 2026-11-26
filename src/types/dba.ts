export type DbEngine = "postgres" | "mysql" | "mssql" | "mongodb";
export type EnvironmentTag = "local" | "dev" | "staging" | "production";
export type SslMode = "disable" | "prefer" | "require" | "verify-ca" | "verify-full";
export type SshAuthMethod = "password" | "privatekey";

export interface SslConfig {
  mode: SslMode;
  caCertPath?: string | null;
  clientCertPath?: string | null;
  clientKeyPath?: string | null;
}

export interface SshConfig {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  privateKeyPath?: string | null;
  jumpHost?: string | null;
  keyringRef?: string | null;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  engine: DbEngine;
  host: string;
  port: number;
  database?: string | null;
  username: string;
  keyringRef?: string | null;
  groupPath?: string | null;
  environment: EnvironmentTag;
  color?: string | null;
  readOnly: boolean;
  ssl: SslConfig;
  ssh: SshConfig;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionSaveInput {
  profile: ConnectionProfile;
  password?: string | null;
  sshSecret?: string | null;
}

export interface ParsedConnectionUri {
  engine: DbEngine;
  host: string;
  port: number;
  database?: string | null;
  username: string;
  password?: string | null;
  sslMode?: SslMode | null;
}

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  serverVersion?: string | null;
  message: string;
}

export interface DatabaseInfo {
  name: string;
  sizeBytes?: number | null;
}

export interface SchemaInfo {
  name: string;
}

export type ObjectKind =
  | "table"
  | "view"
  | "materialized_view"
  | "function"
  | "procedure"
  | "trigger"
  | "index"
  | "sequence"
  | "enum_type"
  | "event"
  | "collection";

export interface DatabaseObject {
  name: string;
  schema?: string | null;
  kind: ObjectKind;
  rowEstimate?: number | null;
  comment?: string | null;
}

export interface ColumnMeta {
  name: string;
  dataType: string;
  udtName?: string | null;
  maxLength?: number | null;
  numericPrecision?: number | null;
  numericScale?: number | null;
  nullable: boolean;
  defaultValue?: string | null;
  isPrimaryKey: boolean;
  isAutoIncrement: boolean;
  comment?: string | null;
}

export interface IndexMeta {
  name: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
  method: string;
  definition?: string | null;
}

export interface ForeignKeyMeta {
  name: string;
  columns: string[];
  refSchema?: string | null;
  refTable: string;
  refColumns: string[];
  onUpdate: string;
  onDelete: string;
}

export interface CheckConstraintMeta {
  name: string;
  expression: string;
}

export interface TableMetadata {
  schema?: string | null;
  name: string;
  columns: ColumnMeta[];
  indexes: IndexMeta[];
  foreignKeys: ForeignKeyMeta[];
  checks: CheckConstraintMeta[];
  rowEstimate?: number | null;
  ddl?: string | null;
}

export interface RoutineParameter {
  name: string;
  mode: string;
  dataType: string;
  defaultValue?: string | null;
  position: number;
}

export interface RoutineSignature {
  name: string;
  schema?: string | null;
  kind: ObjectKind;
  returnType?: string | null;
  language?: string | null;
  parameters: RoutineParameter[];
}

export interface SaveObjectDdlRequest {
  connectionId: string;
  database?: string | null;
  schema?: string | null;
  name: string;
  kind: ObjectKind;
  isNew: boolean;
  ddl: string;
  originalName?: string | null;
  confirmedProduction: boolean;
}

export interface FilterCondition {
  column: string;
  operator: string;
  value?: string | null;
  value2?: string | null;
}

export interface SortSpec {
  column: string;
  direction: "ASC" | "DESC";
}

export interface TableDataRequest {
  connectionId: string;
  database?: string | null;
  schema?: string | null;
  table: string;
  page: number;
  pageSize: number;
  filters: FilterCondition[];
  sorts: SortSpec[];
}

export interface ForeignKeyTarget {
  schema?: string | null;
  table: string;
  column: string;
}

export interface ResultColumn {
  name: string;
  dataType: string;
  isPrimaryKey: boolean;
  fkTarget?: ForeignKeyTarget | null;
}

export interface QueryResultSet {
  columns: ResultColumn[];
  rows: unknown[][];
  rowsAffected?: number | null;
  totalCount?: number | null;
  executionMs: number;
  statement: string;
}

export interface QueryExecutionResponse {
  queryId: string;
  resultSets: QueryResultSet[];
  totalExecutionMs: number;
}

export type StagedChange =
  | { kind: "insert"; values: Record<string, unknown> }
  | {
      kind: "update";
      primary_keys: Record<string, unknown>;
      changes: Record<string, unknown>;
    }
  | { kind: "delete"; primary_keys: Record<string, unknown> };

export interface ApplyChangesRequest {
  connectionId: string;
  database?: string | null;
  schema?: string | null;
  table: string;
  changes: StagedChange[];
  confirmedProduction: boolean;
}

export interface PreviewChangesResponse {
  statements: string[];
  requiresConfirmation: boolean;
  safetyWarnings: string[];
}

export interface SafetyCheckResult {
  allowed: boolean;
  requiresConfirmation: boolean;
  warnings: string[];
  isWrite: boolean;
  isDestructive: boolean;
}

export interface ExplainNode {
  nodeType: string;
  relation?: string | null;
  startupCost?: number | null;
  totalCost?: number | null;
  planRows?: number | null;
  actualTimeMs?: number | null;
  actualRows?: number | null;
  isFullScan: boolean;
  extra?: string | null;
  children: ExplainNode[];
}

export interface ExplainPlanResult {
  root?: ExplainNode | null;
  rawJson: unknown;
  executionMs: number;
}

export interface QueryHistoryEntry {
  id: string;
  connectionId: string;
  connectionName: string;
  database?: string | null;
  sql: string;
  executedAt: string;
  durationMs: number;
  rowCount?: number | null;
  status: "ok" | "error" | "cancelled";
  errorMessage?: string | null;
}

export interface SavedQuery {
  id: string;
  name: string;
  folder: string;
  connectionId?: string | null;
  database?: string | null;
  schema?: string | null;
  engine?: DbEngine | null;
  sql: string;
  path: string;
  updatedAt: string;
}

export interface CodeSnippet {
  id: string;
  name: string;
  description: string;
  engine?: DbEngine | null;
  body: string;
}

export interface TableDesignColumn {
  name: string;
  originalName?: string | null;
  dataType: string;
  length?: string | null;
  nullable: boolean;
  defaultValue?: string | null;
  isPrimaryKey: boolean;
  isAutoIncrement: boolean;
  comment?: string | null;
}

export interface TableDesignDraft {
  isNewTable: boolean;
  schema?: string | null;
  tableName: string;
  columns: TableDesignColumn[];
  indexes: IndexMeta[];
  foreignKeys: ForeignKeyMeta[];
  checks: CheckConstraintMeta[];
}

export interface AutocompleteSchema {
  tables: Record<string, string[]>;
}

export interface ApiError {
  kind: string;
  message: string;
  code?: string | null;
  detail?: string | null;
  line?: number | null;
}

// ============================================================================
// Phase 2: MongoDB / NoSQL Types
// ============================================================================

export interface MongoIndexSpec {
  name: string;
  keys: Record<string, unknown>;
  unique: boolean;
  sparse: boolean;
  ttlSeconds?: number | null;
  partialFilterExpression?: Record<string, unknown> | null;
}

export interface MongoCollectionOptions {
  capped: boolean;
  maxSizeBytes?: number | null;
  maxDocs?: number | null;
  validator?: Record<string, unknown> | null;
  validationLevel?: string | null;
  validationAction?: string | null;
}

export interface MongoCollectionMetadata {
  database: string;
  name: string;
  documentCount: number;
  avgDocSize?: number | null;
  storageSize?: number | null;
  indexes: MongoIndexSpec[];
  options: MongoCollectionOptions;
}

export interface MongoDocRequest {
  connectionId: string;
  database: string;
  collection: string;
  filterJson?: string | null;
  sortJson?: string | null;
  projectionJson?: string | null;
  page: number;
  pageSize: number;
}

export interface MongoDocResponse {
  documents: Record<string, unknown>[];
  totalCount: number;
  executionMs: number;
}

export type MongoDocChange =
  | { kind: "insert"; document: Record<string, unknown> }
  | { kind: "update"; id: unknown; document: Record<string, unknown> }
  | { kind: "delete"; id: unknown };

export interface MongoApplyChangesRequest {
  connectionId: string;
  database: string;
  collection: string;
  changes: MongoDocChange[];
  confirmedProduction: boolean;
}

export interface MongoQueryRequest {
  connectionId: string;
  database: string;
  collection: string;
  operation:
    | "find"
    | "aggregate"
    | "count"
    | "insertOne"
    | "updateMany"
    | "deleteMany"
    | "command";
  filterJson?: string | null;
  sortJson?: string | null;
  projectionJson?: string | null;
  pipelineJson?: string | null;
  documentJson?: string | null;
  updateJson?: string | null;
  limit?: number | null;
  skip?: number | null;
  confirmedSafety: boolean;
}

export interface MongoQueryResponse {
  documents: Record<string, unknown>[];
  affectedCount?: number | null;
  executionMs: number;
  summary: string;
}

export interface MongoAggregationStage {
  id: string;
  operator: string;
  bodyJson: string;
  enabled: boolean;
}

export interface MongoAggregationStageResult {
  stageIndex: number;
  operator: string;
  docCount: number;
  sampleDocs: Record<string, unknown>[];
  executionMs: number;
  error?: string | null;
}

export interface MongoCreateIndexRequest {
  connectionId: string;
  database: string;
  collection: string;
  name?: string | null;
  keysJson: string;
  unique: boolean;
  sparse: boolean;
  ttlSeconds?: number | null;
  partialFilterJson?: string | null;
}

export interface MongoValidationUpdateRequest {
  connectionId: string;
  database: string;
  collection: string;
  validatorJson?: string | null;
  validationLevel: string;
  validationAction: string;
  confirmedProduction: boolean;
}

// ============================================================================
// Phase 3: Data Mobility Types
// ============================================================================

export type DataFileFormat = "csv" | "json" | "jsonl" | "xlsx" | "sql";
export type SqlExportMode = "insert" | "upsert";
export type ImportErrorPolicy = "stop_on_error" | "skip_and_log";
export type TransferTableMode =
  | "drop_and_recreate"
  | "create_if_not_exists"
  | "append"
  | "upsert";

export interface ColumnMapping {
  sourceColumn: string;
  targetColumn: string;
  included: boolean;
  targetType?: string | null;
}

export interface ExportRequest {
  jobId?: string | null;
  connectionId: string;
  database?: string | null;
  schema?: string | null;
  table: string;
  format: DataFileFormat;
  outputPath: string;
  delimiter?: string | null;
  includeHeaders: boolean;
  sqlMode: SqlExportMode;
  batchSize?: number | null;
  columnMappings: ColumnMapping[];
}

export interface ImportPreviewRequest {
  filePath: string;
  format: DataFileFormat;
  delimiter?: string | null;
  hasHeaders: boolean;
  sampleRows?: number | null;
}

export interface ImportPreviewResponse {
  columns: string[];
  sampleRows: unknown[][];
  detectedFormat: DataFileFormat;
}

export interface ImportRequest {
  jobId?: string | null;
  connectionId: string;
  database?: string | null;
  schema?: string | null;
  table: string;
  format: DataFileFormat;
  filePath: string;
  delimiter?: string | null;
  hasHeaders: boolean;
  columnMappings: ColumnMapping[];
  errorPolicy: ImportErrorPolicy;
  batchSize?: number | null;
  truncateBefore: boolean;
  confirmedProduction: boolean;
}

export interface DataJobResult {
  jobId: string;
  ok: boolean;
  cancelled: boolean;
  rowsProcessed: number;
  rowsFailed: number;
  durationMs: number;
  outputPath?: string | null;
  summary: string;
  errors: string[];
}

export interface DataJobProgress {
  jobId: string;
  percent: number;
  currentItem: string;
  completedItems: number;
  totalItems: number;
  rowsProcessed: number;
  elapsedMs: number;
}

export interface DataJobProfile {
  id: string;
  name: string;
  kind: "export" | "import" | "dump" | "transfer" | string;
  config: Record<string, unknown>;
  updatedAt: string;
}

export interface SqlDumpRequest {
  jobId?: string | null;
  connectionId: string;
  database?: string | null;
  schema?: string | null;
  tables: string[];
  outputPath: string;
  includeStructure: boolean;
  includeData: boolean;
  dropExisting: boolean;
  chunkSize?: number | null;
}

export interface ExecuteSqlFileRequest {
  jobId?: string | null;
  connectionId: string;
  database?: string | null;
  filePath: string;
  errorPolicy: ImportErrorPolicy;
  confirmedProduction: boolean;
}

export interface NativeCliToolInfo {
  name: string;
  engine: DbEngine;
  role: "dump" | "restore" | string;
  available: boolean;
  path?: string | null;
  version?: string | null;
}

export interface NativeCliRunRequest {
  connectionId: string;
  database?: string | null;
  tool: string;
  filePath: string;
  format?: string | null;
  compress: boolean;
  parallelJobs?: number | null;
  schemaOnly: boolean;
  dataOnly: boolean;
  extraArgs: string[];
  confirmedProduction: boolean;
}

export interface NativeCliRunResult {
  ok: boolean;
  exitCode: number;
  commandPreview: string;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface TypeMappingRule {
  sourceType: string;
  targetType: string;
}

export interface TransferTableSelection {
  sourceTable: string;
  targetTable: string;
  includeData: boolean;
}

export interface TransferObjectSelection {
  name: string;
  kind: ObjectKind;
}

export interface DataTransferRequest {
  jobId?: string | null;
  sourceConnectionId: string;
  sourceDatabase?: string | null;
  sourceSchema?: string | null;
  targetConnectionId: string;
  targetDatabase?: string | null;
  targetSchema?: string | null;
  tables: TransferTableSelection[];
  objects?: TransferObjectSelection[];
  mode: TransferTableMode;
  typeMappings: TypeMappingRule[];
  batchSize?: number | null;
  errorPolicy: ImportErrorPolicy;
  confirmedProduction: boolean;
}

export interface TransferTableReport {
  sourceTable: string;
  targetTable: string;
  rowsTransferred: number;
  ok: boolean;
  error?: string | null;
}

export interface TransferObjectReport {
  name: string;
  kind: ObjectKind;
  ok: boolean;
  error?: string | null;
}

export interface DataTransferResult {
  jobId: string;
  ok: boolean;
  cancelled: boolean;
  totalRows: number;
  durationMs: number;
  tables: TransferTableReport[];
  objects?: TransferObjectReport[];
  summary: string;
}

// ============================================================================
// Phase 4: Schema Intelligence & Visual Design (Sync, ER Model, Query Builder)
// ============================================================================

export type SyncDiffStatus = "new" | "modified" | "deleted" | "unchanged";

export interface StructureSyncRequest {
  sourceConnectionId: string;
  sourceDatabase?: string | null;
  sourceSchema?: string | null;
  targetConnectionId: string;
  targetDatabase?: string | null;
  targetSchema?: string | null;
  includeDrops: boolean;
}

export interface ColumnDiff {
  name: string;
  status: SyncDiffStatus;
  sourceType?: string | null;
  targetType?: string | null;
  sourceNullable?: boolean | null;
  targetNullable?: boolean | null;
  sourceDefault?: string | null;
  targetDefault?: string | null;
  details: string;
}

export interface IndexDiff {
  name: string;
  status: SyncDiffStatus;
  sourceColumns: string[];
  targetColumns: string[];
  isUnique: boolean;
  details: string;
}

export interface ForeignKeyDiff {
  name: string;
  status: SyncDiffStatus;
  sourceSummary?: string | null;
  targetSummary?: string | null;
}

export interface TableStructureDiff {
  tableName: string;
  status: SyncDiffStatus;
  columnDiffs: ColumnDiff[];
  indexDiffs: IndexDiff[];
  fkDiffs: ForeignKeyDiff[];
  ddlStatements: string[];
}

export interface StructureSyncPlan {
  sourceEngine: DbEngine;
  targetEngine: DbEngine;
  tables: TableStructureDiff[];
  fullScript: string;
  summary: string;
}

export interface ExecuteSyncScriptRequest {
  connectionId: string;
  database?: string | null;
  statements: string[];
  stopOnError: boolean;
  confirmedProduction: boolean;
}

export interface SyncExecutionResult {
  ok: boolean;
  statementsExecuted: number;
  statementsFailed: number;
  durationMs: number;
  errors: string[];
  summary: string;
}

export interface DataSyncTableSpec {
  sourceTable: string;
  targetTable: string;
  keyColumns: string[];
}

export interface DataSyncRequest {
  sourceConnectionId: string;
  sourceDatabase?: string | null;
  sourceSchema?: string | null;
  targetConnectionId: string;
  targetDatabase?: string | null;
  targetSchema?: string | null;
  tables: DataSyncTableSpec[];
  includeDeletes: boolean;
  maxDiffRowsPerTable?: number | null;
}

export type RowDiffKind = "insert" | "update" | "delete";

export interface RowDiffEntry {
  kind: RowDiffKind;
  keyValues: Record<string, unknown>;
  sourceRow?: Record<string, unknown> | null;
  targetRow?: Record<string, unknown> | null;
  changedColumns: string[];
  sql: string;
}

export interface TableDataDiff {
  sourceTable: string;
  targetTable: string;
  keyColumns: string[];
  inserts: number;
  updates: number;
  deletes: number;
  unchanged: number;
  sampleDiffs: RowDiffEntry[];
  statements: string[];
  error?: string | null;
}

export interface DataSyncPlan {
  tables: TableDataDiff[];
  totalInserts: number;
  totalUpdates: number;
  totalDeletes: number;
  fullScript: string;
  summary: string;
}

export type ErCardinality = "one_to_one" | "one_to_many" | "many_to_many";

export interface ErTableNode {
  id: string;
  name: string;
  schema?: string | null;
  x: number;
  y: number;
  color?: string | null;
  group?: string | null;
  columns: TableDesignColumn[];
  indexes: IndexMeta[];
}

export interface ErRelationship {
  id: string;
  name: string;
  sourceTableId: string;
  sourceColumn: string;
  targetTableId: string;
  targetColumn: string;
  cardinality: ErCardinality;
  onUpdate: string;
  onDelete: string;
}

export interface ErModel {
  id: string;
  name: string;
  engine: DbEngine;
  database?: string | null;
  schema?: string | null;
  tables: ErTableNode[];
  relationships: ErRelationship[];
  updatedAt: string;
}

export interface ReverseEngineerRequest {
  connectionId: string;
  database?: string | null;
  schema?: string | null;
  modelName?: string | null;
}

export interface ForwardEngineerRequest {
  model: ErModel;
  targetEngine: DbEngine;
  includeDrops: boolean;
}

export interface ForwardEngineerResult {
  ddl: string;
  statements: string[];
}

export interface ErModelSyncRequest {
  model: ErModel;
  targetConnectionId: string;
  targetDatabase?: string | null;
  targetSchema?: string | null;
  includeDrops: boolean;
}

export type QbJoinType = "inner" | "left" | "right" | "full";

export interface QbTableItem {
  id: string;
  schema?: string | null;
  table: string;
  alias: string;
  x: number;
  y: number;
}

export interface QbJoinItem {
  id: string;
  leftTableId: string;
  leftColumn: string;
  rightTableId: string;
  rightColumn: string;
  joinType: QbJoinType;
}

export interface QbSelectColumn {
  tableId: string;
  column: string;
  alias?: string | null;
  aggregate?: string | null;
  selected: boolean;
}

export interface QbWhereCondition {
  id: string;
  conjunction: "AND" | "OR";
  tableId: string;
  column: string;
  operator: string;
  value?: string | null;
}

export interface QbOrderItem {
  tableId: string;
  column: string;
  direction: "ASC" | "DESC";
}

export interface VisualQuerySpec {
  engine: DbEngine;
  distinct: boolean;
  tables: QbTableItem[];
  joins: QbJoinItem[];
  columns: QbSelectColumn[];
  whereConditions: QbWhereCondition[];
  groupBy: string[];
  having?: string | null;
  orderBy: QbOrderItem[];
  limit?: number | null;
}

// ============================================================================
// Phase 5: Automation, Analytics (Charts/Dashboards) & Data Generation
// ============================================================================

export type DataGenGeneratorKind =
  | "auto_increment_skip"
  | "uuid"
  | "full_name"
  | "first_name"
  | "last_name"
  | "email"
  | "phone"
  | "address"
  | "city"
  | "country"
  | "company"
  | "username"
  | "url"
  | "boolean"
  | "integer_range"
  | "decimal_range"
  | "date_range"
  | "timestamp_range"
  | "enum_list"
  | "text_lorem"
  | "regex_pattern"
  | "foreign_key_sample"
  | "null";

export interface DataGenColumnRule {
  column: string;
  dataType: string;
  generator: DataGenGeneratorKind;
  nullPercent: number;
  minNum?: number | null;
  maxNum?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  enumValues: string[];
  pattern?: string | null;
  fkSchema?: string | null;
  fkTable?: string | null;
  fkColumn?: string | null;
}

export interface DataGenInferRequest {
  connectionId: string;
  database?: string | null;
  schema?: string | null;
  table: string;
}

export interface DataGenRequest {
  jobId?: string | null;
  connectionId: string;
  database?: string | null;
  schema?: string | null;
  table: string;
  rowCount: number;
  batchSize?: number | null;
  truncateBefore: boolean;
  seed?: number | null;
  rules: DataGenColumnRule[];
  confirmedProduction: boolean;
}

export interface DataGenPreviewResult {
  columns: string[];
  rows: unknown[][];
}

export interface DataGenResult {
  jobId: string;
  ok: boolean;
  cancelled: boolean;
  rowsInserted: number;
  durationMs: number;
  summary: string;
  error?: string | null;
}

export type ChartType =
  | "bar"
  | "stacked_bar"
  | "line"
  | "area"
  | "pie"
  | "donut"
  | "scatter"
  | "kpi";

export interface ChartCardConfig {
  id: string;
  title: string;
  chartType: ChartType;
  connectionId: string;
  database?: string | null;
  savedQueryPath?: string | null;
  sql: string;
  xColumn: string;
  yColumns: string[];
  seriesColumn?: string | null;
  colSpan: number;
}

export interface ChartDashboard {
  id: string;
  name: string;
  description?: string | null;
  charts: ChartCardConfig[];
  updatedAt: string;
}

export type BatchStepKind =
  | "run_query"
  | "sql_dump"
  | "export_table"
  | "data_transfer"
  | "structure_sync"
  | "data_sync"
  | "data_gen";

export interface BatchStep {
  id: string;
  name: string;
  kind: BatchStepKind;
  enabled: boolean;
  config: Record<string, unknown>;
}

export type SchedulePreset = "manual" | "hourly" | "daily" | "weekly" | "custom";

export interface JobSchedule {
  enabled: boolean;
  preset: SchedulePreset;
  onCalendar: string;
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
}

export interface BatchJob {
  id: string;
  name: string;
  description?: string | null;
  stopOnError: boolean;
  steps: BatchStep[];
  schedule: JobSchedule;
  updatedAt: string;
}

export interface JobExecutionLog {
  id: string;
  jobId: string;
  startedAt: string;
  finishedAt?: string | null;
  status: string;
  output: string;
}

export interface SystemdTimerStatus {
  jobId: string;
  unitName: string;
  servicePath: string;
  timerPath: string;
  installed: boolean;
  enabled: boolean;
  active: boolean;
  nextTrigger?: string | null;
  message: string;
}
