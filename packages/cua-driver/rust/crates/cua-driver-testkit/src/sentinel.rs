//! Full-desktop foreground sentinel used by background E2E cells.

use std::fs;
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::e2e::OracleKind;
use crate::observer::{DesktopObserver, NativeObserver, TargetWindow};
use crate::{harness_app, spawn_in_job, BehaviorRecording, ChildReaper, Driver};

/// A foreground Electron window that journals focus and leaked input while it
/// fully occludes the background target.
pub struct ForegroundSentinel {
    journal_path: std::path::PathBuf,
    target: TargetWindow,
    _reaper: ChildReaper,
    _user_data: tempfile::TempDir,
}

impl ForegroundSentinel {
    pub fn launch(driver: &mut impl Driver) -> Self {
        let mut last_error = None;
        for attempt in 1..=2 {
            match Self::try_launch(driver) {
                Ok(sentinel) => return sentinel,
                Err(error) => {
                    eprintln!(
                        "[testkit] foreground sentinel launch attempt {attempt}/2 failed: {error}"
                    );
                    last_error = Some(error);
                    if attempt < 2 {
                        std::thread::sleep(Duration::from_millis(300));
                    }
                }
            }
        }
        panic!(
            "could not launch foreground sentinel after bounded retry: {}",
            last_error.unwrap_or_else(|| "unknown launch error".to_owned())
        );
    }

