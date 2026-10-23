# Managed Workspace: `todo_write` on the `/3` profiles

[中文](2026-10-22-managed-workspace-fetch-and-todos.zh-CN.md) | English

> Scope note: this document was first written for a change that added both
> `web_fetch` and `todo_write`. A recorded maintainer ruling on the issue
> defers native web fetch, so the delivered change is the `todo_write` slice
> only. The fetch analysis is kept below as the reason it is not delivered.

## Problem

A Managed Agent Workspace Session offers six tools: `read_file`, `write_file`,
`edit`, `glob`, `run_shell_command` and `monitor`. The shared core already has
`todo_write`, and a `qwen serve` session exposes it. The Managed path never
declares it, so a long multi-step task has no plan surface of its own.

Issue: [#15076](https://github.com/QwenLM/qwen-code/issues/15076).

## Current state

The tool surface of a Workspace Session is declared and admitted in one place
(`packages/cli/src/serve/hosted-workspace-tool-turn.ts`), executed by the
Runtime Broker and its worker, and partially re-validated by the Java control
plane.

| Layer             | Where                                                                                  | Role today                                                        |
| ----------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Declaration list  | `HOSTED_WORKSPACE_FILE_TOOLS`, `..._SHELL_TOOLS`, and their `/2` variants              | What the model is offered                                         |
| Admission         | `prepareRequests` in `HostedWorkspaceToolTurn.executeNative`                           | Refusal text per tool, batch by batch, with no Runtime work spent |
| Approval          | `hostedApprovalAsks` in `hosted-tool-approval.ts`                                      | Per-mode pre-approval                                             |
| Action preview    | `HOSTED_INPUT_PREVIEW_TOOLS` here and `PREVIEW_TOOLS` in `ManagedActionService` (Java) | Which approvals carry their input                                 |
| Broker            | `POST /executions:*` (Java `RuntimeBrokerService`)                                     | Rejects a call that is not a Worker-known tool                    |
| Worker            | `ADMITTED_TOOL_NAMES` and `createManagedToolSet` in `managed-runtime-tool-executor.ts` | The allow-list that runs                                          |
| Worker (provider) | `ManagedRuntimeProviderWorker.createRuntime` in `managed-runtime-provider-worker.ts`   | The per-Session tool set for Workspace-bound sessions             |

Two profiles are current: `/1` (`files`, `shell`) and `/2` (each plus `glob`).
A profile name is persisted with the Session definition, and a load that names
a different profile is refused with `409 hosted_tool_profile_conflict`
(`hostedWorkspaceProfileConflictRefusal` in `hosted-harness-session.ts`). So a
new tool cannot widen an existing profile: a tool a `/1` or `/2` Session was
never offered would become callable on its next load.

## Proposed change

Add `todo_write` through two new profiles:

- `hosted-workspace-files/3` — `read_file`, `write_file`, `edit`, `glob`,
  `todo_write`
- `hosted-workspace-shell/3` — the same five plus `run_shell_command` and
  `monitor`

`/3` borrows its tool array from the `/2` declarations and appends one new
declaration, so the existing declarations stay byte-identical.

`hosted-workspace-team-lead/1` and `hosted-workspace-read/1` do not gain the
tool. A team lead is a Session the control plane creates internally, and the
read profile belongs to a snapshot child that must not write.

### Design decisions

1. **A new profile version, not a change to `/1` or `/2`.** Tool admission
   rests on what the Session's own profile offered. Adding a name to `/2`
   would make an existing `/2` Session's next load expose a tool its earlier
   turns never had. The precedent is the `glob` change (`#13166`), which added
   `/2` for the same reason.
2. **`web_fetch` is not delivered, by a recorded decision.** On the issue, a
   maintainer ruled that native fetch is deferred and that a Managed Session
   should keep using `run_shell_command` for the web. Two facts make that
   ruling the technical answer here as well. First, the egress argument does
   not hold for a files-profile Session: it has no shell, so a fetch there
   would open a new outbound path rather than reuse an existing one. Second,
   nothing in the Hosted path constrained the destination: the admission check
   that revision carried covered the scheme, credentials and length but not the
   host, `isPrivateHost` was only used to skip the https upgrade, and under
   `yolo` neither the Worker (built with `ApprovalMode.YOLO`) nor the Harness
   would have asked. A files/3 Session would therefore have reached link-local
   and metadata endpoints unattended. Delivering it needs a destination policy
   first, which is follow-up work.
3. **`todo_write` runs inside the Worker and writes no Workspace file.** The
   list is bookkeeping in the Worker's runtime directory. It does not touch
   the Session Store schema, Java storage, or the Workspace, which is also why
   it is safe to pre-approve.
4. **The list is scoped to one turn, and the tool says so.** The Worker's tool
   set is keyed by the Runtime session id, and the Harness derives that id per
   turn (`hostedRuntimeSessionId(promptId)` returns the prompt id). The Worker's
   runtime directory is likewise per Runtime instance. So the stored list does
   not survive into the next turn. The declaration therefore promises a list
   for the current turn only, and no reminder path is claimed: the reminder a
   local Session shows is injected by the model loop, which runs in the Harness
   and never sees this Worker's `Config`. Making the list durable needs a
   stable Session identity supplied to the Worker by the Harness — a protocol
   change recorded below, not implied by this profile.
5. **The Worker opts in to the tool explicitly.** Core defaults
   `todoWriteEnabled` to false and the operator-facing path gates registration
   on it. The Worker config that serves the hosted profiles sets it to true,
   so the tool is admitted because the profile says so, not because a default
   was bypassed. Only that lane registers the tool: the provider lane serves
   the resident and CSI sessions, whose manifests are a closed set, so it stays
   untouched exactly as the `glob` change left it. No code running inside the
   Worker reads the flag today, so this keeps the Config truthful and records
   the intent rather than switching behaviour.
6. **Approval.** Under `default` and `auto-edit` the tool is pre-approved: it
   writes only its own bookkeeping and changes no file the user owns. Under
   `yolo` nothing asks, as today.
7. **Input validation stays model-correctable.** A refused argument never
   acquires the mount. `todo_write` requires a `todos` array whose items
   repeat the shape the core tool validates: nonempty `id` and `content`,
   `status` one of the three states, and an optional `blockedBy` array of ids.
   The exact rules stay in the core tool; admission checks only what it must
   to keep a malformed call out of a durable Runtime round trip.
8. **Plan mode is unchanged.** `todo_write` writes, so it does not join the
   public plan-mode read set. `/3` Sessions also cannot enter public plan mode
   today: the constructor admits only `files/1`, `shell/1` and `shell/2`, so
   this change adds no plan-mode branch that the build cannot reach.
9. **The team board stays the team surface.** The hosted profiles already
   declare `task_list`, `task_create` and `task_update`, which are scoped to a
   team and read by its lead. They are not a single-session plan surface, so
   they do not satisfy this request. A team member pinned to `/3` is offered
   both; the board takes precedence, and `todo_write` is that member's own
   scratch plan for the current turn, which its lead never reads.

### Follow-ups this design does not cover

- **A destination policy for `web_fetch`** (allowlist or denylist, plus a
  decision on private and metadata hosts), after which the fetch half can be
  re-proposed. It is not a rollout toggle today.
- **A stable Session identity for the task list**, so the plan survives a
  turn. This needs the Harness to pass a stable hosted Session id to the
  Worker, and a decision on where that list is stored across Runtime
  instances.
- **Java profile predicates for `/3`.** `WorkspaceToolProfiles` is exact-match:
  `lifecycleProtocol("hosted-workspace-files/3")` returns 0, `isPublicShell`
  covers only `/1` and `/2`, and `supportsApprovalSelection` requires exactly
  `files/1` or a public shell. Enabling `/3` therefore needs Java predicate
  work, not only a configuration change.
- **Projecting the task list to Web Shell or another client** as a durable
  Session record.
- **Enabling `/3` in the production connector.** Which deployment pins `/3`
  is a rollout decision, as it was for `/2`. It requires every Worker upgraded
  and old incarnations drained first, as the `/2` ledger entry records: the
  `managed-runtime-tools/1` and `preapproved-workspace-tools/1` inputs, and
  the `capabilityDigest` derived from them, do not distinguish a Worker that
  admits `todo_write` from one that does not. An un-drained Worker answers the
  call with `409 managed_runtime_identity_conflict` after acquisition and
  dispatch, not with a pre-dispatch refusal the model can correct.

## Files affected

| Area                                | File                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Profiles                            | `packages/cli/src/serve/hosted-workspace-profiles.ts`                                                              |
| Declaration, admission, preview set | `packages/cli/src/serve/hosted-workspace-tool-turn.ts`                                                             |
| Argument validation                 | `packages/cli/src/serve/hosted-workspace-tool-input.ts`                                                            |
| Approval                            | `packages/cli/src/serve/hosted-tool-approval.ts`                                                                   |
| Worker admission and tool set       | `packages/cli/src/serve/managed-runtime-tool-executor.ts`                                                          |
| Java action preview                 | `packages/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/session/ManagedActionService.java` |
| Tests                               | Collocated `*.test.ts` files, and the Java test for the preview set                                                |

No TypeScript change to `packages/core`. No Java Broker change: the Broker
admits a payload for any tool name the Worker knows, and
`managed-runtime-tools/1` keeps its identity.

## Acceptance criteria

1. A `hosted-workspace-files/3` Session declares `todo_write` next to the four
   file tools; a `hosted-workspace-shell/3` Session declares it next to the
   shell tools. Neither declares `web_fetch`.
2. A `/1` or `/2` Session still refuses `todo_write` with the existing
   `Hosted Workspace profile refused a tool call.` error and spends no Runtime
   work.
3. A malformed `todo_write` argument earns a model-correctable refusal,
   committed as a tool result, without acquisition, reservation or dispatch.
4. Under `default` and `auto-edit`, `todo_write` runs without an approval
   request.
5. The Worker admits `todo_write`, keeps the list for the Session's calls, and
   refuses a dependency cycle. The Worker rejects `web_fetch` even though core
   still implements it.
6. Java's action preview returns the input for `todo_write`.
