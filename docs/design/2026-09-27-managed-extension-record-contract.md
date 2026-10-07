# Managed Extension Record Contract (H0b)

[English](2026-09-27-managed-extension-record-contract.md) | [简体中文](2026-09-27-managed-extension-record-contract.zh-CN.md)

Status: contract defined; the Session authority commits these records since H0c ([design](2026-09-27-managed-extension-authority.md)), and no Stage H domain is enabled for submission yet. H0c added the rule that a running or waiting run cannot rest on an execution that never started, before any producer existed, with four refused cases that it labeled by hand; the H0c follow-up of [#13300](https://github.com/QwenLM/qwen-code/issues/13300) then mapped the never-claimed `cancelled` settle this page describes. Updated: 2026-10-04. This is slice H0b of [#12827](https://github.com/QwenLM/qwen-code/issues/12827), stage H of the Managed Agent proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380). Below, "the reference design" is sections 3, 10, 12 and 13 of the proposal's [extension runtime design](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md), with the `OperationGrant` of its [private control protocol](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-control-protocol.md) and the domain index of its [Session storage design](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-session-storage.md), at the commit that #12827 pins.

## Problem

Stage H brings seven capabilities onto the Managed path: MCP, Hooks, background Shell and Monitor, child agents, workflows and teams, Channels, and automation. On that path a Runtime can be reclaimed and a Harness replaced, so the reference design makes every asynchronous capability a durable resource plus a trigger intent, with stable identities, receipts and a single task projection. If each slice invented its own run states, maintenance grant, failure reasons and identity rules, Java, qwen and the Runtime would each read "unknown" or "settled" differently, and no projection could merge them.

H0b fixes the records the seven capabilities share before anything commits them, as the attestation, Tool v2, `managed-context/1` and `managed-tool-result/1` contracts did for their slices. H0c commits them with the Session authority and rebuilds the task list from them.

## Current state

The facts below are from `main` at `88d881491b`.

- **Domain index.** `packages/core/src/managed-runtime/managed-session-records.ts` has a closed index of 32 domain names. `domain.committed` carries a `recordRef` of kind `managed-<domain>` and schema version 1. Only `goal_state`, `session_metadata`, `file_history` and `session_source` are enabled for submission. The storage design lists 33 names in v1; the missing one is `monitor_run`, whose validator it assigns to H0.
- **Domain records.** `LocalManagedSessionAuthority.commitDomainRecord` publishes the record body with `operationId`, `revision` and `previousRecordRef` around the caller's content, and keeps one revision chain per domain.
- **Fences.** `ManagedActivationFence` exists in the activation store, the Session inbox and the embedded Harness scheduler. The code has no `OperationGrant`, `WakeIntent`, outbox or `SessionTaskView`.
- **Java.** The control plane's Session Store keeps the authority's journal as opaque transaction records and has no domain records. In the Runtime Broker, each `RuntimeBindingRecord` is one physical Runtime generation: a replacement gets a new binding ID and the next generation. The Broker's tool execution ledger has a line of the same kind, `PREPARED`, `DISPATCHING`, `EXECUTING`, `CANCEL_REQUESTED`, `SETTLED` and `UNKNOWN`, but not step for step. `EXECUTING` is entered before the Runtime receives the call, so it corresponds to `dispatch_started`. A cancelled `PREPARED` call, and a `DISPATCHING` call whose cancellation is seen before it is sent, settle as `cancelled` without being sent; a call cancelled after it was sent can also settle as `cancelled`, from the Runtime's own result. A `SETTLED` record with `cancelled` therefore covers both a call that was never sent, which maps to `not_started_proven`, and one that was sent and then cancelled, which maps to `settled`. The record's own ledger tells the never-sent case apart: `ToolExecutionRecord` refuses a claimed dispatch whose generation is not positive, so a `SETTLED` record with the status `cancelled` at `dispatchGeneration` 0 proves the call was never claimed. (The H0c follow-up of #13300 lands that proof: such a record maps to `not_started_proven`, past tense like the `Contract.` bullets above — a `PREPARED` or `ABANDONED` record at generation 0 maps elsewhere.) Nothing records whether a claimed call entered `EXECUTING`, so a claimed call that settles `cancelled` keeps the `settled` mapping, and telling that residue apart needs evidence beyond the settled record, which the slice that wires the mapping must bring. The mapping must still never map a call it cannot prove unsent to `not_started_proven`: the contract refuses `intent → settled`, but nothing in it catches a `not_started_proven` the record cannot prove — a `cancelled` or `failed` monitor run accepts it, and MCP allows the pair explicitly, but a `child_run` requires a `cancelled` run's execution to be `settled`, which the execution line will not reach from `intent` — and such a mapping would claim that work that may have run never started.
- **Legacy Monitor.** `MonitorRegistry` keeps monitors in memory with the statuses `running`, `completed`, `failed` and `cancelled`. `MonitorTool` caps `max_events` at 10,000 and `idle_timeout_ms` at 600,000, and records why a monitor stopped: a spawn error; after it started, a non-zero exit, a signal, binary output or a stream error, which also end it as `failed`; a natural exit, max events or idle timeout; or a stop request.

## Goals

- Define `OperationGrant` and when a Runtime's per-operation gate may replace one grant with another.
- Define the three state lines (logical run, physical execution, delivery and acceptance), their single steps, and the rules that tie them together, as one run block that every Stage H record embeds.
- Define the recovery and quota reasons a run may carry.
- Define the stable identities (`executionCallId` or `effectId`, `dispatchId`, `deliveryId`) and the Runtime binding, and how they may change.
- Define the `definitionRevision` pin and its consistency rule.
- Define the `monitor_run` record body and its revision rule, and register the domain without enabling it.
- Pin all of it with one shared schema and fixture file that TypeScript and Java both replay.

## Non-goals

- **Committing.** No authority commits these records, and there is no outbox, `WakeIntent` or `SessionTaskView` projection. H0c does that.
- **Enablement.** `monitor_run` joins the index but stays disabled for submission; enabling a domain remains a separate, explicit step.
- **Other bodies.** The record bodies of the other Stage H domains, and the phases each domain registers, belong to H1–H6.
- **Public API.** The task resources and their errors are H0a.
- **Runtime paths.** No Harness loop, Broker, worker or route changes.

## Decisions

1. **`monitor_run` joins the closed v1 index** (question 1 of #12827). The storage design at the pinned commit lists it among the 33 v1 names and leaves only its validator to H0. No v1 reader can meet a `monitor_run` record yet, because the domain stays disabled and nothing writes it, so the index keeps its version. Only `commitDomainRecord` checked that a domain is enabled: the authority's generic `appendExecution` and `appendExecutionEvent` accepted a `domain.committed` event from a `trusted_entry` actor for any name in the index, so H0c now enforces that check on every path that commits domain records — a domain record commits only through `commitExtensionRecord`, and a disabled domain is refused for submission there and on the generic paths. A reader from before this change refuses the name, so when H3 enables the domain, a Session that holds such records must keep those readers out, for example by raising its `minimumReader`. The name goes after `memory_job`, in the design's order.
2. **One run block, embedded by each record.** The shared state lines, reasons, identities, binding and pin form a closed `run` object inside each domain record, not a domain of their own. H0c rebuilds `SessionTaskView` from these blocks.
3. **The Java consumer lives in the control plane.** Section 1 of the reference design gives product records and the task projection to Java. Whichever side commits the records (question 2), Java reads them to build the projection, so `ManagedExtensionRecords` sits in `managed-agent-server` and reads Jackson trees like the rest of that module.
4. **A revision takes one step per line.** A later revision may leave each state line where it was or take one allowed step; an execution enters at `intent` and a delivery at `planned`. Every step, and the evidence it rests on, is then committed before the next one acts. A rule that accepted any reachable state would let `unknown → sending` pass as `unknown → partial → sending` without the partial delivery ever being recorded, which is the resend the reference design forbids.

Questions 2 and 3 of #12827 concern H0c and are not decided here. For question 4, H0b changes no runtime path and can land ahead of the tool-capable Hosted turn.

## Value rules

| Rule        | Values                                                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| id          | The Managed Session stable ID rule: a non-empty string of at most 512 UTF-8 bytes, well-formed, in NFC, with no C0, DEL or C1 character. |
| count       | A JSON integer from 0 to 2^53−2, the Managed Session sequence rule.                                                                      |
| revision    | A count from 1.                                                                                                                          |
| time        | UTC Unix milliseconds, a JSON integer from 0 to 8.64 × 10^15.                                                                            |
| generation  | Canonical decimal text from 1 to 2^63−1, the W0a rule for `workspaceGeneration`. Generations are compared as numbers, never as text.     |
| digest      | 64 lowercase hexadecimal characters.                                                                                                     |
| durable ref | The five `DurableRef` fields: `resourceId` and `kind` are ids, `schemaVersion` and `byteLength` are counts, `digest` is a digest.        |
| phase       | `[a-z][a-z0-9_]{0,63}`, the form of the phase names in the recovery design, such as `send_segment`.                                      |

Every record below is a closed JSON object: each key is required, and a key that may be empty holds `null`. A number with a zero fraction, such as `1.0`, counts as the integer it equals, as it does for JSON Schema's `integer` and for JavaScript; producers still write plain integers. Numbers are judged as the IEEE-754 doubles that a default JSON parser produces: JavaScript's, or Jackson's default mapper in Java; a number past the double range is no integer. NFC is judged with each runtime's Unicode data, and JDK 21 knows Unicode 15 while Node 22 knows a later version, so the two may disagree on a character assigned after Unicode 15; identifiers must stay within the characters Unicode 15 assigns.

## Operation grant

An `OperationGrant` lets the owner of an accepted operation finish its planned phases without a model activation: a Channel send after the turn ended, a configuration install, a history maintenance step, a Monitor rebuild. It never authorizes a model call or new business, and it is not a second Session epoch.

| Key                   | Rule                                                                     |
| --------------------- | ------------------------------------------------------------------------ |
| `sessionKey`          | `tenantId`, `workspaceId` and `sessionId`, each an id                    |
| `operationId`         | id                                                                       |
| `domain`              | one of the 33 names of the v1 domain index                               |
| `operationRevision`   | revision: the authority's control version for this grant                 |
| `ownerId`             | id: the owner that holds the grant                                       |
| `workspaceGeneration` | generation                                                               |
| `resourceScope`       | `recordRef` and `phases`, below                                          |
| `leaseDurationMs`     | 1,000 to 300,000, the bounds of the durable Session store's writer lease |
| `expiresAt`           | time                                                                     |

- **Scope.** `recordRef` is the committed domain record that holds the operation's plan. Its kind must be `managed-<domain>` and its schema version 1, the pairing `domain.committed` already requires, so a grant cannot point at another domain's plan. `phases` lists the 1 to 16 distinct phases of that plan the grant admits. Which phases a domain has is registered with its body in H1–H6; H0b fixes their form.
- **No activation fields.** The record is closed, so an `epoch` or `activationId` is refused: a grant is not an activation.
- **Replacement.** A Runtime's per-operation gate may replace grant `a` with grant `b` only when both are valid, name the same Session, operation and domain, and either
  - `b` renews `a`: the same revision and every field equal, phases in the same order, except a later `expiresAt`; or
  - `b` is a later revision whose `workspaceGeneration` is not older than `a`'s. A later revision may change the owner, scope and lease.

  An earlier revision is stale, and so is a renewal that does not extend the lease. An identical grant replaces nothing: installing it again is idempotent at the gate, which answers as it did before.

  The rule compares two grants and cannot see the gate's history, so revocation is gate state kept outside it. As the control protocol requires, the gate never reopens a revision it revoked: it refuses a renewal of that revision, and installing that grant again leaves it revoked; only a later revision can reopen the operation. H0c keeps this state with the gate.

## State lines

A run is described by three separate lines. None may stand in for another: a settled run does not prove its process drained, an accepted result does not prove the model consumed it, and a completed model turn does not prove a Channel delivered its reply.

**Logical run** — whether the business was admitted and has ended.

| From                             | Allowed next states                                             |
| -------------------------------- | --------------------------------------------------------------- |
| `reserved`                       | `admitted`, `failed`, `cancelled`                               |
| `admitted`                       | `running`, `waiting`, `failed`, `cancelled`, `recovery_blocked` |
| `running`                        | `waiting`, `settled`, `failed`, `cancelled`, `recovery_blocked` |
| `waiting`                        | `running`, `settled`, `failed`, `cancelled`, `recovery_blocked` |
| `recovery_blocked`               | `running`, `waiting`, `settled`, `failed`, `cancelled`          |
| `settled`, `failed`, `cancelled` | none                                                            |

**Physical execution** — what a Runtime, process or remote call actually did.

| From                                       | Allowed next states                                                               |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `intent`                                   | `dispatch_started`, `not_started_proven`, `outcome_unknown`, `corrupt`            |
| `dispatch_started`                         | `running_attached`, `settled`, `not_started_proven`, `outcome_unknown`, `corrupt` |
| `running_attached`                         | `settled`, `outcome_unknown`, `corrupt`                                           |
| `outcome_unknown`                          | `running_attached`, `settled`, `not_started_proven`, `corrupt`                    |
| `settled`, `not_started_proven`, `corrupt` | none                                                                              |

A dispatch that the Runtime refuses before any side effect proves nothing started. An unknown outcome leaves `outcome_unknown` only on evidence: a re-attach, including a Monitor watch rebuilt under a later generation, the original system's result, or its proof that the work never ran. `corrupt` is final, so its run stays `recovery_blocked`: the reference design defines no way out, and a user can still query it, request its cancellation or close the Session.

**Delivery and acceptance** — whether a result reached a Channel or a parent Session, and whether the model consumed it.

| From                                             | Allowed next states                            |
| ------------------------------------------------ | ---------------------------------------------- |
| `planned`                                        | `sending`, `accepting`, `cancelled`            |
| `sending`                                        | `delivered`, `partial`, `unknown`, `rejected`  |
| `partial`                                        | `sending`, `unknown`                           |
| `accepting`                                      | `accepted`, `unknown`, `rejected`              |
| `accepted`                                       | `consumed`                                     |
| `unknown`                                        | `delivered`, `partial`, `accepted`, `rejected` |
| `delivered`, `consumed`, `rejected`, `cancelled` | none                                           |

A delivery has a target. A `channel` delivery uses `planned`, `sending`, `partial`, `delivered`, `unknown`, `rejected` and `cancelled`; a `session` delivery uses `planned`, `accepting`, `accepted`, `consumed`, `unknown`, `rejected` and `cancelled`. `consumed` belongs to acceptance only: a Channel has no model to consume a reply. An unknown delivery never returns to `sending` or `accepting`; a resend is a new delivery with a new `deliveryId`. `partial` returns to `sending` only to send the segments proven unsent.

## Run block

Every Stage H record embeds one closed `run` object.

| Key               | Rule                                                                    |
| ----------------- | ----------------------------------------------------------------------- |
| `state`           | a logical run state                                                     |
| `reason`          | null, a recovery reason or a quota reason                               |
| `definition`      | null or a definition pin                                                |
| `executionCallId` | null or id: the `tool.intent` identity of a tool-started run            |
| `effectId`        | null or id: the effect identity of a domain phase                       |
| `dispatchId`      | null or id: a dispatch to another Session                               |
| `deliveryId`      | null or id: an external delivery                                        |
| `execution`       | null or a physical execution state                                      |
| `runtime`         | null, or `runtimeBindingId` (id) and `generation` (generation)          |
| `delivery`        | null, or `target` (`channel` or `session`) and a `state` of that target |

**Identities and binding.**

- A run names at most one physical identity: `executionCallId` or `effectId`, never both, and one of them whenever `execution` is set.
- `runtime` requires an `execution`: a binding exists only for a physical execution. An execution without one runs in a domain adapter, such as a Channel sender.
- `deliveryId` is set exactly when the delivery targets a Channel. A Session delivery needs no ID of its own: the run identifies it, with its `dispatchId` when it crosses Sessions.

**States.**

- A `reserved` run has no execution and no delivery: nothing is dispatched before admission.
- While the execution is `outcome_unknown` or `corrupt`, the run is `recovery_blocked`, so an outcome that nobody can prove never passes for a result.
- A `settled`, `failed` or `cancelled` run has no execution, or one proven to have ended: `settled` or `not_started_proven`. A `settled` run's execution cannot be `not_started_proven`, and neither can a `running` or `waiting` run's, since nothing is left to run.
- A `session` delivery beyond `planned` or `cancelled` needs a run that ended: a parent accepts a result only after it exists.

**Reasons.**

| State                                          | `reason`                                                      |
| ---------------------------------------------- | ------------------------------------------------------------- |
| `recovery_blocked`                             | a recovery reason, required                                   |
| `running`, `waiting`                           | null, or a recovery reason: the run goes on in a degraded way |
| `failed`                                       | null, or a quota reason                                       |
| `reserved`, `admitted`, `settled`, `cancelled` | null                                                          |

- `outcome_unknown` requires an execution in `outcome_unknown`; `execution_corrupt` is the reason exactly when the execution is `corrupt`; `runtime_lost` requires the `runtime` it lost, and a run blocked on it is not `running_attached`; `dispatch_unknown` requires a `dispatchId`.

**Revisions.** A later revision of the same run must satisfy all of the following:

- Each state line stays where it was or takes one allowed step. An execution first appears as `intent` and a delivery as `planned`; once present, neither goes back to null, and a delivery keeps its target.
- `executionCallId`, `effectId`, `dispatchId`, `deliveryId` and `definition` may be set once and never change after that. Like `runtime`, `definition` may first appear only while the previous revision's execution is null or `intent`, so a run never executes under a definition it is pinned to later.
- `runtime` is recorded with the dispatch: it may first appear only while the previous revision's execution is null or `intent`. It changes only when an `outcome_unknown` execution becomes `running_attached` again under a strictly later generation; the binding ID may then change too, since the Broker assigns one per generation.
- A run that ended changes only its delivery, plus the `deliveryId` of a first Channel delivery, so a result can be handed on after the run settled.

## Reasons

| Recovery reason       | Meaning                                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outcome_unknown`     | The work was dispatched and its outcome cannot be proven.                                                                                                                           |
| `execution_corrupt`   | The physical ledger or receipt is corrupt.                                                                                                                                          |
| `runtime_lost`        | The Runtime binding that owned the work was lost. A blocked run was not re-attached; a running or waiting run continues after a re-attach, and results from the gap may be missing. |
| `dispatch_unknown`    | A dispatch to another Session was sent and its admission is unknown.                                                                                                                |
| `handler_unavailable` | A registered handler, such as a function Hook, cannot be rebuilt.                                                                                                                   |

| Quota reason       | Limits it covers in section 12 of the reference design                                         |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `count_limit`      | connections, bindings, in-flight operations, processes, monitors, concurrent children, backlog |
| `rate_limit`       | triggers per period, event rate                                                                |
| `depth_limit`      | child depth                                                                                    |
| `byte_limit`       | log bytes, staged bytes                                                                        |
| `budget_exhausted` | model and tool budgets                                                                         |
| `duration_limit`   | Runtime duration                                                                               |

A capacity refusal before admission creates no record; a quota reason explains a run that was admitted or reserved and then failed on a limit.

## Definition pin

A pin is `definitionId` (id), `definitionRevision` (revision) and `definitionDigest` (digest): the immutable definition a run actually uses, such as a schedule, Hook catalog, MCP server or AgentBundle revision. Two pins with the same `definitionId` and `definitionRevision` must have the same digest, because a revision never names two contents. A run is pinned no later than its dispatch and keeps its pin, so a definition update affects only later runs.

## Monitor run

A `monitor_run` record body, kind `managed-monitor_run` and schema version 1, holds exactly these keys, which cover the list in section 10 of the reference design. This is the content the domain record carries; `commitDomainRecord` currently adds `operationId`, `revision` and `previousRecordRef` around its content, and H0c decides how that envelope and the content are kept apart.

| Key                   | Rule                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `monitorId`           | id                                                                                                                                              |
| `ownerScopeId`        | id: the activation scope that owns the monitor and receives its notifications                                                                   |
| `commandRef`          | durable ref: the start call's `argsRef`, which holds the command and its directory; its digest is the command/target digest                     |
| `maxEvents`           | 1 to 10,000                                                                                                                                     |
| `idleTimeoutMs`       | 1 to 600,000                                                                                                                                    |
| `debounceMs`          | 0 to 600,000: the window within which the Runtime aggregates output into one observation; any filter is part of the command behind `commandRef` |
| `startReceiptRef`     | null or durable ref: the physical start receipt of the current watch                                                                            |
| `observationSequence` | a count up to `maxEvents`: accepted meaningful observations, not raw lines                                                                      |
| `lastObservationRef`  | null or durable ref: the summary of the last observation                                                                                        |
| `notifiedThrough`     | a count up to `observationSequence`: the notification watermark                                                                                 |
| `stopReason`          | null, or why the monitor ended                                                                                                                  |
| `outputRef`           | null, or a `managed-tool-result-manifest` version 1 reference: the output Artifact                                                              |
| `run`                 | the run block                                                                                                                                   |

- **Run.** The run names the start call's `executionCallId` and nothing else: no `effectId`, `dispatchId`, `deliveryId`, `delivery` or `definition`. A Monitor notifies through its watermark, not through a delivery.
- **Observations.** `lastObservationRef` is set exactly when `observationSequence` is above 0.
- **Notifications.** The notification policy of v1 is fixed, so it needs no field of its own: every accepted observation is due for notification, and one notification may cover several of them. Only what reaches acceptance can be set, by the filter in the command and by `debounceMs`. The Legacy Monitor tool takes no policy argument either; it notifies every line that passes a fixed throttle, five at once and then one a second, and reports how many lines it dropped. Aggregation within `debounceMs` takes the throttle's place, and what an observation aggregated is part of its summary; the planned `SessionTaskView` has no dropped-line count. A policy that notifies only some accepted observations, such as every nth one, would change the body and so take a new record version.
- **Start receipt.** It is set once the watch has started: whenever there is an observation or the execution is `running_attached`. It is null while the execution is null, `intent`, `dispatch_started` or `not_started_proven`. A start receipt needs the run's Runtime binding, which issued it.
- **Stop reason.** It is set exactly when the run ended, and must fit the state: `settled` by `exited`, `max_events` or `idle_timeout`; `failed` by `start_failed`, `watch_failed` or `quota_exceeded`; `cancelled` by `stop_requested`. A `settled` monitor's execution is `settled` and it has a start receipt, since each of its stop reasons needs a watch that ran. `max_events` requires `observationSequence` equal to `maxEvents`. `start_failed` requires an attempted execution and no start receipt; `watch_failed`, a watch that ran and then failed, requires a start receipt. `quota_exceeded` is the stop reason exactly when the run's reason is a quota reason.
- **Revisions.** A later revision keeps `monitorId`, `ownerScopeId`, `commandRef`, `maxEvents`, `idleTimeoutMs` and `debounceMs`; its run is a successor; `observationSequence` and `notifiedThrough` never decrease; `observationSequence` grows only when the execution of either revision is `running_attached`, because a lost or ended watch observes nothing, and `lastObservationRef` changes only with a new observation; `outputRef` may change as the manifest gains revisions but is never removed; `startReceiptRef` is set once, a new Runtime binding must bring a new one, and nothing else changes it. Once the monitor ended, only `notifiedThrough` may still advance, so a final pending notification can still be delivered.
- **Rebuild.** A watch whose Runtime was lost is `recovery_blocked` with `runtime_lost` and an `outcome_unknown` execution. A target that is purely observational and can be rebuilt from its durable definition returns to `running` and `running_attached` under a later generation, with a new start receipt, and continues from the committed watermark; the run may keep `runtime_lost` as its reason to show that observations during the gap may be missing. No other target can be rebuilt, since running its command again could repeat side effects whose outcome is unknown: it stays blocked, and watching it again takes a new Monitor. A command counts as purely observational only when it is known to be read-only. The rebuild is a maintenance phase under an `OperationGrant`: its intent and dispatch are committed in that phase's physical ledger, keyed by Session, effect, phase and effect revision, and the monitor record commits only the outcome, the attach under the new generation. If the rebuild's outcome is unknown, the monitor stays blocked and nothing starts another watch. A rebuild starts only from `outcome_unknown`, never from a settled execution. A Monitor's execution describes its watch, which a rebuild continues under a later generation, not the process of the lost one, so learning that the process was lost with its Runtime does not rule a rebuild out: while the target can be rebuilt, H3 does not settle the execution on that proof. The execution settles when the watch itself ends, as when the command exits or fails on its own, reaches a limit or is stopped, or when a target that cannot be rebuilt is proven gone. Such a target then stays `recovery_blocked` until the monitor ends; H3 never returns it to `running` or `waiting`, although the record contract does not refuse that step (open question 5). A monitor that ended is never rebuilt.
- **Rebuild or new Monitor.** A rebuild continues the same monitor under the grant, without a model activation: it keeps the `monitorId`, start call, command and limits, continues from the committed watermarks, and replaces only the Runtime binding and start receipt. A new Monitor is a new start call under an activation, with its own identity, limits and watermarks and its own admission, approval and quota.

## Shared schema and fixtures

`packages/core/src/managed-runtime/contracts/managed-extension-record-v1.schema.json` and `.fixtures.json` hold the contract, beside the other Managed Runtime contracts.

- The domain index, limits, kinds, state lines, delivery targets, reasons and Monitor stop reasons, as constants.
- A canonical grant, pin, run block and monitor run.
- 568 cases: grants (140, one valid grant per domain among them), grant replacements (22), pins (25), pin pairs (7), run blocks (152), run revisions (61), monitor runs (118) and monitor revisions (43). Each invalid case is aimed at one rule.

The schema fixes each record's shape and every rule it can state readably, including all the state, reason and stop-reason rules. It cannot state UTF-8 byte limits, NFC, well-formed UTF-16, the 2^63−1 bound readably, a record kind derived from another field, or a bound that depends on another field; the TypeScript test lists the cases on which the schema and the module disagree. Its patterns follow ECMA-262, as draft 2020-12 specifies; a validator with other regular expression semantics, such as Java's default, may accept a trailing newline that both modules refuse. A Python implementation written from this document, independent of both languages and kept outside the repository as for `managed-tool-result/1`, labeled every case, and the generator stops when it disagrees with a label. The ten cases added for [#12887](https://github.com/QwenLM/qwen-code/issues/12887) item 1, and the monitor successor case re-isolated under the same runtime binding, come from a newly written Python reference instead, that generator being unavailable: it covered those eleven and its positive controls only, did not re-audit the remaining 557 labels, and reads only part of the schema, so the Ajv validation listed below stays the corpus's schema authority.

- **TypeScript.** `packages/core/src/managed-runtime/managed-extension-record.ts` parses grants, pins, run blocks and monitor runs, and checks grant replacements, pin pairs and revisions. The Session authority's record and projection modules have imported it since H0c.
- **Java.** `ManagedExtensionRecords` in `managed-agent-server` implements the same rules over Jackson trees. A test replays every case, checks every pair of states on every line, pins the constants, and validates the fixtures against the schema.

## Files affected

- `packages/core/src/managed-runtime/contracts/managed-extension-record-v1.schema.json` and `.fixtures.json` (new).
- `packages/core/src/managed-runtime/managed-extension-record.ts` and its test (new).
- `packages/core/src/managed-runtime/managed-session-records.ts` and its test: `monitor_run` joins the v1 index.
- `ManagedExtensionRecords` and `ManagedExtensionRecordContractTest` in `packages/sdk-java/managed-agent-server` (new).
- This design document in both languages (new).

No authority, store, Harness, Broker, worker, route or CI workflow changes.

## Validation plan

- **TypeScript:** strict Ajv validation of the fixtures against the schema; every case replayed through the module; every pair of states on every line checked against the fixture table; the schema checked against every record case.
- **Java:** every case replayed through `ManagedExtensionRecords`; every pair of states; the constants pinned; the fixtures validated against the schema with the networknt validator.
- **Mutation check:** each failure, early return, comparison and logical operator of the TypeScript module, each `require` and early return of the Java class, and in both each call that checks a single field, are mutated in turn and the suite of the same language rerun.

## Acceptance criteria

- In both languages, every malformed shape and every illegal transition in the fixtures is refused, and every valid case is accepted.
- The schema and the module disagree only on the listed rules that JSON Schema cannot state.
- `monitor_run` is in the v1 domain index and is still refused for submission.
- Existing behavior is unchanged but for one parsing change: `parseManagedSessionEvent`, and every path built on it, such as the authority's `open` and `appendExecution` and the storage scans, now accepts a `domain.committed` event whose domain is `monitor_run`, which it refused before. Appending one still meets the two refusals H0c added: domain records commit only through `commitExtensionRecord` — `commitDomainRecord` still refuses that domain for submission — and the enablement check refuses a disabled domain on the generic append paths.

## Open questions

1. **Phases.** A grant checks only the form of its phases. Should each H slice register its domain's phases in this contract, or with its own record body?
2. **Degraded.** Answered by H0c's Decision 5, which projects exactly `degraded` for a running or waiting run that carries a recovery reason.
3. **Revision chains.** Answered by H0c's Decision 3: one chain per record, keyed by the record body's own identity (`monitorId` for Monitors), with the envelope a commit adds kept apart from the closed record body it publishes.
4. **Corrupt executions.** A run whose execution is `corrupt` stays `recovery_blocked`. Should a later slice add an explicit operator command that closes such a run, and what evidence would it record?
5. **Leaving a block without a re-attach.** A run whose execution settled while it was `recovery_blocked` may still step to `running` or `waiting` under the contract, although nothing runs. Should the contract refuse that step? Doing so before any Stage H domain is enabled takes no record version.
6. **Notification content.** The body keeps only the last observation's summary, so a notification that covers several observations cannot name the others' summaries. Should H3 take them from the output behind `outputRef`, or commit one observation per revision? Neither needs another field.

## Follow-up work

| Slice | Scope                                                                                                                                                                                     |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H0c   | Commit domain records, the outbox and wake intents with the Session authority; issue and install grants; rebuild `SessionTaskView` from the run blocks after a restart.                   |
| H3    | Enable `monitor_run` and background Shell under their own admission, receipt, cancellation, quota and recovery checks, keeping readers from before H0b away from Sessions that hold them. |
| H1–H6 | The other domain bodies and their phases, each embedding the run block.                                                                                                                   |
