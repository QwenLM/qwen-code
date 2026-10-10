# Managed Session messages and child continuations (H4d-a)

[English](2026-10-09-managed-session-messages.md) | [简体中文](2026-10-09-managed-session-messages.zh-CN.md)

Status: implemented in this change. Landed: the `managed-session_message` record body, registered and validated in TypeScript and Java but not enabled for submission, and the continuation rules for `child_run` (`continueChildRun`), checked in both languages and gated off for submission. Still design: the runtime that sends, relays, delivers and consumes messages and revives completed children (H4d-b, Follow-up work). This is the record-contract half of slice **H4d** of [#12827](https://github.com/QwenLM/qwen-code/issues/12827), stage H of the Managed Agent proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380), tracked by [#13744](https://github.com/QwenLM/qwen-code/issues/13744). It follows H4a ([record contract](2026-10-06-managed-child-agent-runtime.md), #13505), H4b ([child Session runtime](2026-10-07-managed-child-session-runtime.md), #13550) and H4c ([workflow kind](2026-10-09-managed-workflow-child-kind.md), #13754). Below, "the automation design" is sections 5 and 5.1 of the [automation, Channels and child delivery design](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-automation.md) at the commit that #12827 pins.

## Problem and scope

H4b made a child's result durable and its acceptance observable, but the communication stays one-directional and terminal: the parent launches, the child runs, and the child's result is copied back and accepted. A parent cannot add information to a running child, a child cannot ask its parent anything, and a completed child cannot be continued. H4b stopped there on purpose. Its decision 12 names `continueChildRun` as having "no honest v1 producer" whose real producers are H4d's peer-message and revive paths. The H4a delivery map gives H4d "the `session_message` body and durable `send_message` routing without a team", with the exit "durable delivery, per-recipient accepted and consumed, across restart and reconnect".

Issue #13744 asked for three deliverables. The maintainer settled the scope on 2026-10-09. The narrowing of D1 and the move of D3 follow the triage on the issue. Splitting D2 and leaving `queryChildRun` unbuilt, which the triage left open, are the maintainer's call, recorded here:

- **D1 (operations) is narrowed to `continueChildRun`.** `queryChildRun` is not built as an operation. H4b decision 12 stands: a query needs no journal write, and the relay and the tool turn already read the committed records or their SQL projection (decision 12 below).
- **D2 (durable delivery) is split.** This change lands the record half: every fact the delivery needs is a committed record with commit-time rules in both languages. The runtime half is H4d-b: the managed `send_message` tool, the message relay, the delivery boundary, consumption and revive.
- **D3 (mailbox) moves to H4e** ([#13745](https://github.com/QwenLM/qwen-code/issues/13745)). The mailbox is the team construct (Legacy `agents/team/mailbox.ts`, durable `team_message`). H4d's routing is the no-team routing.

This follows the H4a → H4b, H5a → H5b/H5c and H6a cadence: the record contract lands first, validated ahead of any writer, and enablement ships with the producers.

## Current state

The facts below are from `main` at `f20ed558e3`.

- **Domain.** `session_message` is in the closed v1 domain index (`MANAGED_SESSION_DOMAINS`) and in Java's `ManagedExtensionRecords.DOMAINS`. It has no body in either language, no store rule, no task kind and no enablement. The only fixture that names it is an operation-grant case in `managed-extension-record-v1.fixtures.json`.
- **Continuations.** The `child_agent` and `workflow` bodies carry `predecessorChildRunId` (fixed, set at launch), but no rule reads it beyond the id shape. A launch naming any predecessor, even a missing one, would commit in either language. `childLaunchBody` always writes `null`. No continuation producer exists.
- **Operations.** `continueChildRun`, `queryChildRun` and `mailbox` occur nowhere in `packages/core/src/managed-runtime`, `packages/cli/src/serve` or `managed-agent-server/src/main`.
- **Lineage.** The parent's journal names each child through its `child_run` record (`childRunId`, then `childSessionId` from attach). A child's journal holds no lineage. The child's ancestry lives only in Java, in the V54 columns `parent_session_id` and `parent_child_run_id` of `managed_agent_session`, written at creation and never changed. The TypeScript Hosted Session also persists it in its definition, but the authority does not read it.
- **Inputs.** `commitExtensionRecord` can commit one input with its authority-generated wake in the same transaction as one record revision. H4b's `"sent"` acceptance uses this. The Java store sees the whole transaction (`apply` walks every event line), so it can check an input against the record it travels with.
- **Legacy.** `send_message` routes to a background `task_id` (an in-memory queue, drained at tool-round boundaries; a paused or completed agent is resumed or revived), to a teammate, or to a named peer Session over a socket. None of these paths is durable, and the Hosted profile declares no `send_message`.

## Decisions

1. **One domain, two directions, two journals.** A message is committed twice, once in each Session's journal, each time by that journal's own single writer (H0c: no second write path). The sender's record (`direction: "outbound"`) is the durable outbox entry. The target's record (`direction: "inbound"`) is the receipt. Both chains are keyed by the same `messageId`, each in its own journal. A journal holds its own outbox entries and the receipts from its children in one key space, so `messageId` must be unique across Sessions: the sender mints it, for example as a UUID. `managed-session_message` is schema version 1 and has one closed key set for both directions, with direction-specific rules.
2. **Routes follow the lineage in v1.** `route` is `to_child` (parent to child) or `to_parent` (child to parent). `childRunId` names the lineage edge: the child run in the parent's journal. Named peers outside the lineage need an authorization proof (the automation design's `routeProofRef`), which has no designed producer. They are not representable in v1, and a later route value can add them additively.
3. **The send is a settled act, and only its delivery moves.** Nothing executes when a message is sent. The act is complete once the content is committed. The outbound run is purely logical apart from `executionCallId`, the sending tool call, and it opens `settled` with delivery `planned`. The generic opening rule (reserved or admitted) cannot express that, for the same reason it could not express H4a's acceptance (H4a decision 9). Afterwards only the session delivery line moves, one shared step at a time:
   - `planned → accepting → accepted → consumed`
   - `planned → cancelled`: never handed over
   - `accepting → unknown | rejected`
   - `unknown → accepted | rejected`
4. **The target is fixed at handover, so a message to an unstarted child is held.** `targetSessionId` is set once and is required from `accepting` on: the real target is fixed when the message is claimed, not at send time. A message to a child whose Session does not exist yet stays `planned` until the child attaches. It is neither refused nor lost. This is D3's exit rule, "held or refused by an explicit rule", in the form H4d owns. The other way round is held too: the parent refuses a message from a child whose run has not attached yet with its own message ("arrives only once its run attached"), so a relay holds it and never takes it for a forgery.
5. **The sender names the input that carries its message.** An outbound record carries `inputId` exactly when its delivery is `accepted` or `consumed`, and the id is set once. It names the input in the target's journal that carries the message. Per-recipient accepted and consumed are therefore visible on both sides, and each fact names the evidence it stands on.
6. **The receipt opens accepted, in the same transaction as its input.** The inbound record follows H4a decision 9: it opens `settled` with delivery `accepted`, and its only later step is `consumed`. Its opening revision must commit together with exactly the input its `inputId` names, plus that input's generated wake. No other `session_message` revision may carry an input. This gives four guarantees:
   - "Accepted" and "input committed" are one atomic fact, so a crash leaves both or neither.
   - A redelivery under the same `messageId` finds the chain and can open nothing again. It cannot create a second input, so the message is recovered exactly once.
   - A second message has a new `messageId`, so a redelivery is distinguishable from a second message.
   - Nothing merges two messages under one id. Every other attempt to open a taken `messageId` is refused before anything publishes: by the input's own event id or by the input rule when it brings an input, and by the fixed-key rule when it changes the message. A relay therefore recognizes a redelivery by replaying its opening command, not by reading a refusal: the same command for the same message answers with the committed receipt, and the same command with other content answers as a conflict.
7. **Content is bounded and digest-bound.** `contentRef` is a durable reference to the holding Session's own copy, at most 64 KiB (65536 bytes), within the parent's durable inline bound. The bound is in bytes, while Legacy `send_message` caps 65536 characters, so a producer bounds the bytes before it commits. The input that carries a message in the target is a bounded notification, exactly as H4b's `"sent"` acceptance input is (H4b decision 5): escaped, then truncated with a marker within the inline bound of the input and of its wake turn's message. The full content is the receipt's `contentRef`, which the digest binds. `contentDigest` must equal `contentRef.digest`. The inbound copy therefore binds to the outbound original by digest, as H4a decision 6 binds result copies.
8. **Commit-time rules check what each journal can prove.** The authority checks what its journal holds, and the Java store additionally checks the lineage that only it holds:

   | Rule                                                                                                                               | TypeScript authority | Java store |
   | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------- |
   | An outbound record is sent by this Session; an inbound record is addressed to it                                                   | yes                  | yes        |
   | `to_child` outbound names a child Session run of this Session that has not ended when the message opens                            | yes                  | yes        |
   | `to_child` outbound targets exactly the Session its child run attached                                                             | yes                  | yes        |
   | `to_parent` inbound names a child Session run of this Session and comes from the Session that run attached; the run may have ended | yes                  | yes        |
   | `to_parent` outbound and `to_child` inbound follow this Session's own lineage (`parent_child_run_id`, `parent_session_id`)         | no lineage held      | yes        |
   | The inbound opening carries exactly its input; no other revision carries one                                                       | at commit            | yes        |

   Only the store can refuse a lineage violation, so it answers with its own code, `session_message_lineage_refused` (409). The HTTP Session store maps it to a rollbackable non-commit, as it maps H4b's `child_run_lineage_minted`: the authority could not refuse the record first, and the child's log stays writable instead of latching a write failure.

   An inbound `to_parent` message may name a run that has already ended, because a message sent before the child ended can arrive after. An outbound `to_child` message may not name an ended run. A completed child is continued instead (decision 9), and a failed or cancelled child is never continued: the reference design's honest recovery after a failure is a new independent run.

9. **`continueChildRun` is a continuation launch.** A continuation is a `child_run` of a child Session kind whose `predecessorChildRunId` is set. It has a new `childRunId`, `resultVersion` 1 (H4a decision 7) and its own launch input. Its opening revision must satisfy all of these:
   - The predecessor is a child run of this Session, of the same kind.
   - The predecessor ended `settled` with stop reason `completed`, so its result was committed, and no stop was requested of it: a run the parent or the user asked to stop is never revived.
   - The continuation keeps the predecessor's `ownerScopeId`, `rootSessionId`, `depth`, `workspaceMode` and `workingDirectory`, and pins the predecessor's definition from its opening revision.
   - No other run continues the same predecessor. The chain is linear: a second message to a completed child goes to the continuation, never to a fork of the predecessor. A continuation whose execution is proven never to have started (`not_started_proven`: a failed creation, a refused quota, a cancel before the start) left the predecessor untouched, so it releases the predecessor for the next continuation.

   The builder `childContinuationBody` derives exactly these fields, the kind included. Completion is free: a continuation started by `send_message` would usually be `"sent"`. A continuation is a launch, so it counts toward H4b's active cap and H4c's budget like any other, and its producer owes the same launch admission (closing, quotas) before it commits, because neither the authority nor the store checks the quotas at commit.

10. **Both capabilities stay disabled.**
    - `session_message` stays out of `MANAGED_SESSION_ENABLED_DOMAINS`.
    - Continuations get their own gate, `MANAGED_SESSION_CHILD_CONTINUATIONS_ENABLED = false`, checked by the authority's commit path. A plain kind check would not be enough, because `child_agent` is enabled. Without the gate, H4b's relay would run a committed continuation as a fresh child with no history, and the parent would mistake that run for a continuation. The gate refuses submission and never a reader.
    - The Java store validates both ahead of any writer, in the server-first order of H1 through H4c. Java's lifecycle gate keeps `session_message` off the list of domains a Session under a close or delete claim may commit. Whether the outbox's cancellations must commit during close is H4d-b's to decide (open question 3).
11. **No task projection.** A message is not a task. `session_message` registers with a null task kind, and its Java rows carry null task columns, as `child_acceptance` rows do.
12. **`queryChildRun` is not built.** H4b decision 12 stands. The child state a sender needs (running, completed, ended) is the committed `child_run` record, which the authority already reads, or its SQL projection on the Java side. "Never fabricate a result the child did not commit" holds by construction: a result flows only through `commitChildResult`, and a continuation requires its predecessor's committed result.

## Records

### `managed-session_message`

Schema version 1. The chain is keyed by `messageId`. All keys are required; a nullable key holds `null`.

| Key               | Rule                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `direction`       | `"outbound"` (the sender's outbox entry) or `"inbound"` (the target's receipt)                                                                    |
| `messageId`       | id: the message, minted by the sender; the same id keys both records                                                                              |
| `route`           | `"to_child"` or `"to_parent"`                                                                                                                     |
| `childRunId`      | id: the lineage edge, the child run in the parent's journal                                                                                       |
| `senderSessionId` | id: the sending Session                                                                                                                           |
| `targetSessionId` | null or id, never the sender. Outbound: set once, required once the delivery is past `planned` except at `cancelled`. Inbound: required           |
| `contentRef`      | durable ref to the holding Session's copy of the message, at most 65536 bytes                                                                     |
| `contentDigest`   | digest: must equal `contentRef.digest`                                                                                                            |
| `inputId`         | null or id: the input that carries the message in the target. Outbound: set once, present exactly at `accepted` and `consumed`. Inbound: required |
| `run`             | the run block: settled and purely logical, with a `session` delivery. Outbound names its sending call in `executionCallId`; inbound names none    |

- **Fixed keys.** `direction`, `messageId`, `route`, `childRunId`, `senderSessionId`, `contentRef` and `contentDigest` never change. `targetSessionId` and `inputId` are set once.
- **Opening.** An outbound record opens at delivery `planned` (with no `inputId`). An inbound record opens at `accepted`.
- **Successors.** The run follows the shared successor rule, which for an ended run moves only the delivery. An inbound record moves only from `accepted` to `consumed`.

### Continuations of `managed-child_run`

No key changes. Decision 9's rules are commit-time checks in the authority and the Java store, not body grammar, so no shared fixture carries them. This mirrors how H4b pinned its reverse acceptance check.

## Non-goals

- **The runtime (H4d-b):** the managed `send_message` tool admission and its routing choice (a running child gets a message, a completed child gets a continuation); the message relay in `managed-agent-server`; the notification input source and its wake pump; the consumption commits; the revive of a continuation with its predecessor's history; and enablement.
- **`queryChildRun`** (decision 12), **the team mailbox** (H4e), **named peers outside the lineage** (decision 2), and **mid-turn delivery**.
- **Any public contract change.** The OpenAPI contract, routes and Flyway migrations stay as they are; `contract-known-gaps.txt` does not move.

## Files affected

- `packages/core/src/managed-runtime/managed-session-message-record.ts` (new): the body, its start and successor rules.
- `packages/core/src/managed-runtime/contracts/managed-session-message-record-v1.fixtures.json` (new): the shared cases. `managed-extension-projection-v1.fixtures.json` gains `session_message → null`.
- `packages/core/src/managed-runtime/managed-extension-projection.ts`: the body registration.
- `packages/core/src/managed-runtime/managed-session-authority.ts`: resource closure, the cross-record rules of decision 8, the input binding, the continuation rules and gate, and the continuation index.
- `packages/core/src/managed-runtime/managed-session-records.ts`: the continuation gate.
- `packages/core/src/managed-runtime/managed-child-operations.ts`: `childContinuationBody`.
- `packages/core/src/managed-runtime/http-managed-session-store.ts`: `session_message_lineage_refused` is a rollbackable non-commit.
- `packages/sdk-java/managed-agent-server`:
  - `ManagedSessionMessageRecords` (new): the validator.
  - `ManagedExtensionProjection`: the body registration.
  - `ManagedExtensionRecordStore`: closure, the cross-record and lineage rules, the transaction's input binding, and the continuation rules.
- Tests beside each file in both languages: the TypeScript fixture replay, `managed-session-authority.session-message.test.ts`, the operation test, `ManagedSessionMessageRecordContractTest` and `ManagedSessionMessageStoreTest` (which reuses the store suite's child-run helpers; the test journal gains a request that bundles an input and its wake).
- This design in both languages, plus a pointer from the H4a and H4b designs.

## Validation

- **Fixture parity.** The shared cases and successors replay in both languages, and every invalid case names the clause both validators must report.
- **Authority.** The suite lifts the two gates to plant records, except where it tests the gates themselves:
  - The real gate refuses a `session_message` commit and a continuation, and nothing publishes.
  - A parent's outbound chain runs from `planned` through `consumed` against a live, then attached, child run.
  - A child's message arrives as an inbound chain in the parent, together with its input, and the input's wake is generated.
  - Every rule of decision 8 that the authority owns refuses its violation with the named message.
  - A redelivery opens nothing and adds no input.
  - A reopened log rebuilds every chain.
  - A continuation commits after a completed predecessor and is refused for a missing, failed, unfinished, stop-requested, re-scoped or already-continued predecessor; a continuation that never started releases its predecessor, one that started does not.
  - The HTTP Session store treats the lineage refusal as a rollbackable non-commit, and the log stays writable.
- **Java store.** The same chains commit over H2 in MySQL mode. The lineage rules refuse, with their own code, a message that does not follow `managed_agent_session`'s lineage. The transaction-level input binding refuses an inbound opening without its input or with a second one, even a second one under the same id, and refuses any other revision that carries one. The continuation rules match TypeScript. A `session_message` row projects no task.
- **Mutation checks.** Each new guard is disabled in turn, and its witness goes red in its own language.

## Acceptance criteria

- TypeScript and Java accept and refuse identical `session_message` records and successors from the shared fixtures, and every existing contract corpus replays unchanged.
- `session_message` stays off the enabled list, and a continuation is refused with "registered but not enabled" while its gate is off. Both refusals happen before anything publishes.
- In both languages, every cross-record rule of decision 8 and every continuation rule of decision 9 refuses its violation, and a lawful chain commits and rebuilds.
- No public API or migration changes, and every existing H1–H4c suite stays green.

## Open questions

1. **How a continuation keeps its history.** This contract assumes that every run of a chain has its own child Session and lineage edge, so H4d-b seeds the continuation's new child Session from the predecessor's transcript (`history_copy`). Keeping the completed child Session open for the continuation instead would need a contract change: its lineage edge (`parent_child_run_id`) still names the predecessor, so the child-side lineage rule of decision 8 would refuse every message of the continuation.
2. **The delivery boundary at a busy target.** The Hosted wake pump queues an input until the Session is idle. The Legacy path is moving toward tool-round delivery behind an opt-in (#13428). A managed message must survive reclamation, so H4d-b chooses its boundary over committed inputs only.
3. **The outbox at sender close.** Undelivered outbound messages could be cancelled during close, which needs the lifecycle gate to admit them, or left `planned` and classified by the relay.
4. **Named peers.** Peers outside the lineage need an authorization proof and their own route value.
5. **What the relay must prove beyond the records.** Three bindings are the producer's, not the contract's: the input's text against the receipt's `contentDigest` (the input is the relay's bounded wrapper, so it binds the content's prefix, not all of it), an inbound receipt against the sender's outbound record in the other journal, and whether a child may still open a message after its own run ended, which the parent's receipt admits for messages in flight.

## Follow-up work

| Slice | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H4d-b | Done in the [H4d-b design](2026-10-10-managed-session-message-runtime.md), which also answers open questions 1–3 and 5. The managed `send_message` tool (routing: a running child gets a message, a completed child gets a continuation, an ended child gets a named refusal); the Java message relay (claim, target resolution, inbound receipt with its input and wake, sender advances, crash recovery); consumption; revive; enablement. Also owed there: H4b's relay settles a child from its latest API Turn and then closes it, which would strand a message queued behind that Turn, so its completion criterion must account for undelivered and unconsumed messages; the Hosted recovery domain allowlist must admit `session_message`; a continuation runs the launch admission; and `send_message` bounds a message by the smaller of its two carriers (the 64 KiB content bound and the 32 KiB launch envelope of a continuation), so whether the child has completed never changes the answer. |
| H4e   | Teams and the mailbox ([#13745](https://github.com/QwenLM/qwen-code/issues/13745)); the record contract is the [H4e-a design](2026-10-10-managed-agent-teams.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
