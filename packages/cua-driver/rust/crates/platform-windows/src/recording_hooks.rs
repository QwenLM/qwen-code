//! Recording callbacks exposed to `cua_driver_core::recording`.
//!
//! Two hooks:
//!  - `app_state_json_for` — produces `app_state.json` bytes for a turn folder.
//!  - `element_window_local_xy` — resolves `element_index` to a click point in
//!    window-local screenshot-pixel coordinates so `click.png` is also written
//!    on UIA/MSAA-indexed clicks (not just pixel-addressed ones).

use cua_driver_core::recording::ScreenshotCapture;

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HWND;

#[cfg(target_os = "windows")]
use windows::Win32::UI::Input::KeyboardAndMouse::IsWindowEnabled;

#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    GetLastActivePopup, GetWindowThreadProcessId, IsWindow, IsWindowVisible,
};

/// Resolve the window whose application evidence should be captured. Keep a
/// live explicit HWND so occluded/background turns capture the exact target.
/// When an action closes a modal HWND, fall back to another top-level window
/// owned by the same pid for the post-action application state.
#[cfg(target_os = "windows")]
pub fn resolve_window_for_recording(window_id: Option<u64>, pid: Option<i64>) -> Option<u64> {
    if let Some(window_id) = window_id {
        let hwnd = HWND(window_id as *mut _);
        if unsafe { IsWindow(hwnd) }.as_bool() {
            let popup = unsafe { GetLastActivePopup(hwnd) };
            if !unsafe { IsWindowEnabled(hwnd) }.as_bool()
                && popup != hwnd
                && unsafe { IsWindow(popup) }.as_bool()
                && unsafe { IsWindowVisible(popup) }.as_bool()
            {
                let mut popup_pid = 0;
                unsafe { GetWindowThreadProcessId(popup, Some(&mut popup_pid)) };
                if pid.and_then(|value| u32::try_from(value).ok()) == Some(popup_pid) {
                    return Some(popup.0 as u64);
                }
            }
            return Some(window_id);
        }
    }
    let pid = u32::try_from(pid?).ok()?;
    crate::win32::list_windows(Some(pid))
        .first()
        .map(|window| window.hwnd)
}

#[cfg(target_os = "windows")]
pub fn screenshot_for_recording(window_id: Option<u64>, pid: Option<i64>) -> ScreenshotCapture {
    if window_id.is_none() && pid.is_none() {
        return crate::capture::screenshot_display_bytes()
            .map(ScreenshotCapture::captured)
            .unwrap_or_else(|_| ScreenshotCapture::unavailable("capture_failed"));
    }
    let Some(hwnd) = resolve_window_for_recording(window_id, pid) else {
        return ScreenshotCapture::unavailable("target_unavailable");
    };
    match crate::capture::screenshot_window_bytes_with_occlusion(hwnd) {
        Ok((_, true)) => ScreenshotCapture::unavailable("background_occluded"),
        Ok((png, false)) => ScreenshotCapture::captured(png),
        Err(error) if error.to_string().contains("minimized window") => {
            ScreenshotCapture::unavailable("target_minimized")
        }
        Err(_) => ScreenshotCapture::unavailable("capture_failed"),
    }
}

#[cfg(target_os = "windows")]
pub fn app_state_json_for(window_id: Option<u64>, pid: Option<i64>) -> Option<Vec<u8>> {
    let pid = u32::try_from(pid?).ok()?;
    let hwnd = resolve_window_for_recording(window_id, Some(pid.into()))?;
    recording_tree_json(pid, hwnd)
}

#[cfg(target_os = "windows")]
struct RecordingApartment;

#[cfg(target_os = "windows")]
impl RecordingApartment {
    fn new() -> Option<Self> {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
        if unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_err() {
            return None;
        }
        Some(Self)
    }
}

#[cfg(target_os = "windows")]
impl Drop for RecordingApartment {
    fn drop(&mut self) {
        unsafe { windows::Win32::System::Com::CoUninitialize() };
    }
}

#[cfg(target_os = "windows")]
struct RecordingTree(crate::uia::UiaTreeResult);

#[cfg(target_os = "windows")]
impl Drop for RecordingTree {
    fn drop(&mut self) {
        crate::uia::settle_node_bindings(&mut self.0.nodes, self.0.backend, false);
    }
}

