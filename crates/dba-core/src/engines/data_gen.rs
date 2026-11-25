use crate::drivers::mongodb::MongoDriver;
use crate::drivers::{qualified_table, quote_ident, sql_literal, SqlDriver};
use crate::error::Result;
use crate::models::*;
use chrono::{Duration, NaiveDate, NaiveDateTime, Utc};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use uuid::Uuid;

const FIRST_NAMES: &[&str] = &[
    "Aria", "Budi", "Citra", "Dian", "Elena", "Farhan", "Grace", "Hendra", "Intan", "Joko",
    "Klara", "Liam", "Maya", "Nadia", "Omar", "Putri", "Quinn", "Rafi", "Sari", "Tariq",
    "Uma", "Vina", "Wawan", "Xena", "Yusuf", "Zara", "Alex", "Noah", "Chloe", "Lucas",
];

const LAST_NAMES: &[&str] = &[
    "Santoso", "Wijaya", "Pratama", "Kusuma", "Hidayat", "Saputra", "Setiawan", "Rahman",
    "Anderson", "Chen", "Garcia", "Kim", "Miller", "Nakamura", "Patel", "Silva", "Smith",
    "Tanaka", "Turner", "Walker", "Young", "Zhang", "Lestari", "Permata", "Nugroho",
];

const CITIES: &[&str] = &[
    "Jakarta", "Bandung", "Surabaya", "Yogyakarta", "Bali", "Singapore", "Tokyo", "Seoul",
    "London", "Berlin", "New York", "San Francisco", "Seattle", "Toronto", "Sydney", "Amsterdam",
];

const COUNTRIES: &[&str] = &[
    "Indonesia", "Singapore", "Japan", "South Korea", "United States", "United Kingdom",
    "Germany", "Canada", "Australia", "Netherlands", "France", "Malaysia",
];

const COMPANIES: &[&str] = &[
    "DBa Labs", "Nusantara Tech", "Aurora Systems", "Quantum Grid", "PixelForge",
    "Cobalt Cloud", "Meridian Data", "Vanguard Analytics", "Helios Digital", "Orbit Works",
];

const STREETS: &[&str] = &[
    "Sudirman", "Thamrin", "Merdeka", "Diponegoro", "Gatot Subroto", "Maple Ave", "Oak St",
    "Market St", "Pine Rd", "Cedar Blvd", "Sunset Way", "Harbor View",
];

const LOREM_WORDS: &[&str] = &[
    "lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing", "elit", "sed",
    "eiusmod", "tempor", "incididunt", "labore", "dolore", "magna", "aliqua", "ut", "enim",
    "minim", "veniam", "quis", "nostrud", "exercitation", "ullamco", "laboris", "nisi",
];

const DOMAINS: &[&str] = &["example.com", "mail.test", "dba.dev", "acme.io", "corp.org"];

/// Fast deterministic PRNG (SplitMix64) with zero external crate dependencies.
pub struct FastRng {
    state: u64,
}

impl FastRng {
    pub fn new(seed: u64) -> Self {
        Self {
            state: if seed == 0 { 0x9E37_79B9_7F4A_7C15 } else { seed },
        }
    }

    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    pub fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / ((1u64 << 53) as f64)
    }

    pub fn gen_range_i64(&mut self, min: i64, max: i64) -> i64 {
        if max <= min {
            return min;
        }
        let span = (max as i128 - min as i128 + 1) as u128;
        let offset = (self.next_u64() as u128) % span;
        (min as i128 + offset as i128) as i64
    }

    pub fn pick<'a, T>(&mut self, slice: &'a [T]) -> &'a T {
        let idx = (self.next_u64() as usize) % slice.len();
        &slice[idx]
    }
}

