# Persist `max-sessions` in `settings.json`

[English](2026-10-24-serve-max-sessions-setting.md) | [简体中文](2026-10-24-serve-max-sessions-setting.zh-CN.md)

## Problem

`qwen serve --max-sessions` is only reachable from the command line. A daemon
restart therefore has to repeat the flag, and a deployment that does not keep a
launch script (a one-off `nohup` line, a container entrypoint assembled by
hand) silently returns to the built-in cap of 32. The `serve` settings section
already persists `serve.channels`, `serve.tokenQr`, and the sub-session
concurrency caps, but not the per-workspace session cap operators most often
need to size.

## Current state

- `packages/cli/src/commands/serve.ts` declares `--max-sessions` with
  `default: 32`, so the yargs result cannot distinguish "flag omitted" from
  "flag passed as 32".
- `runQwenServe` forwards that value to every workspace runtime, and
  `deriveDefaultMaxTotalSessions` uses it to derive a daemon-wide total cap
  when several workspaces are registered.
- `serve.tokenQr` is the existing precedent for a serve setting: the flag has
  no default, the value resolves at daemon boot from the fast-path settings
  summary, and only operator-owned scopes may set it.

## Goals and non-goals

Goals:

- Let `serve.maxSessions` in `settings.json` set the per-workspace cap.
- Preserve `--max-sessions` as the highest-precedence source.
- Keep a workspace settings file from raising a daemon-wide resource cap.
- Report an invalid value instead of silently disabling backpressure.

Non-goals:

- Persisting other serve limits (`max-total-sessions`, `max-connections`,
  `event-ring-size`, ...). Each needs its own precedence and scope review.
- Changing the built-in default of 32.

## Proposed solution

Resolution order: `--max-sessions` → `serve.maxSessions` → `32`.

1. Remove `default: 32` from the yargs option so an omitted flag stays
   `undefined`; keep the effective default in the description and docs.
2. In the serve fast-path reader, pick `serve.maxSessions` from user, system,
   and system-defaults scopes only. A workspace file that sets it is reported
   through `ignoredWorkspaceKeys` and never contributes the value.
3. Register `serve.maxSessions` in `WORKSPACE_RESTRICTED_SETTINGS` so the full
   settings loader strips it from workspace scope, warns about it, and the
   settings dialog filters it.
4. At daemon boot, when `opts.maxSessions` is still `undefined`, resolve it
   from `bootSettings.serve.maxSessions` before bridge construction and before
   `deriveDefaultMaxTotalSessions`.
5. Accept a non-negative integer or `Infinity`; `0` disables the cap. Any
   other value is reported on stderr and treated as absent.
6. Expose the setting in the Web Shell settings panel: add `serve.maxSessions`
   to the daemon's `WEB_SHELL_SETTINGS` allowlist (it is `showInDialog: false`,
   so the dialog allowlist does not carry it) and publish a presentation alias
   in the Web Shell client. The panel can read and write it at user scope; a
   workspace-scope write still returns the existing
   `workspace_restricted_setting` refusal.

## Design decisions

- **Resolve at boot, not in the yargs handler.** The daemon has a fast path
  that does not go through the command handler, and `serve.tokenQr` already
  resolves from `bootSettings` for that reason. One resolution point keeps
  both paths identical.
- **Operator-owned scopes only.** The cap bounds per-workspace memory and file
  descriptors. A cloned repository must not be able to raise it, matching the
  rule already applied to `serve.maxConcurrentSubSessions*`.
- **Warn and fall back on invalid values.** The bridge already throws on `NaN`
  and negative values. Reusing that failure for a hand-edited settings file
  would take the daemon down; falling back to the default keeps the existing
  cap and names the typo. This matches the sub-session cap reader.
- **Keep the default visible.** Removing the yargs default must not change the
  advertised capability: `advertisedMaxSessions(undefined)` already returns
  `32`, and the schema keeps `default: 32` for editors and `/settings`.

## Risks

- An operator who relied on `--max-sessions` appearing in shell completions as
  a default sees it omitted instead; the description still states the default.
- A workspace value is ignored. The boot path reports the dropped key on
  stderr, so the behavior is visible rather than silent.
- The `serve.maxSessions` default in the schema must stay in sync with
  `DEFAULT_MAX_SESSIONS` in `acp-bridge` and `serve-features.ts`.

## Validation

- Unit tests: fast-path scope selection and merge precedence; invalid-value
  handling; yargs parsing with and without the flag.
- `cd packages/cli && npx vitest run src/serve/fast-path.test.ts
src/serve/run-qwen-serve.test.ts src/commands/serve.test.ts
src/config/settingsSchema.test.ts`
- `npm run typecheck` and `npm run lint`.

## Acceptance criteria

- With `serve.maxSessions: 64` in user settings and no flag, `qwen serve`
  advertises and enforces 64.
- With both the flag and the setting, the flag wins.
- With the setting only in a workspace `.qwen/settings.json`, the daemon uses
  the default 32 and logs the ignored key.
- With `serve.maxSessions: -1`, the daemon starts on the default and warns.
- The Web Shell settings panel lists the row under Advanced, shows the restart
  badge after a save, and refuses a workspace-scope write with the existing
  restriction error.
- No change to the other serve limits or to the multi-workspace total-cap
  derivation beyond using the resolved per-workspace value.
