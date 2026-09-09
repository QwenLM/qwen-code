# Multi-agent collaboration on a shared thread

> **Development handoff (2026-09-09):** Read the [Agent service architecture](../design/2026-09-09-agent-service-collaboration.md) and [successor implementation plan](./2026-09-09-agent-service-collaboration-plan.md) before continuing. Start at P0: independent default-off experimental gates. The successor architecture §8 explicitly identifies superseded decisions; other storage and safety contracts below remain applicable. Historical runtime observations are not evidence that the new service boundary is implemented. Do not resume the old §5.2 sequence by default.

> Current session-adapter caveat (2026-09-08): the earlier live demo below does
> not verify the replacement ACP-session execution path. Dispatch now prepares
> and binds a session before asynchronously activating its prompt. Live replies
> use durable rebooking, not mid-turn delivery. The new path still needs a live
> panel → agent → child task → human acceptance run.
>
> Earlier-path status: The two-agent happy path and Web demo are verified. Production paths
> exist for direct delivery, recovery, startup replay, source-first
> cancellation, and the Web surface, but the negative reliability matrix has
> not been run. Channel delivery is blocked on the destination decision in
> §9.12.
> Baseline: `origin/main` @ `703678136a` (2026-09-06)
> Verification: §0.2 separates earlier targeted checks from the first live
> two-agent run and from everything still unverified
> Supersedes the Agent-Team-first direction in [`2026-09-06-agent-team-webshell-gap.md`](./2026-09-06-agent-team-webshell-gap.md) §6
> Related: #9402 (board storage), #10078 (session boundary), #10247 §5, #11072, #11140

## 0. What this is

Durable agent identities that collaborate on a shared thread. A person opens a
thread, assigns an agent, and the agents take it from there — reading, posting,
`@`-ing each other, splitting sub-threads, and handing work back for review,
while the person can interject at any moment.

This is the Multica model, built on machinery Qwen Code already has. Agent Team
is untouched and stays the inner loop for sub-turn collaboration inside a single
run.

### 0.1 The correction this rests on

An earlier reading concluded Multica's agents "don't talk in real time". Source
inspection shows that conclusion was wrong, but also exposes an important scope
difference:

- `server/internal/daemon/types.go` (`PriorSessionID`) and
  `handler/daemon.go` (`GetLastTaskSession{AgentID, IssueID}`) — Multica resumes
  the prior session for one **(agent, issue)** pair. It does not give an agent
  one body shared across issues.
- `server/internal/daemon/wakeup.go` (`taskWakeupLoop`) — WebSocket push wakes
  idle claimers quickly; an HTTP polling fallback deliberately remains active.
- `server/internal/handler/comment.go` (`ReasonAlreadyActive`,
  `decidePostMergeMiss`) — a comment cannot enter an executing task, but it is
  not simply dropped: completion reconciliation replays the miss.

`@`-based coordination in Multica is live collaboration. Its limitation is
latency during an active run, not eventual delivery.

Qwen Code can deliver at a tool-round boundary, but the entry point matters.
`resumeBackgroundAgent` returns an already-running task without consuming its
continuation message. The working path is the same three-way split used by
`tools/send-message.ts`: `registry.queueMessage` for running,
`continueResidentAgent` for a completed resident runtime, and cold resume/revive
otherwise. `queueMessage` returning `false` during finishing is a delivery miss,
not success; §4 requires durable reconciliation before this design may claim an
advantage over Multica. Workspace agents delivery uses the lower-level
`queueExternalInput` with a correlated delivery id; the existing string-only
`queueMessage` wrapper is insufficient for a durable consumed watermark.

Decision 5 originally chose one memory-bearing body across threads. Source and
implementation review rejected that choice: it prevents real concurrency,
mixes unrelated task context, and differs from Multica's `(agent, issue)`
continuity. Identity now persists across the workspace while a top-level ACP
session is scoped to `(agent, thread)`.

### 0.2 What is verified, and what is not

Read this before treating anything below as established.

**Verified by reading source.** Claims about Qwen Code and Multica name the
load-bearing file and stable symbol. They were read directly, at the baseline
commit above for Qwen Code and at `multica-ai/multica@7a438bd5b` for Multica.
Re-check `BackgroundTaskRegistry.queueMessage`, `AgentEventType.EXTERNAL_MESSAGE`,
`AgentEventType.USAGE_METADATA`, `continueResidentAgent`, `runBackgroundTurn`, auto-compaction,
`PriorSessionID`, `taskWakeupLoop`, `ReasonAlreadyActive`, and
`decidePostMergeMiss` before changing the execution model.

**Verified in this subsystem foundation commit.** Targeted tests, core typecheck, and
targeted lint found and checked concrete defects that source review predicted:
`blocked` was absent from store validation, an unknown `@name` fell back to the
assignee, child budget fallback failed open, running work counted against the
pending queue, and a human reply on one child reset a sibling's turn gate. Those
checks validate only the rules/storage foundation, not this architecture. The
targeted test command and count are kept in §5.3.

**Verified in integrated runtime preparation.** A two-segment headless execution
reproduced `USAGE_METADATA.round` as `[1, 1]`; the cumulative-round patch changes
it to `[1, 2]`. Structured external input now carries `deliveryId` through the
consumed event and transcript, and resident continuation returns an actionable
result instead of a boolean. These contracts were merged from the draft
#11200/#11202/#11204 branches into #11206. Source and runtime
tests also disproved one round-2 premise: ordinary resident `task_prompt`
continuations already emit `EXTERNAL_MESSAGE`, and cold revival explicitly
seeds the continuation prompt in the transcript. Workspace agents still uses structured
input because correlation, not transcript presence, is the missing contract.

**Verified locally in steps 2-4.** The capability table denies shell and MCP
tools and passes its named test. The versioned store tests exercise
newer-version refusal, v0 migration and backup recovery, two-process sequence
allocation, source-first outbox replay, persisted admission outcomes, and
tree-wide token accounting. The step-4 tests exercise invocation-time tool
refusal, typed launcher outcomes, a singleton hidden host, default-catalog
exclusion, and host reload before a subsequent launch. The ACP bridge and child
handler have focused route tests. These are local observations only until the
merged step is green in #11206; the reload test runs the real bridge reaper
in-process with a fake ACP child, not a daemon process.

**Verified in the first live happy-path slice (2026-09-07).** A normal,
non-bare host launched Alice on an assigned root thread. Alice used
`thread_create` to assign Bob and ended with `thread_wait`; Bob posted three
results and ended the child with `thread_review`; the durable parent report was
applied in 13 ms; the same resident Alice body resumed on the root, summarized
Bob's work, and ended with `thread_review`. The child and root both finished
`in_review`, and Alice's two runs persisted `waiting` then `review`. All six
advertised `thread_*` tools were present in the model's function declarations.
No §6 prompt text changed to obtain this result.

The live run found one runtime-path defect: the continuation binder looked for
the agent sidecar below the workspace checkout, while background-agent
transcripts live below `Config.storage.getProjectDir()`. Consequently the first
parent wake failed before the resident continuation. Using the same storage
root as the launcher fixed the next run. A separate first attempt mentioned
both `@alice` and `@bob` in the human instruction and correctly woke both; the
demo input was corrected to address only Alice, with no routing-rule change.

**Verified through the real daemon and Web Shell demo path (2026-09-07).** The
Agents page created persistent identities and a root thread, the workspace-
qualified REST surface resolved the exact runtime, and the hidden host
dispatched bookings while the browser polled the ledger. With fresh
`alice-demo` and `bob-demo` bodies, Alice created one child and waited, Bob
reviewed it, the parent report woke Alice, and Alice reviewed the root. The UI
finished with the root `in_review`, the attributed result visible, and the two
Alice runs collapsed as history. The tree accounted 186,317 of 200,000 tokens.
This is a demo-path observation, not the full step-9 acceptance gate.

**Verified after correcting the session persona path (2026-09-08).** Source
review found that the child applied `Config.systemPrompt` only after
`Config.initialize()` had already bound the live chat's system instruction.
The default create path also loaded the built-in `general-purpose` definition,
whose prompt explicitly describes a subagent working for a parent. The child
now refreshes the live system instruction after persona and model resolution;
an Agent with no linked definition starts from its own workspace-Agent identity
instead of a subagent definition. A fresh Agent created in Web Shell with the
durable marker `PERSISTENT-ORCHID` received a new task-scoped session and
submitted: “My runtime role is an independent workspace Agent (not a
subagent), with the durable role marker PERSISTENT-ORCHID.” The person then
marked that task done. This proves the primary no-definition path; a linked
legacy definition is still treated as an optional behaviour template and its
identity contract is appended last, but that compatibility path has not been
separately exercised with a live model.

**Verified through the corrected product surface (2026-09-08).** The Agent
creation entry now begins with the same two choices the product intends to
support: model-assisted generation or manual configuration; both write one
persistent workspace Agent rather than requiring a subagent definition. The
Agent roster expands directly to that identity's assigned tasks. The shared
task list shows roots once and keeps child tasks under their parent; a child
detail links back to the parent. Thread bodies, acceptance criteria and posts
reuse Web Shell's Markdown renderer. A fresh task assigned to
`identity-proof` reached `in_review`, appeared under that Agent, and its
ordinary conversation appeared in the existing Agents session list as
`identity-proof · Session title acceptance`. Existing manually renamed
sessions remain untouched. This is local-daemon product-path evidence, not a
claim of a Multica-compatible remote Runtime.

