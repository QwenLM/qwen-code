# What is missing against Multica, and how to close it

## Architecture correction — persistent identity, task-scoped sessions

The previous implementation score confused a working collaboration engine with
the requested Multica-shaped product. Against that product the branch is about
one working collaboration kernel, not a mostly complete product: routing and
shared-thread mechanics are substantial, while Agent creation, Runtime and task
presentation remain partial or absent. No percentage is meaningful until those
different layers have one explicit acceptance checklist.

One implementation decision was wrong, not merely incomplete. A deterministic
session keyed only by agent made every task share one transcript and left
`maxConcurrentRuns > 1` ineffective because the runtime port held one execution
slot per agent. Multica's `PriorSessionID` is selected by
`GetLastTaskSession(agent_id, issue_id)`. Qwen Code now follows the same scope:
the Agent identity is durable across the workspace, and its ACP session is
durable only for one `(agent, thread)` pair.

One structural gap remains and is not hidden behind UI glue:

- `runtimeId` and the hidden host session are not a first-class Runtime with
  provider, health and placement semantics.

The primary Agent Builder now writes one workspace Agent record containing its
identity instructions, model and concurrency. It does not create a subagent
definition first. Existing definitions remain a secondary linking/template path
for compatibility, not a prerequisite for a new persistent Agent.
The existing Agents navigation now opens the runnable Agent roster and shared
tasks first; reusable definition files are a secondary Definitions view.
New Agents bind explicitly to the local Runtime. An Agent with no task session
is idle while that Runtime is online; a task/run, not the Agent row, owns the
link to its ordinary conversation transcript.

## Current correction — task orchestration before process isolation

### Browser/source acceptance observations, 2026-09-08

#### Daemon restart — recovered after fixing runtime discovery

Task `th_00437664-ff68-4582-a053-949dc6ac53e1` first completed too quickly for
manual interruption; that first run is not crash-recovery evidence. On a second
human-requested run, a bounded observer waited for a durable checkpoint and
verified no unrelated live work before sending SIGKILL to the local daemon.
At interruption, run `rn_a04df8a1-8bcc-4a53-91c7-2940ce584c07` was running,
attempt 1, session `b48bad11-6e7c-5110-92a1-e560bf56eec6`; message
`ms_67e84e03-15c6-4382-a9d9-78569db56c6b` contained recovery checkpoint new-1.

The first daemon restart left this run stranded. The route registration only
performed a one-shot registry scan and discarded startup errors. It now scans
active, trusted workspace runtimes every five seconds for durable live work or
pending outbox events, reusing the existing owner and serialized dispatch. The
scan is stopped during server cleanup. The exact cause of the initial missed
one-shot scan was not logged, so readiness timing is not claimed as proven.

After that patch, starting the daemon recovered the same run as attempt 2,
without a human post, and reused the same session. Its review contained
RESTART-RECOVER-7263 and identified new-1 as the surviving checkpoint; it did not
repeat the checkpoint loop. Chrome Mark done succeeded. This verifies running
run recovery, not every accepted-input/transcript/outbox crash window.

Recovery also overwrote the prior usage baseline before settling that attempt:
2,462,933 before the kill became 2,495,350 on resume, with no attempt-1 usage
entry. The dispatcher now records the positive prior-attempt delta before
rebinding. A direct source check verified 100 → 125 produces a 25-token entry
for attempt 1 and baseline 125 for attempt 2. The real task's old accounting
was not rewritten; its displayed 1,030.1k tokens omit that observed 32,417 delta.
The accounting patch has source-check evidence, not a second live crash run.
No build, lint, typecheck, test suite, or additional PR was used.

#### Human unblock — same-session continuation

Chrome task `th_2987a14f-0765-4a32-81e2-c0c12b28dd9a` asked demo-leader to
request an output format before proceeding. Run
`rn_7f036523-31ca-4c07-9e86-9e0e11387e5e` closed blocked, and the panel showed
"Which output format should I use: JSON or CSV?" plus the waiting-for-a-person
reason. A human JSON selection at sequence 3 booked
`rn_cd66955c-4d53-4646-8834-90d1d01603b3` and acknowledged the earlier blocker
at that same sequence. Both runs used session `63465788-a16b-5328-92fc-8020330969a9`.
The second run submitted `{"ready": true, "marker": "HUMAN-UNBLOCK-6149"}`
through thread_review, and Chrome Mark done succeeded. The panel displayed
280.9k tokens. No manual retry or additional agent identity was needed.

This covers a human answering the assigned agent's own question, not every
open product choice about acknowledging other agents' blockers. The acceptance
companion now distinguishes current ACP evidence from historical background
observations and follows the owner's direct-to-#11206/no-local-CI workflow.
The Agent page's description also now names reusable definitions and shared
tasks rather than presenting Agent Team as the only collaboration path.
Updating that translation triggered a React removeChild error once during hot
reload. A full page reload recovered the UI and showed the new description;
the hot-reload error itself has not been diagnosed or claimed fixed.

