use crate::error::Result;
use crate::models::{JobExecutionLog, QueryHistoryEntry};
use rusqlite::{params, Connection};
use std::path::Path;

pub struct LocalDb {
    conn: Connection,
}

impl LocalDb {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        let db = Self { conn };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<()> {
        self.conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS query_history (
                id TEXT PRIMARY KEY,
                connection_id TEXT NOT NULL,
                connection_name TEXT NOT NULL,
                database_name TEXT,
                sql TEXT NOT NULL,
                executed_at TEXT NOT NULL,
                duration_ms INTEGER NOT NULL,
                row_count INTEGER,
                status TEXT NOT NULL,
                error_message TEXT
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS query_history_fts USING fts5(
                id UNINDEXED,
                sql,
                connection_name,
                database_name
            );

            CREATE TABLE IF NOT EXISTS app_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS schema_cache (
                connection_id TEXT NOT NULL,
                database_name TEXT NOT NULL,
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (connection_id, database_name)
            );

            CREATE TABLE IF NOT EXISTS job_logs (
                id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL,
                started_at TEXT NOT NULL,
                finished_at TEXT,
                status TEXT NOT NULL,
                output TEXT
            );
            "#,
        )?;
        Ok(())
    }

    pub fn insert_history(&self, entry: &QueryHistoryEntry) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO query_history
             (id, connection_id, connection_name, database_name, sql, executed_at, duration_ms, row_count, status, error_message)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                entry.id,
                entry.connection_id,
                entry.connection_name,
                entry.database,
                entry.sql,
                entry.executed_at,
                entry.duration_ms as i64,
                entry.row_count.map(|v| v as i64),
                entry.status,
                entry.error_message,
            ],
        )?;
        self.conn.execute(
            "INSERT INTO query_history_fts (id, sql, connection_name, database_name) VALUES (?1, ?2, ?3, ?4)",
            params![
                entry.id,
                entry.sql,
                entry.connection_name,
                entry.database.clone().unwrap_or_default(),
            ],
        )?;
        Ok(())
    }

    pub fn search_history(
        &self,
        query: Option<&str>,
        limit: usize,
    ) -> Result<Vec<QueryHistoryEntry>> {
        let mut results = Vec::new();
        if let Some(q) = query.map(str::trim).filter(|s| !s.is_empty()) {
            let like = format!("%{}%", q);
            let mut stmt = self.conn.prepare(
                "SELECT id, connection_id, connection_name, database_name, sql, executed_at, duration_ms, row_count, status, error_message
                 FROM query_history
                 WHERE sql LIKE ?1 OR connection_name LIKE ?1 OR COALESCE(database_name, '') LIKE ?1
                 ORDER BY executed_at DESC
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![like, limit as i64], Self::map_history_row)?;
            for r in rows {
                results.push(r?);
            }
        } else {
            let mut stmt = self.conn.prepare(
                "SELECT id, connection_id, connection_name, database_name, sql, executed_at, duration_ms, row_count, status, error_message
                 FROM query_history
                 ORDER BY executed_at DESC
                 LIMIT ?1",
            )?;
            let rows = stmt.query_map(params![limit as i64], Self::map_history_row)?;
            for r in rows {
                results.push(r?);
            }
        }
        Ok(results)
    }

    fn map_history_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<QueryHistoryEntry> {
        Ok(QueryHistoryEntry {
            id: row.get(0)?,
            connection_id: row.get(1)?,
            connection_name: row.get(2)?,
            database: row.get(3)?,
            sql: row.get(4)?,
            executed_at: row.get(5)?,
            duration_ms: row.get::<_, i64>(6)? as u64,
            row_count: row.get::<_, Option<i64>>(7)?.map(|v| v as u64),
            status: row.get(8)?,
            error_message: row.get(9)?,
        })
    }

    pub fn set_app_state(&self, key: &str, value: &str) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?1, ?2, ?3)",
            params![key, value, now],
        )?;
        Ok(())
    }

    pub fn get_app_state(&self, key: &str) -> Result<Option<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT value FROM app_state WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get(0)?))
        } else {
            Ok(None)
        }
    }

    pub fn insert_job_log(&self, entry: &JobExecutionLog) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO job_logs (id, job_id, started_at, finished_at, status, output)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                entry.id,
                entry.job_id,
                entry.started_at,
                entry.finished_at,
                entry.status,
                entry.output,
            ],
        )?;
        Ok(())
    }

    pub fn list_job_logs(
        &self,
        job_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<JobExecutionLog>> {
        let mut out = Vec::new();
        if let Some(jid) = job_id.filter(|s| !s.trim().is_empty()) {
            let mut stmt = self.conn.prepare(
                "SELECT id, job_id, started_at, finished_at, status, COALESCE(output, '')
                 FROM job_logs
                 WHERE job_id = ?1
                 ORDER BY started_at DESC
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![jid, limit as i64], Self::map_job_log)?;
            for r in rows {
                out.push(r?);
            }
        } else {
            let mut stmt = self.conn.prepare(
                "SELECT id, job_id, started_at, finished_at, status, COALESCE(output, '')
                 FROM job_logs
                 ORDER BY started_at DESC
                 LIMIT ?1",
            )?;
            let rows = stmt.query_map(params![limit as i64], Self::map_job_log)?;
            for r in rows {
                out.push(r?);
            }
        }
        Ok(out)
    }

    pub fn clear_job_logs(&self, job_id: Option<&str>) -> Result<()> {
        if let Some(jid) = job_id.filter(|s| !s.trim().is_empty()) {
            self.conn
                .execute("DELETE FROM job_logs WHERE job_id = ?1", params![jid])?;
        } else {
            self.conn.execute("DELETE FROM job_logs", [])?;
        }
        Ok(())
    }

    fn map_job_log(row: &rusqlite::Row<'_>) -> rusqlite::Result<JobExecutionLog> {
        Ok(JobExecutionLog {
            id: row.get(0)?,
            job_id: row.get(1)?,
            started_at: row.get(2)?,
            finished_at: row.get(3)?,
            status: row.get(4)?,
            output: row.get(5)?,
        })
    }
}
