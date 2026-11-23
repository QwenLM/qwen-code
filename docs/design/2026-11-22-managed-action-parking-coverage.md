# Managed Action Parking: widening the first increment

[English](2026-11-22-managed-action-parking-coverage.md) | [简体中文](2026-11-22-managed-action-parking-coverage.zh-CN.md)

Status: proposal, pre-implementation design. Date: 2026-11-22. This follows the [Action parking design](2026-11-21-managed-action-parking.md) (Phase 4, merged in #18115) and is checked against `main` at `5714ee4c53`. It takes each wait shape the first increment excludes, one at a time, and answers that design's open question 4 and, except for team plan approvals, its open question 3. Tracked in #18149, whose Stages 0–5 map to the slices in §6. Code references are to that commit. Conclusions marked "to verify" come from reading the code, not from tests, and must be confirmed by a test before their slice is implemented.

## 1. Problem and current state

### 1.1 The exclusions and their real gates

The first increment parks only waits that cold recovery already accepts (parent §2). The exclusion logic lives in three places: the park eligibility `actionParkCandidate` (`packages/cli/src/serve/hosted-harness-session.ts:5123`), the continuation producer `captureNativeBatch` (`packages/cli/src/serve/hosted-workspace-tool-turn.ts:4498`), and the cold-recovery entry points (the takeover arm `hosted-harness-session.ts:8386`, the approval recovery arm `:8645-8652`, and `resumeSavedNativeBatch` `hosted-workspace-tool-turn.ts:4327`).

| Exclusion                                                                          | Code gate                                                                                                                                        | Root cause                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image-only Prompt                                                                  | `hostedOriginalPromptText` (`hosted-harness-session.ts:2882`) joins only the text parts of the projected user record                             | The gate is stricter than needed: for a `hosted-harness` input, `executeHostedTurn` reads the full input, attachments included, back from the durable `managed-input` resource through `readHostedInput` (`packages/cli/src/serve/hosted-input.ts:167`); the text argument is only a fallback for other sources |
| Background work + Action                                                           | The Store refuses at seal: `A parked Turn cannot share a wake-pending or background seal.` (`JournalWriterLifecycle.java:422`)                   | Combining the 3b certificate with the park certificate is undefined (parent open question 4)                                                                                                                                                                                                                    |
| Child Sessions                                                                     | The `lineage` term of eligibility (`:5131`)                                                                                                      | Conservative exclusion. A child Turn is itself a coordinator-dispatched `ma_turn` row, so the park CAS applies as is; the risk lies in the relays that depend on it                                                                                                                                             |
| Wake-started Turns (monitor, loop, automation, channel, child-result notification) | `isWakeOwnedInput` (`:2101`, `:5147`)                                                                                                            | The Harness's wake pump runs these Turns, so there is no coordinator-held `ma_turn` row to park; on cold load the pump handles an "attempted wake input" with `settleCrashedWakeTurnAftermath` (`:1828`), settling it as a crash instead of resuming the approval                                               |
| Hooks                                                                              | Eligibility `session.hooks`; producer `:4528`; `resumeSavedNativeBatch` `:4327`; takeover `:8386`                                                | The continuation carries no Hook evidence, and the recovery arms refuse a Session with Hooks. The Hook evidence itself is already durable: every PreToolUse/PermissionRequest writes a `hook_execution` record, and a reader replays from those records (`hosted-workspace-tool-turn.ts:3576-3740`)             |
| MCP                                                                                | Eligibility `session.mcp`; producer `:4528` and its tool allowlist; recovery arm `:8651`                                                         | Recovery requires each tool definition to deep-equal the declaration rediscovered after cold load; without a retained catalog an MCP server may advertise a different definition, so a parked Turn could not resume                                                                                             |
| Extension command-step approvals                                                   | Eligibility `continuation.plan.commandStep !== undefined` (`:5160`)                                                                              | The takeover recovery arm already supports them (`extensionsCommandStepTakeover`, `:8389-8394`, Hook catalog allowed); eligibility just has not been opened                                                                                                                                                     |
| `uncaptured` batches                                                               | The producer refuses: ordinary batches on a Workspace Shell profile, tools outside the allowlist, Hooks/MCP, plans over 64 KiB, undigested calls | The most common source is a `run_shell_command` approval on a Shell profile: G3 built continuations for native files only, and Shell before dispatch needs its own positive evidence (G3 §4.3)                                                                                                                  |
| v1/v2 approvals                                                                    | Recovery declines any batch containing v1/v2 (G3 §4.1)                                                                                           | Exists only in waits written before the upgrade and disappears on its own                                                                                                                                                                                                                                       |

### 1.2 One invariant fixes the order of extension

To the journal, a frozen Turn is identical to "the process was SIGKILLed at the wait point" (parent §4.2). **Park coverage can therefore never exceed cold-recovery coverage.** Each slice must first make cold recovery accept the wait, then relax park eligibility in the same slice. It follows that each slice also fixes crash recovery for the same wait: today, a monitor Turn waiting for an approval when its Harness crashes is settled as a crash instead of continuing to wait.

## 2. Goals and scope

Goals:

- Make each wait shape excluded by the first increment parkable, or state explicitly that it stays unsupported and why.
- Reuse the G3 approval-continuation driver and the parent's certificate, CAS and unpark mechanisms for every shape; build no second park/resume protocol.
- Make each slice independently reviewable and revertible, relaxing only its own term of the shared eligibility function.

Non-goals:

- Parking a parent Session that waits on a child result (a parent Turn inside an `agent` call). That is a new kind of wait with no Action and needs its own design (see §9).
- Handing back the Turn's Runtime membership while parked (parent open question 2).
- Sessions on a public Workspace Shell profile with MCP: Phase 1 never suspends them, because detaching them needs a lifecycle authority.
- Recovering v1/v2 waits (§4.8).
- Team plan approvals. The parent's open question 3 lists them, but this design has not analyzed their recovery path, so they stay resident and need their own analysis.

## 3. Overview

1. **P0: fold the eligibility function first.** Extract the takeover arm's Session-shape guards (Hooks, MCP, lineage, wake ownership, command step, readable Prompt) into one function that both park eligibility and the cold-load recovery arms call, with tests asserting both give the same answer for the same journal state. #18115 already lists this as a follow-up. Afterwards each slice changes only that function plus its producer or recovery arm, so no second copy of "equivalent-looking" conditions ever exists. The function also returns a typed refusal reason, and the Harness counts park refusals by reason in its existing observability. Today `actionParkCandidate` returns `undefined` on every refusal without saying why, so there is no data on which shapes keep Sessions resident; these counts drive the reordering in §6 and answer open question 3.
2. **Extend slice by slice** (§4). Each slice has three parts: the cold-recovery producer or recovery-arm change, one relaxation in the shared eligibility function, and the matching fault and real-process tests.
3. **Contract changes are gated by a capability bit.** Slices that change the seal certificate's shape (S2, S4) have the control plane advertise one more capability bit in the writer grant, and the Harness sends the new certificate shape only when it sees that bit. No configuration key is added; the bit is advertised together with `qwen.managed-agent.action-parking.enabled`. Rationale: a seal refused after the freeze is an irreversible teardown failure. Bounded recovery does converge, but "mixed versions are unsupported" should not be the safety net.

## 4. Slices

### 4.1 S1: image-only Prompts

- **Change.** In both recovery arms and in park eligibility, replace `hostedOriginalPromptText` with "the original input is readable". For a `hosted-harness` source, `readHostedInput` must succeed and return non-empty text or attachments. Other sources still require non-empty text, because text is their only fallback. The text passed to `executeHostedTurn` on resume is the `text` that `readHostedInput` returns, which may be empty, matching the original live Turn.
- **To verify.** (a) The history of the first model request after resume contains the original image. The user record restored from the journal should carry the inline image; the in-memory `InMemoryImagePayloadStore` (`packages/core/src/services/image-payload-references.ts`) only evicts at request time and is empty after a cold load. If the restored history holds only an `[Image #id: …]` text reference, the image is lost, and the text-plus-image Prompts that may already park today have the same defect; this slice must then tighten them as well. (b) The consumers of the run option `prompt: text` (`hosted-harness-session.ts:4486`) accept an empty string.
- **Surface.** Harness only.

### 4.2 S2: background work + Action

- **Change.** The seal carries both the 3b background hold and `parkedTurn`; the Store accepts the combination only when the new capability bit is advertised. Parent §4.9 item 3 already defines that once the Broker stages a background terminal, it seals through the existing staged-wake path and clears the parked fields. This slice adds one step: the same transaction unparks the Session's `hosted_action_parked` row, reusing the store method of parent §4.6. The coordinator then redispatches the Turn immediately, instead of leaving the resident Turn rebuilt by the wake load with nobody consuming its event stream until `retry_after`.
- **Load path.** A wake-recovery load is `passiveRecovery` (to verify), so `takeoverFlags` is true and the load enters the approval recovery arm, which rebuilds the waiter. The coordinator's drive load then converges with it under the #17521 attachment rules and replays from its consumed watermark. The background notification stays pending as a wake input until the Turn settles, and only then does the pump deliver it. Meanwhile another input is pending, so the Session cannot park again. This is bounded: at most one reload per background terminal.
- **Invariant.** The park CAS does not read the background field. The background hold is still proven by 3b, and `parkedTurn` is still proven by "the only live Turn is in a parkable wait". Neither certificate infers the other.
- **Surface.** Store seal validation, the staged-wake transaction and the grant bit; on the Harness, relaxing the "no background hold" term of eligibility.

### 4.3 S3: child Sessions

- **Why the CAS applies as is.** A child Session's Turn is a coordinator-dispatched `ma_turn` row. `ChildResultRelay` acts only on terminal statuses and a few specific error codes when it reads that row, and treats `RUNNING` as a wait. A parked row stays `RUNNING`, and `hosted_action_parked` matches none of those branches. Child Sessions run without the live poll (`hostedApprovalForTurn` turns it off when `lineage` is set, `:997`), so their certificate carries no `approvalRevision`.
- **Prerequisite.** The cold-open admission section of the [stateless Harness design](2026-11-16-managed-stateless-harness.md) lists the relay attempt-budget gap as a Phase 1 prerequisite: session-message delivery, child-result delivery and automation fires still charge waits against their attempt budget, so a cold-open burst can settle a message as cancelled or unknown. Confirm that this gap is closed first; if it is still open, close it first as part of this slice.
- **Change.** The eligibility function drops the `lineage` term and keeps every other one. A pending session message is a wake-owned input, so its presence keeps the Session from parking, and the relay's reload brings the Session back.
- **Benefit.** The parent Turn remains resident inside its `agent` call, so this slice frees only the child Session's resident. Zero residency for the whole tree also needs parent-waits-on-child parking, a non-goal in §2.
- **To verify.** The mount-handback path for a child Session's single-question batch (`questionChild`) behaves correctly after cold recovery, and `MESSAGE_TURN_WAIT_MS` does not settle anything wrongly during a long park.

### 4.4 S4: wake-started Turns

This is the largest slice, delivered in two steps: monitor, loop, automation and child-result notifications first; channel and `pr_event`, which also carry reply plans and channel settlement, follow as S4b.

- **Harness recovery arm.** When the pump handles an "attempted wake input" whose checkpoint is at `await_action` and whose continuation the shared eligibility function accepts, it resumes the wait through the approval-continuation driver instead of calling `settleCrashedWakeTurnAftermath`. Shipped alone, this step already fixes crash recovery for wake Turns that wait for an approval.
- **Certificate.** These Turns have no `ma_turn` row, so only the wake-recovery scan can wake them on expiry. `parkedTurn` gains `owner: 'wake'`. `ma_session_head` gains the nullable column `wake_seal_parked_owner`, written in the same seal UPDATE as the other parked columns and cleared by any generation-incrementing writer acquisition; if the writer that cleared it then crashes, the existing wake recovery of "committed inputs no writer owns" takes over (to verify). Per this module's rules, the V1 baseline is edited in place and no migration is added. The wake-recovery scan additionally selects heads with `wake_seal_parked_owner = 'wake'` and `wake_seal_parked_until <= now`. `wake.pending` stays `false` here: the input was already attempted, so it is not one of the "deferred, unattempted" wake inputs 3a defines, and its meaning must not be reused.
- **Wake sources.** Decision: on a cache miss, `ACTION_RESPONSE` delivery loads the Session (`doResolveAction`), and that load must be a passive takeover load (to verify). Cancellation and approval-mode changes: the unpark of parent §4.6 acts on `ma_turn` rows, and a wake-owned park has none. These two paths instead set the head's `wake_seal_parked_until` to now in the same transaction, and the scan loads the Session on its next pass (to verify: today's cancel entry point for wake Turns and its transaction boundary). Expiry: handled by the scan.
- **Relation to 3a.** If the same Session also has a deferred, unattempted wake input, this increment still does not park, because the "only pending input" condition is unchanged.
- **Surface.** The Harness pump, the Store seal and scan, the cancel and approval-mode-change transactions, and the grant bit.

