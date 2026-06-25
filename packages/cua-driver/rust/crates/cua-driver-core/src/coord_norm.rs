//! Relative-coordinate (1000×1000 normalized) translation layer.
//!
//! Opt-in (`coordinate_space = normalized_1000`, default `pixels`) shim that
//! lets clients trained on 0–1000 normalized coordinates (e.g. Qwen-VL
//! `computer_use`) drive the pixel-based tool surface. It runs entirely in
//! `cua-driver-core` so the per-platform tools stay untouched (fork-rebase
//! friendly). See `libs/cua-driver/docs/relative-coordinates-design.md`.
//!
//! Three hooks, wired into `ToolRegistry::invoke` / `tools_list`:
//!   - input  : `denormalize_args`  — 0–1000 → pixels, before the real tool
//!   - output : `normalize_result`  — pixels → 0–1000, on the way back
//!   - listing: `rewrite_coord_desc`— pixel wording → normalized wording
//!
//! Conversion is anchored to the **downscaled screenshot size** the matching
//! `get_window_state` reported (`screenshot_width/height`), i.e. the very image
//! the model reasoned over — so `norm/1000 * dim` lands in the right pixel.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

use crate::protocol::ToolResult;

/// Divisor for 1000-normalized coordinates (Qwen `computer_use` convention:
/// `pixel = coord / 1000 * resized_dim`). Kept as a constant so the 999-vs-1000
/// ambiguity (mobile_use cookbook uses 999) has a single place to change.
const DIV: f64 = 1000.0;

/// Convert a 0–1000 normalized coordinate to a pixel coordinate against `dim`.
pub fn norm_to_px(norm: f64, dim: u32) -> f64 {
    (norm / DIV * dim as f64).round()
}

/// Convert a pixel coordinate to a 0–1000 normalized coordinate against `dim`.
pub fn px_to_norm(px: f64, dim: u32) -> f64 {
    if dim == 0 {
        return 0.0;
    }
    (px / dim as f64 * DIV).round()
}

/// Input coordinate fields per tool. `true` = X axis (scale by width),
/// `false` = Y axis (scale by height). Tools not listed (move_cursor,
/// zoom, scroll, …) are intentionally excluded — see the design doc.
fn input_coord_fields(tool: &str) -> &'static [(&'static str, bool)] {
    match tool {
        "click" | "double_click" | "right_click" => &[("x", true), ("y", false)],
        "drag" => &[
            ("from_x", true),
            ("from_y", false),
            ("to_x", true),
            ("to_y", false),
        ],
        _ => &[],
    }
}

