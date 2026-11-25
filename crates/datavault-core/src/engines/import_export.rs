use crate::drivers::mongodb::MongoDriver;
use crate::drivers::{qualified_table, quote_ident, sql_literal, SqlDriver};
use crate::engines::xlsx::{read_xlsx, write_xlsx};
use crate::error::{DatavaultError, Result};
use crate::models::*;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

/// RFC-4180 compliant CSV line formatter.
pub fn format_csv_row(values: &[serde_json::Value], delim: char) -> String {
    let mut out = String::new();
    for (i, val) in values.iter().enumerate() {
        if i > 0 {
            out.push(delim);
        }
        let raw = value_to_plain_string(val);
        if raw.contains(delim) || raw.contains('"') || raw.contains('\n') || raw.contains('\r') {
            out.push('"');
            out.push_str(&raw.replace('"', "\"\""));
            out.push('"');
        } else {
            out.push_str(&raw);
        }
    }
    out
}

/// RFC-4180 compliant CSV line parser.
pub fn parse_csv_line(line: &str, delim: char) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = line.trim_end_matches(&['\r', '\n'][..]).chars().collect();
    let mut i = 0;
    let mut in_quotes = false;

    while i < chars.len() {
        let ch = chars[i];
        if in_quotes {
            if ch == '"' {
                if i + 1 < chars.len() && chars[i + 1] == '"' {
                    current.push('"');
                    i += 2;
                    continue;
                }
                in_quotes = false;
            } else {
                current.push(ch);
            }
        } else if ch == '"' && current.is_empty() {
            in_quotes = true;
        } else if ch == delim {
            fields.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
        i += 1;
    }
    fields.push(current);
    fields
}

