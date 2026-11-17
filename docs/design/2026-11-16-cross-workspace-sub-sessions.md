# Sub-sessions in another workspace

[English](2026-11-16-cross-workspace-sub-sessions.md) | [简体中文](2026-11-16-cross-workspace-sub-sessions.zh-CN.md)

Status: step 1 implemented alongside this document; steps 2 and 3 proposed.

## Problem

A daemon serves several registered workspaces, and Web Shell already shows
sessions from all of them side by side. A session can only delegate inside
its own workspace, though. `create_sub_session` spawns a fresh session in
the caller's workspace and runs one prompt there. It takes no target
workspace and cannot give a follow-up to a session it created earlier. Each
workspace's sub-session launcher is bound to its own bridge, and a bridge
refuses a spawn for another workspace.

So a session in workspace A cannot ask workspace B, with B's own
`QWEN.md`, skills, settings and history, to do something and report back.
The person has to switch to B, type the request there, and carry the answer
back by hand.

#17419 asks for the same outcome through Agent Collaboration (an `@`-able
agent bound to B). This design takes the session route instead. It needs no
persistent agent identity and no experimental flag, and it reuses the
sub-session machinery that already has caps, timeouts, result truncation and
completion delivery. The two are not exclusive: a workspace-bound agent
could later run on top of this.

## Goals

- A model in workspace A can start a session in a registered workspace B,
  and later send that same session a follow-up. For each prompt it can
  either wait for the turn's result or carry on and be told when the turn
  finishes.
- A person in Web Shell can do the same from a session page.
- B's work runs under B's runtime: B's directory, settings, trust and
  permissions. The launcher uses A's effective mode to choose the child's
  approval mode.

## Steps

The work lands in three changes, each usable on its own.

1. **A new session in another workspace.** `create_sub_session` takes a
   `workspace`. This change.
2. **Follow-ups to a session the caller created.** `create_sub_session`
   takes a `sessionId`.
3. **Web Shell.** A "Send to session" action on a session page.

## Step 1: a new session in another workspace

### The tool

`create_sub_session` gains an optional `workspace`: the absolute path or
workspace id of a workspace registered with this daemon. Absent means the
caller's workspace, which is today's behavior.

`first-turn` waits for the first turn and returns its text. A named `sent`
call returns once the bridge writes the prompt to ACP. A refusal before
dispatch or a 30-second dispatch timeout is returned directly. If the write
has already begun when it times out, the tool reports that the child may have
received the prompt. Cross-workspace `sent` also requires chat recording in
the caller. The caller gets a task notification with the result when the turn
finishes, or a cancellation if the target runtime stops while the caller is
still active. The tool result and the notification
link to the child in the target workspace. After confirmation, a selector
for the caller's own workspace uses the same-runtime execution and
completion path.

Each call with a named workspace requires one-time human approval in the
calling session. The daemon resolves the selector before the confirmation,
which shows the registered workspace's path and the full prompt. The approval
is tied to that runtime generation. If the selector resolves to a different
runtime at launch, the caller must request approval again. Deny rules apply to the supplied selector,
the registered path, and the workspace ID. Existing permanent grants continue
to apply to calls that omit the selector.

### Resolving the target

The tool resolves the destination via `qwen/control/resolve-sub-session-workspace`
before asking for approval. The approved launch request travels through the
session's spawner and the `qwen/control/create-sub-session` ext method to the
caller's launcher. The launchers are registered by runtime generation. The
caller's launcher runs the caller-side checks: the depth gate, the
standalone and Live refusal, and the caller's trust. It then hands the
launch to the target workspace's launcher, which spawns, prompts and waits
on its own bridge, under its own caps and with its own rollback. The
completion notification is delivered on the caller's bridge, because that
is where the caller lives.

The target is resolved from the registry's public list, so internal and Live
conversation runtimes cannot be named. Both workspaces must be trusted. The
primary workspace's usual exemption from the trust check does not apply here,
because this path drives one workspace from another. An unknown or untrusted
target is refused, and the error lists the workspaces that can be named so
the model can correct itself. After asynchronous startup, the launcher
rechecks both runtime generations and both sessions' approval revisions
when the prompt reaches the ACP write queue's head. The target also checks its live mode when it admits the
prompt. A mode change invalidates the pending dispatch so the caller can
retry under the new mode.

Standalone and Live callers cannot name a workspace. Their sub-sessions live
in daemon-owned directories that have no meaning in another workspace.

### Approval mode

