# Goal telemetry

[English](2026-09-15-goal-telemetry.md) | [简体中文](2026-09-15-goal-telemetry.zh-CN.md)

## Problem

A Goal runs autonomously, and the ways it stops — the verifier completing or blocking it, a token, turn or active-time budget running out, the no-progress bound pausing it, the user pausing or clearing it — are recorded only in the session transcript. The telemetry package has no Goal event and no Goal metric. An operator who wants to know how often Goals end blocked, how much a completed Goal spends, or whether a budget is set too low has to read transcripts one at a time.

Codex counts goal outcomes in its metrics, and Claude Code emits `tengu_goal_*` analytics events. Neither carries the objective text.

## Design

**One event, distinguished by cause.** Every reported transition is a `qwen-code.goal_state` event whose `cause` is the runtime's own `GoalStateCause`. A separate event per transition would each need a type, a logger, an analytics-sink method and a documentation entry while carrying the same fields.

**Which causes are reported.** `create`, `replace`, `edit`, `pause`, `resume`, `clear`, `complete`, `blocked`, `usage_limited` and `verifier_reject`: the user's controls and the stops a user acts on. `turn_finished` and `checkpoint` happen on every turn; they would multiply the volume, and per-turn token spend is already in the API metrics. `migrated` is a one-off format migration. `verifier_accept` is always followed by the `complete` or `blocked` it accepted. Broadcasts without a cause are activity changes inside the runtime.

**Where it is wired.** `Config.initializeGoalRuntime` subscribes to the runtime it has just created. It is the one place that holds both the runtime and the `Config` every telemetry logger takes, and it subscribes before the restore it starts, so no transition can commit with nobody listening. The mapping from a snapshot to an event is a pure function in the telemetry package, `goalStateEventFromSnapshot`.

**Restored state is not reported again.** `restore()` republishes a resumed session's Goal with the cause of the record it recovered: a paused Goal comes back as a `pause` broadcast, a budget-stopped Goal as `usage_limited`. A subscriber cannot tell that broadcast from the live transition that first produced it, and comparing against `getRecoveryCause()` is ambiguous as soon as a later live transition carries the same cause. The runtime therefore passes a third broadcast argument, `meta`, with `replayed: true` on that one broadcast and nothing on any other, and the telemetry subscriber skips replays. Existing listeners that take two arguments are unaffected.

**No free text.** The event carries identifiers, enums and numbers: the Goal id and revision, the resulting status, the limit kind, the turn count and turn budget, tokens used and the token budget, active time and the active-time budget, and the objective's length in code points. The objective, the stop reason and the checkpoint failure message are never included. `telemetry.logPrompts`, the switch that gates prompt text elsewhere, defaults to on, so gating the objective behind it would include it by default. An active Goal's committed `activeTimeMs` lags the clock, so the event reads it as of the broadcast.

**Metrics stay bounded.** `qwen-code.goal.transition.count` counts every event, tagged by `cause`, `status` and `limit_kind`. On `complete`, `blocked` and `usage_limited`, the histograms `qwen-code.goal.tokens_used` and `qwen-code.goal.turn_count` record what the Goal had spent, tagged by `cause` and `limit_kind`. The Goal id stays on the log record: every Goal is a new value, which is the unbounded time-series fan-out the metrics module already declines for `session.id` by default. A resumed Goal contributes one observation per stop, with lifetime cumulative spend and turns. Histogram `_count` counts stops rather than distinct Goals, and `_sum` is not total Goal spend.

**Both sinks.** The log record goes to OpenTelemetry when the SDK is initialized, and the analytics sink receives the event when usage statistics are enabled, as with every other event. The analytics payload leaves out the Goal id, because that sink aggregates by installation.

## Scope

- `goal-protocol.ts`: `GoalBroadcastMeta`.
- `goal-runtime.ts`: the optional `meta` argument on `subscribe` listeners and on `broadcast`, set on the restore broadcast.
- `telemetry/types.ts` and `constants.ts`: `GoalStateEvent`, `GOAL_STATE_EVENT_CAUSES`, `makeGoalStateEvent`, `EVENT_GOAL_STATE`.
- `telemetry/goal-events.ts`: `goalStateEventFromSnapshot`.
- `telemetry/loggers.ts`, `qwen-logger/qwen-logger.ts`, `metrics.ts` and `index.ts`: `logGoalState`, `logGoalStateEvent`, `recordGoalStateMetrics` and the three instruments.
- `config/config.ts`: the subscriber.
- Documentation: the telemetry reference and the Goals feature page.

Not changed: the per-stream Goal state subscription in `client.ts` that feeds the UI, Goal proposal approvals, and spans for Goal turns.

## Verification

- `goal-events.test.ts`: every reported cause maps to an event and every unreported cause does not; figures are carried and absent ones are left out rather than set to `undefined`; an active Goal's time is read as of the broadcast; the objective length counts code points; `clear` names the removed Goal and carries no figures; no objective or reason text appears in the serialized event.
- `goal-runtime.test.ts`: the restore broadcast carries `meta.replayed`, and a later live transition carries no `meta`.
- `loggers.test.ts`: the log record's body and attributes, the metrics call, and the analytics sink still being called when the OpenTelemetry SDK is off.
- `qwen-logger.test.ts`: the analytics event leaves out the Goal id and absent figures.
- `metrics.test.ts`: the instruments are registered; the counter carries only its three bounded attributes; the histograms record only on the three outcomes.
- `config.test.ts`: a created Goal is reported once; a resumed session's recovered Goal is not reported, and the user's next control on it is.
- End to end: a headless run writing telemetry to a file before and after the change, and a resumed session that reports no second transition for the recovered Goal.