#### Cancellation — wait for the runtime, then account for usage

The dispatcher previously ignored the cancellation result and immediately wrote
cancelled, even while the runtime still reported running. It now keeps cancelling
until a fresh runtime inspection no longer reports running; refusal and accepted
but incomplete cancellation have distinct dispatch details. The session adapter
also checks thread/run/attempt before cancelling, and terminal reconciliation
charges usage before writing cancelled.

A direct source check observed both rejected and accepted-but-running requests
remain cancelling. When the stub runtime stopped, the run became cancelled and
its 125-minus-100 usage delta was recorded as 25 tokens. A single regression
case was added to the existing dispatcher test file; the suite was not run.

Chrome task `th_9b557bad-6888-4695-a0ed-b72abfd70c98` initially completed before
the cancellation click could reach it; that first run is not cancellation
evidence. A second human-requested run,
`rn_2b38c719-44d5-46c8-92fd-f9b0af25e785`, posted sequential checkpoints.
Chrome showed working → stopping → no active run after Cancel. The store
confirmed cancelled, startedAt=1788848724048, endedAt=1788848741171, and 594,802
tokens accounted to that run. Checkpoints 1–7 exist; checkpoint 8 and a review
from the cancelled run do not. The thread is blocked with an explicit cancelled
run reason and no successor, not in_progress. Its two-run history remains in the
local demo workspace. This does not verify an unresponsive child or forced kill.

#### Same-thread peer handoff — clean first-attempt demo

Chrome task `th_00df8e71-3a7f-4c83-876c-290a7a22d878` reused demo-leader and
demo-worker, with no child threads. Leader posted one addressed request; worker
returned 31 × 37 = 1147 addressed to leader. Leader independently posted
41 × 43 = 1763, closed with thread_wait, then automatically resumed and submitted
both results plus `PEER-HANDOFF-5931` through thread_review. Chrome Mark done
succeeded, and a store read confirmed done, three completed runs, all attempt 1,
zero child threads, and no manual retry or extra human message.

Leader run `rn_3d9be992-e39b-4c11-a5d6-c132595651c8` ran from 1788848276487
to 1788848297506; worker `rn_a4c2bf69-fc1e-4c29-a032-e391711b8f22` ran from
1788848288507 to 1788848299517: 8,999 ms overlap. Leader's continuation
`rn_8c7ba977-9320-4c4f-bd34-a8fe5a5649f6` ran from 1788848297506 to 1788848305513. Both leader runs used session `63465788-a16b-5328-92fc-8020330969a9`;
worker used `b48bad11-6e7c-5110-92a1-e560bf56eec6`, also reused from the earlier
demo. The panel displayed 636.3k tokens. Overlap proves concurrent run lifetimes,
not separate OS processes or simultaneous provider computation.

The browser exposed a wording defect: a same-thread wait was described as
"waiting on a sub-thread" although closeKind carries no such distinction.
The shared run-label helper now says "waiting for other work". A direct source
assertion checked that label along with the persisted task/run evidence above.
No build, lint, typecheck, test suite, or new PR was needed. This is a clean
shared-thread orchestration demo, not a crash/restart reliability sign-off.

#### ACP same-run input — live evidence

The session adapter now uses the existing queue-only mid-turn channel, carrying
daemon-owned run metadata and the delivery id. The child checks that metadata
against the active ambient run before injection, flushes its mid-turn transcript
record, then records the consumed context window under the workspace lock.
Queue acceptance alone still does not acknowledge consumption. A stale run is
rejected; an unrecorded receipt remains eligible for durable follow-up.

Chrome task `th_028860cd-ee68-48e4-a792-1869a281fbe1` used the existing demo-worker
session. While it was working, a human correction requested
`MIDTURN-RECEIPT-4827`. One run, `rn_d1d4a0ec-f71b-4314-b944-c73379c499a2`,
started at 1788847915707 and completed at 1788847952361 with closeKind=review.
The correction (`ms_6e5516a8-20c7-409d-8d46-fcd719eac773`, sequence 3) is in
that run's consumed ids, and its committed watermark is 3. The active transcript
contains one matching mid_turn_user_message at 2026-09-08T06:12:17.797Z,
UUID `130194d1-bc5a-4e6c-8dda-186b10288f06`. The final thread_review includes the
marker and says this is partial demo acceptance. No successor run was created.

The model also called thread_read, so the final marker alone does not isolate
the queue path; the persisted mid-turn record and receipt provide that evidence.
Its summary repeated historical, superseded startup limitations from this doc;
that prose is not accepted as a factual architecture audit. The task remains
in_review. The panel displayed 398.4k tokens across this task's run.

