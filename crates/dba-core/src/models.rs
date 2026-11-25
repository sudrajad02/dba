use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DbEngine {
    Postgres,
    Mysql,
    Mssql,
    Mongodb,
}

impl DbEngine {
    pub fn default_port(&self) -> u16 {
        match self {
            DbEngine::Postgres => 5432,
            DbEngine::Mysql => 3306,
            DbEngine::Mssql => 1433,
            DbEngine::Mongodb => 27017,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EnvironmentTag {
    Local,
    Dev,
    Staging,
    Production,
}

impl Default for EnvironmentTag {
    fn default() -> Self {
        EnvironmentTag::Local
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SslMode {
    Disable,
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

impl Default for SslMode {
    fn default() -> Self {
        SslMode::Prefer
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SslConfig {
    pub mode: SslMode,
    pub ca_cert_path: Option<String>,
    pub client_cert_path: Option<String>,
    pub client_key_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SshAuthMethod {
    Password,
    PrivateKey,
}

impl Default for SshAuthMethod {
    fn default() -> Self {
        SshAuthMethod::PrivateKey
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: SshAuthMethod,
    pub private_key_path: Option<String>,
    pub jump_host: Option<String>,
    pub keyring_ref: Option<String>,
}

/// Stored in `connections.json` (zero plaintext secrets).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub engine: DbEngine,
    pub host: String,
    pub port: u16,
    pub database: Option<String>,
    pub username: String,
    pub keyring_ref: Option<String>,
    pub group_path: Option<String>,
    pub environment: EnvironmentTag,
    pub color: Option<String>,
    pub read_only: bool,
    #[serde(default)]
    pub ssl: SslConfig,
    #[serde(default)]
    pub ssh: SshConfig,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Input payload from UI when saving/testing a connection (secrets go to OS Keyring only).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSaveInput {
    pub profile: ConnectionProfile,
    pub password: Option<String>,
    pub ssh_secret: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedConnectionUri {
    pub engine: DbEngine,
    pub host: String,
    pub port: u16,
    pub database: Option<String>,
    pub username: String,
    pub password: Option<String>,
    pub ssl_mode: Option<SslMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub ok: bool,
    pub latency_ms: u64,
    pub server_version: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseInfo {
    pub name: String,
    pub size_bytes: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInfo {
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObjectKind {
    Table,
    View,
    MaterializedView,
    Function,
    Procedure,
    Trigger,
    Index,
    Sequence,
    EnumType,
    Event,
    Collection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseObject {
    pub name: String,
    pub schema: Option<String>,
    pub kind: ObjectKind,
    pub row_estimate: Option<i64>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
    pub udt_name: Option<String>,
    pub max_length: Option<i64>,
    pub numeric_precision: Option<i64>,
    pub numeric_scale: Option<i64>,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub is_primary_key: bool,
    pub is_auto_increment: bool,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexMeta {
    pub name: String,
    pub columns: Vec<String>,
    pub is_unique: bool,
    pub is_primary: bool,
    pub method: String,
    pub definition: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyMeta {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_schema: Option<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    pub on_update: String,
    pub on_delete: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckConstraintMeta {
    pub name: String,
    pub expression: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableMetadata {
    pub schema: Option<String>,
    pub name: String,
    pub columns: Vec<ColumnMeta>,
    pub indexes: Vec<IndexMeta>,
    pub foreign_keys: Vec<ForeignKeyMeta>,
    pub checks: Vec<CheckConstraintMeta>,
    pub row_estimate: Option<i64>,
    pub ddl: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterCondition {
    pub column: String,
    pub operator: String, // "=", "!=", ">", "<", ">=", "<=", "LIKE", "ILIKE", "IN", "IS NULL", "IS NOT NULL", "BETWEEN"
    pub value: Option<String>,
    pub value2: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortSpec {
    pub column: String,
    pub direction: String, // "ASC" | "DESC"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDataRequest {
    pub connection_id: String,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub table: String,
    pub page: u64,
    pub page_size: u64,
    #[serde(default)]
    pub filters: Vec<FilterCondition>,
    #[serde(default)]
    pub sorts: Vec<SortSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultColumn {
    pub name: String,
    pub data_type: String,
    pub is_primary_key: bool,
    pub fk_target: Option<ForeignKeyTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyTarget {
    pub schema: Option<String>,
    pub table: String,
    pub column: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResultSet {
    pub columns: Vec<ResultColumn>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub rows_affected: Option<u64>,
    pub total_count: Option<u64>,
    pub execution_ms: u64,
    pub statement: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryExecutionResponse {
    pub query_id: String,
    pub result_sets: Vec<QueryResultSet>,
    pub total_execution_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StagedChange {
    Insert {
        values: HashMap<String, serde_json::Value>,
    },
    Update {
        primary_keys: HashMap<String, serde_json::Value>,
        changes: HashMap<String, serde_json::Value>,
    },
    Delete {
        primary_keys: HashMap<String, serde_json::Value>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyChangesRequest {
    pub connection_id: String,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub table: String,
    pub changes: Vec<StagedChange>,
    pub confirmed_production: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewChangesResponse {
    pub statements: Vec<String>,
    pub requires_confirmation: bool,
    pub safety_warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafetyCheckResult {
    pub allowed: bool,
    pub requires_confirmation: bool,
    pub warnings: Vec<String>,
    pub is_write: bool,
    pub is_destructive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainNode {
    pub node_type: String,
    pub relation: Option<String>,
    pub startup_cost: Option<f64>,
    pub total_cost: Option<f64>,
    pub plan_rows: Option<f64>,
    pub actual_time_ms: Option<f64>,
    pub actual_rows: Option<f64>,
    pub is_full_scan: bool,
    pub extra: Option<String>,
    pub children: Vec<ExplainNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainPlanResult {
    pub root: Option<ExplainNode>,
    pub raw_json: serde_json::Value,
    pub execution_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryHistoryEntry {
    pub id: String,
    pub connection_id: String,
    pub connection_name: String,
    pub database: Option<String>,
    pub sql: String,
    pub executed_at: String,
    pub duration_ms: u64,
    pub row_count: Option<u64>,
    pub status: String, // "ok" | "error" | "cancelled"
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    pub id: String,
    pub name: String,
    pub folder: String,
    pub engine: Option<DbEngine>,
    pub sql: String,
    pub path: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeSnippet {
    pub id: String,
    pub name: String,
    pub description: String,
    pub engine: Option<DbEngine>,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDesignColumn {
    pub name: String,
    pub original_name: Option<String>,
    pub data_type: String,
    pub length: Option<String>,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub is_primary_key: bool,
    pub is_auto_increment: bool,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDesignDraft {
    pub is_new_table: bool,
    pub schema: Option<String>,
    pub table_name: String,
    pub columns: Vec<TableDesignColumn>,
    pub indexes: Vec<IndexMeta>,
    pub foreign_keys: Vec<ForeignKeyMeta>,
    pub checks: Vec<CheckConstraintMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutocompleteSchema {
    pub tables: HashMap<String, Vec<String>>,
}

// ============================================================================
// Phase 2: MongoDB / NoSQL Models
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoIndexSpec {
    pub name: String,
    pub keys: serde_json::Value,
    pub unique: bool,
    pub sparse: bool,
    pub ttl_seconds: Option<i64>,
    pub partial_filter_expression: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoCollectionOptions {
    pub capped: bool,
    pub max_size_bytes: Option<u64>,
    pub max_docs: Option<u64>,
    pub validator: Option<serde_json::Value>,
    pub validation_level: Option<String>,
    pub validation_action: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoCollectionMetadata {
    pub database: String,
    pub name: String,
    pub document_count: u64,
    pub avg_doc_size: Option<u64>,
    pub storage_size: Option<u64>,
    pub indexes: Vec<MongoIndexSpec>,
    pub options: MongoCollectionOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoDocRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub filter_json: Option<String>,
    pub sort_json: Option<String>,
    pub projection_json: Option<String>,
    pub page: u64,
    pub page_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoDocResponse {
    pub documents: Vec<serde_json::Value>,
    pub total_count: u64,
    pub execution_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MongoDocChange {
    Insert {
        document: serde_json::Value,
    },
    Update {
        id: serde_json::Value,
        document: serde_json::Value,
    },
    Delete {
        id: serde_json::Value,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoApplyChangesRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub changes: Vec<MongoDocChange>,
    pub confirmed_production: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoQueryRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    /// "find" | "aggregate" | "count" | "insertOne" | "updateMany" | "deleteMany" | "command"
    pub operation: String,
    pub filter_json: Option<String>,
    pub sort_json: Option<String>,
    pub projection_json: Option<String>,
    pub pipeline_json: Option<String>,
    pub document_json: Option<String>,
    pub update_json: Option<String>,
    pub limit: Option<i64>,
    pub skip: Option<u64>,
    pub confirmed_safety: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoQueryResponse {
    pub documents: Vec<serde_json::Value>,
    pub affected_count: Option<u64>,
    pub execution_ms: u64,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoAggregationStage {
    pub id: String,
    pub operator: String,
    pub body_json: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoAggregationStageResult {
    pub stage_index: usize,
    pub operator: String,
    pub doc_count: usize,
    pub sample_docs: Vec<serde_json::Value>,
    pub execution_ms: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoCreateIndexRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub name: Option<String>,
    pub keys_json: String,
    pub unique: bool,
    pub sparse: bool,
    pub ttl_seconds: Option<u64>,
    pub partial_filter_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoValidationUpdateRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub validator_json: Option<String>,
    pub validation_level: String,
    pub validation_action: String,
    pub confirmed_production: bool,
}

// ============================================================================
// Phase 3: Data Mobility (Import/Export, Dump/Restore, Native CLI & Transfer)
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DataFileFormat {
    Csv,
    Json,
    Jsonl,
    Xlsx,
    Sql,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SqlExportMode {
    Insert,
    Upsert,
}

impl Default for SqlExportMode {
    fn default() -> Self {
        SqlExportMode::Insert
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportErrorPolicy {
    StopOnError,
    SkipAndLog,
}

impl Default for ImportErrorPolicy {
    fn default() -> Self {
        ImportErrorPolicy::StopOnError
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMapping {
    pub source_column: String,
    pub target_column: String,
    #[serde(default = "default_true")]
    pub included: bool,
    pub target_type: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub job_id: Option<String>,
    pub connection_id: String,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub table: String,
    pub format: DataFileFormat,
    pub output_path: String,
    #[serde(default)]
    pub delimiter: Option<String>,
    #[serde(default = "default_true")]
    pub include_headers: bool,
    #[serde(default)]
    pub sql_mode: SqlExportMode,
    #[serde(default)]
    pub batch_size: Option<usize>,
    #[serde(default)]
    pub column_mappings: Vec<ColumnMapping>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreviewRequest {
    pub file_path: String,
    pub format: DataFileFormat,
    pub delimiter: Option<String>,
    pub has_headers: bool,
    pub sample_rows: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreviewResponse {
    pub columns: Vec<String>,
    pub sample_rows: Vec<Vec<serde_json::Value>>,
    pub detected_format: DataFileFormat,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub job_id: Option<String>,
    pub connection_id: String,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub table: String,
    pub format: DataFileFormat,
    pub file_path: String,
    #[serde(default)]
    pub delimiter: Option<String>,
    #[serde(default = "default_true")]
    pub has_headers: bool,
    #[serde(default)]
    pub column_mappings: Vec<ColumnMapping>,
    #[serde(default)]
    pub error_policy: ImportErrorPolicy,
    #[serde(default)]
    pub batch_size: Option<usize>,
    #[serde(default)]
    pub truncate_before: bool,
    #[serde(default)]
    pub confirmed_production: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataJobResult {
    pub job_id: String,
    pub ok: bool,
    pub cancelled: bool,
    pub rows_processed: u64,
    pub rows_failed: u64,
    pub duration_ms: u64,
    pub output_path: Option<String>,
    pub summary: String,
    #[serde(default)]
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataJobProfile {
    pub id: String,
    pub name: String,
    /// "export" | "import" | "dump" | "transfer"
    pub kind: String,
    pub config: serde_json::Value,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlDumpRequest {
    pub job_id: Option<String>,
    pub connection_id: String,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub tables: Vec<String>,
    pub output_path: String,
    #[serde(default = "default_true")]
    pub include_structure: bool,
    #[serde(default = "default_true")]
    pub include_data: bool,
    #[serde(default)]
    pub drop_existing: bool,
    #[serde(default)]
    pub chunk_size: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteSqlFileRequest {
    pub job_id: Option<String>,
    pub connection_id: String,
    pub database: Option<String>,
    pub file_path: String,
    #[serde(default)]
    pub error_policy: ImportErrorPolicy,
    #[serde(default)]
    pub confirmed_production: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCliToolInfo {
    pub name: String,
    pub engine: DbEngine,
    pub role: String, // "dump" | "restore"
    pub available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCliRunRequest {
    pub connection_id: String,
    pub database: Option<String>,
    pub tool: String, // "pg_dump" | "pg_restore" | "mysqldump" | "mysql" | "mongodump" | "mongorestore" | "bcp" | "sqlpackage"
    pub file_path: String,
    #[serde(default)]
    pub format: Option<String>, // e.g. "custom", "plain", "directory", "archive"
    #[serde(default)]
    pub compress: bool,
    #[serde(default)]
    pub parallel_jobs: Option<u32>,
    #[serde(default)]
    pub schema_only: bool,
    #[serde(default)]
    pub data_only: bool,
    #[serde(default)]
    pub extra_args: Vec<String>,
    #[serde(default)]
    pub confirmed_production: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCliRunResult {
    pub ok: bool,
    pub exit_code: i32,
    pub command_preview: String,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferTableMode {
    DropAndRecreate,
    CreateIfNotExists,
    Append,
    Upsert,
}

impl Default for TransferTableMode {
    fn default() -> Self {
        TransferTableMode::CreateIfNotExists
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeMappingRule {
    pub source_type: String,
    pub target_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferTableSelection {
    pub source_table: String,
    pub target_table: String,
    #[serde(default = "default_true")]
    pub include_data: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferObjectSelection {
    pub name: String,
    pub kind: ObjectKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataTransferRequest {
    pub job_id: Option<String>,
    pub source_connection_id: String,
    pub source_database: Option<String>,
    pub source_schema: Option<String>,
    pub target_connection_id: String,
    pub target_database: Option<String>,
    pub target_schema: Option<String>,
    #[serde(default)]
    pub tables: Vec<TransferTableSelection>,
    #[serde(default)]
    pub objects: Vec<TransferObjectSelection>,
    #[serde(default)]
    pub mode: TransferTableMode,
    #[serde(default)]
    pub type_mappings: Vec<TypeMappingRule>,
    #[serde(default)]
    pub batch_size: Option<usize>,
    #[serde(default)]
    pub error_policy: ImportErrorPolicy,
    #[serde(default)]
    pub confirmed_production: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferTableReport {
    pub source_table: String,
    pub target_table: String,
    pub rows_transferred: u64,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferObjectReport {
    pub name: String,
    pub kind: ObjectKind,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataTransferResult {
    pub job_id: String,
    pub ok: bool,
    pub cancelled: bool,
    pub total_rows: u64,
    pub duration_ms: u64,
    pub tables: Vec<TransferTableReport>,
    #[serde(default)]
    pub objects: Vec<TransferObjectReport>,
    pub summary: String,
}

// ============================================================================
// Phase 4: Schema Intelligence & Visual Design (Sync, ER Model, Query Builder)
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncDiffStatus {
    New,
    Modified,
    Deleted,
    Unchanged,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureSyncRequest {
    pub source_connection_id: String,
    pub source_database: Option<String>,
    pub source_schema: Option<String>,
    pub target_connection_id: String,
    pub target_database: Option<String>,
    pub target_schema: Option<String>,
    #[serde(default)]
    pub include_drops: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDiff {
    pub name: String,
    pub status: SyncDiffStatus,
    pub source_type: Option<String>,
    pub target_type: Option<String>,
    pub source_nullable: Option<bool>,
    pub target_nullable: Option<bool>,
    pub source_default: Option<String>,
    pub target_default: Option<String>,
    pub details: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDiff {
    pub name: String,
    pub status: SyncDiffStatus,
    pub source_columns: Vec<String>,
    pub target_columns: Vec<String>,
    pub is_unique: bool,
    pub details: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyDiff {
    pub name: String,
    pub status: SyncDiffStatus,
    pub source_summary: Option<String>,
    pub target_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStructureDiff {
    pub table_name: String,
    pub status: SyncDiffStatus,
    pub column_diffs: Vec<ColumnDiff>,
    pub index_diffs: Vec<IndexDiff>,
    pub fk_diffs: Vec<ForeignKeyDiff>,
    pub ddl_statements: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureSyncPlan {
    pub source_engine: DbEngine,
    pub target_engine: DbEngine,
    pub tables: Vec<TableStructureDiff>,
    pub full_script: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteSyncScriptRequest {
    pub connection_id: String,
    pub database: Option<String>,
    pub statements: Vec<String>,
    #[serde(default = "default_true")]
    pub stop_on_error: bool,
    #[serde(default)]
    pub confirmed_production: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncExecutionResult {
    pub ok: bool,
    pub statements_executed: u64,
    pub statements_failed: u64,
    pub duration_ms: u64,
    #[serde(default)]
    pub errors: Vec<String>,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSyncTableSpec {
    pub source_table: String,
    pub target_table: String,
    #[serde(default)]
    pub key_columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSyncRequest {
    pub source_connection_id: String,
    pub source_database: Option<String>,
    pub source_schema: Option<String>,
    pub target_connection_id: String,
    pub target_database: Option<String>,
    pub target_schema: Option<String>,
    pub tables: Vec<DataSyncTableSpec>,
    #[serde(default)]
    pub include_deletes: bool,
    #[serde(default)]
    pub max_diff_rows_per_table: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RowDiffKind {
    Insert,
    Update,
    Delete,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowDiffEntry {
    pub kind: RowDiffKind,
    pub key_values: HashMap<String, serde_json::Value>,
    pub source_row: Option<HashMap<String, serde_json::Value>>,
    pub target_row: Option<HashMap<String, serde_json::Value>>,
    #[serde(default)]
    pub changed_columns: Vec<String>,
    pub sql: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDataDiff {
    pub source_table: String,
    pub target_table: String,
    pub key_columns: Vec<String>,
    pub inserts: u64,
    pub updates: u64,
    pub deletes: u64,
    pub unchanged: u64,
    pub sample_diffs: Vec<RowDiffEntry>,
    pub statements: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSyncPlan {
    pub tables: Vec<TableDataDiff>,
    pub total_inserts: u64,
    pub total_updates: u64,
    pub total_deletes: u64,
    pub full_script: String,
    pub summary: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErCardinality {
    OneToOne,
    OneToMany,
    ManyToMany,
}

impl Default for ErCardinality {
    fn default() -> Self {
        ErCardinality::OneToMany
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErTableNode {
    pub id: String,
    pub name: String,
    pub schema: Option<String>,
    pub x: f64,
    pub y: f64,
    pub color: Option<String>,
    pub group: Option<String>,
    #[serde(default)]
    pub columns: Vec<TableDesignColumn>,
    #[serde(default)]
    pub indexes: Vec<IndexMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErRelationship {
    pub id: String,
    pub name: String,
    pub source_table_id: String,
    pub source_column: String,
    pub target_table_id: String,
    pub target_column: String,
    #[serde(default)]
    pub cardinality: ErCardinality,
    #[serde(default)]
    pub on_update: String,
    #[serde(default)]
    pub on_delete: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErModel {
    pub id: String,
    pub name: String,
    pub engine: DbEngine,
    pub database: Option<String>,
    pub schema: Option<String>,
    #[serde(default)]
    pub tables: Vec<ErTableNode>,
    #[serde(default)]
    pub relationships: Vec<ErRelationship>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReverseEngineerRequest {
    pub connection_id: String,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub model_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardEngineerRequest {
    pub model: ErModel,
    pub target_engine: DbEngine,
    #[serde(default)]
    pub include_drops: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardEngineerResult {
    pub ddl: String,
    pub statements: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErModelSyncRequest {
    pub model: ErModel,
    pub target_connection_id: String,
    pub target_database: Option<String>,
    pub target_schema: Option<String>,
    #[serde(default)]
    pub include_drops: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QbJoinType {
    Inner,
    Left,
    Right,
    Full,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QbTableItem {
    pub id: String,
    pub schema: Option<String>,
    pub table: String,
    pub alias: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QbJoinItem {
    pub id: String,
    pub left_table_id: String,
    pub left_column: String,
    pub right_table_id: String,
    pub right_column: String,
    pub join_type: QbJoinType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QbSelectColumn {
    pub table_id: String,
    pub column: String,
    pub alias: Option<String>,
    pub aggregate: Option<String>,
    #[serde(default = "default_true")]
    pub selected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QbWhereCondition {
    pub id: String,
    pub conjunction: String,
    pub table_id: String,
    pub column: String,
    pub operator: String,
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QbOrderItem {
    pub table_id: String,
    pub column: String,
    pub direction: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualQuerySpec {
    pub engine: DbEngine,
    #[serde(default)]
    pub distinct: bool,
    #[serde(default)]
    pub tables: Vec<QbTableItem>,
    #[serde(default)]
    pub joins: Vec<QbJoinItem>,
    #[serde(default)]
    pub columns: Vec<QbSelectColumn>,
    #[serde(default)]
    pub where_conditions: Vec<QbWhereCondition>,
    #[serde(default)]
    pub group_by: Vec<String>,
    pub having: Option<String>,
    #[serde(default)]
    pub order_by: Vec<QbOrderItem>,
    pub limit: Option<u64>,
}

// ============================================================================
// Phase 5: Automation, Analytics (Charts/Dashboards) & Data Generation
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DataGenGeneratorKind {
    AutoIncrementSkip,
    Uuid,
    FullName,
    FirstName,
    LastName,
    Email,
    Phone,
    Address,
    City,
    Country,
    Company,
    Username,
    Url,
    Boolean,
    IntegerRange,
    DecimalRange,
    DateRange,
    TimestampRange,
    EnumList,
    TextLorem,
    RegexPattern,
    ForeignKeySample,
    Null,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataGenColumnRule {
    pub column: String,
    pub data_type: String,
    pub generator: DataGenGeneratorKind,
    #[serde(default)]
    pub null_percent: u8,
    pub min_num: Option<f64>,
    pub max_num: Option<f64>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    #[serde(default)]
    pub enum_values: Vec<String>,
    pub pattern: Option<String>,
    pub fk_schema: Option<String>,
    pub fk_table: Option<String>,
    pub fk_column: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataGenInferRequest {
    pub connection_id: String,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub table: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataGenRequest {
    pub job_id: Option<String>,
    pub connection_id: String,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub table: String,
    pub row_count: u64,
    pub batch_size: Option<usize>,
    #[serde(default)]
    pub truncate_before: bool,
    pub seed: Option<u64>,
    pub rules: Vec<DataGenColumnRule>,
    #[serde(default)]
    pub confirmed_production: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataGenPreviewResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataGenResult {
    pub job_id: String,
    pub ok: bool,
    pub cancelled: bool,
    pub rows_inserted: u64,
    pub duration_ms: u64,
    pub summary: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChartType {
    Bar,
    StackedBar,
    Line,
    Area,
    Pie,
    Donut,
    Scatter,
    Kpi,
}

impl Default for ChartType {
    fn default() -> Self {
        ChartType::Bar
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartCardConfig {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub chart_type: ChartType,
    pub connection_id: String,
    pub database: Option<String>,
    pub saved_query_path: Option<String>,
    pub sql: String,
    pub x_column: String,
    #[serde(default)]
    pub y_columns: Vec<String>,
    pub series_column: Option<String>,
    #[serde(default = "default_col_span")]
    pub col_span: u8,
}

fn default_col_span() -> u8 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartDashboard {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    #[serde(default)]
    pub charts: Vec<ChartCardConfig>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BatchStepKind {
    RunQuery,
    SqlDump,
    ExportTable,
    DataTransfer,
    StructureSync,
    DataSync,
    DataGen,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchStep {
    pub id: String,
    pub name: String,
    pub kind: BatchStepKind,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub config: serde_json::Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SchedulePreset {
    Manual,
    Hourly,
    Daily,
    Weekly,
    Custom,
}

impl Default for SchedulePreset {
    fn default() -> Self {
        SchedulePreset::Manual
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSchedule {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub preset: SchedulePreset,
    #[serde(default)]
    pub on_calendar: String,
    #[serde(default = "default_true")]
    pub notify_on_success: bool,
    #[serde(default = "default_true")]
    pub notify_on_failure: bool,
}

impl Default for JobSchedule {
    fn default() -> Self {
        Self {
            enabled: false,
            preset: SchedulePreset::Manual,
            on_calendar: "daily".into(),
            notify_on_success: true,
            notify_on_failure: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchJob {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    #[serde(default = "default_true")]
    pub stop_on_error: bool,
    #[serde(default)]
    pub steps: Vec<BatchStep>,
    #[serde(default)]
    pub schedule: JobSchedule,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobExecutionLog {
    pub id: String,
    pub job_id: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub status: String,
    pub output: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemdTimerStatus {
    pub job_id: String,
    pub unit_name: String,
    pub service_path: String,
    pub timer_path: String,
    pub installed: bool,
    pub enabled: bool,
    pub active: bool,
    pub next_trigger: Option<String>,
    pub message: String,
}
