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

**不做首次提示。** 转录里一行"其它会话现在能看到本会话"需要按 home 放标记文件才能只显示一次，而且每个 scoped home 都会再来一次。文档和 `/peers` 承担解释；审查规则会把其它会话发来的内容 hold 给用户决定，下面两种情况除外。

**有两类发送方不经审查就投递，默认开启后它们覆盖到了所有人。** 本会话启动的进程继承它的子进程令牌，会被当作本会话自己的消息投递：hook 或构建脚本能回报结果靠的就是这一点，文档里也写明了。审查类别 parity 比较的是发送方自己声明的类别，而这个声明没有任何认证，所以能读取注册表的同用户进程可以声称自己和接收会话同类。这两点对手动开启过的用户早就成立；默认开启把它们扩展到了从没看过这个设置的用户。两者都没有扩大边界——都需要已经以同一用户身份在 `0700`/`0600` 目录内运行的代码，而这样的代码本来就能做该用户能做的任何事——所以在这里和设置描述里记录下来，而不是加闸。把子进程令牌的导出限制为显式开启，会让默认用户失去一种文档里写明的 hook 用法。想让这类消息全部经过审查的用户，把 `agents.crossSessionInbound` 设为 `hold`。

**Windows 没有 inbox，只在被问到时才说明。** 那里没有自动 inbox 路径，inbox 降级为"平台不支持"。除非有人在自己的用户设置或本工作区设置里写了 `true`，否则启动时不提示——运维方的 system-defaults 文件不算。`/peers` 以普通信息而非错误的形式回答"本平台不支持跨会话消息"。ACP 进程在第一个托管会话得知这一点后就不再尝试绑定，不会每个会话都重试一遍。在命名管道落地之前，这些用户没有其它变化。

**不认识的值是关，不是开。** 此前的读取点把 `true` 之外的一切当作关，工作区排名也已经把不认识的值算作严格的一方。新默认值下保持这一点，意味着一个笔误不会意外打开一个会话。

## 文件

- `packages/cli/src/peerMessaging/enabled.ts` — 开关的唯一读取方。
- `packages/cli/src/config/settingsSchema.ts` — 默认值及描述；生成的 JSON schema 随之更新。
- `packages/cli/src/config/settingsUtils.ts` — 未设置与开同级。
- `packages/cli/src/ui/startInteractiveUI.tsx`、`packages/cli/src/acp-integration/acpAgent.ts`、`packages/cli/src/ui/commands/peers-command.ts` — 通过辅助函数读取。
- `packages/cli/src/commands/sessions/controllers.ts`、`packages/core/src/tools/send-message.ts` — 措辞。
- `docs/users/features/commands.md`、`docs/users/configuration/settings.md`、`docs/developers/sdk-typescript.md`、`packages/sdk-typescript/README.md` — 默认值，以及如何关闭。