Direct source checks rejected a stale attempt and a mismatched watermark and
recorded a valid repeated receipt once. No build, lint, typecheck or test suite
ran. Crash/late-drain/close races on the new ACP path still require live checks;
this supersedes earlier statements below that live input is unconnected.

#### ACP initial input — transcript before receipt

The initial launch path no longer reports its input consumed while the session
is merely prepared. `Session` records and flushes the initial user message
before advancing the durable consumed watermark; a failed receipt leaves the
input eligible for replay.

Real task `th_c7646c7b-7f4c-4996-9560-42721f125d0d` ran on the existing
demo-worker session. Run `rn_bcd7f190-5958-4dcd-9c92-ea207d4aad16` posted
`INITIAL-RECEIPT-8391`, called `thread_review`, and finished with trigger
`ms_c7dcb7be-dda0-496f-90f7-e3663dec5130` consumed at watermark 1. Reloading
the session from disk found both the assigned prompt and marker in its
transcript. This observes the normal model path and checks the persisted result;
the exact process-exit window between transcript flush and receipt remains an
unrun failure injection. No build, lint, typecheck, test suite, CI, or new PR
was used.

#### Unread input at close

Source inspection found that explicit close used to promote every accepted id
to consumed, while successor booking considered only unaccepted triggers.
That would silently acknowledge an input queued just before close without any
consumption receipt. Terminal bookkeeping now preserves consumed ids, and
finishing/completed runs rebook triggers without a consumption receipt.

A direct source check in an isolated temporary store observed a finishing run
with one accepted/unread correction become completed, retain zero consumed ids
and a zero committed watermark, and start a successor carrying that correction
in the same dispatch sweep. A single regression case was added to the existing
dispatcher test file; the source check ran, not the local CI/test suite.
This is storage/dispatcher evidence, not an ACP live-drain acceptance claim.

#### Post-send routing visibility

Thread details now expose each message's stored admission outcomes, and the
panel renders them below the message. Skip explanations use the same mapping
as draft preview. Running coalescence explicitly says it is not a read receipt.
Chrome on the source daemon displayed the persisted leader/worker bookings in
the completed acceptance task below; no new model run was needed for this check.
To repeat: open Shared threads, select that completed task, and check its Routing
lines against the stored message outcomes. Skip/coalescence rendering still needs
a browser scenario; only dispatch outcomes were observed in this pass.

This UI change itself did not implement mid-turn steering. The subsequent ACP
implementation and live evidence are recorded above; queue admission labels
still intentionally make no claim about consumption.

#### Session capability wiring follow-up

The replacement session path previously applied only the resolved prompt.
It now also passes the existing `toolConfig.executionAllowedTools` to Config;
the scheduler-facing guard intersects that set with the existing capability
classification and preserves host-policy denials. Ordinary sessions retain
their previous guard. This is tool-call policy, not OS isolation or a claim
about initialization hooks/MCP discovery.

A direct source check observed read_file/thread_review allowed and write_file,
run_shell_command, save_memory, an unknown MCP name, and an omitted glob denied.
It also observed an upstream denial preserved and an ordinary Config unchanged.
The scheduler's existing pre-execution call site was inspected; model-driven
negative-path and full reliability acceptance are still outstanding. No build
or local CI ran.

Session startup now applies the resolved definition/identity model selector
through the existing model resolver and Config APIs before publication.
`inherit` leaves the workspace model unchanged; `fast` uses the configured
selector; same-provider selections use setModel (including raw model IDs),
and cross-provider selections use switchModel with cached-credential requirements
for OAuth. This does not update an already-live agent after a roster edit.
Direct resolver checks covered inherit, fast and explicit same-provider IDs;
live provider-request verification and live configuration refresh remain pending.

#### Live follow-up (supersedes the startup blocker below)

The source dev loader now resolves ACP bridge exports from this worktree, not
the checkout behind shared node_modules. Real browser task submission then
exposed and drove fixes for three more execution-path defects: prefixed session
IDs rejected by ACP's UUID contract, persona resolution before Config created
its definition manager, and attempting session creation for live or persisted
sessions. Agent IDs now map to stable UUID v5 session IDs; persona resolution
runs after initialization but before publication; start reuses a live session,
resumes an active on-disk transcript, or creates a genuinely new session.
Protocol error objects use the existing error formatter instead of rendering
`[object Object]`.