### 4.5 S5: Hooks

- **Existing basis.** `hook_execution` records persist the input and result of every PreToolUse/PermissionRequest under `${promptId}:${callId}`, and `orderedHookInput` recomputes the effective input from them without rerunning the Hook. The waiting call has already finished PreToolUse and PermissionRequest before it asks for a human decision.
- **Change.**
  1. Producer: lift the Hooks half of `(this.hooks || this.mcp)`. For each call, the continuation records the Hook occurrence IDs completed before the wait, with their result digests.
  2. Recovery: `resumeSavedNativeBatch` accepts Sessions with Hooks. Completed occurrences are read back through the existing saved-output path. An occurrence that has a record but no result is uncertain, and recovery declines (G3 §4.2 step 5). PostToolUse after an Allow is a new occurrence, proven not started before execution, and runs normally.
  3. Takeover: `takeover` stops excluding `session.hooks` unconditionally and defers to the shared eligibility function. When a recoverable native continuation exists, skip `answerResumedTurnCalls`: it answers interrupted calls as "never run", which would permanently destroy the continuation, the same hazard as command-step R9-1.
  4. Eligibility: the waiting call's PreToolUse and PermissionRequest have both completed, or are provably not configured. The Phase 1 "no Hook operation in flight" condition is unchanged.
