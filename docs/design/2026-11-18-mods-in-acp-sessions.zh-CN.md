# ACP 会话中的 Mod

[English](2026-11-18-mods-in-acp-sessions.md) | [简体中文](2026-11-18-mods-in-acp-sessions.zh-CN.md)

状态：已实现。本文让 Mod 在 ACP 会话（`qwen --acp`：Web Shell daemon、Zed 和 VS Code companion）中运行，在 #13749 跟踪。它是 Web Shell 绘制 Mod 改写的消息行之前的一步。

## 问题与现状

Mod 能在终端和 headless 运行中工作，ACP 会话却从不加载它们：Config 处于 ACP 模式时，Mod 会话拒绝启动。这个限制是第一批 headless Mod 命令加入时设的，当时还没有 ACP 宿主。翻译模型回复、在每轮结束时记笔记、或者调用 `$.model.complete` 的 Mod，在 Web Shell 里都不起作用。

ACP 已经为其中一种用法做了临时方案 `MessageRewriteMiddleware`（设置 `messageRewrite`）：每轮结束时用一次模型调用改写本轮文本，把结果作为一条额外消息追加。它的 README 希望换成基于 hook 的方案，Web Shell 也不绘制它的输出。

## 目标与非目标

目标：

- 打开 `experimental.mods` 的 ACP 会话加载工作区的 Mod，与终端和 headless 运行一样，经过同样的权限检查。
- Mod 能听到 `session.start` 和 `session.end`、`turn.start` 和 `turn.complete`，能调用 `$.model.complete`、`$.store`、`$.session` 的读取、`$.clock` 和 `$.turn.abort`。
- Mod 写的日志和宿主关于它的诊断，作为通知到达 ACP 客户端，daemon 把它们转发到对应会话的事件流。
- 每个会话的 Mod 相互隔离：一个会话的模型响应、turn 和日志不会到达另一个会话的 Mod。

非目标：

- 渲染站点（`ui.render`）。ACP 客户端目前都不绘制 Mod 改写。Web Shell 的投影和它的客户端能力检查是下一步。
- 工具和命令中间件（`tool.call`、`tool.check`、Mod 命令）以及 prompt（`prompt.submit`、`$.prompt.submit`），留给后续的 ACP 步骤。
- 在 Web Shell 里显示 Mod 日志，随投影一起做。
- 移除 `MessageRewriteMiddleware`。Web Shell 能绘制 Mod 改写之后再移除。

## 契约

ACP 会话是没有自己 surface 的宿主：`$.session.surface()` 返回 `null`，`$.session.surfaces()` 返回 `[]`，与 headless 运行相同。`session.start` 报告 `isInteractive: false`。因此 Mod 在 Web Shell、Zed 和 VS Code companion 下的运行方式相同。等客户端绘制 Mod 输出时再报告 surface。

ACP 宿主触发：

- Mod 加载后触发一次 `session.start`。会话关闭、进程退出或 `/clear` 替换会话时触发 `session.end`，原因与终端相同。
- 每个运行 `UserPromptSubmit` 的 prompt 触发 `turn.start` 和 `turn.complete`：新 prompt 或重试，两条 agent 循环都一样。继续、恢复的提问和 Goal 续轮不是新的 turn，不调用模型的斜杠命令也不是。定时任务和后台通知的轮次不是 prompt，什么都不触发，与终端相同。被取消的 turn 在 `turn.complete` 中报告 `aborted`，失败的报告 `error`。
- `$.model.complete` 和 `$.store` 与终端相同。`$.turn.abort` 取消正在运行的 ACP turn。

ACP 宿主不触发 `ui.render`、`prompt.submit`、`tool.call` 和 `tool.check`。加载时，hook 了其中任何一个的 Mod 会收到现有的诊断 "Hooks for unsupported events will not run: …"，`$.session.version()` 也不列出这些事件。`$.prompt.submit` 丢弃 prompt，原因是 "this host does not run prompts a Mod submits"，与现在不运行 Mod prompt 的宿主相同。因此，装了工具守卫的 Mod 会被告知它没在守卫，而不是被静默忽略。

### 日志

每条要进对话记录的 `ui.log`、`turn.complete` 返回的每条备注，以及宿主的每条诊断，都作为 ACP 扩展通知发给客户端：

```json
{
  "method": "qwen/notify/session/mod-log",
  "params": {
    "sessionId": "…",
    "plugin": "zh-display",
    "text": "translated 3 blocks"
  }
}
```

文本去掉了 ANSI 和控制字符，长度上限与 headless 运行相同（日志行 2,000 个字符，turn 备注 4,096 个字符）。只写 debug 日志的行只进 debug 日志，不发给客户端。不认识这个方法的客户端按 ACP 的要求忽略它。daemon 把它作为 `mod_log` 帧（`{ sessionId, plugin, text }`）转发到会话的事件流。不属于该 daemon 的会话的日志行会被丢弃，与它的其他通知相同。

## Qwen 的设计决策

### 每个 ACP 会话一个 Mod 会话

