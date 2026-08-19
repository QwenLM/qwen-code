use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::Duration;
use tauri::webview::WebviewWindowBuilder;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use url::Url;

pub const STATUS_WINDOW_LABEL: &str = "computer-use-status";
pub const PIP_WINDOW_LABEL: &str = "computer-use-pip";
const STATE_EVENT: &str = "desktop-computer-use-state";
const FRAME_POLL_INTERVAL: Duration = Duration::from_millis(500);
const RECONNECT_DELAY: Duration = Duration::from_secs(1);
const HTTP_TIMEOUT: Duration = Duration::from_secs(4);
const SSE_READ_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, PartialEq)]
pub struct RuntimeConnection {
    pub base_url: Url,
    pub token: String,
}

#[derive(Clone)]
pub struct ComputerUseController {
    generation: Arc<AtomicU64>,
    inner: Arc<Mutex<ControllerState>>,
}

struct ControllerState {
    activity: ActivitySnapshot,
    always_hide_picture_in_picture: bool,
    can_stop_with_escape: bool,
    connection: Option<RuntimeConnection>,
    frame_etag: Option<String>,
    picture_in_picture_override: Option<bool>,
    preview_unavailable: bool,
    screenshot: Option<String>,
    session_id: Option<String>,
    stopping: bool,
}

#[derive(Clone, Default, PartialEq)]
struct ActivitySnapshot {
    active: bool,
    args: Map<String, Value>,
    tool_name: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SurfaceState {
    active: bool,
    always_hide_picture_in_picture: bool,
    can_stop_with_escape: bool,
    picture_in_picture_visible: bool,
    preview_unavailable: bool,
    screenshot: Option<String>,
    session_id: Option<String>,
    stopping: bool,
    target: Option<String>,
    tool_name: Option<String>,
}

#[derive(Default)]
struct ActivityTracker {
    snapshot: ActivitySnapshot,
    last_call_id: Option<String>,
    pending_permissions: HashMap<String, PendingPermission>,
}

struct PendingPermission {
    allowed_option_ids: Vec<String>,
    args: Map<String, Value>,
    call_id: String,
    tool_name: String,
}

impl ComputerUseController {
    pub fn new(always_hide_picture_in_picture: bool) -> Self {
        Self {
            generation: Arc::new(AtomicU64::new(0)),
            inner: Arc::new(Mutex::new(ControllerState {
                activity: ActivitySnapshot::default(),
                always_hide_picture_in_picture,
                can_stop_with_escape: false,
                connection: None,
                frame_etag: None,
                picture_in_picture_override: None,
                preview_unavailable: false,
                screenshot: None,
                session_id: None,
                stopping: false,
            })),
        }
    }

    pub fn set_session(
        &self,
        app: &AppHandle,
        session_id: Option<String>,
        connection: Option<RuntimeConnection>,
    ) {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        {
            let mut state = lock(&self.inner);
            state.activity = ActivitySnapshot::default();
            state.can_stop_with_escape = false;
            state.connection = connection.clone();
            state.frame_etag = None;
            state.picture_in_picture_override = None;
            state.preview_unavailable = false;
            state.screenshot = None;
            state.session_id = session_id.clone();
            state.stopping = false;
        }
        self.unregister_escape(app);
        self.hide_surfaces(app);
        self.emit_state(app);

        let (Some(session_id), Some(connection)) = (session_id, connection) else {
            return;
        };
        self.spawn_observer(
            app.clone(),
            generation,
            session_id.clone(),
            connection.clone(),
        );
        self.spawn_frame_poller(app.clone(), generation, session_id, connection);
    }

    pub fn clear(&self, app: &AppHandle) {
        self.set_session(app, None, None);
    }

    pub fn matches_session(
        &self,
        session_id: &Option<String>,
        connection: &Option<RuntimeConnection>,
    ) -> bool {
        let state = lock(&self.inner);
        state.session_id == *session_id && state.connection == *connection
    }

    pub fn emit_state_to(&self, app: &AppHandle, label: &str) {
        let mut state = self.surface_state();
        if label != PIP_WINDOW_LABEL {
            state.screenshot = None;
        }
        let _ = app.emit_to(label, STATE_EVENT, &state);
    }

