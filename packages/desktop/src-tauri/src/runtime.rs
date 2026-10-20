use command_group::{CommandGroup, GroupChild};
use rand::RngCore;
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use url::Url;

const LISTEN_PREFIX: &str = "qwen serve listening on ";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(45);
const HEALTH_RETRY_INTERVAL: Duration = Duration::from_millis(100);
const HEALTH_REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const FAILURE_OUTPUT_LIMIT: usize = 16 * 1024;
static NEXT_RUNTIME_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStopped {
    runtime_id: u64,
    status: String,
}

pub struct DesktopRuntime {
    id: u64,
    pub base_url: Url,
    token: String,
    child: Arc<Mutex<Option<GroupChild>>>,
    stopping: Arc<AtomicBool>,
}

impl DesktopRuntime {
    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn start(
        app: &AppHandle,
        workspace: &Path,
        log_path: &Path,
        on_spawned: impl FnOnce(Arc<Mutex<Option<GroupChild>>>, Arc<AtomicBool>),
    ) -> Result<Self, String> {
        let id = NEXT_RUNTIME_ID.fetch_add(1, Ordering::Relaxed);
        let layout = RuntimeLayout::resolve(app)?;
        // Callers pass a workspace already resolved by resolve_workspace.
        let token = random_token();
        let mut command = Command::new(&layout.node);
        command
            .arg(&layout.entry)
            .args(runtime_arguments(workspace))
            .current_dir(workspace)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("QWEN_CODE_DESKTOP", "1")
            .env("QWEN_SERVER_TOKEN", &token);

        let mut child = spawn_runtime_group(&mut command)
            .map_err(|error| format!("Failed to start bundled Qwen Code runtime: {error}"))?;
        let Some(stdout) = child.inner().stdout.take() else {
            stop_runtime_child(&mut child);
            return Err("Bundled runtime stdout was not captured.".to_string());
        };
        let Some(stderr) = child.inner().stderr.take() else {
            stop_runtime_child(&mut child);
            return Err("Bundled runtime stderr was not captured.".to_string());
        };
        let failure_output = Arc::new(Mutex::new(String::new()));
        let log = match open_log(log_path) {
            Ok(log) => Arc::new(Mutex::new(log)),
            Err(error) => {
                stop_runtime_child(&mut child);
                return Err(error);
            }
        };
        let (listen_sender, listen_receiver) = std::sync::mpsc::channel();
        capture_stdout(
            stdout,
            Arc::clone(&failure_output),
            Arc::clone(&log),
            listen_sender,
        );
        capture_stderr(stderr, Arc::clone(&failure_output), log);

        // Share the child before blocking on startup so a concurrent stop
        // (app exit, restart, or a newer start) can kill an in-flight daemon
        // instead of orphaning it in its own process group.
        let child = Arc::new(Mutex::new(Some(child)));
        let stopping = Arc::new(AtomicBool::new(false));
        on_spawned(Arc::clone(&child), Arc::clone(&stopping));

        let base_url = match wait_for_listening(&child, listen_receiver, &token, &failure_output) {
            Ok(url) => url,
            Err(error) => {
                stop_runtime_handle(&child);
                return Err(error);
            }
        };
        monitor_runtime(app.clone(), id, Arc::clone(&child), Arc::clone(&stopping));

        Ok(Self {
            id,
            base_url,
            token,
            child,
            stopping,
        })
    }

    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        stop_runtime_handle(&self.child);
    }

    pub fn base_url(&self) -> &Url {
        &self.base_url
    }

    pub fn authenticated_web_url(&self) -> Url {
        let mut url = self.base_url.clone();
        url.set_fragment(Some(&format!("token={}", self.token)));
        url
    }
}

impl Drop for DesktopRuntime {
    fn drop(&mut self) {
        self.stop();
    }
}

// Spawns the runtime child in its own process group. On Windows the bundled
// Node.js binary is a console application, so creating it from the desktop
// (a GUI application) without `CREATE_NO_WINDOW` allocates a visible terminal
// window for it, and closing that window stops the runtime (#9043). The flag
// must be set through the group builder: `group_spawn` replaces the command's
// creation flags with the builder's own.
#[cfg(windows)]
fn spawn_runtime_group(command: &mut Command) -> std::io::Result<GroupChild> {
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    command.group().creation_flags(CREATE_NO_WINDOW).spawn()
}

#[cfg(not(windows))]
fn spawn_runtime_group(command: &mut Command) -> std::io::Result<GroupChild> {
    command.group_spawn()
}

