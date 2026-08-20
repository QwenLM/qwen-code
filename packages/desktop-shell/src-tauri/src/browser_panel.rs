use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, Webview, WebviewBuilder};
use tauri::{
    AppHandle, LogicalPosition, LogicalRect, LogicalSize, Manager, Rect, State, WebviewUrl,
    WebviewWindow,
};
use url::Url;

use crate::{lock, require_runtime_origin, ApplicationState};

const BROWSER_PANEL_LABEL: &str = "browser-panel";
const BROWSER_STATE_EVENT: &str = "qwen-desktop-browser-state";
const MAX_HISTORY_ENTRIES: usize = 100;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPanelBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPanelSnapshot {
    url: String,
    loading: bool,
    can_go_back: bool,
    can_go_forward: bool,
}

#[derive(Default)]
struct BrowserHistory {
    entries: Vec<String>,
    index: Option<usize>,
    pending_index: Option<usize>,
}

impl BrowserHistory {
    fn record(&mut self, url: String) {
        if let Some(index) = self.pending_index.take() {
            if self.entries.get(index) == Some(&url) {
                self.index = Some(index);
                return;
            }
        }
        if self
            .index
            .and_then(|index| self.entries.get(index))
            .is_some_and(|current| current == &url)
        {
            return;
        }
        let keep = self.index.map_or(0, |index| index + 1);
        self.entries.truncate(keep);
        self.entries.push(url);
        if self.entries.len() > MAX_HISTORY_ENTRIES {
            self.entries.remove(0);
        }
        self.index = self.entries.len().checked_sub(1);
    }

    fn target(&mut self, offset: isize) -> Option<String> {
        let index = self.index?;
        let target = index.checked_add_signed(offset)?;
        let url = self.entries.get(target)?.clone();
        self.pending_index = Some(target);
        Some(url)
    }

    fn cancel_pending(&mut self) {
        self.pending_index = None;
    }

    fn can_go_back(&self) -> bool {
        self.index.is_some_and(|index| index > 0)
    }

    fn can_go_forward(&self) -> bool {
        self.index
            .is_some_and(|index| index + 1 < self.entries.len())
    }
}

#[derive(Default)]
struct BrowserPanelController {
    view: Option<Webview>,
    current_url: String,
    loading: bool,
    history: BrowserHistory,
}

impl BrowserPanelController {
    fn snapshot(&self) -> BrowserPanelSnapshot {
        BrowserPanelSnapshot {
            url: self.current_url.clone(),
            loading: self.loading,
            can_go_back: self.history.can_go_back(),
            can_go_forward: self.history.can_go_forward(),
        }
    }

    fn reset(&mut self) -> Option<Webview> {
        self.current_url.clear();
        self.loading = false;
        self.history = BrowserHistory::default();
        self.view.take()
    }
}

#[derive(Default)]
pub struct BrowserPanelStore(Mutex<BrowserPanelController>);

