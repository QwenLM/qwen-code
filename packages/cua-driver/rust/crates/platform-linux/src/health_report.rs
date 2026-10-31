//! Linux `health_report` provider.
//!
//! Implements [`cua_driver_core::health_report::HealthCheckProvider`]
//! for Linux. Reuses the same probes the Linux `check_permissions`
//! tool runs — X11 connectivity for AX (driven via XSendEvent +
//! AT-SPI) and X11 again for the screen capture path.
//!
//! The TCC / bundle checks emit `status: "skip"` with `message: "not
//! applicable on Linux"`; Linux has no TCC.

use async_trait::async_trait;
use cua_driver_core::health_report::{
    CheckData, CheckEntry, HealthCheckProvider, NAME_AX_CAPABILITY, NAME_BINARY_VERSION,
    NAME_BUNDLE_IDENTITY, NAME_PLATFORM_SUPPORTED, NAME_SCREEN_CAPTURE_CAPABILITY,
    NAME_SESSION_ACTIVE, NAME_TCC_ACCESSIBILITY, NAME_TCC_SCREEN_RECORDING,
};

/// Linux canonical check names — same Swift-PR contract, with TCC /
/// bundle entries surfaced as `skip("not applicable on Linux")`. The
/// full set of entries always appears so cross-platform consumers see
/// a complete check map.
pub const LINUX_CHECK_NAMES: &[&str] = &[
    NAME_BINARY_VERSION,
    NAME_PLATFORM_SUPPORTED,
    NAME_SESSION_ACTIVE,
    NAME_BUNDLE_IDENTITY,
    NAME_TCC_ACCESSIBILITY,
    NAME_TCC_SCREEN_RECORDING,
    NAME_AX_CAPABILITY,
    NAME_SCREEN_CAPTURE_CAPABILITY,
];

pub struct LinuxHealthProvider;

#[async_trait]
impl HealthCheckProvider for LinuxHealthProvider {
    fn platform(&self) -> &'static str {
        "linux"
    }

    fn check_names(&self) -> &'static [&'static str] {
        LINUX_CHECK_NAMES
    }

    async fn run_check(&self, name: &str) -> CheckEntry {
        match name {
            NAME_BINARY_VERSION => check_binary_version(),
            NAME_PLATFORM_SUPPORTED => check_platform_supported(),
            NAME_SESSION_ACTIVE => check_session_active(),
            NAME_BUNDLE_IDENTITY => skip_not_applicable(NAME_BUNDLE_IDENTITY),
            NAME_TCC_ACCESSIBILITY => skip_not_applicable(NAME_TCC_ACCESSIBILITY),
            NAME_TCC_SCREEN_RECORDING => skip_not_applicable(NAME_TCC_SCREEN_RECORDING),
            NAME_AX_CAPABILITY => check_ax_capability().await,
            NAME_SCREEN_CAPTURE_CAPABILITY => check_screen_capture_capability().await,
            other => CheckEntry::skip(
                other.to_owned(),
                "Unknown check name (not implemented on this platform).",
            ),
        }
    }
}

// ── Individual checks ────────────────────────────────────────────────────────

pub(crate) fn check_binary_version() -> CheckEntry {
    CheckEntry::pass(
        NAME_BINARY_VERSION,
        format!("cua-driver {}", env!("CARGO_PKG_VERSION")),
    )
}

pub(crate) fn check_platform_supported() -> CheckEntry {
    let arch = arch_label();
    let os_version = os_release_pretty_name().unwrap_or_else(|| "Linux".to_owned());
    CheckEntry::pass(NAME_PLATFORM_SUPPORTED, format!("{os_version} ({arch})")).with_data(
        CheckData {
            os_version: Some(os_version),
            architecture: Some(arch.to_owned()),
            ..Default::default()
        },
    )
}

pub(crate) fn check_session_active() -> CheckEntry {
    CheckEntry::pass(NAME_SESSION_ACTIVE, "MCP session is active.")
}