Local task `th_b425fc9b-719a-4456-99a9-13fae4c960ea` used two test identities
(`demo-leader`, `demo-worker`) backed by the existing general-purpose definition.
The model created child `th_cc67e630-b3e8-42b8-b27e-3429adcde924` and submitted
323 through `thread_review`; the leader posted 667 and closed with `thread_wait`.
Persisted run intervals overlap for 8,006 ms: leader
1788846040198–1788846063450, worker 1788846054442–1788846062448.
After the startup/restore corrections and explicit human retry, the leader
read the child and submitted both results through `thread_review`. Chrome
confirmed parent completion is refused with `descendants_not_done` before child
acceptance; marking the child done succeeded and automatically started another
leader run from the parent-report event, without a new human message.
That run (`rn_5d81f465-0dd0-41c5-b3cf-f9ce4289d812`) completed and submitted
another summary. The browser then successfully marked the parent done; both
parent and child are now done. The two local test identities and full failure/
retry history remain available in this acceptance workspace.

This is real execution evidence, not a clean first-attempt acceptance run:
the same task preserves earlier failures and manual retries. Immediate mid-run
steering, capability enforcement on this session path, and the full original
acceptance matrix remain unverified/incomplete. No build or local CI was run.

- Direct source execution of `Config.createToolRegistry` now reports all six
  `thread_*` tools for a top-level `agent` session and zero for an ordinary
  session. Previously registration required `forSubAgent`, so replacement
  sessions could not split work or explicitly close runs. The existing ambient
  store checks remain the authority for every tool invocation.
- Chrome against Vite on 5173 and the source daemon on 4170 reproduced the
  shared-task page failing to parse an HTML response. The backend's plural
  `/workspaces/:workspace/agents` prefix also collided with the existing
  agent-definition `/:agentType` route. The collaboration backend now matches
  the client's separate `/workspaces/:workspace/agent` prefix. After restart,
  the page loads the real empty roster and server capability description with
  no parse or missing-subagent error. No agents or tasks were created.
- Task selection now clears the previous detail/draft, ignores stale refresh
  and preview responses, and does not render task A's controls with task B's
  ID. This race fix is source-reviewed, not yet browser race-injection verified.
- Live model acceptance is **not passed**: the ACP child exits during startup
  because the locally resolved bridge package lacks `DAEMON_AGENT_RUN_META_KEY`.
  No build or local CI was run. The tool-registry observation and empty-panel
  observation do not establish concurrent model work or child-task acceptance.

The owner's clarified goal is existing agents collaborating on tasks, with
assignment, child tasks, reports and human acceptance visible in the panel.
Separate OS processes are not a prerequisite for this slice. Historical claims
below that a session is a process, or that Stage A delivered crash isolation,
are incorrect: the current ACP bridge multiplexes sessions in one process.

Source inspection found that `sendPrompt` resolves at turn completion. Awaiting
it inside dispatch delayed the HTTP assignment response, blocked peer starts,
and sampled usage only after the work was done. Session dispatch now prepares
the session, persists its run binding and usage baseline, then activates the
prompt without waiting for the model. The adapter exposes the active run's
identity for cancellation, and asynchronous errors settle as visible failures.
Timer and HTTP dispatch passes share one in-flight pass to avoid reconciling
a run between claim and activation.

The claim that `deliver` already uses live mid-turn input is also incorrect.
It used the normal prompt FIFO. Replies now explicitly take the existing durable
rebooking path; true mid-turn input and drain acknowledgements remain unconnected.
This is not evidence of a complete leader → worker → human acceptance demo.

Verification for this correction: source/call-site inspection only; the named
session-dispatch-port test was updated with an unresolved model promise and
asynchronous failure case, but was not run. No build, lint, typecheck or local
CI was run. Next entry: exercise panel assignment with two existing agents,
then connect live input acknowledgement and verify child-report/acceptance flow.

> Written after reading `multica-ai/multica@7a438bd5b` properly: its migrations
> (`agent`, `agent_runtime`, `agent_task_queue`, `issue`, `comment`, `squad`,
> `agent_invocation_target`, `inbox_item`) and its product routes.
> Companion to [`2026-09-06-multi-agent-board-collaboration.md`](./2026-09-06-multi-agent-board-collaboration.md).
> Goal restated by the owner: **not a literal copy.** Get as close to Multica's
> model as Qwen Code's grain allows, and integrate its board and its
> conversation into Qwen Code rather than beside it.

## 1. What Multica actually is

An issue tracker in Linear's shape, where an assignee may be an agent, plus a
registry that makes agents real processes on registered machines.

