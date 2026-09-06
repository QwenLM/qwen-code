# Current-session entrypoints for daemon scheduled tasks

Status: Draft

Related: #8906, #9361, #9415

## Summary

PR #9361 added the daemon primitive this feature needs: scheduled-task create
requests may reuse an existing session by sending `sessionId`. The daemon
validates the live session, records it as caller-owned, keeps it resident, and
restores it after restart. A task bound this way continues to run in that
session even when the Web Shell selects a different conversation.

Two user entrypoints still cannot request that behavior. The Scheduled Tasks
form never sends the current session id, and `cron_create` has no current-session
mode. This design adds those entrypoints without changing the scheduler,
persisted ownership model, or either entrypoint's existing default behavior.

## Existing baseline

The merged #9361 contract is the source of truth:

- Omitting or passing `null` for `sessionId` creates a dedicated task-owned
  session.
- Passing `sessionId` reuses a live, idle session in the selected workspace and
  persists `sessionOwnedByTask: false`.
- A caller-owned session is not renamed or closed when its task is renamed or
  deleted.
- Archiving the bound session disables the task, unarchiving resumes it, and
  deleting the session removes the task.
- Enabled bound sessions are kept resident and rehydrated after daemon restart.
- A session may be bound to at most one scheduled task.

This REST behavior is different from the existing core tool behavior. A durable
task created by `cron_create` is unbound: it has no `sessionId` and fires through
the existing shared per-project lock owner. The tool does not mint a dedicated
task conversation today.

The scheduler already maps `task.sessionId` to `boundSessionId` and fires the
task only from the matching session. Session execution already serializes cron
turns behind active user turns.

## Goals

- Let the Scheduled Tasks form bind a new task to the currently selected
  ordinary conversation.
- Let a user explicitly request current-session binding through `cron_create`.
- Preserve the form's dedicated-session default and `cron_create`'s unbound
  durable default.
- Preserve the #9361 ownership, workspace, capacity, lifecycle, and unique
  binding checks.
- Fail clearly when the host cannot guarantee daemon-managed restoration.

## Non-goals

- Rebinding an existing task through PATCH.
- Binding more than one task to a session.
- Migrating task history between sessions.
- Binding a session with `parentSessionId`, a `channel`, `side_task`,
  `scheduled_task`, or explicit `standalone` source, a reserved Live Voice
  source id, an unknown source value, or an archived or non-live session.
- Changing the Scheduled Tasks page's existing "Create via chat" action, which
  intentionally starts a fresh conversation.
- Solving the remaining legacy teardown-versus-reuse race tracked by #9415.
- Changing token-limit or missed-fire policy.

## Public behavior

### Scheduled Tasks form

The create form gains a two-option session selector:

- **Dedicated task conversation** — default; omit `sessionId`, preserving the
  current behavior.
- **Current conversation** — send the selected session id in the existing
  `DaemonCreateScheduledTaskRequest.sessionId` field.

Here, current means the ordinary session selected by the outer Web Shell
connection (`connection.sessionId`), even while `mainView` is the Scheduled
Tasks page and the chat pane is covered. A visible chat pane is not required.
No selection disables the option. Split panes do not replace the outer selected
id and no pane implicitly wins; activity in a non-selected pane neither disables
the option nor supplies the `sessionId`.

The selected session is eligible only when it is top-level, has no `sourceId`,
and its `sourceType` is absent or `default`. This is the metadata shape of an
ordinary Web Shell conversation. The form rejects `channel`, `side_task`,
`scheduled_task`, and explicit `standalone` source values, any unknown source
value, and `default` paired with the reserved `realtime_voice:` source-id prefix.

The current-conversation option is shown only when the daemon advertises a new
`scheduled_task_session_reuse` capability. It is disabled with a reason when:

- there is no selected session;
- the selected session still has a running turn or pending interaction;
- the selected session is not an eligible top-level ordinary conversation;
- the form's selected workspace differs from the selected session's workspace;
  or
- the loaded task list already contains a task with that session id.

These checks are advisory. The daemon remains authoritative and the form
surfaces its existing `session_busy`, `session_already_bound`,
`session_workspace_mismatch`, `session_not_live`, and related errors.

Binding is selectable only during creation. Edit mode does not display or send
`sessionId`. Task cards keep the existing generic "View conversation" action,
which is correct for both dedicated and caller-owned sessions.

### `cron_create`

`CronCreateParams` gains:

```ts
sessionMode?: 'unbound' | 'current';
```

