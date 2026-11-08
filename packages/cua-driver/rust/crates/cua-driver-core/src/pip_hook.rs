//! Internal, local-only preview notifications after an authorized observation.

use std::sync::{Arc, RwLock};

#[derive(Clone)]
pub struct PipTarget {
    pub session: String,
    pub pid: i32,
    pub window_id: u32,
    /// Rechecks the observation's authority without extending its lifetime.
    pub is_live: Arc<dyn Fn() -> bool + Send + Sync>,
}

pub trait PipSink: Send + Sync {
    fn observe(&self, target: PipTarget);
    fn remove_session(&self, session: &str);
    fn remove_runtime(&self, prefix: &str);
}

static SINK: RwLock<Option<Arc<dyn PipSink>>> = RwLock::new(None);

pub fn set_pip_sink(sink: Option<Arc<dyn PipSink>>) {
    *SINK.write().unwrap() = sink;
}

pub fn enabled() -> bool {
    SINK.read().unwrap().is_some()
}

pub fn observe_target(target: PipTarget) {
    let sink = SINK.read().unwrap().clone();
    if let Some(sink) = sink {
        sink.observe(target);
    }
}

pub fn remove_session(session: &str) {
    let sink = SINK.read().unwrap().clone();
    if let Some(sink) = sink {
        sink.remove_session(session);
    }
}

pub fn remove_runtime(prefix: &str) {
    let sink = SINK.read().unwrap().clone();
    if let Some(sink) = sink {
        sink.remove_runtime(prefix);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Receiver(Mutex<Vec<String>>);

    impl PipSink for Receiver {
        fn observe(&self, target: PipTarget) {
            if target.session == "pip-hook-test/two" {
                self.0.lock().unwrap().push(target.session);
                // Receivers may release the hook during teardown.
                set_pip_sink(None);
            }
        }
        fn remove_session(&self, session: &str) {
            if session == "pip-hook-test/one" {
                self.0.lock().unwrap().push(format!("session:{session}"));
            }
        }
        fn remove_runtime(&self, prefix: &str) {
            if prefix == "pip-hook-test/runtime/" {
                self.0.lock().unwrap().push(format!("runtime:{prefix}"));
            }
        }
    }

    #[test]
    fn replaceable_sink_is_called_without_holding_its_registry_lock() {
        let first = Arc::new(Receiver::default());
        set_pip_sink(Some(first.clone()));
        remove_session("pip-hook-test/one");
        let second = Arc::new(Receiver::default());
        set_pip_sink(Some(second.clone()));
        remove_runtime("pip-hook-test/runtime/");
        observe_target(PipTarget {
            session: "pip-hook-test/two".into(),
            pid: 1,
            window_id: 2,
            is_live: Arc::new(|| true),
        });
        remove_session("ignored");
        assert_eq!(*first.0.lock().unwrap(), ["session:pip-hook-test/one"]);
        assert_eq!(
            *second.0.lock().unwrap(),
            ["runtime:pip-hook-test/runtime/", "pip-hook-test/two"]
        );
    }
}
