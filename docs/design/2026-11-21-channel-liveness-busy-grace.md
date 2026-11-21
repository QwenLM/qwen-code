# Channel Liveness: Busy Grace and Failure Evidence

[English](2026-11-21-channel-liveness-busy-grace.md) | [简体中文](2026-11-21-channel-liveness-busy-grace.zh-CN.md)

Status: implemented and verified (2026-11-21)

## Problem statement

The daemon's ACP channel liveness monitor
(`packages/acp-bridge/src/channel-liveness.ts`) probes the agent child every
15 s (`CHANNEL_LIVENESS_INTERVAL_MS`), requires a response within 10 s
(`CHANNEL_LIVENESS_PROBE_TIMEOUT_MS`), and after 2 consecutive on-time
timeouts (`CHANNEL_LIVENESS_FAILURE_THRESHOLD`) SIGKILLs the whole channel
process. A channel hosts several sessions (4–5 in the observed incident), so
one false positive tears down every session on it: in-flight turns die, the
prompt ledger records `terminal: "error"`, and the next Web Shell load shows
the `interrupted_prompt` recovery banner ("The previous request was
interrupted before the response completed.").

The monitor cannot distinguish an agent that is **temporarily busy or
stalled** (GC pause, heavy synchronous work, scheduling delay, a parked
ndjson pump) from an agent that is **dead or permanently stuck**. The only
forgiveness today is `local_delay`, which covers the daemon's own timer
firing late — not agent-side stalls. The codebase already documents one
false-kill mode: `ndJsonStream.ts` notes that two queue-saturation episodes
inside 30 s "would tear the channel down as a liveness timeout — the outage
this backpressure exists to prevent, with a misleading cause."

Observed on a 32-core development machine on 2026-11-21: four liveness kills
in one day (01:28, 03:38, 17:18, 17:34 local). Machine-wide CPU starvation
was ruled out (load ≈ 9 on 32 cores), worker RSS was 0.3–0.9 GB (no
multi-GB GC), and no queue-saturation warnings were logged. The actual stall
cause is unknown because SIGKILL destroys the scene: nothing records the
agent's process state at the moment of the kill.

## Current state

The baseline policy — cadence, probe timeout, two-strike failure, and the
kill mechanics — is documented in
[daemon channel transport liveness](2026-08-24-daemon-channel-transport-liveness.md).
This design relaxes that failure accounting for CPU-advancing agents and
adds failure evidence; it keeps the cadence, the zero-CPU thresholds, and
the teardown path unchanged.

- `startChannelLivenessMonitor` takes injected `probe`, `onFailure`,
  `isActive`, and optional `now`. It has no access to the child process.
- `channel-startup.ts` wires the probe to
  `qwen/status/channel/ping` and, on failure, marks the transport failed,
  emits a `channel.liveness_failed` telemetry event, writes one stderr line,
  and kills the channel (`transportGuard.fail` or `killChannelWithLog`).
- The agent-side ping handler (`acpAgent.ts`, `channelPing` case) validates
  the nonce and returns immediately; it cannot itself be slow. Delay means
  the agent event loop is blocked or the request/response cannot traverse
  the ndjson queues.
- `AcpChannel` (`channel.ts`) does not expose the child's OS pid;
  `spawnChannel.ts` has it (`child.pid`) but does not publish it.
- The constants are hardcoded; there is no env/settings knob, and the
  initialize request proposes liveness unconditionally
  (`channel-handshake.ts`).

## Goals

1. Do not kill a channel whose agent process is demonstrably still
   consuming CPU without giving it bounded extra grace — busy is not dead.
2. Leave actionable evidence on every liveness failure and every busy
   extension: pid, `/proc` state, wchan, CPU-tick delta, RSS, and the
   monitor's counters, captured **before** the kill.
3. Preserve fast detection of truly dead or zero-CPU stuck channels: the
   2-consecutive-timeout path is unchanged when no CPU progress is observed.
4. No behavior change where the evidence is unavailable: non-Linux
   platforms, unreadable `/proc`, and in-process channels keep today's
   semantics.

## Scope boundaries

In scope: `packages/acp-bridge` (liveness monitor, a new `/proc` sampler,
`AcpChannel.pid`, spawn wiring, startup wiring) and collocated tests.

Out of scope:

- Root-causing the agent stall itself. The evidence this change logs is the
  input to that follow-up; no stall hypothesis is implemented here.
- Configuration knobs for the cadence/timeout/threshold. The constants stay
  as they are; a knob can be added later if the collected evidence justifies
  per-machine tuning.
- The zero-CPU detection thresholds (15 s / 10 s / 2) and the `local_delay`
  tolerance.
- Per-session channel sharding or any change to the kill/teardown mechanics.
- The agent-side ping handler and the ndjson backpressure grace window.

## Proposed solution

### 1. Process sampler — `channel-process-sample.ts` (new)

A dependency-free Linux sampler using `node:fs` sync reads:

- `sampleChannelProcess(pid: number | undefined): ChannelProcessSample | undefined`
  returns `{ cpuTicks, state, wchan, rssBytes }` where `cpuTicks` is
  `utime + stime` from `/proc/<pid>/stat`, `state` is field 3, `wchan` is the
  trimmed content of `/proc/<pid>/wchan`, and `rssBytes` comes from the
  `VmRSS` line of `/proc/<pid>/status`.
- Non-Linux, invalid pid, or any read/parse failure returns `undefined`.
- The stat parser is a pure exported function anchored on the **last** `)`
  (the `comm` field may contain spaces and parentheses), the same technique
  as `core/src/utils/process-liveness.ts`. It lives in `acp-bridge` because
  it has a single consumer and the liveness module stays dependency-free;
  the core helpers are identity/zombie-specialized and are not modified.

### 2. Monitor — `channel-liveness.ts`

New constant: `CHANNEL_LIVENESS_BUSY_EXTENSION_LIMIT = 6`.

New optional options:

- `sampleProcess?: () => ChannelProcessSample | undefined`
- `onBusyExtension?: (info: { extension: number; limit: number; cpuDeltaTicks: number }) => void`

Behavior:

- At probe start, capture a baseline sample (when the sampler is provided).
- On an on-time timeout, capture a second sample. If both samples exist and
  `cpuTicks` advanced, the timeout is a **busy extension**: it does not
  charge `consecutiveTimeouts`; `busyExtensions` increments;
  `onBusyExtension` fires; the next probe runs immediately (the existing
  timeout-retry cadence). When `busyExtensions` reaches the limit, the
  monitor fails with the timeout code anyway — a busy-looping hung agent
  is still killed, just later.
- If either sample is missing or CPU did not advance, the timeout charges
  `consecutiveTimeouts` exactly as today (2 → fail).
- A valid response resets both counters. A `local_delay` outcome resets
  both counters (it already resets `consecutiveTimeouts`).
- `ChannelLivenessFailure` gains an optional `evidence` field:
  `{ lastSample?, lastCpuDeltaTicks?, consecutiveTimeouts, busyExtensions }`.
  The failure code and constructor signature stay backward compatible.
  All four failure paths attach evidence: the two timeout failures carry
  the timeout-side sample and the CPU delta across the final probe window;
  the two protocol-error failures carry a fresh snapshot and the counters,
  with no CPU delta (no timeout window elapsed).

Worst-case detection latency: a zero-CPU hang is still killed ≈ 20 s after
it stops responding (two 10 s probe windows); a CPU-consuming hang is
killed after at most 6 busy windows (≈ 60 s after it stops responding).

### 3. Channel contract — `channel.ts` / `spawnChannel.ts`

`AcpChannel` gains `pid?: number` — the OS pid when the transport owns a
child process, absent for in-process channels. `spawnChannel.ts` publishes
`child.pid` on the returned channel. The field is optional, so existing
consumers (`channels/base`, the VSCode IDE companion, test fakes) are
unaffected.

### 4. Wiring — `channel-startup.ts`

- Pass `sampleProcess: () => sampleChannelProcess(info.channel.pid)`.
- Pass `onBusyExtension`, writing one stderr line per extension:
  `qwen serve: channel liveness probe timed out but agent pid=<pid> consumed CPU (<n> ticks); extending grace <k>/<limit>`.
- Enrich `failChannelLiveness`: the stderr line and the
  `channel.liveness_failed` telemetry event carry the evidence fields
  (pid, state, wchan, cpu delta, RSS, counters) alongside the existing
  channel id and session count. The kill path itself is unchanged.

## Design decisions and rationale

- **CPU-tick delta as the busy signal.** The kernel accounts CPU time
  regardless of whether the agent's event loop can answer a ping, so the
  signal works precisely in the failure mode we care about (loop blocked).
  It separates "computing / in GC / being scheduled" from "blocked on a
  futex or pipe with zero CPU". It costs one snapshot at every probe start
  plus a second on a timed-out probe; each snapshot is three
  microsecond-scale `/proc` reads (≈ one snapshot per 15 s per channel
  while healthy).
- **Bounded grace, not unlimited.** An agent stuck in a busy loop consumes
  CPU forever; unlimited forgiveness would hang its sessions forever. Six
  extensions bound the extra latency to ≈ 40 s while surviving transient
  stalls of tens of seconds.
- **Evidence before kill.** SIGKILL leaves no scene. Capturing state/wchan/
  CPU delta at failure time turns the next incident into root-cause data
  (e.g. `pipe_wait` would implicate stdout backpressure; `D` state would
  implicate I/O).
- **Fail open to today's behavior.** Missing samples (non-Linux, hidepid,
  in-process channel, exited child) charge timeouts as before. The change
  can only add grace where positive evidence of CPU progress exists; it
  never weakens detection where no evidence is available.
