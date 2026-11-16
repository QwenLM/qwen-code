# 双引擎工作区变更传播

[English](./2026-09-27-paired-engine-workspace-change-propagation.md) | [简体中文](./2026-09-27-paired-engine-workspace-change-propagation.zh-CN.md)

## 状态

#12737 B2b 切片的第二部分，基于上游 `52460c24c8`。第一部分
[双引擎工作区 runtime 身份](./2026-09-26-paired-engine-workspace-runtime-identity.zh-CN.md)
处理了存活判断、epoch 和停止回执。本部分给出
[ACP Bridge 执行引擎](./acp-bridge-execution-engines.zh-CN.md) 所记工作区契约门槛中
的第三项：把影响会话的工作区变更下发到所有存活引擎，并采用 #12737 中 Q2 已决定的
确认与权限围栏语义。它建立在
[双引擎按引擎运维](./2026-09-26-paired-engine-per-engine-operations.zh-CN.md)（B2c）
的隔离机制之上：未确认的变更成为一种隔离原因，而按照 Q3 的决定，之后对它的确认可以
提前结束隔离。本改动之后，普通 daemon、Channels 和嵌入式构造都仍不传
`executionEngines`。

## 问题与现状

改变存活会话权限或行为的工作区命令只会送到工作区控制通道（配对 Bridge 上即
Legacy）：

- 权限规则（`qwen/permissions/setRules`，同时由 Legacy 子进程持久化）；
- 设置重载（`qwen/control/workspace/reload`：审批模式、workflow 与工具设置、环境
  变量）；
- Session Workflow 开关（`qwen/control/workspace/session-workflow`）；
- 模型 provider（`qwen/control/workspace/model-providers/reload`）；
- Skills（`qwen/control/workspace/skills/refresh`）。

因此新增 deny 规则后，存活的 Managed 会话在重建前仍沿用旧权限。只有 Managed 存活
时，这些命令都以 `workspace-command` 会话不存在失败，变更完全到不了 Managed 会话。

## 范围

范围内：

- Bridge 到引擎的变更通知及其确认。
- 把上述五种命令下发到 Legacy 以外的每个存活引擎。
- 把未确认的变更作为隔离原因；变更收紧权限时施加 Q2 的围栏，并按 Q3 的决定允许
  提前结束隔离。
- 不新增路由或错误码，把部分生效的变更报告给调用方。

范围外：

- 隔离策略本身（B2c）。本改动只新增三项所有隔离都会执行的拒绝：shell 命令、继续
  轮次，以及在附件解析期间被隔离超越的 prompt；
- 宿主接线（B2d）；
- Legacy 引擎自身的语义，保持不变：重载时忙碌的 Legacy 会话保留原设置，并像现在
  一样列在 `sessionsSkipped` 中；
- 信任撤销：工作区信任协调器已经会排空并替换整个工作区 runtime，包括所有引擎。

## 方案设计

### 变更通知

配对 Bridge 向 Legacy（即工作区控制）以外各引擎的每个存活通道发送
`qwen/control/workspace/change`：

```json
{
  "v": 1,
  "revision": 3,
  "kind": "permissions",
  "tightening": true,
  "cwd": "/work/project"
}
```

`kind` 取 `permissions`、`settings`、`sessionWorkflow`（另带 `enabled`）、
`modelProviders` 或 `skills`（另带 `reason`）。同一 Bridge 上每传播一次变更，
`revision` 就递增一次。

通知不携带设置值。发出通知时，工作区控制引擎或 daemon 已经把变更持久化，引擎自行
重新读取对应设置。

引擎要在每个存活会话的下一次 prompt、模型请求或工具派发之前应用该变更，并取消无法
重新校验的进行中轮次，之后才能回复：

```json
{ "v": 1, "revision": 3, "acknowledged": true }
```

其他结果都不算确认：出错、超时（沿用该命令的超时）、回复格式不对或 revision 不符。
投递期间退出的通道视为已了结，这符合 Q2 中“退出已确认”的条件：其会话已不存在，新会话
会启动新的通道。仍在启动的通道会被跳过，因此引擎必须在创建每个会话时读取设置。命令执行
期间替换了超时 Legacy 通道的新 Legacy 通道也是如此：它自己读取了当前设置，不会收到通知。

通知不经过工作区控制发送，就像 B2c 读取 Managed 子进程的资源那样，因此回复慢不会让
通道退役，而是让它进入隔离；请求也会保持打开，以便接收之后才到的确认。

### 各类变更的去向

