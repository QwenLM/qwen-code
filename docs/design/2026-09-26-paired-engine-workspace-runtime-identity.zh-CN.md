# 双引擎工作区 runtime 身份

[English](./2026-09-26-paired-engine-workspace-runtime-identity.md) | [简体中文](./2026-09-26-paired-engine-workspace-runtime-identity.zh-CN.md)

## 状态

#12737 B2b 切片的第一部分，属于 #12380 的 Stage B 宿主接入，基于上游
`8629086ae2`。本设计给出 [ACP Bridge 执行引擎](./acp-bridge-execution-engines.zh-CN.md)
中所记工作区契约门槛里的两项：区分整体存活与工作区控制就绪；由通道持有的 epoch
及停止代际策略，其中包括覆盖多个存活通道的停止回执。第三项门槛，即把影响会话的
工作区变更下发到所有存活引擎，并采用 #12737 中 Q2 已决定的确认与权限围栏语义，是
B2b 的第二部分，另行提交。本改动之后，普通 daemon、Channels 和嵌入式构造都仍不传
`executionEngines`。

## 问题与现状

双引擎 Bridge 为每个引擎持有一个通道，但有三项工作区级契约仍把 runtime 当作单一
通道。

- **存活。** `isChannelLive()` 和生命周期快照统计任意引擎，而工作区控制（工作区
  状态与命令、MCP、Skills、预热）只由 Legacy 通道提供。只有 Managed 通道存活时，
  工作区 runtime coordinator 会跳过启动 Legacy，把 Skills 准备记为失败，错误为
  `No session with id "workspace-command:qwen/control/workspace/skills/refresh"`；
  工作区服务还会把失败的 Legacy 预热报告为就绪。
- **Epoch。** 每次启动通道都会从共享分配器取得新 epoch，但 Bridge 用同一个
  harness 级数值（最近一次分配的值）同时充当工作区控制 runtime、停止目标和空闲
  候选的 epoch。因此启动 Managed 通道会给 Legacy runtime 重新打戳：未变化的 Legacy
  MCP 与 Skills 准备被判为过期，MCP 准备在轮询中途中止，Managed 启动之前取得的停止
  确认会被拒绝。反过来，Legacy 退出而 Managed 仍存活时，打着最新 epoch 的能力仍显示
  就绪。
- **停止。** 停止快照和回执只指向一个通道，所以有两个存活通道的 runtime 无法停止
  （`multiple_engine_channels`）。

## 范围

范围内：

- 每个通道保存自己的 epoch，报告时使用所描述通道的 epoch。
- 在整体生命周期之外增加工作区控制生命周期和工作区控制存活检查，供 coordinator
  和工作区服务使用。
- 覆盖所有存活通道的停止快照与回执，以及停止确认的代际策略。
- #12698 推迟到这一领域的测试覆盖：workspace generation 的外来连接防护，以及多通道
  停止阻断的解除。

范围外：影响会话的工作区变更下发及其确认（B2b 第二部分）；按引擎汇总资源、语言
下发、Managed 预热/保活与隔离恢复（B2c）；宿主接线（B2d）。工作区控制仍走 Legacy。
不新增路由。公开层面的变化是停止预览与回执中新增的 `channels` 字段，以及下文所述
双引擎 runtime 下 runtime 状态字段的含义。

## 方案设计

### 由通道持有的 epoch

共享、单调的 epoch 来源保持不变。通道握手完成时，为它分配的 epoch 保存在该通道上
（`HarnessChannel.runtimeEpoch`），每项报告都使用其所描述通道的 epoch：

- 工作区状态戳（`workspaceSkills`、`workspaceMcp`、MCP tools 与 resources）使用
  工作区控制通道的 epoch；
- 空闲通道候选使用自身通道的 epoch；
- 生命周期快照的 `runtimeEpoch` 在工作区控制通道存活时取该通道的 epoch，否则取
  来源的当前值。

