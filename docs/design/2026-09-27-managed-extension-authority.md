# Managed Extension Authority (H0c)

[English](2026-09-27-managed-extension-authority.md) | [简体中文](2026-09-27-managed-extension-authority.zh-CN.md)

Status: implemented in this change; no Stage H domain is enabled for submission yet. Updated: 2026-09-28. This is slice H0c of [#12827](https://github.com/QwenLM/qwen-code/issues/12827), stage H of the Managed Agent proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380). It builds on the task contract of H0a ([design](2026-09-27-managed-agent-task-contract.md)) and the record contract of H0b ([design](2026-09-27-managed-extension-record-contract.md)). Below, "the reference design" is sections 1, 3, 11 and 13 of the proposal's [extension runtime design](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md), with section 3 of its [Session storage design](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-session-storage.md) and the `OperationGrant` of its [private control protocol](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-control-protocol.md), at the commit that #12827 pins.

## Problem

H0b fixed the records the Stage H capabilities share, but nothing commits them. Before H1 can bring MCP onto the Managed path, the Session authority has to commit these records, the outbox and the wake intents that go with them, and the control plane has to rebuild `SessionTaskView` from them. The H0 gate in section 13 of the reference design is that Java, qwen and the Runtime agree on stable IDs, generation and unknown outcomes, and that a restart rebuilds the task list.

Two questions of #12827 had to be answered first: who owns the records (question 2) and what carries a wake intent (question 3). H0b left two more: how `degraded` is projected, and how a record's revision chain is keyed when a domain has one record per resource.

## Current state

The facts below are from `main` at `9220c85358`.

- **Authority.** `LocalManagedSessionAuthority` in `packages/core` is the only writer of a Session's journal. `commitDomainRecord` merges `operationId`, `revision` and `previousRecordRef` into the body it publishes and keeps one revision chain per domain. `submitInput` commits `input.accepted` and the `wake.requested` the authority generates for it in one transaction.
- **Store.** The Hosted Harness writes the journal through `HttpManagedSessionStore` into the Java Session store, which keeps each transaction as opaque record bytes and each resource as a verified blob. Resources that event payloads reference travel inline with the commit; a resource named only inside another resource's body travels with it only when that body is a checkpoint.
- **Contract.** H0b defined the run block, the monitor body and `OperationGrant`, pinned by fixtures that TypeScript and Java both replay. `monitor_run` is in the v1 domain index and disabled for submission. H0a added the task routes to the public contract as `planned`.
- **Broker.** The Runtime Broker's execution ledger has the states `PREPARED`, `DISPATCHING`, `EXECUTING`, `CANCEL_REQUESTED`, `SETTLED` and `UNKNOWN`. The Harness sees them through a wire status that folds `DISPATCHING`, `EXECUTING` and `UNKNOWN` into `executing` and answers `UNKNOWN` with the error `runtime_broker_execution_unknown`. No code maps either to the physical execution line.

## Goals

- Commit Stage H record revisions with the Session authority, one revision chain per record, and an optional notification input and wake in the same transaction.
- Rebuild the chains and the task list when an authority reopens.
- Materialize the records, the task projection and the outbox in the Java Session store, in the SQL transaction that commits the journal, and refuse any revision the shared contract refuses.
- Issue `OperationGrant`s from committed records, and install them at a per-operation gate.
- Serve the task list and detail on both API surfaces, and announce each change of a task view on the Session event stream.
- Pin the projection, the task identity and the Broker mapping with one fixture file that TypeScript and Java both replay.

## Non-goals

- **Enablement.** `monitor_run` stays disabled for submission, and no other domain gets a body. H3 enables Monitors.
- **Task events and cancel.** Their routes stay `planned`: no H0c task produces output, and no owner can act on a cancel yet.
- **Dispatchers.** Nothing reads the outbox yet; H4 and H5 add the dispatchers.
- **Grant checks on commit.** Which commits must present a grant is decided by each slice with its phases.
- **Runtime, Harness and Broker paths.** No tool loop, Broker or worker change. The Broker's wire mapping only becomes visible to its new contract test.
- **Ordering.** #12827 holds H0c until the tool-capable Hosted turn, #12765 and #12766 land. H0c changes no Harness, Broker or worker path and keeps `monitor_run` disabled, so it can land ahead of them or wait; that is the maintainers' call.

## Decisions

1. **The authority writes; the Java store materializes** (question 2). The TypeScript authority stays the single writer of the journal, as section 3 of the storage design requires: a registered domain has no second write path. The Java Session store is its durable store, and it now reads the Stage H revisions each transaction carries and writes the record index, the task projection and the outbox into queryable rows inside the SQL transaction that stores the journal. It checks every revision with the H0b and H0c rules and refuses the whole commit if one fails. Within that check the control plane never holds a record the authority could not have committed; whether a domain is enabled for submission stays the authority's own gate, which the store does not mirror. A disagreement stops the writer instead of passing silently. This gives the control plane the product records and the public projection that section 1 of the reference design assigns to it, without a second writer.
2. **A wake is `input.accepted` plus `wake.requested`** (question 3). A Stage H revision may commit a notification input in the same transaction; the authority generates the wake for it, as `submitInput` does. There is no `WakeIntent` record and no new event kind: section 3 of the storage design would require a new `minimumReader` for either, and `wake.requested` already is the rebuildable scheduling index. The Session inbox is a queue of user messages, not a wake carrier.
3. **One chain per record, keyed by the body's identity** (H0b open question 3). The resource of a Stage H revision holds exactly the closed body; nothing is merged into it. The chain is keyed by the domain and the body's own identity (`monitorId` for a Monitor), and its revision, previous revision and opening operation come from the journal order, where they cannot disagree with the body.
4. **A first revision opens its run.** Its run is `reserved` or `admitted`, its execution is absent or an `intent`, and its delivery is absent or `planned`; a Monitor has also written no output, and cannot have observed anything without a start receipt. H0b's successor rules only say how a revision follows another; without this rule, a record could appear already settled.
5. **`degraded` is a running or waiting run with a recovery reason** (H0b open question 2). That is exactly the state H0b allows to go on with reduced guarantees, such as a Monitor watch rebuilt after its Runtime was lost.
6. **The outbox is derived from the delivery line.** A record is in the outbox while its delivery is `planned`, `sending`, `partial`, `accepting` or `unknown`: still to send, or to reconcile without resending. Because the outbox is a projection of the committed run, it always commits with it. `accepted` waits for the model, not for a dispatcher. A Monitor's run carries no delivery line, so no H0c record is in the outbox: the delivery columns and `isExtensionDeliveryPending` serve the bodies that H4 and H5 add, and the fixtures pin the rule on plain runs.
7. **Grants are derived from committed facts.** The authority issues a grant for a committed record: its operation is the command that opened the record, so a command opens at most one record; its revision is the record's current revision; and its plan is that revision's resource. The owner, the Workspace generation and the phases are the caller's, and the slices that register phases add their lifecycle, trust and phase checks. The grant needs no journal entry, and a restarted authority issues the same revision again. The Runtime's gate installs it under H0b's replacement rule, so issuing it again renews it and another owner or scope takes a new revision of the record. The gate never reopens a revoked revision, and the grant it revoked still bounds the next one. It refuses a malformed revocation rather than missing the grant it names. The gate lives in the Runtime's memory: a restarted Runtime starts with none, so a revocation lasts as long as the process that received it, and H1, which wires the gate, decides whether revocation must become a committed fact.
8. **Task identity is a hash both sides compute.** The record key is SHA-256 over the Session ID, the domain and the record's identity, joined by NUL, and the task ID is `task_` followed by the key. The ID fits the 128-character public limit and exposes no internal identifier.
9. **List and detail are served; events and cancel are not.** The four read routes become `partial` and every Session reports `capabilities.tasks`, since every Session serves them. Task events stay `planned` until a task produces output, and cancel until an owner can stop a task; `PublicCommandOperation.task_id` and `WebShellCommandOperation.taskId` stay `planned` with cancel. H0c tasks therefore advertise no action and no Artifact.
10. **The Runtime's reports map onto the execution line.** A Broker record in `PREPARED` or `DISPATCHING` is an `intent`, `EXECUTING` or `CANCEL_REQUESTED` is `dispatch_started`, `UNKNOWN` and `ABANDONED` (W0e: the original Runtime's journal is gone for good) are `outcome_unknown`, and `SETTLED` is `not_started_proven` with the status `not_started` and `settled` otherwise. The Harness reads the wire status the same way, except that it takes `executing` as dispatched: the wire cannot tell an unsent claim from a sent call, and taking a call that may have been sent for an unsent one could run it twice. Only the Runtime's own `not_started` answer proves a call unsent; the Broker never derives it. A call that settles as `cancelled` may have been cancelled before or after it was sent, and no field of the record tells which (H0b), so both readings take it as `settled` and never as `not_started_proven`. Telling a never-sent cancellation apart needs evidence beyond the settled record, which the slice that wires the mapping must bring.

