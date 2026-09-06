# Route B — multi-agent collaboration on a shared board

> Status: Plan — design only, no implementation
> Baseline: `origin/main` @ `703678136a` (2026-09-06)
> Supersedes the Agent-Team-first direction in [`2026-09-06-agent-team-webshell-gap.md`](./2026-09-06-agent-team-webshell-gap.md) §6
> Related: #9402 (board storage), #10078 (session boundary), #10247 §5, #11072

## 0. Decision

Build the Multica-shaped model: **durable agent identities, a shared thread that
several agents read and write, and a dispatcher that wakes the addressed agent's
session.** Agent Team is not the vehicle; it stays available as an *inner* loop
inside a single run.

The reason is a correction, not a preference. An earlier reading of Multica
concluded its agents "don't talk in real time". Verified against its source,
that is wrong on two counts:

- `server/internal/daemon/types.go:110` and `daemon/prompt.go:58` — Multica
  **resumes the agent CLI's prior session** (`PriorSessionID`), and explicitly
  works to keep the prompt cache across resumes. Context is not rebuilt from the
  thread; the same conversation continues.
- `server/internal/daemon/wakeup.go` — dispatch is a **WebSocket push** from
  server to daemon, not polling. An `@` to an agent that is not currently
  running starts it within about a second.

So `@`-based coordination in Multica *is* live collaboration. The only thing it
cannot do is deliver into a run that is already executing:
`server/internal/handler/comment.go:2313` returns `DispatchDeferred` /
`ReasonAlreadyActive` for that case — "its reconcile covers the comment".

Agent Team's one advantage is exactly that gap: `agent-core.ts:1140` drains
external messages at each tool-round boundary and appends them to the next model
turn, so a running teammate can be corrected mid-task. Every other axis —
durability, replay, shared visibility, restartability, cross-machine — favours
the board model. A private inbox that dies with the process is the wrong
substrate for the product described.

## 1. The three pillars, and what we already have

| Pillar | Multica | Qwen Code today |
| --- | --- | --- |
| Resumable per-agent session whose transcript is the run log | `PriorSessionID` + resume | **Have it.** `POST /session/:id/resume`, transcripts persist after the idle reaper closes a session (`serve/create-sub-session.ts`) |
| Wake the addressed agent | WebSocket push → daemon claims → run | **Half.** `create_sub_session` spawns a fresh top-level session and can notify the parent on completion; `scheduled-task-keepalive.ts` already keeps a bound session resident and *revives* one the reaper closed. No addressing layer. |
| Shared, durable work surface everyone reads | Issues + comments in Postgres | **Design only.** #9402's board (`~/.qwen/boards/`, task/ask/decision, cross-process locks) is deliberately storage-and-CLI only: "Pull is the contract. Nothing is delivered into a running agent process." |
| Agent identity bound to a runtime | Agent + Runtime records | **No.** Only definitions (`.qwen/agents/*.md`, `SubagentManager`, `/workspace/agents`). |

The single most useful piece of prior art is the durable scheduled task. It
already is, structurally, what a Route B "assignment" needs:
`DurableCronTask` (`core/src/services/cronTasksFile.ts:76`) carries an id, a
prompt, an `enabled` switch, a **bound `sessionId` whose transcript is the run
history**, and a bounded `runs[]` history — with `scheduled-task-keepalive.ts`
handling residency and revival and `scheduled-task-session-lifecycle.ts`
handling archive/delete coupling. Route B's dispatcher is the same shape with a
different trigger.

## 2. Entities

**Agent** — a durable identity in a workspace.
`id`, `name`, `color`, `description`, `agentType` (an existing definition,
supplying prompt/tools/MCP/skills), optional `model` and approval mode,
`maxConcurrentRuns`, `enabled`/`archived`. Persisted per workspace, next to the
durable-tasks file.

**Thread** — the shared surface; Multica's issue.
`id`, `title`, `body`, `status`, optional `assigneeAgentId`, and an append-only
`messages[]` of `{id, from: agentId | 'user', text, mentions[], at}`.

**Run** — one agent turn against one thread.
`id`, `agentId`, `threadId`, bound `sessionId`, `status`, timings, token usage,
error. The bound session's transcript is the log — no second log format.

