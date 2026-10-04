# Hosted Turn failover E2E 与 Harness 轮次接管（G1）

[English](2026-09-30-hosted-turn-failover-e2e.md) | [简体中文](2026-09-30-hosted-turn-failover-e2e.zh-CN.md)

状态：已提议。实现 #12952 的 G1 切片（属于 #12380），前置 G0（#12955）已合入。

## 问题与范围

`scripts/run-managed-agent-server-e2e.ts` 的 `--inflight-failover` 与
`--continuation-failover` 仍以一个已过期理由的 `not-yet-enabled` 抛出退出。G0 打开了
Workspace 绑定文件工具会话的公开准入，但在打包栈上实际运行暴露出更深的缺口：
**Hosted Harness 没有轮次接管**。Java 协调器与 SDK 已带完整的恢复契约 —— load 响应的
`_meta.qwen.daemon.managedRuntimeRecovery`、`POST /session/:id/managed-runtime/continue`
与 `/cancel` 路由、按 epoch 的输出回退 —— 而 TypeScript Harness 对带未结算输入的会话一律
拒绝加载（`hosted_turn_recovery_required`），该契约一项都没有实现。

因此 G1 交付：

1. **Harness 侧轮次接管。** 替换 Harness 能加载停在 `await_runtime` / `results_ready`
   checkpoint 的会话，不重放地对账并结算其 Runtime 执行，上报恢复快照，并应协调器请求
   续跑该轮次。
2. **持久的流式文本。** 模型流式输出期间，assistant 文本以 activation 作用域的 delta 事件
   提交进 journal，使已发布的前缀在写者死亡后存活，并由现有 epoch 机制把死亡 owner 的
   前缀从公开投影中回退。
3. **准入使能。** 打包后的服务器获得一个显式 opt-in
   （`qwen.managed-agent.trusted-actor-header`，默认为空），充当可信网关的
   `AuthenticatedTenantActor` 替身，让 E2E 能经公开路由创建 Workspace 绑定会话。在不可信
   客户端可达的部署上绝不能开启。
4. **解禁与 CI。** 两个模式移除过期门禁、改用 `write_file`（公开准入的 profile）驱动物理
   工具、接入 Hosted MySQL CI 任务，README 改为如实描述。

不在范围内：公开 Shell profile 选择、G2 接管对账扫描、G3 取消 owner 粘性、多 Runtime
接管。取消接管为契约完整性而实现，但没有对应 E2E 模式。

## 当前状态

- runner 已包含完整的 in-flight/continuation 场景（扣住 Broker `:start` 的代理、假模型、
  杀进程、删 home、审计断言）；它们自 #12801 起被门禁，从未通过。
- core 已有 `ManagedSessionJournalStore` 写者围栏、`await_runtime` checkpoint 与
  `resolveAwaitRuntime`；`--session-failover` 持久 owner 证明可通过。
- Java 侧：`HostedHarnessClient` 解析恢复 `_meta` 并调用 continue/cancel；
  `HarnessCoordinator` 回退死亡 owner 的公开 delta、绑定替换 Harness 代数并记录恢复准入。
- 缺失（TS）：load 恢复快照、continue/cancel 路由、对挂起执行的恰好一次重派发、轮次中
  的持久文本 delta。
- 缺失（打包服务器）：没有任何注入 actor principal 的途径，公开 Workspace 创建在 JVM 内
  测试之外一律 401。

## 决策

- **load 上报或完成挂起的 Runtime 工作，绝不重放模型 Prompt。** 对带未结算输入、checkpoint
  可运行（`await_runtime` 或 `results_ready`）且带 Workspace 工具 profile 的会话，Harness
  按原 `executionCallId` 逐个向 Broker 解决在途执行。continuation load 经 `execute` 重派发
  每个挂起执行 —— Broker 的持久记录保证恰好一次 —— 提交工具结果并在应答前把 checkpoint
  推进到 `results_ready`。passive load（协调器的取消路径）先接管已 dead 的 owner
  留下的 Runtime Session —— acquire 不派发任何东西 —— 然后读取执行状态并上报
  `known`/`unknown`。load 持有该接管、自身从不释放：成功时由终结的 cancel
  路由交还租约；失败时留作欠账——因为一次 release 会持久化为 RELEASED，而搁浅的
  READY 身份仍然可用：重驱动的 cancel 会按当前 checkpoint 被重新接纳（daemon
  不会对已 attach 的会话重新 load），owner 变更后的接管则幂等重 acquire。
  在已接管、但会话尚未注册成功就被拒绝的 load 上，欠账的接管会被按身份记录并报告——
  因为不存在可供退役的已注册会话；该记录在下一次成功加载同一会话时清除，其余情形仍只有
  会话退休才会清偿一次遗弃。Broker 无法交代的执行上报 `unknown`，协调器把该轮次阻塞为
  `managed_runtime_recovery_blocked`，什么都不重放。
- **continue 从 `results_ready` 起跑模型；cancel 不做新工作直接结算。**
  `managed-runtime/continue` 校验 prompt、checkpoint 与 activation 身份，以 200 回执准入
  continuation，随后用 journaled 工具结果重发模型请求并跑正常的可带工具循环直至终态记录。
  `managed-runtime/cancel` 尽力取消挂起执行并把轮次结算为 cancelled。两者对身份不匹配一律
  409。
- **assistant 文本以新的 `message.delta` journal 事件流式提交。** 该类型进入封闭的 v1 集合，
  actor 为 `harness`、带 activation subject，被围栏的前 owner 无法追加。delta 携带最终消息的
  预分配 `messageId`；已有 delta 投影的 `message.committed` 记录不再二次投影 chunk，从零开始
  的投影保持精确。每个模型 chunk 立即提交 —— 已发布前缀必须在流仍打开时就持久 —— 只在
  journal 文本上限处拆分。
