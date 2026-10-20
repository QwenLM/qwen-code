# 「从未启动」派发的对账 arm（issue #13801 A3）

[English](2026-10-11-never-started-dispatch-reconcile.md) | [简体中文](2026-10-11-never-started-dispatch-reconcile.zh-CN.md)

状态：reload 对账已随 #13917 合入；回合内后台 Shell 取证（#13937）随本次改动落地。原设计 2026-10-11，作者 wenshao。
跟踪：#12380 阶段 H → #12827，#13532 验收运行的发现 **A3**。

范围：#13801 的 reload 对账与独立的 #13937 回合内后台 Shell 取证。A1 执行启用、跨 Session 楔死与 Monitor 行缺失取证继续不在这两条路径内。

## 问题陈述

一条后台派发已被认领的 `child_run` 记录会提交
`run.state: "running"` 与 `run.execution: "dispatch_started"`，而进程
可证明从未启动，并永远停在那里：

- 记录第 1 版（`admit`）与第 2 版（`dispatchStarted`）在 Broker execute
  调用**之前**提交（`hosted-workspace-tool-turn.ts` ——
  `commitAwaitRuntimeBatch` 检查点使派发即时持久化）。
- 若 daemon 在 `dispatchStarted` 提交之后、execute/settle 路径运行之前
  死亡，或回合内 catch arm（`hosted-workspace-tool-turn.ts` 中
  `close_not_started` 之上的 `proven` 门）拿不到它的证明，**没有
  任何 arm 再会结算这条记录**。其余所有 `settleFailed` 调用方都只在
  存活的回合内触发。
- 公开 tasks API 于是永远报 `running` / `provisioning`
  （`managed-extension-projection.ts`：`intent | dispatch_started →
provisioning`，`taskState → running`）。

R1 —— 缺失的 arm：重新加载时，一条执行已被认领、而进程可证明从未
存在（无 `:process` 账本行、无 cgroup 单元）的记录，必须结算为
`not_started_proven`，而不是停在 `dispatch_started`。
R2 —— 公开回答依构造跟随记录（投影是纯读取；`not_started_proven`
本已投影为终态）。
R3 —— 不放宽：含糊的结果必须保持阻塞，绝不被报为「从未启动」。

## 关键证据链（全部在当前 HEAD 核实）

1. **对一次 `is_background` 派发，只有先经过排除迟到准入的生命周期边界，
   再缺失 `:process` 行，才是「从未启动」的完整证明** —— reload 为对账路径提供
   该边界，存活回合则通过成功的取消屏障取得它。该行只为那一次执行入账，并按派发所属的 hold 家族
   入账（`is_background` 为 `ManagedHoldFamily.SHELL`，`is_monitor` 为
   `ManagedHoldFamily.MONITOR`；两者都经
   `RuntimeBrokerService.admitBackgroundProcess`，共用同一个键）。
   缺失读取不区分家族，因此它只是「正在被结算的那个家族」的
   从未启动证明。
   `RuntimeBrokerService` 在 execute 准入时、_早于_ `beginDispatch`，
   于同一个 `.thenApply` 块内入账 `:process` 账本行（键为
   `<executionCallId>:process`，JDBC 持久化，
   `RuntimeBrokerService.java` execute 路径）。因此准入严格先于派发：
   - 行**缺失** ⇒ execute 准入从未发生 ⇒ 派发从未开始 ⇒ worker 从未
     收到该调用 ⇒ cgroup 单元不可能存在。issue 二分证据中的
     cgroup 单元那一腿**已被行证据蕴含**，无需另行核查（harness 本来
     也看不到 worker 本地的单元）。
   - 行**存在** ⇒ 派发已开始 ⇒ 进程可能启动也可能没有：**含糊 ⇒
     保持原状** —— 其中有一个本 arm 有意不消费的确定性成员：Broker
     自己终态结算为 `executionStatus: 'not_started'` 的行，本身就是
     Runtime 持久的「从未启动」证明（它随客户端本已读取的同一次
     status 应答返回），把证明放宽到它是 B1 的后续工作。其余一切
     「行存在」状态都是含糊的 B1 家族（#13533），不在本片范围。
2. **404 的不对称性让证明天然保守。** Broker 的 `requireExecution`
   *先*按 `executionCallId` 在共享仓储中查行，行不在时抛出
   `runtime_execution_not_found`（404），早于一切 Session/binding
   身份校验。TS 客户端（`HostedWorkspaceBroker.status`）只把这个 404
   映射为 `undefined`（409 `runtime_broker_execution_unknown` →
   `{state:'unknown'}`；其余一律重抛）。因此 `status()` 回答
   `undefined` 是确定性的「该行可证明不存在」，与应答它的是哪个
   runtime-session 上下文无关。