#[cfg(target_os = "windows")]
fn recording_tree_json(pid: u32, hwnd: u64) -> Option<Vec<u8>> {
    // Declaration order keeps the apartment alive until raw node references drop.
    let _apartment = RecordingApartment::new()?;
    let tree = RecordingTree(unsafe { crate::uia::walk_tree_for_recording(hwnd) });
    let result = &tree.0;
    let element_count = result
        .nodes
        .iter()
        .filter(|n| n.element_index.is_some())
        .count();
    let payload = serde_json::json!({
        "pid": pid,
        "window_id": hwnd,
        "element_count": element_count,
        "tree_markdown": result.tree_markdown,
    });
    serde_json::to_vec_pretty(&payload).ok()
}

#[cfg(target_os = "windows")]
pub fn element_window_local_xy(
    window_id: u64,
    pid: i64,
    element_index: u32,
    binding: &cua_driver_core::element_token::SnapshotBinding,
) -> Option<(f64, f64)> {
    let cache = crate::uia::cache::BoundElementCache::from_binding(binding.clone());
    let pid_u32 = u32::try_from(pid).ok()?;
    let (sx, sy) = cache.get_element_center(pid_u32, window_id, element_index as usize)?;
    // The cached center is in SCREEN coords. Convert to window-local pixel
    // coords by subtracting the window's screen origin (GetWindowRect-equivalent
    // in WindowInfo). Windows captures at logical pixels so no scale factor.
    let wins = crate::win32::list_windows(Some(pid_u32));
    let win = wins.iter().find(|w| w.hwnd == window_id)?;
    Some(((sx - win.x) as f64, (sy - win.y) as f64))
}

#[cfg(not(target_os = "windows"))]
pub fn app_state_json_for(_window_id: Option<u64>, _pid: Option<i64>) -> Option<Vec<u8>> {
    None
}
#[cfg(not(target_os = "windows"))]
pub fn resolve_window_for_recording(_window_id: Option<u64>, _pid: Option<i64>) -> Option<u64> {
    None
}
#[cfg(not(target_os = "windows"))]
pub fn screenshot_for_recording(_window_id: Option<u64>, _pid: Option<i64>) -> ScreenshotCapture {
    ScreenshotCapture::unavailable("unsupported_platform")
}
#[cfg(not(target_os = "windows"))]
pub fn element_window_local_xy(
    _window_id: u64,
    _pid: i64,
    _element_index: u32,
    _binding: &cua_driver_core::element_token::SnapshotBinding,
) -> Option<(f64, f64)> {
    None
}

