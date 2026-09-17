# Goal verification from a current-turn evidence window

[English](2026-09-17-goal-verifier-evidence-window.md) | [简体中文](2026-09-17-goal-verifier-evidence-window.zh-CN.md)

Status: proposed, 2026-09-17. Tracking issue: #12053. Baseline for line references: upstream `main` at `b8def02aad`.

## Problem statement

A Goal's terminal proposal (`update_goal` with `complete` or `blocked`) is judged by an independent verifier. Today the verifier receives the transcript records the model cites by UUID from a bounded catalog (100 entries / 24 000 bytes of previews, `goal-evidence.ts:32-33`), and a checkpoint side query compresses old evidence into claims so it stays citable.

Two `/goal-draft` sessions on 2026-09-16 each finished their objective inside one Goal turn of roughly a hundred tool calls. Every model step records an assistant entry and a tool entry, so the catalog overflowed long before the end; `update_goal` refused the proposal because the catalog was truncated (`goal-tools.ts:359-376`); the turn-end checkpoint had to compress the overflowed window through a single-shot fast-model query, and on one model three failed compressions stopped the Goal as usage-limited. After `/goal resume` the catalog was empty and the tool still told the model to retry with UUIDs it could not have. In both sessions the evidence the verifier finally accepted was the verification the model re-ran in the closing turn: the deliverable was on disk and the check could be run again.

