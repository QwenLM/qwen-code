# Managed 空闲挂起接线实施计划

[English](2026-11-18-managed-idle-suspension-wiring.md) | [简体中文](2026-11-18-managed-idle-suspension-wiring.zh-CN.md)

状态：挂起状态机已实现并验证；本计划把它接入 Hosted Harness 路由面。日期：2026-11-18。基线：分支 `feat/managed-agent-idle-suspension` 上的 `4bbd817657`（worktree `eager-ray-2ab2a7`，基于 `origin/main` `5fc5a98ecc`）。本计划实现[无状态 Hosted Harness 设计](../design/2026-11-16-managed-stateless-harness.zh-CN.md)的第一阶段；编码前先读该设计的「准入闸门与在飞工作」「挂起流程」「teardown 失败或结果未知」「close 路径审查」四节。阶段编号是本地计划标签。除注明外，所有行号锚点指 `5fc5a98ecc` 的 `packages/cli/src/serve/hosted-harness-session.ts`；模块提交不移动这些行号。

## 1. 已有基础

`packages/cli/src/serve/hosted-session-suspension.ts`（提交 `4bbd817657`，19/19 单测，ESLint/Prettier 干净）持有纯状态机：

- `SessionSuspension`：闸门 `open | closing | blocked`、`admittedWork` 计数、`teardownStarted` 闩、`lastActivity`、`idleTimer`、`teardownAttempts`。
- `suspensionRefusalCode`：closing 时 `hosted_session_closing`，blocked 时 `hosted_session_teardown_blocked`，open 时 undefined。
- `admitSuspensionWork` / `releaseSuspensionWork`：非 open 拒绝准入；释放下限为零。
- `armIdleSuspension` / `disarmIdleSuspension` / `recordSuspensionActivity`：≤10% 抖动，非 open 不 arm，定时器 unref。
- `beginSuspensionClose` / `revertSuspension` / `markSuspensionTeardown` / `escalateSuspension` / `clearSuspension`：仅第一次 teardown 调用前可回退；被放弃的可回退尝试记为活动；仅确认完成的 teardown 清除闸门。
- `runSuspensionAttempt(suspension, deps)`：待处理输入检查 → 同步 `markClosing(attemptStart)` → 有界等待 `admittedWork` → `liveWork` + 待处理输入复检 → 不可回退 teardown（退避+抖动、次数上限的精确重试）→ 成功 `removeResident` + 清除，上限处 `removeResident` + escalate。deps 注入；常量 `HOSTED_IDLE_SUSPEND_MS`（10 分钟）、`HOSTED_SUSPEND_WORK_WAIT_MS`（30 秒）、`HOSTED_SUSPEND_TEARDOWN_RETRY_CAP`（5）均为候选值，启用前测量。

闸门 registry 必须放在 `sessions` map 旁、按 Session id 键控，**不在 resident 对象上**：结果未知的 teardown 在 resident 移除后仍拒绝 load。

并行轨道（不在本计划范围）：WP1 Java/SDK 前置已提交在 worktree `managed-wp1-recovery` 的分支 `feat/managed-agent-recovery-prereqs`（`b5da254178` SDK 心跳失效通知、`f08a98b104` 等待分类 + churn 上限），叠在 PR #17521 上。端到端挂起→重开验收需要两条轨道；本计划的单元/集成测试不依赖 WP1。

## 2. W1 — Core：暴露续约停止

`packages/core/src/managed-runtime/managed-session-assembly.ts`：

1. `ManagedSession` 接口加 `stopRenewal(): Promise<void>`（`releaseActivation` 附近，~:191）。
2. 返回对象（~:322）实现：`stopRenewal: () => renewal.stop()`。`renewal.stop()` 闩住 stopped、清除 interval 并返回在飞续约 promise——在 authority 串行队列**之外** await 它是设计要求（续约本身跑在 `runSerial` 内，`managed-session-authority.ts:3865`）。
3. 不改 `close()` 语义：它仍是现有的非事务关闭（停续约、activation 释放失败也尝试 seal）。挂起自己编排各步骤。