3. **缺失的「未启动」读取不需要任何会话上下文。** `getExecution`
   先执行 `requireOwnedExecution` —— 在共享仓储中按
   `executionCallId` 持久查找 —— 早于一切会话生命周期检查
   （`requireReadySession`）。`:process` 行不存在时即使原 runtime
   Session 已 `RELEASED`（善意重取此时被永久拒于
   `runtime_session_not_acquirable` —— 那是 cancel/settle 类
   变更路径的事，与本证明无关），仍确定性回答
   `runtime_execution_not_found`（404）。行缺失与会话活力无关，
   该臂从不 acquire。
4. **runtime-session 身份经日志可持久恢复。** 每次后台派发都写有
   `tool.intent` 事件（`payload.executionCallId`、`payload.argsRef`）；
   publication 模式下 `argsRef` 资源是 `managed-tool-input` 路由 JSON，
   携带 `harnessSessionId` 与 `runtimeSessionId`
   （`hosted-runtime-recovery.ts` 的 `originalRuntimeBroker` 正是这样
   恢复 owner 的）。一条被搁死的记录因此能重建其执行被认领时所用的
   精确 Broker 身份。
5. **该结算转换在现行契约下完全合法。** `dispatch_started →
not_started_proven` 是许可的执行步，`running → failed` 是许可的
   run 步，`failed` + `not_started_proven` 是被证明的终态配对
   （`parseExtensionRun` 规则），`start_failed` 是许可的 child
   `stopReason`。回合内 arm 提交的正是这个 body。记录从不携带
   `startReceiptRef` —— 恰是 never-started 结算所要求的形态。

## 设计

### 新模块：会话开的对账扫描

`packages/cli/src/serve/hosted-never-started-reconcile.ts` 导出：

```text
reconcileNeverStartedChildRuns(input: {
  authority: LocalManagedSessionAuthority;
  resources: { read(ref): Promise<Buffer> };
  childRuns: HostedChildRunSession;
  brokerOptions: HostedWorkspaceBrokerOptions;
}): Promise<{ scanned: number; settled: string[]; skipped: string[] }>
```

算法：

1. 枚举 `authority.extensionRecordsInDomain('child_run')`；筛出解析后
   `run.execution === 'dispatch_started'` 的记录。
2. 对每个候选，从其 `tool.intent` 事件重建 runtime-session 身份：读取
   `payload.argsRef`；要求 `managed-tool-input` 路由、带
   `runtimeSessionId` 且 `harnessSessionId` 与本会话匹配；用
   `assertManagedSessionStableId` 校验。任何读不出 / 缺失 / 不匹配
   ⇒ **跳过**（无证明）。
3. 按 runtimeSessionId 分组。每组：
   `broker = new HostedWorkspaceBroker(brokerOptions, sessionKey,
runtimeSessionId)`。不 acquire：已释放的 runtime Session 会让强制
   重取永久被拒 `runtime_session_not_acquirable`，而确定性的
   「从未启动」读取不需要任何会话上下文（§3）。
4. 逐候选：`backgroundProcessStatus(<executionCallId>)` ——
   `:process` 账本键后缀由客户端（`HostedWorkspaceBroker`）持有，
   键的变化不会让本 arm 的取证漂移敞开：
   - `undefined`（404，确定性缺失）⇒
     `childRuns.settleFailed(shellId, { stopReason: 'start_failed',
started: false })` → 经 `commitExtensionRecord` 提交
     `state: failed`、`execution: not_started_proven`、
     `stopReason: start_failed`（同一事务内持久化，command id 幂等
     重放安全，已结算时按 deep-equal 跳过）。
   - 任何应答（含 `unknown`）或任何拒绝 ⇒ **跳过**。
5. 结算**提交**错误向上传播（会话自身写平面失败必须响亮可重试）；
   一切**取证**错误（路由读取、status）记入 `skipped`，绝不阻塞
   open —— Broker 暂不可达只是「未证明」，恰是 R3 安全的回答。
   搁死记录的诊断行带会话 id，并把每条跳过归因到独立原因 ——
   `no_identity`、`route_foreign`、`probe_rejected`（只带拒绝的
   HTTP status/code 字段，绝不带嵌有请求 URL 的错误消息文本）、
   `ambiguous_state` —— 永久性空洞（凭据错误）不再与瞬时不可达
   输出逐字节相同的行。