/// Automatically infers the best generator rule for each column in a TableMetadata,
/// including Foreign Key-aware sampling.
pub fn infer_column_rules(meta: &TableMetadata) -> Vec<DataGenColumnRule> {
    let mut fk_map: HashMap<String, (&ForeignKeyMeta, usize)> = HashMap::new();
    for fk in &meta.foreign_keys {
        for (idx, col) in fk.columns.iter().enumerate() {
            fk_map.insert(col.to_lowercase(), (fk, idx));
        }
    }

    meta.columns
        .iter()
        .map(|c| {
            let name_lc = c.name.to_lowercase();
            let dt_lc = c.data_type.to_lowercase();
            let null_pct = if c.nullable { 5 } else { 0 };

            // 1. Auto-increment / serial / identity -> skip so DB generates it
            if c.is_auto_increment
                || dt_lc.contains("serial")
                || dt_lc.contains("identity")
            {
                return DataGenColumnRule {
                    column: c.name.clone(),
                    data_type: c.data_type.clone(),
                    generator: DataGenGeneratorKind::AutoIncrementSkip,
                    null_percent: 0,
                    min_num: None,
                    max_num: None,
                    start_date: None,
                    end_date: None,
                    enum_values: Vec::new(),
                    pattern: None,
                    fk_schema: None,
                    fk_table: None,
                    fk_column: None,
                };
            }

            // 2. Foreign Key-aware sampling
            if let Some((fk, idx)) = fk_map.get(&name_lc) {
                let ref_col = fk
                    .ref_columns
                    .get(*idx)
                    .or_else(|| fk.ref_columns.first())
                    .cloned()
                    .unwrap_or_else(|| "id".into());
                return DataGenColumnRule {
                    column: c.name.clone(),
                    data_type: c.data_type.clone(),
                    generator: DataGenGeneratorKind::ForeignKeySample,
                    null_percent: null_pct,
                    min_num: None,
                    max_num: None,
                    start_date: None,
                    end_date: None,
                    enum_values: Vec::new(),
                    pattern: None,
                    fk_schema: fk.ref_schema.clone(),
                    fk_table: Some(fk.ref_table.clone()),
                    fk_column: Some(ref_col),
                };
            }

            // 3. Name & Type heuristics
            let (generator, min_num, max_num, enum_values, pattern) = if dt_lc.contains("uuid")
                || name_lc == "uuid"
                || name_lc.ends_with("_uuid")
                || name_lc == "guid"
            {
                (DataGenGeneratorKind::Uuid, None, None, vec![], None)
            } else if name_lc.contains("email") {
                (DataGenGeneratorKind::Email, None, None, vec![], None)
            } else if name_lc.contains("phone") || name_lc.contains("mobile") || name_lc.contains("tel") {
                (DataGenGeneratorKind::Phone, None, None, vec![], None)
            } else if name_lc == "first_name" || name_lc == "firstname" {
                (DataGenGeneratorKind::FirstName, None, None, vec![], None)
            } else if name_lc == "last_name" || name_lc == "lastname" {
                (DataGenGeneratorKind::LastName, None, None, vec![], None)
            } else if name_lc.contains("full_name") || name_lc == "name" || name_lc == "author" {
                (DataGenGeneratorKind::FullName, None, None, vec![], None)
            } else if name_lc.contains("username") || name_lc == "handle" || name_lc == "login" {
                (DataGenGeneratorKind::Username, None, None, vec![], None)
            } else if name_lc.contains("address") || name_lc.contains("street") {
                (DataGenGeneratorKind::Address, None, None, vec![], None)
            } else if name_lc.contains("city") {
                (DataGenGeneratorKind::City, None, None, vec![], None)
            } else if name_lc.contains("country") {
                (DataGenGeneratorKind::Country, None, None, vec![], None)
            } else if name_lc.contains("company") || name_lc.contains("org") {
                (DataGenGeneratorKind::Company, None, None, vec![], None)
            } else if name_lc.contains("url") || name_lc.contains("website") || name_lc.contains("avatar") {
                (DataGenGeneratorKind::Url, None, None, vec![], None)
            } else if name_lc == "status" || name_lc.ends_with("_status") {
                (
                    DataGenGeneratorKind::EnumList,
                    None,
                    None,
                    vec!["active".into(), "pending".into(), "inactive".into()],
                    None,
                )
            } else if name_lc == "role" {
                (
                    DataGenGeneratorKind::EnumList,
                    None,
                    None,
                    vec!["user".into(), "admin".into(), "editor".into()],
                    None,
                )
            } else if dt_lc.contains("bool") || dt_lc == "bit" || name_lc.starts_with("is_") || name_lc.starts_with("has_") {
                (DataGenGeneratorKind::Boolean, None, None, vec![], None)
            } else if dt_lc.contains("timestamp") || dt_lc.contains("datetime") || name_lc.ends_with("_at") {
                (DataGenGeneratorKind::TimestampRange, None, None, vec![], None)
            } else if dt_lc == "date" || name_lc.ends_with("_date") || name_lc.contains("birth") {
                (DataGenGeneratorKind::DateRange, None, None, vec![], None)
            } else if dt_lc.contains("decimal")
                || dt_lc.contains("numeric")
                || dt_lc.contains("float")
                || dt_lc.contains("double")
                || dt_lc.contains("real")
                || dt_lc.contains("money")
                || name_lc.contains("price")
                || name_lc.contains("amount")
            {
                (DataGenGeneratorKind::DecimalRange, Some(1.0), Some(9999.99), vec![], None)
            } else if dt_lc.contains("int") || dt_lc.contains("short") || dt_lc.contains("long") {
                let (lo, hi) = if name_lc.contains("age") {
                    (18.0, 80.0)
                } else if name_lc.contains("qty") || name_lc.contains("quantity") || name_lc.contains("count") {
                    (1.0, 100.0)
                } else {
                    (1.0, 100_000.0)
                };
                (DataGenGeneratorKind::IntegerRange, Some(lo), Some(hi), vec![], None)
            } else if name_lc.contains("code") || name_lc.contains("sku") {
                (DataGenGeneratorKind::RegexPattern, None, None, vec![], Some("[A-Z]{3}-\\d{4}".into()))
            } else {
                (DataGenGeneratorKind::TextLorem, None, None, vec![], None)
            };

            DataGenColumnRule {
                column: c.name.clone(),
                data_type: c.data_type.clone(),
                generator,
                null_percent: if c.is_primary_key { 0 } else { null_pct },
                min_num,
                max_num,
                start_date: Some("2022-01-01".into()),
                end_date: Some("2026-12-31".into()),
                enum_values,
                pattern,
                fk_schema: None,
                fk_table: None,
                fk_column: None,
            }
        })
        .collect()
}