扩展同目录 assembly 测试：`stopRenewal` 等待在飞续约、幂等、`close()` 行为不变。

完成标准：调用方能在不进串行队列的前提下停止续约并等待在飞的那次。

## 3. W2 — Monitor loop 存活判定

`packages/cli/src/serve/hosted-monitor-loop.ts`（类在 :100）：加 `get live(): boolean { return !this.ended; }`。`ended` 是存活旗标（`onLine`/`armWindow`/`armIdle`/`flush` 全检查它；`stop()` 在 :321 置位）。`monitorLoops` map 从不剪枝，资格必须测存活而非 map 大小。

加单测：已停止/parked 的 loop `live === false`，运行中的 `true`。

完成标准：资格能区分存活观察循环与已停止记录。

## 4. W3 — Registry、空闲时长、闸门、协调

在 `hosted-harness-session.ts`：

1. import 挂起模块。`registerHostedHarnessSessionRoutes`（:4574，现 `(app, contract, cwd, brokerOptions?)`）加可选第 5 参 `options?: { idleSuspendMs?: number }`（调用方：`server.ts:2642` 与测试——可选，无需改调用方）。空闲时长解析：`options?.idleSuspendMs` ?? `QWEN_E2E_IDLE_SUSPEND_MS` 环境变量（仅接受 `0 < 值 < HOSTED_IDLE_SUSPEND_MS`，与 :4604 的 `QWEN_E2E_DROP_LOAD_REPLY` 同模式；该变量只能调短、不能关闭）?? 常量。无受支持的配置项，不声明能力。
2. `const suspensions = new Map<string, SessionSuspension>()` 放 `sessions`（:4598）旁。助手：`suspensionFor(id)`（懒创建）、`noteActivity(id)`（仅 entry 存在且 gate open 时记录+rearm）、`armFor(id)`（arm，`onTimeout` 触发 `runSuspensionAttempt`，fire-and-forget 带 stderr catch 日志）。
3. **open() 闸门**：`sessionId` 算出后（~:5046）立即、先于任何 resident 复用（:5302）与写者获取：查 registry；refusal 码以 `409` 回答。覆盖 create、普通 load、被动 load、驱动式恢复、MCP-management load——load 路由（:8467）注册在 Session 中间件（:8476）之前，仅靠中间件挡不住。
4. **中间件闸门**（:8476，identity 检查后）：registry refusal 对所有方法含 GET 答 `409`（teardown 中的读答 closing；heartbeat 答 closing 直到 seal 落地、下一次 heartbeat 404 经 WP1 通知退休 SDK attachment）。私有 teardown 对账不是路由，不设闸门。
5. **drain 互斥**（各自一个同步段）：`releaseIdleOwner` busy 列表（:4730）加 `suspensions.get(sessionId)?.gate !== 'open'`；`markClosing`（W4）在 `session.ownershipRelease` 已设、`instance?.accepting === false`、`session.lifecycle` 已设或 `session.mcpClosing` 为 true 时拒绝。谁先标记谁赢，另一方拒绝。挂起绝不调用 `releaseIdleOwner`（仅 drain 用、释放 placement；第一阶段保留 placement）。
6. **arm 点**：每处 `sessions.set(sessionId, session)`（:6705、:7541、:8363）后调 `armFor(sessionId)`——load 完成赚一个完整常驻周期，含读取触发的 load。
7. **activity 点**：中间件 `authorizeOrdinary` 成功后（非 GET，`next()` 前）、Turn 结算处（grep `turn.settled` 写入点）、wake pump 通知回调——`noteActivity(sessionId)`。heartbeat（:13469）、status/events/transcript 读、activation 续约、被拒请求永不记活动。内部变更源（wake pump、reply planning）遵守同一闸门：启动工作前查 `suspensionRefusalCode`。

