# Bun Runtime Boundary: App Launcher vs JS Interpreter

[English](bun-runtime-boundary.md) | [简体中文](bun-runtime-boundary.zh-CN.md)

Status: implemented in MYWO-8 S1 (this change). Audience: S2 (Bun PTY), S3
(runtime compat matrix), S4 (packaging), and qoder's PTY integration work.

## Problem

`process.execPath` conflates two distinct identities:

- the **app launcher** — how a subprocess reaches _this build_ of the CLI;
- the **JS interpreter** — the binary that runs an arbitrary JavaScript file
  or `-e` snippet as a child.

They agree today (npm: host Node; standalone: the bundled runtime launches
`lib/cli-entry.js`, so `process.execPath` is always a JS interpreter). They
diverge the moment a compiled-app flavor (`bun build --compile`) exists:
`process.execPath` becomes the application binary, which cannot run arbitrary
JS files. Every worker spawn that re-reads `process.execPath` directly would
break at once and silently. The Bun runtime migration (MYWO-8) is exactly the
project that will introduce that flavor, so the boundary must be explicit
before S2/S3/S4 build on it.

## Current state: call-site inventory

The conceptual tables originated at `main`
`d8558bba0198c1cdadac1523940c88c04b038f62`. They are not exhaustive;
the fixed-parent literal call-site audit below supplements them with every
scoped occurrence and its exclusions. Classification does not prove migration
or compatibility.

### App launcher identity (how to re-invoke this build)

| Site                                                                                  | Mechanism                                                                                                                                | Notes                                                      |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `scripts/cli-entry.js`                                                                | stamps `QWEN_CODE_CLI` (shim path when `QWEN_CODE_LAUNCHER_PATH` set, else the entry file); captures + deletes `QWEN_CODE_LAUNCHER_PATH` | the launcher source of truth                               |
| `packages/core/src/services/shellContextEnv.ts`                                       | propagates `QWEN_CODE_CLI` into shell subprocess env; blanks a set-but-unusable script entry                                             | consumers use `"${QWEN_CODE_CLI:-qwen}"`                   |
| `packages/cli/src/cli.ts` (`getShellContextEnvVars` wiring)                           | same env propagation for every shell the CLI spawns                                                                                      |                                                            |
| `packages/cli/src/serve/routes/daemon-update.ts`                                      | reads `QWEN_CODE_CLI` as the bootstrap for update relaunch                                                                               |                                                            |
| `packages/cli/src/commands/review/**`                                                 | `"${QWEN_CODE_CLI:-qwen}" review …` self-invocation in agent prompts                                                                     | launcher identity, pinned by tests                         |
| `scripts/cli-entry.js` `relaunchAfterUpdate()`                                        | `findLauncher()` prefers `QWEN_CODE_LAUNCHER_PATH`, then PATH scan scored by install prefix                                              | update relaunch                                            |
| `packages/cli/src/utils/relaunch.ts` (`relaunchAppInChildProcess`)                    | supervised relaunch: `spawn(process.execPath, [execArgv, argv[1], args], ipc)`; `process.execve` variant when available                  | same-interpreter fallback of the launcher                  |
| `packages/cli/src/utils/processUtils.ts` (`relaunchApp`)                              | `execve(process.execPath, [execPath, execArgv, argv…])`                                                                                  | same-interpreter fallback                                  |
| `packages/core/src/agents/arena/ArenaManager.ts`                                      | `command: process.execPath, args: [resolve(argv[1]), …]` per arena agent                                                                 | app re-invocation in a worktree; must stay launcher-shaped |
| `packages/cli/src/serve/managed-runtime-session-worker.ts` (`currentCliWorkerLaunch`) | `command: process.execPath, args: [execArgv, QWEN_CLI_ENTRY \|\| argv[1], 'managed-runtime-worker']`                                     | app re-invocation                                          |
| `packages/cli/src/commands/review/run.ts` (agent runner spawn)                        | `process.execPath` + entry                                                                                                               | app re-invocation                                          |

### JS interpreter identity (how to run an arbitrary JS child)