- **To verify.** A cold load that resumes a parked Turn does not refire SessionStart or UserPromptSubmit (G3 requires "without reapplying startup Hooks").
- **Surface.** Harness only, but it touches the G3 producer and recovery arms, so the G3 A3/A6 fault gates need Hook variants.

### 4.6 S6: MCP

- **Dependency.** Phase 2's `qwen.managed-agent.runtime-broker.mcp-parking.enabled`. Only when connections and the catalog are retained across the suspension, and the new writer reacquires them by durable owner identity, can the MCP tool definitions seen after a cold load be guaranteed to deep-equal those saved in the continuation. Otherwise do not park: discovering after a park that recovery fails is worse than staying resident.
- **Change.** The producer admits MCP tools into the allowlist, and the continuation records the MCP configuration's durable revision and catalog pin. Eligibility requires MCP parking to be enabled, the current grant to reacquire the same owner, and every earlier MCP call in the batch to have a committed result. If any call is still in flight, the Phase 1 "unsettled Runtime work" condition already refuses. The waiting MCP call has not been dispatched, so an Allow dispatches it exactly once.
- **Invariant.** MCP calls have no prepare/receipt protocol like native files, so a dispatched call is never replayed, and any call with an uncertain dispatch state declines.
- **Surface.** The Harness producer and recovery arm, aligned with the Broker's MCP owner reacquisition.

