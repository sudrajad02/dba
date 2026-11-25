use crate::error::{DatavaultError, Result};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct DatavaultPaths {
    pub data_dir: PathBuf,
    pub sqlite_db: PathBuf,
    pub workspace_dir: PathBuf,
    pub connections_file: PathBuf,
    pub queries_dir: PathBuf,
    pub snippets_dir: PathBuf,
    pub models_dir: PathBuf,
    pub charts_dir: PathBuf,
    pub jobs_dir: PathBuf,
}

impl DatavaultPaths {
    /// Follows Linux XDG Base Directory Specification (~/.local/share/datavault/)
    pub fn resolve() -> Result<Self> {
        let base = dirs::data_local_dir()
            .or_else(|| dirs::home_dir().map(|h| h.join(".local/share")))
            .ok_or_else(|| DatavaultError::Storage("Cannot resolve XDG data directory".into()))?;
        let data_dir = base.join("datavault");
        let workspace_dir = data_dir.join("workspace");
        Ok(Self {
            sqlite_db: data_dir.join("datavault.db"),
            connections_file: workspace_dir.join("connections.json"),
            queries_dir: workspace_dir.join("queries"),
            snippets_dir: workspace_dir.join("snippets"),
            models_dir: workspace_dir.join("models"),
            charts_dir: workspace_dir.join("charts"),
            jobs_dir: workspace_dir.join("jobs"),
            workspace_dir,
            data_dir,
        })
    }

    pub fn ensure_dirs(&self) -> Result<()> {
        for dir in [
            &self.data_dir,
            &self.workspace_dir,
            &self.queries_dir,
            &self.snippets_dir,
            &self.models_dir,
            &self.charts_dir,
            &self.jobs_dir,
        ] {
            fs::create_dir_all(dir)?;
        }
        Ok(())
    }
}
