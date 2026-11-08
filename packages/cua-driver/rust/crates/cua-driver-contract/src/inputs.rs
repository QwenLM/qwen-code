// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cua AI, Inc.

//! Typed inputs for the published Cua Driver SDK surface.
//!
//! These types are transport-free. The contract generator derives JSON Schema
//! from them, and live Rust handlers deserialize the same types before acting.

use crate::{schema_settings, CursorThemeSelection};
use schemars::{json_schema, JsonSchema, Schema, SchemaGenerator};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;

pub trait ToolInput: Serialize + DeserializeOwned + JsonSchema {
    const TOOL_NAME: &'static str;

    fn input_schema() -> Value {
        let schema = schema_settings()
            .into_generator()
            .into_root_schema_for::<Self>();
        let mut value = serde_json::to_value(schema).expect("tool input schema serializes");
        normalize_input_schema(&mut value);
        value
    }
}

pub fn normalize_input_schema(value: &mut Value) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    object.remove("title");
    if object.get("default").is_some_and(Value::is_null) {
        object.remove("default");
    }
    if let Some(types) = object.get("type").and_then(Value::as_array) {
        let kept: Vec<_> = types
            .iter()
            .filter(|kind| kind.as_str() != Some("null"))
            .cloned()
            .collect();
        if let [kind] = kept.as_slice() {
            object.insert("type".into(), kind.clone());
        }
    }
    if let Some(variants) = object.get("anyOf").and_then(Value::as_array) {
        let kept: Vec<_> = variants
            .iter()
            .filter(|schema| schema["type"] != "null")
            .cloned()
            .collect();
        if let [Value::Object(schema)] = kept.as_slice() {
            let schema = schema.clone();
            object.remove("anyOf");
            object.extend(schema);
        }
    }
    if let Some(constant) = object.remove("const") {
        match constant {
            Value::String(text) => {
                object.insert("type".into(), serde_json::json!("string"));
                object.insert("enum".into(), serde_json::json!([text]));
            }
            Value::Number(number) => {
                object.insert("minimum".into(), serde_json::json!(number));
                object.insert("maximum".into(), serde_json::json!(number));
            }
            other => {
                object.insert("const".into(), other);
            }
        }
    }
    if object.get("type").and_then(Value::as_str) == Some("object") {
        object
            .entry("properties")
            .or_insert_with(|| serde_json::json!({}));
        object
            .entry("required")
            .or_insert_with(|| serde_json::json!([]));
        object
            .entry("additionalProperties")
            .or_insert(Value::Bool(true));
    }
    for key in ["properties", "$defs"] {
        if let Some(children) = object.get_mut(key).and_then(Value::as_object_mut) {
            for child in children.values_mut() {
                normalize_input_schema(child);
            }
        }
    }
    for key in ["items", "additionalProperties"] {
        if let Some(child) = object.get_mut(key).filter(|child| child.is_object()) {
            normalize_input_schema(child);
        }
    }
    for key in ["anyOf", "oneOf", "allOf"] {
        if let Some(children) = object.get_mut(key).and_then(Value::as_array_mut) {
            for child in children {
                normalize_input_schema(child);
            }
        }
    }
}

fn string_schema(generator: &mut SchemaGenerator) -> Schema {
    String::json_schema(generator)
}

fn boolean_schema(generator: &mut SchemaGenerator) -> Schema {
    bool::json_schema(generator)
}

pub const MULTI_CALL_SESSION_DESCRIPTION: &str =
    "For multi-call work, prefer a short public session label and repeat it on every call that \
     accepts it. Omit it to use the authenticated transport's implicit lifecycle session.";

fn string_list_schema(generator: &mut SchemaGenerator) -> Schema {
    Vec::<String>::json_schema(generator)
}

fn menu_path_schema(_: &mut SchemaGenerator) -> Schema {
    json_schema!({
        "type": "array",
        "minItems": 1,
        "maxItems": 16,
        "items": { "type": "string", "minLength": 1, "maxLength": 200 }
    })
}

fn number_schema(_: &mut SchemaGenerator) -> Schema {
    json_schema!({ "type": "number" })
}

fn positive_number_schema(_: &mut SchemaGenerator) -> Schema {
    json_schema!({ "type": "number", "minimum": 1 })
}

fn positive_integer_schema(_: &mut SchemaGenerator) -> Schema {
    json_schema!({ "type": "integer", "minimum": 1 })
}

