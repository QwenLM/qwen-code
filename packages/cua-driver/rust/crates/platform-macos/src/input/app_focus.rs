use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::{Arc, Mutex, OnceLock};

use core_foundation::base::{CFRelease, CFTypeRef};
use core_foundation::mach_port::{
    CFMachPortCreateRunLoopSource, CFMachPortInvalidate, CFMachPortRef,
};
use core_foundation::runloop::{
    kCFRunLoopDefaultMode, CFRunLoopAddSource, CFRunLoopGetCurrent, CFRunLoopRemoveSource,
    CFRunLoopRunInMode,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Preparation {
    None,
    ReturnKeyFocus,
    Activate,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct FocusState {
    believes_active: bool,
    believes_focus: bool,
    actual_active: bool,
    generation: u64,
}

impl FocusState {
    fn preparation(self) -> Preparation {
        if self.believes_focus {
            Preparation::None
        } else if self.believes_active {
            Preparation::ReturnKeyFocus
        } else {
            Preparation::Activate
        }
    }

    fn invalidate(&mut self) {
        self.believes_active = false;
        self.believes_focus = false;
        self.generation = self.generation.wrapping_add(1);
    }

    fn notification(&mut self, kind: usize, subtype: i16) {
        match (kind, subtype as u16) {
            (13, 1) => {
                self.believes_active = true;
                self.believes_focus = true;
            }
            (13, 2) => self.invalidate(),
            (21, 0x1000 | 0x4000 | 0xf102 | 2) => {
                self.believes_focus = false;
                self.generation = self.generation.wrapping_add(1);
            }
            (21, 0x8000) => self.believes_focus = true,
            _ => {}
        }
    }

    fn commit(&mut self, generation: u64, preparation: Preparation) {
        if self.generation != generation {
            return;
        }
        match preparation {
            Preparation::None => {}
            Preparation::ReturnKeyFocus => self.believes_focus = true,
            Preparation::Activate => {
                self.believes_active = true;
                self.believes_focus = true;
            }
        }
    }
}

struct ProcessFocus {
    pid: i32,
    stamp: (u64, u64),
    owners: usize,
    window_id: u32,
    state: FocusState,
    monitored: bool,
    click_monitored: bool,
}

type Registry = Mutex<HashMap<i32, Arc<Mutex<ProcessFocus>>>>;

fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn process_stamp(pid: i32) -> Option<(u64, u64)> {
    crate::ax::enablement::process_start_stamp(pid)
}

pub(crate) struct FocusLease {
    pid: i32,
    stamp: (u64, u64),
    process: Arc<Mutex<ProcessFocus>>,
}

impl FocusLease {
    pub(crate) fn is_current(&self) -> bool {
        process_stamp(self.pid) == Some(self.stamp)
            && registry().lock().is_ok_and(|entries| {
                entries.get(&self.pid).is_some_and(|entry| {
                    Arc::ptr_eq(entry, &self.process)
                        && entry.lock().is_ok_and(|entry| entry.owners > 0)
                })
            })
    }
}

impl Drop for FocusLease {
    fn drop(&mut self) {
        if let Ok(mut entries) = registry().lock() {
            let remove = entries.get(&self.pid).is_some_and(|entry| {
                if !Arc::ptr_eq(entry, &self.process) {
                    return false;
                }
                let Ok(mut entry) = entry.lock() else {
                    return false;
                };
                if entry.stamp != self.stamp {
                    return false;
                }
                entry.owners = entry.owners.saturating_sub(1);
                entry.owners == 0
            });
            if remove {
                entries.remove(&self.pid);
            }
        }
    }
}

pub(crate) fn track(pid: i32) -> anyhow::Result<FocusLease> {
    let stamp =
        process_stamp(pid).ok_or_else(|| anyhow::anyhow!("input target process is unavailable"))?;
    let mut entries = registry()
        .lock()
        .map_err(|_| anyhow::anyhow!("input focus registry poisoned"))?;
    if entries
        .get(&pid)
        .is_some_and(|entry| entry.lock().map_or(true, |entry| entry.stamp != stamp))
    {
        entries.remove(&pid);
    }
    let process = entries.entry(pid).or_insert_with(|| {
        let process = Arc::new(Mutex::new(ProcessFocus {
            pid,
            stamp,
            owners: 0,
            window_id: 0,
            state: FocusState::default(),
            monitored: false,
            click_monitored: false,
        }));
        start_monitor(pid, Arc::clone(&process));
        process
    });
    process
        .lock()
        .map_err(|_| anyhow::anyhow!("input focus state poisoned"))?
        .owners += 1;
    Ok(FocusLease {
        pid,
        stamp,
        process: Arc::clone(process),
    })
}

pub(super) fn prepare(
    pid: i32,
    window_id: u32,
    send: impl FnOnce(Preparation) -> anyhow::Result<()>,
) -> anyhow::Result<bool> {
    let stamp = process_stamp(pid)
        .ok_or_else(|| anyhow::anyhow!("could not establish the input process lifetime"))?;
    install_activation_observer();
    let actual_active = unsafe {
        objc2_app_kit::NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
            .is_some_and(|app| app.isActive())
    };
    let has_key_focus = super::skylight::key_focus_matches(pid, window_id) == Some(true);
    let process = {
        let mut entries = registry()
            .lock()
            .map_err(|_| anyhow::anyhow!("input focus registry poisoned"))?;
        if entries
            .get(&pid)
            .is_some_and(|entry| entry.lock().map_or(true, |entry| entry.stamp != stamp))
        {
            entries.remove(&pid);
        }
        entries
            .entry(pid)
            .or_insert_with(|| {
                let process = Arc::new(Mutex::new(ProcessFocus {
                    pid,
                    stamp,
                    owners: 0,
                    window_id,
                    state: FocusState {
                        believes_active: actual_active,
                        believes_focus: has_key_focus,
                        actual_active,
                        generation: 0,
                    },
                    monitored: false,
                    click_monitored: false,
                }));
                start_monitor(pid, Arc::clone(&process));
                process
            })
            .clone()
    };
    let (preparation, generation) = {
        let mut entry = process
            .lock()
            .map_err(|_| anyhow::anyhow!("input focus state poisoned"))?;
        if !entry.monitored || entry.window_id != window_id {
            entry.state.invalidate();
            entry.state.believes_active = actual_active;
            entry.state.believes_focus = has_key_focus;
        }
        entry.window_id = window_id;
        entry.state.actual_active = actual_active;
        if actual_active && has_key_focus {
            entry.state.believes_active = true;
            entry.state.believes_focus = true;
        }
        (entry.state.preparation(), entry.state.generation)
    };
    if preparation == Preparation::None {
        return Ok(false);
    }
    let result = send(preparation);
    if let Ok(mut entry) = process.lock() {
        if result.is_ok() {
            entry.state.commit(generation, preparation);
        } else {
            entry.state.invalidate();
        }
    }
    result.map(|()| true)
}

type TapCallback = unsafe extern "C" fn(*mut c_void, u32, *mut c_void, *mut c_void) -> *mut c_void;
type CreateTap =
    unsafe extern "C" fn(i32, u32, u32, u64, TapCallback, *mut c_void) -> CFMachPortRef;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventGetIntegerValueField(event: *mut c_void, field: u32) -> i64;
    fn CGEventTapCreate(
        location: u32,
        placement: u32,
        options: u32,
        mask: u64,
        callback: TapCallback,
        context: *mut c_void,
    ) -> CFMachPortRef;
}

fn user_click_needs_activation(
    state: FocusState,
    source_pid: i64,
    target_pid: i64,
    driver_pid: i32,
    app_pid: i32,
    window_owner: Option<i32>,
) -> bool {
    state.believes_active
        && !state.actual_active
        && source_pid != i64::from(driver_pid)
        && target_pid != i64::from(app_pid)
        && window_owner == Some(app_pid)
}

unsafe extern "C" fn observe_user_click(
    _proxy: *mut c_void,
    event_type: u32,
    event: *mut c_void,
    context: *mut c_void,
) -> *mut c_void {
    let process = &*(context as *const Mutex<ProcessFocus>);
    if event_type >= 0xffff_fffe {
        if let Ok(mut entry) = process.lock() {
            entry.click_monitored = false;
            entry.state.invalidate();
        }
        return event;
    }
    if event_type != 1 || event.is_null() {
        return event;
    }
    let (pid, stamp, state) = match process.lock() {
        Ok(entry) => (entry.pid, entry.stamp, entry.state),
        Err(_) => return event,
    };
    let source = CGEventGetIntegerValueField(event, 41);
    let target = CGEventGetIntegerValueField(event, 40);
    if !state.believes_active
        || state.actual_active
        || source == i64::from(libc::getpid())
        || target == i64::from(pid)
    {
        return event;
    }
    // The native enforcer reads mouseEventWindowUnderMousePointer (51), not
    // the synthetic window-routing fields 91/92. Ignore closed or foreign windows.
    let window = CGEventGetIntegerValueField(event, 51);
    let owner = u32::try_from(window)
        .ok()
        .filter(|id| *id != 0)
        .and_then(crate::windows::window_info_by_id)
        .map(|window| window.pid);
    if user_click_needs_activation(state, source, target, libc::getpid(), pid, owner)
        && process_stamp(pid) == Some(stamp)
    {
        if let Some(app) =
            objc2_app_kit::NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
        {
            crate::focus_steal::allow_user_activation(pid);
            let _ = app.activateWithOptions(objc2_app_kit::NSApplicationActivationOptions(0));
        }
    }
    event
}

unsafe extern "C" fn observe_event(
    _proxy: *mut c_void,
    event_type: u32,
    event: *mut c_void,
    context: *mut c_void,
) -> *mut c_void {
    let process = &*(context as *const Mutex<ProcessFocus>);
    if event_type >= 0xffff_fffe {
        if let Ok(mut entry) = process.lock() {
            entry.monitored = false;
            entry.state.invalidate();
        }
        return event;
    }
    if matches!(event_type, 13 | 21) && !event.is_null() {
        objc2::rc::autoreleasepool(|_| {
            use objc2::{class, msg_send};
            let ns_event: *mut objc2_app_kit::NSEvent = msg_send![class!(NSEvent), eventWithCGEvent: event as *mut super::app_pointer::ObjcCGEvent];
            if !ns_event.is_null() {
                let kind = (*ns_event).r#type().0;
                if matches!(kind, 13 | 21) {
                    let subtype = (*ns_event).subtype().0;
                    if let Ok(mut entry) = process.lock() {
                        entry.state.notification(kind, subtype);
                    }
                }
            }
        });
    }
    event
}

fn start_monitor(pid: i32, process: Arc<Mutex<ProcessFocus>>) {
    // The observer stays inside the native driver. A stopped or unavailable tap
    // invalidates beliefs; it can never turn into a permanent focus cache.
    let _ = std::thread::Builder::new()
        .name("cua-app-focus".into())
        .spawn(move || unsafe {
            struct RemoveEntry(i32, Arc<Mutex<ProcessFocus>>);
            impl Drop for RemoveEntry {
                fn drop(&mut self) {
                    if let Ok(mut entry) = self.1.lock() {
                        entry.monitored = false;
                        entry.click_monitored = false;
                        entry.state.invalidate();
                    }
                    if let Ok(mut entries) = registry().lock() {
                        if entries
                            .get(&self.0)
                            .is_some_and(|entry| Arc::ptr_eq(entry, &self.1))
                        {
                            entries.remove(&self.0);
                        }
                    }
                }
            }
            let _remove = RemoveEntry(pid, Arc::clone(&process));
            let symbol = libc::dlsym(libc::RTLD_DEFAULT, c"CGEventTapCreateForPid".as_ptr());
            if symbol.is_null() {
                return;
            }
            let create: CreateTap = std::mem::transmute(symbol);
            let context = Arc::as_ptr(&process) as *mut c_void;
            // Observe only activation/process notifications. No keyboard or
            // pointer contents are collected by the per-process focus monitor.
            let tap = create(pid, 0, 1, (1 << 13) | (1 << 21), observe_event, context);
            if tap.is_null() {
                return;
            }
            let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
            if source.is_null() {
                CFMachPortInvalidate(tap);
                CFRelease(tap as CFTypeRef);
                return;
            }
            let run_loop = CFRunLoopGetCurrent();
            CFRunLoopAddSource(run_loop, source, kCFRunLoopDefaultMode);
            if let Ok(mut entry) = process.lock() {
                entry.monitored = true;
            }
            let mut click_tap: CFMachPortRef = std::ptr::null_mut();
            let mut click_source: core_foundation::runloop::CFRunLoopSourceRef =
                std::ptr::null_mut();
            loop {
                CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.1, 1);
                let (keep, needs_click_tap, click_alive) =
                    process.lock().map_or((false, false, false), |entry| {
                        (
                            entry.monitored
                                && entry.owners > 0
                                && process_stamp(pid) == Some(entry.stamp),
                            entry.state.believes_active && !entry.state.actual_active,
                            entry.click_monitored,
                        )
                    });
                if !keep {
                    break;
                }
                if !click_tap.is_null() && (!needs_click_tap || !click_alive) {
                    CFRunLoopRemoveSource(run_loop, click_source, kCFRunLoopDefaultMode);
                    CFMachPortInvalidate(click_tap);
                    CFRelease(click_source as CFTypeRef);
                    CFRelease(click_tap as CFTypeRef);
                    click_tap = std::ptr::null_mut();
                    click_source = std::ptr::null_mut();
                    if let Ok(mut entry) = process.lock() {
                        entry.click_monitored = false;
                    }
                }
                if needs_click_tap && click_tap.is_null() {
                    // Annotated session, head insert, listen-only, left-mouse-down.
                    // Matches the native tap, and never consumes/reposts user input.
                    click_tap = CGEventTapCreate(2, 0, 1, 1 << 1, observe_user_click, context);
                    if !click_tap.is_null() {
                        click_source =
                            CFMachPortCreateRunLoopSource(std::ptr::null(), click_tap, 0);
                        if !click_source.is_null() {
                            CFRunLoopAddSource(run_loop, click_source, kCFRunLoopDefaultMode);
                            if let Ok(mut entry) = process.lock() {
                                entry.click_monitored = true;
                            }
                        } else {
                            CFMachPortInvalidate(click_tap);
                            CFRelease(click_tap as CFTypeRef);
                            click_tap = std::ptr::null_mut();
                        }
                    }
                }
            }
            if let Ok(mut entry) = process.lock() {
                entry.monitored = false;
                entry.state.invalidate();
            }
            CFRunLoopRemoveSource(run_loop, source, kCFRunLoopDefaultMode);
            CFMachPortInvalidate(tap);
            CFRelease(source as CFTypeRef);
            CFRelease(tap as CFTypeRef);
            if !click_tap.is_null() {
                CFRunLoopRemoveSource(run_loop, click_source, kCFRunLoopDefaultMode);
                CFMachPortInvalidate(click_tap);
                CFRelease(click_source as CFTypeRef);
                CFRelease(click_tap as CFTypeRef);
            }
        });
}