fn skip_not_applicable(name: &str) -> CheckEntry {
    CheckEntry::skip(name.to_owned(), "not applicable on Linux".to_owned())
}

async fn check_ax_capability() -> CheckEntry {
    // Mirror the existing `check_permissions` Linux probe: X11
    // connectivity is the AX prerequisite (AT-SPI is over D-Bus, but
    // input/readback need an X server). Cheap and side-effect-free.
    let x11_ok = tokio::task::spawn_blocking(probe_x11_connect)
        .await
        .unwrap_or(false);
    if x11_ok {
        // X11 input works, but AT-SPI *inspection* (get_window_state) also needs
        // org.a11y.Bus on the session bus. Probe it so we don't claim AX works
        // when the tree would come back empty — the DBUS_SESSION_BUS_ADDRESS-
        // unset / a11y-bridge-off case the daemon now auto-recovers at startup.
        let a11y_ok = tokio::task::spawn_blocking(probe_a11y_bus)
            .await
            .unwrap_or(false);
        if a11y_ok {
            return CheckEntry::pass(
                NAME_AX_CAPABILITY,
                "X11 reachable and org.a11y.Bus is on the session bus; \
                 AT-SPI inspection + XSendEvent input will work.",
            );
        }
        let hint = if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some() {
            "DBUS_SESSION_BUS_ADDRESS is set but org.a11y.Bus has no owner — enable \
             accessibility (`gsettings set org.gnome.desktop.interface \
             toolkit-accessibility true`) and/or start the AT-SPI bus \
             (`/usr/libexec/at-spi-bus-launcher`)."
        } else {
            "DBUS_SESSION_BUS_ADDRESS is unset and none was auto-discovered, so there \
             is no session bus to reach AT-SPI on — start the daemon inside the desktop \
             session, or ensure a /run/user/<uid>/bus socket exists (the daemon adopts \
             it at startup)."
        };
        return CheckEntry::fail(
            NAME_AX_CAPABILITY,
            "X11 is reachable but AT-SPI (org.a11y.Bus) is not — UI inspection \
             (get_window_state) will return empty trees; X11 input injection still works.",
            hint,
        );
    }
    let display_set = std::env::var_os("DISPLAY").is_some();
    let xauth_unset = std::env::var_os("XAUTHORITY").is_none();
    let hint = if display_set && xauth_unset {
        // SSH-driven Wayland+Xwayland: DISPLAY inherited but no auth cookie (#1926).
        "DISPLAY is set but XAUTHORITY is not (typical when driving a \
         Wayland+Xwayland session over SSH): the X server's per-session auth \
         cookie isn't discoverable, so X11 connects fail 'Authorization required'. \
         Point XAUTHORITY at the Xwayland '-auth' cookie file, or restart the \
         cua-driver daemon — it auto-discovers the cookie from /proc at startup."
    } else {
        "Only X11 is supported. Set DISPLAY and XAUTHORITY for the target X server, including XWayland."
    };
    CheckEntry::fail(
        NAME_AX_CAPABILITY,
        "X11 is not reachable; UI inspection and event injection will fail.",
        hint,
    )
}

async fn check_screen_capture_capability() -> CheckEntry {
    // On Linux the canonical capture path is X11 GetImage / xwd / scrot
    // — all require an open X11 connection. The probe is the same one
    // we use for ax_capability, but the consumer-facing message and
    // hint differ so future drift between the two doesn't break either
    // contract.
    let x11_ok = tokio::task::spawn_blocking(probe_x11_connect)
        .await
        .unwrap_or(false);
    if x11_ok {
        return CheckEntry::pass(
            NAME_SCREEN_CAPTURE_CAPABILITY,
            "X11 reachable; screen capture path is functional.",
        );
    }
    let hint = "Only X11 is supported. Set DISPLAY and XAUTHORITY for capture.";
    CheckEntry::fail(
        NAME_SCREEN_CAPTURE_CAPABILITY,
        "X11 is not reachable; screen capture will fail.",
        hint,
    )
}

