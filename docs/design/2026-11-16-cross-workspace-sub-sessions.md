# Sub-sessions in another workspace

[English](2026-11-16-cross-workspace-sub-sessions.md) | [简体中文](2026-11-16-cross-workspace-sub-sessions.zh-CN.md)

Status: steps 1, 2 and 3 implemented.

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
3. **Web Shell.** A `/send` command on a session page.

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

## Step 2: follow-ups to a session the caller created

`create_sub_session` gains `sessionId`, combined with `workspace` when the
session lives in another workspace. `model` and `name` apply only to a new
session, so they cannot be combined with `sessionId`.

**Which sessions.** The session must be one this caller created: its recorded
parent is the caller, and it carries no source marker. Side tasks and
scheduled-task runs also record the session they came from as their parent,
but a person or a schedule started them, and they carry `side_task` or a
`scheduled_task_run:` source. The launcher checks this before it touches the
session, from the live entry or, for a session the idle reaper already
closed, from the creation records at the head of its transcript. That lineage
is persisted, so it holds across a daemon restart. The caller itself, an
archived session, and a standalone session are refused. Sessions the caller
did not create stay out of reach: prompting one would put another session's
model text into it as a user turn, and `send_message`, which carries no user
authority, remains the way to talk to them.

**Approval.** A follow-up that names a workspace goes through everything step
1 requires for that workspace: the one-time approval, which also names the
session, the trust and generation checks, and the approval rule, applied to
the target mode at admission. If the rule tightens the mode, the change
takes effect when the follow-up starts its turn. A follow-up in the caller's
own workspace uses the tool's usual permission flow and keeps the session's
mode, as a new sub-session in that workspace does.

**Running the turn.** The launcher resumes the session on its workspace's
bridge, which attaches if it is live and restores it from its transcript if
not. The archive coordinator covers lineage lookup, restore, and prompt
admission. The prompt queues behind any running turn. While
waiting it counts only output stamped with its own prompt id, so a turn that
was already running, or a background turn, is never taken for this one. A
follow-up keeps the session's name, and a failed follow-up never closes or
deletes the session. Resuming attaches a client; the launcher releases it once
it is done with the turn, so follow-ups do not pile up attachments, and a
session restored only for the follow-up closes again once it has nothing left
to run.

**Reporting back.** Every follow-up sent with `sent` reports back, in either
workspace, and needs chat recording in the caller to do so, as a `sent`
launch into another workspace does. A `sent` launch that creates a session waits
until its prompt is dispatched. A follow-up returns once the prompt is
queued. The launcher waits up to 30 minutes for the result and pauses its
timer while the target needs approval or an answer. Expiry before
the ACP write prevents dispatch and publishes the failed turn status.
Once the write starts, the timeout ends the result wait and later prompts
still wait for that ACP request to settle. The guards still run when the
turn comes, and a prompt they refuse is reported as a failed completion.
If a failed follow-up leaves no eligible successor, the bridge releases
the preceding turn's Todo Stop Guard wait. A follow-up's background task id is
`<sessionId>:<promptId>`, not the session id: a caller receives several
completions from one session, and the receiving session treats a repeated
task id as a notification it already has. The launcher returns that id, and
the caller's session records it, so the Todo Stop Guard links the completion
to the work that asked for it. The tool description tells the caller's model
that results come back on their own and that it should not ask the
sub-session to report back, which would deliver the result twice.

Because a child cannot delegate, a caller and its children cannot form a
cycle, so no daemon-wide delegation record is needed.

## Step 3: Web Shell

A person can do from a session page what the model does with the tool:
start a sub-session in a chosen workspace, or send to a session already
there, and read the reply.

**Where.** A slash command in the composer:
`/send [--workspace <name|path|id>] [--session-id <id>] <message>`. Without
`--workspace` it targets the current workspace; without `--session-id` it
starts a new session there. Options come first and everything after them is
the message, newlines included; a value with spaces can be quoted. Completion
offers the option names, the trusted registered workspaces, and the active
sessions of the chosen workspace by name (it inserts the id), leaving out the
caller. The command is listed only when the daemon advertises
`session_sub_session_send` and the open session runs in a registered
workspace. A refusal (an untrusted or unknown workspace, an unknown session, a
cap) shows the daemon's reason and puts the command back in the composer.
Attachments are refused: the message is text.

**The route.** Sending calls `POST /session/:id/sub-sessions` with
`{ prompt, workspace?, targetSessionId? }`; `:id` is the open session, which
becomes the caller. The route uses the same owner check as `POST
/session/:id/prompt` and hands the request to the launcher of the caller's
workspace, which runs it like a `sent` launch from the tool: the same trust and
cap checks and the same chat-recording requirement. It answers with
`{ sessionId, workspaceCwd?, taskId? }`.

Five things differ from the tool, because a person wrote the message and
chose the target. Each rests on the same point: the person could open the
target session and type the same message there.

- No separate approval. Picking the workspace and pressing Send is the
  approval; the route resolves the target and launches it in one request.