**Verified through the existing local Runtime owner (2026-09-08).** Before the
registered-Host slice, the Agent surface projected Qwen Code's selected
`WorkspaceRuntime`, the workspace's durable
`hostSessionId`, and the bridge's real heartbeat. Restarting the daemon kept
host session `f210855f-45ab-4624-a858-bf11785e22d0`; the non-empty roster
restored its owner without a task mutation, and the displayed heartbeat moved
from 20:29:10 to 20:29:19. The Runtime view also showed provider, Agent/session
counts, and running/queued task counts. A binding unknown to this daemon is
reported offline and the dispatcher leaves its work queued as
`runtime_unavailable`; it is not converted into a terminal launch failure.
This proves the one local host and its restart continuity, not remote
registration or placement.

**Verified through registered-Host H1 (2026-09-08).** The primary daemon now
owns a workspace-scoped Host registry. A ten-minute one-time credential was
exchanged by a second `qwen serve` process for Host
`host_d43cad67-c491-4915-9186-481732a0458e`; replaying the enrollment returned
401. Its provider and workspace advertisement appeared beside the local daemon
in the Runtime view. Stopping it for more than the 15-second liveness window
changed the stored Host to offline. Restarting it without the enrollment token
restored the same Host id, and restarting the primary daemon while it was alive
produced a heartbeat failure followed by automatic reconnection with that same
id. This proves registration and liveness only: H1 does not permit binding an
Agent to that Host or executing a run there.

An earlier browser run exposed a prompt-level ping-pong: Bob and Alice used
peer mentions in result prose, and each mention correctly booked another run.
That tree reached 253,320 accounted tokens and blocked before the parent could
resume. The prompt now says that an at-sign address books work, forbids it in
status/result prose unless another wake is intended, and reminds the agent that
child completion already reports to the parent. Re-running with fresh bodies
removed the unintended bookings and completed the loop.

**Still unverified.** Running-delivery miss reconciliation, the 12-turn
ping-pong gate, stall recovery, daemon host replacement/reaper, bare-mode tool
exposure, and notifications have not been run end to end. Daemon restart and
accepted-but-unconsumed replay have been observed with the same run recovering
on attempt 2, as recorded in the acceptance document.
Production paths now exist for correlated running delivery, delivery-race
rebooking, one retry after restart or a three-minute no-activity stall, stale
host replacement after a definitive resume failure, source-first cancellation,
startup replay, and attempt-guarded late callbacks. They have deliberately not
been tested locally while the demo path is being completed. Cancellation,
transcript slicing, blocked-question rendering, inline children, and
deleted-agent tombstones have been exercised through the real daemon and
browser.

The first deliberate live ping-pong attempt also showed that the two settled
default gates cannot both be reached with the current model footprint. Alice
and Bob produced three unattended deliveries before the thread reached 428,636
accounted tokens; the 200,000-token gate therefore pre-empted the 12-turn gate.
Both agents did run concurrently, and a coalesced mid-run delivery was accepted
and consumed, but the receiving model closed without producing another reply.
This is an observed acceptance constraint, not evidence that the turn gate is
broken. A later Alice → Bob child → Alice run reached 257,895 accounted
tokens before the parent continuation, so the default gate was raised to one
million tokens; a full 12-turn runtime proof still needs a cheaper/minimal model
frame or an explicit scenario-only token-limit override.

**How to re-check the Multica claims.** Clone `github.com/multica-ai/multica`
and read `server/internal/daemon/types.go`, `server/internal/daemon/prompt.go`,
`server/internal/daemon/wakeup.go`, and `server/internal/handler/comment.go`.
Line numbers drift; the symbols (`PriorSessionID`, `taskWakeupLoop`,
`ReasonAlreadyActive`, `decidePostMergeMiss`) do not. An earlier version of this
design was wrong about Multica precisely because it reasoned from the docs
rather than these files — argue from the symbols, not from the marketing pages.

## 1. Execution model

**An agent has one top-level ACP session per thread it works on.** Runs by the
same agent on the same thread resume that session; work on another thread gets
another session. The current bridge multiplexes these sessions in one ACP
process, so a session is not an OS-process boundary.
The owner's clarified acceptance target is task orchestration visible and
controllable in the panel, not process isolation. Keep the existing identity,
task and session layers; do not introduce a runtime rewrite for this demo.

The session port prepares the session first. Dispatch persists the run/session
binding and pre-prompt usage baseline before activating model execution, without
waiting for turn completion. The port reports the active run identity and any
asynchronous failure for subsequent reconciliation. Replies received while busy
enter the existing correlated session-input channel and are consumed at a tool-
round boundary; this is not token-stream interruption.

### 1.1 The correction this replaces

An earlier revision of this section chose **one long-lived background agent per
workspace** — a subagent inside a hidden host session — and called it "the
design's biggest correction". The reasoning was that the persona machinery
(`subagent-manager.ts` → `{promptConfig, modelConfig, runConfig, toolConfig}`)
targets the agent runtime rather than ACP sessions, and that `BridgeSpawnRequest`
carries no persona field, so a per-session persona hook would be "new work on a
hot path with no precedent".

That reasoning was about implementation cost, and it silently traded away the
property the whole subsystem exists to provide. Under it:

- Every agent shares one process, so one agent's crash, memory growth or
  runaway loop is every agent's. Decision 1 (read-only) was partly a way to
  live with that; it is not a substitute for isolation.
- "Independent identities" was true of the _records_ and false of the
  _execution_. The roster looked like Multica's; the runtime was a fan-out of
  subagents.
- §10 listed "real OS-process isolation" as out of scope and §7 scored runtime
  binding at zero, which was honest bookkeeping of a gap that should never have
  been opened.

The cost argument was also wrong on its facts. A session _can_ carry a persona
today, and the pieces were already in the codebase when that paragraph was
written:

- **Prompt.** `Config.systemPrompt` is read by `getMainSessionBaseSystemPrompt`,
  which uses `getCustomSystemPrompt(...)` instead of the default core prompt
  when it is set. That is the per-session prompt hook the paragraph said did not
  exist.
- **Tools.** `deriveConfig` already overrides `getToolRegistry` and
  `getToolInvocationGuard`; #11224 built this subsystem read-only guard on exactly
  that seam for subagents, and it applies unchanged to a session.
- **Model.** `getModel` is overridable the same way, and the roster already
  carries a per-agent model.

So the persona machinery does not have to be rebuilt. It has to be pointed at a
session instead of a subagent.

`BridgeSpawnRequest` genuinely has no persona field. But the agent host session
already proves the mechanism that closes that gap: it is spawned with
`sourceType: 'agent-host'` and the child _recognises itself_ at `newSession` and
behaves accordingly. An agent session uses the same mechanism with
`sourceType: 'agent'` and `sourceId: <agent id>`: the child reads the
workspace roster, finds its own identity, and applies that agent's definition to
its own `Config` before the session goes live. No new bridge field, and the
persona machinery is used where it already works.

### 1.2 What this changes, and what it does not

The layering was built so that this swap is possible, and it holds. Unchanged:
the store and its transaction protocol, admission and the budget gates, the
status aggregate, run close and the outbox, the six thread tools, the prompt
envelope, REST and Web Shell. All of it addresses agents by `WorkspaceAgent.id` and
threads by file, and none of it knows how a body is started.

What changes is the runtime seam, and only it:

| Concern                | Was                                                              | Becomes                                                                               |
| ---------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| A body                 | background agent `workspace agents-<id>` inside the host session | a top-level ACP session keyed by `(agent id, thread id)` with `sourceType: 'agent'`   |
| Persona                | `convertToRuntimeConfig` into a subagent `toolConfig`            | the same conversion, applied by the child to its own session `Config` at `newSession` |
| Start a turn           | `launchProgrammaticBackgroundAgent`                              | `bridge.spawnOrAttach` then a prompt into that session                                |
| Inspect                | `registry.get('workspace agents-<id>')`                          | the bridge's live-session record for that agent and thread                            |
| Mid-run steering       | `registry.queueExternalInput`                                    | the session's existing mid-prompt input path                                          |
| Per-turn binding       | `AgentMeta.agentRun` read at the in-process turn seam            | the same record, read at the agent session's turn seam                                |
| Usage and drain events | `AgentEventEmitter` in the host process                          | the session's own event stream                                                        |

`dispatch-port.ts` is the whole of it: the dispatcher, its rules, and every
outcome it can record are unchanged, because the port was always the only thing
that knew what a body is.

The hidden host session stays, with a smaller job: it owns nothing but the
dispatch loop. It no longer contains the agents.

### 1.3 What session separation buys, and what it does not

Each agent gets its own identity, persona and model setting. Each task gets an
isolated context and transcript, matching Multica's `(agent, issue)` resumption
scope and allowing one agent to work several tasks without mixing them. It is
not crash isolation: the current ACP bridge multiplexes those sessions in one
process, so a process failure affects every local agent session.

The cost is N live session contexts and model clients inside that process. A
local roster is expected to stay small — two to five agents — and the machine's
memory is the practical limit. The registered-Host H1 slice adds durable
identity, advertisement and daemon heartbeat, but remote Agent execution and
per-agent process boundaries still require the H2 run protocol; this demo does
not claim those capabilities.

Everything the execution layer needs still exists:

## 2. Settled decisions

Twenty-two decisions, all confirmed with the product owner and refined below.
Recorded so implementation does not relitigate them.

### Scope and safety

| #   | Decision                                                                                                                                                                            | Consequence                                                                                                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **v1 agents are read-only.** No file writes, no worktrees, no branches.                                                                                                             | Removes all concurrent-write design. The deliverable of a thread is a conclusion, not a diff.                                                                                                                                                 |
| 2   | Read-only means **workspace file-reading tools only**. Shell, MCP, `save_memory`, context-file writes, and every other persistent-write or host-wide tool are outside that ceiling. | A read-only shell classifier does not confine absolute paths, so it cannot protect secrets outside the workspace. Shell stays denied until execution has a real filesystem sandbox. Agent definitions may narrow the ceiling, never widen it. |
| 3   | A workspace Agent owns its identity instructions and model. An existing agent definition is an optional template/base, never a second required identity.                            | The primary creation flow writes one Agent record. Linked legacy definitions may narrow the same read-only ceiling; a missing linked definition remains an explicit configuration error.                                                      |
| 4   | Agents are **scoped to one workspace**.                                                                                                                                             | Trust and permissions follow the workspace. Five repos means five rosters.                                                                                                                                                                    |

