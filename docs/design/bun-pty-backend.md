# Bun PTY Backend: `qwen-bun-pty`

[English](bun-pty-backend.md) | [简体中文](bun-pty-backend.zh-CN.md)

Status: implemented in MYWO-8 S2. Builds on the runtime boundary from S1
([bun-runtime-boundary.md](bun-runtime-boundary.md)). Audience: Desktop /
Web Terminal maintainers, S3 (runtime compat), S4/S5 (packaging acceptance).

## Problem

`getPty()` disables the PTY under the Bun runtime because `@lydell/node-pty`
"hangs under Desktop's runtime". The mechanism is now pinned:

- the wrapper reads master-fd output through a `tty.ReadStream`;
- the pty master fd is opened **non-blocking**, so a read with no data ready
  fails with `EAGAIN`;
- Node's `tty.ReadStream` (libuv) treats `EAGAIN` as "no data yet" and keeps
  the stream open; **Bun surfaces it as an `error` event and destroys the
  stream**;
- destroying the stream closes the master fd. The child keeps running, but
  `onData` never fires and `resize` fails with `EBADF` — from the outside,
  exactly a hang.

Reproduced against a shell round-trip on Bun 1.3.14 and 1.4.0 (fd timeline:
`fstat` OK at spawn → first read `EAGAIN` → stream error/close → subsequent
`fstat`/`resize` fail with `EBADF`). Same behaviour on both versions, so the
workaround cannot be "wait for a Bun fix".

## Design

New backend `packages/core/src/utils/bun-pty.ts`, selected only under Bun:

- `getPty()` keeps `isBunRuntime()` as the seam. Under Bun on POSIX it now
  imports `bun-pty.ts` and returns `{ name: 'qwen-bun-pty' }`. On Windows the
  gate stays (ConPTY under Bun is unvalidated) with an honest `loadError`.
  The **Node path is byte-identical** to before: `@lydell/node-pty`, then
  `node-pty`, unchanged, so Node behaviour has no new code on it.
- The backend drives the **same pinned native addon** directly:
  `require('@lydell/node-pty-<platform>-<arch>')` → `pty.fork` / `pty.resize`
  / `pty.process`. No patched fork of `@lydell/node-pty`, no new native
  artifact, no extra ABI surface.
- Output is pumped by a `node:worker_threads` Worker running blocking
  `fs.readSync` on the master fd. An fd with no `ReadStream` constructed on
  it stays blocking-mode, so the read parks in the kernel until data or end
  of life — no polling, and no runtime can misread `EAGAIN` into a close.
  `EIO` (child exited, slave closed) ends the pump; `EBADF` (master closed
  underneath us) ends it too.
- Writes go through an async `fs.write` queue with `EAGAIN` retry, mirroring
  the wrapper's `CustomWriteStream` (string writes use the configured
  encoding).
- Exit ordering: the native `onexit(code, signal)` callback may beat the last
  output. The backend parks the exit event until the pump ends (flushing the
  trailing `StringDecoder` tail first), bounded by a 500 ms destroy timeout —
  the counterpart of the wrapper's 200 ms socket-destroy fallback.
- The observable POSIX `IPty` contract is mirrored 1:1, including details the
  consumers rely on: `pid`, `cols`/`rows`, `process` title (with the darwin
  `kernel_task`/`spawn_helper` fallback), `onData`/`onExit` as
  `IEvent`-style disposable subscriptions, `write`, `resize` (validation +
  pixel size), `clear()` no-op, `kill(signal || 'SIGHUP')` with swallowed
  errors, `pause`/`resume` (worker-level read gating), `handleFlowControl`
  with XOFF/XON interception (ShellExecutionService passes
  `handleFlowControl: true`), and the EventEmitter `error` event
  (only delivered when a listener exists, else logged).
- Env parity with the wrapper: when `options.env === process.env`, the same
  sanitize list is applied (`TMUX`, `TMUX_PANE`, `STY`, `WINDOW`,
  `WINDOWID`, `TERMCAP`, `COLUMNS`, `LINES`); `PWD` is set to the resolved
  cwd and `TERM` to `options.name || env.TERM || 'xterm'`.

## Deliberately out of scope

- **Windows under Bun** — gate stays, honest reason; needs ConPTY validation
  (`useConptyDll`) under Bun before enabling.
- **`packages/cli/src/agent-view/pty-host.ts`** — agent view keeps its own
  Bun gate this change; wiring it to `qwen-bun-pty` is a small follow-up and
  is not part of the S2 deliverables.
- **Release smoke** — `desktop/scripts/smoke-runtime.js` exercises the PTY
  round-trip through the bundled Node; a Bun-leg PTY smoke belongs to S5
  acceptance on the real archives.

## Packaging

`scripts/create-standalone-package.js` staged the node-pty packages only for
the `node` flavor ("getPty() returns null under Bun"). The `bun` flavor now
stages them too — `lib/node_modules/@lydell/node-pty(-<platform>-<arch>)` —
because `bun-pty.ts` resolves the same platform package via
`createRequire(import.meta.url)` at runtime; the externals in
`esbuild.config.js` already keep every node-pty specifier out of the bundle,
and the `QWEN_STANDALONE_REQUIRE_NODE_PTY_PREBUILD=1` release hard-fail
inherits automatically since the same step now runs for both flavors.

## Validation

- `packages/core/src/utils/bun-pty.test.ts` — behaviour suite under
  vitest/Node (the backend is runtime-agnostic worker code): output
  streaming, writes, `stty size` after `resize`, kill→`onExit` with signal,
  reaping, pause/resume, flow-control interception, `encoding: null`, process
  title, `clear()`.
- `packages/core/src/utils/bun-pty.node-bun.test.ts` — cross-runtime leg
  (S1 harness pattern): a fixture imports the real `getPty.ts`, and under a
  real `bun` binary (BUN_TEST_BIN) asserts the `qwen-bun-pty` backend loads
  and completes a spawn/stream/resize/kill round-trip. Skips when no `bun`
  is available, like the S1 suite.
- `packages/core/src/utils/getPty.test.ts` — Bun arm flipped from "resolves
  null with a disabled reason" to "loads `qwen-bun-pty` without spawning";
  Windows-under-Bun keeps the honest gate; the per-call `loadError`
  contract (#11881) still pinned for the arms that can fail.
- Evidence run on Bun 1.3.14: backend probe (native addon loads, fd stays
  healthy, resize works) and the real product path (CLI `serve` under Bun,
  Web Terminal creation, shell tool PTY round-trip) — recorded in the MYWO-8
  S2 delivery comment.
