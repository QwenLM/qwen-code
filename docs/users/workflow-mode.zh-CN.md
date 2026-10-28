# 会话级 Workflow 模式

[English](workflow-mode.md) | [简体中文](workflow-mode.zh-CN.md)

Workflow 模式保存当前会话的偏好：对普通新输入考虑使用 Workflow 工具，默认关闭。
模型仍决定任务是否适合工作流；权限、信任、预算与工具限制保持生效。
开启模式不会启动工作流、修改推理 effort 或修改默认设置。

Workflow 工具默认关闭。开启模式前，先在设置中启用 `tools.workflowsEnabled`，
或设置 `QWEN_CODE_ENABLE_WORKFLOWS=1`：

```sh
QWEN_CODE_ENABLE_WORKFLOWS=1 qwen --workflow-mode on
qwen --resume <session-id> --workflow-mode off
```

工具不可用时使用 `--workflow-mode on` 启动会导致初始化失败。
`QWEN_CODE_DISABLE_WORKFLOWS=1` 的优先级高于开启工具的设置。

两套终端界面均支持 `/workflows mode` 或 `/workflows mode status` 查询状态，
通过 `/workflows mode on` 和 `/workflows mode off` 修改。
这些模式控制可在回复流式输出期间执行，对后续符合条件的输入生效。
页脚显示 `Workflow mode: on`；保存的偏好暂时无法应用时显示
`Workflow mode: on (unavailable)`。已有 `/workflows` 运行列表与暂停控制保持原有行为。

状态分为 `requested`（已保存的偏好）、`available`（当前所需工具是否可用）和
`effective`（前两者均为真）。开启要求 Workflow 工具可用；工具不可用时仍可关闭。
工具丢失不会删除已保存的开启偏好；工具恢复后，该偏好重新生效。

普通本地会话和普通 daemon 会话支持此模式，包括次级工作区的会话所有者。
Managed、SSH、派生/子代理、session-agent 及关闭聊天录制的会话不支持模式修改。
这些协议会话不广告相应能力或选项。持久化写入失败时，公开状态保持不变。

## Web Shell 与 VS Code

Web Shell、分屏和现代 VS Code 聊天的输入栏为受支持会话提供独立的 **Workflow**
控件。开关表示已保存的偏好，而不是当前是否实际生效。偏好已开启但工具不可用时，
开关仍保持选中，并允许关闭。点击 Workflow 标签可打开状态详情；键盘聚焦后激活标签
或在触屏设备上轻点，也能查看相同详情。

尚未创建或恢复会话时，控件只显示可用性占位提示，不会创建会话或保存将来的偏好。
未广告支持能力的宿主（包括旧版服务端）不显示模式开关。

其他客户端的更改会自动同步到同一会话的控件。写入或重连期间保留最后确认值，
直到状态重新确认前禁用开关。超时表示结果尚未确认，不是修改成功；客户端读取当前
状态，而不会自动重复写入。正在输出回复不会禁用开关：更改对下一轮新输入生效，
并保持思考强度不变。

## 提醒与输入行为

第一个符合条件的输入收到仅提供给模型的提醒。无其他变化时，稀疏提醒在第 11、21
次输入发送，此后每十次符合条件的输入发送一次。关闭模式或失去工具能力后，下次符合
条件的输入携带一次退出提醒。只有真实模型请求派发才消费提醒或推进计数；派发前取消
或拒绝不会消费。同一请求的重试与 fallback 使用同一交付 token。如果取消操作从模型
历史中移除了已派发的模式提醒，下次符合条件的输入会重新声明当前状态。

普通 CLI、SDK 和 ACP 输入使用显式模式时不要求 human-origin 声明。工具续轮、
重试、Hook、slash 生成的提示、shell 模式、旁路查询、自动 Goal/Cron/通知/渠道输入
及子代理不新增模式提醒，也不推进计数。模式或尚未交付的状态切换需要上下文时，暂停
提示推测执行。

[单轮关键词提示](workflow-intent.zh-CN.md) 保持独立，其人工来源要求与关闭设置不变。
合法关键词和模式提醒共享一个 envelope；关闭持续模式不会关闭合法的单轮关键词。
仅由模式触发的提醒不点亮瞬时关键词指示器，也不记录关键词遥测。

## 会话生命周期

恢复会话读取所选 transcript 分支上最后一个合法 Boolean 记录，并对已保存的开启或
关闭状态重申一次。显式 CLI 或 SDK 初始值在会话就绪后覆盖恢复值一次。
初始值冲突，或工具不可用时指定初始开启值，都会导致初始化失败。
新建或清空会话默认关闭。Fork 独立继承所选检查点值；
rewind 保留当前偏好并将其锚定到恢复后的分支。成功压缩后，下次符合条件的新输入重新
声明状态。
恢复或分支切换失败后，如果重建了原会话历史，下次符合条件的新输入会重新声明其保存的
状态。未保存过模式偏好的会话不发送提醒。

## TypeScript SDK 与 ACP

```ts
const session = query({
  prompt: messages(),
  options: { workflowMode: true },
});
const state = await session.getWorkflowMode();
await session.setWorkflowMode(false);
```

`workflowMode` 可省略：省略保留恢复值，`false` 显式保存关闭。初始化会协商并暂存初始值；
`Query.initialized` 表示控制握手完成。Get/set 等待会话就绪；会话初始化尚未完成时，
重复的 initialize 请求会被拒绝。旧版 CLI 在首个 prompt 前
拒绝显式模式请求，不会静默忽略。自定义 Transport 使用相同控制协议。

ACP 广告标准 `workflow_mode` 配置选项，值为 `on` 和 `off`。`currentValue` 对应
请求状态，`_meta['qwen.workflowMode']` 包含 `available`、`effective` 和可选 `reason`。
提交成功或工具能力刷新时，通过 `config_option_update` 发布完整选项。

Daemon 客户端使用现有会话 config-option 接口或
`setSessionConfigOption(sessionId, 'workflow_mode', 'on', clientId)`。
该选项不接受 `persist` 覆盖参数，始终持久化到当前会话。上下文读回与更新属于该会话的
真实 live owner，受 lease 与 generation 检查约束。Web Shell 和现代 VS Code 宿主使用
同一套会话控制与更新。
