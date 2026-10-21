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
- The backend reuses the **same pinned native artifact**, but loads its
  private addon by path. It uses
  `require.resolve('@lydell/node-pty-<platform>-<arch>')` to locate the package
  entry, takes `dirname(dirname(entry))`, then loads
  `prebuilds/<platform>-<arch>/pty.node` rather than requiring the package entry.
  On macOS it also checks for the adjacent `spawn-helper`; its path is passed
  to `pty.fork`. There is no patched fork or new native artifact, but the
  backend now depends directly on the pinned addon's private
  `fork` / `resize` / `process` API and prebuild directory layout. Resolving the
  package alone does not establish prebuild availability or ABI compatibility;
  installed and staged layouts and each supported runtime/platform still need
  validation.
- Output is pumped by **main-thread async `fs.read` calls** on the master fd.
  The fd the native fork returns is already non-blocking, so an idle read
  fails with `EAGAIN` and is retried on a short (4 ms) timer; a read that
  returned data chains straight into the next one. **One read at a time**: an
  in-flight guard keeps `resume()` from chaining a second read on top of a
  still-outstanding one — every read targets the shared 64 KiB read buffer,
  so an overlap would make one callback observe the other read's bytes
  (duplicated/fragmented output). No `tty.ReadStream` is ever constructed, so
  no runtime can misread `EAGAIN` into a close. `EIO` (child exited, slave
  closed) ends the pump; `EBADF` (master closed underneath us) ends it too.
  An earlier worker-threads/blocking-read sketch was abandoned: a worker that
  touched the master fd left the Bun host unable to drain after the child
  exited.
- **Exit detection rides on the pump.** Probe evidence: a child that leaves
  output undrained on the pty delivers the addon's native exit callback only
  around master-fd read activity, while a child with nothing pending
  delivers its callback even at zero reads (same on Node and Bun). Keeping
  the pump reading is therefore what makes exits of producing children
  observable — the pump runs from the constructor and keeps reading through
  `pause()` until the hold is full (see below).
- Writes go through an async `fs.write` queue with `EAGAIN` retry, mirroring
  the wrapper's `CustomWriteStream` (string writes use the configured
  encoding).
- Exit ordering: the native `onexit(code, signal)` callback may beat the last
  output. The backend parks the exit event until the pump ends (flushing the
  trailing `StringDecoder` tail first), bounded by a 500 ms fallback — the
  counterpart of the wrapper's 200 ms socket-destroy fallback. Every
  end-of-life path (pump saw `EIO`/`EBADF`, the 500 ms fallback fires, or the
  native callback lands after the pump already ended) runs the same cleanup:
  retry-timer teardown, logical master-fd closure, decoder flush and one real
  `onExit`. Physical close is deferred until in-flight reads/writes settle;
  `onExit` is not proof that the close syscall has completed or succeeded.
  Close exceptions are still swallowed and remain a verification gap.
  The fallback timer is deliberately not `unref`'d — exit delivery
  must not depend on a timer the runtime is free to drop.
- The observable POSIX `IPty` contract is mirrored 1:1, including details the
  consumers rely on: `pid`, `cols`/`rows`, `process` title (with the darwin
  `kernel_task`/`spawn_helper` fallback), `onData`/`onExit` as
  `IEvent`-style disposable subscriptions, `write`, `resize` (validation +
  pixel size), `clear()` no-op, `kill(signal || 'SIGHUP')` with swallowed
  errors, `pause`/`resume` (bounded hold, see below), `handleFlowControl`
  with XOFF/XON interception (ShellExecutionService passes
  `handleFlowControl: true`), and the EventEmitter `error` event
  (only delivered when a listener exists, else logged).
- Env parity with the wrapper: when `options.env === process.env`, the same
  sanitize list is applied (`TMUX`, `TMUX_PANE`, `STY`, `WINDOW`,
  `WINDOWID`, `TERMCAP`, `COLUMNS`, `LINES`); `PWD` is set to the resolved
  cwd and `TERM` to `options.name || env.TERM || 'xterm'`.

## Pause keeps reading until the hold is full, then parks

