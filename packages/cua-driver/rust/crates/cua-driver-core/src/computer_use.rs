use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::protocol::{Content, ToolResult};
use crate::tool::{DispatchSessionIdentity, Tool, ToolDef, ToolRegistry};

pub(crate) struct Entry(ToolDef);

impl Entry {
    pub(crate) fn new(spec: cua_driver_contract::computer_use::ComputerUseTool) -> Self {
        Self(ToolDef {
            name: spec.name.into(),
            description: spec.description.into(),
            input_schema: spec.input_schema,
            read_only: spec.read_only,
            destructive: false,
            idempotent: spec.read_only,
            open_world: !spec.read_only,
        })
    }
}

#[async_trait::async_trait]
impl Tool for Entry {
    fn def(&self) -> &ToolDef {
        &self.0
    }
    async fn invoke(&self, _args: Value) -> ToolResult {
        error(
            "unsupported_on_platform",
            "This app operation has no native implementation on this platform.",
            false,
        )
    }
}

#[derive(Default)]
pub(crate) struct ComputerUseRuntime {
    apps: Mutex<HashMap<(DispatchSessionIdentity, String), Arc<tokio::sync::Mutex<AppState>>>>,
    desktops:
        Mutex<HashMap<DispatchSessionIdentity, Arc<tokio::sync::Mutex<Option<DesktopFrame>>>>>,
}

#[derive(Clone, Copy)]
struct DesktopFrame {
    image: [f64; 2],
    screen: [f64; 2],
    scale: f64,
}

impl DesktopFrame {
    fn from_capture(value: &Value) -> Option<Self> {
        let frame = Self {
            image: [
                value["screenshot_width"].as_f64()?,
                value["screenshot_height"].as_f64()?,
            ],
            screen: [
                value["screen_width"].as_f64()?,
                value["screen_height"].as_f64()?,
            ],
            scale: value["scale_factor"].as_f64().unwrap_or(1.0),
        };
        let valid = frame
            .image
            .iter()
            .chain(frame.screen.iter())
            .chain([&frame.scale])
            .all(|n| n.is_finite() && *n > 0.0);
        valid.then_some(frame)
    }
    fn map(&self, input: &mut Value, x: &str, y: &str) -> Result<(), ToolResult> {
        for (axis, key) in [x, y].into_iter().enumerate() {
            let value = input[key]
                .as_f64()
                .filter(|n| n.is_finite() && *n >= 0.0 && *n < self.image[axis])
                .ok_or_else(|| {
                    error(
                        "invalid_arguments",
                        format!("{key} must be inside the current desktop screenshot."),
                        false,
                    )
                })?;
            input[key] = json!(value * self.screen[axis] / self.image[axis]);
        }
        Ok(())
    }
}

#[derive(Default)]
struct AppState {
    window: Option<(u64, u64)>,
    revision: Option<String>,
    lineage: Option<String>,
    ids: HashMap<u64, u64>,
    next_id: u64,
    tokens: HashMap<u64, String>,
    screenshot: bool,
    last_action: Option<std::time::Instant>,
}

pub(crate) fn error(code: &str, reason: impl Into<String>, sent: bool) -> ToolResult {
    ToolResult::computer_use_error(code, reason, sent)
}

