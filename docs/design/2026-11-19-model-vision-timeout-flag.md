# `/model --vision --timeout`

[English](2026-11-19-model-vision-timeout-flag.md) | [简体中文](2026-11-19-model-vision-timeout-flag.zh-CN.md)

## Problem

The vision bridge gives each transcription attempt a timeout, and a timed-out attempt is retried once with a fresh timeout. The timeout is `visionBridgeTimeoutMs` (built-in 30s). Slow or proxied vision endpoints need a larger value. Today the value can only be changed by editing `settings.json` and restarting, because `Config` reads it once at construction and has no setter. `/model --vision` already selects the bridge model, but it cannot change the timeout.

## Goals

- `/model --vision --timeout <value>` sets the vision bridge timeout. The new value applies to the running session at once and is persisted like the vision model.
- `--timeout` can also be passed with a model id, so the model and the timeout are set in one command.
- Out of scope: configuring the retry count, which stays fixed at one retry after a timeout.

## Design

**Syntax.** The value is a whole number of seconds (`60`). The `s` suffix (`60s`) and the `ms` suffix (`90000ms`) are also accepted. The command converts the value to milliseconds, and the setting stays `visionBridgeTimeoutMs` in milliseconds. The value must be a positive integer number of milliseconds no larger than 2147483647, the largest delay `AbortSignal.timeout` accepts. Fractions, other units, zero and negative values are rejected with an error, and nothing is written.

**Forms.**

| Command                                             | Effect                                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `/model --vision --timeout 60`                      | Sets only the timeout. It does not open the picker in interactive mode.                      |
| `/model --vision qwen-vl-max --timeout 60`          | Sets the model and the timeout. If the model is rejected, the timeout is not written either. |
| `/model --vision` (non-interactive)                 | The readback also shows the current timeout, marked `(default)` when unset.                  |
| `/model --timeout 60`, `/model --fast --timeout 60` | Error: `--timeout` only applies to `--vision`.                                               |

`--timeout` can appear anywhere among the flags. `--project` and `--global` choose the settings scope, as they already do for the vision model. The untrusted-workspace check and the daemon's `persistModelSelection` gate apply unchanged.

**Inline prompts.** `/model <model-id> <prompt>` sends the prompt verbatim. `--timeout` is extracted only when the remaining arguments form a `--vision` invocation, so a prompt that contains `--timeout` is not changed.

**Runtime.** `Config` gains `setVisionBridgeTimeoutMs`. It shares validation with the constructor, so a value the constructor would reject falls back to the built-in default in both places. The bridge reads the getter on every call, so the next image uses the new value.

**Web Shell.** Web Shell handles `/model --vision` on the client: it writes workspace settings through the daemon instead of running the CLI command, and daemon sessions refuse settings writes from `/model` anyway. Without a change, `/model --vision --timeout 60` would store `--timeout 60` as the vision model. Web Shell therefore parses `--timeout` the same way and writes `visionBridgeTimeoutMs` to workspace scope, plus `visionModel` when a model id is given. An invalid value shows an error toast and writes nothing. Like the existing Web Shell `/model --vision <id>`, the write applies to new sessions. The daemon settings route adds `visionBridgeTimeoutMs` to the keys it serves to Web Shell. The setting is `showInDialog: false`, so this list is the only way it is served, and the key also gains a row in the Web Shell settings panel.

**Restart flag.** The setting keeps `requiresRestart: true`. `/config`, Web Shell settings and hand edits write the file without calling the setter, so for those paths a restart is still needed. Only this command updates the running session.

## Files affected

- `packages/core/src/config/config.ts`: shared validation and the setter.
- `packages/core/src/services/visionBridge/vision-bridge-service.ts`: exports the built-in default for the readback.
- `packages/cli/src/ui/commands/modelCommand.ts`: flag parsing, validation, persistence, readback and completion.
- `packages/cli/src/i18n/locales/{en,zh,zh-TW}.js`: new messages.
- `packages/cli/src/serve/routes/workspace-settings.ts`: serves `visionBridgeTimeoutMs` to Web Shell.
- `packages/web-shell/client/vision-timeout-command.ts` and `App.tsx`: Web Shell parsing and settings writes; `settings.ts`, `settings/messages.ts` and the i18n catalogs: alias, label and messages.
- `packages/cli/src/config/settingsSchema.ts`, the generated VS Code settings schema, `docs/users/configuration/settings.md` and `docs/users/features/commands.md`: descriptions.

## Acceptance criteria

- `/model --vision --timeout 60` writes `visionBridgeTimeoutMs: 60000` to the chosen scope and updates the running `Config`.
- `60s`, `90000ms`, and `--timeout` before `--vision` produce the same result as their seconds equivalents.
- Invalid values and `--timeout` without `--vision` return errors and write nothing.
- `/model <model-id> <prompt containing --timeout>` still submits the prompt unchanged.
- The non-interactive `/model --vision` readback lists the current timeout.
- In Web Shell, `/model --vision [<model-id>] --timeout 60` writes `visionBridgeTimeoutMs: 60000` (and `visionModel` when given) to workspace scope, and never writes `--timeout` into `visionModel`.