## Committing a record

`LocalManagedSessionAuthority.commitExtensionRecord(command, { domain, record, input? }, actor)` commits one revision.

1. The domain must have a record body in `MANAGED_EXTENSION_RECORD_BODIES`; only `monitor_run` has one.
2. A retried command returns the revision it committed before anything is published again, even if the domain was disabled since. The same command with other content is a conflict, and so is a command that committed something other than a Stage H record.
3. The domain must be enabled for submission; `monitor_run` is not.
4. The body is parsed and closed. The first revision of its record must open its run, and its command must not have opened another record; every later revision must be a successor of the latest.
5. The command must be writable: the log has not stopped after a failed write, the command names this Session, and its expected sequence, when given, is the committed one. These checks run again in the commit, but running them first means a refused retry publishes no body.
6. The parsed body is published as the resource, and the `domain.committed` event, with the input and its wake when given, commits in one transaction. The authority applies the revision with the rest of the transaction's state, so no reader sees the event committed and the record not.

Any other path that tries to commit a `domain.committed` event for a domain with a body, such as `appendExecution` or `commitDomainRecord`, is refused, so no revision bypasses its chain. So is any other event whose ID has the form `<domain>:<n>` that Stage H record events use, so no event can take the ID a later revision needs. Every path also refuses a `domain.committed` event of a domain that is not enabled for submission, as H0b requires, since the generic appends would otherwise take any name in the index.

