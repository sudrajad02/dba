use crate::error::{DbaError, Result};
use crate::models::{
    BatchJob, ChartDashboard, CodeSnippet, ConnectionProfile, DataJobProfile, DbEngine, ErModel,
    SavedQuery,
};
use crate::storage::paths::DbaPaths;
use chrono::{DateTime, Utc};
use std::fs;
use std::path::{Component, Path, PathBuf};

pub struct WorkspaceStore {
    paths: DbaPaths,
}

impl WorkspaceStore {
    pub fn new(paths: DbaPaths) -> Self {
        Self { paths }
    }

    pub fn load_connections(&self) -> Result<Vec<ConnectionProfile>> {
        if !self.paths.connections_file.exists() {
            return Ok(Vec::new());
        }
        let raw = fs::read_to_string(&self.paths.connections_file)?;
        if raw.trim().is_empty() {
            return Ok(Vec::new());
        }
        let items: Vec<ConnectionProfile> = serde_json::from_str(&raw)?;
        Ok(items)
    }

    pub fn save_connections(&self, profiles: &[ConnectionProfile]) -> Result<()> {
        let json = serde_json::to_string_pretty(profiles)?;
        fs::write(&self.paths.connections_file, json)?;
        Ok(())
    }

    pub fn list_saved_queries(&self) -> Result<Vec<SavedQuery>> {
        let mut out = Vec::new();
        self.walk_queries(&self.paths.queries_dir, "", &mut out)?;
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(out)
    }

    fn is_supported_query_file(path: &Path) -> bool {
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if file_name.ends_with(".mongodb.json") {
            return true;
        }
        path.extension()
            .map(|e| e == "sql" || e == "js")
            .unwrap_or(false)
    }

    fn extract_query_name_and_engine(path: &Path) -> (String, Option<DbEngine>) {
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if let Some(stem) = file_name.strip_suffix(".mongodb.json") {
            return (stem.to_string(), Some(DbEngine::Mongodb));
        }
        let name = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        (name, None)
    }

    fn parse_folder_binding(folder: &str) -> (Option<String>, Option<String>) {
        let parts: Vec<&str> = folder
            .split('/')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect();
        match parts.as_slice() {
            [] => (None, None),
            [conn_id] => (Some((*conn_id).to_string()), None),
            [conn_id, db, ..] => (Some((*conn_id).to_string()), Some((*db).to_string())),
        }
    }

