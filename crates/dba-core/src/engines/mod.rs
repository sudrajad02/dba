pub mod automation;
pub mod data_gen;
pub mod data_sync;
pub mod dump;
pub mod er_model;
pub mod import_export;
pub mod native_cli;
pub mod structure_sync;
pub mod transfer;
pub mod xlsx;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Tracks cancellation flags for long-running Phase 3 streaming jobs (Import/Export/Dump/Transfer).
#[derive(Default)]
pub struct JobCancelRegistry {
    tokens: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl JobCancelRegistry {
    pub fn register(&self, job_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        let mut map = self.tokens.lock().unwrap();
        map.insert(job_id.to_string(), flag.clone());
        flag
    }

    pub fn cancel(&self, job_id: &str) -> bool {
        let map = self.tokens.lock().unwrap();
        if let Some(flag) = map.get(job_id) {
            flag.store(true, Ordering::SeqCst);
            true
        } else {
            false
        }
    }

    pub fn unregister(&self, job_id: &str) {
        let mut map = self.tokens.lock().unwrap();
        map.remove(job_id);
    }
}