    pub fn set_picture_in_picture_visible(&self, app: &AppHandle, visible: bool) {
        {
            let mut state = lock(&self.inner);
            if !state.activity.active {
                return;
            }
            state.picture_in_picture_override = Some(visible);
            if !visible {
                state.screenshot = None;
                state.frame_etag = None;
            }
        }
        self.sync_surfaces(app);
        self.emit_state(app);
    }

    pub fn set_always_hide_picture_in_picture(&self, app: &AppHandle, hidden: bool) {
        {
            let mut state = lock(&self.inner);
            state.always_hide_picture_in_picture = hidden;
            state.picture_in_picture_override = None;
            if hidden {
                state.screenshot = None;
                state.frame_etag = None;
            }
        }
        self.sync_surfaces(app);
        self.emit_state(app);
    }

    pub fn stop(&self, app: &AppHandle) {
        let request = {
            let mut state = lock(&self.inner);
            if !state.activity.active || state.stopping {
                return;
            }
            let (Some(session_id), Some(connection)) =
                (state.session_id.clone(), state.connection.clone())
            else {
                return;
            };
            state.stopping = true;
            (session_id, connection)
        };
        self.emit_state(app);

        let controller = self.clone();
        let app = app.clone();
        thread::spawn(move || {
            let (session_id, connection) = request;
            let url = endpoint(&connection.base_url, &session_id, "cancel");
            let result = http_agent(HTTP_TIMEOUT)
                .post(url.as_str())
                .header("Authorization", &format!("Bearer {}", connection.token))
                .send_empty();
            if result.is_err() {
                let mut state = lock(&controller.inner);
                if state.session_id.as_deref() == Some(session_id.as_str()) {
                    state.stopping = false;
                }
                drop(state);
                controller.emit_state(&app);
            }
        });
    }

    pub fn reposition(&self, app: &AppHandle) {
        if !lock(&self.inner).activity.active {
            return;
        }
        position_surfaces(app);
    }

    pub fn hide_picture_in_picture(&self, app: &AppHandle) {
        self.set_picture_in_picture_visible(app, false);
    }

    fn spawn_observer(
        &self,
        app: AppHandle,
        generation: u64,
        session_id: String,
        connection: RuntimeConnection,
    ) {
        let controller = self.clone();
        thread::spawn(move || {
            let mut last_event_id = 0_u64;
            while controller.is_current(generation, &session_id) {
                let mut tracker = ActivityTracker::default();
                let mut replaying = true;
                let url = endpoint(&connection.base_url, &session_id, "events");
                let response = http_agent(SSE_READ_TIMEOUT)
                    .get(url.as_str())
                    .header("Accept", "text/event-stream")
                    .header("Authorization", &format!("Bearer {}", connection.token))
                    .header("Last-Event-ID", &last_event_id.to_string())
                    .call();
                if let Ok(response) = response {
                    let (_, body) = response.into_parts();
                    let mut reader = BufReader::new(body.into_reader());
                    let mut data = String::new();
                    loop {
                        if !controller.is_current(generation, &session_id) {
                            return;
                        }
                        let mut line = String::new();
                        match reader.read_line(&mut line) {
                            Ok(0) | Err(_) => break,
                            Ok(_) => {}
                        }
                        let line = line.trim_end_matches(['\r', '\n']);
                        if line.is_empty() {
                            if let Ok(event) = serde_json::from_str::<Value>(&data) {
                                let event_type = event
                                    .get("type")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default();
                                let changed = tracker.consume(&event);
                                if event_type == "replay_complete" {
                                    replaying = false;
                                    controller.apply_activity(
                                        &app,
                                        generation,
                                        &session_id,
                                        tracker.snapshot.clone(),
                                    );
                                } else if !replaying && changed {
                                    controller.apply_activity(
                                        &app,
                                        generation,
                                        &session_id,
                                        tracker.snapshot.clone(),
                                    );
                                }
                            }
                            data.clear();
                        } else if let Some(value) = line.strip_prefix("data:") {
                            if !data.is_empty() {
                                data.push('\n');
                            }
                            data.push_str(value.trim_start());
                        } else if let Some(value) = line.strip_prefix("id:") {
                            if let Ok(next) = value.trim().parse() {
                                last_event_id = next;
                            }
                        }
                    }
                }
                sleep_while_current(&controller, generation, &session_id, RECONNECT_DELAY);
            }
        });
    }