The owner settled the v1 MCP policy: every MCP tool fails closed. A later
release may admit only individual tools whose policy can prove they are
read-only; a private server or trusted-looking name is not evidence.

### Identity and memory

| #   | Decision                                                                                                                                                                                                                                                                                                        | Consequence                                                                                                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Identity persists across the workspace; execution context persists per `(agent, thread)`.**                                                                                                                                                                                                                   | Matches Multica's per-(agent, issue) session continuity. The same task resumes with context, unrelated tasks cannot pollute each other, and one identity may work several tasks concurrently.                                                                                           |
| 6   | Context growth uses runtime **auto-compaction**, but every run prompt remains self-contained.                                                                                                                                                                                                                   | Compaction exists but is lossy; it invalidates any assumption that an earlier thread frame or delivery is still remembered.                                                                                                                                                             |
| 7   | The **host session is hidden and kept alive** while workspace agents exist.                                                                                                                                                                                                                                     | The user's model stays "agents and threads". Losing the host degrades resident continuation to transcript-backed cold revive and must be observable.                                                                                                                                    |
| 8   | **Disabling stops new work; deleting retires the identity and never rewrites history.** Deletion refuses while any run is non-terminal, then closes the agent's session and marks the roster entry retired: it stops being addressable, its status reads `offline`, and every post it ever made keeps its name. | Multica's shape, and the honest one. An agent's posts are evidence another agent reasoned from; erasing the author would make a thread unreadable after the fact. Disable-and-drain remains the reversible middle: already-booked work drains, new work is refused, the session may go. |

### Conversation

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Consequence                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | A message **may enter a running agent only on its bound thread**. Queue acceptance and correlated runtime consumption are recorded separately; undrained input is reconciled from durable triggers.                                                                                                                                                                                                                                                                                                                 | Mid-run steering is at-least-once, never a success-shaped prediction. Duplicate delivery is allowed; silent loss is not.                                                                                                   |
| 10  | An agent runs **up to `maxConcurrentRuns` task sessions at once** (default 1). Pending work is selected globally by lock-issued `(queueSequence, runId)` FIFO; `queuedAt` is diagnostic only.                                                                                                                                                                                                                                                                                                                       | Mirrors Multica's `max_concurrent_tasks`. Separate task sessions make the configured concurrency real even though those sessions still share one ACP process.                                                              |
| 11  | Each agent has a **bounded pending queue**; running work is not counted. Full queues and launch failures are explicit outcomes.                                                                                                                                                                                                                                                                                                                                                                                     | `queueLimit=5` means five waiting runs, not four plus the active one; failed launches cannot occupy a slot forever.                                                                                                        |
| 12  | Agents may **post, `@` any enabled workspace agent, change status, and create sub-threads**. They may not create agents.                                                                                                                                                                                                                                                                                                                                                                                            | This is intentionally looser than Multica's per-agent invocation policy. Every agent action is stamped with its ambient run for provenance.                                                                                |
| 13  | A sub-thread becoming quiescent writes a durable, system-authored **parent dependency event** attributed to the child transition. `in_review` carries the summary; aggregate blocked and terminal run failure/cancellation carry their state. Human-set done reports only while the parent still needs work; an `in_review` or `done` parent already consumed the child's review and reads the child's final state directly. It targets the parent assignee; with none, it remains visible and notifies the person. | A waiting parent is always woken or visibly stranded, cross-file posting survives a crash, and accepting a child cannot start a redundant parent run after the parent already submitted its review.                        |
| 14  | Blocking is one atomic operation: **post the question, record the caller blocked, and end that run**. The thread becomes `blocked` only when no other work can progress.                                                                                                                                                                                                                                                                                                                                            | One agent cannot overwrite a shared thread's status while another is still working. A human reply that actually books/delivers work acknowledges current blockers and returns it to `in_progress`.                         |
| 15  | An agent closes a run with atomic `thread_wait()`, `thread_block(question)`, or `thread_review(summary)`; **only a person sets `done`**. Waiting is allowed only with another live run or child dependency; a same-thread wait is acknowledged by any later close or human post on that thread. `in_review` is reached only after all booked work is quiescent. Marking done refuses non-done descendants, then cancels this thread's queued/running work.                                                          | Delegation can release the parent agent body without falsely asking a person or claiming review. The final explanation and workflow state cannot split across a crash, and closing a parent cannot orphan live child work. |

### Cost and failure

| #   | Decision                                                                                                                                                                                                                                                                                                                                      | Consequence                                                                                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 16  | Two gates: **12 unattended agent deliveries per thread / 1M accounted tokens per thread tree**. A human post resets only that thread's turn counter; the token gate applies to every trigger. `coalesce(running)` costs a turn, `coalesce(queued)` does not.                                                                                  | Turn count is a local loop breaker; token count is money. A sibling comment cannot reset a loop, and a human message cannot bypass known spend; strict reservation versus bounded in-flight overshoot remains §9.5. |
| 17  | A child **inherits the parent's current turn count** and charges tokens to the root.                                                                                                                                                                                                                                                          | Creating a child does not mint immediate unattended turns; a child created at the limit may be gated immediately. Later human input resets only the child being supervised.                                         |
| 18  | A run is stuck after **three minutes with no model/runtime activity and no tool in flight** — not by total duration. Workspace agents reuses the existing workflow stall watchdog and its progress definition.                                                                                                                                | A legitimate long-running tool is never killed for being slow, and workspace agents does not invent a second watchdog policy.                                                                                       |
| 19  | A stuck run, and any run still `running` after a **daemon restart**, is reconciled once. Restart-recovered registry entries are `paused` and use `resumeBackgroundAgent`; completed entries use resident continue or cold revive. A second execution failure is terminal. A launch failure is typed and terminal unless classified transient. | Recovery follows the runtime's actual state machine and replays only work not committed by the delivery watermark; queued launch failures cannot poison the backlog indefinitely.                                   |

### Surfaces

| #   | Decision                                                                                                                                                    | Consequence                                                                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 20  | The entry point **folds into the existing Agents page**; #11140's sidebar change is absorbed here and that PR is closed.                                    | One PR, no dependency ordering, and the "Agents" entry finally means runnable agents.                                                                                                                                   |
| 21  | Creating or assigning a thread with an assignee emits a **structured assignment trigger** through the same booking transaction; no assignee leaves it idle. | Assignment cannot bypass budgets, provenance, queue limits, or the dispatch outcome model. The assignee is a future-routing default, not an exclusive lease; reassignment does not silently cancel already-booked work. |
| 22  | Channel notifications (Lark/Slack/…) fire on **a blocker raised, aggregate in_review, gate tripped, and run failed after retry**.                           | The four things that need a person. Reuses the existing channel workers.                                                                                                                                                |

## 3. Data model

```
AgentWorkspaceState  schemaVersion, workspaceId, hostSessionId,
                    nextRunSequence
AgentAgentsFile      schemaVersion, agents[]
AgentHostsFile       schemaVersion, hosts[], enrollment?

AgentHost            id, name, secretHash, workspaceCwd, providers[],
                    createdAt, lastSeenAt

WorkspaceAgent           id, name, description, color, agentType, model,
                    instructions, queueLimit, maxConcurrentRuns,
                    enabled, createdAt, retiredAt,
                    runtimeId                                ← execution binding

Thread              schemaVersion, id, title, body, acceptanceCriteria,
                    status, priority, assigneeAgentId, createdAt,
                    createdBy, messages[], runs[],
                    parentThreadId, rootThreadId,
                    autoTurnsUsed, tokensUsed,
                    nextMessageSequence, deliveryByAgent{}, outbox[]

ThreadMessage       id, sequence, authorKind, from, authorNameSnapshot,
                    sourceRunId, triggerKind, text, mentions[], outcomes[], at,
                    originEventId
ThreadRun           id, agentId, sessionId, status, triggerMessageIds[],
                    acceptedMessageIds[], consumedMessageIds[],
                    contextThroughSequence, definitionVersion,
                    transcriptStartOffset, transcriptEndOffset,
                    closeKind, closeAcknowledgedAtSequence,
                    finalMessageId, usageByRound[],
                    failureStage,
                    queueSequence, queuedAt, startedAt, endedAt, attempts, error

AgentDelivery       committedThroughSequence
DispatchOutcome     targetAgentId, targetAgentName, kind, reason, runId, into
ThreadEvent         id, kind, causedByRunId, payload, status, attempts,
                    createdAt

ThreadStatus        open | in_progress | blocked | in_review | done
ThreadRunStatus     queued | running | finishing | cancelling |
                    completed | failed | cancelled
RunCloseKind        waiting | blocked | review | unclosed
```

V1 declares and validates this whole shape in one storage version. The owner
chose one migration rather than serial schema bumps for fields already designed
for steps 5-8. Fields whose producers do not exist yet remain optional and do
not claim that delivery, provenance, recovery, or transcript slicing is
implemented. `hostSessionId` is a workspace singleton. `runtimeId` is the
generic execution binding. New local Agents store `runtimeId: "local"`; v1
records written before that producer existed read an absent field as the same
local binding. A task session id is derived from `(agent id, thread id)` and is
stored on each run, so there is no ambiguous Agent-wide conversation handle.

