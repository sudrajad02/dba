use crate::error::{DatavaultError, Result};
use crate::models::{SshAuthMethod, SshConfig};
use std::net::TcpListener;
use std::time::Duration;
use tokio::process::{Child, Command};
use tokio::time::sleep;

/// Manages a local-to-remote SSH port-forwarding tunnel.
/// Automatically cleans up the tunnel process on Drop.
pub struct SshTunnel {
    pub local_port: u16,
    child: Child,
}

impl SshTunnel {
    pub async fn open(
        ssh: &SshConfig,
        remote_host: &str,
        remote_port: u16,
        _secret: Option<&str>,
    ) -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|e| DatavaultError::SshTunnel(format!("Failed to bind local port: {}", e)))?;
        let local_port = listener
            .local_addr()
            .map_err(|e| DatavaultError::SshTunnel(e.to_string()))?
            .port();
        drop(listener);

        let forward_spec = format!("127.0.0.1:{}:{}:{}", local_port, remote_host, remote_port);
        let target = format!("{}@{}", ssh.username, ssh.host);
        let port_str = if ssh.port == 0 {
            "22".to_string()
        } else {
            ssh.port.to_string()
        };

        let mut cmd = Command::new("ssh");
        cmd.arg("-N")
            .arg("-L")
            .arg(&forward_spec)
            .arg("-p")
            .arg(&port_str)
            .arg("-o")
            .arg("ExitOnForwardFailure=yes")
            .arg("-o")
            .arg("StrictHostKeyChecking=accept-new")
            .arg("-o")
            .arg("ConnectTimeout=10");

        if ssh.auth_method == SshAuthMethod::PrivateKey {
            if let Some(ref key_path) = ssh.private_key_path {
                if !key_path.trim().is_empty() {
                    cmd.arg("-i").arg(key_path.trim());
                }
            }
            cmd.arg("-o").arg("BatchMode=yes");
        }

        if let Some(ref jump) = ssh.jump_host {
            if !jump.trim().is_empty() {
                cmd.arg("-J").arg(jump.trim());
            }
        }

        cmd.arg(&target).kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|e| {
            DatavaultError::SshTunnel(format!("Failed to launch SSH tunnel process: {}", e))
        })?;

        // Wait until local forwarded port is accepting connections
        for _ in 0..40 {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(DatavaultError::SshTunnel(format!(
                    "SSH tunnel exited early with status {}",
                    status
                )));
            }
            if tokio::net::TcpStream::connect(("127.0.0.1", local_port))
                .await
                .is_ok()
            {
                return Ok(Self { local_port, child });
            }
            sleep(Duration::from_millis(125)).await;
        }

        let _ = child.kill().await;
        Err(DatavaultError::SshTunnel(
            "Timed out waiting for SSH tunnel to establish".into(),
        ))
    }

    pub async fn close(mut self) {
        let _ = self.child.kill().await;
    }
}
