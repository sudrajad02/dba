use crate::drivers::{qualified_table, quote_ident, sql_literal, SqlDriver};
use crate::error::Result;
use crate::models::*;
use chrono::Utc;
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

pub type ProgressCallback = Arc<dyn Fn(DataJobProgress) + Send + Sync>;

/// Built-in zero-dependency streaming SQL Dump (DDL + chunked multi-row INSERTs).
pub async fn run_sql_dump(
    driver: Arc<dyn SqlDriver>,
    engine: DbEngine,
    req: &SqlDumpRequest,
    job_id: String,
    cancel: Arc<AtomicBool>,
    on_progress: Option<ProgressCallback>,
) -> Result<DataJobResult> {
    let start = Instant::now();
    let chunk_size = req.chunk_size.unwrap_or(250).clamp(1, 2000);
    let total_tables = req.tables.len() as u64;

    let emit_progress = |percent: f64, current_item: String, completed_items: u64, rows: u64| {
        if let Some(ref cb) = on_progress {
            cb(DataJobProgress {
                job_id: job_id.clone(),
                percent: percent.clamp(0.0, 100.0),
                current_item,
                completed_items,
                total_items: total_tables,
                rows_processed: rows,
                elapsed_ms: start.elapsed().as_millis() as u64,
            });
        }
    };

    if let Some(parent) = Path::new(&req.output_path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }

    let file = File::create(&req.output_path)?;
    let mut w = BufWriter::new(file);

    writeln!(w, "-- ============================================================")?;
    writeln!(w, "-- DBa SQL Dump ({:?})", engine)?;
    writeln!(w, "-- Generated at: {}", Utc::now().to_rfc3339())?;
    if let Some(ref db) = req.database {
        writeln!(w, "-- Database: {}", db)?;
    }
    writeln!(w, "-- ============================================================\n")?;

    let mut rows_processed = 0u64;
    let mut cancelled = false;
    let mut errors = Vec::new();

    for (idx, table) in req.tables.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }

        let base_pct = if total_tables > 0 {
            (idx as f64 / total_tables as f64) * 100.0
        } else {
            0.0
        };
        let table_slice = if total_tables > 0 {
            100.0 / total_tables as f64
        } else {
            100.0
        };
        emit_progress(base_pct, table.clone(), idx as u64, rows_processed);

        let fq = qualified_table(engine, req.schema.as_deref(), table);
        writeln!(w, "-- ------------------------------------------------------------")?;
        writeln!(w, "-- Table: {}", fq)?;
        writeln!(w, "-- ------------------------------------------------------------")?;

        if req.drop_existing {
            writeln!(w, "DROP TABLE IF EXISTS {};", fq)?;
        }

        if req.include_structure {
            match driver
                .get_table_metadata(req.database.as_deref(), req.schema.as_deref(), table)
                .await
            {
                Ok(meta) => {
                    if let Some(ddl) = meta.ddl {
                        writeln!(w, "{}\n", ddl.trim())?;
                    }
                }
                Err(err) => {
                    errors.push(format!("DDL for {}: {}", table, err));
                }
            }
        }

        if req.include_data {
            let mut page = 1u64;
            let page_size = 1000u64;
            let mut table_rows_done = 0u64;
            loop {
                if cancel.load(Ordering::SeqCst) {
                    cancelled = true;
                    break;
                }
                let rs = driver
                    .fetch_table_data(&TableDataRequest {
                        connection_id: req.connection_id.clone(),
                        database: req.database.clone(),
                        schema: req.schema.clone(),
                        table: table.clone(),
                        page,
                        page_size,
                        filters: Vec::new(),
                        sorts: Vec::new(),
                    })
                    .await?;

                if rs.rows.is_empty() {
                    break;
                }

                let col_list = rs
                    .columns
                    .iter()
                    .map(|c| quote_ident(engine, &c.name))
                    .collect::<Vec<_>>()
                    .join(", ");

                for batch in rs.rows.chunks(chunk_size) {
                    let tuples: Vec<String> = batch
                        .iter()
                        .map(|r| {
                            let vals = r.iter().map(sql_literal).collect::<Vec<_>>().join(", ");
                            format!("({})", vals)
                        })
                        .collect();
                    writeln!(
                        w,
                        "INSERT INTO {} ({}) VALUES\n  {};",
                        fq,
                        col_list,
                        tuples.join(",\n  ")
                    )?;
                    rows_processed += batch.len() as u64;
                    table_rows_done += batch.len() as u64;
                }

                let sub_frac = if let Some(total_r) = rs.total_count {
                    if total_r > 0 {
                        (table_rows_done as f64 / total_r as f64).min(0.99)
                    } else {
                        0.5
                    }
                } else {
                    0.5
                };
                emit_progress(
                    base_pct + table_slice * sub_frac,
                    table.clone(),
                    idx as u64,
                    rows_processed,
                );

                if (rs.rows.len() as u64) < page_size {
                    break;
                }
                page += 1;
            }
            writeln!(w)?;
        }

        emit_progress(
            ((idx + 1) as f64 / total_tables.max(1) as f64) * 100.0,
            table.clone(),
            (idx + 1) as u64,
            rows_processed,
        );
    }

    w.flush()?;

    Ok(DataJobResult {
        job_id,
        ok: !cancelled && errors.is_empty(),
        cancelled,
        rows_processed,
        rows_failed: errors.len() as u64,
        duration_ms: start.elapsed().as_millis() as u64,
        output_path: Some(req.output_path.clone()),
        summary: if cancelled {
            format!("SQL dump cancelled after {} row(s)", rows_processed)
        } else {
            format!(
                "Dumped {} table(s) ({} rows) to {}",
                req.tables.len(),
                rows_processed,
                req.output_path
            )
        },
        errors,
    })
}

