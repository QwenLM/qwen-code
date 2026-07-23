//! MCP JSON-RPC 2.0 protocol types.

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ── Request ──────────────────────────────────────────────────────────────────

/// An incoming JSON-RPC 2.0 request or notification.
#[derive(Debug, Deserialize)]
pub struct Request {
    #[allow(dead_code)]
    pub jsonrpc: String,
    /// Absent on notifications.
    pub id: Option<Value>,
    pub method: String,
    pub params: Option<Value>,
}

impl Request {
    pub fn is_notification(&self) -> bool {
        self.id.is_none()
    }

    pub fn tool_call(&self) -> anyhow::Result<ToolCall> {
        self.tool_call_with_filter(crate::model_payload::is_enabled())
    }

    fn tool_call_with_filter(&self, filter_enabled: bool) -> anyhow::Result<ToolCall> {
        let params = self.params.as_ref().ok_or_else(|| anyhow::anyhow!("missing params"))?;
        let name = params
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("missing tool name"))?
            .to_owned();
        let mut args = params
            .get("arguments")
            .cloned()
            .unwrap_or(Value::Object(Default::default()));
        let name = if filter_enabled {
            crate::model_payload::decode_value(&mut args).map_err(anyhow::Error::msg)?;
            crate::model_payload::decode_text(&name).into_owned()
        } else {
            name
        };
        Ok(ToolCall { name, args })
    }
}

pub struct ToolCall {
    pub name: String,
    pub args: Value,
}

// ── Response ─────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct Response {
    pub jsonrpc: &'static str,
    pub id: Value,
    #[serde(flatten)]
    pub body: ResponseBody,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum ResponseBody {
    Result { result: Value },
    Error { error: RpcError },
}

#[derive(Debug, Serialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl Response {
    pub fn ok(id: Value, result: Value) -> Self {
        Self::ok_with_filter(id, result, crate::model_payload::is_enabled())
    }

    fn ok_with_filter(id: Value, mut result: Value, filter_enabled: bool) -> Self {
        if filter_enabled {
            crate::model_payload::encode_value(&mut result);
        }
        Self {
            jsonrpc: "2.0",
            id,
            body: ResponseBody::Result { result },
        }
    }

    pub fn error(id: Value, code: i64, message: impl Into<String>) -> Self {
        Self::error_with_filter(id, code, message, crate::model_payload::is_enabled())
    }

    fn error_with_filter(
        id: Value,
        code: i64,
        message: impl Into<String>,
        filter_enabled: bool,
    ) -> Self {
        let message = message.into();
        let message = if filter_enabled {
            crate::model_payload::encode_text(&message).into_owned()
        } else {
            message
        };
        Self {
            jsonrpc: "2.0",
            id,
            body: ResponseBody::Error {
                error: RpcError { code, message },
            },
        }
    }

    pub fn parse_error() -> Self {
        Self::error(Value::Null, -32700, "Parse error")
    }

    pub fn method_not_found(id: Value, method: &str) -> Self {
        Self::error(id, -32601, format!("Unknown method: {method}"))
    }
}

// ── Tool result content ───────────────────────────────────────────────────────

/// A single item in the `content` array of a `tools/call` result.
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Content {
    Text {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        annotations: Option<Value>,
    },
    Image {
        data: String,     // base64-encoded PNG
        #[serde(rename = "mimeType")]
        mime_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        annotations: Option<Value>,
    },
}

impl Content {
    pub fn text(text: impl Into<String>) -> Self {
        Content::Text { text: text.into(), annotations: None }
    }

    pub fn image_png(data_base64: String) -> Self {
        Content::Image { data: data_base64, mime_type: "image/png".into(), annotations: None }
    }

    pub fn image_jpeg(data_base64: String) -> Self {
        Content::Image { data: data_base64, mime_type: "image/jpeg".into(), annotations: None }
    }
}

