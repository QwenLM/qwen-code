# Managed session message runtime (H4d-b)

[English](2026-10-10-managed-session-message-runtime.md) | [简体中文](2026-10-10-managed-session-message-runtime.zh-CN.md)

Status: implemented in this change. This is the runtime half of slice **H4d** of [#12827](https://github.com/QwenLM/qwen-code/issues/12827), stage H of the Managed Agent proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380), tracked by [#13744](https://github.com/QwenLM/qwen-code/issues/13744). It produces the records the [H4d-a contract](2026-10-09-managed-session-messages.md) pinned: the managed `send_message` tool, the control plane's message relay, the delivery boundary, consumption, revive of completed children, and enablement. It amends H4b's [child Session runtime](2026-10-07-managed-child-session-runtime.md) where a message changes when a child is finished. Below, "the contract" is the H4d-a design and "the automation design" is section 5.1 of the [automation, Channels and child delivery design](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-automation.md) at the commit #12827 pins.

## Problem and scope

H4d-a made every fact a delivery needs a committed record, with commit-time rules in both languages, and left both capabilities disabled because nothing produced them. This slice is the producers:

- **The managed `send_message` tool** on the Hosted Shell lanes: a parent messages the child tasks it launched (`task_id`), a child messages its parent (`to: "parent"`). A running child gets a message, a completed child gets a continuation, and any other ending gets a named refusal (contract follow-up row).
- **The message relay** in `managed-agent-server`: claim, target resolution, the receipt with its input and wake, the sender's advances, and crash recovery.
- **Consumption** of a receipt once the turn that read it settles, and the sender's matching last step.
- **Revive**: a continuation starts a new child Session that carries its chain's history.
- **The obligations the contract named for this slice**: H4b's completion rule must account for undelivered and unconsumed messages, the Hosted recovery allowlist must admit `session_message`, a continuation runs the launch admission, and one send bound applies whether the child has completed or not.
- **Enablement** of `session_message` and continuations.

## Current state

The facts below are from `main` at `ba8615f4c4`.

- **Records.** `managed-session_message` is registered and validated in TypeScript and Java and stays out of `MANAGED_SESSION_ENABLED_DOMAINS`; `MANAGED_SESSION_CHILD_CONTINUATIONS_ENABLED` is `false`. `childContinuationBody` exists; nothing calls it.
- **Hosted turn.** The private Hosted profiles declare no `send_message`; an undeclared tool is refused at admission. The Agent tool exists on the Shell lanes (`hosted-workspace-shell/1..2`) behind the `child_agent` kind gate.
- **Wake pump.** Notification inputs (`monitor`, `automation`, `child_agent`, `channel`) run as wake turns while the Session is idle; a wake turn is Hosted-internal and never becomes an API Turn (`managed_agent_turn`), so its output appears only in the Session's own journal.
- **H4b relay.** `ChildResultRelay` settles a child from its latest API Turn and then closes it. A message delivered behind that Turn would run after the settlement and be lost, and the child's close would race it.
- **Recovery.** `verifyWorkspaceRestore` refuses a journal holding a `domain.committed` of a domain outside its allowlist, which has no `session_message`.
- **Java.** No worker reads `session_message` rows; the V54 `(domain, delivery_state)` index exists. Flyway stands at V60.

## Decisions

1. **One tool, two forms, along the lineage.** `send_message` has a parent form (`task_id`, `message`) and a child form (`to: "parent"`, `message`). A Session advertises the parent form where it may launch children (the root of a Shell lane, behind the `child_agent` kind gate) and the child form where its definition records a lineage. Both sit behind the `session_message` domain gate. Team recipients belong to H4e and named peers to a later route (contract decision 2); their arguments are refused with a named scope. The tool needs no Runtime: a message-only batch takes no Workspace mount and no Broker reservation, exactly like an Agent launch.
2. **The parent's routing is decided on its child funnel's writes chain.** A `task_id` names a child run of any generation; the route follows its chain to the head, the newest continuation that did not prove it never started (contract decision 9 releases such a predecessor). A head that has not ended takes a message; a head that ended `completed` with no stop requested is continued; a stop-requested or otherwise ended head is refused by name. The decision and its commit run on the same writes chain as H4b's settlement, so a message either opens before the run settles (and then holds the settlement, decision 8) or finds the run ended and becomes a continuation. A re-driven call replays its committed message or continuation, compared by evidence, and never routes twice.
3. **One send bound for both routes.** A message to a task must fit the continuation's launch envelope built from that task's own launch description and definition (≤ 32 KiB, H4b's envelope bound), whether the head is running or completed. The envelope depends on nothing later, so the child's state never changes the answer. A child's message to its parent is bounded by the 64 KiB content bound. A refusal is a tool error, and nothing commits.
4. **Identities are minted by the sender and replay-stable.** `messageId` is `msg_` plus 32 hex characters of `sha256(senderSessionId | turnId | callId)`: unique across Sessions (contract decision 1) and the same for a re-driven call. A continuation's `childRunId` is the call key an Agent launch would use. The input and wake turn that carry a message in its target are `<messageId>:message`.
5. **The message relay lives in `managed-agent-server`, leashed by its own ledger.** `SessionMessageRelay` scans `session_message` rows at `planned`, `accepting` or `unknown` (only outbox entries reach those states, so the V54 index serves the scan) and `accepted` rows whose ledger row is `delivered`. V61 adds `qwen_managed_session_message_relay`: one row per claimed outbox entry, with the claim lease, the backoff and the durable classifications. Each step reconciles from both journals' committed records:
   - **Handover.** The target is fixed now (contract decision 4): for `to_child` the Session the run attached, held while the run has not attached; for `to_parent` the parent the sender's lineage row records. A run that ended before the handover, or a target that is no longer active, cancels the entry (`planned → cancelled`, never handed over). Otherwise the sender commits `planned → accepting` with the target.
   - **Receipt.** The relay copies the sender's content bytes to the target, which publishes its own copy, checks it against the sender's digest, and commits the receipt with its input and wake in one transaction (contract decision 6). A redelivery replays the committed receipt. A parent answers a child's message before that run attached with `session_message_not_ready`, and the relay holds it. A refusal by the target's rules (`session_message_record` or `session_message_conflict`) rejects the entry (`accepting → rejected`). A receipt already committed skips straight to the sender's step.
   - **Acceptance and consumption.** The sender commits `accepting → accepted` with the input's id; then, once the target's receipt is `consumed`, `accepted → consumed`.
   - **Classifications.** A sender that is closing or gone before its entry was accepted gets nothing more and the row is `orphaned`; a step that fails 64 times is `unknown`. Neither is ever presented as delivered. An entry already accepted is `done` when either side closes before the consumption: the sender's entry stays `accepted`, and the target's receipt is the consumption truth. H4b closes a child right after its settlement, so a child's message to its parent usually ends this way.
6. **The delivery boundary is the target's wake pump, over committed inputs only (contract open question 2).** A message waits for the target's current turn to end and runs as its own wake turn, with the bounded notification text of contract decision 7. Its input is in the journal, so it survives reclamation of the Runtime and replacement of the Harness. Mid-turn delivery stays a non-goal.
7. **Consumption follows the wake turn's real settle.** When a message's wake turn settles `completed`, the target commits its receipt `accepted → consumed`. A turn that ended otherwise leaves the receipt `accepted`: owed evidence, never widened (H4b decision 6). A Session that closes cancels its pending message inputs as it cancels its other wake inputs.
8. **A child is finished only once its messages are (amends H4b decision 8).** The relay settles a child only when its latest API Turn is terminal, no message on its edge still owes its handover (the parent's to this run and every one the child sent; a message the message relay gave up on or orphaned no longer holds anything), and the child's journal holds no accepted input without its settled turn. The child's result is its newest settled turn: a message's wake turn when it ran last, read from the child's own journal (the newest assistant record of that turn, chunked bodies joined as bytes), otherwise H4b's API Turn result unchanged. A compacted journal cannot prove its turns and is refused, never guessed. The parent backs this up at its seam: `commit_result` is refused with `409 child_messages_pending` while a message to the run owes its handover, and the relay watches again without spending an attempt. A failure settlement is never held: the relay cancels what it still holds for an ended run.
9. **Revive starts a new child Session that carries its chain's history (contract open question 1).** A continuation is a new chain link with its own child Session and lineage edge, so the contract's lineage rules hold. Its first input is composed by the relay from the parent's committed records: each earlier run's instruction (launch envelope prompt) and result (the parent's result copy), oldest first, then the new instruction. The composition is bounded below the Hosted prompt bound (48 KiB of JSON text) by leaving the oldest runs out; when the newest earlier run alone does not fit, its texts are cut with a marker. It reads only committed records, so a replayed creation names the same input and the creation stays idempotent. This carries the conversation the parent saw, not the child's tool history: a transcript import (`history_copy` with a restore proof) needs a header-level import the authority does not support yet, and is follow-up work.
10. **The outbox at sender close stays as committed (contract open question 3).** The lifecycle gate keeps refusing `session_message` under a close claim; the relay classifies a closing sender's entries `orphaned`. Nothing cancels them in-journal, and nothing delivers them.
11. **What the relay proves beyond the records (contract open question 5).** The input's text binds the target's own copy, whose digest the target checks against the sender's before it commits; the receipt names the sender's message by `messageId` and digest; a parent admits a child's message for a run that has since ended, so a message sent before the end still arrives.
12. **Approval and preview.** `send_message` asks for approval in the modes that ask for the Agent tool, and joins the closed input-preview set in both languages (`HOSTED_INPUT_PREVIEW_TOOLS`, Java `PREVIEW_TOOLS`), so the card shows the message being approved.
13. **Enablement, server first.** `session_message` joins `MANAGED_SESSION_ENABLED_DOMAINS` and the continuation gate opens. The Java store has validated both since the H4d-a release, and the relay ships in the same release as the writers, so the server-first order of H1–H4c holds: a server that does not run the relay never sees a writer that produces these records.
14. **No public contract change.** The OpenAPI contract, its routes and `contract-known-gaps.txt` do not move. The new Hosted route `POST /session/:id/messages/operations` is private between the control plane and `qwen serve`, like H4b's `/children/operations`. V61 is the only migration.

## The pipeline

A parent's message to a running child:

| Step | Journal | Commit                                                          | By                |
| ---- | ------- | --------------------------------------------------------------- | ----------------- |
| 1    | parent  | outbound `planned`, target unset                                | `send_message`    |
| 2    | parent  | outbound `accepting`, target = the run's attached child         | relay (handover)  |
| 3    | child   | inbound `accepted` + input + wake                               | relay (receive)   |
| 4    | parent  | outbound `accepted`, `inputId`                                  | relay             |
| 5    | child   | wake turn runs and settles; inbound `consumed`                  | child's wake pump |
| 6    | parent  | outbound `consumed`                                             | relay             |
| 7    | parent  | the child run settles from the child's newest turn (decision 8) | H4b relay         |

A child's message to its parent runs the same steps with the journals swapped; its step 2 takes the target from the child's lineage, and the parent's step 3 waits until the run attached. A message to a completed child is a continuation launch instead: step 1 commits a `child_run` that names its predecessor, and H4b's pipeline runs it with the composed first input of decision 9.

## Bounds

| Bound                         | Value                                             | Refusal                                   |
| ----------------------------- | ------------------------------------------------- | ----------------------------------------- |
| Message to a child task       | fits the task's continuation envelope (≤ 32 KiB)  | tool error, `byte_limit`                  |
| Message to the parent         | ≤ 64 KiB of UTF-8                                 | tool error                                |
| Carrying notification         | ≤ 48 KiB serialized, escaped then cut with marker | truncation, never refusal                 |
| Continuation first input      | ≤ 48 KiB of JSON text; oldest runs left out       | truncation, never refusal                 |
| Relay attempts per message    | 64, with backoff                                  | ledger `unknown`, never a second delivery |
| Continuation launch admission | H4b/H4c: closing, active cap 4, launch budget 64  | tool error naming the reason              |

## Non-goals

- Team recipients and the mailbox (H4e, [#13745](https://github.com/QwenLM/qwen-code/issues/13745)), named peers outside the lineage (contract decision 2), and mid-turn delivery.
- A transcript import for continuations (decision 9).
- `queryChildRun`, which the contract leaves unbuilt.
- Any public contract change, and any change to the Legacy `send_message`.

## Files affected

- `packages/core/src/managed-runtime/managed-session-message-operations.ts` (new): the message ids and every revision body.
- `packages/core/src/managed-runtime/managed-session-records.ts`: enablement of `session_message` and continuations.
- `packages/cli/src/serve/hosted-child-agent-session.ts`: the parent's routing (`sendToChild`), the chain head, the settlement hold, the shared bounded notification builder.
- `packages/cli/src/serve/hosted-session-message-session.ts` (new): the child's send, the relay's sender and target verbs, consumption, the notification text.
- `packages/cli/src/serve/hosted-workspace-tool-turn.ts`: the two `send_message` declarations, their admission and execution.
- `packages/cli/src/serve/hosted-harness-session.ts`: the funnel wiring, the wake source, consumption after the wake turn, close-time settlement, the recovery allowlist, and the `/messages/operations` route.
- `packages/sdk-java/qwencode`: `HostedHarnessClient.runMessageOperation`.
- `packages/sdk-java/managed-agent-server`: `V61__managed_session_message_relay.sql`, `SessionMessageRelayStore`, `SessionMessageRelay`, its scheduler, `HarnessConnector.runMessageOperation`, the completion rule and continuation composition in `ChildResultRelay`, the journal reads in `ChildResultRelayStore`, and `PREVIEW_TOOLS`.
- Tests beside each file in both languages; this design in both languages; pointers from the H4d-a and H4b designs.

## Validation

- **TypeScript.** The funnel suite drives two real managed Sessions: the outbox entry and its replay, the settlement hold, a continuation with its envelope and its chain head, a never-started continuation releasing its predecessor, each named refusal and the bound, every relay step and its step-awareness, a receipt with its input and wake committed once, the digest check, the lineage check, and consumption. The tool-turn suite covers the two declarations, argument refusals, both routes, and the absence of any mount. The Hosted suite reopens a Session whose journal holds a child's message, runs its wake turn and consumes it, and maps the route's refusals, including `child_messages_pending`. The H4d-a gate tests now pin the gates open, and close them through the mock to pin that the authority consults them before anything publishes.
- **Java.** The relay suite walks a message through handover, receipt and acceptance, the hold before attach, cancellation of an ended run or inactive target, the child-to-parent route, the not-ready hold, rejection, a replayed receipt, consumption, orphaning and give-up. The H4b relay suite gains the completion rule: the edge hold, the journal hold, settlement from a message turn (completed and not), the parent's `child_messages_pending` veto, and continuation composition with its bound. The H2 store suite covers the ledger page and lease, the edge count with given-up rows excluded, the lineage read, the journal reads (pending inputs, newest settled turn, assistant text, chunked bodies split inside a character), and the compacted-journal refusal.
- **Every existing suite stays green**: the H1–H4c and H4d-a contract replays, authority, store, tool-turn and lifecycle suites, and the full `managed-agent-server` surefire suite.

## Acceptance criteria

- A parent's message reaches a running child exactly once, across a relay restart, and the child's result reflects the turn that read it.
- A child's message reaches its parent exactly once, held until the run attached.
- A message to a completed child continues it as a new run whose first input carries the chain's history; a failed or cancelled child is refused by name.
- Accepted and consumed are visible on both sides, each naming the input it stands on; nothing is consumed by a turn that did not complete.
- A closing sender's messages are never delivered; a child never settles over a message still owed to it.
- Both gates are open, the recovery allowlist admits `session_message`, and no public contract moves.

## Open questions

1. **Transcript import for continuations.** Whether revive should copy the predecessor's full transcript (tool calls included) through a header-level import with a restore proof, or keep the bounded instruction-and-result history of decision 9.
2. **Messages to a busy foreground parent.** A child's message to a parent waiting on that child's foreground result is accepted at once and read after the parent's turn, which has already received the result. Whether a foreground child should be refused `send_message` instead is left to product evidence.

## Follow-up work

| Slice  | Scope                                                                                                                      |
| ------ | -------------------------------------------------------------------------------------------------------------------------- |
| H4e    | Teams and the mailbox; the team route of `send_message`.                                                                   |
| H4f    | Public task cancel and the `unknown`-delivery operator story, which also covers a message ledger row classified `unknown`. |
| Import | Transcript import for continuations (open question 1).                                                                     |
| Peers  | Named peers outside the lineage, with their authorization proof and route value.                                           |
