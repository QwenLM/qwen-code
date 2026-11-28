# Remove loop detection

[English](2026-11-25-remove-loop-detection.md) | [简体中文](2026-11-25-remove-loop-detection.zh-CN.md)

- **Status**: implemented (step 3 of Delivery)
- **Date**: 2026-11-25
- **Supersedes**: [loop protection setting](2026-10-21-loop-protection-setting.md),
  [loop stop reasons](2026-10-20-loop-stop-reason.md) (except the two stops
  kept below), [adaptive tool-call cap](2026-07-17-adaptive-tool-call-cap.md),
  [read-only exploration convergence](tool-exploration-convergence.md),
  [ACP repeated tool-call protection](acp-repeated-tool-call-protection.md)
- **Related**: #14828, #15016, #13321, #10887, #5019

## Problem

Qwen Code judges whether the model is stuck and then reminds it or stops it.
These judgments have grown into several separate mechanisms with three settings,
an environment variable, a TUI dialog, telemetry events and per-surface
variants in the core client, subagents and daemon sessions. Each needs its own
thresholds, exemptions (stateful reads, parallel read batches, `/btw`, retries)
and wording, and each can misjudge a productive turn.

Other coding-agent harnesses mostly do not do this. For Claude Code, Codex,
Pi, Kimi Code and mini-swe-agent, the agent-loop descriptions in Harness Lens
(each claim linked to source) list no loop detector. DeepSeek Harness only
reminds (at 3, 5 and 8 identical calls). OpenCode asks for permission after 3
identical calls, and Grok Build relies on signals from xAI's own servers. How
these two behave in headless runs was not verified. Gemini CLI, which Qwen Code
forked from, and OpenHands stop.

A stop is costly in unattended runs, where it ends the task. On the Harness
Leaderboard (Qwen Code 0.25.2, which still stopped), 31 of 50 sampled failed
Flint DeepSWE trials ended on the loop guard. On one of those tasks, a harness
without a loop guard saw the model repeat an invalid edit call 102 times and
then recover for 116 more calls. v0.26.0 already changed the default to
reminders (#15016); this proposal goes further and removes the judgments, for
simplicity. No measurement shows that reminders hurt. The reason to drop
them is the code and the misjudgment surface they carry, not their effect.

## Current state (upstream main, 2026-11-25)

| Mechanism                                                                                                                   | Where                                                | Default behavior                      |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------- |
| Always-on detectors: consecutive identical calls (remind 3, stop 5), shell inspection stagnation (6 / 8)                    | core client, subagents                               | remind (`model.loopProtection: warn`) |
| Opt-in heuristics: content and thought repetition, read-file loop, action stagnation, global duplicate, alternating pattern | core client, subagents; global duplicate also daemon | off (`model.skipLoopDetection: true`) |
| Adaptive tool-call cap: soft 100 (stuck repetition reminds), hard backstop 1000 (stops)                                     | core client, subagents, daemon                       | on                                    |
| Explicit `model.maxToolCallsPerTurn`                                                                                        | core client, subagents, daemon                       | unset                                 |
| Daemon invalid-params stagnation (remind 2, stop 3)                                                                         | daemon                                               | remind                                |
| ACP repeated tool-failure guard (`QWEN_CODE_ACP_REPEATED_TOOL_FAILURE_GUARD`: off / shadow / warn / enforce)                | daemon                                               | shadow (telemetry only)               |
| Read-only exploration convergence reminder (at `maxToolCallsPerTurn` reads)                                                 | core client, daemon                                  | on                                    |
| Duplicate provider tool-call id breaker                                                                                     | core client, subagents, daemon                       | stops                                 |
| TUI "potential loop" dialog with a session disable                                                                          | Ink TUI                                              | shown on a stop                       |

`#14828` and the code comment above `TOOL_CALL_LOOP_THRESHOLD` say that
DashScope no longer rejects repeated identical calls. That is not true, but the
rejection is narrower than #5019 suggests. Probes on 2026-11-25 (Standard CN
and Token Plan) sent a history with N consecutive rounds of the same
`read_file` call, called with `path` where the schema requires `file_path`, each
answered with the schema error. qwen3.7-plus returned
`400 invalid_parameter_error "Repetitive tool calls detected in the
conversation history..."` from about N = 20 (thinking on; between 40 and 80
with thinking off); qwen3.6-plus, qwen3.7-max and qwen3.6-flash also returned
400 at N = 30. qwen3.5-plus, qwen3.8-flash, qwen3.8-max, qwen4-max and the
DeepSeek, Kimi and GLM models on Token Plan did not, up to N = 30. qwen3.7-plus
is the first model of the Token Plan preset. The rejection depends on content
and is not deterministic: at N = 25 the same request was rejected two times
out of three, and repeated successful reads, a different error text, or the
schema error with a valid argument name were never rejected. A new user message
appended after the last tool result is rejected again, while an assistant text
reply or one different tool call round in between is accepted. Through the
client itself the rejection did not reproduce: resuming a session with 25 such
rounds against qwen3.7-plus (Qwen Code 0.27.4, with its system prompt, tools and
loop reminders) returned 200 on every request, and `/compress` worked. The
Coding Plan models `qwen3-coder-plus`,
`qwen3-coder-next` and `qwen3-max-2026-01-23` are not served on Standard CN and
were not probed, nor was Qwen OAuth (`coder-model`).