#[tauri::command]
pub async fn browser_panel_open(
    caller: WebviewWindow,
    app: AppHandle,
    application: State<'_, ApplicationState>,
    store: State<'_, BrowserPanelStore>,
    url: String,
    bounds: BrowserPanelBounds,
) -> Result<(), String> {
    require_runtime_origin(&caller, &application)?;
    let url = require_browser_url(&url)?;
    let rect = require_browser_bounds(&caller, bounds)?;
    let existing = lock(&store.0)
        .view
        .clone()
        .or_else(|| app.get_webview(BROWSER_PANEL_LABEL));
    if let Some(view) = existing {
        view.set_bounds(Rect {
            position: rect.position.into(),
            size: rect.size.into(),
        })
        .map_err(|error| format!("Failed to resize the desktop browser: {error}"))?;
        {
            let mut controller = lock(&store.0);
            controller.view = Some(view.clone());
            controller.current_url = url.to_string();
            controller.loading = true;
            controller.history.cancel_pending();
        }
        emit_state(&app);
        return view
            .navigate(url)
            .map_err(|error| format!("Failed to navigate the desktop browser: {error}"));
    }

    {
        let mut controller = lock(&store.0);
        controller.current_url = url.to_string();
        controller.loading = true;
    }
    emit_state(&app);

    let navigation_app = app.clone();
    let new_window_app = app.clone();
    let builder = WebviewBuilder::new(BROWSER_PANEL_LABEL, WebviewUrl::External(url.clone()))
        .incognito(true)
        .on_navigation(move |target| {
            if is_browser_url(target) {
                true
            } else {
                open_mailto(target);
                emit_current_state(&navigation_app);
                false
            }
        })
        .on_new_window(move |target, _features| {
            if is_browser_url(&target) {
                if let Some(view) = new_window_app.get_webview(BROWSER_PANEL_LABEL) {
                    let _ = view.navigate(target);
                }
            } else {
                open_mailto(&target);
            }
            NewWindowResponse::Deny
        })
        .on_download(|_webview, event| match event {
            DownloadEvent::Requested { .. } => false,
            _ => true,
        })
        .on_page_load(|webview, payload| {
            handle_page_load(
                webview.app_handle(),
                payload.url().to_string(),
                payload.event(),
            );
        });
    let view = match caller
        .as_ref()
        .window()
        .add_child(builder, rect.position, rect.size)
    {
        Ok(view) => view,
        Err(error) => match app.get_webview(BROWSER_PANEL_LABEL) {
            Some(view) => {
                view.set_bounds(Rect {
                    position: rect.position.into(),
                    size: rect.size.into(),
                })
                .map_err(|resize_error| {
                    format!("Failed to resize the desktop browser: {resize_error}")
                })?;
                view.navigate(url.clone()).map_err(|navigate_error| {
                    format!("Failed to navigate the desktop browser: {navigate_error}")
                })?;
                view
            }
            None => {
                lock(&store.0).reset();
                emit_state(&app);
                return Err(format!("Failed to open the desktop browser: {error}"));
            }
        },
    };
    lock(&store.0).view = Some(view);
    emit_state(&app);
    Ok(())
}

#[tauri::command]
pub fn browser_panel_navigate(
    caller: WebviewWindow,
    application: State<'_, ApplicationState>,
    store: State<'_, BrowserPanelStore>,
    url: String,
) -> Result<(), String> {
    require_runtime_origin(&caller, &application)?;
    let url = require_browser_url(&url)?;
    let view = {
        let mut controller = lock(&store.0);
        controller.history.cancel_pending();
        controller.current_url = url.to_string();
        controller.loading = true;
        controller.view.clone()
    }
    .ok_or_else(|| "The desktop browser is closed.".to_string())?;
    emit_state(caller.app_handle());
    view.navigate(url)
        .map_err(|error| format!("Failed to navigate the desktop browser: {error}"))
}