struct RuntimeLayout {
    node: PathBuf,
    entry: PathBuf,
}

impl RuntimeLayout {
    fn resolve(app: &AppHandle) -> Result<Self, String> {
        let root = if let Some(path) = std::env::var_os("QWEN_DESKTOP_RUNTIME_DIR") {
            PathBuf::from(path)
        } else if cfg!(debug_assertions) {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("runtime")
                .join("qwen-code")
        } else {
            app.path()
                .resource_dir()
                .map_err(|error| format!("Failed to resolve desktop resources: {error}"))?
                .join("runtime")
                .join("qwen-code")
        };
        let (node, entry) = layout_from_root(root);
        require_file(&node, "Node.js runtime")?;
        require_file(&entry, "Qwen Code runtime entry")?;
        Ok(Self { node, entry })
    }
}

fn layout_from_root(root: PathBuf) -> (PathBuf, PathBuf) {
    let node = if cfg!(windows) {
        root.join("node").join("node.exe")
    } else {
        root.join("node").join("bin").join("node")
    };
    let entry = root.join("lib").join("cli-entry.js");
    // Tauri's resource_dir() returns `\\?\` verbatim paths on Windows, and
    // Node's entry-script resolution cannot handle that prefix (#8929).
    (
        dunce::simplified(&node).to_path_buf(),
        dunce::simplified(&entry).to_path_buf(),
    )
}

fn require_file(path: &Path, description: &str) -> Result<(), String> {
    if path.is_file() {
        return Ok(());
    }
    Err(format!("{description} is missing at {}", path.display()))
}

fn ensure_supported_workspace_path(path: &Path) -> Result<(), String> {
    if matches!(
        path.components().next(),
        Some(Component::Prefix(prefix)) if prefix.kind().is_verbatim()
    ) {
        return Err(format!(
            "Desktop workspace path uses an unsupported Windows extended-length form: {}. Choose a local drive path; network (UNC) shares, paths over 260 characters, and names ending in a dot or space are not supported.",
            path.display()
        ));
    }
    Ok(())
}

pub(crate) fn resolve_workspace(configured: &Path) -> Result<PathBuf, String> {
    // dunce::canonicalize strips the Windows `\\?\` prefix when safe (#8615).
    let workspace = dunce::canonicalize(configured).map_err(|error| {
        format!(
            "Failed to resolve desktop workspace {}: {error}",
            configured.display()
        )
    })?;
    ensure_supported_workspace_path(&workspace)?;
    if workspace.is_dir() {
        Ok(workspace)
    } else {
        Err(format!(
            "Desktop workspace is not a directory: {}",
            workspace.display()
        ))
    }
}

fn random_token() -> String {
    use std::fmt::Write as _;
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(token, "{byte:02x}");
    }
    token
}

fn capture_stdout(
    stdout: impl Read + Send + 'static,
    failure_output: Arc<Mutex<String>>,
    log: Arc<Mutex<File>>,
    listen_sender: std::sync::mpsc::Sender<Url>,
) {
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            append_failure_output(&failure_output, &line);
            append_log(&log, "stdout", &line);
            if let Some(url) = parse_listening_url(&line) {
                let _ = listen_sender.send(url);
            }
        }
    });
}

fn capture_stderr(
    stderr: impl Read + Send + 'static,
    failure_output: Arc<Mutex<String>>,
    log: Arc<Mutex<File>>,
) {
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            append_failure_output(&failure_output, &line);
            append_log(&log, "stderr", &line);
        }
    });
}

fn append_failure_output(output: &Mutex<String>, line: &str) {
    let mut output = match output.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if output.len() >= FAILURE_OUTPUT_LIMIT {
        return;
    }
    let remaining = FAILURE_OUTPUT_LIMIT - output.len();
    let mut end = line.len().min(remaining);
    while end > 0 && !line.is_char_boundary(end) {
        end -= 1;
    }
    if end == 0 {
        return;
    }
    output.push_str(&line[..end]);
    if output.len() < FAILURE_OUTPUT_LIMIT {
        output.push('\n');
    }
}

fn open_log(path: &Path) -> Result<File, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create desktop log directory: {error}"))?;
    }
    File::options()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("Failed to open desktop runtime log: {error}"))
}

fn stop_runtime_child(child: &mut GroupChild) {
    let _ = child.kill();
    let _ = child.wait();
}

