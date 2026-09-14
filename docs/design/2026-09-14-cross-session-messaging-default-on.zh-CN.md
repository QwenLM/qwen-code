# 跨会话消息：默认开启

[English](2026-09-14-cross-session-messaging-default-on.md) | [简体中文](2026-09-14-cross-session-messaging-default-on.zh-CN.md)

状态：随本文档一起实现。

## 问题

`agents.crossSessionMessaging` 自落地以来一直是 opt-in。每个会话启动时都是关着的：同一用户的其它会话看不见它、联系不到它，它也联系不到别人。在让"可达的会话"变得安全的那些零件还在一个个 PR 地到来时，这是正确的姿态。

现在它们都到了。inbox 对每个连接做认证；来自另一个会话的消息只在两个会话处于同一审查类别时投递，否则 hold 给用户；仓库可以让会话更谨慎，但不能更宽松；发得比会话能接的快的发送方会被丢弃并被告知；用户信任的程序出示用户亲手铸造的令牌。这些都到位之后，默认关闭不再保护任何东西——它只意味着这个功能对它本来要服务的人不存在。通过 SDK peer 端点接入的语音前端看不到一个用户从没找到这个设置的会话；同一仓库里的两个会话也没法互相说一句"构建完成了"。

## 设计

**schema 默认值改为 `true`。** 这个设置的其它方面不变：`false` 仍然关闭该会话的功能，仍然需要重启，工作区仍然只能收紧。

**未设置的键读作开，只在一处。** 合并后的设置只包含某个作用域确实写了的内容，所以 schema 默认值从不会以值的形式到达代码——每个读取点看到的都是 `undefined`，然后拿它和 `true` 比较。四个读取点（交互式启动、ACP agent、`/peers`、inbox 失败提示）现在都问同一个辅助函数：`true` 和 `undefined` 答开，`false` 和任何不认识的值答关。最后一条是刻意的：读取方无法解释的值不能打开 socket。

**工作区排名跟着变。** 工作区的值只在严于用户或平台所设时才保留，而"他们所设"此前是按"未设置即关"来比较的。未设置改为开之后，仓库的 `false` 会和未设置的用户作用域同级而被丢弃——仓库将永远无法关闭消息。现在未设置与 `true` 同级，所以 `false` 是收紧、会保留；工作区的 `true` 只是重复默认值，无警告地丢弃。

**措辞随默认值改。** `/peers` 在没有 inbox 的会话上不再让用户去启用一个已经开着的设置，而是区分"在设置里关掉了"和"inbox 没能启动"。controller 令牌的提示、`send_message` 的错误、设置参考、SDK 指南和 commands 页的消息章节都改成说明"关掉"是什么样子，而不是怎么打开。

## 取舍

**不做首次提示。** 转录里一行"其它会话现在能看到本会话"需要按 home 放标记文件才能只显示一次，而且每个 scoped home 都会再来一次。文档和 `/peers` 承担解释；审查规则意味着一个可被发现的会话仍然不会执行用户没放行的任何内容。

**Windows 仍然是关的。** 那里没有自动 inbox 路径，inbox 已经能无错误地降级为"平台不支持"。默认开对这些用户没有任何改变，直到命名管道落地。

**不认识的值是关，不是开。** 此前的读取点把 `true` 之外的一切当作关，工作区排名也已经把不认识的值算作严格的一方。新默认值下保持这一点，意味着一个笔误不会意外打开一个会话。

## 文件

- `packages/cli/src/peerMessaging/enabled.ts` — 开关的唯一读取方。
- `packages/cli/src/config/settingsSchema.ts` — 默认值及描述；生成的 JSON schema 随之更新。
- `packages/cli/src/config/settingsUtils.ts` — 未设置与开同级。
- `packages/cli/src/ui/startInteractiveUI.tsx`、`packages/cli/src/acp-integration/acpAgent.ts`、`packages/cli/src/ui/commands/peers-command.ts` — 通过辅助函数读取。
- `packages/cli/src/commands/sessions/controllers.ts`、`packages/core/src/tools/send-message.ts` — 措辞。
- `docs/users/features/commands.md`、`docs/users/configuration/settings.md`、`docs/developers/sdk-typescript.md`、`packages/sdk-typescript/README.md` — 默认值，以及如何关闭。
