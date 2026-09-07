# What is missing against Multica, and how to close it

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

- `MeshAgent` gains `runtime: { mode: 'local'; sessionId?: string }`. The field
  is a discriminated union from day one so `'cloud'` can be added without a
  migration, matching `agent.runtime_mode`.
- An agent session is spawned with `sourceType: 'mesh-agent'`,
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
`runtime-bridge.ts` — and the `AgentMeta.meshRun` per-turn binding moves from an
in-process AsyncLocalStorage frame in the host to the agent's own process. Every
test that mocks `BackgroundTaskRegistry` for mesh goes with them. Nothing in the
store, the rules, the tools or the REST surface changes.

N processes replace one. A roster is two to five agents, so this is a real cost
and not a prohibitive one, but the background-agent concurrency cap stops being
the limit and the machine's memory becomes it. A roster size limit belongs in
the UI, and `max_concurrent_tasks` (Multica has it; we currently force serial)
becomes a per-agent field rather than decision 10's blanket rule.

## 6. Decisions, made 2026-09-08

1. **An agent may work several threads at once.** `MeshAgent.maxConcurrentRuns`,
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
   _Where it lands:_ the mesh-agent source type is excluded from the
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

1. `MeshAgent` gains `runtime: { mode: 'local'; sessionId?: string }`,
   `maxConcurrentRuns`, and `status` derived from the session rather than stored.
2. `mesh-agent` session source type, and persona resolution in the child at
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

<details>
<summary>中文说明</summary>

**Multica 实际是什么**：Linear 形态的 issue tracker，assignee 可以是 agent，外加一层 runtime 注册。`agent_runtime` 是独立实体（workspace + daemon_id + provider，带在线状态和心跳），agent 绑定到它上面；`agent_task_queue` 是 agent × issue 的派发队列；`issue` 有优先级、7 种状态、验收标准、截止日期、标签、项目；对话就是 issue 上的 comment。页面里有独立的 runtimes 和 runtimes/[id]。

**我们的状态**：底层是扎实的——存储事务、准入十二种结局、预算闸门、状态聚合、run 两段收尾、outbox、六个工具、提示词、崩溃恢复、中途插话。这些只认 agent id 和文件，换执行模型后仍然成立。执行模型是错的：agent 是同一个宿主进程里的 subagent，没有 runtime 概念。完全没有的：runtime 注册与绑定、工作项的优先级/标签/验收标准/截止日期、agent 的可配置能力、squad、inbox、projects、按 agent 的并发。

**之前那个七八成错在哪**：我拿自己那份设计文档当卷子打分，而文档 §1 就把执行模型定错了、§10 还把真正的进程隔离划到范围外。按你的目标看，runtime 这层是零。

**方案四步**：A 让 agent 变成进程（一个 agent 一个 session，靠 sourceType 认领身份并加载人格——这个钩子本来就存在，当初说没有是错的；重写三个文件，规则层不动）；B 把对话交回 Qwen Code 已有的 session 界面，线程页只保留它独有的状态、run 行、预算和指派；C 工作项补上验收标准和优先级，标签和截止日期次之；D agent 变成可配置对象。squad/inbox/projects 排在最后，且不是两个 agent 协作的必要条件。

**动手前需要你定三件事**：每个 agent 允不允许并发多任务；agent 的 session 要不要出现在普通会话列表里；删除 agent 时线程怎么处理。

</details>