- The target keeps its own approval mode. The caller's mode is not compared
  with the target's. A destination workspace using the `consensus`
  permission policy refuses `/send` before launch. Its approvals fix the
  voter set before the side panel attaches. Open the destination session
  and send the message there.
- Any session can be the target, not only one this session created: a side
  task, another person's Web Shell session, a sub-session of another session.
  It keeps its own parent and source. Only the caller itself is refused. The
  depth limit does not apply either, so a sub-session's page can send too: it
  exists to stop a model delegating without end, and a person's send does
  not recurse.
- The message is recorded in the caller, and the reply comes back as a turn
  in which the caller's model passes it on to the person (see "The exchange
  in the caller" below).
- A new session's title has no thread glyph. The person started it, so it
  reads like any session they start.

Only the route can ask for these; they are not fields the ACP child can send,
so a model cannot claim them. The tool keeps its rules, including for a
session a person created or sent to.

**After sending.** The page does not move. While the target runs the turn,
a "1 other session" chip shows above the composer, beside the chips for
background agents and shells. Clicking it opens the target in a right-panel
tab, live and read-only. MCP cards display their saved output or summary.
The tab still shows the target's tool approvals and
questions, and they can be answered there: the target keeps its own mode, and
in an ask mode it may wait on one with nobody else watching. While it waits,
the chip reads "1 session needs your answer" in the warning color, because
the daemon's permission wait has no timeout by default and nothing else on
the caller's page would say the target is blocked. When the turn finishes
the chip goes away.

**The exchange in the caller.** It reads like two sessions talking: the
target answers the caller, and the caller tells the person. When the send is
accepted, the message appears in the caller as a row on the user's side,
headed "To <workspace> · <session>". When the target's turn settles, the
caller runs a turn of its own, headed "Cross-session message · <workspace> ·
<session>" like a message from another session, in which its model tells the
person what the target replied, in its own words, and anything to act on. The
target's own words are not shown again in the caller: they are in the
target, which the chip's tab opens while it works and the card's "View
details" opens afterwards. The card stays in view when the finished turn
folds its steps, so the source of what the caller says stays visible.

The message row is written through the daemon's external-record call
(`appendExternalRecord`), which Agent Collaboration uses for a message from
another party: it writes a durable record and shows it live. The automatic
reply turn adds the record's bounded model text when the receipt is
missing from the model history. The `agent_mention` record has a
`sentTo` field with the target's id, workspace and title. The completion's
task id keys the record so a repeat writes nothing. It does not start a turn.

The reply is the completion notification a `sent` launch of the tool
delivers, with three changes for a person's send. Its summary says the user
sent the message with `/send` and asks the model to tell the user what the
target replied; it also repeats the first 2,000 characters of the message.
It leaves out the tool notification's session link so the model won't repeat
it verbatim.
Its label is "<workspace> · <session>". Structured `fromSession` metadata
identifies the target and its workspace for the Web Shell card.

The first design started no turn and showed the target's reply as a message
in the caller; the person wanted the caller to take in the reply and tell
them, as with a message between sessions. An even earlier version started a
turn with no record of the send in the caller, and the model then doubted
where the result came from; the message row fixes that.

If the caller is no longer live when the reply arrives, the reply waits as
any `sent` completion does.

**The message in the target.** The prompt the target receives carries a
`source` entry among its `inputAnnotations` (the caller's id, workspace and
title at send time). Annotations are stored with the user record and come
back on replay, so the target's transcript shows "From <workspace> ·
<session>" above the message, live and after a reload. The model does not see
it. The tool's launches carry it too; a scheduled run does not, since its
caller is not who sent it. The entry is display data that any client of the
daemon could also put on its own prompt, like the rest of the annotations;
nothing reads it for authorization.

**The chip's data.** The daemon, not the caller's child, reports these
launches back, so the child's task list does not know them. The caller's
launcher keeps a record of every `sent` launch it reports back to a caller,
a person's send and the model's cross-workspace or follow-up `sent` launches
alike, from the launch until the target's turn settles (completed, failed, or
cancelled when the daemon stops). `GET /session/:id/tasks?includeSubSessions=true`
adds them as `subSessions` beside the child's tasks. A record names the target
by its title when a person sent to an existing session, and carries
`waitingForInput`, which the launcher initializes from the target's pending
requests and updates as it follows the turn. Waiting on a permission or
question pauses the 30-minute observation budget. When a record
starts, settles, or starts or stops waiting, the daemon publishes `sub_session_task_changed` with the caller's id
on the caller's workspace, and Web Shell re-reads the list; a slow poll backs
the event up while one runs. So a send made through the API, or by the model,
shows a chip too. Records live in daemon memory, at most 20 per caller with
the oldest settled ones dropped first. When 20 sends are active, the daemon
refuses another send until a slot opens. A daemon restart forgets the records
and any pending notification.

## Files

- `packages/core/src/tools/create-sub-session.ts`: the parameters, their
  validation, the description and approval text, and how a follow-up's
  result is worded.
- The ACP session's spawner and the bridge's request validation
  (`packages/cli/src/acp-integration/session/Session.ts`,
  `packages/acp-bridge/src/bridgeOptions.ts`, `bridgeClient.ts`): carry the
  field. The spawner also passes on the daemon's refusal text: the RPC error
  that carries it reaches the session as a plain object whose message is
  only "Internal error", which the tool used to print as `[object Object]`.