## Goals and scope

Goals:

- No component judges whether the model is looping. The model decides; tool
  results and errors are returned as they are.
- One budget remains: an explicit `model.maxToolCallsPerTurn`, a hard cap the
  user opts into. There is no default cap.
- The duplicate provider tool-call id breaker remains. It handles a provider
  protocol fault (a provider replays a call id that was already answered;
  executing it again would repeat side effects), not model behavior.
- A DashScope repetitive-call 400 gets a message that says what happened and
  how to recover.
- Removed settings are ignored with a one-time warning, not rejected.

Out of scope:

- Renaming the `loop_detected` stop channel (see Decisions).
- Turn or time limits that already exist elsewhere: `maxSessionTurns`, a
  subagent's `maxTurns` / `maxTimeMinutes`, the fork subagent's 200 turns,
  workflow subagents' 50 turns / 10 minutes, the daemon's prompt deadline, and
  stream timeouts.
- The todo reminder and other reminders that do not judge looping.
- A built-in replacement. Users who want a guard write a hook (see Extension
  point).

## Design

### What is removed

- `LoopDetectionService` and `loop-protection.ts` in core: every detector,
  reminder and per-session disable, and their calls in `client.ts`, `turn.ts`,
  `agent-loop.ts` and the subagent runtime (`agent-core.ts`).
- The adaptive cap: the soft cap of 100, stuck-repetition halts and the 1000
  backstop.
