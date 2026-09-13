//! Bounded, read-only dialog identities for PID-scoped window discovery.

use core_foundation::base::{CFRelease, CFTypeRef};
use std::collections::HashSet;
use std::time::{Duration, Instant};

use super::bindings::*;

fn is_dialog(role: Option<&str>, subrole: Option<&str>, modal: Option<bool>) -> bool {
    role == Some("AXSheet")
        || (role == Some("AXWindow")
            && (matches!(subrole, Some("AXDialog" | "AXSystemDialog")) || modal == Some(true)))
}

pub(crate) fn dialog_window_ids(pid: i32) -> HashSet<u32> {
    let mut ids = HashSet::new();
    let deadline = Instant::now() + Duration::from_millis(500);
    unsafe {
        let app = AXUIElementCreateApplication(pid);
        if app.is_null() {
            return ids;
        }
        let _ = AXUIElementSetMessagingTimeout(app, 0.1);
        let roots = copy_ax_windows_with_status(app);
        CFRelease(app as CFTypeRef);
        if roots.complete {
            for &root in roots.elements.iter().take(64) {
                if Instant::now() >= deadline {
                    break;
                }
                let _ = AXUIElementSetMessagingTimeout(root, 0.1);
                let role = copy_string_attr(root, "AXRole");
                if !matches!(role.as_deref(), Some("AXWindow" | "AXSheet")) {
                    continue;
                }
                if Instant::now() >= deadline {
                    break;
                }
                let subrole = copy_string_attr(root, "AXSubrole");
                let modal = if !is_dialog(role.as_deref(), subrole.as_deref(), None)
                    && Instant::now() < deadline
                {
                    copy_bool_attr(root, "AXModal")
                } else {
                    None
                };
                if is_dialog(role.as_deref(), subrole.as_deref(), modal)
                    && Instant::now() < deadline
                {
                    if let Some(id) = ax_get_window_id(root) {
                        ids.insert(id);
                    }
                }
            }
        }
        for root in roots.elements {
            CFRelease(root as CFTypeRef);
        }
    }
    ids
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admission_requires_positive_window_dialog_evidence() {
        assert!(is_dialog(Some("AXWindow"), Some("AXDialog"), Some(true)));
        assert!(is_dialog(Some("AXWindow"), Some("AXSystemDialog"), None));
        assert!(is_dialog(
            Some("AXWindow"),
            Some("AXStandardWindow"),
            Some(true)
        ));
        assert!(is_dialog(Some("AXSheet"), None, None));
        assert!(!is_dialog(
            Some("AXWindow"),
            Some("AXStandardWindow"),
            Some(false)
        ));
        assert!(!is_dialog(Some("AXWindow"), None, None));
        assert!(!is_dialog(Some("AXMenu"), Some("AXDialog"), Some(true)));
        assert!(!is_dialog(None, Some("AXDialog"), Some(true)));
    }
}
