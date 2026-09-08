# What is missing against Multica, and how to close it

## Current correction — task orchestration before process isolation

### Browser/source acceptance observations, 2026-09-08

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

**Wrong, and being replaced.** The execution model. An agent is a background
subagent inside one hidden host session, so N agents share one process, one
memory space and one crash. There is no runtime concept at all.

**Missing entirely.** Runtime registry and binding; priority, labels, due date,
acceptance criteria on the work item; agent configuration beyond a name and a
definition reference; squads; inbox; projects; per-agent concurrency.

## 3. Why the percentages I gave were wrong

I was scoring implementation against our own design document — which itself put
the wrong execution model in §1 and listed real process isolation as out of
scope in §10. That measures "how much of a plan we finished", not "how close
this is to what was asked for". Against your goal, the runtime layer is zero,
not eighty percent. I should not have used that number.

## 4. The plan

Four stages. Each is usable on its own; none needs the next to be worth having.

### Stage A — an agent is a process

Multica binds an agent to a runtime. Locally, the runtime is this machine's
daemon and the process is one session per agent, so the binding degenerates to
"which session is this agent" without losing the shape.

- `WorkspaceAgent` gains `runtime: { mode: 'local'; sessionId?: string }`. The field
  is a discriminated union from day one so `'cloud'` can be added without a
  migration, matching `agent.runtime_mode`.
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

Delivers: real isolation, an honest agent status, and a per-agent transcript
that is that agent's session.

### Stage B — the conversation is Qwen Code's, not a second one

I built a bespoke `ThreadView` with its own message rendering. That was a
consequence of Stage A being wrong: a subagent has no session, so it had no UI,
so I drew one. With agents as sessions it is redundant and it is a second place
where "who said what" has to be got right.

- The thread page keeps what only it knows: the status sentence, the run rows
  with their close obligations, the budget line, assignment and status actions,
  and the composer with its routing preview.
- Everything about _what an agent said_ links into that agent's existing session
  view. One message renderer, one transcript, one place a person already knows.
- Thread posts stay the durable coordination record — who was asked, who
  answered, what was booked — not a duplicate of the model conversation.

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
integrations and activity. We have a name, a colour and a definition reference.
Qwen Code already has agent definitions with prompts, tools and MCP, so the
work is surfacing per-identity overrides on top of a definition rather than
building a second configuration system: instructions, model, MCP servers, and
the read-only ceiling shown as what it is.

Squads, inbox and projects come after this, and only if you want them; none is
load-bearing for two agents collaborating on one thread.

## 5. What this costs, and what it breaks

Stage A rewrites three files — `launcher.ts`, `dispatch-port.ts`,
`runtime-bridge.ts` — and the `AgentMeta.agentRun` per-turn binding moves from an
in-process AsyncLocalStorage frame in the host to the agent's own process. Every
test that mocks `BackgroundTaskRegistry` for workspace agents goes with them. Nothing in the
store, the rules, the tools or the REST surface changes.

N processes replace one. A roster is two to five agents, so this is a real cost
and not a prohibitive one, but the background-agent concurrency cap stops being
the limit and the machine's memory becomes it. A roster size limit belongs in
the UI, and `max_concurrent_tasks` (Multica has it; we currently force serial)
becomes a per-agent field rather than decision 10's blanket rule.

## 6. Decisions, made 2026-09-08

1. **An agent may work several threads at once.** `WorkspaceAgent.maxConcurrentRuns`,
   default 1, mirroring Multica's `max_concurrent_tasks`. Decision 10 is
   rewritten: serial was a consequence of a subagent owning one chat inside a
   shared process, and with a process per agent it is a policy rather than a
   fact. The default keeps today's behaviour until someone raises it, and
   `queueLimit` stays a separate bound — throughput and backlog are different
   questions.
   _Where it lands:_ `selectCandidates` counts an agent's live runs against its
   own limit instead of treating any live run as busy; `claimRun`'s
   already-live check does the same. Both are single conditions.