// Kills and reaps the child behind a shared startup/runtime handle. The
// `Option::take` makes concurrent stops (pending stop vs `DesktopRuntime::stop`)
// idempotent: whichever runs first owns the kill.
pub(crate) fn stop_runtime_handle(child: &Mutex<Option<GroupChild>>) {
    let taken = match child.lock() {
        Ok(mut guard) => guard.take(),
        Err(poisoned) => poisoned.into_inner().take(),
    };
    if let Some(mut child) = taken {
        stop_runtime_child(&mut child);
    }
}

fn append_log(log: &Mutex<File>, stream: &str, line: &str) {
    let mut log = match log.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let _ = writeln!(log, "[{stream}] {line}");
    let _ = log.flush();
}

fn monitor_runtime(
    app: AppHandle,
    id: u64,
    child: Arc<Mutex<Option<GroupChild>>>,
    stopping: Arc<AtomicBool>,
) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(250));
        if stopping.load(Ordering::SeqCst) {
            return;
        }
        let exit = {
            let mut guard = match child.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            let Some(process) = guard.as_mut() else {
                return;
            };
            match process.try_wait() {
                Ok(Some(status)) => {
                    if let Some(mut process) = guard.take() {
                        let _ = process.kill();
                    }
                    Some(status.to_string())
                }
                Ok(None) => None,
                Err(error) => {
                    if let Some(mut process) = guard.take() {
                        let _ = process.kill();
                    }
                    Some(format!("failed to inspect daemon: {error}"))
                }
            }
        };
        if let Some(status) = exit {
            if !stopping.load(Ordering::SeqCst) {
                let _ = app.emit(
                    "runtime-process-stopped",
                    RuntimeStopped {
                        runtime_id: id,
                        status,
                    },
                );
            }
            return;
        }
    });
}

fn parse_listening_url(line: &str) -> Option<Url> {
    let rest = line.strip_prefix(LISTEN_PREFIX)?;
    let raw_url = rest.split_whitespace().next()?;
    let url = Url::parse(raw_url).ok()?;
    if url.scheme() == "http" && url.host_str() == Some("127.0.0.1") {
        Some(url)
    } else {
        None
    }
}

enum StartupChildState {
    Running,
    Exited(String),
    // A concurrent stop took the child out of the shared handle while startup
    // was still in flight.
    Stopped,
}

fn startup_child_state(child: &Mutex<Option<GroupChild>>) -> Result<StartupChildState, String> {
    let mut guard = match child.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let Some(process) = guard.as_mut() else {
        return Ok(StartupChildState::Stopped);
    };
    match process.try_wait() {
        Ok(Some(status)) => Ok(StartupChildState::Exited(status.to_string())),
        Ok(None) => Ok(StartupChildState::Running),
        Err(error) => Err(format!("Failed to inspect bundled runtime: {error}")),
    }
}

fn wait_for_listening(
    child: &Mutex<Option<GroupChild>>,
    listen_receiver: std::sync::mpsc::Receiver<Url>,
    token: &str,
    failure_output: &Mutex<String>,
) -> Result<Url, String> {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    loop {
        match startup_child_state(child)? {
            StartupChildState::Running => {}
            StartupChildState::Exited(status) => {
                return Err(startup_error(
                    &format!("Bundled runtime exited with status {status}."),
                    failure_output,
                ));
            }
            StartupChildState::Stopped => {
                return Err(startup_error(
                    "Runtime startup was stopped before the daemon was ready.",
                    failure_output,
                ));
            }
        }
        match listen_receiver.recv_timeout(HEALTH_RETRY_INTERVAL) {
            Ok(url) => return wait_for_health(child, url, token, deadline, failure_output),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err(startup_error(
                    "Bundled runtime closed stdout before reporting its listening URL.",
                    failure_output,
                ));
            }
        }
        if Instant::now() >= deadline {
            return Err(startup_error(
                "Timed out waiting for the bundled runtime to listen.",
                failure_output,
            ));
        }
    }
}