harness 保留最近一次分配的值，用来发现 epoch 来源回退，并像以前一样在没有存活通道
时作为停止快照的 epoch。启动或停止 Managed 通道不会改变 Legacy 的 epoch 及其 MCP 与
Skills 准备状态。Legacy 退出后工作区控制不再存活，即使 Managed 仍存活，其能力也会被判
为过期；下一个 Legacy 通道会获得新的 epoch。

单工厂 Bridge 上唯一的存活通道总是最新的通道，因此所有报告值都不变。

### 整体存活与工作区控制就绪

工作区控制通道在双引擎 Bridge 上是 Legacy 通道，其他情况下是唯一的通道。Bridge
同时报告两种视图：

| 信号                                                                                                               | 范围                 |
| ------------------------------------------------------------------------------------------------------------------ | -------------------- |
| `isChannelLive()`、daemon 状态 `channelLive`、生命周期 `state`、`runtimeLive` 与 `activeWork`                      | 所有引擎通道（不变） |
| `isWorkspaceControlLive()`、生命周期 `workspaceControl`（`cold`、`starting`、`live`、`stopping`）与 `runtimeEpoch` | 仅工作区控制通道     |

双引擎 Bridge 报告 `workspaceControl`：Legacy 通道存活时为 `live`；runtime 停止
进行中或该通道正在退出时为 `stopping`；其启动进行中时为 `starting`；其余情况为
`cold`。只有一个通道的 Bridge 不报告该字段，因为整体字段已经描述了这个通道，所以其
生命周期快照保持不变。`isWorkspaceControlLive()` 在 Bridge 接口中是可选的；没有它的
Bridge 只有一个通道。

各消费方按需选用视图：

- 工作区 runtime coordinator 的所有判断都通过工作区控制视图读取生命周期：是否预热，
  调和是否需要等待或在启动后重试，能力是否过期。只有其活动检查仍取整体值。
- 因此公开的工作区 runtime 状态中，`runtimeLive` 与 `runtimeEpoch` 描述拥有这些能力
  的通道；该通道未存活时，`state` 报告它的 `cold`、`starting` 或 `stopping`；
  `active` 与 `idle` 仍统计所有引擎上的工作。把能力的 epoch 与 runtime epoch 比对的
  客户端，在另一引擎存活时仍能正常工作。
- 工作区服务的预热结果、变更后的刷新以及 `acpChannelLive` 字段检查工作区控制存活。
  四处构造（primary、secondary、dynamic 以及 `createServeApp` 默认 Bridge）都这样
  接线，因此存活的 Managed 通道不能让失败的 Legacy 预热看起来成功。
- daemon 状态、健康检查和容量统计仍使用整体存活。

### 停止所有存活通道

停止快照以 `channels: [{ channelId, runtimeEpoch, executionEngine? }]` 列出所有
存活通道，工作区控制通道排在最前。阻断原因对所有通道统一计算，并移除
`multiple_engine_channels`。顶层 `channelId` 为列出的第一个通道，`runtimeEpoch`
为所列通道中最新的 epoch；没有存活通道时取最近一次分配的 epoch（此时停止被
`not_live` 阻断）。

停止令牌、`channelId`、`runtimeEpoch` 和完整的会话集合都不变时，确认保持有效。
epoch 来自同一个单调来源，所以预览之后启动的通道一定会抬高最新 epoch，使确认失效；
工作区控制通道被替换时 `channelId` 也会改变。因此停止绝不会触及预览中没有的通道或
会话。预览之后退出、且自身没有会话的通道可能不会使确认失效，此时停止要做的事更少。
请求格式不变。