### 4.7 S7: extension command-step approvals

- **Change.** The eligibility function accepts `plan.commandStep` when `plan.commandStep.configRevision` equals the current extension configuration revision (`resumeSavedNativeBatch` already checks this, `hosted-workspace-tool-turn.ts:4328`). The Hooks relaxation applies only to command-step plans, consistent with `extensionsCommandStepTakeover`, and does not depend on S5.
- **To verify.** The load during decision delivery must carry the takeover flags. A bare load must never answer a parked command step; the R9-1 guard exists and needs a test to pin it. If the extension configuration changes during a park, recovery declines on the revision mismatch; confirm that this lands in a typed terminal decline, not an endless retry.
- **Surface.** Harness only.

### 4.8 S8: `uncaptured` batches

- **Shell before dispatch (S8a).** This item has the highest value: most approvals on a Shell profile are `run_shell_command`. G3 requires Shell before dispatch to build its own positive continuation and ownership evidence. First confirm whether Shell execution has the same prepare with `dispatch = false` and exact-key replay semantics as native files (to verify). If it does, the continuation records the `runtimeCallId`, prepare key and argument digest as for native files. If it does not, the Broker must gain them first, and the slice grows substantially. Either way, this extends the G3 contract, so write a separate G3 extension design before implementing; this document only names the slice. Dispatched Shell keeps its refusal.
- **Plans over 64 KiB.** Not supported yet. The P0 refusal counts show how often they occur; consider storing plans as non-inline resources only if the rate is significant.
- **v1/v2.** Not supported. They exist only in waits written before the upgrade, G3 already states that legacy reconstruction needs its own validation, and the benefit shrinks to zero over time.

