# Managed Extension Authority (H0c)

[English](2026-09-27-managed-extension-authority.md) | [简体中文](2026-09-27-managed-extension-authority.zh-CN.md)

Status: implemented in this change; no Stage H domain is enabled for submission yet. Updated: 2026-09-27. This is slice H0c of [#12827](https://github.com/QwenLM/qwen-code/issues/12827), stage H of the Managed Agent proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380). It builds on the task contract of H0a ([design](2026-09-27-managed-agent-task-contract.md)) and the record contract of H0b ([design](2026-09-27-managed-extension-record-contract.md)). Below, "the reference design" is sections 1, 3, 11 and 13 of the proposal's [extension runtime design](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md), with section 3 of its [Session storage design](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-session-storage.md) and the `OperationGrant` of its [private control protocol](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-control-protocol.md), at the commit that #12827 pins.

## Problem

H0b fixed the records the Stage H capabilities share, but nothing commits them. Before H1 can bring MCP onto the Managed path, the Session authority has to commit these records, the outbox and the wake intents that go with them, and the control plane has to rebuild `SessionTaskView` from them. The H0 gate in section 13 of the reference design is that Java, qwen and the Runtime agree on stable IDs, generation and unknown outcomes, and that a restart rebuilds the task list.

Two questions of #12827 had to be answered first: who owns the records (question 2) and what carries a wake intent (question 3). H0b left two more: how `degraded` is projected, and how a record's revision chain is keyed when a domain has one record per resource.

## Current state

The facts below are from `main` at `848cf5e6c4`.

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
- **Runtime, Harness and Broker paths.** No tool loop, Broker or worker change.

## Decisions

1. **The authority writes; the Java store materializes** (question 2). The TypeScript authority stays the single writer of the journal, as section 3 of the storage design requires: a registered domain has no second write path. The Java Session store is its durable store, and it now reads the Stage H revisions each transaction carries and writes the record index, the task projection and the outbox into queryable rows inside the SQL transaction that stores the journal. It checks every revision with the H0b and H0c rules and refuses the whole commit if one fails, so the control plane never holds a record the authority could not have committed, and a disagreement stops the writer instead of passing silently. This gives the control plane the product records and the public projection that section 1 of the reference design assigns to it, without a second writer.
2. **A wake is `input.accepted` plus `wake.requested`** (question 3). A Stage H revision may commit a notification input in the same transaction; the authority generates the wake for it, as `submitInput` does. There is no `WakeIntent` record and no new event kind: section 3 of the storage design would require a new `minimumReader` for either, and `wake.requested` already is the rebuildable scheduling index. The Session inbox is a queue of user messages, not a wake carrier.
3. **One chain per record, keyed by the body's identity** (H0b open question 3). The resource of a Stage H revision holds exactly the closed body; nothing is merged into it. The chain is keyed by the domain and the body's own identity (`monitorId` for a Monitor), and its revision, previous revision and opening operation come from the journal order, where they cannot disagree with the body.
4. **A first revision opens its run.** Its run is `reserved` or `admitted`, its execution is absent or an `intent`, and its delivery is absent or `planned`; a Monitor has also written no output, and cannot have observed anything without a start receipt. H0b's successor rules only say how a revision follows another; without this rule, a record could appear already settled.
5. **`degraded` is a running or waiting run with a recovery reason** (H0b open question 2). That is exactly the state H0b allows to go on with reduced guarantees, such as a Monitor watch rebuilt after its Runtime was lost.
6. **The outbox is derived from the delivery line.** A record is in the outbox while its delivery is `planned`, `sending`, `partial`, `accepting` or `unknown`: still to send, or to reconcile without resending. Because the outbox is a projection of the committed run, it always commits with it. `accepted` waits for the model, not for a dispatcher.
7. **Grants are derived from committed facts.** The authority issues a grant for a committed record: its operation is the command that opened the record and its revision is the record's current revision. Issuing it again later renews it; a new owner or scope needs a new revision of the record first. The grant needs no journal entry, and a restarted authority issues the same revision again. The Runtime's gate installs it under H0b's replacement rule and never reopens a revoked revision.
8. **Task identity is a hash both sides compute.** The record key is SHA-256 over the Session ID, the domain and the record's identity, joined by NUL, and the task ID is `task_` followed by the key. The ID fits the 128-character public limit and exposes no internal identifier.
9. **List and detail are served; events and cancel are not.** The four read routes become `partial` and every Session reports `capabilities.tasks`, since every Session serves them. Task events stay `planned` until a task produces output, and cancel until an owner can stop a task; `PublicCommandOperation.task_id` and `WebShellCommandOperation.taskId` stay `planned` with cancel. H0c tasks therefore advertise no action and no Artifact.
10. **The Runtime's reports map onto the execution line.** A Broker record in `PREPARED` or `DISPATCHING` is an `intent`, `EXECUTING` or `CANCEL_REQUESTED` is `dispatch_started`, `UNKNOWN` is `outcome_unknown`, and `SETTLED` is `not_started_proven` with the status `not_started` and `settled` otherwise. The Harness reads the wire status the same way, except that it takes `executing` as dispatched: the wire cannot tell an unsent claim from a sent call, and taking a call that may have been sent for an unsent one could run it twice.

## Committing a record

`LocalManagedSessionAuthority.commitExtensionRecord(command, { domain, record, input? }, actor)` commits one revision.

1. The domain must have a record body in `MANAGED_EXTENSION_RECORD_BODIES` and be enabled for submission; only `monitor_run` has a body, and it is not enabled.
2. A retried command returns the revision it committed before anything is published again. The same command with other content is a conflict.
3. The body is parsed and closed. The first revision of its record must open its run, and every later one must be a successor of the latest.
4. The parsed body is published as the resource, and the `domain.committed` event, with the input and its wake when given, commits in one transaction.

Any other path that tries to commit a `domain.committed` event for a domain with a body, such as `appendExecution` or `commitDomainRecord`, is refused, so no revision bypasses its chain.

When an authority opens, it replays every Stage H revision in the journal through the same rules, reading each body from the resource store. A body that no longer reads or chains means the log or its resources are corrupt, and opening fails. `extensionRecord`, `taskViews` and `extensionOutbox` expose the rebuilt state, and `issueOperationGrant` issues grants from it. The HTTP store now also commits the resources a Stage H body names, as it does for a checkpoint, so the body never references a resource that only the writer holds.

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
- `startedAt` is the time of the first revision whose run is `running`, `waiting`, `recovery_blocked` or `settled`, so every completed task has one and a pending task never does.
- `settledAt` is the time of the revision that ended the run.
- `definitionRevision` is the run's pinned definition revision.
- The list is newest first by creation, then by task ID, both descending.

Task timestamps are epoch milliseconds, as the H0a contract states. The served Session and event resources report seconds; see open question 2.

## Java Session store

Flyway `V16` adds `qwen_managed_session_extension_record`: one row per record, keyed by the Session scope key and the record key, holding the record's identity, its latest revision and resource, the task projection and the delivery line. `ManagedExtensionRecordStore` writes it from `ManagedSessionStore.commit`, after the transaction's resources are stored and in the same SQL transaction:

1. It parses each record line of the transaction strictly, refusing duplicate keys, and picks the `domain.committed` events of domains with a body.
2. It checks that each event names this Session and that its resource matches the reference, then reads the body from the verified resource and checks it with `ManagedExtensionRecords`.
3. It checks the first-revision or successor rule against the stored latest revision, projects the task view with `ManagedExtensionProjection`, and inserts or updates the row.
4. When the view changed and the Session has a public resource, it appends a `task.updated` event with `data.taskId` and `data.state`, keyed so a replayed transaction announces nothing twice.

A refused revision answers `409 managed_session_extension_record_rejected` and rolls back the whole commit. A replayed transaction returns before any of this runs. Every record line must now be a JSON object; the authority has always written one. The rows are the durable read model: a restarted server reads the same list, and the journal they are derived from stays the source of truth.

## Public contract

The OpenAPI version becomes `1.18.0`, after the `1.17.0` of event replay (#12840).

- `listSessionTasks`, `getSessionTask`, `queryWebShellTasks` and `getWebShellTask` are `partial` and mapped, and so are the task schemas and enums they return.
- `SessionCapabilities.tasks` is served. `WebShellSession.capabilities` becomes the named schema `WebShellSessionCapabilities`, whose `tasks` is served while the other flags stay `planned`.
- The list route documents the `task.updated` event; the event type is an open string, so no schema changes.
- A bad list cursor is `400 invalid_cursor`, a limit outside 1 to 100 is `400 invalid_limit`, and an unknown task is `404 task_not_found`.

The generated WebShell types gain the two task routes, the task schemas and the capabilities object.

## Shared fixtures

`packages/core/src/managed-runtime/contracts/managed-extension-projection-v1.fixtures.json` pins H0c for both languages:

- the record bodies, task states and outbox states, as constants;
- 7 task ID cases;
- 49 run start and 31 Monitor start cases;
- 45 single-revision views and 8 run histories, with their outbox membership;
- 2 Monitor chains that both sides commit through their authority or store, and 8 chains they must refuse;
- 9 Broker and 8 wire-status execution cases.

A Python labeler written from this document, independent of both languages and kept outside the repository as for H0b, produced the labels. `managed-extension-projection.test.ts` and `ManagedExtensionProjectionContractTest` replay the pure cases; the authority suite, `ManagedExtensionRecordStoreTest` and `ManagedAgentMySqlIT` commit the chains.

## Files affected

- `packages/core/src/managed-runtime/managed-extension-projection.ts` and its test, and `managed-operation-grant-gate.ts` and its test (new).
- `packages/core/src/managed-runtime/managed-extension-record.ts`: the start rules.
- `packages/core/src/managed-runtime/managed-session-authority.ts` and the new `managed-session-authority.extension.test.ts`.
- `packages/core/src/managed-runtime/http-managed-session-store.ts` and its test.
- The fixture file above (new).
- In `packages/sdk-java/managed-agent-server`: `ManagedExtensionProjection`, `ManagedExtensionRecordStore`, `ManagedTaskService` and `V16__managed_extension_record.sql` (new); `ManagedExtensionRecords`, `ManagedSessionStore`, `ManagedAgentService`, `ApiModels` and both controllers; the OpenAPI spec; `ManagedAgentApiContractTest`, `ManagedAgentMySqlIT` and three new tests.
- `packages/web-shell/client/components/managed/generated/managed-agent-api.ts` (regenerated).
- This design in both languages, and the status lines of the H0a and H0b designs.

## Validation plan

- **TypeScript:** the fixture replay; the authority suite for chains, refusals, replay, the notification and wake, the bypass guard, disabled domains, cold rebuild, a missing body and grants; the gate against H0b's replacement cases and revocation; the HTTP store for the nested resources and a cold rebuild over HTTP.
- **Java:** the fixture replay; the chains, refusals, replay and announcements through `ManagedSessionStore`; the API contract test for every mapped route and record; the MySQL integration test on MariaDB 10.11 and MySQL 8.4, which also shows that a refused revision rolls back its resources and journal row.
- **Generated types:** the WebShell generator test.
- **Mutation checks:** each rule of the projection, the start rules and the store checks is mutated in turn and a test fails.

## Acceptance criteria

- TypeScript and Java produce the same task IDs, task views, outbox membership and execution states for every fixture case, and refuse the same chains.
- A refused revision commits nothing on either side.
- A reopened authority and a restarted server report the same task list as before.
- No planned route is mapped, and nothing changes for Sessions without Stage H records except the empty task list and `capabilities.tasks`.
- `monitor_run` is still refused for submission.

## Open questions

1. **Rebuild cost.** A reopened authority reads every Stage H revision body. A Monitor may commit up to 10,000 observations, so H3 should bound this before enabling it, for example by chaining the authority's view to a checkpoint.
2. **Timestamp units.** The H0a contract gives tasks epoch milliseconds, and this change follows it, but the served Session and event resources report seconds. A later D slice should make the public surface consistent.
3. **Nested resources.** The HTTP store commits every resource a Stage H body names, so the Java store refuses a body that names a resource the Session does not hold, such as a start receipt or an output manifest kept only in the Runtime or the tool result store. H3 must either publish those as Session resources or exempt their kinds from the closure.
4. **Replayed domain records.** `commitDomainRecord` publishes a new body before it detects a replayed command, and returns that body's reference instead of the committed one. `commitExtensionRecord` checks for the replay first; the older method is left for a separate fix.

## Follow-up work

| Slice | Scope                                                                                                                                  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------- |
| H1–H2 | Bodies and phases for MCP and Hooks; decide which commits present a grant and check it at commit.                                      |
| H3    | Enable `monitor_run` and background Shell; task events and output; `draining`; bound the rebuild; keep old readers away from Sessions. |
| H4–H5 | Child and Channel bodies; dispatchers that drain the outbox; task cancel.                                                              |
