#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod desktop_state;
mod runtime;

use command_group::GroupChild;
use desktop_state::{default_window_size, restore_window, SettingsStore};
use runtime::{resolve_workspace, stop_runtime_handle, DesktopRuntime};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::webview::{DownloadEvent, NewWindowResponse, WebviewWindowBuilder};
use tauri::{
    AppHandle, Emitter, Listener, Manager, RunEvent, State, WebviewUrl, WebviewWindow,
    WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

#[cfg(target_os = "windows")]
const BOOTSTRAP_URL: &str = "http://tauri.localhost";
#[cfg(not(target_os = "windows"))]
const BOOTSTRAP_URL: &str = "tauri://localhost";
#[cfg(target_os = "macos")]
static FULLSCREEN_HIDE_PENDING: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static FULLSCREEN_HIDE_GENERATION: AtomicU64 = AtomicU64::new(0);
// Keep the default first-launch workspace aligned with the Electron shell's
// getDefaultConversationWorkspacePath() in
// packages/desktop/packages/shared/src/config/storage.ts: ~/Documents/Qwen,
// relocatable through QWEN_DEFAULT_WORKSPACE_DIR (see default_workspace).
const DEFAULT_WORKSPACE_DIRECTORY: &str = "Qwen";
const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapState {
    desktop_version: String,
    status: &'static str,
    workspace: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStopped {
    runtime_id: u64,
    status: String,
}

// A runtime that has spawned but may still be inside DesktopRuntime::start's
// startup wait. Shares the child handle with the DesktopRuntime it becomes,
// so a stop during that window kills the in-flight daemon instead of
// orphaning it in its own process group.
struct PendingRuntime {
    generation: u64,
    child: Arc<Mutex<Option<GroupChild>>>,
    stopping: Arc<AtomicBool>,
}

impl PendingRuntime {
    fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        stop_runtime_handle(&self.child);
    }
}

struct ApplicationState {
    runtime: Mutex<Option<DesktopRuntime>>,
    pending_runtime: Mutex<Option<PendingRuntime>>,
    settings: SettingsStore,
    log_path: PathBuf,
    origin: Arc<Mutex<Option<Url>>>,
    last_error: Mutex<Option<String>>,
    last_workspace: Mutex<Option<(PathBuf, bool)>>,
    window_dirty: AtomicBool,
    start_generation: AtomicU64,
    starting: AtomicU64,
}

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            bootstrap_state,
            choose_workspace,
            open_logs,
            restart_runtime,
            install_update,
        ])
        .setup(setup_app);

    let app = match builder.build(tauri::generate_context!()) {
        Ok(app) => app,
        Err(error) => {
            eprintln!("Failed to initialize Qwen Code desktop: {error}");
            return;
        }
    };

    app.run(|app_handle, event| match event {
        RunEvent::WindowEvent { label, event, .. } if label == "main" => match event {
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                app_handle
                    .state::<ApplicationState>()
                    .window_dirty
                    .store(true, Ordering::Relaxed);
            }
            #[cfg(target_os = "macos")]
            WindowEvent::Focused(true) => {
                cancel_pending_fullscreen_hide();
            }
            #[cfg(target_os = "macos")]
            WindowEvent::CloseRequested { api, .. } => {
                save_window_state(app_handle);
                api.prevent_close();
                if let Some(window) = app_handle.get_webview_window("main") {
                    if FULLSCREEN_HIDE_PENDING.load(Ordering::Acquire) {
                        return;
                    }
                    if window.is_fullscreen().unwrap_or(false) {
                        if window.set_fullscreen(false).is_err() {
                            FULLSCREEN_HIDE_PENDING.store(false, Ordering::Release);
                            return;
                        }
                        let hide_generation =
                            FULLSCREEN_HIDE_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
                        FULLSCREEN_HIDE_PENDING.store(true, Ordering::Release);
                        let app = app_handle.clone();
                        let win = window.clone();
                        // ponytail: remove this delay when Tauri exposes fullscreen-exit events.
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_secs(2));
                            let _ = app.run_on_main_thread(move || {
                                if take_pending_fullscreen_hide(hide_generation) {
                                    let _ = win.hide();
                                }
                            });
                        });
                    } else {
                        let _ = window.hide();
                    }
                }
            }
            #[cfg(not(target_os = "macos"))]
            WindowEvent::CloseRequested { .. } => save_window_state(app_handle),
            _ => {}
        },
        RunEvent::Exit | RunEvent::ExitRequested { .. } => {
            save_window_state(app_handle);
            stop_runtime(app_handle);
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows,
            ..
        } if should_restore_main_window(
            has_visible_windows,
            app_handle.get_webview_window("main").is_some_and(|window| {
                !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(false)
            }),
        ) =>
        {
            focus_main_window(app_handle)
        }
        _ => {}
    });
}

