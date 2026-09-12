# AutoSkill experience signals: replacing raw tool-call counts with retry evidence

[English](2026-08-13-auto-skill-experience-trigger.md) | [简体中文](2026-08-13-auto-skill-experience-trigger.zh-CN.md)

## Problem

Previously, `scheduleSkillReview` only checked `toolCallCount >= AUTO_SKILL_THRESHOLD`
(20). Principle 4 of the original design (`docs/design/skill-nudge/skill-nudge.md`)
used call density as a proxy for task complexity, retries, and strategy changes.
That proxy can be wrong in both directions:

- A routine session that reads 25 files triggers a review, potentially spending
  eight fork-agent turns only to conclude "Nothing to save."
- A five-call debugging session that takes a test from red to green never reaches
  the review threshold.

The review prompt already asks for trial and error, changing course, or a user
expecting a different outcome. The trigger should detect deterministic evidence
of these events instead of estimating them from call volume.

## Solution

Add a **deterministic experience-signal detector** with no LLM calls. It accumulates
accepted tool outcomes with negligible linear overhead and provides two paths:

1. **Experience fast path**: a retry signal exists and the window contains at least
   `AUTO_SKILL_EXPERIENCE_FLOOR` calls (5), giving the reviewer enough material.
2. **Count backstop**: at least `AUTO_SKILL_THRESHOLD` calls (20), including a
   completed `write_file`, `edit`, `notebook_edit`, `run_shell_command`, or `exec`.
   Sessions using only read, list, or search tools no longer trigger this backstop.

Code Mode wraps internal tool calls in an outer `exec`; those internal calls do
not enter the experience window as separate history functionCalls. Add `exec`
beyond the four tools prescribed by issue #9062 to preserve the Code Mode
backstop. Count each outer `exec` once, without expanding its internal calls or
parsing its script. As with shell, classification uses the tool category, so an
`exec` that only reads also counts as substantive work. This is an explicit
prefilter tradeoff; the review agent still decides whether anything merits saving.

### Experience signals

| Signal               | Definition                                                                           | Detection                                                                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retryArc`           | A tool fails and the same tool later succeeds: a recovered retry                     | Classify structured `status` / `executionStatus` at completion and stage by `callId`; consume after the corresponding `ToolResult` or `Retry` is accepted, or after direct `LlmClient.addHistory`. Shell also requires a structured numeric exit code; unknown exits are neutral. |
| `userSteer`          | The user intervenes while the agent works, expecting a different approach or outcome | Not inferred from history. Set when `LlmClient` completes `SendMessageType.Steer`, or accepts a ToolResult submission carrying steer input.                                                                                                                                       |
| `hasSubstantiveWork` | The window includes file writing, notebook editing, shell execution, or exec         | Used only by the backstop to exclude sessions using only read, list, or search tools.                                                                                                                                                                                             |

A separate `testFlip` (red-to-green test) signal was considered, but it always
implies `retryArc` in the same scan: the successful test closes the retry arc.
It adds nothing to the gate, so it is folded into `retryArc` without a separate
test-command detector.

### Window and duplicate prevention

`LlmClient` receives structured outcomes at tool completion: `callId`, `status`,
`executionStatus`, `errorType`, `responseParts`, and optional `exitCode`. Reliable
successes and failures are staged by `callId`. Consume each once after its
ToolResult (including one resubmitted as Retry) is accepted into history or written
through direct `addHistory`. The history-dedup path consumes immediately when the
same `callId` is already paired. Rejected submissions can therefore be retried,
and resubmitting accepted results is a no-op. Classification state lives in a
client sidecar, not in model-visible `functionResponse.response`.

Tool completion updates `toolCallCount` and `hasSubstantiveWork`. Calls that never
executed do not count. Calls cancelled after execution completed retain
`status: cancelled` and their actual `executionStatus` of `success` or `error`:
they count but contribute neither a successful nor a failed experience. Set
`userSteer` on Steer arrival or accepted ToolResult submissions carrying steer.
Reset the signals and count together when review is scheduled or an equivalent
review is already running. Session reset also clears unconsumed outcome sidecars.

Tools cancelled during execution must return `aborted: true`. The scheduler sets
`executionStatus: cancelled`, so the client neither counts the call nor stages a
failure. Workflow cancellation before startup and during a registered run follow
the same contract. Mid-run cancellation uses the registry's `cancelled` status,
even when the outer signal remains live. Genuine execution failures do not add
this flag and can still form a retry arc with a later success.

### Gate logic (`MemoryManager.scheduleSkillReview`)

```text
disabled / skillsModified            → preserve existing skips
fastPath  = (retryArc || userSteer) && toolCallCount >= 5
backstop  = hasSubstantiveWork && toolCallCount >= AUTO_SKILL_THRESHOLD
!fastPath && !backstop               → skipped
                                      → 'below_threshold'
fastPath || backstop                 → scheduled
```

`AUTO_SKILL_THRESHOLD` is fixed at 20 and cannot be overridden by callers.

The in-flight dedup check follows the gate, so `already_running` means the window
would have triggered a review. The client resets that window just as it does for
`scheduled`, preventing old signals from replaying immediately after the active
review finishes.

## Integration points

- `packages/core/src/memory/experience-signals.ts` (new): structured outcome
  classification, work detection, and a three-state accumulator, independently
  unit-testable.
- `packages/core/src/memory/manager.ts`: `experienceSignals` is optional for
  compatibility. Internal callers always supply complete signals; omitted signals
  retain the count-only behavior. Adds `AUTO_SKILL_EXPERIENCE_FLOOR`.
- `packages/core/src/core/client.ts`: owns window signals and the `callId` outcome
  sidecar; forwards signals to the manager in `runManagedAutoMemoryBackgroundTasks`
  and resets the window on scheduled / already-running results.
- Interactive CLI, history-dedup, and headless completion paths forward structured
  outcomes consistently. Public model protocols, JSON output protocols, and tool
  text budgets remain unchanged.

## Non-goals

- No LLM classifier in the trigger path: per-turn inference is too expensive, and
  semantic assessment belongs to the review agent after this prefilter.
- No text analysis of user corrections: multilingual regexes are fragile, and
  Steer is already a first-class event.
- No new threshold or floor settings.
- No changes to the review agent, permission boundaries, or confirmation flow.

## Validation

- `experience-signals.test.ts` (new): reliable and neutral outcomes, same-tool
  ordering, unknown shell exits, and substantive-work boundaries.
- `manager.test.ts`: table-driven fast-path floor, backstop, and read-only rejection
  boundaries. `skillReviewNudge.integration.test.ts` retains fast-path and backstop
  integration smoke coverage.
- `client.test.ts`: ToolResult acceptance/rejection, Retry single consumption,
  Steer, and both window resets. CLI tests pin structured-outcome wiring and
  compatibility with the structured-output sibling path.
- Regression acceptance: an all-`exec` window with no retry arc or steer skips at
  19 calls and schedules at 20; derive signals from the real tool classifier.
  Actual cancelled Workflow results passing through the scheduler and client do
  not count or stage failures, and a later success creates no retry arc. Genuine
  failure followed by success still creates one. Removing the `exec` set entry or
  cancellation flag must make the respective regression tests fail.
- E2E test plan: `.qwen/e2e-tests/2026-08-13-auto-skill-experience-trigger.md`.