/// Expands a lightweight regex-like pattern such as `[A-Z]{3}-\d{4}` or `USR-[a-z]{2}[0-9]{3}`.
pub fn generate_from_pattern(rng: &mut FastRng, pattern: &str) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::new();
    let mut i = 0;

    while i < chars.len() {
        let token = if chars[i] == '\\' && i + 1 < chars.len() {
            let next = chars[i + 1];
            i += 2;
            match next {
                'd' => PatternToken::Digits,
                'w' => PatternToken::Word,
                other => PatternToken::Literal(other),
            }
        } else if chars[i] == '[' {
            if let Some(end_rel) = chars[i + 1..].iter().position(|&c| c == ']') {
                let inner: String = chars[i + 1..i + 1 + end_rel].iter().collect();
                i += end_rel + 2;
                PatternToken::CharClass(expand_char_class(&inner))
            } else {
                let c = chars[i];
                i += 1;
                PatternToken::Literal(c)
            }
        } else {
            let c = chars[i];
            i += 1;
            PatternToken::Literal(c)
        };

        // Optional {n} quantifier
        let mut repeat = 1usize;
        if i < chars.len() && chars[i] == '{' {
            if let Some(end_rel) = chars[i + 1..].iter().position(|&c| c == '}') {
                let num_str: String = chars[i + 1..i + 1 + end_rel].iter().collect();
                if let Ok(n) = num_str.trim().parse::<usize>() {
                    repeat = n.min(64);
                    i += end_rel + 2;
                }
            }
        }

        for _ in 0..repeat {
            match &token {
                PatternToken::Literal(c) => out.push(*c),
                PatternToken::Digits => {
                    out.push((b'0' + (rng.next_u64() % 10) as u8) as char);
                }
                PatternToken::Word => {
                    const ALNUM: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
                    out.push(ALNUM[(rng.next_u64() as usize) % ALNUM.len()] as char);
                }
                PatternToken::CharClass(pool) if !pool.is_empty() => {
                    out.push(pool[(rng.next_u64() as usize) % pool.len()]);
                }
                PatternToken::CharClass(_) => {}
            }
        }
    }
    out
}

