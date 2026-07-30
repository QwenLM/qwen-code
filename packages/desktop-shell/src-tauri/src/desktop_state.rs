use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

const DEFAULT_WIDTH: u32 = 1280;
const DEFAULT_HEIGHT: u32 = 820;
const MIN_WIDTH: u32 = 900;
const MIN_HEIGHT: u32 = 600;

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
            Ok(contents) => serde_json::from_str(&contents)
                .map_err(|error| format!("Failed to parse desktop settings: {error}"))?,
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
            settings.window = Some(WindowState {
                width: size.width.max(MIN_WIDTH),
                height: size.height.max(MIN_HEIGHT),
                x: position.x,
                y: position.y,
                maximized,
            });
        })
    }

    fn update(&self, update: impl FnOnce(&mut DesktopSettings)) -> Result<(), String> {
        let serialized = {
            let mut settings = match self.settings.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            update(&mut settings);
            serde_json::to_string_pretty(&*settings)
                .map_err(|error| format!("Failed to serialize desktop settings: {error}"))?
        };
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

fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Desktop settings path has no parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create desktop settings directory: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, contents)
        .map_err(|error| format!("Failed to write desktop settings: {error}"))?;
    if let Err(error) = fs::rename(&temporary, path) {
        if cfg!(windows) && path.exists() {
            fs::remove_file(path).map_err(|remove_error| {
                format!("Failed to replace desktop settings: {remove_error}")
            })?;
            fs::rename(&temporary, path).map_err(|rename_error| {
                format!("Failed to replace desktop settings: {rename_error}")
            })?;
        } else {
            return Err(format!("Failed to replace desktop settings: {error}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{write_atomic, DesktopSettings, WindowState};
    use std::fs;

    #[test]
    fn settings_remain_backward_compatible_when_fields_are_missing() {
        let settings: DesktopSettings = serde_json::from_str("{}").expect("settings");
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
    fn atomic_write_replaces_existing_contents() {
        let root = std::env::temp_dir().join(format!("qwen-desktop-state-{}", std::process::id()));
        let path = root.join("desktop-state.json");
        write_atomic(&path, b"first").expect("first write");
        write_atomic(&path, b"second").expect("second write");
        assert_eq!(fs::read_to_string(&path).expect("read"), "second");
        fs::remove_dir_all(root).expect("cleanup");
    }
}