`authorKind` is `human | agent | system`. Until the ambient producer lands in
step 5, migrated and rule-layer posts may omit `sourceRunId` and `triggerKind`.
Once that producer exists an agent post requires `sourceRunId`; the server
derives it and the author kind from the ambient run rather than accepting them
from the model or an HTTP body. A system trigger records the run or human action
that caused it. This provenance does not neutralise prompt injection, but it
prevents identity spoofing and makes every automated hop auditable.

Deleting an agent removes its runnable identity and transcript, not the audit
meaning of old posts. Messages therefore retain the author's display-name
snapshot; ids are never reused. A missing or changed live agent cannot rewrite
history.

Admission outcomes are stored on the message in the same transaction as run
booking. Returning them to the immediate caller is only a convenience; a reload
must still explain an unknown target, gate, queue refusal, coalesce, or booking.

`outbox` covers side effects that cannot share the thread-file transaction:
parent dependency reports and channel notifications. Consumers acknowledge
event ids, so a restart may duplicate an effect but cannot silently lose it.
The parent post stores the event id as its idempotency key. Token accounting is
not an outbox effect: usage is stored on the run that produced it and summed
across the root's thread tree under the workspace lock.

Message sequence is monotonic per thread. `triggerMessageIds` means durably
booked; `acceptedMessageIds` means the runtime queue accepted those inputs;
`consumedMessageIds` is recorded from the correlated `EXTERNAL_MESSAGE` event
when the old background runtime drains them. In the ACP session path, daemon
input carries the run metadata and delivery watermark; the session checks the
ambient binding, flushes the initial or mid-turn transcript record, then records
the consumed window under the workspace lock. Queue acceptance is not that
receipt.
`committedThroughSequence` advances only across a
contiguous consumed context window. On a failed enqueue, execution failure, or
daemon restart, reconciliation rebooks everything not consumed and committed.
Delivery is therefore at-least-once: a duplicate is acceptable, silent loss is
not.

An explicit closing tool is not a consumption receipt. Finishing a run preserves
its recorded consumed ids; it must not promote accepted ids to consumed. Once
finishing/completed, accepted-but-unconsumed triggers are eligible for successor
booking too. While running, accepted inputs remain owned by the active runtime.

Run queue order is a separate workspace-wide monotonic `queueSequence`, issued
while holding the workspace mutation lock. `queuedAt` remains useful for age and
stall display but never participates in FIFO ordering because callers live in
different processes and their wall clocks can disagree.

At run start and direct delivery, the dispatcher sends one contiguous context
window through `contextThroughSequence`, not just the triggering ids. The
initial prompt becomes consumed only after its transcript record is durable;
direct input follows the same transcript-before-receipt order. This makes the
scalar watermark honest even when intervening posts targeted another agent. A
clean but `unclosed` return blocks the workflow yet commits only demonstrably
consumed input. A
durable `blocked`/`review` close marker likewise lets restart reconciliation
finish the workflow close without pretending an accepted-but-undrained message
was read.

Exact retries of mutating workspace agents tools are deduplicated by a runtime-derived action
key `(runId, attempt, invocationSequence)`; the invocation sequence is assigned
outside model arguments. This does not make a full model replay exactly-once: a
crash after a visible post may produce a semantically duplicate post on the next
attempt. That product trade-off remains explicit in §9.

A workspace agent owns one append-only JSONL transcript per thread. Runs on that
thread are byte ranges within the file, captured after writer flush. Another
thread has another transcript.

`maxConcurrentRuns` bounds how many threads one agent works at once, and
`queueLimit` bounds how much may wait behind it. They are different questions —
throughput and backlog — and an earlier revision collapsed them because a
subagent could only ever have one live run. Task-scoped top-level sessions make
that a policy rather than a fact, so it is a field with a default of 1.

`rootThreadId` is inherited at creation rather than resolved by walking parents
at spend time. Missing or invalid roots fail closed. A child inherits the
parent's `autoTurnsUsed`; token spend is summed from runs on every thread with
that root id.

The workspace lock prevents concurrent writers; it does **not** make two JSON
files one transaction. A thread post, its admission outcomes, and its booked run
share one atomic thread-file replacement. For an assigned new thread, the
thread, assignment message, outcomes, and first run are all written by that
initial replacement, so no empty assigned thread can survive a crash. Cross-file
parent reports and notifications use durable, idempotent outbox events. Every runtime
`USAGE_METADATA` event upserts `(runId, attempt, cumulativeRound, usage)` on the
source run; duplicate events replace the same entry. Admission sums
`runs[].usageByRound` across the root's thread tree under the workspace lock
before checking the token gate. Each thread's `tokensUsed` is a validated cache
of its own runs, not the source of truth. Transcript round usage can reconstruct
a missing run entry; finish reconciles rather than creating the first usage
record. Parent reports
and notifications use write-source-first, apply-idempotently,
acknowledge-last.
Thread deletion refuses non-terminal runs, descendants, or unacknowledged
outbox events; otherwise it could erase work or a side effect another file has
not yet observed.

Every released state file carries `schemaVersion`. A supported old version is
migrated under the workspace lock with atomic replacement; an unknown newer
version or failed migration is a fail-closed error, never treated as empty
state. The pre-migration file is retained until the replacement validates.

Stored under the per-project runtime dir (`~/.qwen/tmp/<project-hash>/agent-host/`),
not the working tree — the reasoning the durable scheduled-tasks file records,
plus one more: thread text is written by one agent and fed to another, so it is
a prompt-injection surface and must never be committed, pulled, or reviewed as
if it were code.

## 4. The dispatch loop

```
person, agent, assignment, or child-dependency event
        │
        ▼
postMessage()  ── one workspace mutation lock ──────────────────┐
  append sequenced + attributed message/trigger                 │
  resolveTargets: any explicit @ token suppresses assignee      │
  for each target → decideDispatch                              │
  append/coalesce run and charge local turn                     │
        │                                                       │
        ▼                                                       │
returns { outcomes, dispatched[] } ─────────────────────────────┘
        │
        ▼
dispatcher (daemon)
  scan durable dirty runs/events; process-result notifications are only hints
  choose each agent's oldest queued run by (queueSequence, runId)
    running on THIS thread → registry.queueExternalInput(agent delivery)
       true  → record accepted ids on the run
       false → atomically detach/rebook unaccepted ids
       drain → correlated EXTERNAL_MESSAGE records consumed ids
    running on ANOTHER thread → leave queued; expose active thread
    idle → unbound: launch; paused: resume; completed: continue
           (the registry decides hot vs transcript and reports which)
       capacity → leave queued; expose capacity_wait
       claim queued run before runtime start
       accepted → bind session + record prompt watermark/transcript start
       failed   → terminal failed(failureStage=launch); release queue slot
        │
        ▼
agent answers via thread_post ─────────────────────────────────► re-enters postMessage
        │
        ▼
turn completes → flush transcript → finishRun
  commit the contiguous consumed window, including a clean but unclosed return
  reconcile per-round run usage, unconsumed ids, and cross-file outbox
  select next FIFO run
        │
sweeper: run with no activity for N minutes, or `running` at daemon start
        → reconcile; paused registry entry resumes, completed entry revives;
          second failure → terminal failed
```

The loop closes because an agent's reply is itself a post. That is the whole
mechanism, and it is why the guards are not optional.

### Admission table (under the workspace mutation lock)

| Outcome                        | When                                                                            | Why it exists                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `skip: agent_unknown`          | an explicit `@token` resolved to no roster identity, or an assignee disappeared | a typo must be visible and must not fall back to the assignee                    |
| `skip: agent_disabled`         | agent exists but is off                                                         | keeps identity and history without taking work                                   |
| `skip: thread_done`            | thread is finished                                                              | a late post must not silently restart spend                                      |
| `skip: self_trigger`           | the target wrote the post                                                       | otherwise one "I'm done" becomes an infinite self-conversation                   |
| `skip: no_target`              | no explicit mention and no assignee                                             | an accepted-looking post must not disappear silently                             |
| `skip: turn_budget_exhausted`  | agent-caused trigger, this thread's turn budget is spent                        | the local loop breaker; only a human post on this thread resets it               |
| `skip: token_budget_exhausted` | the root tree's accounted token budget is spent                                 | money gate for human and agent triggers; never reset; in-flight policy is §9.5   |
| `skip: queue_full`             | the agent's backlog is at its limit                                             | makes real throughput visible instead of accruing a stale queue                  |
| `coalesce (queued)`            | the agent has an unstarted run here                                             | one run answers both posts instead of two racing                                 |
| `coalesce (running)`           | the agent is executing **this** thread                                          | records intent to attempt mid-run delivery; agent-caused delivery charges a turn |
| `dispatch`                     | none of the above                                                               | book a queued run                                                                |

Explicit routing is a target-resolution rule, not a synthetic skip outcome: the
presence of any `@token`, including an unknown one, suppresses assignee fallback.
Known and unknown tokens in the same post produce their own outcomes; known
targets still run. These eleven outcomes are the complete admission contract.
Definition availability is deliberately not a twelfth admission outcome: it is
known only when the runtime loads the required definition, so the dispatcher
records a typed terminal launch failure without creating an agent body.

Malformed input, authentication failure, missing/corrupt storage, lock failure,
and unknown schema version abort the mutation as typed API errors; they are not
success-shaped dispatch outcomes. Retrying a mutation with the same runtime
action key returns its previously persisted message and outcomes rather than
booking again.

### Dispatcher results (after booking)

