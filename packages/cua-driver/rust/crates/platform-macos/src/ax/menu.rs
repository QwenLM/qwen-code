use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock, Weak,
};

use core_foundation::base::{CFEqual, CFRelease, CFRetain, CFTypeRef, TCFType};
use core_foundation::runloop::{
    kCFRunLoopDefaultMode, CFRunLoopAddSource, CFRunLoopGetCurrent, CFRunLoopRemoveSource,
    CFRunLoopRunInMode, CFRunLoopSourceRef,
};
use core_foundation::string::{CFString, CFStringRef};

use super::bindings::*;

type Observer = *mut c_void;
type Callback = unsafe extern "C" fn(Observer, AXUIElementRef, CFStringRef, *mut c_void);

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXObserverCreate(pid: i32, callback: Callback, observer: *mut Observer) -> AXError;
    fn AXObserverAddNotification(
        observer: Observer,
        element: AXUIElementRef,
        notification: CFStringRef,
        context: *mut c_void,
    ) -> AXError;
    fn AXObserverGetRunLoopSource(observer: Observer) -> CFRunLoopSourceRef;
}

struct MenuElement(usize);

impl Drop for MenuElement {
    fn drop(&mut self) {
        unsafe {
            CFRelease(self.0 as CFTypeRef);
        }
    }
}

struct MenuState {
    pid: i32,
    stamp: (u64, u64),
    menu: Mutex<Option<MenuElement>>,
    stopped: AtomicBool,
}

pub(crate) struct MenuMonitor(Arc<MenuState>);

impl MenuMonitor {
    pub(crate) fn is_current(&self) -> bool {
        !self.0.stopped.load(Ordering::Acquire)
            && super::enablement::process_start_stamp(self.0.pid) == Some(self.0.stamp)
    }
}

impl Drop for MenuMonitor {
    fn drop(&mut self) {
        self.0.stopped.store(true, Ordering::Release);
    }
}

fn registry() -> &'static Mutex<HashMap<i32, Weak<MenuMonitor>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<i32, Weak<MenuMonitor>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