fn wait_for_health(
    child: &Mutex<Option<GroupChild>>,
    base_url: Url,
    token: &str,
    deadline: Instant,
    failure_output: &Mutex<String>,
) -> Result<Url, String> {
    // `?deep=true` matters: the serve fast path answers a shallow `/health`
    // from its bootstrap app before the real runtime (and the Web Shell) is
    // mounted. Deep health stays 503 (`reason: "bootstrap"`) until the
    // runtime app is ready, so navigating after a 200 cannot race into the
    // deferred-runtime window.
    let health_url = base_url
        .join("health?deep=true")
        .map_err(|error| format!("Failed to construct runtime health URL: {error}"))?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(HEALTH_REQUEST_TIMEOUT))
        .build()
        .into();
    while Instant::now() < deadline {
        match startup_child_state(child)? {
            StartupChildState::Running => {}
            StartupChildState::Exited(status) => {
                return Err(startup_error(
                    &format!("Bundled runtime exited with status {status}."),
                    failure_output,
                ));
            }
            StartupChildState::Stopped => {
                return Err(startup_error(
                    "Runtime startup was stopped before the daemon was ready.",
                    failure_output,
                ));
            }
        }
        let response = agent
            .get(health_url.as_str())
            .header("Authorization", &format!("Bearer {token}"))
            .call();
        if response.is_ok_and(|response| {
            response
                .into_body()
                .read_to_string()
                .is_ok_and(|body| body.contains("\"status\":\"ok\""))
        }) {
            return Ok(base_url);
        }
        thread::sleep(HEALTH_RETRY_INTERVAL);
    }
    Err(startup_error(
        "Timed out waiting for the bundled runtime health check.",
        failure_output,
    ))
}

fn startup_error(message: &str, output: &Mutex<String>) -> String {
    let output = match output.lock() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    };
    if output.trim().is_empty() {
        message.to_string()
    } else {
        format!("{message}\n\nRuntime output:\n{}", output.trim())
    }
}

