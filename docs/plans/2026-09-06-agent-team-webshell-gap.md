# Agent Team in WebShell: current state and the gap to an orchestrated agent fleet

> Status: Assessment — no implementation
> Baseline: `origin/main` @ `002305b903` (2026-09-06), plus `origin/codex/agent-team-roster-web-shell` (#11072) and `origin/codex/agent-team-discovery-web-shell` (#11140)
> Related: #10247 (Agent Team tracker), #11069, #8724 (closed), #9402 (board), #11003 (external ACP executor)

## 0. Summary

The target experience — *declare durable agents, put repos and work items in a workspace, create a
task against a workspace, pick one or more agents, and let several agents self-organise* — is the
Multica model. Qwen Code today implements a **different** model: one interactive session's model
calls `team_create`, and teammates are spawned **inside that session's process**.

The two open PRs are the *observability + plumbing* leg of the current model. They are correct and
worth landing, but they do not move the topology toward the target. Everything the target needs —
durable agent identity, runtime binding, a work-item/run record, UI-initiated team formation, and a
process per agent — is still unbuilt, and one of its prerequisites (#10247 §5, the Agent View
supervisor wiring) is stalled on an unmade decision.

Rough distance: the coordination *runtime* is ~80% there for the in-session topology; the
*orchestration product* the user described is ~10–15% there, and most of the remaining work is new
daemon state, not model plumbing.

## 1. The two PRs, precisely

### #11072 — `feat(ui): show Agent Team status in CLI and WebShell` (draft, base `main`, +1374/-89, 40 files)

Two things, not one:

1. **A read-only roster projection.** `use-team-agent-roster.ts` (new) adapts live `TeamManager`
   members into the existing CLI `LiveAgentPanel` rows; `tasksSnapshot.ts`'s
   `buildSessionAgentsStatus` appends team members (name, colour, current in-progress shared task,
   running/idle/completed) to the existing session-agents snapshot, so WebShell's `EnvironmentPanel`
   and `AgentWorkflow` pick them up with no new route, SSE event, or store.
2. **Actual ACP coordination wiring** (`Session.ts`, +157). This is the load-bearing part:
   `#registerTeamManagerCallbacks` binds the leader-message callback so a teammate report enqueues a
   background notification and **resumes an idle WebShell leader**; teammate tool approvals are
   routed through the existing WebShell permission dialog
   (`#requestTeammateApproval`); replacing/deleting a team detaches callbacks, aborts pending
   approvals, and drops that team's queued notifications. Plus: named teammates keep their name
   through the daemon transcript (dedupe), and a teammate launched from an Agent definition inherits
   that definition's MCP servers.

CI is green (including the real-daemon E2E and web-shell smoke). No reviews yet. Still draft.
Before #11072, `qwen serve` had the Agent Team runtime but no path for a teammate to reach the
leader or the user — so this is the PR that makes Agent Team *usable at all* in WebShell.

### #11140 — `feat(web-shell): expose Agent management in sidebar` (draft, base `codex/agent-team-roster-web-shell`, +120, 7 files)

Its own delta is 120 lines: one `agents` entry in the WebShell primary sidebar between New Task and
Plugins, opening the **existing** `AgentsManagerPage` (Agent *definition* CRUD), plus one sentence
explaining that Qwen can coordinate definitions in an Agent Team. No runtime behaviour.

Two caveats:

- It is stacked on #11072, and a PR based on a non-`main` branch **runs no unit tests and no
  Lint & Static** in this repo (`ci.yml` triggers only on `main`/`release/**`). Its checks are all
  `skipping`.
- The entry is called "Agents" but manages *prompt/tool/model definitions*, not runnable agents.
  Against the target model that name is a promise the daemon cannot yet keep.

## 2. What actually exists today (traced)

| Layer | Exists | Where | Note |
| --- | --- | --- | --- |
| Agent **definitions** | Yes | `.qwen/agents/*.md`, `SubagentManager`, `GET/POST /workspace/agents` (`serve/workspace-agents.ts:180`), WebShell `AgentsManagerPage` | Prompt + tools + MCP + hooks + model. **No runtime binding, no identity, no run history.** |
| Agent **team runtime** | Yes | `packages/core/src/agents/team/` (~6.9k lines): `TeamManager`, `tasks.ts`, `mailbox.ts`, `leaderPermissionBridge.ts`, `promptAddendum.ts` | Persisted at `~/.qwen/teams/{team}/config.json`, shared tasks at `~/.qwen/tasks/{team}/`. Gated behind experimental `agentTeam` setting, **default off** (`settingsSchema.ts:3650`). |
| Team **creation** | Model-only | `team_create` tool (`config.ts:8197`) | There is no API or UI that creates a team. The LLM decides. |
| Teammate **process** | In-process | `detectBackend` (`agents/backends/detect.ts:41`) defaults to `InProcessBackend`; `TmuxBackend` is opt-in via `agents.displayMode` and CLI-only | Under `qwen serve`, teammates are `AgentCore` loops **inside the daemon process**. |
| Daemon **workspaces** | Yes | `serve/workspace-registry.ts` — `WorkspaceRuntime` = id + cwd + trust + bridge + services | A workspace is **one cwd**, not a set of repos, and holds no work items. |
| Daemon **sessions** | Yes | `POST /session` (`routes/session.ts:1318`) — cwd, model, approvalMode, scope | No agent/persona binding at creation. |
| Spawn a **fresh top-level session** | Yes | `create_sub_session` tool + daemon handler `serve/create-sub-session.ts` | The closest existing primitive to "a new agent that is a real main loop". Fire-and-forget or first-turn result; not kept resident. |
| Supervised **child processes** | Stranded | `packages/cli/src/agent-view/` (~3.1k prod lines) | `supervisor-runner.ts:38` spawns `qwen --internal-agent-view-supervisor`; **nothing on `main` parses that flag** and yargs is `.strict()`, so the supervisor exits immediately. Tracked as #10247 §5 with two competing wiring stacks (#7802/#7803 vs #10942/#10943/#10949/#10954) and an unmade choice. |
| **Remote / cloud** agents | No | — | Nearest: #11003 delegates one subagent turn to an external agent (Claude Code) over ACP — local child process, per-turn, not a hosted agent. #11139 separates leader/worker credentials. |
| Cross-process work sharing | Design + PR | #9402 agent board (`~/.qwen/boards/`), design `docs/plans/2026-08-18-peer-session-collaboration.md` | Pull-based, no membership, no wake path. Explicitly **not** a scheduler. |

## 3. Agent Team vs subagents — what the difference actually is here

The user's mental model ("subagents can't talk; teams can") is directionally right but not quite
this codebase's distinction, because Qwen Code's background subagents *can* already be messaged
mid-flight (`send_message` with `task_id`, `background-agent-resume.ts`). The real differences:

| | Subagent (`agent` tool) | Teammate (Agent Team) |
| --- | --- | --- |
| Lifetime | One task, then terminates | Long-lived: goes **idle** and picks up the next task; idle is deliberately distinct from completed |
| Identity | Ephemeral `task_id` from the launch response | Named `name@team`, persisted on disk with PID liveness; discoverable via `list_agents` |
| Work assignment | Parent hands it a prompt | Shared task list with `claim` semantics, `blocks`/`blockedBy`, owner field — teammates **pull** work (`promptAddendum.ts` literally instructs: call `task_list`, claim, do, report, mark complete, repeat) |
| Topology | Star: parent ↔ child | Leader + named peers, broadcast `*`, structured mailbox (`shutdown_request`, `plan_approval_request`, `task_assignment`) with cross-process file locks |
| Approvals | Routed to the parent session | `leaderPermissionBridge` + optional plan mode: teammate must `exit_plan_mode` and get leader approval before writing |
| Leader blocking | Inline subagent blocks the turn; background ones notify | Leader stays idle and is **resumed** by a teammate report (this is what #11072 wires into ACP) |
| Process | In the session process (or backgrounded) | In-process, or a real `qwen` process per teammate under the tmux backend |

**What that buys.** Warm, stateful workers that survive across tasks (no re-priming per task),
pull-based distribution so the leader isn't a dispatch bottleneck, mid-flight steering without a
full hand-back, and a plan-approval gate before a worker is allowed to write.

**What it costs.** Each teammate is a full independent context — its own history, its own system
prompt, its own tool declarations. Nothing is shared. So the bill is not "×2"; it is roughly
**N × (per-worker context) + the coordination traffic**: every teammate re-polls `task_list` on each
loop, every report is a `send_message` plus a leader resume turn, and each approval is another
leader round trip. With N warm workers on a long task the coordination term is not the small one.
The payoff is wall-clock parallelism and keeping the leader's context clean — the same context
argument that justifies ordinary subagents, plus concurrency.

**Correction worth internalising:** an Agent Team is *not* a stronger version of a subagent; it is a
different **allocation model** (pull from a shared board) with a different **lifetime** (warm and
reusable). The chat-vs-no-chat framing understates it.

## 4. The target model, mapped

The described workflow is Multica's, near one-to-one:

| Target concept | Multica | Qwen Code today |
| --- | --- | --- |
| Agent = reusable identity, bound to a runtime and model, with availability + workload status | `Agent` + `Runtime` | **Definition only.** No runtime binding, no online/offline, no workload. |
| Workspace holds repos and work items | `Workspace` + `Projects` + `Issues` | Workspace = one cwd. No projects, no issues. Nearest: goals, scheduled tasks. |
| Create a task, pick workspace + agent(s) | Assign an issue to an agent | New Task creates a chat session; no agent picker. |
| Several agents → coordinated by a leader | `Squad` (leader routes, members triggered by `@mention`) | Agent Team, but created **by the model inside a session**, not declared by the user. |
| Each run is a real, isolated execution with a record | `Run` (transcript, tokens, retries) | Sessions and workflow runs exist; not tied to a work item or an agent identity. |
| Agents may be remote/cloud | Daemon runtimes, cloud runners | None. |

Note the topology difference that is easy to miss: a Multica **squad leader routes and stops** —
coordination is coarse, durable, and mediated by issue comments; runs are fresh processes. A Qwen
**Agent Team leader stays live** and its teammates share an in-memory/on-disk task board with
fine-grained messaging. The target wants Multica's *outer* loop with (optionally) Qwen's *inner*
loop inside a single run. These compose; they do not conflict.

## 5. Gap, in dependency order

1. **Durable agent identity** — agent = definition + runtime + model + concurrency + access, with
   its own id and history. New daemon-persisted state and a REST surface. Everything else depends
   on this. #11140's sidebar entry is the natural home for it, which is exactly why landing that
   entry while it still means "definition CRUD" is a naming risk.
2. **A process (or hosted session) per agent.** Three candidate hosts, pick one:
   (a) daemon-hosted session per agent, built on `create_sub_session` — cheapest, no new supervision,
   but agents share the daemon's fate and memory; (b) child `qwen` process per agent supervised by
   the daemon — this is what `agent-view/` was built for, and it is one unmade decision plus one
   unparsed CLI flag away from being reachable; (c) generalise `TmuxBackend` — visible but
   terminal-bound and CLI-only. **Recommendation: (b), after #10247 §5 picks a wiring stack.**
3. **Work items and runs.** A durable record keyed to work, not to a chat session: who ran, against
   which agent identity, what it cost, what it produced. `workflow-run-registry` + workflow
   snapshots are the closest existing shape and are worth reusing rather than re-inventing.
4. **UI-initiated team formation.** Today `team_create` is a model tool. Needs an API that
   pre-creates a team and binds a session to it, so "pick 3 agents for this task" is a user action
   rather than a prompt the leader has to be talked into. This is the *smallest* remaining item —
   `TeamManager` already accepts an externally-constructed team file.
5. **Remote / cloud agents.** ACP over a network transport plus a credential model. #11003 and
   #11139 are the first two bricks; there is no third yet.

Also gating, not optional:

- `agentTeam` is experimental and **off by default** — the whole surface is invisible to users
  until that flips, which is a product decision, not a code one.
- #10207 (one task dispatched to two teammates) is the last open lifecycle race, fix still draft.
- `chore/remove-unwired-agent-view` exists as a branch — deleting the supervisor is on the table.
  Deciding to keep it and deciding to build (2b) are the same decision.

## 6. Recommended next steps

1. **Land #11072.** Take it out of draft and get review. Its ACP wiring is a prerequisite for any
   later topology — a teammate that cannot reach the leader or raise an approval in WebShell is
   unusable regardless of who spawns it. The read-only roster is a fair MVP; WebShell teammate
   transcript browsing can follow.
2. **Retarget #11140 to `main`** (small `App.tsx` rebase) so it gets real CI, or hold it until step
   1 lands and the agent-identity model is decided. Landing it is cheap and forecloses nothing, but
   plan to re-point "Agents" at real agent identities rather than definitions.
3. **Force the #10247 §5 decision** before any further orchestration work: one wiring stack, or
   delete `agent-view/`. Step 2 of §5 above cannot start until this is settled.
4. **Write the target-model design** (agent identity + run record + team formation API) as a
   separate plan. It is a daemon-state design, not a UI change, and it is where the real distance
   lies.

<details>
<summary>中文说明</summary>

目标形态（声明持久化的 Agent、工作空间挂仓库与事项、新建任务时选工作空间 + 若干 Agent、多个 Agent 自动组队）本质上是 Multica 的模型。Qwen Code 现在实现的是另一套：由会话里的模型调用 `team_create`，队友跑在**同一个进程内**。

两个 PR 是当前模型的「可观测 + 接线」这一条腿：#11072 一半是只读 roster 投影，另一半是真正关键的 ACP 接线（队友汇报唤醒空闲 Leader、队友审批走 WebShell 权限弹窗、团队替换/删除时解绑与清理、Agent 定义的 MCP 继承）；#11140 只有 120 行，在侧栏加一个入口，打开的是**已有的 Agent 定义管理页**，没有运行时语义，而且因为叠在非 main 分支上，单测和 Lint 全部 skip。

Agent Team 与 subagent 的差异，不完全是「能不能聊天」——Qwen 的后台 subagent 已经可以用 `send_message(task_id)` 中途通信。真正的差异是**分配模型**（共享任务板 + 认领，队友主动拉活）和**生命周期**（idle 后可复用，不是一次性）。代价不是「翻倍」，而是 N 份独立上下文 + 协调流量（每轮 `task_list` 轮询、每次汇报的 Leader 续跑、每次审批的往返）。

距离：协调运行时对「单会话内组队」这个拓扑已经完成约 80%；用户描述的编排产品大约只有 10–15%，缺的主要是 daemon 侧的新状态而不是模型接线。按依赖顺序缺：①持久化的 Agent 身份（绑定 runtime/模型）②每个 Agent 一个真实进程或托管会话（推荐走 daemon 托管子进程，但要先在 #10247 §5 二选一，`agent-view/` 的 supervisor 至今因为 `--internal-agent-view-supervisor` 没人解析而跑不起来）③事项与 Run 记录 ④由 UI 而非模型发起的组队 API（这一项最小）⑤远程/云端 Agent（目前只有 #11003、#11139 两块砖）。另外 `agentTeam` 默认关闭，#10207 竞态未修。

建议：#11072 转 Ready 送审；#11140 改 base 到 main 拿到 CI（或等身份模型定了再合，避免「Agents」入口名不副实）；尽快敲定 #10247 §5；把目标形态单独写成一份 daemon 状态设计。

</details>