| Result              | Required state change                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `accepted_running`  | add ids to `acceptedMessageIds`; correlated drain events move them to consumed                              |
| `delivery_race`     | `queueExternalInput` returned false or the run began finishing; rebook unaccepted ids                       |
| `busy_other_thread` | leave queued and expose the active thread id; do not mutate admission outcome                               |
| `capacity_wait`     | leave queued and expose runtime-capacity backpressure; do not consume a launch attempt                      |
| `started`           | bind the run/session, prompt watermark, and transcript start atomically                                     |
| `launch_failed`     | mark terminal `failed` with typed `failureStage`; release pending capacity and notify after retry policy    |
| `cancelling`        | request cancellation of the bound active attempt; remain stopping while the runtime still reports running   |
| `cancelled`         | mark queued runs cancelled immediately; for active work, confirm the runtime stopped and charge usage first |
| `unclosed_run`      | preserve final text and commit consumed input; if no successor is runnable, block instead of guessing done  |

The booking outcome and dispatcher result are intentionally separate. A durable
queued run remains true until changed under lock; "busy right now" is an
ephemeral observation. That is the reason there is no rules-layer `defer` — not
because the rules know nothing about run state (coalescing and queue limits
plainly do). Across threads, the dispatcher scans all queued runs for an agent
and selects the minimum `(queueSequence, runId)` so leaving work queued cannot
create file-order starvation or inherit caller clock skew. Registry capacity is
the same kind of momentary fact and
therefore appears as dispatcher result `capacity_wait`, not an admission reason
or terminal launch failure. `thread_wait()` is unrelated: it is an explicit,
durable workflow close after delegation, not a scheduler prediction about when
an already-booked run can start.

All workspace agents mutations take one workspace lock in v1. At this scale, serial writes
are cheaper and safer than a lock hierarchy across agent, root, child, and
outbox files. It makes cross-thread pending counts and root-token reads
authoritative at the instant they are read; it does not provide cross-file crash
atomicity, which is handled by the outbox protocol in §3. `otherThreads` is not
an optional caller hint in the final API.
The daemon scans durable unaccepted triggers and outbox events after startup and
periodically, so a crash between a successful file write and an in-process wake
notification only adds latency.

Cancellation intent is persisted before the runtime is touched. Once a run is
`cancelling`, any racing completion callback resolves it as `cancelled`; a late
normal return cannot reverse the person's stop request.

### Status transition matrix

| Action                                                                                                              | Allowed from           | Result and durable side effects                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| first successful booking/delivery                                                                                   | `open`                 | `in_progress`                                                                                                                           |
| human feedback that successfully books/delivers                                                                     | `blocked`, `in_review` | acknowledge applicable blockers/review candidates, set `in_progress`, reset only this thread's turn count; target scope remains §9.11   |
| `thread_wait()` from the bound run with another live run (excluding itself) or a descendant with a future wake path | `open`, `in_progress`  | record `closeKind=waiting`, mark run `finishing`, keep `in_progress`; no person notification                                            |
| `thread_wait()` without a live dependency                                                                           | `open`, `in_progress`  | reject; the agent must block, review, or continue working                                                                               |
| `thread_block(question)` from the bound run                                                                         | `open`, `in_progress`  | append question, record `closeKind=blocked`, mark run `finishing`, enqueue blocker notification atomically                              |
| `thread_review(summary)` from the bound run                                                                         | `open`, `in_progress`  | append summary, record `closeKind=review`, mark run `finishing` atomically                                                              |
| any admission books/delivers nothing and leaves no runnable target                                                  | any non-`done`         | persist all outcomes, set `blocked`, enqueue one deduplicated notification; includes gates, disabled/unknown assignees, and `no_target` |
| terminal launch/execution failure leaves no runnable target                                                         | any non-`done`         | append system failure, set `blocked`, enqueue failure notification                                                                      |
| clean run exit without `thread_block`/`thread_review`                                                               | `in_progress`          | append final text, commit consumed input, record `closeKind=unclosed`; block only if no successor is runnable                           |
| human marks done with a non-done descendant                                                                         | any non-`done`         | refuse and return the descendant ids; v1 never silently cascades                                                                        |
| human marks done with no non-done descendant                                                                        | any non-`done`         | set `done`, cancel queued runs, request running cancellation                                                                            |
| any late post                                                                                                       | `done`                 | append for audit, persist `thread_done`, never book or reopen                                                                           |

Thread status is an aggregate, not last-writer-wins. While any run is queued,
running, or finishing, the thread stays `in_progress` (unless a person set
`done`). At quiescence, an unacknowledged blocker, terminal failure, unclosed
run, or wait whose dependency vanished without a bookable parent event takes
precedence and yields `blocked`; otherwise at least one unacknowledged review
close yields `in_review` and emits the parent report. A same-thread wait is
acknowledged by any later close record or human post on that thread. Any later
successful booking acknowledges earlier terminal failure and unclosed records;
otherwise a recovered workflow could remain pinned by an obsolete failure after
useful work continued. A successfully booked parent dependency event
acknowledges the matching cross-thread wait. Human blocker acknowledgement
remains target-scoped product work in §9.11. This defines the cases where one
agent waits, blocks, or reviews while another is still working without inventing
a separate blocker object.

All transition checks and same-thread side effects happen under the workspace
lock. Parent reports and channel sends leave through the outbox because they
cannot be atomic with that file. Repeated reconciliation uses the event id,
message id, and run id as idempotency keys. The tool cannot mark its own
still-executing runtime completed: it moves the run to `finishing`, causes the
agent turn to terminate, and the runtime callback records the terminal state.
`cancelling` serves the same restart-safe purpose for a human stop.

Agent-caused work is charged when it books a new run or records delivery intent
for a running run. A delivery race rebooks that same charged intent; it does not
charge again. Coalescing into an unstarted run is free because it starts no extra
turn. A human post resets only that thread's turn count. Tokens are derived from
idempotent per-round usage entries on runs across the root's tree and never
reset.

`assigneeAgentId` controls fallback routing only. Reassignment emits one
structured trigger to the new assignee and affects future posts; it does not
cancel work already accepted by other agents. Unassignment emits no trigger.
Structured assignment and parent-dependency events are system-authored but retain
their causing human action or agent run, so they are charged correctly without
being suppressed as ordinary self-authored posts.
Only a direct human mutation on this thread resets its turn counter. A
cross-thread dependency event remains an unattended delivery even when a human
action on the child caused it.

## 5. Module map

Implemented on the single #11206 delivery branch:

| File                                                      | Responsibility                                         |
| --------------------------------------------------------- | ------------------------------------------------------ |
| `core/src/agents/workspace-agents/types.ts`               | Entities and limits                                    |
| `core/src/agents/workspace-agents/store.ts`               | Paths, validation, locking, CRUD and Host registry     |
| `core/src/agents/workspace-agents/mentions.ts`            | `@name` → agent ids                                    |
| `core/src/agents/workspace-agents/dispatch-policy.ts`     | `decideDispatch` — pure                                |
| `core/src/agents/workspace-agents/thread-actions.ts`      | `postMessage` — append and book under one lock         |
| `core/src/agents/workspace-agents/thread-status.ts`       | Aggregate status over every run's close obligation     |
| `core/src/agents/workspace-agents/run-lifecycle.ts`       | Run close, terminal state, status application, outbox  |
| `core/src/agents/workspace-agents/run-context.ts`         | Per-turn ambient `(agent, run, thread)` binding        |
| `core/src/agents/workspace-agents/prompt.ts`              | Turn envelope: thread frame, delta, gap, peers         |
| `core/src/agents/workspace-agents/capability.ts`          | Read-only name and invocation boundary                 |
| `core/src/agents/workspace-agents/persona.ts`             | Resolves an agent's persona for its own session        |
| `core/src/tools/thread-tools.ts`                          | The six thread tools; ambient identity only            |
| `core/src/agents/workspace-agents/dispatcher.ts`          | FIFO selection, runtime entry point, parent reports    |
| `cli/src/serve/workspace-agents/session-dispatch-port.ts` | The one binding to the local agent session runtime     |
| `cli/src/serve/workspace-agents/agent-host-session.ts`    | Hidden ACP host ownership, keepalive, reload           |
| `cli/src/serve/routes/agent-hosts.ts`                     | Scoped Host enrollment and heartbeat transport         |
| `cli/src/serve/agent-host-client.ts`                      | Remote daemon credential and heartbeat client          |
| `cli/src/acp-integration/acpAgent.ts`                     | Applies the persona when an agent session spawns       |

### 5.1 Local review correction — committed and verified

1. Store validation accepts `blocked`; missing roots fail closed; a child
   inherits its parent's current turn count; deletion refuses active runs and
   thread trees that would orphan descendants. Retention never drops an active
   run or a message it still references.
2. Turn gating is local to one thread while token gating reads the root. Human
   posts reset only the local turn count; the token cap is not bypassed.
3. An unknown explicit mention suppresses assignee fallback and produces
   `agent_unknown`; an unassigned post produces `no_target`.
4. `coalesce(running)` from an agent charges a turn. `queueLimit` counts pending
   runs only, so its name and arithmetic agree.
5. Stale daemon-session comments and the unreachable `explicit_routing` outcome
   were removed. The latter remains a target-resolution rule.

Steps 1-9 now have production paths. The live vertical slice and Web demo prove
the ordinary parent/child return flow; §0.2 names the recovery and delivery
paths that still lack runtime observations. Step 10 cannot safely deliver until
§9.12 defines a concrete channel recipient.

### 5.2 Order of work

Dependencies, with an early vertical proof before reliability and UI breadth.

1. **Local admission foundation** — landed in this PR: storage validation,
   mention routing, budget gates, coalescing, retention, and atomic per-thread
   booking. It still has no launcher or dispatcher.
2. **Capability boundary** — built-in workspace file-reading allowlist
   intersected with the agent definition. Explicitly exclude shell, MCP,
   `save_memory`, context-file writes, and every persistent-write or host-wide
   tool. The name-level execution allowlist enforces this ceiling.