fn setup_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let settings = SettingsStore::load(&handle).map_err(std::io::Error::other)?;
    let window_state = settings.window();
    let log_path = desktop_log_path(&handle).map_err(std::io::Error::other)?;
    if let Some(parent) = log_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&log_path, b"");
    let origin = Arc::new(Mutex::new(None));
    let navigation_origin = Arc::clone(&origin);
    let runtime_exit_handle = handle.clone();
    handle.listen("runtime-process-stopped", move |event| {
        let Ok(stopped) = serde_json::from_str::<RuntimeStopped>(event.payload()) else {
            return;
        };
        let state = runtime_exit_handle.state::<ApplicationState>();
        if lock(&state.runtime).as_ref().map(DesktopRuntime::id) != Some(stopped.runtime_id) {
            return;
        }
        stop_runtime(&runtime_exit_handle);
        *lock(&state.origin) = None;
        let message = format!("Qwen Code stopped: {}", stopped.status);
        *lock(&state.last_error) = Some(message.clone());
        let _ = navigate_to_bootstrap(&runtime_exit_handle);
        let _ = runtime_exit_handle.emit("runtime-failed", message);
    });
    let (width, height) = default_window_size();

    let window = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::App("index.html".into()))
        .title("Qwen Code")
        .inner_size(width, height)
        .min_inner_size(900.0, 600.0)
        .on_navigation(move |url| is_allowed_navigation(url, &navigation_origin))
        .on_new_window(|url, _features| {
            if is_safe_external_url(&url) {
                let _ = open::that_detached(url.as_str());
            }
            NewWindowResponse::Deny
        })
        .on_download(|webview, event| match event {
            DownloadEvent::Requested { url, .. } => webview
                .url()
                .ok()
                .and_then(|current| origin_of(&current).ok())
                .is_some_and(|current_origin| {
                    url.scheme() == "blob"
                        && lock(&webview.app_handle().state::<ApplicationState>().origin)
                            .as_ref()
                            .is_some_and(|runtime_origin| current_origin == *runtime_origin)
                }),
            DownloadEvent::Finished { .. } => true,
            _ => false,
        })
        .build()?;
    restore_window(&window, window_state.as_ref());

    handle.manage(ApplicationState {
        runtime: Mutex::new(None),
        pending_runtime: Mutex::new(None),
        settings,
        log_path,
        origin,
        last_error: Mutex::new(None),
        last_workspace: Mutex::new(None),
        window_dirty: AtomicBool::new(false),
        start_generation: AtomicU64::new(0),
        starting: AtomicU64::new(0),
    });

    match initial_workspace(&handle) {
        Ok((workspace, create_if_missing)) => {
            start_runtime_async(handle.clone(), workspace, create_if_missing)
        }
        Err(error) => {
            *lock(&handle.state::<ApplicationState>().last_error) = Some(error.clone());
            let _ = handle.emit("runtime-failed", error);
        }
    }
    check_updates_silently(handle.clone());
    spawn_window_state_flusher(handle);
    Ok(())
}

