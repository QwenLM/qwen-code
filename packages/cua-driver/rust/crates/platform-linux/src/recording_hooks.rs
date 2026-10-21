//! Application-state snapshots used by trajectory recording on Linux.

#[cfg(target_os = "linux")]
pub fn app_state_json_for(window_id: Option<u64>, pid: Option<i64>) -> Option<Vec<u8>> {
    if tokio::runtime::Handle::try_current().is_ok() {
        return std::thread::spawn(move || app_state_json_for_blocking(window_id, pid))
            .join()
            .ok()
            .flatten();
    }
    app_state_json_for_blocking(window_id, pid)
}

#[cfg(target_os = "linux")]
fn app_state_json_for_blocking(window_id: Option<u64>, pid: Option<i64>) -> Option<Vec<u8>> {
    let pid = u32::try_from(pid?).ok()?;
    let window_id = { resolve_window_for_recording(pid, window_id)?.xid };
    let result = { crate::atspi::walk_tree(pid, window_id, None) };
    if result.nodes.is_empty() || result.tree_markdown.trim().is_empty() {
        return None;
    }
    let element_count = result
        .nodes
        .iter()
        .filter(|node| node.element_index.is_some())
        .count();
    let payload = serde_json::json!({
        "pid": pid,
        "window_id": window_id,
        "element_count": element_count,
        "tree_markdown": result.tree_markdown,
    });
    serde_json::to_vec_pretty(&payload).ok()
}

#[cfg(target_os = "linux")]
pub fn screenshot_for_recording(window_id: Option<u64>, pid: Option<i64>) -> Option<Vec<u8>> {
    if let Some(window_id) = window_id {
        crate::capture::screenshot_window_bytes(window_id).ok()
    } else if let Some(pid) = pid.and_then(|pid| u32::try_from(pid).ok()) {
        let windows = crate::x11::list_windows(Some(pid));
        windows
            .first()
            .and_then(|window| crate::capture::screenshot_window_bytes(window.xid).ok())
    } else {
        crate::capture::screenshot_display_bytes().ok()
    }
}

#[cfg(target_os = "linux")]
pub fn element_window_local_xy(
    window_id: u64,
    pid: i64,
    element_index: u32,
    binding: &cua_driver_core::element_token::SnapshotBinding,
) -> Option<(f64, f64)> {
    let binding = binding.clone();
    if tokio::runtime::Handle::try_current().is_ok() {
        return std::thread::spawn(move || {
            element_window_local_xy_blocking(window_id, pid, element_index, &binding)
        })
        .join()
        .ok()
        .flatten();
    }
    element_window_local_xy_blocking(window_id, pid, element_index, &binding)
}

#[cfg(target_os = "linux")]
fn element_window_local_xy_blocking(
    window_id: u64,
    pid: i64,
    element_index: u32,
    binding: &cua_driver_core::element_token::SnapshotBinding,
) -> Option<(f64, f64)> {
    let pid = u32::try_from(pid).ok()?;
    let cache = crate::atspi::cache::BoundElementCache::from_binding(binding.clone());
    let identity = cache.get_element_identity(pid, window_id, element_index as usize)?;
    let (screen_x, screen_y, width, height) =
        crate::atspi::get_element_bounds_exact(pid, element_index as usize, identity).ok()?;
    let window = resolve_window_for_recording(pid, Some(window_id))?;
    Some((
        f64::from(screen_x - window.x) + f64::from(width) / 2.0,
        f64::from(screen_y - window.y) + f64::from(height) / 2.0,
    ))
}

#[cfg(target_os = "linux")]
fn resolve_window_for_recording(
    pid: u32,
    window_id: Option<u64>,
) -> Option<crate::x11::WindowInfo> {
    let windows = crate::x11::list_windows(Some(pid));
    if let Some(window_id) = window_id {
        windows.into_iter().find(|window| window.xid == window_id)
    } else {
        windows.into_iter().next()
    }
}

#[cfg(not(target_os = "linux"))]
pub fn app_state_json_for(_window_id: Option<u64>, _pid: Option<i64>) -> Option<Vec<u8>> {
    None
}

#[cfg(not(target_os = "linux"))]
pub fn screenshot_for_recording(_window_id: Option<u64>, _pid: Option<i64>) -> Option<Vec<u8>> {
    None
}

#[cfg(not(target_os = "linux"))]
pub fn element_window_local_xy(
    _window_id: u64,
    _pid: i64,
    _element_index: u32,
    _binding: &cua_driver_core::element_token::SnapshotBinding,
) -> Option<(f64, f64)> {
    None
}
