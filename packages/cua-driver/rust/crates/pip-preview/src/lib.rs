//! Local window-preview configuration and platform backend compatibility.

/// Canonical `~/.cua-driver/config.json` path matching what the per-platform
/// `set_config` tools write to. Resolves `$HOME` first (Unix/macOS) and falls
/// back to `%USERPROFILE%` (Windows, where `HOME` is usually unset). Returns
/// `None` when neither is set (sandboxed CI).
pub fn default_config_path() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|h| {
            std::path::PathBuf::from(h)
                .join(".cua-driver")
                .join("config.json")
        })
}

/// Read a single key from `~/.cua-driver/config.json` as a raw JSON value,
/// returning `None` when the file is missing/malformed or the key is absent.
/// Used by the per-platform `load_driver_config` helpers to rehydrate the
/// in-memory `DriverConfig` at process startup so `set_config` writes survive
/// across stateless `cua-driver call` invocations.
pub fn read_config_value(key: &str) -> Option<serde_json::Value> {
    let path = default_config_path()?;
    let text = std::fs::read_to_string(&path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get(key).cloned()
}

/// Merge a single `key`/`value` into `~/.cua-driver/config.json`,
/// preserving any other keys that are already there. Used by the
/// per-platform `set_config` tools to persist `experimental_pip` /
/// `experimental_pip_geometry` so the next daemon restart picks them up.
pub fn write_config_key(key: &str, value: serde_json::Value) -> Result<(), String> {
    let path = default_config_path().ok_or_else(|| "$HOME is not set".to_string())?;
    let mut json: serde_json::Value = path
        .exists()
        .then(|| std::fs::read_to_string(&path).ok())
        .flatten()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    json[key] = value;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| e.to_string())?;
    Ok(())
}

/// Read `experimental_pip` + `experimental_pip_geometry` from the
/// config file, falling back to defaults when missing or malformed.
/// Surfaced by the per-platform `get_config` tools alongside the
/// in-memory `DriverConfig` fields.
pub fn read_pip_keys_from_file() -> (bool, Option<String>) {
    let path = match default_config_path() {
        Some(p) => p,
        None => return (PipConfig::default().enabled, None),
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return (PipConfig::default().enabled, None),
    };
    let json: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return (PipConfig::default().enabled, None),
    };
    let enabled = json
        .get("experimental_pip")
        .and_then(|v| v.as_bool())
        .unwrap_or(PipConfig::default().enabled);
    let geometry = json
        .get("experimental_pip_geometry")
        .and_then(|v| v.as_str())
        .map(|s| s.to_owned());
    (enabled, geometry)
}

/// Geometry of the PiP window, in screen points (top-left origin).
///
/// Parsed from `--experimental-pip-geometry WxH+X+Y`. `x` / `y` are
/// optional; when `None` the floating window starts near the lower-right.
/// Width/height bound each card; the window also reserves its stack and controls.
#[derive(Debug, Clone, Copy)]
pub struct PipGeometry {
    pub width: u32,
    pub height: u32,
    pub x: Option<i32>,
    pub y: Option<i32>,
}

impl Default for PipGeometry {
    fn default() -> Self {
        Self {
            width: 400,
            height: 300,
            x: None,
            y: None,
        }
    }
}

impl PipGeometry {
    /// Parse `WxH` or `WxH+X+Y` (matching the common X11 geometry form).
    /// Returns `None` on any parse failure so the caller can fall back
    /// to defaults without panicking.
    pub fn parse(s: &str) -> Option<Self> {
        // Split off the optional `+X+Y` tail first so the leading
        // `WxH` parses cleanly even when no position is provided.
        let (size, pos): (&str, Option<(i32, i32)>) = match s.find('+') {
            Some(i) => {
                let tail = &s[i + 1..];
                let mut parts = tail.split('+');
                let x = parts.next()?.parse().ok()?;
                let y = parts.next()?.parse().ok()?;
                if parts.next().is_some() {
                    return None;
                }
                (&s[..i], Some((x, y)))
            }
            None => (s, None),
        };
        let mut wh = size.split('x');
        let w: u32 = wh.next()?.parse().ok()?;
        let h: u32 = wh.next()?.parse().ok()?;
        if wh.next().is_some() || !(160..=2048).contains(&w) || !(120..=2048).contains(&h) {
            return None;
        }
        Some(Self {
            width: w,
            height: h,
            x: pos.map(|p| p.0),
            y: pos.map(|p| p.1),
        })
    }
}

