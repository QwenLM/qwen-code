# Computer Use

Qwen Code ships built-in **Computer Use** tools that let the agent drive your desktop — clicking, typing, scrolling, launching apps, reading window contents, and taking screenshots. This turns Qwen Code into a general desktop automation agent, not just a coding assistant confined to the terminal.

Computer Use is powered by the [`cua-driver`](https://github.com/trycua/cua) native driver. The tools are registered as deferred (lazy-loaded) built-ins under the `computer_use__` prefix, so they only cost prompt space once the model actually reaches for them.

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
      "enabled": false
    }
  }
}
```

This setting requires a restart to take effect.

## First run and the native driver

The first time the agent invokes a Computer Use tool, Qwen Code downloads a pinned, signed `cua-driver` binary (~20 MB) into `~/.qwen/computer-use/` and spawns it as a local process. Prebuilt binaries are published for macOS (Apple Silicon and Intel), Linux (x86_64), and Windows (x86_64).

### macOS permissions

On macOS, desktop automation requires two system permissions:

- **Accessibility** — to read window/UI state and synthesize input
- **Screen Recording** — to capture screenshots

On first use the driver walks you through granting these via the standard macOS system dialogs. The agent can also check permission status on demand (the `check_permissions` tool). Because macOS attributes permission grants to the *responsible* process, grants may need to be given to the terminal or IDE that launched Qwen Code.

## What the agent can do

The full `cua-driver` tool surface is exposed. Highlights:

| Category      | Tools (a selection)                                                                 |
| ------------- | ----------------------------------------------------------------------------------- |
| Mouse         | `click`, `double_click`, `right_click`, `drag`, `move_cursor`, `scroll`             |
| Keyboard      | `type_text`, `press_key`, `hotkey`                                                  |
| Windows / UI  | `list_windows`, `get_window_state`, `get_accessibility_tree`, `set_value`, `zoom`   |
| Apps          | `launch_app`, `list_apps`, `bring_to_front`, `kill_app`                             |
| Browser pages | `page` (execute JavaScript, read text, query the DOM, click elements)               |
| Screenshots   | `get_window_state` (captures a PNG), `page`                                         |
| Recording     | `start_recording`, `stop_recording`, `replay_trajectory` (record/replay a session)  |
| Sessions      | `start_session`, `end_session`, agent-cursor overlay controls                       |

Element-addressed actions are preferred over raw pixel coordinates: `get_window_state` returns a Markdown rendering of a window's accessibility tree with a stable `element_index` for each actionable element, which the input tools can target directly.

Support is most complete on macOS; some tools are platform-specific (for example, `bring_to_front` is Windows-only, and `launch_app` targets macOS apps).

## Configuration

All Computer Use settings live under `tools.computerUse` in `settings.json`. See the [Settings reference](../configuration/settings.md) for the authoritative list.

| Setting                            | Type    | Default  | Description                                                                                                                                                                              |
| ---------------------------------- | ------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools.computerUse.enabled`        | boolean | `true`   | Register the `computer_use__*` tools. When `false`, the driver is never downloaded or spawned.                                                                                          |
| `tools.computerUse.maxImageDimension` | number  | `-1`     | Longest-edge pixel cap for screenshots. `-1` keeps the driver's default (1568); `0` disables resizing (full resolution); a positive value caps the longest edge. Lower caps cut vision-token cost. Env override: `QWEN_COMPUTER_USE_MAX_IMAGE_DIMENSION`. |
| `tools.computerUse.idleTimeoutMs`  | number  | `300000` | Milliseconds to keep the driver process alive after the last `computer_use__*` call (default 5 minutes). `0` keeps it running until Qwen Code exits.                                    |

All three settings require a restart to take effect.

## See also

- [Approval Mode](./approval-mode.md) — how tool executions are gated
- [Sandboxing](./sandbox.md) — isolating what tools can touch
- [Settings reference](../configuration/settings.md) — the full `tools.computerUse.*` schema