fn observation_revision_schema(_: &mut SchemaGenerator) -> Schema {
    // Mirrors the live platform subschema so the portable projection stays a
    // provable subset of every runtime `get_window_state` schema.
    json_schema!({
        "type": "object",
        "required": ["version", "serializer_version", "projection_version"],
        "properties": {
            "version": { "type": "integer", "const": 1 },
            "serializer_version": { "type": "string", "minLength": 1, "maxLength": 128 },
            "projection_version": { "type": "string", "minLength": 1, "maxLength": 128 },
            "base_revision_id": { "type": "string", "minLength": 1, "maxLength": 256 },
            "force_full": { "type": "boolean", "default": false }
        },
        "additionalProperties": false
    })
}

fn click_button_schema(generator: &mut SchemaGenerator) -> Schema {
    ClickButton::json_schema(generator)
}

fn scroll_by_schema(generator: &mut SchemaGenerator) -> Schema {
    ScrollBy::json_schema(generator)
}

fn click_count_schema(_: &mut SchemaGenerator) -> Schema {
    json_schema!({ "type": "integer", "minimum": 1, "maximum": 3 })
}

fn drag_duration_schema(_: &mut SchemaGenerator) -> Schema {
    json_schema!({ "type": "integer", "minimum": 0, "maximum": 10000 })
}

fn drag_steps_schema(_: &mut SchemaGenerator) -> Schema {
    json_schema!({ "type": "integer", "minimum": 1, "maximum": 200 })
}

fn delivery_mode_schema(_: &mut SchemaGenerator) -> Schema {
    json_schema!({ "type": "string", "enum": ["background", "foreground"] })
}

fn scroll_amount_schema(_: &mut SchemaGenerator) -> Schema {
    json_schema!({ "type": "integer", "minimum": 1, "maximum": 50 })
}

fn cursor_theme_id_schema(_: &mut SchemaGenerator) -> Schema {
    json_schema!({ "type": "string", "minLength": 1, "maxLength": 200 })
}

fn element_token_schema(_: &mut SchemaGenerator) -> Schema {
    json_schema!({ "type": "string", "minLength": 1, "maxLength": 512 })
}

fn escalation_detail_schema(_: &mut SchemaGenerator) -> Schema {
    json_schema!({ "type": "string", "maxLength": 200 })
}

fn capture_scope_schema(_: &mut SchemaGenerator) -> Schema {
    json_schema!({
        "type": "string",
        "enum": ["auto", "window", "desktop"]
    })
}

#[derive(
    Debug, Clone, Copy, Default, Serialize, Deserialize, JsonSchema, PartialEq, Eq, uniffi::Enum,
)]
#[serde(rename_all = "snake_case")]
pub enum CaptureScope {
    #[default]
    Auto,
    Window,
    Desktop,
}

impl CaptureScope {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "auto" => Some(Self::Auto),
            "window" => Some(Self::Window),
            "desktop" => Some(Self::Desktop),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Window => "window",
            Self::Desktop => "desktop",
        }
    }
}

impl std::fmt::Display for CaptureScope {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq, uniffi::Enum)]
#[serde(rename_all = "snake_case")]
pub enum EscalationReason {
    AxTreePixelMismatch,
    BackgroundDeliveryFailed,
    ForegroundIneffective,
    NoWindowTarget,
    Other,
}

impl EscalationReason {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "ax_tree_pixel_mismatch" => Some(Self::AxTreePixelMismatch),
            "background_delivery_failed" => Some(Self::BackgroundDeliveryFailed),
            "foreground_ineffective" => Some(Self::ForegroundIneffective),
            "no_window_target" => Some(Self::NoWindowTarget),
            "other" => Some(Self::Other),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AxTreePixelMismatch => "ax_tree_pixel_mismatch",
            Self::BackgroundDeliveryFailed => "background_delivery_failed",
            Self::ForegroundIneffective => "foreground_ineffective",
            Self::NoWindowTarget => "no_window_target",
            Self::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, uniffi::Enum)]
pub enum DesktopScope {
    #[serde(rename = "desktop")]
    Desktop,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq, uniffi::Enum)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryMode {
    Background,
    Foreground,
}

fn desktop_scope_schema(generator: &mut SchemaGenerator) -> Schema {
    DesktopScope::json_schema(generator)
}

/// Exact capture/input target selected independently for each action.
///
/// `display_id="primary"` is the portable desktop target in this release.
/// Platforms that cannot address another display reject it explicitly rather
/// than silently changing coordinate spaces.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, uniffi::Enum)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ActionTarget {
    Window { pid: u32, window_id: u64 },
    Desktop { display_id: String },
}

