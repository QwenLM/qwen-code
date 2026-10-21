//! Fresh exact-target acquisition for background input decisions.
//!
//! Gathers the facts [`cua_driver_core::background_input`] needs about one
//! requested `(pid, CGWindowID)` immediately before a background mutation:
//! WindowServer ownership, fresh `AXWindows` membership (mapped through
//! `_AXUIElementGetWindow`), minimized/hidden state, competing same-pid AX
//! top-level keyboard destinations, and addressed-element ancestry. All reads are
//! bounded and fail closed — an unreadable fact never unlocks a route.

use core_foundation::base::{CFEqual, CFRelease, CFRetain, CFTypeRef};
use cua_driver_core::background_input::{
    BackgroundTargetFacts, ElementAncestry, WindowServerOwnership,
};
use std::collections::HashSet;
use std::time::{Duration, Instant};

use super::bindings::{
    _AXUIElementGetWindow, ax_get_window_id, copy_ax_windows_with_status, copy_bool_attr,
    copy_bool_attr_with_status, copy_children_with_status, copy_element_attr,
    copy_remote_window_for_id, copy_string_attr, focused_element_of_pid, kAXErrorSuccess,
    AXUIElementCreateApplication, AXUIElementGetPid, AXUIElementRef,
    AXUIElementSetMessagingTimeout,
};
use super::tree::AXIdentity;
use crate::windows::{all_windows, resolve_window_owner, WindowOwner};

/// Bounded `AXParent` ascent used when an element does not expose `AXWindow`.
const MAX_ANCESTRY_DEPTH: usize = 40;

/// Resolve the CGWindowID of the top-level AX window that owns `element`.
///
/// Prefers its native window mapping, then `AXWindow` and a bounded
/// `AXParent` walk. `None` means ancestry could not be proven — callers must
/// treat that as "not the requested window", never as a wildcard.
///
/// # Safety
///
/// `element` must be a valid `AXUIElementRef` for the duration of the call.
pub unsafe fn element_window_id(element: AXUIElementRef) -> Option<u32> {
    let _ = AXUIElementSetMessagingTimeout(element, 0.1);
    // AppKit sheet fields can expose their parent in AXWindow, while their
    // native mapping identifies the actual sheet receiving keyboard input.
    let mut window_id = 0;
    if _AXUIElementGetWindow(element, &mut window_id) == kAXErrorSuccess && window_id != 0 {
        return Some(window_id);
    }
    if let Some(window) = copy_element_attr(element, "AXWindow") {
        let window_id = ax_get_window_id(window);
        CFRelease(window as CFTypeRef);
        if window_id.is_some() {
            return window_id;
        }
    }
    // Fallback: ascend AXParent until a window role, then map it.
    let mut current: AXUIElementRef = element;
    let mut owned = false;
    let mut resolved = None;
    for _ in 0..MAX_ANCESTRY_DEPTH {
        let _ = AXUIElementSetMessagingTimeout(current, 0.1);
        match copy_string_attr(current, "AXRole").as_deref() {
            Some("AXWindow") | Some("AXSheet") => {
                resolved = ax_get_window_id(current);
                break;
            }
            Some("AXApplication") | None => break,
            _ => {}
        }
        let parent = copy_element_attr(current, "AXParent");
        if owned {
            CFRelease(current as CFTypeRef);
        }
        match parent {
            Some(parent) => {
                current = parent;
                owned = true;
            }
            None => return None,
        }
    }
    if owned {
        CFRelease(current as CFTypeRef);
    }
    resolved
}

