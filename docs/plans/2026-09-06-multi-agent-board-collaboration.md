# Multi-agent collaboration on a shared thread

> Status: Design settled — ready to implement
> Baseline: `origin/main` @ `703678136a` (2026-09-06)
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

An earlier reading concluded Multica's agents "don't talk in real time". Verified
against its source, that is wrong twice over:

- `server/internal/daemon/types.go:110`, `daemon/prompt.go:58` — Multica
  **resumes the agent CLI's prior session** (`PriorSessionID`) and works to keep
  the prompt cache across resumes. Context is not rebuilt from the thread.
- `server/internal/daemon/wakeup.go` — dispatch is a **WebSocket push**, not
  polling. An `@` to an idle agent starts it within about a second.

`@`-based coordination in Multica *is* live collaboration. The one thing it
cannot do is deliver into a run that is already executing:
`server/internal/handler/comment.go:2313` returns `DispatchDeferred` /
`ReasonAlreadyActive` — "its reconcile covers the comment".

Qwen Code does not have that limitation. `resumeBackgroundAgent`
(`core/src/agents/background-agent-resume.ts:600`) queues a message into a
**running** agent via `registry.queueMessage`. So this design takes the durable,
observable, shared-thread model *and* keeps mid-run steering — better than either
Agent Team or Multica alone on the axis each of them loses.

## 1. Execution model

An agent is **one long-lived background agent per workspace**, not a daemon
session. This was the design's biggest correction: the persona machinery
(`subagent-manager.ts:868` → `{promptConfig, modelConfig, runConfig, toolConfig}`)
targets the agent runtime, not ACP sessions, and there is no per-session persona
hook. Building one would be new work on a hot path with no precedent.

Everything the execution layer needs already exists:

| Need | Existing machinery |
| --- | --- |
| Agent loop | `AgentCore` / `AgentInteractive` |
| Persona: prompt, restricted tools, private MCP | `convertToRuntimeConfig` |
| Durable log | `attachJsonlTranscriptWriter` |
| Reading that log in Web Shell | virtual subagent sessions + the existing panel |
| Wake with a message, into a **running** agent | `resumeBackgroundAgent` → `registry.queueMessage` |
| Wake a finished agent from its transcript, across a process restart | `reviveCompletedBackgroundAgent` |
| Context growth | auto-compaction, already in the runtime (`agent-core.ts:559`, `:977`) |
| Approvals | the background-agent approval path |
| Keeping a bound session resident, and reviving one the reaper closed | `scheduled-task-keepalive.ts` |

So the work is the **orchestration layer**, which does not exist yet. Nothing
underneath needs rewriting, and none of the reuse goes through Agent Team — it
goes through the background-agent layer that Agent Team and ordinary subagents
both sit on.

## 2. Settled decisions

Nineteen decisions, all confirmed with the product owner. Recorded so
implementation does not relitigate them.

### Scope and safety

| # | Decision | Consequence |
| --- | --- | --- |
| 1 | **v1 agents are read-only.** No file writes, no worktrees, no branches. | Removes all concurrent-write design. The deliverable of a thread is a conclusion, not a diff. |
| 2 | Read-only means **files + read-only shell**, against a **built-in allowlist**. | `run_shell_command` can write, so "no writes but any command" is a false boundary. The allowlist is the hard ceiling; agent definitions may narrow it, never widen it. |
| 3 | Tool sets otherwise **follow the agent definition**. | No second permission model. Who can do what is decided where agents are defined. |
| 4 | Agents are **scoped to one workspace**. | Trust and permissions follow the workspace. Five repos means five rosters. |

### Identity and memory

| # | Decision | Consequence |
| --- | --- | --- |
| 5 | **One long-lived execution body per agent**, with memory continuous across threads. | Like a colleague who remembers last week. Requires compaction, and makes the agent a serial worker. |
| 6 | Context growth is handled by **auto-compaction**, reusing the runtime's existing mechanism. | Verified to exist. Lossy over long horizons; accepted. |
| 7 | The **host session is hidden** — pure infrastructure, absent from the session list. | The user's model stays "agents and threads". Troubleshooting goes through logs. |
| 8 | **Disabling keeps memory; deleting clears it.** | Matches the durable scheduled task's `enabled` semantics. |

### Conversation