// ── Probes ───────────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn probe_x11_connect() -> bool {
    x11rb::rust_connection::RustConnection::connect(None).is_ok()
}

#[cfg(not(target_os = "linux"))]
fn probe_x11_connect() -> bool {
    false
}

/// Probe whether `org.a11y.Bus` is reachable on the session bus — the
/// canonical AT-SPI prerequisite. Returns false on any error (no session bus, no a11y service,
/// timeout, etc.) so the doctor message stays simple.
#[cfg(target_os = "linux")]
pub(crate) fn probe_a11y_bus() -> bool {
    use atspi::zbus;
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(_) => return false,
    };
    rt.block_on(async {
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            let bus = match zbus::Connection::session().await {
                Ok(b) => b,
                Err(_) => return false,
            };
            let proxy = match zbus::fdo::DBusProxy::new(&bus).await {
                Ok(p) => p,
                Err(_) => return false,
            };
            // `name_has_owner` is the cheap direct existence check — avoids
            // pulling the entire session-bus name registry just to look up one
            // entry.
            let bus_name = match "org.a11y.Bus".try_into() {
                Ok(n) => n,
                Err(_) => return false,
            };
            proxy.name_has_owner(bus_name).await.unwrap_or(false)
        })
        .await
        .unwrap_or(false)
    })
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn probe_a11y_bus() -> bool {
    false
}

/// PRETTY_NAME from /etc/os-release; callers fall back to Linux.
fn os_release_pretty_name() -> Option<String> {
    let s = std::fs::read_to_string("/etc/os-release").ok()?;
    for line in s.lines() {
        if let Some(rest) = line.strip_prefix("PRETTY_NAME=") {
            let v = rest.trim_matches('"').to_owned();
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    None
}

fn arch_label() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        other => other,
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use cua_driver_core::health_report::{CheckStatus, HealthReportTool};
    use cua_driver_core::tool::Tool;
    use std::sync::Arc;

    #[test]
    fn binary_version_always_passes() {
        let entry = check_binary_version();
        assert_eq!(entry.status, CheckStatus::Pass);
        assert!(entry.message.contains("cua-driver "));
    }

    #[test]
    fn session_active_passes() {
        let entry = check_session_active();
        assert_eq!(entry.status, CheckStatus::Pass);
    }

    #[test]
    fn tcc_and_bundle_are_skipped_with_canonical_message() {
        for name in [
            NAME_TCC_ACCESSIBILITY,
            NAME_TCC_SCREEN_RECORDING,
            NAME_BUNDLE_IDENTITY,
        ] {
            let entry = skip_not_applicable(name);
            assert_eq!(entry.status, CheckStatus::Skip, "{name} must be skipped");
            assert_eq!(entry.message, "not applicable on Linux");
        }
    }

    #[tokio::test]
    async fn invoke_full_run_produces_linux_check_set() {
        let provider = Arc::new(LinuxHealthProvider);
        let tool = HealthReportTool::new(provider);
        let result = tool.invoke(serde_json::json!({})).await;
        assert!(
            result.is_error.is_none(),
            "health_report must never set isError"
        );
        let structured = result.structured_content.expect("structured payload");
        assert_eq!(structured["platform"], "linux");
        assert_eq!(structured["schema_version"], "1");
        let names: Vec<&str> = structured["checks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["name"].as_str().unwrap())
            .collect();
        let expected: Vec<&str> = LINUX_CHECK_NAMES.to_vec();
        assert_eq!(names, expected);

        let by_name: std::collections::HashMap<_, _> = structured["checks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| (c["name"].as_str().unwrap(), c))
            .collect();
        for name in [
            NAME_TCC_ACCESSIBILITY,
            NAME_TCC_SCREEN_RECORDING,
            NAME_BUNDLE_IDENTITY,
        ] {
            let entry = by_name[name];
            assert_eq!(entry["status"], "skip", "{name} must be skipped on Linux");
            assert_eq!(entry["message"], "not applicable on Linux");
        }
    }
}