unsafe fn is_app_menu(
    element: AXUIElementRef,
    app: AXUIElementRef,
    pid: i32,
    window_id: u32,
) -> bool {
    let mut owner = 0;
    if AXUIElementGetPid(element, &mut owner) != kAXErrorSuccess
        || owner != pid
        || !matches!(
            copy_string_attr(element, "AXRole").as_deref(),
            Some("AXMenuBarItem" | "AXMenuItem" | "AXMenu")
        )
        || super::bindings::focused_window_id_of_pid(pid) != Some(window_id)
    {
        return false;
    }
    if super::menu::contains(pid, element) {
        return true;
    }
    let Some(bar) = copy_element_attr(app, "AXMenuBar") else {
        return false;
    };
    let _ = AXUIElementSetMessagingTimeout(bar, 0.1);
    let valid_bar = AXUIElementGetPid(bar, &mut owner) == kAXErrorSuccess
        && owner == pid
        && copy_string_attr(bar, "AXRole").as_deref() == Some("AXMenuBar");
    CFRetain(element as CFTypeRef);
    let mut current = element;
    let mut matched = false;
    if valid_bar {
        for _ in 0..MAX_ANCESTRY_DEPTH {
            let _ = AXUIElementSetMessagingTimeout(current, 0.1);
            if CFEqual(current as CFTypeRef, bar as CFTypeRef) != 0 {
                matched = true;
                break;
            }
            let Some(parent) = copy_element_attr(current, "AXParent") else {
                break;
            };
            CFRelease(current as CFTypeRef);
            current = parent;
        }
    }
    CFRelease(current as CFTypeRef);
    CFRelease(bar as CFTypeRef);
    matched
}

/// The process's focused AX element, but only when it provably belongs to the
/// requested window. Returns a retained element the caller must release.
///
/// This is the only focused-element reader background window-scoped keyboard
/// paths may use: a PID-global focused element can belong to a sibling window,
/// and sibling state must never address or confirm the requested target.
///
/// # Safety
///
/// Caller must `CFRelease` the returned element.
pub unsafe fn focused_element_in_window(pid: i32, window_id: u32) -> Option<AXUIElementRef> {
    let Some(element) = focused_element_of_pid(pid) else {
        return focused_text_descendant(pid, window_id);
    };
    if element_window_id(element) == Some(window_id) {
        // Some apps report an unfocused container above the actual text focus.
        if copy_string_attr(element, "AXRole").as_deref() == Some("AXGroup")
            && copy_bool_attr(element, "AXFocused") == Some(false)
        {
            CFRelease(element as CFTypeRef);
            return focused_text_descendant(pid, window_id);
        }
        Some(element)
    } else {
        CFRelease(element as CFTypeRef);
        None
    }
}

// WKWebView can expose AXFocused on its input while the application's
// AXFocusedUIElement is empty. Never infer focus from a cached observation.
unsafe fn focused_text_descendant(pid: i32, window_id: u32) -> Option<AXUIElementRef> {
    let deadline = Instant::now() + Duration::from_millis(300);
    let app = AXUIElementCreateApplication(pid);
    if app.is_null() {
        return None;
    }
    let _ = AXUIElementSetMessagingTimeout(app, 0.05);
    let root = copy_element_attr(app, "AXFocusedWindow");
    CFRelease(app as CFTypeRef);
    let root = root?;
    let identity = AXIdentity::retained(root);
    CFRelease(root as CFTypeRef);
    if ax_get_window_id(root) != Some(window_id) {
        return None;
    }
    let mut pending = vec![(identity, 0)];
    let mut visited = HashSet::new();
    let mut focused: Option<AXIdentity> = None;
    while let Some((identity, depth)) = pending.pop() {
        if !visited.insert(identity.clone()) {
            continue;
        }
        if visited.len() > 256 || Instant::now() >= deadline {
            return None;
        }
        let element = identity.as_ptr() as AXUIElementRef;
        let timeout = deadline
            .saturating_duration_since(Instant::now())
            .as_secs_f32()
            .clamp(0.001, 0.025);
        let _ = AXUIElementSetMessagingTimeout(element, timeout);
        let mut owner = 0;
        if AXUIElementGetPid(element, &mut owner) != kAXErrorSuccess || owner <= 0 {
            return None;
        }
        let focus = copy_bool_attr_with_status(element, "AXFocused");
        if !focus.complete {
            return None;
        }
        if focus.value == Some(true)
            && matches!(
                copy_string_attr(element, "AXRole").as_deref(),
                Some("AXTextField" | "AXTextArea" | "AXSearchField" | "AXComboBox")
            )
        {
            // A window can contain remote helper containers. Only the final
            // editable destination must belong to this process and window.
            if owner != pid || focused.is_some() || element_window_id(element) != Some(window_id) {
                return None;
            }
            focused = Some(identity.clone());
        }
        let children = copy_children_with_status(element);
        let children_owned: Vec<_> = children
            .elements
            .into_iter()
            .map(|child| {
                let identity = AXIdentity::retained(child);
                CFRelease(child as CFTypeRef);
                identity
            })
            .collect();
        if !children.complete
            || (depth >= MAX_ANCESTRY_DEPTH && !children_owned.is_empty())
            || pending.len() + children_owned.len() + visited.len() > 256
        {
            return None;
        }
        pending.extend(children_owned.into_iter().map(|child| (child, depth + 1)));
    }
    let focused = focused?;
    let element = focused.as_ptr() as AXUIElementRef;
    if Instant::now() >= deadline
        || super::bindings::focused_window_id_of_pid(pid) != Some(window_id)
        || copy_bool_attr(element, "AXFocused") != Some(true)
        || element_window_id(element) != Some(window_id)
    {
        return None;
    }
    CFRetain(element as CFTypeRef);
    Some(element)
}

