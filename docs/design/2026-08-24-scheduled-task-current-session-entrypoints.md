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
persisted ownership model, or the default dedicated-session behavior.

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

The scheduler already maps `task.sessionId` to `boundSessionId` and fires the
task only from the matching session. Session execution already serializes cron
turns behind active user turns.

## Goals

- Let the Scheduled Tasks form bind a new task to the currently selected
  ordinary conversation.
- Let a user explicitly request current-session binding through `cron_create`.
- Preserve dedicated sessions as the default for every existing caller.
- Preserve the #9361 ownership, workspace, capacity, lifecycle, and unique
  binding checks.
- Fail clearly when the host cannot guarantee daemon-managed restoration.

## Non-goals

- Rebinding an existing task through PATCH.
- Binding more than one task to a session.
- Migrating task history between sessions.
- Supporting Channel, side-task, Live, standalone, archived, or non-live
  sessions.
- Changing the Scheduled Tasks page's existing "Create via chat" action, which
  intentionally starts a fresh conversation.
- Solving the remaining legacy teardown-versus-reuse race tracked by #9415.
- Changing token-limit or missed-fire policy.

## Public behavior

### Scheduled Tasks form

The create form gains a two-option session selector:

- **Dedicated task conversation** — default; omit `sessionId`, preserving the
  current behavior.
- **Current conversation** — send the active session id in the existing
  `DaemonCreateScheduledTaskRequest.sessionId` field.

The current-conversation option is shown only when the daemon advertises a new
`scheduled_task_session_reuse` capability. It is disabled with a reason when:

- there is no active session;
- the active session still has a running turn or pending interaction;
- the active session is not an eligible top-level ordinary conversation;
- the form's selected workspace differs from the active session's workspace;
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
sessionMode?: 'dedicated' | 'current';
```

The default is `dedicated`. `sessionMode: 'current'` is valid only with
`durable: true`, and the tool description instructs the model to use it only
when the user explicitly asks to keep scheduled work in the current
conversation. The permission-classifier projection includes `sessionMode`.

Outside a daemon-managed ACP session, current mode returns a clear
`current_session_scheduling_unavailable` error. Dedicated durable and
session-only jobs retain their existing paths.

## Architecture

### Why the REST path cannot be called directly from `cron_create`

The public #9361 endpoint requires a supplied session to be idle. A
`cron_create` tool call runs inside an active prompt, so its own session is
necessarily busy and a direct REST-equivalent call would return
`session_busy`.

The busy rule must remain unchanged for ordinary clients: an arbitrary caller
must not bind a session while a different turn is mutating it. Current-mode
tool creation therefore uses a daemon-only control path that can attest that
the active turn is the caller requesting the binding.

### Daemon control path

Core Config receives an optional `CurrentSessionScheduledTaskCreator`
capability, following the existing injected daemon-capability pattern. The ACP
Session implementation wires it to a new control request:

```text
qwen/control/scheduled-task/create-current
```

The child request carries `cron`, `prompt`, `recurring`, and its own
`callerSessionId`. It does not accept a separate target session id.

The bridge handler:

1. validates payload types and the same prompt bounds as the REST route;
2. verifies that the bridge client owns `callerSessionId`;
3. resolves that live session in the bridge that received the request;
4. requires a top-level session and rejects `channel`, `side_task`,
   `scheduled_task`, `standalone`, and the reserved Live source marker;
   unreserved top-level source types remain compatible with the existing API;
   and
5. delegates to a host callback installed only by `qwen serve` runtimes that
   manage scheduled-task sessions.

No host callback returns method-not-found, which the tool maps to
`current_session_scheduling_unavailable`.

### Shared daemon creation command

The host callback and the REST route share a focused
`createScheduledTaskWithExistingSession` command extracted from the #9361
provided-session branch. The command accepts an internal binding context:

```ts
type ExistingSessionBindingContext =
  | { source: 'rest'; allowActiveCaller: false }
  | {
      source: 'cron-tool';
      allowActiveCaller: true;
      callerSessionId: string;
    };
```

Both paths apply the same session-id normalization, selected-runtime and
workspace ownership, archive state, scheduled-task-source, capacity,
generation, and unique-binding checks. Only the authenticated cron-tool path
may skip the idle rejection, and only when the resolved session id equals its
caller session id.

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

- `sessionMode` is optional and defaults to the existing behavior.
- Existing REST and SDK callers do not change.
- Existing task files require no rewrite.
- The daemon advertises `scheduled_task_session_reuse` only when
  `manageScheduledTaskSessions` is enabled, so minimal embeds do not promise a
  lifecycle they cannot keep alive.
- Web clients without `scheduled_task_session_reuse` do not render the new
  selector, preventing an older daemon from silently ignoring the intent.
- Non-daemon tool callers receive an explicit error rather than creating a
  durable task whose bound session cannot be restored.
- The feature can ship in one implementation PR because capability advertising,
  UI use, and daemon control support are versioned together.

## Test plan

### Core tool

- Omitted mode preserves session-only and dedicated durable creation.
- Current mode requires `durable: true` and an injected host capability.
- Current mode forwards the exact schedule and returns the committed task id.
- The permission-classifier input includes `sessionMode`.
- Host failure and method-not-found are surfaced without creating an unbound
  fallback task.

### Bridge and daemon

- The control method rejects malformed payloads, an unknown caller, and a
  caller session not owned by the bridge client.
- The authenticated active caller succeeds despite `hasActivePrompt: true`.
- REST creation with the same busy session still returns `session_busy`.
- Workspace mismatch, archived/non-live sessions, task-created sessions,
  capacity, generation closure, and an existing binding preserve #9361 errors.
- A concurrent REST/tool create commits exactly one task.
- The committed task is caller-owned; task rename and deletion do not rename or
  close the conversation.

### Web Shell

- Dedicated mode is the default and omits `sessionId`.
- Current mode sends the active session id.
- Capability absence, no active session, an active turn, an ineligible session
  source, workspace mismatch, and an existing binding disable the option with
  the expected explanation.
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

This cannot prove that the active turn belongs to the caller requesting the
binding and weakens #9361 for every API client.

### Write the task file directly from `cron_create`

This bypasses daemon runtime ownership, capacity and generation checks, and
cannot safely promise keepalive outside `qwen serve`.

### Defer creation until the tool turn ends

The tool would have to report success before persistence, or keep a
process-local deferred operation whose failure cannot be returned to the user.
The authenticated control path commits before the tool returns.

### Create a dedicated session and later migrate it

Migration splits transcript history and adds rollback and ownership transitions
that are unnecessary now that #9361 can bind the intended session directly.