impl JsonSchema for ActionTarget {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "ActionTarget".into()
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "object",
            "description": "Exact window or desktop target. Window requires pid and window_id; desktop requires display_id.",
            "required": ["kind"],
            "properties": {
                "kind": {"type":"string","enum":["window","desktop"]},
                "pid": {"type":"integer","minimum":0},
                "window_id": {"type":"integer","minimum":0},
                "display_id": {"type":"string","description":"Use primary for the primary display."}
            }
        })
    }
}

pub fn action_target_schema() -> Value {
    let schema = schema_settings()
        .into_generator()
        .into_root_schema_for::<ActionTarget>();
    let mut value = serde_json::to_value(schema).expect("action target schema serializes");
    normalize_input_schema(&mut value);
    value
}

impl JsonSchema for DesktopScope {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "DesktopScope".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({ "const": "desktop" })
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq, uniffi::Enum)]
#[serde(rename_all = "snake_case")]
pub enum ClickButton {
    Left,
    Right,
    Middle,
}

impl ClickButton {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
            Self::Middle => "middle",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq, uniffi::Enum)]
#[serde(rename_all = "snake_case")]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

impl ScrollDirection {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Up => "up",
            Self::Down => "down",
            Self::Left => "left",
            Self::Right => "right",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq, uniffi::Enum)]
#[serde(rename_all = "snake_case")]
pub enum ScrollBy {
    Line,
    Page,
}

