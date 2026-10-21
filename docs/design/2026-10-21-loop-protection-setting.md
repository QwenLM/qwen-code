# Loop protection setting and reminders before stops

[English](2026-10-21-loop-protection-setting.md) | [简体中文](2026-10-21-loop-protection-setting.zh-CN.md)

- **Status**: implemented on the PR branch
- **Date**: 2026-10-21
- **Related**: issue #14828 (PR 2 of 2),
  [loop stop reasons](2026-10-20-loop-stop-reason.md) (PR 1, #14858),
  [adaptive tool-call cap](2026-07-17-adaptive-tool-call-cap.md),
  [ACP repeated tool-call protection](acp-repeated-tool-call-protection.md)

## Problem

Every loop detector stops the turn the moment it fires. The model is never
told that it is about to be stopped, so it gets no chance to change course,
and an unattended run then waits for a human. The ACP repeated-tool-failure
guard is the only detector that warns first.

The switches are also scattered. `model.skipLoopDetection` only decides
whether the heuristic detectors run. `model.maxToolCallsPerTurn ≤ 0` disables
the cap. The core consecutive-identical and shell-stagnation guards and the
daemon invalid-params guard have no setting at all; only the TUI dialog can
disable them, and only for the current session.

## Goals and scope

Goals:

- One setting, `model.loopProtection: "off" | "warn" | "stop"`, honored by the
  core client, subagents and daemon/ACP sessions.
- In the default `stop`, every stop point stays where it is today; the
  always-on detectors give the model one corrective reminder first.
- A decision telemetry event, so a later default change can be based on data.

Out of scope:

- Changing the default to `warn`.
- Budgets: an explicit `model.maxToolCallsPerTurn`, the 1000-call backstop and
  a subagent's `maxTurns` / `maxTimeMinutes` stop in every mode.
- The duplicate provider tool-call id breaker and the ACP repeated-tool-failure
  guard, which keeps its own staged rollout.
- New detectors, such as a consecutive-identical guard in the daemon.
- An interactive continue / stop prompt.

## Design

### Modes

| Mode             | Always-on detectors                                                 | Opt-in heuristics (`model.skipLoopDetection: false`)                                            |
| ---------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `stop` (default) | One reminder at the reminder point, then the stop at today's point. | Unchanged.                                                                                      |
| `warn`           | The same reminder, then no stop.                                    | One reminder at today's stop point instead of the stop. Content/thought repetition still stops. |
| `off`            | No reminder and no stop. Telemetry records the detection.           | No reminder and no stop. Telemetry records the detection.                                       |

Under `warn` and `off` a stuck turn runs until a budget stops it, by default
the 1000-call backstop. The setting's description says so.

`model.skipLoopDetection` keeps its meaning: it decides whether the heuristics
run at all. `off` deliberately makes the always-on guards configurable, which
the comment in `client.ts` used to rule out; #14828 measured that DashScope no
longer rejects repeated identical calls, so a true off is safe to offer.

### Always-on detectors

| Detector (`loopType`)                                                     | Runs in                 | Reminder                                          | Stop (today, and in `stop`)                  |
| ------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------- | -------------------------------------------- |
| Consecutive identical calls (`consecutive_identical_tool_calls`)          | core, subagents         | 3rd identical call in a row                       | 5th                                          |
| Shell inspection stagnation (`shell_command_stagnation`)                  | core, subagents         | 6th overview inspection in a row                  | 8th                                          |
| Invalid tool params (`invalid_tool_params_stagnation`)                    | daemon                  | 2nd invalid-params error for one tool in the turn | 3rd                                          |
| Adaptive cap, stuck repetition (`turn_tool_call_cap`, `stuck_repetition`) | core, subagents, daemon | past the soft cap, one call repeated 4 times      | past the soft cap, one call repeated 6 times |

A reminder is given once per streak. A streak ends by the detector's existing
reset rule: a different call ends a consecutive-identical streak, a
non-inspection command ends a shell streak, and the cap and invalid-params
counts last for the turn. A successful result does not end a streak. For
stateful read tools (`task_list`) the consecutive-identical reminder needs the
same unchanged-result evidence as the stop, so productive polling is not
reminded.

If one batch reaches both points, or a call has already repeated 6 times when
the turn passes the soft cap, `stop` stops as today and the queued reminder is
never sent; under `warn` the reminder is given at that point instead.

### Reminder delivery

The detector queues the reminder. It is appended to the next model request that
carries tool results, where the exploration and todo reminders already go:

- core client: the tool-result send in `client.ts`;
- subagents: the tool-response message in `agent-core.ts`;
- daemon: the batch `parts` in `Session.ts`.

Reminders of different patterns queued in the same batch go out together. A
retry discards the attempt's queued reminders, because the replayed calls
queue them again. A concurrent `/btw` side query neither queues nor takes the
running turn's reminders. The reminder names the detector, the tool and what
to change, and under `stop` it says that continuing will stop the turn.

### Telemetry

`loop_detected` and the `StopFailure` hook keep meaning "the turn stopped". A
new `loop_protection` event records each governed decision: `reminded`,
`stopped`, or `observed` under `off`, with the loop type, the reason and the
mode. `reminded` is logged when the reminder is sent, so a reminder dropped by
a retry or cut off by a stop in the same batch is not counted; `stopped` is
logged once per turn. Budget stops and the provider-id breaker are not
governed and emit no decision event.

### Messages

The headless hint for a governed always-on stop names `model.loopProtection`
instead of saying the guard cannot be disabled. The TUI loop dialog's note
names the setting too.

## Compatibility

Without the setting, the behavior is `stop`: the same stop points, the same
`turn_error`, `loop_detected` and hook payloads, plus the reminders. `loopType`
values and the PR 1 fields do not change. Reminders add a few dozen tokens to
the request after the tool results; the cached prefix is untouched.

## Files affected

- Core: a new `services/loop-protection.ts` (mode, reminder points and texts),
  `services/loopDetectionService.ts`, `core/client.ts`,
  `agents/runtime/agent-core.ts`, `config/config.ts`, `telemetry/types.ts`,
  `telemetry/loggers.ts`, `telemetry/qwen-logger/qwen-logger.ts`.
- CLI: `config/settingsSchema.ts`, `config/config.ts`,
  `acp-integration/session/Session.ts`, `utils/loop-detected-message.ts`,
  `ui/components/LoopDetectionConfirmation.tsx`.
- Generated: the VS Code settings schema.
- Docs: the settings and telemetry references.

## Validation

Unit tests cover each mode for every governed detector, the reminder points,
one reminder per streak, retry handling, the stateful-read exemption, budgets
in every mode, the decision event, reminder delivery in core, subagents and the
daemon, and the setting plumbing.

End-to-end, against a mock OpenAI-compatible server:

- headless `stop`: identical calls get the reminder in the request after the
  3rd call and still stop at the 5th; the stuck cap and shell cases likewise;
- headless `warn`: the same cases keep running until the model ends the turn
  or a budget stops it;
- headless `off`: no reminder and no stop;
- daemon / Web Shell: invalid params get a reminder after the 2nd error and stop
  at the 3rd under `stop`.

## Acceptance criteria

- `stop`: every governed detector stops exactly where it does today, and each
  always-on detector reminds first.
- `warn`: no governed stop except content/thought repetition. Budgets stop.
- `off`: no reminder and no governed stop. Budgets stop, and telemetry records
  `observed`.

## Follow-up

- Decide the default from the `loop_protection` decision data.
- The interactive continue / stop prompt, including hiding the dialog's
  disable option where it has no effect.
