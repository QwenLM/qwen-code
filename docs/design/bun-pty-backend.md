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
- Output is pumped by **main-thread async `fs.read` calls** on the master fd.
  The fd the native fork returns is already non-blocking, so an idle read
  fails with `EAGAIN` and is retried on a short (4 ms) timer; a read that
  returned data chains straight into the next one. No `tty.ReadStream` is
  ever constructed, so no runtime can misread `EAGAIN` into a close. `EIO`
  (child exited, slave closed) ends the pump; `EBADF` (master closed
  underneath us) ends it too. An earlier worker-threads/blocking-read sketch
  was abandoned: a worker that touched the master fd left the Bun host unable
  to drain after the child exited.
- **Exit detection rides on the pump.** Isolated-probe evidence: the native
  `onexit` callback of this addon does not fire while the master fd sees no
  read activity at all (identically on Node and Bun) — it fires around the
  reads that reach the end of life. The pump therefore runs from the
  constructor and never stops for `pause()` (see below).
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
  errors, `pause`/`resume` (buffered hold, see below), `handleFlowControl`
  with XOFF/XON interception (ShellExecutionService passes
  `handleFlowControl: true`), and the EventEmitter `error` event
  (only delivered when a listener exists, else logged).
- Env parity with the wrapper: when `options.env === process.env`, the same
  sanitize list is applied (`TMUX`, `TMUX_PANE`, `STY`, `WINDOW`,
  `WINDOWID`, `TERMCAP`, `COLUMNS`, `LINES`); `PWD` is set to the resolved
  cwd and `TERM` to `options.name || env.TERM || 'xterm'`.

## Pause keeps reading

`pause()` cannot stop the pump without losing exit detection (see the
"Exit detection rides on the pump" bullet above): with reads stopped, the
native exit callback never fires, `onExit` is never delivered, the master fd
stays open, and the host cannot drain — reproduced pre-fix on Bun 1.3.14
(pause → child exits → no exit event, fd open, natural-drain probe timed
out) and matched the XOFF-then-cancel FD-residue report, since
`handleFlowControl: true` makes XOFF a `pause()`.

So `pause()` holds output instead of stopping reads: chunks that arrive
while paused are buffered into a bounded hold (1 MiB) and flushed by
`resume()` in order. Past the cap the hold drops incoming chunks — the
wrapper would have applied kernel backpressure by not reading, which this
backend cannot afford without giving up exit detection. On end of life the
hold is discarded and the decoder tail is skipped while paused, matching
the wrapper, where the paused ReadStream loses its buffered data when the
exit fallback destroys the socket: onExit still arrives exactly once, the
fd is released, but resume-after-exit replays nothing.

Reference behaviour pinned by probe (Node wrapper, pause → child exits with
code 7): `onExit` exactly once ~200 ms after child death via the
socket-destroy fallback, fd `EBADF` after, tail output not delivered. The
backend now matches that contract on both runtimes, minus the 200 ms
latency (its pump sees `EIO` directly).

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
  vitest/Node (the backend is main-thread async code, runtime-agnostic):
  output streaming, writes, `stty size` after `resize`, kill→`onExit` with
  signal, reaping, pause/resume, flow-control interception, `encoding:
null`, process title, `clear()`, plus the pause-lifecycle regressions:
  exit exactly once + fd released when the child exits while paused, exit
  detection surviving a paused hold overflow, and the fd released when an
  XOFF flow-control pause is followed by `kill()`.
- `packages/core/src/utils/bun-pty.node-bun.test.ts` — cross-runtime leg
  (S1 harness pattern): a fixture imports the real `getPty.ts`, and under a
  real `bun` binary (BUN_TEST_BIN) asserts the `qwen-bun-pty` backend loads
  and completes a spawn/stream/resize/kill round-trip; a second fixture
  drives the paused-exit lifecycle (pause → child exits → `onExit` exactly
  once, fd released, host exits naturally) under **both** Node and Bun.
  Skips when no `bun` is available, like the S1 suite.
- `packages/core/src/utils/getPty.test.ts` — Bun arm flipped from "resolves
  null with a disabled reason" to "loads `qwen-bun-pty` without spawning";
  Windows-under-Bun keeps the honest gate; the per-call `loadError`
  contract (#11881) still pinned for the arms that can fail.
- Evidence run on Bun 1.3.14: backend probe (native addon loads, fd stays
  healthy, resize works) and the real product path (CLI `serve` under Bun,
  Web Terminal creation, shell tool PTY round-trip) — recorded in the MYWO-8
  S2 delivery comment.
