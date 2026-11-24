//! Shared delivery-mode logic for cua-driver Linux input tools.
//!
//! X11 background delivery uses semantic actions, XSendEvent or MPX. Foreground
//! delivery activates the target and restores the prior active window.

use serde_json::Value;

/// Input delivery modality — the agent-selected rung of the best-effort-
/// background ladder, passed per call (never a stored/config setting). Mirrors
/// macOS `tools::DeliveryMode` and Windows `input::delivery::DeliveryMode`.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub enum DeliveryMode {
    /// Inject without activating the target (X11 XTEST/MPX).
    #[default]
    Background,
    /// Activate the target, inject, restore prior active window.
    Foreground,
}

impl DeliveryMode {
    /// Parse the per-call `delivery_mode` argument. Anything other than an
    /// explicit case-insensitive `"foreground"` resolves to `Background` — the
    /// correct default, so an omitted/garbage value never silently fronts.
    /// Matches macOS / Windows `DeliveryMode::parse`.
    pub fn parse(arg: Option<&str>) -> Self {
        match arg {
            Some(s) if s.eq_ignore_ascii_case("foreground") => Self::Foreground,
            _ => Self::Background,
        }
    }

    /// Parse from a tool's JSON args, reading the `delivery_mode` field.
    pub fn from_args(args: &Value) -> Self {
        Self::parse(args.get("delivery_mode").and_then(|v| v.as_str()))
    }

    pub fn is_foreground(self) -> bool {
        matches!(self, Self::Foreground)
    }
}

/// JSON-schema fragment for the `delivery_mode` field. Include this in every
/// input tool's `input_schema.properties.delivery_mode`. Two modes, matching
/// the macOS / Windows surface.
pub fn delivery_mode_schema() -> Value {
    let mut v = cua_driver_core::tool_schema::delivery_mode_schema_with(
        "Input delivery mode. 'background' (default) does not activate the target. 'foreground' activates the exact X11 window for input and then restores the previous foreground.",
    );
    v["default"] = serde_json::json!("background");
    v
}

/// Reason background input is unavailable on the exact X11 target.
#[derive(Copy, Clone, Debug)]
pub enum BackgroundUnavailable {
    /// X11/Chromium does not accept synthetic pointer or keyboard input
    /// addressed to an occluded, unfocused renderer without briefly moving
    /// focus, which background delivery forbids.
    ChromiumInput,
    /// The remaining backend can only inject into the globally focused widget.
    FocusedInputOnly,
    /// WebKitGTK rejects synthetic XSendEvent input and no real target-addressed
    /// pointer backend is available in this session.
    WebKitSyntheticInput,
    /// Openbox promotes an MPX master's core FocusIn to global activation.
    WindowManagerFocus,
}

impl BackgroundUnavailable {
    fn code(self) -> &'static str {
        match self {
            Self::ChromiumInput => "background_unavailable",
            Self::FocusedInputOnly => "background_unavailable",
            Self::WebKitSyntheticInput => "background_unavailable",
            Self::WindowManagerFocus => "background_unavailable",
        }
    }
    fn detail(self) -> &'static str {
        match self {
            Self::ChromiumInput => {
                "Chromium/Electron does not accept pointer or keyboard input \
                 addressed to an occluded, unfocused renderer through X11 \
                 background injection"
            }
            Self::FocusedInputOnly => {
                "the requested target has no focus-free input backend; the remaining XTest/X11 route can only deliver to the globally focused widget"
            }
            Self::WebKitSyntheticInput => {
                "WebKitGTK rejects synthetic XSendEvent input and this session has no real target-addressed pointer backend"
            }
            Self::WindowManagerFocus => {
                "Openbox treats virtual keyboard focus as global window activation"
            }
        }
    }
}

impl std::fmt::Display for BackgroundUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.detail())
    }
}

impl std::error::Error for BackgroundUnavailable {}

/// Build the structured `background_unavailable` error returned when a
/// background injection has no usable backend. Mirrors the
/// Windows silent-drop error so callers branch on `code` identically.
pub fn background_unavailable_error(
    reason: BackgroundUnavailable,
) -> cua_driver_core::protocol::ToolResult {
    let detail = reason.detail();
    cua_driver_core::protocol::ToolResult::error(format!(
        "Background delivery is not available: {detail}. Retry this action with \
         delivery_mode:\"foreground\"; Cua Driver will activate the target for \
         the action and restore the previous foreground afterward."
    ))
    .with_structured(serde_json::json!({
        "code": reason.code(),
        "sent": false,
        "detail": detail,
        "suggestion": "Retry this action with delivery_mode:\"foreground\".",
        "escalation": {
            "recommended": "foreground",
            "reason": "background input is unavailable on this surface; retry this \
                       action with delivery_mode:\"foreground\".",
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delivery_mode_parses_known_values() {
        let j = |s: &str| serde_json::json!({"delivery_mode": s});
        assert_eq!(
            DeliveryMode::from_args(&j("background")),
            DeliveryMode::Background
        );
        assert_eq!(
            DeliveryMode::from_args(&j("foreground")),
            DeliveryMode::Foreground
        );
        // Case-insensitive, matching macOS / Windows.
        assert_eq!(
            DeliveryMode::from_args(&j("Foreground")),
            DeliveryMode::Foreground
        );
    }

    #[test]
    fn delivery_mode_defaults_to_background() {
        // Missing field, garbage value, null, and the removed legacy "auto" all
        // resolve to Background — the no-foreground-by-default contract.
        assert_eq!(
            DeliveryMode::from_args(&serde_json::json!({})),
            DeliveryMode::Background
        );
        assert_eq!(
            DeliveryMode::from_args(&serde_json::json!({"delivery_mode": "garbage"})),
            DeliveryMode::Background
        );
        assert_eq!(
            DeliveryMode::from_args(&serde_json::json!({"delivery_mode": "auto"})),
            DeliveryMode::Background
        );
        assert_eq!(
            DeliveryMode::from_args(&serde_json::json!({"delivery_mode": null})),
            DeliveryMode::Background
        );
    }

    #[test]
    fn delivery_mode_schema_advertises_two_modes() {
        let s = delivery_mode_schema();
        let en: Vec<&str> = s["enum"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert_eq!(en, vec!["background", "foreground"]);
        assert_eq!(s["default"], "background");
        let description = s["description"]
            .as_str()
            .expect("delivery_mode description");
        assert!(!description.contains("bring_to_front"));
    }

    #[test]
    fn background_unavailable_error_carries_code() {
        let r = background_unavailable_error(BackgroundUnavailable::FocusedInputOnly);
        assert_eq!(r.is_error, Some(true));
        assert_eq!(
            r.structured_content.as_ref().unwrap()["code"],
            serde_json::json!("background_unavailable")
        );
        let text = match &r.content[0] {
            cua_driver_core::protocol::Content::Text { text, .. } => text,
            _ => panic!("expected text content"),
        };
        let structured = r.structured_content.as_ref().unwrap();
        assert!(text.contains("Retry this action with delivery_mode:\"foreground\""));
        assert!(!text.contains("bring_to_front"));
        assert_eq!(
            structured["suggestion"].as_str(),
            Some("Retry this action with delivery_mode:\"foreground\".")
        );
        assert_eq!(
            structured["escalation"]["recommended"].as_str(),
            Some("foreground")
        );
        assert!(!structured["escalation"]["reason"]
            .as_str()
            .unwrap_or_default()
            .contains("bring_to_front"));
    }
}