- **Sampler local to acp-bridge.** Single consumer; keeps the liveness
  module dependency-free; avoids growing core's identity helpers with a
  third shape (their own comment sets a two-caller limit).

## Constraints

- Linux `/proc` layout: stat fields after `comm` are state = index 0,
  utime = index 11, stime = index 12; `comm` is anchored on the last `)`.
- Clock-tick granularity (typically 10 ms): a process that ran less than one
  tick inside a 10 s window reads as zero delta and falls back to today's
  path — the conservative direction.
- PID stability: the daemon owns the child and reaps it only via the exit
  handler, which also stops the monitor (`isActive`), so the sampled pid
  cannot be recycled under a live monitor.
- Sync `/proc` reads run on the daemon's timer path at probe start and
  after a probe timeout; they are microsecond-scale and bounded (3 files
  per snapshot).

## Risks

- A busy-looping hung agent now survives ≈ 40 s longer before its sessions
  are torn down. Bounded and logged; acceptable against the observed
  false-kill cost.
- The busy signal could be satisfied by an unrelated thread burning CPU
  while the event loop is permanently stuck (e.g. a worker thread in a busy
  loop). The extension limit still forces a kill; the evidence logs the
  state for triage.
- Extra stderr lines on busy extensions: at most one per probe window per
  channel, only during an active stall episode.

