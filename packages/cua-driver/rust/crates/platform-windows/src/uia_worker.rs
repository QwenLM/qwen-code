use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use cua_driver_core::protocol::{Content, ToolResult};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::ClientOptions;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);
const WORKER_PATH_ENV: &str = "QWEN_CUA_UIACCESS_WORKER_PATH";

#[derive(Deserialize)]
struct PipeResponse {
    ok: bool,
    result: Option<Value>,
    error: Option<String>,
}

fn launch_gate() -> &'static tokio::sync::Mutex<()> {
    static GATE: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn module_path() -> anyhow::Result<PathBuf> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetModuleHandleExW(
            flags: u32,
            address: *const u16,
            module: *mut *mut core::ffi::c_void,
        ) -> i32;
        fn GetModuleFileNameW(module: *mut core::ffi::c_void, path: *mut u16, size: u32) -> u32;
    }
    const FROM_ADDRESS: u32 = 0x0000_0004;
    const UNCHANGED_REFCOUNT: u32 = 0x0000_0002;
    let mut module = std::ptr::null_mut();
    let address = module_path as *const () as *const u16;
    if unsafe { GetModuleHandleExW(FROM_ADDRESS | UNCHANGED_REFCOUNT, address, &mut module) } == 0 {
        anyhow::bail!("resolve cua-driver module handle");
    }
    let mut buffer = vec![0_u16; 32_768];
    let length = unsafe { GetModuleFileNameW(module, buffer.as_mut_ptr(), buffer.len() as u32) };
    if length == 0 || length as usize >= buffer.len() {
        anyhow::bail!("resolve cua-driver module path");
    }
    Ok(PathBuf::from(String::from_utf16_lossy(
        &buffer[..length as usize],
    )))
}

pub(crate) fn is_worker_process() -> bool {
    if cfg!(test) {
        return true;
    }
    module_path()
        .ok()
        .and_then(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .is_some_and(|name| name.to_ascii_lowercase().contains("cua-driver-uia"))
}

fn worker_path(module: &Path) -> anyhow::Result<PathBuf> {
    let local = module
        .file_name()
        .map(|name| {
            name.to_string_lossy()
                .to_ascii_lowercase()
                .contains("local")
        })
        .unwrap_or(false);
    if local {
        if let Some(path) = std::env::var_os(WORKER_PATH_ENV) {
            return Ok(PathBuf::from(path));
        }
        return module
            .parent()
            .map(|directory| directory.join("qwen-cua-driver-uia-local.exe"))
            .ok_or_else(|| anyhow::anyhow!("cua-driver module has no parent directory"));
    }
    let program_files = std::env::var_os("ProgramFiles")
        .ok_or_else(|| anyhow::anyhow!("ProgramFiles is unavailable"))?;
    Ok(PathBuf::from(program_files)
        .join("Qwen")
        .join("CuaDriver")
        .join(env!("CARGO_PKG_VERSION"))
        .join("qwen-cua-driver-uia.exe"))
}

fn pipe_path(module: &Path, parent_pid: u32) -> String {
    let local = module
        .file_name()
        .map(|name| {
            name.to_string_lossy()
                .to_ascii_lowercase()
                .contains("local")
        })
        .unwrap_or(false);
    if local {
        format!(r"\\.\pipe\qwen-cua-driver-local-uia-{parent_pid}")
    } else {
        format!(r"\\.\pipe\qwen-cua-driver-uia-{parent_pid}")
    }
}

fn launch_worker(path: &Path) -> anyhow::Result<()> {
    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: *mut core::ffi::c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show: i32,
        ) -> *mut core::ffi::c_void;
    }
    if !path.is_file() {
        anyhow::bail!(
            "required signed UIAccess worker is missing from its secure path: {}",
            path.display()
        );
    }
    let wide = |value: &str| {
        value
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>()
    };
    let operation = wide("open");
    let file = wide(&path.to_string_lossy());
    let parameters = wide(&format!("--authorized-parent-pid {}", std::process::id()));
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            parameters.as_ptr(),
            std::ptr::null(),
            0,
        )
    } as isize;
    if result <= 32 {
        anyhow::bail!("launch UIAccess worker failed with ShellExecute code {result}");
    }
    Ok(())
}

async fn open_pipe(
    path: &str,
) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
    ClientOptions::new().open(path)
}

async fn ensure_pipe(
    module: &Path,
) -> anyhow::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
    let pipe = pipe_path(module, std::process::id());
    if let Ok(client) = open_pipe(&pipe).await {
        return Ok(client);
    }
    let _gate = launch_gate().lock().await;
    if let Ok(client) = open_pipe(&pipe).await {
        return Ok(client);
    }
    launch_worker(&worker_path(module)?)?;
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    loop {
        match open_pipe(&pipe).await {
            Ok(client) => return Ok(client),
            Err(error) if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(50)).await;
                let _ = error;
            }
            Err(error) => anyhow::bail!("UIAccess worker did not open {pipe}: {error}"),
        }
    }
}

fn decode_tool_result(value: Value) -> anyhow::Result<ToolResult> {
    let mut content = Vec::new();
    for item in value
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match item.get("type").and_then(Value::as_str) {
            Some("text") => content.push(Content::text(
                item.get("text").and_then(Value::as_str).unwrap_or_default(),
            )),
            Some("image") => content.push(Content::Image {
                data: item
                    .get("data")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                mime_type: item
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .unwrap_or("image/png")
                    .to_owned(),
                annotations: None,
            }),
            _ => {}
        }
    }
    let action_record = value
        .get("_uiaccessActionRecord")
        .map(cua_driver_core::action_record::ActionExecutionRecord::from_private_json)
        .transpose()
        .map_err(anyhow::Error::msg)?;
    Ok(ToolResult {
        content,
        is_error: value.get("isError").and_then(Value::as_bool),
        structured_content: value.get("structuredContent").cloned(),
        action_record,
    })
}

async fn call_worker(name: &str, args: Value) -> anyhow::Result<ToolResult> {
    let module = module_path()?;
    let mut client = ensure_pipe(&module).await?;
    let request = json!({"method":"call", "name":name, "args":args});
    client
        .write_all(format!("{}\n", serde_json::to_string(&request)?).as_bytes())
        .await?;
    client.flush().await?;
    let mut line = String::new();
    let read = BufReader::new(client).read_line(&mut line).await?;
    if read == 0 {
        anyhow::bail!("UIAccess worker closed before returning {name}");
    }
    let response: PipeResponse = serde_json::from_str(&line)?;
    if !response.ok {
        anyhow::bail!(
            "{}",
            response
                .error
                .unwrap_or_else(|| format!("UIAccess {name} failed"))
        );
    }
    decode_tool_result(response.result.unwrap_or(Value::Null))
}

/// Returns None only inside the authenticated UIAccess worker itself. Every
/// caller in the ordinary runtime receives either the worker result or a hard
/// availability error; foreground input never falls back to medium integrity.
pub(crate) async fn forward_required(name: &str, args: Value) -> Option<ToolResult> {
    if is_worker_process() {
        return None;
    }
    Some(call_worker(name, args).await.unwrap_or_else(|error| {
        ToolResult::error(format!("UIAccess worker required for {name}: {error}")).with_structured(
            json!({
                "code": "uiaccess_worker_unavailable",
                "tool": name,
            }),
        )
    }))
}
