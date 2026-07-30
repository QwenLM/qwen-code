use command_group::{CommandGroup, GroupChild};
use rand::RngCore;
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use url::Url;

const LISTEN_PREFIX: &str = "qwen serve listening on ";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(45);
const HEALTH_RETRY_INTERVAL: Duration = Duration::from_millis(100);
const FAILURE_OUTPUT_LIMIT: usize = 16 * 1024;

pub struct DesktopRuntime {
    pub base_url: Url,
    token: String,
    child: Arc<Mutex<Option<GroupChild>>>,
}

impl DesktopRuntime {
    pub fn start(app: &AppHandle) -> Result<Self, String> {
        let layout = RuntimeLayout::resolve(app)?;
        let workspace = resolve_workspace()?;
        let token = random_token();
        let mut command = Command::new(&layout.node);
        command
            .arg(&layout.entry)
            .args(runtime_arguments(&workspace))
            .current_dir(&workspace)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("QWEN_CODE_DESKTOP", "1")
            .env("QWEN_SERVER_TOKEN", &token);

        let mut child = command
            .group_spawn()
            .map_err(|error| format!("Failed to start bundled Qwen Code runtime: {error}"))?;
        let stdout = child
            .inner()
            .stdout
            .take()
            .ok_or_else(|| "Bundled runtime stdout was not captured.".to_string())?;
        let stderr = child
            .inner()
            .stderr
            .take()
            .ok_or_else(|| "Bundled runtime stderr was not captured.".to_string())?;
        let failure_output = Arc::new(Mutex::new(String::new()));
        let (listen_sender, listen_receiver) = std::sync::mpsc::channel();
        capture_stdout(stdout, Arc::clone(&failure_output), listen_sender);
        capture_stderr(stderr, Arc::clone(&failure_output));

        let base_url =
            match wait_for_listening(&mut child, listen_receiver, &token, &failure_output) {
                Ok(url) => url,
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(error);
                }
            };

        Ok(Self {
            base_url,
            token,
            child: Arc::new(Mutex::new(Some(child))),
        })
    }

    pub fn stop(&self) {
        let child = match self.child.lock() {
            Ok(mut guard) => guard.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        };
        if let Some(mut child) = child {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    pub fn web_url(&self) -> Url {
        authenticated_web_url(&self.base_url, &self.token)
    }
}

impl Drop for DesktopRuntime {
    fn drop(&mut self) {
        self.stop();
    }
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
        let node = if cfg!(windows) {
            root.join("node").join("node.exe")
        } else {
            root.join("node").join("bin").join("node")
        };
        let entry = root.join("lib").join("cli-entry.js");
        require_file(&node, "Node.js runtime")?;
        require_file(&entry, "Qwen Code runtime entry")?;
        Ok(Self { node, entry })
    }
}

fn require_file(path: &Path, description: &str) -> Result<(), String> {
    if path.is_file() {
        return Ok(());
    }
    Err(format!("{description} is missing at {}", path.display()))
}

fn resolve_workspace() -> Result<PathBuf, String> {
    let configured = std::env::var_os("QWEN_DESKTOP_WORKSPACE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let workspace = fs::canonicalize(&configured).map_err(|error| {
        format!(
            "Failed to resolve desktop workspace {}: {error}",
            configured.display()
        )
    })?;
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
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn capture_stdout(
    stdout: impl Read + Send + 'static,
    failure_output: Arc<Mutex<String>>,
    listen_sender: std::sync::mpsc::Sender<Url>,
) {
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            append_failure_output(&failure_output, &line);
            if let Some(url) = parse_listening_url(&line) {
                let _ = listen_sender.send(url);
            }
        }
    });
}

fn capture_stderr(stderr: impl Read + Send + 'static, failure_output: Arc<Mutex<String>>) {
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            append_failure_output(&failure_output, &line);
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
    output.extend(line.chars().take(remaining));
    if output.len() < FAILURE_OUTPUT_LIMIT {
        output.push('\n');
    }
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

fn authenticated_web_url(base_url: &Url, token: &str) -> Url {
    let mut url = base_url.clone();
    url.set_fragment(Some(&format!("token={token}")));
    url
}

fn wait_for_listening(
    child: &mut GroupChild,
    listen_receiver: std::sync::mpsc::Receiver<Url>,
    token: &str,
    failure_output: &Mutex<String>,
) -> Result<Url, String> {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Failed to inspect bundled runtime: {error}"))?
        {
            return Err(startup_error(
                &format!("Bundled runtime exited with status {status}."),
                failure_output,
            ));
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
    child: &mut GroupChild,
    base_url: Url,
    token: &str,
    deadline: Instant,
    failure_output: &Mutex<String>,
) -> Result<Url, String> {
    let health_url = base_url
        .join("health")
        .map_err(|error| format!("Failed to construct runtime health URL: {error}"))?;
    while Instant::now() < deadline {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Failed to inspect bundled runtime: {error}"))?
        {
            return Err(startup_error(
                &format!("Bundled runtime exited with status {status}."),
                failure_output,
            ));
        }
        let response = ureq::get(health_url.as_str())
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
    use super::{authenticated_web_url, parse_listening_url, runtime_arguments};
    use std::path::Path;
    use url::Url;

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
    fn carries_the_daemon_token_in_the_web_url_fragment() {
        let base_url = Url::parse("http://127.0.0.1:49152/").expect("base URL");
        let web_url = authenticated_web_url(&base_url, "secret-token");
        assert_eq!(
            web_url.as_str(),
            "http://127.0.0.1:49152/#token=secret-token"
        );
        assert_eq!(base_url.as_str(), "http://127.0.0.1:49152/");
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
}