| Site                                                                  | Use                                                                                                                             | Wired to `getJsInterpreterCommand` in this change           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `packages/core/src/code-mode/host-client.ts` (`hostCommand`)          | code-mode host child (`host.js` / bundled `codeModeHost.js`; dev: `--import tsx host.ts`)                                       | yes                                                         |
| `packages/core/src/sandbox/file-worker-client.ts`                     | sandbox file-worker child (`sandboxAsset('file-worker')`)                                                                       | yes                                                         |
| `packages/core/src/hooks/hookRunner.ts` (surviving-hook supervisor)   | `spawn(--input-type=commonjs --eval SUPERVISOR …)`, detached                                                                    | yes                                                         |
| `packages/core/src/hooks/hook-command-cgroup.ts` (`launch`)           | cgroup-v2 launcher child (`--input-type=commonjs --eval LAUNCHER …`) running the hook under its delegated unit                  | not yet (S3) — Linux only (cgroup v2 platform guard)        |
| `packages/core/src/sandbox/bwrap-execution.ts` (`executeBwrap`)       | stages the interpreter (`realpathSync(process.execPath)`) into the bubblewrap allowlist; the relay spawns the JS relay under it | not yet (S3) — Linux only (bubblewrap)                      |
| `packages/core/src/sandbox/landlock-execution.ts` (`executeLandlock`) | stages the interpreter into the landlock allowlist; the relay spawns the JS relay under it                                      | not yet (S3) — Linux only (landlock LSM)                    |
| `packages/core/src/utils/getPty.ts` (`loadPty`)                       | Bun detection for the PTY gate (PTY disabled under Bun today — **S2 replaces this branch with a real backend**)                 | detection via `isBunRuntime()`                              |
| `packages/cli/src/config/mem0-settings.ts` (`bundledMem0Server`)      | bundled mem0 MCP child; identity check `server.command !== process.execPath`                                                    | not yet; must migrate with its identity check together (S3) |
| `packages/core/src/agents/arena/ArenaManager.ts`                      | (also) worker-side in-process runtime                                                                                           | launcher-shaped, see above                                  |
| `packages/cli/src/serve/pem-certificate-blocks.ts`                    | helper child spawn                                                                                                              | not yet (S3 sweep)                                          |
| `packages/cli/src/commands/review/test-efficacy.ts`                   | spawns vitest via `process.execPath` (dev-tooling path)                                                                         | intentionally not; host-tool identity                       |

Rows marked `not yet` are owned by the **S3 migration sweep** (V8/GC/TLS/env
compatibility stage), which uses this table as its checklist. The
cgroup/bwrap/landlock rows are **Linux-only** mechanisms (platform-guarded or
inert on macOS/Windows), so their migration is validated against the Linux
targets of the platform matrix; the mem0 and pem rows apply on every
platform.

### Update / install identity (must stay host-Node)