The default is `unbound`. `sessionMode: 'unbound'` and an omitted mode both use
the existing paths: durable tasks stay unbound and session-only jobs stay local
to the current process. `sessionMode: 'current'` is valid only when `durable` is
`true`, and the tool description instructs the model to use it only when the
user explicitly asks to keep scheduled work in the current conversation. The
permission-classifier projection includes `sessionMode`.

The entrypoints therefore have three explicit outcomes:

| Entry point and request                          | Persisted session binding                         | Execution ownership                    |
| ------------------------------------------------ | ------------------------------------------------- | -------------------------------------- |
| Form default, REST `sessionId` omitted           | Daemon mints a task-owned session                 | Dedicated task conversation            |
| Durable `cron_create`, mode omitted or `unbound` | No `sessionId`                                    | Existing shared per-project lock owner |
| `cron_create` mode `current`                     | Caller's session with `sessionOwnedByTask: false` | Caller-owned current conversation      |

Outside a daemon-managed ACP session, current mode returns a clear
`current_session_scheduling_unavailable` error. Unbound durable and session-only
jobs retain their existing paths.

## Architecture

### Why the REST path cannot be called directly from `cron_create`

The public #9361 endpoint requires a supplied session to be idle. A
`cron_create` tool call runs inside an active prompt, so its own session is
necessarily busy and a direct REST-equivalent call would return
`session_busy`.

The busy rule must remain unchanged for ordinary clients: an arbitrary caller
must not bind a session while a different turn is mutating it. Current-mode
tool creation therefore uses a daemon-only control path. This path trusts the
daemon-spawned workspace agent runtime; a shared ACP connection by itself cannot
prove that an arbitrary owned session id belongs to the exact executing turn.
The control request instead binds daemon-owned prompt state to identifiers
stamped inside the runtime, outside the model-visible tool arguments.

### Daemon control path

Core Config receives an optional `CurrentSessionScheduledTaskCreator`
capability, following the existing injected daemon-capability pattern. The ACP
Session implementation wires it to a new control request:

```text
qwen/control/scheduled-task/create-current
```

The core creator input includes the executing `promptId` captured from the tool
invocation context. The ACP Session object stamps `callerSessionId` from
`this.sessionId` and forwards that prompt id. Neither identifier is accepted in
`CronCreateParams`, and the control request does not accept a separate target
session id.

The bridge handler:

1. validates payload types and the same prompt bounds as the REST route;
2. verifies that the bridge client owns `callerSessionId`;
3. resolves that live session in the bridge that received the request;
4. requires `promptId` to equal that entry's `activePromptId` while
   `promptActive` is true, following the existing
   `external_tool_guard/prepare` binding pattern;
5. applies the same exact source allow-list as the form: no parent, no
   `sourceId`, and `sourceType` absent or `default`; and
6. delegates to a host callback installed only by `qwen serve` runtimes that
   manage scheduled-task sessions.

The prompt match prevents an accidental busy-sibling binding on a connection
that owns multiple sessions. It is a consistency check inside a trusted agent
runtime, not a claim that ACP cryptographically authenticates the exact turn.
The public REST path never uses this exception and always rejects a busy supplied
session.

If no host callback is installed, the bridge returns method-not-found, which the
tool maps to `current_session_scheduling_unavailable`.

### Shared daemon creation command

The host callback and the REST route share a focused
`createScheduledTaskWithExistingSession` command extracted from the #9361
provided-session branch. The command accepts the internal creation source:

```ts
type ExistingSessionCreateOptions = {
  source: 'rest' | 'cron-tool';
};
```

The `cron-tool` source is supplied only by the private host callback after the
bridge has matched the internally stamped caller session and prompt ids to the
live active prompt. Both paths apply the same selected-runtime and workspace
ownership, archive state, scheduled-task-source, capacity, generation, and
unique-binding checks. Only that prompt-matched trusted path may skip the active
prompt rejection; pending interactions remain ineligible. Public REST never
skips either idle check.

The final write-lock check remains authoritative. It revalidates that the
session is live and not task-reserved, rejects a concurrent binding, and writes
the task with the existing fields:

```ts
{
  sessionId: callerSessionId,
  sessionOwnedByTask: false,
}
```

No new durable schema or migration is introduced. The task creation timestamp
and `lastFiredAt` use the same creation-minute anchor as the REST route, so the
task cannot fire from the turn that is still creating it.

After the host commits the task, the control response returns its id and cron
expression. The creating session's file watcher loads the bound task; a
subsequent `cron_list` remains immediately consistent because durable listing
is file-first.

### Execution and session switching