| Entity                    | What it carries                                                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`                   | workspace-scoped identity: `runtime_mode` (local/cloud), `runtime_config`, `visibility`, `status` (idle/working/blocked/error/offline), `max_concurrent_tasks`, owner |
| `agent_runtime`           | **a machine**: workspace + `daemon_id` + provider, `status` online/offline, `last_seen_at`, `device_info`                                                             |
| `agent_task_queue`        | agent × issue × `status` (queued/dispatched/running/completed/failed/cancelled) + priority                                                                            |
| `issue`                   | title, description, 7 statuses, priority, `assignee_type` (member/agent), `parent_issue_id`, `acceptance_criteria`, `due_date`, labels, project                       |
| `comment`                 | the conversation, on the issue                                                                                                                                        |
| `squad`                   | a leader agent plus members                                                                                                                                           |
| `agent_invocation_target` | who may invoke this agent                                                                                                                                             |

Routes: `agents`, `agents/[id]` (instructions / env / MCP / custom args /
integrations / activity tabs), `agents/new` (manual or AI-authored),
**`runtimes`, `runtimes/[id]`**, `issues`, `issues/[id]`, `my-issues`, `inbox`,
`squads`, `projects`, `skills`, `chat`, `autopilots`.

The load-bearing idea, and the one we inverted: **an agent is a process on a
registered runtime, and dispatch hands work to that runtime.** Everything else
is a tracker built around that fact.

## 2. What we have, honestly

Two layers, and they are in very different states.

**Sound, and worth keeping whatever happens above it.** The store's versioned
schema and workspace-lock transactions; admission with its twelve outcomes;
the per-thread turn gate and the per-tree token gate; status as an aggregate
over every run's close obligation; the two-write run close; the outbox with
idempotent apply; the six thread tools with ambient-only identity; the prompt
envelope; interrupted-run recovery; mid-run steering with rebook. None of this
knows how a body is started. It addresses agents by id and threads by file, so
it survives the change below.

**Implemented, but narrower than Multica.** Each identity owns a task-scoped
top-level ACP session with its own persona, model setting and transcript. It is
no longer a background subagent, and work on another task gets another session.
The ACP bridge still multiplexes those sessions in one process. The produced
`local` binding and Runtime view are real, but there is no remote registry,
placement or heartbeat protocol.

**Missing entirely.** Remote Runtime registry and placement; labels and due date
on the work item; squads; inbox; projects. Priority, acceptance criteria,
per-Agent instructions/model/concurrency and direct persistent-Agent creation
have landed. Reusable definitions are now an optional compatibility path.

## 3. Why the percentages I gave were wrong

I was scoring implementation against our own design document — which itself put
the wrong execution model in §1 and listed real process isolation as out of
scope in §10. That measures "how much of a plan we finished", not "how close
this is to what was asked for". Against your goal, the runtime layer is zero,
not eighty percent. I should not have used that number.

## 4. The plan

Four stages. Each is usable on its own; none needs the next to be worth having.

### Stage A — an agent is a top-level session

Multica binds an agent to a runtime and resumes a session per agent and issue.
This demo binds an identity to top-level ACP sessions keyed by agent and thread
on the current local daemon. That preserves task-local conversation without
claiming a registered runtime or OS-process boundary.

- No durable runtime record is invented for the local-only demo. An agent's
  deterministic session id and the bridge's live-session record are the source
  of truth. A persisted binding belongs with a real runtime registry, not with
  a label that always means "this daemon".
- An agent session is spawned with `sourceType: 'agent'`,
  `sourceId: <agent id>`. The child recognises itself at `newSession`, reads the
  roster, and applies its own persona — `Config.systemPrompt` for the prompt
  (which `getMainSessionBaseSystemPrompt` already honours), `deriveConfig` for
  `getToolRegistry` / `getToolInvocationGuard` / `getModel`. **This hook already
  exists**; the claim in §1 that it did not is what sent the design to
  subagents.
- Agent status stops being derived and becomes Multica's: `offline` when no
  session, `idle` when the session is live and free, `working` while a run is
  bound, `blocked` when it owes a question, `error` after a terminal failure.
- `dispatch-port.ts` is rewritten against sessions: `inspect` reads the bridge's
  live-session record, `start` is spawn-or-attach plus a prompt, `deliver` is
  the session's existing mid-prompt input path. **The dispatcher, its rules and
  every outcome it records are untouched** — the port was always the only thing
  that knew what a body is.
- `launcher.ts` and `runtime-bridge.ts` are replaced: no
  `launchProgrammaticBackgroundAgent`, no `BackgroundTaskRegistry`, no
  in-process `AgentEventEmitter`.

Delivers: separate agent identity, persona and transcript. It does not deliver
process crash isolation or remote runtime placement.

### Stage B — the conversation is Qwen Code's, not a second one

I built a bespoke `ThreadView` with its own message rendering. Some of that UI
can reuse the existing conversation shell, but the shared thread itself cannot
be replaced by one ordinary session: it spans several agent sessions and owns
assignment, status, child work, routing outcomes and acceptance.

- The thread page keeps what only it knows: the status sentence, the run rows
  with their close obligations, the budget line, assignment and status actions,
  and the composer with its routing preview.
- Each run links into that agent's existing session view for the full model
  transcript. Agent sessions remain visible in the normal conversation list.
- Thread posts stay the durable coordination record — who was asked, who
  answered, what was booked — because no individual session owns that shared
  history. The remaining UI work is reuse of the existing list shell and
  message primitives, not deletion of the thread model.

### Stage C — the work item catches up

Today a thread is title, body, five statuses, assignee, parent. Multica's issue
carries priority, seven statuses, acceptance criteria, due date, labels,
project. In order of how much each changes behaviour rather than display:

1. **`acceptance_criteria`** — this is what an agent is checked against and what
   `thread_review` should report against. It changes what the agent is told.
2. **Priority** — the dispatcher already picks by FIFO sequence; priority is the
   one field that should be allowed to override that order.
3. **Labels and project** — grouping and filtering; display only.
4. **Due date** — display only until something schedules on it.

Statuses stay at five unless a use appears: `backlog` and `todo` are tracker
bookkeeping, and our `open` covers both.

### Stage D — the agent is configurable

Multica's agent detail page has instructions, env, MCP servers, custom args,
integrations and activity. Qwen Code reuses its rich Agent Builder UI, including
model-assisted generation, but the primary collaboration flow submits directly
to one workspace Agent record. The read-only v1 hides tool, MCP and hook options
that cannot take effect. Existing definitions remain an optional compatibility
path rather than a second required create step.

Squads, inbox and projects come after this, and only if you want them; none is
load-bearing for two agents collaborating on one thread.

## 5. What this costs, and what it breaks

Stage A rewrites three files — `launcher.ts`, `dispatch-port.ts`,
`runtime-bridge.ts` — and the `AgentMeta.agentRun` per-turn binding moves from an
in-process AsyncLocalStorage frame in the host to the agent session's turn seam.
Every test that mocks `BackgroundTaskRegistry` for workspace agents goes with
them. Nothing in the store, the rules, the tools or the REST surface changes.

N session contexts share one ACP process. A roster is two to five agents, so
the machine's memory is still the practical limit. A roster size limit belongs
in the UI, and `max_concurrent_tasks` is a per-agent field rather than a blanket
rule. A later runtime layer may place those sessions on separate processes or
hosts without changing the thread rules.

## 6. Decisions, made 2026-09-08

1. **An agent may work several threads at once.** `WorkspaceAgent.maxConcurrentRuns`,
   default 1, mirroring Multica's `max_concurrent_tasks`. Decision 10 is
   rewritten: serial was a consequence of a subagent owning one chat inside a
   shared chat. A task-scoped top-level session makes concurrency a policy rather
   than a fact. The default keeps today's behaviour until someone raises it, and
   `queueLimit` stays a separate bound — throughput and backlog are different
   questions.
   _Where it lands:_ `selectCandidates` counts an agent's live runs against its
   own limit instead of treating any live run as busy; `claimRun`'s
   already-live check does the same. Both are single conditions.

2. **An agent's task sessions appear in the normal session list.** A person
   opens them the way they open any other conversation. This reuses the existing
   transcript and renderer for each task. The shared thread remains
   the cross-agent coordination record because no one agent session owns it.
   Only the dispatch host stays hidden, because it is infrastructure with no
   conversation of its own.
   _Where it lands:_ this subsystem-agent source type is excluded from the
   host-session filters in `session-list.ts` and `acpAgent.ts`, not added to
   them. The session is labelled by the agent so a list of five sessions reads
   as five agents.

3. **Deleting an agent retires it; it never rewrites history.** Multica's shape.
   The roster entry stops being addressable and reads `offline`, the session
   closes, and every post the agent made keeps its name — those posts are
   evidence other agents reasoned from, and erasing the author makes a thread
   unreadable after the fact. Disable-and-drain remains the reversible middle.
   _Where it lands:_ decision 8 rewritten; the tombstone snapshot becomes
   unnecessary because the identity is retained rather than removed.

## 7. Stage A, concretely

In dependency order. Each item is small; the sequence is what matters.

1. `WorkspaceAgent` gains `maxConcurrentRuns`; its local session and status are
   derived from the bridge rather than duplicated in the roster.
2. `workspace agents-agent` session source type, and persona resolution in the child at
   `newSession` — roster lookup, `Config.systemPrompt`, `deriveConfig` for tool
   registry, invocation guard and model.
3. `dispatch-port.ts` rewritten against the bridge: `inspect` from the live
   session record, `start` as spawn-or-attach plus prompt, `deliver` as the
   session's mid-prompt input path.
4. `launcher.ts` and `runtime-bridge.ts` deleted; their callers move to 3.
5. `selectCandidates` and `claimRun` honour `maxConcurrentRuns`.
6. The per-turn `(agent, run, thread)` binding moves from the host's
   AsyncLocalStorage frame to the agent session, read at its turn seam.

The dispatcher's rules, the twelve admission outcomes, the store, the tools,
the prompt envelope and the REST surface are not touched by any of this.

## 8. What landed, 2026-09-08

All four stages are on `codex/multi-agent-mesh-foundation`. Nothing here was
built, typechecked or tested on the author's machine; ESLint is clean across
the changed surface and CI is the verification.

| Commit       | What                                                                 |
| ------------ | -------------------------------------------------------------------- |
| `2a8e23cb30` | Renamed the subsystem from mesh to workspace agents                  |
| `77578abab7` | Repaired the import paths the rename broke; persona applied at spawn |
| `cbc8958379` | Dispatch against one top-level ACP session per agent                 |
| `f663f779a1` | Token accounting from the session's own counter                      |
| `39da00b8f6` | Removed the subagent execution path                                  |
| `b4055c3690` | Agent sessions named after their agent; runs link to them            |
| `6616312c67` | Threads gained acceptance criteria and priority                      |
| `8d6e199cc4` | Deleting an agent retires it instead of erasing it                   |
| `59d326e422` | Agents are configurable; the capability ceiling is shown             |

Stage A's initial sessionization is complete: `launcher.ts`, `dispatch-port.ts` and
`runtime-bridge.ts` are gone, along with `launchWorkspaceAgent`,
`dispatchAgentRuns` and the two ACP control methods behind them. Dispatch runs
in the daemon, where the sessions are. The follow-up correction scopes those
sessions to `(agent, thread)` instead of one transcript per identity.
Multica-style runtime registration and process isolation remain absent.

A later source audit found that sessionization alone had not delivered the
claimed persona: persona fields were assigned after `Config.initialize()` had
already bound the live chat, and an Agent with no linked definition fell back
to the built-in `general-purpose` subagent prompt. The correction refreshes the
live system instruction after persona/model resolution and gives the primary
no-definition path its own independent workspace-Agent identity. A fresh Web
Shell task reproduced a durable marker found only in that Agent's instructions
and explicitly identified itself as an independent workspace Agent, then
reached human acceptance. This overturns the earlier inference that writing
`Config.systemPrompt` before the first task prompt was sufficient.

Stage B turned out to be smaller than written. Agent sessions were already in
the ordinary session catalog, but the sidebar's Tasks filter hid them. The
existing session-source switch now has an Agents tab backed by the same
`WorkspaceSection` and ordinary session page; no second conversation list was
added. A run row links to the ordinary task session. The current automatic title
is only the Agent name, so two task sessions owned by the same Agent are not
distinguishable in the list; it must become `Agent · Task` without overwriting a
person's `/rename`. The store carries transcript-offset fields, but the session
adapter does not produce them and the REST/UI path does not consume them, so a
run row currently opens the whole task session rather than a proven run slice.

Stage C landed items 1 and 2 of the four. Labels, project and due date are
still display-only work and are not done.

Stage D landed instructions, model and concurrency as per-identity fields, plus
the capability ceiling as something a person can read. MCP
servers were deliberately not added: `classifyAgentTool` denies every name not
in its table and no MCP tool is in it, so the setting would do nothing.
Reaching MCP means moving the read-only ceiling, which is a separate decision.
The creation endpoint accepts those identity fields in its first roster write,
and the list reports status from live task sessions. The primary New Agent
action opens Qwen Code's existing manual/model-assisted builder and submits that
form directly to the roster. Linking an existing definition is a secondary
compatibility action. This is one product object and one durable write.

### How this branch was verified

Everything below is repeatable from `scripts/audit/`, and every one of them was
calibrated by breaking the thing it checks and watching it go red. A green run
that has never failed is not evidence.

| Check                                       | What it covers                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workspace-agent-orphans.py`                | Exports whose only callers are tests, record fields nothing reads, baseline entries naming nothing, and the design doc's record diagrams against the real types                                                                                                                                                                            |
| `tsconfig.workspace-agents-{core,cli}.json` | Narrow typechecks with `paths` pointed at package source rather than stale `dist`                                                                                                                                                                                                                                                          |
| `run-workspace-agents.mjs`                  | 139 assertions over the rules: store round-trip, the eleven admission outcomes, priority, retirement, budget boundaries, a run's whole life, all six thread tools under real run frames, delegation, blocking, waiting, the status aggregate, the parent-report outbox, crash recovery, the panel's view logic, and in-process concurrency |
| `run-workspace-agents-concurrency.mjs`      | Ten real processes contending the file lock. Removing `lockfile.lock` loses 7 of 10 posts                                                                                                                                                                                                                                                  |
| `run-workspace-agents-crash.mjs`            | A writer SIGKILLed holding the lock: the store stays readable and writes return unaided                                                                                                                                                                                                                                                    |
| `fuzz-workspace-agents.mjs`                 | Random operation sequences against the invariants. 25 seeds × 600 steps — 15,000 operations — with no violation                                                                                                                                                                                                                            |

