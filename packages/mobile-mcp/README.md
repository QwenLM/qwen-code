# @qwen-code/mobile-mcp

Fork of [mobile-next/mobile-mcp](https://github.com/mobile-next/mobile-mcp) for [qwen-code](https://github.com/QwenLM/qwen-code), with opt-in relative coordinate support and additional Android tooling.

This package is an MCP server that enables LLM agents to interact with mobile devices (iOS and Android) through screenshots, accessibility elements, and coordinate-based touch actions. It supports simulators, emulators, and real devices.

## Upstream

Based on [mobile-next/mobile-mcp](https://github.com/mobile-next/mobile-mcp) v0.0.61 (`c5d7d27`). We track upstream via `git subtree` and will continue to sync updates. See [.vendored-patches.md](.vendored-patches.md) for local modifications and [scripts/sync-from-upstream.sh](scripts/sync-from-upstream.sh) for the sync mechanism.

## What we added

### 1. Opt-in 0-1000 relative coordinate mode

Mirrors the [cua-driver relative coordinate shim](../cua-driver/docs/relative-coordinates-design.md) for mobile. When enabled, all coordinate inputs/outputs are normalized to a 0-1000 scale, matching the Qwen VL model's `computer_use` / `mobile_use` coordinate convention.

**Environment variables:**

| Variable                      | Values               | Default | Description                                              |
| ----------------------------- | -------------------- | ------- | -------------------------------------------------------- |
| `MOBILE_MCP_COORDINATE_SPACE` | `0` (off) / `1` (on) | `0`     | Enable 0-1000 normalized coordinates                     |
| `MOBILE_MCP_COORDINATE_SCALE` | Any positive integer | `1000`  | Full scale value (use `999` for `mobile_use` convention) |

**How it works:**

- **Input denormalization**: Coordinate tools (`mobile_click_on_screen_at_coordinates`, `mobile_double_tap_on_screen`, `mobile_long_press_on_screen_at_coordinates`, `mobile_swipe_on_screen`) convert 0-1000 input to device pixels/points before execution.
- **Output normalization**: `mobile_list_elements_on_screen` element coordinates are converted from pixels/points to 0-1000. `mobile_get_screen_size` reports 1000x1000.
- **Description rewriting**: Tool descriptions change from "in pixels" to "in 0-1000 normalized coordinates" when enabled.
- **Default off**: Zero behavior change when not configured. Fully backward compatible.

The normalization basis is `getScreenSize()` — logical points on iOS, physical pixels on Android. The shim runs entirely in `server.ts`; backend files (`android.ts`, `ios.ts`, etc.) are untouched.

### 2. Extended Android install options

`mobile_install_app` now supports Android-specific flags:

| Parameter           | Flag | Description                           |
| ------------------- | ---- | ------------------------------------- |
| `replace`           | `-r` | Replace existing app (default `true`) |
| `grant_permissions` | `-g` | Grant all runtime permissions         |
| `allow_downgrade`   | `-d` | Allow version code downgrade          |
| `allow_test`        | `-t` | Allow test APKs                       |

iOS/simulator silently ignores these options.

### 3. Android-specific tools

| Tool              | Description                                                                                                                                                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mobile_ui_dump`  | Dump the full UI hierarchy as raw XML via `uiautomator`. Unlike `mobile_list_elements_on_screen` (filtered flat JSON), this returns the complete unfiltered XML tree with all node attributes. Use for debugging or when `mobile_list_elements_on_screen` misses elements. Supports `--compressed`. |
| `mobile_adb_pull` | Pull a file from Android device to local filesystem                                                                                                                                                                                                                                                 |
| `mobile_adb_push` | Push a local file to Android device (default restricted to `/sdcard/`, `force=true` to override)                                                                                                                                                                                                    |

### 4. Telemetry disabled by default

Upstream PostHog telemetry is off by default in this fork. Set `MOBILEMCP_ENABLE_TELEMETRY=1` to re-enable.

## Available MCP Tools

### Device Management

- **`mobile_list_available_devices`** - List all available devices (simulators, emulators, and real devices)
- **`mobile_get_screen_size`** - Get the screen size of the mobile device
- **`mobile_get_orientation`** / **`mobile_set_orientation`** - Get/set screen orientation

### App Management

- **`mobile_list_apps`** - List all installed apps
- **`mobile_launch_app`** / **`mobile_terminate_app`** - Launch/terminate apps
- **`mobile_install_app`** - Install app with optional Android flags (-r/-g/-d/-t)
- **`mobile_uninstall_app`** - Uninstall app

### Screen Interaction

- **`mobile_take_screenshot`** / **`mobile_save_screenshot`** - Capture screen
- **`mobile_list_elements_on_screen`** - List UI elements with coordinates (cross-platform)
- **`mobile_click_on_screen_at_coordinates`** - Tap at x,y
- **`mobile_double_tap_on_screen`** - Double-tap at x,y
- **`mobile_long_press_on_screen_at_coordinates`** - Long press at x,y
- **`mobile_swipe_on_screen`** - Swipe in any direction

### Input & Navigation

- **`mobile_type_keys`** - Type text into focused element
- **`mobile_press_button`** - Press device buttons (HOME, BACK, etc.)
- **`mobile_open_url`** - Open URL in browser

### Recording & Debugging

- **`mobile_start_screen_recording`** / **`mobile_stop_screen_recording`** - Screen recording
- **`mobile_list_crashes`** / **`mobile_get_crash`** - Crash reports

### Android Only

- **`mobile_ui_dump`** - Full UI hierarchy XML dump
- **`mobile_adb_pull`** / **`mobile_adb_push`** - File transfer via ADB

## Usage

### MCP server configuration

```json
{
  "mcpServers": {
    "mobile-mcp": {
      "command": "npx",
      "args": ["@qwen-code/mobile-mcp"]
    }
  }
}
```

With relative coordinates enabled:

```json
{
  "mcpServers": {
    "mobile-mcp": {
      "command": "npx",
      "args": ["@qwen-code/mobile-mcp"],
      "env": {
        "MOBILE_MCP_COORDINATE_SPACE": "1"
      }
    }
  }
}
```

### Prerequisites

- **Android**: [Android SDK Platform Tools](https://developer.android.com/tools/releases/platform-tools) (`adb` on PATH)
- **iOS real devices**: [go-ios](https://github.com/danielpaulus/go-ios)
- **iOS simulators**: Xcode with simulator runtimes + [mobilecli](https://github.com/mobile-next/mobilecli) (installed automatically via `mobilewright` dependency)

## License

Apache-2.0 (same as upstream)