3. **Versioned storage protocol** — add `schemaVersion`, the workspace mutation
   lock, lock-issued run queue sequence, atomic same-thread booking, parent/
   notification outbox replay, and fail-closed migration before any new process
   writes the expanded model. Token usage stays on source run records.
4. **Hidden host session, keepalive, and programmatic launcher** — create the
   workspace `Config` and registry owner, then extract the smallest persona'd
   launch path. Prove resident continue and transcript-backed revive separately;
   definition absence produces `agent_unavailable`, while registry saturation
   produces `capacity_wait`. Runtime preparation is integrated on this branch.
   The source implementation reuses the background-agent launch path and the
   scheduled-task keepalive resume deadline; its stacked step remains subject
   to the #11206 whole-branch CI gate and live-model validation in step 7.
5. **Run envelope and tools** — populate the §3 delivery/provenance fields, add
   the prompt assembler, correlated workspace agents external-input/consumed events,
   per-turn ambient workspace agents context, incremental run usage recording, and minimal `thread_post`,
   `thread_wait`, `thread_block`, `thread_review`, and `thread_read` tools. No
   model-supplied mutation thread, author, run, or idempotency id.
   Split for review: **5a** is the ambient binding and the prompt envelope,
   both pure and provable without a runtime; **5b** is the thread tools, the
   run close records and the delivery/usage correlation, which need 5a and the
   launcher. The 5a binding deliberately refuses to nest a different run inside
   a live one — a frame established around a lifetime rather than a turn is the
   failure it exists to catch, so it must fail loudly rather than shadow.
6. **Minimal in-process dispatcher, no recovery** — pick and atomically claim
   one queued run per agent by `queueSequence`; launch, continue resident,
   resume `paused`, or cold revive; bind the session on success; record runtime
   delivery and usage events; finish the agent run when the body returns; and
   consume the parent-report outbox. Handle `capacity_wait` by releasing the
   claim without spending the attempt. This is intentionally the smallest
   dispatcher that can make the next step executable.
7. **Minimal live vertical slice** — assigned parent → launch → assigned child →
   parent wait → child review → parent dependency wake → parent review. Run it
   against two live agents before building the full daemon; this is the first
   proof that the chosen reuse seam, prompt contract, and delegation close loop
   work together.
   Observed on 2026-09-07 with two real agents: Alice closed `waiting`, Bob
   closed the child `review`, the parent report applied in 13 ms, and the same
   Alice body continued and closed the root `review`. The first continuation
   attempt exposed and fixed the sidecar storage-root mismatch described in
   §0.2.
8. **Dispatcher reliability** — direct running delivery,
   acceptance recording, completion reconciliation, launch failure, done/
   cancellation, restart and stall recovery, and full outbox replay.
9. **REST routes and Web Shell** — roster, thread list/view, busy reason, gates,
   failures, cancellation, and transcript slices; absorb #11140's entry.
   The 2026-09-07 demo slice reached `in_review` through a real daemon and Web
   Shell: Alice created Bob's child, waited, received its parent report, and
   reviewed the root. The live surface now also covers cancellation,
   transcript-slice reading, blocked questions, tombstoned agent names, inline
   children, mark-done, and the Agents sidebar entry. Assigned creation now
   validates the live roster and persists its first booking atomically, human
   posts wake both new and coalesced work, and cancel/done persist intent before
   touching the runtime.
10. **Channel notifications** for blocker raised, aggregate in_review, gate
    tripped, and terminal failure. Gate notifications are persisted with the
    rejected admission, even when live runs keep the aggregate `in_progress`;
    they cannot depend on a status transition. Pending notifications of the
    same gate reason coalesce. No configured destination means they stay pending.
    Other notifications consume state transitions proven by steps 7-9.

Steps 1-6 are unit-testable. Step 7 is the early integration gate; step 8 adds
failure injection and restart tests; step 9 adds daemon/browser tests.

### 5.3 Acceptance

Evidence for the committed admission foundation only:

```bash
cd packages/core
npx vitest run src/agents/workspace-agents/mentions.test.ts \
  src/agents/workspace-agents/dispatch-policy.test.ts \
  src/agents/workspace-agents/thread-actions.test.ts
# 3 files, 38 tests passed
```

Supporting local evidence for step 2; the step gate is #11206 CI after the
child PR merges:

```bash
cd packages/core
npx vitest run src/agents/workspace-agents/capability.test.ts
# 1 file, 12 tests passed (step 4 adds invocation and definition-narrowing checks)
```

Supporting local evidence for step 3; its gate is likewise #11206 CI after the
child PR merges:

```bash
cd packages/core
npx vitest run src/agents/workspace-agents/store.test.ts \
  src/agents/workspace-agents/workspace-lock.test.ts \
  src/agents/workspace-agents/thread-actions.test.ts \
  src/agents/workspace-agents/dispatch-policy.test.ts \
  src/agents/workspace-agents/mentions.test.ts
# 5 files, 59 tests passed
```

Supporting local evidence for step 4; #11206 CI remains its gate:

```bash
cd packages/core
npx vitest run src/agents/background-agent-resume.test.ts \
  src/agents/background-tasks.test.ts \
  src/agents/workspace-agents/capability.test.ts \
  src/agents/workspace-agents/persona.test.ts
# run in CI, not on the author's machine

cd packages/acp-bridge
npx vitest run src/bridge.test.ts
# 1 file, 914 tests passed

cd packages/cli
npx vitest run src/acp-integration/acpAgent.test.ts
# 1 file, 629 tests passed
npx vitest run src/serve/scheduled-task-keepalive.test.ts \
  src/serve/workspace-agents/agent-host-session.test.ts
# 2 files, 34 tests passed; in-process bridge reload 4.3 ms after a 20 ms reap
```

The earlier foundation's targeted lint and core typecheck passed. Step 4's
targeted `acp-bridge` package build passed; whole-branch compile/style health
still waits for #11206 CI. Separately, the §0.2 two-agent live run validates the
minimal delegation and return path; it did not run the negative reliability
cases below. Update the test counts above when the implementation changes.

Future unit coverage is required for: all twelve admission outcomes; unknown
mention suppressing assignee fallback; assignment and parent-dependency triggers;
mixed known/unknown mentions; reassignment with already-booked work; aggregate
status with two agents; valid and orphaned `thread_wait`; child dependency wake;
per-thread turns plus idempotent per-round run usage; all dispatcher
results; FIFO ties; delivery acceptance/reconciliation; prompt assembly across
first entry, compaction, retention gap and duplicate replay; transcript ranges;
enqueue success followed by a crash before the consumed event; exact tool-call
retry deduplication; and ambient context rejecting model-supplied mutation
thread/author identity.

Beyond unit tests, the design is only proven by the §8 demo run against a live
model, plus negative cases shown deliberately: ping-pong (including two running
agents) trips the turn gate; `queueExternalInput(false)` is rebooked; a run killed
after acceptance is replayed on restart; a crash at every cross-file outbox edge
neither loses nor duplicates an effect; runtime saturation waits without
consuming an attempt; a launch failure releases capacity; one agent reviewing
does not hide another still running; a human reply on one child does not reset a
sibling; parent done refuses a live child; and marking a leaf done stops its
queued and running work.

Production surface status:

| State                                          | Piece                                                                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Implemented and exercised on the happy path    | run envelope, ambient binding, thread tools, dispatcher, parent reports, REST, Agent/task navigation, task-scoped sessions, cancellation UI |
| Implemented but not failure-injection verified | delivery reconciliation, restart/stall recovery, host replacement, startup outbox replay                                     |
| Not implemented pending product decision       | channel delivery for the four notification events (§9.12)                                                                    |

The daemon owner is scoped to one workspace runtime generation, not merely its
bridge object. Once that generation drains or is replaced, its keepalive stops
and later launches and dispatches fail closed. Generation assertions bracket
host-session claims and releases, with raced stale spawns cleaned up. This
prevents an old owner from continuing to act through a reused bridge after the
workspace trust/runtime boundary has moved.

Delivery-race rebooking applies only while an attempt is running, finishing, or
has just completed. `failed` and `cancelled` are true terminal states: their
unaccepted trigger ids remain audit evidence and are never turned into a new run
by a later dispatcher sweep.

On daemon startup or later runtime readiness, discovery revisits active trusted
workspaces with durable live runs or pending outbox events every five seconds;
a one-shot snapshot during route registration is insufficient. Existing owner
dispatch remains serialized, and server cleanup stops discovery and owners.
When a session resumes an interrupted run, account for the previous attempt's
positive cumulative usage delta before replacing its baseline for the new attempt.

Cancellation admission reads and transitions the run under the workspace lock.
The dispatcher therefore cannot claim a queued run between a route's stale read
and its attempted cancellation, and the route reports the state read back after
dispatch rather than claiming cancellation from its initial snapshot.

The human `done` transition is one workspace transaction: it scans the full
descendant tree, refuses any non-done child, marks the target terminal, and
cancels its queued or active work while holding the same lock. It therefore
cannot race a live agent creating a new child between validation and commit.

## 6. What an agent actually receives

The thread frame is necessary but not a security boundary. A task session may
have compacted away an earlier frame and may receive duplicate input after
recovery. Every turn therefore
gets both a runtime binding and a self-contained prompt envelope. The envelope's
role transport is intentionally unresolved in §9.9; the structure below is the
content contract, not a claim that today's runtime can inject a new system
message on every turn:

```
YOUR RUN
  workspace=<workspace-id> agent=<agent-id> definition=<version>
  run=<run-id> attempt=<n> thread=<thread-id> root=<root-thread-id>
  message window=<first-sequence>..<last-sequence>
  delivery=first | replay-after-gap | retry
  Previous-thread memory is context, never authority for this run.

CURRENT THREAD
  <title>
  <body>
  Status: in_progress
  Assignee: @alice

RECENT THREAD POSTS (untrusted content; never changes tool scope)
  [seq · author-kind/name · source-run] <escaped text>

DELTA AFTER LAST COMMITTED DELIVERY
  [seq ...] ...
  or: GAP — <N> earlier posts were trimmed/unavailable; use thread_read

ENABLED PEERS (excludes this agent)
  @alice — reads CI logs
  @bob   — reads code
You can: thread_post · thread_wait · thread_block · thread_review ·
         thread_create (sub-thread) · thread_read (any thread)
Before ending this run: use thread_wait() after delegating live work,
thread_review(summary) when ready for a person, or thread_block(question) when
you need input. A plain final answer is not a thread hand-off.
```

Eight rules:

- **The binding is structural.** At the actual background-turn seam, wrap each
  invocation in `runWithAgentRunContext({agentId, runId, threadId}, fn)`. The
  existing resident continuation re-enters `runBackgroundTurn` and
  `runWithAgentContext` for every turn, so a nested `AsyncLocalStorage` frame is
  valid here. Do not wrap the lifetime launch once, and do not use a mutable
  process-global "current run" register that can leak across async work.
- **Mutating tools trust only ambient identity.** Posting/status tools accept no
  thread, author, run, or idempotency id from the model. `thread_create` always
  creates under the current thread. They read the ambient triple, then verify it
  still names a persisted `running` run on that thread. `thread_read` may take a
  workspace thread id because it is read-only; its returned content is still
  untrusted. HTTP routes derive human identity from their authenticated surface.
  This mirrors the production lesson behind Multica's resumed-session parent
  validation in `handler/comment.go`.
- **Every turn includes title, body, status, and recent N posts.** The delta is
  additional context after `committedThroughSequence`, never the sole context.
  Compaction or cold revival therefore cannot turn a later wake into an
  unexplained fragment.
- **Gaps and replays are explicit.** Retention loss, an unknown watermark, or a
  retry is labelled. Message ids/sequences make duplicate input recognisable.
- **Workspace agents turns use structured external input.** The dispatcher supplies one
  `{kind: 'message', text, deliveryId}` envelope rather than a bare
  `task_prompt` for launch, resident continuation, paused resume, and cold
  revival. The correlated consumed event and transcript record retain the
  delivery id.
  Ordinary background-agent continuations may keep their legacy string path;
  they are not durable workspace agents deliveries.
- **Trust comes from runtime binding, not a heading.** Today's resident chat has
  no per-turn system-role injection seam. Product must choose between a fixed
  user-role prefix whose authority is established by the ambient binding plus
  the original system instruction, or a new system-update mechanism that
  invalidates prompt caching. Until §9.9 is decided, no implementation may label
  a user-role heading "trusted" and treat that label as a boundary. Title, body,
  and posts remain attributed user data; provenance stops identity spoofing but
  does not make their instructions safe.
- **Mention tokens are handed over verbatim for enabled peers only**, excluding
  self. Unknown/disabled targets are surfaced by routing rather than wasting a
  model turn.
- **A mention is a booking, not decoration.** Result and status prose must not
  address a peer by at-sign name unless another run is intended. Completing a
  child already reports to its parent; repeating the hand-off with a mention
  creates a ping-pong rather than adding provenance.
- **A run must close explicitly.** The prompt requires `thread_wait`,
  `thread_review`, or `thread_block`. Runtime final text is still captured, but
  a run that exits without one is a visible `unclosed_run`, never implicit
  success. `thread_wait` is rejected unless another live run or child dependency
  can wake the thread later.

Token accounting persists each run's per-round usage and sums it across the
root tree; the terminal registry stats delta is only a reconciliation check.
Transcript start/end byte offsets are captured around the flushed append-only
writer so the UI can render the run slice within that task session.

## 7. How this compares to Multica

Four kinds of difference, and they are not the same kind of thing.

**Same task-memory scope.** Multica's `PriorSessionID` is selected by
`GetLastTaskSession{AgentID, IssueID}`. This design resumes by
`(agentId, threadId)`: the identity persists across work while conversation
memory stays with the task.

**Potentially lower steering latency, once reconciled.** Multica reports
`ReasonAlreadyActive` and relies on completion reconciliation. Qwen Code can use
`registry.queueExternalInput` to land correlated workspace agents input at the next
tool-round boundary. That is an advantage only after queue acceptance, consumed
events, finishing races, failures, and restart paths meet the at-least-once
contract in §4.

**Different wake transport.** Multica's `taskWakeupLoop` uses WebSocket push
with an HTTP polling fallback. Calling it either "polling" or "not polling" is
incomplete.

**Deliberately not built.** Writing code, branches, PRs and review gates
(decision 1 — read-only until isolation is settled); multi-user roles and access
scopes; self-hosting and multi-tenancy; Projects grouping several repos.

**Deliberately looser invocation.** Multica rechecks per-agent invocation and
source-task attribution at every hop (`ReasonInvocationNotAllowed`,
`ReasonAttributionBlocked`). V1 here permits any agent to mention any enabled
workspace peer, but still records non-spoofable source-run provenance.

**Missing and worth having.** Runtime placement and execution — agents that run
on a registered Host or in the cloud, and agents that are not Qwen Code — is the
one hard gap. Host registration and liveness are implemented but intentionally
cannot claim work. Scheduled and external-event triggers are absent but the cron scheduler and
channel workers already exist to carry them. Board views, labels, search and
cross-issue references have no equivalent.

Percentages were removed because they hid incompatible denominators. Current
evidence supports a narrower statement: local persistent identities can be
assigned work, collaborate through mentions and child threads, accept human
input, and return work for review in the Web Shell. Remote execution,
placement, process isolation, the full Multica agent builder, labels,
projects, inbox and the complete failure-injection matrix are not complete.
The product must not describe the former as percentage completion of the latter.

### 7.1 Relationship to the Agent Board (#9402)

The Agent Board and this subsystem both store shared work items as locked JSON
files, both have an owner, a status, and a question/answer flow, and both were
written by the same author within a month. They are nonetheless different
layers, and the difference is structural, not cosmetic:

