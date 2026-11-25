use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DbaError {
    #[error("Connection not found: {0}")]
    ConnectionNotFound(String),

    #[error("Not connected: {0}")]
    NotConnected(String),

    #[error("Unsupported engine: {0}")]
    UnsupportedEngine(String),

    #[error("Read-only mode enabled: {0}")]
    ReadOnlyBlocked(String),

    #[error("Safety guard blocked execution: {0}")]
    SafetyGuardBlocked(String),

    #[error("Invalid URI: {0}")]
    InvalidUri(String),

    #[error("Database error: {message}")]
    Database {
        message: String,
        code: Option<String>,
        detail: Option<String>,
        line: Option<u32>,
    },

    #[error("SSH tunnel error: {0}")]
    SshTunnel(String),

    #[error("TLS/SSL error: {0}")]
    Tls(String),

    #[error("Storage error: {0}")]
    Storage(String),

    #[error("Keyring error: {0}")]
    Keyring(String),

    #[error("Query cancelled")]
    Cancelled,

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

#[derive(Debug, Clone, Serialize)]
pub struct SerializableError {
    pub kind: String,
    pub message: String,
    pub code: Option<String>,
    pub detail: Option<String>,
    pub line: Option<u32>,
}

impl From<DbaError> for SerializableError {
    fn from(err: DbaError) -> Self {
        match err {
            DbaError::Database {
                message,
                code,
                detail,
                line,
            } => SerializableError {
                kind: "database".into(),
                message,
                code,
                detail,
                line,
            },
            DbaError::ReadOnlyBlocked(msg) => SerializableError {
                kind: "read_only".into(),
                message: msg,
                code: None,
                detail: None,
                line: None,
            },
            DbaError::SafetyGuardBlocked(msg) => SerializableError {
                kind: "safety_guard".into(),
                message: msg,
                code: None,
                detail: None,
                line: None,
            },
            DbaError::Cancelled => SerializableError {
                kind: "cancelled".into(),
                message: "Query was cancelled by user".into(),
                code: None,
                detail: None,
                line: None,
            },
            other => SerializableError {
                kind: "internal".into(),
                message: other.to_string(),
                code: None,
                detail: None,
                line: None,
            },
        }
    }
}

pub type Result<T> = std::result::Result<T, DbaError>;
