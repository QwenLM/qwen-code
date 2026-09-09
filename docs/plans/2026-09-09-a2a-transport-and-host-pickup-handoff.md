# 交接：A2A 传输层与 Host 出站取件

状态：两项均未开始。上游状态见[实施计划 §3b](./2026-09-09-agent-service-collaboration-plan.md)。基线 `c976e5e2a0`（分支 `codex/multi-agent-mesh-foundation`，PR #11206）。

两项都**只差传输**：语义、存储与授权已落地并有断言覆盖，可用 `node scripts/audit/run-workspace-agents.mjs`（335 passed）复跑。**不要重新实现这些语义**，接上去即可；下面每条“已有”都是不该再造一遍的东西。

两项文件不重叠，可并行。

---

## 任务 1：A2A JSON-RPC 传输层

把已冻结的契约和已实现的五个操作，暴露成一个真的 A2A 服务端。

### 已有（不要重写）

- `packages/core/src/agents/workspace-agents/a2a-contract.ts` — 冻结的版本与常量：`A2A_PROTOCOL_VERSION = '1.0'`、`A2A_TRANSPORT_BINDING = 'JSONRPC'`、`A2A_AGENT_CARD_PATH = '.well-known/agent-card.json'`、`A2A_CONTENT_TYPE = 'application/a2a+json'`、`QWEN_A2A_EXTENSION_URI`、`toA2ATaskState`、`externalRequestKey`。选型理由见[冻结契约](../design/2026-09-09-a2a-frozen-contract.md)，**不要改版本或绑定**。
- `packages/core/src/agents/workspace-agents/a2a-server.ts` — 五个必需操作，全部已实现并测过：

  ```ts
  a2aSendMessage(projectRoot, caller, { agentId, messageId, title, body, acceptanceCriteria? })
    : Promise<A2AResult<A2ATaskView>>
  a2aGetTask(projectRoot, caller, taskId): Promise<A2AResult<A2ATaskView>>
  a2aListTasks(projectRoot, caller, agentId): Promise<A2AResult<A2ATaskView[]>>
  a2aCancelTask(projectRoot, caller, taskId)
    : Promise<A2AResult<{ task: A2ATaskView; runsStillLive: number }>>
  a2aAgentCardForCaller(projectRoot, caller, agentIds, baseUrl): Promise<A2AAgentCard>
  ```

  `A2ACaller = { callerId: string; secret: string }`。

- `a2a-grants.ts` — grant 的签发、撤销、校验、作用域、过期。
- `external-intake.ts` — 幂等接单、同键冲突、按调用方限定读写。

### 要做的

1. 把 `@a2a-js/sdk@^1.1.0` 加进 `packages/cli/package.json`（目前不是依赖）。它的 peer 里有 `@grpc/grpc-js` 和 `@bufbuild/protobuf`——**只用 `./server/express`,不要把 gRPC 拉进来**。
2. 新建 `packages/cli/src/serve/routes/a2a.ts`：用 SDK 的 express 服务端，把 `A2ARequestHandler` 的五个必需方法转成上面五个函数的调用。
3. 公开 Agent Card 路由 `GET /.well-known/agent-card.json`。
4. `A2AFailure` → JSON-RPC 错误码映射。
5. 在 `server.ts` 挂载，照 `if (agentCollaborationEnabled) { … }` 的现有两处（约 2118、3159 行）同样包起来。

### 必须守住的点（每条都有理由，不是风格偏好）

- **调用方身份只能来自传输层认证，绝不能读请求体里的 `callerId`。** 请求体里的 id 是一句自称；grant 的全部意义就是这句自称要被核对。
- **公开卡片与 `a2aAgentCardForCaller` 是两份不同文档。** 后者按调用方生成、列出它被授权的 agent。公开那份是给发现用的，**不能枚举 agent**——否则任何人 GET 一次就拿到了本 daemon 的 agent 清单。
- **`A2AFailure` 的 `refused` 必须映射成单一错误码，四种授权失败对外不可区分。** 上游已经把「无 grant / 密钥错 / 过期 / 越权」压成了一个 `refused`，传输层若再拆开就把这层设计撤销了：能区分它们的调用方可以枚举 agent。
- **`not_found` 同理**：「没有这个任务」与「不是你的任务」是同一个答案。不要为后者加 403 分支。
- **`conflict` 要把 `existingTaskId` 带给调用方。** 这是「你这个 id 已经用在别的内容上了」，与普通失败不同——分不清的调用方会永远重试。
- **`capabilities.streaming` 与 `pushNotifications` 保持 false。** 规范用这两个标志门控可选操作；advertise 一个没实现的，会把客户端的正确行为变成失败调用。因此也**不要实现** `sendMessageStream` / `resubscribe` / 四个 push 方法。
- 版本用 header `A2A-Version: 1.0`，响应 `Content-Type: application/a2a+json`。**不要在请求或卡片里带 patch 版本号**（规范明确 SHOULD NOT）。

