use crate::error::{DbaError, Result};
use crate::manager::ConnectionManager;
use crate::models::*;
use chrono::Utc;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use uuid::Uuid;

/// Sanitizes a job ID so it is safe as a systemd unit name suffix.
pub fn safe_unit_suffix(job_id: &str) -> String {
    let cleaned: String = job_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "unnamed".into()
    } else {
        cleaned
    }
}

pub fn systemd_unit_base(job_id: &str) -> String {
    format!("dba-job-{}", safe_unit_suffix(job_id))
}

/// Resolves ~/.config/systemd/user directory on Linux.
pub fn systemd_user_dir() -> Result<PathBuf> {
    let base = dirs::config_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join(".config")))
        .ok_or_else(|| DbaError::Storage("Cannot resolve XDG config directory".into()))?;
    Ok(base.join("systemd").join("user"))
}

/// Locates the dba-cli executable (beside current binary, in PATH, or fallback name).
pub fn resolve_cli_binary() -> String {
    let bin_name = if cfg!(windows) {
        "dba-cli.exe"
    } else {
        "dba-cli"
    };
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sibling = dir.join(bin_name);
            if sibling.exists() {
                return sibling.to_string_lossy().to_string();
            }
        }
    }
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(bin_name);
            if candidate.is_file() {
                return candidate.to_string_lossy().to_string();
            }
        }
    }
    bin_name.to_string()
}

pub fn render_systemd_service(job_id: &str, job_name: &str, cli_binary: &str) -> String {
    format!(
        "[Unit]\nDescription=DBa Batch Job: {}\nAfter=network-online.target\n\n[Service]\nType=oneshot\nExecStart={} run-job {}\n",
        job_name.replace('\n', " "),
        cli_binary,
        job_id
    )
}

pub fn render_systemd_timer(job_id: &str, job_name: &str, on_calendar: &str) -> String {
    let cal = if on_calendar.trim().is_empty() {
        "daily"
    } else {
        on_calendar.trim()
    };
    format!(
        "[Unit]\nDescription=DBa Schedule Timer: {}\n\n[Timer]\nOnCalendar={}\nPersistent=true\nUnit={}.service\n\n[Install]\nWantedBy=timers.target\n",
        job_name.replace('\n', " "),
        cal,
        systemd_unit_base(job_id)
    )
}

/// Installs or updates ~/.config/systemd/user/dba-job-<id>.{service,timer} and enables the timer (Linux only).
pub fn sync_systemd_timer(job: &BatchJob) -> Result<SystemdTimerStatus> {
    #[cfg(not(target_os = "linux"))]
    {
        return Ok(SystemdTimerStatus {
            job_id: job.id.clone(),
            unit_name: format!("{}.timer", systemd_unit_base(&job.id)),
            service_path: String::new(),
            timer_path: String::new(),
            installed: false,
            enabled: false,
            active: false,
            next_trigger: None,
            message: "Automatic systemd scheduling is only supported on Linux. Run jobs manually or via dba-cli.".into(),
        });
    }

    #[cfg(target_os = "linux")]
    {
        let dir = systemd_user_dir()?;
        fs::create_dir_all(&dir)?;

        let base = systemd_unit_base(&job.id);
        let service_path = dir.join(format!("{}.service", base));
        let timer_path = dir.join(format!("{}.timer", base));
        let timer_unit = format!("{}.timer", base);

        if !job.schedule.enabled || job.schedule.preset == SchedulePreset::Manual {
            return remove_systemd_timer(&job.id);
        }

        let cli_bin = resolve_cli_binary();
        let svc_content = render_systemd_service(&job.id, &job.name, &cli_bin);
        let tmr_content = render_systemd_timer(&job.id, &job.name, &job.schedule.on_calendar);

        fs::write(&service_path, svc_content)?;
        fs::write(&timer_path, tmr_content)?;

        let mut notes = Vec::new();
        match Command::new("systemctl")
            .args(["--user", "daemon-reload"])
            .output()
        {
            Ok(o) if o.status.success() => {}
            Ok(o) => notes.push(format!(
                "daemon-reload: {}",
                String::from_utf8_lossy(&o.stderr).trim()
            )),
            Err(e) => notes.push(format!("systemctl unavailable: {}", e)),
        }

        match Command::new("systemctl")
            .args(["--user", "enable", "--now", &timer_unit])
            .output()
        {
            Ok(o) if o.status.success() => notes.push("Timer enabled and started via systemd --user.".into()),
            Ok(o) => notes.push(format!(
                "Unit files written, enable returned: {}",
                String::from_utf8_lossy(&o.stderr).trim()
            )),
            Err(e) => notes.push(format!("Unit files written (systemctl unavailable: {})", e)),
        }

        let mut status = get_systemd_timer_status(&job.id)?;
        if !notes.is_empty() {
            status.message = notes.join(" | ");
        }
        Ok(status)
    }
}