#[tauri::command]
fn bootstrap_state(
    webview: WebviewWindow,
    state: State<'_, ApplicationState>,
) -> Result<BootstrapState, String> {
    require_bootstrap_origin(&webview)?;
    let starting = state.starting.load(Ordering::SeqCst) != 0;
    let running = lock(&state.runtime).is_some();
    let workspace = bootstrap_workspace(
        lock(&state.last_workspace).clone(),
        state.settings.workspace(),
    );
    Ok(BootstrapState {
        desktop_version: env!("CARGO_PKG_VERSION").to_string(),
        status: if running {
            "ready"
        } else if starting {
            "starting"
        } else {
            "idle"
        },
        workspace: workspace.map(|path| path.to_string_lossy().into_owned()),
        error: lock(&state.last_error).clone(),
    })
}

fn bootstrap_workspace(
    last_workspace: Option<(PathBuf, bool)>,
    persisted_workspace: Option<PathBuf>,
) -> Option<PathBuf> {
    last_workspace
        .map(|(workspace, _)| workspace)
        .or(persisted_workspace)
}

#[tauri::command]
async fn choose_workspace(
    webview: WebviewWindow,
    app: AppHandle,
) -> Result<Option<String>, String> {
    require_bootstrap_origin(&webview)?;
    let folder = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || {
            app.dialog()
                .file()
                .set_title("Choose a Qwen Code workspace")
                .blocking_pick_folder()
        }
    })
    .await
    .map_err(|error| format!("Failed to show workspace picker: {error}"))?;
    let Some(folder) = folder else {
        return Ok(None);
    };
    let workspace = folder
        .into_path()
        .map_err(|error| format!("Failed to read selected workspace: {error}"))?;
    start_runtime_async(app, workspace.clone(), false);
    Ok(Some(workspace.to_string_lossy().into_owned()))
}

#[tauri::command]
fn restart_runtime(webview: WebviewWindow, app: AppHandle) -> Result<(), String> {
    require_bootstrap_origin(&webview)?;
    let last_workspace = lock(&app.state::<ApplicationState>().last_workspace).clone();
    let (workspace, create_if_missing) = match last_workspace {
        Some(workspace) => workspace,
        None => initial_workspace(&app)?,
    };
    start_runtime_async(app, workspace, create_if_missing);
    Ok(())
}

#[tauri::command]
fn open_logs(
    webview: WebviewWindow,
    state: State<'_, ApplicationState>,
) -> Result<(), String> {
    require_bootstrap_origin(&webview)?;
    if let Some(parent) = state.log_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create desktop log directory: {error}"))?;
    }
    if !state.log_path.exists() {
        fs::write(&state.log_path, b"")
            .map_err(|error| format!("Failed to create desktop log: {error}"))?;
    }
    open::that_detached(&state.log_path)
        .map_err(|error| format!("Failed to open desktop logs: {error}"))
}

#[tauri::command]
async fn install_update(webview: WebviewWindow, app: AppHandle) -> Result<(), String> {
    require_bootstrap_origin(&webview)?;
    let update = check_for_update(&app)
        .await?
        .ok_or_else(|| "No desktop update is available.".to_string())?;
    let version = update.version.clone();
    let confirmed = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || {
            app.dialog()
                .message(format!(
                    "Install Qwen Code Desktop {version} and restart now?"
                ))
                .title("Qwen Code update")
                .kind(MessageDialogKind::Info)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Install and restart".to_string(),
                    "Cancel".to_string(),
                ))
                .blocking_show()
        }
    })
    .await
    .map_err(|error| format!("Failed to show update confirmation: {error}"))?;
    if !confirmed {
        return Ok(());
    }
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| format!("Failed to install update: {error}"))?;
    app.request_restart();
    Ok(())
}

