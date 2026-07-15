//! Window / display screenshot using the macOS `screencapture` CLI tool.
//!
//! `screencapture -l <windowID> -x -o <file>` captures a single window by
//! CGWindowID to a PNG without any screen-recording permission dialog.
//!
//! `screencapture -x <file>` captures the full main display.
//!
//! For production use, the ImageIO/CGWindowListCreateImageFromArray path
//! would give lower overhead (no subprocess + temp file), but the subprocess
//! approach is simpler to implement correctly and is reliable across OS versions.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

const SCREENSHOT_TIMEOUT_SECS_DEFAULT: u64 = 15;
const TOOL_TIMEOUT_SECS_DEFAULT: u64 = 90;
const TOOL_DEADLINE_MARGIN: Duration = Duration::from_millis(250);

fn tool_timeout() -> Duration {
    let seconds = std::env::var("CUA_DRIVER_RS_TOOL_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0 && *value < 120)
        .unwrap_or(TOOL_TIMEOUT_SECS_DEFAULT);
    Duration::from_secs(seconds)
}

pub(crate) fn remaining_tool_budget(started: Instant) -> Duration {
    tool_timeout()
        .saturating_sub(started.elapsed())
        .saturating_sub(TOOL_DEADLINE_MARGIN)
}

fn screenshot_timeout() -> Duration {
    let requested = std::env::var("CUA_DRIVER_RS_SCREENSHOT_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(SCREENSHOT_TIMEOUT_SECS_DEFAULT);
    bounded_screenshot_timeout(requested, tool_timeout().as_secs())
}

fn bounded_screenshot_timeout(requested_seconds: u64, tool_timeout_seconds: u64) -> Duration {
    let native_budget =
        Duration::from_secs(tool_timeout_seconds).saturating_sub(TOOL_DEADLINE_MARGIN);
    Duration::from_secs(requested_seconds).min(native_budget)
}

struct CaptureFile(PathBuf);

impl CaptureFile {
    fn new(kind: &str) -> Self {
        Self(std::env::temp_dir().join(format!(
            "qwen-cua-driver-{kind}-{}-{}.png",
            std::process::id(),
            uuid::Uuid::new_v4()
        )))
    }

    fn path(&self) -> &Path { &self.0 }
}

impl Drop for CaptureFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn run_screencapture(args: &[String], target: &str, timeout: Duration) -> anyhow::Result<()> {
    if timeout.is_zero() {
        anyhow::bail!("no tool deadline remains for screencapture of {target}");
    }
    let mut child = Command::new("screencapture").args(args).spawn()?;
    let Some(deadline) = Instant::now().checked_add(timeout) else {
        let _ = child.kill();
        let _ = child.wait();
        anyhow::bail!("invalid screencapture timeout for {target}");
    };
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                anyhow::bail!(
                    "screencapture timed out after {} ms for {target}; process terminated",
                    timeout.as_millis()
                );
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.into());
            }
        }
    };
    if !status.success() {
        anyhow::bail!("screencapture failed for {target} (status {status})");
    }
    Ok(())
}

/// Capture a window by its `window_id` (CGWindowID).
/// Returns raw PNG bytes or an error.
pub fn screenshot_window_bytes(window_id: u32) -> anyhow::Result<Vec<u8>> {
    screenshot_window_bytes_with_budget(window_id, screenshot_timeout())
}

pub(crate) fn screenshot_window_bytes_with_budget(
    window_id: u32,
    remaining_budget: Duration,
) -> anyhow::Result<Vec<u8>> {
    let capture = CaptureFile::new(&format!("window-{window_id}"));
    let args = vec![
        "-l".to_owned(), window_id.to_string(),
        "-x".to_owned(), "-o".to_owned(),
        capture.path().to_string_lossy().into_owned(),
    ];
    run_screencapture(
        &args,
        &format!("window {window_id}"),
        screenshot_timeout().min(remaining_budget),
    )?;
    let bytes = std::fs::read(capture.path())?;

    if bytes.is_empty() {
        anyhow::bail!("screencapture produced empty output for window {window_id}");
    }
    Ok(bytes)
}