fn runtime_arguments(workspace: &Path) -> Vec<OsString> {
    [
        OsString::from("serve"),
        OsString::from("--port"),
        OsString::from("0"),
        OsString::from("--hostname"),
        OsString::from("127.0.0.1"),
        OsString::from("--require-auth"),
        OsString::from("--workspace"),
        workspace.as_os_str().to_owned(),
        OsString::from("--no-open"),
    ]
    .into_iter()
    .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        append_failure_output, parse_listening_url, resolve_workspace, runtime_arguments,
        DesktopRuntime, RuntimeStopped, FAILURE_OUTPUT_LIMIT,
    };
    #[cfg(unix)]
    use super::{stop_runtime_handle, wait_for_listening};
    #[cfg(windows)]
    use super::{layout_from_root, spawn_runtime_group};
    use std::path::Path;
    #[cfg(windows)]
    use std::path::PathBuf;
    #[cfg(unix)]
    use std::sync::Arc;
    use std::sync::Mutex;
    use url::Url;

    #[test]
    fn resolve_workspace_strips_windows_verbatim_prefix() {
        let dir = std::env::temp_dir().join(format!("qwen-desktop-ws-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp workspace");
        let resolved = resolve_workspace(&dir).expect("resolve workspace");
        std::fs::remove_dir_all(&dir).expect("cleanup temp workspace");
        let resolved = resolved.to_string_lossy();
        assert!(
            !resolved.starts_with("\\\\?\\"),
            "workspace keeps the verbatim prefix: {resolved}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn rejects_residual_windows_verbatim_workspace_paths() {
        for path in [
            r"\\?\C:\workspace",
            r"\\?\UNC\server\share",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1",
        ] {
            let error = super::ensure_supported_workspace_path(Path::new(path))
                .expect_err("reject residual verbatim path");
            assert!(error.contains("unsupported Windows extended-length form"));
        }
    }

    #[cfg(windows)]
    #[test]
    fn resolve_workspace_rejects_residual_verbatim_paths() {
        use std::os::windows::ffi::OsStrExt;

        let base =
            std::env::temp_dir().join(format!("qwen-desktop-long-ws-{}", std::process::id()));
        let mut workspace = PathBuf::from(format!(r"\\?\{}", base.display()));
        while workspace.as_os_str().encode_wide().count() <= 270 {
            workspace.push("long-workspace-component");
        }
        std::fs::create_dir_all(&workspace).expect("create long workspace");
        let result = resolve_workspace(&workspace);
        std::fs::remove_dir_all(PathBuf::from(format!(r"\\?\{}", base.display())))
            .expect("cleanup long workspace");
        let error = result.expect_err("reject long workspace");
        assert!(error.contains("unsupported Windows extended-length form"));
    }

    // The bundled runtime is a console application, so it must be created
    // with `CREATE_NO_WINDOW`: the probe child reports its own attached
    // console window, and there must be none (#9043).
    #[cfg(windows)]
    #[test]
    fn runtime_child_gets_no_windows_console() {
        let probe = concat!(
            "Add-Type -Namespace QwenDesktop -Name ConsoleProbe",
            " -MemberDefinition '[DllImport(\"kernel32.dll\")]",
            " public static extern IntPtr GetConsoleWindow();';",
            " [QwenDesktop.ConsoleProbe]::GetConsoleWindow().ToInt64()",
        );
        let mut command = std::process::Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", probe])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let output = spawn_runtime_group(&mut command)
            .expect("spawn hidden runtime child")
            .wait_with_output()
            .expect("collect hidden runtime child output");
        assert!(
            output.status.success(),
            "console probe child failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "0",
            "the runtime child must not receive a console window"
        );
    }

    #[cfg(windows)]
    #[test]
    fn runtime_layout_strips_windows_verbatim_prefix() {
        let root = PathBuf::from(r"\\?\C:\Users\user\AppData\Local\Qwen Code Desktop")
            .join("runtime")
            .join("qwen-code");
        let (node, entry) = layout_from_root(root);
        for path in [node, entry] {
            let path = path.to_string_lossy();
            assert!(
                !path.starts_with("\\\\?\\"),
                "runtime path keeps the verbatim prefix: {path}"
            );
        }
    }

    #[test]
    fn parses_loopback_listening_line() {
        let url = parse_listening_url(
            "qwen serve listening on http://127.0.0.1:49152 (mode=stdio, workspace=/tmp)",
        )
        .expect("listening URL");
        assert_eq!(url.as_str(), "http://127.0.0.1:49152/");
    }

    #[test]
    fn rejects_non_loopback_listening_line() {
        assert!(parse_listening_url(
            "qwen serve listening on http://0.0.0.0:4170 (mode=stdio, workspace=/tmp)"
        )
        .is_none());
    }

    #[test]
    fn carries_the_daemon_token_only_in_the_url_fragment() {
        let runtime = DesktopRuntime {
            id: 1,
            base_url: Url::parse("http://127.0.0.1:49152/").expect("base URL"),
            token: "secret-token".to_string(),
            child: std::sync::Arc::new(std::sync::Mutex::new(None)),
            stopping: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };
        assert_eq!(
            runtime.authenticated_web_url().as_str(),
            "http://127.0.0.1:49152/#token=secret-token"
        );
        assert_eq!(runtime.base_url().as_str(), "http://127.0.0.1:49152/");
    }

    #[test]
    fn runtime_arguments_enable_ephemeral_authenticated_web_shell() {
        let args = runtime_arguments(Path::new("/tmp/workspace"));
        let args: Vec<_> = args
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            [
                "serve",
                "--port",
                "0",
                "--hostname",
                "127.0.0.1",
                "--require-auth",
                "--workspace",
                "/tmp/workspace",
                "--no-open",
            ]
        );
    }

    #[test]
    fn runtime_stopped_payload_uses_camel_case_runtime_id() {
        let payload = RuntimeStopped {
            runtime_id: 7,
            status: "exited".to_string(),
        };

        assert_eq!(
            serde_json::to_value(payload).expect("payload"),
            serde_json::json!({ "runtimeId": 7, "status": "exited" }),
        );
    }

    #[test]
    fn failure_output_limit_respects_utf8_boundaries() {
        let output = Mutex::new("a".repeat(FAILURE_OUTPUT_LIMIT - 1));
        append_failure_output(&output, "中");
        assert_eq!(
            output.lock().expect("output").len(),
            FAILURE_OUTPUT_LIMIT - 1
        );
    }

    #[cfg(unix)]
    fn spawn_sleep(seconds: &str) -> command_group::GroupChild {
        use command_group::CommandGroup;
        std::process::Command::new("sleep")
            .arg(seconds)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .group_spawn()
            .expect("spawn sleep")
    }

    // A pending stop (app exit / restart while startup is still in flight)
    // must reap the child it took from the shared handle.
    #[cfg(unix)]
    #[test]
    fn pending_stop_reaps_a_child_taken_from_the_shared_handle() {
        let handle = Arc::new(Mutex::new(Some(spawn_sleep("30"))));
        let started = std::time::Instant::now();
        stop_runtime_handle(&handle);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "stop blocked, so the child was not killed"
        );
        assert!(handle.lock().expect("handle").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn wait_for_listening_reports_a_stop_during_startup() {
        let handle = Arc::new(Mutex::new(Some(spawn_sleep("30"))));
        let failure_output = Mutex::new(String::new());
        let (_listen_sender, listen_receiver) = std::sync::mpsc::channel::<Url>();
        let stopper = Arc::clone(&handle);
        let stopper_thread = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(200));
            stop_runtime_handle(&stopper);
        });

        let error = wait_for_listening(&handle, listen_receiver, "token", &failure_output)
            .expect_err("startup should fail when stopped in flight");
        assert!(
            error.contains("stopped before the daemon was ready"),
            "unexpected startup error: {error}"
        );
        stopper_thread.join().expect("stopper thread joins");
    }
}
