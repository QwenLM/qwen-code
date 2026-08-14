fn main() {
    let windows = tauri_build::WindowsAttributes::new()
        .app_manifest(include_str!("windows-app-manifest.xml"));
    let app_manifest = tauri_build::AppManifest::new().commands(&[
        "bootstrap_state",
        "choose_workspace",
        "restart_runtime",
        "local_control_status",
        "enable_local_control",
        "disable_local_control",
        "open_logs",
        "install_update",
        "desktop_host_settings",
        "set_desktop_host_setting",
        "report_pet_streaming_state",
        "report_pet_session_change",
        "pet_bootstrap",
        "start_pet_dragging",
        "close_desktop_pet",
    ]);
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(windows)
        .app_manifest(app_manifest);
    tauri_build::try_build(attributes).expect("failed to run Tauri build script");
}