enum PatternToken {
    Literal(char),
    Digits,
    Word,
    CharClass(Vec<char>),
}

fn expand_char_class(inner: &str) -> Vec<char> {
    let cs: Vec<char> = inner.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < cs.len() {
        if i + 2 < cs.len() && cs[i + 1] == '-' {
            let start = cs[i] as u32;
            let end = cs[i + 2] as u32;
            if start <= end && end - start <= 128 {
                for code in start..=end {
                    if let Some(ch) = char::from_u32(code) {
                        out.push(ch);
                    }
                }
            }
            i += 3;
        } else {
            out.push(cs[i]);
            i += 1;
        }
    }
    out
}

pub fn generate_value(
    rng: &mut FastRng,
    rule: &DataGenColumnRule,
    fk_pool: Option<&[Value]>,
    row_idx: u64,
) -> Value {
    if rule.null_percent > 0 && rule.generator != DataGenGeneratorKind::Null {
        let roll = (rng.next_u64() % 100) as u8;
        if roll < rule.null_percent {
            return Value::Null;
        }
    }

    match rule.generator {
        DataGenGeneratorKind::AutoIncrementSkip | DataGenGeneratorKind::Null => Value::Null,
        DataGenGeneratorKind::Uuid => {
            // Deterministic-friendly UUID v4 bytes derived from rng
            let a = rng.next_u64();
            let b = rng.next_u64();
            let mut bytes = [0u8; 16];
            bytes[..8].copy_from_slice(&a.to_le_bytes());
            bytes[8..].copy_from_slice(&b.to_le_bytes());
            bytes[6] = (bytes[6] & 0x0f) | 0x40;
            bytes[8] = (bytes[8] & 0x3f) | 0x80;
            json!(Uuid::from_bytes(bytes).to_string())
        }
        DataGenGeneratorKind::FirstName => json!(*rng.pick(FIRST_NAMES)),
        DataGenGeneratorKind::LastName => json!(*rng.pick(LAST_NAMES)),
        DataGenGeneratorKind::FullName => {
            json!(format!("{} {}", rng.pick(FIRST_NAMES), rng.pick(LAST_NAMES)))
        }
        DataGenGeneratorKind::Email => {
            let f = rng.pick(FIRST_NAMES).to_lowercase();
            let l = rng.pick(LAST_NAMES).to_lowercase();
            let dom = rng.pick(DOMAINS);
            json!(format!("{}.{}.{}@{}", f, l, row_idx + 1, dom))
        }
        DataGenGeneratorKind::Phone => {
            let p1 = rng.gen_range_i64(100, 999);
            let p2 = rng.gen_range_i64(1000, 9999);
            json!(format!("+62-812-{}-{}", p1, p2))
        }
        DataGenGeneratorKind::Address => {
            let num = rng.gen_range_i64(1, 999);
            json!(format!("Jl. {} No. {}", rng.pick(STREETS), num))
        }
        DataGenGeneratorKind::City => json!(*rng.pick(CITIES)),
        DataGenGeneratorKind::Country => json!(*rng.pick(COUNTRIES)),
        DataGenGeneratorKind::Company => json!(*rng.pick(COMPANIES)),
        DataGenGeneratorKind::Username => {
            let f = rng.pick(FIRST_NAMES).to_lowercase();
            let n = rng.gen_range_i64(10, 9999);
            json!(format!("{}_{}", f, n))
        }
        DataGenGeneratorKind::Url => {
            let dom = rng.pick(DOMAINS);
            let slug = rng.pick(LOREM_WORDS);
            json!(format!("https://{}/{}/{}", dom, slug, row_idx + 1))
        }
        DataGenGeneratorKind::Boolean => json!(rng.next_u64() % 2 == 0),
        DataGenGeneratorKind::IntegerRange => {
            let lo = rule.min_num.unwrap_or(1.0) as i64;
            let hi = rule.max_num.unwrap_or(10_000.0) as i64;
            json!(rng.gen_range_i64(lo, hi))
        }
        DataGenGeneratorKind::DecimalRange => {
            let lo = rule.min_num.unwrap_or(1.0);
            let hi = rule.max_num.unwrap_or(1000.0);
            let raw = lo + rng.next_f64() * (hi - lo).max(0.0);
            let rounded = (raw * 100.0).round() / 100.0;
            json!(rounded)
        }
        DataGenGeneratorKind::DateRange => {
            let start = rule
                .start_date
                .as_deref()
                .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
                .unwrap_or_else(|| NaiveDate::from_ymd_opt(2022, 1, 1).unwrap());
            let end = rule
                .end_date
                .as_deref()
                .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
                .unwrap_or_else(|| Utc::now().date_naive());
            let span = (end - start).num_days().max(1);
            let offset = rng.gen_range_i64(0, span);
            let d = start + Duration::days(offset);
            json!(d.format("%Y-%m-%d").to_string())
        }
        DataGenGeneratorKind::TimestampRange => {
            let start = rule
                .start_date
                .as_deref()
                .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
                .unwrap_or_else(|| NaiveDate::from_ymd_opt(2022, 1, 1).unwrap())
                .and_hms_opt(0, 0, 0)
                .unwrap();
            let end: NaiveDateTime = rule
                .end_date
                .as_deref()
                .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
                .unwrap_or_else(|| Utc::now().date_naive())
                .and_hms_opt(23, 59, 59)
                .unwrap();
            let span = (end - start).num_seconds().max(1);
            let offset = rng.gen_range_i64(0, span);
            let dt = start + Duration::seconds(offset);
            json!(dt.format("%Y-%m-%d %H:%M:%S").to_string())
        }
        DataGenGeneratorKind::EnumList => {
            if rule.enum_values.is_empty() {
                json!("default")
            } else {
                json!(rng.pick(&rule.enum_values))
            }
        }
        DataGenGeneratorKind::TextLorem => {
            let count = rng.gen_range_i64(3, 8) as usize;
            let mut words = Vec::with_capacity(count);
            for _ in 0..count {
                words.push(*rng.pick(LOREM_WORDS));
            }
            json!(words.join(" "))
        }
        DataGenGeneratorKind::RegexPattern => {
            let pat = rule.pattern.as_deref().unwrap_or("[A-Z]{3}-\\d{4}");
            json!(generate_from_pattern(rng, pat))
        }
        DataGenGeneratorKind::ForeignKeySample => {
            if let Some(pool) = fk_pool {
                if !pool.is_empty() {
                    return rng.pick(pool).clone();
                }
            }
            json!(rng.gen_range_i64(1, 100))
        }
    }
}