- `packages/cli/src/serve/create-sub-session.ts`: caller-side checks,
  handing off to the target launcher, the approval rule, notification
  routing, the record of a person's message, and the follow-up path (lineage check, resume, client release,
  task id, prompt-id matching).
- `packages/cli/src/serve/run-qwen-serve.ts`: register each launcher by
  workspace and give launchers the resolver; expose the launcher lookup to
  the routes.
- `packages/cli/src/serve/routes/session.ts`, `capabilities.ts`: the
  `POST /session/:id/sub-sessions` route, its capability tag, and the
  `includeSubSessions` view of `GET /session/:id/tasks`.
- `packages/core/src/agents/session-agents/contract.ts`,
  `packages/acp-bridge/src/transcript-replay.ts`: the `sentTo` field of an
  `agent_mention` record and its projection, live and on replay.
- `packages/sdk-typescript/src/daemon/`: the client method, the
  `subSessions` task type, the `sub_session_task_changed` event, `sentTo`,
  and the `source` annotation type.
- `packages/web-shell/client/`: the `/send` command and its completion, the
  composer chip and its waiting state, the read-only session tab in the right
  panel, and the "To" and "From" lines on user messages.
- User docs for the tool.

## Out of scope

- Agent Collaboration's `@`-mentions across workspaces (#17419).
- Relaying a target's `ask_user_question` or tool approvals to the caller's
  model. They wait in the target session; a person answers them there or in
  the Web Shell tab that follows it.
- Replying from the right-panel tab, or opening the target from it.
- Persisting in-flight `sent` launches across a daemon restart. A restart
  loses a pending notification, as it does today.

## Open questions

- A `first-turn` follow-up waits at most five minutes, and a busy session can
  hold it in the queue past that. This wait does not withdraw the prompt,
  so it still runs later, and nothing reports its result. Use `sent` when
  the queue delay is uncertain.

- Should every `sent` sub-session notify its caller, not only one that names
  a workspace? That would make the tool consistent, but it would change
  existing fire-and-forget calls by adding an automatic turn.

## Verification

- Unit: resolution by absolute path and id, refusal of unknown and untrusted
  targets and callers, the depth gate, target-bridge dispatch, caller-bridge
  notification delivery, named-workspace confirmation despite legacy grants,
  live approval reads, incompatible or changed modes, and target cancellation.
- End to end: with two trusted workspaces, start a child in B from A, read B's
  `QWEN.md` in `first-turn` mode, and verify `sent` notification delivery in A.
  Open the child link from A and verify it loads B. Naming an untrusted target
  returns a refusal and the list of eligible workspaces.
- Step 2, unit: a follow-up returns only output stamped with its prompt id;
  a `sent` follow-up reports under `<sessionId>:<promptId>` and releases the
  client it attached; a `sent` follow-up to a busy session returns once
  queued, and one refused when its turn comes is reported as failed; a reaped child's lineage is read from its transcript;
  another session, the caller itself, a side task, a scheduled-task run, a
  Live caller, and a caller that cannot take a `sent` completion are refused
  before the session is touched; a failed follow-up does not close the
  session; a follow-up in another workspace runs on that workspace's bridge
  under the delegated mode.
- Step 2, end to end: follow up a child in B with `first-turn`, and again with
  `sent` after a daemon restart, and see B answer with the context of its
  earlier turns; follow up while the child runs a long turn and receive only
  the new turn's text; a session the caller did not create is refused.
- Step 3, unit: the route's validation, owner check and capability tag; a
  person's launch keeps the target's mode where the tool's would be clamped
  or refused, reaches a session the caller did not create while the tool is
  refused, works from a sub-session, and refuses the caller itself; reported
  launches are listed on the caller's launcher until they settle, cancelled
  when the daemon stops, bounded per caller, and left out for a launch the
  tool reports itself; the tasks route adds them only when asked; `/send`
  parsing and completion; the chip for a running send and for one whose target
  waits for an answer; a read-only pane keeps approvals and drops the
  composer; a person's send writes the message to the caller as a record and
  returns the reply as a notification that asks the model to pass it on,
  names the caller on the target's prompt, and titles a new session without
  the glyph; a turn started by a session's reply is labeled as a
  cross-session message; `sentTo` survives
  replay and the SDK parser, and a malformed one is dropped; the "To" and
  "From" lines on a user message.
- Step 3, end to end: from a Web Shell session in A, `/send` to a new session
  in B: the page stays, the message shows in A headed "To B", a chip shows
  while B works, clicking it opens B in the right panel with the message
  headed "From A", and when B finishes A runs a turn headed "Cross-session
  message · B · …" in which it tells the person what B answered; the rows
  survive a reload; `/send` to a session in B that A did not create and see its lineage
  unchanged; send to a target in an ask mode and approve its tool call from
  the tab; a target that asks a question turns the chip to "needs your
  answer" until it is answered in the tab; a send made through the API shows
  a chip in an open page.