How much those checks are worth was measured rather than assumed. Disabling
each of the 86 single-line guards in the subsystem one at a time and re-running
the harness caught 8 at first and 28 now. The remaining survivors fall into
three kinds, and the distinction matters more than the number:

- **Unobservable.** Removing `if (pending.length === 0) return` walks an empty
  list to the same end; removing the unset-assignee check re-assigns undefined
  over undefined. No assertion can catch these and writing one would be
  theatre.
- **Unreachable.** `deliverParentReports` guards a report whose parent thread
  is gone, but `deleteThread` refuses to delete a thread that has sub-threads,
  so no supported operation produces that state. The refusal is asserted; the
  guard behind it stays as defence.
- **Somebody else's.** Most of store.ts's 39 survivors are per-field
  validators. store.test.ts covers fail-closed at the record level — checked,
  not assumed — but a single field check can be disabled with every suite
  still green. That is a real if minor gap.

What none of it covers: the vitest suites, which are larger and still need CI;
partial-write recovery, since the file lock means two writers never touch one
file and killing an idle holder never interrupts a write (`store.test.ts`
covers that with fault injection). Decisions 4 and 12 of §2 are covered as of
ae7deeeaf9's successor: an agent has no agent-creating tool in reach and the
guard refuses it anyway, and a run frame naming another workspace cannot write
here.

