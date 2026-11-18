//! Native turn notifications posted by the macOS desktop host.
//!
//! WebKit never grants Web Notification permission to the embedded web shell
//! (no host hook exists in WKWebView/WKWebViewConfiguration — verified against
//! the macOS 26 runtime), so the desktop host posts the system notification
//! itself. The web shell triggers this over Tauri IPC when Web Notifications
//! are unavailable or denied.

use block2::RcBlock;
use objc2::runtime::Bool;
use objc2_foundation::{NSError, NSBundle, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationRequest,
    UNUserNotificationCenter,
};

/// The unbundled process `tauri dev` launches has no bundle identifier, and
/// `+[UNUserNotificationCenter currentNotificationCenter]` raises an
/// uncatchable `NSInternalInconsistencyException` there, so host posting is
/// attempted only from a bundled app; without an identifier it fails closed.
fn host_can_notify(bundle_identifier: Option<&str>) -> bool {
    bundle_identifier.is_some()
}

fn main_bundle_identifier() -> Option<String> {
    NSBundle::mainBundle()
        .bundleIdentifier()
        .map(|identifier| identifier.to_string())
}

/// Request system notification authorization. Called when the user turns
/// task notifications on; shows the OS prompt once and is ignored when the
/// user already decided.
pub fn request_authorization() {
    if !host_can_notify(main_bundle_identifier().as_deref()) {
        return;
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let handler: RcBlock<dyn Fn(Bool, *mut NSError)> =
        RcBlock::new(move |_granted: Bool, _error: *mut NSError| {});
    center.requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
        &handler,
    );
}

/// Post a single system notification. Fire-and-forget: failures are not
/// surfaced to the web shell.
pub fn show(title: &str, body: &str) {
    if !host_can_notify(main_bundle_identifier().as_deref()) {
        return;
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let identifier = NSString::from_str(&format!("qwen-turn-{nanos}"));
    // No trigger: deliver immediately.
    let request =
        UNNotificationRequest::requestWithIdentifier_content_trigger(&identifier, &content, None);
    center.addNotificationRequest_withCompletionHandler(&request, None);
}

#[cfg(test)]
mod tests {
    use super::host_can_notify;

    #[test]
    fn rejects_unbundled_processes() {
        assert!(!host_can_notify(None));
        assert!(host_can_notify(Some("org.qwencode.desktop")));
    }

    // The test binary is itself unbundled: with the guard in place both entry
    // points return before touching UNUserNotificationCenter; without it the
    // process aborts on the raised NSInternalInconsistencyException.
    #[test]
    fn unbundled_process_does_not_post() {
        super::request_authorization();
        super::show("title", "body");
    }
}
