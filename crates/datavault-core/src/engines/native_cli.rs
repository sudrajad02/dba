use crate::error::{DatavaultError, Result};
use crate::models::*;
use std::path::PathBuf;
use std::process::Command;
use std::time::Instant;

const TOOL_SPECS: &[(&str, DbEngine, &str)] = &[
    ("pg_dump", DbEngine::Postgres, "dump"),
    ("pg_restore", DbEngine::Postgres, "restore"),
    ("psql", DbEngine::Postgres, "restore"),
    ("mysqldump", DbEngine::Mysql, "dump"),
    ("mysql", DbEngine::Mysql, "restore"),
    ("mongodump", DbEngine::Mongodb, "dump"),
    ("mongorestore", DbEngine::Mongodb, "restore"),
    ("bcp", DbEngine::Mssql, "dump"),
    ("sqlpackage", DbEngine::Mssql, "dump"),
];

/// Auto-detects official database CLI binaries available in system PATH.
pub fn detect_native_cli_tools() -> Vec<NativeCliToolInfo> {
    TOOL_SPECS
        .iter()
        .map(|(name, engine, role)| {
            let found_path = find_in_path(name);
            let version = found_path
                .as_ref()
                .and_then(|p| probe_version(p, name));
            NativeCliToolInfo {
                name: (*name).to_string(),
                engine: *engine,
                role: (*role).to_string(),
                available: found_path.is_some(),
                path: found_path.map(|p| p.to_string_lossy().to_string()),
                version,
            }
        })
        .collect()
}

fn find_in_path(bin: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(bin);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(windows)]
        {
            for ext in ["exe", "cmd", "bat"] {
                let candidate_ext = dir.join(format!("{}.{}", bin, ext));
                if candidate_ext.is_file() {
                    return Some(candidate_ext);
                }
            }
        }
    }
    None
}

fn probe_version(path: &PathBuf, name: &str) -> Option<String> {
    let flag = match name {
        "bcp" => "-v",
        "sqlpackage" => "/version",
        _ => "--version",
    };
    let out = Command::new(path).arg(flag).output().ok()?;
    let txt = String::from_utf8_lossy(&out.stdout);
    let first = txt.lines().next().map(str::trim).filter(|s| !s.is_empty());
    if let Some(v) = first {
        return Some(v.to_string());
    }
    let err_txt = String::from_utf8_lossy(&out.stderr);
    err_txt
        .lines()
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
}