- The read-only exploration convergence reminder (`ToolExplorationBudget`,
  #13601). This rejects #13321.
- In daemon sessions (`Session.ts`): the invalid-params stagnation guard, the
  opt-in global-duplicate halt, the adaptive cap, the exploration budget and the
  repeated tool-failure guard (`repeated-tool-failure-guard.ts`, #8469, and the
  `QWEN_CODE_ACP_REPEATED_TOOL_FAILURE_GUARD` variable). This rejects #10887.
- Settings `model.loopProtection` and `model.skipLoopDetection`.
- The TUI `LoopDetectionConfirmation` dialog. A stop is shown as a message.
- Telemetry events `loop_protection`, `loop_detection_disabled` and
  `repeated_tool_failure_guard` with their metrics; `LoopType` and `LoopReason`
  values that no stop produces any more.
- Web Shell and SDK presentation of removed stop causes (localized texts for
  backstop, stuck repetition, repeated call, invalid params and repeated
  failure). A persisted transcript carrying one of them falls back to the
  generic stop text.

### What stays

| Stop                                          | `loopType` / `loopReason`                              | Surfaces                       |
| --------------------------------------------- | ------------------------------------------------------ | ------------------------------ |
| Explicit `model.maxToolCallsPerTurn` exceeded | `turn_tool_call_cap` / `explicit_cap`                  | core client, subagents, daemon |
| Provider replayed an answered tool-call id    | `global_tool_call_duplicate` / `provider_duplicate_id` | core client, subagents, daemon |

Both keep today's stop path: the `LoopDetected` event, `turn_error` with
`errorKind: loop_detected`, the `StopFailure` hook with `loop_detected`, the
`loop_detected` telemetry event and the existing payload fields. The explicit
cap keeps its released semantics: the turn halts on the call after the cap; a
daemon tool batch that would cross it is skipped whole. A small per-turn
counter replaces the service; the turn resets stay where they are (user turns,
blocking Stop-hook continuations and Goal turns each start a fresh count).

Tool error texts that are not a loop judgment stay as they are: the
scheduler's retry directive on repeated schema errors, and the retry directive
a refused partial edit gets from its second refusal in a response (truncated
output or incomplete arguments). Only the daemon's stop after the third
refused partial edit goes, with the other stops.

### Settings

| Key                         | After                                                                                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model.maxToolCallsPerTurn` | Default unset: no cap. A positive value is a hard cap. Zero or a negative value means no cap. A user who explicitly set 100 (today's default) keeps a hard cap of 100. |
| `model.loopProtection`      | Removed. If present, ignored with a warning naming the removal, shown for each settings file that has it, like the other settings-key warnings.                        |
| `model.skipLoopDetection`   | Removed. Same handling.                                                                                                                                                |

The settings schema, the generated VS Code schema and the settings reference
drop the two keys and describe the new `maxToolCallsPerTurn` default.

### DashScope repetitive-call 400

No workaround is added (no provider-specific reminder or history rewrite). The
API error formatter recognizes the message `Repetitive tool calls detected in
the conversation history` and appends a hint, the same way it appends one to a
429:

> The provider rejected the request because the conversation repeats the same
> tool call. The next message may be rejected for the same reason; run
> /compress to summarize the history, or /clear to start over.

Daemon sessions append the same hint to the turn error. `/compress` sends the
history with thinking disabled, where the measured threshold is higher, and
`/clear` always recovers. The hint is independent of the removal: under
today's `warn` default the 400 is already reachable, so it ships first
(#18317).

### Extension point

A loop guard can be written as a hook. Checked on 2026-11-25 by reading main
and by a headless run of the released 0.27.4 against a mock server whose model
repeats `read_file` with an invalid `path` argument, and then with a valid one:

- `PreToolUse` fires for every call, including one later rejected for invalid
  parameters, and sees the tool name and input. It can deny the call, and its
  `additionalContext` reaches the next request.
- `PostToolUse` fires only for executed calls; its `additionalContext` is
  appended to the tool result.
- `PostToolUseFailure` does not fire for a call rejected before execution
  (`invalid_tool_params`, `not_started`).
- Since #18345, a tool hook's `continue: false` ends the turn after the
  current batch (`PreToolUse`, `PostToolUse`, `PostToolUseFailure` and
  `PostToolBatch`; ledger C14 and T11). Before it, `PostToolUse` with
  `continue: false` only turned that call's result into an error and the run
  went on.

So a hook can remind, deny and stop. A restored `ask_user_question` call after
a daemon restart is the one daemon path where a tool hook stop still only fails
the call.

The hooks guide gets a short example (Example 4), linked from the
`model.maxToolCallsPerTurn` reference: a `PreToolUse` command hook that keeps
the session's last call in a temporary file, adds a reminder after three
identical calls in a row and ends the turn at six.

## Decisions and rationale

- **Remove instead of keeping reminders.** Reminders are cheap per request,
  but every detector still carries thresholds, exemptions and per-surface
  wiring, and its misjudgments land on users. Leaving the decision to the model
  gives one rule for every surface instead of a set of thresholds per surface.
  (Maintainer decision.)
- **Remove the convergence reminder and the ACP repeated-failure guard too.**
  Both judge progress from call patterns; keeping them would keep the same
  class of code. Their issues (#13321, #10887) are answered by the hook
  extension point. (Maintainer decision.)
- **No default cap.** With the 1000 backstop gone, regular and background
  subagents, headless runs, and daemon prompts (including cron, Goal,
  notification and channel turns) have no built-in call bound unless the user
  sets `maxToolCallsPerTurn` or another existing limit applies. A default cap
  is itself a loop judgment (a number chosen to mean "stuck"), and the callers
  that need a bound already have turn, time or deadline limits. (Maintainer
  decision.)
- **Keep the `loop_detected` channel for the two remaining stops.** Renaming it
  would change the SDK's `DAEMON_ERROR_KINDS`, the `StopFailure` hook enum, Web
  Shell, acp-bridge and telemetry consumers at once, for a name. The cost is
  that the name no longer matches: both stops are a budget or a protocol fault,
  not a loop. A rename can follow separately.
- **DashScope: message only (option A).** The affected models are the
  qwen3.6 and qwen3.7 families, including qwen3.7-plus, the first model of the
  Token Plan preset; qwen3.5-plus, qwen3.8, qwen4-max and non-Qwen models are
  not affected. A provider-specific reminder would reintroduce a detector.
  (Maintainer decision.)
- **Ignore removed settings.** Rejecting them would break existing
  `settings.json` files for a key that no longer does anything.

## Compatibility

- A turn that today gets a reminder (identical calls, shell inspection, stuck
  repetition, invalid params, read-only exploration) gets none. A turn that
  today stops at the 1000 backstop runs on. Users who set
  `model.loopProtection: "stop"` lose the stops.
- On qwen3.6 and qwen3.7 models a model that keeps repeating a call DashScope
  rejects may now get the DashScope 400 instead of a client reminder, and the
  session needs `/compress` or `/clear`. Today's `warn` default already
  reaches the same 400 when the model ignores the reminder.
- Protocol: `turn_error`, `errorKind: loop_detected`, `loopType`, `loopReason`,
  `toolCallCount` and `toolCallLimit` keep their shape. Clients stop receiving
  the removed `loopType` and `loopReason` values. The SDK keeps
  `loop_detected` in `DAEMON_ERROR_KINDS`.
- Core exports: `LoopDetectionService`, `loop-protection.ts` exports and the
  removed telemetry classes and enum values disappear from
  `@qwen-code/qwen-code-core`.
- Hooks: `StopFailure` still fires with `loop_detected` for the two remaining
  stops.

## Risks

- A runaway model in an unattended surface burns tokens until an outer limit
  stops it. Mitigation: the explicit cap, existing turn and time limits, and
  hooks.
- Users of the convergence reminder or the ACP guard lose them; #13321 and
  #10887 are closed with the hook pointer.
- When it fires, the DashScope 400 strands a session on the affected models
  until the user compacts or clears.

## Files affected

- Core: `services/loopDetectionService.ts`, `services/loop-protection.ts`,
  `services/tool-exploration-budget.ts` (removed); `core/client.ts`,
  `core/turn.ts`, `core/agent-loop.ts`, `agents/runtime/agent-core.ts`,
  `agents/runtime/agent-headless.ts`, `agents/runtime/terminate-reason.ts`,
  `config/config.ts`, `telemetry/types.ts`, `telemetry/loggers.ts`,
  `telemetry/metrics.ts`, `telemetry/qwen-logger/qwen-logger.ts`,
  `utils/errorParsing.ts`, `index.ts`.
- CLI: `acp-integration/session/Session.ts`,
  `acp-integration/session/repeated-tool-failure-guard.ts` (removed),
  `config/settingsSchema.ts`, `config/config.ts`,
  `config/migration/versions/v1-to-v2-shared.ts`, `config/shared-env-keys.ts`,
  `nonInteractiveCli.ts`, `utils/loop-detected-message.ts`,
  `ui/components/LoopDetectionConfirmation.tsx` (removed) and its TUI wiring,
  the OpenTUI adapters.
- Web Shell and SDK: removed stop-cause texts and their localized strings.
- Generated: the VS Code settings schema.
- Docs: the settings and telemetry references; row T22 of the
  [loop capability ledger](2026-11-15-loop-capability-ledger.md) and the
  loop-protection rows of the
  [unified agent loop](2026-10-23-unified-agent-loop.md) design, in both
  languages, which describe the removed guards as current behavior.

The exact list is settled during implementation; the boundary is the table in
Current state.

## Delivery

1. **DashScope hint** (small, independent): the formatter and daemon hint and
   their tests (#18317, merged).
2. **Tool hooks end the turn** (#18345, merged): `continue: false` from any
   tool hook ends the turn after the batch (ledger C14 and T11, #18217), so the
   hook extension point can stop.
3. **Removal**: core, subagents, daemon, settings, TUI, telemetry and docs, in
   one PR, since the settings and the shared counter cross all three runtimes.
4. **Presentation cleanup**: Web Shell and SDK texts for the removed causes.

## Validation

Unit tests: the explicit cap in the core client, subagents and daemon (halt
point, batch skip, turn resets); the provider-duplicate breaker; the removed
settings' warning; the DashScope hint. Tests of removed code are deleted with
it.

End to end, against a mock OpenAI-compatible server:

- headless: a model that repeats one identical call 30 times gets no reminder
  and no stop, and the run ends when the model stops calling tools;
- headless with `model.maxToolCallsPerTurn: 5`: the turn stops on the 6th call
  with the explicit-cap message;
- daemon / Web Shell: repeated invalid params and repeated failures get no
  reminder and no stop; the explicit cap stops with `turn_error`
  `loop_detected` / `explicit_cap`;
- a replayed provider call id still stops;
- settings with `model.loopProtection` or `model.skipLoopDetection` print a
  warning naming each key and run;
- a mock 400 with the DashScope message shows the hint in headless text and
  JSON output and in a daemon session (done for #18317).

## Acceptance criteria

- No reminder or stop based on call patterns in any surface.
- The explicit cap and the provider-duplicate breaker stop exactly as today.
- Without `maxToolCallsPerTurn`, no tool-call bound applies.
- Removed settings and the removed environment variable have no effect beyond
  the one-time settings warning.
- The DashScope repetitive-call 400 shows the recovery hint.

## Open questions

- Whether `loop_protection` decision data from #15016 exists. It would show how
  often a reminded turn recovered; it does not change this decision.
- A rename of the `loop_detected` channel, if wanted later.