## Validation plan

- Unit matrix in `channel-liveness.test.ts` (fake timers, injected sampler):
  busy grace delays failure up to the limit; the limit-th busy timeout
  fails with evidence; zero-CPU and no-sampler paths keep the 2-timeout
  behavior; success and `local_delay` reset both counters; missing
  mid-sequence samples charge as non-busy.
- `channel-process-sample.test.ts`: parser fixtures (plain comm, comm with
  spaces and `)`, malformed input), pid guards, platform gate, and a live
  self-sample on Linux.
- Real-process rig and real-daemon E2E per
  `.qwen/e2e-tests/2026-11-21-channel-liveness-busy-grace.md`: SIGSTOPped
  agent → evidence-bearing kill; busy child → extensions then bounded kill;
  healthy channel → no failure. Baseline dry-run against the global `qwen`
  first.
- `npm run build && npm run typecheck`, focused package tests, lint/format.

## Acceptance criteria

1. A zero-CPU unresponsive agent is killed after 2 consecutive on-time
   timeouts as today, and the failure log/telemetry carries pid, state,
   wchan, CPU delta, RSS, and counters.
2. A CPU-consuming unresponsive agent survives up to
   `CHANNEL_LIVENESS_BUSY_EXTENSION_LIMIT` busy windows, each extension
   logged, then is killed with evidence.
3. Healthy channels and the `local_delay` path behave exactly as before.
4. Non-Linux, unreadable `/proc`, and in-process channels behave exactly as
   before (no sampler effect).
5. Existing liveness tests pass unchanged; build, typecheck, and focused
   tests are green.

## Open questions

None blocking. Follow-up after evidence accumulates: root-cause the agent
stall (the leading suspects are event-loop-blocking synchronous work and
ndjson pump parking), and revisit whether operators need a tuning knob.
