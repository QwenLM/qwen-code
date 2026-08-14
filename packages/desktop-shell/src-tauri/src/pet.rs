use crate::desktop_state::{PetPosition, PetSettings, MAX_PET_SIZE, MIN_PET_SIZE};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::webview::WebviewWindowBuilder;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl};

pub const PET_WINDOW_WIDTH: f64 = 300.0;
pub const PET_WINDOW_HEIGHT: f64 = 340.0;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PetState {
    Failed,
    Idle,
    Jumping,
    Running,
    Waiting,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionChangeType {
    Submit,
    TurnComplete,
}

#[derive(Deserialize)]
pub struct SessionChangeReport {
    #[serde(rename = "type")]
    pub kind: SessionChangeType,
    #[serde(default)]
    pub failed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSettingsCategory {
    pub id: &'static str,
    pub label: &'static str,
    pub scope_label: &'static str,
    pub items: Vec<HostSettingItem>,
}

#[derive(Serialize)]
pub struct HostSettingItem {
    pub key: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub kind: &'static str,
    pub value: Value,
}

pub fn host_settings(settings: &PetSettings, language: &str) -> Vec<HostSettingsCategory> {
    let chinese = language.to_ascii_lowercase().starts_with("zh");
    let (category, scope, enabled, enabled_description, size, size_description) = if chinese {
        (
            "桌面宠物",
            "桌面端",
            "显示桌面宠物",
            "在聊天窗口之外显示始终置顶的 Qwen 桌面伙伴。",
            "宠物大小",
            "设置桌面宠物高度，范围为 64 到 240 像素。",
        )
    } else {
        (
            "Desktop Pet",
            "Desktop",
            "Show desktop pet",
            "Show the always-on-top Qwen companion outside the chat window.",
            "Pet size",
            "Set the desktop pet height from 64 to 240 pixels.",
        )
    };
    vec![HostSettingsCategory {
        id: "desktop-pet",
        label: category,
        scope_label: scope,
        items: vec![
            HostSettingItem {
                key: "pet.enabled",
                label: enabled,
                description: enabled_description,
                kind: "boolean",
                value: Value::Bool(settings.enabled),
            },
            HostSettingItem {
                key: "pet.size",
                label: size,
                description: size_description,
                kind: "number",
                value: Value::from(settings.size),
            },
        ],
    }]
}

pub fn apply_host_setting(
    mut settings: PetSettings,
    key: &str,
    value: Value,
) -> Result<PetSettings, String> {
    match key {
        "pet.enabled" => {
            settings.enabled = value
                .as_bool()
                .ok_or_else(|| "pet.enabled must be a boolean.".to_string())?;
        }
        "pet.size" => {
            let size = value
                .as_f64()
                .filter(|value| value.is_finite())
                .ok_or_else(|| "pet.size must be a finite number.".to_string())?;
            settings.size = (size.round() as u32).clamp(MIN_PET_SIZE, MAX_PET_SIZE);
        }
        _ => return Err(format!("Unknown desktop setting: {key}")),
    }
    Ok(settings)
}

pub fn streaming_state(state: &str) -> PetState {
    match state {
        "waiting" => PetState::Waiting,
        "responding" => PetState::Running,
        _ => PetState::Idle,
    }
}

pub fn session_state(event: &SessionChangeReport) -> (PetState, Option<u64>) {
    match event.kind {
        SessionChangeType::Submit => (PetState::Running, None),
        SessionChangeType::TurnComplete if event.failed => (PetState::Failed, Some(2_600)),
        SessionChangeType::TurnComplete => (PetState::Jumping, Some(1_300)),
    }
}

pub fn ensure_window(app: &AppHandle, settings: &PetSettings) -> Result<(), String> {
    if !settings.enabled || app.get_webview_window("pet").is_some() {
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(app, "pet", WebviewUrl::App("pet.html".into()))
        .title("Qwen Pet")
        .inner_size(PET_WINDOW_WIDTH, PET_WINDOW_HEIGHT)
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .fullscreen(false)
        .skip_taskbar(true)
        .shadow(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .build()
        .map_err(|error| format!("Failed to create desktop pet: {error}"))?;
    let position = settings.position.clone().or_else(|| default_position(app));
    if let Some(position) = position {
        let _ = window.set_position(PhysicalPosition::new(position.x, position.y));
    }
    Ok(())
}

pub fn destroy_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("pet") {
        let _ = window.destroy();
    }
}

pub fn emit_settings(app: &AppHandle, settings: &PetSettings) {
    if let Some(window) = app.get_webview_window("pet") {
        let _ = window.emit("desktop-pet-settings-changed", settings);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("desktop-host-settings-changed", ());
    }
}

pub fn emit_activity(app: &AppHandle, state: PetState) {
    if let Some(window) = app.get_webview_window("pet") {
        let _ = window.emit("desktop-pet-activity-changed", state);
    }
}

fn default_position(app: &AppHandle) -> Option<PetPosition> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    Some(PetPosition {
        x: area.position.x + area.size.width as i32 - (PET_WINDOW_WIDTH * scale) as i32 - 24,
        y: area.position.y + area.size.height as i32 - (PET_WINDOW_HEIGHT * scale) as i32 - 24,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        apply_host_setting, session_state, streaming_state, PetState, SessionChangeReport,
        SessionChangeType,
    };
    use crate::desktop_state::{PetSettings, MAX_PET_SIZE};
    use serde_json::json;

    #[test]
    fn host_size_is_clamped() {
        let settings =
            apply_host_setting(PetSettings::default(), "pet.size", json!(999)).expect("setting");
        assert_eq!(settings.size, MAX_PET_SIZE);
    }

    #[test]
    fn activity_signals_match_the_electron_experiment() {
        assert_eq!(streaming_state("waiting"), PetState::Waiting);
        assert_eq!(streaming_state("responding"), PetState::Running);
        assert_eq!(
            session_state(&SessionChangeReport {
                kind: SessionChangeType::TurnComplete,
                failed: true,
            }),
            (PetState::Failed, Some(2_600)),
        );
    }
}
