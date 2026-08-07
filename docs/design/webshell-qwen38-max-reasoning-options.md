# WebShell qwen3.8-max reasoning options

## Goal

Expose Thinking and reasoning-effort controls in the WebShell composer model
popover when the active model's bare id is exactly `qwen3.8-max`.

The model supports `low`, `medium`, and `xhigh`; its default is `xhigh`.
`qwen3.8-max-preview`, snapshots, and aliases are deliberately excluded.

## Design

The ACP session `configOptions` snapshot is the source of truth for live
sessions. The agent advertises two `thought_level` select options for the
stable model:

- `thinking`: `on` or `off`
- `effort`: `low`, `medium`, or `xhigh`

Changes travel through a daemon session config-option mutation and are echoed
as ACP `config_option_update` notifications. Web clients update their cached
connection state from both the attach snapshot and live notifications.

The persisted defaults remain model settings. `model.reasoningEffort` stores
the last tier and the new `model.thinkingEnabled` stores the switch. Both use
the same writable scope as model selection. Turning thinking off does not erase
the tier. Missing, `high`, and `max` effort values resolve to `xhigh` for this
model, while other models retain the existing five-tier behavior.

Before a live session exists, WebShell writes the two settings through the
workspace settings API. Once attached, it uses the session mutation so the
current session and future sessions stay in sync.

## UI behavior

The existing model chip remains the only entry point. For the exact stable
model, the popover renders Thinking and Effort sections above the searchable
model list. Effort rows remain visible but disabled while Thinking is off.
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