停止先在各会话自己的通道上关闭每个已确认的会话，再停止每个列出的通道，并等待每个
子进程的 registry 释放。回执带有快照中的 `channelId`、`runtimeEpoch` 与
`channels`；全部释放后才报告 `released`，所有通道都已停止并释放后才报告 `stopped`。
停止期间因列出的通道退出而被拆除的会话，以 `cause: "workspace_runtime_stop"` 报告。
若会话关闭失败时有列出的通道正在退出或已经退出，回执会等待这些通道释放，报告仍然
存活的会话，并把已尝试关闭的会话以及所有已不存在的会话计为被中断。存活通道上停止尚未
处理到的会话保持存活，既不计为被中断，也不计为已关闭。停止进行期间 idle 计时器被取消；
停止结束时，每个未被停止的列出通道都回到 idle 策略，因此会话已全部关闭的存活通道会照常
被回收。

## 文件与消费方

| 领域               | 文件                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Bridge             | `channel-lifecycle.ts`、`channel-startup.ts`、`session-control-plane.ts`、`bridgeTypes.ts`                                 |
| Coordinator 与接线 | `serve/workspace-runtime-coordinator.ts`、`serve/run-qwen-serve.ts`、`serve/server.ts`、`serve/workspace-service/types.ts` |
| 客户端             | SDK daemon 停止类型、Web Shell 阻断原因文案、`docs/developers/qwen-serve-protocol.md`                                      |

不新增路由。`GET /workspaces/runtime-stop-options` 仍为进程全局范围，
`POST /workspaces/:workspace/runtime/stop` 仍只作用于所选 runtime；两者都新增
`channels`。`/workspace/runtime/status`、`/workspace/runtime/ensure` 和
`/workspace/acp/*` 仍只属于 primary runtime，其 `/workspaces/:workspace/...` 形式
仍只作用于所选 runtime。都不会回退到 primary runtime。

## 验证与验收标准

1. 启动和停止 Managed 通道不改变工作区控制 epoch、工作区状态戳以及已准备好的
   Legacy MCP/Skills。Managed 存活时 Legacy 退出会使它们过期，下一个 Legacy 通道获得
   新 epoch。在 Bridge 上覆盖，并通过真实 serve 应用（注入双引擎 Bridge）的工作区
   runtime 路由覆盖。
2. 只有 Managed 存活时，coordinator 推迟调和，并在准备能力之前预热 Legacy；
   `/workspace/acp/status` 报告没有存活的 ACP 通道，失败的 Legacy 预热不被报告为就绪。
   四处构造的工作区服务都使用工作区控制存活。
3. 空闲候选带有自身通道的 epoch。
4. 双引擎停止列出两个通道，关闭两个引擎上的会话，停止两个子进程，并且在两者都释放
   之后才报告 `stopped` 与 `released`；在此期间工作区控制报告 `stopping`，与 Legacy
   通道正在退出时相同。预览之后启动的通道会使确认失效，即使会话集合不变。因通道退出
   导致关闭失败时，存活通道上停止尚未处理到的会话保持存活，不计为被中断，而在回执
   确定之前退出的会话计为被中断。未完成的停止会让没有会话的存活通道回到 idle 策略。
5. workspace generation 流忽略来自另一引擎连接的事件（#12698 推迟的覆盖）。
6. 现有单工厂 Bridge 的生命周期、状态与停止测试不经修改全部通过；CLI 停止路由的
   一个替身仅补上了其类型现在要求的 `channels` 字段。每条新测试在对应行为被撤回时都会
   失败。

## 风险与待解问题

- 双引擎 runtime 只有 Managed 会话时，公开 runtime 状态在这些会话运行期间报告
  `runtimeLive: false`。B2d 之前没有宿主接入双引擎模式。
- 预览之后，没有会话的通道退出可能不会使确认失效。这不会扩大停止范围，但此时回执
  列出的通道会比预览少。
- 影响会话的变更下发仍待完成（B2b 第二部分）。资源汇总、语言下发、Managed 预热/保活
  与隔离恢复见[双引擎按引擎的运维行为](./2026-09-26-paired-engine-per-engine-operations.zh-CN.md)
  （B2c）。
