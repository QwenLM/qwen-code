# Model reasoning controls registry

## Goal

Expose model-specific Thinking and reasoning-effort controls without teaching
clients about individual model ids. A built-in Core registry declares which
controls each exact bare model id supports and their defaults.

The model supports `low`, `medium`, and `xhigh`; its default is `xhigh`.
`qwen3.8-max-preview`, snapshots, and aliases are deliberately excluded.

## Design

The registry independently declares optional `thinking` and `effort`
capabilities. An effort registration contains its ordered supported tiers and
default. The first registration is `qwen3.8-max`: Thinking defaults on and
Effort supports `low`, `medium`, and `xhigh`, defaulting to `xhigh`.

The ACP session `configOptions` snapshot is the source of truth for live
sessions. The agent dynamically advertises the registered `thought_level`
options for the active model:

- `thinking`: `on` or `off`
- `effort`: `low`, `medium`, or `xhigh`

Changes travel through a daemon session config-option mutation and are echoed
as ACP `config_option_update` notifications. Web clients update their cached
connection state from both the attach snapshot and live notifications.

The daemon's workspace model catalog carries the same optional capability
metadata so a composer can render controls before a session exists. Older
daemons omit both the capability metadata and `session_reasoning_control`, so
clients retain the model-only picker.

Persisted values live in `model.reasoningPreferences`, keyed by exact bare
model id. Each entry can store `thinkingEnabled` and `effort`. Missing or
invalid values use the registry defaults and never inherit the global
`model.reasoningEffort`; the global setting remains unchanged for unregistered
models. Turning thinking off does not erase the tier. TUI `/effort` keeps its
five-tier picker but normalizes a selection to the registered model's supported
subset before storing it.

Before a live session exists, WebShell merges the selected model's preference
into the map through the workspace settings API. Once attached, it uses the
session mutation so the current session and future sessions stay in sync.

## UI behavior

The existing model chip remains the only entry point. The popover renders each
registered section independently above the searchable model list, supporting
Thinking-only, Effort-only, and combined models. Effort rows remain visible but
disabled while Thinking is off when both controls exist.
Changing an option keeps the popover open. During an active response the
controls remain available; the new value applies to the next request.

Older daemons that do not advertise `session_reasoning_control` keep the
existing model-only popover.

## Local mock environment

The WebShell Playwright mock daemon includes a reasoning-options scenario, so
the UI can be exercised without credentials or a real model request:

```bash
cd packages/web-shell
npm run dev:reasoning-options
```

The command opens a headed browser with the stable model named
`qwen3.8-max`, installs the mock daemon, opens the model popover, and pauses so
Thinking and Effort can be changed manually. Run the stable flow plus the
preview-model and old-daemon fallback cases headlessly with
`npm run test:e2e:reasoning`.
