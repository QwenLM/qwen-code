# Paired engine workspace change propagation

[English](./2026-09-27-paired-engine-workspace-change-propagation.md) | [简体中文](./2026-09-27-paired-engine-workspace-change-propagation.zh-CN.md)

## Status

Second part of slice B2b of #12737, based on upstream `52460c24c8`. The first
part, [Paired engine workspace runtime identity](./2026-09-26-paired-engine-workspace-runtime-identity.md),
covered liveness, epochs and the stop receipt. This part specifies the third
workspace-contract gate recorded in
[ACP Bridge execution engines](./acp-bridge-execution-engines.md): delivering
session-affecting workspace changes to every live engine, with the
acknowledgement and permission-fence semantics decided for Q2 in #12737. It
builds on the paired quarantine from
[Paired engine per-engine operations](./2026-09-26-paired-engine-per-engine-operations.md)
(B2c): an unacknowledged change becomes a quarantine cause, and a late
acknowledgement of it can end the quarantine early, as the Q3 decision allows.
No ordinary daemon, Channels or embedded constructor passes `executionEngines`
after this change.

## Problem and current behavior

Workspace commands that change what live sessions may do reach only the
workspace-control channel (Legacy on a paired Bridge):

- permission rules (`qwen/permissions/setRules`, which the Legacy child also
  persists);
- the settings reload (`qwen/control/workspace/reload`: approval mode,
  workflow and tool settings, environment);
- the Session Workflow gate (`qwen/control/workspace/session-workflow`);
- model providers (`qwen/control/workspace/model-providers/reload`);
- Skills (`qwen/control/workspace/skills/refresh`).

A live Managed session therefore keeps old permissions after a new deny rule
until it is recreated. With only Managed live, each command fails with
`workspace-command` session-not-found, and the change never reaches the Managed
sessions at all.

## Scope

In scope:

- A Bridge-to-engine change notification with an acknowledgement.
- Delivery of the five commands above to every live engine other than Legacy.
- The unacknowledged change as a quarantine cause, with the Q2 fence for a
  change that tightens permissions and the early end the Q3 decision allows.
- Reporting a partially applied change to the caller without new routes or
  error codes.

Out of scope:

- the quarantine policy itself (B2c). This change only adds refusals that every
  quarantine now applies: shell commands, continuations, and a prompt that the
  quarantine overtakes while its attachments resolve;
- host wiring (B2d);
- the Legacy engine's own semantics, which are unchanged: a Legacy session
  that is busy during a reload keeps its settings and is listed in
  `sessionsSkipped`, as today;
- trust revocation, which already drains and replaces the whole workspace
  runtime, every engine included, through the workspace trust reconciler.

## Proposed design

### Change notification

A paired Bridge sends `qwen/control/workspace/change` to every live channel
of an engine other than Legacy, which is workspace control:

```json
{
  "v": 1,
  "revision": 3,
  "kind": "permissions",
  "tightening": true,
  "cwd": "/work/project"
}
```

`kind` is `permissions`, `settings`, `sessionWorkflow` (plus `enabled`),
`modelProviders` or `skills` (plus `reason`). `revision` increases with every
propagated change on that Bridge.

The notification carries no setting values. By the time it is sent, the
workspace-control engine or the daemon has already persisted the change, so
the engine re-reads that setting.

The engine applies the change to every live session before the session's next
prompt, model request or tool dispatch, and cancels a running turn it cannot
revalidate. Only then does it answer:

```json
{ "v": 1, "revision": 3, "acknowledged": true }
```