When an authority opens, it replays every Stage H revision in the journal through the same rules, reading each body from the resource store. A body that no longer reads or chains means the log or its resources are corrupt, and opening fails. Because a reopened authority applies the rules in force, tightening one of them changes the contract version: a log that the older rules accepted would no longer open. The one H0b rule this change tightens, that a running or waiting run cannot rest on an execution that never started, lands before any domain with a body is enabled, so no log holds such a record. `extensionRecord` and `taskViews` expose the rebuilt state, and `issueOperationGrant` issues grants from it. The outbox is each record's delivery line, which `isExtensionDeliveryPending` tests; nothing reads it before H4. The HTTP store now also commits the resources a Stage H body names, as it does for a checkpoint, so the body never references a resource that only the writer holds.

## Task projection

The task view follows the committed revisions of one record. Each revision gives the run block and the time its `domain.committed` event occurred.

| Run state              | Task state                            |
| ---------------------- | ------------------------------------- |
| `reserved`, `admitted` | `pending`                             |
| `running`, `waiting`   | the same, or `degraded` with a reason |
| `settled`              | `completed`                           |
| `failed`, `cancelled`  | the same                              |
| `recovery_blocked`     | `recovery_blocked`                    |

| Run block                                     | Runtime state  |
| --------------------------------------------- | -------------- |
| run ended, or no execution                    | absent         |
| execution without a Runtime binding           | `unbound`      |
| `running_attached`                            | `ready`        |
| reason `runtime_lost`                         | `lost`         |
| `intent` or `dispatch_started` with a binding | `provisioning` |
| any other execution                           | absent         |

The rows apply in order. `draining` needs a stop request, which the run block does not carry; H3 adds it.

- `createdAt` is the time of the first revision.
- `startedAt` is the time of the first revision whose run is `running`, `waiting` or `settled`, so every completed task has one and a pending task never does. A blocked run sets none, since it may still prove that it never started.
- `settledAt` is the time of the revision that ended the run.
- A time never precedes an earlier one: `startedAt` is at least `createdAt`, and `settledAt` at least the start, or the creation when there was none.
- `definitionRevision` is the run's pinned definition revision.
- The list is newest first by creation, then by task ID, both descending.

