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

Baseline audited: `main` `d8558bba0198c1cdadac1523940c88c04b038f62`
(diff vs plan baseline `5aae8991bede…` touches none of the files below).
Classified by which identity the site actually needs.

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
| `packages/cli/src/utils/installationInfo.ts`                           | reports `process.execPath` as the node path (informational)                                                                                        |
| `scripts/build-standalone-release.js` / `create-standalone-package.js` | pin Bun 1.3.14, five targets, `manifest.json` (`runtime`, version); layout `bun/bin/bun`, `node/bin/node`                                          |

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
  inventory above.

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
     the `interpreter` field resolved against the package root, else the
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
- Result memoized per process; `resetJsInterpreterCacheForTests()` clears it.
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
