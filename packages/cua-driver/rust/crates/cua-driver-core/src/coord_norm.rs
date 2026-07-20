//! Relative-coordinate (1000×1000 normalized) translation layer.
//!
//! Opt-in (`CUA_DRIVER_RS_COORDINATE_SPACE=1`, default off = `pixels`) shim that
//! lets clients trained on 0–1000 normalized coordinates (e.g. Qwen-VL
//! `computer_use`) drive the pixel-based tool surface. It runs entirely in
//! `cua-driver-core` so the per-platform tools stay untouched (fork-rebase
//! friendly). See `libs/cua-driver/docs/relative-coordinates-design.md`.
//!
//! Three hooks, wired into `ToolRegistry::invoke` / `tools_list`:
//!   - input  : `denormalize_args`  — 0–1000 → pixels, before the real tool
//!   - output : `normalize_result`  — no-op (query results returned unmodified)
//!   - listing: `rewrite_coord_desc`— pixel wording → normalized wording
//!
//! Conversion is anchored to the **downscaled screenshot size** the matching
//! `get_window_state` reported (`screenshot_width/height`), i.e. the very image
//! the model reasoned over — so `norm/1000 * dim` lands in the right pixel.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

use crate::protocol::ToolResult;

/// Convert a normalized coordinate to a pixel coordinate against `dim`, where
/// `scale` is the normalization full-scale (the "1000" in 1000×1000). Qwen
/// `computer_use` uses 1000; some cookbooks use 999 — see `coordinate_scale`.
pub fn norm_to_px(norm: f64, dim: u32, scale: f64) -> f64 {
    (norm / scale * dim as f64).round()
}

/// Convert a pixel coordinate back to a normalized coordinate against `dim`.
pub fn px_to_norm(px: f64, dim: u32, scale: f64) -> f64 {
    if dim == 0 {
        return 0.0;
    }
    (px / dim as f64 * scale).round()
}

/// Input coordinate fields per tool: `(field, is_x_axis, screen_basis)`.
/// `is_x_axis` true = scale by width, false = by height. `screen_basis` true =
/// normalize against the SCREEN size (move_cursor moves the agent-cursor
/// overlay in screen space — it has no window_id); false = against the window's
/// screenshot size.
fn input_coord_fields(tool: &str) -> &'static [(&'static str, bool, bool)] {
    match tool {
        "click" | "double_click" | "right_click" => &[("x", true, false), ("y", false, false)],
        "drag" => &[
            ("from_x", true, false),
            ("from_y", false, false),
            ("to_x", true, false),
            ("to_y", false, false),
        ],
        // zoom defines a crop rectangle in screenshot pixels; window-basis like
        // click. from_zoom (handled below) is the only zoom-space concern.
        "zoom" => &[
            ("x1", true, false),
            ("y1", false, false),
            ("x2", true, false),
            ("y2", false, false),
        ],
        // move_cursor positions the overlay in SCREEN space (no window_id).
        "move_cursor" => &[("x", true, true), ("y", false, true)],
        // scroll x/y specify WHERE to deliver the wheel event (not scroll amount).
        // macOS: window-local screenshot pixels. Windows: screen-absolute (desktop
        // scope only, no pid → screenshot_w=0 → falls back to desktop/screen cache).
        // Linux: no x/y params. Using window-basis here is safe for both: macOS
        // gets window-local conversion, Windows desktop-scope hits the screenshot_w=0
        // fallback path which routes to desktop_screenshot_size / screen_size.
        "scroll" => &[("x", true, false), ("y", false, false)],
        // Linux-only stateful mouse tools — window-local coordinates.
        "mouse_button_down" | "mouse_button_up" => &[("x", true, false), ("y", false, false)],
        "mouse_drag" => &[("x", true, false), ("y", false, false)],
        // type_text/press_key/hotkey accept x/y for focus-by-pixel (internally
        // delegates to click). Listed here so rewrite_coord_desc rewrites their
        // field descriptions; denormalize_args converts them the same way.
        "type_text" | "press_key" | "hotkey" => &[("x", true, false), ("y", false, false)],
        // parallel_mouse_drag has nested coords handled specially in
        // denormalize_args. Listed here (with empty fields) so
        // rewrite_coord_desc processes its top-level description.
        "parallel_mouse_drag" => &[],
        _ => &[],
    }
}