fn start_runtime_async(app: AppHandle, workspace: PathBuf, create_if_missing: bool) {
    stop_runtime(&app);
    let generation = {
        let state = app.state::<ApplicationState>();
        *lock(&state.last_workspace) = Some((workspace.clone(), create_if_missing));
        let generation = state.start_generation.fetch_add(1, Ordering::SeqCst) + 1;
        state.starting.store(generation, Ordering::SeqCst);
        generation
    };
    *lock(&app.state::<ApplicationState>().last_error) = None;
    let _ = app.emit("runtime-starting", workspace.to_string_lossy().into_owned());
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ApplicationState>();
        // Creating the default workspace touches ~/Documents, which can raise
        // the macOS TCC prompt, so it runs here (off the main thread) instead
        // of during setup.
        if create_if_missing {
            if let Err(error) = ensure_workspace_dir(&workspace) {
                emit_runtime_failure(&app, generation, error);
                return;
            }
        }
        let canonical = match resolve_workspace(&workspace) {
            Ok(path) => path,
            Err(error) => {
                emit_runtime_failure(&app, generation, error);
                return;
            }
        };
        if let Err(error) = state.settings.set_workspace(canonical.clone()) {
            emit_runtime_failure(&app, generation, error);
            return;
        }
        let registered = app.clone();
        match DesktopRuntime::start(&app, &canonical, &state.log_path, move |child, stopping| {
            let state = registered.state::<ApplicationState>();
            let pending = PendingRuntime {
                generation,
                child,
                stopping,
            };
            let mut slot = lock(&state.pending_runtime);
            if state.start_generation.load(Ordering::SeqCst) == generation {
                *slot = Some(pending);
            } else {
                drop(slot);
                pending.stop();
            }
        }) {
            Ok(runtime) => {
                if state.start_generation.load(Ordering::SeqCst) != generation {
                    runtime.stop();
                    clear_pending_runtime(&state, generation);
                    return;
                }
                let origin = match origin_of(runtime.base_url()) {
                    Ok(origin) => origin,
                    Err(error) => {
                        runtime.stop();
                        clear_pending_runtime(&state, generation);
                        emit_runtime_failure(&app, generation, error);
                        return;
                    }
                };
                *lock(&state.origin) = Some(origin);
                let Some(window) = app.get_webview_window("main") else {
                    runtime.stop();
                    clear_pending_runtime(&state, generation);
                    emit_runtime_failure(
                        &app,
                        generation,
                        "Desktop window is unavailable.".to_string(),
                    );
                    return;
                };
                if let Err(error) = window.navigate(runtime.authenticated_web_url()) {
                    runtime.stop();
                    clear_pending_runtime(&state, generation);
                    emit_runtime_failure(
                        &app,
                        generation,
                        format!("Failed to authenticate and load Web Shell: {error}"),
                    );
                    return;
                }
                let mut runtime_slot = lock(&state.runtime);
                if state.start_generation.load(Ordering::SeqCst) != generation {
                    drop(runtime_slot);
                    runtime.stop();
                    clear_pending_runtime(&state, generation);
                    return;
                }
                *runtime_slot = Some(runtime);
                drop(runtime_slot);
                clear_pending_runtime(&state, generation);
                if state
                    .starting
                    .compare_exchange(generation, 0, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
                {
                    let _ = app.emit("runtime-ready", canonical.to_string_lossy().into_owned());
                }
            }
            Err(error) => {
                clear_pending_runtime(&state, generation);
                emit_runtime_failure(&app, generation, error);
            }
        }
    });
}

fn emit_runtime_failure(app: &AppHandle, generation: u64, error: String) {
    let state = app.state::<ApplicationState>();
    if state.start_generation.load(Ordering::SeqCst) != generation {
        return;
    }
    state
        .starting
        .compare_exchange(generation, 0, Ordering::SeqCst, Ordering::SeqCst)
        .ok();
    *lock(&state.origin) = None;
    *lock(&state.last_error) = Some(error.clone());
    let _ = navigate_to_bootstrap(app);
    let _ = app.emit("runtime-failed", error);
}

fn stop_runtime(app: &AppHandle) {
    let state = app.state::<ApplicationState>();
    state.start_generation.fetch_add(1, Ordering::SeqCst);
    state.starting.store(0, Ordering::SeqCst);
    let runtime = lock(&state.runtime).take();
    if let Some(runtime) = runtime {
        runtime.stop();
    }
    // Kill any daemon still inside DesktopRuntime::start's startup wait.
    // Shares the child handle with a live runtime, so the take() inside
    // stop_runtime_handle keeps this idempotent.
    let pending = lock(&state.pending_runtime).take();
    if let Some(pending) = pending {
        pending.stop();
    }
}

fn clear_pending_runtime(state: &ApplicationState, generation: u64) {
    let mut pending = lock(&state.pending_runtime);
    if pending.as_ref().map(|runtime| runtime.generation) == Some(generation) {
        pending.take();
    }
}