完成标准：被闸门的 Session 对每条普通路由与每条 load 路径以 registry 的码拒绝，drain 与挂起互相排斥，活动重置定时器。

## 5. W4 — 资格、标记、teardown

按 Session 接 `runSuspensionAttempt` deps：

1. **`pendingInputs`（异步）**：`pendingSessionInputs(authority.eventsInSequenceRange(1, committedSequence)).length > 0`（`hosted-wake-intake.ts:37`）——含未来 `notBefore` 的 wake 与 loop 输入。第一阶段只在零待处理输入时挂起。
2. **`liveWork`（同步）**——`releaseIdleOwner` busy 列表（:4730）按 Session 化、只计存活工作：`active`、`recoveredTurn`、`blocked`、`lifecycle`、`mcpBusy`、`hooksBusy`、`mcpRecovering`、`compressionBusy(session)`（:1096）、`fileHistoryOwed`、`hasHostedCleanupDebt(managed)`、`childConsumption.size`、`messageOperations?.size`、`unsettledInputs(session).size`（:2014）、`heldRuntimeTurns.size`、`automations?.hasPendingGateReleases`、`shell`/`backgroundLane` `monitorLoops` 任一元 `.live`、未结算 `child_run`/`monitor_run` extension records（`heldResources` :4615 的 reduce 写法）、`ownershipRelease`、`clientFiles !== undefined`（活跃注册）、MCP 配置的公开 Workspace Shell 档位且非 lifecycle protocol 2（`hosted_lifecycle_required` 排除，close :13874）。**不计**：`hooks`/`mcp`/publisher 存在性（teardown 对象，load 重新获取）、`runtimeLeaseHeld`（步骤 3 释放）。实例级项（`inFlightMutations`、`opening.size`、`initialReconciliations`）不是按 Session 的资格。
3. **`markClosing(attemptStart)`（同步段）**：`liveWork()`、`suspension.lastActivity > attemptStart` 或任一 W3.5 互斥条件成立时拒绝（`false`）；否则 `beginSuspensionClose(suspension)` 并置 `session.mcpClosing = true`。被条件阻塞的 Session 继续正常服务——不周期性返回 closing 拒绝。
4. **`teardown`**——步骤状态闭包，上限内重试从失败步续跑（仅精确重试）：
   1. `session.monitorWake?.close()`——关 wake 调度器但**不结算输入**。这是不可回退边界；`markSuspensionTeardown` 已在第一次调用前闩住。
   2. `await session.hooks?.close({ terminal: false })` 然后 `await session.mcp?.close({ terminal: false })`——与 detach 相同的非终态调用。
   3. `await releaseLeaseNow(session, false)`（:10844；先结清欠下的文件历史标记；返回 `true`=unproven/deferred → throw）然后 `await retryHostedCleanup(session, brokerOptions, true)`（:2741；无 `brokerOptions` 时 `hasHostedCleanupDebt` → throw）。仍有剩余或结果未知保持闸门关闭。
   4. `await session.shell?.publisher?.close()` 与 `await session.backgroundLane?.publisher?.close()`——无存活循环（资格），无物等待其结算，下次 load 重建。
   5. `await managed.stopRenewal()`（W1，串行队列外）→ `await managed.releaseActivation()` → `await managed.authority.close()`（memoized seal；重试对账**同一次** seal）。暴露每步结果；seal 成功但 activation 释放未确认仍是恢复工作，不是干净挂起。
   6. 全部步骤确认后：`await session.stores!.stopLocal()`、停 `session.streams`。seal 仍需对账时绝不 `stopLocal()`——它也 fence 那些请求（`http-managed-session-store.ts:2957/:3516`）。
      相对 detach 跳过（资格已排除或设计禁止）：held-Runtime drain、client-files close、待处理输入取消、automation run 对账、SessionEnd/SessionDelete Hook、普通执行授权（挂起不启动工作；seal 受写者 fencing 保护）。