    fn spawn_frame_poller(
        &self,
        app: AppHandle,
        generation: u64,
        session_id: String,
        connection: RuntimeConnection,
    ) {
        let controller = self.clone();
        thread::spawn(move || {
            while controller.is_current(generation, &session_id) {
                let etag = {
                    let state = lock(&controller.inner);
                    if !state.activity.active || !picture_in_picture_visible(&state) {
                        drop(state);
                        sleep_while_current(
                            &controller,
                            generation,
                            &session_id,
                            FRAME_POLL_INTERVAL,
                        );
                        continue;
                    }
                    state.frame_etag.clone()
                };
                let url = endpoint(&connection.base_url, &session_id, "computer-use/frame");
                let mut request = http_agent(HTTP_TIMEOUT)
                    .get(url.as_str())
                    .header("Accept", "image/*")
                    .header("Authorization", &format!("Bearer {}", connection.token));
                if let Some(etag) = &etag {
                    request = request.header("If-None-Match", etag);
                }
                match request.call() {
                    Ok(mut response) if response.status().as_u16() == 200 => {
                        let mime_type = response
                            .headers()
                            .get("content-type")
                            .and_then(|value| value.to_str().ok())
                            .and_then(|value| value.split(';').next())
                            .unwrap_or_default()
                            .to_string();
                        if matches!(
                            mime_type.as_str(),
                            "image/png" | "image/jpeg" | "image/webp"
                        ) {
                            if let Ok(bytes) = response.body_mut().read_to_vec() {
                                if !bytes.is_empty()
                                    && controller.is_current(generation, &session_id)
                                {
                                    let next_etag = response
                                        .headers()
                                        .get("etag")
                                        .and_then(|value| value.to_str().ok())
                                        .map(str::to_string);
                                    let screenshot =
                                        format!("data:{mime_type};base64,{}", BASE64.encode(bytes));
                                    let Some(mut state) =
                                        controller.current_state(generation, &session_id)
                                    else {
                                        return;
                                    };
                                    state.frame_etag = next_etag;
                                    state.preview_unavailable = false;
                                    state.screenshot = Some(screenshot);
                                    drop(state);
                                    controller.emit_state(&app);
                                }
                            }
                        }
                    }
                    Ok(response) if matches!(response.status().as_u16(), 204 | 304) => {
                        let Some(mut state) = controller.current_state(generation, &session_id)
                        else {
                            return;
                        };
                        if state.preview_unavailable {
                            state.preview_unavailable = false;
                            drop(state);
                            controller.emit_state(&app);
                        }
                    }
                    _ => {
                        let Some(mut state) = controller.current_state(generation, &session_id)
                        else {
                            return;
                        };
                        if !state.preview_unavailable {
                            state.preview_unavailable = true;
                            drop(state);
                            controller.emit_state(&app);
                        }
                    }
                }
                sleep_while_current(&controller, generation, &session_id, FRAME_POLL_INTERVAL);
            }
        });
    }

    fn apply_activity(
        &self,
        app: &AppHandle,
        generation: u64,
        session_id: &str,
        activity: ActivitySnapshot,
    ) {
        let was_active = {
            let Some(mut state) = self.current_state(generation, session_id) else {
                return;
            };
            let was_active = state.activity.active;
            state.activity = activity;
            if !state.activity.active {
                state.frame_etag = None;
                state.preview_unavailable = false;
                state.screenshot = None;
                state.stopping = false;
            }
            was_active
        };
        let Some(state) = self.current_state(generation, session_id) else {
            return;
        };
        let active = state.activity.active;
        drop(state);
        if active && !was_active {
            self.register_escape(app);
        } else if !active && was_active {
            self.unregister_escape(app);
        }
        self.sync_surfaces(app);
        self.emit_state(app);
        if !self.is_current(generation, session_id) {
            self.reconcile_surfaces(app);
        }
    }