| # | Decision | Consequence |
| --- | --- | --- |
| 9 | A message **can enter a running agent** — but **only for the thread it is currently working on**. | Keeps steering, prevents an unrelated thread's message landing inside the current one's reasoning. |
| 10 | An agent is **serial across threads**, and a waiting thread **says so explicitly** ("busy on <thread>"). | One slow thread blocks that agent's other work; the UI makes it legible rather than mysterious. |
| 11 | Each agent has a **bounded pending queue**; a full queue **refuses and says so**. | Forces the real throughput to be visible instead of accumulating a backlog nobody will reach. |
| 12 | Agents may **post, `@` any existing workspace agent, change thread status, and create sub-threads**. They may not create agents. | Sub-tasks are expressible; the roster stays human-owned. |
| 13 | A sub-thread reaching `in_review` **posts back to its parent automatically**. | The hand-off chain cannot silently break. |
| 14 | Blocked agents **post the question and set the thread to `blocked`**, ending the run. | Costs nothing while waiting. A human reply wakes the agent again. `@user` is not supported in v1 — `blocked` plus a channel notification is how a person is found. |
| 15 | An agent may set `in_review`; **only a person sets `done`**. | Nothing is archived without a human having seen it. |

### Cost and failure

| # | Decision | Consequence |
| --- | --- | --- |
| 16 | Two gates: **12 auto turns / 200k tokens**, per thread tree. | Whichever trips first stops dispatch and says why in the thread. A wall-clock gate was specified and then removed: elapsed time is not cost, and measuring it would have refused a thread revisited the next day. A stuck run is the sweeper's job (18), not the budget's. |
| 17 | **A sub-thread shares its root's budget.** | Closes the hole where creating threads mints new budget. |
| 18 | A run is stuck when **N minutes pass with no activity** — not by total duration. | A legitimate two-hour investigation is never killed for being slow. |
| 19 | A stuck run, and any run still `running` after a **daemon restart**, is **revived and continued**, told it timed out. Failing again marks it `failed`. | One recovery path for both. Cheap — completed work is not repeated — and the agent can report its own progress. |

### Surfaces

| # | Decision | Consequence |
| --- | --- | --- |
| 20 | The entry point **folds into the existing Agents page**; #11140's sidebar change is absorbed here and that PR is closed. | One PR, no dependency ordering, and the "Agents" entry finally means runnable agents. |
| 21 | Creating a thread with an assignee **starts it**; creating one without leaves it idle for a later `@`. | Assignment is the trigger, as in Multica. |
| 22 | Channel notifications (Lark/Slack/…) fire on **blocked, in_review, gate tripped, and run failed after retry**. | The four things that need a person. Reuses the existing channel workers. |

## 3. Data model

```
MeshAgent           id, name, description, color, agentType, model,
                    queueLimit, enabled, createdAt,
                    backgroundAgentId, hostSessionId          ← execution binding

Thread              id, title, body, status, assigneeAgentId, createdAt,
                    createdBy, messages[], runs[],
                    parentThreadId, rootThreadId,             ← budget is on the root
                    autoTurnsUsed, tokensUsed

There is no `maxConcurrentRuns`. Decisions 5 and 10 — one long-lived body per
agent, serial across threads — already cap an agent at one running run, so the
field would have been dead and `defer: agent_at_capacity` collapses into
`defer: busy_elsewhere`.

ThreadMessage       id, from, text, mentions[], at
ThreadRun           id, agentId, sessionId, status, triggerMessageIds[],
                    queuedAt, startedAt, endedAt, attempts, error

ThreadStatus        open | in_progress | blocked | in_review | done
```

Stored under the per-project runtime dir (`~/.qwen/tmp/<project-hash>/mesh/`),
not the working tree — the reasoning the durable scheduled-tasks file records,
plus one more: thread text is written by one agent and fed to another, so it is
a prompt-injection surface and must never be committed, pulled, or reviewed as
if it were code.

## 4. The dispatch loop

