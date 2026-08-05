# Active-work health signal

## Problem

`activePrompts` only describes prompts currently dispatched to an ACP child. A prompt can finish after starting background Agents, leaving `activePrompts` at zero while useful session-owned work is still running. A restart controller that treats zero active prompts as idle can therefore restart the daemon before those Agents report their terminal results to the parent session.

## Scope

This change adds one fact to `GET /health?deep=1`: `activeWork`. It is true while any managed workspace has an accepted but unsettled prompt, a running background Agent, or a queued/in-progress Agent terminal notification. The aggregation includes draining workspace runtimes.

It deliberately does not count background shells, Monitors, workflows, cron jobs, or follow-up suggestions. It also does not add `activeBackgroundTasks` or `restartSafe`: restart policy still belongs to the external controller and should combine repeated health samples, an idle grace period, and graceful shutdown.

Controllers that understand the new field should use:

```ts
const busy = health.activeWork === true || health.activePrompts > 0;
```

Unknown responses and failed probes remain fail-closed.

## ACP capability and reporting

The daemon requests a private top-level `_meta` capability during initialization:

```json
{
  "qwen.daemon.activeWorkHeartbeat": {
    "v": 1,
    "intervalMs": 15000
  }
}
```

The child echoes the exact capability when supported. Both sides merge this entry with the existing initialization metadata. If negotiation fails, the channel retains its previous behavior and the daemon does not enforce heartbeat expiry.

For a negotiated channel, each Session derives a single boolean from pending prompt dispatch/completion state, `BackgroundTaskRegistry.hasRunningTasks()`, and pending or currently processed Agent terminal notifications. State transitions are reported immediately; while active, the state is reported every 15 seconds:

```json
{
  "method": "qwen/notify/session/active-work",
  "params": {
    "v": 1,
    "sessionId": "session-id",
    "active": true,
    "seq": 1
  }
}
```

Publication is serialized and sequence numbers increase within a Session lifetime. The bridge accepts a report only when its version and payload are valid, its sequence is newer, and the receiving channel owns the Session.

## Bridge ownership and failure handling

The bridge combines its parent-owned accepted-prompt count with the child's active-work lease. Accepted FIFO entries count before dispatch, so they do not depend on a child heartbeat. Automatic detach cleanup, prompt-settle cleanup, attach rollback, and the idle reaper all preserve Sessions with active work. Explicit close, kill, shutdown, and channel exit keep their force semantics.

After prompt dispatch or an active child report, the bridge expects another report for that Session within 45 seconds. Deadlines are independent per Session. A valid repeated heartbeat refreshes only that Session's lease and does not change `lastActivityAt`; a boolean transition does update activity. If a deadline expires, the daemon kills the owning channel, and the existing channel-exit path emits `session_died` for all Sessions on that process.

The timeout detects a wedged ACP process, event loop, or transport. Detecting an Agent whose process still sends heartbeats but whose model/tool logic makes no progress is intentionally deferred to a separate watchdog change tracked by the umbrella issue.

## Compatibility

The shallow health response stays `{ "status": "ok" }`. The deep response is additive. Older children do not acknowledge the capability and are not subject to the new heartbeat timeout. `activePrompts` remains present as an independent compatibility signal for restart controllers.

## Verification

Unit coverage exercises health aggregation and failure semantics, initialization negotiation, notification validation and sequencing, accepted prompt transitions, per-Session heartbeat expiry, Agent registry transitions, terminal-notification continuity, and cleanup. The repository build and typecheck cover the cross-package interface addition.