### Found on this branch, outside this subsystem

`client/App.tsx` reads `teamName` off `DaemonSessionAgentTaskStatus` in four
places, and the wire type does not declare it — the only `teamName` in core is
in the team test harness, so the daemon does not appear to send it either.
Measured, not guessed: `packages/web-shell` typechecks to 635 errors on
`origin/main` and to the same 635 on this branch, but the sets differ — the
branch fixes three of main's and adds these four. It belongs to the Agent Team
track rather than to workspace agents, so it is reported here rather than
fixed: whether the field should be added to the type or the reads removed is a
question for whoever owns that surface.

### Still open

- **Definition drift is designed in but never fed.** `bindRunSession` stores a
  `definitionVersion` and the turn envelope renders it, but `definitionVersion`
  is an optional port method and the session dispatch port does not implement
  it, so every envelope reads `definition=unversioned`. Supplying it means
  hashing the agent definition, which the port cannot do today: it holds the
  bridge and a workspace path, while definitions load through core's
  `SubagentManager` against a `Config`. Either the port gains that reach or the
  child stamps the hash it already resolved at boot — a decision, not a wiring
  fix, which is why this tick recorded it rather than guessing.
- Labels, project and due date on a thread (Stage C, items 3 and 4).
- §9.9 envelope role transport, §9.10 parent-to-child replies, §9.11 human
  blocker acknowledgement scope — all owner decisions, unchanged.