fn value_to_plain_string(val: &serde_json::Value) -> String {
    match val {
        serde_json::Value::Null => String::new(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn parse_cell_value(raw: &str, target_type: Option<&str>) -> serde_json::Value {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("null") {
        return serde_json::Value::Null;
    }
    if let Some(tt) = target_type {
        let lower = tt.to_lowercase();
        if lower.contains("int") || lower.contains("serial") {
            if let Ok(i) = trimmed.parse::<i64>() {
                return serde_json::Value::from(i);
            }
        } else if lower.contains("float")
            || lower.contains("double")
            || lower.contains("dec")
            || lower.contains("num")
        {
            if let Ok(f) = trimmed.parse::<f64>() {
                if let Some(n) = serde_json::Number::from_f64(f) {
                    return serde_json::Value::Number(n);
                }
            }
        } else if lower.contains("bool") || lower == "bit" {
            return serde_json::Value::Bool(matches!(
                trimmed.to_lowercase().as_str(),
                "true" | "1" | "yes" | "t"
            ));
        } else if lower.contains("json") {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
                return v;
            }
        }
        return serde_json::Value::String(raw.to_string());
    }
    serde_json::Value::String(raw.to_string())
}

/// Streams a table or MongoDB collection out to CSV, JSON, JSONL, Excel (.xlsx), or SQL INSERT/UPSERT.
pub async fn run_export(
    driver: Arc<dyn SqlDriver>,
    engine: DbEngine,
    req: &ExportRequest,
    job_id: String,
    cancel: Arc<AtomicBool>,
) -> Result<DataJobResult> {
    let start = Instant::now();
    let delim = req
        .delimiter
        .as_deref()
        .and_then(|s| s.chars().next())
        .unwrap_or(',');
    let page_size = req.batch_size.unwrap_or(1000).clamp(50, 5000) as u64;

    if let Some(parent) = Path::new(&req.output_path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }

    let mut page = 1u64;
    let mut rows_processed = 0u64;
    let mut cancelled = false;
    let mut xlsx_headers: Vec<String> = Vec::new();
    let mut xlsx_rows: Vec<Vec<serde_json::Value>> = Vec::new();

    let mut writer = if req.format != DataFileFormat::Xlsx {
        Some(BufWriter::new(File::create(&req.output_path)?))
    } else {
        None
    };

    if req.format == DataFileFormat::Json {
        if let Some(w) = writer.as_mut() {
            writeln!(w, "[")?;
        }
    } else if req.format == DataFileFormat::Sql {
        if let Some(w) = writer.as_mut() {
            writeln!(w, "-- Datavault Export: {}", req.table)?;
            writeln!(w, "-- Format: {:?} ({:?})\n", req.format, req.sql_mode)?;
        }
    }

    let mut wrote_header = false;
    let mut first_json_item = true;
    let mut pk_columns: Vec<String> = Vec::new();

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
                table: req.table.clone(),
                page,
                page_size,
                filters: Vec::new(),
                sorts: Vec::new(),
            })
            .await?;

        if !wrote_header {
            pk_columns = rs
                .columns
                .iter()
                .filter(|c| c.is_primary_key)
                .map(|c| c.name.clone())
                .collect();
        }

        // Determine active column indices + target header names from mappings
        let selected_cols: Vec<(usize, String)> = if req.column_mappings.is_empty() {
            rs.columns
                .iter()
                .enumerate()
                .map(|(i, c)| (i, c.name.clone()))
                .collect()
        } else {
            req.column_mappings
                .iter()
                .filter(|m| m.included)
                .filter_map(|m| {
                    rs.columns
                        .iter()
                        .position(|c| c.name == m.source_column)
                        .map(|idx| (idx, m.target_column.clone()))
                })
                .collect()
        };

        let headers: Vec<String> = selected_cols.iter().map(|(_, n)| n.clone()).collect();

        if !wrote_header {
            wrote_header = true;
            match req.format {
                DataFileFormat::Csv if req.include_headers => {
                    if let Some(w) = writer.as_mut() {
                        let header_vals: Vec<serde_json::Value> = headers
                            .iter()
                            .map(|h| serde_json::Value::String(h.clone()))
                            .collect();
                        writeln!(w, "{}", format_csv_row(&header_vals, delim))?;
                    }
                }
                DataFileFormat::Xlsx => {
                    if req.include_headers {
                        xlsx_headers = headers.clone();
                    }
                }
                _ => {}
            }
        }

        if rs.rows.is_empty() {
            break;
        }

        let fq = qualified_table(engine, req.schema.as_deref(), &req.table);

        for row in &rs.rows {
            if cancel.load(Ordering::SeqCst) {
                cancelled = true;
                break;
            }
            let projected: Vec<serde_json::Value> = selected_cols
                .iter()
                .map(|(idx, _)| row.get(*idx).cloned().unwrap_or(serde_json::Value::Null))
                .collect();

            match req.format {
                DataFileFormat::Csv => {
                    if let Some(w) = writer.as_mut() {
                        writeln!(w, "{}", format_csv_row(&projected, delim))?;
                    }
                }
                DataFileFormat::Json => {
                    if let Some(w) = writer.as_mut() {
                        let mut obj = serde_json::Map::new();
                        for (h, v) in headers.iter().zip(projected.into_iter()) {
                            obj.insert(h.clone(), v);
                        }
                        if !first_json_item {
                            writeln!(w, ",")?;
                        }
                        first_json_item = false;
                        write!(w, "  {}", serde_json::Value::Object(obj))?;
                    }
                }
                DataFileFormat::Jsonl => {
                    if let Some(w) = writer.as_mut() {
                        let mut obj = serde_json::Map::new();
                        for (h, v) in headers.iter().zip(projected.into_iter()) {
                            obj.insert(h.clone(), v);
                        }
                        writeln!(w, "{}", serde_json::Value::Object(obj))?;
                    }
                }
                DataFileFormat::Xlsx => {
                    xlsx_rows.push(projected);
                }
                DataFileFormat::Sql => {
                    if let Some(w) = writer.as_mut() {
                        let stmt = build_sql_export_statement(
                            engine,
                            &fq,
                            &headers,
                            &projected,
                            req.sql_mode,
                            &pk_columns,
                        );
                        writeln!(w, "{}", stmt)?;
                    }
                }
            }
            rows_processed += 1;
        }

        if cancelled || (rs.rows.len() as u64) < page_size {
            break;
        }
        page += 1;
    }

    if req.format == DataFileFormat::Json {
        if let Some(w) = writer.as_mut() {
            writeln!(w, "\n]")?;
        }
    }
    if let Some(mut w) = writer {
        w.flush()?;
    }
    if req.format == DataFileFormat::Xlsx {
        write_xlsx(&req.output_path, &req.table, &xlsx_headers, &xlsx_rows)?;
    }

    Ok(DataJobResult {
        job_id,
        ok: !cancelled,
        cancelled,
        rows_processed,
        rows_failed: 0,
        duration_ms: start.elapsed().as_millis() as u64,
        output_path: Some(req.output_path.clone()),
        summary: if cancelled {
            format!("Export cancelled after {} row(s)", rows_processed)
        } else {
            format!("Exported {} row(s) to {}", rows_processed, req.output_path)
        },
        errors: Vec::new(),
    })
}

