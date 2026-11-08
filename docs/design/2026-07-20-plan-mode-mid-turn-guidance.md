# Plan mode mid-turn guidance and entry boundary

## Problem

`enter_plan_mode` changes the approval mode while a model turn is still being processed. Before this change, a successful invocation returned only a short sentence, so the model did not receive the full Plan mode constraints until a later turn. Sibling tool calls from the same model response could also execute on either side of the mode transition: calls before the entry ran under the previous mode, while calls after it ran after Plan mode became active without being rescheduled against the new boundary.

## Contract

A successful or already-active `enter_plan_mode` invocation returns the same complete reminder produced by `getPlanModeSystemReminder()`. SDK sessions receive the SDK-specific variant. Unsolicited YOLO entry, transition failures, and subagent or teammate rejection retain their existing results because no Plan mode transition occurred.

When a post-deduplication executable batch contains more than one call and one call is `enter_plan_mode`, the first entry call is an execution boundary. Only that call is eligible to execute. Every other executable sibling, regardless of whether it appeared before or after the entry, receives a terminal `EXECUTION_DENIED` response instructing the model to retry in the next turn after observing the new approval mode. Entry failure or idempotent success does not release the siblings.

Existing terminal decisions take precedence. Loop detection still rejects the whole batch first. Duplicate provider responses are emitted in their original positions but are not executable siblings. In structured-output mode, the existing structured-output pre-scan remains terminal and suppresses `enter_plan_mode` along with other non-structured calls.

`exit_plan_mode` is not an execution boundary in this change. Its explicit user approval and stale-context protections are independent.

## Integration

The core scheduler applies the boundary after call-ID deduplication and canonical-name resolution, before permission checks, registry lookup, hooks, or invocation construction. Skipped calls therefore do not request permissions or run per-tool hooks. They remain terminal batch results so the existing completion callback, recording, telemetry, and `PostToolBatch` audit path observe a complete response for every accepted call ID. Runtime-specific content-generator views are cleaned with the other terminal results.

ACP applies the same policy after loop and duplicate-provider handling and before executing its sequential or Agent batches. Duplicate responses remain ordered. ACP does not introduce a `PostToolBatch` hook because that path intentionally does not support one.

Headless mode applies the policy after duplicate and structured-output filtering. Skipped calls are emitted and returned as denied tool results in their original order, but do not consume `--max-tool-calls` budget. The entry itself follows the normal budget and abort behavior.

## Output preservation

The reminder is lifecycle policy, not ordinary tool payload. `enter_plan_mode` declares an infinite per-tool output limit, is exempt from the scheduler's persistence spill gate, and is not a candidate for aggregate batch offloading. These three protections prevent the policy from being truncated, replaced with a file pointer, or reduced to a preview before the next model turn.

## Validation

Unit coverage verifies exact DEFAULT and SDK reminders, success and idempotent entry, first-entry selection, sibling denial on both sides, duplicate-provider ordering, headless budget accounting, full-reminder preservation under deliberately tiny output thresholds, `PostToolBatch` visibility, and runtime-view cleanup. Existing scheduler, ACP, and headless suites cover the surrounding permission, loop, duplicate, structured-output, and abort behavior.

Managed-host validation should confirm that the ACP client receives one result for every tool call and that the next model request contains the complete reminder plus sibling denial responses. This validation requires a deployed build and a host session ID; it is not simulated by changing production routing in this PR.
