use crate::drivers::split_sql_statements;
use crate::models::{ConnectionProfile, EnvironmentTag, SafetyCheckResult};
use regex::Regex;

/// Evaluates SQL against Production Safety Guard & Read-Only Mode rules.
pub fn evaluate_sql_safety(profile: &ConnectionProfile, sql: &str) -> SafetyCheckResult {
    let statements = split_sql_statements(sql);
    let mut warnings = Vec::new();
    let mut is_write = false;
    let mut is_destructive = false;

    let re_comment_line = Regex::new(r"(?m)--[^\n]*").unwrap();
    let re_comment_block = Regex::new(r"(?s)/\*.*?\*/").unwrap();
    let re_where = Regex::new(r"(?i)\bWHERE\b").unwrap();

    for stmt in &statements {
        let cleaned = re_comment_block.replace_all(stmt, " ");
        let cleaned = re_comment_line.replace_all(&cleaned, " ");
        let trimmed = cleaned.trim();
        if trimmed.is_empty() {
            continue;
        }
        let upper = trimmed.to_uppercase();
        let first_word = upper.split_whitespace().next().unwrap_or("");

        let stmt_is_read = matches!(
            first_word,
            "SELECT" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" | "WITH" | "VALUES" | "PRAGMA"
        );

        // Even WITH (CTE) can contain INSERT/UPDATE/DELETE
        let cte_write = first_word == "WITH"
            && (upper.contains(" INSERT ")
                || upper.contains(" UPDATE ")
                || upper.contains(" DELETE "));

        if !stmt_is_read || cte_write {
            is_write = true;
        }

        if matches!(first_word, "DROP" | "TRUNCATE") {
            is_destructive = true;
            warnings.push(format!("Destructive DDL statement detected: {} ...", first_word));
        } else if first_word == "DELETE" && !re_where.is_match(trimmed) {
            is_destructive = true;
            warnings.push("DELETE statement without WHERE clause detected!".into());
        } else if first_word == "UPDATE" && !re_where.is_match(trimmed) {
            is_destructive = true;
            warnings.push("UPDATE statement without WHERE clause detected!".into());
        }
    }

    if profile.read_only && is_write {
        warnings.push("Connection is in Read-Only Mode. Write operations are blocked.".into());
        return SafetyCheckResult {
            allowed: false,
            requires_confirmation: false,
            warnings,
            is_write,
            is_destructive,
        };
    }

    let is_prod = profile.environment == EnvironmentTag::Production;
    if is_prod && is_write {
        warnings.push(format!(
            "Target connection '{}' is tagged as PRODUCTION.",
            profile.name
        ));
    }

    let requires_confirmation = is_destructive || (is_prod && is_write);

    SafetyCheckResult {
        allowed: true,
        requires_confirmation,
        warnings,
        is_write,
        is_destructive,
    }
}
