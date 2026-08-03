# ACP Repeated Tool-Call Protection

Date: 2026-07-31
Status: Implemented, pending shadow rollout; revised for PR #8176 and PR #8180
Area: ACP foreground prompt loop

## Summary

ACP should stop an automatic model loop when the same resolved tool repeatedly
reaches the same trusted execution failure. The protection is conservative:
it observes only finalized, fully settled tool batches; gives the model one
fixed corrective reminder; and stops only if the next batch repeats the same
failure.

The first version is an in-memory, per-prompt semantic guard. It does not
replace the existing protections for duplicate provider call IDs, invalid
parameters, or the per-turn tool-call cap. It also does not attempt to provide
cross-restart exactly-once execution.

Two telemetry changes are prerequisites:

- [PR #8176](https://github.com/QwenLM/qwen-code/pull/8176) makes terminal
  `status` authoritative and normalizes cancellation and error fields.
- [PR #8180](https://github.com/QwenLM/qwen-code/pull/8180) adds the independent
  `executionStatus` axis and fixes ACP permission-cancellation classification.

Enforcement must remain disabled when either contract is unavailable or
unknown. ACP's internal batch receipt must also preserve the structured
execution error type that PR #8180 already freezes while `invocation.execute()`
settles; the public response and JSON protocols do not need another field.

## Problem

The current ACP path has three useful but incomplete circuit breakers:

- repeated provider call IDs are deduplicated;
- repeated invalid tool parameters stop after three failures; and
- every prompt has a total tool-call cap.

They do not catch the common semantic loop in which the model keeps issuing
fresh call IDs for a tool that is actually entered and repeatedly fails for the
same structured reason. A high total-call cap stops the eventual runaway but
wastes model rounds, tool latency, and tokens before doing so.

Terminal `error` alone is not a safe signal. It currently includes calls that
never executed, such as validation and permission failures, as well as failures
that happen after successful execution. Treating all of those as repeated tool
failures creates false positives and, in particular, turns user cancellation
into a product stability problem. The 468 recent permission cancellations that
were recorded as errors are a concrete example.

## Goals

- Detect repeated failures of the actual tool execution boundary.
- Never count user cancellation, permission denial, validation failure,
  post-processing failure, historical unknowns, or duplicate provider events.
- Never skip or cancel the tool calls in the currently admitted model batch.
- Give the model one bounded chance to change approach before stopping.
- Preserve complete tool results and a clear stop reason in ACP history.
- Make shadow and enforcement decisions explainable without logging arguments,
  results, paths, or raw error messages.
- Reuse existing ACP loop protection and telemetry conventions with a small,
  testable state machine.

## Non-goals

- Exactly-once execution across process crashes, provider reconnects, or
  failover.
- Replacing provider call-ID deduplication.
- Replacing the invalid-parameter fast path.
- Inferring retryability from free-form error text.
- Persisting the guard across a daemon restart, rewind, branch, or fork.
- Applying the guard to TUI, Stop-hook/Todo automatic continuations, cron,
  notifications, subagent-internal loops, or third-party producers in the
  first release.
- Automatically retrying a tool or suppressing an admitted call.

Those are separate problems with different trust and durability boundaries.
Combining them with semantic loop detection would make the first release harder
to validate without improving its decision signal.

## Prerequisite outcome contract

The reducer consumes the integrated result of PR #8176 and PR #8180. It must
not reconstruct execution state from legacy `success`, error strings, UI
frames, or spans.

| Terminal `status` | `executionStatus`    | Meaning for this guard                                                 |
| ----------------- | -------------------- | ---------------------------------------------------------------------- |
| `success`         | `success`            | Reset                                                                  |
| `success`         | `not_started`        | Reset; protocol-level synthetic result                                 |
| `error`           | `not_started`        | Reset; validation, permission rejection, hook block, or lookup failure |
| `error`           | `error`              | Eligible only with a trusted frozen `executionErrorType`               |
| `error`           | `success`            | Reset; execution succeeded and later processing failed                 |
| `cancelled`       | any                  | Reset                                                                  |
| any               | `cancelled`          | Reset                                                                  |
| any               | missing or `unknown` | Reset and downgrade the prompt to at most `warn`                       |

The two invalid combinations defined by PR #8180,
`success/error` and `success/cancelled`, are treated as contract violations:
reset the guard, emit a diagnostic, and do not enforce.

`status` wins cancellation arbitration. If an execution error races with a
user or parent cancellation and the terminal status is `cancelled`, the call
does not count.

Terminal `errorType` is not the repeated-failure key. A post-execution hook,
image bridge, or other finalization step may replace it even when
`executionStatus` remains `error`. The internal receipt therefore copies the
`executionErrorType` captured at execution settle. Missing or
`ToolErrorType.UNKNOWN` execution classifications are ineligible.

## Identity and eligibility

An eligible failure has:

- terminal `status = error`;
- `executionStatus = error`;
- a non-empty structured `executionErrorType` other than
  `ToolErrorType.UNKNOWN`;
- a resolved built-in or MCP tool identity from the tool registry; and
- a final result produced by a fully settled ACP foreground batch.

The failure key is:

```text
(policyToolName, executionErrorType)
```

`policyToolName` is the existing resolved `tool.name` value that ACP uses for
permission checks, not a model-provided display name. MCP registered names
already include their server-qualified identity. `executionErrorType` is frozen
at execution settle, independently from the terminal call error.

Arguments are deliberately excluded. This catches parameter thrashing against
the same execution boundary, while the threshold and two-batch requirement
provide false-positive headroom. Raw arguments, output, paths, and error text
must not be stored in the guard or emitted to central telemetry.

Unknown tools, blank identities, unclassified errors, and third-party events
with incomplete outcome fields are not eligible.

## State machine

The Session owns one guard per foreground ACP prompt:

```ts
type RepeatedToolFailureState =
  | { phase: 'idle' }
  | {
      phase: 'tracking';
      key: FailureKey;
      failureCount: number;
      batchCount: number;
    }
  | {
      phase: 'warned';
      key: FailureKey;
      failureCount: number;
      batchCount: number;
    }
  | {
      phase: 'latched';
      key: FailureKey;
      failureCount: number;
      batchCount: number;
    };
```

The threshold is fixed at eight eligible failures across at least two complete
model batches. It is a code constant in the first release, not a user setting.

After every `runToolCalls` batch has fully settled:

1. Ignore duplicate provider events already handled by the call-ID deduper.
   They neither advance nor reset semantic state.
2. Drain accepted mid-turn input through the existing Session boundary. If new
   external input or a queued full prompt is observed, reset to `idle` and
   leave the existing input and FIFO behavior authoritative. If the drain is
   unreliable, reset and disable enforcement for the rest of the prompt.
3. Reset to `idle` if the batch is incomplete, violates the outcome contract,
   or contains any reset-class outcome.
4. Collect eligible failure keys from the batch. If there is not exactly one
   unique key, reset to `idle`.
5. If the key differs from the tracked key, begin a new streak from this batch.
   Otherwise add the batch's eligible failure count and increment the batch
   count.
6. When `failureCount >= 8` and `batchCount >= 2`, transition to `warned` and
   request the mode-specific reminder action shown below.
7. If the immediately following complete batch contains the same eligible key
   and no reset condition, execute and record the whole batch, then transition
   to `latched`. The configured mode determines whether another model request
   is sent.

The state transition and control action are separate:

| Mode      | Threshold reached                   | Next matching batch                                   |
| --------- | ----------------------------------- | ----------------------------------------------------- |
| `shadow`  | Record `would_warn`; inject nothing | Record `would_stop`, latch, and continue              |
| `warn`    | Inject once and record `warned`     | Record `would_stop`, latch, and continue              |
| `enforce` | Inject once and record `warned`     | Record `stopped`, latch, and stop before another send |

Once latched, the guard emits no further decisions for that prompt. This avoids
repeated reminders and telemetry amplification in shadow and warn modes.

The reminder is:

> System: the same tool execution has failed repeatedly for the same classified
> reason. Do not repeat the same approach. Inspect the returned result, change
> the approach or required preconditions, or explain the blocker.

The stopped message is:

> System: Automatic continuation stopped because the same tool execution
> failure continued after a corrective reminder. New user input is required to
> continue.

The messages contain neither raw arguments nor raw error text. They are fixed
system context, not fabricated user input.

## Batch and concurrency rules

The unit of reduction is a completed model tool batch, not an individual
streaming event. This is required because Agent calls may execute concurrently
and terminal frames may arrive in a different order from the model's function
calls.

`runToolCalls` returns a narrow batch receipt only after all admitted calls have
settled. Each receipt entry contains `callId`, `policyToolName`, terminal
`status`, frozen `executionStatus`, frozen `executionErrorType`, and whether it
was a provider duplicate; it contains no arguments, result, or raw error.
`#buildNextMessageAfterToolRun` drains mid-turn input first, then passes that
receipt and the drain's `parts`, `hasQueuedPrompt`, and `reliable` state to the
reducer before constructing the next model message. This preserves the existing
external-input priority. Outcomes are kept in original model call order,
although the reduction is order-independent.

The guard never:

- stops halfway through a batch;
- cancels siblings after one call reaches the threshold;
- turns a skipped sibling into an execution failure; or
- treats a late duplicate terminal frame as a new observation.

If the Session cannot prove that the batch is complete, it resets and does not
enforce. PR #8180's frozen execution status is necessary but does not by itself
prove batch completion; the reducer is called only from the settled
`runToolCalls` boundary.

## Interaction with existing protection

The checks remain ordered from most specific to broadest:

1. Provider call-ID deduplication handles transport/provider replay.
2. The existing invalid-parameter guard handles repeated pre-execution schema
   failures (`executionStatus = not_started`).
3. This guard handles repeated, typed execution failures.
4. The total per-turn tool-call cap remains the absolute backstop.

Only the first guard that stops the turn records the terminal loop reason.
This design adds a distinct `LoopType.REPEATED_TOOL_EXECUTION_FAILURE` so
operators can distinguish it from invalid parameters, duplicate IDs, and the
total cap.

When this guard stops, ACP must:

- preserve all settled function responses in chat history;
- add the fixed stop context to history and emit it once through the existing
  replayable ACP agent-message update path;
- suspend Todo Stop Guard and other automatic continuations for the prompt;
- leave queued external input intact; and
- finish the active ACP request without opening another model stream.

The guard stays latched until the active prompt finishes. A later top-level
prompt, including an explicit retry or continue request, creates a fresh guard
under the existing Session lifecycle.

## Scope and enforcement modes

The first release applies only to the selected live Session owner processing a
foreground ACP prompt. It is not process-global and must not fall back to a
legacy or primary runtime when workspace ownership is unknown.

Modes:

- `off`: no reducer or telemetry.
- `shadow`: compute decisions but do not inject or stop.
- `warn`: inject the reminder but never stop.
- `enforce`: inject and stop according to the state machine.

Default is `shadow`. Unknown ownership, an untrusted producer, or mixed
deployment versions force at most `warn`. A missing `executionStatus` or an
unsupported outcome combination resets the streak and downgrades the rest of
that prompt to at most `warn`. Cron, notification, background, and custom
routes remain `off` in the first release.

The mode is an operator-controlled deployment policy, not a user-facing
setting. `QWEN_CODE_ACP_REPEATED_TOOL_FAILURE_GUARD` selects `off`, `shadow`,
`warn`, or `enforce` when the Session starts; missing or invalid values resolve
to `shadow`. The deployment control plane must set it only on the assigned
version-pinned cohort. This feature does not introduce a second rollout or
owner-assignment service.

## Telemetry and privacy

Emit low-cardinality counters plus one privacy-restricted structured diagnostic
log per reducer transition:

- deployment environment and service version from the existing OpenTelemetry
  resource rather than new guard labels;
- route: ACP foreground or other;
- mode;
- phase before and after;
- decision: reset, tracked, would_warn, warned, would_stop, or stopped;
- candidate terminal status, execution status, frozen execution error type,
  and tool type when the batch has one eligible key;
- otherwise only a low-cardinality reset reason such as `success`,
  `cancelled`, `not_started`, `unknown`, `mixed`, `incomplete`,
  `external_input`, or `contract_violation`;
- failure count bucket: `0`, `1-2`, `3-4`, `5-7`, or `8+`;
- batch count bucket: `0`, `1`, `2`, or `3+`;
- the existing prompt ID in the diagnostic log only, for checking transition
  order; and
- a prompt-local candidate ordinal in the diagnostic log only. The reducer
  reuses the ordinal while the same private key is active and allocates a new
  one when the key changes.

Prompt ID and candidate ordinal are never metric labels. The ordinal cannot
correlate a tool across prompts and does not reveal its identity. An
`idle`-to-`idle` observation emits nothing.

The terminal `repeated_tool_execution_failure` loop event uses the same
privacy-restricted OpenTelemetry path and bypasses session-scoped RUM. Other
loop types keep their existing telemetry behavior.

Do not emit tool arguments, results, raw error messages, stack traces, paths,
MCP server names, user IDs, session IDs, or the unhashed failure key.

Cancellation is excluded from every failure-rate numerator. The primary
execution SLI uses PR #8180's contract:

```text
execution_status = error
────────────────────────────────────────
execution_status in {success, error}
```

The legacy `success` field and pre-PR deployment data must not be used to
validate this guard.

## Rollout

### Phase 0: integrate outcome contracts

1. Merge PR #8176.
2. Rebase PR #8180 on top and preserve both the terminal `status` dimension
   from #8176 and the independent execution counter from #8180.
3. Preserve #8180's internal `executionErrorType` in the ACP batch receipt;
   do not infer it later from terminal `errorType`.
4. Prefer splitting #8180 into reviewable changes for the execution contract,
   ACP producer fixes, telemetry/spans, and MCP cancellation/timeout
   arbitration.
5. Deploy the integrated contract before collecting a new baseline.

The 468 historical permission-cancellation records remain evidence of the old
producer bug, not eligible guard failures. Recalculate the seven-day baseline
only for deployment versions containing the integrated contract, separately
for internal and public cloud. Do not mix old and new versions.

### Phase 1: shadow

Implement the pure reducer and wire it to the settled ACP batch boundary in
`shadow` mode. Run for at least seven complete days in both environments.
Shadow mode advances a virtual warned state without injecting the reminder, so
`would_warn` and `would_stop` estimate volume only. They cannot establish how a
model behaves after seeing the reminder.

Required invariants:

- zero cancelled calls counted as eligible failures;
- zero `not_started`, unknown execution classifications, or post-execution
  failures counted;
- zero decisions based on incomplete batches;
- zero enforcement after an unreliable input drain;
- zero raw argument, result, path, or error-text fields in telemetry;
- every `would_stop` is preceded by `would_warn` for the same candidate ordinal
  and prompt; and
- the existing total tool-call and duplicate-ID protections remain unchanged.

Manually review a privacy-safe sample of would-stop sessions using authorized
local trace access. Classify whether the unmodified continuation made useful
progress; use this to reject a clearly unsafe threshold, not to approve
enforcement.

### Phase 2: warn

Enable `warn` for internal ACP foreground prompts. Hold for seven days and
confirm that reminder injection does not increase cancellation, reconnect,
latency, token, or round-count regressions. Public cloud remains in shadow.
Only warn-mode prompts show whether the model repeats the failure after the
actual corrective reminder; that cohort supplies the semantic evidence for
enforcement.

### Phase 3: limited enforcement

Enable enforcement for at most 5% of stable, version-pinned internal ACP
foreground owners. Assignment is deterministic by owner so one prompt cannot
switch treatment mid-run. The remaining 95% stays in `warn`, so both treatment
and control receive the same corrective reminder and differ only in whether the
post-reminder matching batch stops. Hold each wave for seven days.

Promote only if:

- all correctness invariants remain at zero violations;
- warn-mode review finds no clear useful progress after a matching
  post-reminder failure;
- enforced stops have the expected key, reminder, complete batch receipt, and
  preserved history;
- completion rate is not worse by more than one percentage point;
- disconnect-or-retry-within-ten-minutes is not worse by more than 0.5
  percentage points;
- p95 latency, mean tokens, and mean rounds are each no worse than 1.10 times
  control; and
- the stopped-loop rate and saved-call estimate match warn-mode observations.

Use owner-level blocked analysis and confidence intervals; calls from one owner
are not independent samples. Any contract violation or cancellation
misclassification immediately returns the environment to `shadow`.

Do not ramp beyond 5% until treatment saturation has been checked at higher
assignment levels through capacity testing at projected full traffic. If
interference cannot be ruled out, keep a permanent control and cap enforcement
at 5%.

Public cloud repeats shadow, warn, and limited enforcement independently after
the internal gate passes. It never inherits an internal pass.

## Implementation shape

Keep the change small:

- add a pure `repeated-tool-failure-guard.ts` reducer beside ACP Session code;
- have Session translate finalized batch records into the reducer's narrow
  receipt, drain external input, and apply the returned action;
- add the new loop type and telemetry event fields through the existing
  low-cardinality logging path; and
- avoid changing tool implementations or adding another execution scheduler.

Because the change touches Core telemetry types and ACP Session orchestration,
it requires maintainer ownership under the repository's core-infrastructure
gate.

Suggested delivery sequence:

1. Outcome-contract integration and the corrected seven-day baseline.
2. Reducer, unit tests, and shadow telemetry.
3. Reminder injection and warn-mode E2E coverage.
4. Stop wiring, lifecycle resets, and dormant enforce mode.
5. Controlled rollout; no code change is required to advance modes.

## Verification

Unit tests for the pure reducer cover:

- the full terminal/execution decision table;
- terminal `errorType` cannot overwrite the frozen execution failure key;
- eight failures in one batch do not warn;
- eight failures across two batches warn;
- the next matching batch stops only after it settles;
- success, cancellation, `not_started`, `unknown`, post-processing failure,
  mixed keys, incomplete batch, unreliable drain, queued prompt, and new input
  reset;
- duplicate provider events are ignored rather than counted or reset;
- a new key starts a new streak;
- warning and stop text are fixed and contain no tool data; and
- unsupported outcome combinations never enforce.

ACP Session tests cover:

- sequential and concurrent batches;
- preservation of all current-batch results before stop;
- no extra model stream after stop;
- Todo Stop Guard suspension;
- mid-turn and queued user-input precedence;
- duplicate call-ID, invalid-parameter, repeated-execution, and total-cap
  ordering;
- Session reset, retry, cancellation, disconnect, history replay, and model
  switch behavior; and
- shadow, warn, enforce, and downgrade-to-warn routes.

Telemetry tests cover:

- normalization inherited from PR #8176 and PR #8180;
- cancellation exclusion;
- version-scoped baseline queries;
- low-cardinality attributes; and
- redaction of arguments, results, paths, raw messages, and stable identity.

The behavioral change also needs an E2E plan under `.qwen/e2e-tests/` covering
one typed failing tool, permission cancellation, a successful recovery after
the reminder, a repeated failure that stops, concurrent siblings, reconnect,
and both internal and public-cloud policy modes.

Before delivery, run targeted Core and CLI Vitest files from their package
directories, then `npm run build`, `npm run typecheck`, and `npm run lint`.

## Failure handling

- Telemetry emission failure never changes the tool or model control flow.
- Missing or malformed outcome data resets and downgrades enforcement.
- Reminder injection failure resets the guard; it must not stop without having
  delivered the reminder.
- Stop-history persistence failure returns the existing ACP internal error and
  does not pretend the stop was durably recorded.
- A process restart loses the semantic streak by design. Existing history-based
  provider call-ID deduplication still prevents replay of an already answered
  provider call. The total tool-call cap bounds a newly started prompt.

## Final decision

Adopt the two-axis outcome contract and implement the conservative per-prompt
state machine after PR #8176 and PR #8180 are integrated. Do not count any
legacy, cancelled, pre-execution, unknown, or post-execution outcome. Keep
exactly-once transport, durable cross-restart state, and global rollout
orchestration outside the first implementation unless production evidence
shows that the bounded in-memory guard is insufficient.
