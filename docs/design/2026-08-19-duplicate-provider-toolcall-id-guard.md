# Duplicate provider tool-call id guard: args-aware replay detection and visible daemon stop

- **Status**: approved
- **Date**: 2026-08-19
- **Related**: issue #5014, PR #5038 (first-level suppression), PR #5657
  (repeated-duplicate circuit breaker)

## Background

PR #5038 made provider-supplied tool-call ids idempotent: when a provider
replays an already-handled id, the duplicate is answered with a synthetic
error response instead of executing again (issue #5014 showed the same shell
command executing hundreds of times). PR #5657 added a circuit breaker on
top: once a synthetic duplicate response has been sent for a provider id,
seeing that id again drops the whole tool batch and terminates the turn.
The breaker is shared by four entry points via
`findRepeatedDuplicateProviderToolCall` (`packages/core/src/core/turn.ts`):
AgentCore, the TUI stream hook, the non-interactive CLI, and the ACP daemon
`Session`.

## Problems

### P1: id-only matching misfires on per-response id schemes

Both guard levels key on the provider id **alone**. Some models emit
tool-call ids that are only unique within a single response — e.g. Kimi K3
emits `functions.{name}:{index}` which surfaces as `run_shell_command_0`,
and the index can restart at 0 on any round. A fresh call (different
command) that happens to reuse an old id is then treated as a replay:

- round 1: `run_shell_command_0` (cmd A) → executes;
- round 2: `run_shell_command_0` (cmd B) → synthetic duplicate error;
- round 3: `run_shell_command_0` (cmd C) → circuit breaker, batch dropped,
  turn ends.

Once the model is in this mode every turn dies by round 3. Observed live in
daemon sessions `e73e9c10` and `0c4ebdb4` (the latter looped through the
two-round failure cycle on three consecutive prompts after the model's
counter reset).

The original #5014 replay — and the regression fixtures that guard it — are
**same id and same arguments**. Id collisions with different arguments are a
distinct, benign case that the guard should let through.

### P2: the daemon drop is silent

PR #5657 required user-visible termination and delivered it on three of the
four paths: AgentCore terminates with `LOOP_DETECTED`, the TUI sets its
loop-detected flag and posts the loop message, the non-interactive CLI emits
a `LoopType.GLOBAL_TOOL_CALL_DUPLICATE` loop result. The ACP daemon
`Session` is the outlier: `runToolCalls` returns an empty-parts result whose
only consumer returns `message: null`, so the turn ends as a normal
`end_turn` with nothing in the transcript, no telemetry, and only a
`debugLogger.debug` line. To the user the session looks hung.

## Decisions

### D1 (P2): route the daemon breaker through the loop-detected machinery

In `Session.runToolCalls`, when `findRepeatedDuplicateProviderToolCall`
fires, call `recordDaemonLoopDetected(config, promptId,
LoopType.GLOBAL_TOOL_CALL_DUPLICATE, message, toolLoopState)` and return
`loopDetected: true` instead of the bespoke
`repeatedDuplicateProviderToolCall` flag. Every `runToolCalls` caller
already handles `loopDetected`: it preserves the
`LOOP_DETECTED_CONTEXT_MESSAGE` into unsent history, suspends the todo stop
guard, and — on foreground turns — fails the prompt with the
`LOOP_DETECTED` turn error (`loopType` carried in the error data), which the
client renders. Cron and background-notification turns keep their graceful
end-turn semantics, matching how daemon loop detection already behaves.

The `repeatedDuplicateProviderToolCall` field on `RunToolResult` and its
dead consumer branch are removed. `GLOBAL_TOOL_CALL_DUPLICATE` is the same
loop type the non-interactive CLI reports for this breaker, and
`recordDaemonLoopDetected` is idempotent per turn and emits the
`LoopDetectedEvent` telemetry the silent path was missing.

### D2 (P1): a duplicate is a replay only if name+args match the original

Replace the id-membership test with a fingerprint test at all four entry
points, both guard levels:

- **fingerprint** = tool name + canonical JSON of `args` (sorted keys,
  stable serialization).
- A handled-id map replaces the handled-id set: provider id → fingerprint
  of the call that first executed under that id. History-derived entries
  come from a new `GeminiChat.getHistoryToolCallFingerprints()` (model-turn
  `functionCall`s whose id has a matching user-turn `functionResponse`),
  replacing `getHistoryFunctionResponseIds()` at the dedup sites. In-flight
  tracking (per-turn refs/sets at each entry point) records the same
  mapping when a call is admitted for execution.