在配对 Bridge 上，`invokeWorkspaceCommand` 识别这五种命令：先像现在一样把命令发给
工作区控制，再向其他存活引擎发送通知。单工厂 Bridge 仍走原有路径，不做改动；工作区
stop 进行中时所有命令也是如此：照旧被拒绝，不通知任何引擎，也不隔离任何引擎。

| 命令                                            | `kind`            | 是否收紧权限           |
| ----------------------------------------------- | ----------------- | ---------------------- |
| `qwen/permissions/setRules`                     | `permissions`     | 是                     |
| `qwen/control/workspace/reload`                 | `settings`        | 是                     |
| `qwen/control/workspace/session-workflow`       | `sessionWorkflow` | `enabled` 为 true 时是 |
| `qwen/control/workspace/model-providers/reload` | `modelProviders`  | 否                     |
| `qwen/control/workspace/skills/refresh`         | `skills`          | 否                     |

权限规则和设置重载不做差异比较，一律按收紧处理。二者都可能新增 deny 规则或收紧
审批，而按收紧处理的代价只是取消本已未确认的引擎的进行中轮次。

工作区控制不存活或其命令失败时，已落盘的变更仍会发给其他引擎。若它们都确认，则
返回该命令原来的错误，现有调用方行为不变。权限规则例外：只有 Legacy 子进程会持久化
权限规则，因此只有该引擎存活时才发送。daemon 自身只在工作区控制存活时才发出 Skills
命令（B2b 第一部分已如此），所以只有 Managed 存活时，Skills 变更暂时到不了 Managed。

### 未确认的引擎

该通道按 B2c 的描述进入隔离，reason 为 `workspace_change_unacknowledged`：

- 该引擎不再接收新会话，其会话也不再接受新工作，两者都以
  `503 acp_channel_unavailable` 和该 reason 拒绝；
- 进行中的轮次照常结算，已结算的会话被关闭，通道排空后退役；
- 排空期限（`quarantineDrainTimeoutMs`，默认 5 分钟）限定等待时间。

另一个引擎不受影响。本改动还补上了这种拒绝的三个缺口，对所有隔离原因都生效：拒绝
shell 命令和继续轮次，并在 prompt 的附件解析完成后、发出之前再检查一次。

变更收紧权限时，Bridge 不等进行中的工作结算（Q2）：

- 进行中的轮次立即按客户端取消的方式取消；
- 这些会话的权限请求一律按已取消回复，无视取消的轮次也拿不到排队中的 mid-turn
  消息；
- 后台通知轮次一律拒绝，包括其他隔离会放行的、汇报已在进行的工作的通知；
- 子进程之后在这些会话上开始的 Goal 轮次一经上报即被取消。

变更之前已在进行、变更之后才在该通道上完成的恢复或创建，其会话同样被施加围栏。

状态读取、取消、关闭，以及暂停或清除 Goal、暂停 workflow，仍能到达每个会话。

### 提前结束隔离

#12737 的决定只允许对缺失工作区变更的有效确认在期限前结束隔离。超时的通知会保持
请求打开；如果引擎之后对它给出精确的确认，该 revision 就不再缺失。一旦没有缺失的
revision，隔离即结束：

- 通道重新接收新会话和新工作；
- 权限围栏解除，排空期限撤销；
- 已关闭的会话保持关闭，需要时再恢复。

以下情况会保留隔离：

- 另有其他原因占住该通道；
- 本次隔离由其他原因开始；
- 期限已过或终止已经开始。

这些情况下权限围栏同样解除：没有缺失的 revision 时，引擎已持有它错过的所有变更，因此
后台汇报可以结算，而保留的隔离仍然拒绝新会话和新工作。

出错或错误的回复无法在之后得到确认，这类通道会退役。

### 结果报告

只要有引擎未确认，命令就以 `WorkspaceChangePartiallyAppliedError` 失败。该错误携带
revision、kind、未确认的通道 ID；工作区控制引擎成功时带上其结果，失败时把其错误作为
`cause`。

现有调用方本来就把失败视为“未生效”，因此不新增路由或错误码：

| 路由或调用方                  | 变更部分生效时                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| `POST /workspace/permissions` | `500 permission_update_failed`（ACP 方法返回内部错误）；规则已保存时仍发布 `settings_changed` |
| `POST /workspace/reload`      | `200`，带 Legacy 的结果，`childError` 指出变更部分生效                                        |
| 模型 provider 重载            | `status: "failed"`                                                                            |
| Session Workflow 设置路由     | `500 runtime_update_error`，与现在实时推送失败时一样仍发布 `settings_changed`                 |
| Skill 开关                    | `activation: "partial"`                                                                       |
| Skills 准备                   | Skills 准备错误                                                                               |
| 编辑 Skill 后的刷新           | daemon 日志                                                                                   |