`pause()` cannot stop the pump outright without losing exit detection for
producing children (see the "Exit detection rides on the pump" bullet
above): probe evidence — with zero master-fd reads for 3 s after a child
exited leaving output undrained, the native exit callback never fired
(identically on Node and Bun). Without that callback the addon does not reap
the leader either (it still answers `kill(pid, 0)`, and `ps` lists it in
exiting state), so no liveness probe can substitute for the reads. `onExit`
is never delivered, the master fd stays open, and the host cannot drain —
reproduced pre-fix on Bun 1.3.14 (pause → child exits → no exit event, fd
open, natural-drain probe timed out) and matched by the XOFF-then-cancel
FD-residue report, since `handleFlowControl: true` makes XOFF a `pause()`.

So `pause()` keeps reading into a hold — **inside a budget**:

- **Per-pty `pausedHoldBytes`** (default 4 MiB) and **process-wide
  `totalPausedHoldBytes`** (default 32 MiB), charged in data bytes;
- the hold copies read chunks into **fixed 64 KiB blocks**, so per-Buffer
  overhead is bounded by one partial block no matter how the child writes —
  pty read sizes vary wildly with the producer (~0.5 KB reads for an `awk`
  flood, ~40 B for `yes`, 1 B for a drip), and per-chunk retention would
  let tiny reads multiply object overhead past the byte budget;
- each paused read asks for no more than the hold still has room for, so
  the hold stays within its caps. The only overshoot is a read already in
  flight when `pause()` landed, or another pty's paused read landing against
  the shared total first — at most one 64 KiB read.

Held output is byte-exact: `resume()` flushes it in order, pinned by
byte/line-exact regressions (a 500-toggle no-gap pause/resume storm during
a 20 000-line flood, and a ~1.7 MB flood produced entirely while paused —
both reproduce the stream exactly, and the pump still reports the exit of a
child that floods while paused and then exits).

**A full hold parks the pump instead of failing.** Once either cap has no
room left, no further master-fd read is issued until `resume()`: the kernel
pty buffer fills and the child blocks on write — the backpressure the
wrapper's paused socket applies from the first byte. Nothing is dropped,
nothing is killed, no error is emitted, and pause is never released
automatically. `resume()` replays the hold and restarts the reads, so the
stream past the cap stays byte-exact too (`pty.stats.readParked` exposes
the parked state). A pty parked by the shared total stays parked until its
own `resume()`.

This replaces an earlier contract that terminated the child tree with
`QWEN_PTY_OUTPUT_LIMIT` once the paused hold passed its cap. Under the shell
tool's `handleFlowControl: true` one Ctrl+S (XOFF) byte is a `pause()`, so
that contract turned a recoverable "stop scrolling" keystroke into the loss
of the command: during a flood the tree was killed about a second after a
single XOFF (review R1-33).

While parked, exit detection is the wrapper's: a child that dies with
output undrained may finish exiting only once reads resume (macOS holds it
in exiting state; Linux reaps it and the parked exit drains on the 500 ms
fallback). The shell tool's cancel therefore calls `resume()` before it
signals the process group — a no-op when the pty is not paused, on either
backend.

On natural end of life the hold is discarded and the decoder tail is
skipped while paused, matching the wrapper: `onExit` still arrives exactly
once, fd closure is requested (physical close waits for in-flight operations),
and resume-after-exit replays nothing.

The **write queue** keeps an explicit failure: queued, not-yet-written input
beyond 1 MiB per pty or 8 MiB process-wide terminates the pty with
`QWEN_PTY_WRITE_LIMIT` instead of acknowledging backpressure that does not
exist. Termination kills the child process tree by real ownership: the
leader, its process group, its descendants, and every process in its session
(Linux `sid`) or on its controlling tty (macOS `tdev`), as listed by `ps`
while the leader is still unreaped. That list covers the foreground jobs an
interactive shell runs in their own process groups. SIGTERM goes first; after
a 500 ms grace, SIGKILL goes to a fresh listing, which keeps earlier members
only while they are still the same process (same start time), so a recycled
pid is never signalled. The backend then closes the master fd and ends every
drain path (retry timer, pending exit, hold, write queue). After the failure, `write` and `resize` are no-ops (matching the
registry guards above them), held bytes still in flight from an in-flight
read are neither delivered nor re-charged, and a `resume()` replay stops at
the first data listener that terminates the pty. Exactly one structured
`PtyLimitError` is then emitted on the `error` event, carrying a stable
`code` (`QWEN_PTY_WRITE_LIMIT`, or `QWEN_PTY_ACTIVE_LIMIT` for admission),
the `limitKind`, the `limit`, the bytes accepted so far, and whether
undelivered input was discarded. `onExit` stays reserved for real native
exits: a native callback that still arrives after a limit termination is
only recorded (`pty.stats.nativeExitRecord`) — never delivered as a second
terminal event, never turned into a fabricated exit code.

