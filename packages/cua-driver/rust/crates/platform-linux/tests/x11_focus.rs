//! Run explicitly on Linux with Xvfb installed:
//! cargo test -p platform-linux --test x11_focus -- --ignored --nocapture --test-threads=1
//! Each case starts its own Xvfb and never connects to the caller's display.

#![cfg(target_os = "linux")]

use std::ffi::OsString;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use platform_linux::input::with_x11_foreground;
use x11::xlib;

struct IsolatedDisplay {
    child: Child,
    previous_display: Option<OsString>,
}

impl IsolatedDisplay {
    fn start() -> Self {
        let child = Command::new("Xvfb")
            .args([
                "-displayfd",
                "1",
                "-screen",
                "0",
                "800x600x24",
                "-nolisten",
                "tcp",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("Xvfb must be installed to run this ignored test");
        let mut server = Self {
            child,
            previous_display: std::env::var_os("DISPLAY"),
        };
        let stdout = server.child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut display = String::new();
            let result = BufReader::new(stdout).read_line(&mut display);
            let _ = tx.send(result.map(|_| display));
        });
        let display = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("Xvfb startup timed out")
            .expect("read Xvfb display number");
        assert!(!display.trim().is_empty(), "Xvfb exited before startup");
        std::env::set_var("DISPLAY", format!(":{}", display.trim()));
        server
    }
}