### 回合内后台失败取证（#13937）

tool-turn 的 catch 处理 publication 行尚未创建时失败的后台 Shell 预留。
保留 grant owner 的 `NOT_STARTED` 证明。close 请求失败或没有返回状态时，
后备路径先要求原 Broker 确认取消。Broker 在 Session 锁下持久化取消，并在
等待中的 publication 安装结束后重新检查，因此成功应答会阻止迟到的进程
入账与派发。随后才通过 `backgroundProcessStatus(executionCallId)` 查询同一原
Broker。任何明确状态都是反证，不得被后备查询覆盖。因此 publication 缺失时，
也必须先跨过取消屏障，再由独立进程账本返回确定性的 404，才允许结算。只有带类型的
`runtime_execution_not_found` 应答解析为行缺失，才允许在存活回合内执行
`settleFailed(..., { stopReason: 'start_failed', started: false })`。
行存在、unknown、身份不匹配或查询被拒绝时，记录继续未结算；publication
报错本身永远不是未启动证明。

当一个失败回合包含多个后台 Shell binding 时，每个 grant owner 返回的
`NOT_STARTED` 都会立即结算对应记录；剩余 grant owner 判定全部完成后，再并发
启动所有允许执行的进程账本探测。因此 Broker 静默无响应只消耗
一个 30 秒探测窗口，而不是每个 binding 各消耗一个窗口。reload 扫描器和
回合内恢复分支共用同一探测判定：只有账本行缺失才能证明 never-started；
账本行存在时报告 `ambiguous_state (<state>)`；查询被拒绝时报告
`probe_rejected (<safe detail>)`。诊断包含 execution id，可在不插入
rejection message 的前提下区分两个已知 Broker 契约错误与传输错误类型，
并记录每个由进程账本证明后成功结算的记录。

此后备取证仅适用于后台 Shell 请求。Monitor 派发会创建自己的 `:process`
行，但 `request.background` 会有意排除它们；其结算继续由 Monitor 专属的
grant 与远程证据路径负责。不增加 acquire、release、派发或协议字段。记录
已证明的 child 终态后，原 Turn 仍报告需要恢复；不宣称批次中的其它不确定
调用已完成。

回归用例先拒绝 reserve，再因 publication 缺失拒绝 `close_not_started`。
只有取消屏障成功且原进程明确不存在时才要求立即结算 child；取消失败、进程行
存在或 Broker 不可达时，保留拒绝结算行为。Broker 侧另有回归钉住：publication
安装延迟期间一旦持久化取消，安装随后完成也不得迟到派发。

### 挂点：hosted 会话 open

在 `registerHostedHarnessSessionRoutes` 的 open/load 处理里
（`hosted-harness-session.ts`），紧随 `childRuns`/`monitors` funnel
构建完成之后（记录已由 `openManagedSession` 回放完毕）：

```text
if (session.childRuns && brokerOptions)
  await reconcileNeverStartedChildRuns({
    authority: session.managed.authority,
    resources: session.managed.resources,
    childRuns: session.childRuns,
    brokerOptions,
  });
```

- 每次 fresh open 运行一次，先于任何路由消费该会话；扫描与注册之间
  不会有并发回合重新 attach。
- 无搁死记录时零成本（无候选 ⇒ 无 Broker 流量）。
- 可重入：扫描与结算之间若再崩，下一次 open 自愈（deep-equal 跳过 +
  幂等 command id）。

### 有意不做的事

- 不从 harness 核查 cgroup 单元（worker 本地，需 supervisor 接管 ——
  行证据已蕴含，见证据 §1）。
- 不做 `monitor_run` arm：monitor 记录在同一窗口搁浅，但 issue 的
  R1 只针对 `child_run`（monitor 的 `dispatchStarted` 连
  `state: 'admitted'` 都不变，是**少报**方向，属 #13377 的镜像 ——
  另一种症状，不在范围内）。Monitor 派发会在
  `ManagedHoldFamily.MONITOR` 下写入自己的 `:process` 行，但本设计不复用
  该缺失读取：monitor 记录、hold、停止证据与最终输出分别由专属生命周期
  负责。向那里扩展前，必须先定义 Monitor 专属的结算契约与见证。
- reload 扫描器不处理 #13801 R1 Gap A 的存活回合失败路径。该路径由
  上述 #13937 后备取证单独覆盖，保留同一原进程账本的行缺失证明。
