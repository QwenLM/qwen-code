# Daemon ACP channel transport liveness

## Problem

The daemon knows when an ACP child exits or its bounded NDJSON transport rejects a frame, but it cannot detect a child that remains alive while its event loop or transport stops answering. Session active-work snapshots cannot fill this gap: silence from one Session is not proof that the shared channel is dead, and using that signal to recycle the child would destroy every multiplexed Session.

Layer 2 of #8586 adds a separate channel-level liveness contract. It does not change `activeWork`, Session cleanup, or logical Agent progress detection.

## Scope and ownership

One `AcpSessionBridge` owns one workspace runtime and at most one attach-available ACP child channel. The liveness monitor therefore belongs to `ChannelInfo`, not to a Session. A failure condemns the whole child because every Session on that transport is already unreachable.

The monitor covers only daemon-owned ACP children that acknowledge the v1 capability during `initialize`. Older or alternate children that do not acknowledge it keep the current behavior. Direct ACP consumers and channel adapters are unchanged.

## Wire contract

The daemon advertises this initialize metadata:

```json
{
  "qwen.daemon.channelLiveness": { "v": 1 }
}
```

A supporting child echoes the same metadata in its initialize response. Once negotiated, the daemon periodically calls the read-only extension method:

```text
qwen/status/channel/ping { v: 1, nonce: N }
  -> { v: 1, nonce: N }
```

`nonce` is a non-negative safe integer allocated monotonically for the life of the channel and wraps to zero after `Number.MAX_SAFE_INTEGER`. The daemon accepts only an exact version and nonce echo. A malformed response or a request rejection after a v1 acknowledgement is a definite protocol failure; it does not spend the timeout retry budget.

No Session id, work state, timeout, or process detail crosses this method.

## Timing and escalation

The fixed internal policy is:

- wait 15 seconds between healthy probes;
- allow 10 seconds for one response;
- after the first on-time timeout, retry immediately;
- after a second consecutive on-time timeout, fail the transport and recycle the channel.

This bounds detection to 35 seconds when a child wedges just after a healthy probe, while requiring two independent unanswered requests before taking down multiplexed Sessions. A successful response resets the consecutive-timeout count. These values are implementation policy, not public configuration, matching #8586's non-goal.

At most two requests can remain unresolved: the first timed-out request and its retry. ACP request ids keep a late first response separate from the retry. Once the channel is condemned, the existing transport teardown closes both.

## Host suspend and parent stalls

Every scheduled callback records its expected firing time using `performance.now()`. If either the interval callback or a probe-timeout callback runs more than one second after its expected monotonic deadline, the daemon treats the observation as a local scheduling gap and clears the miss count. A delayed interval starts a fresh interval; a delayed probe timeout keeps the same bounded request outstanding and gives it a fresh response window. It does not infer anything about the child from a timer the parent could not run on time.

This covers platforms whose monotonic clock advances across host suspend. On platforms where that clock pauses during suspend, the timer deadline pauses with it and no overdue callback is produced. Wall-clock changes never participate.

The rule also prevents a long daemon event-loop pause from charging a child timeout. It does not excuse an on-time timeout merely because the daemon was busy earlier; the immediate retry supplies the second observation.

## Lifecycle and failure path

The monitor starts only after initialize succeeds and the channel is published. Its timers are unreferenced so an otherwise idle daemon can exit. It stops on transport failure, channel exit, synchronous kill-all, and graceful shutdown; every callback also rechecks that the same channel remains live and is not dying.

A terminal liveness failure enters the existing transport-failure path before starting teardown:

1. mark the `ChannelInfo` dying synchronously so no new Session work is admitted;
2. retain a bounded failure code for telemetry;
3. clear in-flight extension refresh bookkeeping;
4. ask the daemon transport guard to fail and terminate the child, or call the channel's ordinary kill fallback for injected channels without a guard;
5. let the existing `channel.exited` handler remove every multiplexed Session, publish `session_died`, and release channel state.

This preserves the existing overlap invariant: a replacement can be spawned while the dying channel remains reachable to `killAllSync` until OS reap.

## Observability

The daemon emits one `channel.liveness_failed` telemetry event and one bounded stderr line when escalation begins. The existing `channel.exited` event then reports `transport_failed=true`, `transport_failure_initiated_teardown=true`, and either `acp_channel_liveness_timeout` or `acp_channel_liveness_protocol_error`.

No health or status response field is added. Public health remains an observation surface, not a synchronous probe.

## Compatibility and non-goals

- An unacknowledged capability disables the monitor for that channel.
- Existing Session active-work reporting and conditional close behavior do not change.
- A responsive process with a logically stalled Agent still answers ping; Layer 3 owns progress watchdogs.
- Runtime generation draining and recovery remain Layers 4 and 5.
- There is no public timeout setting, persistence change, transport retry, Session-specific kill, or inference from active-work snapshots.

## Verification

Unit coverage pins negotiation, exact ping echo validation, healthy cadence, timeout reset, two-timeout escalation, local timer-delay suppression, cleanup, legacy compatibility, and teardown of every Session on the failed channel. A child-side test pins the initialize acknowledgement and stateless ping response.

The E2E plan freezes only the ACP child with `SIGSTOP` to reproduce the current gap and verify channel recycle. Host-suspend safety is deterministic unit coverage because a real machine suspend cannot be made reliable or portable in CI.
