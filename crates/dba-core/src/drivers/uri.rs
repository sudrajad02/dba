use crate::error::{DbaError, Result};
use crate::models::{DbEngine, ParsedConnectionUri, SslMode};
use url::Url;

/// Parses connection URIs like:
/// - `postgres://user:pass@localhost:5432/mydb?sslmode=require`
/// - `mysql://root:secret@127.0.0.1:3306/app`
/// - `mongodb+srv://user:pass@cluster.mongodb.net/mydb`
pub fn parse_connection_uri(raw: &str) -> Result<ParsedConnectionUri> {
    let trimmed = raw.trim();
    let parsed = Url::parse(trimmed)
        .map_err(|e| DbaError::InvalidUri(format!("Failed to parse URI: {}", e)))?;

    let engine = match parsed.scheme().to_lowercase().as_str() {
        "postgres" | "postgresql" => DbEngine::Postgres,
        "mysql" | "mariadb" => DbEngine::Mysql,
        "mssql" | "sqlserver" => DbEngine::Mssql,
        "mongodb" | "mongodb+srv" => DbEngine::Mongodb,
        other => {
            return Err(DbaError::InvalidUri(format!(
                "Unsupported URI scheme '{}'",
                other
            )))
        }
    };

    let host = parsed
        .host_str()
        .ok_or_else(|| DbaError::InvalidUri("Missing host in URI".into()))?
        .to_string();
    let port = parsed.port().unwrap_or_else(|| engine.default_port());
    let username = percent_decode(parsed.username());
    let password = parsed.password().map(percent_decode);
    let database = parsed
        .path()
        .trim_start_matches('/')
        .split('/')
        .next()
        .filter(|s| !s.is_empty())
        .map(percent_decode);

    let mut ssl_mode = None;
    for (k, v) in parsed.query_pairs() {
        if k.eq_ignore_ascii_case("sslmode") || k.eq_ignore_ascii_case("ssl-mode") {
            ssl_mode = match v.to_lowercase().as_str() {
                "disable" | "disabled" => Some(SslMode::Disable),
                "prefer" | "preferred" => Some(SslMode::Prefer),
                "require" | "required" => Some(SslMode::Require),
                "verify-ca" | "verify_ca" => Some(SslMode::VerifyCa),
                "verify-full" | "verify_full" | "verify_identity" => Some(SslMode::VerifyFull),
                _ => None,
            };
        }
    }

    Ok(ParsedConnectionUri {
        engine,
        host,
        port,
        database,
        username,
        password,
        ssl_mode,
    })
}

fn percent_decode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(val) = u8::from_str_radix(hex, 16) {
                    out.push(val as char);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}
