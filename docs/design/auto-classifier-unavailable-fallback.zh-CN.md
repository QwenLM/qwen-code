# Auto 分类器不可用时的确认回退

[English](auto-classifier-unavailable-fallback.md)

## 问题

Auto Mode 当前会把所有分类器基础设施故障转换为执行拒绝。网络错误、超时、结构化响应无效、快速模型不可用或上下文溢出，都会在标准确认流程询问用户之前终止待执行的工具调用。

这种行为混淆了两种结果：

- 分类器的策略阻止是安全判断，应继续拒绝操作。
- 分类器不可用表示未产生判断，应由用户人工决定。

现有连续不可用回退只会在两次分类器调用失败后打开确认。最初的失败仍会终止工具调用，确认也没有解释基础设施问题或提供直接恢复路径。

## 目标

- 首次分类器不可用就进入标准人工确认流程。
- 在确认中说明 Auto Mode 无法对操作进行分类。
- 提供明确选项：仅批准当前操作一次，并将会话切换到 Default Mode。
- 保持 CLI 与 ACP 权限行为一致。
- 保留策略阻止、显式 deny 规则、确定性破坏性命令 guard 和用户取消行为。

## 非目标

- 将 Default Mode 持久化到用户或工作区设置。
- 未经用户选择就自动切换模式。
- 修改策略分类器的允许或阻止规则。
- 让没有审批界面的非交互或后台会话能够显示确认。

## 预期行为

当分类器返回 `unavailable: true` 时，权限层仍会记录不可用事件，但返回人工回退结果而不是阻止结果。待执行调用继续经过现有 PermissionRequest 和确认流程。

生成的确认携带 Auto Mode 回退元数据，并隐藏持久化的“始终允许”选项。确认说明分类器不可用，并建议在持续失败时使用 Default Mode。选项包括：

- 允许一次。
- 切换到 Default Mode 并允许一次。
- 拒绝。

切换选项明确包含一次性批准。只显示模式切换会让已经待执行的操作是否获准变得不明确。

| 分类器结果 | 当前行为           | 新行为       |
| ---------- | ------------------ | ------------ |
| 允许       | 自动执行           | 不变         |
| 策略阻止   | 拒绝并提供策略原因 | 不变         |
| 不可用     | 拒绝工具调用       | 请求人工批准 |

## 核心权限流程

`applyAutoModeDecision` 记录不可用计数，并返回专用的分类器不可用回退原因。由于结果不再是阻止，基础设施故障不会触发 PermissionDenied hook；普通 PermissionRequest hook 会在确认前运行。

不可用计数仍有用途。批准回退会重置连续计数，拒绝则保留计数。如果重复失败达到现有阈值，后续需要分类器的调用可跳过已知故障的分类器，直接进入人工确认。

确认详情新增可选 Auto Mode 回退元数据，供 edit、execute、info、MCP 等确认类型共享。新增审批结果表示“允许一次并切换到 Default”。CLI scheduler 切换运行中会话的模式，并在调用工具确认回调或记录工具决策前将该结果归一化为普通 `ProceedOnce`。

破坏性 guard 的升级在权限结果中设置 `requiresHumanDecision: true`。scheduler 和 ACP 都会忽略 PermissionRequest hook 对这类升级的 allow，包括 hook 改写后触发 guard 并达到上限的输入。hook 的 deny 仍生效。普通分类器回退保留既有 hook 批准行为。

`Config.setApprovalMode` 已提供所需会话转换：恢复进入 Auto Mode 时暂时移除的规则、重置拒绝计数并递增审批模式版本。不修改设置文件。

## CLI 展示

TUI 确认组件在操作详情之前展示回退说明，并在 Reject 前添加切换选项。完整和紧凑确认布局都显示该选项。高度计算为新增提示和选项预留空间，确保小终端仍显示可操作选项。

## ACP 展示

ACP 权限请求将回退说明放入文本内容，并提供相同的切换模式并允许一次选项。用户选择后，会话将工具审批归一化为 `ProceedOnce`，切换运行时模式到 Default，并发布现有当前模式更新通知。

只选择 Allow 或 Reject 的 ACP 客户端继续使用现有协议行为。

## 失败边界

- 用户取消分类器请求仍是中止，不会转为审批确认。
- 显式权限 deny 仍是错误。确定性破坏性命令阻止在拒绝计数达到连续阻止或会话总量上限前仍是错误；达到上限后必须由人工决定。共享拒绝计数，包括分类器不可用事件，可以触发总量上限，但不能通过 PermissionRequest hook 的 allow 授权执行。
- 没有权限传输的非交互调用，以及无法确认的后台 agent，仍通过既有人工确认回退处理拒绝执行。
- 分类器 Stage 2 的策略审核失败视为不可用并询问用户；Stage 2 成功完成的策略阻止仍拒绝执行。

## 涉及文件

- `packages/core/src/permissions/autoMode.ts` 和测试：不可用到回退的映射、元数据和 hook 门控。
- `packages/core/src/tools/tools.ts`：回退确认元数据和切换审批结果。
- `packages/core/src/core/coreToolScheduler.ts` 和测试：装饰确认、跟踪回退决策、切换模式、归一化审批结果。
- `packages/core/src/telemetry/tool-call-decision.ts` 和测试：识别新增审批结果。
- `packages/cli/src/ui/components/messages/ToolConfirmationMessage.tsx` 和测试：说明和选项展示。
- `packages/cli/src/acp-integration/session/permissionUtils.ts` 和测试：ACP 内容和选项映射。
- `packages/cli/src/acp-integration/session/Session.ts` 和测试：ACP 回退、模式转换和通知。
- `docs/users/features/auto-mode.md`：说明即时人工回退和 Default Mode 恢复选项。

## 待定问题

无。模式切换只作用于当前会话，并明确批准待执行操作一次。
