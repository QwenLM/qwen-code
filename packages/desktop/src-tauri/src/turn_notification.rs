//! Native turn notifications posted by the macOS desktop host.
//!
//! WebKit never grants Web Notification permission to the embedded web shell
//! (no host hook exists in WKWebView/WKWebViewConfiguration — verified against
//! the macOS 26 runtime), so the desktop host posts the system notification
//! itself. The web shell triggers this over Tauri IPC when Web Notifications
//! are unavailable or denied.

use block2::RcBlock;
use objc2::runtime::Bool;
use objc2_foundation::{NSError, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationRequest,
    UNTimeIntervalNotificationTrigger, UNUserNotificationCenter,
};

/// Request system notification authorization. Shows the OS prompt once;
/// ignored when the user already decided.
pub fn request_authorization() {
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
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    let trigger =
        UNTimeIntervalNotificationTrigger::triggerWithTimeInterval_repeats(1.0, false);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let identifier = NSString::from_str(&format!("qwen-turn-{nanos}"));
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &identifier,
        &content,
        Some(&trigger),
    );
    center.addNotificationRequest_withCompletionHandler(&request, None);
}