fn keyboard_focus_matches_target(pid: i32, window_id: u32) -> bool {
    if super::bindings::focused_window_id_of_pid(pid) != Some(window_id) {
        return false;
    }
    unsafe {
        let Some(element) = focused_element_in_window(pid, window_id) else {
            return false;
        };
        let focused = copy_bool_attr(element, "AXFocused") == Some(true);
        CFRelease(element as CFTypeRef);
        focused
    }
}

pub(crate) fn validate_keyboard_target(pid: i32, window_id: u32) -> anyhow::Result<()> {
    use cua_driver_core::background_input::{
        decide_background_input, BackgroundAction, BackgroundInputDecision, ExactWindowTarget,
    };
    match decide_background_input(
        ExactWindowTarget { pid, window_id },
        &gather_background_facts(pid, window_id, None),
        BackgroundAction::GenericKey,
    ) {
        BackgroundInputDecision::Execute { .. } => Ok(()),
        BackgroundInputDecision::Refuse(refusal) => {
            anyhow::bail!("{}: {}", refusal.code, refusal.reason)
        }
    }
}

/// One fresh AX window or attached sheet: its mapped ID and minimized state.
/// `minimized: None` means the attribute could not be read — unknown, not
/// "not minimized".
struct AxWindowRecord {
    window_id: u32,
    minimized: Option<bool>,
}

fn attached_sheet_record(
    window_id: Option<u32>,
    root_window_id: Option<u32>,
    records: &[AxWindowRecord],
) -> Option<AxWindowRecord> {
    let window_id = window_id?;
    let root_window_id = root_window_id?;
    if records.iter().any(|record| record.window_id == window_id) {
        return None;
    }
    let root = records
        .iter()
        .find(|record| record.window_id == root_window_id)?;
    Some(AxWindowRecord {
        window_id,
        // Attached sheets minimize with their proven root window.
        minimized: root.minimized,
    })
}