The times are the `occurredAt` the authority records on each revision, not the server's clock, so a rebuild from the journal yields the same view; the clamping covers a writer whose clock runs behind the one before it. They are epoch milliseconds, as the H0a contract states, and the task schemas say so; the public Session, turn, event and item resources report seconds, see open question 2.

## Java Session store

Flyway `V18` adds `qwen_managed_session_extension_record`: one row per record, keyed by the Session scope key and the record key, holding the record's identity, the hash of the command that opened it, its latest revision and resource, the task projection and the delivery line. One index serves the task list and another the check of the opening command. `ManagedExtensionRecordStore` writes it from `ManagedSessionStore.commit`, after the transaction's resources are stored and in the same SQL transaction:

1. It parses each record line of the transaction as strictly as the authority's reader: no duplicate keys or trailing content, at most 64 levels deep, as the shared store contract pins, and only finite numbers. It then picks the `domain.committed` events of domains with a body.
2. It checks each such event as the authority's reader does: a closed event with no subject, which the authority never gives one; version 1; the sequence of its place among the transaction's events, so it is never the marker's line or part of the genesis; a closed key of this Session; and a closed payload whose reference names a version 1 record of the domain. A transaction that carries one must hold only its events and then its commit marker. It then reads the body from the verified resource, checks that it matches the reference, and checks the body with `ManagedExtensionRecords`.
3. It checks the first-revision or successor rule against the stored latest revision, and that the command opening a record has opened no other, by a hash of the opening command that each row keeps. It then projects the task view with `ManagedExtensionProjection`, and inserts or updates the row.
4. When the view changed and the Session has a public resource that is not deleted or being deleted, it appends a `task.updated` event with `data.taskId` and `data.state`, keyed so a replayed transaction announces nothing twice. It locks the Session's row before it reads the status, so it sees a deletion that committed while the Session store's transaction was open. The event is appended like any other Session event: it advances the Session's `updated_at` and version, and one that lands between two streamed text deltas splits the text part, as any interleaved event does.

A revision that these rules refuse answers `409 managed_session_extension_record_rejected`. A body resource that is missing, belongs to another Session or fails verification keeps the store's existing answers (`409 managed_session_resource_missing`, `404 managed_session_not_found`, `500 managed_session_resource_corrupt`). Either way the whole commit rolls back. A replayed transaction returns before any of this runs. Every record line must now be a JSON object that the authority's reader accepts, whether or not the transaction carries a Stage H record; a line that is not answers `400 invalid_managed_session_store_request`. The authority has always written such lines. The rows are the durable read model: a restarted server reads the same list, and the journal they are derived from stays the source of truth.

## Public contract