impl ScrollBy {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Line => "line",
            Self::Page => "page",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
pub struct StartSessionInput {
    /// Optional stable public label for this run (e.g. "research-run-1").
    /// When omitted, the authenticated transport lease's implicit session is
    /// created or returned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_schema")]
    pub session: Option<String>,
    /// Deprecated compatibility policy. New callers select window or desktop
    /// modality on each action instead of storing it on the session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "capture_scope_schema")]
    pub capture_scope: Option<CaptureScope>,
    /// Optional initial cursor theme. The host applies it before the cursor is
    /// first made visible, avoiding a flash of the default theme.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor_theme: Option<CursorThemeSelection>,
}

impl ToolInput for StartSessionInput {
    const TOOL_NAME: &'static str = "start_session";
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
pub struct EscalateSessionInput {
    pub session: String,
    pub reason: EscalationReason,
    /// Optional bounded diagnostic detail. Never use secrets or page content.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "escalation_detail_schema")]
    pub detail: Option<String>,
}

impl ToolInput for EscalateSessionInput {
    const TOOL_NAME: &'static str = "escalate_session";
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
pub struct GetSessionStateInput {
    /// Optional public label. When omitted, inspect the caller's attached
    /// implicit session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_schema")]
    pub session: Option<String>,
}

impl ToolInput for GetSessionStateInput {
    const TOOL_NAME: &'static str = "get_session_state";
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
pub struct GetSessionInput {
    /// Optional public label. When omitted, inspect the caller's attached
    /// implicit session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_schema")]
    pub session: Option<String>,
}

impl ToolInput for GetSessionInput {
    const TOOL_NAME: &'static str = "get_session";
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
pub struct ListSessionsInput {
    /// Maximum number of content-free summaries to return (default 50, max
    /// 100). Ordinary agent transports are scoped to their own lease.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// Opaque continuation cursor returned by a previous call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_schema")]
    pub cursor: Option<String>,
}

impl ToolInput for ListSessionsInput {
    const TOOL_NAME: &'static str = "list_sessions";
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
pub struct EndSessionInput {
    /// Optional public label to end. When omitted, end the caller's attached
    /// implicit session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_schema")]
    pub session: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct SetAgentCursorEnabledInput {
    pub session: String,
    pub enabled: bool,
}

impl ToolInput for SetAgentCursorEnabledInput {
    const TOOL_NAME: &'static str = "set_agent_cursor_enabled";
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct SetAgentCursorMotionInput {
    pub session: String,
    pub start_handle: Option<f64>,
    pub end_handle: Option<f64>,
    pub arc_size: Option<f64>,
    pub arc_flow: Option<f64>,
    pub spring: Option<f64>,
    pub glide_duration_ms: Option<f64>,
    pub dwell_after_click_ms: Option<f64>,
    pub idle_hide_ms: Option<f64>,
    pub turn_radius: Option<f64>,
}

impl ToolInput for SetAgentCursorMotionInput {
    const TOOL_NAME: &'static str = "set_agent_cursor_motion";
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct SetAgentCursorThemeInput {
    pub session: String,
    #[schemars(schema_with = "cursor_theme_id_schema")]
    pub theme_id: String,
    #[serde(default)]
    pub reduced_motion: crate::CursorReducedMotion,
}

impl ToolInput for SetAgentCursorThemeInput {
    const TOOL_NAME: &'static str = "set_agent_cursor_theme";
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct GetAgentCursorStateInput {
    pub session: String,
}

impl ToolInput for GetAgentCursorStateInput {
    const TOOL_NAME: &'static str = "get_agent_cursor_state";
}

impl ToolInput for EndSessionInput {
    const TOOL_NAME: &'static str = "end_session";
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct GetDesktopStateInput {
    /// For multi-call work, prefer a short public session label and repeat it on every call that
    /// accepts it. Omit it to use the authenticated transport's implicit lifecycle session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_schema")]
    pub session: Option<String>,
    /// Write the PNG here instead of returning base64.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_schema")]
    pub screenshot_out_file: Option<String>,
}

impl ToolInput for GetDesktopStateInput {
    const TOOL_NAME: &'static str = "get_desktop_state";
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct ListAppsInput {
    #[uniffi(default = None)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub running_only: Option<bool>,
}

impl ToolInput for ListAppsInput {
    const TOOL_NAME: &'static str = "list_apps";
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct LaunchAppInput {
    /// Application name or absolute installation path discovered by list_apps.
    pub name: String,
    /// Windows launcher command returned by list_apps, including shortcut arguments.
    #[uniffi(default = None)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_path: Option<String>,
}

impl ToolInput for LaunchAppInput {
    const TOOL_NAME: &'static str = "launch_app";
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct ListWindowsInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "positive_integer_schema")]
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_screen_only: Option<bool>,
    /// Resolve the macOS application's current AX window and attached sheet.
    #[uniffi(default = None)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_context: Option<bool>,
}

impl ToolInput for ListWindowsInput {
    const TOOL_NAME: &'static str = "list_windows";
}

/// Opt in to the versioned `accessibility.observation_revision.v1` protocol on
/// `get_window_state`. Omitting the whole record preserves the legacy
/// full-snapshot contract byte for byte.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct ObservationRevisionInput {
    /// Protocol version. Only `1` is defined; any other value is rejected
    /// with a closed `invalid_observation_revision` error.
    pub version: u32,
    /// Canonical accessibility serializer expected by the caller. A mismatch
    /// returns a full response with `serializer_changed`.
    pub serializer_version: String,
    /// Canonical tree projection expected by the caller. A mismatch returns a
    /// full response with `projection_changed`.
    pub projection_version: String,
    /// Revision the caller wants to diff against. The caller — never the
    /// driver — decides which revision was actually delivered downstream.
    /// Missing, expired, foreign, or incompatible bases yield a full response.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_revision_id: Option<String>,
    /// Force a full resynchronization even when a compatible base exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force_full: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct GetWindowStateInput {
    /// Target process ID.
    #[schemars(schema_with = "positive_integer_schema")]
    pub pid: u32,
    /// Exact window to observe.
    #[schemars(schema_with = "positive_integer_schema")]
    pub window_id: u64,
    /// For multi-call work, prefer a short public session label and repeat it on every call that
    /// accepts it. Omit it to use the authenticated transport's implicit lifecycle session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_schema")]
    pub session: Option<String>,
    /// Case-insensitive projection filter. Incompatible with `observation_revision`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_schema")]
    pub query: Option<String>,
    /// Default true. Set false to skip the screenshot and return the tree only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "boolean_schema")]
    pub include_screenshot: Option<bool>,
    /// Write the PNG here instead of returning base64.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_schema")]
    pub screenshot_out_file: Option<String>,
    /// Cap on the total number of accessibility nodes walked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "positive_integer_schema")]
    pub max_elements: Option<u32>,
    /// Cap on the accessibility-tree walk depth.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "positive_integer_schema")]
    pub max_depth: Option<u32>,
    /// Use the compact macOS application observation with contextual menus.
    #[uniffi(default = None)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_context: Option<bool>,
    /// Opt in to `accessibility.observation_revision.v1`. Requires a bound
    /// driver session. Omit to preserve the legacy full-snapshot contract.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "observation_revision_schema")]
    pub observation_revision: Option<ObservationRevisionInput>,
}

impl ToolInput for GetWindowStateInput {
    const TOOL_NAME: &'static str = "get_window_state";
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct GetScreenSizeInput {
    /// For multi-call work, prefer a short public session label and repeat it on every call that
    /// accepts it. Omit it to use the authenticated transport's implicit lifecycle session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_schema")]
    pub session: Option<String>,
}

impl ToolInput for GetScreenSizeInput {
    const TOOL_NAME: &'static str = "get_screen_size";
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct GetCursorPositionInput {
    /// For multi-call work, prefer a short public session label and repeat it on every call that
    /// accepts it. Omit it to use the authenticated transport's implicit lifecycle session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_schema")]
    pub session: Option<String>,
}

impl ToolInput for GetCursorPositionInput {
    const TOOL_NAME: &'static str = "get_cursor_position";
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct MoveCursorInput {
    #[schemars(schema_with = "number_schema")]
    pub x: f64,
    #[schemars(schema_with = "number_schema")]
    pub y: f64,
    /// Preferred per-call target. New callers should set this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<ActionTarget>,
    /// Deprecated flat desktop target retained for wire compatibility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "desktop_scope_schema")]
    pub scope: Option<DesktopScope>,
    /// For multi-call work, prefer a short public session label and repeat it on every call that
    /// accepts it. Omit it to use the authenticated transport's implicit lifecycle session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_schema")]
    pub session: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct SetWindowFrameInput {
    #[schemars(schema_with = "positive_integer_schema")]
    pub pid: u32,
    #[schemars(schema_with = "positive_integer_schema")]
    pub window_id: u64,
    #[schemars(schema_with = "number_schema")]
    pub x: f64,
    #[schemars(schema_with = "number_schema")]
    pub y: f64,
    #[schemars(schema_with = "positive_number_schema")]
    pub width: f64,
    #[schemars(schema_with = "positive_number_schema")]
    pub height: f64,
    /// For multi-call work, prefer a short public session label and repeat it on every call that
    /// accepts it. Omit it to use the authenticated transport's implicit lifecycle session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_schema")]
    pub session: Option<String>,
}

impl ToolInput for SetWindowFrameInput {
    const TOOL_NAME: &'static str = "set_window_frame";
}

/// Exact, immediate-child application menu path to resolve and invoke through
/// the operating system's accessibility API. Path labels are matched after
/// trimming surrounding whitespace and otherwise remain case-sensitive.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct InvokeMenuInput {
    #[schemars(schema_with = "positive_integer_schema")]
    pub pid: u32,
    #[schemars(schema_with = "positive_integer_schema")]
    pub window_id: u64,
    #[schemars(schema_with = "menu_path_schema")]
    pub path: Vec<String>,
    /// For multi-call work, prefer a short public session label and repeat it on every call that
    /// accepts it. Omit it to use the authenticated transport's implicit lifecycle session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_schema")]
    pub session: Option<String>,
}

impl ToolInput for InvokeMenuInput {
    const TOOL_NAME: &'static str = "invoke_menu";
}

impl ToolInput for MoveCursorInput {
    const TOOL_NAME: &'static str = "move_cursor";
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct ClickInput {
    #[schemars(schema_with = "number_schema")]
    pub x: f64,
    #[schemars(schema_with = "number_schema")]
    pub y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<ActionTarget>,
    /// Deprecated flat desktop target retained for wire compatibility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "desktop_scope_schema")]
    pub scope: Option<DesktopScope>,
    /// For multi-call work, prefer a short public session label and repeat it on every call that
    /// accepts it. Omit it to use the authenticated transport's implicit lifecycle session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_schema")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "click_button_schema")]
    pub button: Option<ClickButton>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "click_count_schema")]
    pub count: Option<u32>,
}

impl ToolInput for ClickInput {
    const TOOL_NAME: &'static str = "click";
}

/// Exact-window click input for the generated SDK. The existing [`ClickInput`]
/// remains the portable desktop-coordinate form.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct WindowClickInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_context: Option<bool>,
    #[schemars(schema_with = "positive_integer_schema")]
    pub pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "positive_integer_schema")]
    pub window_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "element_token_schema")]
    pub element_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "delivery_mode_schema")]
    pub delivery_mode: Option<DeliveryMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "number_schema")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "number_schema")]
    pub y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "click_button_schema")]
    pub button: Option<ClickButton>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "click_count_schema")]
    pub count: Option<u32>,
}