#[cfg(all(test, target_os = "windows"))]
mod recording_com_tests {
    use super::*;
    use crate::uia::{UiaBackend, UiaNode, UiaTreeResult};
    use std::ffi::c_void;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };
    use windows::core::{IUnknown_Vtbl, GUID, HRESULT};
    use windows::Win32::Foundation::{CO_E_NOTINITIALIZED, E_NOINTERFACE};
    use windows::Win32::System::Com::{
        CoGetApartmentType, CoInitializeEx, CoUninitialize, APTTYPE, APTTYPEQUALIFIER,
        APTTYPEQUALIFIER_IMPLICIT_MTA, APTTYPEQUALIFIER_NONE, COINIT_APARTMENTTHREADED,
        COINIT_MULTITHREADED,
    };

    fn apartment() -> windows::core::Result<(APTTYPE, APTTYPEQUALIFIER)> {
        let mut kind = APTTYPE::default();
        let mut qualifier = APTTYPEQUALIFIER::default();
        unsafe { CoGetApartmentType(&mut kind, &mut qualifier)? };
        Ok((kind, qualifier))
    }

    fn assert_uninitialized() {
        // Another UIA worker may keep the process MTA alive. That gives this
        // thread an implicit apartment, without a CoInitializeEx reference.
        match apartment() {
            Err(error) => assert_eq!(error.code(), CO_E_NOTINITIALIZED),
            Ok((_, qualifier)) => assert_eq!(qualifier, APTTYPEQUALIFIER_IMPLICIT_MTA),
        }
    }

    #[test]
    fn recording_worker_balances_com_and_preserves_other_apartments() {
        std::thread::spawn(|| unsafe {
            assert_uninitialized();
            // The unchanged legacy entry demonstrates the old initialization
            // lifetime. HWND 0 exercises native failure without opening a GUI.
            let mut legacy = crate::uia::walk_tree(0, None);
            crate::uia::settle_node_bindings(&mut legacy.nodes, legacy.backend, false);
            assert_eq!(apartment().unwrap().1, APTTYPEQUALIFIER_NONE);
            drop(legacy);
            CoUninitialize();
            assert_uninitialized();

            assert!(recording_tree_json(0, 0).is_some());
            assert_uninitialized();

            CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap();
            let previous = apartment().unwrap();
            assert!(recording_tree_json(0, 0).is_some());
            assert_eq!(apartment().unwrap(), previous); // S_FALSE was paired once.
            CoUninitialize();
            assert_uninitialized();

            CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap();
            let previous = apartment().unwrap();
            assert!(recording_tree_json(0, 0).is_none()); // Changed mode is rejected.
            assert_eq!(apartment().unwrap(), previous);
            CoUninitialize();
            assert_uninitialized();
        })
        .join()
        .unwrap();
    }

    #[repr(C)]
    struct ReleaseProbe {
        vtable: *const IUnknown_Vtbl,
        releases: Arc<AtomicUsize>,
        live_apartment: Arc<AtomicBool>,
    }

    unsafe extern "system" fn query(
        _: *mut c_void,
        _: *const GUID,
        out: *mut *mut c_void,
    ) -> HRESULT {
        *out = std::ptr::null_mut();
        E_NOINTERFACE
    }
    unsafe extern "system" fn add_ref(_: *mut c_void) -> u32 {
        2
    }
    unsafe extern "system" fn release(ptr: *mut c_void) -> u32 {
        let probe = Box::from_raw(ptr.cast::<ReleaseProbe>());
        probe.live_apartment.store(
            apartment().is_ok_and(|(_, qualifier)| qualifier == APTTYPEQUALIFIER_NONE),
            Ordering::SeqCst,
        );
        probe.releases.fetch_add(1, Ordering::SeqCst);
        0
    }
    static VTABLE: IUnknown_Vtbl = IUnknown_Vtbl {
        QueryInterface: query,
        AddRef: add_ref,
        Release: release,
    };

    fn node(ptr: usize, actionable: bool) -> UiaNode {
        UiaNode {
            element_index: actionable.then_some(0),
            control_type: "probe".into(),
            name: None,
            value: None,
            automation_id: None,
            help_text: None,
            actions: Vec::new(),
            runtime_id: None,
            enabled: None,
            selected: None,
            element_ptr: ptr,
            center_x: 0,
            center_y: 0,
            rect: None,
            msaa_role: None,
            depth: 0,
            parent_element_index: None,
            in_web_content: false,
        }
    }

    #[test]
    fn recording_releases_uia_and_msaa_bindings_before_apartment_on_unwind() {
        std::thread::spawn(|| {
            for backend in [UiaBackend::Uia, UiaBackend::Msaa] {
                let releases = Arc::new(AtomicUsize::new(0));
                let live_apartment = Arc::new(AtomicBool::new(false));
                let nodes = [false, true]
                    .into_iter()
                    .map(|actionable| {
                        // Only IUnknown::Release is called by the real settlement
                        // path; this owned fake has no UIA provider or desktop data.
                        let ptr = Box::into_raw(Box::new(ReleaseProbe {
                            vtable: &VTABLE,
                            releases: releases.clone(),
                            live_apartment: live_apartment.clone(),
                        }));
                        node(ptr as usize, actionable)
                    })
                    .collect();
                let unwound = std::panic::catch_unwind(|| {
                    let _apartment = RecordingApartment::new().unwrap();
                    let _tree = RecordingTree(UiaTreeResult {
                        nodes,
                        backend,
                        tree_markdown: String::new(),
                        complete: true,
                        truncated: false,
                        incomplete_notes: Vec::new(),
                    });
                    panic!("controlled serialization unwind");
                });
                assert!(unwound.is_err());
                assert_eq!(releases.load(Ordering::SeqCst), 2);
                assert!(live_apartment.load(Ordering::SeqCst));
                assert_uninitialized();
            }
        })
        .join()
        .unwrap();
    }
}