/// Runs a native CLI dump/restore tool (`pg_dump`, `pg_restore`, `mysqldump`, `mysql`, `mongodump`, `mongorestore`, `bcp`, `sqlpackage`).
/// Passes credentials via environment variables (`PGPASSWORD`, `MYSQL_PWD`) rather than exposing them in process args when supported.
pub async fn run_native_cli(
    profile: &ConnectionProfile,
    password: Option<&str>,
    req: &NativeCliRunRequest,
) -> Result<NativeCliRunResult> {
    let start = Instant::now();
    let bin_path = find_in_path(&req.tool).ok_or_else(|| {
        DatavaultError::Storage(format!(
            "Native CLI tool '{}' not found in PATH. Install it or use Built-in SQL Dump.",
            req.tool
        ))
    })?;

    let db = req
        .database
        .as_deref()
        .or(profile.database.as_deref())
        .unwrap_or("");

    let mut args: Vec<String> = Vec::new();
    let mut envs: Vec<(String, String)> = Vec::new();

    match req.tool.as_str() {
        "pg_dump" => {
            args.extend([
                "-h".into(),
                profile.host.clone(),
                "-p".into(),
                profile.port.to_string(),
                "-U".into(),
                profile.username.clone(),
            ]);
            if let Some(ref fmt) = req.format {
                let flag = match fmt.as_str() {
                    "custom" => "c",
                    "directory" => "d",
                    "tar" => "t",
                    _ => "p",
                };
                args.push(format!("-F{}", flag));
            }
            if req.compress {
                args.push("-Z6".into());
            }
            if req.schema_only {
                args.push("--schema-only".into());
            } else if req.data_only {
                args.push("--data-only".into());
            }
            if let Some(j) = req.parallel_jobs {
                if req.format.as_deref() == Some("directory") && j > 1 {
                    args.extend(["-j".into(), j.to_string()]);
                }
            }
            args.extend(["-f".into(), req.file_path.clone()]);
            if !db.is_empty() {
                args.push(db.to_string());
            }
            if let Some(pw) = password {
                envs.push(("PGPASSWORD".into(), pw.to_string()));
            }
        }
        "pg_restore" => {
            args.extend([
                "-h".into(),
                profile.host.clone(),
                "-p".into(),
                profile.port.to_string(),
                "-U".into(),
                profile.username.clone(),
            ]);
            if !db.is_empty() {
                args.extend(["-d".into(), db.to_string()]);
            }
            if let Some(j) = req.parallel_jobs {
                if j > 1 {
                    args.extend(["-j".into(), j.to_string()]);
                }
            }
            if req.schema_only {
                args.push("--schema-only".into());
            } else if req.data_only {
                args.push("--data-only".into());
            }
            args.push(req.file_path.clone());
            if let Some(pw) = password {
                envs.push(("PGPASSWORD".into(), pw.to_string()));
            }
        }
        "psql" => {
            args.extend([
                "-h".into(),
                profile.host.clone(),
                "-p".into(),
                profile.port.to_string(),
                "-U".into(),
                profile.username.clone(),
            ]);
            if !db.is_empty() {
                args.extend(["-d".into(), db.to_string()]);
            }
            args.extend(["-f".into(), req.file_path.clone()]);
            if let Some(pw) = password {
                envs.push(("PGPASSWORD".into(), pw.to_string()));
            }
        }
        "mysqldump" => {
            args.extend([
                format!("--host={}", profile.host),
                format!("--port={}", profile.port),
                format!("--user={}", profile.username),
                "--single-transaction".into(),
            ]);
            if req.schema_only {
                args.push("--no-data".into());
            } else if req.data_only {
                args.push("--no-create-info".into());
            }
            if req.compress {
                args.push("--compress".into());
            }
            args.push(format!("--result-file={}", req.file_path));
            if !db.is_empty() {
                args.push(db.to_string());
            }
            if let Some(pw) = password {
                envs.push(("MYSQL_PWD".into(), pw.to_string()));
            }
        }
        "mysql" => {
            args.extend([
                format!("--host={}", profile.host),
                format!("--port={}", profile.port),
                format!("--user={}", profile.username),
                "-e".into(),
                format!("source {}", req.file_path),
            ]);
            if !db.is_empty() {
                args.push(db.to_string());
            }
            if let Some(pw) = password {
                envs.push(("MYSQL_PWD".into(), pw.to_string()));
            }
        }
        "mongodump" => {
            args.extend([
                format!("--host={}:{}", profile.host, profile.port),
            ]);
            if !profile.username.is_empty() {
                args.push(format!("--username={}", profile.username));
            }
            if let Some(pw) = password {
                if !pw.is_empty() {
                    args.push(format!("--password={}", pw));
                }
            }
            if !db.is_empty() {
                args.push(format!("--db={}", db));
            }
            if req.format.as_deref() == Some("archive") {
                args.push(format!("--archive={}", req.file_path));
            } else {
                args.push(format!("--out={}", req.file_path));
            }
            if req.compress {
                args.push("--gzip".into());
            }
        }
        "mongorestore" => {
            args.push(format!("--host={}:{}", profile.host, profile.port));
            if !profile.username.is_empty() {
                args.push(format!("--username={}", profile.username));
            }
            if let Some(pw) = password {
                if !pw.is_empty() {
                    args.push(format!("--password={}", pw));
                }
            }
            if !db.is_empty() {
                args.push(format!("--db={}", db));
            }
            if req.compress {
                args.push("--gzip".into());
            }
            if req.format.as_deref() == Some("archive") {
                args.push(format!("--archive={}", req.file_path));
            } else {
                args.push(req.file_path.clone());
            }
        }
        "sqlpackage" => {
            args.extend([
                "/Action:Export".into(),
                format!("/SourceServerName:{},{}", profile.host, profile.port),
                format!("/SourceDatabaseName:{}", db),
                format!("/SourceUser:{}", profile.username),
                format!("/TargetFile:{}", req.file_path),
            ]);
            if let Some(pw) = password {
                if !pw.is_empty() {
                    args.push(format!("/SourcePassword:{}", pw));
                }
            }
        }
        other => {
            return Err(DatavaultError::Storage(format!(
                "Unsupported native CLI tool '{}'",
                other
            )));
        }
    }

    for extra in &req.extra_args {
        if !extra.trim().is_empty() {
            args.push(extra.trim().to_string());
        }
    }

    let preview_args: Vec<String> = args
        .iter()
        .map(|a| {
            if a.starts_with("--password=") || a.starts_with("/SourcePassword:") {
                a.split('=').next().unwrap_or("--password").to_string() + "=******"
            } else {
                a.clone()
            }
        })
        .collect();
    let command_preview = format!("{} {}", req.tool, preview_args.join(" "));

    let output = tokio::task::spawn_blocking(move || {
        let mut cmd = Command::new(bin_path);
        cmd.args(&args);
        for (k, v) in envs {
            cmd.env(k, v);
        }
        cmd.output()
    })
    .await
    .map_err(|e| DatavaultError::Storage(format!("CLI task join error: {}", e)))??;

    Ok(NativeCliRunResult {
        ok: output.status.success(),
        exit_code: output.status.code().unwrap_or(-1),
        command_preview,
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        duration_ms: start.elapsed().as_millis() as u64,
    })
}