/// Capture a window by its `window_id` (CGWindowID).
/// Returns (base64-encoded PNG, width, height) or an error.
pub fn screenshot_window(window_id: u32) -> anyhow::Result<(String, u32, u32)> {
    let bytes = screenshot_window_bytes(window_id)?;
    let (w, h) = png_dimensions(&bytes)?;
    let b64 = BASE64.encode(&bytes);
    Ok((b64, w, h))
}

/// Capture the full main display.
/// Returns raw PNG bytes or an error.
pub fn screenshot_display_bytes() -> anyhow::Result<Vec<u8>> {
    let capture = CaptureFile::new("display");
    let args = vec!["-x".to_owned(), capture.path().to_string_lossy().into_owned()];
    run_screencapture(&args, "main display", screenshot_timeout())?;
    let bytes = std::fs::read(capture.path())?;

    if bytes.is_empty() {
        anyhow::bail!("screencapture produced empty output for main display");
    }
    Ok(bytes)
}

/// Capture the main display and return (base64-encoded PNG, width, height).
pub fn screenshot_display() -> anyhow::Result<(String, u32, u32)> {
    let bytes = screenshot_display_bytes()?;
    let (w, h) = png_dimensions(&bytes)?;
    let b64 = BASE64.encode(&bytes);
    Ok((b64, w, h))
}

// PNG/JPEG/resize/crosshair helpers — re-exports of the shared
// `cua_driver_core::image_utils` module. The previous file-local copies were
// near-identical to the Windows and Linux versions; the dedup-audit
// (2026-05) moved them all to one place. See
// `CUA_DRIVER_RS_DEDUP_AUDIT.md` for the audit trail.

/// Convert raw PNG bytes to JPEG at the given quality (1-95).
pub fn png_bytes_to_jpeg(png_bytes: &[u8], quality: u8) -> anyhow::Result<Vec<u8>> {
    cua_driver_core::image_utils::png_bytes_to_jpeg(png_bytes, quality)
}

/// Downscale `png_bytes` so neither dimension exceeds `max_dim`.
/// If `max_dim == 0` or the image already fits, returns the original
/// bytes unchanged.
pub fn resize_png_if_needed(png_bytes: &[u8], max_dim: u32) -> anyhow::Result<Vec<u8>> {
    cua_driver_core::image_utils::resize_png_if_needed(png_bytes, max_dim)
}

/// Draw a red crosshair at pixel (cx, cy) on a PNG image and write to
/// `path`. Used by `click`'s `debug_image_out` param to verify
/// coordinate spaces. The crosshair uses top-left-origin coords
/// matching the click tool's convention.
pub fn write_crosshair_png(
    png_bytes: &[u8],
    cx: f64,
    cy: f64,
    path: &str,
) -> anyhow::Result<()> {
    cua_driver_core::image_utils::write_crosshair_png(png_bytes, cx, cy, path)
}

/// Draw a red crosshair at pixel (cx, cy) on a PNG image and return the
/// modified PNG bytes. Used by recording's click-marker callback to
/// produce click.png.
pub fn crosshair_png_bytes(png_bytes: &[u8], cx: f64, cy: f64) -> anyhow::Result<Vec<u8>> {
    cua_driver_core::image_utils::crosshair_png_bytes(png_bytes, cx, cy)
}

/// Parse width and height from a PNG file's IHDR chunk.
pub fn png_dimensions(data: &[u8]) -> anyhow::Result<(u32, u32)> {
    cua_driver_core::image_utils::png_dimensions(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screenshot_timeout_stays_inside_tool_deadline() {
        assert_eq!(
            bounded_screenshot_timeout(u64::MAX, 90),
            Duration::from_millis(89_750),
        );
        assert_eq!(
            bounded_screenshot_timeout(15, 5),
            Duration::from_millis(4_750),
        );
    }
}