/// Local preview defaults, with explicit per-host disabling.
#[derive(Debug, Clone)]
pub struct PipConfig {
    /// Enabled by default on macOS; unsupported platforms keep their stub.
    pub enabled: bool,
    pub geometry: PipGeometry,
    /// Local window title.
    pub title: String,
}

impl Default for PipConfig {
    fn default() -> Self {
        Self {
            enabled: cfg!(target_os = "macos"),
            geometry: PipGeometry::default(),
            title: "Qwen Computer Use".to_owned(),
        }
    }
}

impl PipConfig {
    /// Parse the PiP-related CLI flags out of `std::env::args()`.
    /// Recognised flags:
    /// ```text
    /// --experimental-pip
    /// --pip                        (short alias)
    /// --no-pip
    /// --experimental-pip-geometry  WxH | WxH+X+Y
    /// ```
    /// Unknown flags are ignored so this never conflicts with the
    /// other arg-parser passes (CursorConfig, the subcommand router).
    pub fn from_args() -> Self {
        let args: Vec<String> = std::env::args().collect();
        Self::parse(&args[1..])
    }

    pub fn parse(args: &[String]) -> Self {
        let mut cfg = PipConfig::default();
        cfg.apply_args(args);
        cfg
    }

    fn apply_args(&mut self, args: &[String]) {
        let mut i = 0usize;
        while i < args.len() {
            match args[i].as_str() {
                "--experimental-pip" | "--pip" => self.enabled = true,
                "--no-pip" => self.enabled = false,
                "--experimental-pip-geometry" => {
                    if let Some(geom) = args.get(i + 1).and_then(|s| PipGeometry::parse(s)) {
                        self.geometry = geom;
                        i += 1;
                    }
                }
                _ => {}
            }
            i += 1;
        }
    }

    /// Resolve the config from (in order of precedence, low → high):
    ///
    ///   defaults  →  `~/.cua-driver/config.json` keys
    ///                  (`experimental_pip` bool, `experimental_pip_geometry` string)
    ///              →  CLI flags
    ///
    /// Lets users persist `--experimental-pip` across daemon restarts by
    /// editing `~/.cua-driver/config.json` once, instead of re-running
    /// `claude mcp add` with the flag baked into the args list.
    /// Malformed or missing file falls back to the next layer silently.
    pub fn from_args_and_file(config_path: &std::path::Path) -> Self {
        let mut cfg = PipConfig::default();
        if let Ok(text) = std::fs::read_to_string(config_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(b) = json.get("experimental_pip").and_then(|v| v.as_bool()) {
                    cfg.enabled = b;
                }
                if let Some(s) = json
                    .get("experimental_pip_geometry")
                    .and_then(|v| v.as_str())
                {
                    if let Some(g) = PipGeometry::parse(s) {
                        cfg.geometry = g;
                    }
                }
            }
        }
        let args: Vec<String> = std::env::args().collect();
        cfg.apply_args(&args[1..]);
        cfg
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_cards_use_a_four_hundred_by_three_hundred_bound() {
        let geometry = PipGeometry::default();
        assert_eq!((geometry.width, geometry.height), (400, 300));
        assert_eq!((geometry.x, geometry.y), (None, None));
    }

    #[test]
    fn explicit_disabled_configuration_survives_empty_arguments() {
        let mut cfg = PipConfig {
            enabled: false,
            ..PipConfig::default()
        };
        cfg.apply_args(&[]);
        assert!(!cfg.enabled);
        cfg.apply_args(&["--pip".into()]);
        assert!(cfg.enabled);
        cfg.apply_args(&["--no-pip".into()]);
        assert!(!cfg.enabled);
    }

    #[test]
    fn geometry_rejects_unbounded_or_ambiguous_shapes() {
        for value in ["0x0", "4000x200", "320x200x1", "320x200+1+2+3", "320x200+1"] {
            assert!(PipGeometry::parse(value).is_none(), "{value}");
        }
        let geometry = PipGeometry::parse("320x200+-100+25").unwrap();
        assert_eq!(
            (geometry.width, geometry.height, geometry.x, geometry.y),
            (320, 200, Some(-100), Some(25))
        );
    }
}