/// In-place convert a coordinate tool's normalized input fields to pixels,
/// using the window's current screenshot dimensions as the basis.
pub fn denormalize_args(tool: &str, args: &mut Value, screenshot_w: u32, screenshot_h: u32) {
    // from_zoom coords live in the zoom-image space, not window-local; core has
    // no crop basis to convert them, so leave the whole call untouched.
    if args.get("from_zoom").and_then(|v| v.as_bool()).unwrap_or(false) {
        return;
    }
    for &(field, is_x) in input_coord_fields(tool) {
        if let Some(v) = args.get(field).and_then(|v| v.as_f64()) {
            let dim = if is_x { screenshot_w } else { screenshot_h };
            args[field] = json!(norm_to_px(v, dim));
        }
    }
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

/// In-place normalize a tool result's pixel coordinates back to 0–1000.
///
/// First version: rewrite `screenshot_width/height` to 1000 (the model treats
/// the returned image as a 0–1000 grid). Element frames stay in pixels — they
/// are screen-global with no window-origin/scale basis available in core (see
/// design doc §5), so converting them here would introduce error.
pub fn normalize_result(tool: &str, result: &mut ToolResult) {
    // First version only rewrites get_window_state's screenshot dims.
    if tool != "get_window_state" {
        return;
    }
    if let Some(obj) = result
        .structured_content
        .as_mut()
        .and_then(|v| v.as_object_mut())
    {
        if obj.contains_key("screenshot_width") {
            obj.insert("screenshot_width".to_string(), json!(1000));
        }
        if obj.contains_key("screenshot_height") {
            obj.insert("screenshot_height".to_string(), json!(1000));
        }
    }
}

/// Rewrite coordinate-field descriptions in a `tools/list` payload from pixel
/// wording to 0–1000 normalized wording. Caller gates on normalized mode. Only
/// the fields that actually get converted (same table as `denormalize_args`)
/// are rewritten, so the docs match behavior — move_cursor/zoom stay pixels.
pub fn rewrite_coord_desc(tools_list: &mut Value) {
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
        if fields.is_empty() {
            continue; // not a converted tool — leave its docs alone
        }
        // Per-field coordinate descriptions. The MCP path emits `inputSchema`
        // (camelCase); the daemon list path (serve.rs) emits `input_schema`
        // (snake_case) — reach whichever this payload uses.
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
            for &(field, is_x) in fields {
                if let Some(fobj) = props.get_mut(field).and_then(|f| f.as_object_mut()) {
                    if fobj.contains_key("description") {
                        let desc = if is_x {
                            "X coordinate, 0–1000 normalized to window width (top-left origin)."
                        } else {
                            "Y coordinate, 0–1000 normalized to window height (top-left origin)."
                        };
                        fobj.insert("description".to_string(), json!(desc));
                    }
                }
            }
        }
        // Top-level description: swap the pixel phrasing. Compute the new string
        // first so the immutable borrow ends before the mutable write-back.
        let new_top = tool
            .get("description")
            .and_then(|d| d.as_str())
            .filter(|d| d.contains("window-local screenshot pixels"))
            .map(|d| {
                d.replace(
                    "window-local screenshot pixels",
                    "0–1000 normalized coordinates (top-left origin)",
                )
            });
        if let Some(nd) = new_top {
            tool["description"] = json!(nd);
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

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ---- scalar conversion ----

    #[test]
    fn norm_to_px_maps_midpoint() {
        // 500/1000 of an 800px-wide image = 400px
        assert_eq!(norm_to_px(500.0, 800), 400.0);
    }

    #[test]
    fn norm_to_px_maps_edges() {
        assert_eq!(norm_to_px(0.0, 800), 0.0);
        assert_eq!(norm_to_px(1000.0, 800), 800.0);
    }

    #[test]
    fn norm_to_px_rounds_to_nearest() {
        // 333/1000 of 800 = 266.4 → 266
        assert_eq!(norm_to_px(333.0, 800), 266.0);
    }

    #[test]
    fn px_to_norm_is_inverse_at_midpoint() {
        assert_eq!(px_to_norm(400.0, 800), 500.0);
        assert_eq!(px_to_norm(800.0, 800), 1000.0);
    }

    // ---- args field mapping (x uses width, y uses height) ----

    #[test]
    fn denormalize_click_uses_width_for_x_height_for_y() {
        // Non-square image to catch any axis mix-up.
        let mut args = json!({ "pid": 1, "x": 500.0, "y": 500.0 });
        denormalize_args("click", &mut args, 800, 600);
        assert_eq!(args["x"], json!(400.0)); // 500/1000 * 800
        assert_eq!(args["y"], json!(300.0)); // 500/1000 * 600
    }

    #[test]
    fn denormalize_drag_converts_all_four_endpoints() {
        let mut args = json!({ "from_x": 0.0, "from_y": 0.0, "to_x": 1000.0, "to_y": 1000.0 });
        denormalize_args("drag", &mut args, 800, 600);
        assert_eq!(args["from_x"], json!(0.0));
        assert_eq!(args["from_y"], json!(0.0));
        assert_eq!(args["to_x"], json!(800.0));
        assert_eq!(args["to_y"], json!(600.0));
    }

    // ---- exclusions / passthrough ----

    #[test]
    fn denormalize_skips_when_from_zoom_set() {
        // from_zoom coords are in the zoom-image space; core has no crop basis
        // to convert them, so they must pass through untouched.
        let mut args = json!({ "x": 500.0, "y": 500.0, "from_zoom": true });
        denormalize_args("click", &mut args, 800, 600);
        assert_eq!(args["x"], json!(500.0));
        assert_eq!(args["y"], json!(500.0));
    }

    #[test]
    fn denormalize_excludes_move_cursor() {
        // move_cursor is screen/overlay space with no window basis — never scale.
        let mut args = json!({ "x": 500.0, "y": 500.0 });
        denormalize_args("move_cursor", &mut args, 800, 600);
        assert_eq!(args["x"], json!(500.0));
        assert_eq!(args["y"], json!(500.0));
    }

    #[test]
    fn denormalize_leaves_non_coord_tools_untouched() {
        let mut args = json!({ "direction": "down", "pid": 1 });
        denormalize_args("scroll", &mut args, 800, 600);
        assert_eq!(args, json!({ "direction": "down", "pid": 1 }));
    }

    #[test]
    fn denormalize_ignores_missing_coord_fields() {
        // element_index addressing — no x/y present to convert.
        let mut args = json!({ "pid": 1, "element_index": 3 });
        denormalize_args("click", &mut args, 800, 600);
        assert_eq!(args, json!({ "pid": 1, "element_index": 3 }));
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
    fn normalize_result_rewrites_screenshot_dims_to_1000() {
        let mut r = ToolResult::text("ok")
            .with_structured(json!({ "screenshot_width": 800, "screenshot_height": 600 }));
        normalize_result("get_window_state", &mut r);
        let sc = r.structured_content.as_ref().unwrap();
        assert_eq!(sc["screenshot_width"], json!(1000));
        assert_eq!(sc["screenshot_height"], json!(1000));
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
    fn rewrite_excludes_move_cursor_description() {
        // move_cursor is screen-space and not converted — its docs stay pixels.
        let mut tl = json!({
            "tools": [{
                "name": "move_cursor",
                "description": "Move cursor.",
                "inputSchema": { "properties": {
                    "x": { "type": "number", "description": "Screen X." },
                    "y": { "type": "number", "description": "Screen Y." }
                }}
            }]
        });
        rewrite_coord_desc(&mut tl);
        let props = &tl["tools"][0]["inputSchema"]["properties"];
        assert_eq!(props["x"]["description"], json!("Screen X."));
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
}
