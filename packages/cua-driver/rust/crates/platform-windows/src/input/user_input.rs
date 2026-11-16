//! Content-free physical input detection. Hooks always forward every event.
use anyhow::{anyhow, bail, Result};
use std::cell::RefCell;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::*;
#[derive(Default)]
struct State {
    stopped: AtomicBool,
    detected: AtomicBool,
}
thread_local! {
    static OBSERVING: RefCell<Option<Arc<State>>> = const { RefCell::new(None) };
    static ACTIVE: RefCell<Option<Arc<State>>> = const { RefCell::new(None) };
}
unsafe extern "system" fn keyboard(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0
        && !(*(l.0 as *const KBDLLHOOKSTRUCT))
            .flags
            .contains(LLKHF_INJECTED)
    {
        mark();
    }
    CallNextHookEx(None, code, w, l)
}
unsafe extern "system" fn mouse(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 && (*(l.0 as *const MSLLHOOKSTRUCT)).flags & 1 == 0 {
        mark();
    }
    CallNextHookEx(None, code, w, l)
}
fn mark() {
    OBSERVING.with(|state| {
        if let Some(state) = state.borrow().as_ref() {
            state.detected.store(true, Ordering::Release);
        }
    });
}
pub(super) struct Guard {
    state: Arc<State>,
    previous: Option<Arc<State>>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Guard {
    pub(super) fn start() -> Result<Self> {
        let state = Arc::new(State::default());
        let worker_state = state.clone();
        let (ready, started) = std::sync::mpsc::sync_channel(1);
        let worker = std::thread::Builder::new()
            .name("cua-user-input".into())
            .spawn(move || unsafe {
                OBSERVING.with(|state| {
                    state.replace(Some(worker_state.clone()));
                });
                let keyboard = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), None, 0) {
                    Ok(hook) => hook,
                    Err(error) => {
                        let _ = ready.send(Err(error.to_string()));
                        return;
                    }
                };
                let mouse = match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse), None, 0) {
                    Ok(hook) => hook,
                    Err(error) => {
                        let _ = UnhookWindowsHookEx(keyboard);
                        let _ = ready.send(Err(error.to_string()));
                        return;
                    }
                };
                let _ = ready.send(Ok(()));
                let mut message = MSG::default();
                while !worker_state.stopped.load(Ordering::Acquire) {
                    while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                        let _ = TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                    std::thread::sleep(Duration::from_millis(1));
                }
                let _ = UnhookWindowsHookEx(mouse);
                let _ = UnhookWindowsHookEx(keyboard);
                OBSERVING.with(|state| {
                    state.take();
                });
            })?;
        match started.recv_timeout(Duration::from_secs(1)) {
            Ok(Ok(())) => {}
            failure => {
                state.stopped.store(true, Ordering::Release);
                let _ = worker.join();
                bail!("foreground_unavailable: physical-input observer could not start; no input was sent: {failure:?}");
            }
        }
        let previous = ACTIVE.with(|active| active.replace(Some(state.clone())));
        Ok(Self {
            state,
            previous,
            worker: Some(worker),
        })
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        ACTIVE.with(|active| {
            active.replace(self.previous.take());
        });
        self.state.stopped.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
pub(super) fn checkpoint() -> Result<()> {
    if ACTIVE.with(|active| {
        active
            .borrow()
            .as_ref()
            .is_some_and(|state| state.detected.load(Ordering::Acquire))
    }) {
        return Err(anyhow!("user_input_detected: physical input arrived during foreground delivery; input stopped; observe before retrying"));
    }
    Ok(())
}
