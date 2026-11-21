# Telemetry: Channel Attribution for Daemon Sessions

[English](telemetry-runtime-client-attribution-design.md) | [简体中文](telemetry-runtime-client-attribution-design.zh-CN.md)

> Related issue: [#8660](https://github.com/QwenLM/qwen-code/issues/8660)
> Based on a code review of the qwen-code main branch on 2026-08-07
> Extended 2026-11-21: Managed Agent (`managed`) attribution, see section 2 "Managed Agent attribution"

## 1. Background

The default usage-statistics (qwen-logger RUM) payload has a single entry-point dimension, `properties.channel`, which comes from the `--channel` flag:

- The VS Code companion launches `qwen --acp --channel=VSCode` directly.
- The Electron desktop app launches `qwen --acp --channel=desktop` directly.
- The TS/Python/Java SDK main entry (`query()`) spawns the CLI directly (stream-json mode) and passes `--channel=SDK` itself.
- When `--acp` is given without an explicit channel, the fallback is `ACP` (the ACP fallback in `packages/cli/src/config/config.ts`).

But the `qwen serve` (daemon) spawn factory starts `qwen --acp` children without a channel (`packages/acp-bridge/src/spawnChannel.ts`), so **every daemon-hosted session — the SDK daemon client entries (such as the TS SDK's `DaemonClient`/`DaemonSessionClient`), Web Shell, and the Tauri desktop shell — reports `ACP`**, with no way to tell them apart. The Tauri shell sets `QWEN_CODE_DESKTOP=1` when it starts the daemon (`packages/desktop/src-tauri/src/runtime.rs`), but telemetry never read that variable.

`app.channel` is the **installation source** from `~/.qwen/source.json`; it is a different concept from entry-point attribution and must not be overloaded.

## 2. Solution

Reuse the existing `properties.channel` dimension; add no payload keys. A review confirmed `getChannel()` has no behavioral consumers (only telemetry reads it), so channel is a pure reporting dimension and extending its values has no side effects.

The daemon sets a `QWEN_CODE_SERVE=1` marker in every child's environment, covering both spawn sites:

- `packages/acp-bridge/src/spawnChannel.ts` (ACP session children)
- `packages/cli/src/serve/channel-worker-supervisor.ts` (channel workers; inside a worker, `channels/base/AcpBridge.ts` keeps inheriting the marker through `{...process.env}`)

The CLI's ACP channel fallback (`packages/cli/src/config/acp-channel-fallback.ts`) resolves by marker:

| Condition                     | channel value                                                          |
| ----------------------------- | ---------------------------------------------------------------------- |
| Explicit `--channel=X`        | `X` (unchanged; the explicit flag wins)                                |
| `QWEN_CODE_MANAGED_RUNTIME=1` | `managed` (the Managed Agent's Hosted Harness and its children)        |
| `QWEN_CODE_DESKTOP=1`         | `desktop` (Tauri shell sessions, the same client identity as Electron) |
| `QWEN_CODE_SERVE=1`           | `daemon` (daemon-hosted sessions)                                      |
| Otherwise                     | `ACP` (direct third-party ACP launches, unchanged)                     |

Attribution matrix:

| Scenario                                                      | properties.channel                   |
| ------------------------------------------------------------- | ------------------------------------ |
| Interactive/headless CLI                                      | (none)                               |
| Direct third-party ACP                                        | `ACP`                                |
| VS Code companion                                             | `VSCode`                             |
| Electron desktop (direct, not through the daemon)             | `desktop`                            |
| SDK `query()` direct (TS/Python/Java, not through the daemon) | `SDK` (passed by the SDK, unchanged) |
| Daemon sessions (SDK daemon clients, Web Shell, etc.)         | `daemon`                             |
| Daemon sessions (Tauri desktop shell)                         | `desktop`                            |
| Managed Agent sessions (Hosted Harness, both engines)         | `managed`                            |
| Daemon sessions inside a docker/podman sandbox                | inherits outer `daemon`/`desktop`    |
| Daemon channel workers                                        | worker name (e.g. feishu, unchanged) |

### Managed Agent attribution (`managed`)

The Managed Agent's session host is the Hosted Harness daemon (`qwen serve --profile hosted-harness`), operated by the Java `managed-agent-server` through the Runtime Broker. At boot (`run-qwen-serve.ts`, before the base env freeze) it stamps `QWEN_CODE_MANAGED_RUNTIME=1` into its own `process.env` and restores the previous value on close (an embedded caller keeps no leftover marker). Both session execution paths therefore attribute as `managed`:

- **Managed engine**: Hosted turns run inside the harness process. Each turn builds its Config through `loadCliConfig` with a synthesized argv (`acp: true`, no channel) that never passes through `parseArguments`. `loadCliConfig` applies the same fallback to ACP argv without an explicit channel, so reading the marker reports `managed`.
- **Legacy engine**: the `qwen --acp` children the harness spawns through `createSpawnChannelFactory` inherit the marker (alongside the daemon's `QWEN_CODE_SERVE=1`); in the fallback, `managed` wins over `daemon`.

Tool execution workers (`qwen managed-runtime-worker`) produce no session telemetry and are not stamped.

## 3. Why daemon sessions cannot pass `--channel` directly like VS Code

The VS Code companion **owns its spawn**: one client = one dedicated child, so it can pass `--channel=VSCode`.

The daemon's bridge model is different (`packages/acp-bridge/src/bridge.ts`):**one bridge (one workspace) has at most one `qwen --acp` child**, and every client's sessions multiplex onto that same process through `connection.newSession()`, sharing the process/OAuth/FileReadCache. Therefore:

- at spawn time it is unknown which clients will connect (the child may be preheated);
- sessions from different clients run in the same process at the same time, so a process-level flag cannot express session-level identity;
- the qwen-logger payload is built at process level, so a process-level channel cannot distinguish clients per session.

Environment markers plus fallback resolution are therefore the only process-level attribution mechanism available under the current model.

## 4. Schema impact and compatibility

- Zero new keys. `properties.channel` only gains possible values: `daemon`, `managed` (`desktop` is an existing value; Tauri shell sessions fold into it).
- `app.channel` semantics and values are unchanged; the existing explicit `--channel` values (`VSCode`/`desktop`/`SDK`/worker names) are unchanged.
- `QWEN_CODE_SERVE` / `QWEN_CODE_MANAGED_RUNTIME` are informational markers carrying no sensitive data; they do not enter `SCRUBBED_CHILD_ENV_KEYS` (denylist semantics are unaffected).
- docker/podman sandboxes explicitly pass through `QWEN_CODE_SERVE` / `QWEN_CODE_DESKTOP` / `QWEN_CODE_MANAGED_RUNTIME` so children inside the sandbox do not fall back to `ACP`; project `.env`/`settings.env` cannot set these three markers, so a workspace cannot spoof client attribution.
- `qwen daemon start`'s `START_ENV_DROP` discards `QWEN_CODE_MANAGED_RUNTIME`: a new daemon started from inside a Managed session is an independent daemon, not a Hosted Harness worker.

## 5. Follow-up work (out of scope here)

Splitting clients further by SDK/Web Shell requires **session-level** attribution: each client self-declares through the daemon when it creates a session. The existing `qwen.session.source` meta → `config.setSessionSource(sourceType, sourceId)` pipeline (introduced by #8155 for lifecycle hooks) is the natural extension point. Today the Web Shell main session only uses `sourceType: 'default'`. Because the default payload is process-level, landing session-level identity in telemetry also needs session-dimension support; whether to introduce a separate client key can be decided then.
