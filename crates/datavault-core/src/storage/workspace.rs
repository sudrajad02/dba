use crate::error::Result;
use crate::models::{
    BatchJob, ChartDashboard, CodeSnippet, ConnectionProfile, DataJobProfile, ErModel, SavedQuery,
};
use crate::storage::paths::DatavaultPaths;
use chrono::{DateTime, Utc};
use std::fs;
use std::path::Path;

pub struct WorkspaceStore {
    paths: DatavaultPaths,
}

impl WorkspaceStore {
    pub fn new(paths: DatavaultPaths) -> Self {
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
            } else if path
                .extension()
                .map(|e| e == "sql" || e == "js")
                .unwrap_or(false)
            {
                let sql = fs::read_to_string(&path).unwrap_or_default();
                let meta = fs::metadata(&path)?;
                let modified: DateTime<Utc> = meta
                    .modified()
                    .map(DateTime::<Utc>::from)
                    .unwrap_or_else(|_| Utc::now());
                let name = path
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                let full_path = path.to_string_lossy().to_string();
                out.push(SavedQuery {
                    id: full_path.clone(),
                    name,
                    folder: folder.to_string(),
                    engine: None,
                    sql,
                    path: full_path,
                    updated_at: modified.to_rfc3339(),
                });
            }
        }
        Ok(())
    }

    pub fn save_query_file(&self, folder: &str, name: &str, sql: &str) -> Result<SavedQuery> {
        let clean_name = name
            .trim()
            .trim_end_matches(".sql")
            .replace(['/', '\\', '\0'], "_");
        let target_dir = if folder.trim().is_empty() {
            self.paths.queries_dir.clone()
        } else {
            let d = self.paths.queries_dir.join(folder.trim());
            fs::create_dir_all(&d)?;
            d
        };
        let file_path = target_dir.join(format!("{}.sql", clean_name));
        fs::write(&file_path, sql)?;
        let full_path = file_path.to_string_lossy().to_string();
        Ok(SavedQuery {
            id: full_path.clone(),
            name: clean_name,
            folder: folder.trim().to_string(),
            engine: None,
            sql: sql.to_string(),
            path: full_path,
            updated_at: Utc::now().to_rfc3339(),
        })
    }

    pub fn delete_saved_query(&self, path: &str) -> Result<()> {
        let p = Path::new(path);
        if p.exists() && p.starts_with(&self.paths.queries_dir) {
            fs::remove_file(p)?;
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