2. **An agent's session appears in the normal session list.** A person opens
   alice the way they open any other conversation. This is what makes Stage B
   possible: with the session visible there is one message renderer and one
   transcript, and the bespoke thread conversation I built can go. Only the
   dispatch host stays hidden, because it is infrastructure with no
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

1. `WorkspaceAgent` gains `runtime: { mode: 'local'; sessionId?: string }`,
   `maxConcurrentRuns`, and `status` derived from the session rather than stored.
2. `workspace agents-agent` session source type, and persona resolution in the child at
   `newSession` — roster lookup, `Config.systemPrompt`, `deriveConfig` for tool
   registry, invocation guard and model.
3. `dispatch-port.ts` rewritten against the bridge: `inspect` from the live
   session record, `start` as spawn-or-attach plus prompt, `deliver` as the
   session's mid-prompt input path.
4. `launcher.ts` and `runtime-bridge.ts` deleted; their callers move to 3.
5. `selectCandidates` and `claimRun` honour `maxConcurrentRuns`.
6. The per-turn `(agent, run, thread)` binding moves from the host's
   AsyncLocalStorage frame to the agent's own process, read at its turn seam.

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
| `cbc8958379` | Dispatch against one session process per agent                       |
| `f663f779a1` | Token accounting from the session's own counter                      |
| `39da00b8f6` | Removed the subagent execution path                                  |
| `b4055c3690` | Agent sessions named after their agent; runs link to them            |
| `6616312c67` | Threads gained acceptance criteria and priority                      |
| `8d6e199cc4` | Deleting an agent retires it instead of erasing it                   |
| `59d326e422` | Agents are configurable; the capability ceiling is shown             |

Stage A is complete: `launcher.ts`, `dispatch-port.ts` and `runtime-bridge.ts`
are gone, along with `launchWorkspaceAgent`, `dispatchAgentRuns` and the two
ACP control methods behind them. Dispatch runs in the daemon, where the
sessions are.

Stage B turned out to be smaller than written. Agent sessions were already in
the ordinary session list — only the hidden host type is filtered anywhere —
so the work was making them legible: a session is titled with its agent's
name, written once and never over a person's `/rename`. A run row links to the
agent's session. The thread-scoped transcript slice was kept rather than
replaced: a session serving several threads cannot answer "what did this agent
do _here_", which is the narrower question the slice exists for.

Stage C landed items 1 and 2 of the four. Labels, project and due date are
still display-only work and are not done.

Stage D landed instructions, model, definition and concurrency as per-identity
overrides, plus the capability ceiling as something a person can read. MCP
servers were deliberately not added: `classifyAgentTool` denies every name not
in its table and no MCP tool is in it, so the setting would do nothing.
Reaching MCP means moving the read-only ceiling, which is a separate decision.

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

**我们的状态**：底层是扎实的——存储事务、准入十二种结局、预算闸门、状态聚合、run 两段收尾、outbox、六个工具、提示词、崩溃恢复、中途插话。这些只认 agent id 和文件，换执行模型后仍然成立。执行模型是错的：agent 是同一个宿主进程里的 subagent，没有 runtime 概念。完全没有的：runtime 注册与绑定、工作项的优先级/标签/验收标准/截止日期、agent 的可配置能力、squad、inbox、projects、按 agent 的并发。

**之前那个七八成错在哪**：我拿自己那份设计文档当卷子打分，而文档 §1 就把执行模型定错了、§10 还把真正的进程隔离划到范围外。按你的目标看，runtime 这层是零。

**方案四步**：A 让 agent 变成进程（一个 agent 一个 session，靠 sourceType 认领身份并加载人格——这个钩子本来就存在，当初说没有是错的；重写三个文件，规则层不动）；B 把对话交回 Qwen Code 已有的 session 界面，线程页只保留它独有的状态、run 行、预算和指派；C 工作项补上验收标准和优先级，标签和截止日期次之；D agent 变成可配置对象。squad/inbox/projects 排在最后，且不是两个 agent 协作的必要条件。

**动手前需要你定三件事**：每个 agent 允不允许并发多任务；agent 的 session 要不要出现在普通会话列表里；删除 agent 时线程怎么处理。

</details>