```
person or agent posts
        │
        ▼
postMessage()  ── one thread lock ──────────────────────────────┐
  append message                                                │
  resolveTargets: explicit @mentions, else assignee             │
  for each target → decideDispatch                              │
        │                                                       │
        ▼                                                       │
returns { outcomes, dispatched[] } ─────────────────────────────┘
        │
        ▼
dispatcher (daemon)
  for each booked run:
    agent busy on THIS thread   → queueMessage into the running agent
    agent busy on ANOTHER thread→ leave queued; the waiting thread shows why
    agent idle                  → revive its background agent, or launch it
    startRun(runId) · prompt = thread context + posts since its last run
        │
        ▼
agent answers via thread_post ─────────────────────────────────► re-enters postMessage
        │
        ▼
turn ends → finishRun → re-evaluate anything queued
        │
sweeper: run with no activity for N minutes, or `running` at daemon start
        → revive and continue, telling it what happened; second failure → failed
```

The loop closes because an agent's reply is itself a post. That is the whole
mechanism, and it is why the guards are not optional.

### Decision table

| Outcome | When | Why it exists |
| --- | --- | --- |
| `skip: agent_unknown` | mention resolved to no agent | a typo must be visible, not silent |
| `skip: agent_disabled` | agent exists but is off | keeps identity and history without taking work |
| `skip: thread_done` | thread is finished | a late post must not silently restart spend |
| `skip: self_trigger` | the target wrote the post | otherwise one "I'm done" becomes an infinite self-conversation |
| `skip: explicit_routing` | post names others, target is only the assignee | an explicit `@` *is* the routing decision |
| `skip: budget_exhausted` | agent-authored post, the thread tree's gate has tripped | the loop breaker; a human post resets the turn counter |
| `skip: queue_full` | the agent's pending queue is at its limit | makes real throughput visible instead of accruing a backlog |
| `coalesce: queued_run` | target has a queued, unstarted run | one run answers both posts instead of two racing |
| `coalesce: running_same_thread` | target is executing **this** thread | mid-run steering — the thing Multica cannot do |
| `defer: busy_elsewhere` | target is executing **another** thread | serial per agent; the waiting thread says which thread it is on |
| `dispatch` | none of the above | book a run |

Budget is charged at **booking**, not completion, so a pair of agents that keep
failing still runs out. A human post resets `autoTurnsUsed`; the token and
wall-clock gates are not reset, because those measure real spend.

## 5. Module map

Landed on this branch (storage and rules; nothing starts an agent yet):

| File | Responsibility |
| --- | --- |
| `core/src/agents/mesh/types.ts` | Entities and limits |
| `core/src/agents/mesh/mesh-store.ts` | Paths, validation, locking, CRUD |
| `core/src/agents/mesh/mentions.ts` | `@name` → agent ids |
| `core/src/agents/mesh/dispatch-policy.ts` | `decideDispatch` — pure |
| `core/src/agents/mesh/thread-actions.ts` | `postMessage` — append and book under one lock |

### Changes the settled decisions require in that code

1. `types.ts` — add `blocked` to `ThreadStatus`; add `parentThreadId`,
   `rootThreadId`, `tokensUsed`, `firstDispatchedAt` to `Thread`; add `attempts`
   to `ThreadRun`; add `backgroundAgentId`, `hostSessionId`, `queueLimit` to
   `MeshAgent`.
2. `dispatch-policy.ts` — split `defer: active_run` into
   `coalesce: running_same_thread` and `defer: busy_elsewhere` (decision 9); add
   `skip: queue_full` (11); evaluate the budget against the **root** thread (17);
   add the token gate and drop `agent_at_capacity` (16).
3. `mesh-store.ts` — parent/root linkage and its cycle check; drop
   `maxConcurrentRuns` and `agentConcurrencyLimit`.
4. `thread-actions.ts` — charge tokens from each run's stats delta; reset only
   the turn counter on a human post.

Still to build:

