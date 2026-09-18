//! Discover directly attached sheets without walking each window's controls.

use core_foundation::base::{CFEqual, CFRelease, CFTypeRef};
use std::time::{Duration, Instant};

use super::bindings::*;
use super::tree::AXIdentity;

pub struct AttachedSheet {
    pub element: AXIdentity,
    pub window_id: Option<u32>,
    pub root_window_id: Option<u32>,
}

/// The roots remain borrowed; each returned sheet owns its AX retain.
/// Incomplete discovery must not establish a unique target or capture geometry.
pub unsafe fn copy_attached_sheets(roots: &[AXUIElementRef]) -> (Vec<AttachedSheet>, bool) {
    let deadline = Instant::now() + Duration::from_millis(500);
    let mut sheets: Vec<AttachedSheet> = Vec::new();
    let mut queue = Vec::new();
    let mut complete = true;
    for &root in roots {
        if Instant::now() >= deadline || queue.len() >= 64 {
            complete = false;
            break;
        }
        let _ = AXUIElementSetMessagingTimeout(root, 0.1);
        let role = copy_string_attr_with_status(root, "AXRole");
        complete &= role.complete && role.value.is_some();
        if matches!(role.value.as_deref(), Some("AXWindow" | "AXSheet"))
            && !queue
                .iter()
                .any(|&(seen, _)| CFEqual(seen as CFTypeRef, root as CFTypeRef) != 0)
        {
            queue.push((root, ax_get_window_id(root)));
        }
    }
    let mut cursor = 0;
    let mut read_children = 0;
    while cursor < queue.len() {
        if Instant::now() >= deadline || queue.len() > 64 || read_children >= 512 {
            complete = false;
            break;
        }
        let (parent, root_window_id) = queue[cursor];
        cursor += 1;
        let children = copy_children_with_status(parent);
        complete &= children.complete;
        for child in children.elements {
            read_children += 1;
            if Instant::now() >= deadline || read_children > 512 {
                complete = false;
                CFRelease(child as CFTypeRef);
                continue;
            }
            let _ = AXUIElementSetMessagingTimeout(child, 0.1);
            let role = copy_string_attr_with_status(child, "AXRole");
            complete &= role.complete && role.value.is_some();
            if role.value.as_deref() == Some("AXSheet")
                && !sheets.iter().any(|sheet| {
                    CFEqual(sheet.element.as_ptr() as CFTypeRef, child as CFTypeRef) != 0
                })
            {
                sheets.push(AttachedSheet {
                    element: AXIdentity::retained(child),
                    window_id: ax_get_window_id(child),
                    root_window_id,
                });
                if !queue
                    .iter()
                    .any(|&(seen, _)| CFEqual(seen as CFTypeRef, child as CFTypeRef) != 0)
                {
                    queue.push((child, root_window_id));
                }
            }
            CFRelease(child as CFTypeRef);
        }
    }
    if !complete {
        note_incomplete(
            "AXSheet discovery",
            "attachment reads incomplete or bounded",
        );
    }
    (sheets, complete)
}

/// Read-only classification for capture. Ordinary windows keep their existing
/// capture path; only proven attached groups select display-relative cropping.
pub fn window_is_in_attached_group(pid: i32, window_id: u32) -> anyhow::Result<bool> {
    unsafe {
        let app = AXUIElementCreateApplication(pid);
        if app.is_null() {
            anyhow::bail!("could not read AX application for capture group classification");
        }
        let _ = AXUIElementSetMessagingTimeout(app, 0.1);
        let roots_read = copy_ax_windows_with_status(app);
        let roots = roots_read.elements;
        let (sheets, complete) = copy_attached_sheets(&roots);
        let grouped = complete
            && (sheets.iter().any(|sheet| {
                sheet.window_id == Some(window_id) || sheet.root_window_id == Some(window_id)
            }) || roots.iter().any(|&root| {
                ax_get_window_id(root) == Some(window_id)
                    && copy_string_attr(root, "AXRole").as_deref() == Some("AXSheet")
            }));
        for root in roots {
            CFRelease(root as CFTypeRef);
        }
        CFRelease(app as CFTypeRef);
        if !roots_read.complete || !complete {
            anyhow::bail!("could not completely read attached window groups");
        }
        Ok(grouped)
    }
}