- **Runtime 接管依赖 W0e 的回收能力，所以这两个模式今天只能在 Linux 上跑。** 替代 owner 必须
  先退掉死亡 worker 的 Runtime 绑定，才能重驱动挂起的执行。该回收只存在于 durable
  local-process provisioner，其可信宿主身份只在 Linux 上可用。runner 对这两个模式开启
  `durable-local-process`、把 state 目录建成属主私有，并在其他平台上以明确报错拒绝并指向
  Hosted MySQL CI 任务。这正是 #12766 已记录的边界；G1 不改变它。
- **E2E 把 Workspace 准入当部署数据种子化**（registry 行、access 授权、Broker mount），并在
  两个 Spring owner 上都开启 `harness.workspace-files-enabled` 与可信 actor 头。物理副作用是
  固定的 `write_file`；恰好一次断言由持久执行记录、dispatch generation 与模型请求次数承载，
  而不是文件字节。`--session-failover` 仍创建非绑定 Session，但这套准入接线不再按模式
  门控：每个模式的 owner 都携带它(#13258)，其配置与其他模式一致。
- **两个模式并入 `hosted-harness-mysql` 任务**，该任务安装 runner 私有 `mysqld` 所需的
  MySQL 二进制。

## 改动与归属

| 层           | 改动                                                                  | 范围                      |
| ------------ | --------------------------------------------------------------------- | ------------------------- |
| core journal | `message.delta` 事件类型（schema、harness actor、activation subject） | Managed Session 日志      |
| CLI Harness  | load 恢复快照与结算；continue/cancel 路由；delta 流式提交             | Hosted Harness 会话       |
| CLI Broker   | 供 passive 上报的 acquire + `status` 读取 + release                   | Workspace Broker          |
| Java API     | `TrustedActorHeaderFilter` 与属性，默认关闭                           | 部署 opt-in               |
| E2E runner   | 解禁；Workspace 种子、mount 与 actor 接线；`write_file` 副作用        | 本地与 CI 验证            |
| CI workflow  | MySQL 二进制 + 两个 failover 模式进 `hosted-harness-mysql`            | Hosted MySQL 任务         |
| README       | 模式可运行；属性风险说明                                              | Managed Agent Server 文档 |

## 验证与验收

单元测试：delta 事件 schema 往返；恢复 meta 形态与拒绝路径；continue/cancel 身份与相位
门禁；actor 过滤器。G0 Hosted 集成测试与 Hosted MySQL 套件保持通过。

E2E 退出检查即 issue 原文：

- **in-flight：** 第一个 Broker `:start` 在持久 `await_runtime` checkpoint 之后被扣住；两棵
  进程树被杀、home 被删；替代方复用原 `executionCallId`、物理工具恰好执行一次、不重放地续接
  Prompt（一次初始 + 一次 continuation 模型请求），并提交一个终态事件。
- **continuation：** Harness 在第一段公开文本后被杀；工具在此之前恰好执行一次并结算；替代方
  再发一次 continuation；公开记录只保留替代方的回答（被回退的前缀为空）；轮次只有一个终态
  事件。

删掉任一断言都必须让对应模式失败。`--session-failover` 与真实模型检查作为回归重跑。完成前
先过 build、typecheck、bundle、针对性测试与两轮干净的 diff 审计。

## 边界与待定问题

G1 归属 #12952。issue 的切片文本曾假定接管机器已存在；本设计记录了 Harness 一半才是工作量
主体。delta 流式化日后是否扩展到无工具 Hosted 轮次、多 Runtime 恢复如何与 G2 扫描组合，保持
开放。trusted-actor 属性是本地/E2E 替身；未来接入真实网关时替换它即可，准入逻辑不受影响。

维护者真实环境验证留下的已知后续项：

- 接管 load 的应答丢失后轮次卡死：Harness 已挂载会话，之后的 load 一律 409
  `hosted_session_already_attached`，恢复快照再也取不回来。接管 load 需要做成幂等。注意该
  load 正常最长可跑 120 秒，而协调器 `request-timeout` 默认 30 秒。
- 含 `message.delta` 事件的 journal 无法被旧版本 Harness 打开。发布版 0.24.7 的拒绝形态是
  fail-closed 的 `POST /session/:id/load` 应答：503 加
  `{"error":"managed_session_open_failed","code":"managed_session_open_failed"}` —— 比
  journal 读取器自身的报错面早一层，且在混合机群期间由协调器持续重试。自 #13320 起，Java
  客户端透出拒绝码（`HarnessSessionRefusedException`），协调器在重试日志与准入前重试预算耗尽
  后的终态失败里都记录该码，滚动发布手册由此能把「journal 比读取方新」与「Harness 真不可用」
  区分开。本构建的读取方没问题，但回滚或滚动发布期间的混合机群不行。启用 Hosted Workspace
  轮次前请先升级机群，或对回滚做门控。
- 首个流式分片之后才到达的模型回退或重试会让轮次终态失败（`Hosted Harness cannot retract a
published model attempt.`）：`message.delta` 一旦落盘，部分尝试就已公开、无法撤回，轮次只能以
  `error` 结算，而不是像流式化之前那样丢弃该次尝试并重试。因此一次瞬时的 provider 容量事件会
  在流中途永久失败该轮次，而不会由协调器重试（`turn_result` 是终态）。把这类结算归类为协调器
  可重试是后续项。（其后由 #13319 改为带内撤回：发布后到达的重试改为全新 replay，Harness 落账
  `message.retracted`，server 按源序号范围置空该消息的 delta 并发布 `stream.reconciled`——见
  [2026-10-04-managed-midstream-retry-retraction](2026-10-04-managed-midstream-retry-retraction.zh-CN.md)。）
