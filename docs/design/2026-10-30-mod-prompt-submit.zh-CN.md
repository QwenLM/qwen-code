# Mod 提示提交

[English](2026-10-30-mod-prompt-submit.md) | [简体中文](2026-10-30-mod-prompt-submit.zh-CN.md)

状态：提议中。本阶段接在 #15443 的回合事件之后，由 #13749 跟踪。依据是 Claude Code 2.1.310 插件 API 对 `prompt.submit` 和 `$.prompt.submit` 的声明。

## 问题与现状

为 Claude Code 写的 Mod 会处理用户发出的提示：

- 守卫用 `{ drop: reason }` 拦下含有凭据的提示。
- Mod 用 `next({ ...e, text })` 改写提示，例如展开缩写。
- Mod 用 `next({ ...e, context: [...] })` 附上模型能读到、用户看不到的上下文。
- Mod 用 `$.prompt.submit` 在会话空闲后发出自己的提示。

Qwen Code 在加载时跳过 `prompt.submit` hook，并提示 `Hooks for unsupported events will not run: prompt.submit`。写在这里的守卫不会运行。

## 目标与非目标

目标，分四个 PR：

1. core 和 headless：事件本身、规则和上下文。本文随它合入。
2. Ink 终端。
3. OpenTUI 终端。
4. `$.prompt.submit`。

非目标：

- 斜杠命令。Claude Code 对它们带 `command` 触发，留到后续处理命令行的步骤。
- 不是用户输入的提示：后台通知、定时提示、队友消息、goal 续跑、中断回合的续跑。Claude Code 对其中一部分标 `isMeta`。
- 回合进行中输入、在模型边界插入当前回合的提示。
- `attachments` 和 `$.prompt.media`。

## 方案

### 1. 触发时机

用户每提交一个提示，在宿主拿到文本之后、任何地方读取它之前触发 `prompt.submit`：在 UserPromptSubmit 之前，在读取 `@` 引用之前，在记录或显示用户消息之前。只有会触发该事件的宿主才加载它的 hook；其他宿主在启动时照常跳过并给出提示，守卫不会被悄悄绕过。第 1 步在 headless 运行中触发：`-p` 的提示和 stream-json 的每条用户消息。

### 2. 输入

| 字段      | 值                                                           |
| --------- | ------------------------------------------------------------ |
| `text`    | 提交的提示，粘贴内容已展开                                   |
| `context` | 宿主触发时不带                                               |
| `wait`    | `false`                                                      |
| `origin`  | headless 为 `{ kind: 'sdk' }`；终端为 `{ kind: 'composer' }` |
| `turnId`  | 不带，直到终端为回合进行中输入的提示触发该事件               |

hook 可以把改过的 `text` 和 `context` 传给 `next`；`origin`、`wait`、`turnId` 不可改。`context` 是文本列表。

### 3. 最终提交什么

和 Claude Code 一样，提交的是穿过所有 hook 到达链底的提示：worker 记录到达链底的 `text` 和 `context`。`next(e)` 解析为它们，外加 origin。hook 在 `next` 返回之后再给出的答复不起作用。

链的结果有三种：

- 提示到达链底：带着它的文本和上下文提交；
- 某个 hook 答复 `{ drop: reason }`：提示被 hook 丢弃；
- 链没有到达链底就结束了，因为某个 hook 没调 `next` 就答复了 `{ text }`：提示没有提交，对应 Claude Code 的 `a hook answered without passing the prompt on`。

和 Claude Code 一样，调过 `next` 之后再答复 drop 的 hook 算失败：先问它的 `.catch`，否则跳过它，保留它最后一次 `next` 的结果。失败或超时的 hook 被跳过；worker 出错时提示原样通过。坏掉的插件不会拦住提示。

### 4. 改写与上下文

改写后的文本在宿主保存提示的每一处都替换掉原文：发给模型的文本、`@` 处理读取的文本、`turn.start` 的文本、transcript 记录及其显示文本。

上下文并入 core 已有的隐藏块，即追加在提示之后、存放 UserPromptSubmit `additionalContext` 的那一块，排在后者之前，转义方式相同。client 通过新的发送选项 `promptContext` 接收它，只有该提示自己的 UserQuery 会用掉它。transcript 把这一块记作 hook 上下文，因此恢复会话时它仍然隐藏，压缩时也和 UserPromptSubmit 的上下文一样保留。