- Squads, inbox and projects, which remain out of scope until asked for.

<details>
<summary>中文说明</summary>

**Multica 实际是什么**：Linear 形态的 issue tracker，assignee 可以是 agent，外加一层 runtime 注册。`agent_runtime` 是独立实体（workspace + daemon_id + provider，带在线状态和心跳），agent 绑定到它上面；`agent_task_queue` 是 agent × issue 的派发队列；`issue` 有优先级、7 种状态、验收标准、截止日期、标签、项目；对话就是 issue 上的 comment。页面里有独立的 runtimes 和 runtimes/[id]。

**我们的状态**：底层协作规则已经具备；每个 `(agent, task)` 都是独立的顶层 ACP session，不再是 background subagent，同一 Agent 处理不同任务也不会共用 transcript。本地 `runtimeId` 已产生、校验并在面板展示，但这些 session 仍共享一个 ACP daemon；远程 host 注册、心跳、放置和进程级故障隔离尚未实现。工作项已有优先级和验收标准；标签、截止日期、project、squad、inbox 仍未实现。

**之前那个七八成错在哪**：我拿自己那份设计文档当卷子打分，而文档 §1 当时就把执行模型定错了。现在修正的是本地 demo 主链路；若按 Multica 完整产品计算，远程 Runtime、权限、项目和收件箱仍然不存在，不能再用百分比掩盖不同分母。

**方案四步**：A 让 agent 变成顶层 session（靠 sourceType 认领身份并加载人格），但不谎称它已有独立进程；B agent 的完整执行记录复用 Qwen Code 原有会话，shared thread 继续保存跨 agent 的指派、状态、@ 与验收，再复用现有列表壳和消息组件；C 工作项补上验收标准和优先级，标签和截止日期次之；D agent 变成可配置对象，并把已有 definition builder 与 persistent roster 合成一条创建路径。squad/inbox/projects 排在最后，且不是两个 agent 协作的必要条件。

**已定的三件事**：每个 Agent 可按 `maxConcurrentRuns` 并发多个任务；每个 task-scoped session 进入普通会话列表；删除采用退役语义，停止接活但保留任务内历史署名。

</details>
