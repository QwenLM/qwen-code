# 移除 MessageRewriteMiddleware

[English](2026-11-23-remove-message-rewrite-middleware.md) | [简体中文](2026-11-23-remove-message-rewrite-middleware.zh-CN.md)

状态：已实现。本改动移除 ACP 消息改写中间件，在 #13749 跟踪。Mod 可以在 Ink、OpenTUI 和 Web Shell 中改写回复和思考的显示（见 [Web Shell 中的 Mod 回复行](2026-11-18-mod-rows-in-web-shell.zh-CN.md)、[Web Shell 中的 Mod 思考行](2026-11-20-mod-thinking-rows-in-web-shell.zh-CN.md)）。

## 问题与现状

ACP 会话带有 `MessageRewriteMiddleware`，它是为显示改写加入的临时方案。在用户或工作区设置中写一个 `messageRewrite` 对象即可开启。每次模型回复结束时，它把这段回复的思考和回复文本连同自定义 prompt 发给另一次模型调用，再把结果作为一条带 `_meta.rewritten: true` 标记的额外 `agent_message_chunk` 追加。它的 README 自称临时方案，并希望换成基于 hook 的方案。

Mod 的 `ui.render` 站点就是那个方案，而且做得更多：

- 按块改写，只改显示，并且只改有人看到的块。
- 刷新页面时由缓存作答。
- 在 Ink、OpenTUI 终端和 Web Shell 中都能用。

旧版 ACP 把改写结果作为带有额外 metadata 的普通文本块发送。Web Shell 和 SDK 无需识别标记，也能把它作为额外的回复文本消费。VS Code companion 也会流式显示这段文本，并用标记避免重复保存通知。channel 桥用标记跳过改写后的后台回复。

保留这个中间件，每个 ACP 回合都要付出代价：

- `Session`、emitter 和历史回放器中有十多处可选调用。
- 即使中间件关闭，默认路径上也有 `await`。
- 有一个不在设置 schema 中的设置。

## 目标与非目标

目标：

- 移除中间件、它的设置读取和调用模型的改写器。
- 移除 ACP 会话、emitter 和历史回放器中的调用点。
- 兼容旧版 ACP 会话发出的改写后台回复。

非目标：

- 在 VS Code companion 或 Zed 中渲染 Mod。
- 把 `messageRewrite` 设置迁移成 Mod。

## 设计决策

### 直接移除

中间件的 README 介绍过这个设置。它未收录在设置参考和 schema 中，默认关闭。新版 CLI 会忽略残留的 `messageRewrite` 键。会报告未知设置的启动路径会像处理其他未知键一样处理它。

### 标记的消费方

两个 channel 桥都保留对带有 `_meta.rewritten` 标记的独立后台回复的过滤。原地升级后，daemon 可以重载 channel worker，同时旧版 ACP 会话仍然存活。独立运行的桥也可以指定旧版 CLI 的入口路径。过滤可避免聊天收到重复回复，并保护 daemon 桥按任务收集的原始结果。

VS Code companion 单独发布，可能连接较旧的 CLI，因此保留它的处理，只把注释改为说明较旧的 CLI 才会发出这个标记。

### 会话时序

被移除的调用中有五处即使没有安装中间件也会被 `await`，所以每个回合都会在那里让出一次。五个会话测试曾把中间件的等待当作暂停点，在那一刻插入取消或一个更新的 prompt。现在每个测试都改为在同一路径的下一个真实步骤暂停：

- 保存已结束批次或停止提示的历史写入；
- 模型回复流的结束。

变异检查确认，去掉各自保护的检查后，这些测试仍会失败：

- 抛出循环保护错误前的取消检查；
- 工具阶段的清除；
- 感知中止的停止原因；
- Stop 循环开始时的取消检查；
- 重置较新 prompt 状态前的归属检查。

### 名称

`Session.installRewriter` 现在只加载会话的 Mod，因此改名为 `installMods`。

## 验证与验收

- CLI、bridge 和 channel 包的类型检查通过。
- 完整的 ACP 会话测试文件和 ACP agent 测试通过。
- channel 桥测试覆盖旧版改写块，包括重复投递和按任务选择结果。
- 调整过的九个会话测试通过，其中五个竞态测试在各自保护的检查被变异后会失败。只覆盖中间件的一个测试被删除。
- 新版 CLI 不再调用中间件、它的设置读取器或改写器。

验收：新版 ACP 会话无论是否配置 `messageRewrite` 都运行一致，且不发送改写消息。channel 桥跳过旧版会话发出的改写后台回复。

## 风险与待定问题

- 启用过 `messageRewrite` 的用户在原先会显示这些附加摘要的 ACP 客户端中将看不到它们，包括 Web Shell 和 VS Code companion。Ink、OpenTUI 和 Web Shell 支持 Mod 显示改写。
- 每个 ACP 会话的回合时序会略有变化，因为被移除的 `await` 即使在中间件关闭时也会让出。完整的会话测试覆盖了这一点。