/// Disables and deletes the systemd --user unit files for a batch job (Linux only).
pub fn remove_systemd_timer(job_id: &str) -> Result<SystemdTimerStatus> {
    #[cfg(not(target_os = "linux"))]
    {
        return Ok(SystemdTimerStatus {
            job_id: job_id.to_string(),
            unit_name: format!("{}.timer", systemd_unit_base(job_id)),
            service_path: String::new(),
            timer_path: String::new(),
            installed: false,
            enabled: false,
            active: false,
            next_trigger: None,
            message: "Systemd scheduling is only supported on Linux.".into(),
        });
    }

    #[cfg(target_os = "linux")]
    {
        let dir = systemd_user_dir()?;
        let base = systemd_unit_base(job_id);
        let service_path = dir.join(format!("{}.service", base));
        let timer_path = dir.join(format!("{}.timer", base));
        let timer_unit = format!("{}.timer", base);

        let _ = Command::new("systemctl")
            .args(["--user", "disable", "--now", &timer_unit])
            .output();

        if timer_path.exists() {
            let _ = fs::remove_file(&timer_path);
        }
        if service_path.exists() {
            let _ = fs::remove_file(&service_path);
        }

        let _ = Command::new("systemctl")
            .args(["--user", "daemon-reload"])
            .output();

        Ok(SystemdTimerStatus {
            job_id: job_id.to_string(),
            unit_name: timer_unit,
            service_path: service_path.to_string_lossy().to_string(),
            timer_path: timer_path.to_string_lossy().to_string(),
            installed: false,
            enabled: false,
            active: false,
            next_trigger: None,
            message: "Systemd timer removed.".into(),
        })
    }
}

/// Inspects unit file existence and live systemd --user enabled/active status (Linux only).
pub fn get_systemd_timer_status(job_id: &str) -> Result<SystemdTimerStatus> {
    #[cfg(not(target_os = "linux"))]
    {
        return Ok(SystemdTimerStatus {
            job_id: job_id.to_string(),
            unit_name: format!("{}.timer", systemd_unit_base(job_id)),
            service_path: String::new(),
            timer_path: String::new(),
            installed: false,
            enabled: false,
            active: false,
            next_trigger: None,
            message: "Manual mode (systemd scheduling is Linux-only).".into(),
        });
    }

    #[cfg(target_os = "linux")]
    {
        let dir = systemd_user_dir()?;
        let base = systemd_unit_base(job_id);
        let service_path = dir.join(format!("{}.service", base));
        let timer_path = dir.join(format!("{}.timer", base));
        let timer_unit = format!("{}.timer", base);
        let installed = service_path.exists() && timer_path.exists();

        let mut enabled = false;
        let mut active = false;
        let mut next_trigger = None;
        let mut message = if installed {
            "Unit files installed.".to_string()
        } else {
            "No systemd timer installed (manual mode).".to_string()
        };

        if installed {
            if let Ok(out) = Command::new("systemctl")
                .args(["--user", "is-enabled", &timer_unit])
                .output()
            {
                enabled = out.status.success()
                    && String::from_utf8_lossy(&out.stdout).trim() == "enabled";
            }
            if let Ok(out) = Command::new("systemctl")
                .args(["--user", "is-active", &timer_unit])
                .output()
            {
                active = out.status.success()
                    && String::from_utf8_lossy(&out.stdout).trim() == "active";
            }
            if let Ok(out) = Command::new("systemctl")
                .args([
                    "--user",
                    "show",
                    &timer_unit,
                    "--property=NextElapseUSecRealtime",
                    "--value",
                ])
                .output()
            {
                if out.status.success() {
                    let txt = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !txt.is_empty() && txt != "n/a" {
                        next_trigger = Some(txt);
                    }
                }
            }
            message = if enabled && active {
                "Active and scheduled via systemd --user".into()
            } else if enabled {
                "Enabled (waiting for user systemd session)".into()
            } else {
                "Unit files installed (not active)".into()
            };
        }

        Ok(SystemdTimerStatus {
            job_id: job_id.to_string(),
            unit_name: timer_unit,
            service_path: service_path.to_string_lossy().to_string(),
            timer_path: timer_path.to_string_lossy().to_string(),
            installed,
            enabled,
            active,
            next_trigger,
            message,
        })
    }
}