没有调用方会把部分生效的变更报告为已生效，因此撤销只有在所有存活引擎都确认或已退出后
才报告完成。

## 文件与消费方

| 区域   | 文件                                                                                        |
| ------ | ------------------------------------------------------------------------------------------- |
| Bridge | `session-control-plane.ts`、`bridgeClient.ts`、`bridgeErrors.ts`、`status.ts`               |
| CLI    | `serve/workspace-service/index.ts`（权限规则与重载）                                        |
| 文档   | `docs/developers/qwen-serve-protocol.md`、`acp-bridge-execution-engines.md`、按引擎运维设计 |

不新增路由，也不改变路由作用域。权限、重载、Session Workflow、模型 provider 和
Skills 路由仍是工作区级别，只作用于所选 runtime；`workspace_change_unacknowledged`
是现有字段的新取值。

## 验证与验收标准

1. Legacy 子进程保存新的 deny 规则后，规则送达存活的 Managed 会话：引擎在 Legacy
   命令之后收到 revision 为 1 的 `permissions`，其会话和新会话照常可用。Bridge 测试
   和真实 serve app 上的 `POST /workspace/permissions` 都覆盖了这一点。
2. Managed 未确认新的 deny 规则时：
   - 命令以部分生效失败并带上 Legacy 的结果，隔离以
     `workspace_change_unacknowledged` 开始；
   - 取消进行中的 Managed 轮次，已排队的 prompt 被拒绝且从未开始；
   - 已结算的会话以 `channel_quarantined` 原因关闭，通道随后退役；
   - 新建 Managed 会话被拒绝；
   - Legacy 会话和新建的 Legacy 会话照常可用；
   - 仍发布 `settings_changed`。
3. 无视取消的轮次，其权限请求以已取消结束，也拿不到排队中的 mid-turn 消息。子进程
   之后在被围栏会话上开始的 Goal 轮次被取消，Legacy 会话上的则不受影响。变更之前启动的
   后台任务，其结果汇报在被围栏会话上被拒绝；不收紧权限的变更未被确认时则被放行。在收紧
   权限的变更之后才完成恢复的会话被施加围栏；迟到的确认之后新建的会话则没有围栏。
4. 在被隔离的会话上，开始工作的所有途径都以 `workspace_change_unacknowledged` 拒绝：
   prompt、继续轮次、旁支提问、recap、generation、fork agent、shell 命令、mid-turn
   消息，以及 Goal 或 workflow 的启动。在附件解析期间被隔离超越的 prompt 不会发出。
   暂停 Goal 或 workflow 仍会送达引擎。
5. 不收紧权限的变更（Skills、模型 provider、关闭 Session Workflow 开关）未被确认时，
   引擎被隔离，但进行中的轮次照常结算。revision 不符的回复不算确认。
6. 迟到的精确确认在没有缺失 revision 后结束隔离：该引擎的新会话在同一通道上启动，
   该会话也重新接受 prompt。仍有一个 revision 缺失、或回复的是其他 revision 时，隔离
   保持。其他原因保留隔离时，确认仍会解除权限围栏：被挂起的后台汇报被放行，而新会话和
   prompt 仍被拒绝。
7. 工作区控制不存活时，设置重载仍送达 Managed，权限规则则不发送。工作区 stop 进行
   中时，权限变更以原有的 draining 错误拒绝，Managed 收不到通知。
8. 命令执行期间替换了超时工作区控制通道的新 Legacy 通道不会收到通知。投递期间退出
   的引擎视为已了结。
9. 单工厂 Bridge 不发送通知，现有测试无需修改即可通过。撤回任一新行为，对应的新测试
   都会失败。

## 风险与待解问题

- 真实的 Managed 引擎尚不存在。通知契约目前只由进程内替身验证；实现该契约的引擎
  必须遵守“在下一个准入点之前应用”这一确认前提。
- Bridge 只能拒绝经过它的工作。未确认的引擎在排空期限之前，仍可能运行不经 Bridge
  的自发工作，例如定时任务。
- 临时故障导致未能确认时，引擎同样会被隔离：其会话结算后即被关闭，除非之前先收到
  迟到的确认，否则通道会退役。提前结束隔离不会重新打开已关闭的会话。
- 只有 Managed 存活时仍无法修改权限规则，因为规则由 Legacy 子进程持久化；daemon 也会
  把 Skills 变更推迟到工作区控制存活之后。配对宿主是否为这些路由启动工作区控制，由
  B2d 决定。