### 过关条件

不是「能编译」「能 curl 通」。要的是：

1. 用 **`a2a-sdk`（Python，PyPI 1.1.2）** 作为独立客户端跑通接单、查询、列举、取消。这是 P1 选定的互通验收者——用 `@a2a-js/sdk` 自带 client 打自己只能算冒烟，不作为兼容证据（架构 §6）。
2. 记录实际用到的方法名、返回分支与不支持项。
3. 关闭 `experimental.agentCollaboration` 时，这些路由与公开卡片全部消失（404），且普通 daemon API 不受影响。
4. 幂等与作用域在传输层之后依然成立：同一 `messageId` 重发不产生第二个任务；第二个授权客户端读不到第一个的任务。上游已有断言，传输层不得绕过。

---

## 任务 2：Host 出站取件通道

### 已有（不要重写）

`packages/core/src/agents/workspace-agents/host-lease.ts`，18 条断言覆盖：

```ts
acquireRunLease(projectRoot, { threadId, runId, hostId, ttlMs? }, now?): Promise<LeaseResult<RunLease>>
renewRunLease(projectRoot,  { threadId, runId, leaseId, ttlMs? }, now?): Promise<LeaseResult<RunLease>>
checkRunLease(projectRoot,  { threadId, runId, leaseId }, now?): Promise<LeaseResult<RunLease>>
releaseRunLease(projectRoot,{ threadId, runId, leaseId }): Promise<LeaseResult<true>>

type LeaseRefusal = 'no_such_run' | 'not_leasable' | 'held_by_other_host'
                  | 'stale_lease' | 'attempt_moved_on'
```

`DEFAULT_RUN_LEASE_MS = 60_000`。已有的 Host 注册与心跳在 `packages/cli/src/serve/routes/agent-hosts.ts`（`POST /agent-hosts/enroll`、`POST /agent-hosts/:workspaceId/:hostId/heartbeat`），凭证校验用其中的 `hostSecret(req)` + `heartbeatAgentHost` 模式。

### 要做的

在 `routes/agent-hosts.ts` 里加两个端点：

1. **取件长轮询** — Host 主动来问有没有活。命中就 `acquireRunLease`，把 run 与提示词一起交出去。
2. **结果回传** — Host 交回执行结果。

同样包在 `agentCollaborationEnabled` 里。

### 必须守住的点

- **写入前一律先 `checkRunLease`,不要自己再造一套核对。** 这是本任务最容易做错的地方：租约的意义就是「消失过的 worker 不能覆盖接手者」,绕过它写一次就前功尽弃。
- **`stale_lease` 与 `attempt_moved_on` 要分开回报。** 前者是「你的租约被接管了」,后者是「这个 run 重启过,你手里的是上一轮的」——同一个 Host 也可能撞上后者。给同一个错误码,排查时分不出是哪种。
- **持久化后才确认,结果持久化后才重试发送。** 先确认再落盘,断网就会丢掉一次真实执行。
- **执行机器不得新增入站监听。** 全部出站,这是本步骤存在的理由。
- **Host 凭证不能领取他人的任务。** 照 heartbeat 的模式先核对 workspace 与 host 凭证,再谈租约。
- **断网显示失联或状态未知,不得未经核对就在另一台机器重跑有副作用的工作。** 租约到期让 run 可被再领取是设计,但「再领取」与「重跑副作用」是两回事——回传路径必须能识别重复结果。

### 过关条件

1. 执行机器无新增入站监听,仍能领取指定任务。
2. 用两个 Host 演示接管:A 领走后失联,租约到期 B 接手,**A 回来的写入被拒**,且拒绝理由是 `stale_lease`。
3. 同一 Host 在 run 重启后拿旧 `leaseId` 回传,被拒且理由是 `attempt_moved_on`。
4. Host 凭证 X 领不到属于 Host Y 的任务。
5. 断线重连后能找回原任务,不产生第二次副作用执行。

---

## 两项共同的规矩

- **只交付到 #11206,直接追加,不新拆 PR。**
- **不 rebase、不 force push**(仓库 bot 会标记)。推之前先 `git fetch`,基于当时最新 head 追加——从落后的 worktree 提交会静默回滚别人的改动。
- 不把 build、lint、typecheck、目录扫描或 CI 等待当作主线。
- 每段结束回报:branch/commit、改动、**实际观测值**、未通过项、下一步。没有过关证据就写未完成,不用百分比代替结果。
- 若发现上游语义有错,**先报回来再改**——那些模块有断言和变异验证支撑,改动前应该知道自己在推翻什么。
