//! Observe physical XI2 slave input during foreground transactions. Events always pass through.
use anyhow::{bail, Result};
use std::cell::RefCell;
use std::collections::HashSet;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use x11rb::connection::Connection;
use x11rb::protocol::{
    xinput::{ConnectionExt, Device, DeviceType, EventMask, XIEventMask},
    Event,
};
use x11rb::rust_connection::RustConnection;

#[derive(Default)]
struct State {
    stopped: AtomicBool,
    detected: AtomicBool,
}
thread_local! { static ACTIVE: RefCell<Option<Arc<State>>> = const { RefCell::new(None) }; }
pub(super) struct Observer {
    state: Arc<State>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Observer {
    pub(super) fn start() -> Result<Self> {
        let (conn, screen) = RustConnection::connect(None)?;
        conn.xinput_xi_query_version(2, 0)?.reply()?;
        let devices = conn.xinput_xi_query_device(Device::ALL)?.reply()?;
        let physical = devices
            .infos
            .into_iter()
            .filter(|device| {
                let name = String::from_utf8_lossy(&device.name).to_ascii_lowercase();
                matches!(
                    device.type_,
                    DeviceType::SLAVE_POINTER
                        | DeviceType::SLAVE_KEYBOARD
                        | DeviceType::FLOATING_SLAVE
                ) && !name.contains("xtest")
                    && !name.starts_with("cua-")
                    && !name.starts_with("cua v1.")
                    && !name.starts_with("qwen-cua")
            })
            .map(|device| device.deviceid)
            .collect::<HashSet<_>>();
        conn.xinput_xi_select_events(
            conn.setup().roots[screen].root,
            &[EventMask {
                deviceid: Device::ALL.into(),
                mask: vec![
                    XIEventMask::RAW_KEY_PRESS
                        | XIEventMask::RAW_KEY_RELEASE
                        | XIEventMask::RAW_BUTTON_PRESS
                        | XIEventMask::RAW_BUTTON_RELEASE
                        | XIEventMask::RAW_MOTION,
                ],
            }],
        )?
        .check()?;
        conn.flush()?;
        let state = Arc::new(State::default());
        let worker_state = state.clone();
        let worker = std::thread::Builder::new()
            .name("cua-user-input".into())
            .spawn(move || {
                while !worker_state.stopped.load(Ordering::Acquire) {
                    match conn.poll_for_event() {
                        Ok(Some(event)) => {
                            let source = match event {
                                Event::XinputRawKeyPress(event)
                                | Event::XinputRawKeyRelease(event) => Some(event.sourceid),
                                Event::XinputRawButtonPress(event)
                                | Event::XinputRawButtonRelease(event)
                                | Event::XinputRawMotion(event) => Some(event.sourceid),
                                _ => None,
                            };
                            if source.is_some_and(|source| physical.contains(&source)) {
                                worker_state.detected.store(true, Ordering::Release);
                            }
                        }
                        Ok(None) => std::thread::sleep(Duration::from_millis(1)),
                        Err(_) => {
                            worker_state.detected.store(true, Ordering::Release);
                            break;
                        }
                    }
                }
            })?;
        Ok(Self {
            state,
            worker: Some(worker),
        })
    }
    pub(super) fn interrupted(&self) -> bool {
        self.state.detected.load(Ordering::Acquire)
    }
}
impl Drop for Observer {
    fn drop(&mut self) {
        self.state.stopped.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
pub(super) struct Guard {
    _observer: Observer,
    previous: Option<Arc<State>>,
}
impl Guard {
    pub(super) fn start() -> Result<Self> {
        let observer = Observer::start()?;
        let previous = ACTIVE.with(|active| active.replace(Some(observer.state.clone())));
        Ok(Self {
            _observer: observer,
            previous,
        })
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        ACTIVE.with(|active| {
            active.replace(self.previous.take());
        });
    }
}
pub(super) fn checkpoint() -> Result<()> {
    if ACTIVE.with(|active| {
        active
            .borrow()
            .as_ref()
            .is_some_and(|state| state.detected.load(Ordering::Acquire))
    }) {
        bail!("user_input_detected: physical input arrived during foreground delivery; input stopped; observe before retrying");
    }
    Ok(())
}
