# Session Crash Recovery and Unified Recovery Service Design

## 1. Design Goals

The Recovery Service is the unified decision layer for session recovery. It
reads recovered session history, classifies the current recovery state, builds
the protocol repairs and continuation payloads required to proceed, and exposes
the same result to the TUI, daemon, SDK, and headless entrypoints.

Existing capabilities include:

- Append-only JSONL session storage.
- Session load and API history reconstruction.
- Orphaned `tool_use` / `tool_result` repair.
- Three-state interruption detection.
- Continue entrypoints for headless, nonInteractive control, and ACP.

The main issue today is not that recovery capability is entirely missing. The
issue is that:

- Recovery decisions are spread across multiple entrypoints.
- TUI / daemon / SDK do not see the same recovery state.
- Repair happens implicitly at a low level and is not visible to users or
  clients.
- Any future recovery state would need to be wired repeatedly into multiple
  entrypoints.

The goals of a unified Recovery Service are:

- Unified classification: every entrypoint uses the same recovery plan.
- Unified repair: every entrypoint reuses the same tool-pair repair and
  interruption classification.
- Unified visibility: TUI / daemon / SDK can all tell whether a resume is clean,
  interrupted, or degraded.
- Unified debugging data: repairs, synthesized results, and drops are exposed
  as structured output for display and logs.
- Unified testing: the same crash fixtures can cover the core plan and each
  entrypoint adapter.

## 2. Core Design: Recovery Service

Add a core service:

```text
packages/core/src/core/session-recovery.ts
```

It does not render UI and does not execute tools. Its only responsibility is to
produce a deterministic `SessionRecoveryPlan` from the session transcript and
the current chat history.

Suggested types:

```ts
export type SessionRecoveryKind =
  | 'clean'
  | 'interrupted_prompt'
  | 'interrupted_turn'
  | 'degraded_history';

export type RecoveryRepair =
  | { type: 'synthesized_tool_result'; callId: string; name: string }
  | { type: 'dropped_duplicate_tool_result'; callId: string; name: string }
  | { type: 'history_gap'; childUuid: string; missingParentUuid: string };

export interface SessionRecoveryPlan {
  planId: string;
  sessionId: string;
  kind: SessionRecoveryKind;
  originalApiHistory: Content[];
  apiHistory: Content[];
  repairs: RecoveryRepair[];
  canContinue: boolean;
  canAutoContinue: boolean;
  requiresUserConfirmation: boolean;
  visibleNotice?: string;
  continuation?: {
    mode: 'retry_user_parts' | 'tool_result_parts';
    parts: Part[];
    displayText: string;
  };
}
```

Suggested entrypoint:

```ts
export function buildSessionRecoveryPlan(input: {
  sessionId: string;
  conversation: ConversationRecord;
  historyGaps?: HistoryGap[];
  options?: {
    allowAutoContinue?: boolean;
  };
}): SessionRecoveryPlan;
```

Core flow:

1. Build `originalApiHistory` from `ConversationRecord`.
2. If non-ignorable `historyGaps` exist, classify the session as
   `degraded_history`.
3. Run `detectTurnInterruption` on `originalApiHistory`. This must happen
   before repair. Otherwise a dangling `model[functionCall]` would first be
   closed by a synthetic `functionResponse`, making it impossible to classify
   the state as `interrupted_turn`.
4. Clone `originalApiHistory` into provider-safe history, run the existing
   `repairOrphanedToolUseTurns` on the clone, and store the result in
   `plan.apiHistory`.
5. Build the continuation payload from the classification:
   - `interrupted_prompt`: replay trailing user parts with Retry semantics.
   - `interrupted_turn`: close dangling tool calls with synthetic error
     `functionResponse` parts.
6. Produce `visibleNotice` and `repairs` for UI / daemon / SDK display and
   debugging.

Naming compatibility:

- Keep using the existing public protocol string `interrupted_turn`; do not add
  `interrupted_tool_turn`. nonInteractive control, ACP, and existing tests
  already depend on `interrupted_turn`, and the Recovery Service should not add
  migration cost.

## 3. Role and Value of the Recovery Service

### 3.1 Robustness

A unified service turns the current implicit and scattered recovery behavior
into an explicit state machine.

Current state:

- Resume initialization repairs orphaned `tool_use` entries, but entrypoints do
  not always know that repair happened.