| Site                                                                   | Notes                                                                                                                                              |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/utils/managed-npm-update.ts`                         | runs npm's `cli.js` via `process.execPath`; npm **must** run under a Node identity, never the private bundled Bun — keep host Node resolution here |
| `packages/cli/src/ui/handleAutoUpdate.ts`                              | picks the update command; Node-identity path                                                                                                       |
| `packages/cli/src/serve/daemon-update-restart.ts`                      | already disabled under Bun (`process.versions['bun']`) and execve-feature-detected                                                                 |
| `packages/cli/src/utils/installationInfo.ts`                           | defaults npm CLI path resolution to `process.execPath` (host Node)                                                                                 |
| `scripts/build-standalone-release.js` / `create-standalone-package.js` | pin Bun 1.3.14, five targets, `manifest.json` (`runtime`, version); layout `bun/bin/bun`, `node/bin/node`                                          |

### Complete literal call-site audit at the fixed parent

The tables above are a historical conceptual grouping, not an exhaustive list.
This table accounts for every executable literal `process.execPath` read in
`packages/**/src/**` at parent
`8b4a0a25ea2bc570a1a6070e05182f29501a1b7f`: 34 files, 48 occurrences.
Line numbers refer to that parent; different roles within a file are explicit.
The sweep excludes comments, `*.test.*`, `*.spec.*`, `__tests__`, `test`
directories, `*test-helper*`, and `acceptance` directories; exceptions are
accounted for below. This is source classification, not platform or compiled
artifact compatibility evidence, nor an audit of every implicit fork, alias,
external command, or native spawn. Repeat this scoped sweep after changes.

| Fixed source location (all lines)                                      | Identity, current behavior and follow-up scope                                                                                                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/acp-bridge/src/spawnChannel.ts:554`                          | Launcher: ACP CLI child with heap arguments; not migrated (S4).                                                                                                             |
| `packages/browser-use/src/native-host-installer.ts:378`                | Interpreter: persists the native-host runtime in its shell launcher; not migrated (S3); installation lifetime and host compatibility need validation.                       |
| `packages/channels/base/src/AcpBridge.ts:141`                          | Launcher: CLI entry with --acp and inherited runtime flags; not migrated (S4).                                                                                              |
| `packages/cli/src/agent-view/current-cli-argv.ts:27,34`                | Launcher: development tsx entry (27), ordinary entry (34); neither migrated (S4).                                                                                           |
| `packages/cli/src/commands/review/run.ts:602`                          | Launcher: CLI review agent with --expose-gc; not migrated (S4).                                                                                                             |
| `packages/cli/src/commands/review/test-efficacy.ts:1849`               | Host tooling: local Vitest entry; intentionally retains its test host, outside app-interpreter migration.                                                                   |
| `packages/cli/src/commands/sandbox.ts:228`                             | Interpreter: sandbox -e diagnostic, realpath allowlist; not migrated (S3, Linux).                                                                                           |
| `packages/cli/src/config/mem0-settings.ts:153,208`                     | Interpreter: MCP child (153) and matching identity check (208); migrate together (S3), neither changed here.                                                                |
| `packages/cli/src/serve/channel-worker-supervisor.ts:1119`             | Launcher: channel daemon-worker entry with IPC; not migrated (S4).                                                                                                          |
| `packages/cli/src/serve/daemon-update-restart.ts:99,100`               | Launcher: execve executable and argv[0]; Bun-disabled path, not compiled-app support (S4).                                                                                  |
| `packages/cli/src/serve/local-process-runtime-activator.ts:315`        | Launcher: configured managed-runtime entry arguments; not migrated (S4).                                                                                                    |
| `packages/cli/src/serve/managed-runtime-session-worker.ts:250`         | Launcher: managed-runtime-worker entry; not migrated (S4).                                                                                                                  |
| `packages/cli/src/serve/pem-certificate-blocks.ts:83`                  | Interpreter: CommonJS PEM oracle; not migrated (S3); runtime crypto semantics remain to be verified.                                                                        |
| `packages/cli/src/serve/run-qwen-serve.ts:913`                         | Interpreter: module eval TLS trust probe; not migrated (S3); preserve Node/Bun TLS distinctions.                                                                            |
| `packages/cli/src/serve/session-agents/orchestrator.ts:631`            | Launcher: agents session-send-mcp entry; not migrated (S4).                                                                                                                 |
| `packages/cli/src/ui/handleAutoUpdate.ts:124`                          | Host Node: npm update command; retain host identity, not private Bun (S3 validation pending).                                                                               |
| `packages/cli/src/ui/utils/updateCheck.ts:148`                         | Host Node: npm update-check runner default; retain host identity (S3 validation pending).                                                                                   |
| `packages/cli/src/utils/installationInfo.ts:27`                        | Host Node: default for npm CLI path resolution, not merely informational; retain with npm consumers.                                                                        |
| `packages/cli/src/utils/managed-npm-update.ts:118,120,137,188,329,331` | Host Node: npm config/path resolution (118/120/137), staged CLI health launch (188), npm install and path lookup (329/331); retain host identity, validate each stage (S3). |
| `packages/cli/src/utils/processUtils.ts:68,69`                         | Launcher: execve executable and argv[0]; not migrated for compiled apps (S4).                                                                                               |
| `packages/cli/src/utils/relaunch.ts:167,168,190`                       | Launcher: execve executable/argv[0] (167/168), supervised IPC spawn fallback (190); not migrated for compiled apps (S4).                                                    |
| `packages/core/src/agents/arena/ArenaManager.ts:1096`                  | Launcher: argv[1] in agent worktree; not migrated (S4).                                                                                                                     |
| `packages/core/src/hooks/hook-command-cgroup.ts:166`                   | Interpreter: CommonJS eval cgroup launcher; not migrated (S3, Linux cgroup v2).                                                                                             |
| `packages/core/src/sandbox/bwrap-execution.ts:41`                      | Interpreter: realpath staging for JS relay; not migrated (S3, Linux bubblewrap).                                                                                            |
| `packages/core/src/sandbox/landlock-execution.ts:113`                  | Interpreter: realpath staging for JS relay; not migrated (S3, Linux landlock).                                                                                              |
| `packages/core/src/utils/runtime-info.ts:175`                          | Interpreter resolver fallback: host executable on rejected/missing manifest; implemented S1, compiled flavor unsupported.                                                   |
| `packages/mobile-mcp/src/server.ts:189`                                | Information: telemetry identity hash input; no child launch, intentionally outside migration.                                                                               |
| `packages/node-repl/src/desktop-relay/cli.ts:89,174,192`               | Mixed: npm host interpreter (89); persisted launchd relay app entry (174, S4 pending); permission guidance text (192, informational). Do not replace all three blindly.     |
| `packages/node-repl/src/desktop-relay/runtime.ts:53`                   | Interpreter: node-repl package entry, not Qwen CLI launcher; not migrated (S3), package/runtime boundary must be preserved.                                                 |
| `packages/node-repl/src/kernel-manager.ts:567`                         | Interpreter: VM kernel with experimental flags and fd3/fd4 protocol; host Node contract, no automatic Bun substitution (S3 compatibility pending).                          |
| `packages/sdk-typescript/src/utils/cliPath.ts:313,340`                 | Launcher: bundled CLI default (313); interpreter: explicit JS executable (340). SDK-host identity, intentionally no private-Bun override; compiled handling pending S4.     |
| `packages/vscode-ide-companion/src/extension.ts:409`                   | Launcher: extension-host CLI terminal command; preserve Electron/VSCode environment contract, not private Bun (S4 pending).                                                 |
| `packages/vscode-ide-companion/src/services/acpConnection.ts:109`      | Launcher: extension-host ACP entry; preserve Electron run-as-Node contract (S4 pending).                                                                                    |
| `packages/vscode-ide-companion/src/services/qwenDaemonProcess.ts:76`   | Launcher: extension-host serve entry; preserve Electron run-as-Node contract (S4 pending).                                                                                  |
| `scripts/cli-entry.js:476,488`                                         | Launcher: Bun/Windows `spawnSync(--expose-gc, cliPath)` branch and error text; not migrated for compiled apps (S4), not interpreter-selector wiring.                        |
| `scripts/dev.js:237`                                                   | Development host interpreter selection; intentionally retains the development tool host, outside standalone production migration.                                           |

Scope exceptions: literal matches in `packages/sdk-typescript/src/transport/ProcessTransport.ts` are comments; its actual `forkOptions.execPath` consumes the selection from `cliPath.ts` and needs joint SDK/Electron contract validation. The `execPath` parameter reads at `channel-worker-supervisor.ts:196,271,280` consume the 1119 call in the table. Other literal matches in `core/src/utils/runtime-info.ts` are comments.

Intentional production-migration exclusions: `packages/cli/src/serve/cdp-tunnel/acceptance/run-real-chrome.mjs:95,112,129` is an acceptance driver; `packages/cli/src/serve/managed-runtime-tool-v3-host.test-helper.ts:44` is a test helper; all tests/fixtures and `packages/sdk-java/**/src/test/**` are host tests. Remaining matches in `packages/**/scripts/**`, package-root `build.mjs`, and `scripts/**` are build, packaging, development, benchmark, sandbox prototype, lint or E2E drivers. They retain their tool host and are not migrated application sites. Script spawns in `scripts/build-standalone-release.js` are build-host behavior, not proof that generated archives run. Runtime strings in packaging scripts are layout configuration requiring separate unmodified-archive acceptance.

The three S1 selector consumers are `core/src/code-mode/host-client.ts`, `core/src/sandbox/file-worker-client.ts` and `core/src/hooks/hookRunner.ts` (each under `packages/`). They no longer read `process.execPath` directly and remain part of the inventory despite no literal match. `getPty.ts` detects the runtime; it does not spawn an interpreter. S3/S4 designate pending work, not submitted or approved migrations; kernel, npm, SDK and extension hosts must not all be replaced with private Bun.

### SDK consumers

`@qwen-code/qwen-code-core` used as a library (SDK hosts) runs under the
host's own runtime. SDK code paths must not force the Bun interpreter on a
Node host: `getJsInterpreterCommand` only deviates from `process.execPath`
when a standalone `manifest.json` exists in the package layout, which npm and
source installs do not have.

## Contract

### 1. App launcher

- `scripts/cli-entry.js` remains the only writer of `QWEN_CODE_CLI`;
  `getShellContextEnvVars` propagates it. Self-invocation uses
  `"${QWEN_CODE_CLI:-qwen}"` in shells, or the stamped value for direct
  spawns.
- Re-invoking the app _inside_ the same process tree (relaunch, managed
  workers, arena agents) keeps the same-interpreter fallback
  `process.execPath + process.argv[1]`, because the entry is a JS file in
  every shipped layout. A compiled flavor must publish its launcher through
  `QWEN_CODE_CLI` before those sites can change — they are pinned by the
  inventory above as source locations, not verified compiled-app behavior.

### 2. JS interpreter — `packages/core/src/utils/runtime-info.ts`

- `isBunRuntime(): boolean` — single runtime-detection point.
- `getJsInterpreterCommand(importMetaUrl): { command, runtime }` — resolves
  the interpreter for arbitrary-JS children:
  1. The only trusted location is the **standalone package root**: the
     parent of the caller's bundle directory (`resolveBundleDir`), which
     must hold BOTH a `manifest.json` and the standalone entry marker
     `lib/cli-entry.js`. There is **no upward traversal** — an unrelated
     ancestor manifest (an npm host project's build manifest) can never be
     picked up, so npm, source and SDK layouts always keep
     `process.execPath`.
  2. Within that trusted root every declaration is validated before use:
     `runtime` must be exactly `'bun'` or `'node'`, and the interpreter —
     the `interpreter` field resolved against the package root (absolute paths
     are used as-is; no containment is enforced), else the
     standard `bun/bin/bun` / `node/bin/node` location — must be an existing
     regular file. POSIX additionally requires execute permission; Windows
     checks regular-file existence only, not PE validity or launchability.
     The Windows default paths are `bun/bun.exe` and `node/node.exe`.
  3. Any invalid or missing declaration — non-object manifest, unknown
     `runtime`, non-string `interpreter`, missing binary, directory,
     non-executable POSIX file, missing entry marker — falls back to
     `process.execPath`, the interpreter running this process (host Node,
     bundled Node, or the private bundled Bun). The resolution never
     guesses at a different binary and never throws.
- `runtime` is metadata with no current production read site: the three
  migrated callers consume only `command`. Runtime-specific consumers,
  including any future S3 use of this field, are not implemented here.
- Result memoized per process: the first caller's URL determines resolution;
  later caller URLs are ignored. Current production callers share one
  installation root. `resetJsInterpreterCacheForTests()` clears the cache.
- The sandbox file-worker selects this interpreter, but bwrap/landlock still
  stage `realpathSync(process.execPath)` in their allowlists. That coupling
  remains an unimplemented S3 migration; this PR does not establish support
  for layouts where the resolved interpreter differs from the staged binary.
- Supported scope: **interpreter-based Node/Bun distributions**. Rejection
  returns `process.execPath`, which would be the application binary in a
  compiled build. This PR does not support compiled applications or provide
  a compiled-artifact producer. That future flavor needs explicit interpreter
  packaging and separately verified failure behavior before adoption; the
  present fallback does not guarantee a usable interpreter in that flavor.

Migration rule: any new code that spawns a JS file or `-e` snippet as a child
goes through `getJsInterpreterCommand`; sites that re-invoke the app go
through `QWEN_CODE_CLI` / the entry fallback.

## Cross-runtime test coverage

`packages/core/src/utils/runtime-boundary.node-bun.test.ts` runs the same
fixture under Node and an available Bun interpreter. It covers identity and
stdio JSON framing, exit-code propagation, POSIX SIGTERM handling, IPC
round-trips with explicit shutdown, `--expose-gc`, and
`--input-type=commonjs --eval`. These are test contracts, not a claim that all
platforms or packaged artifacts have passed. Windows skips the catchable
SIGTERM case. An absent Bun binary skips the Bun leg; record the actual
runtime versions and skips when reporting a run. The shipped Bun 1.3.14 pin
and standalone artifacts require separate packaging acceptance.

This fixture does not probe `process.execve`, native PTY loading, fd-3 status
pipes or process-group signaling. `process.execve` feature detection at
relaunch sites and Bun gating in `getPty` are source mechanisms, not results
from this matrix. Native PTY and process-tree behavior need their own real
process and artifact evidence.

## Validation plan

- `packages/core/src/utils/runtime-info.test.ts` — manifest resolution,
  fallbacks, memoization.
- `packages/core/src/utils/runtime-boundary.node-bun.test.ts` — the
  same-fixture coverage described above; the Bun leg skips when no Bun
  binary exists. A skipped leg is not a compatibility pass.
- S2/S3 consume the inventory tables as their migration checklist; S5 reruns
  the matrix on the real archives per the MYWO-8 acceptance protocol.

## Open questions

- `ArenaManager` / managed-worker relaunch under a future compiled flavor:
  the launcher must be published by the compiled package (`QWEN_CODE_CLI`),
  and the same-interpreter fallback sites above need a launcher-shaped
  migration. Tracked for S4.
- `mem0-settings.ts` identity check couples `command === process.execPath`;
  migrate it together with its spawn site in S3 so the identity cannot drift
  from the launcher.
