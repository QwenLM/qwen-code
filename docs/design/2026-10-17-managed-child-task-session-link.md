# Managed child task to child Session link (H4f F2)

[English](2026-10-17-managed-child-task-session-link.md) | [简体中文](2026-10-17-managed-child-task-session-link.zh-CN.md)

Status: implemented in this change. A `child_agent` or `workflow` task names the child Session that runs it: `PublicTask.child_session_id` and `WebShellTask.childSessionId`, served in contract `1.55.0`. No new route, authorization rule, migration or event type.

This is F2 of [#13746](https://github.com/QwenLM/qwen-code/issues/13746), slice H4f of [#12827](https://github.com/QwenLM/qwen-code/issues/12827), stage H of the Managed Agent proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380). [The H4f note](2026-10-10-managed-task-cancel.md) (decision 9) left two ways to expose a child task's output: link the task to its child Session, or relay the child's output as task events behind `read_output`. This change takes the link.

## Problem

Since H4b a child run is a real task. A caller can list it, watch its `state_changed` events and, since H4f, cancel it, but cannot read what it produced. A child task advertises no `read_output`, so its event stream has no `output` events, and its `artifact_refs` stay empty because the child's final text is not published as an Artifact. The output exists: it is the child Session's own transcript. Nothing on the task says which Session that is.

## Current state

Checked at `3bddf6e0bb` (contract `1.51.0`, schema V6).

- **The child Session id lives in the run's record.** The `child_run` body of both child Session kinds carries `childSessionId` (`ManagedExtensionRecords.java:179`). It starts null (`:1126`), is set once (`:1191`), and must be non-null once the run is attached or settled after an attach (`requireChildSession`, `:957`). The attach revision sets it (`childAttachBody`, `managed-child-operations.ts:460`), which the result relay sends once the child is bound (`ChildResultRelay.java:878`). A terminal verdict can also name a minted child that never started (`managed-child-operations.ts:501`). The Shell kind of `child_run` has no such key.
- **The task row does not carry it.** `ma_session_record` holds only the projection columns (task kind, state, Runtime state, delivery, times) and a `record_resource_id` that points at the latest committed body. The task view is built from that row alone (`ManagedTaskService.publicTask`/`webShellTask`), and `PublicTask.session_id` is always the parent.
- **The child Session is already readable by the task's readers.** A child Session is a plain PUBLIC Session inserted with the parent's tenant and `workspace_id` (`ManagedAgentStore.insertChildSession`, `:663`). Every Session read route goes through `requireReadableSession` (`ManagedAgentService.java:1600`), which checks only that the Session is not deleted and that the caller can read its Workspace. So whoever can read the parent's task can already read the child's Session, Turns, items and events; Session lists do not filter children either. The only missing piece is the child's id.
- **Nothing public names a child Session today.** The OpenAPI has no child Session field anywhere.

## Decisions

1. **Link, do not relay.** The task view gains one optional field naming the child Session. The caller reads the child's output through the routes that already serve it: Session, Turns, items, events and their WebShell mirrors. Relaying would copy the transcript into the bounded task journal under the retention floor and the Artifact visibility barrier, and `read_output` is fixed for a task's life; the link needs none of that.
2. **Only the two child Session kinds carry it, and only once the record names the child.** `child_agent` and `workflow` tasks carry the field when the run's latest committed body has a non-null `childSessionId`: from the attach on, or on a terminal verdict that names a minted child. Before that the field is absent, as it is for `background_shell`, `monitor` and `automation_run`. The contract states the kind rule as a conditional on both task schemas. The lineage edge on `ma_session` exists from the mint, but the H4b rule is that the parent learns of the child at attach and never by inference, so the view reads the record and not the lineage.
3. **The view reads the committed body; there is no new column.** The body is the only place the fact lives. A projected column would need a migration (V7 is already claimed by an open pull request), a backfill for rows committed before it, and a writer change on every revision, to save one inline resource read per child task. The task view already makes one query per task (its event cursor positions), so the extra read keeps the same shape and applies only to child kinds. Only the two view paths read it: the cancel admission's task lookup stays a pure projection read. Record bodies are collected only once their Session is retired, so a revision that lands between the row read and the body read leaves the previous body readable, and the view reports the record as of that previous revision.
4. **No new authorization.** The child inherits the parent's Workspace, so the set of callers that can read the task equals the set that can read the child. The link discloses an id only to callers who could already find the child among the Sessions they can list.
5. **No final-text publication.** Publishing the child's final text as a task Artifact (the task panel note's follow-up) stays separate. A caller that wants the final answer reads the child's newest assistant item.

## Contract changes (1.55.0)

- `PublicTask` gains `child_session_id` and `WebShellTask` gains `childSessionId`: optional, `format: uuid`, served (no marker). Each schema adds a conditional that forbids the field for any kind other than `child_agent` and `workflow`.
- `info.description` gains the v1.55 paragraph.
- The generated WebShell types gain `childSessionId`.

## Validation

- **Real records** (`ManagedExtensionRecordStoreTest`): a `child_agent` chain committed through the Session store names no child before its attach, on both surfaces; from the attach on, detail and list on both surfaces name it, and the settled run still names it. The workflow chain names its child the same way. A background Shell row and a Monitor task name none.
- **Contract** (`ManagedAgentApiContractTest`): a served child task carries `child_session_id` on the public route and `childSessionId` on the WebShell route, each validated against its schema; a workflow task whose record names no child omits it. `recordsMatchTheirSchemas` pins the DTO components against the schema properties.
- **Schema** (`PlannedTaskContractTest`): both child kinds accept the field and its absence, a malformed id is refused, and `background_shell`, `monitor` and `automation_run` refuse it, on both surfaces. Removing the kind conditional fails these cases.
- **Types**: the regenerated WebShell types pass their freshness test, and the WebShell package typechecks.
- **Real stack** (FG9, `HostedSessionRelayFaultGatesIT`, MySQL 8.4, packaged Harness): in all six cases, a team member runs as a `child_agent` task of its lead. The lead's public task view names the member's child Session in `child_session_id`, the same Session the member's committed `child_run` record attached, and that Session reads through the public Session route. Both letters pass.
- **Not run:** the MySQL integration lane, and reading the child's Turns and Items through the link beyond the Session itself.

## Follow-up work

| Item                   | Scope                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WebShell task panel    | Show the link in the task detail and open the child Session's transcript from it.                                                                      |
| Final-text publication | Publish a child's final text as a task Artifact, so `artifact_refs` carries it ([task panel note](2026-10-12-managed-child-task-panel.md), follow-up). |