    fn register_escape(&self, app: &AppHandle) {
        if lock(&self.inner).can_stop_with_escape {
            return;
        }
        let controller = self.clone();
        let registered = app
            .global_shortcut()
            .on_shortcut("Escape", move |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    controller.stop(app);
                }
            })
            .is_ok();
        lock(&self.inner).can_stop_with_escape = registered;
    }

    fn unregister_escape(&self, app: &AppHandle) {
        let _ = app.global_shortcut().unregister("Escape");
        lock(&self.inner).can_stop_with_escape = false;
    }

    fn reconcile_surfaces(&self, app: &AppHandle) {
        if lock(&self.inner).activity.active {
            self.register_escape(app);
        } else {
            self.unregister_escape(app);
        }
        self.sync_surfaces(app);
        self.emit_state(app);
    }

    fn sync_surfaces(&self, app: &AppHandle) {
        let state = self.surface_state();
        if state.active {
            if let Some(window) = app.get_webview_window(STATUS_WINDOW_LABEL) {
                let _ = window.show();
            }
            if state.picture_in_picture_visible {
                if let Some(window) = app.get_webview_window(PIP_WINDOW_LABEL) {
                    let _ = window.show();
                }
            } else if let Some(window) = app.get_webview_window(PIP_WINDOW_LABEL) {
                let _ = window.hide();
            }
            position_surfaces(app);
        } else {
            self.hide_surfaces(app);
        }
    }

    fn hide_surfaces(&self, app: &AppHandle) {
        for label in [STATUS_WINDOW_LABEL, PIP_WINDOW_LABEL] {
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.hide();
            }
        }
    }

    fn emit_state(&self, app: &AppHandle) {
        let state = self.surface_state();
        let mut control_state = state.clone();
        control_state.screenshot = None;
        let _ = app.emit_to("main", STATE_EVENT, &control_state);
        let _ = app.emit_to(STATUS_WINDOW_LABEL, STATE_EVENT, &control_state);
        let _ = app.emit_to(PIP_WINDOW_LABEL, STATE_EVENT, &state);
    }

    fn surface_state(&self) -> SurfaceState {
        let state = lock(&self.inner);
        SurfaceState {
            active: state.activity.active,
            always_hide_picture_in_picture: state.always_hide_picture_in_picture,
            can_stop_with_escape: state.can_stop_with_escape,
            picture_in_picture_visible: picture_in_picture_visible(&state),
            preview_unavailable: state.preview_unavailable,
            screenshot: state.screenshot.clone(),
            session_id: state.session_id.clone(),
            stopping: state.stopping,
            target: extract_target(&state.activity.args),
            tool_name: state.activity.tool_name.clone(),
        }
    }

    fn is_current(&self, generation: u64, session_id: &str) -> bool {
        self.current_state(generation, session_id).is_some()
    }

    fn current_state<'a>(
        &'a self,
        generation: u64,
        session_id: &str,
    ) -> Option<std::sync::MutexGuard<'a, ControllerState>> {
        let state = lock(&self.inner);
        (self.generation.load(Ordering::SeqCst) == generation
            && state.session_id.as_deref() == Some(session_id))
        .then_some(state)
    }
}

