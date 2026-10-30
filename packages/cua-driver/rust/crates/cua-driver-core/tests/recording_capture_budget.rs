//! The real recording API with a controlled native provider; no desktop is opened.
use cua_driver_core::recording::{
    now_ms, set_ax_snapshot_fn, PendingTurn, RecordingCaller, RecordingSession,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Gate {
    state: Mutex<(usize, bool)>,
    changed: Condvar,
    block_call: usize,
}

impl Gate {
    fn new(block_call: usize) -> Arc<Self> {
        Arc::new(Self {
            block_call,
            ..Self::default()
        })
    }

    fn capture(&self) -> Option<Vec<u8>> {
        let mut state = self.state.lock().unwrap();
        state.0 += 1;
        let call = state.0;
        self.changed.notify_all();
        if call == self.block_call {
            let (next, timeout) = self
                .changed
                .wait_timeout_while(state, Duration::from_secs(10), |state| !state.1)
                .unwrap();
            state = next;
            assert!(
                !timeout.timed_out(),
                "test failed to release controlled provider"
            );
        }
        drop(state);
        Some(serde_json::to_vec(&json!({"call": call})).unwrap())
    }

    fn wait_for_call(&self, expected: usize) {
        let (state, timeout) = self
            .changed
            .wait_timeout_while(
                self.state.lock().unwrap(),
                Duration::from_secs(3),
                |state| state.0 < expected,
            )
            .unwrap();
        assert!(
            !timeout.timed_out(),
            "provider did not receive call {expected}: {}",
            state.0
        );
    }

    fn release(&self) {
        self.state.lock().unwrap().1 = true;
        self.changed.notify_all();
    }
}

struct ReleaseAll(Vec<Arc<Gate>>);
impl Drop for ReleaseAll {
    fn drop(&mut self) {
        for gate in &self.0 {
            gate.release();
        }
    }
}

fn begin(session: &RecordingSession, pid: i64, owner: Option<&str>) -> Option<PendingTurn> {
    session.begin_turn(
        "budget_probe",
        &json!({"pid": pid}),
        now_ms(),
        RecordingCaller {
            session: owner,
            transport: owner,
        },
    )
}

fn evidence(dir: &std::path::Path, turn: usize) -> Value {
    serde_json::from_slice(
        &std::fs::read(dir.join(format!("turn-{turn:05}/evidence.json"))).unwrap(),
    )
    .unwrap()
}

#[test]
fn bounded_native_capture_releases_locks_and_rejects_late_generations() {
    let gates = Arc::new(Mutex::new(HashMap::<i64, Arc<Gate>>::new()));
    let provider_gates = gates.clone();
    set_ax_snapshot_fn(move |_, pid| {
        let gate = provider_gates.lock().unwrap().get(&pid?).cloned()?;
        gate.capture()
    });
    let root = tempfile::tempdir().unwrap();
    let mut releases = ReleaseAll(Vec::new());

    // Four slow providers time out for their callers but retain all four slots.
    let mut captures = Vec::new();
    for pid in 1..=4 {
        let gate = Gate::new(1);
        releases.0.push(gate.clone());
        gates.lock().unwrap().insert(pid, gate.clone());
        let session = Arc::new(RecordingSession::new());
        let dir = root.path().join(format!("timeout-{pid}"));
        session.start(dir.to_str().unwrap(), false, None).unwrap();
        let worker_session = session.clone();
        let worker = std::thread::spawn(move || {
            let start = Instant::now();
            let pending = begin(&worker_session, pid, None).unwrap();
            (pending, start.elapsed())
        });
        gate.wait_for_call(1);
        captures.push((session, dir, worker, gate));
    }
    let fifth = Gate::new(0);
    gates.lock().unwrap().insert(5, fifth.clone());
    let spare = RecordingSession::new();
    let spare_dir = root.path().join("spare");
    spare
        .start(spare_dir.to_str().unwrap(), false, None)
        .unwrap();
    let started = Instant::now();
    let pending = begin(&spare, 5, None).unwrap();
    spare.finish_turn(pending, "busy");
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(fifth.state.lock().unwrap().0, 0);
    assert_eq!(
        evidence(&spare_dir, 1)["before"]["state"]["classification"],
        "state_capture_busy"
    );

    for (session, dir, worker, gate) in captures {
        let (pending, elapsed) = worker.join().unwrap();
        assert!(elapsed >= Duration::from_millis(1900));
        assert!(elapsed < Duration::from_secs(4));
        session.finish_turn(pending, "timeout");
        let result = evidence(&dir, 1);
        assert_eq!(
            result["before"]["state"]["classification"],
            "state_capture_timeout"
        );
        assert_eq!(
            result["after"]["state"]["classification"],
            "state_capture_busy"
        );
        assert_eq!(gate.state.lock().unwrap().0, 1);
        assert!(!dir.join("turn-00001/before_state.json").exists());
        gate.release();
        session.stop_owner(None).unwrap();
    }
    // Wait for a slot to be released by the worker, not by its timed-out caller.
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let pending = begin(&spare, 5, None).unwrap();
        spare.finish_turn(pending, "recovered");
        if fifth.state.lock().unwrap().0 > 0 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "workers did not release their slots"
        );
        std::thread::yield_now();
    }
    spare.stop_owner(None).unwrap();
    for pid in 1..=4 {
        let turn = root.path().join(format!("timeout-{pid}/turn-00001"));
        assert!(!turn.join("before_state.json").exists());
        assert!(!turn.join("after_state.json").exists());
        assert!(!turn.join("app_state.json").exists());
    }

    // An after capture must neither hold the session lock nor outlive its owner/generation.
    for (pid, replacement_owner) in [(10, "owner-a"), (11, "owner-b")] {
        let gate = Gate::new(2);
        releases.0.push(gate.clone());
        gates.lock().unwrap().insert(pid, gate.clone());
        let session = Arc::new(RecordingSession::new());
        let old_dir = root.path().join(format!("old-{pid}"));
        let new_dir = root.path().join(format!("new-{pid}"));
        session
            .start(old_dir.to_str().unwrap(), false, Some("owner-a"))
            .unwrap();
        let pending = begin(&session, pid, Some("owner-a")).unwrap();
        let worker_session = session.clone();
        let worker = std::thread::spawn(move || worker_session.finish_turn(pending, "old result"));
        gate.wait_for_call(2);
        let started = Instant::now();
        assert!(session.current_state().enabled);
        session.stop_owner(Some("owner-a")).unwrap();
        session
            .start(new_dir.to_str().unwrap(), false, Some(replacement_owner))
            .unwrap();
        assert!(started.elapsed() < Duration::from_secs(1));
        gate.release();
        worker.join().unwrap();
        for dir in [&old_dir, &new_dir] {
            for file in [
                "action.json",
                "after_state.json",
                "app_state.json",
                "evidence.json",
            ] {
                assert!(
                    !dir.join("turn-00001").join(file).exists(),
                    "stale write: {dir:?}/{file}"
                );
            }
        }
        session.stop_owner(Some(replacement_owner)).unwrap();
    }
}