/// Sends a desktop notification (best-effort, non-fatal across Linux, macOS, and Windows).
pub fn send_desktop_notification(title: &str, body: &str, is_error: bool) {
    #[cfg(target_os = "linux")]
    {
        let urgency = if is_error { "critical" } else { "normal" };
        let icon = if is_error {
            "dialog-error"
        } else {
            "dialog-information"
        };
        let _ = Command::new("notify-send")
            .args(["-a", "DBa", "-u", urgency, "-i", icon, title, body])
            .output();
    }

    #[cfg(target_os = "macos")]
    {
        let _ = is_error;
        let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!(
            "display notification \"{}\" with title \"{}\"",
            esc(body),
            esc(title)
        );
        let _ = Command::new("osascript").args(["-e", &script]).output();
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (title, body, is_error);
    }
}

/// Executes all enabled steps in a BatchJob sequentially, persists the log to SQLite,
/// and optionally triggers a Linux desktop notification.
pub async fn run_batch_job(
    manager: &ConnectionManager,
    job: &BatchJob,
    send_notify: bool,
) -> Result<JobExecutionLog> {
    let log_id = Uuid::new_v4().to_string();
    let started_at = Utc::now().to_rfc3339();
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!(
        "[{}] Starting batch job '{}' ({} step(s))",
        started_at,
        job.name,
        job.steps.len()
    ));

    let mut all_ok = true;

    for (idx, step) in job.steps.iter().enumerate() {
        if !step.enabled {
            lines.push(format!("  Step {}: '{}' [SKIPPED]", idx + 1, step.name));
            continue;
        }
        lines.push(format!(
            "  Step {}: '{}' ({:?}) ...",
            idx + 1,
            step.name,
            step.kind
        ));

        let step_res: Result<String> = match step.kind {
            BatchStepKind::RunQuery => {
                let conn_id = step
                    .config
                    .get("connectionId")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let database = step
                    .config
                    .get("database")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(ToString::to_string);
                let sql = step
                    .config
                    .get("sql")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                if conn_id.is_empty() || sql.trim().is_empty() {
                    Err(DbaError::Storage(
                        "RunQuery step requires connectionId and sql".into(),
                    ))
                } else {
                    manager.ensure_connected(&conn_id).await?;
                    let res = manager
                        .execute_query(&conn_id, database.as_deref(), &sql, None, true)
                        .await?;
                    Ok(format!(
                        "Executed {} statement(s) in {} ms",
                        res.result_sets.len(),
                        res.total_execution_ms
                    ))
                }
            }
            BatchStepKind::SqlDump => {
                let req: SqlDumpRequest = serde_json::from_value(step.config.clone())
                    .map_err(|e| DbaError::Storage(format!("Invalid SqlDump config: {}", e)))?;
                manager.ensure_connected(&req.connection_id).await?;
                let res = manager.dump_sql(&req).await?;
                if res.ok {
                    Ok(res.summary)
                } else {
                    Err(DbaError::Storage(res.summary))
                }
            }
            BatchStepKind::ExportTable => {
                let req: ExportRequest = serde_json::from_value(step.config.clone())
                    .map_err(|e| DbaError::Storage(format!("Invalid Export config: {}", e)))?;
                manager.ensure_connected(&req.connection_id).await?;
                let res = manager.export_table_data(&req).await?;
                if res.ok {
                    Ok(res.summary)
                } else {
                    Err(DbaError::Storage(res.summary))
                }
            }
            BatchStepKind::DataTransfer => {
                let mut req: DataTransferRequest = serde_json::from_value(step.config.clone())
                    .map_err(|e| {
                        DbaError::Storage(format!("Invalid DataTransfer config: {}", e))
                    })?;
                req.confirmed_production = true;
                manager.ensure_connected(&req.source_connection_id).await?;
                manager.ensure_connected(&req.target_connection_id).await?;
                let res = manager.run_data_transfer(&req).await?;
                if res.ok {
                    Ok(res.summary)
                } else {
                    Err(DbaError::Storage(res.summary))
                }
            }
            BatchStepKind::StructureSync => {
                let req: StructureSyncRequest = serde_json::from_value(step.config.clone())
                    .map_err(|e| {
                        DbaError::Storage(format!("Invalid StructureSync config: {}", e))
                    })?;
                manager.ensure_connected(&req.source_connection_id).await?;
                manager.ensure_connected(&req.target_connection_id).await?;
                let plan = manager.compute_structure_sync(&req).await?;
                let stmts: Vec<String> = plan
                    .tables
                    .iter()
                    .flat_map(|t| t.ddl_statements.iter().cloned())
                    .collect();
                if stmts.is_empty() {
                    Ok("Schemas already in sync (0 DDL statements)".into())
                } else {
                    let exec_res = manager
                        .execute_sync_script(&ExecuteSyncScriptRequest {
                            connection_id: req.target_connection_id.clone(),
                            database: req.target_database.clone(),
                            statements: stmts,
                            stop_on_error: job.stop_on_error,
                            confirmed_production: true,
                        })
                        .await?;
                    if exec_res.ok {
                        Ok(exec_res.summary)
                    } else {
                        Err(DbaError::Storage(exec_res.summary))
                    }
                }
            }
            BatchStepKind::DataSync => {
                let req: DataSyncRequest = serde_json::from_value(step.config.clone())
                    .map_err(|e| {
                        DbaError::Storage(format!("Invalid DataSync config: {}", e))
                    })?;
                manager.ensure_connected(&req.source_connection_id).await?;
                manager.ensure_connected(&req.target_connection_id).await?;
                let plan = manager.compute_data_sync(&req).await?;
                let stmts: Vec<String> = plan
                    .tables
                    .iter()
                    .flat_map(|t| t.statements.iter().cloned())
                    .collect();
                if stmts.is_empty() {
                    Ok("Data already in sync (0 statements)".into())
                } else {
                    let exec_res = manager
                        .execute_sync_script(&ExecuteSyncScriptRequest {
                            connection_id: req.target_connection_id.clone(),
                            database: req.target_database.clone(),
                            statements: stmts,
                            stop_on_error: job.stop_on_error,
                            confirmed_production: true,
                        })
                        .await?;
                    if exec_res.ok {
                        Ok(exec_res.summary)
                    } else {
                        Err(DbaError::Storage(exec_res.summary))
                    }
                }
            }
            BatchStepKind::DataGen => {
                let mut req: DataGenRequest = serde_json::from_value(step.config.clone())
                    .map_err(|e| DbaError::Storage(format!("Invalid DataGen config: {}", e)))?;
                req.confirmed_production = true;
                manager.ensure_connected(&req.connection_id).await?;
                let res = manager.run_data_gen(&req).await?;
                if res.ok {
                    Ok(res.summary)
                } else {
                    Err(DbaError::Storage(res.error.unwrap_or(res.summary)))
                }
            }
        };

        match step_res {
            Ok(msg) => {
                lines.push(format!("    ✓ OK: {}", msg));
            }
            Err(err) => {
                all_ok = false;
                lines.push(format!("    ✗ FAILED: {}", err));
                if job.stop_on_error {
                    lines.push("  Stopping batch job due to stop_on_error=true.".into());
                    break;
                }
            }
        }
    }

    let finished_at = Utc::now().to_rfc3339();
    let status = if all_ok { "success" } else { "failed" }.to_string();
    lines.push(format!("[{}] Finished with status: {}", finished_at, status));

    let log = JobExecutionLog {
        id: log_id,
        job_id: job.id.clone(),
        started_at,
        finished_at: Some(finished_at),
        status: status.clone(),
        output: lines.join("\n"),
    };

    let _ = manager.storage.insert_job_log(&log);

    if send_notify {
        if all_ok && job.schedule.notify_on_success {
            send_desktop_notification(
                &format!("DBa Job Succeeded: {}", job.name),
                &format!("Completed {} step(s) successfully.", job.steps.len()),
                false,
            );
        } else if !all_ok && job.schedule.notify_on_failure {
            send_desktop_notification(
                &format!("DBa Job Failed: {}", job.name),
                "One or more steps failed. Check DBa Automation logs.",
                true,
            );
        }
    }

    Ok(log)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_valid_systemd_service_and_timer_units() {
        let svc = render_systemd_service("job 123/abc", "Nightly Backup", "/usr/bin/dba-cli");
        assert!(svc.contains("Description=DBa Batch Job: Nightly Backup"));
        assert!(svc.contains("ExecStart=/usr/bin/dba-cli run-job job 123/abc"));
        assert!(svc.contains("Type=oneshot"));

        let tmr = render_systemd_timer("job 123/abc", "Nightly Backup", "*-*-* 02:30:00");
        assert!(tmr.contains("OnCalendar=*-*-* 02:30:00"));
        assert!(tmr.contains("Unit=dba-job-job-123-abc.service"));
        assert!(tmr.contains("Persistent=true"));
    }

    #[test]
    fn sanitizes_unit_suffix() {
        assert_eq!(safe_unit_suffix("abc-123_4"), "abc-123_4");
        assert_eq!(safe_unit_suffix("my/job:1"), "my-job-1");
        assert_eq!(safe_unit_suffix(""), "unnamed");
    }
}