// Resolves the initial workspace and whether it is the derived first-launch
// default that must be created before starting the runtime. Path resolution
// only: directory creation happens off the main thread in start_runtime_async
// because the first touch of ~/Documents can trigger the macOS TCC prompt.
fn initial_workspace(app: &AppHandle) -> Result<(PathBuf, bool), String> {
    if let Some(workspace) = std::env::var_os("QWEN_DESKTOP_WORKSPACE") {
        return Ok((PathBuf::from(workspace), false));
    }
    if let Some(workspace) = app.state::<ApplicationState>().settings.workspace() {
        return Ok((workspace, false));
    }
    default_workspace(app)
}

fn default_workspace(app: &AppHandle) -> Result<(PathBuf, bool), String> {
    // Matches the Electron shell, where an empty override falls back to the
    // ~/Documents/Qwen default.
    let override_dir =
        default_workspace_override_dir(std::env::var_os("QWEN_DEFAULT_WORKSPACE_DIR"));
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Failed to resolve the home directory: {error}"))?;
    Ok((
        default_workspace_path(&home, override_dir.as_deref()),
        true,
    ))
}

// An empty override is treated as unset so the ~/Documents/Qwen default wins,
// mirroring the Electron shell's `||` fallback.
fn default_workspace_override_dir(value: Option<OsString>) -> Option<PathBuf> {
    value
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

fn default_workspace_path(home: &Path, override_dir: Option<&Path>) -> PathBuf {
    match override_dir {
        Some(dir) => dir.to_path_buf(),
        None => home.join("Documents").join(DEFAULT_WORKSPACE_DIRECTORY),
    }
}

// Creates the default workspace directory. Kept separate from path
// resolution so it can run off the main thread and be tested on its own.
fn ensure_workspace_dir(workspace: &Path) -> Result<(), String> {
    fs::create_dir_all(workspace).map_err(|error| {
        format!(
            "Failed to create the default workspace {}: {error}",
            workspace.display()
        )
    })
}

fn desktop_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_log_dir()
        .map(|path| path.join("desktop-runtime.log"))
        .map_err(|error| format!("Failed to resolve desktop log directory: {error}"))
}

fn save_window_state(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = app
            .state::<ApplicationState>()
            .settings
            .save_window(&window);
    }
}

fn spawn_window_state_flusher(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(300));
        let state = app.state::<ApplicationState>();
        if state.window_dirty.swap(false, Ordering::Relaxed) {
            save_window_state(&app);
        }
    });
}

fn focus_main_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    cancel_pending_fullscreen_hide();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(target_os = "macos")]
fn cancel_pending_fullscreen_hide() {
    FULLSCREEN_HIDE_GENERATION.fetch_add(1, Ordering::AcqRel);
    FULLSCREEN_HIDE_PENDING.store(false, Ordering::Release);
}

#[cfg(target_os = "macos")]
fn take_pending_fullscreen_hide(generation: u64) -> bool {
    FULLSCREEN_HIDE_GENERATION.load(Ordering::Acquire) == generation
        && FULLSCREEN_HIDE_PENDING.swap(false, Ordering::AcqRel)
}

#[cfg(target_os = "macos")]
fn should_restore_main_window(has_visible_windows: bool, main_needs_restore: bool) -> bool {
    !has_visible_windows || main_needs_restore || FULLSCREEN_HIDE_PENDING.load(Ordering::Relaxed)
}

fn navigate_to_bootstrap(app: &AppHandle) -> Result<(), String> {
    let url = Url::parse(BOOTSTRAP_URL)
        .map_err(|error| format!("Failed to construct bootstrap URL: {error}"))?;
    app.get_webview_window("main")
        .ok_or_else(|| "Desktop window is unavailable.".to_string())?
        .navigate(url)
        .map_err(|error| format!("Failed to show desktop recovery page: {error}"))
}

fn require_bootstrap_origin(webview: &WebviewWindow) -> Result<(), String> {
    let url = webview
        .url()
        .map_err(|error| format!("Failed to read calling webview URL: {error}"))?;
    if is_bootstrap_url(&url) {
        Ok(())
    } else {
        Err("This command is only available from the desktop shell.".to_string())
    }
}