A first replacement (PR #12060, closed) changed what the verifier sees but re-derived the packing policy from scratch and dropped invariants the old path held; four review rounds found the same class of edge each time. This document is the design step that attempt skipped: every invariant of the current path is listed with a keep / drop / replace decision, every assumption the rest of the runtime makes about the path is listed with its handling, and the code is cut into reviewable steps only after that.

## Current state

- `update_goal` requires `evidenceRefs`, validates them against the latest `get_goal` catalog, folds in the turn's own delivered output, and refuses a proposal outright when the catalog is truncated (`goal-tools.ts:295-376`).
- The verifier receives the cited records whole, bounded only by a 256 000-byte total on cited content and a 256 000-byte request limit (`goal-evidence.ts:44`, `goal-verifier.ts:14`), with a 30-second timeout and one attempt (`goal-verifier.ts:13`, `:199`).
- The deterministic half of the blocked policy runs in `validateBlockerCoverage` (`goal-evidence.ts:898-966`): an infeasible blocker needs an `external_fact`, an immediate one needs `user_input` or `external_fact`, a repeated one needs the current and two preceding lineage turns each to hold non-assistant evidence.
- A turn-end checkpoint (`goal-checkpoint-verifier.ts`, fast model, `maxAttempts: 1`) compresses evidence into up to 32 claims; three consecutive stalls stop the Goal (`goal-runtime.ts:1292-1308`); a non-zero stall streak suppresses the no-progress pause (`goal-runtime.ts:1932`); resume of an evidence-limited Goal repoints the cursor and drops the checkpoint (`goal-reducer.ts:237-252`).
- Measured on the two sessions: about 140–150 records and 500 kB of raw content per closing turn; tool results have a median of 2–3 kB, a 90th percentile of about 10 kB, and 92–99 % are under 16 kB.

## Goals

1. A turn of any length can be judged: the proposal is never refused for the size of the transcript, and the Goal never stops because bookkeeping overflowed.
2. The model has nothing to cite: `update_goal` takes a status and a reason.
3. Every guarantee the current path gives that still matters is kept or replaced by a stated equivalent; each drop is deliberate and written down.
4. The verifier's request always fits its limits and is sized from the real request, not from a constant that happens to match another.
5. The evidence a claim about the user needs is reachable however long the Goal has run and whatever state it was in when the user wrote it.

## Scope boundaries

- In scope: the verifier's input and its construction, the `update_goal` / `get_goal` contract, the runtime's verification path and error mapping, the disabling and later removal of checkpoints, the prompts and user documentation that describe judging.
- Out of scope: removing the verifier (the Codex-style alternative was rejected by the maintainers), the Goal state machine, budgets, pause reasons, the approval dialog, the legacy `active_goal` projection, and the Web Shell Goals page beyond dropping checkpoint fields.

## Proposed solution

### The window

For a `complete` proposal the verifier receives the `assistant_output` and `tool_result` records of the Goal turn that made the proposal. For a `blocked` proposal it receives those of the current turn and the two lineage turns before it. For any proposal it also receives the user's own `real_user` messages from anywhere in the session, with or without Goal turn context; a message sent while no Goal turn was running carries the turn id `outside_goal_turn`. Records are ordered newest first.

The lineage is read from the evidence cursor forward by the existing `collectLineageTurnIds`; records before the cursor are read only to collect user messages and are not examined for lineage. A current turn that has recorded nothing yet yields an empty window, which the verifier rejects with feedback; a current turn that is in the lineage but not at its tail is a source failure (`current_turn_not_tail`).

### Packing

Every record's content is capped at 16 000 bytes: the first 6 000 and the last of the remaining budget are kept with a marker where the middle was, on code point boundaries. This applies to all provenances, because tool results carry their summary line at the end, user messages carry the decision at the end, and a deliverable often needs more than two kilobytes to be judged.

A record's cost is its serialized form (`uuid`, `provenance`, `turnId`, `proofKind`, `content`) plus the array comma. The budget is the 256 000-byte request limit minus the measured envelope (objective, proposal reason, blocked policy, three turn ids, the omitted count), never more than 224 000 bytes. If less than 64 000 bytes remain, the Goal stops with a reason naming the objective as the thing to shorten.

Records are admitted in this order, each pass newest first and skipping a record that does not fit rather than ending the pass: the current turn's newest record; for a blocked proposal, the newest non-assistant record of each of the two preceding turns; the newest four user messages or an eighth of the budget, whichever is reached first; then every remaining record by transcript position. Records are rendered only when a pass reaches them, and a pass stops when the remaining budget cannot hold the smallest record. The window reports how many eligible records it left out.

### Coverage rules, decoupled from packing

The deterministic half of the blocked policy is decided on the lineage records, not on the packed window, so a tight budget cannot turn a well-evidenced blocker into a refusal: an infeasible blocker needs a `tool_result` record in the current turn; an authority or external blocker needs a `real_user` record anywhere or a `tool_result` in the current turn; a repeated blocker needs at least three lineage turns with a `tool_result` or `real_user` record in each of the last three. A proposal that fails is rejected locally with the rule as feedback, and the verifier is not called. The runtime's fingerprint audit for repeated blockers (three consecutive turns, same kind and reason) stays as the first gate.

### The verifier call

The timeout grows with the request: 30 seconds plus 15 seconds per 32 kB, capped at 180 seconds. A verifier that fails on the full window (timeout, provider error, context length) is retried once with a window built at half the budget; a second failure stops the Goal with the real error. The request-size guard in the verifier stays as a last resort and, with the budget measured from the envelope, is unreachable in normal operation.

The system prompt says that the evidence is the proposing turn's records newest first (three turns for a blocked proposal), that the user's messages come from anywhere in the session and what `outside_goal_turn` means, that a marked cut leaves the text on both sides verbatim, and what the omitted count means. The `user_input` rule is unchanged.

### Error mapping

| Condition                                                                                                                                  | Outcome                                  | `limitKind`        | Recovery                         |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ------------------ | -------------------------------- |
| Coverage rule not met                                                                                                                      | reject with the rule                     | —                  | next turn                        |
| Transcript cannot be attributed (cursor missing or duplicated, malformed context after the cursor, re-entry, current turn not at the tail) | `usage_limited`                          | `evidence_catalog` | resume repoints the cursor       |
| Envelope leaves under 64 000 bytes                                                                                                         | `usage_limited`, dedicated reason        | —                  | `/goal edit` a shorter objective |
| Verifier fails twice                                                                                                                       | `usage_limited`, real error              | —                  | resume retries                   |
| Verifier rejects                                                                                                                           | existing path, feedback on the next turn | —                  | —                                |

### Model-facing contract

`update_goal({ status, reason, blockerKind? })`; `evidenceRefs` is accepted and ignored for one release; the schema requires only `status` and `reason`. `get_goal()` returns the Goal summary and the verifier's feedback; the `view` parameter is accepted and ignored. The `invalidEvidenceRefs`, auto-citation and `checkpointRequired` gates are removed. The continuation prompt tells the model that the verifier sees only the proposing turn and to run the decisive checks immediately before `update_goal`, reports rather than cites a standing blocker, and carries a completion audit. The `/goal-draft` skill describes judging the same way and names the 1 500-character `propose_goal` limit.

### Checkpoints

The runtime is created without a checkpoint verifier, so no checkpoint attempt is created (PR #12073). A pending checkpoint from an earlier build is dropped on restore, the stall count such a build recorded is cleared, and the no-progress bound ignores a stall streak when no checkpoint verifier is wired. The checkpoint code, the catalog and reference validation are deleted once the window is wired.

## Design decisions and rationale

- **Current turn only for completion**, rather than the newest N turns: it matches the skill's contract (run the named check and paste the line when proposing completion), it matches how the two sessions actually completed, and it keeps stale evidence from proving a current state.
- **Coverage on lineage records, not on the window**: the rules are about what the model did, not about what fit the request; deciding them on the packed window made them depend on budget arithmetic, which is what the closed PR kept getting wrong.
- **User messages from anywhere, with or without Goal context, including before the cursor**: they are the only proof of what the user said and cannot be produced again; an approval given while the Goal was blocked or before an edit is still the approval. Relevance is the verifier's judgement.
- **One per-record cap for every provenance, cut in the middle**: measured tool results are mostly under 16 kB, and the information that decides a claim sits at the ends.
- **Budget from the measured envelope** rather than a fixed reserve: `/goal set` accepts objectives of any length, and a fixed reserve is either wasted or insufficient.
- **Retry at half rather than a bigger timeout alone**: a request the model cannot hold does not get better with time.
- **Keep the verifier**: it is the documented promise of how a Goal is judged and the difference from a prompt-only audit; its cost is small, the ledger that fed it was the expensive part.

## Constraints

- The verifier request stays under 256 000 bytes and is a single side query on the configured fast model.
- `GoalSnapshotV2` keeps its version; every removed field is optional; old snapshots and old clients keep parsing.
- The hosts' handling of `terminateTurn`, `goalContext` stamping, budgets, wind-down, no-progress and telemetry is unchanged.
- The evidence-limited resume branch in the reducer stays, since source failures depend on it.

## Risks

- A check that ran in an earlier turn must be run again in the proposing turn, or the verifier rejects; the skill and the prompt say so, and the rejection carries feedback.
- A record longer than 16 000 bytes loses its middle; a decisive line written there is not seen.
- A user message longer than the user share may be skipped in favour of shorter ones; the newest four are always tried first.
- The verifier reads up to about 60 000 tokens; models with a smaller context fall back to the halved window once and then stop the Goal with the provider's error.

## Validation plan

- Unit tests for the window builder cover: newest-first order; the middle cut on both provenances and on code point boundaries; the serialized budget with skipped records counted; the priority passes under a 64 kB budget (current turn, both preceding turns and a short approval behind two long pastes all present); user messages without Goal context; the cursor-bounded lineage (an anomaly behind the cursor is ignored, one after it is a source failure); the duplicate-uuid refusal; the empty window for a turn that recorded nothing.
- Unit tests for the coverage rules on lineage records, one per rule and per failure.
- A combined test wires the real `createGoalVerifier` (provider mocked) to a window built at the budget the envelope leaves, with the longest allowed reason and escape-heavy records, and asserts the request fits and is full.
- Runtime tests: completion from a 140-record turn; the four blocked kinds; a coverage rejection without a verifier call; a lineage failure that resume recovers from by repointing the cursor; a 250 kB objective that stops with the dedicated reason; the retry at half and the stop after a second failure; a restored stall count that no longer exempts an idle Goal.
- CLI tests for the continuation prompt text and the `terminateTurn` paths.
- One live replay of a 2026-09-16 objective on the built CLI before the wiring PR is merged.

## Acceptance criteria

1. A Goal turn of a hundred tool calls that proposes completion reaches the verifier in one turn and completes when the closing check passes.
2. `update_goal` never refuses a proposal for the state of a catalog; `get_goal` returns no catalog.
3. Every row of the invariant table below is either still pinned by a test or listed as dropped with its reason.
4. No checkpoint side query runs in production; a session restored from an earlier build's records neither fails nor keeps a stall count.
5. The user guide and the skill describe judging as this document does.

## Delivery steps

| Step | Content                                                                                                                                  | Behaviour change |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 0'   | This document                                                                                                                            | none             |
| A    | PR #12073: stop running checkpoints, drop stale checkpoint state on restore, gate the stall exemption                                    | yes              |
| B1   | Pure functions: window builder, coverage rules, envelope measurement, timeout function, with unit and combined tests; not wired          | none             |
| B2   | Wire the window into the verification path; error mapping; retry; the `update_goal` / `get_goal` contract; prompts, skill and user guide | yes              |
| C    | Delete the checkpoint code, the catalog and reference validation, their constants and the `checkpoint_request` limit kind                | none             |
| D    | Drop checkpoint fields from SDK, Web Shell, CLI and documentation                                                                        | none             |

## Open questions

Resolved with the maintainers on 2026-09-17: completion is judged from the current turn only; user messages get four guaranteed slots or an eighth of the budget and the same 16 000-byte cut; the verifier judges a repeated blocker from the blocked policy and the current turn when the preceding turns do not fit; user messages are taken from anywhere in the session regardless of when the Goal was created; B1 and B2 stay separate.

## Appendix A: invariants of the current path

K = kept as is; R = replaced by the stated guarantee; D = dropped with the test, for the stated reason. Test names refer to the suites on `b8def02aad`.

### `goal-evidence.test.ts`

| Test                                                                          | Decision | Note                                                                              |
| ----------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------- |
| bounds the catalog while retaining the newest evidence                        | D        | no catalog; newest-first order carried by the window                              |
| scopes the truncated catalog gate to full-window coverage proposals           | D        | no truncation gate                                                                |
| keeps the catalog whole when only ineligible records sit past the entry cap   | D        | no catalog                                                                        |
| keeps the catalog whole when a whitespace-only record sits past the entry cap | R        | empty content is never admitted nor counted as omitted                            |
| fails closed when truncation evicts a repeated blocker turn                   | R        | coverage decided on lineage records                                               |
| keeps a repeated blocker validatable while its turns stay catalogued          | R        | same                                                                              |
| does not expand records older than the bounded catalog window                 | R        | lazy rendering: unreached records are not rendered                                |
| bounds the serialized catalog by UTF-8 bytes                                  | R        | window budget in serialized UTF-8 bytes                                           |
| requests a checkpoint before the catalog reaches its byte limit               | D        | checkpoints disabled                                                              |
| caps oversized window content with a truncation marker                        | R        | 16 000-byte middle cut with a marker                                              |
| does not start truncated under a full checkpoint of multi-byte claims         | D        | no checkpoint                                                                     |
| caps window content on a code point boundary for multi-byte text              | K        | the new cut is on code point boundaries                                           |
| does not expand raw evidence below the checkpoint threshold                   | D        | no checkpoint                                                                     |
| bounds reference count, rejects duplicates, and bounds cited bytes            | R        | no references; total bounded by the budget                                        |
| admits delivered output larger than the catalog preview budget                | R        | delivered output enters whole up to 16 000 bytes, then both ends                  |
| admits thirteen delivered outputs plus independent evidence                   | D        | no reference quota                                                                |
| uses a stable cursor and exposes only bounded previews                        | R        | cursor-forward scan kept; thoughts excluded; no previews                          |
| treats only display metadata as real-user evidence                            | K        | `evidenceContent` projection unchanged                                            |
| keeps mid-turn model text instead of its display label                        | K        | same                                                                              |
| reports `cursor_unset` / `cursor_not_found` as a source failure               | K        | cursor lookup shared with the remaining catalog code                              |
| requires coherent type, subtype, provenance, and goal ownership               | K / R    | provenance coherence kept; `real_user` no longer needs Goal context               |
| keeps completion available after the lineage display window fills             | D        | no display cap                                                                    |
| rejects permit mismatch, malformed ownership, re-entry, and wrong tail        | K        | same codes; wrong tail only when the turn is in the lineage                       |
| requires user or tool evidence for an immediate blocker                       | R        | decided on lineage records                                                        |
| holds an infeasible blocker to external facts                                 | R        | same                                                                              |
| gates an immediate blocker on checkpoint claims like raw evidence             | D        | no checkpoint claims                                                              |
| requires non-self-reported evidence from the last three turns                 | R        | decided on lineage records                                                        |
| keeps source and reference failures distinguishable                           | R        | source failures and coverage failures are distinct classes with distinct outcomes |

### `goal-verifier.test.ts`

| Test                                                                                             | Decision | Note                                                                                |
| ------------------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------- |
| parses only the exact bounded result union; rejects non-exact output; rejects an overlong reason | K        | unchanged                                                                           |
| returns the side query usage alongside the decision                                              | K        | unchanged                                                                           |
| uses a tool-free deterministic side query with bounded fields                                    | K / R    | fields become `evidenceTurnIds` and `omitted`; prompt updated                       |
| includes blocked policy only for blocked proposals                                               | K        | unchanged                                                                           |
| preserves the legacy delivered-output input contract                                             | D        | `currentDeliveredOutput` removed; the runtime always sends `currentTurnId`          |
| keeps maximum valid evidence and proposal reason within the request limit                        | R        | combined test: a window built at the envelope's budget plus the longest reason fits |
| rejects an unbounded verifier request before calling the provider                                | K        | kept as a last resort                                                               |
| propagates provider failure and clears its timeout                                               | K / R    | timeout grows with the request; the runtime retries at half                         |
| combines caller cancellation with its timeout                                                    | K        | unchanged                                                                           |

### `goal-tools.test.ts`

| Test                                                                                                                                      | Decision | Note                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------- |
| `GetGoalTool`: canonical name, visibility, `lastGoal` summary without a permit, unreachable persistence                                   | K        | unchanged; the checkpoint health line goes with its fields in step D |
| returns only the bounded worker view for the captured permit                                                                              | R        | returns `{ active, snapshot, verifierFeedback }`                     |
| exposes the view parameter and nothing else                                                                                               | R        | `view` kept as a deprecated optional                                 |
| collapses checkpoint claims in the summary view; returns the whole catalog in the full view; steady-state summary ceiling                 | D        | no catalog                                                           |
| `UpdateGoalTool`: exposes the exact evidence and non-terminal response contract                                                           | R        | new contract assertions                                              |
| rejects lineage turn ids before recording a proposal                                                                                      | D        | no references                                                        |
| cites this turn's delivered output; does not duplicate cited output; leaves a blocked proposal to cite what it chose                      | D        | no auto-citation                                                     |
| checkpoints a truncated catalog before recording completion; keeps truncated repeated blockers eligible                                   | D        | no `checkpointRequired` gate                                         |
| records one proposal; audit-only proposals; second proposal in the same turn; stale permit; cancellation; disposal; no lifecycle controls | K        | unchanged                                                            |
| requires a non-empty reason and stable evidence references                                                                                | R        | only the reason is validated                                         |

### `goal-runtime.test.ts` (verification-related)

| Test                                                                                                                                                                                              | Decision | Note                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| requires evidence source and verifier dependencies as a pair                                                                                                                                      | K        |                                                                                                |
| persists verifier usage once; applies the budget gate; stops when the budget is spent                                                                                                             | K        |                                                                                                |
| persists verifier acceptance before completing                                                                                                                                                    | K / R    | assertions on `evidence` and `evidenceTurnIds`                                                 |
| accepts a verified blocker; accepts an evidenced infeasible blocker on its first turn                                                                                                             | K        | coverage satisfied on lineage records                                                          |
| rejects an invalid evidence reference without calling the verifier                                                                                                                                | R        | a coverage failure is rejected locally                                                         |
| stops continuations when completion evidence exceeds the catalog                                                                                                                                  | R        | an oversized objective stops with the dedicated reason; a long turn completes                  |
| does not accept catalog exhaustion as an external blocker                                                                                                                                         | D        | no catalog                                                                                     |
| lets a repeated blocker streak reach the verifier when the catalog truncates                                                                                                                      | R        | three turns with tool evidence reach the verifier                                              |
| checkpoint scheduling, replay, provider failure, stall breaker, batching                                                                                                                          | D        | unreachable after step A, deleted in step C                                                    |
| checkpoints after the verifier rejects; rejection cause below threshold; feedback kept when the checkpoint fails                                                                                  | R        | no checkpoint after a rejection; feedback kept                                                 |
| preserves raw lineage when a repeated blocker verifier rejects                                                                                                                                    | K        | cursor unchanged                                                                               |
| moves to `usage_limited` when flush / read / cursor / provider fail                                                                                                                               | K / R    | source failures carry `evidence_catalog`; provider failures retry at half first                |
| queued user input, in-flight results after edit / pause / disposal, persistence failures, one continuation snapshot, verification live when a pause append fails                                  | K        | unchanged                                                                                      |
| returns only a bounded evidence catalog and rejects it after stale I/O                                                                                                                            | R        | `getGoalForWorker` reads no transcript                                                         |
| returns a bounded catalog without exposing full evidence content                                                                                                                                  | D        | no catalog                                                                                     |
| defensive worker state; oversized reason; repeated audit normalisation, restore, bound, pause reset, consecutiveness; authority / external ready immediately; pending proposal without a verifier | K        | unchanged                                                                                      |
| the no-progress group                                                                                                                                                                             | K / R    | the stall exemption applies only with a checkpoint verifier; a restored stall count is cleared |
| lets the checkpoint stall breaker outrank the bound                                                                                                                                               | R        | holds only with an injected checkpoint verifier; deleted in step C                             |

### `client-goal.test.ts`, `goal-turn-integration.test.ts`, `Session.test.ts`, `nonInteractiveCli.test.ts`

All K: `goalContext` stamping, `goal_runtime` provenance for the Goal tools' own results, `terminateTurn` semantics, verifier feedback in the continuation. Only the literal continuation lines asserted by the CLI stream test change with the prompt.

## Appendix B: assumptions the rest of the runtime makes

| Assumption (location)                                                                                            | Handling                                                              |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| verifier 30 s timeout, one attempt (`goal-verifier.ts:13`, `:199`)                                               | timeout grows with the request; the runtime retries at half           |
| 256 000-byte request (`goal-verifier.ts:14`)                                                                     | budget derived from it minus the measured envelope; guard kept        |
| `maxItems: 100` implies at most 200 000 bytes of cited content (`goal-tools.ts:447`)                             | replaced by the budget                                                |
| cited records sent whole (`goal-evidence.ts:1124-1147`)                                                          | 16 000-byte middle cut, justified by measured sizes                   |
| `runVerification` error mapping (`goal-runtime.ts:1165-1185`)                                                    | the table above                                                       |
| `goalLimitKindForReason` recognises two strings (`goal-protocol.ts:308-318`)                                     | unchanged; source failures set `limitKind` explicitly                 |
| evidence-limited resume branch (`goal-reducer.ts:237-252`)                                                       | kept for source failures; not deleted in step C                       |
| cursor moves on create / edit / resume / checkpoint                                                              | checkpoint no longer moves it; the rest unchanged                     |
| no-progress stall exemption (`goal-runtime.ts:1932`)                                                             | gated on a wired checkpoint verifier                                  |
| restore of `checkpointPending` throws without dependencies (`goal-runtime.ts:1628-1641`)                         | dropped when no checkpoint verifier is wired                          |
| `config.ts:10127` wires the checkpoint verifier                                                                  | removed                                                               |
| UI, SDK, Web Shell and telemetry read `checkpointStalls`, `lastCheckpointFailure`, `limitKind`, `evidenceCursor` | fields removed in step D; `limitKind` narrows; `evidenceCursor` stays |
| `chatRecordingService` stamps `goalContext` and excludes `goal_runtime` results                                  | unchanged                                                             |
| hosts honour `terminateTurn`                                                                                     | unchanged; only `readyForVerification` triggers it                    |