    fn try_launch(driver: &mut impl Driver) -> Result<Self, String> {
        let electron = electron_fixture();
        if !electron.path.exists() {
            return Err(format!(
                "Electron sentinel fixture is missing at {}",
                electron.path.display()
            ));
        }
        let user_data = tempfile::Builder::new()
            .prefix("cua-e2e-sentinel-")
            .tempdir()
            .map_err(|error| format!("create sentinel user-data directory: {error}"))?;
        let journal_path = user_data.path().join("sentinel-events.jsonl");
        fs::write(&journal_path, "")
            .map_err(|error| format!("initialize sentinel event journal: {error}"))?;
        let cdp_port = TcpListener::bind(("127.0.0.1", 0))
            .and_then(|listener| listener.local_addr())
            .map_err(|error| format!("allocate sentinel CDP port: {error}"))?
            .port();
        let mut command = Command::new(&electron.path);
        command
            .args(&electron.args)
            .env("CUA_E2E_SENTINEL", "1")
            .env("CUA_E2E_SENTINEL_JOURNAL", &journal_path)
            .env("CUA_E2E_USER_DATA_DIR", user_data.path())
            .env("CUA_ELECTRON_CDP_PORT", cdp_port.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = spawn_in_job(&mut command)
            .map_err(|error| format!("launch foreground sentinel: {error}"))?;
        let launched_pid = child.id();
        let mut reaper = ChildReaper::new();
        reaper.push(child);
        let expected_title = format!("CuaTestHarness Sentinel [cdp={cdp_port}]");

        let window_deadline = Instant::now() + Duration::from_secs(15);
        let target = loop {
            let windows = driver.call("list_windows", serde_json::json!({}));
            if let Some(target) = windows.structured()["windows"]
                .as_array()
                .and_then(|windows| {
                    windows.iter().find_map(|window| {
                        let id = window["window_id"].as_u64()?;
                        let title = window["title"].as_str().unwrap_or("");
                        title.contains(&expected_title).then(|| TargetWindow {
                            pid: window["pid"].as_u64().unwrap_or(launched_pid as u64) as u32,
                            native_id: id,
                        })
                    })
                })
            {
                assert_ne!(
                    target.pid, 0,
                    "foreground sentinel window has no process id"
                );
                break target;
            }
            if Instant::now() >= window_deadline {
                return Err("foreground sentinel window did not appear".to_owned());
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        reaper.track_pid(target.pid);

        let focus_deadline = Instant::now() + Duration::from_secs(10);
        {
            wait_for_journal(&journal_path, focus_deadline, r#""kind":"ready""#, "ready");
            try_activate_native_foreground(driver, target)?;
            wait_for_native_focus_stable(target);
            // On macOS the Electron renderer can report `document.hasFocus()`
            // as false at DOMContentLoaded, then become natively focused
            // without emitting a later DOM `focus` event. Require the setup
            // click below to reach the WebContents instead: that proves the
            // renderer is the input target before the journal is reset.
            #[cfg(not(target_os = "macos"))]
            wait_for_journal(&journal_path, focus_deadline, r#""kind":"focus""#, "focus");
            #[cfg(target_os = "macos")]
            wait_for_journal(
                &journal_path,
                focus_deadline,
                r#""kind":"click""#,
                "focused by setup click",
            );
        }
        fs::write(&journal_path, "")
            .map_err(|error| format!("reset focused sentinel journal: {error}"))?;

        Ok(Self {
            journal_path,
            target,
            _reaper: reaper,
            _user_data: user_data,
        })
    }

    pub fn observe(&self) -> (Vec<OracleKind>, Vec<String>) {
        std::thread::sleep(Duration::from_millis(200));
        let events = match read_journal_events(&self.journal_path) {
            Ok(events) => events,
            Err(error) => {
                return (
                    Vec::new(),
                    vec![format!("foreground sentinel journal is invalid: {error}")],
                )
            }
        };
        let mut passed = Vec::new();
        let mut violations = Vec::new();
        if !events
            .iter()
            .any(|event| event_kind(event) == Some("heartbeat"))
        {
            violations.push("foreground sentinel heartbeat stopped".to_owned());
        }
        {
            if events.iter().any(|event| {
                event_kind(event) == Some("blur")
                    || (event_kind(event) == Some("visibility")
                        && event["state"].as_str() == Some("hidden"))
            }) {
                violations.push("foreground sentinel lost focus".to_owned());
            } else {
                passed.push(OracleKind::Focus);
            }
        }
        let leaked = events
            .iter()
            .filter_map(|event| event_kind(event))
            .filter(|kind| {
                matches!(
                    *kind,
                    "keydown"
                        | "keyup"
                        | "pointerdown"
                        | "pointerup"
                        | "click"
                        | "wheel"
                        | "contextmenu"
                        | "input"
                )
            })
            .collect::<Vec<_>>();
        if leaked.is_empty() {
            passed.push(OracleKind::NoLeakedInput);
        } else {
            violations.push(format!(
                "foreground sentinel received input events: {}",
                leaked.join(", ")
            ));
        }
        (passed, violations)
    }

    /// Prove once per canonical lane that the foreground guard can detect both
    /// leaked input and transient focus loss. A guard that cannot observe its
    /// deliberate violations must never be trusted to certify background rows.
    pub fn assert_guard_canaries(
        &self,
        driver: &mut impl Driver,
        background_target: TargetWindow,
    ) -> Result<(), String> {
        wait_for_event(&self.journal_path, "heartbeat", Duration::from_secs(2))?;
        reset_journal(&self.journal_path)?;

        let leaked_key = driver.call(
            "press_key",
            serde_json::json!({
                "pid": self.target.pid,
                "window_id": self.target.native_id,
                "key": "a",
                "delivery_mode": "foreground",
            }),
        );
        if leaked_key.is_error() {
            return Err(format!(
                "foreground input canary could not inject a key: {}",
                leaked_key.text()
            ));
        }
        wait_for_event(&self.journal_path, "keydown", Duration::from_secs(2))?;
        let (_, leaked_input_violations) = self.observe();
        if !leaked_input_violations
            .iter()
            .any(|violation| violation.contains("received input events"))
        {
            return Err(format!(
                "foreground input canary was not detected: {leaked_input_violations:?}"
            ));
        }
        reset_journal(&self.journal_path)?;

        let raised = driver.call(
            "bring_to_front",
            serde_json::json!({
                "pid": background_target.pid,
                "window_id": background_target.native_id,
            }),
        );
        if raised.is_error() {
            return Err(format!(
                "focus-loss canary could not raise the background target: {}",
                raised.text()
            ));
        }
        {
            wait_for_event(&self.journal_path, "blur", Duration::from_secs(3))?;
            let (_, focus_violations) = self.observe();
            if !focus_violations
                .iter()
                .any(|violation| violation.contains("lost focus"))
            {
                return Err(format!(
                    "focus-loss canary was not detected: {focus_violations:?}"
                ));
            }
        }

        activate_native_foreground(driver, self.target);
        wait_for_native_focus_stable(self.target);
        std::thread::sleep(Duration::from_millis(150));
        reset_journal(&self.journal_path)?;
        wait_for_event(&self.journal_path, "heartbeat", Duration::from_secs(2))?;
        reset_journal(&self.journal_path)?;
        self.assert_background_posture(background_target)
    }

    pub fn target(&self) -> TargetWindow {
        self.target
    }

    /// Confirm the target is fully behind the ready foreground sentinel before
    /// the behavioral video boundary is crossed.
    pub fn assert_background_posture(&self, target: TargetWindow) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let observer = DesktopObserver::new(NativeObserver::new(), target);
            let before = observer.snapshot().map_err(|error| error.to_string())?;
            if before.target_z == crate::observer::TargetZ::BackgroundOccluded {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "background target was not fully occluded before recording: {:?}",
                    before.target_z
                ));
            }
            // Native maximize/fullscreen transitions can report focus before
            // their final geometry. This wait is outside the action boundary;
            // dispatch-time occlusion remains an immediate strict assertion.
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Re-establish the observation boundary after video capture starts.
    /// Capture backends may briefly perturb foreground state while they attach;
    /// those setup events are not part of the action under test.
    pub fn prepare_background_observation(
        &self,
        driver: &mut impl Driver,
        target: TargetWindow,
    ) -> Result<(), String> {
        activate_native_foreground(driver, self.target);
        wait_for_native_focus_stable(self.target);
        std::thread::sleep(Duration::from_millis(100));
        reset_journal(&self.journal_path)?;
        // Windows establishes focus with a physical click. Its DOM `click`
        // can arrive after the native focus transition and the first journal
        // reset, falsely attributing setup input to the background action.
        // A later heartbeat is an event-loop barrier: once observed, clear the
        // journal again so the action boundary starts from a quiet sentinel.
        wait_for_event(&self.journal_path, "heartbeat", Duration::from_secs(2))?;
        reset_journal(&self.journal_path)?;
        self.assert_background_posture(target)
    }

    /// Run one background action while checking the native desktop and the
    /// sentinel journal. The returned oracle list is suitable for a typed E2E
    /// result; any unsupported observation or side effect is an error.
    pub fn observe_background<R>(
        &self,
        target: TargetWindow,
        action: impl FnOnce() -> R,
    ) -> Result<(R, Vec<OracleKind>), String> {
        self.observe_target(target, true, action)
    }

    /// Observe a desktop-wide action against the foreground sentinel itself.
    /// Launch and cursor-overlay cells have no pre-existing background target,
    /// so they verify desktop stability without the target-occlusion precondition.
    pub fn observe_desktop<R>(
        &self,
        action: impl FnOnce() -> R,
    ) -> Result<(R, Vec<OracleKind>), String> {
        self.observe_target(self.target, false, action)
    }

    fn observe_target<R>(
        &self,
        target: TargetWindow,
        require_occluded_target: bool,
        action: impl FnOnce() -> R,
    ) -> Result<(R, Vec<OracleKind>), String> {
        let mut observer = DesktopObserver::new(NativeObserver::new(), target);
        let before = observer.snapshot().map_err(|error| error.to_string())?;
        if require_occluded_target
            && before.target_z != crate::observer::TargetZ::BackgroundOccluded
        {
            return Err(format!(
                "background target was not fully occluded before dispatch: {:?}",
                before.target_z
            ));
        }
        let native_oracles = [OracleKind::Focus, OracleKind::ZOrder, OracleKind::Cursor];
        let (result, delta) = observer
            .observe(&native_oracles, action)
            .map_err(|error| error.to_string())?;
        if require_occluded_target
            && delta.before.target_z != crate::observer::TargetZ::BackgroundOccluded
        {
            return Err(format!(
                "background target was not fully occluded at dispatch: {:?}",
                delta.before.target_z
            ));
        }
        delta
            .ensure_supported()
            .map_err(|error| error.to_string())?;

        let mut passed = delta.passed().to_vec();
        let mut violations = delta.violations().to_vec();
        let (sentinel_passed, sentinel_violations) = self.observe();
        passed.extend(sentinel_passed);
        violations.extend(sentinel_violations);
        passed.sort();
        passed.dedup();
        if violations.is_empty() {
            Ok((result, passed))
        } else {
            Err(violations.join("; "))
        }
    }
}

fn wait_for_journal(path: &std::path::Path, deadline: Instant, marker: &str, state: &str) {
    loop {
        let journal = fs::read_to_string(path).unwrap_or_default();
        if journal.contains(marker) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "foreground sentinel did not become {state}: {journal}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn reset_journal(path: &std::path::Path) -> Result<(), String> {
    fs::write(path, "").map_err(|error| format!("reset foreground sentinel journal: {error}"))
}

fn read_journal_events(path: &std::path::Path) -> Result<Vec<serde_json::Value>, String> {
    let journal =
        fs::read_to_string(path).map_err(|error| format!("read {}: {error}", path.display()))?;
    journal
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            serde_json::from_str(line)
                .map_err(|error| format!("parse sentinel event {line:?}: {error}"))
        })
        .collect()
}

fn event_kind(event: &serde_json::Value) -> Option<&str> {
    event["kind"].as_str()
}

fn wait_for_event(path: &std::path::Path, kind: &str, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        let events = read_journal_events(path)?;
        if events.iter().any(|event| event_kind(event) == Some(kind)) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "foreground sentinel did not emit {kind:?} within {timeout:?}: {events:?}"
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn activate_native_foreground(driver: &mut impl Driver, target: TargetWindow) {
    try_activate_native_foreground(driver, target)
        .unwrap_or_else(|error| panic!("could not activate foreground sentinel: {error}"));
}

fn try_activate_native_foreground(
    driver: &mut impl Driver,
    target: TargetWindow,
) -> Result<(), String> {
    let response = driver.call(
        "bring_to_front",
        serde_json::json!({
            "pid": target.pid,
            "window_id": target.native_id,
        }),
    );
    if response.is_error() {
        return Err(response.text().to_owned());
    }
    #[cfg(target_os = "windows")]
    physically_focus_windows_sentinel(target);
    #[cfg(target_os = "macos")]
    focus_macos_sentinel_contents(driver, target)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn focus_macos_sentinel_contents(
    driver: &mut impl Driver,
    target: TargetWindow,
) -> Result<(), String> {
    // A native app activation can leave Electron's renderer without keyboard
    // focus even though WindowServer reports its window at the front. This
    // bounded setup click lands well inside every canonical sentinel window
    // and is cleared from the journal before any behavioral action begins.
    let response = driver.call(
        "click",
        serde_json::json!({
            "pid": target.pid,
            "window_id": target.native_id,
            "x": 320.0,
            "y": 240.0,
            "delivery_mode": "background",
        }),
    );
    if response.is_error() {
        return Err(format!(
            "could not focus foreground sentinel WebContents: {}",
            response.text()
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn physically_focus_windows_sentinel(target: TargetWindow) {
    use windows::Win32::Foundation::{HWND, POINT, RECT};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
        MOUSEINPUT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetWindowRect, SetCursorPos};

    let hwnd = HWND(target.native_id as *mut _);
    let mut rect = RECT::default();
    let mut original_cursor = POINT::default();
    unsafe {
        GetWindowRect(hwnd, &mut rect).expect("read foreground sentinel bounds");
        GetCursorPos(&mut original_cursor).expect("read cursor before focusing sentinel");
    }
    let x = (rect.left + rect.right) / 2;
    let y = (rect.top + rect.bottom) / 2;
    assert!(
        rect.right > rect.left && rect.bottom > rect.top,
        "foreground sentinel has invalid bounds: {rect:?}"
    );

    let inputs = [
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dwFlags: MOUSEEVENTF_LEFTDOWN,
                    ..Default::default()
                },
            },
        },
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dwFlags: MOUSEEVENTF_LEFTUP,
                    ..Default::default()
                },
            },
        },
    ];
    unsafe {
        SetCursorPos(x, y).expect("move cursor onto foreground sentinel");
        let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        assert_eq!(sent, inputs.len() as u32, "click foreground sentinel");
        SetCursorPos(original_cursor.x, original_cursor.y)
            .expect("restore cursor after focusing sentinel");
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn wait_for_native_focus_stable(target: TargetWindow) {
    use crate::observer::{ObserverBackend, TargetZ};

    let backend = NativeObserver::new();
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut stable_since = None;
    loop {
        let foreground = backend
            .snapshot(target)
            .map(|snapshot| snapshot.target_z == TargetZ::Foreground)
            .unwrap_or(false);
        if foreground {
            let since = stable_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= Duration::from_millis(300) {
                return;
            }
        } else {
            stable_since = None;
        }
        assert!(
            Instant::now() < deadline,
            "foreground sentinel did not remain natively focused"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn wait_for_native_focus_stable(_target: TargetWindow) {}

pub fn run_with_background_oracles<D: Driver + BehaviorRecording, R>(
    driver: &mut D,
    target: TargetWindow,
    action: impl FnOnce(&mut D) -> R,
) -> Result<(R, Vec<OracleKind>), String> {
    let sentinel = ForegroundSentinel::launch(driver);
    sentinel.assert_background_posture(target)?;
    driver.start_behavior_recording();
    sentinel.prepare_background_observation(driver, target)?;
    sentinel.observe_background(target, || action(driver))
}

struct ElectronFixture {
    path: std::path::PathBuf,
    args: Vec<&'static str>,
}

fn electron_fixture() -> ElectronFixture {
    #[cfg(target_os = "windows")]
    {
        ElectronFixture {
            path: harness_app("harness-electron", "CuaTestHarness.Electron.exe"),
            args: vec![
                "--no-sandbox",
                "--disable-gpu",
                "--force-renderer-accessibility",
            ],
        }
    }
    #[cfg(target_os = "macos")]
    {
        ElectronFixture {
            path: harness_app(
                "harness-electron",
                "CuaTestHarness.Electron.app/Contents/MacOS/Electron",
            ),
            args: vec!["--force-renderer-accessibility"],
        }
    }
    #[cfg(target_os = "linux")]
    {
        ElectronFixture {
            path: harness_app("harness-electron", "CuaTestHarness.Electron"),
            args: vec![
                "--no-sandbox",
                "--disable-gpu",
                "--force-renderer-accessibility",
            ],
        }
    }
}