    fn sanitize_segment(raw: &str) -> Result<String> {
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
            return Err(DbaError::Storage(
                "Invalid query path segment".to_string(),
            ));
        }
        if trimmed.contains("..")
            || trimmed.contains('/')
            || trimmed.contains('\\')
            || trimmed.contains('\0')
        {
            return Err(DbaError::Storage(
                "Query name or folder cannot contain path separators or '..'".to_string(),
            ));
        }
        let cleaned: String = trimmed
            .chars()
            .map(|c| match c {
                ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
                _ => c,
            })
            .collect();
        let cleaned = cleaned.trim().to_string();
        if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
            return Err(DbaError::Storage("Invalid query name".to_string()));
        }
        Ok(cleaned)
    }

    fn validate_existing_query_path(&self, raw_path: &str) -> Result<PathBuf> {
        if raw_path.trim().is_empty() || raw_path.contains('\0') {
            return Err(DbaError::Storage("Invalid query path".to_string()));
        }
        let p = Path::new(raw_path);
        for comp in p.components() {
            if matches!(comp, Component::ParentDir) {
                return Err(DbaError::Storage(
                    "Path traversal is not allowed".to_string(),
                ));
            }
        }
        fs::create_dir_all(&self.paths.queries_dir)?;
        let root_canon = fs::canonicalize(&self.paths.queries_dir)?;
        let target_canon = fs::canonicalize(p).map_err(|_| {
            DbaError::Storage(format!("Saved query file not found: {}", raw_path))
        })?;
        if !target_canon.starts_with(&root_canon) || target_canon == root_canon {
            return Err(DbaError::Storage(
                "Access denied: path is outside workspace queries directory".to_string(),
            ));
        }
        Ok(target_canon)
    }

    fn build_saved_query_from_path(
        &self,
        file_path: &Path,
        sql: String,
        schema_override: Option<String>,
        engine_override: Option<DbEngine>,
    ) -> Result<SavedQuery> {
        let root_canon = fs::canonicalize(&self.paths.queries_dir)
            .unwrap_or_else(|_| self.paths.queries_dir.clone());
        let file_canon = fs::canonicalize(file_path).unwrap_or_else(|_| file_path.to_path_buf());
        let rel = file_canon
            .strip_prefix(&root_canon)
            .or_else(|_| file_path.strip_prefix(&self.paths.queries_dir))
            .unwrap_or(file_path);
        let folder = rel
            .parent()
            .map(|p| {
                p.components()
                    .map(|c| c.as_os_str().to_string_lossy().to_string())
                    .collect::<Vec<_>>()
                    .join("/")
            })
            .unwrap_or_default();
        let (connection_id, database) = Self::parse_folder_binding(&folder);
        let (name, inferred_engine) = Self::extract_query_name_and_engine(&file_canon);
        let meta = fs::metadata(&file_canon)?;
        let modified: DateTime<Utc> = meta
            .modified()
            .map(DateTime::<Utc>::from)
            .unwrap_or_else(|_| Utc::now());
        let full_path = file_canon.to_string_lossy().to_string();
        Ok(SavedQuery {
            id: full_path.clone(),
            name,
            folder,
            connection_id,
            database,
            schema: schema_override,
            engine: engine_override.or(inferred_engine),
            sql,
            path: full_path,
            updated_at: modified.to_rfc3339(),
        })
    }

    fn walk_queries(&self, dir: &Path, folder: &str, out: &mut Vec<SavedQuery>) -> Result<()> {
        if !dir.exists() {
            return Ok(());
        }
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                let next_folder = if folder.is_empty() {
                    name.to_string()
                } else {
                    format!("{}/{}", folder, name)
                };
                self.walk_queries(&path, &next_folder, out)?;
            } else if Self::is_supported_query_file(&path) {
                let sql = fs::read_to_string(&path).unwrap_or_default();
                let meta = fs::metadata(&path)?;
                let modified: DateTime<Utc> = meta
                    .modified()
                    .map(DateTime::<Utc>::from)
                    .unwrap_or_else(|_| Utc::now());
                let (name, engine) = Self::extract_query_name_and_engine(&path);
                let (connection_id, database) = Self::parse_folder_binding(folder);
                let full_path = path.to_string_lossy().to_string();
                out.push(SavedQuery {
                    id: full_path.clone(),
                    name,
                    folder: folder.to_string(),
                    connection_id,
                    database,
                    schema: None,
                    engine,
                    sql,
                    path: full_path,
                    updated_at: modified.to_rfc3339(),
                });
            }
        }
        Ok(())
    }

    pub fn save_query_file(
        &self,
        folder: &str,
        name: &str,
        sql: &str,
        connection_id: Option<&str>,
        database: Option<&str>,
        schema: Option<&str>,
        engine: Option<DbEngine>,
        overwrite_path: Option<&str>,
    ) -> Result<SavedQuery> {
        fs::create_dir_all(&self.paths.queries_dir)?;

        if let Some(existing_path) = overwrite_path.map(str::trim).filter(|s| !s.is_empty()) {
            let target = self.validate_existing_query_path(existing_path)?;
            fs::write(&target, sql)?;
            return self.build_saved_query_from_path(
                &target,
                sql.to_string(),
                schema.map(|s| s.to_string()),
                engine,
            );
        }

        let is_mongo = engine == Some(DbEngine::Mongodb)
            || name.trim().to_lowercase().ends_with(".mongodb.json");
        let stripped_name = name
            .trim()
            .trim_end_matches(".mongodb.json")
            .trim_end_matches(".sql");
        let clean_name = Self::sanitize_segment(stripped_name)?;

        let mut target_dir = self.paths.queries_dir.clone();
        if let Some(cid) = connection_id.map(str::trim).filter(|s| !s.is_empty()) {
            target_dir = target_dir.join(Self::sanitize_segment(cid)?);
            if let Some(db) = database.map(str::trim).filter(|s| !s.is_empty()) {
                target_dir = target_dir.join(Self::sanitize_segment(db)?);
            }
        } else if !folder.trim().is_empty() {
            for seg in folder.trim().split('/').filter(|s| !s.is_empty()) {
                target_dir = target_dir.join(Self::sanitize_segment(seg)?);
            }
        }

        fs::create_dir_all(&target_dir)?;
        let root_canon = fs::canonicalize(&self.paths.queries_dir)?;
        let dir_canon = fs::canonicalize(&target_dir)?;
        if !dir_canon.starts_with(&root_canon) {
            return Err(DbaError::Storage(
                "Access denied: target folder is outside workspace queries directory".to_string(),
            ));
        }

        let ext = if is_mongo { "mongodb.json" } else { "sql" };
        let file_path = dir_canon.join(format!("{}.{}", clean_name, ext));
        fs::write(&file_path, sql)?;
        self.build_saved_query_from_path(
            &file_path,
            sql.to_string(),
            schema.map(|s| s.to_string()),
            engine.or(if is_mongo { Some(DbEngine::Mongodb) } else { None }),
        )
    }

    pub fn rename_saved_query(&self, old_path: &str, new_name: &str) -> Result<SavedQuery> {
        let src = self.validate_existing_query_path(old_path)?;
        let is_mongo = src
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase().ends_with(".mongodb.json"))
            .unwrap_or(false);
        let stripped = new_name
            .trim()
            .trim_end_matches(".mongodb.json")
            .trim_end_matches(".sql");
        let clean_name = Self::sanitize_segment(stripped)?;
        let ext = if is_mongo {
            "mongodb.json".to_string()
        } else {
            src.extension()
                .map(|e| e.to_string_lossy().to_string())
                .unwrap_or_else(|| "sql".to_string())
        };
        let parent = src.parent().ok_or_else(|| {
            DbaError::Storage("Invalid query file parent directory".to_string())
        })?;
        let dst = parent.join(format!("{}.{}", clean_name, ext));
        if dst != src && dst.exists() {
            return Err(DbaError::Storage(format!(
                "A saved query named \"{}.{}\" already exists in this folder",
                clean_name, ext
            )));
        }
        if dst != src {
            fs::rename(&src, &dst)?;
        }
        let sql = fs::read_to_string(&dst).unwrap_or_default();
        self.build_saved_query_from_path(&dst, sql, None, None)
    }

    pub fn duplicate_saved_query(&self, path: &str, new_name: &str) -> Result<SavedQuery> {
        let src = self.validate_existing_query_path(path)?;
        let is_mongo = src
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase().ends_with(".mongodb.json"))
            .unwrap_or(false);
        let stripped = new_name
            .trim()
            .trim_end_matches(".mongodb.json")
            .trim_end_matches(".sql");
        let clean_name = Self::sanitize_segment(stripped)?;
        let ext = if is_mongo {
            "mongodb.json".to_string()
        } else {
            src.extension()
                .map(|e| e.to_string_lossy().to_string())
                .unwrap_or_else(|| "sql".to_string())
        };
        let parent = src.parent().ok_or_else(|| {
            DbaError::Storage("Invalid query file parent directory".to_string())
        })?;
        let dst = parent.join(format!("{}.{}", clean_name, ext));
        if dst.exists() {
            return Err(DbaError::Storage(format!(
                "A saved query named \"{}.{}\" already exists in this folder",
                clean_name, ext
            )));
        }
        fs::copy(&src, &dst)?;
        let sql = fs::read_to_string(&dst).unwrap_or_default();
        self.build_saved_query_from_path(&dst, sql, None, None)
    }

    pub fn delete_saved_query(&self, path: &str) -> Result<()> {
        let target = self.validate_existing_query_path(path)?;
        if target.exists() {
            fs::remove_file(target)?;
        }
        Ok(())
    }

    pub fn ensure_default_snippets(&self) -> Result<()> {
        let file = self.paths.snippets_dir.join("snippets.json");
        if file.exists() {
            return Ok(());
        }
        let defaults = vec![
            CodeSnippet {
                id: "select-top".into(),
                name: "Select Top 100".into(),
                description: "Quick preview of 100 rows from a table".into(),
                engine: None,
                body: "SELECT *\nFROM {{table_name}}\nLIMIT 100;".into(),
            },
            CodeSnippet {
                id: "pg-table-sizes".into(),
                name: "PostgreSQL Table Sizes".into(),
                description: "Inspect largest tables in current PostgreSQL database".into(),
                engine: Some(crate::models::DbEngine::Postgres),
                body: "SELECT schemaname, relname AS table_name,\n       pg_size_pretty(pg_total_relation_size(relid)) AS total_size\nFROM pg_catalog.pg_statio_user_tables\nORDER BY pg_total_relation_size(relid) DESC\nLIMIT 25;".into(),
            },
            CodeSnippet {
                id: "pg-active-queries".into(),
                name: "PostgreSQL Active Queries".into(),
                description: "Show currently running queries and duration".into(),
                engine: Some(crate::models::DbEngine::Postgres),
                body: "SELECT pid, usename, state, now() - query_start AS duration, query\nFROM pg_stat_activity\nWHERE state != 'idle'\nORDER BY duration DESC;".into(),
            },
            CodeSnippet {
                id: "mysql-table-sizes".into(),
                name: "MySQL Table Sizes".into(),
                description: "Inspect table sizes in MB in current MySQL schema".into(),
                engine: Some(crate::models::DbEngine::Mysql),
                body: "SELECT table_name,\n       ROUND(((data_length + index_length) / 1024 / 1024), 2) AS size_mb,\n       table_rows\nFROM information_schema.TABLES\nWHERE table_schema = DATABASE()\nORDER BY (data_length + index_length) DESC;".into(),
            },
            CodeSnippet {
                id: "cte-template".into(),
                name: "CTE Query Template".into(),
                description: "Common Table Expression skeleton".into(),
                engine: None,
                body: "WITH base AS (\n  SELECT *\n  FROM {{table_name}}\n  WHERE {{condition}}\n)\nSELECT *\nFROM base\nLIMIT 100;".into(),
            },
        ];
        fs::write(&file, serde_json::to_string_pretty(&defaults)?)?;
        Ok(())
    }

    pub fn list_snippets(&self) -> Result<Vec<CodeSnippet>> {
        let file = self.paths.snippets_dir.join("snippets.json");
        if !file.exists() {
            return Ok(Vec::new());
        }
        let raw = fs::read_to_string(&file)?;
        Ok(serde_json::from_str(&raw)?)
    }

    pub fn save_snippet(&self, snippet: CodeSnippet) -> Result<Vec<CodeSnippet>> {
        let mut all = self.list_snippets()?;
        if let Some(existing) = all.iter_mut().find(|s| s.id == snippet.id) {
            *existing = snippet;
        } else {
            all.push(snippet);
        }
        let file = self.paths.snippets_dir.join("snippets.json");
        fs::write(&file, serde_json::to_string_pretty(&all)?)?;
        Ok(all)
    }

    pub fn list_job_profiles(&self, kind: Option<&str>) -> Result<Vec<DataJobProfile>> {
        let mut out = Vec::new();
        if !self.paths.jobs_dir.exists() {
            return Ok(out);
        }
        for entry in fs::read_dir(&self.paths.jobs_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path
                .file_name()
                .map(|n| n.to_string_lossy().ends_with(".dvjob.json"))
                .unwrap_or(false)
            {
                if let Ok(raw) = fs::read_to_string(&path) {
                    if let Ok(profile) = serde_json::from_str::<DataJobProfile>(&raw) {
                        if kind.map(|k| k == profile.kind).unwrap_or(true) {
                            out.push(profile);
                        }
                    }
                }
            }
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(out)
    }

    pub fn save_job_profile(&self, mut profile: DataJobProfile) -> Result<DataJobProfile> {
        if profile.id.trim().is_empty() {
            profile.id = uuid::Uuid::new_v4().to_string();
        }
        profile.updated_at = Utc::now().to_rfc3339();
        let safe_id = profile.id.replace(['/', '\\', '\0'], "_");
        let file = self.paths.jobs_dir.join(format!("{}.dvjob.json", safe_id));
        fs::write(&file, serde_json::to_string_pretty(&profile)?)?;
        Ok(profile)
    }

    pub fn delete_job_profile(&self, id: &str) -> Result<()> {
        let safe_id = id.replace(['/', '\\', '\0'], "_");
        let file = self.paths.jobs_dir.join(format!("{}.dvjob.json", safe_id));
        if file.exists() && file.starts_with(&self.paths.jobs_dir) {
            fs::remove_file(file)?;
        }
        Ok(())
    }

    pub fn list_er_models(&self) -> Result<Vec<ErModel>> {
        let mut out = Vec::new();
        if !self.paths.models_dir.exists() {
            return Ok(out);
        }
        for entry in fs::read_dir(&self.paths.models_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path
                .file_name()
                .map(|n| n.to_string_lossy().ends_with(".dvmodel.json"))
                .unwrap_or(false)
            {
                if let Ok(raw) = fs::read_to_string(&path) {
                    if let Ok(model) = serde_json::from_str::<ErModel>(&raw) {
                        out.push(model);
                    }
                }
            }
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(out)
    }

    pub fn save_er_model(&self, mut model: ErModel) -> Result<ErModel> {
        if model.id.trim().is_empty() {
            model.id = uuid::Uuid::new_v4().to_string();
        }
        model.updated_at = Utc::now().to_rfc3339();
        let safe_id = model.id.replace(['/', '\\', '\0'], "_");
        let file = self.paths.models_dir.join(format!("{}.dvmodel.json", safe_id));
        fs::write(&file, serde_json::to_string_pretty(&model)?)?;
        Ok(model)
    }

    pub fn delete_er_model(&self, id: &str) -> Result<()> {
        let safe_id = id.replace(['/', '\\', '\0'], "_");
        let file = self.paths.models_dir.join(format!("{}.dvmodel.json", safe_id));
        if file.exists() && file.starts_with(&self.paths.models_dir) {
            fs::remove_file(file)?;
        }
        Ok(())
    }

    // ---- Phase 5: Charts / Dashboards (.dvchart.json) ----

    pub fn list_dashboards(&self) -> Result<Vec<ChartDashboard>> {
        let mut out = Vec::new();
        if !self.paths.charts_dir.exists() {
            return Ok(out);
        }
        for entry in fs::read_dir(&self.paths.charts_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path
                .file_name()
                .map(|n| n.to_string_lossy().ends_with(".dvchart.json"))
                .unwrap_or(false)
            {
                if let Ok(raw) = fs::read_to_string(&path) {
                    if let Ok(dash) = serde_json::from_str::<ChartDashboard>(&raw) {
                        out.push(dash);
                    }
                }
            }
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(out)
    }

    pub fn save_dashboard(&self, mut dash: ChartDashboard) -> Result<ChartDashboard> {
        if dash.id.trim().is_empty() {
            dash.id = uuid::Uuid::new_v4().to_string();
        }
        dash.updated_at = Utc::now().to_rfc3339();
        let safe_id = dash.id.replace(['/', '\\', '\0'], "_");
        let file = self.paths.charts_dir.join(format!("{}.dvchart.json", safe_id));
        fs::write(&file, serde_json::to_string_pretty(&dash)?)?;
        Ok(dash)
    }

    pub fn delete_dashboard(&self, id: &str) -> Result<()> {
        let safe_id = id.replace(['/', '\\', '\0'], "_");
        let file = self.paths.charts_dir.join(format!("{}.dvchart.json", safe_id));
        if file.exists() && file.starts_with(&self.paths.charts_dir) {
            fs::remove_file(file)?;
        }
        Ok(())
    }

    // ---- Phase 5: Batch Jobs (.dvbatch.json) ----

    pub fn list_batch_jobs(&self) -> Result<Vec<BatchJob>> {
        let mut out = Vec::new();
        if !self.paths.jobs_dir.exists() {
            return Ok(out);
        }
        for entry in fs::read_dir(&self.paths.jobs_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path
                .file_name()
                .map(|n| n.to_string_lossy().ends_with(".dvbatch.json"))
                .unwrap_or(false)
            {
                if let Ok(raw) = fs::read_to_string(&path) {
                    if let Ok(job) = serde_json::from_str::<BatchJob>(&raw) {
                        out.push(job);
                    }
                }
            }
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(out)
    }

    pub fn get_batch_job(&self, id: &str) -> Result<Option<BatchJob>> {
        let safe_id = id.replace(['/', '\\', '\0'], "_");
        let file = self.paths.jobs_dir.join(format!("{}.dvbatch.json", safe_id));
        if !file.exists() {
            return Ok(None);
        }
        let raw = fs::read_to_string(&file)?;
        Ok(Some(serde_json::from_str::<BatchJob>(&raw)?))
    }

    pub fn save_batch_job(&self, mut job: BatchJob) -> Result<BatchJob> {
        if job.id.trim().is_empty() {
            job.id = uuid::Uuid::new_v4().to_string();
        }
        job.updated_at = Utc::now().to_rfc3339();
        let safe_id = job.id.replace(['/', '\\', '\0'], "_");
        let file = self.paths.jobs_dir.join(format!("{}.dvbatch.json", safe_id));
        fs::write(&file, serde_json::to_string_pretty(&job)?)?;
        Ok(job)
    }

    pub fn delete_batch_job(&self, id: &str) -> Result<()> {
        let safe_id = id.replace(['/', '\\', '\0'], "_");
        let file = self.paths.jobs_dir.join(format!("{}.dvbatch.json", safe_id));
        if file.exists() && file.starts_with(&self.paths.jobs_dir) {
            fs::remove_file(file)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> (WorkspaceStore, PathBuf) {
        let root = std::env::temp_dir().join(format!("dba_ws_test_{}", uuid::Uuid::new_v4()));
        let workspace_dir = root.join("workspace");
        let paths = DbaPaths {
            sqlite_db: root.join("dba.db"),
            connections_file: workspace_dir.join("connections.json"),
            queries_dir: workspace_dir.join("queries"),
            snippets_dir: workspace_dir.join("snippets"),
            models_dir: workspace_dir.join("models"),
            charts_dir: workspace_dir.join("charts"),
            jobs_dir: workspace_dir.join("jobs"),
            workspace_dir,
            data_dir: root.clone(),
        };
        paths.ensure_dirs().unwrap();
        (WorkspaceStore::new(paths), root)
    }

    #[test]
    fn saved_queries_crud_and_legacy_and_traversal_guard() {
        let (store, root) = temp_store();

        // 1. Save structured SQL query under <conn_id>/<db>/
        let saved = store
            .save_query_file(
                "",
                "monthly_report",
                "SELECT 1;",
                Some("conn-1"),
                Some("sales_db"),
                None,
                Some(DbEngine::Mysql),
                None,
            )
            .unwrap();
        assert_eq!(saved.name, "monthly_report");
        assert_eq!(saved.connection_id.as_deref(), Some("conn-1"));
        assert_eq!(saved.database.as_deref(), Some("sales_db"));
        assert!(saved.path.ends_with("monthly_report.sql"));

        // 2. Overwrite directly via overwrite_path
        let updated = store
            .save_query_file(
                "",
                "monthly_report",
                "SELECT 2;",
                Some("conn-1"),
                Some("sales_db"),
                None,
                Some(DbEngine::Mysql),
                Some(&saved.path),
            )
            .unwrap();
        assert_eq!(updated.path, saved.path);
        assert_eq!(updated.sql, "SELECT 2;");

        // 3. Save MongoDB query (.mongodb.json)
        let mongo = store
            .save_query_file(
                "",
                "active_users",
                r#"{"mode":"mql"}"#,
                Some("mongo-1"),
                Some("app_db"),
                None,
                Some(DbEngine::Mongodb),
                None,
            )
            .unwrap();
        assert_eq!(mongo.name, "active_users");
        assert_eq!(mongo.engine, Some(DbEngine::Mongodb));
        assert!(mongo.path.ends_with("active_users.mongodb.json"));

        // 4. Legacy root query remains readable
        fs::write(store.paths.queries_dir.join("legacy.sql"), "SELECT 42;").unwrap();
        let all = store.list_saved_queries().unwrap();
        assert_eq!(all.len(), 3);
        let legacy = all.iter().find(|q| q.name == "legacy").unwrap();
        assert_eq!(legacy.connection_id, None);
        assert_eq!(legacy.database, None);

        // 5. Duplicate & Rename
        let dup = store
            .duplicate_saved_query(&saved.path, "monthly_report_v2")
            .unwrap();
        assert_eq!(dup.name, "monthly_report_v2");
        assert_eq!(dup.sql, "SELECT 2;");

        let renamed = store
            .rename_saved_query(&dup.path, "monthly_report_final")
            .unwrap();
        assert_eq!(renamed.name, "monthly_report_final");
        assert!(!Path::new(&dup.path).exists());

        // 6. Path traversal must be rejected
        assert!(store
            .save_query_file("", "../evil", "SELECT 1;", None, None, None, None, None)
            .is_err());
        assert!(store.delete_saved_query("/etc/passwd").is_err());

        // 7. Delete
        store.delete_saved_query(&renamed.path).unwrap();
        assert!(!Path::new(&renamed.path).exists());

        let _ = fs::remove_dir_all(root);
    }
}
