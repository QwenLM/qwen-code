use async_trait::async_trait;
use cua_driver_core::{protocol::ToolResult, tool::{Tool, ToolDef}};
use serde_json::Value;
use std::sync::Arc;

use super::{write_driver_config_updates, ConfigOverrides, ToolState};

pub struct SetConfigTool {
    state: Arc<ToolState>,
}

impl SetConfigTool {
    pub fn new(state: Arc<ToolState>) -> Self { Self { state } }
}

static DEF: std::sync::OnceLock<ToolDef> = std::sync::OnceLock::new();

fn def() -> &'static ToolDef {
    DEF.get_or_init(|| ToolDef {
        name: "set_config".into(),
        description: "Update cua-driver-rs configuration. Changes to \
            max_image_dimension and capture_scope take effect immediately. The \
            experimental_pip keys are persisted to ~/.cua-driver/config.json and \
            take effect on the next daemon restart (the PiP backend is \
            initialised once at startup).\n\nNote: capture_mode is a per-call \
            param (on get_window_state / click), not a stored setting. \
            capture_scope gates get_desktop_state (full-display capture requires \
            capture_scope=desktop) and is isolated per named MCP session.".into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "key": {
                    "type": "string",
                    "description": "Name of a single config field to write ({key, value} shape, \
                        matching the CLI `config set` and the Windows/Linux tools). Pair with `value`. \
                        Equivalent to passing the field directly."
                },
                "value": {
                    "description": "New value for `key`. JSON type depends on the key."
                },
                "max_image_dimension": {
                    "type": "integer",
                    "description": "Max dimension for screenshot resizing (0 = no limit)."
                },
                "capture_scope": {
                    "type": "string",
                    "enum": ["window", "desktop"],
                    "description": "Capture scope: \"window\" (default) or \"desktop\". Desktop \
                        scope enables get_desktop_state (full-display capture) and window-less \
                        screen-absolute click/scroll. Session-scoped for MCP; takes effect immediately."
                },
                "experimental_pip": {
                    "type": "boolean",
                    "description": "Enable the experimental picture-in-picture preview window. \
                        Applies on next daemon restart."
                },
                "experimental_pip_geometry": {
                    "type": "string",
                    "description": "PiP window size + optional position in `WxH` or `WxH+X+Y` \
                        form (e.g. `320x200+24+24`). Applies on next daemon restart."
                }
            },
            "additionalProperties": false
        }),
        read_only: false,
        destructive: false,
        idempotent: true,
        open_world: false,
    })
}

#[async_trait]
impl Tool for SetConfigTool {
    fn def(&self) -> &ToolDef { def() }

