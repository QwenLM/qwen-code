# 钉钉工具审批卡片

[English](2026-08-29-dingtalk-permission-cards.md) | [简体中文](2026-08-29-dingtalk-permission-cards.zh-CN.md)

## 背景

钉钉渠道已使用原生卡片呈现运行状态和 `ask_user_question` 交互。普通非 YOLO 工具审批请求仍以纯文本形式提供 `/approve`、`/approve-always` 和 `/deny` 命令。本次变更扩展现有 Channel 展示边界，不改变 ACP、daemon 路由、审批语义或其他渠道适配器。

## 目标

- 将有人参与的钉钉工具审批请求呈现为原生交互卡片。
- 提供单次允许、拒绝，以及 daemon 提供时的持久授权选项。
- 将回调绑定到原始请求、运行、会话、聊天或话题以及 prompt 所有者。
- 原始审批最多处理一次，并将过期卡片置为终态。
- 交互卡片被禁用或投递失败时，保留现有文本请求。

## 非目标

- 不改变审批策略、审批模式、ACP 或会话语言 API。
- 不新增钉钉卡片模板。复用现有问题表单模板，其中只包含一个必填、单选的审批字段。
- 不支持跨客户端或群内投票。只有发起该次有人参与的 Channel 运行的用户可以操作卡片。
- 不在 CLI、Web、IDE 或其他 IM 适配器中实现原生审批卡片。

## Channel 展示契约

`ChannelBase` 为普通审批提供第二个可选的结构化展示钩子。上下文仅包含与适配器无关的数据：请求与运行标识、prompt 所有者、已解析的 Channel 目标、经过净化的工具标题、审批请求实际提供的决策、审批结束订阅，以及只能响应一次的闭包。

```ts
export type ChannelPermissionDecision = 'allow_once' | 'allow_always' | 'deny';

export interface ChannelPermissionRequestContext {
  requestId: string;
  sessionId: string;
  runId: string;
  owner: ChannelPromptOwner;
  target: SessionTarget;
  precedingSegmentId?: string;
  title: string;
  decisions: Array<{
    kind: ChannelPermissionDecision;
    label: string;
  }>;
  onSettled(listener: (reason: UserInputSettlementReason) => void): () => void;
  respond(decision: ChannelPermissionDecision): Promise<boolean>;
}
```

该钩子仅适用于当前有人参与、非循环且具有所有者的 prompt。`ChannelBase` 从原始审批选项推导可用决策，绝不允许适配器自行编造选项 ID。拒绝仍通过现有的拒绝或取消映射提供。对于 `ask_user_question`，先运行现有问题展示器；仅当该路径不受支持时，才运行普通审批展示。

同一个待处理审批响应 Promise 将卡片响应和文本命令响应串行化。没有结构化展示器生效时，文本命令保持不变。对于原生审批卡片，来自所属发送者的命令仍可与卡片安全竞争：第一个被接受的响应生效，卡片通过共享待处理记录观察审批结束状态。

## 钉钉控制器

`PermissionCardController` 管理钉钉专用状态，以请求 ID 和 `outTrackId` 为键。它复用现有问题模板，仅包含一个 `permission_decision` checkbox-group 字段，不提供自由输入选项。渲染的选项是从上下文决策中选取的字面值，因此 daemon 未声明 `allow_always` 时，不会显示该选项。

展示过程经过四个状态：`reserved`、`pending`、`claimed` 和 `terminal`。记录在投递前订阅 Channel 审批结束事件，避免网络请求期间从外部完成的审批被重新激活。投递失败会移除本地记录并返回 `unsupported`；随后 `ChannelBase` 发送现有文本请求。投递成功后启动配置的超时计时。

只有以下条件全部满足时，才接受回调：

- `outTrackId` 对应一条仍有效的待处理记录。
- 回调操作者与 prompt 所有者一致。
- 回调包含预期的提交或取消动作及业务载荷。
- 对于提交动作，表单恰好包含一个已声明的决策，且不含未知字段。

被接受的回调在异步完成审批之前，同步认领该记录。重复、格式错误、过期及终态回调会得到应答，但不作处理。其他操作者会收到使用 Channel 语言的通用提示，说明仅所有者可操作，且无法修改审批或卡片。

## 终态

控制器通过现有卡片实例更新 API 呈现以下终态：

| 原因                 | 卡片状态    | 原始审批                    |
| -------------------- | ----------- | --------------------------- |
| 接受允许决策         | `approved`  | 选取原始允许选项            |
| 接受拒绝决策         | `denied`    | 选取原始拒绝选项或取消      |
| 卡片取消动作         | `cancelled` | 通过一次性响应器拒绝        |
| 超时                 | `expired`   | 通过一次性响应器拒绝        |
| 运行或会话取消       | `cancelled` | 由现有 Channel 清理流程结束 |
| 在卡片之外完成审批   | `expired`   | 已在其他位置完成            |
| 响应被拒绝或抛出异常 | `expired`   | 不重试；继续阻止重复回调    |

卡片更新属于尽力而为的状态呈现。更新失败不会重新打开或重试已经结束的审批。

## 配置与兼容性

`interactiveCards.permissionCard` 与问题卡片配置保持一致：

```json
{
  "interactiveCards": {
    "permissionCard": {
      "enabled": true,
      "timeoutMs": 270000
    }
  }
}
```

配置 `interactiveCards` 后，审批卡片默认开启，超时采用与问题卡片相同的有界正值处理方式。根级 `enabled` 标志和嵌套审批标志均可独立禁用审批卡片。现有配置结构继续有效，其他渠道不会因此获得原生审批卡片实现。

## 语言行为

Channel 启动时读取一次现有默认 `general.language` 设置。先将下划线规范化为连字符，再根据中文值（`zh`、`zh-*`、`Chinese` 或 `中文`）选择中文审批文案；缺失、自动及所有其他值使用英文。daemon worker 遵循相同规则。任何 IM 请求都不会调用 `/daemon/session/:sessionId/language`，语言也不按会话解析。

选定的语言通过现有 Channel 创建选项传递。`ChannelBase` 仅本地化其内置审批决策标签和命令回退文案，保留工具标题、自定义选项标签、选项 ID 和斜杠命令。钉钉将相同语言应用于审批卡片标题、字段标签、提交按钮、终态描述以及仅所有者可操作的交互提示。`pending`、`approved` 和 `expired` 等协议卡片状态保持不变。

## 验证

- ChannelBase 测试覆盖适用条件、精确决策推导、一次性响应仲裁、外部结束审批和文本回退。
- 控制器测试覆盖渲染、可选持久授权、所有者限制、全部决策、投递失败、超时、重复回调、格式错误的载荷和外部结束审批。
- 钉钉适配器、展示器、回调路由、配置和管理 schema 测试覆盖各部分的连接。
- 提交前运行包测试、仓库构建、类型检查和 diff 自审。
- 仅在有效凭据和已发布模板可用时进行真实钉钉运行，并单独报告结果。