Any other outcome is not an acknowledgement: an error, a timeout (the
command's timeout), a malformed answer or another revision. A channel that
exits during delivery counts as settled, as Q2 allows once exit is verified:
its sessions are gone, and a fresh session starts a new channel. A channel
that is still starting is skipped, so its engine must read settings when it
creates each session. The same holds for a Legacy channel that replaced a
timed-out one while the command ran: it read the current settings itself and
is never notified.

The notification is sent outside workspace control, the way B2c reads a
Managed child's resources, so a slow answer never retires the channel. It
quarantines the channel instead, and the request stays open for a late
acknowledgement.

### Which change goes where

`invokeWorkspaceCommand` recognizes the five commands on a paired Bridge. It
sends each command to workspace control as today, then sends the notification
to the other live engines. Single-factory Bridges take the existing path
unchanged, and so does every command while a workspace stop is in progress:
it is refused as before, and no engine is notified or quarantined.

| Command                                         | `kind`            | Tightens permissions   |
| ----------------------------------------------- | ----------------- | ---------------------- |
| `qwen/permissions/setRules`                     | `permissions`     | yes                    |
| `qwen/control/workspace/reload`                 | `settings`        | yes                    |
| `qwen/control/workspace/session-workflow`       | `sessionWorkflow` | when `enabled` is true |
| `qwen/control/workspace/model-providers/reload` | `modelProviders`  | no                     |
| `qwen/control/workspace/skills/refresh`         | `skills`          | no                     |

Permission rules and a settings reload are treated as tightening without
diffing them. Either can add a deny rule or restrict approval, and failing
closed only costs the running turns of an engine that already failed to
acknowledge.

When workspace control is not live, or its command fails, the other engines
still receive every change that is already on disk. If they all acknowledge,
the command's original error is returned, so existing callers behave as
before. Permission rules are the exception: only the Legacy child persists
them, so they are sent only when that engine was live. The daemon itself issues
Skills commands only while workspace control is live, as B2b part one
established, so with only Managed live a Skills change does not reach Managed
yet.

### An engine that does not acknowledge

The channel is quarantined as B2c describes, with reason
`workspace_change_unacknowledged`:

- its engine takes no fresh sessions, and its sessions take no new work;
  both are refused with `503 acp_channel_unavailable` and that reason;
- running turns settle, settled sessions are closed, and the channel retires
  once it drains;
- the drain deadline (`quarantineDrainTimeoutMs`, 5 minutes by default) bounds
  the wait.

The other engine stays usable. This change also closes three gaps in that
refusal, for every quarantine cause: shell commands and continuations are
refused, and a prompt is checked again after its attachments resolve, just
before it is sent.

When the change tightens permissions, the Bridge does not wait for running work
to settle (Q2):

- running turns are cancelled now, as if a client had cancelled them;
- the sessions' permission requests are answered as cancelled, and a turn that
  ignores its cancel gets no queued mid-turn messages;
- background notification turns are refused, even one reporting work already
  under way, which other quarantines admit;
- a Goal turn the child starts later on one of those sessions is cancelled as
  soon as it is reported.

A session whose restore or creation was already in flight and lands on that
channel after the change is fenced the same way.

Status reads, cancellation, close, and pausing or clearing a Goal or a workflow
still reach every session.

### Ending the quarantine early

The #12737 decision lets only a validated acknowledgement of a missing
workspace change end a quarantine before its deadline. A notification that
timed out keeps its request open. If the engine later answers it with the
exact acknowledgement, that revision is no longer missing, and once no revision
is missing the quarantine ends:

- the channel takes fresh sessions and new work again;
- the permission fence lifts, and the drain deadline is disarmed;
- sessions already closed stay closed and restore on demand.

The quarantine is kept in these cases:

- another cause holds the channel;
- the episode began for another reason;
- the deadline has passed or termination began.

The permission fence lifts in these cases too: once no revision is missing, the
engine holds every change it missed, so a background report may settle while
the kept quarantine still refuses fresh sessions and new work.

An error or a wrong answer cannot be acknowledged later, so that channel
retires.

### Reporting

When any engine did not acknowledge, the command fails with
`WorkspaceChangePartiallyAppliedError`. The error carries the revision, the
kind, the unacknowledged channel IDs, the workspace-control engine's result if
it had one, and its failure as `cause` otherwise.

Existing callers already treat a failure as "not applied", so no new route or
error code is added:

| Route or caller                  | Partially applied change                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /workspace/permissions`    | `500 permission_update_failed` (an internal error on the ACP method); `settings_changed` is still published once the rules were saved |
| `POST /workspace/reload`         | `200` with the Legacy result and a `childError` naming the partial change                                                             |
| Model-provider reload            | `status: "failed"`                                                                                                                    |
| Session Workflow settings routes | `500 runtime_update_error`, and `settings_changed` is still published, as for a failed live push today                                |
| Skill toggles                    | `activation: "partial"`                                                                                                               |
| Skills preparation               | A Skills preparation error                                                                                                            |
| Refresh after a Skill edit       | A daemon log line                                                                                                                     |

No caller reports a partially applied change as applied, so a revocation is
reported complete only after every live engine has acknowledged it or exited.

## Files and consumers

| Area   | Files                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------- |
| Bridge | `session-control-plane.ts`, `bridgeClient.ts`, `bridgeErrors.ts`, `status.ts`                                 |
| CLI    | `serve/workspace-service/index.ts` (permission rules and reload)                                              |
| Docs   | `docs/developers/qwen-serve-protocol.md`, `acp-bridge-execution-engines.md`, the per-engine operations design |

No route is added or re-scoped. The permission, reload, Session Workflow,
model-provider and Skills routes stay workspace scoped and act on the selected
runtime only; `workspace_change_unacknowledged` is a new value of an existing
field.

## Validation and acceptance criteria

1. A new deny rule reaches a live Managed session after the Legacy child saved
   it: the engine gets `permissions`, revision 1, after the Legacy command, and
   its sessions and fresh sessions keep working. Covered on the Bridge and
   through `POST /workspace/permissions` on a real serve app.
2. When Managed does not acknowledge a new deny rule:
   - the command fails as partially applied with the Legacy result, and a
     quarantine starts with reason `workspace_change_unacknowledged`;
   - the running Managed turn is cancelled, and a queued prompt is refused
     without starting;
   - the settled session is closed with reason `channel_quarantined`, and the
     channel retires;
   - fresh Managed sessions are refused;
   - Legacy sessions and fresh Legacy sessions keep working;
   - `settings_changed` is still published.
3. A turn that ignores its cancel gets its permission requests answered as
   cancelled and no queued mid-turn messages. A Goal turn the child starts later
   on a fenced session is cancelled, while one on a Legacy session is not. The
   report of a background job started before the change is refused on a fenced
   session, and admitted after an unacknowledged change that does not tighten
   permissions. A session whose restore lands after a tightening change is
   fenced, and a session created after a late acknowledgement is not.
4. On a quarantined session, every way to start work is refused with
   `workspace_change_unacknowledged`: prompts, continuations, side questions,
   recaps, generation, fork agents, shell commands, mid-turn messages, and Goal
   or workflow starts. A prompt the quarantine overtakes while its attachments
   resolve is not sent. Pausing a Goal or a workflow still reaches the engine.
5. An unacknowledged change that does not tighten permissions (Skills, model
   providers, disabling the Session Workflow gate) quarantines the engine but
   lets its running turn settle. An answer carrying another revision is not an
   acknowledgement.
6. A late exact acknowledgement ends the quarantine once no revision is
   missing: a fresh session of that engine starts on the same channel, and the
   session takes prompts again. One revision still missing, or an answer for
   another revision, keeps the quarantine. When another cause keeps the
   quarantine, the acknowledgement still lifts the permission fence: a held
   background report is admitted, while fresh sessions and prompts stay
   refused.
7. With workspace control not live, a settings reload still reaches Managed,
   while permission rules do not. During a workspace stop, a permission change
   is refused with the existing draining error, and Managed gets no
   notification.
8. A Legacy channel that replaced a timed-out workspace-control channel during
   the command is not notified. An engine that exits during delivery counts as
   settled.
9. Single-factory Bridges send no notification, and existing tests pass
   unchanged. Each new test fails when its behavior is reverted.

## Risks and open questions

- A real Managed engine does not exist yet. The notification contract is
  exercised with in-process doubles, and the engine that implements it must
  honor the "apply before the next admission boundary" rule behind every
  acknowledgement.
- The Bridge refuses only the work that passes through it. An engine that did
  not acknowledge can still run work it starts without telling the Bridge,
  such as a scheduled task, until the drain deadline.
- A transient failure to acknowledge still quarantines the engine: its sessions
  close as they settle, and the channel retires unless a late acknowledgement
  arrives first. Early clearing does not reopen sessions that were already
  closed.
- With only Managed live, permission rules still cannot be changed, because
  the Legacy child persists them, and the daemon defers Skills changes until
  workspace control is live. B2d decides whether a paired host starts
  workspace control for these routes.