unsafe extern "C" fn notification(
    _observer: Observer,
    element: AXUIElementRef,
    name: CFStringRef,
    context: *mut c_void,
) {
    let state = &*(context as *const MenuState);
    if state.stopped.load(Ordering::Acquire) {
        return;
    }
    let name = CFString::wrap_under_get_rule(name).to_string();
    if name == "AXMenuClosed" {
        if let Ok(mut menu) = state.menu.lock() {
            *menu = None;
        }
    } else if name == "AXMenuOpened" {
        if !element.is_null() {
            let _ = AXUIElementSetMessagingTimeout(element, 0.1);
        }
        let mut pid = 0;
        if !element.is_null()
            && AXUIElementGetPid(element, &mut pid) == kAXErrorSuccess
            && pid == state.pid
            && copy_string_attr(element, "AXRole").as_deref() == Some("AXMenu")
        {
            if let Ok(mut menu) = state.menu.lock() {
                CFRetain(element as CFTypeRef);
                *menu = Some(MenuElement(element as usize));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closed_notification_releases_retained_menu_without_querying_focus() {
        let value = CFString::new("retained menu identity for close notification test");
        let ptr = value.as_CFTypeRef();
        unsafe {
            CFRetain(ptr);
        }
        let state = MenuState {
            pid: 42,
            stamp: (1, 2),
            menu: Mutex::new(Some(MenuElement(ptr as usize))),
            stopped: AtomicBool::new(false),
        };
        let before = unsafe { core_foundation::base::CFGetRetainCount(ptr) };
        unsafe {
            notification(
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CFString::new("AXMenuClosed").as_concrete_TypeRef(),
                &state as *const _ as *mut c_void,
            );
        }
        assert!(state.menu.lock().unwrap().is_none());
        assert_eq!(
            unsafe { core_foundation::base::CFGetRetainCount(ptr) },
            before - 1
        );
    }

    #[test]
    fn last_owner_stops_monitor_even_when_worker_keeps_state_alive() {
        let state = Arc::new(MenuState {
            pid: 42,
            stamp: (1, 2),
            menu: Mutex::new(None),
            stopped: AtomicBool::new(false),
        });
        let monitor = Arc::new(MenuMonitor(Arc::clone(&state)));
        let second = Arc::clone(&monitor);
        drop(monitor);
        assert!(!state.stopped.load(Ordering::Acquire));
        drop(second);
        assert!(state.stopped.load(Ordering::Acquire));
    }
}

pub(crate) fn track(pid: i32) -> anyhow::Result<Arc<MenuMonitor>> {
    let mut entries = registry()
        .lock()
        .map_err(|_| anyhow::anyhow!("menu registry poisoned"))?;
    entries.retain(|_, entry| entry.strong_count() != 0);
    if let Some(monitor) = entries
        .get(&pid)
        .and_then(Weak::upgrade)
        .filter(|m| m.is_current())
    {
        return Ok(monitor);
    }
    let stamp = super::enablement::process_start_stamp(pid)
        .ok_or_else(|| anyhow::anyhow!("menu target process is unavailable"))?;
    let state = Arc::new(MenuState {
        pid,
        stamp,
        menu: Mutex::new(None),
        stopped: AtomicBool::new(false),
    });
    let monitor = Arc::new(MenuMonitor(Arc::clone(&state)));
    let (ready, started) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("cua-app-menus".into())
        .spawn(move || {
            objc2::rc::autoreleasepool(|_| unsafe {
                let mut observer = std::ptr::null_mut();
                let status = AXObserverCreate(pid, notification, &mut observer);
                if status != kAXErrorSuccess || observer.is_null() {
                    let _ = ready.send(false);
                    state.stopped.store(true, Ordering::Release);
                    return;
                }
                let app = AXUIElementCreateApplication(pid);
                if app.is_null() {
                    CFRelease(observer as CFTypeRef);
                    let _ = ready.send(false);
                    state.stopped.store(true, Ordering::Release);
                    return;
                }
                let _ = AXUIElementSetMessagingTimeout(app, 0.1);
                let context = Arc::as_ptr(&state) as *mut c_void;
                let registered = ["AXMenuOpened", "AXMenuClosed"].into_iter().all(|name| {
                    AXObserverAddNotification(
                        observer,
                        app,
                        CFString::new(name).as_concrete_TypeRef(),
                        context,
                    ) == kAXErrorSuccess
                });
                CFRelease(app as CFTypeRef);
                if !registered {
                    CFRelease(observer as CFTypeRef);
                    let _ = ready.send(false);
                    state.stopped.store(true, Ordering::Release);
                    return;
                }
                let run_loop = CFRunLoopGetCurrent();
                let source = AXObserverGetRunLoopSource(observer);
                CFRunLoopAddSource(run_loop, source, kCFRunLoopDefaultMode);

                use objc2_app_kit::{
                    NSWorkspace, NSWorkspaceApplicationKey,
                    NSWorkspaceDidDeactivateApplicationNotification,
                };
                use objc2_foundation::NSNotification;
                let center = NSWorkspace::sharedWorkspace().notificationCenter();
                let weak = Arc::downgrade(&state);
                let block = block2::RcBlock::new(move |note: std::ptr::NonNull<NSNotification>| {
                    let Some(state) = weak.upgrade() else {
                        return;
                    };
                    let Some(info) = note.as_ref().userInfo() else {
                        return;
                    };
                    let app: *mut objc2::runtime::AnyObject =
                        objc2::msg_send![&*info, objectForKey: NSWorkspaceApplicationKey];
                    if !app.is_null() {
                        let owner: i32 = objc2::msg_send![app, processIdentifier];
                        if owner == state.pid {
                            if let Ok(mut menu) = state.menu.lock() {
                                *menu = None;
                            }
                        }
                    }
                });
                let token = center.addObserverForName_object_queue_usingBlock(
                    Some(NSWorkspaceDidDeactivateApplicationNotification),
                    None,
                    None,
                    &block,
                );
                let _ = ready.send(true);
                while !state.stopped.load(Ordering::Acquire)
                    && super::enablement::process_start_stamp(pid) == Some(stamp)
                {
                    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.05, 1);
                }
                state.stopped.store(true, Ordering::Release);
                if let Ok(mut menu) = state.menu.lock() {
                    *menu = None;
                }
                center.removeObserver(&token);
                CFRunLoopRemoveSource(run_loop, source, kCFRunLoopDefaultMode);
                CFRelease(observer as CFTypeRef);
            });
        })?;
    if started.recv_timeout(std::time::Duration::from_secs(2)) != Ok(true) {
        anyhow::bail!("application does not provide menu notifications");
    }
    entries.insert(pid, Arc::downgrade(&monitor));
    Ok(monitor)
}

/// Returns a retained live menu; the caller owns its release.
pub(super) unsafe fn copy_current(pid: i32) -> Option<AXUIElementRef> {
    let monitor = registry().lock().ok()?.get(&pid)?.upgrade()?;
    if !monitor.is_current() {
        return None;
    }
    let menu = monitor.0.menu.lock().ok()?;
    let element = menu.as_ref()?.0 as AXUIElementRef;
    CFRetain(element as CFTypeRef);
    Some(element)
}

pub(super) unsafe fn contains(pid: i32, element: AXUIElementRef) -> bool {
    let Some(menu) = copy_current(pid) else {
        return false;
    };
    let mut current = element;
    CFRetain(current as CFTypeRef);
    let mut matched = false;
    for _ in 0..40 {
        let mut owner = 0;
        if AXUIElementGetPid(current, &mut owner) != kAXErrorSuccess || owner != pid {
            break;
        }
        if CFEqual(current as CFTypeRef, menu as CFTypeRef) != 0 {
            matched = true;
            break;
        }
        let Some(parent) = copy_element_attr(current, "AXParent") else {
            break;
        };
        CFRelease(current as CFTypeRef);
        current = parent;
    }
    CFRelease(current as CFTypeRef);
    if matched {
        matched = copy_current(pid).is_some_and(|fresh| {
            let same = CFEqual(fresh as CFTypeRef, menu as CFTypeRef) != 0;
            CFRelease(fresh as CFTypeRef);
            same
        });
    }
    CFRelease(menu as CFTypeRef);
    matched
}
