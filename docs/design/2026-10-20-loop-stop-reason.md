# Loop stop reasons and per-cause stop messages

[English](2026-10-20-loop-stop-reason.md) | [简体中文](2026-10-20-loop-stop-reason.zh-CN.md)

- **Status**: implemented on the PR branch
- **Date**: 2026-10-20
- **Related**: issue #14828 (PR 1 of 2),
  [adaptive tool-call cap](2026-07-17-adaptive-tool-call-cap.md),
  [duplicate provider tool-call id guard](2026-08-19-duplicate-provider-toolcall-id-guard.md),
  [Web Shell loop-detection turn errors](web-shell-loop-detection-turn-error.md)

## Problem

Every loop-protection stop carries a `loopType`. Two loop types name two
different causes each:

| `loopType`                   | Causes                                                                                                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn_tool_call_cap`         | An explicit `model.maxToolCallsPerTurn` was exceeded (a budget the user set). The adaptive default passed its 1000-call backstop (a budget). The adaptive default passed its soft cap of 100 while one call had repeated 6 times (a loop signal). |
| `global_tool_call_duplicate` | The heuristic global-duplicate detector, which runs only with `model.skipLoopDetection: false`. The duplicate provider tool-call id breaker, an always-on protocol check that reuses this type (decision D1 of the duplicate-id design).          |

Every surface that explains a stop either hedges or describes the wrong cause:

- The headless hint for `turn_tool_call_cap` lists every possibility. For
  `global_tool_call_duplicate` it says the guard is always on and cannot be
  disabled through `model.skipLoopDetection`, which is false for the heuristic
  detector.
- The TUI loop dialog, the message after it and the OpenTUI adapter print one
  sentence for every stop and ignore `loopType`.
- Web Shell prints one sentence for every stop. The SDK UI normalizer drops
  `loopType` from `turn_error`, so the client cannot tell any two causes apart.
- Telemetry cannot separate the stuck halt from the backstop. The adaptive-cap
  design lists that as a follow-up.

## Goals and scope

Goals:

- Name the cause of every cap and duplicate stop, and carry it from the
  detector to every surface that explains the stop.
- Give the headless CLI, the TUI, OpenTUI and Web Shell a specific message per
  cause.

Out of scope:

- No change to when any detector fires or stops, to settings, or to `loopType`
  values.
- No new telemetry emission sites. The TUI, headless and subagent provider-id
  breakers still emit no `loop_detected` event.
- The subagent result shape (`loopType` on agent results) does not change.
- `model.loopProtection` and the reminder stage are PR 2 of #14828.

## Design

### Reason values

A new `LoopReason` enum sits next to `LoopType` in the core telemetry types.
Only the two shared loop types carry a reason.

| `loopType`                   | `loopReason`            | When                                                                                                  |
| ---------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `turn_tool_call_cap`         | `explicit_cap`          | An explicit `model.maxToolCallsPerTurn` was exceeded.                                                 |
| `turn_tool_call_cap`         | `backstop`              | The adaptive default exceeded its hard backstop (soft cap × 10).                                      |
| `turn_tool_call_cap`         | `stuck_repetition`      | The adaptive default exceeded its soft cap with one call repeated `GLOBAL_DUPLICATE_THRESHOLD` times. |
| `global_tool_call_duplicate` | `repeated_call`         | The heuristic global-duplicate detector: core request and result paths, and the daemon batch path.    |
| `global_tool_call_duplicate` | `provider_duplicate_id` | The duplicate provider tool-call id breaker in the TUI, the headless CLI and the daemon.              |

For the cap, an explicit value always yields `explicit_cap`. Under the adaptive
default, passing the backstop yields `backstop` even when a call also repeated,
because the budget is the part the user can change.

### Tool-call numbers

`turn_tool_call_cap` stops also carry two numbers:

- `toolCallCount`: the calls counted when the stop fired. The daemon checks the
  cap per batch before execution, so its count includes the skipped batch.
- `toolCallLimit`: the limit that applied. That is the explicit value, the
  backstop, or the soft cap for a stuck halt.

### One classification for both runtimes

`getTurnToolCallCapHalt()` returns the reason and the limit, or nothing when the
turn may continue. It replaces the boolean `shouldHaltOnTurnToolCallCap()`, whose
only caller was the daemon. Core's per-call check and the daemon's per-batch
check both call the classifier, so the two runtimes cannot drift.

### Carriers

| Layer                            | Fields                                                                                                                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core stream event `LoopDetected` | `value.loopReason`, `value.toolCallCount` and `value.toolCallLimit` next to `value.loopType`.                                                                                                                                                                 |
| `LoopDetectionService`           | `getLastLoopDetail()` returns the reason and numbers next to `getLastLoopType()`, resets per prompt, and is empty when a later detector in the same pass set another type.                                                                                    |
| Telemetry `loop_detected`        | `loop_reason`, `tool_call_count` and `tool_call_limit` OTEL attributes. The RUM event gets the same properties.                                                                                                                                               |
| Daemon `turn_error`              | `loopReason`, `toolCallCount` and `toolCallLimit` in the JSON-RPC error data and in the bridge's `turn_error` event, next to `loopType`.                                                                                                                      |
| SDK                              | `DaemonTurnErrorData` gains the fields. `DaemonUiErrorEvent` and `DaemonStatusTranscriptBlock` gain `loop` (`DaemonLoopStop`: `loopType`, `loopReason`, `toolCallCount`, `toolCallLimit`) on `loop_detected` turn errors, so the normalizer keeps `loopType`. |

The bridge replays the published `turn_error` event when Web Shell reloads a
live session, so the fields survive a page refresh.

### Messages

The CLI moves the headless labels into one module shared by the headless CLI,
the TUI and OpenTUI. A reason refines the label and the hint:

| Cause                   | Label                                                                                 | Hint                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `explicit_cap`          | The turn reached the per-turn tool-call limit set by `model.maxToolCallsPerTurn` (N). | Raise the value, or set 0 to disable the cap.                                                                   |
| `backstop`              | The turn reached the backstop of the adaptive per-turn cap (N calls).                 | Set `model.maxToolCallsPerTurn` to choose a fixed cap instead (0 disables it).                                  |
| `stuck_repetition`      | Past N tool calls the model kept repeating the same call.                             | Give a more specific instruction. An explicit `model.maxToolCallsPerTurn` replaces this check with a fixed cap. |
| `repeated_call`         | The existing global-duplicate label.                                                  | Set `model.skipLoopDetection` to true to disable it. This corrects the always-on hint.                          |
| `provider_duplicate_id` | The provider replayed a tool call id that had already run.                            | An always-on protocol guard; `model.skipLoopDetection` does not affect it.                                      |

Without a reason, each surface keeps its current text.

- Headless: the stderr line and the JSON `errorMessage` use the refined label
  and hint.
- TUI: the loop dialog shows the cause under its title, and the message after
  "keep" uses the headless wording. OpenTUI prints the same message.
- Web Shell: localized text (English and Chinese) for each cause the daemon can
  produce: the three cap reasons, both duplicate reasons,
  `invalid_tool_params_stagnation` and `repeated_tool_execution_failure`. Other
  or missing causes keep the generic sentence.

## Compatibility

All fields are optional and additive. Older clients ignore them. Newer clients
fall back to the generic text when an older daemon sends none. `loopType`
values, the `turn_error` / `errorKind` contract and the `StopFailure` hook's
`error_details` (the loop type) do not change. The headless message text
changes for cap and duplicate stops; that text was never a parsed contract.

The exported transcript document bundles Web Shell's whole i18n table, so the
new keys raise its renderer from 2,041,583 to 2,046,722 bytes (+5,139,
measured on main 158ff26aeb without and with the change). The renderer budget
in `packages/web-templates/src/export-html/build.mjs` rises from 2,045,000 to
2,050,000, keeping the headroom the previous raise left.

## Files affected

- Core: `telemetry/types.ts`, `telemetry/qwen-logger/qwen-logger.ts`,
  `services/loopDetectionService.ts`, `core/turn.ts`, `core/client.ts`,
  `index.ts`.
- CLI: a new shared loop message module, `nonInteractiveCli.ts`,
  `ui/hooks/use-llm-stream.ts`, `ui/types.ts`,
  `ui/components/DialogManager.tsx`,
  `ui/components/LoopDetectionConfirmation.tsx`,
  `ui/opentui/event-adapter.ts`, `acp-integration/session/Session.ts`.
- ACP bridge: `session-control-plane.ts`.
- SDK: `daemon/events.ts`, `daemon/ui/types.ts`, `daemon/ui/normalizer.ts`,
  `daemon/ui/transcript.ts`, `daemon/ui/index.ts`, `daemon/index.ts`.
- Web Shell: `adapters/transcriptToMessages.ts`,
  `adapters/localizedMessages.ts`, `i18n.tsx`.
- Web templates: the export renderer budget in `src/export-html/build.mjs`.
- Docs: the telemetry reference.

## Validation

Unit tests cover:

- cap classification and its precedence;
- the reason from every producer;
- the event value and the telemetry attributes;
- the daemon `turn_error` data and the bridge publication;
- the SDK normalizer and transcript block;
- the CLI message formatter, the dialog and the OpenTUI adapter;
- the Web Shell adapter text in both languages.

End-to-end:

- Headless against a mock OpenAI-compatible server: an explicit-cap stop and a
  stuck halt print the refined message, and a consecutive-identical stop is
  unchanged.
- TUI in tmux: the dialog shows the cause.
- Real daemon and Web Shell (Playwright): an explicit-cap stop and a stuck halt
  show their own text, including after a page refresh.

## Acceptance criteria

- Every cap and duplicate stop carries a reason in the core event, telemetry
  and the daemon `turn_error`. Other loop types carry none.
- No detector fires or stops at a different point. Existing loop-detection
  tests pass unchanged apart from the added fields.
- Each surface shows the cause-specific text, and falls back to today's text
  when the reason is missing.

## Follow-up

- PR 2 of #14828: `model.loopProtection` and a reminder before each stop.
- The subagent provider-id breaker reports no `loopType`. It could report
  `global_tool_call_duplicate` with `provider_duplicate_id`.
- The TUI, headless and subagent provider-id breakers emit no `loop_detected`
  telemetry.
- The TUI loop dialog offers "Disable loop detection for this session" for
  every cause, but the TUI provider-id breaker ignores that choice. Now that
  the dialog names the cause, it could hide the option where it has no effect
  (the interactive prompt in #14828's follow-up list).
