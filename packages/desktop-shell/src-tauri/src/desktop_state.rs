use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

const DEFAULT_WIDTH: u32 = 1280;
const DEFAULT_HEIGHT: u32 = 820;
const MIN_WIDTH: u32 = 900;
const MIN_HEIGHT: u32 = 600;
const DISABLE_SETTINGS_PERSISTENCE_ENV: &str = "QWEN_DESKTOP_DISABLE_SETTINGS_PERSISTENCE";
static NEXT_WRITE_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct DesktopSettings {
    pub workspace: Option<PathBuf>,
    pub window: Option<WindowState>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WindowState {
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub maximized: bool,
}

pub struct SettingsStore {
    path: PathBuf,
    settings: Mutex<DesktopSettings>,
}

impl SettingsStore {
    pub fn load(app: &AppHandle) -> Result<Self, String> {
        let path = settings_path(app)?;
        let settings = match fs::read_to_string(&path) {
            Ok(contents) => parse_settings(&contents),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                DesktopSettings::default()
            }
            Err(error) => return Err(format!("Failed to read desktop settings: {error}")),
        };
        Ok(Self {
            path,
            settings: Mutex::new(settings),
        })
    }

    pub fn workspace(&self) -> Option<PathBuf> {
        self.with_settings(|settings| settings.workspace.clone())
    }

    pub fn set_workspace(&self, workspace: PathBuf) -> Result<(), String> {
        self.update(|settings| settings.workspace = Some(workspace))
    }

    pub fn window(&self) -> Option<WindowState> {
        self.with_settings(|settings| settings.window.clone())
    }

    pub fn save_window(&self, window: &WebviewWindow) -> Result<(), String> {
        let position = window
            .outer_position()
            .map_err(|error| format!("Failed to read window position: {error}"))?;
        let size = window
            .inner_size()
            .map_err(|error| format!("Failed to read window size: {error}"))?;
        let maximized = window
            .is_maximized()
            .map_err(|error| format!("Failed to read window maximized state: {error}"))?;
        self.update(|settings| {
            settings.window = Some(saved_window_state(
                settings.window.as_ref(),
                position,
                size,
                maximized,
            ));
        })
    }

    fn update(&self, update: impl FnOnce(&mut DesktopSettings)) -> Result<(), String> {
        if settings_persistence_disabled() {
            return Ok(());
        }
        let mut settings = match self.settings.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        update(&mut settings);
        let serialized = serde_json::to_string_pretty(&*settings)
            .map_err(|error| format!("Failed to serialize desktop settings: {error}"))?;
        write_atomic(&self.path, format!("{serialized}\n").as_bytes())
    }

    fn with_settings<T>(&self, read: impl FnOnce(&DesktopSettings) -> T) -> T {
        let settings = match self.settings.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        read(&settings)
    }
}

fn settings_persistence_disabled() -> bool {
    settings_persistence_disabled_value(
        std::env::var_os(DISABLE_SETTINGS_PERSISTENCE_ENV).as_deref(),
    )
}

fn settings_persistence_disabled_value(value: Option<&OsStr>) -> bool {
    value == Some(OsStr::new("1"))
}

pub fn restore_window(window: &WebviewWindow, state: Option<&WindowState>) {
    let Some(state) = state else {
        let _ = window.center();
        return;
    };
    let size = PhysicalSize::new(state.width.max(MIN_WIDTH), state.height.max(MIN_HEIGHT));
    let _ = window.set_size(size);
    if window
        .monitor_from_point(f64::from(state.x), f64::from(state.y))
        .ok()
        .flatten()
        .is_some()
    {
        let _ = window.set_position(PhysicalPosition::new(state.x, state.y));
    } else {
        let _ = window.center();
    }
    if state.maximized {
        let _ = window.maximize();
    }
}

pub fn default_window_size() -> (f64, f64) {
    (f64::from(DEFAULT_WIDTH), f64::from(DEFAULT_HEIGHT))
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join("desktop-state.json"))
        .map_err(|error| format!("Failed to resolve desktop settings directory: {error}"))
}

fn parse_settings(contents: &str) -> DesktopSettings {
    serde_json::from_str(contents).unwrap_or_default()
}

