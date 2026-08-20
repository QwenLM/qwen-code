fn main() {
    let windows = tauri_build::WindowsAttributes::new()
        .app_manifest(include_str!("windows-app-manifest.xml"));
    let app_manifest = tauri_build::AppManifest::new().commands(&[
        "bootstrap_state",
        "choose_workspace",
        "open_logs",
        "restart_runtime",
        "install_update",
        "computer_use_request_state",
        "computer_use_sync_session",
        "computer_use_stop",
        "computer_use_set_picture_in_picture_visible",
        "computer_use_set_always_hide_picture_in_picture",
        "browser_panel_open",
        "browser_panel_navigate",
        "browser_panel_set_bounds",
        "browser_panel_go_back",
        "browser_panel_go_forward",
        "browser_panel_reload",
        "browser_panel_open_external",
        "browser_panel_close",
        "desktop_set_theme",
    ]);
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(windows)
        .app_manifest(app_manifest);
    tauri_build::try_build(attributes).expect("failed to run Tauri build script");
}