#[tauri::command]
pub fn browser_panel_set_bounds(
    caller: WebviewWindow,
    application: State<'_, ApplicationState>,
    store: State<'_, BrowserPanelStore>,
    bounds: BrowserPanelBounds,
) -> Result<(), String> {
    require_runtime_origin(&caller, &application)?;
    let rect = require_browser_bounds(&caller, bounds)?;
    let view = lock(&store.0).view.clone();
    if let Some(view) = view {
        view.set_bounds(Rect {
            position: rect.position.into(),
            size: rect.size.into(),
        })
        .map_err(|error| format!("Failed to resize the desktop browser: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn browser_panel_go_back(
    caller: WebviewWindow,
    application: State<'_, ApplicationState>,
    store: State<'_, BrowserPanelStore>,
) -> Result<(), String> {
    require_runtime_origin(&caller, &application)?;
    navigate_history(caller.app_handle(), &store, -1)
}

#[tauri::command]
pub fn browser_panel_go_forward(
    caller: WebviewWindow,
    application: State<'_, ApplicationState>,
    store: State<'_, BrowserPanelStore>,
) -> Result<(), String> {
    require_runtime_origin(&caller, &application)?;
    navigate_history(caller.app_handle(), &store, 1)
}

#[tauri::command]
pub fn browser_panel_reload(
    caller: WebviewWindow,
    application: State<'_, ApplicationState>,
    store: State<'_, BrowserPanelStore>,
) -> Result<(), String> {
    require_runtime_origin(&caller, &application)?;
    let view = lock(&store.0)
        .view
        .clone()
        .ok_or_else(|| "The desktop browser is closed.".to_string())?;
    view.reload()
        .map_err(|error| format!("Failed to reload the desktop browser: {error}"))
}

#[tauri::command]
pub fn browser_panel_open_external(
    caller: WebviewWindow,
    application: State<'_, ApplicationState>,
    url: String,
) -> Result<(), String> {
    require_runtime_origin(&caller, &application)?;
    let url = require_browser_url(&url)?;
    open::that_detached(url.as_str())
        .map_err(|error| format!("Failed to open the default browser: {error}"))
}

#[tauri::command]
pub fn browser_panel_close(
    caller: WebviewWindow,
    application: State<'_, ApplicationState>,
    app: AppHandle,
) -> Result<(), String> {
    require_runtime_origin(&caller, &application)?;
    close(&app)
}

pub fn close(app: &AppHandle) -> Result<(), String> {
    let view = lock(&app.state::<BrowserPanelStore>().0).reset();
    if let Some(view) = view {
        view.close()
            .map_err(|error| format!("Failed to close the desktop browser: {error}"))?;
    }
    emit_state(app);
    Ok(())
}

fn navigate_history(
    app: &AppHandle,
    store: &State<'_, BrowserPanelStore>,
    offset: isize,
) -> Result<(), String> {
    let (view, target) = {
        let mut controller = lock(&store.0);
        let target = controller.history.target(offset);
        (controller.view.clone(), target)
    };
    let Some(target) = target else {
        return Ok(());
    };
    let view = view.ok_or_else(|| "The desktop browser is closed.".to_string())?;
    {
        let mut controller = lock(&store.0);
        controller.current_url = target.clone();
        controller.loading = true;
    }
    emit_state(app);
    view.navigate(require_browser_url(&target)?)
        .map_err(|error| format!("Failed to navigate browser history: {error}"))
}

fn handle_page_load(app: &AppHandle, url: String, event: PageLoadEvent) {
    let store = app.state::<BrowserPanelStore>();
    {
        let mut controller = lock(&store.0);
        controller.current_url = url.clone();
        controller.loading = event == PageLoadEvent::Started;
        if event == PageLoadEvent::Finished && require_browser_url(&url).is_ok() {
            controller.history.record(url);
        }
    }
    emit_state(app);
}

fn emit_current_state(app: &AppHandle) {
    emit_state(app);
}

fn emit_state(app: &AppHandle) {
    let snapshot = lock(&app.state::<BrowserPanelStore>().0).snapshot();
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    let Ok(event) = serde_json::to_string(BROWSER_STATE_EVENT) else {
        return;
    };
    let Ok(payload) = serde_json::to_string(&snapshot) else {
        return;
    };
    let _ = main.eval(format!(
        "window.dispatchEvent(new CustomEvent({event}, {{ detail: {payload} }}));"
    ));
}

fn require_browser_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|_| "Only HTTP(S) URLs can be opened.".to_string())?;
    if is_browser_url(&url) {
        Ok(url)
    } else {
        Err("Only HTTP(S) URLs can be opened.".to_string())
    }
}

fn is_browser_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

fn open_mailto(url: &Url) {
    if url.scheme() == "mailto" {
        let _ = open::that_detached(url.as_str());
    }
}

fn require_browser_bounds(
    window: &WebviewWindow,
    bounds: BrowserPanelBounds,
) -> Result<LogicalRect<f64, f64>, String> {
    let scale = window
        .scale_factor()
        .map_err(|error| format!("Failed to read desktop scale: {error}"))?;
    let size = window
        .inner_size()
        .map_err(|error| format!("Failed to read desktop size: {error}"))?
        .to_logical::<f64>(scale);
    normalize_browser_bounds(bounds, size.width, size.height)
}

fn normalize_browser_bounds(
    bounds: BrowserPanelBounds,
    window_width: f64,
    window_height: f64,
) -> Result<LogicalRect<f64, f64>, String> {
    if !bounds.x.is_finite()
        || !bounds.y.is_finite()
        || !bounds.width.is_finite()
        || !bounds.height.is_finite()
        || bounds.x < 0.0
        || bounds.y < 0.0
        || bounds.width <= 0.0
        || bounds.height <= 0.0
    {
        return Err("Invalid desktop browser bounds.".to_string());
    }
    if window_width < 1.0
        || window_height < 1.0
        || bounds.x >= window_width
        || bounds.y >= window_height
    {
        return Err("Desktop browser bounds exceed the window.".to_string());
    }
    let window_width = window_width.floor();
    let window_height = window_height.floor();
    let x = bounds.x.round().min(window_width - 1.0);
    let y = bounds.y.round().min(window_height - 1.0);
    Ok(LogicalRect {
        position: LogicalPosition::new(x, y),
        size: LogicalSize::new(
            bounds.width.round().max(1.0).min(window_width - x),
            bounds.height.round().max(1.0).min(window_height - y),
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_browser_bounds, require_browser_url, BrowserHistory, BrowserPanelBounds,
        MAX_HISTORY_ENTRIES,
    };

    #[test]
    fn accepts_only_http_and_https_urls() {
        assert_eq!(
            require_browser_url(" https://example.com/path ")
                .expect("https")
                .as_str(),
            "https://example.com/path"
        );
        assert!(require_browser_url("http://127.0.0.1:4170/page").is_ok());
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,test",
            "mailto:test@example.com",
            "not a url",
            "",
        ] {
            assert!(require_browser_url(url).is_err(), "accepted {url}");
        }
    }

    #[test]
    fn records_and_traverses_browser_history() {
        let mut history = BrowserHistory::default();
        history.record("https://example.com/one".to_string());
        history.record("https://example.com/two".to_string());
        assert!(history.can_go_back());
        assert!(!history.can_go_forward());
        assert_eq!(
            history.target(-1).as_deref(),
            Some("https://example.com/one")
        );
        history.record("https://example.com/one".to_string());
        assert!(!history.can_go_back());
        assert!(history.can_go_forward());
        assert_eq!(
            history.target(1).as_deref(),
            Some("https://example.com/two")
        );
    }

    #[test]
    fn a_new_navigation_truncates_forward_history() {
        let mut history = BrowserHistory::default();
        history.record("https://example.com/one".to_string());
        history.record("https://example.com/two".to_string());
        history.target(-1);
        history.record("https://example.com/one".to_string());
        history.record("https://example.com/three".to_string());
        assert!(!history.can_go_forward());
        assert_eq!(history.entries.len(), 2);
    }

    #[test]
    fn bounds_history_growth() {
        let mut history = BrowserHistory::default();
        for index in 0..MAX_HISTORY_ENTRIES + 5 {
            history.record(format!("https://example.com/{index}"));
        }
        assert_eq!(history.entries.len(), MAX_HISTORY_ENTRIES);
        assert_eq!(history.entries[0], "https://example.com/5");
    }

    #[test]
    fn normalizes_finite_bounds_to_the_window() {
        let valid = normalize_browser_bounds(
            BrowserPanelBounds {
                x: 640.4,
                y: 42.4,
                width: 519.8,
                height: 717.7,
            },
            1200.0,
            800.0,
        )
        .expect("valid bounds");
        assert_eq!(valid.position.x, 640.0);
        assert_eq!(valid.size.width, 520.0);
        let clamped = normalize_browser_bounds(
            BrowserPanelBounds {
                x: 900.0,
                y: 780.0,
                width: 400.0,
                height: 100.0,
            },
            1200.0,
            800.0,
        )
        .expect("clamped bounds");
        assert_eq!(clamped.size.width, 300.0);
        assert_eq!(clamped.size.height, 20.0);
        for bounds in [
            BrowserPanelBounds {
                x: -1.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            },
            BrowserPanelBounds {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 10.0,
            },
            BrowserPanelBounds {
                x: 1200.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            },
            BrowserPanelBounds {
                x: f64::NAN,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            },
        ] {
            assert!(normalize_browser_bounds(bounds, 1200.0, 800.0).is_err());
        }
    }
}
