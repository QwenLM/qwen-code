# Managed channel 投递作为任务及其取消（#13746 F3）

[English](2026-10-17-managed-delivery-task-cancel.md) | [简体中文](2026-10-17-managed-delivery-task-cancel.zh-CN.md)

状态：已在本变更中实现。channel 投递投影为其路由 Session 的一个任务（kind `channel_delivery`），并且在尚无适配器认领它时，公开任务取消可以服务它。契约在 `1.57.0` 中点名该 kind。没有新路由、新操作类型或新失败码。本变更建立在已合入的 [H4f-c](2026-10-17-managed-h3-task-cancel.zh-CN.md) 之上，与它共用可取消类型规则与投递分支。

这是 [#13746](https://github.com/QwenLM/qwen-code/issues/13746) 的 F3，即「H5 的那一半」：一条取消路径同时服务 child 任务与 channel 投递，两者都不另长词汇。它属于 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 的阶段 H，在 [#12827](https://github.com/QwenLM/qwen-code/issues/12827) 下跟踪。它替代 [H4f 文档](2026-10-10-managed-task-cancel.zh-CN.md)的决策 10：那条决策把投递留在任务模型之外，并把它的取消留给 H5 的公开变更路由。issue 自己的表述已经回答了这个问题：channel 投递就是带投递行的任务。

## 问题

channel 的回复在适配器拉取之前，以 `planned` 投递的形式留在 outbox 里。看到这条回复、认为它不该发出的调用者没有任何办法阻止它：

- 公开 channel 路由只读；
- 它们读的是投递台账，而台账只有在适配器认领投递后才有行，所以 planned 的投递甚至不可见；
- Hosted 的 `cancel_delivery` 动词存在，但除故障门禁外没有任何调用方。

## 现状

核对于叠在 `b4614845f0` 上的 H4f-c（契约 `1.54.0`）：

- **记录。**
  - `channel_delivery` 是路由 Session 的一条记录。它带有一条投递行（`planned` → `sending` → `partial`、`delivered`、`unknown`、`rejected` 或 `cancelled`），以及一个只设一次的 `cancelRequested` 标志。
  - `cancelled` 需要该标志且零回执，所以只有 planned 的投递能以 cancelled 结束（`ManagedChannelRecords.java:178`）。
  - 该记录不投影任务（`ManagedExtensionProjection.java:62` 及其 TS 镜像）。
- **Hosted 动词。**
  - `/session/:id/channels/operations` 上的 `cancel_delivery` 在一次修订中把 planned 投递连同标志结算为 `cancelled`。
  - 对已被适配器认领的投递，它只记录标志，发送照常进行。
  - 对终态投递原样应答（`hosted-channel-session.ts:707`）。
  - 它唯一的调用方是 FG7d 故障门禁。
- **认领。** 适配器的拉取发现 `planned` 与 `partial` 记录（`ChannelInstanceStore.java:263`、`:296`）。已取消的投递永远不会被认领。
- **公开读取。** 投递列表与详情读台账；planned 投递回 `404 delivery_not_found`（`ManagedChannelService.java:502`）。
- **任务路径。**
  - 对 Session 中每条投影任务的记录，都提供任务列表、详情、事件与取消。
  - 记录行在首次插入时获得 `task_kind`，之后的修订只更新投影出的状态（`ManagedExtensionRecordStore.java:1350`、`:1383`）。

## 决策

1. **投递投影为其路由 Session 的一个任务。**
   - `channel_delivery` 记录体的任务 kind 变为 `channel_delivery`，两种语言与共享投影 fixtures 同步，契约的 `TaskKind` 增加该值。
   - 状态与其他类型一样跟随 run 块：

     | 投递行                          | run         | 任务状态    |
     | ------------------------------- | ----------- | ----------- |
     | `planned`                       | `admitted`  | `pending`   |
     | `sending`、`partial`            | `running`   | `running`   |
     | `unknown`（及其后的 `partial`） | `waiting`   | `waiting`   |
     | `delivered`                     | `settled`   | `completed` |
     | `rejected`                      | `failed`    | `failed`    |
     | `cancelled`                     | `cancelled` | `cancelled` |

   - run 没有 execution，所以任务不带 `runtime_state`，也没有 Artifact 引用。
   - 视图的每次变化都记入 H3 的每任务事件日志，与所有类型相同。
   - 能看到该任务的恰好是路由 Session 的读者，而路由 Session 属于该 channel 的 Workspace。这与 channel 读取所准入的集合相同。

2. **本变更之前写入的行保持非任务。** 行的 kind 在插入时确定，之后的每次修订都遵循该行存储的 kind，而不是其记录体现在会投影的 kind：升级前已 planned 的投递在之后任何修订上都不写任务状态、不记任务事件，永远不会投影任务。不做回填：等到有人能对它操作时，这样的投递已经过了可取消的窗口，而且它一旦被认领，channel 读取仍能看到它。

3. **只在投递为 `pending` 时准入取消。**
   - `taskActions` 为 `channel_delivery` 设一条自己的状态规则：只对处于活跃 Session 中、`pending`（planned、未被认领）的投递公布 `cancel` 并准入新的取消。
   - 已认领的投递正在发往提供方：其视图不公布任何动作，新的取消回 `409 task_action_unavailable`。
   - 其余都是未改动的 H4f 路径：A6 准入顺序、Workspace OPERATOR 规则、重放以及「每个 Session 只有一个 open 操作」规则。

4. **投递分支与 verdict 复用任务取消。**
   - `TaskCancelCoordinator` 经路由 Session 的 channel operation 路由发送 `cancel_delivery`，以操作的尝试为键。
   - verdict 读取已提交的记录，`cancelRequested` 标志就是停止请求：

     | 已提交的记录             | 操作结果                                 |
     | ------------------------ | ---------------------------------------- |
     | `cancelRequested` 已设置 | `completed`，带 receipt                  |
     | 投递在没有它的情况下结束 | `failed` `task_already_settled`          |
     | 投递存活且没有它         | 发送 `cancel_delivery`，然后再读一次记录 |

   - 在准入与发送之间认领了投递的适配器赢得竞争：动词记录标志，于是操作完成，而投递继续发送直到其自然结果——正如任务契约中先完成者保留其结果。
   - 未获证明的结果在预算内重试，之后停住，与 H4f 决策 5 相同。

5. **没有新词汇。** 没有投递路由、操作类型、投递 id 属性或失败码。F3 的验收字面成立：一条取消路径服务两种类型。

## 契约变更（1.57.0）

- `TaskKind` 增加 `channel_delivery`。
- `TaskActionCapability` 的描述点名该 kind 及其「仅 `pending`」规则。
- `info.description` 增加 v1.57 段落。
- 生成的 WebShell 类型增加该枚举值。

## 验证

- **投影，两种语言。** 共享投影 fixtures 把 `channel_delivery` 映射到其 kind，并把它列入任务 kind。两种语言的 channel 记录契约测试都钉住「投递投影任务、路由不投影」。TS authority 的投递链及其重开现在带有投递的任务视图。
- **真实记录**（`ManagedExtensionRecordStoreTest`）：
  - planned 投递读为带 `cancel`、无 runtime state 的 `pending` 任务；
  - 已认领的读为无动作的 `running`；
  - 已取消的读为 `cancelled`，其请求在 verdict 读取的记录上；
  - 以无 kind 方式存储的投递行（即本变更之前的 server 写入的那样），在下一次修订时不写任务状态、不记任务事件。
- **准入**（`ManagedTaskCancelOperationTest`）：`pending` 投递准入并重放；其他所有状态回 `task_action_unavailable`。
- **投递**（`TaskCancelCoordinatorTest`）：
  - pending 投递经 channel 路由（从不经 child operation 路由）收到 `cancel_delivery`，并从标志完成；
  - 期间被认领的投递以已记录的标志完成；
  - 已 delivered 且无标志的投递以 `task_already_settled` 失败，不发送；
  - Workspace 权限拒绝了路由时，取消会重试、在预算用完后停放，且不再发送；投递在没有标志的情况下发出后，停放的取消以 `task_already_settled` 失败。
- **连接器**（`QwenHostedHarnessConnectorTest`）：`cancel_delivery` 与 `submit_input` 一样，在已缓存的挂接上也要经过 channel 路由的 Workspace 检查，检查失败时不转发任何东西。
- **真实栈**（FG7d，`HostedChannelFaultGatesIT`，MySQL 8.4，打包的 Harness，email 参考适配器）：
  - `task-cancel-planned`：路由 Session 的任务列表把 planned 投递显示为带 `cancel` 的 `pending` 任务。公开取消回 `202`，操作完成且其 key 可重放，任务读为 `cancelled`。outbox 拉取到达控制面但什么也不发送，台账保持为空。
  - `task-cancel-claimed`：适配器的发送被挂起期间，任务读为无动作的 `running`，公开取消回 `409 task_action_unavailable`。放行后投递发送一次，任务读为 `completed`。
  - 整个 FG7 类与 channel 崩溃 IT 和新用例一起通过。
- **未覆盖：** 在 WebShell 面板中列出投递任务（面板自己的变更）；email fixture 之外的真实提供方。

## 约束与风险

- **路由 Session 的任务列表行数变多。** channel Session 的每条回复现在都是那里的一个任务，每次修订都是一条任务事件。日志的上限与保留下限照常适用。
- **竞争可见。** 准入时看到 `pending` 的取消，可能在适配器先认领的情况下完成，而回复仍然发出。操作的 `completed` 是已记录的请求，任务的 `completed` 是物理结果，契约把二者分开。
- **创建者缺少执行授权时取消会停放。** channel 操作路由在每次操作时都会重新校验路由 Session 的 Workspace 执行权限，已缓存的挂接也不例外（`QwenHostedHarnessConnector.runChannelOperation`），`cancel_delivery` 与 `submit_input` 一样要经过它。创建者缺少该授权期间，投递取消什么也不发送，按预算重试后停放为 `recovery_blocked`。停放的取消不会再发送（[H4f 决策 5](2026-10-10-managed-task-cancel.zh-CN.md)）。授权恢复后，新的取消仍能停下尚未被认领的投递，因为停放的取消不算 open；但适配器可能先认领并发出它，此时停放的取消以 `task_already_settled` 失败。这就是 H4f 对「创建者失去授权」的既有限制，适用范围是这条路由：child 任务的取消走 child operation 路由，它在已缓存的挂接上不做自己的 Workspace 检查。
- **旧行。** 升级前已 planned 的投递不是任务（决策 2）。
- **回滚下限。** 早于本变更的 server 对它不知道会投影任务的行，在每次修订时都写入空的任务状态。回滚后，它会继续列出期间插入的投递任务（它们的 kind 已存储），状态为空，kind 也是其契约不认识的值。只有在这些 Session 关闭之后才回滚到本变更之前，或者接受这些行在关闭前读起来不正确。

## 后续工作

| 项            | 范围                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 公开重发      | 对 `unknown` 或 `rejected` 投递的重发仍是受信适配器的动词；公开的重发需要自己的契约工作（H5 未决问题 4）。                      |
| WebShell 面板 | **已由 #14415 交付：** 面板按标签列出所有 kind，并只按 `actionCapabilities` 决定是否允许取消，所以 pending 投递会带着取消显示。 |
| 部分停止      | 停止 `partial` 投递的剩余分段需要改记录契约；目前没有适配器会产生 partial。                                                     |
