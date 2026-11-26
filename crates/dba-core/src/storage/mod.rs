pub mod keyring;
pub mod paths;
pub mod sqlite;
pub mod workspace;

use crate::error::Result;
use crate::models::{
    BatchJob, ChartDashboard, CodeSnippet, ConnectionProfile, DataJobProfile, ErModel,
    JobExecutionLog, QueryHistoryEntry, SavedQuery,
};
use std::sync::Mutex;

pub struct StorageManager {
    pub paths: paths::DbaPaths,
    pub secrets: keyring::SecretStore,
    pub db: Mutex<sqlite::LocalDb>,
    pub workspace: workspace::WorkspaceStore,
}

impl StorageManager {
    pub fn initialize() -> Result<Self> {
        let paths = paths::DbaPaths::resolve()?;
        paths.ensure_dirs()?;
        let db = sqlite::LocalDb::open(&paths.sqlite_db)?;
        let workspace = workspace::WorkspaceStore::new(paths.clone());
        workspace.ensure_default_snippets()?;
        let secrets = keyring::SecretStore::new(&paths.data_dir);
        Ok(Self {
            paths,
            secrets,
            db: Mutex::new(db),
            workspace,
        })
    }

    pub fn list_connections(&self) -> Result<Vec<ConnectionProfile>> {
        self.workspace.load_connections()
    }

    pub fn save_connection(&self, profile: ConnectionProfile) -> Result<ConnectionProfile> {
        let mut all = self.workspace.load_connections()?;
        if let Some(existing) = all.iter_mut().find(|c| c.id == profile.id) {
            *existing = profile.clone();
        } else {
            all.push(profile.clone());
        }
        self.workspace.save_connections(&all)?;
        Ok(profile)
    }

    pub fn delete_connection(&self, id: &str) -> Result<()> {
        let mut all = self.workspace.load_connections()?;
        if let Some(pos) = all.iter().position(|c| c.id == id) {
            let removed = all.remove(pos);
            if let Some(ref kr) = removed.keyring_ref {
                let _ = self.secrets.delete_secret(kr);
            }
            if let Some(ref skr) = removed.ssh.keyring_ref {
                let _ = self.secrets.delete_secret(skr);
            }
            self.workspace.save_connections(&all)?;
        }
        Ok(())
    }

    pub fn get_connection(&self, id: &str) -> Result<Option<ConnectionProfile>> {
        let all = self.workspace.load_connections()?;
        Ok(all.into_iter().find(|c| c.id == id))
    }

    pub fn record_history(&self, entry: &QueryHistoryEntry) -> Result<()> {
        let db = self.db.lock().unwrap();
        db.insert_history(entry)
    }

    pub fn search_history(&self, query: Option<&str>, limit: usize) -> Result<Vec<QueryHistoryEntry>> {
        let db = self.db.lock().unwrap();
        db.search_history(query, limit)
    }

    pub fn list_saved_queries(&self) -> Result<Vec<SavedQuery>> {
        self.workspace.list_saved_queries()
    }

    pub fn save_query_file(
        &self,
        folder: &str,
        name: &str,
        sql: &str,
        connection_id: Option<&str>,
        database: Option<&str>,
        schema: Option<&str>,
        engine: Option<crate::models::DbEngine>,
        overwrite_path: Option<&str>,
    ) -> Result<SavedQuery> {
        self.workspace.save_query_file(
            folder,
            name,
            sql,
            connection_id,
            database,
            schema,
            engine,
            overwrite_path,
        )
    }

    pub fn rename_saved_query(&self, old_path: &str, new_name: &str) -> Result<SavedQuery> {
        self.workspace.rename_saved_query(old_path, new_name)
    }

    pub fn duplicate_saved_query(&self, path: &str, new_name: &str) -> Result<SavedQuery> {
        self.workspace.duplicate_saved_query(path, new_name)
    }

    pub fn delete_saved_query(&self, path: &str) -> Result<()> {
        self.workspace.delete_saved_query(path)
    }

    pub fn list_snippets(&self) -> Result<Vec<CodeSnippet>> {
        self.workspace.list_snippets()
    }

    pub fn save_snippet(&self, snippet: CodeSnippet) -> Result<Vec<CodeSnippet>> {
        self.workspace.save_snippet(snippet)
    }

    pub fn delete_snippet(&self, id: &str) -> Result<Vec<CodeSnippet>> {
        self.workspace.delete_snippet(id)
    }

    pub fn save_recovery_state(&self, key: &str, payload: &str) -> Result<()> {
        let db = self.db.lock().unwrap();
        db.set_app_state(key, payload)
    }

    pub fn load_recovery_state(&self, key: &str) -> Result<Option<String>> {
        let db = self.db.lock().unwrap();
        db.get_app_state(key)
    }

    pub fn list_job_profiles(&self, kind: Option<&str>) -> Result<Vec<DataJobProfile>> {
        self.workspace.list_job_profiles(kind)
    }

    pub fn save_job_profile(&self, profile: DataJobProfile) -> Result<DataJobProfile> {
        self.workspace.save_job_profile(profile)
    }

    pub fn delete_job_profile(&self, id: &str) -> Result<()> {
        self.workspace.delete_job_profile(id)
    }

    pub fn list_er_models(&self) -> Result<Vec<ErModel>> {
        self.workspace.list_er_models()
    }

    pub fn save_er_model(&self, model: ErModel) -> Result<ErModel> {
        self.workspace.save_er_model(model)
    }

    pub fn delete_er_model(&self, id: &str) -> Result<()> {
        self.workspace.delete_er_model(id)
    }

    pub fn list_dashboards(&self) -> Result<Vec<ChartDashboard>> {
        self.workspace.list_dashboards()
    }

    pub fn save_dashboard(&self, dash: ChartDashboard) -> Result<ChartDashboard> {
        self.workspace.save_dashboard(dash)
    }

    pub fn delete_dashboard(&self, id: &str) -> Result<()> {
        self.workspace.delete_dashboard(id)
    }

    pub fn list_batch_jobs(&self) -> Result<Vec<BatchJob>> {
        self.workspace.list_batch_jobs()
    }

    pub fn get_batch_job(&self, id: &str) -> Result<Option<BatchJob>> {
        self.workspace.get_batch_job(id)
    }

    pub fn save_batch_job(&self, job: BatchJob) -> Result<BatchJob> {
        self.workspace.save_batch_job(job)
    }

    pub fn delete_batch_job(&self, id: &str) -> Result<()> {
        self.workspace.delete_batch_job(id)
    }

    pub fn insert_job_log(&self, entry: &JobExecutionLog) -> Result<()> {
        let db = self.db.lock().unwrap();
        db.insert_job_log(entry)
    }

    pub fn list_job_logs(
        &self,
        job_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<JobExecutionLog>> {
        let db = self.db.lock().unwrap();
        db.list_job_logs(job_id, limit)
    }

    pub fn clear_job_logs(&self, job_id: Option<&str>) -> Result<()> {
        let db = self.db.lock().unwrap();
        db.clear_job_logs(job_id)
    }
}
