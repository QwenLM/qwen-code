# Load-based session admission

[English](load-based-session-admission.md) | [简体中文](load-based-session-admission.zh-CN.md)

Status: implemented

## Problem

When the host is already under heavy load, the daemon keeps admitting new
sessions. Task creation — a caller-supplied `sessionId`, sub-sessions,
scheduled tasks — forces `thread` scope, which spawns a fresh ACP child
process per session: a full Node process with its own heap. (Only bare
`single`-scope spawns multiplex onto the workspace's existing child.) Each
admission therefore deepens the saturation. The daemon's single event loop
starves, HTTP routes (including cancel and status) stop responding in time,
and the daemon appears hung. Continuing to create tasks under load makes the
freeze worse instead of failing fast.

Today every admission gate is count-based:

- Per-workspace live-session cap `maxSessions` (default 32,
  `packages/acp-bridge/src/session-control-plane.ts`).
- Daemon-wide `maxTotalSessions`, derived from workspace count
  (`packages/cli/src/serve/run-qwen-serve.ts`,
  `deriveDefaultMaxTotalSessions`); unset for a single workspace.
- Per-session pending-prompt cap (`maxPendingPromptsPerSession`, default 5).

Counts say nothing about what the machine can actually run: 32 sessions per
workspace can far exceed host capacity. The memory budget module
(`packages/acp-bridge/src/daemon-memory-budget.ts`) is explicitly descriptive
— "Reported, never applied" — and documents that a real policy needs
admission at spawn time. No admission path reads load average, event-loop
delay, or free memory.

## Goals

- Refuse new child spawns with a retryable `503` while the host is saturated
  or the daemon's own event loop is starved.
- Keep existing sessions and the control plane (prompt, cancel, detach,
  status, SSE) fully usable during overload.
- Make the decision observable through `GET /daemon/status`.
- Provide an operator opt-out.

## Scope boundaries

- Signals in this change: host load average and daemon event-loop lag only.
  Memory pressure and cgroup-aware CPU pressure are follow-ups.
- Rejected creations are not queued. Fail fast with `503 + Retry-After`.
- The Managed concurrent-child count cap (`acp_child_capacity_exhausted`) is
  an orthogonal count gate and is unchanged.
- No dedicated Web Shell banner or create-button disabling. The existing
  generic notice path already surfaces the daemon's error message as a toast.
- Prompts to live sessions, cancel, detach, status, and SSE are never gated.

## Design

### Load monitor

A new module `packages/cli/src/serve/load-admission.ts` exports
`createLoadAdmissionMonitor`. It samples every 2 seconds
(`LOAD_ADMISSION_SAMPLE_MS = 2_000`) on an `unref()`-ed interval and caches a
snapshot that admission reads synchronously:

```ts
interface LoadAdmissionSnapshot {
  enabled: boolean;
  overloaded: boolean;
  reason: 'cpu_load' | 'event_loop_lag' | null;
  loadRatio: number; // os.loadavg()[0] / os.availableParallelism()
  eventLoopLagP99Ms: number; // window-scoped p99, histogram reset each tick
  sampledAtMs: number;
}
```

Two signals, each with enter/exit thresholds (hysteresis):

| Signal         | Source                                                                 | Enter         | Exit         |
| -------------- | ---------------------------------------------------------------------- | ------------- | ------------ |
| CPU load       | `os.loadavg()[0] / os.availableParallelism()`                          | ratio ≥ 2.0   | ratio < 1.0  |
| Event-loop lag | `monitorEventLoopDelay({ resolution: 20 })`, percentile(99) per window | p99 ≥ 1000 ms | p99 < 250 ms |

A signal flips state only after the flip condition holds for 3 consecutive
samples (6 seconds). Each signal keeps its own sustain counters;
`overloaded` is the OR of the two signal states. `reason` names the currently
overloaded signal, `cpu_load` taking precedence when both are active; the
snapshot always carries both measured values. The lag histogram is dedicated
to this monitor and reset every tick so the reading is per-window, matching
the existing metrics sampler's pattern in `run-qwen-serve.ts`.

The monitor accepts an optional `readSignals` test seam (defaults to the real
`os`/`perf_hooks` reads) and an optional `sampleMs` override. `dispose()`
clears the interval and disables the histogram. Thresholds and sustain counts
are exported constants, not configuration, in this change.

### Admission integration

`createTotalSessionAdmissionController
` (`packages/cli/src/serve/total-session-admission.ts`) gains an optional
`loadAdmission?: { snapshot(): LoadAdmissionSnapshot }` option. `admit()`
checks, in order:

1. Workspace draining (existing).
2. Load: if `snapshot().overloaded`, throw `SystemOverloadedError`.
3. Total session count (existing).
4. Reserve an in-flight slot (existing).

The controller is the single synchronous seam already wired as
`freshSessionAdmission` into every bridge the daemon constructs
(`run-qwen-serve.ts` primary and secondary runtimes; `server.ts` default
bridge for the standalone app factory). The bridge contract is unchanged:
admission stays synchronous, and the reservation/release semantics are
untouched.

The gate covers all four fresh-child operations — `spawn`, `load`, `resume`,
`branch` — because each spawns a child process. The
`skipFreshSessionAdmission` exemption belongs to the branch operation's
internal restore only: the branch already reserved admission, so its restore
must not reserve twice. A worktree-reset replacement spawns through the
normal `spawn` path and is gated like any other fresh child — consistent with
the existing count gate; a refusal leaves the old session untouched because
the spawn is the reset flow's first step.

The monitor is created where the controller is created, only when load
admission is enabled, and disposed on daemon shutdown and runtime rebuild,
following the metrics sampler's lifecycle.

### Error contract

New `SystemOverloadedError` in `packages/acp-bridge/src/bridgeErrors.ts`,
carrying `reason`, `loadRatio`, and `eventLoopLagP99Ms`. The message names the
reason and the measured values so logs and toasts are diagnostic without extra
lookups.

- REST (`packages/cli/src/serve/server/error-response.ts`): `503`,
  `Retry-After: 15`, body
  `{ error, code: 'system_overloaded', reason, loadRatio, eventLoopLagP99Ms }`.
  A `warn` daemon log line mirrors the total-admission rejection logging.
- ACP RPC (`packages/cli/src/serve/acp-http/dispatch.ts`): `errorKind:
'system_overloaded'`, `httpStatus: 503`, `retryable: true`, plus the same
  measured fields.
- SDK: no new error class in this change; the condition surfaces as
  `DaemonHttpError` with status and body, like the other 503 capacity shapes.

`Retry-After` is 15 seconds rather than the count gates' 5: host load drains
more slowly than a session slot frees.

### Configuration

`ServeOptions.loadAdmission?: boolean`, default `true`. CLI flag
`--load-admission` / `--no-load-admission` on `qwen serve` (yargs boolean with
default). When disabled, no monitor is created and admission behaves exactly
as today.

### Status exposure

`GET /daemon/status` gains a `loadAdmission` section carrying the snapshot
(`enabled`, `overloaded`, `reason`, `loadRatio`, `eventLoopLagP99Ms`,
`sampledAtMs`), and the issues list gains `system_overloaded`
(severity `warning`) while overloaded, alongside the existing
`total_session_capacity_high` family.

## Design decisions and rationale

- **Fail fast, not queue.** Queuing rejected creations would hide
  backpressure, grow daemon memory under exactly the conditions that cause
  the freeze, and leave clients waiting indefinitely. `503 + Retry-After` is
  the established capacity shape in this codebase.
- **One seam, all runtimes.** Gating inside the total-admission controller
  covers every bridge without touching the bridge package's admission
  contract, which must stay synchronous. A per-request async load probe would
  violate that contract.
- **Two signals.** Host load average captures machine-wide saturation,
  including pressure from processes outside the daemon. Event-loop lag
  captures daemon starvation directly, and still works on Windows where
  `os.loadavg()` is always zero.
- **Hysteresis plus 3-sample debounce.** A single heavy JSON parse or a brief
  spawn burst must not block creation, and the gate must not flap. Six
  seconds to engage is acceptable because the overload this guards against
  develops over tens of seconds; the exit side is debounced too, so a momentary
  dip does not release a burst of creations.
- **Gate `load`/`resume` as well as `spawn`.** They spawn children too.
  Runaway work lives in already-live sessions, which need no admission and
  stay cancellable; a cold session has no running work, so refusing its
  restore does not impair controllability.
- **Conservative defaults, enabled by default.** A load ratio of 2.0 means
  the run queue is twice the core count; a 1-second p99 lag means the daemon
  is visibly unresponsive. Healthy hosts never engage the gate, so the
  default-on behavior change is safe; operators can opt out.

## Constraints and risks

- **Windows:** `os.loadavg()` returns zeros, so the CPU signal is inert
  there; the lag signal remains active.
- **cgroups:** load average is host-wide, not container-scoped. A container
  with a CPU quota can see high host load while itself idle, producing false
  refusals. The lag signal is daemon-local and unaffected; operators can
  `--no-load-admission`. cgroup PSI pressure is a follow-up.
- **Linux IO wait:** load average counts uninterruptible IO wait, so an
  IO-heavy host can engage the CPU signal with idle CPUs. The conservative
  threshold and the opt-out bound the impact.
- **False positives block creation.** The refusal is visible (toast, status
  issue, daemon log) and reversible (opt-out, load subsiding). The gate never
  touches work already admitted.
- **Overhead:** one extra histogram and one 2-second timer, the same pattern
  as the existing 5-second metrics sampler; negligible.

## Validation plan

- Unit tests (collocated): monitor enter/exit/debounce matrix per signal and
  combined, dispose, zero-load inertness; controller overload refusal with
  reservation/release invariants and disabled pass-through; REST and RPC
  error mapping.
- E2E plan: `.qwen/e2e-tests/load-based-session-admission.md`. Baseline
  dry-run against the globally installed `qwen` CLI shows the gap (creations
  admitted under load). Post-implementation groups against the local build:
  real CPU-burner load → `503 system_overloaded` on create while live-session
  prompt/cancel stay usable, recovery after load stops; `--no-load-admission`
  admits under the same load; status reports the state.
- `npm run build && npm run typecheck`, focused vitest per changed package.

## Acceptance criteria

- Under sustained saturation (load ratio ≥ 2.0 or event-loop p99 ≥ 1000 ms
  for ≥ 6 seconds), creating a session returns `503 system_overloaded` with
  `Retry-After`, and no child process is spawned.
- During overload, prompts to live sessions, cancel, detach, status, and SSE
  keep working.
- After both signals stay below their exit thresholds for ≥ 6 seconds,
  creations are admitted again.
- `--no-load-admission` disables the gate entirely; behavior matches today.
- `GET /daemon/status` reports the load-admission state and the
  `system_overloaded` issue while overloaded.
- On a healthy host the gate never engages; existing admission tests pass
  unchanged.

## Open questions

- Threshold tuning (2.0/1.0 ratio, 1000/250 ms lag, 3 samples at 2 s) after
  real-world observation; intentionally constants for now.
- Memory-pressure signal and cgroup-aware CPU pressure: follow-up.
- Dedicated Web Shell overload banner and create-button disabling from the
  status section: follow-up.

## Files affected

| File                                                     | Change                                        |
| -------------------------------------------------------- | --------------------------------------------- |
| `packages/cli/src/serve/load-admission.ts`               | New monitor (signals, hysteresis, snapshot)   |
| `packages/cli/src/serve/load-admission.test.ts`          | New unit tests                                |
| `packages/cli/src/serve/total-session-admission.ts`      | Optional load gate in `admit()`               |
| `packages/cli/src/serve/total-session-admission.test.ts` | Overload refusal tests                        |
| `packages/acp-bridge/src/bridgeErrors.ts`                | `SystemOverloadedError`                       |
| `packages/cli/src/serve/acp-session-bridge.ts`           | Re-export the new error class                 |
| `packages/cli/src/serve/server/error-response.ts`        | REST 503 mapping                              |
| `packages/cli/src/serve/acp-http/dispatch.ts`            | RPC error mapping                             |
| `packages/cli/src/serve/run-qwen-serve.ts`               | Monitor lifecycle, controller wiring, options |
| `packages/cli/src/serve/server.ts`                       | Controller wiring (standalone app factory)    |
| `packages/cli/src/serve/types.ts`                        | `ServeOptions.loadAdmission`                  |
| `packages/cli/src/commands/serve.ts`                     | `--load-admission` flag                       |
| `packages/cli/src/serve/fast-path.ts`                    | Fast-path boolean flag registration           |
| `packages/cli/src/serve/daemon-status.ts`                | `loadAdmission` section + issue               |
| `packages/cli/src/serve/routes/daemon-status.ts`         | Status getter pass-through                    |
| `packages/cli/src/serve/server.test.ts`                  | REST mapping test                             |
| `packages/cli/src/serve/acp-http/transport.test.ts`      | RPC mapping test                              |
| `packages/cli/src/serve/daemon-status.test.ts`           | Status section / issue tests                  |
| `packages/cli/src/serve/fast-path.test.ts`               | Flag parsing tests                            |