impl Drop for IsolatedDisplay {
    fn drop(&mut self) {
        if let Some(value) = &self.previous_display {
            std::env::set_var("DISPLAY", value);
        } else {
            std::env::remove_var("DISPLAY");
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

unsafe fn set_active(
    display: *mut xlib::Display,
    root: xlib::Window,
    atom: xlib::Atom,
    window: xlib::Window,
) {
    xlib::XChangeProperty(
        display,
        root,
        atom,
        xlib::XA_WINDOW,
        32,
        xlib::PropModeReplace,
        (&window as *const xlib::Window).cast(),
        1,
    );
    xlib::XSync(display, 0);
}

#[derive(Debug)]
struct Observation {
    scenario: &'static str,
    body_calls: usize,
    focus_was_child: bool,
    focus_after_is_child: bool,
    focus_after_is_new_child: bool,
    focus_after_is_other: bool,
    focus_after_is_other_child: bool,
    focus_after_is_sibling: bool,
    restore_elapsed_ms: Option<u128>,
    new_child_key_events: usize,
    child_key_events: usize,
    toplevel_key_events: usize,
    target_activation_requests: usize,
    elapsed_ms: u128,
    error: Option<String>,
}

fn observe(scenario: &'static str) -> Observation {
    let _server = IsolatedDisplay::start();
    let display = unsafe { xlib::XOpenDisplay(ptr::null()) };
    assert!(!display.is_null());
    let root = unsafe { xlib::XDefaultRootWindow(display) };
    let target = unsafe { xlib::XCreateSimpleWindow(display, root, 10, 10, 200, 120, 0, 0, 0) };
    let child = unsafe { xlib::XCreateSimpleWindow(display, target, 5, 5, 50, 40, 0, 0, 0) };
    let child_b = unsafe { xlib::XCreateSimpleWindow(display, target, 65, 5, 50, 40, 0, 0, 0) };
    let other = unsafe { xlib::XCreateSimpleWindow(display, root, 250, 10, 200, 120, 0, 0, 0) };
    let sibling = unsafe { xlib::XCreateSimpleWindow(display, root, 250, 160, 200, 120, 0, 0, 0) };
    let other_child = unsafe { xlib::XCreateSimpleWindow(display, other, 5, 5, 50, 40, 0, 0, 0) };
    unsafe {
        for window in [target, child, child_b, other, other_child, sibling] {
            xlib::XMapWindow(display, window);
            xlib::XSelectInput(display, window, xlib::KeyPressMask);
        }
        let pid_atom = xlib::XInternAtom(display, c"_NET_WM_PID".as_ptr(), xlib::False);
        for (window, pid) in [
            (target, 101 as xlib::Window),
            (
                sibling,
                if scenario == "foreign-focus" {
                    202
                } else {
                    101
                },
            ),
        ] {
            xlib::XChangeProperty(
                display,
                window,
                pid_atom,
                xlib::XA_CARDINAL,
                32,
                xlib::PropModeReplace,
                &pid as *const _ as *const u8,
                1,
            );
        }
        xlib::XSync(display, 0);
    }
    let initially_target = matches!(scenario, "child" | "body-error" | "child-move");
    unsafe {
        xlib::XSetInputFocus(
            display,
            if initially_target {
                child
            } else if scenario == "restore-other-child" {
                other_child
            } else {
                other
            },
            xlib::RevertToParent,
            xlib::CurrentTime,
        );
        xlib::XSync(display, 0);
    }
    let active_atom = if scenario == "missing-active" {
        0
    } else {
        unsafe { xlib::XInternAtom(display, c"_NET_ACTIVE_WINDOW".as_ptr(), 0) }
    };
    if active_atom != 0 {
        unsafe {
            set_active(
                display,
                root,
                active_atom,
                if initially_target { target } else { other },
            )
        };
    }
    let stop = Arc::new(AtomicBool::new(false));
    let requests = Arc::new(AtomicUsize::new(0));
    let (ready_tx, ready_rx) = mpsc::channel();
    let stop_wm = stop.clone();
    let wm_requests = requests.clone();
    // A minimal EWMH responder makes activation acceptance deterministic.
    // X focus and input delivery still use the real Xvfb/Xlib/XTest stack.
    let wm = std::thread::spawn(move || unsafe {
        let wm_display = xlib::XOpenDisplay(ptr::null());
        assert!(!wm_display.is_null());
        xlib::XSelectInput(wm_display, root, xlib::SubstructureNotifyMask);
        xlib::XSync(wm_display, 0);
        ready_tx.send(()).unwrap();
        while !stop_wm.load(Ordering::SeqCst) {
            while xlib::XPending(wm_display) > 0 {
                let mut event: xlib::XEvent = std::mem::zeroed();
                xlib::XNextEvent(wm_display, &mut event);
                if event.get_type() != xlib::ClientMessage {
                    continue;
                }
                let event = event.client_message;
                if event.message_type != active_atom {
                    continue;
                }
                if event.window != target {
                    if active_atom != 0 {
                        set_active(wm_display, root, active_atom, event.window);
                        xlib::XSetInputFocus(
                            wm_display,
                            event.window,
                            xlib::RevertToParent,
                            xlib::CurrentTime,
                        );
                        xlib::XSync(wm_display, 0);
                    }
                    continue;
                }
                let ordinal = wm_requests.fetch_add(1, Ordering::SeqCst) + 1;
                if scenario == "reject" || (scenario == "drop-first" && ordinal == 1) {
                    continue;
                }
                if scenario == "delay-first" && ordinal == 1 {
                    std::thread::sleep(Duration::from_millis(80));
                }
                if active_atom != 0 {
                    set_active(wm_display, root, active_atom, target);
                    xlib::XSetInputFocus(
                        wm_display,
                        target,
                        xlib::RevertToParent,
                        xlib::CurrentTime,
                    );
                    xlib::XSync(wm_display, 0);
                }
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        xlib::XCloseDisplay(wm_display);
    });
    ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let mut body_calls = 0;
    let mut focus_in_body = 0;
    let started = Instant::now();
    let mut outcome: anyhow::Result<()> = Ok(());
    let mut focus_after = 0;
    let mut body_finished_at = None;
    let mut restore_elapsed_ms = None;
    for _ in 0..if scenario == "child" { 2 } else { 1 } {
        outcome = with_x11_foreground(target as u64, 80, || {
            body_calls += 1;
            if scenario == "child-move" {
                unsafe {
                    xlib::XSetInputFocus(display, child_b, xlib::RevertToParent, xlib::CurrentTime);
                    xlib::XSync(display, 0);
                }
            }
            let mut revert = 0;
            unsafe {
                xlib::XGetInputFocus(display, &mut focus_in_body, &mut revert);
                let keycode = xlib::XKeysymToKeycode(display, 0x61);
                x11::xtest::XTestFakeKeyEvent(display, keycode as u32, xlib::True, 0);
                x11::xtest::XTestFakeKeyEvent(display, keycode as u32, xlib::False, 0);
                xlib::XSync(display, 0);
            }
            if matches!(scenario, "sibling-focus" | "foreign-focus") {
                unsafe {
                    set_active(display, root, active_atom, sibling);
                    xlib::XSetInputFocus(display, sibling, xlib::RevertToParent, xlib::CurrentTime);
                    xlib::XSync(display, 0);
                }
            }
            body_finished_at = Some(Instant::now());
            if scenario == "body-error" {
                anyhow::bail!("fixture body error");
            }
            Ok(())
        });
        restore_elapsed_ms = body_finished_at.map(|finished| finished.elapsed().as_millis());
        std::thread::sleep(Duration::from_millis(30));
        let mut revert = 0;
        unsafe {
            xlib::XGetInputFocus(display, &mut focus_after, &mut revert);
        }
    }
    let elapsed_ms = started.elapsed().as_millis();
    std::thread::sleep(Duration::from_millis(15));
    stop.store(true, Ordering::SeqCst);
    wm.join().unwrap();
    let mut child_key_events = 0;
    let mut new_child_key_events = 0;
    let mut toplevel_key_events = 0;
    unsafe {
        while xlib::XPending(display) > 0 {
            let mut event: xlib::XEvent = std::mem::zeroed();
            xlib::XNextEvent(display, &mut event);
            if event.get_type() == xlib::KeyPress {
                if event.key.window == child {
                    child_key_events += 1;
                }
                if event.key.window == child_b {
                    new_child_key_events += 1;
                }
                if event.key.window == target {
                    toplevel_key_events += 1;
                }
            }
        }
        xlib::XCloseDisplay(display);
    }
    Observation {
        scenario,
        body_calls,
        focus_was_child: focus_in_body == child,
        focus_after_is_child: focus_after == child,
        focus_after_is_new_child: focus_after == child_b,
        focus_after_is_other: focus_after == other,
        focus_after_is_other_child: focus_after == other_child,
        focus_after_is_sibling: focus_after == sibling,
        restore_elapsed_ms,
        new_child_key_events,
        child_key_events,
        toplevel_key_events,
        target_activation_requests: requests.load(Ordering::SeqCst),
        elapsed_ms,
        error: outcome.err().map(|error| error.to_string()),
    }
}

#[test]
#[ignore = "requires Xvfb; starts isolated displays and sends real XTest keys"]
fn x11_foreground_preserves_child_focus_and_bounds_activation_recovery() {
    unsafe { xlib::XInitThreads() };
    for scenario in [
        "child",
        "child-move",
        "restore-other-child",
        "drop-first",
        "delay-first",
        "reject",
        "body-error",
        "missing-active",
        "sibling-focus",
        "foreign-focus",
    ] {
        let observation = observe(scenario);
        println!("{observation:?}");
        assert_eq!(observation.scenario, scenario);
        if matches!(scenario, "reject" | "missing-active") {
            assert_eq!(observation.body_calls, 0);
            assert_eq!(
                observation.child_key_events
                    + observation.new_child_key_events
                    + observation.toplevel_key_events,
                0
            );
            assert!(observation
                .error
                .as_deref()
                .unwrap()
                .contains("no input was sent"));
            // Allow scheduler variance while detecting an accidentally unbounded retry.
            assert!(observation.elapsed_ms < 1500);
        } else {
            let expected = if scenario == "child" { 2 } else { 1 };
            assert_eq!(observation.body_calls, expected);
            assert_eq!(
                observation.child_key_events
                    + observation.new_child_key_events
                    + observation.toplevel_key_events,
                expected
            );
            if matches!(scenario, "child" | "body-error") {
                assert!(observation.focus_was_child);
                assert_eq!(observation.child_key_events, expected);
                assert!(observation.focus_after_is_child);
            }
            if scenario == "child-move" {
                assert_eq!(observation.new_child_key_events, 1);
                assert!(observation.focus_after_is_new_child);
            }
            if scenario == "body-error" {
                assert_eq!(observation.error.as_deref(), Some("fixture body error"));
            } else if scenario == "sibling-focus" {
                assert!(observation
                    .error
                    .as_deref()
                    .unwrap()
                    .contains("focus_restore_unconfirmed"));
            } else {
                assert!(observation.error.is_none());
            }
        }
        if !matches!(
            scenario,
            "child"
                | "child-move"
                | "body-error"
                | "restore-other-child"
                | "sibling-focus"
                | "foreign-focus"
        ) {
            assert!(observation.focus_after_is_other);
        }
        if matches!(scenario, "sibling-focus" | "foreign-focus") {
            assert!(observation.focus_after_is_sibling);
        }
        if scenario == "restore-other-child" {
            assert!(observation.focus_after_is_other_child);
            assert!(observation.restore_elapsed_ms.unwrap() < 500);
        }
        if scenario == "drop-first" {
            assert_eq!(observation.target_activation_requests, 2);
        }
        if scenario == "reject" {
            assert_eq!(observation.target_activation_requests, 2);
        }
    }
}
