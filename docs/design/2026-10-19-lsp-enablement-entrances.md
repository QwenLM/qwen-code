# LSP enablement entrances

[English](./2026-10-19-lsp-enablement-entrances.md) | [简体中文](./2026-10-19-lsp-enablement-entrances.zh-CN.md)

## Status

Implemented in the change that adds `tools.lspEnabled`. LSP remains
experimental and off by default.

## Problem

Before this change, LSP could only be enabled by `--experimental-lsp`. The
clients that benefit most from code intelligence build the daemon's argument
list themselves and cannot pass a flag: the Desktop client pins its argv in
Rust. The feature was therefore shipped but unreachable there, and `/lsp` was
not even registered for those hosts.

A second entrance changes what the first one means. `experimentalLsp` is
declared with `default: false`, so an internal Config that passes the flag as
off is indistinguishable from one that never mentioned it. Once a setting can
enable LSP, every host-owned helper Config that relied on "flag off" as a
refusal would start a full set of language servers it can never use.

## Entrances and precedence

One resolver answers for every surface:

1. `QWEN_CODE_DISABLE_LSP=1` — operator kill switch, wins over everything.
2. `--experimental-lsp`.
3. `QWEN_CODE_ENABLE_LSP=1`.
4. `tools.lspEnabled === true`.

The setting is read from the user, system and system-defaults layers only.
`tools.lspEnabled` is listed in `WORKSPACE_RESTRICTED_SETTINGS`, so a
workspace value is stripped before merge, reported as ignored, and refused by
the daemon's settings route. The reason is scope, not preference: enabling LSP
lets a session spawn language servers with the user's own permissions, and a
checked-out repository is not an authorization surface.

The env pair follows the `tools.workflowsEnabled` precedent: a strict `=== '1'`
comparison and the kill switch evaluated first. Both keys are listed in the
project `.env` exclusion list, so a repository's environment file can neither
enable the feature nor clear the switch.

The value is read at startup only (`requiresRestart: true`). The native service
and its subprocesses are constructed while the Config is built, and `/lsp` is
registered when commands load, so a mid-session change cannot attach a client
to a session that started without one.

## Host refusal

A host that owns a Config and never uses LSP sets the runtime-only
`hostPolicy.lspDisabled: true`. It is deliberately not sourced from argv,
settings or the environment: only the embedding host that constructs the
Config may refuse the service, and the refusal must outrank the env pair as
well as the setting.

`lspDisabled` accepts only the literal `true` and never travels through
positional argument lists by itself — `hostPolicy` is the tenth positional
parameter of `loadCliConfig`.

## Host-owned Configs

Every host-owned helper Config must pass `lspDisabled: true`. This rule is the
reason the table below exists: the omission is silent, because the Config
still builds and still works for its own purpose.

| Site                                                                     | Purpose                                                  | Refuses LSP |
| ------------------------------------------------------------------------ | -------------------------------------------------------- | ----------- |
| `packages/cli/src/llm.tsx` — pre-sandbox `partialConfig`                 | Validate authentication before `start_sandbox` hands off | Yes         |
| `packages/cli/src/llm.tsx` — main session Config                         | The interactive or ACP session                           | No          |
| `packages/cli/src/acp-integration/acpAgent.ts` — workspace MCP discovery | Discover MCP servers only                                | Yes         |
| `packages/cli/src/acp-integration/acpAgent.ts` — session Config          | The session the host runs                                | No          |
| `packages/cli/src/serve/hosted-harness-model.ts`                         | One hosted model turn                                    | Yes         |
| `packages/cli/src/serve/hosted-hook-model.ts`                            | One hosted hook operation                                | Yes         |
| `packages/cli/src/serve/hosted-workflow-turn.ts`                         | One hosted workflow turn                                 | Yes         |
| `packages/cli/scripts/opentui-command-parity.ts`                         | Read-only command-surface parity probe                   | Yes         |

A new production `loadCliConfig` call site must decide which row it belongs to.
If it exists to run no tools, it owes the guard.

## Daemon compatibility

`evaluateManagedCompatibility` resolves LSP where the decision is made: after
it reads the settings snapshot and the effective environment it already uses
for the other rules, and with the forwarded `--experimental-lsp` argument
supplied as the flag entrance. No per-runtime field caches the answer, so a
settings write, a runtime-environment swap and a model-provider reload all
reach the next evaluation, and there is no boot-time value to freeze. The
operator kill switch is applied by the same resolver, so a forwarded flag does
not outrank `QWEN_CODE_DISABLE_LSP=1`.

The resolver can still over-report relative to the child: a session host that
refuses LSP on its own terms (read-only agent host, SSH workspace, provisional
workspace, bare or safe mode) is deferred even though it would not start
servers. That is the fail-safe direction — it loses an offload, never certifies
a session that starts processes. An unreadable settings layer returns `unknown`,
which likewise never selects the managed engine.

## Session-side host modes

`loadCliConfig` refuses LSP altogether for a read-only agent host, an SSH
workspace, a provisional workspace, bare mode and safe mode. Safe mode is the
one added by this change: it exists to distrust ambient file-sourced state, and
a workspace `.lsp.json` is exactly that.

## Validation

- Unit: resolver precedence; the setting enabling the service with no flag;
  the kill switch beating flag, env and setting; the host refusal beating both
  the setting and `QWEN_CODE_ENABLE_LSP=1`; safe mode refusing the setting
  entrance; the workspace value being stripped with a warning.
- Wiring: each guarded host-owned Config under `src/` asserts its `hostPolicy`
  argument; `scripts/opentui-command-parity.ts` is a manually run probe and has
  no test. LSP enablement is resolved inside the evaluator from the snapshot it
  reads, so the unit cases cover a settings write that arrives after the
  runtime was constructed.
- Manual: create a daemon session with the setting on and no flag, then read
  `GET /session/:id/lsp`.

## Follow-ups

- `Config.shutdown()` does not stop an LSP client, so a daemon-spawned session
  leaves its language servers to process exit. Tracked separately; the fix
  widens the core `LspClient` interface and `Config.shutdown`.
- The startup execution-sandbox guard in `llm.tsx` still reads the flag only;
  it fails closed through `loadCliConfig`, but the two guards answer different
  questions.
- `docs/design/hot-reload/lsp-runtime-reinitialization.md` still describes the
  flag as the only switch. Correcting it requires authoring its missing zh-CN
  counterpart, so it is a separate documentation change.