/// Streams a large `.sql` file statement-by-statement without loading the whole file into RAM.
pub async fn run_execute_sql_file(
    driver: Arc<dyn SqlDriver>,
    req: &ExecuteSqlFileRequest,
    job_id: String,
    cancel: Arc<AtomicBool>,
    on_progress: Option<ProgressCallback>,
) -> Result<DataJobResult> {
    let start = Instant::now();
    let file = File::open(&req.file_path)?;
    let total_bytes = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut bytes_processed = 0u64;
    let mut last_emit = Instant::now();

    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut in_dollar = false;
    let mut in_block_comment = false;
    let mut delimiter = ";".to_string();

    let mut executed = 0u64;
    let mut failed = 0u64;
    let mut cancelled = false;
    let mut errors = Vec::new();
    let mut line_buf = String::new();

    if let Some(ref cb) = on_progress {
        cb(DataJobProgress {
            job_id: job_id.clone(),
            percent: 0.0,
            current_item: "Starting SQL file execution...".into(),
            completed_items: 0,
            total_items: total_bytes,
            rows_processed: 0,
            elapsed_ms: 0,
        });
    }

    loop {
        if cancel.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
        line_buf.clear();
        let bytes_read = reader.read_line(&mut line_buf)?;
        if bytes_read == 0 {
            break;
        }
        bytes_processed += bytes_read as u64;
        if let Some(ref cb) = on_progress {
            if last_emit.elapsed().as_millis() >= 120 {
                last_emit = Instant::now();
                let pct = if total_bytes > 0 {
                    ((bytes_processed as f64 / total_bytes as f64) * 100.0).min(99.5)
                } else {
                    0.0
                };
                cb(DataJobProgress {
                    job_id: job_id.clone(),
                    percent: pct,
                    current_item: format!("Executed {} statement(s)", executed),
                    completed_items: bytes_processed,
                    total_items: total_bytes,
                    rows_processed: executed,
                    elapsed_ms: start.elapsed().as_millis() as u64,
                });
            }
        }

        // Handle MySQL `DELIMITER <token>` directive on its own line
        if !in_single && !in_double && !in_dollar && !in_block_comment {
            let trimmed_line = line_buf.trim();
            if trimmed_line.len() >= 10 && trimmed_line[..10].eq_ignore_ascii_case("DELIMITER ") {
                let next_delim = trimmed_line[10..].trim();
                if !next_delim.is_empty() {
                    delimiter = next_delim.to_string();
                    continue;
                }
            }
            if delimiter != ";" {
                if let Some(before) = trimmed_line.strip_suffix(&delimiter) {
                    if !before.trim().is_empty() {
                        current.push_str(before);
                        current.push('\n');
                    }
                    let stmt = current.trim().to_string();
                    current.clear();
                    if !stmt.is_empty() && !is_only_comments(&stmt) {
                        match driver
                            .execute_query(req.database.as_deref(), &stmt, &job_id)
                            .await
                        {
                            Ok(_) => executed += 1,
                            Err(err) => {
                                failed += 1;
                                if errors.len() < 50 {
                                    errors.push(err.to_string());
                                }
                                if req.error_policy == ImportErrorPolicy::StopOnError {
                                    return Ok(DataJobResult {
                                        job_id,
                                        ok: false,
                                        cancelled: false,
                                        rows_processed: executed,
                                        rows_failed: failed,
                                        duration_ms: start.elapsed().as_millis() as u64,
                                        output_path: None,
                                        summary: format!(
                                            "Stopped on error after {} statement(s)",
                                            executed
                                        ),
                                        errors,
                                    });
                                }
                            }
                        }
                    }
                    continue;
                } else {
                    current.push_str(&line_buf);
                    continue;
                }
            }
        }

        let chars: Vec<char> = line_buf.chars().collect();
        let mut i = 0;
        let mut in_line_comment = false;

        while i < chars.len() {
            let ch = chars[i];
            let next = if i + 1 < chars.len() {
                Some(chars[i + 1])
            } else {
                None
            };

            if in_line_comment {
                current.push(ch);
                i += 1;
                continue;
            }
            if in_block_comment {
                current.push(ch);
                if ch == '*' && next == Some('/') {
                    current.push('/');
                    in_block_comment = false;
                    i += 2;
                    continue;
                }
                i += 1;
                continue;
            }
            if in_single {
                current.push(ch);
                if ch == '\'' {
                    if next == Some('\'') {
                        current.push('\'');
                        i += 2;
                        continue;
                    }
                    in_single = false;
                }
                i += 1;
                continue;
            }
            if in_double {
                current.push(ch);
                if ch == '"' {
                    if next == Some('"') {
                        current.push('"');
                        i += 2;
                        continue;
                    }
                    in_double = false;
                }
                i += 1;
                continue;
            }
            if in_dollar {
                current.push(ch);
                if ch == '$' && next == Some('$') {
                    current.push('$');
                    in_dollar = false;
                    i += 2;
                    continue;
                }
                i += 1;
                continue;
            }

            if ch == '-' && next == Some('-') {
                in_line_comment = true;
                current.push('-');
                current.push('-');
                i += 2;
                continue;
            }
            if ch == '/' && next == Some('*') {
                in_block_comment = true;
                current.push('/');
                current.push('*');
                i += 2;
                continue;
            }
            if ch == '\'' {
                in_single = true;
                current.push(ch);
                i += 1;
                continue;
            }
            if ch == '"' {
                in_double = true;
                current.push(ch);
                i += 1;
                continue;
            }
            if ch == '$' && next == Some('$') {
                in_dollar = true;
                current.push('$');
                current.push('$');
                i += 2;
                continue;
            }

            if ch == ';' {
                let stmt = current.trim().to_string();
                current.clear();
                if !stmt.is_empty() && !is_only_comments(&stmt) {
                    match driver
                        .execute_query(req.database.as_deref(), &stmt, &job_id)
                        .await
                    {
                        Ok(_) => executed += 1,
                        Err(err) => {
                            failed += 1;
                            if errors.len() < 50 {
                                errors.push(err.to_string());
                            }
                            if req.error_policy == ImportErrorPolicy::StopOnError {
                                return Ok(DataJobResult {
                                    job_id,
                                    ok: false,
                                    cancelled: false,
                                    rows_processed: executed,
                                    rows_failed: failed,
                                    duration_ms: start.elapsed().as_millis() as u64,
                                    output_path: None,
                                    summary: format!(
                                        "Stopped on error after {} statement(s)",
                                        executed
                                    ),
                                    errors,
                                });
                            }
                        }
                    }
                }
                i += 1;
                continue;
            }

            current.push(ch);
            i += 1;
        }
    }

    // Flush trailing statement without semicolon
    if !cancelled {
        let trailing = current.trim().to_string();
        if !trailing.is_empty() && !is_only_comments(&trailing) {
            match driver
                .execute_query(req.database.as_deref(), &trailing, &job_id)
                .await
            {
                Ok(_) => executed += 1,
                Err(err) => {
                    failed += 1;
                    errors.push(err.to_string());
                }
            }
        }
    }

    Ok(DataJobResult {
        job_id,
        ok: !cancelled && (failed == 0 || req.error_policy == ImportErrorPolicy::SkipAndLog),
        cancelled,
        rows_processed: executed,
        rows_failed: failed,
        duration_ms: start.elapsed().as_millis() as u64,
        output_path: None,
        summary: if cancelled {
            format!("Execution cancelled after {} statement(s)", executed)
        } else {
            format!(
                "Executed {} statement(s) from {}{}",
                executed,
                req.file_path,
                if failed > 0 {
                    format!(" ({} failed)", failed)
                } else {
                    String::new()
                }
            )
        },
        errors,
    })
}

fn is_only_comments(stmt: &str) -> bool {
    stmt.lines().all(|l| {
        let t = l.trim();
        t.is_empty() || t.starts_with("--")
    })
}