## 5. Decisions and rationale

1. **Cold recovery first, parking second, delivered in the same slice.** A park is a controlled crash, so no shape may become parkable ahead of its crash recovery.
2. **P0 first.** Every later slice relaxes eligibility; with two copies of the conditions, every relaxation is another chance for parking and recovery to disagree.
3. **Wake-owned parks are woken by the scan, without new `ma_turn` rows.** Creating dispatch rows for wake Turns would change their ownership model and every relay and pump invariant built on it. Reusing the wake-recovery scan costs one column and one query term.
4. **MCP parking is tied to Phase 2 MCP parking.** Without a retained catalog, an MCP park cannot prove its definitions are unchanged at recovery.
5. **The child slice does not include parent-waits-on-child.** The latter is another kind of wait (no Action, no approval continuation); bundling it would widen what G3 must prove.

## 6. Recommended order and measurement

| Order | #18149 stage | Slice                                            | Surface                         | Depends on                     |
| ----- | ------------ | ------------------------------------------------ | ------------------------------- | ------------------------------ |
| 0     | 0            | P0 shared eligibility function + refusal reasons | Harness                         | —                              |
| 1     | 1            | S1 image-only Prompts                            | Harness                         | P0                             |
| 2     | 1            | S7 command step                                  | Harness                         | P0                             |
| 3     | 2            | S2 background + Action                           | Harness + Store                 | P0, 3b                         |
| 4     | 2            | S4 wake Turns (S4b channel later)                | Harness + Store                 | P0                             |
| 5     | 3            | S3 child Sessions                                | Harness                         | P0, relay budget gap closed    |
| 6     | 4            | S5 Hooks                                         | Harness (G3)                    | P0                             |
| 7     | 4            | S6 MCP                                           | Harness (G3) + Broker alignment | P0, Phase 2 MCP parking        |
| 8     | 5            | S8a Shell before dispatch                        | Harness (G3) + possibly Broker  | A separate G3 extension design |