fn text(result: &ToolResult) -> String {
    result
        .content
        .iter()
        .filter_map(|part| match part {
            Content::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn checked(result: ToolResult, mutating: bool) -> Result<ToolResult, ToolResult> {
    if result.is_error != Some(true) {
        return Ok(result);
    }
    let structured = result.structured_content.as_ref();
    let message = text(&result);
    let code = structured
        .and_then(|value| value.get("code").or_else(|| value.pointer("/refusal/code")))
        .and_then(Value::as_str)
        .or_else(|| {
            [
                "no_focused_text_input",
                "not_settable",
                "write_not_applied",
                "user_input_detected",
                "foreground_unavailable",
                "target_occluded",
                "text_delivery_stalled",
            ]
            .into_iter()
            .find(|code| message.contains(&format!("{code}:")))
        })
        .unwrap_or("operation_failed");
    let stale = matches!(
        code,
        "stale_element_token"
            | "invalid_element_token"
            | "generation_mismatch"
            | "snapshot_id_required"
    );
    let pre_dispatch = stale
        || matches!(
            code,
            "no_focused_text_input" | "not_settable" | "foreground_unavailable" | "target_occluded"
        );
    let sent = structured
        .and_then(|value| value.get("sent"))
        .and_then(Value::as_bool)
        .unwrap_or(mutating && !pre_dispatch);
    Err(error(
        if stale { "element_stale" } else { code },
        message,
        sent,
    ))
}

fn authorize_app(
    name: &str,
    args: &Value,
    pid: Option<u64>,
    window: Option<u64>,
) -> Result<(), ToolResult> {
    let mut resolved = args.clone();
    if let Some(pid) = pid {
        resolved["pid"] = json!(pid);
    }
    if let Some(window) = window {
        resolved["window_id"] = json!(window);
    }
    crate::policy::authorize_tool_call(name, &resolved)
        .map_err(|reason| error("permission_denied", reason.to_string(), false))
}

fn validate(name: &str, args: &Value) -> Result<(), ToolResult> {
    let spec = cua_driver_contract::computer_use::tools()
        .into_iter()
        .find(|tool| tool.name == name)
        .ok_or_else(|| error("unsupported_on_platform", "Unknown app operation.", false))?;
    let Some(input) = args.as_object() else {
        return Err(error(
            "invalid_arguments",
            "Arguments must be an object.",
            false,
        ));
    };
    let properties = spec.input_schema["properties"].as_object().unwrap();
    let desktop = input.get("scope").is_some_and(|scope| scope == "desktop");
    if name != "get_state"
        && (desktop == input.contains_key("app")
            || matches!(name, "key_down" | "key_up") && !desktop)
    {
        return Err(error(
            "invalid_arguments",
            "Select exactly one app or scope:desktop. key_down/key_up require desktop scope.",
            false,
        ));
    }
    if desktop && input.contains_key("element") {
        return Err(error(
            "invalid_arguments",
            "Desktop input requires screenshot coordinates, not an app element ID.",
            false,
        ));
    }
    for field in spec.input_schema["required"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if !input.contains_key(field) {
            return Err(error(
                "invalid_arguments",
                format!("{field} is required."),
                false,
            ));
        }
    }
    for (field, value) in input {
        let schema = properties.get(field).ok_or_else(|| {
            error(
                "invalid_arguments",
                format!("Unknown app option {field}."),
                false,
            )
        })?;
        let typed = match schema["type"].as_str() {
            Some("string") => value.is_string(),
            Some("integer") => value.is_i64() || value.is_u64(),
            Some("number") => value.is_number(),
            Some("boolean") => value.is_boolean(),
            Some("array") => {
                // The JS click API also accepts one modifier as a string.
                name == "click" && field == "key" && value.is_string()
                    || value
                        .as_array()
                        .is_some_and(|values| values.iter().all(Value::is_string))
            }
            _ => {
                value.is_string()
                    || value
                        .as_array()
                        .is_some_and(|values| values.iter().all(Value::is_string))
            }
        };
        let range = value.as_f64().is_none_or(|number| {
            schema["minimum"]
                .as_f64()
                .is_none_or(|minimum| number >= minimum)
                && schema["maximum"]
                    .as_f64()
                    .is_none_or(|maximum| number <= maximum)
        });
        let enumeration = schema["enum"]
            .as_array()
            .is_none_or(|choices| choices.contains(value));
        let length = value.as_str().is_none_or(|text| {
            schema["minLength"]
                .as_u64()
                .is_none_or(|min| text.chars().count() >= min as usize)
        }) && value.as_array().is_none_or(|values| {
            schema["minItems"]
                .as_u64()
                .is_none_or(|min| values.len() >= min as usize)
        });
        if !typed || !range || !enumeration || !length {
            return Err(error(
                "invalid_arguments",
                format!("Invalid value for {field}."),
                false,
            ));
        }
    }
    if input.contains_key("element") && (input.contains_key("x") || input.contains_key("y")) {
        return Err(error(
            "invalid_arguments",
            "Use an element ID or coordinates, not both.",
            false,
        ));
    }
    Ok(())
}

fn normalized_path(value: &str) -> Option<String> {
    let windows = value.as_bytes().get(1) == Some(&b':') || value.starts_with("\\\\");
    if !value.starts_with('/') && !windows {
        return None;
    }
    let value = if windows {
        value.replace('\\', "/").to_lowercase()
    } else {
        value.to_owned()
    };
    let mut components = Vec::new();
    for component in value.split('/') {
        match component {
            "." => {}
            ".." if components.last().is_some_and(|last| *last != "") => {
                components.pop();
            }
            ".." => {}
            _ => components.push(component),
        }
    }
    Some(components.join("/").trim_end_matches('/').to_owned())
}

fn identity(app: &Value) -> String {
    let launch = app["launch_path"].as_str().unwrap_or_default();
    let bundle = app["bundle_id"].as_str().unwrap_or_default();
    if opaque_launch(app) {
        return launch.to_owned();
    }
    normalized_path(launch)
        .or_else(|| (!bundle.is_empty()).then(|| bundle.to_owned()))
        .unwrap_or_else(|| app["name"].as_str().unwrap_or_default().to_owned())
}

fn opaque_launch(app: &Value) -> bool {
    let launch = app["launch_path"].as_str().unwrap_or_default();
    let bundle = app["bundle_id"].as_str().unwrap_or_default();
    !bundle.starts_with('/')
        && normalized_path(bundle).is_some()
        && !launch.is_empty()
        && launch != bundle
}

fn resolve_app(apps: &Value, selector: &str) -> Result<Value, ToolResult> {
    if selector.trim().is_empty() {
        return Err(error(
            "app_not_found",
            "An exact application selector is required.",
            false,
        ));
    }
    let path = normalized_path(selector);
    let needle = selector.trim().to_lowercase();
    let matches = apps
        .as_array()
        .into_iter()
        .flatten()
        .filter(|app| {
            identity(app) == selector
                || if let Some(path) = &path {
                    ["launch_path", "bundle_id"]
                        .iter()
                        .filter(|key| **key != "launch_path" || !opaque_launch(app))
                        .any(|key| {
                            app[*key].as_str().and_then(normalized_path).as_ref() == Some(path)
                        })
                } else {
                    ["name", "bundle_id"].iter().any(|key| {
                        app[*key]
                            .as_str()
                            .is_some_and(|value| value.to_lowercase() == needle)
                    })
                }
        })
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [] => Err(error(
            "app_not_found",
            format!("No application matches {selector:?}."),
            false,
        )),
        [app] => Ok((*app).clone()),
        _ => Err(error(
            "app_ambiguous",
            "Use a unique application identifier or absolute path.",
            false,
        )),
    }
}

impl AppState {
    fn select_window(&mut self, pid: u64, windows: &Value) -> Result<Value, ToolResult> {
        let selected = windows
            .as_array()
            .into_iter()
            .flatten()
            .filter(|window| window["is_app_target"] == true)
            .collect::<Vec<_>>();
        let [window] = selected.as_slice() else {
            self.invalidate();
            return Err(error(
                "window_not_found",
                "The app has no unambiguous selected window.",
                false,
            ));
        };
        let Some(window_id) = window["window_id"].as_u64() else {
            return Err(error(
                "window_not_found",
                "The selected window has no native identity.",
                false,
            ));
        };
        let key = (window["pid"].as_u64().unwrap_or(pid), window_id);
        if self.window != Some(key) {
            self.invalidate();
            self.window = Some(key);
        }
        Ok((*window).clone())
    }

    fn invalidate(&mut self) {
        self.window = None;
        self.revision = None;
        self.lineage = None;
        self.ids.clear();
        self.tokens.clear();
        self.screenshot = false;
    }

    fn id(&mut self, native: u64) -> u64 {
        *self.ids.entry(native).or_insert_with(|| {
            self.next_id += 1;
            self.next_id
        })
    }

    fn render(&mut self, raw: &str, budget: usize) -> String {
        let mut lines = Vec::new();
        let mut chars = 0;
        for line in raw.lines() {
            let start = line.find('[').filter(|start| {
                line[..*start]
                    .chars()
                    .all(|c| c.is_whitespace() || matches!(c, '+' | '-' | '~'))
            });
            let rendered = if let Some(start) = start {
                let end = line[start..].find(']').map(|end| end + start);
                if let Some((end, native)) =
                    end.and_then(|end| line[start + 1..end].parse::<u64>().ok().map(|id| (end, id)))
                {
                    format!(
                        "{}[{}]{}",
                        &line[..start],
                        self.id(native),
                        &line[end + 1..]
                    )
                } else {
                    line.to_owned()
                }
            } else {
                line.to_owned()
            };
            if chars + rendered.chars().count() + 1 > budget.saturating_sub(100) {
                lines.push(
                    "Text truncated. Request force_full:true with a larger max_text_chars.".into(),
                );
                break;
            }
            chars += rendered.chars().count() + 1;
            lines.push(rendered);
        }
        lines.join("\n")
    }
}

impl ComputerUseRuntime {
    pub(crate) fn clear_session(&self, session: &str) {
        self.apps
            .lock()
            .unwrap()
            .retain(|(owner, _), _| owner.session_id != session);
        self.desktops.lock().unwrap().retain(|owner, _| {
            owner.session_id != session && owner.transport_session_id != session
        });
    }

    pub(crate) async fn invoke(
        &self,
        registry: &ToolRegistry,
        name: &str,
        args: Value,
    ) -> ToolResult {
        match self.invoke_inner(registry, name, args).await {
            Ok(result) | Err(result) => result,
        }
    }

    async fn invoke_inner(
        &self,
        registry: &ToolRegistry,
        name: &str,
        args: Value,
    ) -> Result<ToolResult, ToolResult> {
        validate(name, &args)?;
        if args["scope"] == "desktop" {
            return self.desktop(registry, name, args).await;
        }
        if name == "get_state" {
            authorize_app(name, &args, None, None)?;
        }
        let session = args.get("session").cloned();
        let call = |name: &'static str, mut input: Value| {
            if let Some(session) = &session {
                input["session"] = session.clone();
            }
            Box::pin(registry.invoke_computer_use_native(name, input))
        };
        let apps = checked(call("list_apps", json!({})).await, false)?;
        let apps = apps
            .structured_content
            .as_ref()
            .and_then(|value| value.get("apps"))
            .ok_or_else(|| {
                error(
                    "app_not_found",
                    "The driver returned no application inventory.",
                    false,
                )
            })?;
        if name == "get_state" {
            let inventory = checked(call("list_windows", json!({})).await, false)?;
            let windows = inventory.structured_content.as_ref()
                .and_then(|value| value["windows"].as_array()).into_iter().flatten()
                .map(|window| {
                    let app = apps.as_array().into_iter().flatten()
                        .find(|app| app["pid"] == window["pid"]);
                    json!({"app":app.map(identity),"title":window["title"],"minimized":window["minimized"]})
                }).collect::<Vec<_>>();
            let apps = apps
                .as_array()
                .into_iter()
                .flatten()
                .map(|app| {
                    json!({
                        "id":identity(app),"displayName":app["name"],"isRunning":app["running"],
                    })
                })
                .collect::<Vec<_>>();
            let inventory = json!({"apps":apps,"windows":windows});
            return Ok(
                ToolResult::text(serde_json::to_string_pretty(&inventory).unwrap())
                    .with_structured(inventory),
            );
        }
        let selector = args
            .get("app")
            .and_then(Value::as_str)
            .ok_or_else(|| error("app_not_found", "Provide an application selector.", false))?;
        let observing = matches!(
            name,
            "get_app" | "get_ax_state" | "get_screenshot" | "get_ax_state_and_screenshot"
        );
        let mut app = resolve_app(apps, selector)?;
        let owner = crate::tool::current_dispatch_session_identity().ok_or_else(|| {
            error(
                "session_unavailable",
                "A bound driver session is required.",
                false,
            )
        })?;
        let state = self
            .apps
            .lock()
            .unwrap()
            .entry((owner, identity(&app)))
            .or_default()
            .clone();
        let mut state = state.lock().await;
        if app["running"] == false || app["pid"].as_u64().unwrap_or(0) == 0 {
            state.invalidate();
            if name != "get_app" {
                return Err(error(
                    "app_not_running",
                    "Actions do not relaunch a stopped app.",
                    false,
                ));
            }
            authorize_app(name, &args, None, None)?;
            let launch = app["launch_path"]
                .as_str()
                .or_else(|| app["bundle_id"].as_str())
                .or_else(|| app["name"].as_str())
                .unwrap_or(selector);
            let mut input = json!({"name":launch});
            if cfg!(target_os = "windows") {
                input = json!({"name":app["name"], "launch_path":launch});
            }
            checked(call("launch_app", input).await, true)?;
            let apps = checked(call("list_apps", json!({"running_only":true})).await, false)?;
            app = resolve_app(
                &apps
                    .structured_content
                    .as_ref()
                    .map(|value| value["apps"].clone())
                    .unwrap_or(Value::Null),
                selector,
            )?;
        }
        let pid = app["pid"]
            .as_u64()
            .filter(|pid| *pid > 0)
            .ok_or_else(|| error("app_not_running", "The app has no running process.", false))?;
        let readiness_deadline = (observing && name != "get_screenshot")
            .then(|| std::time::Instant::now() + crate::tool::AX_READINESS_BUDGET);
        let call = |name: &'static str, mut input: Value| {
            if let Some(session) = &session {
                input["session"] = session.clone();
            }
            Box::pin(registry.invoke_computer_use_native_with_readiness(
                name,
                input,
                readiness_deadline,
            ))
        };
        let mut windows = checked(
            call("list_windows", json!({"pid":pid,"app_context":true})).await,
            false,
        )?;
        if observing {
            if let Some(action) = state.last_action.take() {
                let deadline = action + std::time::Duration::from_millis(400);
                let mut quiet = 0;
                while std::time::Instant::now() < deadline {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    let next = checked(
                        call("list_windows", json!({"pid":pid,"app_context":true})).await,
                        false,
                    )?;
                    if next.structured_content == windows.structured_content {
                        quiet += 1;
                    } else {
                        quiet = 0;
                    }
                    windows = next;
                    if quiet >= 2 && action.elapsed() >= std::time::Duration::from_millis(300) {
                        break;
                    }
                }
            }
        }
        let window = state.select_window(
            pid,
            &windows
                .structured_content
                .as_ref()
                .map(|value| value["windows"].clone())
                .unwrap_or(Value::Null),
        )?;
        let (pid, window_id) = state.window.expect("selected window");
        authorize_app(name, &args, Some(pid), Some(window_id))?;
        if observing {
            let budget = args
                .get("max_text_chars")
                .and_then(Value::as_u64)
                .unwrap_or(12000);
            if !(512..=1000000).contains(&budget) {
                return Err(error(
                    "invalid_arguments",
                    "max_text_chars must be between 512 and 1000000.",
                    false,
                ));
            }
            let screenshot_only = name == "get_screenshot";
            let mut input = json!({"pid":pid,"window_id":window_id,"app_context":true,
                "include_screenshot":name == "get_screenshot" || name == "get_ax_state_and_screenshot",
                "include_accessibility":!screenshot_only});
            if !screenshot_only {
                input["observation_revision"] = json!({"version":1,
                    "serializer_version":crate::observation_revision::ACCESSIBILITY_SERIALIZER_VERSION,
                    "projection_version":crate::observation_revision::APP_ACCESSIBILITY_PROJECTION_VERSION,
                    "force_full":name == "get_app" || args["force_full"] == true || state.revision.is_none()});
                if let Some(base) = &state.revision {
                    input["observation_revision"]["base_revision_id"] = json!(base);
                }
                for field in ["max_elements", "max_depth"] {
                    if let Some(value) = args.get(field) {
                        input[field] = value.clone();
                    }
                }
            }
            let observed = checked(call("get_window_state", input).await, false)?;
            let structured = observed
                .structured_content
                .as_ref()
                .cloned()
                .unwrap_or_default();
            if !screenshot_only {
                let lineage = structured["observation_revision"]["lineage_id"]
                    .as_str()
                    .map(str::to_owned);
                if state.lineage != lineage || lineage.is_none() {
                    state.ids.clear();
                }
                state.lineage = lineage;
                state.tokens.clear();
                for element in structured["elements"].as_array().into_iter().flatten() {
                    if let Some((native, token)) = element["element_id"]
                        .as_u64()
                        .or_else(|| element["element_index"].as_u64())
                        .zip(element["element_token"].as_str())
                    {
                        let id = state.id(native);
                        state.tokens.insert(id, token.to_owned());
                    }
                }
                state.revision = structured["observation_revision"]["revision_id"]
                    .as_str()
                    .map(str::to_owned);
            }
            state.screenshot = observed
                .content
                .iter()
                .any(|part| matches!(part, Content::Image { .. }))
                && structured["screenshot_frame_valid"] != false;
            if (screenshot_only || name == "get_ax_state_and_screenshot") && !state.screenshot {
                return Err(error(
                    "screenshot_unavailable",
                    "The driver could not establish a current image frame.",
                    false,
                ));
            }
            let mode = structured["observation_revision"]["mode"]
                .as_str()
                .unwrap_or("full");
            let mut body = if screenshot_only {
                "Window screenshot.".to_owned()
            } else {
                state.render(
                    structured["tree_markdown"]
                        .as_str()
                        .unwrap_or(&text(&observed)),
                    budget as usize,
                )
            };
            if !screenshot_only && structured["capture_complete"] == false {
                body = format!("Accessibility capture is incomplete; only current captured IDs are actionable. Use a screenshot or a larger capture budget if needed.\n{body}");
            }
            if let Some(note) = structured["off_space_staleness"].as_str() {
                body = format!("{note}\n{body}");
            }
            let title = window["title"].as_str().unwrap_or_default();
            let mut metadata =
                json!({"app":identity(&app),"name":app["name"],"window":title,"mode":mode});
            for field in ["on_current_space", "off_space_staleness"] {
                if let Some(value) = structured.get(field) {
                    metadata[field] = value.clone();
                }
            }
            let mut result = ToolResult::text(format!(
                "{} — {title} ({mode})\n{body}",
                app["name"].as_str().unwrap_or(selector)
            ))
            .with_structured(metadata);
            result.content.extend(
                observed
                    .content
                    .into_iter()
                    .filter(|part| matches!(part, Content::Image { .. })),
            );
            return Ok(result);
        }
        if let Some(element) = args.get("element") {
            let token = element
                .as_u64()
                .and_then(|id| state.tokens.get(&id))
                .ok_or_else(|| {
                    error(
                        "element_stale",
                        "The ID is not actionable in this window's current observation.",
                        false,
                    )
                })?;
            let mut input = args.clone();
            input["element_token"] = json!(token);
            state.last_action = Some(std::time::Instant::now());
            return self.act(registry, name, input, pid, window_id).await;
        }
        if name == "drag" || args.get("x").is_some() || args.get("y").is_some() {
            if !state.screenshot {
                return Err(error(
                    "screenshot_required",
                    "Observe a screenshot of this window before using coordinates.",
                    false,
                ));
            }
            if name != "drag" && (args["x"].as_f64().is_none() || args["y"].as_f64().is_none()) {
                return Err(error(
                    "invalid_arguments",
                    "Provide both x and y screenshot coordinates.",
                    false,
                ));
            }
        } else if matches!(
            name,
            "click"
                | "double_click"
                | "right_click"
                | "set_value"
                | "select_text"
                | "perform_secondary_action"
        ) {
            return Err(error(
                "element_stale",
                "Provide a current element ID or screenshot point.",
                false,
            ));
        }
        state.last_action = Some(std::time::Instant::now());
        self.act(registry, name, args, pid, window_id).await
    }

    async fn act(
        &self,
        registry: &ToolRegistry,
        name: &str,
        mut input: Value,
        pid: u64,
        window_id: u64,
    ) -> Result<ToolResult, ToolResult> {
        input.as_object_mut().expect("object input").remove("app");
        input.as_object_mut().unwrap().remove("element");
        input["pid"] = json!(pid);
        input["window_id"] = json!(window_id);
        if let Some(native) = registry.get_def(name) {
            for (key, value) in [
                ("app_context", json!(true)),
                ("delivery_mode", json!("background")),
            ] {
                if native.input_schema["properties"].get(key).is_some() {
                    input[key] = value;
                }
            }
        }
        if name == "click" {
            if let Some(key) = input.as_object_mut().unwrap().remove("key") {
                input["modifier"] = if key.is_string() { json!([key]) } else { key };
            }
        }
        let mut result = Box::pin(registry.invoke_computer_use_native(name, input.clone())).await;
        let refusal = result.structured_content.as_ref();
        if cfg!(any(target_os = "windows", target_os = "linux"))
            && result.is_error == Some(true)
            && refusal.is_some_and(|value| {
                value["code"] == "background_unavailable" && value["sent"] == false
            })
        {
            input["delivery_mode"] = json!("foreground");
            result = Box::pin(registry.invoke_computer_use_native(name, input)).await;
        }
        Self::acknowledge(result)
    }

    fn acknowledge(result: ToolResult) -> Result<ToolResult, ToolResult> {
        let result = checked(result, true)?;
        let confirmed = result
            .action_record
            .as_ref()
            .is_some_and(|record| record.effect == crate::action_record::ActionEffect::Confirmed);
        let mut output = ToolResult::text(if confirmed {
            ""
        } else {
            "Sent but not confirmed. Observe the target state before retrying."
        })
        .with_structured(json!({"computer_use":1,"sent":true}));
        output.action_record = result.action_record;
        Ok(output)
    }

    async fn desktop(
        &self,
        registry: &ToolRegistry,
        name: &str,
        mut input: Value,
    ) -> Result<ToolResult, ToolResult> {
        authorize_app(name, &input, None, None)?;
        let owner = crate::tool::current_dispatch_session_identity().ok_or_else(|| {
            error(
                "session_unavailable",
                "A bound driver session is required.",
                false,
            )
        })?;
        let state = self
            .desktops
            .lock()
            .unwrap()
            .entry(owner)
            .or_default()
            .clone();
        let mut frame = state.lock().await;
        let session = input.get("session").cloned();
        let session_args = || {
            session
                .as_ref()
                .map_or_else(|| json!({}), |id| json!({"session":id}))
        };
        if name == "get_screenshot" {
            *frame = None;
            let result = checked(
                Box::pin(registry.invoke_computer_use_native("get_desktop_state", session_args()))
                    .await,
                false,
            )?;
            let captured = result
                .structured_content
                .as_ref()
                .and_then(DesktopFrame::from_capture)
                .filter(|_| {
                    result
                        .content
                        .iter()
                        .any(|part| matches!(part, Content::Image { .. }))
                })
                .ok_or_else(|| {
                    error(
                        "screenshot_unavailable",
                        "The driver returned no valid desktop image geometry.",
                        false,
                    )
                })?;
            *frame = Some(captured);
            return Ok(result);
        }
        if matches!(
            name,
            "click" | "double_click" | "right_click" | "scroll" | "drag"
        ) {
            let captured = frame.ok_or_else(|| {
                error(
                    "screenshot_required",
                    "Observe cua.desktop.getScreenshot() before using desktop coordinates.",
                    false,
                )
            })?;
            let geometry = checked(
                Box::pin(registry.invoke_computer_use_native("get_screen_size", session_args()))
                    .await,
                false,
            )?;
            let geometry = geometry.structured_content.unwrap_or_default();
            if geometry["width"].as_f64() != Some(captured.screen[0])
                || geometry["height"].as_f64() != Some(captured.screen[1])
                || geometry["scale_factor"].as_f64().unwrap_or(1.0) != captured.scale
            {
                *frame = None;
                return Err(error(
                    "screenshot_required",
                    "Display geometry changed. Observe a fresh desktop screenshot.",
                    false,
                ));
            }
            if name == "drag" {
                captured.map(&mut input, "from_x", "from_y")?;
                captured.map(&mut input, "to_x", "to_y")?;
            } else {
                captured.map(&mut input, "x", "y")?;
            }
        }
        if name == "click" {
            if let Some(key) = input.as_object_mut().unwrap().remove("key") {
                input["modifier"] = if key.is_string() { json!([key]) } else { key };
            }
        }
        let native = match name {
            "double_click" => {
                input["count"] = json!(2);
                "click"
            }
            "right_click" => {
                input["button"] = json!("right");
                "click"
            }
            _ => name,
        };
        Self::acknowledge(Box::pin(registry.invoke_computer_use_native(native, input)).await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authorization::PermissionMode;
    use crate::session_authorization::{SessionAuthorizationRegistry, SessionModeCeiling};
    use crate::tool::TrustedInvocationEvidence;
    use std::time::Duration;

    #[test]
    fn flat_schema_keeps_target_and_modifier_validation() {
        for args in [json!({}), json!({"app":"Fixture","scope":"desktop"})] {
            let refusal = validate("click", &args).unwrap_err();
            assert_eq!(refusal.structured_content.unwrap()["sent"], false);
        }
        for key in [json!("shift"), json!(["ctrl", "shift"])] {
            assert!(validate("click", &json!({"app":"Fixture","element":1,"key":key})).is_ok());
        }
        assert!(validate("click", &json!({"app":"Fixture","element":1,"key":[7]})).is_err());
        assert!(validate("key_down", &json!({"app":"Fixture","key":"shift"})).is_err());
        assert!(validate("key_down", &json!({"scope":"desktop","key":"shift"})).is_ok());
    }

    #[test]
    fn explicit_dispatch_state_survives_error_classification() {
        let result = ToolResult::computer_use_error(
            "not_settable",
            "native write failed after dispatch",
            true,
        );
        let checked = checked(result, true).unwrap_err();
        assert_eq!(checked.structured_content.unwrap()["sent"], true);
    }

    #[derive(Default)]
    struct Fixture {
        window: Mutex<u64>,
        screen_width: Mutex<u64>,
        off_space: Mutex<bool>,
        calls: Mutex<Vec<(String, Value)>>,
        readiness: Mutex<Vec<(String, Option<std::time::Instant>)>>,
    }
    struct Native {
        def: ToolDef,
        fixture: Arc<Fixture>,
    }
    #[async_trait::async_trait]
    impl Tool for Native {
        fn def(&self) -> &ToolDef {
            &self.def
        }
        async fn invoke(&self, args: Value) -> ToolResult {
            self.fixture.readiness.lock().unwrap().push((
                self.def.name.clone(),
                crate::tool::current_ax_readiness_deadline(),
            ));
            self.fixture
                .calls
                .lock()
                .unwrap()
                .push((self.def.name.clone(), args.clone()));
            let window = *self.fixture.window.lock().unwrap();
            match self.def.name.as_str() {
                "get_desktop_state" => {
                    let mut result = ToolResult::text("desktop").with_structured(json!({"platform":"macos","display":"primary","screenshot_mime_type":"image/png","screenshot_width":2000,"screenshot_height":1000,"screen_width":1000,"screen_height":500,"scale_factor":2.0}));
                    result.content.push(Content::image_png("AQ==".into())); result
                },
                "get_screen_size" => ToolResult::text("geometry").with_structured(json!({"width":*self.fixture.screen_width.lock().unwrap(),"height":500,"scale_factor":2.0})),
                "list_apps" => ToolResult::text("").with_structured(json!({"apps":[{
                    "name":"Fixture", "bundle_id":"org.qwen.fixture", "launch_path":"/Applications/Fixture.app", "pid":42,"running":true,
                }]})),
                "list_windows" => ToolResult::text("").with_structured(json!({"windows":[{
                    "pid":42,"window_id":window,"title":"Fixture window","is_app_target":true,"z_index":1,
                }]})),
                "get_window_state" => {
                    let mut metadata = json!({
                        "tree_markdown":"[100] button Save", "elements":[{"element_id":100,"element_token":"native-token"}],
                    });
                    if *self.fixture.off_space.lock().unwrap() {
                        metadata["on_current_space"] = json!(false);
                        metadata["off_space_staleness"] = json!("This read may show an older state.");
                    }
                    let mut result = ToolResult::text("").with_structured(metadata);
                    if args["include_screenshot"] == true {
                        result.content.push(Content::image_png("AQ==".into()));
                    }
                    result
                },
                _ => ToolResult::text("dispatched"),
            }
        }
    }
    fn setup() -> (
        ToolRegistry,
        Arc<Fixture>,
        Arc<crate::session_authorization::EffectiveAuthorizationContext>,
    ) {
        let fixture = Arc::new(Fixture {
            window: Mutex::new(7),
            screen_width: Mutex::new(1000),
            ..Default::default()
        });
        let mut registry = ToolRegistry::new();
        for name in [
            "list_apps",
            "list_windows",
            "get_window_state",
            "get_desktop_state",
            "get_screen_size",
            "click",
            "type_text",
        ] {
            registry.register(Box::new(Native {
                def: ToolDef { name:name.into(), description:"fixture".into(),
                    input_schema:json!({"type":"object","properties":{"pid":{"type":"integer"},"window_id":{"type":"integer"},"delivery_mode":{"type":"string"},"app_context":{"type":"boolean"}}}),
                    read_only:name.starts_with("list_") || name == "get_window_state", destructive:false,idempotent:false,open_world:false,
                }, fixture:fixture.clone(),
            }));
        }
        registry.enable_computer_use();
        let ceiling = SessionModeCeiling::for_trusted_sessions(
            [PermissionMode::Standard],
            false,
            Duration::from_secs(60),
            Duration::from_secs(30),
        )
        .unwrap();
        let context = SessionAuthorizationRegistry::with_ceiling(ceiling)
            .compatibility_context(PermissionMode::Standard, None)
            .unwrap();
        (registry, fixture, context)
    }
    async fn call(
        registry: &ToolRegistry,
        context: Arc<crate::session_authorization::EffectiveAuthorizationContext>,
        name: &str,
        args: Value,
        transport: &str,
    ) -> ToolResult {
        let evidence = TrustedInvocationEvidence::extract_from_adapter_args(
            &mut json!({"_transport_session_id":transport}),
        );
        registry
            .invoke_with_context_and_evidence(name, args, context, evidence)
            .await
    }
    #[tokio::test]
    async fn ax_observation_shares_one_readiness_deadline_but_input_and_screenshot_do_not_wait() {
        let (registry, fixture, context) = setup();
        let result = call(
            &registry,
            context.clone(),
            "get_app",
            json!({"app":"Fixture"}),
            "readiness",
        )
        .await;
        assert_ne!(result.is_error, Some(true), "{}", text(&result));
        let reads = fixture.readiness.lock().unwrap().clone();
        let selection = reads
            .iter()
            .find(|(name, _)| name == "list_windows")
            .unwrap()
            .1;
        let walk = reads
            .iter()
            .find(|(name, _)| name == "get_window_state")
            .unwrap()
            .1;
        assert!(selection.is_some());
        assert_eq!(selection, walk);
        assert!(reads
            .iter()
            .filter(|(name, _)| name == "list_apps")
            .all(|(_, deadline)| deadline.is_none()));
        for (name, args) in [
            ("click", json!({"app":"Fixture","element":1})),
            ("get_screenshot", json!({"app":"Fixture"})),
        ] {
            fixture.readiness.lock().unwrap().clear();
            let result = call(&registry, context.clone(), name, args, "readiness").await;
            assert_ne!(result.is_error, Some(true), "{}", text(&result));
            assert!(fixture
                .readiness
                .lock()
                .unwrap()
                .iter()
                .all(|(_, deadline)| deadline.is_none()));
        }
        assert!(crate::tool::current_ax_readiness_deadline().is_none());
    }
    #[tokio::test]
    async fn desktop_maps_the_observed_frame_once_and_invalidates_changed_geometry() {
        let (mut registry, fixture, context) = setup();
        registry.set_coordinate_space_normalized(true);
        let result = call(
            &registry,
            context.clone(),
            "click",
            json!({"scope":"desktop","x":1500,"y":600}),
            "desktop-a",
        )
        .await;
        assert_eq!(
            result.structured_content.unwrap()["code"],
            "screenshot_required"
        );
        let result = call(
            &registry,
            context.clone(),
            "get_screenshot",
            json!({"scope":"desktop"}),
            "desktop-a",
        )
        .await;
        assert_ne!(result.is_error, Some(true), "{}", text(&result));
        let result = call(
            &registry,
            context.clone(),
            "click",
            json!({"scope":"desktop","x":1500,"y":600,"key":"shift"}),
            "desktop-a",
        )
        .await;
        assert_ne!(result.is_error, Some(true), "{}", text(&result));
        let action = fixture
            .calls
            .lock()
            .unwrap()
            .iter()
            .find(|(name, _)| name == "click")
            .unwrap()
            .1
            .clone();
        assert_eq!(action["x"], 750.0);
        assert_eq!(action["y"], 300.0);
        assert_eq!(action["modifier"], json!(["shift"]));
        assert!(action.get("pid").is_none());
        let result = call(
            &registry,
            context.clone(),
            "click",
            json!({"scope":"desktop","x":2000,"y":0}),
            "desktop-a",
        )
        .await;
        assert_eq!(
            result.structured_content.unwrap()["code"],
            "invalid_arguments"
        );
        let result = call(
            &registry,
            context.clone(),
            "click",
            json!({"scope":"desktop","x":100,"y":100}),
            "desktop-b",
        )
        .await;
        assert_eq!(
            result.structured_content.unwrap()["code"],
            "screenshot_required"
        );
        *fixture.screen_width.lock().unwrap() = 800;
        let result = call(
            &registry,
            context,
            "click",
            json!({"scope":"desktop","x":100,"y":100}),
            "desktop-a",
        )
        .await;
        assert_eq!(
            result.structured_content.unwrap()["code"],
            "screenshot_required"
        );
        let calls = fixture.calls.lock().unwrap();
        assert_eq!(
            calls
                .iter()
                .filter(|(name, _)| name == "get_desktop_state")
                .count(),
            1
        );
        assert_eq!(calls.iter().filter(|(name, _)| name == "click").count(), 1);
        assert!(!calls
            .iter()
            .any(|(name, _)| matches!(name.as_str(), "list_apps" | "get_window_state")));
    }

    #[tokio::test]
    async fn app_calls_resolve_in_the_driver_and_refuse_stale_ids_before_dispatch() {
        let (registry, fixture, context) = setup();
        let result = call(
            &registry,
            context.clone(),
            "get_app",
            json!({"app":"Fixture"}),
            "a",
        )
        .await;
        assert_ne!(result.is_error, Some(true), "{}", text(&result));
        assert!(text(&result).contains("[1] button Save"));
        assert!(result.structured_content.unwrap().get("elements").is_none());
        let observed = fixture.calls.lock().unwrap().clone();
        assert_eq!(
            observed
                .iter()
                .filter(|(name, _)| name == "get_window_state")
                .count(),
            1
        );
        assert_eq!(observed.last().unwrap().1["include_screenshot"], false);
        assert_eq!(observed.last().unwrap().1["include_accessibility"], true);
        *fixture.window.lock().unwrap() = 8;
        let result = call(
            &registry,
            context.clone(),
            "click",
            json!({"app":"Fixture","element":1}),
            "a",
        )
        .await;
        assert_eq!(
            result.structured_content.as_ref().unwrap()["code"],
            "element_stale"
        );
        assert_eq!(result.structured_content.unwrap()["sent"], false);
        assert!(!fixture
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|(name, _)| name == "click"));
        call(
            &registry,
            context.clone(),
            "get_ax_state",
            json!({"app":"Fixture"}),
            "a",
        )
        .await;
        let result = call(
            &registry,
            context,
            "click",
            json!({"app":"Fixture","element":2}),
            "a",
        )
        .await;
        assert_ne!(result.is_error, Some(true), "{}", text(&result));
        let calls = fixture.calls.lock().unwrap();
        let action = &calls.iter().find(|(name, _)| name == "click").unwrap().1;
        assert_eq!(action["window_id"], 8);
        assert_eq!(action["element_token"], "native-token");
        assert!(action.get("element").is_none());
    }

    #[tokio::test]
    async fn app_observation_preserves_off_space_warning_on_all_observation_routes() {
        let (registry, fixture, context) = setup();
        *fixture.off_space.lock().unwrap() = true;
        for name in [
            "get_app",
            "get_ax_state",
            "get_screenshot",
            "get_ax_state_and_screenshot",
        ] {
            let result = call(
                &registry,
                context.clone(),
                name,
                json!({"app":"Fixture"}),
                "off-space",
            )
            .await;
            assert_ne!(result.is_error, Some(true), "{name}: {}", text(&result));
            assert!(
                text(&result).contains("This read may show an older state."),
                "{name}"
            );
            let metadata = result.structured_content.unwrap();
            assert_eq!(metadata["on_current_space"], false);
            assert_eq!(
                metadata["off_space_staleness"],
                "This read may show an older state."
            );
        }
    }
    #[tokio::test]
    async fn app_state_is_transport_isolated_and_options_are_checked_before_native_calls() {
        let (registry, fixture, context) = setup();
        call(
            &registry,
            context.clone(),
            "get_app",
            json!({"app":"Fixture"}),
            "a",
        )
        .await;
        let result = call(
            &registry,
            context.clone(),
            "click",
            json!({"app":"Fixture","element":1}),
            "b",
        )
        .await;
        assert_eq!(result.structured_content.unwrap()["code"], "element_stale");
        let before = fixture.calls.lock().unwrap().len();
        let result = call(
            &registry,
            context,
            "click",
            json!({"app":"Fixture","element":1,"delivery_mode":"foreground"}),
            "a",
        )
        .await;
        assert_eq!(
            result.structured_content.unwrap()["code"],
            "invalid_arguments"
        );
        assert_eq!(fixture.calls.lock().unwrap().len(), before);
    }
    #[test]
    fn app_identity_preserves_opaque_windows_launch_arguments_and_rejects_ambiguity() {
        let apps = json!([
            {"name":"Editor","bundle_id":"C:\\Editor.exe","launch_path":"C:\\Editor.exe --Profile ABC"},
            {"name":"Editor","bundle_id":"C:\\Other.exe","launch_path":"C:\\Other.exe"},
        ]);
        assert_eq!(identity(&apps[0]), "C:\\Editor.exe --Profile ABC");
        assert!(resolve_app(&apps, "Editor").is_err());
        assert_eq!(
            resolve_app(&apps, "c:\\EDITOR.exe").unwrap()["bundle_id"],
            "C:\\Editor.exe"
        );
    }
}