fn build_sql_export_statement(
    engine: DbEngine,
    fq: &str,
    headers: &[String],
    values: &[serde_json::Value],
    mode: SqlExportMode,
    pk_columns: &[String],
) -> String {
    let cols = headers
        .iter()
        .map(|h| quote_ident(engine, h))
        .collect::<Vec<_>>()
        .join(", ");
    let vals = values.iter().map(sql_literal).collect::<Vec<_>>().join(", ");

    if mode == SqlExportMode::Insert || pk_columns.is_empty() {
        return format!("INSERT INTO {} ({}) VALUES ({});", fq, cols, vals);
    }

    match engine {
        DbEngine::Postgres => {
            let pk = pk_columns
                .iter()
                .map(|c| quote_ident(engine, c))
                .collect::<Vec<_>>()
                .join(", ");
            let updates = headers
                .iter()
                .filter(|h| !pk_columns.contains(h))
                .map(|h| {
                    let q = quote_ident(engine, h);
                    format!("{} = EXCLUDED.{}", q, q)
                })
                .collect::<Vec<_>>()
                .join(", ");
            if updates.is_empty() {
                format!(
                    "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT ({}) DO NOTHING;",
                    fq, cols, vals, pk
                )
            } else {
                format!(
                    "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT ({}) DO UPDATE SET {};",
                    fq, cols, vals, pk, updates
                )
            }
        }
        DbEngine::Mysql => {
            let updates = headers
                .iter()
                .filter(|h| !pk_columns.contains(h))
                .map(|h| {
                    let q = quote_ident(engine, h);
                    format!("{} = VALUES({})", q, q)
                })
                .collect::<Vec<_>>()
                .join(", ");
            if updates.is_empty() {
                format!("INSERT IGNORE INTO {} ({}) VALUES ({});", fq, cols, vals)
            } else {
                format!(
                    "INSERT INTO {} ({}) VALUES ({}) ON DUPLICATE KEY UPDATE {};",
                    fq, cols, vals, updates
                )
            }
        }
        _ => format!("INSERT INTO {} ({}) VALUES ({});", fq, cols, vals),
    }
}

