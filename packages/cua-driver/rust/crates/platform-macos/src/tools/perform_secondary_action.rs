use std::sync::Arc;

use async_trait::async_trait;
use cua_driver_core::{
    action_record::{
        ActionEffect, ActionEvidence, ActionExecutionRecord, ActionTransport, ActualDelivery,
        EvidenceKind, RequestedDelivery,
    },
    protocol::ToolResult,
    tool::{Tool, ToolDef},
};
use serde_json::{json, Value};

use crate::ax::bindings::{copy_action_names, kAXErrorSuccess, perform_action, AXUIElementRef};

use super::ToolState;

pub struct PerformSecondaryActionTool {
    state: Arc<ToolState>,
}

impl PerformSecondaryActionTool {
    pub fn new(state: Arc<ToolState>) -> Self {
        Self { state }
    }
}

static DEF: std::sync::OnceLock<ToolDef> = std::sync::OnceLock::new();

fn def() -> &'static ToolDef {
    DEF.get_or_init(|| ToolDef {
        name: "perform_secondary_action".into(),
        description: "Perform one exact action name advertised by a cached AX element. Unavailable actions fail closed and never fall back to AXPress or pixels.".into(),
        input_schema: json!({
            "type": "object",
            "required": ["pid", "element_token", "action"],
            "properties": {
                "pid": { "type": "integer", "minimum": 1 },
                "window_id": { "type": "integer", "minimum": 1 },
                "element_token": cua_driver_core::tool_schema::element_token_schema(),
                "action": { "type": "string", "minLength": 1 }
            },
            "additionalProperties": false
        }),
        read_only: false,
        destructive: true,
        idempotent: false,
        open_world: true,
    })
}

fn resolve_advertised_action(actions: &[String], requested: &str) -> Result<String, &'static str> {
    if requested.is_empty() {
        return Err("empty");
    }
    let mut matches = actions.iter().filter(|action| action.as_str() == requested);
    let Some(action) = matches.next() else {
        return Err("missing");
    };
    if matches.next().is_some() {
        return Err("ambiguous");
    }
    Ok(action.clone())
}

fn action_record(action: &str) -> ActionExecutionRecord {
    ActionExecutionRecord::builder(
        ActionEffect::Unverifiable,
        ActionTransport::MacosAxAction,
        RequestedDelivery::Background,
    )
    .actual_delivery(ActualDelivery::Background)
    .evidence(ActionEvidence {
        kind: EvidenceKind::NativeApiResult,
        detail: format!("AX reported success for the exact advertised action {action}"),
    })
    .build()
    .expect("secondary AX action record is valid")
}

#[async_trait]
impl Tool for PerformSecondaryActionTool {
    fn def(&self) -> &ToolDef {
        def()
    }

    async fn invoke(&self, args: Value) -> ToolResult {
        use cua_driver_core::tool_args::ArgsExt;
        let pid = match args.require_i32("pid") {
            Ok(pid) => pid,
            Err(error) => return error,
        };
        let requested = match args.require_str("action") {
            Ok(action) if !action.is_empty() => action,
            Ok(_) => return ToolResult::error("action must not be empty"),
            Err(error) => return error,
        };
        let window_id = args.opt_u64("window_id").map(|value| value as u32);
        let token = args.opt_str("element_token");
        let resolved = match cua_driver_core::element_token::resolve_element_args(
            pid,
            None,
            token.as_deref(),
            None,
            window_id,
            "perform_secondary_action",
        ) {
            Ok(resolved) => resolved,
            Err(error) => return error,
        };
        let cua_driver_core::element_token::ResolvedElement::Element {
            window_id: Some(window_id),
            element_index,
            ..
        } = resolved
        else {
            return ToolResult::error("perform_secondary_action requires a current element_token")
                .with_structured(json!({ "code": "invalid_element_target" }));
        };
        let element =
            match self
                .state
                .element_cache
                .get_element_retained(pid, window_id, element_index)
            {
                Some(element) => element,
                None => {
                    return ToolResult::error(
                        "element_token no longer resolves in the current AX snapshot",
                    )
                    .with_structured(json!({ "code": "stale_element_token" }))
                }
            };
        let element_ptr = element.as_ptr();
        let _lease = match super::gate_background_window_action(
            pid,
            window_id,
            Some(element_ptr),
            cua_driver_core::background_input::BackgroundAction::AxSemantic,
        )
        .await
        {
            Ok(lease) => lease,
            Err(refusal) => return refusal,
        };
        let requested_for_dispatch = requested.clone();
        let result = tokio::task::spawn_blocking(move || unsafe {
            let actions = copy_action_names(element_ptr as AXUIElementRef);
            let action = resolve_advertised_action(&actions, &requested_for_dispatch)
                .map_err(|reason| (reason, actions))?;
            let status = perform_action(element_ptr as AXUIElementRef, &action);
            (status == kAXErrorSuccess)
                .then_some(action)
                .ok_or(("native_failure", Vec::new()))
        })
        .await;
        match result {
            Ok(Ok(action)) => ToolResult::text(format!("Performed AX action {action}."))
                .with_structured(json!({
                    "effect": "unverifiable",
                    "route": "accessibility"
                }))
                .with_action_record(action_record(&action)),
            Ok(Err((reason, actions))) => ToolResult::error(format!(
                "secondary action '{requested}' was not performed ({reason}); advertised actions: {}",
                actions.join(", ")
            ))
            .with_structured(json!({ "code": "secondary_action_unavailable" })),
            Err(error) => ToolResult::error(format!("secondary action task failed: {error}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_matching_is_exact_without_fallback() {
        let actions = vec!["AXPress".to_owned(), "AXShowMenu".to_owned()];
        assert_eq!(
            resolve_advertised_action(&actions, "AXShowMenu"),
            Ok("AXShowMenu".into())
        );
        assert_eq!(
            resolve_advertised_action(&actions, "SHOW_MENU"),
            Err("missing")
        );
        assert_eq!(resolve_advertised_action(&actions, "Raise"), Err("missing"));
    }

    #[test]
    fn successful_secondary_action_has_a_publishable_execution_record() {
        let public = action_record("AXShowMenu").public_result().unwrap();
        assert_eq!(
            public.effect,
            cua_driver_contract::ActionEffect::Unverifiable
        );
        assert_eq!(
            public.route,
            cua_driver_contract::ActionRoute::Accessibility
        );
        assert_eq!(
            public.delivery.unwrap().mode,
            cua_driver_contract::ActionDeliveryMode::Background
        );
    }
}