/// Map fresh AXWindows, proven sheets, and an exactly recovered remote window.
/// An unmapped window or incomplete attachment discovery cannot unlock input.
unsafe fn ax_window_records(
    app: AXUIElementRef,
    pid: i32,
    target_window_id: u32,
) -> Vec<AxWindowRecord> {
    let windows_read = copy_ax_windows_with_status(app);
    let windows = windows_read.elements;
    let mut records: Vec<_> = windows
        .iter()
        .filter_map(|&window| {
            ax_get_window_id(window).map(|window_id| AxWindowRecord {
                window_id,
                minimized: copy_bool_attr(window, "AXMinimized"),
            })
        })
        .collect();
    let all_windows_mapped = records.len() == windows.len();
    if windows_read.complete
        && !records
            .iter()
            .any(|record| record.window_id == target_window_id)
    {
        let (sheets, complete) = super::sheets::copy_attached_sheets(&windows);
        if complete {
            let all_sheets_mapped = sheets.iter().all(|sheet| {
                sheet.window_id.is_some()
                    && sheet.root_window_id.is_some_and(|root_id| {
                        records.iter().any(|record| record.window_id == root_id)
                    })
            });
            for sheet in sheets {
                if let Some(record) =
                    attached_sheet_record(sheet.window_id, sheet.root_window_id, &records)
                {
                    records.push(record);
                }
            }
            if all_windows_mapped
                && all_sheets_mapped
                && !records
                    .iter()
                    .any(|record| record.window_id == target_window_id)
            {
                if let Some(window) = copy_remote_window_for_id(pid, target_window_id, None) {
                    let _ = AXUIElementSetMessagingTimeout(window, 0.1);
                    records.push(AxWindowRecord {
                        window_id: target_window_id,
                        minimized: copy_bool_attr(window, "AXMinimized"),
                    });
                    CFRelease(window as CFTypeRef);
                }
            }
        }
    }
    for window in windows {
        CFRelease(window as CFTypeRef);
    }
    records
}

/// Count independently AX-mapped, non-minimized sibling top-level windows.
///
/// WindowServer may expose several layer-0 compositor surfaces for one native
/// Electron, Tauri, or WebKit window. A raw same-pid CGWindow row is therefore
/// not enough to prove another process-scoped keyboard destination. Requiring a
/// fresh `AXWindows` mapping preserves the fail-closed two-window guard while
/// ignoring render surfaces that cannot independently become the AX key window.
fn count_competing_keyboard_destinations(
    pid: i32,
    target_window_id: u32,
    window_server_rows: impl IntoIterator<Item = (i32, u32)>,
    ax_records: &[AxWindowRecord],
) -> usize {
    window_server_rows
        .into_iter()
        .filter(|(owner_pid, window_id)| {
            *owner_pid == pid
                && *window_id != target_window_id
                && ax_records
                    .iter()
                    .any(|record| record.window_id == *window_id && record.minimized != Some(true))
        })
        .count()
}

/// Gather fresh background-input facts for one `(pid, window_id)` target.
///
/// `element_ptr` is an optional retained `AXUIElementRef` (as `usize`) for an
/// explicitly addressed element; the caller must keep it retained for the
/// duration of this call. Blocking: performs one CGWindowList enumeration and
/// bounded AX reads. Call from a blocking context immediately before deciding.
pub fn gather_background_facts(
    pid: i32,
    window_id: u32,
    element_ptr: Option<usize>,
) -> BackgroundTargetFacts {
    let window_server = match resolve_window_owner(pid, window_id) {
        WindowOwner::SamePid => WindowServerOwnership::SamePid,
        WindowOwner::Unknown => WindowServerOwnership::NotFound,
        WindowOwner::ForeignPid { owner_pid, .. } => {
            WindowServerOwnership::ForeignPid { owner_pid }
        }
    };

    // SAFETY: the application element is created and released here; window
    // elements are released inside ax_window_records; the caller guarantees
    // element_ptr stays retained.
    let (records, app_hidden, element) = unsafe {
        let app = AXUIElementCreateApplication(pid);
        if app.is_null() {
            (
                Vec::new(),
                None,
                element_ptr.map(|_| ElementAncestry::Unproven),
            )
        } else {
            let _ = AXUIElementSetMessagingTimeout(app, 0.1);
            // Electron/Chromium apps may need per-process-lifetime enablement
            // before their AX windows and subtrees are materialized.
            super::enablement::ensure_chromium_ax_enabled(pid, app, None);
            let records = ax_window_records(app, pid, window_id);
            let app_hidden = copy_bool_attr(app, "AXHidden");
            let element = element_ptr.map(|ptr| match element_window_id(ptr as AXUIElementRef) {
                Some(id) if id == window_id => ElementAncestry::ProvenDescendant,
                _ if is_app_menu(ptr as AXUIElementRef, app, pid, window_id) => {
                    ElementAncestry::ProvenAppMenu
                }
                Some(_) => ElementAncestry::OutsideTargetWindow,
                None => ElementAncestry::Unproven,
            });
            CFRelease(app as CFTypeRef);
            (records, app_hidden, element)
        }
    };

    let target = records.iter().find(|record| record.window_id == window_id);
    let competing_keyboard_destinations = count_competing_keyboard_destinations(
        pid,
        window_id,
        all_windows()
            .iter()
            .map(|window| (window.pid, window.window_id)),
        &records,
    );

    BackgroundTargetFacts {
        window_server,
        ax_window_present: target.is_some(),
        target_minimized: target.and_then(|record| record.minimized),
        app_hidden,
        competing_keyboard_destinations,
        keyboard_focus_matches_target: keyboard_focus_matches_target(pid, window_id),
        element: element.unwrap_or(ElementAncestry::NotAddressed),
    }
}

