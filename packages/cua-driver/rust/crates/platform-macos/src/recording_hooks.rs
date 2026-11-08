//! Recording callbacks exposed to `cua_driver_core::recording`.
//!
//! Two hooks live here:
//!  - `app_state_json_for` — produces `app_state.json` bytes for a turn folder.
//!  - `element_window_local_xy` — resolves `element_index` to a click point in
//!    window-local screenshot-pixel coordinates so `click.png` is also written
//!    on AX-indexed clicks (not just pixel-addressed ones).
//!
//! The element-bounds resolver uses the snapshot bound to the recorded action,
//! so a concurrent observation cannot replace the element used for its marker.

use crate::ax::bindings::{element_screen_center, AXUIElementRef};

/// Build `app_state.json` bytes for the turn folder. Walks the AX tree for
/// (pid, window_id) and emits the same shape `get_window_state` returns
/// (minus screenshot fields — those live in `screenshot.png`).
pub fn app_state_json_for(window_id: Option<u64>, pid: Option<i64>) -> Option<Vec<u8>> {
    let pid = i32::try_from(pid?).ok()?;
    let resolved_wid = match window_id {
        Some(w) => u32::try_from(w).ok()?,
        None => crate::windows::resolve_main_window_id(pid).ok()?,
    };
    let started = std::time::Instant::now();
    let result = crate::ax::tree::walk_tree_for_recording(
        pid,
        resolved_wid,
        cua_driver_core::recording::RECORDING_AX_WALK_BUDGET,
    );
    recording_tree_json(pid, resolved_wid, result, started)
}

fn recording_tree_json(
    pid: i32,
    window_id: u32,
    result: crate::ax::tree::TreeWalkResult,
    started: std::time::Instant,
) -> Option<Vec<u8>> {
    // Recording consumes the walk's extra native retains without publishing IDs.
    let _bindings = crate::ax::cache::ElementCache::prepare(&result.nodes);
    let element_count = result
        .nodes
        .iter()
        .filter(|n| n.element_index.is_some())
        .count();
    let payload = serde_json::json!({
        "pid": pid,
        "window_id": window_id,
        "element_count": element_count,
        "tree_markdown": result.tree_markdown,
        "truncated": result.truncated,
        "read_complete": result.read_complete,
        "incomplete_notes": result.incomplete_notes,
        "walk_elapsed_ms": started.elapsed().as_millis(),
    });
    serde_json::to_vec_pretty(&payload).ok()
}

/// Resolve `element_index` to window-local screenshot-pixel coords for
/// (pid, window_id). `element_screen_center` returns SCREEN points; convert
/// by subtracting the window's screen origin and multiplying by the
/// screenshot's pixels-per-point scale.
pub fn element_window_local_xy(
    window_id: u64,
    pid: i64,
    element_index: u32,
    binding: &cua_driver_core::element_token::SnapshotBinding,
) -> Option<(f64, f64)> {
    let cache = crate::ax::cache::BoundElementCache::from_binding(binding.clone());
    let pid_i32 = i32::try_from(pid).ok()?;
    let window_id_u32 = u32::try_from(window_id).ok()?;
    // Retain so a concurrent get_window_state can't free the element between
    // the lookup and element_screen_center (use-after-free → daemon crash).
    let element = cache.get_element_retained(pid_i32, window_id_u32, element_index as usize)?;
    let (sx, sy) = unsafe { element_screen_center(element.as_ptr() as AXUIElementRef)? };

    // Same frame resolution the pixel action rungs use (origin + Retina scale
    // measured off the capture), so a recording marker can never disagree with
    // the click it is annotating. `None` when the window has no live frame —
    // this hook is best-effort and simply records no coordinates then.
    let frame = crate::tools::px_frame::resolve_window_px_frame(window_id_u32).ok()?;
    let wx = (sx - frame.bounds.x) * frame.scale;
    let wy = (sy - frame.bounds.y) * frame.scale;
    Some((wx, wy))
}

#[cfg(test)]
mod tests {
    use super::recording_tree_json;
    use crate::ax::tree::{AXNode, TreeWalkResult};
    use core_foundation::base::{CFGetRetainCount, CFRetain, CFTypeRef, TCFType};
    use core_foundation::string::CFString;
    use std::time::Instant;

    fn tree(nodes: Vec<AXNode>, partial: bool) -> TreeWalkResult {
        TreeWalkResult {
            nodes,
            tree_markdown: "recording fixture".into(),
            complete: !partial,
            read_complete: !partial,
            incomplete_notes: if partial {
                vec!["fixture timeout".into()]
            } else {
                vec![]
            },
            truncated: partial,
            window_scope: None,
        }
    }

    #[test]
    fn complete_and_partial_recordings_release_actionable_retains_without_replacing_tokens() {
        let pid = 9_802_601;
        let window = 501;
        let registry = cua_driver_core::element_token::global();
        let snapshot = registry.register_snapshot(pid, window, 1);
        let token = cua_driver_core::element_token::token_for(snapshot, 0);
        for partial in [false, true] {
            let value = CFString::new("owned recording reference fixture with a heap allocation");
            let ptr = value.as_concrete_TypeRef() as CFTypeRef;
            let baseline = unsafe { CFGetRetainCount(ptr) };
            unsafe { CFRetain(ptr) };
            let nodes = vec![AXNode {
                element_index: Some(0),
                element_ptr: ptr as usize,
                ..Default::default()
            }];
            let bytes =
                recording_tree_json(pid, window, tree(nodes, partial), Instant::now()).unwrap();
            let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(unsafe { CFGetRetainCount(ptr) }, baseline);
            assert_eq!(payload["element_count"], 1);
            assert_eq!(payload["truncated"], partial);
            assert_eq!(payload["read_complete"], !partial);
            assert_eq!(registry.resolve(pid, &token), Ok((window, 0)));
        }
        registry.clear_pid(pid);
    }

    #[test]
    fn display_nodes_do_not_transfer_an_unowned_reference() {
        let value = CFString::new("unindexed recording fixture with a separate heap allocation");
        let ptr = value.as_concrete_TypeRef() as CFTypeRef;
        let baseline = unsafe { CFGetRetainCount(ptr) };
        let nodes = vec![AXNode {
            element_ptr: ptr as usize,
            ..Default::default()
        }];
        let bytes = recording_tree_json(101, 501, tree(nodes, false), Instant::now()).unwrap();
        assert_eq!(unsafe { CFGetRetainCount(ptr) }, baseline);
        let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(payload["element_count"], 0);
    }

    #[test]
    fn empty_recording_keeps_its_metadata() {
        let bytes = recording_tree_json(101, 501, tree(vec![], false), Instant::now()).unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(payload["pid"], 101);
        assert_eq!(payload["window_id"], 501);
        assert_eq!(payload["element_count"], 0);
        assert_eq!(payload["tree_markdown"], "recording fixture");
        assert_eq!(payload["read_complete"], true);
    }
}
