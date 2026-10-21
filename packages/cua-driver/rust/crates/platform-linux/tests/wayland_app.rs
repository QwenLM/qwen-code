//! Explicitly run on an isolated headless Sway desktop, never the user's seat.
#![cfg(target_os = "linux")]
use serde_json::json;
use std::process::{Child, Command};
use std::time::{Duration, Instant};
struct Fixture(Child);
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires isolated Sway, native Wayland GTK3 and a session bus"]
async fn live_wayland_app_follows_compositor_focus() {
    let child = Command::new("/usr/bin/python3")
        .args([
            "-c",
            r#"
import gi
gi.require_version('Gtk','3.0')
from gi.repository import Gtk
windows=[]
for title in ['CUA first','CUA second']:
 w=Gtk.Window(title=title);w.add(Gtk.Entry());w.show_all();windows.append(w)
Gtk.main()
"#,
        ])
        .spawn()
        .unwrap();
    let fixture = Fixture(child);
    let deadline = Instant::now() + Duration::from_secs(10);
    let windows = loop {
        let windows = platform_linux::wayland::sway_ipc::list_windows()
            .unwrap_or_default()
            .into_iter()
            .filter(|w| w.pid == fixture.0.id())
            .collect::<Vec<_>>();
        if windows.len() == 2 {
            break windows;
        }
        assert!(Instant::now() < deadline, "two Wayland windows must appear");
        std::thread::sleep(Duration::from_millis(100));
    };
    let registry = platform_linux::tools::build_registry(false);
    for window in windows {
        let output = Command::new("swaymsg")
            .arg(format!("[con_id={}] focus", window.id))
            .output()
            .unwrap();
        assert!(output.status.success());
        let result = registry
            .invoke(
                "list_windows",
                json!({"pid":fixture.0.id(),"app_context":true,"on_screen_only":false}),
            )
            .await;
        assert_ne!(result.is_error, Some(true), "{result:?}");
        let state = result.structured_content.unwrap();
        let selected = state["windows"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|w| w["is_app_target"] == true)
            .collect::<Vec<_>>();
        assert_eq!(selected.len(), 1, "{state}");
        assert_eq!(selected[0]["window_id"], window.id, "{state}");
    }
    println!("App selection followed both native Sway windows in the same process");
}
