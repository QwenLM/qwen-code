# Active-work health signal

## Problem

`activePrompts` counts prompts currently dispatched to an ACP child. A prompt can finish after starting background Agents, leaving `activePrompts` at zero while session-owned work is still running. A restart controller that reads zero active prompts as idle can restart the daemon before those Agents finish and before their terminal notifications reach the parent session.

## Scope

`GET /health?deep=1` gains three fields: `activeWork`, `activeWorkReporting`, and `activeWorkStaleMs`.

`activeWork` is true while any managed workspace has an accepted-but-unsettled prompt, a running background Agent, or an Agent terminal notification that is queued, awaiting acceptance, or being processed by its parent continuation. It deliberately does **not** cover background shells, Monitors, workflows, or cron. That exclusion is a scope decision, not an oversight: those categories have no equivalent signal today, and a controller that treats `activeWork: false` as "nothing at all is running" will be wrong about them.

It is also **Session-scoped, not channel-scoped**. Channel-level work with no Session attached yet — a spawn in flight, a pending restore, MCP discovery or authentication — is not counted, so `activeWork` can read false while the daemon's own `hasNoChannelWork` is simultaneously refusing to reclaim that channel. The two answer different questions and are allowed to disagree: this field describes work owned by Sessions, and widening it to cover channel setup would change what the boolean means for every existing reader. A controller that needs "is this daemon reclaimable" must combine the three-term rule below with a graceful-shutdown handshake, not read more into this one field than it claims.

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

A dropped report therefore costs one interval of staleness and needs no retransmit, ack, or "last reported" state to diff against — the next snapshot is the whole truth again. `seq` guards against reordering only; a gap is not an error. Channel scope is what keeps an always-on cadence affordable (one small message per interval regardless of Session count) and it gives the daemon a second fact for free: because the report is complete, a Session **absent** from a fresh snapshot holds nothing on the child side. Absence and reported-with-no-holds are therefore the same fact and take the same path — one that ends in asking the child, never in assuming.

Prompts are absent from the child's report on purpose. The daemon accepts, queues, dispatches, and settles them, so its own `pendingPromptCount` is authoritative and strictly wider — it covers prompts still waiting in the FIFO, which the child cannot see. Reporting them from both sides would create two sources of truth for one fact with nothing to reconcile them.

## Ordering

A snapshot is flushed ahead of the prompt response on the same stream. The daemon drops its pending-prompt count the instant that response lands, so a hold the prompt left behind — a background Agent it started — must already be on the wire, or the daemon briefly sees neither fact.

## Three states, and closing atomically

Per Session the daemon holds one of:

- **unsupported** — the channel never negotiated. Contributes nothing; pre-existing cleanup behavior applies unchanged. Treating this as "unknown" would make every legacy Session permanently unreapable.
- **unknown** — negotiated, not yet heard from _recently enough_. Reads as busy on the health surface, but is not a state the daemon sits in: it asks.
- **known** — a fresh snapshot has been applied.

Never-reported and gone-quiet are the same state on purpose. A snapshot older than the grading window (`intervalMs × 3`) is not a report that the Session is idle, it is the absence of one — a background Agent could have started at any point since — so it stops counting as evidence.

**Unknown is a reason to ask, not a reason to skip.** The two consumers read it differently, and they have to: the health surface reports unknown as busy (a controller must never mistake "nobody told me" for "nothing is running"), while automatic cleanup treats it as a candidate and goes on to the conditional close below. Only _known_ work — daemon-owned, or a fresh report of held work — blocks the attempt outright. Skipping on unknown instead would look safe and in fact be the worse failure: nothing would ever resolve it, so a Session on a channel that went quiet would be retained forever with no path out. Asking costs one bounded round trip and still retains on any non-answer, and the child can answer authoritatively under its close gate whether or not its snapshots are arriving.

Reclaiming a channel that has stopped answering entirely is still not this mechanism's job; see below.

The cache decides _when_ it is worth asking. It never authorizes destruction, because a fresh empty snapshot only describes the moment it was built and work can start in the gap. So automatic cleanup closes through a conditional RPC:

```
qwen/control/session/close { sessionId, onlyIfUnheld: true }
  → { closed: true, holds: [] } | { closed: false, holds: [...] }
```

The child evaluates it under its own close gate, before anything destructive runs. With the gate held the Session admits no new prompt and starts no new automatic turn, so a hold cannot appear between the check and the teardown **on the child side**. If holds exist, the gate is released and they are handed back; the daemon adopts them and backs off.

The daemon side needs its own cover, because the round trip is an await of up to ten seconds. A Session with a conditional close outstanding is marked in-flight, and every admission path — attach, prompt, rewind — refuses it exactly as it refuses one that is already closing. Without that, a prompt accepted during the round trip is lost when the teardown it raced completes; the previous synchronous guard-then-teardown sequence got this for free, and splitting it is what created the need to say so explicitly.

On timeout the daemon cannot tell whether the child closed. It does not retry in place and does not assume: it leaves the Session alone and lets the next snapshot settle it. Absence from that snapshot is not consent to destroy — it makes the Session a candidate, and the candidate still has to clear every ordinary guard (no SSE subscriber, no registered client, nothing daemon-owned in flight) before the daemon asks the child once more. A child that already closed the Session answers `closed` for a Session it no longer has, which is how a lost close response is recovered without ever guessing.

Explicit close, kill, shutdown, and channel exit keep their force semantics and do not go through this path.

## One guard model, four triggers

Four things can decide it is time to look at a Session: the last client detaching, a prompt settling, a terminal notification settling, and the idle reaper's TTL. Each brings its own policy, and none of them may weaken the shared part:

| Guard                                       | Why it is shared                                                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| not already closing or close-in-flight      | two paths racing the same teardown duplicate the round trip and race each other's guards                             |
| no SSE subscriber                           | someone is watching this Session's stream                                                                            |
| nothing daemon-owned in flight              | queued and dispatched prompts and notifications the daemon is pushing; never depends on the child reporting anything |
| no fresh child report of held work          | only _known_ work blocks; unknown is a candidate that goes on to ask                                                 |
| the child confirms under its own close gate | the cache says what _was_ true; only the child can say what is true now                                              |

The reaper deliberately ignores registered client ids — it exists for the crash path where a detach never arrived — but that is the only difference, and it still has to ask the child before destroying anything.

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

Freshness is graded by the daemon, not the controller: the reporting cadence is negotiated per channel (the child proposes, the daemon clamps into an agreed range), so only the daemon can judge it. A stale snapshot or a child that omits a category degrades the grade to `partial` rather than silently narrowing what the boolean covers. `activeWorkStaleMs` is diagnostic, and it measures only the _covered_ Sessions — an uncovered one already shows up in the grade, so letting it also drag the age down would double-count it and produce a positive staleness next to a grade saying nothing is covered.

The grade is computed once over the whole daemon rather than per runtime and then combined, because grades do not compose: a runtime with no Sessions vouches for everything it has, and folding that vacuous `full` in as evidence let an empty workspace vouch for another workspace's unreported Sessions. Each runtime therefore exposes coverage counts and the route sums them before grading.

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