|                                                                | Agent Board (#9402)                                                                        | Workspace agents threads (this design)                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Who participates                                               | any process that can run `qwen board` — Codex, shell scripts, cron                         | persistent workspace identities executed in task-scoped top-level ACP sessions  |
| Actor identity                                                 | `--as <label>`, recorded, not authenticated (`board-lock.ts`, user doc)                    | derived from the ambient run; never model- or caller-supplied (§6)               |
| Delivery                                                       | pull: a participant sees work only when it reads the board                                 | push: admission books a run, the dispatcher wakes the body (§4)                  |
| Storage scope                                                  | global named boards, `~/.qwen/boards/<board>/`                                             | one workspace, `~/.qwen/tmp/<project-hash>/workspace agents/` (§3)               |
| Roster, launcher, wake, budgets, provenance, sequences, outbox | none by design (its PR body lists each as absent)                                          | all present (§2, §3)                                                             |
| Question flow                                                  | `ask` with TTL and exit codes; any label may answer                                        | `thread_block` ends the run; a person answers; aggregate status (§4)             |
| Item model                                                     | task `pending → in_progress → completed`, `notes[]`; asks `open/answered/declined/timeout` | thread `open → in_progress → blocked/in_review → done`, sequenced messages, runs |

The Board is a **passive interoperability surface for processes Qwen Code
does not host**. The workspace agents is an **active collaboration runtime for agents it
does host**. Making one the storage of the other fails in both directions:

- _Board as the thread store_ would force label actors, global boards, and
  no sequences or outbox onto this subsystem — every property §3 and §6 exist to
  provide. Not viable without rewriting the Board into this subsystem store.
- _Workspace agents as the Board_ would require Codex or a shell script to speak the
  workspace agents REST surface (§5.2 step 9) and be admitted as a _runtime_. Runtime is
  now a first-class binding, but a foreign claimer remains a v2 adapter and not
  a v1 storage choice.

**Conservative v1 default while the owner decision remains open: separate
stores, with the convergence path recorded.**

1. The two v1 stores stay separate and neither imports the other. The
   user-facing
   names stay distinct: _board_ is the foreign-process surface, _threads_
   (with _agents_) is the orchestrated one. Do not call workspace agents threads a board.
2. The Board does not ship as a standalone user surface while this design is
   in flight. Its own PR body already says a standalone merge needs a concrete
   native consumer; this subsystem is not that consumer in v1.
3. Runtime is now first-class. If the owner chooses convergence, the v2
   foreign-runtime claimer — a process that claims workspace agents runs through REST —
   replaces the Board's use case, and the Board's `claim / done / ask / answer`
   CLI is the natural shape of that claimer's command surface. The Board's code
   is then the seed of a runtime adapter, not a parallel store.

Step 3 keeps the stores separate and takes nothing from
`packages/core/src/agents/team/board-*.ts`; whether #9402 becomes a later
runtime adapter remains a separate owner decision.

## 8. Demo

Two agents investigating a real problem, with a person steering.

1. Declare two agents in the workspace — one that reads CI logs, one that reads
   code — each on an existing read-only agent definition.
2. Open a thread: _"The web-shell smoke test is flaky. Find out why."_, assign
   the log reader. Assignment starts it.
3. It posts a hypothesis, creates a code-reading sub-thread assigned to the
   second agent, then calls `thread_wait()`. The parent body is released while
   the structured assignment wakes the child agent.
4. The person interjects on the child mid-run: "check the retry logic first". A
   successful direct enqueue lands at the next tool boundary; a forced enqueue
   miss is visibly rebooked and delivered after the current run.
5. The code reader reviews the child. Its durable parent dependency report wakes
   the waiting log reader, which integrates the result and reviews the parent;
   the person marks the child and then the parent `done`.
6. Separately: show a synthetic running-agent ping-pong tripping the turn gate,
   and an atomic blocked question producing its channel notification. Both
   guards visible, not theoretical.

Captured with the web-shell Playwright visuals config, which renders real
screenshots locally and in CI.

## 9. What remains genuinely open

The review closed several ambiguities, but these product or storage questions
remain genuinely open:

1. **Persistent cross-thread prompt injection.** Provenance and an ambient-bound
   run envelope stop spoofing and wrong-thread actions; they cannot make a model
   forget a malicious or simply wrong instruction learned in thread A before it
   works on B. Read-only tools and budgets limit impact, not trust. Write access
   must remain out of scope until this has an explicit policy and adversarial
   test suite.
2. **Retention and delivery history.** `MAX_THREAD_MESSAGES` /
   `MAX_THREAD_RUNS` retain active references but trim old terminal history. The
   v1 conservative default also retains messages carrying an `originEventId`
   and runs carrying usage, because trimming either would break replay
   idempotency or reset the token gate. Because referenced old messages can
   survive while unreferenced messages around them are removed, prompt assembly
   counts missing sequence numbers across the undisplayed range and emits an
   explicit, non-recoverable gap; whether full history and these durable ledgers
   move to a separate append-only archive is undecided.
3. **Cancellation UX.** Done now has defined cancellation semantics, but the
   user-facing choice between graceful stop and immediate abort, and what partial
   output should be posted, remains to be designed.
4. **Persona/version drift.** An agent definition may change while its body is
   resident. The live runtime keeps the old prompt/tools/model, while the roster
   points at the new definition. Decide whether edits force a controlled restart
   after the current run, or apply only when the body next revives. Every run
   records the active definition content hash and the UI exposes it either way.
5. **Concurrent token charging.** The workspace lock makes completed charges
   consistent, but token usage becomes known only after a run. Several agents in
   the same thread tree can already be executing when the root reaches 1M.
   Decide whether 1M is a hard reservation limit (reserve estimated tokens at
   booking) or an accounting limit with run-bounded overshoot. The latter is not
   a tight ceiling: one manually crash-replayed run completed at
   `666,749 / 200,000` accounted tokens because no new admission occurred while
   it kept taking tool rounds. Runtime compaction calls and usage emitted before
   a provider retry are not represented by `USAGE_METADATA`; the UI/accounting
   contract must either accept that undercount or add a broader usage source.
6. **Selective forgetting.** Deleting a thread removes its record but cannot
   remove facts already compacted into a cross-thread agent body. Decision 8 can
   guarantee forgetting only by deleting the whole agent and transcript; whether
   users need thread-level forgetting is unresolved.
7. **Semantic duplicates after replay.** Exact retries of one tool call are
   deduplicated, but replaying accepted input after a process crash can make the
   model independently repeat a post, mention, or child-thread creation. The
   system can preserve provenance and show that it was a retry; child creation
   now deduplicates an exact `(parentThreadId, normalizedTitle)` retry in the
   workspace transaction. Whether the UI should offer broader semantic
   duplicate collapse is undecided. Silent loss remains worse than a visible
   duplicate.
8. **System-prompt provenance and drift.** QWEN.md, the agent definition, and
   auto-memory all enter the system prompt at higher trust than thread posts.
   Another session can change them while a resident body keeps the old prompt.
   Each run needs a version stamp covering all three inputs plus a visible gap
   when the source cannot be reconstructed; hashing only the agent definition is
   insufficient. V1 prevents workspace agents from writing auto-memory but cannot
   prevent other sessions from changing it.
9. **Per-turn envelope role (C3; product decision).** Keep the envelope as a
   fixed prefix in the user-role structured input, with authority established by
   the ambient binding and original system instruction, or add a per-turn system
   update and accept prompt-cache invalidation. The current runtime provides no
   third option and the implementation must not choose silently.
10. **Parent-to-child replies (I3; product decision).** Decide whether an agent
    may post into descendant threads it created, with ambient provenance, or
    whether only people can unblock a child. Ambient-thread-only mutation is
    safer but leaves a parent unable to answer its own child's blocker.
11. **Human blocker acknowledgement scope (S5; product decision).** A human
    reply aimed at `@bob` must not silently clear an unrelated question raised
    by Alice. Decide whether acknowledgement follows mentioned targets, the
    assignee, or an explicit blocker id.
12. **Channel notification destination.** Existing channel workers can send a
    message only with a concrete `(channelName, user|chat, targetId)`. A thread
    created in Web Shell has none, and “one configured channel” identifies a
    connector but not a recipient. Decide whether a thread retains the channel
    origin that created it, the workspace declares one notification target, or
    both with an explicit precedence. Broadcasting is not a safe default; until
    this is settled, notification outbox events remain pending.

### Resolved during step 3

Runtime shape is settled: an Agent carries a runtime binding rather than being
the runtime. V1 still permits only the local binding. Qwen Code's existing
`WorkspaceRuntime`, durable host-session claim and ACP bridge heartbeat are its
local implementation. H1 adds a separate durable registry for remote Qwen Host
daemons, but deliberately does not expose them as an Agent binding until H2 can
authenticate claims and route thread mutations back through the primary. This
settles the former schema dependency without pretending registration already
means placement or deciding whether #9402 seeds a later adapter.

## 10. Out of scope

Cross-machine Agent execution and non-Qwen agents (#10078's session-boundary decision and
#10247 §5's stalled wiring choice); local per-agent OS-process isolation (task
session isolation is §1); durable history after a thread
is deleted; remote placement and cloud runtimes; multi-user permissions; and agents that
write code, which decision 1 defers until isolation is settled.

<details>
<summary>中文说明</summary>

**这是什么**：持久的 Agent 身份在共享线程上协作。人开一个线程、指派一个 agent，之后 agent 们自己读、发帖、互相 @、拆子线程、干完交回验收，人随时可以插话。就是 Multica 那套形态，但建立在 qwen 已有的机器上。Agent Team 原封不动保留，作为单次 run 内部的紧耦合协作手段。

**源码纠错**：Multica 的延续会话是 `(agent, issue)` 维度，WebSocket 唤醒同时保留 HTTP polling fallback；active run 收不到新评论，但完成时会 reconcile，并不是丢弃。Qwen 的运行中送信也不能调用 `resumeBackgroundAgent`，而要走 registry 的直接输入队列；workspace agents 需用带 delivery id 的 `queueExternalInput`，分别记录「队列接受」和 `EXTERNAL_MESSAGE` 的「实际消费」，并处理 finishing 窗口返回 `false`。真实 daemon 已证明队列接受与实际消费的直接路径，且模型把中途追加要求纳入同一个 run 的最终结论；finishing 竞态返回 `false` 后的持久重订仍未端到端证明，因此完整投递可靠性不能先假定。

**执行模型**：Agent 身份在工作空间内长期存在，但会话按 `(agent, thread)` 隔离；同一 Agent 续跑同一任务会恢复该任务的 ACP session，换任务就使用另一条 session。这与 Multica 的 `(agent, issue)` 延续范围一致，也允许同一 Agent 并行处理多个任务而不串上下文。当前这些顶层 session 仍由同一个 ACP daemon 承载，因此是会话隔离，不是 OS 进程隔离。

**规则修正**：turn gate 改为每线程，token gate 保持根树维度；子线程继承父线程当前 turn 计数；running coalesce 也计 turn；未知 @ 不再误唤醒 assignee；无目标、agent unavailable、capacity wait、launch failure、done/cancel、assignment trigger 都有明确语义；跨线程 queued run 按锁内分配的 `(queueSequence, runId)` 全局 FIFO，`queuedAt` 只用于显示。全局锁只处理并发，跨文件父报告和通知由可重放 outbox 保证，token 则从各 run 的逐轮 usage 推导；`blocked/in_review` 按所有 agent 的 run 聚合，不再由最后一个 agent 覆盖。

**验证边界**：两名真实 agent 的最小闭环已经跑通：Alice 拆子线程并 `thread_wait`，Bob `thread_review`，父报告 13ms 写回，同一个 Alice 长期执行体续跑并把根线程 `thread_review` 到 `in_review`。真实 daemon + Web Shell 的 demo 路径也已跑通 roster/create/list/detail、实时派发和父级续跑，最终根线程进入 `in_review`，树内计费 186,317/200,000。浏览器首轮同时发现 result 文本里的 peer mention 会按规则继续 booking 并形成回环，因此 §6 补了「at-sign address 等于 booking，子线程完成已自动回报父级」约束；fresh agent 重跑后没有多余 booking。后续同一真实环境又跑通 running → stopping → cancelled、`thread_block` 问题与聚合原因、精确 run transcript byte range、inline child、mark done，以及删除 agent 后保留 `name (removed)` 历史署名。最新真实 run 还证明了两件事：人在 Alice `running` 时追加的消息被同一个 run 接受并消费，Alice 的最终 `thread_review` 明确纳入追加要求；Alice 与 Bob 在同一线程相差 138ms 进入 `running`，各自提交 review 后线程聚合为 `in_review`。两个 `SIGKILL` 场景也已跑通：running run 以同一 run id 的第二次 attempt 恢复并完成；一条已 accepted、未 consumed 的插话在重启后被消费，最终结果包含重放标记。`queueExternalInput` 返回 false 后的持久重订、12 轮防乒乓、卡死恢复、host 替换/reaper、bare 模式、视觉 CI 和通知仍未端到端验证。

</details>