There is no scheduler change. Once the task is on disk, only the scheduler whose
session id equals the task's `boundSessionId` may fire it. If a user turn is
active, the cron prompt waits in that session's existing serial queue.

Selecting another Web Shell conversation detaches the previous UI client but
does not close the session. Keepalive continues to heartbeat the bound session,
and boot rehydration restores it after daemon restart. Restore failures keep the
task bound and retry through the existing policy; they never move work into a
different conversation.

## Compatibility and rollout

- `sessionMode` is optional and defaults to the existing unbound tool behavior.
- Existing REST and SDK callers do not change.
- Existing task files require no rewrite.
- One `currentSessionSchedulingEnabled` construction-time condition requires
  `manageScheduledTaskSessions` and the ACP current-session host callback. The
  same condition advertises `scheduled_task_session_reuse` and installs the
  callback on the primary and every dynamically created workspace runtime
  bridge. A process does not advertise partial support, so a selected workspace
  cannot offer the selector and then return method-not-found for `cron_create`
  current mode.
- Web clients without `scheduled_task_session_reuse` do not render the new
  selector, preventing an older daemon from silently ignoring the intent.
- Non-daemon tool callers receive an explicit error rather than creating a
  durable task whose bound session cannot be restored.
- The feature can ship in one implementation PR because capability advertising,
  UI use, and daemon control support are versioned together.

## Test plan

### Core tool

- Omitted and explicit unbound modes preserve session-only and unbound durable
  creation without minting a session.
- Current mode requires `durable: true`, an executing prompt id, and an injected
  host capability.
- Current mode forwards the exact schedule and returns the committed task id.
- The permission-classifier input includes `sessionMode`.
- Host failure and method-not-found are surfaced without creating an unbound
  fallback task.

### Bridge and daemon

- The control method rejects malformed payloads, an unknown caller, and a
  caller session not owned by the bridge client.
- A missing or stale prompt id and an active prompt on an owned sibling session
  are rejected without creating a task.
- The trusted caller succeeds despite `hasActivePrompt: true` only when its
  stamped prompt id matches that session's `activePromptId`.
- REST creation with the same busy session still returns `session_busy`.
- The source matrix accepts only top-level unset/default sessions without a
  source id and rejects parented, Channel, side-task, scheduled-task, explicit
  standalone, Live Voice, and unknown-source sessions.
- Workspace mismatch, archived/non-live sessions, capacity, generation closure,
  and an existing binding preserve #9361 errors.
- A concurrent REST/tool create commits exactly one task.
- The committed task is caller-owned; task rename and deletion do not rename or
  close the conversation.
- The capability is absent when either scheduled-task session management or the
  ACP host callback is absent.
- A dynamically created workspace runtime receives the same callback as the
  primary runtime; current-mode creation routes to the selected runtime rather
  than falling back to primary.

### Web Shell

- Dedicated mode is the default and omits `sessionId`.
- Current mode sends the outer selected session id while the Scheduled Tasks
  page covers the chat pane.
- Capability absence, no selected session, a selected-session active turn, an
  ineligible session source, workspace mismatch, and an existing binding disable
  the option with the expected explanation.
- Split-pane activity does not disable or replace an idle outer selected
  session.
- Edit requests never mutate binding.
- "Create via chat" continues to start a fresh conversation.

### End to end

1. In conversation A, create a durable current-session task through
   `cron_create`; confirm creation succeeds while the tool turn is active.
2. Switch the Web Shell to conversation B and confirm the scheduled turn appears
   in A, not B.
3. Restart the daemon without opening A and confirm A is rehydrated and the next
   fire still appears there.
4. Delete the task and confirm A remains open and usable.
5. Repeat creation through the Scheduled Tasks form while A is idle and confirm
   it uses the same session without minting a new one.

## Alternatives rejected

### Relax `session_busy` for the public endpoint

REST has neither the trusted workspace-runtime context nor the internally
stamped prompt identity used by the control path. Relaxing it would let an
arbitrary client bind a session another turn is mutating and would weaken #9361
for every API client.

### Write the task file directly from `cron_create`

This bypasses daemon runtime ownership, capacity and generation checks, and
cannot safely promise keepalive outside `qwen serve`.

### Defer creation until the tool turn ends

The tool would have to report success before persistence, or keep a
process-local deferred operation whose failure cannot be returned to the user.
The trusted control path commits before the tool returns.

### Create a dedicated session and later migrate it

Migration splits transcript history and adds rollback and ownership transitions
that are unnecessary now that #9361 can bind the intended session directly.