| Piece | Where |
| --- | --- |
| Thread tools: `thread_post`, `thread_assign`, `thread_status`, `thread_create`, `thread_read` | `core/src/tools/` |
| Programmatic agent launcher (extracted from the `agent` tool's teammate path) | `core/src/agents/` |
| Dispatcher, sweeper, and host-session keepalive | `cli/src/serve/mesh/` |
| REST: agents, threads, posts, runs | `cli/src/serve/routes/mesh.ts` |
| Read-only shell allowlist | `core/src/agents/mesh/` |
| Channel notifications for the four events | reuse the channel workers |
| Web Shell: roster, thread list, thread view, run transcripts | `web-shell/client/` |
| #11140's sidebar entry, absorbed | `web-shell/client/components/sidebar/` |

## 6. What an agent actually receives

The dispatcher's prompt is load-bearing, and a one-line "thread context plus new
posts" would have left the hardest part unspecified.

Because an agent is one long-lived body across threads (decision 5), its
previous memory may be from a different thread. Every wake therefore opens with
an explicit thread frame — without it, cross-thread confusion is not a risk but
a certainty:

```
── You are now working on thread <id>: <title> ──
<body>
Status: in_progress · Your last post on this thread: <when>

New since your last run here:
  [alice · 3m ago] ...
  [you were @-mentioned] ...

Who you can @ in this workspace:
  @alice — reads CI logs
  @bob   — reads code
You can: thread_post · thread_status (blocked / in_review) ·
         thread_create (sub-thread) · thread_read (any thread)
```

Three rules:

- **Mention tokens are handed over verbatim**, never left to be guessed. Multica
  gives its squad leader ready-made mention markdown for the same reason: a
  misspelled name is a message that silently reaches nobody.
- **First entry to a thread gets the whole thread**; later wakes get the delta.
  Title and body are always included. When the whole thread exceeds the prompt
  budget, it is truncated to the title, body and the most recent stretch, with
  an explicit note that N earlier posts exist and `thread_read` will fetch them
  — the agent is never quietly given a short view it believes is complete.
- **Thread tools take no thread id from the model.** They act on the run's
  thread, resolved from ambient context the way Agent Team resolves teammate
  identity (`runWithTeammateIdentity`, AsyncLocalStorage). Under a long-lived
  cross-thread body, an agent posting its conclusion into an unrelated thread is
  a predictable failure, not an unlucky one, and a model-supplied id would make
  it reachable.

Token accounting comes from each run's stats delta on the background task
registry, so a thread's `tokensUsed` reflects work done for that thread rather
than the agent's whole conversation.

## 7. How this compares to Multica

Three kinds of difference, and they are not the same kind of thing.

**Ahead, in one place.** Mid-run steering. Multica cannot deliver into an
executing run because it drives someone else's CLI process and has no inbound
channel but a fresh launch. Qwen Code's `queueMessage` lands the message in the
next tool round.

**Deliberately not built.** Writing code, branches, PRs and review gates
(decision 1 — read-only until isolation is settled); multi-user roles and access
scopes; self-hosting and multi-tenancy; Projects grouping several repos.

**Missing and worth having.** Runtime binding — agents that run on another
machine or in the cloud, and agents that are not Qwen Code — is the one hard
gap. Scheduled and external-event triggers are absent but the cron scheduler and
channel workers already exist to carry them. Board views, labels, search and
cross-issue references have no equivalent.

| Capability | Reach | Note |
| --- | --- | --- |
| Multi-agent collaboration itself | ~85% | routing, hand-off, sub-thread reporting, serialisation, gates; no squad-leader role routing, but mid-run steering added |
| Run records and observability | ~80% | transcript as log, replayable tool calls, per-run tokens, retry and timeout |
| Skills | ~70% | carried by the agent definition |
| Agent identity | ~50% | identity, persona, enable/disable, workload — runtime binding is zero |
| Triggers | ~50% | assignment and `@`; scheduled and external events unconnected |
| Work items | ~40% | assignable item with conversation and status; no board, labels or search |
| Notifications | ~40% | four events to existing channels; no inbox |
| Multiple surfaces | ~30% | Web Shell and desktop shell |
| Projects | ~15% | a workspace is one cwd |
| Multi-user, self-hosting | ~5% | single user, single machine |
| Producing code changes | 0% | decision 1 |

As a product, roughly 35-40%. That number mixes two unlike things: Multica is a
multi-user server product (Go, Postgres, tenancy, self-hosting) and this is a
single-machine daemon over files. Most of the remaining 60% is that category
difference, not a backlog.

**Measured against multi-agent collaboration itself — hand-off, observability,
steering, guardrails — this reaches roughly 80%**, which is the part that was
actually asked for.

## 8. Demo

Two agents investigating a real problem, with a person steering.

1. Declare two agents in the workspace — one that reads CI logs, one that reads
   code — each on an existing read-only agent definition.
2. Open a thread: *"The web-shell smoke test is flaky. Find out why."*, assign
   the log reader. Assignment starts it.
3. It investigates, posts findings, and `@`s the code reader with a hypothesis.
   The second agent wakes from that post — not from anything the person did.
4. The person interjects mid-run: "check the retry logic first". It lands in the
   running agent's next turn, and resets the turn counter.
5. The code reader posts a conclusion and sets the thread to `in_review`; the
   person marks it `done`.
6. Separately: show a synthetic ping-pong tripping the turn gate, and an agent
   posting a question and setting `blocked`. Both guards visible, not theoretical.

Captured with the web-shell Playwright visuals config, which renders real
screenshots locally and in CI.

## 9. What remains genuinely open

Everything from the earlier risk list is now decided except these:

1. **Agent-to-agent prompt injection.** A post written by agent A is fed to agent
   B, and B has tools. Decisions 2 and 3 bound the blast radius (read-only, with
   a built-in shell ceiling) and decision 16 bounds the duration, but there is no
   trust boundary. A provenance envelope marking posts as data rather than
   instruction was considered and deliberately deferred; it stays the first thing
   to add if agents ever gain write access.
2. **Retention is lossy and silent.** `MAX_THREAD_MESSAGES` / `MAX_THREAD_RUNS`
   trim the oldest without saying so.
3. **Cancellation.** `finishRun(cancelled)` exists; no UI or API calls it.
4. **Serialisation is enforced per post, not globally.** Two posts on different
   threads naming the same agent are decided under different thread locks, so a
   race can book two runs for an agent that is meant to be serial. The dispatcher
   is the second line of defence and must refuse to start a second body for an
   agent that already has one.

## 10. Out of scope

Real OS-process isolation and cross-machine agents (#10078's session-boundary
decision and #10247 §5's stalled wiring choice); durable history after a thread
is deleted; remote and cloud runtimes; multi-user permissions; and agents that
write code, which decision 1 defers until isolation is settled.

<details>
<summary>中文说明</summary>

**这是什么**：持久的 Agent 身份在共享线程上协作。人开一个线程、指派一个 agent，之后 agent 们自己读、发帖、互相 @、拆子线程、干完交回验收，人随时可以插话。就是 Multica 那套形态，但建立在 qwen 已有的机器上。Agent Team 原封不动保留，作为单次 run 内部的紧耦合协作手段。

**两处纠错**（都已核对源码）：一是 Multica 的 agent **确实实时沟通**——它 resume 上一次会话并保住 prompt cache，派发走 WebSocket 推送，@ 一个空闲 agent 秒级起来；它唯一做不到的是往正在执行的 run 里送消息。二是 qwen **没有这个限制**——`resumeBackgroundAgent` 会把消息塞进正在跑的 agent。所以本方案拿到的是「持久可观察的共享线程」**加上**「中途可纠偏」，在两者各自输的那个维度上都不输。

**执行模型的关键修正**：agent 是**每工作空间一个长期后台 agent**，不是 daemon session。因为人格装配那套机器是喂给 agent 运行时的，ACP Session 没有任何 per-session 人格钩子，造一个是热路径上的新工作且无先例。而后台 agent 这条路上，人格、落盘日志、日志展示、唤醒、跨重启复活、自动压缩、审批——全部现成。**所以要写的只有编排层，底下不需要重写任何东西。**

**22 条已定决策**见第 2 节，覆盖范围与安全（v1 只读、内置只读命令白名单为硬上限、工具跟随定义、按工作空间）、身份与记忆（一个长期执行体、自动压缩、宿主会话隐藏、停用留记忆删除清干净）、对话（同线程可中途插话、跨线程串行且明示在忙、队列封顶、可拆子线程但不能造 agent、子线程进 in_review 自动回报父线程、阻塞时发帖提问并标 blocked、agent 可标 in_review 但只有人能标 done）、成本与失败（12 轮/200k token/30 分钟三重闸门且子线程共享根线程预算、按「距上次活动」判定卡死、卡死与重启统一走复活并继续）、界面（吸收 #11140 并关掉它、指派即启动、四类事件推渠道）。

**第 5 节列出了已写代码需要按决策修改的 4 处**，以及还没建的 8 块。**第 7 节是仍然开放的 4 个问题**，其中第 1 个（agent 之间的 prompt 注入要不要加来源信封）需要决定。

</details>
