use crate::error::Result;
use keyring::Entry;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tracing::warn;

const SERVICE_NAME: &str = "dev.datavault.desktop";

/// Stores database passwords and SSH passphrases in Linux OS Keyring (Secret Service / KWallet).
/// Falls back to a chmod 0600 local vault file outside the Git-friendly workspace directory
/// only if Secret Service daemon is unavailable (e.g. headless CI/SSH session).
pub struct SecretStore {
    fallback_file: PathBuf,
}

impl SecretStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            fallback_file: data_dir.join(".vault.local"),
        }
    }

    pub fn set_secret(&self, key: &str, secret: &str) -> Result<()> {
        match Entry::new(SERVICE_NAME, key).and_then(|e| e.set_password(secret)) {
            Ok(()) => Ok(()),
            Err(err) => {
                warn!("OS Keyring unavailable ({}), using local restricted vault", err);
                self.set_fallback(key, secret)
            }
        }
    }

    pub fn get_secret(&self, key: &str) -> Result<Option<String>> {
        match Entry::new(SERVICE_NAME, key) {
            Ok(entry) => match entry.get_password() {
                Ok(pw) => Ok(Some(pw)),
                Err(keyring::Error::NoEntry) => self.get_fallback(key),
                Err(_) => self.get_fallback(key),
            },
            Err(_) => self.get_fallback(key),
        }
    }

    pub fn delete_secret(&self, key: &str) -> Result<()> {
        if let Ok(entry) = Entry::new(SERVICE_NAME, key) {
            let _ = entry.delete_credential();
        }
        let _ = self.delete_fallback(key);
        Ok(())
    }

    fn load_fallback_map(&self) -> HashMap<String, String> {
        if !self.fallback_file.exists() {
            return HashMap::new();
        }
        fs::read_to_string(&self.fallback_file)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    fn save_fallback_map(&self, map: &HashMap<String, String>) -> Result<()> {
        let json = serde_json::to_string(map)?;
        fs::write(&self.fallback_file, json)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&self.fallback_file, fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    fn set_fallback(&self, key: &str, secret: &str) -> Result<()> {
        let mut map = self.load_fallback_map();
        map.insert(key.to_string(), secret.to_string());
        self.save_fallback_map(&map)
    }

    fn get_fallback(&self, key: &str) -> Result<Option<String>> {
        let map = self.load_fallback_map();
        Ok(map.get(key).cloned())
    }

    fn delete_fallback(&self, key: &str) -> Result<()> {
        let mut map = self.load_fallback_map();
        map.remove(key);
        self.save_fallback_map(&map)
    }
}