impl ToolInput for WindowClickInput {
    const TOOL_NAME: &'static str = "click";
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct DoubleClickInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_context: Option<bool>,
    #[schemars(schema_with = "positive_integer_schema")]
    pub pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "positive_integer_schema")]
    pub window_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "element_token_schema")]
    pub element_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "delivery_mode_schema")]
    pub delivery_mode: Option<DeliveryMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "number_schema")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "number_schema")]
    pub y: Option<f64>,
}

impl ToolInput for DoubleClickInput {
    const TOOL_NAME: &'static str = "double_click";
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct RightClickInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_context: Option<bool>,
    #[schemars(schema_with = "positive_integer_schema")]
    pub pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "positive_integer_schema")]
    pub window_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "element_token_schema")]
    pub element_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "delivery_mode_schema")]
    pub delivery_mode: Option<DeliveryMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "number_schema")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "number_schema")]
    pub y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_list_schema")]
    pub modifier: Option<Vec<String>>,
}

impl ToolInput for RightClickInput {
    const TOOL_NAME: &'static str = "right_click";
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct DragInput {
    #[schemars(schema_with = "number_schema")]
    pub from_x: f64,
    #[schemars(schema_with = "number_schema")]
    pub from_y: f64,
    #[schemars(schema_with = "number_schema")]
    pub to_x: f64,
    #[schemars(schema_with = "number_schema")]
    pub to_y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<ActionTarget>,
    /// Deprecated flat desktop target retained for wire compatibility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "desktop_scope_schema")]
    pub scope: Option<DesktopScope>,
    /// For multi-call work, prefer a short public session label and repeat it on every call that
    /// accepts it. Omit it to use the authenticated transport's implicit lifecycle session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_schema")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "drag_duration_schema")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "drag_steps_schema")]
    pub steps: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "click_button_schema")]
    pub button: Option<ClickButton>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_list_schema")]
    pub modifier: Option<Vec<String>>,
}

