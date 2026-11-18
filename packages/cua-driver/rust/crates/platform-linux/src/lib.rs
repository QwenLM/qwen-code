//! Linux platform backend for cua-driver-rs.
//!
//! Background automation on Linux via:
//! - /proc filesystem for process enumeration
//! - X11 _NET_CLIENT_LIST for window enumeration
//! - X11 XSendEvent for background mouse/keyboard injection (no focus steal)
//! - AT-SPI D-Bus protocol for accessibility tree (via subprocess bridge)
//! - xwd/scrot/import for window screenshots
//!
//! Only X11 is supported, including X11 applications running under XWayland.

use cua_driver_core::tool::ToolRegistry;

pub mod health_report;
pub mod overlay;
pub mod pip;
pub mod tools;

#[cfg(target_os = "linux")]
pub mod x11;

#[cfg(any(target_os = "linux", test))]
mod x11_client_pid;

#[cfg(target_os = "linux")]
pub mod input;

#[cfg(target_os = "linux")]
pub mod tty;

#[cfg(target_os = "linux")]
pub mod proc_fs;

#[cfg(target_os = "linux")]
pub mod browser_platform;

#[cfg(target_os = "linux")]
mod browser_setup_ui;

#[cfg(target_os = "linux")]
mod browser_consent_ui;

#[cfg(target_os = "linux")]
pub mod installed_apps;

#[cfg(target_os = "linux")]
pub mod capture;
#[cfg(target_os = "linux")]
mod clipboard;

#[cfg(target_os = "linux")]
pub mod atspi;

#[cfg(target_os = "linux")]
pub mod a11y;

#[cfg(target_os = "linux")]
pub mod recording_hooks;

// `terminal` is OS-independent (pure string matching + a thin x11 hook).
// Keeping it un-gated lets the unit tests run on any host.
pub mod terminal;

#[cfg(target_os = "linux")]
pub mod xauth;

#[cfg(target_os = "linux")]
pub mod session_bus;

/// Pure WSL-detection predicate, split out from [`is_wsl`] so both branches
/// are unit-testable without the process-global env / `OnceLock` cache.
/// `wsl_env` mirrors `$WSL_DISTRO_NAME`/`$WSL_INTEROP` being set; `osrelease`
/// is the `/proc/sys/kernel/osrelease` contents.
fn detect_wsl(wsl_env_set: bool, osrelease: Option<&str>) -> bool {
    if wsl_env_set {
        return true;
    }
    osrelease
        .map(|s| {
            let s = s.to_ascii_lowercase();
            s.contains("microsoft") || s.contains("wsl")
        })
        .unwrap_or(false)
}

/// True when this process is running under WSL (Windows Subsystem for Linux).
/// WSL leaks its identity through the kernel release string ("microsoft" /
/// "WSL") and `/proc/sys/kernel/osrelease`. Cheap, side-effect-free, cached
/// after the first probe.
pub fn is_wsl() -> bool {
    use std::sync::OnceLock;
    static IS_WSL: OnceLock<bool> = OnceLock::new();
    *IS_WSL.get_or_init(|| {
        let env_set = std::env::var_os("WSL_DISTRO_NAME").is_some()
            || std::env::var_os("WSL_INTEROP").is_some();
        let osrelease = std::fs::read_to_string("/proc/sys/kernel/osrelease").ok();
        detect_wsl(env_set, osrelease.as_deref())
    })
}

/// Actionable display diagnostic shared by capture and input failures.
pub fn no_display_hint() -> String {
    if std::env::var_os("DISPLAY").is_none() {
        " — only X11 is supported. Set DISPLAY and XAUTHORITY for an X server or run the target application under XWayland.".to_owned()
    } else if is_wsl() {
        " — connect to the WSLg X11 display or an external X server and verify XAUTHORITY."
            .to_owned()
    } else {
        String::new()
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn require_x11() -> anyhow::Result<()> {
    if std::env::var_os("DISPLAY").is_none_or(|display| display.is_empty()) {
        anyhow::bail!(
            "only X11 is supported. Set DISPLAY and XAUTHORITY, including when using XWayland."
        );
    }
    Ok(())
}

pub fn register_tools() -> ToolRegistry {
    tools::build_registry(false)
}

/// `compat=true` enables Claude Code computer-use compatibility mode:
/// the regular `screenshot` tool is replaced by a window-scoped variant
/// (pid + window_id required, JPEG @ 85%, text note pointing at pixel
/// tools). See `tools::impl_::ScreenshotCompatTool`.
pub fn register_tools_with_cursor(cfg: cursor_overlay::CursorConfig, compat: bool) -> ToolRegistry {
    register_tools_with_cursor_and_provider(None, cfg, compat)
}

pub fn register_tools_with_cursor_and_provider(
    provider: Option<std::sync::Arc<dyn cua_driver_core::consent::ProtectedConsentProvider>>,
    cfg: cursor_overlay::CursorConfig,
    compat: bool,
) -> ToolRegistry {
    if cfg.enabled {
        overlay::init(cfg.clone());
        overlay::run_on_thread();
    }
    tools::build_registry_with_provider(compat, provider)
}

#[cfg(test)]
mod display_detection_tests {
    use super::detect_wsl;

    #[test]
    fn wsl_env_var_short_circuits() {
        // $WSL_DISTRO_NAME / $WSL_INTEROP present → WSL regardless of osrelease.
        assert!(detect_wsl(true, None));
        assert!(detect_wsl(true, Some("6.1.0-generic")));
    }

    #[test]
    fn wsl2_osrelease_microsoft_tag_detected() {
        // Real WSL2 kernel release string (verified live on a WSL2 box).
        assert!(detect_wsl(false, Some("6.18.33.1-microsoft-standard-WSL2")));
    }

    #[test]
    fn wsl1_osrelease_microsoft_tag_detected() {
        // WSL1 kernels also carry the Microsoft tag, mixed-case.
        assert!(detect_wsl(false, Some("4.4.0-19041-Microsoft")));
    }

    #[test]
    fn plain_linux_is_not_wsl() {
        assert!(!detect_wsl(false, Some("6.8.0-39-generic")));
        assert!(!detect_wsl(false, None));
    }
}

#[cfg(all(test, target_os = "linux"))]
pub(crate) mod test_env {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    pub(crate) struct DisplayOverride(
        Option<std::ffi::OsString>,
        std::sync::MutexGuard<'static, ()>,
    );
    pub(crate) fn unreachable_x11_display() -> DisplayOverride {
        let lock = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let prior = std::env::var_os("DISPLAY");
        std::env::set_var("DISPLAY", ":9999999");
        DisplayOverride(prior, lock)
    }
    impl Drop for DisplayOverride {
        fn drop(&mut self) {
            match self.0.take() {
                Some(prior) => std::env::set_var("DISPLAY", prior),
                None => std::env::remove_var("DISPLAY"),
            }
        }
    }
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod at_point_policy;