### 5. 丢弃

drop 在 UserPromptSubmit 和任何模型请求之前拦下提示，不开始回合。原因只保留一行，最多 4,096 个字符，超出部分以省略号结尾，与 Claude Code 相同。headless 运行以错误结果 `Prompt dropped by a hook: <reason>`（或 `Prompt not submitted: a hook answered without passing the prompt on`）结束，退出码为 1。stream-json 会话继续处理下一条消息。

### 6. 限制

超过 Mod 负载一半（JSON 128 KiB）的提示不经过任何 hook，并在 transcript 日志出现的位置给出 `prompt.submit hook skipped: the prompt is too long for a Mod payload`。Claude Code 会完整传递。改写或上下文让 hook 的答复超过 Mod 负载时，该 hook 算失败。

## 设计决策

- **由宿主触发事件。** 每个宿主在展开或记录提示之前就已拿到提交的文本。在这里触发，改写就能先于文本的每一次使用，且不必改 core 的发送流程。
- **UserPromptSubmit 在 Mod hook 之后、在 core 里运行。** Claude Code 把两者放在同一次准入里，下层设置 hook 的拦截会让 `next(e)` 变成 `{ drop }`。这里链底不等 UserPromptSubmit：它在发送流程更靠后的位置运行，耗时取决于它的命令。需要知道 UserPromptSubmit 是否拦下提示的 Mod 可以看 `turn.start`，只有获准的提示才会触发它。
- **宿主自行声明。** 加载请求说明宿主是否触发 `prompt.submit`，就像它为 `ui.render` 列出绘制的位置一样。每一步只为它新增的宿主开启。
- **上下文共用 hook 上下文块。** 它到达模型、进入 transcript、在恢复时的处理都和 UserPromptSubmit 的上下文一致，不需要新的记录类型。会话里已有一字不差的同一块时不再发送，与 UserPromptSubmit 相同。

## 与 Claude Code 的差异

以下内容写进用户指南：

- 第 2、3 步之前，只有 headless 运行触发 `prompt.submit`。
- 斜杠命令和不是用户输入的提示不触发它，所以不会出现 `command` 和 `isMeta`。
- 不会出现 `attachments`，也没有 `$.prompt.media`。
- UserPromptSubmit 的拦截不会让 `next(e)` 变成 `{ drop }`；`next(e)` 在回合开始之前就返回。
- 会话里已有一字不差的同一上下文块时不再发送。
- 超过 JSON 128 KiB 的提示不经过任何 hook。
- headless 的 drop 是错误结果，退出码为 1。

## 验证与验收

- 真实 QuickJS worker 测试：
  - 哪些插件收到该事件，以及不触发它的宿主跳过它的 hook；
  - 到达链底的提示和上下文，以及 `next` 之后的答复不起作用；
  - hook 的 drop，以及不调 `next` 就答复的 hook；
  - 跨插件、同一插件内和恢复路径中，`next` 返回后的文本答复都保留下层 drop 的原因；被捕获的迟到 drop 不覆盖后续本地 continuation 的结果，也不把宿主 continuation 标记为已调用；
  - `next` 之后 drop、改动 `origin` 或 `wait`、上下文不是列表、答复格式错误、抛错，均被跳过；
  - 守卫失败时由 `.catch` 丢弃。
- Mod session 测试：没有 hook、origin、带上下文的改写、drop 的单行和 4,096 字符、worker 出错、提示被取消、超过负载的提示。
- client 测试：Mod 的上下文排在 UserPromptSubmit 的上下文之前并已转义；有无 UserPromptSubmit hook 两种情况；只用于新提示。
- headless 测试：改写后的提示和上下文到达发送和 `turn.start`；JSON 和文本模式下的 drop；斜杠命令和通知不触发事件。
- 构建后的 CLI 对接 fixture 服务器，在 headless JSON、文本和 stream-json 下验证：模型请求和 transcript 都是改写后的文本；上下文在隐藏块里；drop；守卫失败时由 `.catch` 丢弃。

## 风险与待定问题

- 慢 hook 会让提示延迟，最多为它的预算，每个 hook 10 秒。
- 目前遮蔽斜杠命令的参数要靠 `command.run`；带 `command` 的 `prompt.submit` 留到以后。