- Headless / ACP can continue, but the TUI does not know what to tell the user.
- Parent-chain gaps already have partial visible handling:
  `SessionService.loadSession` returns `historyGaps`, and TUI / ACP can display
  gap notices. However, there is still no unified recovery metadata or
  consistent safe-mode policy.

After introducing the Recovery Service:

- Every resume first produces an explicit state: `clean`,
  `interrupted_prompt`, `interrupted_turn`, or `degraded_history`.
- Any entrypoint can decide whether to continue, notify, or degrade based on the
  same plan.
- History gaps are not silently treated as clean history.
- If new recovery states are added later, only plan construction needs to be
  extended; every entrypoint does not need to reimplement the logic.

The robustness gain is that recovery moves from "each place repairs a little as
needed" to "each recovery has one unified classification result."

### 3.2 Safety

The biggest safety risk in recovery is automatically repeating side-effecting
actions, such as shell commands, file writes, or external API calls.

Recovery Service safety principles:

- Do not automatically replay unknown tools by default.
- Convert dangling tool calls into failed `functionResponse` parts by default,
  and let the model decide whether to retry.
- `interrupted_turn` defaults to `requiresUserConfirmation = true` unless the
  caller explicitly opts in.
- `degraded_history` is never auto-continued.
- All synthetic repairs are included in `repairs` for logs and debugging.

This prioritizes:

- Providers do not receive invalid history.
- Users do not repeat dangerous actions because of recovery logic.
- TUI / SDK can clearly show which tool results were synthesized as recovery
  failures.

The safety value is that recovery does not blindly resume execution. It first
repairs protocol shape, then continues with conservative policy.

### 3.3 Completeness

This design does not immediately solve every crash scenario. It focuses on the
states that current capabilities can classify reliably.

Covered immediately:

- Clean resume.
- Trailing user prompt: `interrupted_prompt`.
- Trailing tool result submission: also classified as `interrupted_prompt` and
  replayed with Retry.
- Dangling tool call: `interrupted_turn`, with synthesized error tool results.
- Non-adjacent tool result: existing repair hoists it into a legal position.
  The first version of this plan does not record hoist details separately
  unless the repair API is later extended to return them.
- Duplicate tool result: drop duplicate.
- Parent-chain gap: `degraded_history`.

Not covered yet:

- A model text stream that disconnects midway but leaves a tail that looks like
  ordinary model text.
- Fine-grained distinction between graceful abort and unknown crash.

Completeness here does not come from adding a large amount of code at once. It
comes from consolidating current capabilities into a unified plan so the states
that can be classified today are handled consistently.

### 3.4 Engineering Architecture

The Recovery Service should live in core rather than in CLI, TUI, daemon, or any
single entrypoint.

Reasons:

- `SessionService`, `buildApiHistoryFromConversation`, `GeminiChat` repair, and
  `detectTurnInterruption` are all in core or core-adjacent layers.
- TUI / headless / ACP / daemon / SDK are adapters.
- Recovery classification is domain logic, not UI rendering logic.

Suggested layering:

```text
SessionService
  Read JSONL, rebuild ConversationRecord, return historyGaps

SessionRecoveryService
  Build RecoveryPlan from ConversationRecord + historyGaps

GeminiClient / GeminiChat
  Consume plan.apiHistory to initialize chat
  Execute plan.continuation when needed

TUI / headless / ACP / daemon / SDK
  Display plan.visibleNotice
  Trigger continuation from user or API requests
```

Benefits of this layering:

- Core owns facts and decisions.
- UI owns display.
- daemon / SDK own protocol output.
- Tests can exercise the core plan directly without booting a full TUI.

### 3.5 Visibility and Debuggability

The plan produced by the Recovery Service should be convertible into two kinds
of output:

1. User-visible notice:

```text
The previous session stopped after tool execution. Marked 2 unfinished tool
calls as failed so the history can be sent safely. You can continue the task;
the model will decide whether to retry based on the failure results.
```

2. Debug log or optional system record:

```ts
type RecoveryDebugPayload = {
  planId: string;
  kind: SessionRecoveryKind;
  repairs: RecoveryRepair[];
  timestamp: string;
};
```

This information does not enter API history. It is only for diagnostics,
export, and debug. Persisting it as a system record can be deferred and is not a
hard requirement of this design.

