# Managed Workspace: `web_fetch` and `todo_write`

[中文](2026-10-22-managed-workspace-fetch-and-todos.zh-CN.md) | English

## Problem

A Managed Agent Workspace Session offers six tools: `read_file`, `write_file`,
`edit`, `glob`, `run_shell_command` and `monitor`. The shared core already has
`web_fetch` and `todo_write`, and a `qwen serve` session exposes both. The
Managed path never declares them, so a Managed Session cannot read a web page
and cannot keep a task list.

Without `web_fetch`, a session that must read a changelog, an issue page or a
library document has to run `curl` through `run_shell_command`, and every such
call asks for approval under the default and auto-edit approval modes. Without
`todo_write`, a long multi-step task has no durable plan of record, so
progress and intent are lost between turns.

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
new tool cannot widen an existing profile: a Tool a `/1` or `/2` Session was
never offered would become callable on its next load.

## Proposed change

Add both tools through two new profiles:

- `hosted-workspace-files/3` — `read_file`, `write_file`, `edit`, `glob`,
  `web_fetch`, `todo_write`
- `hosted-workspace-shell/3` — the same six plus `run_shell_command` and
  `monitor`

`/3` borrows its tool arrays from the `/2` declarations and appends the two
new declarations, so the six existing declarations stay byte-identical.

`hosted-workspace-team-lead/1` and `hosted-workspace-read/1` do not gain the
tools. A team lead is a Session the control plane creates internally, and the
read profile belongs to a snapshot child that must not fetch or write.

### Design decisions

1. **A new profile version, not a change to `/1` or `/2`.** Tool admission
   rests on what the Session's own profile offered. Adding a name to `/2`
   would make an existing `/2` Session's next load expose tools its earlier
   turns never had. The precedent is the `glob` change (`#13166`), which added
   `/2` for the same reason.
2. **`web_fetch` runs inside the Worker, through the Runtime's existing
   outbound channel.** A Hosted Session already reaches the network through
   `run_shell_command` in the same Worker, with the same egress path and the
   same trust boundary. Running `web_fetch` there adds no new network policy
   and no new host. What it must add is the removal of the three local side
   effects a local `qwen serve` session accepts:

   | Side effect            | Local behaviour                                                                           | Managed behaviour                                               |
   | ---------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
   | Binary payload to disk | PDFs and images are saved under the tool-results directory and the model is told the path | Refused with a refusal the model can act on; no file is written |
   | Response cache         | A 15-minute in-memory cache per Session                                                   | Disabled, so every fetch is a real request                      |
   | Summarizing side query | Content is summarized by a fast-model call                                                | Disabled; the fetched content is returned as text               |

   The side query is a second model call from inside the Worker that the
   Session's own token accounting does not see, so turning it off also keeps
   the fetch within the Session's recorded cost.

3. **`todo_write` runs inside the Worker and is not persisted as a Session
   record.** The tool needs its own file store, and the Worker gives one per
   Session. The file is bookkeeping the model reads back on its next call. The
   task list also enters the model's context because the Worker appends active
   todos to its own instructions, so the plan survives across turns of a
   Session. Projecting the list to clients as a durable record is a separate
   change; this one does not touch the Session Store schema, Java, or Web
   Shell.

4. **Approval.** Under `yolo`, nothing asks, as today. Under `default` and
   `auto-edit`, `todo_write` is pre-approved: it writes only its own bookkeeping
   and changes no file the user owns. `web_fetch` asks, because it reaches a URL
   that nobody in the Session chose. This matches the local experience, where a
   pre-approved URL list in settings can spare the question; the Hosted path has
   no per-Session URL allowlist, so it asks. The approval card carries the
   call's input, so the URL, prompt and format are visible before the operator
   answers, exactly as for `run_shell_command`.

5. **Input validation is per-tool and stays model-correctable.** A refused
   argument never acquires the mount. `web_fetch` requires a nonempty `url` that
   starts with `http://` or `https://`, carries no embedded credentials, and is
   at most 2048 bytes, plus a nonempty `prompt` and an optional `format` from
   the fixed set. `todo_write` requires a `todos` array, and each item must
   repeat the shape the core tool validates: nonempty `id` and `content`,
   `status` one of the three states, and an optional `blockedBy` array of ids.
   The exact checks stay in the core tools; admission checks only what it must
   to keep a malformed call out of a durable Runtime round trip.

6. **Plan-mode and Hook gates follow the existing sets.** A public plan-mode
   turn admits reads only; `web_fetch` joins `HOSTED_PUBLIC_PLAN_READS` because
   it only reads the network, and `todo_write` does not, because it writes.
   A member run in plan mode keeps its narrower set unchanged.

### Follow-ups this design does not cover

- Projecting the task list to Web Shell or an interactive client as a durable
  Session record.
- A per-Session URL allowlist or denylist for `web_fetch` in managed
  deployments.
- Enabling `/3` in the production connector. This change adds the profiles,
  the Worker admission and the admission rules; which deployment pins `/3` is
  a rollout decision, as it was for `/2`.

## Files affected

| Area                                            | File                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Profiles                                        | `packages/cli/src/serve/hosted-workspace-profiles.ts`                                                              |
| Declaration, admission, preview set, plan reads | `packages/cli/src/serve/hosted-workspace-tool-turn.ts`                                                             |
| Approval                                        | `packages/cli/src/serve/hosted-tool-approval.ts`                                                                   |
| Worker admission and tool set                   | `packages/cli/src/serve/managed-runtime-tool-executor.ts`                                                          |
| Provider worker tool set                        | `packages/cli/src/serve/managed-runtime-provider-worker.ts`                                                        |
| Tunnel fetch behaviour                          | `packages/core/src/tools/web-fetch.ts`                                                                             |
| Java action preview                             | `packages/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/session/ManagedActionService.java` |
| Tests                                           | Collocated `*.test.ts` files, and the Java test for the preview set                                                |

No Java Broker change is needed. The Broker admits a payload for any tool name
the Worker knows, and `managed-runtime-tools/1` keeps its identity.

## Acceptance criteria

1. A `hosted-workspace-files/3` Session declares `web_fetch` and `todo_write`
   next to the four file tools; a `hosted-workspace-shell/3` Session declares
   them next to the shell tools.
2. A `/1` or `/2` Session still refuses both names with the existing
   `Hosted Workspace profile refused a tool call.` error and spends no Runtime
   work.
3. A malformed `web_fetch` or `todo_write` argument earns a model-correctable
   refusal, committed as a tool result, without acquisition, reservation or
   dispatch.
4. Under `default` and `auto-edit`, `todo_write` runs without an approval
   request and `web_fetch` asks before dispatch, with the URL in the Action's
   input preview.
5. The Worker executes both tools, and `web_fetch` writes no file and returns
   the page text itself.
6. Java's action preview returns the input for both tools.