- 不做周期扫描器：按 R1 只做 reload。open 时 Broker 不可达留下的洞，
  留到下一次 reload 自愈；严格好于今天（永远没有）。
- 探测后不 `release()`：release 会持久 `RELEASED` 并楔死该 runtime
  session 的后续红驱（既有恢复教训）。
- 不改记录契约、不改投影、不改 Java 侧：该转换各处早已合法
  （证据 §5）。

## 见证计划（arm 移除/合并即红）

单元层（`hosted-never-started-reconcile.test.ts`，本地 store 台架 +
stub 的 `HostedWorkspaceBroker` 模块）：

- **R1 结算**：搁死的 `dispatch_started` 记录 +
  `backgroundProcessStatus() → undefined` ⇒ 记录读作 `failed` +
  `not_started_proven` + `stopReason: start_failed`；**再重开**一次
  authority 断言相同（reload 可见）。断言 `broker.acquire` 从未被
  调用：确定性缺失读取本身不依赖会话活力（已释放的 runtime Session
  仍可由缺失的 `:process` 行证明从未启动）。
- **R2 依构造**：结算后 `authority.taskViews()` 显示终态任务
  （`state: failed`、无 runtime hold），而非 running/provisioning。
- **R3 含糊**：`status → {state:'executing'|'unknown'}` 或拒绝 ⇒
  记录不动（仍 `dispatch_started`，无 settle 提交）。
- **R3 无身份**：无 `tool.intent` 路由 / 会话不匹配 ⇒ 跳过。
- **R3 非搁死**：`running_attached` 记录连候选都不是。

- **跳过原因归因**：搁死记录的诊断行带会话 id 与每条记录的独立原因
  （`no_identity` / `route_foreign` / `probe_rejected` 只带拒绝的
  HTTP status/code 字段、绝不带其消息文本 / `ambiguous_state`）；
  见证 spy 住 stderr 写入器，原因退回裸 id 或拒绝文本泄漏入行即红。

契约层（`contracts/managed-child-run-record-v1.fixtures.json`）：

- 新增后继对，如 `dispatch-started-never-started-proven`：
  before = `admit-to-dispatch` 的 body，after =
  `{ stopReason: 'start_failed', run: {state: 'failed',
execution: 'not_started_proven'} }`，`valid: true` —— 由现有 TS 与
  Java 夹具套件自动回放（两种语言同时钉住 arm 所提交的转换）。
- 反向钉已存在于 run 级夹具（`failed-with-unknown-outcome` 合法、
  非阻塞 unknown 非法）；含糊家族由既有强制规则
  （`outcome_unknown|corrupt` ⇒ `recovery_blocked`）覆盖。

接线（`hosted-harness-session.test.ts`）：

- 带搁死记录的会话 load 会以构建好的会话调用该 reconcile（模块
  mock；**hook 被移除即红**），且 open 的应答被扣住直到 reconcile
  完成（**hook 丢掉 `await` 即红**）。

## 受影响文件

| 文件                                                                                    | 改动                     |
| --------------------------------------------------------------------------------------- | ------------------------ |
| `packages/cli/src/serve/hosted-never-started-reconcile.ts`                              | **新增**，arm 本体       |
| `packages/cli/src/serve/hosted-never-started-reconcile.test.ts`                         | **新增**，见证           |
| `packages/cli/src/serve/hosted-workspace-tool-turn.ts`                                  | 回合内后备取证           |
| `packages/cli/src/serve/hosted-workspace-tool-turn.test.ts`                             | 进程缺失与不确定结果见证 |
| `packages/cli/src/serve/hosted-harness-session.ts`                                      | open 时调用 arm（很小）  |
| `packages/cli/src/serve/hosted-harness-session.test.ts`                                 | 接线见证                 |
| `packages/core/src/managed-runtime/contracts/managed-child-run-record-v1.fixtures.json` | +1 组后继对              |
| `docs/design/2026-10-11-never-started-dispatch-reconcile(.zh-CN).md`                    | 本文档                   |

## 未决问题

- 已结算但未证明的 parked turn 自身的重放路径（如
  `finishBackground`/resumeAttached arms）以后是否应汇流到同一取证
  读、以去除重复逻辑？暂缓：open 扫描覆盖严格更大的记录集合；汇流
  可以在 B1 之后做。
- acquire 后永不 release 的 runtime session：保留租约与既有恢复行为
  一致；daemon/Broker 生命周期负责清理。只在 soak 中出现租约压力时
  再议。
