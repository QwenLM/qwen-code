#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod runtime;

use runtime::DesktopRuntime;
use tauri::webview::{NewWindowResponse, WebviewWindowBuilder};
use tauri::{Manager, RunEvent, WebviewUrl};
use url::Url;

fn main() {
    let app = match tauri::Builder::default().build(tauri::generate_context!()) {
        Ok(app) => app,
        Err(error) => {
            eprintln!("Failed to initialize Qwen Code desktop: {error}");
            return;
        }
    };
    let handle = app.handle().clone();
    let runtime = match DesktopRuntime::start(&handle) {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("Failed to start Qwen Code desktop runtime:\n{error}");
            return;
        }
    };
    let origin = match origin_of(&runtime.base_url) {
        Ok(origin) => origin,
        Err(error) => {
            eprintln!("Failed to validate Qwen Code desktop URL: {error}");
            return;
        }
    };
    let web_url = runtime.web_url();
    let navigation_origin = origin.clone();
    let main_window = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(web_url))
        .title("Qwen Code")
        .inner_size(1280.0, 820.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .on_navigation(move |url| is_same_origin(url, &navigation_origin))
        .on_new_window(|url, _features| {
            if is_safe_external_url(&url) {
                let _ = open::that_detached(url.as_str());
            }
            NewWindowResponse::Deny
        })
        .build();
    if let Err(error) = main_window {
        eprintln!("Failed to create Qwen Code desktop window: {error}");
        return;
    }
    handle.manage(runtime);
    app.run(move |app_handle, event| match event {
        RunEvent::Exit | RunEvent::ExitRequested { .. } => {
            if let Some(runtime) = app_handle.try_state::<DesktopRuntime>() {
                runtime.stop();
            }
        }
        _ => {}
    });
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

fn is_safe_external_url(url: &Url) -> bool {
    matches!(url.scheme(), "https" | "http" | "mailto")
}

#[cfg(test)]
mod tests {
    use super::{is_safe_external_url, is_same_origin, origin_of};
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
    }
}