fn install_activation_observer() {
    static INSTALLED: OnceLock<()> = OnceLock::new();
    INSTALLED.get_or_init(|| unsafe {
        use objc2_app_kit::{
            NSWorkspace, NSWorkspaceApplicationKey, NSWorkspaceDidActivateApplicationNotification,
        };
        use objc2_foundation::{NSNotification, NSOperationQueue};
        let center = NSWorkspace::sharedWorkspace().notificationCenter();
        let queue = NSOperationQueue::new();
        queue.setMaxConcurrentOperationCount(1);
        let block = block2::RcBlock::new(|note: std::ptr::NonNull<NSNotification>| {
            let Some(info) = note.as_ref().userInfo() else {
                return;
            };
            let app: *mut objc2::runtime::AnyObject =
                objc2::msg_send![&*info, objectForKey: NSWorkspaceApplicationKey];
            if app.is_null() {
                return;
            }
            let pid: i32 = objc2::msg_send![app, processIdentifier];
            if let Ok(entries) = registry().lock() {
                for (&target, entry) in entries.iter() {
                    if let Ok(mut entry) = entry.lock() {
                        entry.state.actual_active = target == pid;
                    }
                }
            }
        });
        let token = center.addObserverForName_object_queue_usingBlock(
            Some(NSWorkspaceDidActivateApplicationNotification),
            None,
            Some(&queue),
            &block,
        );
        std::mem::forget(token);
        std::mem::forget(queue);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_lease_cannot_remove_replacement_monitor_for_same_process() {
        let pid = -8172;
        let stamp = (1, 2);
        let make = || {
            Arc::new(Mutex::new(ProcessFocus {
                pid,
                stamp,
                owners: 1,
                window_id: 1234,
                state: FocusState::default(),
                monitored: false,
                click_monitored: false,
            }))
        };
        let old = FocusLease {
            pid,
            stamp,
            process: make(),
        };
        let replacement = make();
        registry()
            .lock()
            .unwrap()
            .insert(pid, Arc::clone(&replacement));
        drop(old);
        assert_eq!(replacement.lock().unwrap().owners, 1);
        let retained = registry().lock().unwrap().remove(&pid).unwrap();
        assert!(Arc::ptr_eq(&retained, &replacement));
    }

    #[test]
    fn native_event_callback_decodes_actual_nsevent_selectors_without_posting() {
        use foreign_types::ForeignType;
        let process = Mutex::new(ProcessFocus {
            pid: 42,
            stamp: (1, 2),
            owners: 1,
            window_id: 1234,
            state: FocusState::default(),
            monitored: true,
            click_monitored: false,
        });
        let context = &process as *const _ as *mut c_void;
        for (preparation, kind) in [
            (Preparation::Activate, 13),
            (Preparation::ReturnKeyFocus, 21),
        ] {
            let events = super::super::app_pointer::focus_events(preparation, 1234, None).unwrap();
            let event = events[0].as_ptr() as *mut c_void;
            assert_eq!(
                unsafe { observe_event(std::ptr::null_mut(), kind, event, context) },
                event
            );
            assert!(process.lock().unwrap().state.believes_focus);
            process.lock().unwrap().state.believes_focus = false;
        }
        unsafe {
            observe_event(
                std::ptr::null_mut(),
                0xffff_fffe,
                std::ptr::null_mut(),
                context,
            );
        }
        let entry = process.lock().unwrap();
        assert!(!entry.monitored);
        assert_eq!(entry.state.preparation(), Preparation::Activate);
    }

    #[test]
    fn only_external_click_on_falsely_active_window_requests_real_activation() {
        let state = FocusState {
            believes_active: true,
            actual_active: false,
            ..Default::default()
        };
        assert!(user_click_needs_activation(state, 0, 55, 88, 42, Some(42)));
        assert!(!user_click_needs_activation(
            state,
            88,
            55,
            88,
            42,
            Some(42)
        ));
        assert!(!user_click_needs_activation(state, 0, 42, 88, 42, Some(42)));
        assert!(!user_click_needs_activation(state, 0, 55, 88, 42, Some(55)));
        assert!(!user_click_needs_activation(state, 0, 55, 88, 42, None));
        assert!(!user_click_needs_activation(
            FocusState {
                actual_active: true,
                ..state
            },
            0,
            55,
            88,
            42,
            Some(42)
        ));
        assert!(!user_click_needs_activation(
            FocusState::default(),
            0,
            55,
            88,
            42,
            Some(42)
        ));
    }

    #[test]
    fn preparation_uses_beliefs_independently_of_actual_activation() {
        for actual_active in [false, true] {
            let mut state = FocusState {
                actual_active,
                ..Default::default()
            };
            assert_eq!(state.preparation(), Preparation::Activate);
            state.believes_active = true;
            assert_eq!(state.preparation(), Preparation::ReturnKeyFocus);
            state.believes_focus = true;
            assert_eq!(state.preparation(), Preparation::None);
            state.believes_active = false;
            assert_eq!(state.preparation(), Preparation::None);
        }
    }

    #[test]
    fn notification_loss_requires_focus_return_without_reactivation() {
        let mut state = FocusState::default();
        state.commit(0, Preparation::Activate);
        assert!(!state.actual_active);
        state.notification(21, 0x4000);
        assert_eq!(state.preparation(), Preparation::ReturnKeyFocus);
        state.notification(21, 0x8000u16 as i16);
        assert_eq!(state.preparation(), Preparation::None);
        state.notification(13, 2);
        assert_eq!(state.preparation(), Preparation::Activate);
    }

    #[test]
    fn focus_loss_during_post_cannot_be_overwritten_by_success_commit() {
        let mut state = FocusState::default();
        let generation = state.generation;
        state.notification(21, 0x1000);
        state.commit(generation, Preparation::Activate);
        assert_eq!(state.preparation(), Preparation::Activate);
    }

    #[test]
    fn unknown_or_stopped_monitor_discards_both_beliefs() {
        let mut state = FocusState {
            believes_active: true,
            believes_focus: true,
            actual_active: true,
            generation: 4,
        };
        state.invalidate();
        assert_eq!(state.preparation(), Preparation::Activate);
        assert!(state.actual_active);
        assert_eq!(state.generation, 5);
    }
}