/// Previews headers and sample rows from CSV, JSON, JSONL, or Excel (.xlsx) for Import Wizard mapping.
pub fn preview_import_file(req: &ImportPreviewRequest) -> Result<ImportPreviewResponse> {
    let max_samples = req.sample_rows.unwrap_or(15).clamp(1, 100);
    let delim = req
        .delimiter
        .as_deref()
        .and_then(|s| s.chars().next())
        .unwrap_or(',');

    match req.format {
        DataFileFormat::Csv => {
            let file = File::open(&req.file_path)?;
            let reader = BufReader::new(file);
            let mut lines = reader.lines();
            let first = match lines.next() {
                Some(Ok(l)) => parse_csv_line(&l, delim),
                _ => Vec::new(),
            };
            let (columns, mut sample_rows) = if req.has_headers {
                (first, Vec::new())
            } else {
                let cols = (0..first.len()).map(|i| format!("col_{}", i + 1)).collect();
                let row = first.into_iter().map(serde_json::Value::String).collect();
                (cols, vec![row])
            };
            for line in lines.take(max_samples) {
                let l = line?;
                if l.trim().is_empty() {
                    continue;
                }
                sample_rows.push(
                    parse_csv_line(&l, delim)
                        .into_iter()
                        .map(serde_json::Value::String)
                        .collect(),
                );
            }
            Ok(ImportPreviewResponse {
                columns,
                sample_rows,
                detected_format: DataFileFormat::Csv,
            })
        }
        DataFileFormat::Json => {
            let raw = std::fs::read_to_string(&req.file_path)?;
            let val: serde_json::Value = serde_json::from_str(&raw)?;
            let arr = val.as_array().ok_or_else(|| {
                DatavaultError::Storage("JSON import file must contain a top-level array of objects".into())
            })?;
            let mut col_set = Vec::new();
            for item in arr.iter().take(max_samples) {
                if let Some(obj) = item.as_object() {
                    for k in obj.keys() {
                        if !col_set.contains(k) {
                            col_set.push(k.clone());
                        }
                    }
                }
            }
            let sample_rows = arr
                .iter()
                .take(max_samples)
                .map(|item| {
                    col_set
                        .iter()
                        .map(|c| item.get(c).cloned().unwrap_or(serde_json::Value::Null))
                        .collect()
                })
                .collect();
            Ok(ImportPreviewResponse {
                columns: col_set,
                sample_rows,
                detected_format: DataFileFormat::Json,
            })
        }
        DataFileFormat::Jsonl => {
            let file = File::open(&req.file_path)?;
            let reader = BufReader::new(file);
            let mut objs = Vec::new();
            let mut col_set = Vec::new();
            for line in reader.lines() {
                let l = line?;
                if l.trim().is_empty() {
                    continue;
                }
                let val: serde_json::Value = serde_json::from_str(&l)?;
                if let Some(obj) = val.as_object() {
                    for k in obj.keys() {
                        if !col_set.contains(k) {
                            col_set.push(k.clone());
                        }
                    }
                }
                objs.push(val);
                if objs.len() >= max_samples {
                    break;
                }
            }
            let sample_rows = objs
                .iter()
                .map(|item| {
                    col_set
                        .iter()
                        .map(|c| item.get(c).cloned().unwrap_or(serde_json::Value::Null))
                        .collect()
                })
                .collect();
            Ok(ImportPreviewResponse {
                columns: col_set,
                sample_rows,
                detected_format: DataFileFormat::Jsonl,
            })
        }
        DataFileFormat::Xlsx => {
            let all_rows = read_xlsx(&req.file_path, Some(max_samples + 1))?;
            if all_rows.is_empty() {
                return Ok(ImportPreviewResponse {
                    columns: Vec::new(),
                    sample_rows: Vec::new(),
                    detected_format: DataFileFormat::Xlsx,
                });
            }
            let (columns, sample_rows) = if req.has_headers {
                let cols = all_rows[0]
                    .iter()
                    .enumerate()
                    .map(|(i, v)| {
                        let s = value_to_plain_string(v);
                        if s.is_empty() {
                            format!("col_{}", i + 1)
                        } else {
                            s
                        }
                    })
                    .collect();
                (cols, all_rows[1..].to_vec())
            } else {
                let cols = (0..all_rows[0].len())
                    .map(|i| format!("col_{}", i + 1))
                    .collect();
                (cols, all_rows)
            };
            Ok(ImportPreviewResponse {
                columns,
                sample_rows,
                detected_format: DataFileFormat::Xlsx,
            })
        }
        DataFileFormat::Sql => Err(DatavaultError::Storage(
            "Use 'Execute SQL File' for .sql scripts".into(),
        )),
    }
}

