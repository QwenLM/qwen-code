#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod desktop_state;
mod runtime;

use desktop_state::{default_window_size, restore_window, SettingsStore};
use runtime::{resolve_workspace, DesktopRuntime};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::webview::{DownloadEvent, NewWindowResponse, WebviewWindowBuilder};
use tauri::{
    AppHandle, Emitter, Listener, Manager, RunEvent, State, WebviewUrl, WebviewWindow,
    WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;
use url::Url;

#[cfg(target_os = "windows")]
const BOOTSTRAP_URL: &str = "http://tauri.localhost";
#[cfg(not(target_os = "windows"))]
const BOOTSTRAP_URL: &str = "tauri://localhost";

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

struct ApplicationState {
    runtime: Mutex<Option<DesktopRuntime>>,
    settings: SettingsStore,
    log_path: PathBuf,
    origin: Arc<Mutex<Option<Url>>>,
    last_error: Mutex<Option<String>>,
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
            WindowEvent::CloseRequested { .. } => save_window_state(app_handle),
            _ => {}
        },
        RunEvent::Exit | RunEvent::ExitRequested { .. } => {
            save_window_state(app_handle);
            stop_runtime(app_handle);
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
        settings,
        log_path,
        origin,
        last_error: Mutex::new(None),
        window_dirty: AtomicBool::new(false),
        start_generation: AtomicU64::new(0),
        starting: AtomicU64::new(0),
    });

    if let Some(workspace) = initial_workspace(&handle) {
        start_runtime_async(handle.clone(), workspace);
    } else {
        let _ = handle.emit("workspace-required", ());
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
    Ok(BootstrapState {
        desktop_version: env!("CARGO_PKG_VERSION").to_string(),
        status: if running {
            "ready"
        } else if starting {
            "starting"
        } else {
            "idle"
        },
        workspace: state
            .settings
            .workspace()
            .map(|path| path.to_string_lossy().into_owned()),
        error: lock(&state.last_error).clone(),
    })
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
    start_runtime_async(app, workspace.clone());
    Ok(Some(workspace.to_string_lossy().into_owned()))
}

#[tauri::command]
fn restart_runtime(webview: WebviewWindow, app: AppHandle) -> Result<(), String> {
    require_bootstrap_origin(&webview)?;
    let workspace = app
        .state::<ApplicationState>()
        .settings
        .workspace()
        .ok_or_else(|| "Choose a workspace before starting Qwen Code.".to_string())?;
    start_runtime_async(app, workspace);
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
    let update = app
        .updater()
        .map_err(|error| format!("Failed to initialize updater: {error}"))?
        .check()
        .await
        .map_err(|error| format!("Failed to check for updates: {error}"))?
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

fn start_runtime_async(app: AppHandle, workspace: PathBuf) {
    let generation = {
        let state = app.state::<ApplicationState>();
        let generation = state.start_generation.fetch_add(1, Ordering::SeqCst) + 1;
        state.starting.store(generation, Ordering::SeqCst);
        generation
    };
    stop_runtime(&app);
    *lock(&app.state::<ApplicationState>().last_error) = None;
    let _ = app.emit("runtime-starting", workspace.to_string_lossy().into_owned());
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ApplicationState>();
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
        match DesktopRuntime::start(&app, &canonical, &state.log_path) {
            Ok(runtime) => {
                if state.start_generation.load(Ordering::SeqCst) != generation {
                    runtime.stop();
                    return;
                }
                let origin = match origin_of(runtime.base_url()) {
                    Ok(origin) => origin,
                    Err(error) => {
                        runtime.stop();
                        emit_runtime_failure(&app, generation, error);
                        return;
                    }
                };
                *lock(&state.origin) = Some(origin);
                let Some(window) = app.get_webview_window("main") else {
                    runtime.stop();
                    emit_runtime_failure(
                        &app,
                        generation,
                        "Desktop window is unavailable.".to_string(),
                    );
                    return;
                };
                if let Err(error) = window.navigate(runtime.authenticated_web_url()) {
                    runtime.stop();
                    emit_runtime_failure(
                        &app,
                        generation,
                        format!("Failed to authenticate and load Web Shell: {error}"),
                    );
                    return;
                }
                *lock(&state.runtime) = Some(runtime);
                state
                    .starting
                    .compare_exchange(generation, 0, Ordering::SeqCst, Ordering::SeqCst)
                    .ok();
                let _ = app.emit("runtime-ready", canonical.to_string_lossy().into_owned());
            }
            Err(error) => emit_runtime_failure(&app, generation, error),
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
    if let Some(runtime) = lock(&app.state::<ApplicationState>().runtime).take() {
        runtime.stop();
    }
}

fn initial_workspace(app: &AppHandle) -> Option<PathBuf> {
    std::env::var_os("QWEN_DESKTOP_WORKSPACE")
        .map(PathBuf::from)
        .or_else(|| app.state::<ApplicationState>().settings.workspace())
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
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
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
        let updater = match app.updater() {
            Ok(updater) => updater,
            Err(_) => return,
        };
        let Ok(Some(update)) = updater.check().await else {
            return;
        };
        let _ = app.emit("update-available", update.version.clone());
        let version = update.version.clone();
        let confirmed = tauri::async_runtime::spawn_blocking({
            let app = app.clone();
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
        if update
            .download_and_install(|_, _| {}, || {})
            .await
            .is_err()
        {
            return;
        }
        app.request_restart();
    });
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
    use super::{
        is_allowed_navigation, is_bootstrap_url, is_safe_external_url, is_same_origin, origin_of,
        BOOTSTRAP_URL,
    };
    use std::sync::Mutex;
    use url::Url;

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