The launcher reads each session's effective approval mode from its live ACP
configuration. Equal modes stay as they are. If one side uses `yolo`, the child
uses the other side's mode. For other compatible pairs, `plan` takes precedence,
and `default` takes precedence over `auto-edit` or a caller's `auto` mode.

A target in `auto` accepts callers in `auto` or `yolo`. Leaving `auto` would
restore permission rules that the target suppressed. An `auto` caller also
cannot delegate to an `auto-edit` target, since classification and automatic
edit approval permit different operations. Mode changes apply to the child
session only. A missing or unknown mode, a refused pair, or a failed mode
change closes any unused child before dispatch.

### Caps and lineage

A cross-workspace launch counts against the target launcher's caps:
per caller (16) and per workspace (24). Those caps exist to keep sub-sessions
from starving the interactive sessions of the workspace that runs them, and
here that workspace is B. A completed turn releases its slot in B before
notification delivery. A separately limits outstanding remote `sent`
completions using its own `serve.maxConcurrentSubSessionsTotal`, and holds
each reservation through delivery or expiry.

The child records the caller as its parent, so the
depth gate refuses it if it tries to create sub-sessions of its own. The
completion notification's task id is the new session's id, which is unique
because every step 1 launch creates a session.

## Step 2: follow-ups to a session the caller created (proposed)

`create_sub_session` gains `sessionId`. The session must be one this caller
created: its recorded parent is the caller. That lineage is persisted, so it
holds across a daemon restart. The launcher resumes the session on its
workspace's bridge, which attaches if it is live and restores it if it is
not. It queues the prompt behind any running turn and waits on, or watches,
the turn with its own prompt id. The approval rule from step 1 is applied
again before the prompt. Each completion notification needs its own task id
here, because a caller receives several from one session and the receiving
session treats a repeated task id as a notification it already has.

Sessions the caller did not create stay out of reach. Prompting one would
put another session's model text into it as a user turn, and
`send_message`, which carries no user authority, remains the way to talk to
them. Because a child cannot delegate, a caller and its children cannot form
a cycle, so no daemon-wide delegation record is needed. Rollback never closes
or deletes a reused session.

## Step 3: Web Shell (proposed)

A "Send to session" action on a session page opens a picker: a registered
workspace, then "New session" or one of the sessions this session created
there, and the message. Sending goes through the same daemon path as the
tool, with the open session as the caller and `sent` completion. The target
opens in a split pane, which already supports sessions from other
workspaces, so its reply streams there. When the turn finishes, the
originating session receives the completion notification as well, so the
result shows in both places.

## Files (step 1)

- `packages/core/src/tools/create-sub-session.ts`: the parameter, its
  validation, and the description.
- The ACP session's spawner and the bridge's request validation
  (`packages/cli/src/acp-integration/session/Session.ts`,
  `packages/acp-bridge/src/bridgeOptions.ts`, `bridgeClient.ts`): carry the
  field. The spawner also passes on the daemon's refusal text: the RPC error
  that carries it reaches the session as a plain object whose message is
  only "Internal error", which the tool used to print as `[object Object]`.
- `packages/cli/src/serve/create-sub-session.ts`: caller-side checks,
  handing off to the target launcher, the approval rule, notification
  routing.
- `packages/cli/src/serve/run-qwen-serve.ts`: register each launcher by
  workspace and give launchers the resolver.
- User docs for the tool.

## Out of scope

- Agent Collaboration's `@`-mentions across workspaces (#17419).
- Relaying a target's `ask_user_question` or tool approvals to the caller.
  They wait in the target session, where its owner answers them.
- Persisting in-flight `sent` launches across a daemon restart. A restart
  loses a pending notification, as it does today.

## Open questions

- Should every `sent` sub-session notify its caller, not only one that names
  a workspace? That would make the tool consistent, but it would change
  existing fire-and-forget calls by adding an automatic turn.

## Verification (step 1)

- Unit: resolution by absolute path and id, refusal of unknown and untrusted
  targets and callers, the depth gate, target-bridge dispatch, caller-bridge
  notification delivery, named-workspace confirmation despite legacy grants,
  live approval reads, incompatible or changed modes, and target cancellation.
- End to end: with two trusted workspaces, start a child in B from A, read B's
  `QWEN.md` in `first-turn` mode, and verify `sent` notification delivery in A.
  Open the child link from A and verify it loads B. Naming an untrusted target
  returns a refusal and the list of eligible workspaces.