/// The value placed in `result` for a `tools/call` response.
#[derive(Debug, Serialize, Default)]
pub struct ToolResult {
    pub content: Vec<Content>,
    #[serde(rename = "isError", skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    #[serde(rename = "structuredContent", skip_serializing_if = "Option::is_none")]
    pub structured_content: Option<Value>,
}

impl ToolResult {
    pub fn text(msg: impl Into<String>) -> Self {
        Self { content: vec![Content::text(msg)], ..Default::default() }
    }

    pub fn error(msg: impl Into<String>) -> Self {
        Self { content: vec![Content::text(msg)], is_error: Some(true), ..Default::default() }
    }

    pub fn with_structured(mut self, v: Value) -> Self {
        self.structured_content = Some(v);
        self
    }
}

#[cfg(test)]
mod model_payload_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn filter_is_disabled_by_default_on_both_wire_directions() {
        let result = json!({
            "content": [{ "type": "text", "text": "Open Qwen in Alibaba Cloud" }],
            "structuredContent": { "QwenKey": "Dash Scope" }
        });
        let response = Response::ok_with_filter(json!(1), result.clone(), false);
        let value = serde_json::to_value(response).expect("serialize response");
        assert_eq!(value["result"], result);

        let response = Response::error_with_filter(json!(2), -32603, "Qwen failed", false);
        let value = serde_json::to_value(response).expect("serialize response");
        assert_eq!(value["error"]["message"], "Qwen failed");

        let encoded_name = crate::model_payload::encode_text("Qwen_tool").into_owned();
        let encoded_key = crate::model_payload::encode_text("AlibabaKey").into_owned();
        let encoded_value =
            crate::model_payload::encode_text("/Applications/Qwen.app").into_owned();
        let request: Request = serde_json::from_value(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": encoded_name,
                "arguments": { (encoded_key.clone()): encoded_value.clone() }
            }
        }))
        .expect("request");

        let call = request
            .tool_call_with_filter(false)
            .expect("tool call");
        assert_eq!(call.name, encoded_name);
        assert_eq!(call.args[&encoded_key], encoded_value);
    }

    #[test]
    fn filter_enabled_encodes_success_and_error_responses() {
        let id = json!("Qwen-client-id");
        let image_data = "Qwen-DashScope-Alibaba";
        let response = Response::ok_with_filter(
            id.clone(),
            json!({
                "content": [
                    { "type": "text", "text": "Open Qwen in Alibaba Cloud" },
                    { "type": "image", "data": image_data, "mimeType": "image/png" }
                ],
                "structuredContent": {
                    "QwenKey": ["Dash Scope", "阿里"]
                }
            }),
            true,
        );

        let value = serde_json::to_value(response).expect("serialize response");
        assert_eq!(value["id"], id, "JSON-RPC ids must remain opaque");
        assert_ne!(
            value["result"]["content"][0]["text"],
            "Open Qwen in Alibaba Cloud"
        );
        assert_eq!(value["result"]["content"][1]["data"], image_data);
        assert!(value["result"]["structuredContent"]
            .get("QwenKey")
            .is_none());

        let response = Response::error_with_filter(
            json!(7),
            -32603,
            "Qwen daemon failed under /Applications/Alibaba Cloud",
            true,
        );
        let value = serde_json::to_value(response).expect("serialize response");
        let message = value["error"]["message"].as_str().expect("message");

        assert!(!message.to_ascii_lowercase().contains("qwen"));
        assert!(!message.to_ascii_lowercase().contains("alibaba"));
        assert_eq!(
            crate::model_payload::decode_text(message),
            "Qwen daemon failed under /Applications/Alibaba Cloud"
        );
    }

    #[test]
    fn filter_enabled_round_trips_tool_name_argument_keys_and_values() {
        let encoded_name = crate::model_payload::encode_text("Qwen_tool").into_owned();
        let encoded_key = crate::model_payload::encode_text("AlibabaKey").into_owned();
        let encoded_value =
            crate::model_payload::encode_text("/Applications/Qwen.app").into_owned();
        let request: Request = serde_json::from_value(json!({
            "jsonrpc": "2.0",
            "id": "Qwen-client-id",
            "method": "tools/call",
            "params": {
                "name": encoded_name,
                "arguments": { (encoded_key): encoded_value }
            }
        }))
        .expect("request");

        let call = request.tool_call_with_filter(true).expect("tool call");
        assert_eq!(call.name, "Qwen_tool");
        assert_eq!(call.args["AlibabaKey"], "/Applications/Qwen.app");
        assert_eq!(request.id, Some(json!("Qwen-client-id")));
        assert_eq!(request.method, "tools/call");
    }
}