fn is_allowed_navigation(url: &Url, origin: &Mutex<Option<Url>>) -> bool {
    is_bootstrap_url(url)
        || lock(origin)
            .as_ref()
            .is_some_and(|allowed| is_same_origin(url, allowed))
}

fn is_bootstrap_url(url: &Url) -> bool {
    if url.scheme() == "tauri" && url.host_str() == Some("localhost") {
        return true;
    }
    cfg!(target_os = "windows")
        && matches!(url.scheme(), "http" | "https")
        && url.host_str() == Some("tauri.localhost")
}

fn origin_of(url: &Url) -> Result<Url, String> {
    let mut origin = url.clone();
    origin.set_path("/");
    origin.set_query(None);
    origin.set_fragment(None);
    if origin.scheme() != "http" || origin.host_str() != Some("127.0.0.1") {
        return Err(format!("Refusing non-loopback runtime URL: {origin}"));
    }
    Ok(origin)
}

fn is_same_origin(url: &Url, origin: &Url) -> bool {
    url.scheme() == origin.scheme()
        && url.host_str() == origin.host_str()
        && url.port_or_known_default() == origin.port_or_known_default()
}

fn check_updates_silently(app: AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let Ok(Some(update)) = check_for_update(&app).await else {
            return;
        };
        let _ = app.emit("update-available", update.version.clone());
        let version = update.version.clone();
        let confirmed = tauri::async_runtime::spawn_blocking({
            let app = app.clone();
            let version = version.clone();
            move || {
                app.dialog()
                    .message(format!(
                        "Qwen Code Desktop {version} is available. Install and restart now?"
                    ))
                    .title("Qwen Code update")
                    .kind(MessageDialogKind::Info)
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "Install and restart".to_string(),
                        "Later".to_string(),
                    ))
                    .blocking_show()
            }
        })
        .await;
        if !matches!(confirmed, Ok(true)) {
            return;
        }
        if let Err(error) = update.download_and_install(|_, _| {}, || {}).await {
            let _ = tauri::async_runtime::spawn_blocking({
                let app = app.clone();
                let version = version.clone();
                move || {
                    app.dialog()
                        .message(format!(
                            "Qwen Code Desktop {version} could not be installed.\n\n{error}\n\nSave your work before quitting. Reinstall Qwen Code if it does not reopen."
                        ))
                        .title("Qwen Code update failed")
                        .kind(MessageDialogKind::Error)
                        .blocking_show()
                }
            })
            .await;
            return;
        }
        app.request_restart();
    });
}

async fn check_for_update(app: &AppHandle) -> Result<Option<Update>, String> {
    app.updater_builder()
        .timeout(UPDATE_CHECK_TIMEOUT)
        .build()
        .map_err(|error| format!("Failed to initialize updater: {error}"))?
        .check()
        .await
        .map_err(|error| format!("Failed to check for updates: {error}"))
}