The order rests on code-level estimates: small Harness-only slices first, then slices that need new G3 evidence. These estimates are not measured. Before starting S3 or a later slice, use the P0 refusal counts to see each wait shape's share of real load, together with the parent §7 measurements, and reorder by share; for example, if Shell-profile deployments dominate, S8a should move up.

## 7. Verification plan

Each slice inherits every case of parent §11 and adds:

- **Agreement.** For the same journal state, park eligibility and the cold-recovery arm give the same answer. Cover the shape the slice opens and the neighbouring shapes that stay excluded.
- **Crash equivalence.** First run "SIGKILL during the wait → another Harness generation takes over → decide" for the slice's shape and confirm cold recovery is correct; then run "park → cold load → decide". Both must yield the same journal outcome.
- **S1**: after an image-only Prompt parks and is allowed, the request snapshot of the first model request after resume contains the original image.
- **S2**: a background terminal arriving during the park unparks and resumes the Turn, and the notification is delivered after the Turn settles; the tool and the notification each happen exactly once.
- **S4**: a monitor-started Turn parks and completes through each of decision, cancellation, mode change and expiry without the coordinator; the pump no longer settles a wake input at `await_action` as a crash.
- **S5**: completed PreToolUse/PermissionRequest occurrences are not rerun after resume (asserted by occurrence counts); an occurrence with a record and no result declines; SessionStart and UserPromptSubmit do not refire.
- **S6**: with MCP parking on and off, the Session parks only when it is on; after resume the tool definitions are equal and no dispatched MCP call is replayed.
- **Real process and MySQL 8.4**: each slice puts at least one "park → new Harness generation → decide" case into the required CI tier; H2 results cannot replace it.

## 8. Acceptance criteria

- After each slice ships, a wait outside that slice's conditions behaves exactly as before, and existing test results are unchanged.
- A newly opened shape parks cleanly after one idle period. For each of decision, cancellation, mode change (where applicable) and expiry, one cold recovery completes the original Turn with unchanged Action, Prompt and batch identities; Allow executes exactly once and Deny zero times.
- The same shape, when the Harness crashes during the wait, also continues through cold recovery instead of being settled as failed.
- The real-process, MySQL and fault cases of §7 pass in CI, and the parent §7 measurements are complete, before any deployment turns on `action-parking.enabled`.

## 9. Open questions

None of these blocks development. Each of questions 1–3 is implemented with the default below first and revisited after measurement, and none of the later adjustments needs a protocol or schema change. Question 4 lies outside this design.

1. **Latency of cancelling, or changing the approval mode of, a parked wake-started Turn (S4).** Once these paths set `wake_seal_parked_until` to now, their latency is bounded by the wake-recovery scan interval (2s by default).
   - Default: rely on the scan alone. Ordinary parked Turns are already redispatched by the dispatch sweep (1s), and the parent design treats an immediate kick after commit as a latency optimization, not a correctness requirement (parent §4.6).
   - Revisit if the measured latency is unacceptable: add a direct load kick after the commit, which is a single extra call.
2. **Minimum park duration for combined parks (S2).** A Session with frequent background terminals may lose more than it gains from repeated parks and reloads.
   - Default: none. This is tuning, not correctness, and the feature is default-off.
   - Revisit if measurements show repeated park-and-reload churn: add a Harness eligibility constant. The certificate and the control plane are unaffected.
3. **Share of plans over 64 KiB and of Shell before dispatch in real load.** This affects only whether S8 is worth doing, and when; P0 through S6 are unaffected. It is answered by the P0 refusal counts.
4. **Parking a parent Session that waits on a child result** (a non-goal in §2). There is no Action, so it needs its own wait proof and wake source (the child Turn's terminal). It is required for zero residency across a child-Session tree and needs its own proposal.