impl ToolInput for DragInput {
    const TOOL_NAME: &'static str = "drag";
}

/// Exact-window drag input for the generated SDK. The existing [`DragInput`]
/// keeps its established UniFFI record layout.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct WindowDragInput {
    #[schemars(schema_with = "positive_integer_schema")]
    pub pid: u32,
    #[schemars(schema_with = "positive_integer_schema")]
    pub window_id: u64,
    /// Let the macOS app workflow select the supported native drag route.
    #[uniffi(default = None)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_context: Option<bool>,
    #[schemars(schema_with = "number_schema")]
    pub from_x: f64,
    #[schemars(schema_with = "number_schema")]
    pub from_y: f64,
    #[schemars(schema_with = "number_schema")]
    pub to_x: f64,
    #[schemars(schema_with = "number_schema")]
    pub to_y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "drag_duration_schema")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "drag_steps_schema")]
    pub steps: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "delivery_mode_schema")]
    pub delivery_mode: Option<DeliveryMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "click_button_schema")]
    pub button: Option<ClickButton>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_list_schema")]
    pub modifier: Option<Vec<String>>,
}

impl ToolInput for WindowDragInput {
    const TOOL_NAME: &'static str = "drag";
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct ScrollInput {
    #[schemars(schema_with = "number_schema")]
    pub x: f64,
    #[schemars(schema_with = "number_schema")]
    pub y: f64,
    pub direction: ScrollDirection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<ActionTarget>,
    /// Deprecated flat desktop target retained for wire compatibility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "desktop_scope_schema")]
    pub scope: Option<DesktopScope>,
    /// For multi-call work, prefer a short public session label and repeat it on every call that
    /// accepts it. Omit it to use the authenticated transport's implicit lifecycle session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_schema")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "scroll_by_schema")]
    pub by: Option<ScrollBy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "scroll_amount_schema")]
    pub amount: Option<u64>,
}

impl ToolInput for ScrollInput {
    const TOOL_NAME: &'static str = "scroll";
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct WindowScrollInput {
    #[schemars(schema_with = "positive_integer_schema")]
    pub pid: u32,
    /// Use the app-bound target and focus policy independently of input delivery mode.
    #[uniffi(default = None)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_context: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "positive_integer_schema")]
    pub window_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "element_token_schema")]
    pub element_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "delivery_mode_schema")]
    pub delivery_mode: Option<DeliveryMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "number_schema")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "number_schema")]
    pub y: Option<f64>,
    pub direction: ScrollDirection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "scroll_by_schema")]
    pub by: Option<ScrollBy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "scroll_amount_schema")]
    pub amount: Option<u64>,
}

impl ToolInput for WindowScrollInput {
    const TOOL_NAME: &'static str = "scroll";
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct TypeTextInput {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<ActionTarget>,
    /// Deprecated flat desktop target retained for wire compatibility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "desktop_scope_schema")]
    pub scope: Option<DesktopScope>,
    /// For multi-call work, prefer a short public session label and repeat it on every call that
    /// accepts it. Omit it to use the authenticated transport's implicit lifecycle session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_schema")]
    pub session: Option<String>,
}

impl ToolInput for TypeTextInput {
    const TOOL_NAME: &'static str = "type_text";
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct WindowTypeTextInput {
    #[schemars(schema_with = "positive_integer_schema")]
    pub pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "positive_integer_schema")]
    pub window_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "element_token_schema")]
    pub element_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "delivery_mode_schema")]
    pub delivery_mode: Option<DeliveryMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_context: Option<bool>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay_ms: Option<u64>,
}

