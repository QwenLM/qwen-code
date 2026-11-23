# 移除 MessageRewriteMiddleware

[English](2026-11-23-remove-message-rewrite-middleware.md) | [简体中文](2026-11-23-remove-message-rewrite-middleware.zh-CN.md)

状态：已实现。Mod 现在能在 Qwen Code 的各个界面改写回复和思考的显示（见 [Web Shell 中的 Mod 回复行](2026-11-18-mod-rows-in-web-shell.zh-CN.md)、[Web Shell 中的 Mod 思考行](2026-11-20-mod-thinking-rows-in-web-shell.zh-CN.md)），因此本文移除 ACP 的消息改写中间件，在 #13749 跟踪。

## 问题与现状

ACP 会话带有 `MessageRewriteMiddleware`，它是为显示改写加入的临时方案。在用户或工作区设置中写一个 `messageRewrite` 对象即可开启。每次模型回复结束时，它把这段回复的思考和回复文本连同自定义 prompt 发给另一次模型调用，再把结果作为一条带 `_meta.rewritten: true` 标记的额外 `agent_message_chunk` 追加。它的 README 自称临时方案，并希望换成基于 hook 的方案。

Mod 的 `ui.render` 站点就是那个方案，而且做得更多：

- 按块改写，只改显示，并且只改有人看到的块。
- 刷新页面时由缓存作答。
- 在 Ink、OpenTUI 终端和 Web Shell 中都能用。

相比之下，这个中间件只对认识它标记的客户端有效。Web Shell 和 SDK 从来不认这个标记。VS Code companion 把改写副本当作更多文本流式显示，channel 桥会跳过它。

保留这个中间件，每个 ACP 回合都要付出代价：

- `Session`、emitter 和历史回放器中有十多处可选调用。
- 即使中间件关闭，默认路径上也有 `await`。
- 有一个不在设置 schema 中的设置。

## 目标与非目标

目标：

- 移除中间件、它的设置读取和调用模型的改写器。
- 移除 ACP 会话、emitter 和历史回放器中的调用点。
- 移除 channel 桥对该标记的处理，这个标记只有中间件会发出。

非目标：

- 在 VS Code companion 中提供替代。Mod 行只由 Ink、OpenTUI 终端和 Web Shell 绘制。
- 把 `messageRewrite` 设置迁移成 Mod。

## 设计决策

### 直接移除

这个设置没有写进设置参考，不在设置 schema 中，默认关闭。设置文件中残留的 `messageRewrite` 键与其他未知键一样处理：debug 日志会记一行说明它被忽略。不添加迁移代码。

### 标记的消费方

channel 桥与同一安装的 CLI 一起运行：一个拉起自己的子进程，另一个连接同一安装的 daemon。它们对 `_meta.rewritten` 消息的跳过再也不会触发，所以随中间件一起移除。

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
- channel 桥测试通过。
- 调整过的九个会话测试通过，其中五个竞态测试在各自保护的检查被变异后会失败。只覆盖中间件的一个测试被删除。
- 全仓库搜索确认，除历史设计记录外，不再有对中间件、它的设置读取或改写器的引用。

验收：带有 `messageRewrite` 设置的 ACP 会话与没有该设置时运行一致，且不发送改写消息。

## 风险与待定问题

- 设置了 `messageRewrite` 的 VS Code companion 用户会失去改写摘要，在该客户端中没有替代。
- 每个 ACP 会话的回合时序会略有变化，因为被移除的 `await` 即使在中间件关闭时也会让出。完整的会话测试覆盖了这一点。