#[cfg(test)]
mod tests {
    use super::{attached_sheet_record, count_competing_keyboard_destinations, AxWindowRecord};

    fn ax_window(window_id: u32, minimized: Option<bool>) -> AxWindowRecord {
        AxWindowRecord {
            window_id,
            minimized,
        }
    }

    #[test]
    fn mapped_sheet_inherits_only_its_proven_roots_minimized_state() {
        for minimized in [Some(false), Some(true), None] {
            let records = [ax_window(10, minimized), ax_window(20, Some(false))];
            let sheet = attached_sheet_record(Some(11), Some(10), &records).unwrap();
            assert_eq!(sheet.window_id, 11);
            assert_eq!(sheet.minimized, minimized);
        }
    }

    #[test]
    fn unmapped_or_duplicate_sheet_cannot_add_a_target() {
        let records = [ax_window(10, Some(false))];
        for (window, root) in [
            (None, Some(10)),
            (Some(11), None),
            (Some(11), Some(99)),
            (Some(10), Some(10)),
        ] {
            assert!(attached_sheet_record(window, root, &records).is_none());
        }
    }

    #[test]
    fn compositor_surfaces_do_not_create_keyboard_ambiguity() {
        let rows = [(42, 10), (42, 11), (42, 12), (42, 13), (42, 14), (42, 15)];
        let records = [ax_window(10, Some(false))];

        assert_eq!(
            count_competing_keyboard_destinations(42, 10, rows, &records),
            0
        );
    }

    #[test]
    fn independently_mapped_sibling_remains_ambiguous() {
        let rows = [(42, 10), (42, 11)];
        let records = [ax_window(10, Some(false)), ax_window(11, Some(false))];

        assert_eq!(
            count_competing_keyboard_destinations(42, 10, rows, &records),
            1
        );
    }

    #[test]
    fn minimized_mapped_sibling_is_not_a_keyboard_destination() {
        let rows = [(42, 10), (42, 11)];
        let records = [ax_window(10, Some(false)), ax_window(11, Some(true))];

        assert_eq!(
            count_competing_keyboard_destinations(42, 10, rows, &records),
            0
        );
    }

    #[test]
    fn unmapped_window_server_sibling_is_not_a_keyboard_destination() {
        let rows = [(42, 10), (42, 99), (7, 11)];
        let records = [ax_window(10, Some(false)), ax_window(11, Some(false))];

        assert_eq!(
            count_competing_keyboard_destinations(42, 10, rows, &records),
            0
        );
    }
}