impl ActivityTracker {
    fn consume(&mut self, event: &Value) -> bool {
        let before = self.snapshot.clone();
        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if matches!(
            event_type,
            "turn_complete" | "turn_error" | "prompt_cancelled"
        ) {
            self.snapshot.active = false;
            self.pending_permissions.clear();
            return self.snapshot != before;
        }
        if event_type == "permission_request" {
            let data = object(event.get("data"));
            let request_id = string(data.and_then(|value| value.get("requestId")));
            let tool_call = object(data.and_then(|value| value.get("toolCall")));
            let meta = object(tool_call.and_then(|value| value.get("_meta")));
            let tool_name = string(meta.and_then(|value| value.get("toolName")))
                .or_else(|| string(tool_call.and_then(|value| value.get("toolName"))));
            let call_id = string(tool_call.and_then(|value| value.get("toolCallId")));
            if let (Some(request_id), Some(tool_name), Some(call_id)) =
                (request_id, tool_name, call_id)
            {
                if tool_name.starts_with("computer_use__") {
                    self.pending_permissions.insert(
                        request_id,
                        PendingPermission {
                            allowed_option_ids: allow_option_ids(
                                data.and_then(|value| value.get("options")),
                            ),
                            args: object(tool_call.and_then(|value| value.get("rawInput")))
                                .cloned()
                                .unwrap_or_default(),
                            call_id,
                            tool_name,
                        },
                    );
                }
            }
            return self.snapshot != before;
        }
        if event_type == "permission_resolved" {
            let data = object(event.get("data"));
            let request_id = string(data.and_then(|value| value.get("requestId")));
            let outcome = object(data.and_then(|value| value.get("outcome")));
            let option_id = outcome
                .filter(|value| value.get("outcome").and_then(Value::as_str) == Some("selected"))
                .and_then(|value| string(value.get("optionId")));
            if let Some(request_id) = request_id {
                if let Some(pending) = self.pending_permissions.remove(&request_id) {
                    if option_id.is_some_and(|id| pending.allowed_option_ids.contains(&id)) {
                        self.snapshot.active = true;
                        self.snapshot.args = pending.args;
                        self.snapshot.tool_name = Some(pending.tool_name);
                        self.last_call_id = Some(pending.call_id);
                    }
                }
            }
            return self.snapshot != before;
        }

        let data = object(event.get("data"));
        let update = object(data.and_then(|value| value.get("update"))).or(data);
        let update_type =
            string(update.and_then(|value| value.get("sessionUpdate"))).or_else(|| {
                matches!(event_type, "tool_call" | "tool_call_update")
                    .then(|| event_type.to_string())
            });
        if !matches!(
            update_type.as_deref(),
            Some("tool_call" | "tool_call_update")
        ) {
            return self.snapshot != before;
        }
        let meta = object(update.and_then(|value| value.get("_meta")));
        let tool_name = string(meta.and_then(|value| value.get("toolName")))
            .or_else(|| string(update.and_then(|value| value.get("toolName"))));
        let Some(tool_name) = tool_name.filter(|name| name.starts_with("computer_use__")) else {
            return self.snapshot != before;
        };
        let call_id = string(update.and_then(|value| value.get("toolCallId")))
            .or_else(|| string(update.and_then(|value| value.get("id"))));
        let Some(call_id) = call_id else {
            return self.snapshot != before;
        };
        let args = object(update.and_then(|value| value.get("rawInput")))
            .cloned()
            .unwrap_or_default();
        if !args.is_empty() || self.last_call_id.as_deref() != Some(call_id.as_str()) {
            self.snapshot.args = args;
        }
        self.last_call_id = Some(call_id);
        self.snapshot.tool_name = Some(tool_name);
        if string(update.and_then(|value| value.get("status"))).as_deref() == Some("in_progress") {
            self.snapshot.active = true;
        }
        self.snapshot != before
    }
}

pub fn create_surfaces<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    create_surface(
        app,
        STATUS_WINDOW_LABEL,
        "computer-use-status.html",
        360.0,
        64.0,
        false,
    )?;
    create_surface(
        app,
        PIP_WINDOW_LABEL,
        "computer-use-pip.html",
        258.0,
        258.0,
        true,
    )?;
    Ok(())
}

fn create_surface<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    asset: &str,
    width: f64,
    height: f64,
    focusable: bool,
) -> tauri::Result<WebviewWindow<R>> {
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(asset.into()))
        .title("Qwen Code Computer Use")
        .inner_size(width, height)
        .always_on_top(true)
        .content_protected(true)
        .decorations(false)
        .focusable(focusable)
        .maximizable(false)
        .minimizable(false)
        .resizable(false)
        .shadow(true)
        .skip_taskbar(true)
        .transparent(true)
        .visible(false);
    #[cfg(target_os = "macos")]
    let builder = builder.visible_on_all_workspaces(true);
    builder.build()
}

fn position_surfaces(app: &AppHandle) {
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    let Ok(Some(monitor)) = main.current_monitor() else {
        return;
    };
    let work_position = monitor.work_area().position;
    let work_size = monitor.work_area().size;
    if let Some(status) = app.get_webview_window(STATUS_WINDOW_LABEL) {
        if let Ok(size) = status.outer_size() {
            let x = work_position.x + (work_size.width as i32 - size.width as i32) / 2;
            let _ = status.set_position(PhysicalPosition::new(x, work_position.y + 18));
        }
    }
    if let Some(pip) = app.get_webview_window(PIP_WINDOW_LABEL) {
        if let (Ok(main_position), Ok(main_size), Ok(pip_size)) =
            (main.outer_position(), main.outer_size(), pip.outer_size())
        {
            let min_x = work_position.x + 12;
            let max_x = work_position.x + work_size.width as i32 - pip_size.width as i32 - 12;
            let min_y = work_position.y + 12;
            let max_y = work_position.y + work_size.height as i32 - pip_size.height as i32 - 12;
            let x = (main_position.x + main_size.width as i32 - pip_size.width as i32 - 24)
                .clamp(min_x, max_x.max(min_x));
            let y = (main_position.y + 64).clamp(min_y, max_y.max(min_y));
            let _ = pip.set_position(PhysicalPosition::new(x, y));
        }
    }
}