    async fn invoke(&self, args: Value) -> ToolResult {
        use cua_driver_core::tool_args::ArgsExt;
        // The daemon injects `_session_id` for non-anonymous MCP sessions.
        // Absent => anonymous/global session (CLI one-shot, legacy proxy) =>
        // today's behavior: write the shared global DriverConfig + persist to
        // disk. Present => session-scoped in-memory override only, never
        // touching the global config or the on-disk default, so two concurrent
        // sessions don't clobber each other or the persisted default.
        let session_id = args.opt_str("_session_id");

        // Accept BOTH shapes, matching Windows/Linux + the CLI `config set`:
        //   - direct fields:  {"capture_scope":"desktop"}
        //   - {key, value}:    {"key":"capture_scope","value":"desktop"}
        // A direct field wins if both are somehow present.
        let kv: Option<(String, Value)> = args
            .opt_str("key")
            .and_then(|k| args.get("value").map(|v| (k, v.clone())));
        let kv_u64 = |name: &str| -> Option<u64> {
            kv.as_ref().filter(|(k, _)| k == name).and_then(|(_, v)| v.as_u64())
        };

        // Validate max_image_dimension up front so both branches share the
        // u32 check and we never half-apply.
        let max_dim: Option<u32> = match args.opt_u64("max_image_dimension").or_else(|| kv_u64("max_image_dimension")) {
            Some(dim) => match u32::try_from(dim) {
                Ok(d) => Some(d),
                Err(_) => return ToolResult::error(format!("max_image_dimension {dim} exceeds u32::MAX")),
            },
            None => None,
        };

        let scope_arg = args.opt_str("capture_scope").or_else(|| {
            kv.as_ref()
                .filter(|(k, _)| k == "capture_scope")
                .and_then(|(_, v)| v.as_str().map(str::to_owned))
        });
        if let Some(ref scope) = scope_arg {
            if scope != "window" && scope != "desktop" {
                return ToolResult::error(format!(
                    "`capture_scope` must be \"window\" or \"desktop\", got \"{scope}\"."
                ));
            }
        }

        let pip_enabled = args.get("experimental_pip").and_then(|v| v.as_bool());
        let pip_geometry = args.opt_str("experimental_pip_geometry");
        if let Some(ref geometry) = pip_geometry {
            if pip_preview::PipGeometry::parse(geometry).is_none() {
                return ToolResult::error(format!(
                    "experimental_pip_geometry `{geometry}` is not a valid WxH or WxH+X+Y string"
                ));
            }
        }

        let mut updates = Vec::new();
        if session_id.is_none() {
            if let Some(dim32) = max_dim {
                updates.push(("max_image_dimension", Value::Number(u64::from(dim32).into())));
            }
            if let Some(ref scope) = scope_arg {
                updates.push(("capture_scope", Value::String(scope.clone())));
            }
        }
        if let Some(enabled) = pip_enabled {
            updates.push(("experimental_pip", Value::Bool(enabled)));
        }
        if let Some(ref geometry) = pip_geometry {
            updates.push(("experimental_pip_geometry", Value::String(geometry.clone())));
        }
        if !updates.is_empty() {
            if let Err(e) = write_driver_config_updates(&updates) {
                return ToolResult::error(format!(
                    "failed to persist cua-driver configuration: {e}"
                ));
            }
        }

        let (effective_dim, effective_scope) = if let Some(sid) = session_id.as_deref() {
            // These session-scoped fields are in-memory only; PiP settings above
            // remain global because the backend reads them once at daemon startup.
            self.state.session_config.set(sid, ConfigOverrides {
                max_image_dimension: max_dim,
                capture_scope: scope_arg.clone(),
            });
            let cfg = self.state.config.read().unwrap();
            (
                self.state.session_config.effective_max_image_dimension(Some(sid), &cfg),
                self.state.session_config.effective_capture_scope(Some(sid), &cfg),
            )
        } else {
            let mut cfg = self.state.config.write().unwrap();
            if let Some(dim32) = max_dim {
                cfg.max_image_dimension = dim32;
            }
            if let Some(ref scope) = scope_arg {
                cfg.capture_scope = scope.clone();
            }
            (cfg.max_image_dimension, cfg.capture_scope.clone())
        };
        // PiP keys persist to the same config.json but take effect only on
        // next daemon restart — the backend is initialised once at startup.
        let mut pip_note = String::new();
        if let Some(enabled) = pip_enabled {
            pip_note = format!(" — restart cua-driver for experimental_pip={enabled} to take effect");
        }
        if let Some(geom) = pip_geometry {
            if pip_note.is_empty() {
                pip_note = format!(" — restart cua-driver for experimental_pip_geometry={geom} to take effect");
            }
        }
        let capture_scope_note = scope_arg
            .as_ref()
            .map(|scope| format!(", capture_scope={scope}"))
            .unwrap_or_default();

        let scope_note = if session_id.is_some() {
            " (session-scoped; persisted default unchanged)"
        } else {
            ""
        };
        // Echo the config back in structured content (matches Windows/Linux
        // set_config, which callers/tests read for the applied capture_scope).
        ToolResult::text(format!(
            "Config updated: max_image_dimension={}{}{}{}",
            effective_dim, capture_scope_note, scope_note, pip_note
        ))
        .with_structured(serde_json::json!({
            "version": env!("CARGO_PKG_VERSION"),
            "platform": "macos",
            "max_image_dimension": effective_dim,
            "capture_scope": effective_scope,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn invalid_pip_geometry_does_not_apply_session_overrides() {
        let state = Arc::new(ToolState::default());
        let global_scope = state.config.read().unwrap().capture_scope.clone();
        let requested_scope = if global_scope == "window" { "desktop" } else { "window" };
        let tool = SetConfigTool::new(state.clone());
        let session = "set-config-validation-test";

        let result = tool.invoke(serde_json::json!({
            "_session_id": session,
            "capture_scope": requested_scope,
            "experimental_pip_geometry": "bad",
        })).await;

        assert_eq!(result.is_error, Some(true));
        let cfg = state.config.read().unwrap();
        assert_eq!(
            state.session_config.effective_capture_scope(Some(session), &cfg),
            global_scope,
        );
    }
}