5. **`removeResident`**：`sessions.delete(id)` + `unresolvedOpenings.delete(id)`。成功时驱动器清除闸门——同时 `suspensions.delete(id)` 让下一请求冷打开。blocked 时**保留** registry entry（闸门+证据比 resident 活得久）；后续 load 遇 `hosted_session_teardown_blocked`，直到运维/lifecycle 在已有 authority 下对账。
6. **`rearm`**：`armFor(id)`。

完成标准：空闲合格 Session 端到端挂起并冷重开；每种 teardown 失败模式都以正确的码保持闸门关闭。

## 6. W5 — 集成测试

新建 `hosted-session-suspension.integration.test.ts`，夹具仿 `hosted-harness-session.test.ts`（注册路由时传短 `idleSuspendMs`）：

1. 空闲 Session 到点挂起；后续 load 冷打开（写者重取、MCP/Hook 重连、placement 保留）。
2. 已准入 prompt 重置定时器；Turn 结算后 Session 保持常驻一个完整周期。
3. 待处理输入——含未来 `notBefore` 的 loop 输入——保持常驻（无 closing 拒绝）。
4. 存活 monitor loop 保持常驻；已停止 loop 不阻止。
5. teardown 期间请求答 `409 hosted_session_closing`；load 包括在内。
6. seal 故障注入：teardown 退避重试，上限处 escalate 为 `hosted_session_teardown_blocked`；闸门跨 resident 移除保留并拒绝下一次 load；对账前未调用 `stopLocal`。
7. drain 与挂起双向互斥（drain 先标记阻止 mark；挂起先标记阻止 `releaseIdleOwner`）。
8. 待处理输入读取与标记之间到达的活动经 `lastActivity > attemptStart` 回退。
9. 有界等待超时后的回退 rearm 并记活动。

设计 close 审查表中挂起区别对待的每一行（输入永不取消、非终态 MCP/Hook、无 client-files close、仅确认 teardown 后移除注册）都用测试固定。

## 7. 验证与自审

- `cd packages/cli && npx vitest run src/serve/hosted-session-suspension.test.ts src/serve/hosted-session-suspension.integration.test.ts`，加 core assembly 与 monitor-loop 同目录测试。
- `packages/cli` 内 `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --build`（默认堆 OOM；用项目引用，不用独立 `--noEmit`）。
- `packages/cli`（W1 含 `packages/core`）内 `npx eslint <改动文件>` 与 `npx prettier --check <改动文件>`。
- 全量 `hosted-harness-session.test.ts` 与 Hosted/MySQL CI 层级归 CI；本地预算保持聚焦。真实进程挂起→重开验收在 WP1 落地后跑（协调升级，无配置开关）。
- 按 AGENTS.md 自审：开放式「假设有错」通读全 diff；连续两轮干净才停；修复重置计数。核实每个绿测试断言的是对的东西。
- 仓库规则：ESM、无 `any`、core 从定义模块 import、测试同目录、注释只写非显而易见的 why。活跃 PR 不 force-push；本分支在 feature 完整前保持本地。

## 8. 边界

- 挂起无配置开关或能力声明；仅测试环境变量可调短周期。
- 不改 schema 或 Store 协议；保留 placement；用现有 seal 协议加上述闸门规则。
- 不取消输入、不复用 `releaseIdleOwner`、不把 `managed.close()` 当挂起事务、seal 对账前不 `stopLocal()`。
- 冷打开准入上限（候选 8 → `hosted_session_open_busy`）与可观测性计数器是接线后的下一切片；WP1-C/D（wake 缓存失效、无回执恢复证明）留在 Java 轨道。
- 启用门槛（测量、真实进程故障验收、设计待解决问题 8）不在本计划内；它们先于 feature 的任何发布。