The number of **live ptys** is capped too (default 64, headroom over the
web terminal's eight-session admission cap): a `spawn` past the cap throws
`QWEN_PTY_ACTIVE_LIMIT` synchronously. `getPtyBudgetStats()` and
`pty.stats` expose the held/queued/admitted counters for probes and tests;
production never mutates `processPtyBudget`, tests adjust and restore it.

Slowing reads (one read per timer tick past a high-water mark) was probed
and rejected as the backpressure mechanism: it throttles to ~1 KiB per tick
(the pty delivers at most one small chunk per partial read), so a flood
pauses for minutes, and it still cannot bound memory without dropping
bytes eventually. An earlier draft described that probe as kernel-level
stream corruption; that claim was **withdrawn** — once termios output
processing (ONLCR) is accounted for, the continuous-drain and drip arms
produce byte-identical output on Node and Bun, and no corruption mechanism
was located. The bounded hold reads at full speed and stays byte-exact
below the cap, and parking at the cap bounds memory without dropping a
byte.

### Consumer wiring of the failure

- **ShellExecutionService (foreground PTY path)**: a `QWEN_PTY_WRITE_LIMIT`
  error event settles the execution with `error` set and `exitCode`/`signal`
  `null` — a visible failure carrying no fabricated native exit code; the
  tool result is never `success`. Node backends never emit these codes, so
  Node behaviour is unchanged, and the natural-exit path still resolves from
  `onExit` only. A spawn rejected by the active-pty cap returns an explicit
  error with null native exit/signal and execution method `none`; it does
  not bypass the cap through child_process fallback. Cancel resumes the pty
  before it signals the process group, so a cancel after XOFF still observes
  the exit.
- **Web Terminal (`web-terminal-registry` + `serve` route)**: the registry
  subscribes to the backend `error` event, marks the session failed, and
  releases the PTY without signalling the already-killed tree again. The
  route forwards an explicit `{type: 'error'}` control frame (rendered in
  red by the client), closes the socket with 4001 — a non-retryable close
  code for the client — and `readSnapshot` carries
  `failed`/`failureMessage`; writes and resizes on a failed session are
  rejected.
- **Unexpected PTY errors** differ by consumer: the foreground listener
  throws; the registry ignores EIO/EAGAIN and sends other non-limit errors to
  `debugLogger.warn`. A warn is not a failed session or proof of cleanup, and
  may not persist without an active debug session.

Every input frame is capped by the registry's accumulated input gate, including
an idle terminal's first frame: a frame that would push the session's
unacknowledged input past 256 KiB is refused as `backpressure` before it reaches
the backend, so one oversized paste cannot trip the backend's 1 MiB write-queue
cap and terminate the session. The backend cap still governs accumulated queued
writes: above it the session explicitly fails, and input is never split,
replayed or silently accepted. A future pre-admission input policy requires a
separate decision.

Reference behaviour pinned by probe (Node wrapper, pause → child exits with
code 7): `onExit` exactly once ~200 ms after child death via the
socket-destroy fallback, fd `EBADF` after, tail output not delivered. The
backend still matches that contract on both runtimes for a child that dies
while paused **with reads still going** (hold under its cap), minus the
200 ms latency (its pump sees `EIO` directly).

## Deliberately out of scope

- **Windows under Bun** — gate stays, honest reason; needs ConPTY validation
  (`useConptyDll`) under Bun before enabling.
- **`packages/cli/src/agent-view/pty-host.ts`** — agent view keeps its own
  Bun gate this change; wiring it to `qwen-bun-pty` is a small follow-up and
  is not part of the S2 deliverables.
- **Release smoke** — `packages/desktop/scripts/smoke-runtime.js` exercises the PTY
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

### Pending R2-8 validation

Checklist only; NOT_RUN, not evidence of a pass:

- [ ] Hold an actual asynchronous read callback in flight at logical close;
      separately hold an asynchronous write callback. Observe that physical
      `closeSync(fd)` is deferred, new I/O is rejected, and the numeric fd remains
      open until the last owning callback settles. Cover both callbacks in flight
      and both settlement orders; the first settlement must not close the fd.
- [ ] On the successful-close path, record exactly one close attempt after
      the last settlement and an independent descriptor-close witness. Neither
      `onExit`, `fdClosed`, nor released budget counters prove physical close.
- [ ] Inject a non-EBADF close failure and record the attempted close, errno,
      and descriptor state. The current catch suppresses the error; do not label
      the descriptor released without an independent witness. Retain UNKNOWN
      where physical closure cannot be established. Control descriptor reuse
      when interpreting an EBADF observation; do not infer tree/FD convergence.

### Existing validation inventory (not revalidated in this batch)

- `packages/core/src/utils/bun-pty.test.ts` — behaviour suite under
  vitest/Node (the backend is main-thread async code, runtime-agnostic):
  output streaming, writes, `stty size` after `resize`, kill→`onExit` with
  signal, reaping, pause/resume, flow-control interception, `encoding:
null`, process title, `clear()`, plus the pause-lifecycle regressions:
  exit exactly once + fd released when the child exits while paused, exit
  detection surviving a paused 3 MB flood (hold cap sized explicitly for
  it), a byte/line-exact stream across 500 no-gap pause/resume toggles
  during a 20 000-line flood, a byte-exact resume of a ~1.7 MB flood held
  entirely while paused, and the fd released when an XOFF flow-control
  pause is followed by `kill()`. The resource-limit suite pins the parking
  contract: a paused flood past the per-pty cap parks the reads with no
  error, the child alive and the hold within the cap and no longer growing,
  then `resume()` delivers the whole stream byte-exact and the child stays
  interactive; a child killed while parked still reports exactly one exit
  with every budget released; an under-cap flood stays byte-exact through
  pause/resume; the process-wide cap parks the pty that reaches it, exactly
  at the total, while neither pty fails and both replay losslessly; the
  write-queue cap terminates with
  `QWEN_PTY_WRITE_LIMIT` (no fabricated backpressure ack) and reaps an
  interactive shell's TERM/HUP-ignoring foreground job that runs in its own
  process group; the active-pty
  cap rejects the next `spawn` with `QWEN_PTY_ACTIVE_LIMIT` and frees the
  slot on close; and the budget counters are observable via
  `getPtyBudgetStats()`. The fd-lifetime suite (`defers the fd close while
  a read is still owned by the threadpool` and `defers the fd close while a
  write is still owned by the threadpool`) holds an in-flight read and,
  separately, an in-flight write at logical close, covers both settlement
  orders (the first must not close), and asserts one close attempt with the
  fd still open until the last owner settles. Those tests distinguish
  logical termination from eventual physical close; they do not claim
  close-syscall success.
- `packages/core/src/utils/bun-pty.node-bun.test.ts` — cross-runtime leg
  (S1 harness pattern): a fixture imports the real `getPty.ts`, and under a
  real `bun` binary (BUN_TEST_BIN) asserts the `qwen-bun-pty` backend loads
  and completes a spawn/stream/resize/kill round-trip; a second fixture
  drives the paused-exit lifecycle (pause → child exits → `onExit` exactly
  once, fd released, host exits naturally) under **both** Node and Bun; a
  third fixture runs 300 no-gap pause/resume toggles during a 5 000-line
  flood and asserts the stream stays byte-exact and line-complete on
  **both** runtimes; a fourth fixture drives a paused flood past the hold
  cap under the real Bun runtime (reads park with no error and the child
  alive, then `resume()` delivers the stream byte-exact, the child exits
  naturally, fd released, host drains naturally); a fifth fixture drives the write-queue cap under the real Bun
  runtime (one structured `QWEN_PTY_WRITE_LIMIT`, empty queue, no `onExit`,
  fd released, child tree gone, host drains naturally). Skips when no `bun`
  is available, like the S1 suite.
- `packages/core/src/utils/getPty.test.ts` — Bun arm flipped from "resolves
  null with a disabled reason" to "loads `qwen-bun-pty` without spawning";
  Windows-under-Bun keeps the honest gate; the per-call `loadError`
  contract (#11881) still pinned for the arms that can fail.
- Evidence run on Bun 1.3.14: backend probe (native addon loads, fd stays
  healthy, resize works) and the real product path (CLI `serve` under Bun,
  Web Terminal creation, shell tool PTY round-trip) — recorded in the MYWO-8
  S2 delivery comment.