fn saved_window_state(
    previous: Option<&WindowState>,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    maximized: bool,
) -> WindowState {
    if maximized {
        if let Some(previous) = previous {
            return WindowState {
                maximized: true,
                ..previous.clone()
            };
        }
        return WindowState {
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            x: position.x,
            y: position.y,
            maximized: true,
        };
    }
    WindowState {
        width: size.width.max(MIN_WIDTH),
        height: size.height.max(MIN_HEIGHT),
        x: position.x,
        y: position.y,
        maximized,
    }
}

fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Desktop settings path has no parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create desktop settings directory: {error}"))?;
    let temporary = path.with_extension(format!(
        "json.{}.tmp",
        NEXT_WRITE_ID.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&temporary, contents)
        .map_err(|error| format!("Failed to write desktop settings: {error}"))?;
    if let Err(error) = fs::rename(&temporary, path) {
        if cfg!(windows) && path.exists() {
            let backup = path.with_extension(format!(
                "json.{}.bak",
                NEXT_WRITE_ID.fetch_add(1, Ordering::Relaxed)
            ));
            fs::rename(path, &backup).map_err(|backup_error| {
                format!("Failed to prepare desktop settings replacement: {backup_error}")
            })?;
            if let Err(rename_error) = fs::rename(&temporary, path) {
                let _ = fs::rename(&backup, path);
                return Err(format!(
                    "Failed to replace desktop settings: {rename_error}"
                ));
            }
            let _ = fs::remove_file(backup);
        } else {
            return Err(format!("Failed to replace desktop settings: {error}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        parse_settings, saved_window_state, settings_persistence_disabled_value, write_atomic,
        DesktopSettings, WindowState,
    };
    use std::ffi::OsStr;
    use std::fs;
    use tauri::{PhysicalPosition, PhysicalSize};

    #[test]
    fn settings_remain_backward_compatible_when_fields_are_missing() {
        let settings: DesktopSettings = serde_json::from_str("{}").expect("settings");
        assert!(settings.workspace.is_none());
        assert!(settings.window.is_none());
    }

    #[test]
    fn corrupt_settings_fall_back_to_defaults() {
        let settings = parse_settings("{");
        assert!(settings.workspace.is_none());
        assert!(settings.window.is_none());
    }

    #[test]
    fn window_state_round_trips() {
        let state = WindowState {
            width: 1200,
            height: 800,
            x: 20,
            y: 40,
            maximized: true,
        };
        let json = serde_json::to_string(&state).expect("serialize");
        let restored: WindowState = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(restored.width, 1200);
        assert!(restored.maximized);
    }

    #[test]
    fn maximized_save_preserves_previous_normal_bounds() {
        let previous = WindowState {
            width: 1000,
            height: 700,
            x: 10,
            y: 20,
            maximized: false,
        };
        let state = saved_window_state(
            Some(&previous),
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(1920, 1080),
            true,
        );
        assert_eq!(state.width, 1000);
        assert_eq!(state.height, 700);
        assert_eq!(state.x, 10);
        assert_eq!(state.y, 20);
        assert!(state.maximized);
    }

    #[test]
    fn maximized_first_save_uses_default_normal_size() {
        let state = saved_window_state(
            None,
            PhysicalPosition::new(40, 50),
            PhysicalSize::new(2560, 1440),
            true,
        );
        assert_eq!(state.width, 1280);
        assert_eq!(state.height, 820);
        assert_eq!(state.x, 40);
        assert_eq!(state.y, 50);
        assert!(state.maximized);
    }

    #[test]
    fn atomic_write_replaces_existing_contents() {
        let root = std::env::temp_dir().join(format!("qwen-desktop-state-{}", std::process::id()));
        let path = root.join("desktop-state.json");
        write_atomic(&path, b"first").expect("first write");
        write_atomic(&path, b"second").expect("second write");
        assert_eq!(fs::read_to_string(&path).expect("read"), "second");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn smoke_can_disable_settings_persistence() {
        assert!(settings_persistence_disabled_value(Some(OsStr::new("1"))));
        assert!(!settings_persistence_disabled_value(Some(OsStr::new("0"))));
        assert!(!settings_persistence_disabled_value(None));
    }
}