The OpenAPI version becomes `1.19.0`, after the `1.18.0` of the durable Session lifecycle (#12881).

- `listSessionTasks`, `getSessionTask`, `queryWebShellTasks` and `getWebShellTask` are `partial` and mapped, and so are the task schemas and enums they return.
- `SessionCapabilities.tasks` is served and required, like the other served flags. `WebShellSession.capabilities` becomes the named schema `WebShellSessionCapabilities`, whose `tasks` is served and required while the other flags stay `planned`.
- The task timestamps say that they are epoch milliseconds.
- The list route documents the `task.updated` event; the event type is an open string, so no schema changes.
- A bad list cursor is `400 invalid_cursor`, a limit outside 1 to 100 is `400 invalid_limit`, and an unknown task is `404 task_not_found`.
- `output_cursor` and `outputCursor` stay `planned` with the task events route they point to. The values of `TaskActionCapability` reach the generated types although no H0c task advertises one, since an enum value cannot carry the marker, as H0a noted for `task_cancel`.

The generated WebShell types gain the two task routes, the task schemas and the capabilities object.

## Shared fixtures

`packages/core/src/managed-runtime/contracts/managed-extension-projection-v1.fixtures.json` pins H0c for both languages:

- the record bodies, task states and outbox states, as constants;
- 7 task ID cases;
- 50 run start and 32 Monitor start cases;
- 45 single-revision views and 11 run histories, with their outbox membership;
- 2 Monitor chains that both sides commit through their authority or store, and 12 chains they must refuse: one reuses the command that opened another record, and three attach a Runtime again under the same or an older generation, or without an unknown outcome;
- 10 Broker cases, one per execution state of the Broker's ledger, each with the wire status the Broker reports for it and the execution the Harness reads from that, and 8 wire-status cases.

A Python labeler written from this document, independent of both languages and kept outside the repository as for H0b, produced the labels. `managed-extension-projection.test.ts` and `ManagedExtensionProjectionContractTest` both replay the task ID, start, view and history cases. Java maps each Broker case's state; TypeScript maps its wire status and the wire-status cases, and checks that the two readings differ only for `DISPATCHING`, as decision 10 says; and the Broker's `ManagedExtensionExecutionContractTest` checks that the Broker reports those wire statuses. The authority suite, `ManagedExtensionRecordStoreTest` and `ManagedAgentMySqlIT` commit the chains.

`managed-extension-journal-v1.fixtures.json` holds the requests that the TypeScript authority sent through its HTTP store for a Session with two Monitor revisions, the second with a notification input and its wake. The HTTP store test fails when the writer's output changes, and rewrites the file when run with `QWEN_WRITE_GOLDEN=1`. `ManagedSessionStoreIntegrationTest` sends the same requests to the Java store, which must accept every one and project the same task.

## Files affected

- `packages/core/src/managed-runtime/managed-extension-projection.ts` and its test, and `managed-operation-grant-gate.ts` and its test (new).
- `packages/core/src/managed-runtime/managed-extension-record.ts`: the start rules, and the rule that a running or waiting run cannot rest on an execution that never started, which the H0b schema, fixtures and design gain too.
- `packages/core/src/managed-runtime/managed-session-authority.ts` and the new `managed-session-authority.extension.test.ts`.
- `packages/core/src/managed-runtime/http-managed-session-store.ts` and its test, and `managed-session-store-contract.test.ts`.
- The two fixture files above (new), and `maxJsonDepth` in `managed-session-store-v1.fixtures.json`.
- In `packages/sdk-java/managed-agent-server`: `ManagedExtensionProjection`, `ManagedExtensionRecordStore`, `ManagedTaskService` and `V18__managed_extension_record.sql` (new); `ManagedExtensionRecords`, `ManagedSessionStore`, `ManagedSessionStoreModels`, `AgentStateStore`, `ManagedAgentStore`, `ManagedAgentService`, `ApiModels` and both controllers; the OpenAPI spec; `ManagedAgentApiContractTest`, `ManagedAgentMySqlIT`, `ManagedSessionStoreIntegrationTest`, `ManagedSessionStoreContractFixtureTest` and `PlannedTaskContractTest`; and `ManagedExtensionProjectionContractTest`, `ManagedExtensionRecordStoreTest` and the `ExtensionRecordJournal` helper (new).
- In `packages/sdk-java/runtime-broker`: `RuntimeBrokerHttpServer.wireState` becomes package-private, and `ManagedExtensionExecutionContractTest` (new) pins it.
- `packages/web-shell/client/components/managed/generated/managed-agent-api.ts` (regenerated).
- This design in both languages, and the status lines of the H0a and H0b designs.

## Validation plan

- **TypeScript:** the fixture replay; the authority suite for chains, refusals before publishing, replay and a command committed without a record, the notification and wake, a record visible as soon as its transaction commits, the bypass guard, reserved event IDs, disabled domains, cold rebuild, a missing or non-chaining body or a shared opening command, and grants; the gate against H0b's replacement cases, revocation and malformed input; the HTTP store for the nested resources, a cold rebuild over HTTP and the requests the writer sends.
- **Java:** the fixture replay; the chains, refusals with the rule that refused each, record lines the authority could not parse, replay, announcements and a deleted Session through `ManagedSessionStore`; the TypeScript writer's requests through the HTTP route; the API contract test for every mapped route and record; the MySQL integration test on MariaDB 10.11, which also shows that a refused revision lets the same command commit again as new — no resource, resource reference or revision behind — and that a deletion committed during a Stage H commit gets no `task.updated` after its terminal event.
- **Broker:** the wire status reported for every execution state.
- **Generated types:** the WebShell generator test.
- **Mutation checks:** on the TypeScript side, the projection rules, the start and chain rules and the authority's refusals were each disabled in turn, and a test failed for every one.

## Acceptance criteria

- TypeScript and Java produce the same task IDs, task views and outbox membership for every fixture case and refuse the same chains, and each maps the Runtime reports it reads to the execution states the fixtures give.
- A refused revision commits nothing on either side.
- A reopened authority and a restarted server report the same task list as before.
- No planned route is mapped, and nothing changes for Sessions without Stage H records except the empty task list, `capabilities.tasks`, the stricter parse of record lines, and the generic append paths, which now accept a `domain.committed` event only for an enabled domain that has no Stage H record body — `goal_state`, `session_metadata`, `file_history` and `session_source` today — instead of for every registered name.
- The H0 gate holds at the level of the contract. The fixtures pin the task IDs, the chain rules (a Runtime is attached again only under a later generation, after an unknown outcome), the Broker's execution states and the wire statuses the Broker reports for them. TypeScript, the Java store and the Broker each replay their part. Only the commit path runs end to end: nothing in production calls `commitExtensionRecord`, the grant gate or the execution mappings before H3 enables `monitor_run` and H1 wires the gate.
- `monitor_run` is still refused for submission.

## Open questions

1. **Rebuild cost.** A reopened authority reads every Stage H revision body. A Monitor may commit up to 10,000 observations, so H3 should bound this before enabling it, for example by chaining the authority's view to a checkpoint.
2. **Timestamp units and source.** The H0a contract gives tasks epoch milliseconds, and this change follows it and writes the unit into the task schemas. The WebShell surface reports milliseconds throughout, but the public Session, turn, event and item resources report seconds, so the public surface mixes units. Aligning them is a contract decision, and it is cheapest while the task routes are `partial` and no domain produces tasks. H0a also says that the server fills task times from its clock; H0c takes them from the journal instead, for the reason given under Task projection.
3. **Nested resources.** The HTTP store lists every resource a Stage H body names with the commit, so the Java store's resource check refuses a body that names a resource the Session does not hold, such as a start receipt or an output manifest kept only in the Runtime or the tool result store; the Java store does not walk the body itself. H3 must either publish those as Session resources or exempt their kinds from the closure. A named resource whose metadata disagrees with a staged one fails the commit before it is sent and, as for a mismatched reference in an event payload, stops the writer; H3 should check the references before it publishes the body.
4. **Logical and physical start.** H0b lets a run stay `admitted` while its execution is already `running_attached`, so such a task shows `pending` with the Runtime state `ready` and no start time. Tightening that rule is a change to the H0b contract.
5. **Replayed domain records.** `commitDomainRecord` publishes a new body before it detects a replayed command, and returns that body's reference instead of the committed one. `commitExtensionRecord` checks for the replay first; the older method is left for a separate fix.
6. **Notification wakes.** A revision that commits a notification input also commits its `wake.requested`, but nothing consumes the wake yet. The hosted Session path refuses to reopen a Session while an accepted input has no `turn.settled` (`hosted_turn_recovery_required`), so H3 must run or settle such inputs before it enables a domain that notifies.
7. **Bodies added later.** The Java store materializes only the bodies it knows and passes the `domain.committed` events of other domains through, as before H0c. A slice that adds a body must reach the server before any writer commits the domain, or backfill the rows from the journal when the server gains the body. Otherwise the first revision that such a server sees for a record is not a start, so it is refused and the writer stops. H0c's only body, `monitor_run`, ships on both sides and stays disabled.

## Follow-up work

| Slice | Scope                                                                                                                                  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------- |
| H1–H2 | Bodies and phases for MCP and Hooks; decide which commits present a grant and check it at commit.                                      |
| H3    | Enable `monitor_run` and background Shell; task events and output; `draining`; bound the rebuild; keep old readers away from Sessions. |
| H4–H5 | Child and Channel bodies; dispatchers that drain the outbox; task cancel.                                                              |