/// Generates a local preview of N rows without inserting into the database.
pub fn preview_data_gen(
    rules: &[DataGenColumnRule],
    fk_pools: &HashMap<String, Vec<Value>>,
    seed: Option<u64>,
    sample_rows: usize,
) -> DataGenPreviewResult {
    let active: Vec<&DataGenColumnRule> = rules
        .iter()
        .filter(|r| r.generator != DataGenGeneratorKind::AutoIncrementSkip)
        .collect();
    let columns: Vec<String> = active.iter().map(|r| r.column.clone()).collect();
    let mut rng = FastRng::new(seed.unwrap_or(42));
    let mut rows = Vec::with_capacity(sample_rows);

    for i in 0..sample_rows {
        let mut row = Vec::with_capacity(active.len());
        for rule in &active {
            let pool = fk_pools.get(&rule.column).map(Vec::as_slice);
            row.push(generate_value(&mut rng, rule, pool, i as u64));
        }
        rows.push(row);
    }

    DataGenPreviewResult { columns, rows }
}

/// Loads up to 5,000 existing key values from parent tables for any ForeignKeySample rules.
pub async fn load_fk_pools(
    driver: Arc<dyn SqlDriver>,
    engine: DbEngine,
    database: Option<&str>,
    default_schema: Option<&str>,
    rules: &[DataGenColumnRule],
) -> HashMap<String, Vec<Value>> {
    let mut pools = HashMap::new();
    if engine == DbEngine::Mongodb {
        return pools;
    }
    for rule in rules {
        if rule.generator != DataGenGeneratorKind::ForeignKeySample {
            continue;
        }
        let (Some(ref fk_table), Some(ref fk_col)) = (&rule.fk_table, &rule.fk_column) else {
            continue;
        };
        let fq = qualified_table(engine, rule.fk_schema.as_deref().or(default_schema), fk_table);
        let col_q = quote_ident(engine, fk_col);
        let sql = match engine {
            DbEngine::Mssql => format!("SELECT TOP 5000 {} FROM {} WHERE {} IS NOT NULL", col_q, fq, col_q),
            _ => format!("SELECT {} FROM {} WHERE {} IS NOT NULL LIMIT 5000", col_q, fq, col_q),
        };
        if let Ok(resp) = driver.execute_query(database, &sql, "datagen-fk").await {
            if let Some(rs) = resp.result_sets.into_iter().next() {
                let vals: Vec<Value> = rs
                    .rows
                    .into_iter()
                    .filter_map(|r| r.into_iter().next())
                    .filter(|v| !v.is_null())
                    .collect();
                if !vals.is_empty() {
                    pools.insert(rule.column.clone(), vals);
                }
            }
        }
    }
    pools
}