impl ToolInput for WindowTypeTextInput {
    const TOOL_NAME: &'static str = "type_text";
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct SetValueInput {
    #[schemars(schema_with = "positive_integer_schema")]
    pub pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "positive_integer_schema")]
    pub window_id: Option<u64>,
    #[schemars(schema_with = "element_token_schema")]
    pub element_token: String,
    pub value: String,
}

impl ToolInput for SetValueInput {
    const TOOL_NAME: &'static str = "set_value";
}

#[derive(
    Debug, Clone, Copy, Default, Serialize, Deserialize, JsonSchema, PartialEq, Eq, uniffi::Enum,
)]
#[serde(rename_all = "snake_case")]
pub enum PasteFormat {
    #[default]
    Text,
    Md,
    Html,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct PasteInput {
    #[schemars(schema_with = "positive_integer_schema")]
    pub pid: u32,
    #[schemars(schema_with = "positive_integer_schema")]
    pub window_id: u64,
    pub text: String,
    #[serde(default)]
    pub format: PasteFormat,
    #[serde(default)]
    #[uniffi(default = None)]
    pub app_context: Option<bool>,
}

impl ToolInput for PasteInput {
    const TOOL_NAME: &'static str = "paste";
}

#[derive(
    Debug, Clone, Copy, Default, Serialize, Deserialize, JsonSchema, PartialEq, Eq, uniffi::Enum,
)]
#[serde(rename_all = "snake_case")]
pub enum TextSelection {
    #[default]
    Text,
    CursorBefore,
    CursorAfter,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct SelectTextInput {
    #[schemars(schema_with = "positive_integer_schema")]
    pub pid: u32,
    #[schemars(schema_with = "positive_integer_schema")]
    pub window_id: u64,
    #[schemars(schema_with = "element_token_schema")]
    pub element_token: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suffix: Option<String>,
    #[serde(default)]
    pub selection: TextSelection,
}

impl ToolInput for SelectTextInput {
    const TOOL_NAME: &'static str = "select_text";
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct ClipboardReadInput {
    /// Return plain-text clipboard content in addition to the available types.
    /// Clipboard content is privacy-sensitive and is never retained in telemetry.
    #[serde(default)]
    pub include_text: bool,
    /// For multi-call work, prefer a short public session label and repeat it on every call that
    /// accepts it. Omit it to use the authenticated transport's implicit lifecycle session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_schema")]
    pub session: Option<String>,
}

impl ToolInput for ClipboardReadInput {
    const TOOL_NAME: &'static str = "clipboard_read";
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct ClipboardWriteInput {
    /// Plain text to place on the clipboard.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_schema")]
    pub text: Option<String>,
    /// Absolute path to a local image to place on the clipboard.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_schema")]
    pub image_path: Option<String>,
    /// Absolute path to a local file to place on the clipboard as a file URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_schema")]
    pub file_path: Option<String>,
    /// For multi-call work, prefer a short public session label and repeat it on every call that
    /// accepts it. Omit it to use the authenticated transport's implicit lifecycle session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_schema")]
    pub session: Option<String>,
}

impl ToolInput for ClipboardWriteInput {
    const TOOL_NAME: &'static str = "clipboard_write";
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct PressKeyInput {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<ActionTarget>,
    /// Deprecated flat desktop target retained for wire compatibility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "desktop_scope_schema")]
    pub scope: Option<DesktopScope>,
    /// For multi-call work, prefer a short public session label and repeat it on every call that
    /// accepts it. Omit it to use the authenticated transport's implicit lifecycle session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_schema")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_list_schema")]
    pub modifiers: Option<Vec<String>>,
}

impl ToolInput for PressKeyInput {
    const TOOL_NAME: &'static str = "press_key";
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct WindowPressKeyInput {
    #[schemars(schema_with = "positive_integer_schema")]
    pub pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "positive_integer_schema")]
    pub window_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "element_token_schema")]
    pub element_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "delivery_mode_schema")]
    pub delivery_mode: Option<DeliveryMode>,
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_list_schema")]
    pub modifiers: Option<Vec<String>>,
}