Value:

- Users know what happened during recovery.
- SDK clients can show accurate state.
- Bug reports can include `planId` and `repairs`.
- The same interrupted tail is less likely to be auto-continued multiple times.

## 4. Entrypoint Integration

### 4.1 TUI

After `/resume` or startup with `--resume`:

1. `SessionService.loadSession(sessionId)`.
2. `buildSessionRecoveryPlan(...)`.
3. `config.startNewSession(sessionId, sessionData, recoveryPlan)`, or an
   equivalent mechanism to retain the plan.
4. Load UI history.
5. If `plan.kind !== 'clean'`, insert an INFO item.
6. Provide `/continue` or a "Continue interrupted turn" action.

The TUI does not auto-continue `interrupted_turn` / `degraded_history` by
default.

### 4.2 Headless / nonInteractive Control

`continueInterrupted` or `continue_last_turn` no longer calls scattered
detectors directly. Instead:

1. Build a plan from current chat history or the resumed conversation.
2. If `plan.canContinue = false`, return no-op.
3. If continuation is allowed, execute `plan.continuation`.

### 4.3 ACP / daemon

Add recovery metadata to the `loadSession` / `resumeSession` response:

```ts
{
  recovered: boolean;
  recoveryKind: SessionRecoveryKind;
  canContinue: boolean;
  requiresUserConfirmation: boolean;
  repairs: {
    type: string;
    count: number;
  }
  [];
}
```

`continueLastTurn` should also accept / reject based on the plan, then
revalidate immediately before execution.

### 4.4 SDK

SDK integration needs to distinguish two categories:

- daemon-backed SDK: consumes recovery metadata from daemon `loadSession` /
  `resumeSession` responses, shows a recovery banner, and allows the user or
  host application to trigger continue.
- process-backed SDK: starts the CLI through `ProcessTransport` and uses
  `--resume` / `--continue` flags. It needs equivalent recovery metadata
  exposed through a stream-json system message or an SDK protocol field.

Neither SDK category should directly understand low-level JSONL or tool-pair
repair. They should only consume the structured recovery result exposed by the
entrypoint layer, and they should block auto-continuation in degraded states.

## 5. Unit Test Design

The Recovery Service must have independent unit tests that do not depend on the
TUI or a real provider.

Core fixtures:

1. Clean history:
   - Model text tail.
   - Complete tool call + tool result + final model.

2. `interrupted_prompt`:
   - Last entry is user text.
   - Last entry is a group of user functionResponse parts.
   - Multiple trailing user entries.

3. `interrupted_turn`:
   - Model functionCall with no functionResponse.
   - Multiple functionCalls with only some completed.
   - FunctionCall without id is skipped.

4. Repair:
   - Non-adjacent functionResponse is hoisted and provider-safe history is
     legal.
   - Duplicate functionResponse is dropped.
   - Synthetic tool result shape remains consistent with existing repair.

5. `degraded_history`:
   - `historyGaps` is non-empty.
   - Confirm `canAutoContinue = false`.
   - Confirm `visibleNotice` includes gap information.

6. Compression checkpoint:
   - Tail after the latest compression is detected correctly.
   - System records do not enter API history.

Entrypoint adapter tests:

- TUI `/resume` inserts an INFO item after receiving a non-clean plan.
- Headless `continueInterrupted` uses plan continuation and does not duplicate
  the user message.
- ACP `continueLastTurn` returns the same recovery kind for the same fixture.
- daemon `loadSession` response includes recovery metadata.

The key test goal is: the same history fixture should produce the same recovery
kind in core / TUI / ACP / daemon.

## 6. Conclusion

A unified Recovery Service is the highest-value change at this stage because it
mostly consolidates existing capabilities instead of introducing many new
mechanisms immediately.

Its direct value:

- Makes recovery state consistent across TUI / daemon / SDK / headless.
- Turns existing orphan `tool_use` repair from an implicit 400-prevention step
  into an explicit recovery plan.
- Turns interrupted-turn continuation from a local headless / ACP capability
  into reusable core capability.
- Provides a stable extension point for future recovery states.

It does not solve every crash problem by itself, especially mid-text stream
crashes. This document intentionally keeps those extensions out of scope for
this round to avoid over-design. The current goal is to unify the recovery
capabilities that already exist and can be classified reliably.