- Incoming call with a handled id **and equal fingerprint** → replay:
  synthetic duplicate response first, circuit breaker on recurrence
  (unchanged #5038/#5657 behavior).
- Incoming call with a handled id but a **different fingerprint** → not a
  replay: it executes under the suffixed unique id that
  `normalizeModelToolCallIds` already assigns (`__qwen_dup_N`). The map keeps
  the first occurrence's fingerprint (first-occurrence semantics — the raw
  id keeps naming its original call; suffixed executions live in history
  under their suffixed ids).
- `duplicateProviderToolCallResponseIds` (ids already answered with a
  synthetic response) stays id-keyed; since synthetic responses are now only
  sent for true replays, the breaker condition becomes "incoming item is a
  replay AND (a synthetic response was already sent for that id OR the same
  replay appears more than once in the batch)".
- The same-response duplicate drop inside `normalizeModelToolCallIds`
  (`rawIdsInCurrentTurn`) is unchanged: two identical raw ids inside one
  streamed response remain pathological (Kimi emits distinct indices for
  parallel calls in one response).

Residual risks, accepted:

- A replay of a _suffixed_ execution (same raw id, args equal to a later
  collision call rather than the first) executes again; unbounded repetition
  is stopped by the id-independent guards (consecutive-identical threshold
  5, global same-(tool,args) threshold 6, turn tool-call cap).
- A legitimate re-run whose args exactly equal the raw id's first execution
  is still suppressed once and circuit-breaks on recurrence — now visibly
  (D1), and with a recovery hint (D3).

### D3: make the synthetic duplicate message actionable

Append guidance to `duplicateProviderToolCallMessage` telling the model
that, if a new invocation was intended, it must re-issue the call with a
fresh tool-call id (or explicitly different arguments). Kimi-class models
generate the index token themselves and can comply. Existing assertions use
`toContain` on the leading sentence and remain valid.

## Alternatives rejected

- **Scope provider ids to a single response** (always execute cross-round
  collisions): reverts #5014 — a true replay would execute up to the loop
  thresholds (≤5 times), unacceptable for side-effect tools.
- **Adapter-level id rewriting for `^{tool}_\d+$`-shaped ids**: fragile
  provider-specific heuristic; disables replay protection wholesale for
  matching providers.
- **Family-wide fingerprint matching** (compare against the raw id _and_
  all its suffixed executions): strictly stronger replay suppression, but
  blocks legitimate identical re-runs (build/test/status loops) for
  broken-numbering models — the dominant workflow for the model class this
  fix targets.
- **Waiting for an upstream provider fix**: id uniqueness is outside our
  control; the client must be robust regardless.

## Delivery

Two PRs sharing this doc:

1. **Visible daemon stop (D1)** — `Session.ts` only, plus tests. Ships
   first: turns the silent hang into a diagnosable loop-detected stop even
   before the root cause lands.
2. **Args-aware replay detection (D2 + D3)** — core helpers
   (`turn.ts`, `toolCallIdUtils.ts`, `geminiChat.ts`, `client.ts`) and the
   four entry points, plus tests.

## Test matrix

| Case                                     | Expected                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Same id, same args, second occurrence    | synthetic duplicate response, no execution (unchanged)                                                        |
| Same id, same args, third occurrence     | batch dropped; visible loop-detected stop on every path, `GLOBAL_TOOL_CALL_DUPLICATE` telemetry (daemon: new) |
| Same id, different args, any round       | executes under `__qwen_dup_N` id; no synthetic response; turn continues                                       |
| Same raw id twice within one response    | second call dropped by `normalizeModelToolCallIds` (unchanged)                                                |
| Id without history collision             | executes (unchanged)                                                                                          |
| Daemon foreground turn hits breaker      | prompt fails with `LOOP_DETECTED` turn error; context message preserved for next turn                         |
| Daemon cron/background turn hits breaker | graceful end-turn; context message preserved (parity with existing daemon loop stops)                         |

Regression suites: `packages/core` `turn.test.ts`,
`toolCallIdUtils.test.ts`, `agent-headless.test.ts`; `packages/cli`
`useGeminiStream.test.tsx`, `nonInteractiveCli.test.ts`,
`acp-integration/session/Session.test.ts`. E2E: mock OpenAI-compatible
provider replaying `{name}_0`-style ids with differing args per round
(must complete all rounds), and with identical args (must stop visibly).