## 3. The dispatch loop

A new message lands on a thread (from a person, from an agent, from a channel,
from a schedule). Then:

1. **Resolve targets** — explicit `@mentions`, else the assignee.
2. **Admit** — agent exists, enabled, workspace trusted, concurrency slot free.
   Fail closed: an unresolvable check never enqueues.
3. **Coalesce / defer** — the rules Multica learned the hard way:
   - target has a *queued, unstarted* run on this thread → merge the message into it;
   - target has an *active* run → defer; its completion re-checks the thread;
   - an agent's own message never wakes itself;
   - an explicit `@` to someone else suppresses the assignee's automatic wake.
4. **Ensure a session** — look up `(agentId, threadId) → sessionId`. Missing →
   create one in the workspace carrying the agent's persona. Present but not
   resident → `POST /session/:id/resume`.
5. **Prompt** — thread title/body, the messages since this agent's last run, the
   agent's own instructions, and the reply protocol.
6. **The agent replies through tools** — `thread_post`, `thread_assign`,
   `thread_status`; the qwen equivalent of Multica's `multica` CLI. A
   `thread_post` re-enters step 1, which is what makes agent-to-agent
   conversation work.
7. **Record and re-check** — write the run record; re-evaluate anything deferred
   at step 3.

**Loop safety is not optional.** Two agents that `@` each other will ping-pong
until the budget runs out. Multica's self-trigger guard plus dedup is necessary
but not sufficient; this needs a hard per-thread auto-turn budget and a
per-agent concurrency cap, both visible in the UI and both refusing rather than
silently stopping.

## 4. New vs reused

New: the agent registry (+REST +UI), the thread store (+REST +UI), the
dispatcher service, the three thread tools, and session persona binding.

Reused: session create/resume/transcript, the keepalive-and-revive pattern, the
durable-record and bounded-run-history shapes, agent definitions as persona,
the existing permission dialog, the Web Shell transcript panel, channels as an
external trigger, and Agent Team as an optional inner loop when one run wants
tight sub-turn collaboration.

## 5. Decisions needed before implementation

1. **Thread storage** — new `threads/` store, or adopt #9402's board files?
   *Recommend new store*; leave the board CLI as the foreign-process interop
   surface, since it deliberately refuses addressing and delivery.
2. **Persona binding** — extend `POST /session` with `agentType`, or inject the
   persona in the first prompt? *Recommend extending the route*; prompt
   injection cannot give the agent its definition's tools and MCP servers.
3. **Scope** — threads per workspace (like durable tasks) or global?
   *Recommend per workspace.*
4. **Working directory** — v1 agents share the workspace cwd; per-agent
   worktrees later. *Recommend deferring worktrees.*
5. **Guardrails** — per-thread auto-turn budget and per-agent concurrency
   defaults. Numbers to pick, but they must exist in v1.
6. **Gating** — new experimental flag, or reuse `experimental.agentTeam`?
   *Recommend a separate flag*; this is not Agent Team.

## 6. Module map

Landed on this branch (storage and rules only — nothing starts a session yet):

| File | Responsibility |
| --- | --- |
| `core/src/agents/mesh/types.ts` | `MeshAgent`, `Thread`, `ThreadMessage`, `ThreadRun`, and the three limits |
| `core/src/agents/mesh/mesh-store.ts` | Paths, validation, locking, CRUD for agents and threads |
| `core/src/agents/mesh/mentions.ts` | `@name` → agent ids |
| `core/src/agents/mesh/dispatch-policy.ts` | `decideDispatch` — pure, one decision per (post, target) |
| `core/src/agents/mesh/thread-actions.ts` | `postMessage` — append and book runs under one lock; run state transitions |

Still to build:

| Piece | Where | Note |
| --- | --- | --- |
| Thread tools (`thread_post`, `thread_assign`, `thread_status`, `thread_read`) | `core/src/tools/` | How an agent participates; the qwen equivalent of Multica's `multica` CLI |
| Session persona binding | `serve/routes/session.ts` + core config | `POST /session` accepts `agentType`; without it an agent session has the definition's prompt but not its tools and MCP |
| Dispatcher service | `cli/src/serve/mesh-dispatcher.ts` | Consumes `postMessage`'s bookings: ensure session → resume or create → prompt → `startRun`/`finishRun` |
| REST | `cli/src/serve/routes/mesh.ts` | Agents CRUD, threads CRUD, post, run listing |
| Web Shell | `web-shell/client/` | Agents page, thread list, thread view with attributed posts and run state |

