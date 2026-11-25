use clap::{Parser, Subcommand};
use dba_core::{ConnectionManager, StorageManager};
use std::sync::Arc;

#[derive(Parser)]
#[command(name = "dba-cli", version, about = "Headless CLI runner for DBa")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// List saved connection profiles
    ListConnections,
    /// List saved batch jobs
    ListJobs,
    /// Execute a SQL query against a saved connection ID
    RunQuery {
        #[arg(short, long)]
        connection_id: String,
        #[arg(short, long)]
        database: Option<String>,
        #[arg(short, long)]
        sql: String,
        #[arg(long, default_value_t = false)]
        confirm_safety: bool,
    },
    /// Execute a scheduled batch job (systemd --user timer target)
    RunJob {
        job_id: String,
        #[arg(long, default_value_t = false)]
        no_notify: bool,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();
    let cli = Cli::parse();
    let storage = Arc::new(StorageManager::initialize()?);
    let manager = ConnectionManager::new(storage.clone());

    match cli.command {
        Commands::ListConnections => {
            let conns = storage.list_connections()?;
            println!("{}", serde_json::to_string_pretty(&conns)?);
        }
        Commands::ListJobs => {
            let jobs = storage.list_batch_jobs()?;
            println!("{}", serde_json::to_string_pretty(&jobs)?);
        }
        Commands::RunQuery {
            connection_id,
            database,
            sql,
            confirm_safety,
        } => {
            manager.connect(&connection_id).await?;
            let resp = manager
                .execute_query(
                    &connection_id,
                    database.as_deref(),
                    &sql,
                    None,
                    confirm_safety,
                )
                .await?;
            println!("{}", serde_json::to_string_pretty(&resp)?);
            manager.disconnect(&connection_id).await?;
        }
        Commands::RunJob { job_id, no_notify } => {
            let Some(job) = storage.get_batch_job(&job_id)? else {
                anyhow::bail!("Batch job '{}' not found in workspace/jobs/", job_id);
            };
            let log = manager.run_batch_job(&job, !no_notify).await?;
            println!("{}", log.output);
            if log.status != "success" {
                std::process::exit(1);
            }
        }
    }

    Ok(())
}