// ── Initialize result ─────────────────────────────────────────────────────────

pub fn initialize_result() -> Value {
    serde_json::json!({
        "protocolVersion": "2025-06-18",
        "capabilities": { "tools": {} },
        "serverInfo": { "name": "cua-driver", "version": env!("CARGO_PKG_VERSION") },
        "instructions": agent_instructions()
    })
}

/// MCP `instructions` (`InitializeResult.instructions`) sent to every
/// connecting client. The spec frames this as a "hint... MAY be added
/// to the system prompt" — eager, every-turn cost. We keep it under
/// the community-recommended ~200-word ceiling and host the long-form
/// workflow in `Skills/cua-driver/SKILL.md`.
///
/// Templated per-host: the accessibility-tree provider name (AX on
/// macOS, UIA on Windows, AT-SPI on Linux) is injected so a connecting
/// agent only sees the path that applies, not all three. Same pattern
/// Goose uses in its `ComputerController` extension and Open
/// Interpreter uses for its system message.
/// Coordinate wording for the agent instructions, by mode. Returns
/// `(term, trailing_note)`. Pixel mode keeps the historical wording and an
/// empty note; normalized mode swaps in 0–`scale` wording (tracking
/// `CUA_DRIVER_RS_COORDINATE_SCALE`) plus an explanatory note.
fn coordinate_terms(normalized: bool) -> (String, String) {
    if normalized {
        let scale = crate::coord_norm::coordinate_scale() as u64;
        (
            format!("0–{scale} normalized coordinates"),
            format!(" Raw x/y coordinates are 0–{scale} normalized to the window (top-left origin), not pixels."),
        )
    } else {
        ("pixel coordinates".to_string(), String::new())
    }
}

fn agent_instructions() -> String {
    let (tree_kind, platform_skill_pointer) = if cfg!(target_os = "macos") {
        (
            "AX (Accessibility)",
            "MACOS.md (no-foreground contract, AXMenuBar navigation, SkyLight click dispatch)",
        )
    } else if cfg!(target_os = "windows") {
        (
            "UIA (UI Automation)",
            "WINDOWS.md (UIA tree, UWP / ApplicationFrameHost hosting, Session 0 isolation)",
        )
    } else {
        (
            "AT-SPI",
            "LINUX.md (X11/Wayland status, AT-SPI bus, BETA-level support)",
        )
    };

    let (coord_term, coord_note) = coordinate_terms(crate::coord_norm::default_normalized());

    let click_hint = if crate::coord_norm::default_normalized() {
        "issue a coordinate click or move_cursor first for a visibly gliding demo/recording."
    } else {
        "issue a pixel click or move_cursor first for a visibly gliding demo/recording."
    };

    format!(
        r#"cua-driver: cross-platform background computer-use automation.

Tools let you interact with any app without stealing keyboard focus or moving the visible cursor. Prefer element_index ({tree_kind}) paths over {coord_term} — they work on backgrounded/hidden windows.{coord_note}

Workflow per turn:
0. start_session(session) once at the start of a run → declares THIS run's identity (a stable id you choose, e.g. "research-1"). Pass that same `session` on every action below. It owns your agent cursor (a distinct color per id) and follows the run across apps/windows. End with end_session(session) when done. Concurrent runs/subagents each use their OWN `session`. (Omitting `session` still works, just with no cursor.)
1. launch_app  → idempotent, returns pid + windows array in one call. Pass creates_new_application_instance:true if another run may touch the same app, so you get your own window.
2. (skip list_windows when launch_app already returned a single window)
3. get_window_state(pid, window_id) → refresh the {tree_kind} snapshot, get element indices
4. click/type_text/press_key using element_index from step 3 (+ your `session`)
5. get_window_state(pid, window_id) again → verify the action landed

Agent cursor: a per-SESSION overlay cursor visualises where a run is acting without moving the real pointer. It is shown only for a DECLARED session (pass `session`), is color-coded by the session id, and is removed by end_session or the idle-TTL. The same id over MCP, the CLI, or the raw socket drives the same cursor. set_agent_cursor_* tools hide/show/customise it. Note: a pure accessibility-action (element_index) click snaps the cursor with a brief pulse on its first action rather than a long glide, so it can be easy to miss — {click_hint}

If a `cua-driver` skill is loaded in your harness (Claude Code / Codex / OpenClaw / OpenCode dirs), prefer its detailed workflow — SKILL.md plus {platform_skill_pointer}. Install with `cua-driver skills install` if not yet present."#
    )
}

