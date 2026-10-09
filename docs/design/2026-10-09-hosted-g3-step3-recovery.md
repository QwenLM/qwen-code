# Hosted G3 Step 3 — recover parked Turns after Harness replacement

[English](2026-10-09-hosted-g3-step3-recovery.md) | [简体中文](2026-10-09-hosted-g3-step3-recovery.zh-CN.md)

Status: implemented in the current working tree, 2026-10-09; five scoped Linux packaged acceptance modes passed against immutable snapshot `linux-delivery-gates-2`. Source baseline: upstream `main` at `669b2f0f91b0c787f7d8a26971c7c34210b935e1`. Part of [#12952][g]; follows the existing G3 native-file recovery work. This does not close the broader G series or Q2 fencing gates.

The implementation produces native-file approval plans for native-file profiles without Hooks or MCP (packaged gates cover `hosted-workspace-files/1`), exact main-model request snapshots without Hooks, bounded cold-stream retractions, and native Turn cleanup obligations. Cold model reissue is admitted only without Hooks or MCP. Shell profiles retain their existing execution/cleanup owner. Live prefix continuations remain supported, but an unfinished prefix continuation has no cold-reissue snapshot and declines recovery. A committed final answer with a completed main attempt can still receive terminal-only compensation without reissuing inference. Oversize snapshots deliberately remain unsupported. The production protocol and readers are updated together in this tree; the gates below state the required acceptance evidence.

## 1. Problem and existing behavior

G3 Steps 1–2 let a live Java control plane adopt a replacement Hosted Harness.
Step 3 must finish the original Turn when the crash occurred in model inference
or an approval wait, and preserve already committed terminal events. Recovery
must keep the original Session, Prompt, authority and side-effect identities.

| Baseline behavior                                                                                                                          | What Step 3 still owes                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| The connector renegotiates a new Harness generation; journal writer fencing and Harness-only restart gates are merged.                     | Keep that fencing before every recovery write and every new tool admission.                                          |
| `await_runtime` / `results_ready` file-tool recovery queries original executions and consumes their results.                               | Reuse it; do not rebuild or dispatch those calls from model output.                                                  |
| A requested approval can attach, and resolve commits its decision before replying.                                                         | A replacement has no original in-memory waiter. It must drive or settle the parked Turn after the durable wait ends. |
| `resolveDurableWait()` advances `await_action` to `model_output_committed`.                                                                | This checkpoint transition does not execute the approved batch or finish the Turn.                                   |
| No-tool and first-model-round drive loads decline with `model_start`.                                                                      | Recover a proven model request boundary instead of starting an ordinary fresh Turn.                                  |
| The load route can compensate a projectable `turn_settled` checkpoint; Java changes the event epoch without advancing the consumed cursor. | Complete fault and lost-response coverage; do not replace these mechanisms with a new projection protocol.           |
| Cancellation-only loads can settle some parks with no unpaid Runtime work.                                                                 | Cover requested approvals, expiry and post-decision crashes without certifying an unobserved stop.                   |

Source anchors: `hosted-runtime-recovery.ts` (`recoverHostedRuntimeTurn`),
`hosted-harness-session.ts` (`executeHostedTurn`, `settleCancelledHarnessTurn`,
the load and Action resolve routes), `hosted-tool-approval.ts`
(`resolveHostedAction`), `managed-harness-factory.ts` (`resolveDurableWait`),
and Java `HarnessCoordinator` (`dispatchClaimed`). These are baseline facts,
not new acceptance results.

`model.attempt: output_committed` currently records a finished provider stream
before the final assistant message is durably written. It is not proof of a
committed answer. A fresh model invocation also starts its loop at round zero;
Step 3 must preserve the original remaining rounds and absolute
`input.accepted.deadline`.

## 2. Scope and invariants

This design covers successive Hosted Harness generations reachable through one
Java control plane. Ordinary local Managed activation, two live control-plane
owners, cross-host takeover and Shell execution takeover remain separate.

- A successful load means the parked Turn has a registered driver, a durable
  approval wait with an expiry path, or a payable terminal projection. Merely
  making the Session readable is insufficient.
- A model request may be reissued; a possibly dispatched tool, Hook, MCP call
  or child task may not be recreated to make recovery progress.
- The journal is authoritative for admission, Action state, execution receipts
  and settlement. Java owns public command delivery and its consumed event
  cursor; the current fenced Harness owns model and tool orchestration.
- Keep the original `promptId`, user record, Action IDs, model message IDs for
  committed outputs, and execution IDs for prepared work. A new inference
  attempt gets a new attempt/message identity, not a new Prompt.
- A fresh Prompt, undo and cwd change stay refused while the original Turn or
  a cleanup obligation still owns the corresponding resource. Status and
  cancellation must report the parked Turn truthfully.
- Store faults are retryable faults, not evidence that a resource or execution
  is absent. Missing, corrupt or conflicting durable evidence fails closed.
- A Managed failure never falls back to Legacy. Stale Workspace authorization,
  changed capability/configuration pins or writer loss never grant execution.

## 3. Recovery decisions come from evidence, not phase names

`HARNESS_MODEL_START_PHASES` is a run-admission vocabulary, not a recovery
allowlist. In particular, `model_output_committed` may mean an approved tool
batch is still owed; `results_ready` owns receipts; `turn_settled` owes only
projection. A bootstrap `before_model` checkpoint with a null Turn is not a
snapshot of the currently accepted model request.

| Durable evidence for the original Turn                                                                                   | Proposed behavior                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Submission was marked but Java has no admission epoch/reply.                                                             | Keep G3 D4's original-command reconciliation. A null epoch proves only a missing reply: journal command idempotency and the parked-input refusal make this safe. No Step 3 resubmission shortcut. |
| Complete main-model request snapshot; unfinished attempt; no committed output or unsettled side effect for that request. | Reissue that model request under a new attempt after fencing and retraction.                                                                                                                      |
| Complete assistant tool-call message, but batch has no complete approval continuation evidence.                          | Do not reissue the model or run the ordinary tool entry. Keep the existing recovery refusal.                                                                                                      |
| `await_action`, Action still `requested`, complete continuation evidence.                                                | Retain the same Action, restore its waiter/expiry and cancellation driver.                                                                                                                        |
| Action `decided` with `allow` or `deny`, complete continuation evidence.                                                 | Drive the exact saved batch; apply the saved decision once. Deny becomes a paired tool refusal, then normal model continuation.                                                                   |
| Action `cancelled` / `expired`, or an admitted Turn cancellation wins before fresh dispatch.                             | Close the durable wait and settle the original Turn as cancelled, after proving no unpaid effects.                                                                                                |
| Partial prepare or intent evidence exists after an Action decision.                                                      | Reconcile original reservations and complete the original batch checkpoint before entering G1/G2; never prepare under replacement IDs.                                                            |
| Complete `await_runtime` / `results_ready` execution evidence exists.                                                    | Recover the original executions through G1/G2. No fresh prepare under replacement IDs.                                                                                                            |
| `results_ready` with complete original tool results.                                                                     | Existing result continuation; never rerun the tool-producing model round.                                                                                                                         |
| `turn.settled` already committed but not consumed by Java.                                                               | Rebind the event epoch and replay from Java's consumed cursor; no inference or tool execution.                                                                                                    |
| `turn_settled` checkpoint is payable but terminal record is missing.                                                     | Existing terminal projection compensation, with idempotent write and replay.                                                                                                                      |
| In-flight Shell, unknown external work, incomplete Hook/MCP/child evidence or ambiguous multiple parked Turns.           | Existing typed decline/block; keep the affected ownership fence.                                                                                                                                  |

The model and approval cases need small, producer-specific durable resources.
There is no new universal recovery domain, public resume API or configuration
matrix.

## 4. Slice A — finish approval waits (B2)

### 4.1 Save the continuation before publishing the wait

The existing `approval.invocationRef` saves one call's input, and its
`optionsRef` identifies the Action. Neither alone preserves a mixed batch,
earlier decisions, rewritten inputs or the point at which a Hook asked again.
Save an immutable `hosted-approval-continuation/1` resource before
`commitDurableWait()`. Proposed Action options version 3 references it through
`continuationRef`; retain `invocationRef`'s current meaning.

| Continuation content                                                                                                                     | Required purpose                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Session key, original Prompt, assistant message, definition/config/profile/policy pins and source activation.                            | Reject foreign, stale or differently configured continuation.                                                        |
| Ordered call IDs, names, effective input refs/digests, tool definitions, stable `runtimeCallId` and prepare idempotency keys/references. | Reconstruct the original batch without inventing arguments or IDs.                                                   |
| Current Action ID, approval ordinal and whether the wait is before PreToolUse or a reapproval after input rewriting.                     | Resume at the right point without granting a later input an earlier approval.                                        |
| Earlier decisions/refusals and completed permission/Hook evidence references.                                                            | Keep decisions and side effects already paid; do not repeat Hooks.                                                   |
| Original Runtime owner identity and any existing prepare/receipt evidence.                                                               | Distinguish a pre-dispatch plan from work that must go through G1/G2.                                                |
| History boundary and model/Hook continuation inputs.                                                                                     | Continue from the committed assistant call message, without another user record or inference of the same call batch. |

The Action options, descriptor and nested input references must be present in
the same durable wait transaction. A failure publishes neither a recoverable
wait nor a claim that its inputs are complete. All refs stay inside the same
Session; existing resource and transaction limits apply.

The first approval snapshot is not necessarily the final execution plan:
PreToolUse may rewrite input and allocate a new `runtimeCallId`, even without
another approval. After Hooks and decisions complete, before file-history or
prepare effects, publish and journal-link the latest immutable effective batch
revision. Use a narrow `hosted.batch.planned` event with `batchId`,
`planRevision` and `planRef`, referencing the same continuation format. Save the
final model-call/runtime-call IDs, normalized payload refs/digests, definitions,
refusals/decisions, original owner and complete Broker prepare reference/key.
Recovery selects that revision, not the initial approval descriptor. No
file-history or prepare effect may precede this durable link. If a crash occurs
before a final plan exists, resume only from proven completed Hook/decision
stages; incomplete producer evidence keeps the refusal.

Version 3 keeps the existing preview policy: `inputRef` is present only for
tools eligible for the native bounded preview; `continuationRef` is private
recovery data and is never returned as a public Action field. Both the Java
Action projector and TS options reader must support v1/v2/v3 before a writer
emits v3.

### 4.2 Restore a driver, then honor the durable winner

1. Acquire the new writer activation and restore the exact Session/profile,
   original Runtime owner and continuation evidence. Check cancellation and
   current authorization before permitting fresh effects.
2. Register one parked-Turn owner before load answers. `/status` remains in
   flight; `/prompt` cannot overwrite the park. Resolve, cancel, expiry and
   repeated loads join the same per-Session driver. Its in-memory latch is only
   single-process scheduling; journal CAS and original dispatch IDs provide
   crash idempotency.
3. For a requested Action, keep its original ID and deadline. Register its
   waiter and one expiry timer, then re-read the Action to cover a decision
   that won before registration. No new approval is minted for the same input.
4. For Allow/Deny, verify the original decision digest, input revision and
   policy revision. Advance the wait once, restore the saved execution stage,
   and continue the saved batch. Reevaluate changed effective inputs against
   the applicable policy and obtain a new approval when required; a saved Allow
   never authorizes rewritten arguments by itself.
5. Resume completed Hook occurrences from their original records. Admit a new
   occurrence only when the next stage was proven not started. An uncertain
   Hook/MCP result or existing tool intent diverts to its recovery path, never
   to a fresh invocation. Producer adapters without complete evidence decline.
   For native files, a crash among prepare calls or between prepare and
   `tool.intent` needs batch reconciliation before G1: retry/query prepare with
   the saved `runtimeCallId`, original idempotency key/reference and digests;
   recover matching `PREPARED` reservations; append missing original intents;
   commit the complete original `await_runtime` batch; then enter G1. Broker
   prepare uses `dispatch = false` and exact-key replay returns the original
   execution receipt. Do not call `prepareRequests()` to reconstruct the plan:
   it generates new random IDs. A conflict or unknown reservation blocks. Never
   dispatch before the complete batch and required approval/Hook evidence are
   durable.
6. For expiry or cancellation, record the Action's final state by CAS, close
   `await_action`, pair any committed unanswered call records truthfully, then
   write one cancelled Turn terminal. Expiry takes this cancelled outcome;
   it does not start another model request after the restart. An already
   committed decision wins the Action race; a separate admitted Turn cancel
   still prevents fresh dispatch and settles/stops whatever it actually owes.
7. Release the exact Runtime lease only after safe settlement. A failed release
   remains a durable cleanup obligation as specified in Section 6, recoverable
   after another crash. Never release an uncertain Hook or descendant writer
   based on an empty tool list.
8. Repeated resolve/load/cancel after a crash reads the committed decision,
   checkpoint, original intents and terminal before acting. It neither asks
   again nor executes under a replacement ID.

The resolve route continues to commit a decision before its response. An Action
response operation can complete when that decision is durably projected; this
does not claim the Turn or tool finished. A failure after decision commit must
not rewrite a successful Action response as a failed decision. Java keeps its
original operation/key and the Turn event consumer running; browser terminal
tracking such as #13609 is a separate consumer of that operation.

Expiry must work without a browser response: load installs a deadline timer
and immediately processes an already elapsed deadline. Every reattach checks
the same saved deadline, so another process crash cannot reset it.

### 4.3 Profile and older-record boundaries

Native files are the first acceptance target. Private Shell before dispatch,
MCP, Hooks and child-agent batches require their own positive continuation and
ownership evidence; Shell after dispatch retains its refusal. Do not enable
H3, public Shell or other domains as part of B2.

Older v1/v2 waits remain readable. Safe cancel/expire is allowed only when the
old journal and producer records prove all unpaid effects absent or settled.
An old Allow/Deny without a complete recoverable batch keeps the existing
refusal; it is not silently upgraded by reconstructing live memory. Legacy
reconstruction, if later desired, is a separately validated compatibility
slice. Completion claims must name the supported producer/profile versions.

## 5. Slice B — recover an unfinished main model round

### 5.1 Persist the request before sending it

Add an optional `recoveryRef` to a main `model.attempt` event, pointing to an
immutable `hosted-model-request/1` resource. The event's existing `routeRef`
and budget information keep their meanings. Hook-model attempts do not become
reissuable. Do not repurpose `checkpoint.attempt.routeRef`, which currently
also describes tool/approval input, or change the checkpoint schema.

| Request snapshot                                                                                          | Required purpose                                                                                       |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Session, original Prompt, attempt, source activation, request digest and journal/history boundary.        | Prove which admitted request is being replaced.                                                        |
| Original effective Prompt/request Parts and normalized model-visible history/system instruction refs.     | Restore Hook-modified input, compaction and already consumed results without reapplying startup Hooks. |
| Pinned model route, sampling, definition/config/capability/profile revisions and tool declaration digest. | Reissue under the same contract; changed or unavailable pins fail closed.                              |
| Workspace context revision/content ref and completed Hook-context references.                             | Avoid reading a different Workspace or new instructions from the Harness host.                         |
| Original budget state, round ordinal and request kind.                                                    | Preserve turn limits across replacement instead of resetting the 16-round loop or cost budget.         |
| Ownership/continuation evidence for prior results and producer obligations.                               | Prove that no unconsumed side effect is being skipped or recreated.                                    |

Capture the prepared, authentication-free provider request through a narrow,
awaitable callback at the final logical request boundary in `LlmChat`, after
automatic compaction, tool-history repair and output-token adjustment, before
the generator sends it. A Hosted-layer copy made before `sendMessageStream()`
is insufficient. The Hosted caller supplies this callback for every main
request; ordinary callers keep their current behavior. Snapshot publication and
`model.attempt: started` commit must finish before the network request. Move the
main attempt's existing pre-send `started` write into this callback so it names
the request actually sent. After tools, take the next snapshot from durably
committed/settled results and completed Hook outcomes. Preserve current result
consumption timing: it advances only after successful model `Finished`, not
before this request. Never store model credentials, authorization headers or
OAuth tokens; current credentials resolve the pinned route. Resource references
carry digests and length checks, with the existing inline/transaction limits.
If the descriptor or new request data cannot fit without a new chunking/storage
mechanism, mark this request unrecoverable, write an old-compatible attempt
without `recoveryRef` and keep ordinary live inference working. After a crash
it retains `model_start` refusal; never claim recovery for that request. A Store
fault is not such a size classification and must not silently downgrade the
durability barrier. No OSS spill or new chunking mechanism is added here.

Save the normalized generator parameters, history state and original stream
owner namespace. The saved-request entry calls the pinned generator with those
parameters; it skips `sendMessageStream()`'s normal history repair, compaction,
context injection and Prompt preparation. Retain normal response processing,
usage recording, cancellation and tool-output validation. Once that response commits, the next
logical round returns to the normal loop with restored history and budgets.
A byte-equivalent transport retry can reuse the snapshot. Fallback to another
route, reactive compaction or token adjustment that changes the effective
request requires a new immutable snapshot and attempt boundary before send;
never overwrite a ref or attribute a fallback request to the previous attempt.
This does not increase the original logical-round allowance. Interrupted
compaction or Hook-model work without complete evidence retains refusal.

Before send, bind each attempt to its own pre-assigned stream message ID; keep
that mapping with the saved attempt identity, separate from the normalized
request digest. Restore the latest committed usage/model-metrics ledger as well
as the snapshot's budget baseline, so a finished stream's recorded usage is not
forgotten when its assistant commit was lost. Unknown usage from a crashed
provider call cannot be reconstructed; repeat inference can incur additional
provider cost, and exact external billing limits are not a recovery guarantee.

Recovery retains the absolute deadline already committed in
`input.accepted.deadline`; preparing a replacement request does not start a new
`deadlineMs` interval. If admission committed but no prepared-request snapshot
did, the first model slice retains refusal. Covering that earlier window would
require a separately durable initial-turn preparation plan and is not implied
by request snapshots.

### 5.2 Reissue only the saved unfinished request

1. Find the one unsettled original Prompt and its latest main-model request.
   Verify request identity, referenced history and pins, current writer and
   absence of committed output or unpaid producer effects for that attempt.
   `initial` or a bootstrap checkpoint alone is insufficient proof.
2. If an assistant output/call message was durably committed, recover its
   outstanding work or terminal projection instead. Never discard an accepted
   call batch by reissuing its producing model request.
3. Mark a former `started` attempt abandoned under its original identity;
   preserve a recorded finished-stream state when it already exists. The new
   request snapshot names the replaced attempt in either case. Restore its
   streamed message IDs, original boot/epoch namespace and bounded delta
   sequences from the journal and saved owner evidence, and commit each
   required `message.retracted` before new output. A new empty
   `HostedTextDeltaStream` cannot retract its predecessor's remembered prefix.
4. Start a new attempt for the same saved request, with a fresh message ID and
   reference to the same request digest. Lost retraction responses or another
   crash between retraction and send replay the same journal commands. A crash
   after send can cause another model inference call; exactly-once inference
   and identical regenerated answers are not promised.
5. Invoke the saved normalized-request entry with restored history, request kind,
   budget and round ordinal. Do not call ordinary `executeHostedTurn` as a
   fresh Prompt: it can write another user record and rerun Prompt Hooks.
   No-tool Sessions use this same saved-request path with empty tool declarations.
6. Admit newly produced tools through the normal approved, durable tool path.
   Previously committed calls/results stay in history with their original
   identities. Cancellation observed before send does not send; cancellation
   after send aborts inference and prevents fresh tool admission.

Extend journal retraction with optional `sourceBootId`,
`sourceEventEpoch` and `throughSequence` on `message.retracted`, alongside the
existing message ID and `fromSequence`. Validate the original namespace and
bounded message range against journal/owner evidence. Retract both the prefix
already projected under its original namespace and copies of the same journal
message/range replayed under later attachment namespaces. The journal reader
also applies it to that message, so cold replay cannot resurrect it. Current
in-band retraction selects only the current boot/epoch; it cannot remove an
already consumed old-generation prefix. Do not call broad
`retractContinuationOutput()`, which removes all old Turn/epoch deltas, including
earlier committed rounds. Retraction and consumed-cursor advance are atomic and
idempotent. Test consumed prefixes, unprojected prefixes and prefixes split
across namespaces; retain all prior committed rounds.

Keep the existing same-generation retry semantics. This slice permits
replacement-generation retraction with fenced evidence; it does not make a
published same-generation continuation automatically replayable.

Unfinished old attempts without `recoveryRef` keep the existing `model_start` refusal. A completed main attempt followed by a durable final assistant answer can use terminal-only compensation even without a request snapshot; this never reissues inference.
The new snapshot producer must run for every supported main-model request;
adding a reader or optional parameter without populating it is not delivery.

## 6. Slice C — close terminal projection and event-cursor gaps

Reuse `settleProjectablePromptId` / `runSettleProjection`, the sink's terminal
identity and Java's existing epoch CAS. This slice starts as fault coverage,
with only failures it demonstrates receiving production changes.

- A committed `turn.settled` is replayed, never recomputed. A missing terminal
  record is compensated only from complete projectable checkpoint/output and
  producer evidence. An Action decision alone is not a completed Turn.
- Rebinding changes boot ID and event epoch, while keeping Java's last
  **consumed** journal sequence. The attachment tail is an observation, not a
  consumption receipt; never jump the cursor to that tail.
- Retraction is journaled before the new attempt's deltas. Java/public replay
  and browser refresh remove the former prefix and keep the replacement
  answer, with one terminal event. Retain the existing `fromSequence` semantics;
  do not delete older committed rounds or fabricate message IDs on recovery.
- Replaying an already admitted prompt/continue/cancel returns its original
  admission watermark, not the current tail. Duplicate terminal delivery
  advances the consumer idempotently without another tool or model call.
- Terminal commit and physical cleanup are separate facts. Failed lease
  release, file-history marker retirement or producer cleanup stays owed;
  Java must not reinterpret a completed Turn as an error, and a new Turn must
  not bypass the affected resource fence. Cold restore must find the obligation.

Use one narrow `hosted.cleanup` journal event with `cleanupId`,
`descriptorRef` and state `owed` / `confirmed`, referencing an immutable
`hosted-turn-cleanup/1` descriptor. It names the original Turn, Runtime
Session/binding owner and, when applicable, native file-history marker IDs.
This is turn cleanup bookkeeping, not a general task domain. Commit `owed`
only when original ownership actually owes cleanup; a no-tool Turn does not
acquire a Runtime Session for this protocol. Save the obligation
before adopting/acquiring the recovered lease and before a terminal/release
path can lose that identity. Cleanup waits for journal and producer evidence of
safe settlement. Release uses the original `runtimeSessionId`; only Broker's
`released = true` and confirmation of every named marker permit committing
`confirmed` under the same cleanup ID. Releasing an already `RELEASED` Runtime
Session is idempotent and does not require acquiring it again. Reconcile partial
success and lost replies by querying/retrying those identities. Owners with
still-active work, unknown evidence, missing identity or binding drift remain
fenced. A failure to save `owed` prevents the
new acquisition/release; an already committed terminal remains authoritative.

Cold load and lifecycle-close reconciliation enumerate unresolved
`hosted.cleanup` events even without an `unsettledPromptId`, restore the
original owner and retry only eligible cleanup. Keep the affected
Workspace/resource fence until confirmation. A requested approval still owns
its lease and must not be released merely because this marker exists.
In-memory `runtimeLeaseHeld` / `refusedAdoptions` may schedule retries but are
not durable evidence. Missing old cleanup identity or uncertain Hook/descendant
stop evidence blocks cleanup without relabelling a committed terminal.

## 7. Protocol ownership and compatibility

No new public REST/WebShell route is needed. Existing private load, resolve,
cancel and events routes stay scoped to the live Session owner; Workspace and
Runtime calls stay inside the persisted binding and original execution owner.
None may fall back to the primary runtime on an unresolved scope.

The simplest control-plane path is the existing plain attachment plus event
replay: the Harness owns restored model/approval drivers and Java consumes
their journal. Do not disguise them as a Runtime recovery report containing
invented executions, or add a generic public recovery-kind switch. The existing
Runtime report/continue/cancel protocol remains for G1 work.

The Harness advertises `hosted_approval_resume_v1` and
`hosted_model_round_recovery_v1`; the Java SDK exposes these negotiated features.
They describe support rather than select a new public recovery route. Existing
DRIVE loads inspect durable evidence in the Harness; Store version acknowledgement
and the reader floor enforce format compatibility. An older compatible stack
retains the existing refusal. Once a
Session contains new Step 3 record formats, enforce its reader floor before an
older Harness can attach, not after parsing fails.
Use the existing `qwen_managed_session_journal_head.storage_version` as the
monotonic floor: readers support 1 and 2; the transaction that first commits
v3 options, final batch plans, model recovery data, bounded cross-generation
retraction or cleanup promotes the head to 2 atomically with that record. Keep
the checkpoint schema at 1; the storage envelope's reading contract changes.

Carry the `maxReadableStorageVersion` contract through one HTTP header,
`X-Qwen-Managed-Max-Readable-Storage-Version` (omitted means 1; new readers send
2). The shared TS Store client sends it on every head-scoped request: acquire,
renew, restore, transaction enumeration, resource read, commit, publication,
recovery and lifecycle operations, including requests outside the JSON wrapper.
The Store first checks its supported head formats, then the caller's ceiling
before lease access, reads or writes. A promoting commit checks ceiling 2 under
the head lock. Check before idempotent replay as well; an old still-valid token
cannot bypass the floor. No new grant table or token capability state is needed.
Replay returns the original commit; the floor never moves backward on rollback or deletion of
a transient model state. Validate the writer/lease and head CAS in the same
promotion transaction. The current old Java `requireHeadScope` and old TS
restore both reject a storage version other than 1; the new protocol must also
reject an old Harness against a new Java Store before it obtains a writer lease.
Reader/Store support for all Step 3 formats lands before any producer, even
when only one feature is advertised for execution. This uses an existing SQL
column, not a new table or a guessed Flyway reservation. Synchronize the actual
frozen contract revision on the landing base.

Writer acquire/renew replies advertise `supportedStorageVersion: 2`; missing support means 1 to the TS client. A new-format commit requires that acknowledgement and uses `/transactions:commit-v2`, which shares the new Store's atomic implementation. An old Store has no such endpoint and refuses the commit even if a prior acquire reached a new server. This closes the reverse mixed-deployment direction: older Stores otherwise accept arbitrary model-attempt payloads without promoting the head. Renewal refreshes the acknowledgement. Publication-token Worker submissions keep their own original admission protocol.

All new refs must be followed by TS/Java validation, snapshot/restore,
Hosted-layout verification, W1b bundle enumeration, W1c profile/layout checks
and retention readers before producer enablement. Keep the 64 KiB ordinary
inline resource and 8 MiB transaction limits; shared/missing/corrupt/foreign nested
refs must not pass a reference census. No physical GC or new storage backend
is enabled here.

## 8. Delivery order and dependencies

| Independent slice        | Deliverable and exit condition                                                                                                                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G3.3-A, B2               | Options/continuation readers first, producer and parked approval driver second. Requested → Allow/Deny/Cancel/expiry, lost replies and post-decision crashes finish the original native-file Turn or truthfully block; next Turn and close work once safe cleanup settles. |
| G3.3-B, model rounds     | Main request snapshots and reader floor, then model reissue/retraction for tool-enabled and no-tool Sessions. Original input is admitted once; prior tools execute once; model budget/history survive two replacements.                                                    |
| G3.3-C, terminal closure | Real process/cursor and cleanup fault gates around existing projection. Land bounded production fixes only if those gates expose gaps.                                                                                                                                     |

The C gates apply to A and B before either is accepted; C is not permission to
ship an earlier slice with known cursor or cleanup errors. A final C-only PR is
appropriate only for independent remaining coverage or a bounded proven fix.

All slices are separately reviewable and revertible before new-record producer
enablement. After new records exist, rollback must honor their reader floor;
source revert alone cannot make their old reader compatible.

Rebase each implementation onto actual landing main. [#13188][g1fix] owns
post-merge G1 state/cancellation/cleanup fixes; depend on its landed contracts
or explicitly reconcile the necessary overlap instead of copying the branch.
Do not require public Shell, H3 enablement or ordinary local M6 to start native
file/no-tool Step 3 work. H1/H2/H4 producer evidence is required only for the
corresponding recovery case. Broader Q2 binding fencing remains a separate gate
and keeps the overall Stage G tracker open.

## 9. Verification and acceptance

The implementation adds deterministic fixture barriers to the packaged-stack
runner. Use real Java/MySQL, Harness, Broker and Runtime operations; the model
fixture counts requests and tools and controls exact crash boundaries. A model
fixture is sufficient for orchestration proofs, not real-provider acceptance.
Run Harness-only replacement first, preserving Spring and its production
lease/timeouts; separately exercise replacement of both owners on Linux.

| Gate                                                                         | Required observations                                                                                                                                                                                           |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 requested approval → Allow / Deny                                         | Same Action/input/decision identity; Allow dispatches once, Deny dispatches zero times for that call; original Turn settles and a later Turn completes.                                                         |
| A2 Cancel / expiry / no browser                                              | Deadline is not reset; wait closes, one cancelled terminal and truthful paired records; `close 202` and next Turn succeed after ownership settles.                                                              |
| A3 mixed calls and rewritten inputs                                          | Earlier decisions persist; pending sibling IDs/order survive; reapproved inputs never inherit an earlier Allow; completed Hooks are not rerun.                                                                  |
| A4 decision/load responses lost                                              | Original response operation/key settles once; one driver, no new approval; replay does not duplicate effects.                                                                                                   |
| A5 crash after decision, wait advance, final plan, prepare and result commit | Each barrier resumes the correct stage. Final rewritten plan, original IDs and Runtime status evidence win over the initial approval descriptor.                                                                |
| A5a partial prepare / missing intent                                         | Reconcile native reservations under original IDs/digests; complete batch checkpoint precedes dispatch/G1. Conflicts block; no replacement IDs or duplicate file effects.                                        |
| A6 MCP/Hook/child uncertainty                                                | Missing or unknown producer evidence blocks; no external call is recreated and no Workspace lease is silently released.                                                                                         |
| B1 first round, with/without tools                                           | Exactly one original admission and user record; new inference attempt can complete; no-tool needs no Broker dispatch.                                                                                           |
| B2 streamed prefix and two replacements                                      | New attempt/stream identities; durable retraction before new deltas; live view, reload and replay expose only the surviving answer and one terminal.                                                            |
| B3 after earlier tools                                                       | Request uses saved results/history; each previous execution occurs once; round and cost budget do not reset.                                                                                                    |
| B3a Finished versus durable output                                           | Crash after stream Finished but before assistant commit can reissue from complete evidence; crash after assistant commit adds no inference. Never use the attempt state name as output durability proof.        |
| B4 committed assistant call output                                           | No model reissue over unpaid calls; drive saved approval/batch or existing Runtime recovery.                                                                                                                    |
| B5 snapshot faults, pin drift and cancellation                               | Missing/corrupt/oversized/foreign refs or config/authorization drift cause no new effects; store faults retry; cancellation prevents fresh dispatch.                                                            |
| B6 fallback / reactive compaction                                            | Changed normalized parameters get a new snapshot/attempt before send; equivalent retries reuse the snapshot. Saved-request reissue does not prepare or inject context again; logical-round budget is preserved. |
| C1 terminal committed, not delivered                                         | Boot/epoch changes with the consumed cursor unchanged; terminal replays once; zero inference/tool calls.                                                                                                        |
| C2 checkpoint payable, terminal missing                                      | Compensation succeeds exactly once through crash/lost reply; no invented result on corrupt evidence.                                                                                                            |
| C3 cleanup fails, then another crash                                         | Original cleanup identity remains discoverable and fenced; retry discharges it; completed Turn stays completed.                                                                                                 |
| C4 original admission response lost                                          | Original command/prompt is reconciled, not re-admitted; original admission watermark replays.                                                                                                                   |
| R1 frozen former writer / unsupported engine                                 | Former writer cannot append or dispatch; typed unsupported-engine refusal and no Legacy replay remain. This does not certify a surviving former Spring's binding fencing.                                       |
| R2 old/new readers and storage bundles                                       | v1/v2 and old model attempts stay readable with honest refusal; floor refuses incompatible acquire, renew, reads, writes and replay, including old tokens; bundle/restore reference closure passes.             |

For every physical/tool assertion, inspect actual files, SQL execution rows,
journal IDs and model fixture traffic. Removing the dispatch-count, cursor or
next-Turn assertion must fail its gate; an HTTP 200 or green unit test alone is
not acceptance. Keep initial failed fixture runs and report actual evidence
boundaries. Tests of local JSONL/H2 are additional coverage, not MySQL/Linux
physical-stop evidence.

### 9.1 Verified implementation evidence

The immutable `linux-delivery-gates-2` package passed Allow, Deny, Cancel, expiry and model continuation on the first attempt of each mode. The environment was Linux aarch64 with Node 22.22.1, Java 21.0.12.1 and MySQL 8.4.11. The actual Java control plane, Broker and Runtime Worker survived while only the Harness was replaced; inference used a controlled local OpenAI fixture.

Allow retained the original Action, prepare key, request digest and Runtime binding, produced one settled execution with dispatch generation 1, and wrote the expected file bytes. Deny, Cancel and expiry produced no execution and no file; expiry retained the original deadline. Continuation retained the original execution, reissued the same normalized provider request body and removed the previously visible partial output. Every mode confirmed original-owner cleanup, completed a subsequent Turn, observed exactly two total terminals for those two Turns, then completed close admission 202 and reached closed Session status.

Focused verification passed 840 core tests, 111 shared-contract tests, 650 CLI tests and 189 relevant Java tests. Build, typecheck, bundle, source ESLint and Java Checkstyle passed. Source lint excludes generated Maven `target` and test `coverage` artifacts. An earlier broad Java run exposed three fixture/route-registry failures; their corrected suites passed in the 189-test run. The entire broad Java suite was not rerun after those corrections.

The machine-readable reports, manifests and retained failed diagnostics are under `.qwen/investigations/g3-step3-implementation/`; the current consolidated report is `packaged-verification.md`. These five packaged gates do not prove the whole matrix above. First no-tool request crash, double replacement, partial-prepare crash, response loss, malformed/foreign refs, snapshot overflow and cleanup crash have focused or fault-probe coverage only, or remain broader packaged acceptance work. Full-owner restart, real-provider acceptance, a real mixed-version cluster and Q2 former-control-plane fencing remain separate.

## 10. Implementation surface

| Area                         | Expected paths / responsibilities                                                                                                                                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI orchestration            | `hosted-harness-session.ts`, `hosted-runtime-recovery.ts`: registered parked driver, model recovery entry, cancel/expiry dispatch, projection reuse and original ownership.                                                                                                                                         |
| Approval / native tools      | `hosted-tool-approval.ts`, `hosted-workspace-tool-turn.ts`: options v3, continuation producer/reader, exact batch resume and no Hook/argument replay.                                                                                                                                                               |
| Model and streaming          | `hosted-harness-model.ts`, `hosted-text-deltas.ts`, core `core/llm-chat.ts` and its call-options types: prepared-request callback, saved-request continuation and journal-seeded retraction.                                                                                                                        |
| Core journal                 | `managed-hook-activation.ts`, `managed-session-records.ts`, shared schema/fixtures and `http-managed-session-store.ts`: optional main-attempt recovery ref, final batch plans, bounded retraction, turn-cleanup records, recursive reference closure and per-request version ceiling; keep checkpoint v1 unchanged. |
| Java control plane/store     | `ManagedActionStore`, Session-store validation/reference readers, `QwenHostedHarnessConnector`, `HarnessCoordinator`: v3 projection, reader floor and plain-attach/cursor contract; `ActionResponseCoordinator` retains decision-operation semantics.                                                               |
| Other readers / producers    | Hosted layout/W1b/W1c readers; Hook, MCP, child and file-history adapters only where their continuation evidence is supported. Audit every declared field's producer and every read site.                                                                                                                           |
| Verification / documentation | Collocated tests, packaged E2E runner/CI, paired designs and developer event schema. No public contract promotion or deployment enablement without its own acceptance.                                                                                                                                              |

## 11. Decisions and remaining implementation questions

Decisions: finish B2 before widening model recovery; preserve requested Actions
across restart; Allow/Deny drive the saved batch; Cancel/expiry settle safely;
reissue only a durable main-model request; use plain attachments and the
existing journal feed; retain checkpoint v1 and existing Runtime recovery;
do not close the Stage G tracker on this functional work alone.

Before a slice emits its new records, the implementation must test the
persisted storage-version floor and complete nested-ref readers. Before
claiming a producer supported, prove its saved inputs, completed occurrences,
original owner and stop/settlement evidence. These are implementation gates,
not permission to fill missing evidence from the current environment. Real
provider acceptance, multi-instance binding fencing, public Shell enablement,
cross-host stop/ownership proof and production event pruning remain separate.

## 12. References

- [Stage G tracker #12952][g] and [architecture proposal #12380][proposal].
- [Merged G3 Steps 1–2 #13174][g3] and [explicit B2 follow-up decision][b2].
- [G3 Steps 1–2 design](2026-10-02-hosted-replaceable-harness.md).
- [Actions design](2026-09-30-managed-agent-actions.md).
- [Hosted Hooks design](2026-09-30-managed-hooks-runtime.md).
- [Delivery ledger](managed-agent-delivery-ledger.md).
- [G1 post-merge fixes #13188][g1fix].

[g]: https://github.com/QwenLM/qwen-code/issues/12952
[proposal]: https://github.com/QwenLM/qwen-code/issues/12380
[g3]: https://github.com/QwenLM/qwen-code/pull/13174
[b2]: https://github.com/QwenLM/qwen-code/pull/13174#issuecomment-6030365600
[g1fix]: https://github.com/QwenLM/qwen-code/pull/13188
