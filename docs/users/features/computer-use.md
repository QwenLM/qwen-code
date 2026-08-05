# Computer Use

Qwen Code ships built-in **Computer Use** tools that let the agent drive your desktop — clicking, typing, scrolling, launching apps, reading window contents, and taking screenshots. This turns Qwen Code into a general desktop automation agent, not just a coding assistant confined to the terminal.

Computer Use is powered by the [vendored Qwen CUA driver](https://github.com/QwenLM/qwen-code/tree/main/packages/cua-driver). The tools are registered as deferred (lazy-loaded) built-ins under the `computer_use__` prefix, so they only cost prompt space once the model actually reaches for them.

> [!warning]
>
> Computer Use gives the agent control of your mouse, keyboard, and windows, and lets it read the contents of your screen. Only use it with trusted prompts and, where possible, in a sandboxed or disposable environment. The action tools (click, type, drag, etc.) go through the normal [approval flow](./approval-mode.md); read-only tools such as listing windows may run without a prompt.

## Enabling and disabling

Computer Use is **enabled by default**. The `computer_use__*` tools are registered automatically at startup.

To disable it entirely — which also prevents the native driver from being downloaded or spawned — set `tools.computerUse.enabled` to `false` in your `settings.json`:

```jsonc
{
  "tools": {
    "computerUse": {
      "enabled": false,
    },
  },
}
```

This setting requires a restart to take effect.

## First run and the native driver

The first time the agent invokes a Computer Use tool, Qwen Code downloads a pinned Qwen CUA platform bundle into `~/.qwen/computer-use/` and spawns `qwen-cua-driver` locally. The macOS bundle is signed and notarized. Prebuilt bundles are published for macOS (Apple Silicon and Intel), Linux (x86_64 and arm64), and Windows (x86_64 and arm64).

### macOS permissions

On macOS, desktop automation requires two system permissions:

- **Accessibility** — to read window/UI state and synthesize input
- **Screen Recording** — to capture screenshots

On first use the driver walks you through granting these via the standard macOS system dialogs. The agent can also check permission status on demand (the `check_permissions` tool). Qwen Code registers and launches the downloaded `QwenCuaDriver.app`, so the grants belong to `com.qwencode.cua-driver` rather than the terminal or IDE that launched Qwen Code.

## What the agent can do

The full `cua-driver` tool surface is exposed. Highlights:

| Category     | Tools (a selection)                                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| Mouse        | `click`, `double_click`, `right_click`, `drag`, `move_cursor`, `scroll`                                          |
| Keyboard     | `type_text`, `press_key`, `hotkey`                                                                               |
| Windows / UI | `list_windows`, `get_window_state`, `get_desktop_state`, `verify_state`, `set_window_frame`, `set_value`, `zoom` |
| Apps         | `launch_app`, `list_apps`, `bring_to_front`, `invoke_menu`, `kill_app`                                           |
| Browser      | `get_browser_state`, `browser_prepare`, `browser_navigate`, `browser_click`, `browser_type`, `browser_download`  |
| Clipboard    | `clipboard_read`, `clipboard_write`                                                                              |
| Recording    | `start_recording`, `stop_recording`, `replay_trajectory`                                                         |
| Sessions     | `start_session`, `escalate_session`, `get_session_state`, `end_session`, agent-cursor controls                   |
| Diagnostics  | `health_report`, `check_permissions`, `get_config`, `check_for_update`                                           |

Element-addressed actions are preferred over raw pixel coordinates: `get_window_state` returns structured elements with an `element_token` tied to the current snapshot. Re-snapshot before each action turn because older element handles fail closed after the window state changes. When pixel addressing is necessary, coordinates are absolute screenshot pixels by default; relative coordinates are opt-in via `CUA_DRIVER_RS_COORDINATE_SPACE=1`.

Qwen Code keeps the driver's standard authorization mode and never enables unrestricted mode on your behalf. Operations that require a protected resource grant or embedding authorization host fail closed when that stronger authorization path is unavailable.

Support is most complete on macOS; some tools are platform-specific (for example, `bring_to_front` is Windows-only, and `launch_app` targets macOS apps).

## Configuration

All Computer Use settings live under `tools.computerUse` in `settings.json`. See the [Settings reference](../configuration/settings.md) for the authoritative list.

| Setting                               | Type    | Default  | Description                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools.computerUse.enabled`           | boolean | `true`   | Register the `computer_use__*` tools. When `false`, the driver is never downloaded or spawned.                                                                                                                                                                                                                                              |
| `tools.computerUse.maxImageDimension` | number  | `-1`     | Best-effort longest-edge pixel cap for screenshots. `-1` keeps the driver's default (1568); `0` disables resizing (full resolution); a positive value caps the longest edge. If standard authorization refuses the runtime config change, startup continues with the driver default. Env override: `QWEN_COMPUTER_USE_MAX_IMAGE_DIMENSION`. |
| `tools.computerUse.idleTimeoutMs`     | number  | `300000` | Milliseconds to keep the driver process alive after the last `computer_use__*` call (default 5 minutes). `0` keeps it running until Qwen Code exits.                                                                                                                                                                                        |

All three settings require a restart to take effect.

## See also

- [Approval Mode](./approval-mode.md) — how tool executions are gated
- [Sandboxing](./sandbox.md) — isolating what tools can touch
- [Settings reference](../configuration/settings.md) — the full `tools.computerUse.*` schema