一个 ACP 进程承载多个会话，每个会话有自己的 Config。每个 ACP 会话拥有一个 Mod 会话，随会话创建，在它的 Config 关闭之前关闭。客户端再次 load 或 resume 一个仍在运行的会话时，沿用它的 Mod 会话，所以 `session.start` 不会触发两次。从磁盘加载的会话得到一个新的 Mod 会话。

加载 Mod 不拖慢 `newSession` 或 `loadSession`；prompt 会等加载完成后才开始 turn。Mod 加载失败时，会话用一个说明失败原因的错误拒绝每个 prompt。终端和 headless 运行同样失败即关闭，而不是在没有用户装的 Mod 的情况下继续运行。

### 宿主形态

Mod 会话在终端宿主和 headless 输出之外增加第三种宿主：ACP 宿主。它通过回调报告每条日志，不声明 surface，不触发 prompt 和工具中间件，也不碰进程的 stdout（那里承载 JSON-RPC 流）。headless 向 stdout 或 stderr 打印的路径不会为它运行。拒绝 ACP 模式的检查现在只对其他宿主生效。

加载请求增加一个标志，说明宿主是否触发工具事件：终端和 headless 宿主打开，ACP 关闭。关闭时，`tool.call` 和 `tool.check` 归入宿主可以不触发的事件，沿用现有的"跳过并写诊断"规则。

### 隔离

Mod 通过 `$.session.usage()` 读到的数字来自会话自己的 chat，而不是进程范围的遥测服务，因为后者的最近一次 prompt token 数属于最后应答的那个会话。turn 的模型只取自带有该 turn prompt id 的响应，这是 Mod 会话已有的过滤。每个 Mod 会话还把遥测服务的监听器上限加一，打开很多会话的 daemon 不会报内存泄漏警告。日志带着会话的 ACP id 发送：`/clear` 给 Config 换了新的会话 id，但不改变 ACP id。daemon 把日志发布到该会话的事件流。

### 两条 agent 循环

ACP 用自己的旧循环或共享 agent 循环运行 prompt。共享循环交给 turn 的模型事件与 headless 运行相同。旧循环读的是原始模型响应，所以宿主把每个响应中非思考的文本转成 turn 的内容，把重试或模型回退转成对应事件，把流的结束转成带用量的 finish。turn 的答案是最后一个模型响应的文本，与其他宿主相同。

## 验证与验收

单元测试：

- core 运行时（真实 QuickJS worker）：不触发工具事件的宿主跳过 `tool.call` hook 并写诊断，`$.session.version()` 不列出工具事件。
- Mod 会话：使用 ACP 宿主时在 ACP 模式下加载，不触发 prompt 和工具事件，不声明 surface，日志经宿主回调发出，不写 stderr；不在 ACP 模式时，ACP 宿主什么都不加载。进程范围的计数与会话不同时，它的上下文数字仍取自会话自己的 chat。
- ACP Mod 会话：设置关闭时不创建；日志行用会话的 ACP id 发出，`/clear` 换了 Config 的 id 之后也是；加载失败后每个 prompt 都被拒绝；旧循环的流被读成内容、重试和带用量的 finish；turn 结束时分为正常、失败或中止。
- daemon 把 `mod-log` 转发为 `mod_log` 帧，丢弃格式错误的或不属于它的。

一个集成测试用假模型服务器，通过 ACP 运行构建后的 CLI，旧循环和共享循环各跑一遍。一个 Mod hook 了 `tool.call`，在 `session.start`、`turn.start` 和 `session.end` 写日志，在 `turn.complete` 中调用 `$.model.complete`、读写 `$.store`，并用模块变量给 turn 计数。第一个会话的第二个 prompt 先读一个文件再回答，所以它的 turn 跨两个模型响应。同一进程里的两个会话各自按顺序收到诊断、自己的 `session.start`、自己的 turn 和自己的计数；`/clear` 结束第一个会话的 Mod 会话。

验收：在打开 Mod 的 ACP 会话中，Mod 的会话和 turn hook 会运行，模型调用和存储可用，日志行到达客户端和 daemon 的事件流。宿主不触发的 hook 在加载时报告。

## 风险与待定问题

- 每个加载了 Mod 的 ACP 会话都运行自己的 Mod worker 线程，guest 内存上限 64 MiB，所以 daemon 要为每个加载 Mod 的打开会话付出一个 worker。
- 旧循环的映射是对模型流的第二种读法。ACP 默认改用共享循环、旧循环移除后，它也随之移除。
- daemon 关闭时的 `session.end` 与终端有相同的结束预算。更早杀掉进程的关闭会截断它。关闭会话已在真实 `qwen serve` daemon 上手动验证（关闭返回前，`session.end` hook 已写入 `$.store`）；集成测试没有覆盖关闭和进程退出。
- `mod_log` 帧还不是 TypeScript SDK 的已知事件；Web Shell 投影会连同显示一起加上。在那之前，SDK 把每个帧转成一个未识别的 debug 块，Web Shell 不显示它；日志很多的 Mod 会占用会话事件 ring 的位置。在那之前，`experimental.mods` 也不出现在 Web Shell 的设置页中。
- 集成测试里的两个会话是先后运行的。并发 prompt 下的 turn 隔离依靠 prompt id 过滤和每个会话自己的 Config，没有并发测试覆盖。
