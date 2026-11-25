# DBa

**DBa** is a fast, cross-platform desktop database management client built with **Tauri v2**, **Rust**, and **React**. Designed as a modern, lightweight alternative to Navicat Premium, DBa provides a unified workbench for managing relational and NoSQL databases across **Linux, macOS, and Windows**.

---

## Supported Databases

- **PostgreSQL**
- **MySQL / MariaDB**
- **Microsoft SQL Server (MSSQL)**
- **MongoDB**

---

## Key Features

### Connection & Security
- **Multi-Engine Connection Manager** with URI import, connection grouping, and environment tagging (`Development`, `Staging`, `Production`).
- **SSH Tunneling** (private key & jump host support) and **TLS / SSL** with custom CA certificates.
- **OS Native Keyring** integration (Linux Secret Service / KWallet, macOS Keychain, Windows Credential Manager) with a restricted local fallback vault.
- **Production Safety Guard & Read-Only Mode** to warn or block destructive operations (`DROP`, `TRUNCATE`, `DELETE`/`UPDATE` without `WHERE`) on production databases.

### Querying & Data Exploration
- **SQL Query Editor** powered by Monaco Editor with syntax highlighting, schema-aware autocomplete, SQL formatting, multi-tab & split view, query cancellation, and **EXPLAIN / Execution Plan** viewer.
- **MongoDB Query & Aggregation Editor** with JSON document viewer and inline CRUD editing.
- **High-Performance Data Viewer** with virtualized grid rendering, server-side pagination, filtering, sorting, and staged inline editing.
- **Table & Collection Designer** for visual schema editing with live DDL preview.
- **Object Explorer & Command Palette** for quick navigation across databases, schemas, tables, views, functions, procedures, triggers, events, sequences, and enum types.

### Migration, Sync & Backup
- **Data Transfer (Navicat-style)**: Copy **Tables / Collections** (structure + data or structure-only) as well as **Views, Materialized Views, Functions, Procedures, Triggers, Events, Sequences, and Enum Types** between databases, with customizable cross-engine type mapping and saved transfer profiles.
- **Structure Synchronization**: Compare source and target schemas, inspect column/index/foreign-key diffs, and apply selective DDL updates.
- **Data Synchronization**: Row-level diffing (`INSERT`, `UPDATE`, `DELETE`) with primary/custom key matching and reviewable SQL scripts.
- **Import & Export**: Supports CSV, JSON, SQL, and Excel (`.xlsx`) with error handling policies.
- **Dump & Backup**: Built-in SQL dump/restore plus auto-detection and integration with native CLI tools (`pg_dump`, `pg_restore`, `psql`, `mysqldump`, `mysql`, `mongodump`, `mongorestore`, `bcp`, `sqlpackage`).

### Visual Tools & Automation
- **ER Diagram Designer**: Reverse-engineer schemas into interactive diagrams and forward-engineer DDL scripts.
- **Visual Query Builder**: Build `SELECT`, `JOIN`, `WHERE`, and aggregate queries visually.
- **Charts & BI Dashboard**: Turn query results into visual charts and dashboards.
- **Data Generator**: Generate realistic, deterministic mock data for testing and seeding.
- **Batch Jobs & Automation**: Chain backup, export, transfer, sync, and data generation steps into reusable jobs, runnable manually or via the headless CLI (`dba-cli`) and `systemd --user` timers on Linux.

---

## Cross-Platform Support

DBa runs natively on **Linux**, **macOS**, and **Windows**:
- Uses each OS's native webview (WebKitGTK, WKWebView, WebView2) and native credential store.
- Automatically resolves database CLI tools (including `.exe` / `.cmd` / `.bat` on Windows).
- Stores local workspace data in the standard OS application data directory (`~/.local/share`, `~/Library/Application Support`, `%LOCALAPPDATA%`).

---

## Download

Pre-built binaries and installers for **Linux**, **macOS**, and **Windows** are available on the **Releases** page:

| Platform | Formats |
| --- | --- |
| **Linux** | `.AppImage`, `.deb`, `.rpm` |
| **macOS** | `.dmg`, `.app` |
| **Windows** | `.msi`, `.exe` |

Download the installer for your operating system, install, and launch **DBa** — no additional runtime or setup required.
