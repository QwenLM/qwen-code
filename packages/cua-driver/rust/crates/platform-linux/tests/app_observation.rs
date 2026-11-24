//! Run under an isolated X11 desktop with GTK3/AT-SPI and a window manager.
#![cfg(target_os = "linux")]
use serde_json::{json, Value};
use std::process::{Child, Command};
use std::time::{Duration, Instant};

struct Fixture {
    child: Child,
    state: std::path::PathBuf,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.state);
    }
}
impl Fixture {
    fn start(name: &str) -> Self {
        let state =
            std::env::temp_dir().join(format!("cua-review-{}-{name}.txt", std::process::id()));
        let child = Command::new("/usr/bin/python3").arg("-c").arg(r#"
import gi,sys
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk
window=Gtk.Window(title=sys.argv[1]);window.set_default_size(320,240)
box=Gtk.Box(orientation=Gtk.Orientation.VERTICAL);window.add(box)
entry=Gtk.Entry();entry.set_text('before');entry.connect('changed',lambda e:open(sys.argv[2],'w').write(e.get_text()));box.pack_start(entry,False,False,0)
for n in range(10): box.pack_start(Gtk.Button(label='Button '+str(n)),False,False,0)
window.show_all();Gtk.main()"#).arg(name).arg(&state).spawn().unwrap();
        Self { child, state }
    }
    fn window(&self) -> u64 {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(w) = platform_linux::x11::list_windows(Some(self.child.id())).first() {
                return w.xid;
            }
            assert!(Instant::now() < deadline, "GTK window unavailable");
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

async fn call(
    registry: &cua_driver_core::tool::ToolRegistry,
    name: &str,
    mut args: Value,
) -> cua_driver_core::protocol::ToolResult {
    args["_transport_session_id"] = json!("app-observation-fixture");
    registry.invoke_from_trusted_adapter(name, args).await
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires isolated X11, openbox, dbus-run-session, GTK3 and AT-SPI"]
async fn live_app_bounded_ids_and_minimized_observation() {
    use cua_driver_core::observation_revision::{
        ACCESSIBILITY_SERIALIZER_VERSION, APP_ACCESSIBILITY_PROJECTION_VERSION,
    };
    let fixture = Fixture::start("CUA review target");
    let xid = fixture.window();
    let prior = Fixture::start("CUA review prior");
    let prior_xid = prior.window();
    std::thread::sleep(Duration::from_millis(500));
    let registry = platform_linux::tools::build_registry(false);
    let mut args = json!({"pid":fixture.child.id(),"window_id":xid,"app_context":true,"max_elements":3,"include_screenshot":true,
        "observation_revision":{"version":1,"serializer_version":ACCESSIBILITY_SERIALIZER_VERSION,"projection_version":APP_ACCESSIBILITY_PROJECTION_VERSION}});
    let result = call(&registry, "get_window_state", args.clone()).await;
    assert!(result.is_error != Some(true), "{result:?}");
    let data = result.structured_content.unwrap();
    assert_eq!(data["capture_truncated"], true, "{data}");
    let elements = data["elements"].as_array().unwrap();
    let entry = elements
        .iter()
        .find(|e| {
            e["role"]
                .as_str()
                .is_some_and(|r| r.to_lowercase().contains("text"))
        })
        .expect("captured entry");
    assert!(entry["element_id"].is_number(), "{entry}");
    let token = entry["element_token"].as_str().unwrap();
    let outcome = call(
        &registry,
        "set_value",
        json!({"pid":fixture.child.id(),"window_id":xid,"element_token":token,"value":"after"}),
    )
    .await;
    assert!(outcome.is_error != Some(true), "{outcome:?}");
    assert_eq!(std::fs::read_to_string(&fixture.state).unwrap(), "after");
    unsafe {
        let display = x11::xlib::XOpenDisplay(std::ptr::null());
        assert!(!display.is_null());
        x11::xlib::XIconifyWindow(display, xid as _, 0);
        x11::xlib::XSync(display, 0);
        x11::xlib::XCloseDisplay(display);
    }
    std::thread::sleep(Duration::from_millis(300));
    assert!(!platform_linux::x11::list_windows(Some(fixture.child.id()))[0].is_on_screen);
    let windows = call(
        &registry,
        "list_windows",
        json!({"pid":fixture.child.id(),"app_context":true,"on_screen_only":false}),
    )
    .await;
    assert!(windows.is_error != Some(true), "{windows:?}");
    assert!(windows.structured_content.unwrap()["windows"]
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w["is_app_target"] == Value::Bool(true)));
    assert_eq!(
        active_window(),
        prior_xid,
        "fixture owns the prior foreground"
    );
    args["max_elements"] = json!(100);
    let result = call(&registry, "get_window_state", args).await;
    assert!(result.is_error != Some(true), "{result:?}");
    assert!(platform_linux::x11::list_windows(Some(fixture.child.id()))[0].is_on_screen);
    assert!(
        result
            .content
            .iter()
            .any(|item| matches!(item, cua_driver_core::protocol::Content::Image { .. })),
        "screenshot must be returned"
    );
    assert_eq!(
        active_window(),
        prior_xid,
        "observation restores prior foreground"
    );
    println!("bounded native token updated GTK text; minimized App returned a screenshot and restored focus");
}

fn active_window() -> u64 {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{AtomEnum, ConnectionExt};
    let (conn, screen) = x11rb::connect(None).unwrap();
    let atom = conn
        .intern_atom(false, b"_NET_ACTIVE_WINDOW")
        .unwrap()
        .reply()
        .unwrap()
        .atom;
    conn.get_property(
        false,
        conn.setup().roots[screen].root,
        atom,
        AtomEnum::WINDOW,
        0,
        1,
    )
    .unwrap()
    .reply()
    .unwrap()
    .value32()
    .unwrap()
    .next()
    .unwrap() as u64
}