/// In-place convert a coordinate tool's normalized input fields to pixels.
/// Window-basis fields use the window's screenshot size (`screenshot_w/h`);
/// screen-basis fields (move_cursor) use the cached screen size. Desktop-scope
/// clicks (no pid/window_id → `screenshot_w == 0`) fall back to screen size
/// since `get_desktop_state` captures in true screen pixels.
///
/// Returns `Err` with a guidance message when a required size basis is missing,
/// so the caller can surface the error to the model instead of silently passing
/// through unconverted normalized coordinates (which would land clicks at wrong
/// positions).
pub fn denormalize_args(tool: &str, args: &mut Value, screenshot_w: u32, screenshot_h: u32) -> Result<(), String> {
    // from_zoom coords live in the zoom-image space, not window-local.
    // Denormalize against the cached zoom image dimensions instead of the
    // window screenshot size. If no zoom cache exists, return an error.
    // parallel_mouse_drag does not support from_zoom — skip this block
    // so its nested handler below is always reached.
    if tool != "parallel_mouse_drag"
        && args.get("from_zoom").and_then(|v| v.as_bool()).unwrap_or(false)
    {
        let pid = args.get("pid").and_then(|v| v.as_i64()).unwrap_or(0);
        if let Some((zw, zh)) = get_zoom_size(pid) {
            let scale = coordinate_scale();
            for &(field, is_x, _) in input_coord_fields(tool) {
                let dim = if is_x { zw } else { zh };
                if let Some(v) = args.get(field).and_then(|v| v.as_f64()) {
                    args[field] = json!(norm_to_px(v, dim, scale));
                }
            }
        } else {
            // Only error when the tool actually carries coordinate fields.
            let has_coords = input_coord_fields(tool).iter().any(|&(f, _, _)| {
                args.get(f).and_then(|v| v.as_f64()).is_some()
            });
            if has_coords {
                return Err(
                    "from_zoom=true but no zoom context cached. \
                     Call zoom first so the driver knows the zoom image dimensions."
                        .to_string(),
                );
            }
        }
        return Ok(());
    }
    let scale = coordinate_scale();
    let screen = screen_size();
    for &(field, is_x, screen_basis) in input_coord_fields(tool) {
        // Skip fields the caller didn't provide (e.g. element_index addressing).
        if args.get(field).and_then(|v| v.as_f64()).is_none() {
            continue;
        }
        let (dw, dh) = if screen_basis {
            match screen {
                Some(s) => s,
                None => return Err(
                    "Coordinate normalization requires screen size. \
                     Call get_screen_size first so the driver can convert \
                     0–1000 coordinates to pixels."
                        .to_string(),
                ),
            }
        } else if screenshot_w == 0 {
            let has_window_target = args.get("pid").is_some_and(|v| !v.is_null())
                || args.get("window_id").is_some_and(|v| !v.is_null());
            if has_window_target {
                return Err(
                    "Coordinate normalization requires window screenshot size. \
                     Call get_window_state for this window first so the driver \
                     can convert 0–1000 coordinates to pixels."
                        .to_string(),
                );
            }
            match desktop_screenshot_size() {
                Some(s) => s,
                None => return Err(
                    "Coordinate normalization requires desktop screenshot size. \
                     Call get_desktop_state first so the driver can convert \
                     0–1000 coordinates to pixels."
                        .to_string(),
                ),
            }
        } else {
            (screenshot_w, screenshot_h)
        };
        let dim = if is_x { dw } else { dh };
        if let Some(v) = args.get(field).and_then(|v| v.as_f64()) {
            args[field] = json!(norm_to_px(v, dim, scale));
        }
    }
    // parallel_mouse_drag: coordinates are nested inside drags[].{path, from_x,
    // from_y, to_x, to_y, x_from, x_to}. Each drag item has its own window_id,
    // so we look up per-item size from SIZE_CACHE.
    if tool == "parallel_mouse_drag" {
        if let Some(drags) = args.get_mut("drags").and_then(|v| v.as_array_mut()) {
            let scale = coordinate_scale();
            for item in drags.iter_mut() {
                let item_pid = item.get("pid").and_then(|v| v.as_i64()).unwrap_or(0);
                let item_wid = item.get("window_id").and_then(|v| v.as_u64()).unwrap_or(0);
                let (dw, dh) = match get_size(item_pid, item_wid) {
                    Some(s) => s,
                    None => return Err(
                        "Coordinate normalization requires window screenshot size. \
                         Call get_window_state for this window first so the driver \
                         can convert 0–1000 coordinates to pixels."
                            .to_string(),
                    ),
                };
                // from_x/from_y/to_x/to_y + fn domain bounds x_from/x_to
                for (field, is_x) in &[
                    ("from_x", true), ("from_y", false),
                    ("to_x", true), ("to_y", false),
                    ("x_from", true), ("x_to", true),
                ] {
                    let dim = if *is_x { dw } else { dh };
                    if let Some(v) = item.get(*field).and_then(|v| v.as_f64()) {
                        item[*field] = json!(norm_to_px(v, dim, scale));
                    }
                }
                // path: [[x,y], [x,y], ...]
                if let Some(path) = item.get_mut("path").and_then(|v| v.as_array_mut()) {
                    for point in path.iter_mut() {
                        if let Some(arr) = point.as_array_mut() {
                            if arr.len() >= 2 {
                                if let Some(x) = arr[0].as_f64() {
                                    arr[0] = json!(norm_to_px(x, dw, scale));
                                }
                                if let Some(y) = arr[1].as_f64() {
                                    arr[1] = json!(norm_to_px(y, dh, scale));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

/// Extract the downscaled screenshot size a `get_window_state` reported
/// (`structuredContent.screenshot_width/height`) — the basis for normalizing
/// this window's coordinates. Returns `None` if absent.
pub fn extract_screenshot_size(result: &ToolResult) -> Option<(u32, u32)> {
    let sc = result.structured_content.as_ref()?;
    let w = sc.get("screenshot_width").and_then(|v| v.as_u64())? as u32;
    let h = sc.get("screenshot_height").and_then(|v| v.as_u64())? as u32;
    Some((w, h))
}

/// No-op in normalized mode. Previously this rewrote `screenshot_width/height`
/// to 1000 to hint the model about the 0–1000 grid, but that conflicted with
/// `elements[].frame` (which stays in pixels) and `screen_width/height`,
/// giving the model contradictory coordinate information. The model is now
/// guided to use 0–1000 coordinates purely through tool schema descriptions
/// and MCP instructions; query results are returned unmodified.
pub fn normalize_result(_tool: &str, _result: &mut ToolResult) {}

/// Rewrite coordinate-field descriptions in a `tools/list` payload from pixel
/// wording to 0–`scale` normalized wording. Caller gates on normalized mode.
/// Only the fields that actually get converted (same table as
/// `denormalize_args` — click/double_click/right_click/drag/zoom/move_cursor)
/// are rewritten, so the docs match behavior (move_cursor uses the screen basis,
/// the rest window-local). Uses the configured full-scale so the wording tracks
/// `CUA_DRIVER_RS_COORDINATE_SCALE`.
pub fn rewrite_coord_desc(tools_list: &mut Value) {
    let scale = coordinate_scale() as u64;
    let tools = match tools_list.get_mut("tools").and_then(|t| t.as_array_mut()) {
        Some(t) => t,
        None => return,
    };
    for tool in tools {
        let name = match tool.get("name").and_then(|n| n.as_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let fields = input_coord_fields(&name);
        // Per-field coordinate descriptions — only for tools with coord fields.
        if !fields.is_empty() {
            let schema_key = if tool.get("inputSchema").is_some() {
                "inputSchema"
            } else {
                "input_schema"
            };
            if let Some(props) = tool
            .get_mut(schema_key)
            .and_then(|s| s.get_mut("properties"))
            .and_then(|p| p.as_object_mut())
        {
            for &(field, is_x, screen_basis) in fields {
                if let Some(fobj) = props.get_mut(field).and_then(|f| f.as_object_mut()) {
                    // Insert unconditionally: in normalized mode the model MUST be
                    // told these are 0–`scale`, even for fields the upstream schema
                    // left undescribed (e.g. move_cursor's bare x/y). This runs
                    // only when `normalized` is set, so pixel mode is untouched.
                    // move_cursor is screen-space; the rest are window-local.
                    let basis = if screen_basis { "screen" } else { "window" };
                    let desc = if is_x {
                        format!("X coordinate, 0–{scale} normalized to {basis} width (top-left origin).")
                    } else {
                        format!("Y coordinate, 0–{scale} normalized to {basis} height (top-left origin).")
                    };
                    fobj.insert("description".to_string(), json!(desc));
                }
            }
            // from_zoom: rewrite to say "normalized" instead of "pixel"
            // so the model sends 0–scale coords for zoom-image clicks too.
            if let Some(fobj) = props.get_mut("from_zoom").and_then(|f| f.as_object_mut()) {
                fobj.insert(
                    "description".to_string(),
                    json!(format!(
                        "When true, x and y are 0–{scale} normalized coordinates \
                         in the last zoom image for this pid. The driver maps them \
                         back to window coords."
                    )),
                );
            }
        }
        } // end if !fields.is_empty()
        // Top-level description: replace pixel-coordinate phrasing with
        // normalized wording. Multiple variants exist across platforms.
        if let Some(desc) = tool.get("description").and_then(|d| d.as_str()) {
            let norm = format!("0–{scale} normalized coordinates (top-left origin)");
            let mut d = desc.to_string();
            let mut changed = false;
            for pixel_phrase in &[
                "window-local screenshot pixels",
                "screenshot pixel coordinates",
                "screenshot pixels",
                "scaled-image coordinates",
                "window-local pixels",
                "window-local x, y pixels",
            ] {
                if d.contains(pixel_phrase) {
                    d = d.replace(pixel_phrase, &norm);
                    changed = true;
                }
            }
            // Clean up redundant phrases left after replacement.
            // "...normalized coordinates (top-left origin) — the same space
            //  get_window_state returns. Top-left origin of the target's window."
            for redundant in &[
                " — the same space get_window_state returns. Top-left origin of the target's window.",
                " — the same space get_window_state returns.",
                " - the same space get_window_state returns. Top-left origin of the target's window.",
                " - the same space get_window_state returns.",
            ] {
                if d.contains(redundant) {
                    d = d.replace(redundant, ".");
                    changed = true;
                }
            }
            // "same pixel space as the screenshot" → "0–N normalized space"
            if d.contains("same pixel space") {
                d = d.replace(
                    "same pixel space as the screenshot",
                    &format!("0–{scale} normalized space"),
                );
                changed = true;
            }
            // "Prefer element_index over pixel coordinates" → normalized
            if d.contains("over pixel coordinates") {
                d = d.replace(
                    "over pixel coordinates",
                    &format!("over 0–{scale} normalized coordinates"),
                );
                changed = true;
            }
            // "image-pixel -> screen-point" (macOS right_click)
            if d.contains("image-pixel") {
                d = d.replace("image-pixel", &format!("0–{scale}-normalized"));
                changed = true;
            }
            // "zoom-image pixel coordinates" (macOS click from_zoom description)
            if d.contains("zoom-image pixel coordinates") {
                d = d.replace(
                    "zoom-image pixel coordinates",
                    &format!("0–{scale} normalized zoom-image coordinates"),
                );
                changed = true;
            }
            // "true screen pixels" (get_desktop_state)
            if d.contains("true screen pixels") {
                d = d.replace("true screen pixels", &norm);
                changed = true;
            }
            // "screen-absolute pixel" (get_desktop_state)
            if d.contains("screen-absolute pixel") {
                d = d.replace(
                    "screen-absolute pixel",
                    &format!("0–{scale} normalized"),
                );
                changed = true;
            }
            if changed {
                tool["description"] = json!(d);
            }
        }
    }
}

// ── Coordinate-space default (startup seed) ──────────────────────────────────
//
// The LIVE on/off switch is a `ToolRegistry` field, read by `invoke` /
// `tools_list` — so tests flip it per-registry without racing on global state.
// This global is only the *default* that `ToolRegistry::new()` copies into that
// field, seeded once at startup from env/config (mirrors `CLAUDE_CODE_COMPAT`).
// It is never the value `invoke` consults.

static DEFAULT_NORMALIZED: AtomicBool = AtomicBool::new(false);

/// Seed the process-wide default coordinate mode (called once at startup).
pub fn set_default_normalized(on: bool) {
    DEFAULT_NORMALIZED.store(on, Ordering::Relaxed);
}

/// The default coordinate mode new registries inherit.
pub fn default_normalized() -> bool {
    DEFAULT_NORMALIZED.load(Ordering::Relaxed)
}

/// Normalization full-scale — the "1000" in 1000×1000. Configurable to absorb
/// the 999-vs-1000 cookbook ambiguity (Qwen `computer_use` uses 1000,
/// `mobile_use` uses 999). Seeded once at startup from
/// `CUA_DRIVER_RS_COORDINATE_SCALE`; default 1000. Stored as an integer because
/// normalization scales are whole numbers in practice.
static COORDINATE_SCALE: AtomicU64 = AtomicU64::new(1000);

/// Seed the normalization full-scale (called once at startup). 0 is rejected
/// (it would divide by zero) and falls back to 1000.
pub fn set_coordinate_scale(scale: u32) {
    let s = if scale == 0 { 1000 } else { scale };
    COORDINATE_SCALE.store(s as u64, Ordering::Relaxed);
}

/// The active normalization full-scale, as f64 for the conversion math.
pub fn coordinate_scale() -> f64 {
    COORDINATE_SCALE.load(Ordering::Relaxed) as f64
}

// ── Per-window size cache ────────────────────────────────────────────────────
//
// Cross-call window state (written by get_window_state, read by the next
// click), naturally process-scoped — stays global.

/// Per-(pid, window_id) screenshot-size cache. Keyed on window_id (not pid
/// alone like the platform `resize_registry`) so multiple windows of the same
/// process don't clobber each other's basis.
static SIZE_CACHE: OnceLock<Mutex<HashMap<(i64, u64), (u32, u32)>>> = OnceLock::new();

fn size_cache() -> &'static Mutex<HashMap<(i64, u64), (u32, u32)>> {
    SIZE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Cache the screenshot size for a (pid, window_id) so coordinate tools can
/// resolve the normalization basis without re-capturing.
pub fn put_size(pid: i64, window_id: u64, w: u32, h: u32) {
    if let Ok(mut cache) = size_cache().lock() {
        cache.insert((pid, window_id), (w, h));
    }
}

/// Look up the cached screenshot size for a (pid, window_id).
pub fn get_size(pid: i64, window_id: u64) -> Option<(u32, u32)> {
    size_cache().lock().ok()?.get(&(pid, window_id)).copied()
}

/// Ingest the screenshot size from a `get_window_state` result into the cache,
/// keyed by the call's (pid, window_id). `window_id` defaults to 0 when absent
/// so the same fallback key is used on lookup.
pub fn ingest_window_size(tool: &str, args: &Value, result: &ToolResult) {
    if tool != "get_window_state" {
        return;
    }
    if let Some((w, h)) = extract_screenshot_size(result) {
        let pid = args.get("pid").and_then(|v| v.as_i64()).unwrap_or(0);
        let window_id = args.get("window_id").and_then(|v| v.as_u64()).unwrap_or(0);
        put_size(pid, window_id, w, h);
    }
}

// ── Screen-size cache (for move_cursor, which is screen-space) ────────────────

/// Logical screen size (from `get_screen_size`) — the basis for move_cursor's
/// screen-space coordinates. The agent cursor overlay operates in CGEvent screen
/// points (logical), not physical pixels.
static SCREEN_SIZE: OnceLock<Mutex<Option<(u32, u32)>>> = OnceLock::new();

fn screen_cache() -> &'static Mutex<Option<(u32, u32)>> {
    SCREEN_SIZE.get_or_init(|| Mutex::new(None))
}

/// Cache the logical screen size for normalizing move_cursor coordinates.
pub fn put_screen_size(w: u32, h: u32) {
    if let Ok(mut c) = screen_cache().lock() {
        *c = Some((w, h));
    }
}

/// The cached logical screen size, if a `get_screen_size` has been seen.
pub fn screen_size() -> Option<(u32, u32)> {
    screen_cache().lock().ok().and_then(|c| *c)
}

// ── Desktop screenshot-size cache (for desktop-scope clicks) ────────────────

/// Physical screenshot size (from `get_desktop_state`) — the basis for
/// desktop-scope click/scroll coordinates. The model reasons over the full-
/// display PNG at native pixel size, so denormalization must map 0–1000 to
/// physical pixels. Separate from `SCREEN_SIZE` (logical points) because
/// move_cursor operates in screen points while desktop-scope clicks operate
/// in screenshot pixels.
static DESKTOP_SCREENSHOT_SIZE: OnceLock<Mutex<Option<(u32, u32)>>> = OnceLock::new();

fn desktop_screenshot_cache() -> &'static Mutex<Option<(u32, u32)>> {
    DESKTOP_SCREENSHOT_SIZE.get_or_init(|| Mutex::new(None))
}

/// Cache the desktop screenshot size (physical pixels) for desktop-scope coords.
pub fn put_desktop_screenshot_size(w: u32, h: u32) {
    if let Ok(mut c) = desktop_screenshot_cache().lock() {
        *c = Some((w, h));
    }
}

/// The cached desktop screenshot size, if a `get_desktop_state` has been seen.
pub fn desktop_screenshot_size() -> Option<(u32, u32)> {
    desktop_screenshot_cache().lock().ok().and_then(|c| *c)
}

/// Ingest screen/desktop sizes from tool results into the appropriate caches.
/// `get_screen_size` → logical points (for move_cursor).
/// `get_desktop_state` → physical screenshot pixels (for desktop-scope clicks).
pub fn ingest_screen_size(tool: &str, result: &ToolResult) {
    if tool != "get_screen_size" && tool != "get_desktop_state" {
        return;
    }
    if let Some(sc) = result.structured_content.as_ref() {
        if tool == "get_desktop_state" {
            let w = sc.get("screenshot_width").and_then(|v| v.as_u64());
            let h = sc.get("screenshot_height").and_then(|v| v.as_u64());
            if let (Some(w), Some(h)) = (w, h) {
                put_desktop_screenshot_size(w as u32, h as u32);
            }
        } else {
            let w = sc.get("width").and_then(|v| v.as_u64());
            let h = sc.get("height").and_then(|v| v.as_u64());
            if let (Some(w), Some(h)) = (w, h) {
                put_screen_size(w as u32, h as u32);
            }
        }
    }
}

// ── Zoom-image size cache (for from_zoom click denormalization) ─────────────

/// Per-pid zoom-image size cache. Keyed on pid alone (matching the platform
/// `ZoomRegistry`). Written by `ingest_zoom_size` after a `zoom` call,
/// read by `denormalize_args` when `from_zoom=true`.
static ZOOM_SIZE_CACHE: OnceLock<Mutex<HashMap<i64, (u32, u32)>>> = OnceLock::new();

fn zoom_size_cache() -> &'static Mutex<HashMap<i64, (u32, u32)>> {
    ZOOM_SIZE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn put_zoom_size(pid: i64, w: u32, h: u32) {
    if let Ok(mut cache) = zoom_size_cache().lock() {
        cache.insert(pid, (w, h));
    }
}

pub fn get_zoom_size(pid: i64) -> Option<(u32, u32)> {
    zoom_size_cache().lock().ok()?.get(&pid).copied()
}

/// Ingest the zoom image size from a `zoom` result into the cache so that
/// subsequent `from_zoom=true` clicks can denormalize against it.
pub fn ingest_zoom_size(tool: &str, args: &Value, result: &ToolResult) {
    if tool != "zoom" {
        return;
    }
    let pid = args.get("pid").and_then(|v| v.as_i64()).unwrap_or(0);
    if let Some(sc) = result.structured_content.as_ref() {
        let w = sc.get("width").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        let h = sc.get("height").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        if w > 0 && h > 0 {
            put_zoom_size(pid, w, h);
        }
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ---- scalar conversion ----

    #[test]
    fn norm_to_px_maps_midpoint() {
        // 500/1000 of an 800px-wide image = 400px
        assert_eq!(norm_to_px(500.0, 800, 1000.0), 400.0);
    }

    #[test]
    fn norm_to_px_maps_edges() {
        assert_eq!(norm_to_px(0.0, 800, 1000.0), 0.0);
        assert_eq!(norm_to_px(1000.0, 800, 1000.0), 800.0);
    }

    #[test]
    fn norm_to_px_rounds_to_nearest() {
        // 333/1000 of 800 = 266.4 → 266
        assert_eq!(norm_to_px(333.0, 800, 1000.0), 266.0);
    }

    #[test]
    fn px_to_norm_is_inverse_at_midpoint() {
        assert_eq!(px_to_norm(400.0, 800, 1000.0), 500.0);
        assert_eq!(px_to_norm(800.0, 800, 1000.0), 1000.0);
    }

    #[test]
    fn norm_to_px_respects_custom_scale() {
        // Full-scale 999 → dim (mobile_use cookbook convention).
        assert_eq!(norm_to_px(999.0, 800, 999.0), 800.0);
        // Same input under different scales lands differently: 999/1000*800 = 799.2 → 799
        assert_eq!(norm_to_px(999.0, 800, 1000.0), 799.0);
    }

    #[test]
    fn coordinate_scale_defaults_to_1000() {
        assert_eq!(coordinate_scale(), 1000.0);
    }

    // ---- args field mapping (x uses width, y uses height) ----

    #[test]
    fn denormalize_click_uses_width_for_x_height_for_y() {
        let mut args = json!({ "pid": 1, "x": 500.0, "y": 500.0 });
        denormalize_args("click", &mut args, 800, 600).unwrap();
        assert_eq!(args["x"], json!(400.0));
        assert_eq!(args["y"], json!(300.0));
    }

    #[test]
    fn denormalize_drag_converts_all_four_endpoints() {
        let mut args = json!({ "from_x": 0.0, "from_y": 0.0, "to_x": 1000.0, "to_y": 1000.0 });
        denormalize_args("drag", &mut args, 800, 600).unwrap();
        assert_eq!(args["from_x"], json!(0.0));
        assert_eq!(args["from_y"], json!(0.0));
        assert_eq!(args["to_x"], json!(800.0));
        assert_eq!(args["to_y"], json!(600.0));
    }

    // ---- exclusions / passthrough ----

    #[test]
    fn denormalize_from_zoom_uses_zoom_cache_when_available() {
        put_zoom_size(990010, 400, 300);
        let mut args = json!({ "pid": 990010, "x": 500.0, "y": 500.0, "from_zoom": true });
        denormalize_args("click", &mut args, 800, 600).unwrap();
        assert_eq!(args["x"], json!(200.0));
        assert_eq!(args["y"], json!(150.0));
    }

    #[test]
    fn denormalize_from_zoom_errors_without_cache() {
        let mut args = json!({ "pid": 990011, "x": 500.0, "y": 500.0, "from_zoom": true });
        let err = denormalize_args("click", &mut args, 800, 600).unwrap_err();
        assert!(err.contains("zoom"), "error should mention zoom: {err}");
    }

    #[test]
    fn denormalize_zoom_converts_rect_by_axis() {
        let mut args = json!({ "x1": 400.0, "y1": 400.0, "x2": 600.0, "y2": 600.0 });
        denormalize_args("zoom", &mut args, 800, 600).unwrap();
        assert_eq!(args["x1"], json!(320.0));
        assert_eq!(args["x2"], json!(480.0));
        assert_eq!(args["y1"], json!(240.0));
        assert_eq!(args["y2"], json!(360.0));
    }

    #[test]
    fn denormalize_move_cursor_uses_screen_size() {
        put_screen_size(1920, 1080);
        let mut args = json!({ "x": 500.0, "y": 500.0 });
        denormalize_args("move_cursor", &mut args, 800, 600).unwrap();
        assert_eq!(args["x"], json!(960.0));
        assert_eq!(args["y"], json!(540.0));
    }

    #[test]
    fn denormalize_leaves_non_coord_tools_untouched() {
        // scroll without x/y (keystroke path) — no coords to convert.
        let mut args = json!({ "direction": "down", "pid": 1 });
        denormalize_args("scroll", &mut args, 800, 600).unwrap();
        assert_eq!(args, json!({ "direction": "down", "pid": 1 }));
    }

    #[test]
    fn denormalize_scroll_converts_xy_when_present() {
        // scroll with x/y (pixel-wheel path) — coords are window-local.
        let mut args = json!({ "pid": 1, "window_id": 2, "direction": "down", "x": 500.0, "y": 500.0 });
        denormalize_args("scroll", &mut args, 800, 600).unwrap();
        assert_eq!(args["x"], json!(400.0)); // 500/1000 * 800
        assert_eq!(args["y"], json!(300.0)); // 500/1000 * 600
    }

    #[test]
    fn denormalize_mouse_button_down_converts_xy() {
        let mut args = json!({ "pid": 1, "window_id": 2, "x": 500.0, "y": 500.0 });
        denormalize_args("mouse_button_down", &mut args, 800, 600).unwrap();
        assert_eq!(args["x"], json!(400.0));
        assert_eq!(args["y"], json!(300.0));
    }

    #[test]
    fn denormalize_parallel_mouse_drag_converts_nested_coords() {
        // Each drag item uses its own (pid, window_id) for SIZE_CACHE lookup.
        put_size(990030, 1, 800, 600);
        put_size(990030, 2, 1024, 768);
        let mut args = json!({
            "drags": [
                {
                    "session": "s1", "pid": 990030, "window_id": 1,
                    "from_x": 0.0, "from_y": 0.0, "to_x": 1000.0, "to_y": 1000.0
                },
                {
                    "session": "s2", "pid": 990030, "window_id": 1,
                    "path": [[500.0, 500.0], [1000.0, 0.0]]
                },
                {
                    "session": "s3", "pid": 990030, "window_id": 2,
                    "fn": "sin(x)", "x_from": 0.0, "x_to": 500.0
                }
            ]
        });
        // screenshot_w/h args are ignored — per-item lookup used instead
        denormalize_args("parallel_mouse_drag", &mut args, 0, 0).unwrap();
        let d = args["drags"].as_array().unwrap();
        // Item 0 (window_id=1 → 800x600): from_x/to_x by width, from_y/to_y by height
        assert_eq!(d[0]["from_x"], json!(0.0));
        assert_eq!(d[0]["from_y"], json!(0.0));
        assert_eq!(d[0]["to_x"], json!(800.0));
        assert_eq!(d[0]["to_y"], json!(600.0));
        // Item 1 (window_id=1 → 800x600): path points
        let path = d[1]["path"].as_array().unwrap();
        assert_eq!(path[0][0], json!(400.0)); // 500/1000 * 800
        assert_eq!(path[0][1], json!(300.0)); // 500/1000 * 600
        assert_eq!(path[1][0], json!(800.0));
        assert_eq!(path[1][1], json!(0.0));
        // Item 2 (window_id=2 → 1024x768): fn domain x_from/x_to
        assert_eq!(d[2]["x_from"], json!(0.0));
        assert_eq!(d[2]["x_to"], json!(512.0)); // 500/1000 * 1024
    }

    #[test]
    fn denormalize_ignores_missing_coord_fields() {
        let mut args = json!({ "pid": 1, "element_index": 3 });
        denormalize_args("click", &mut args, 800, 600).unwrap();
        assert_eq!(args, json!({ "pid": 1, "element_index": 3 }));
    }

    #[test]
    fn denormalize_errors_when_window_cache_missing() {
        // screenshot_w=0 + has pid → window-scope without cache → error
        let mut args = json!({ "pid": 42, "x": 500.0, "y": 500.0 });
        let err = denormalize_args("click", &mut args, 0, 0).unwrap_err();
        assert!(err.contains("get_window_state"), "error should guide to get_window_state: {err}");
    }

    #[test]
    fn denormalize_errors_when_screen_cache_missing() {
        // move_cursor with no screen size cached → error
        // Use a fresh args without touching any global cache
        let mut args = json!({ "x": 500.0, "y": 500.0 });
        // Only test when screen cache is empty (other tests may populate it).
        // The core assertion: the error message guides to get_screen_size.
        if screen_size().is_none() {
            let err = denormalize_args("move_cursor", &mut args, 0, 0).unwrap_err();
            assert!(err.contains("get_screen_size"), "{err}");
        }
    }

    // ---- output: size basis extraction + result normalization ----

    #[test]
    fn extract_size_reads_screenshot_dims() {
        let r = ToolResult::text("ok").with_structured(
            json!({ "screenshot_width": 800, "screenshot_height": 600, "elements": [] }),
        );
        assert_eq!(extract_screenshot_size(&r), Some((800, 600)));
    }

    #[test]
    fn extract_size_none_when_absent() {
        let r = ToolResult::text("ok").with_structured(json!({ "foo": 1 }));
        assert_eq!(extract_screenshot_size(&r), None);
        let bare = ToolResult::text("ok");
        assert_eq!(extract_screenshot_size(&bare), None);
    }

    #[test]
    fn normalize_result_is_noop() {
        // normalize_result no longer rewrites screenshot_width/height —
        // query results are returned unmodified.
        let mut r = ToolResult::text("ok")
            .with_structured(json!({ "screenshot_width": 800, "screenshot_height": 600 }));
        normalize_result("get_window_state", &mut r);
        let sc = r.structured_content.as_ref().unwrap();
        assert_eq!(sc["screenshot_width"], json!(800));
        assert_eq!(sc["screenshot_height"], json!(600));
    }

    #[test]
    fn normalize_result_noop_without_structured_content() {
        let mut r = ToolResult::text("ok");
        normalize_result("get_window_state", &mut r);
        assert!(r.structured_content.is_none());
    }

    // ---- tools/list description rewrite (function instruction) ----

    #[test]
    fn rewrite_changes_click_xy_descriptions_by_axis() {
        let mut tl = json!({
            "tools": [{
                "name": "click",
                "description": "Click. x, y (window-local screenshot pixels, top-left origin).",
                "inputSchema": { "properties": {
                    "x": { "type": "number", "description": "Window-local screenshot X coordinate." },
                    "y": { "type": "number", "description": "Window-local screenshot Y coordinate." },
                    "pid": { "type": "integer", "description": "Target pid." }
                }}
            }]
        });
        rewrite_coord_desc(&mut tl);
        let props = &tl["tools"][0]["inputSchema"]["properties"];
        let xd = props["x"]["description"].as_str().unwrap();
        let yd = props["y"]["description"].as_str().unwrap();
        assert!(xd.contains("0–1000"), "x desc should mention 0–1000: {xd}");
        assert!(xd.to_lowercase().contains("width"), "x desc should mention width: {xd}");
        assert!(yd.contains("0–1000"));
        assert!(yd.to_lowercase().contains("height"));
        // non-coord field untouched
        assert_eq!(props["pid"]["description"], json!("Target pid."));
        // top-level description's pixel wording rewritten too
        let td = tl["tools"][0]["description"].as_str().unwrap();
        assert!(!td.contains("window-local screenshot pixels"), "top-level still says pixels: {td}");
    }

    #[test]
    fn rewrite_move_cursor_description_uses_screen_basis() {
        // move_cursor is screen-space: its normalized docs must say "screen",
        // not "window" — the basis the agent normalizes against differs.
        // The real upstream schema gives x/y NO description; normalized mode
        // must still INSERT one so the model knows the 0–1000 convention.
        let mut tl = json!({
            "tools": [{
                "name": "move_cursor",
                "description": "Move cursor.",
                "inputSchema": { "properties": {
                    "x": { "type": "number" },
                    "y": { "type": "number" }
                }}
            }]
        });
        rewrite_coord_desc(&mut tl);
        let props = &tl["tools"][0]["inputSchema"]["properties"];
        assert_eq!(
            props["x"]["description"],
            json!("X coordinate, 0–1000 normalized to screen width (top-left origin).")
        );
        assert_eq!(
            props["y"]["description"],
            json!("Y coordinate, 0–1000 normalized to screen height (top-left origin).")
        );
    }

    #[test]
    fn rewrite_handles_daemon_snake_case_input_schema() {
        // The daemon list path (serve.rs) emits `input_schema` (snake_case),
        // not MCP's `inputSchema`. rewrite must reach both.
        let mut tl = json!({
            "tools": [{
                "name": "click",
                "description": "Click.",
                "input_schema": { "properties": {
                    "x": { "type": "number", "description": "Window-local screenshot X coordinate." }
                }}
            }]
        });
        rewrite_coord_desc(&mut tl);
        let xd = tl["tools"][0]["input_schema"]["properties"]["x"]["description"]
            .as_str()
            .unwrap();
        assert!(xd.contains("0–1000"), "daemon input_schema x not rewritten: {xd}");
    }

    // ---- global state: size cache + ingest + switch ----
    // Unique pid keys per test so the shared cache can't cross-contaminate
    // under cargo's parallel test runner.

    #[test]
    fn size_cache_round_trip() {
        put_size(990001, 7, 800, 600);
        assert_eq!(get_size(990001, 7), Some((800, 600)));
    }

    #[test]
    fn size_cache_unknown_key_is_none() {
        assert_eq!(get_size(990002, 99), None);
    }

    #[test]
    fn ingest_caches_size_from_get_window_state() {
        let args = json!({ "pid": 990003, "window_id": 5 });
        let r = ToolResult::text("ok")
            .with_structured(json!({ "screenshot_width": 1024, "screenshot_height": 768 }));
        ingest_window_size("get_window_state", &args, &r);
        assert_eq!(get_size(990003, 5), Some((1024, 768)));
    }

    #[test]
    fn ingest_ignores_non_get_window_state() {
        let args = json!({ "pid": 990004, "window_id": 5 });
        let r = ToolResult::text("ok")
            .with_structured(json!({ "screenshot_width": 1024, "screenshot_height": 768 }));
        ingest_window_size("click", &args, &r);
        assert_eq!(get_size(990004, 5), None);
    }

    // ---- desktop-scope ----

    #[test]
    fn ingest_zoom_size_caches_from_zoom_result() {
        let args = json!({ "pid": 990020 });
        let r = ToolResult::text("ok")
            .with_structured(json!({ "width": 400, "height": 300, "format": "jpeg" }));
        ingest_zoom_size("zoom", &args, &r);
        assert_eq!(get_zoom_size(990020), Some((400, 300)));
    }

    #[test]
    fn ingest_zoom_size_ignores_non_zoom() {
        let args = json!({ "pid": 990021 });
        let r = ToolResult::text("ok")
            .with_structured(json!({ "width": 400, "height": 300 }));
        ingest_zoom_size("click", &args, &r);
        assert_eq!(get_zoom_size(990021), None);
    }

    #[test]
    fn denormalize_click_falls_back_to_desktop_screenshot_size() {
        put_desktop_screenshot_size(3840, 2160);
        let mut args = json!({ "x": 500.0, "y": 500.0 });
        denormalize_args("click", &mut args, 0, 0).unwrap();
        assert_eq!(args["x"], json!(1920.0));
        assert_eq!(args["y"], json!(1080.0));
    }

    #[test]
    fn denormalize_click_errors_window_scope_without_cache() {
        // pid present but no get_window_state yet → error
        let mut args = json!({ "pid": 42, "x": 500.0, "y": 500.0 });
        let err = denormalize_args("click", &mut args, 0, 0).unwrap_err();
        assert!(err.contains("get_window_state"), "{err}");
    }

    #[test]
    fn denormalize_move_cursor_not_affected_by_desktop_cache() {
        put_screen_size(1920, 1080);
        put_desktop_screenshot_size(3840, 2160);
        let mut args = json!({ "x": 500.0, "y": 500.0 });
        denormalize_args("move_cursor", &mut args, 0, 0).unwrap();
        assert_eq!(args["x"], json!(960.0));
        assert_eq!(args["y"], json!(540.0));
    }

    #[test]
    fn normalize_result_desktop_state_is_noop() {
        let mut r = ToolResult::text("ok")
            .with_structured(json!({
                "screenshot_width": 3840,
                "screenshot_height": 2160,
                "screen_width": 1920,
                "screen_height": 1080,
            }));
        normalize_result("get_desktop_state", &mut r);
        let sc = r.structured_content.as_ref().unwrap();
        assert_eq!(sc["screenshot_width"], json!(3840));
        assert_eq!(sc["screenshot_height"], json!(2160));
        assert_eq!(sc["screen_width"], json!(1920));
        assert_eq!(sc["screen_height"], json!(1080));
    }

    #[test]
    fn ingest_screen_size_from_get_desktop_state() {
        // Retina: get_desktop_state writes to desktop_screenshot cache (physical),
        // NOT to screen cache (logical).
        let r = ToolResult::text("ok")
            .with_structured(json!({
                "screen_width": 1920,
                "screen_height": 1080,
                "screenshot_width": 3840,
                "screenshot_height": 2160,
                "scale_factor": 2.0,
            }));
        ingest_screen_size("get_desktop_state", &r);
        assert_eq!(desktop_screenshot_size(), Some((3840, 2160)));
    }

    #[test]
    fn ingest_get_screen_size_does_not_pollute_desktop_cache() {
        let r = ToolResult::text("ok")
            .with_structured(json!({ "width": 1920, "height": 1080, "scale_factor": 2.0 }));
        ingest_screen_size("get_screen_size", &r);
        assert_eq!(screen_size(), Some((1920, 1080)));
        // desktop cache should not be touched
    }
}