fn is_safe_external_url(url: &Url) -> bool {
    matches!(url.scheme(), "https" | "http" | "mailto")
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    use super::{
        cancel_pending_fullscreen_hide, should_restore_main_window, take_pending_fullscreen_hide,
        FULLSCREEN_HIDE_GENERATION, FULLSCREEN_HIDE_PENDING,
    };
    use super::{
        bootstrap_workspace, default_workspace_override_dir, default_workspace_path,
        ensure_workspace_dir, is_allowed_navigation, is_bootstrap_url, is_safe_external_url,
        is_same_origin, origin_of, BOOTSTRAP_URL,
    };
    use std::ffi::OsString;
    use std::fs;
    use std::path::PathBuf;
    #[cfg(target_os = "macos")]
    use std::sync::atomic::Ordering;
    use std::sync::Mutex;
    use url::Url;

    #[test]
    fn bootstrap_prefers_the_workspace_being_started() {
        let attempted = PathBuf::from("/tmp/attempted");
        let persisted = PathBuf::from("/tmp/persisted");
        assert_eq!(
            bootstrap_workspace(Some((attempted.clone(), false)), Some(persisted.clone())),
            Some(attempted),
        );
        assert_eq!(
            bootstrap_workspace(None, Some(persisted.clone())),
            Some(persisted)
        );
        assert_eq!(
            bootstrap_workspace(Some((PathBuf::from("/tmp/first-launch"), true)), None),
            Some(PathBuf::from("/tmp/first-launch")),
        );
        assert_eq!(bootstrap_workspace(None, None), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn fullscreen_hide_lifecycle_state() {
        // has_visible, main_needs_restore, FULLSCREEN_PENDING → expected
        let cases: &[(bool, bool, bool, bool)] = &[
            (true, false, false, false),
            (true, false, true, true),
            (true, true, false, true),
            (true, true, true, true),
            (false, false, false, true),
            (false, false, true, true),
            (false, true, false, true),
            (false, true, true, true),
        ];
        for (has_visible, needs_restore, pending, expected) in cases {
            FULLSCREEN_HIDE_PENDING.store(*pending, Ordering::Relaxed);
            assert_eq!(
                should_restore_main_window(*has_visible, *needs_restore),
                *expected,
                "has_visible={}, needs_restore={}, pending={}",
                has_visible,
                needs_restore,
                pending,
            );
        }
        FULLSCREEN_HIDE_PENDING.store(false, Ordering::Relaxed);

        FULLSCREEN_HIDE_GENERATION.store(0, Ordering::Relaxed);
        let first_hide = FULLSCREEN_HIDE_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
        FULLSCREEN_HIDE_PENDING.store(true, Ordering::Release);
        cancel_pending_fullscreen_hide();
        let second_hide = FULLSCREEN_HIDE_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
        FULLSCREEN_HIDE_PENDING.store(true, Ordering::Release);
        assert!(!take_pending_fullscreen_hide(first_hide));
        assert!(FULLSCREEN_HIDE_PENDING.load(Ordering::Relaxed));
        assert!(take_pending_fullscreen_hide(second_hide));
    }

    #[test]
    fn allows_only_the_daemon_origin_in_the_main_window() {
        let origin = Url::parse("http://127.0.0.1:49152/").expect("origin");
        assert!(is_same_origin(
            &Url::parse("http://127.0.0.1:49152/session/123").expect("same origin"),
            &origin,
        ));
        assert!(!is_same_origin(
            &Url::parse("http://127.0.0.1:49153/").expect("different port"),
            &origin,
        ));
        assert!(!is_same_origin(
            &Url::parse("https://example.com/").expect("external"),
            &origin,
        ));
    }

    #[test]
    fn creates_and_reuses_the_default_workspace() {
        let home = std::env::temp_dir().join(format!(
            "qwen-desktop-default-workspace-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&home);

        let workspace = default_workspace_path(&home, None);
        assert_eq!(workspace, home.join("Documents/Qwen"));
        ensure_workspace_dir(&workspace).expect("create workspace");
        ensure_workspace_dir(&workspace).expect("reuse workspace");

        assert!(workspace.is_dir());
        fs::remove_dir_all(home).expect("cleanup");
    }

    #[test]
    fn reports_an_uncreatable_default_workspace() {
        let home = std::env::temp_dir().join(format!(
            "qwen-desktop-default-workspace-error-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).expect("create home");
        fs::write(home.join("Documents"), b"not a directory").expect("block Documents");

        let workspace = default_workspace_path(&home, None);
        assert!(ensure_workspace_dir(&workspace).is_err());
        fs::remove_dir_all(home).expect("cleanup");
    }

    #[test]
    fn treats_an_unset_or_empty_workspace_override_as_absent() {
        assert_eq!(default_workspace_override_dir(None), None);
        assert_eq!(default_workspace_override_dir(Some(OsString::new())), None);
    }

    #[test]
    fn uses_a_non_empty_workspace_override_verbatim() {
        let custom = PathBuf::from("/tmp/qwen-custom-workspace");
        assert_eq!(
            default_workspace_override_dir(Some(OsString::from(custom.clone()))),
            Some(custom)
        );
    }

    #[test]
    fn honors_the_default_workspace_directory_override() {
        let home = std::env::temp_dir().join(format!(
            "qwen-desktop-default-workspace-override-home-{}",
            std::process::id()
        ));
        let custom = std::env::temp_dir().join(format!(
            "qwen-desktop-default-workspace-override-target-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&custom);
        fs::create_dir_all(&home).expect("create home");

        let workspace = default_workspace_path(&home, Some(&custom));
        assert_eq!(workspace, custom);
        ensure_workspace_dir(&workspace).expect("create override workspace");

        assert!(custom.is_dir());
        assert!(!home.join("Documents").exists());
        fs::remove_dir_all(home).expect("cleanup home");
        fs::remove_dir_all(custom).expect("cleanup override");
    }

    #[test]
    fn allows_platform_bootstrap_origins() {
        assert!(is_bootstrap_url(
            &Url::parse("tauri://localhost/").expect("tauri bootstrap")
        ));
        if cfg!(target_os = "windows") {
            assert!(is_bootstrap_url(
                &Url::parse("http://tauri.localhost/").expect("windows bootstrap")
            ));
        } else {
            assert!(!is_bootstrap_url(
                &Url::parse("http://tauri.localhost/").expect("not a bootstrap origin")
            ));
        }
    }

    #[test]
    fn recovery_uses_the_platform_bootstrap_origin() {
        let expected = if cfg!(windows) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        };
        assert_eq!(BOOTSTRAP_URL, expected);
    }

    #[test]
    fn rejects_non_loopback_runtime_origins() {
        let error = origin_of(&Url::parse("http://0.0.0.0:4170/").expect("url"))
            .expect_err("non-loopback origin");
        assert!(error.contains("non-loopback"));
    }

    #[test]
    fn new_windows_allow_only_browser_safe_schemes() {
        assert!(is_safe_external_url(
            &Url::parse("https://qwen.ai/").expect("https")
        ));
        assert!(is_safe_external_url(
            &Url::parse("mailto:test@example.com").expect("mailto")
        ));
        assert!(!is_safe_external_url(
            &Url::parse("file:///etc/passwd").expect("file")
        ));
        assert!(!is_safe_external_url(
            &Url::parse("javascript:alert(1)").expect("javascript")
        ));
    }

    #[test]
    fn allows_bootstrap_but_not_a_runtime_url_before_origin_is_set() {
        let origin = Mutex::new(None);
        assert!(is_allowed_navigation(
            &Url::parse(BOOTSTRAP_URL).expect("bootstrap"),
            &origin,
        ));
        assert!(!is_allowed_navigation(
            &Url::parse("http://127.0.0.1:49152/").expect("runtime"),
            &origin,
        ));
    }

    #[test]
    fn allows_only_the_recorded_origin_once_it_is_set() {
        let origin = Mutex::new(Some(
            Url::parse("http://127.0.0.1:49152/").expect("origin"),
        ));
        assert!(is_allowed_navigation(
            &Url::parse("http://127.0.0.1:49152/session/123").expect("same origin"),
            &origin,
        ));
        assert!(!is_allowed_navigation(
            &Url::parse("http://127.0.0.1:49153/").expect("different port"),
            &origin,
        ));
        assert!(!is_allowed_navigation(
            &Url::parse("https://example.com/").expect("external"),
            &origin,
        ));
    }

    #[test]
    fn allows_bootstrap_even_after_origin_is_set() {
        let origin = Mutex::new(Some(
            Url::parse("http://127.0.0.1:49152/").expect("origin"),
        ));
        assert!(is_allowed_navigation(
            &Url::parse(BOOTSTRAP_URL).expect("bootstrap"),
            &origin,
        ));
    }

    #[test]
    fn command_origin_gate_accepts_only_bootstrap() {
        assert!(is_bootstrap_url(
            &Url::parse(BOOTSTRAP_URL).expect("bootstrap")
        ));
        assert!(!is_bootstrap_url(
            &Url::parse("http://127.0.0.1:49152/").expect("runtime")
        ));
        assert!(!is_bootstrap_url(
            &Url::parse("https://example.com/").expect("external")
        ));
    }
}