## 7. The end-to-end sequence

```
person or agent posts
        │
        ▼
postMessage()  ── one thread lock ──────────────────────────────┐
  append message                                                │
  resolveTargets: explicit @mentions, else assignee             │
  for each target → decideDispatch                              │
      dispatch  → book a queued run, charge the budget          │
      coalesce  → add the message to an unstarted run           │
      defer     → nothing now; the active run re-checks later   │
      skip      → recorded with a reason, visible in the UI     │
        │                                                       │
        ▼                                                       │
returns { outcomes, dispatched[] } ─────────────────────────────┘
        │
        ▼
dispatcher (daemon)
  for each booked run:
    session = binding(agentId, threadId)
      missing      → POST /session with the agent's persona
      not resident → POST /session/:id/resume
    startRun(runId, sessionId)
    prompt = thread context + posts since this agent's last run + reply protocol
    send prompt
        │
        ▼
agent answers by calling thread_post ─────► re-enters postMessage
        │
        ▼
turn ends → finishRun → re-evaluate anything deferred
```

The loop closes because an agent's reply is itself a post. That is the whole
mechanism, and it is why the guards are not optional.

## 8. Dispatch decisions in full

| Outcome | When | Why it exists |
| --- | --- | --- |
| `skip: agent_unknown` | mention resolved to no agent | a typo must be visible, not silent |
| `skip: agent_disabled` | agent exists but is off | keeps identity and history without taking work |
| `skip: thread_done` | thread is finished | a late post must not silently restart spend |
| `skip: self_trigger` | the target wrote the post | otherwise one "I'm done" becomes an infinite self-conversation |
| `skip: explicit_routing` | post names others, target is only the assignee | an explicit `@` *is* the routing decision |
| `skip: budget_exhausted` | agent-authored post, thread's auto-turn budget spent | the loop breaker; a human post resets it |
| `coalesce` | target has a queued, unstarted run | one run answers both posts instead of two racing |
| `defer: active_run` | target is already executing on this thread | mid-run delivery is not possible; its completion re-checks |
| `defer: agent_at_capacity` | agent is at `maxConcurrentRuns` | spend and contention control; resolves by waiting |
| `dispatch` | none of the above | book a run |

Budget is charged at **booking**, not completion, so a pair of agents that keep
failing still runs out.

## 9. What reviewers should push on

These are the choices most likely to be wrong. Listed so a reviewer does not
have to find them.

1. **Session-per (agent, thread).** The binding is one durable session per pair.
   That gives each agent a warm, resumable context per work item — but a
   long-lived thread grows one session per participant indefinitely, and
   nothing reclaims them. Alternative: one session per agent, with thread
   context re-supplied each turn. Cheaper to reclaim, colder per turn.
2. **The auto-turn budget is per thread, not per agent pair.** Two agents in a
   tight loop and five agents doing real hand-offs consume the same counter.
   A pair-scoped budget would be more precise and more state.
3. **`defer` has no wake-up of its own.** A deferred target is re-evaluated when
   the blocking run finishes. If that run dies without reporting, the deferred
   work is stranded. The scheduled-task keepalive has the same hazard and
   solves it with a periodic sweep; this needs the equivalent, and does not
   have one yet.
4. **Concurrency counting is best effort.** `countActiveRuns` reads sibling
   threads without holding their locks, so a simultaneous booking elsewhere can
   overshoot the limit by one. Making it exact needs a workspace-wide lock on
   every post. Is one-over acceptable?
5. **Thread text is untrusted input.** A post written by agent A is fed to agent
   B. Prompt injection between agents is in scope by construction, and the only
   mitigations here are keeping the store out of the working tree and bounding
   turns. Should posts be framed to the model as data with an explicit
   provenance envelope?