/// Runs high-speed batched dummy data generation against SQL (PostgreSQL/MySQL/MSSQL) or MongoDB.
#[allow(clippy::too_many_arguments)]
pub async fn run_data_gen(
    driver: Arc<dyn SqlDriver>,
    mongo: Option<Arc<MongoDriver>>,
    engine: DbEngine,
    req: &DataGenRequest,
    job_id: String,
    cancel: Arc<AtomicBool>,
) -> Result<DataGenResult> {
    let start = Instant::now();
    let active_rules: Vec<&DataGenColumnRule> = req
        .rules
        .iter()
        .filter(|r| r.generator != DataGenGeneratorKind::AutoIncrementSkip)
        .collect();

    if active_rules.is_empty() {
        return Ok(DataGenResult {
            job_id,
            ok: false,
            cancelled: false,
            rows_inserted: 0,
            duration_ms: 0,
            summary: "No active columns selected for data generation.".into(),
            error: Some("At least one non-skipped column is required.".into()),
        });
    }

    let fk_pools = load_fk_pools(
        driver.clone(),
        engine,
        req.database.as_deref(),
        req.schema.as_deref(),
        &req.rules,
    )
    .await;

    if req.truncate_before {
        if engine != DbEngine::Mongodb {
            driver
                .truncate_table(req.database.as_deref(), req.schema.as_deref(), &req.table)
                .await?;
        }
    }

    let batch_size = req.batch_size.unwrap_or(500).clamp(1, 2000);
    let seed = req.seed.unwrap_or_else(|| Utc::now().timestamp_micros() as u64);
    let mut rng = FastRng::new(seed);
    let mut inserted = 0u64;
    let mut cancelled = false;

    if engine == DbEngine::Mongodb {
        let Some(mg) = mongo else {
            return Ok(DataGenResult {
                job_id,
                ok: false,
                cancelled: false,
                rows_inserted: 0,
                duration_ms: start.elapsed().as_millis() as u64,
                summary: "MongoDB driver unavailable".into(),
                error: Some("MongoDB driver unavailable".into()),
            });
        };
        let db = req.database.clone().unwrap_or_else(|| "test".into());
        while inserted < req.row_count {
            if cancel.load(Ordering::SeqCst) {
                cancelled = true;
                break;
            }
            let chunk_n = ((req.row_count - inserted) as usize).min(batch_size);
            let mut changes = Vec::with_capacity(chunk_n);
            for offset in 0..chunk_n {
                let mut doc = serde_json::Map::new();
                for rule in &active_rules {
                    let val = generate_value(&mut rng, rule, None, inserted + offset as u64);
                    doc.insert(rule.column.clone(), val);
                }
                changes.push(MongoDocChange::Insert {
                    document: Value::Object(doc),
                });
            }
            let n = mg
                .apply_document_changes(&MongoApplyChangesRequest {
                    connection_id: req.connection_id.clone(),
                    database: db.clone(),
                    collection: req.table.clone(),
                    changes,
                    confirmed_production: req.confirmed_production,
                })
                .await?;
            inserted += n;
        }
    } else {
        let fq = qualified_table(engine, req.schema.as_deref(), &req.table);
        let col_list = active_rules
            .iter()
            .map(|r| quote_ident(engine, &r.column))
            .collect::<Vec<_>>()
            .join(", ");

        // MSSQL supports at most 1000 row constructors per INSERT statement
        let eff_batch = if engine == DbEngine::Mssql {
            batch_size.min(900)
        } else {
            batch_size
        };

        while inserted < req.row_count {
            if cancel.load(Ordering::SeqCst) {
                cancelled = true;
                break;
            }
            let chunk_n = ((req.row_count - inserted) as usize).min(eff_batch);
            let mut tuples = Vec::with_capacity(chunk_n);
            for offset in 0..chunk_n {
                let mut vals = Vec::with_capacity(active_rules.len());
                for rule in &active_rules {
                    let pool = fk_pools.get(&rule.column).map(Vec::as_slice);
                    let v = generate_value(&mut rng, rule, pool, inserted + offset as u64);
                    vals.push(sql_literal(&v));
                }
                tuples.push(format!("({})", vals.join(", ")));
            }

            let sql = format!("INSERT INTO {} ({}) VALUES {};", fq, col_list, tuples.join(", "));
            if let Err(err) = driver
                .execute_query(req.database.as_deref(), &sql, &job_id)
                .await
            {
                let ms = start.elapsed().as_millis() as u64;
                return Ok(DataGenResult {
                    job_id,
                    ok: false,
                    cancelled: false,
                    rows_inserted: inserted,
                    duration_ms: ms,
                    summary: format!("Failed after inserting {} row(s): {}", inserted, err),
                    error: Some(err.to_string()),
                });
            }
            inserted += chunk_n as u64;
        }
    }

    let ms = start.elapsed().as_millis() as u64;
    let rate = if ms > 0 {
        (inserted * 1000) / ms.max(1)
    } else {
        inserted
    };
    Ok(DataGenResult {
        job_id,
        ok: !cancelled,
        cancelled,
        rows_inserted: inserted,
        duration_ms: ms,
        summary: if cancelled {
            format!("Cancelled after inserting {} row(s) in {} ms", inserted, ms)
        } else {
            format!(
                "Generated and inserted {} row(s) into {} in {} ms (~{} rows/sec)",
                inserted, req.table, ms, rate
            )
        },
        error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn infers_generators_including_fk_and_auto_increment() {
        let meta = TableMetadata {
            schema: Some("public".into()),
            name: "orders".into(),
            columns: vec![
                ColumnMeta {
                    name: "id".into(),
                    data_type: "bigserial".into(),
                    udt_name: None,
                    max_length: None,
                    numeric_precision: None,
                    numeric_scale: None,
                    nullable: false,
                    default_value: None,
                    is_primary_key: true,
                    is_auto_increment: true,
                    comment: None,
                },
                ColumnMeta {
                    name: "user_id".into(),
                    data_type: "bigint".into(),
                    udt_name: None,
                    max_length: None,
                    numeric_precision: None,
                    numeric_scale: None,
                    nullable: false,
                    default_value: None,
                    is_primary_key: false,
                    is_auto_increment: false,
                    comment: None,
                },
                ColumnMeta {
                    name: "customer_email".into(),
                    data_type: "varchar(255)".into(),
                    udt_name: None,
                    max_length: Some(255),
                    numeric_precision: None,
                    numeric_scale: None,
                    nullable: false,
                    default_value: None,
                    is_primary_key: false,
                    is_auto_increment: false,
                    comment: None,
                },
                ColumnMeta {
                    name: "total_price".into(),
                    data_type: "numeric(10,2)".into(),
                    udt_name: None,
                    max_length: None,
                    numeric_precision: Some(10),
                    numeric_scale: Some(2),
                    nullable: false,
                    default_value: None,
                    is_primary_key: false,
                    is_auto_increment: false,
                    comment: None,
                },
            ],
            indexes: vec![],
            foreign_keys: vec![ForeignKeyMeta {
                name: "fk_orders_user".into(),
                columns: vec!["user_id".into()],
                ref_schema: Some("public".into()),
                ref_table: "users".into(),
                ref_columns: vec!["id".into()],
                on_update: "CASCADE".into(),
                on_delete: "RESTRICT".into(),
            }],
            checks: vec![],
            row_estimate: None,
            ddl: None,
        };

        let rules = infer_column_rules(&meta);
        assert_eq!(rules[0].generator, DataGenGeneratorKind::AutoIncrementSkip);
        assert_eq!(rules[1].generator, DataGenGeneratorKind::ForeignKeySample);
        assert_eq!(rules[1].fk_table.as_deref(), Some("users"));
        assert_eq!(rules[2].generator, DataGenGeneratorKind::Email);
        assert_eq!(rules[3].generator, DataGenGeneratorKind::DecimalRange);
    }

    #[test]
    fn generates_regex_pattern_and_fk_sample_deterministically() {
        let mut rng = FastRng::new(12345);
        let code = generate_from_pattern(&mut rng, "[A-Z]{3}-\\d{4}");
        assert_eq!(code.len(), 8);
        assert_eq!(code.chars().nth(3), Some('-'));
        assert!(code[..3].chars().all(|c| c.is_ascii_uppercase()));
        assert!(code[4..].chars().all(|c| c.is_ascii_digit()));

        let rule = DataGenColumnRule {
            column: "user_id".into(),
            data_type: "bigint".into(),
            generator: DataGenGeneratorKind::ForeignKeySample,
            null_percent: 0,
            min_num: None,
            max_num: None,
            start_date: None,
            end_date: None,
            enum_values: vec![],
            pattern: None,
            fk_schema: None,
            fk_table: Some("users".into()),
            fk_column: Some("id".into()),
        };
        let pool = vec![json!(10), json!(20), json!(30)];
        let v = generate_value(&mut rng, &rule, Some(&pool), 0);
        assert!(pool.contains(&v));
    }
}
