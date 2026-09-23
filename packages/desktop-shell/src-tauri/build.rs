// Every command the shell registers, listed so the build generates the
// allow-*/deny-* permissions the capability files grant. Without an app ACL
// manifest, Tauri only lets a local page call app commands, and the
// daemon-served Web Shell is a remote origin.
const COMMANDS: &[&str] = &[
    "bootstrap_state",
    "change_zoom",
    "choose_workspace",
    "install_update",
    "open_logs",
    "restart_runtime",
];

fn main() {
    let windows = tauri_build::WindowsAttributes::new()
        .app_manifest(include_str!("windows-app-manifest.xml"));
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(windows)
        .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    tauri_build::try_build(attributes).expect("failed to run Tauri build script");
}