6. **Retention is lossy.** `MAX_THREAD_MESSAGES` / `MAX_THREAD_RUNS` trim the
   oldest. A thread that hits either bound has arguably outgrown one work item,
   but the trim is silent.
7. **No cancellation path yet.** `finishRun(cancelled)` exists; nothing calls
   it. Stopping a thread's agents from the UI is unbuilt.

## 10. Demo, and how it will be shown

Two agents and a person on one thread:

1. Declare `planner` (definition: a research agent) and `builder` (a coding
   agent) in the workspace.
2. Open a thread: *"The web-shell smoke test is flaky. Find out why."*, assign
   `planner`.
3. `planner` wakes, investigates, posts findings and `@builder` with a proposed
   fix — `builder` wakes from that post, not from anything the person did.
4. The person interjects mid-thread: "check the retry logic first" — `@`-free,
   so it goes to the assignee, and it resets the loop budget.
5. Both agents' runs are visible with state and elapsed time; each opens to its
   own transcript.
6. Show the budget refusing a synthetic ping-pong, so the guard is visible
   rather than theoretical.

Captured with the web-shell Playwright visuals config, which renders real
screenshots in CI and locally.

## 11. Scope

In: agent registry, thread store, dispatch rules, the four thread tools,
session persona binding, the dispatcher, and a Web Shell surface for all of it.

Out, deliberately: real OS-process isolation and cross-machine agents (that is
#10078's session-boundary decision, and #10247 §5's stalled wiring choice);
durable history after a thread is deleted; remote/cloud runtimes; multi-user
permissions. Agent Team is untouched and remains the inner loop for sub-turn
collaboration within a single run.

<details>
<summary>中文说明</summary>

**结论**：走 Multica 形态——持久的 Agent 身份、多个 Agent 共读共写的线程、以及一个「谁被 @ 就唤醒谁的会话」的派发器。Agent Team 不是载体，但保留为单次 run 内部的紧耦合协作手段。

**这是一次纠错**：之前说「Multica 的 agent 不实时沟通」是错的。核对源码后确认两点——它会 resume agent CLI 的上一次会话（`daemon/types.go:110`，并且明确在意保住 prompt cache），派发是 WebSocket 推送而非轮询（`daemon/wakeup.go`）。所以 @ 一个没在跑的 agent，秒级就起来了。唯一做不到的是「往正在执行的 run 里塞消息」（`handler/comment.go:2313` 返回 deferred）。而这恰好是 Agent Team 唯一的优势（`agent-core.ts:1140` 在每个工具轮边界注入外部消息）。除此之外，持久性、可回放、共享可见、可重启、跨机器，全都是看板模型更好。

**最有价值的复用**：`DurableCronTask`（`cronTasksFile.ts:76`）已经是本方案需要的结构——绑定的 sessionId、其 transcript 即运行历史、有界的 runs；`scheduled-task-keepalive.ts` 已经处理了「保持会话常驻、被回收后复活」。派发器是同一形状，触发源从 cron 换成 @。

**本分支已落地**（仅存储与规则，还不会启动任何会话）：`types.ts`、`mesh-store.ts`、`mentions.ts`、`dispatch-policy.ts`、`thread-actions.ts`。**尚未实现**：四个线程工具、会话人格绑定（`POST /session` 接受 `agentType`）、派发器服务、REST 路由、WebShell 界面。

**派发规则十种结局**见第 8 节。其中四条抄自 Multica 踩出来的经验，第五条（每线程自动轮次预算）是我们加的——Multica 不需要它是因为它的 run 会自然结束且有人类持有 issue，而两个 mesh agent 互相回复没有任何东西能停下来。预算在**入队时**扣，不是完成时，所以一直失败的一对 agent 也会耗尽。

**第 9 节列了 7 个最可能错的设计选择**，请评审重点打这些：会话按 (agent, thread) 绑定会无限增长且无回收；预算是按线程而非按 agent 对；`defer` 没有自己的唤醒机制，阻塞的 run 若异常死亡会导致工作滞留；并发计数是尽力而为，可能超一个；线程文本是 agent 之间的注入面；保留策略是静默有损的；取消路径尚未接通。

**第 10 节是 demo 脚本**，第 11 节是明确不做的部分。

</details>