pub fn session_id_from_url(raw: &str) -> Option<String> {
    let url = Url::parse(raw).ok()?;
    let path = url.path().trim_end_matches('/');
    let session_id = path.strip_prefix("/session/")?;
    (!session_id.is_empty() && !session_id.contains('/')).then(|| session_id.to_string())
}

fn endpoint(base_url: &Url, session_id: &str, suffix: &str) -> Url {
    base_url
        .join(&format!("session/{session_id}/{suffix}"))
        .expect("runtime base URL accepts session endpoints")
}

fn http_agent(body_timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(HTTP_TIMEOUT))
        .timeout_recv_response(Some(body_timeout))
        .timeout_recv_body(Some(body_timeout))
        .build()
        .into()
}

fn picture_in_picture_visible(state: &ControllerState) -> bool {
    state.activity.active
        && state
            .picture_in_picture_override
            .unwrap_or(!state.always_hide_picture_in_picture)
}

fn extract_target(args: &Map<String, Value>) -> Option<String> {
    ["window_title", "app_name", "application", "bundle_id"]
        .iter()
        .find_map(|key| {
            args.get(*key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
}

fn allow_option_ids(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|option| {
            let option = option.as_object()?;
            let kind = option.get("kind")?.as_str()?;
            if !matches!(kind, "allow_once" | "allow_always") {
                return None;
            }
            option.get("optionId")?.as_str().map(str::to_string)
        })
        .collect()
}

fn object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_string)
}

fn sleep_while_current(
    controller: &ComputerUseController,
    generation: u64,
    session_id: &str,
    duration: Duration,
) {
    let steps = (duration.as_millis() / 100).max(1) as u64;
    for _ in 0..steps {
        if !controller.is_current(generation, session_id) {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

#[cfg(test)]
mod tests {
    use super::{extract_target, session_id_from_url, ActivityTracker};
    use serde_json::{json, Map, Value};

    #[test]
    fn parses_only_session_routes() {
        assert_eq!(
            session_id_from_url("http://127.0.0.1:4321/session/s-1"),
            Some("s-1".to_string())
        );
        assert_eq!(
            session_id_from_url("http://127.0.0.1:4321/session/s-1/"),
            Some("s-1".to_string())
        );
        assert_eq!(session_id_from_url("http://127.0.0.1:4321/"), None);
    }

    #[test]
    fn tracks_permission_then_terminal() {
        let mut tracker = ActivityTracker::default();
        tracker.consume(&json!({
            "type": "permission_request",
            "data": {
                "requestId": "p-1",
                "options": [{"optionId": "allow", "kind": "allow_once"}],
                "toolCall": {
                    "toolCallId": "c-1",
                    "rawInput": {"app_name": "Preview"},
                    "_meta": {"toolName": "computer_use__click"}
                }
            }
        }));
        assert!(!tracker.snapshot.active);
        tracker.consume(&json!({
            "type": "permission_resolved",
            "data": {
                "requestId": "p-1",
                "outcome": {"outcome": "selected", "optionId": "allow"}
            }
        }));
        assert!(tracker.snapshot.active);
        assert_eq!(
            tracker.snapshot.tool_name.as_deref(),
            Some("computer_use__click")
        );
        tracker.consume(&json!({"type": "turn_complete"}));
        assert!(!tracker.snapshot.active);
    }

    #[test]
    fn extracts_the_first_supported_target() {
        let args: Map<String, Value> = serde_json::from_value(json!({
            "app_name": "Safari",
            "bundle_id": "com.apple.Safari"
        }))
        .expect("object");
        assert_eq!(extract_target(&args).as_deref(), Some("Safari"));
    }
}
