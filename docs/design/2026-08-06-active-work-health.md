# Active-work health signal

## Problem

`activePrompts` counts prompts currently dispatched to an ACP child. A prompt can finish after starting background Agents, leaving `activePrompts` at zero while session-owned work is still running. A restart controller that reads zero active prompts as idle can restart the daemon before those Agents finish and before their terminal notifications reach the parent session.

## Scope

`GET /health?deep=1` gains three fields: `activeWork`, `activeWorkReporting`, and `activeWorkStaleMs`.

`activeWork` is true while any managed workspace has an accepted-but-unsettled prompt, a running background Agent, or an Agent terminal notification that is queued, awaiting acceptance, or being processed by its parent continuation. It deliberately does **not** cover background shells, Monitors, workflows, or cron. That exclusion is a scope decision, not an oversight: those categories have no equivalent signal today, and a controller that treats `activeWork: false` as "nothing at all is running" will be wrong about them.

Restart policy stays with the external controller. The daemon publishes facts; it does not publish `restartSafe`.

## Why holds, and why full snapshots

Each Session reports a set of named **holds**, each carrying a category (`agent`, `notification`). Two properties follow, and both are the point:

**Holds are derived, never maintained.** `Session.collectActiveWorkHolds()` reads the owners of the work — the background-task registry's unfinalized set, the notification queue, the in-flight acceptance and continuation state — on every call. There is no acquire/release ledger kept alongside the work, because a ledger can miss a release, and a leaked hold would pin its Session forever while every snapshot faithfully republished the leak.

The agent category uses `BackgroundTaskRegistry.hasUnfinalizedTasks()`'s predicate rather than `hasRunningTasks()`'. A cancelled agent still owes its terminal task-notification: `cancel()` flips status and emits a status change, but the notification arrives later from `finalizeCancelled()` or the 5s grace timer. Keying on "running" would make the Session look idle inside that window, and a detached Session would be closed with the notification still owed.

**Reports are complete snapshots at channel scope, not per-Session transitions.** One message per ACP channel carries every Session the child owns and every hold it holds:

```json
{
  "v": 1,
  "seq": 12,
  "sessions": [
    { "sessionId": "…", "holds": [{ "category": "agent", "id": "a1b2" }] }
  ]
}
```

A dropped report therefore costs one interval of staleness and needs no retransmit, ack, or "last reported" state to diff against — the next snapshot is the whole truth again. `seq` guards against reordering only; a gap is not an error. Channel scope is what keeps an always-on cadence affordable (one small message per interval regardless of Session count) and it gives the daemon a second fact for free: a Session **absent** from a fresh snapshot is positive evidence the child released it.

Prompts are absent from the child's report on purpose. The daemon accepts, queues, dispatches, and settles them, so its own `pendingPromptCount` is authoritative and strictly wider — it covers prompts still waiting in the FIFO, which the child cannot see. Reporting them from both sides would create two sources of truth for one fact with nothing to reconcile them.

## Ordering

A snapshot is flushed ahead of the prompt response on the same stream. The daemon drops its pending-prompt count the instant that response lands, so a hold the prompt left behind — a background Agent it started — must already be on the wire, or the daemon briefly sees neither fact.

## Three states, and closing atomically

Per Session the daemon holds one of:

- **unsupported** — the channel never negotiated. Contributes nothing; pre-existing cleanup behavior applies unchanged. Treating this as "unknown" would make every legacy Session permanently unreapable.
- **unknown** — negotiated, not yet heard from. Reads as retained, but is not a state the daemon sits in: it asks.
- **known** — a snapshot has been applied.

The cache decides _when_ it is worth asking. It never authorizes destruction, because a fresh empty snapshot only describes the moment it was built and work can start in the gap. So automatic cleanup closes through a conditional RPC:

```
qwen/control/session/close { sessionId, onlyIfUnheld: true }
  → { closed: true, holds: [] } | { closed: false, holds: [...] }
```

The child evaluates it under its own close gate, before anything destructive runs. With the gate held the Session admits no new prompt and starts no new automatic turn, so a hold cannot appear between the check and the teardown. If holds exist, the gate is released and they are handed back; the daemon adopts them and backs off.

On timeout the daemon cannot tell whether the child closed. It does not retry and does not assume: it leaves the Session in place and lets the next snapshot settle it — present means the close never happened, absent means it did. A genuinely wedged channel is not this mechanism's problem; see below.

Explicit close, kill, shutdown, and channel exit keep their force semantics and do not go through this path.

## What this deliberately does not do

There is no heartbeat watchdog and no channel kill driven by work state. Inferring "this channel is dead" from "one Session stopped reporting" kills every Session on that process, and a suspend, a long event-loop stall, or a single dropped notification all look identical to a stalled child. Three separate concerns, three separate mechanisms:

| Concern                                                 | Mechanism                                 |
| ------------------------------------------------------- | ----------------------------------------- |
| Transport / process liveness                            | channel ping-pong (separate change)       |
| Agent logic stalling while the process stays responsive | progress-based watchdog (separate change) |
| Session work retention                                  | this document                             |

Killing a whole multiplexed channel is reasonable when the channel is _actually_ dead — every Session on it is unreachable anyway. It is not reasonable as an inference from one Session's reporting.

## Health surface

| Field                 | Meaning                                                               |
| --------------------- | --------------------------------------------------------------------- |
| `activeWork`          | OR across runtimes of daemon-owned work and reported holds            |
| `activeWorkReporting` | `full` / `partial` / `none` — how much of that boolean is vouched for |
| `activeWorkStaleMs`   | Age of the oldest snapshot it rests on; `0` when nothing is covered   |

Freshness is graded by the daemon, not the controller: the reporting cadence is negotiated per channel (the child proposes, the daemon clamps into an agreed range), so only the daemon can judge it. A stale snapshot or a child that omits a category degrades the grade to `partial` rather than silently narrowing what the boolean covers. `activeWorkStaleMs` is diagnostic.

Controllers should treat the daemon as busy when:

```ts
const busy =
  health.activePrompts > 0 ||
  health.activeWork ||
  health.activeWorkReporting !== 'full';
```

`activePrompts` keeps its exact previous meaning as an independent compatibility signal.

## Limits

This is an observation cache, not a restart lease. Even a fresh, empty, fully-graded snapshot describes the moment it was taken; new work can begin immediately afterwards. The rule above substantially lowers the risk of a wrong restart — it does not eliminate it. Strict safety needs a prepare-restart fence that stops new work admission, confirms the drain, and only then shuts down. That is graceful shutdown, and it is out of scope here.