impl ToolInput for WindowPressKeyInput {
    const TOOL_NAME: &'static str = "press_key";
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct HotkeyInput {
    #[schemars(length(min = 2))]
    pub keys: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<ActionTarget>,
    /// Deprecated flat desktop target retained for wire compatibility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "desktop_scope_schema")]
    pub scope: Option<DesktopScope>,
    /// For multi-call work, prefer a short public session label and repeat it on every call that
    /// accepts it. Omit it to use the authenticated transport's implicit lifecycle session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "string_schema")]
    pub session: Option<String>,
}

impl ToolInput for HotkeyInput {
    const TOOL_NAME: &'static str = "hotkey";
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct WindowHotkeyInput {
    #[schemars(schema_with = "positive_integer_schema")]
    pub pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "positive_integer_schema")]
    pub window_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "element_token_schema")]
    pub element_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "delivery_mode_schema")]
    pub delivery_mode: Option<DeliveryMode>,
    #[schemars(length(min = 2))]
    pub keys: Vec<String>,
}

impl ToolInput for WindowHotkeyInput {
    const TOOL_NAME: &'static str = "hotkey";
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, uniffi::Record)]
#[serde(deny_unknown_fields)]
pub struct PerformSecondaryActionInput {
    #[schemars(schema_with = "positive_integer_schema")]
    pub pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "positive_integer_schema")]
    pub window_id: Option<u64>,
    #[schemars(schema_with = "element_token_schema")]
    pub element_token: String,
    pub action: String,
}

impl ToolInput for PerformSecondaryActionInput {
    const TOOL_NAME: &'static str = "perform_secondary_action";
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn input_schema_normalization_keeps_property_names_and_literal_values() {
        let mut schema = json!({
            "type":"object", "title":"Drop annotation", "properties": {
                "title": {"type":["string","null"], "default":null},
                "const": {"type":"object", "default":{"title":"literal","const":1}},
                "version": {"type":"integer","const":1}
            }
        });
        normalize_input_schema(&mut schema);
        assert_eq!(schema["properties"]["title"], json!({"type":"string"}));
        assert_eq!(
            schema["properties"]["const"]["default"],
            json!({"title":"literal","const":1})
        );
        assert_eq!(
            schema["properties"]["version"],
            json!({"type":"integer","minimum":1,"maximum":1})
        );
        assert!(schema.get("title").is_none());
        assert!(serde_json::from_value::<ActionTarget>(json!({"kind":"window","pid":1})).is_err());
        assert!(serde_json::from_value::<ActionTarget>(json!({"kind":"desktop"})).is_err());
    }

    #[test]
    fn generated_click_schema_matches_driver_dialect() {
        let schema = ClickInput::input_schema();
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["required"], json!(["x", "y"]));
        assert_eq!(schema["properties"]["scope"]["enum"], json!(["desktop"]));
        assert_eq!(schema["properties"]["target"]["type"], "object");
        assert!(schema["properties"]["target"].get("anyOf").is_none());
        assert_eq!(
            schema["properties"]["button"],
            json!({ "type": "string", "enum": ["left", "right", "middle"] })
        );
        assert_eq!(
            schema["properties"]["count"],
            json!({ "type": "integer", "minimum": 1, "maximum": 3 })
        );
    }

    #[test]
    fn exact_window_action_schemas_expose_the_runtime_delivery_ladder() {
        for schema in [
            WindowClickInput::input_schema(),
            DoubleClickInput::input_schema(),
            RightClickInput::input_schema(),
            WindowDragInput::input_schema(),
            WindowScrollInput::input_schema(),
            WindowTypeTextInput::input_schema(),
            WindowPressKeyInput::input_schema(),
            WindowHotkeyInput::input_schema(),
        ] {
            assert_eq!(
                schema["properties"]["delivery_mode"],
                json!({ "type": "string", "enum": ["background", "foreground"] })
            );
        }
    }

    #[test]
    fn generated_session_schema_makes_name_and_legacy_capture_optional() {
        let schema = StartSessionInput::input_schema();
        assert_eq!(schema["additionalProperties"], true);
        assert_eq!(schema["required"], json!([]));
        assert!(schema["properties"]["capture_scope"]
            .get("default")
            .is_none());
        assert_eq!(
            schema["properties"]["capture_scope"]["enum"],
            json!(["auto", "window", "desktop"])
        );
    }

    #[test]
    fn serde_and_schema_reject_unknown_fields() {
        let error = serde_json::from_value::<ClickInput>(json!({
            "x": 1,
            "y": 2,
            "pid": 3
        }))
        .expect_err("portable input must reject runtime-only fields");
        assert!(error.to_string().contains("unknown field `pid`"));
    }
}