/// Streams rows from CSV, JSON, JSONL, or Excel (.xlsx) into a SQL table or MongoDB collection.
pub async fn run_import(
    driver: Arc<dyn SqlDriver>,
    mongo: Option<Arc<MongoDriver>>,
    engine: DbEngine,
    req: &ImportRequest,
    job_id: String,
    cancel: Arc<AtomicBool>,
) -> Result<DataJobResult> {
    let start = Instant::now();
    let delim = req
        .delimiter
        .as_deref()
        .and_then(|s| s.chars().next())
        .unwrap_or(',');
    let batch_size = req.batch_size.unwrap_or(200).clamp(1, 2000);

    if req.truncate_before {
        driver
            .truncate_table(req.database.as_deref(), req.schema.as_deref(), &req.table)
            .await?;
    }

    // Load records as (source_col -> Value) rows
    let records = load_import_records(req, delim)?;

    let mut rows_processed = 0u64;
    let mut rows_failed = 0u64;
    let mut errors = Vec::new();
    let mut cancelled = false;

    for chunk in records.chunks(batch_size) {
        if cancel.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }

        if engine == DbEngine::Mongodb {
            if let Some(ref mg) = mongo {
                let db = req.database.as_deref().unwrap_or("admin").to_string();
                let changes: Vec<MongoDocChange> = chunk
                    .iter()
                    .map(|rec| {
                        let mapped = apply_column_mappings(rec, &req.column_mappings);
                        MongoDocChange::Insert {
                            document: serde_json::Value::Object(mapped.into_iter().collect()),
                        }
                    })
                    .collect();
                match mg
                    .apply_document_changes(&MongoApplyChangesRequest {
                        connection_id: req.connection_id.clone(),
                        database: db,
                        collection: req.table.clone(),
                        changes,
                        confirmed_production: req.confirmed_production,
                    })
                    .await
                {
                    Ok(n) => rows_processed += n,
                    Err(err) => {
                        rows_failed += chunk.len() as u64;
                        errors.push(err.to_string());
                        if req.error_policy == ImportErrorPolicy::StopOnError {
                            break;
                        }
                    }
                }
            }
            continue;
        }

        // SQL batch insert via multi-row INSERT statement
        let mapped_rows: Vec<HashMap<String, serde_json::Value>> = chunk
            .iter()
            .map(|r| apply_column_mappings(r, &req.column_mappings))
            .filter(|m| !m.is_empty())
            .collect();

        if mapped_rows.is_empty() {
            continue;
        }

        let mut cols: Vec<String> = mapped_rows[0].keys().cloned().collect();
        cols.sort();
        let fq = qualified_table(engine, req.schema.as_deref(), &req.table);
        let col_list = cols
            .iter()
            .map(|c| quote_ident(engine, c))
            .collect::<Vec<_>>()
            .join(", ");

        let values_sql: Vec<String> = mapped_rows
            .iter()
            .map(|m| {
                let vals = cols
                    .iter()
                    .map(|c| sql_literal(m.get(c).unwrap_or(&serde_json::Value::Null)))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("({})", vals)
            })
            .collect();

        let batch_sql = format!("INSERT INTO {} ({}) VALUES {};", fq, col_list, values_sql.join(", "));
        match driver
            .execute_query(req.database.as_deref(), &batch_sql, &job_id)
            .await
        {
            Ok(_) => rows_processed += mapped_rows.len() as u64,
            Err(batch_err) => {
                if req.error_policy == ImportErrorPolicy::StopOnError {
                    rows_failed += mapped_rows.len() as u64;
                    errors.push(batch_err.to_string());
                    break;
                }
                // Fallback row-by-row when SkipAndLog is enabled
                for m in &mapped_rows {
                    let vals = cols
                        .iter()
                        .map(|c| sql_literal(m.get(c).unwrap_or(&serde_json::Value::Null)))
                        .collect::<Vec<_>>()
                        .join(", ");
                    let single_sql = format!("INSERT INTO {} ({}) VALUES ({});", fq, col_list, vals);
                    match driver
                        .execute_query(req.database.as_deref(), &single_sql, &job_id)
                        .await
                    {
                        Ok(_) => rows_processed += 1,
                        Err(e) => {
                            rows_failed += 1;
                            if errors.len() < 50 {
                                errors.push(e.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(DataJobResult {
        job_id,
        ok: !cancelled && (rows_failed == 0 || req.error_policy == ImportErrorPolicy::SkipAndLog),
        cancelled,
        rows_processed,
        rows_failed,
        duration_ms: start.elapsed().as_millis() as u64,
        output_path: None,
        summary: if cancelled {
            format!("Import cancelled ({} imported, {} failed)", rows_processed, rows_failed)
        } else {
            format!(
                "Imported {} row(s) into {}{}",
                rows_processed,
                req.table,
                if rows_failed > 0 {
                    format!(" ({} failed)", rows_failed)
                } else {
                    String::new()
                }
            )
        },
        errors,
    })
}

fn load_import_records(
    req: &ImportRequest,
    delim: char,
) -> Result<Vec<HashMap<String, serde_json::Value>>> {
    let mut records = Vec::new();
    match req.format {
        DataFileFormat::Csv => {
            let file = File::open(&req.file_path)?;
            let reader = BufReader::new(file);
            let mut lines = reader.lines();
            let first = match lines.next() {
                Some(Ok(l)) => parse_csv_line(&l, delim),
                _ => return Ok(records),
            };
            let headers = if req.has_headers {
                first
            } else {
                let hdrs: Vec<String> = (0..first.len()).map(|i| format!("col_{}", i + 1)).collect();
                let mut map = HashMap::new();
                for (h, v) in hdrs.iter().zip(first.into_iter()) {
                    map.insert(h.clone(), serde_json::Value::String(v));
                }
                records.push(map);
                hdrs
            };
            for line in lines {
                let l = line?;
                if l.trim().is_empty() {
                    continue;
                }
                let fields = parse_csv_line(&l, delim);
                let mut map = HashMap::new();
                for (i, h) in headers.iter().enumerate() {
                    let raw = fields.get(i).map(String::as_str).unwrap_or("");
                    map.insert(h.clone(), serde_json::Value::String(raw.to_string()));
                }
                records.push(map);
            }
        }
        DataFileFormat::Json => {
            let raw = std::fs::read_to_string(&req.file_path)?;
            let val: serde_json::Value = serde_json::from_str(&raw)?;
            let arr = val.as_array().ok_or_else(|| {
                DatavaultError::Storage("JSON import file must contain an array of objects".into())
            })?;
            for item in arr {
                if let Some(obj) = item.as_object() {
                    records.push(obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect());
                }
            }
        }
        DataFileFormat::Jsonl => {
            let file = File::open(&req.file_path)?;
            let reader = BufReader::new(file);
            for line in reader.lines() {
                let l = line?;
                if l.trim().is_empty() {
                    continue;
                }
                let val: serde_json::Value = serde_json::from_str(&l)?;
                if let Some(obj) = val.as_object() {
                    records.push(obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect());
                }
            }
        }
        DataFileFormat::Xlsx => {
            let rows = read_xlsx(&req.file_path, None)?;
            if rows.is_empty() {
                return Ok(records);
            }
            let (headers, start_idx) = if req.has_headers {
                let hdrs = rows[0]
                    .iter()
                    .enumerate()
                    .map(|(i, v)| {
                        let s = value_to_plain_string(v);
                        if s.is_empty() {
                            format!("col_{}", i + 1)
                        } else {
                            s
                        }
                    })
                    .collect::<Vec<_>>();
                (hdrs, 1)
            } else {
                let hdrs = (0..rows[0].len())
                    .map(|i| format!("col_{}", i + 1))
                    .collect::<Vec<_>>();
                (hdrs, 0)
            };
            for r in &rows[start_idx..] {
                let mut map = HashMap::new();
                for (i, h) in headers.iter().enumerate() {
                    map.insert(
                        h.clone(),
                        r.get(i).cloned().unwrap_or(serde_json::Value::Null),
                    );
                }
                records.push(map);
            }
        }
        DataFileFormat::Sql => {
            return Err(DatavaultError::Storage(
                "Use 'Execute SQL File' for .sql scripts".into(),
            ));
        }
    }
    Ok(records)
}

fn apply_column_mappings(
    record: &HashMap<String, serde_json::Value>,
    mappings: &[ColumnMapping],
) -> HashMap<String, serde_json::Value> {
    if mappings.is_empty() {
        return record.clone();
    }
    let mut out = HashMap::new();
    for m in mappings {
        if !m.included || m.target_column.trim().is_empty() {
            continue;
        }
        let val = record
            .get(&m.source_column)
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let converted = match val {
            serde_json::Value::String(ref s) => parse_cell_value(s, m.target_type.as_deref()),
            other => other,
        };
        out.insert(m.target_column.clone(), converted);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_roundtrip_quotes_and_commas() {
        let row = vec![
            serde_json::json!(42),
            serde_json::json!("Hello, \"World\""),
            serde_json::json!(null),
        ];
        let line = format_csv_row(&row, ',');
        assert_eq!(line, "42,\"Hello, \"\"World\"\"\",");
        let parsed = parse_csv_line(&line, ',');
        assert_eq!(parsed, vec!["42", "Hello, \"World\"", ""]);
    }
}