#[cfg(test)]
mod image_mime_type_tests {
    use super::Content;

    /// Surface 7 contract: image parts serialize an explicit `mimeType` field
    /// (not `mime_type`, not `format`) so MCP consumers don't have to sniff
    /// magic bytes off the base64 PNG/JPEG to know what they're holding.
    /// This locks in the JSON shape — any rename or drop breaks here first.
    #[test]
    fn image_png_serializes_with_explicit_mime_type() {
        let c = Content::image_png("ZmFrZQ==".into());
        let v = serde_json::to_value(&c).expect("serialize");
        assert_eq!(v.get("type").and_then(|t| t.as_str()), Some("image"));
        assert_eq!(v.get("mimeType").and_then(|t| t.as_str()), Some("image/png"));
        assert_eq!(v.get("data").and_then(|t| t.as_str()), Some("ZmFrZQ=="));
    }

    #[test]
    fn image_jpeg_serializes_with_explicit_mime_type() {
        let c = Content::image_jpeg("ZmFrZQ==".into());
        let v = serde_json::to_value(&c).expect("serialize");
        assert_eq!(v.get("type").and_then(|t| t.as_str()), Some("image"));
        assert_eq!(v.get("mimeType").and_then(|t| t.as_str()), Some("image/jpeg"));
    }

    /// Text parts must not grow a mimeType field — the field belongs to
    /// image parts only. Guards against an accidental serde_json renamer
    /// that emits a shared shape across the enum.
    #[test]
    fn text_does_not_carry_mime_type() {
        let c = Content::text("hi");
        let v = serde_json::to_value(&c).expect("serialize");
        assert_eq!(v.get("type").and_then(|t| t.as_str()), Some("text"));
        assert!(v.get("mimeType").is_none(), "text content must not carry mimeType");
    }
}

#[cfg(test)]
mod coord_instruction_tests {
    use super::coordinate_terms;

    #[test]
    fn pixel_mode_keeps_historical_wording() {
        let (term, note) = coordinate_terms(false);
        assert_eq!(term, "pixel coordinates");
        assert_eq!(note, "");
    }

    #[test]
    fn normalized_mode_swaps_in_0_1000_wording() {
        let (term, note) = coordinate_terms(true);
        assert!(
            term.contains("0–1000") || term.to_lowercase().contains("normalized"),
            "term: {term}"
        );
        assert!(note.contains("0–1000"), "note: {note}");
        assert!(note.to_lowercase().contains("not pixels"), "note: {note}");
    }
}
