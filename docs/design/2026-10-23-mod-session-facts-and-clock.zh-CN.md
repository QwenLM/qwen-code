# Mod 会话信息与时钟

[English](2026-10-23-mod-session-facts-and-clock.md) | [简体中文](2026-10-23-mod-session-facts-and-clock.zh-CN.md)

状态：提议中。这是 #15270 兼容基线之后的第一个宿主 API 阶段，由 #13749 跟踪。本文以 Claude Code 2.1.309 的插件 API 声明为准；其中的会话和时钟方法自 2.1.308 以来没有变化。

## 问题与现状

Mod 的 `$` 只提供 `command.register`、`session.version` 和 `ui.log`，调用其他方法都会抛出 `Mod API not supported`。为 Claude Code 编写的 Mod 会读取会话信息和时间：

- Token Weather 是标志第一个里程碑的示例，它在 `session.start` 和每个回合之后调用 `$.session.usage()`，把上下文窗口的占用画成图表。
- Claude Code 内置的 telemetry Mod 读取 `$.session.id()`、`cwd()`、`model()` 和 `surfaces()`，并用 `$.clock.sleep()` 等待。
- Mod 用 `$.plugin.name` 标注自己的输出。

这些调用目前在 Qwen Code 里都会失败，于是这类 Mod 的 hook 失败并被跳过。

## 目标与非目标

目标：

- 用 Claude Code 的结构回答只读的会话信息和时钟，数值取自 Qwen Code 已经显示的数据。
- 每个方法和 `session.version` 一样都是 API 事件，其他插件可以观察、代为回答或拒绝。

非目标：

- `$.session.messages`、`repo`、`compact`、`send`、`append`、`authorize` 和 `identity`。
- `$.clock.after` 和 `every`，它们需要在派发结束后继续运行的工作。
- `$.session.usage` 的 `breakdown`。
- 回合事件。它们是下一个阶段；本阶段提供 `turn.complete` hook 要读取的数据。

## 提议的改动

### 1. `$.plugin`

`$.plugin.name` 是插件清单里的名称。`$.plugin.root` 是插件的绝对目录，即存放 `qwen-extension.json` 或 `.claude-plugin/plugin.json` 的目录。它们与 Claude Code 一样是普通属性，不经过中间件链。

### 2. 会话信息

除 `session.usage` 外，每个方法都是不带参数的 API 事件：

| 方法                   | 回答                                          | 在 Qwen Code 中的来源                                                      |
| ---------------------- | --------------------------------------------- | -------------------------------------------------------------------------- |
| `session.id()`         | 会话 id                                       | 当前会话；`/clear` 和 `/resume` 会改变它                                   |
| `session.cwd()`        | 会话运行所在的目录                            | 会话的目标目录                                                             |
| `session.root()`       | 会话的项目根目录                              | 同一个目标目录；进入 worktree 会同时改变两者，shell 里的 `cd` 两者都不改变 |
| `session.model()`      | 主模型的 id                                   | 当前配置的模型，即 `/model` 设置的模型                                     |
| `session.turns()`      | 记录中的用户回合数                            | 会话记录里的回合边界，`/resume`、`/rewind` 和 `/clear` 已经在维护它        |
| `session.surfaces()`   | 终端里为 `["terminal"]`，headless 运行为 `[]` | 入口                                                                       |
| `session.surface()`    | 第一个 surface，或 `null`                     | 入口；Claude Code 已将其标为弃用，但仍在声明中                             |
| `session.usage(args?)` | `{ startedAt, context, rateLimits }`          | 见下文                                                                     |

`session.usage` 返回：

- `startedAt`：会话开始的时间，单位与 `$.clock.now()` 相同，为毫秒。恢复的会话取该会话的第一条记录；`/clear` 会重新计时。用 `/branch` 创建的分支会复制父会话的记录，因此沿用父会话的开始时间，正如它的 `turns` 也包含父会话的回合。
- `context`：主对话的 `tokens`、模型的上下文窗口 `window`，以及 `percent`，取值为 0 到 100 的整数。这些就是状态栏显示的数据：上一次响应的输入 token 数，包括缓存命中的部分。第一次响应之前，`tokens` 和 `percent` 为 0。窗口大小未知时，`window` 为 0，且没有 `percent`。
- `rateLimits`：始终为空。Qwen Code 不读取速率限制窗口。
- 没有 `cost`，因为 Qwen Code 不记录费用。`args.breakdown` 和 `args.columns` 会被校验，但不计算 breakdown。

这些信息在每次派发开始时于主线程读取，随请求一起发给 worker。工具运行期间调用 `$.session.usage()` 的 hook，读到的是该次工具调用开始时的数据。工具调用期间这些数据不会变化：主对话要等工具结束后才发送下一次请求，子代理也不会更新主对话的数据。

### 3. 时钟

`$.clock.now()` 返回 worker 的当前时间，单位为自纪元起的毫秒数。

`$.clock.sleep(ms, options?)` 在 `ms` 毫秒后完成：

- `ms` 必须是有限的非负数。
- 与其他所有 `$` 调用不同，等待时间计入调用方 hook 的预算，这与 Claude Code 相同。睡眠时间超过剩余预算时，hook 会超时。
- `options.signal` 中止时，睡眠立即以拒绝结束。在 Qwen Code 中，Mod 唯一可用的 signal 是 `next.signal`，因为 QuickJS 环境不提供 `AbortController`。与 Claude Code 一样，signal 不会传到宿主一侧。
- 睡眠随发起它的 hook 一起结束。目前还不支持在派发结束后继续运行的工作，因此 hook 没有 await 的睡眠不会拖住派发。

## 设计决策

- **用快照而不是查询。** 每次派发只读取一次信息并随派发发送，而不是每次调用时由 worker 来请求。这样不需要新的消息类型，也不需要在派发中途回调主线程。每个值只是几次字段读取。hook 只会在派发中运行：工具调用、命令、`session.start` 或 `session.end`。在两次派发之间运行的定时器需要查询通道，那属于引入定时器的阶段。
- **回合数取自会话记录。** Claude Code 统计记录中的用户回合。会话记录本来就为每个用户提示保留一个边界，并排除 cron、通知、回合中途和代理消息。恢复时它会重建这些边界，回退时会裁剪，新会话会从头开始。如果改为统计模型请求次数，就会把工具续写和重试也算进去。关闭会话记录时没有记录可查，回答为 0。
- **沿用状态栏的数据。** `session.usage` 复用状态栏已经显示的数值，因此 Mod 画出的数据与状态栏一致。`percent` 按 Claude Code 的声明取整，而状态栏保留一位小数。
- **拦截。** 与 `session.version` 一样，每个新方法都从链头开始，来源是调用方插件。插件可以代为回答其中任何一个，例如在测试中冻结时间，也可以拒绝。结构不对的回答会让该 hook 失败，与其他无效回答相同。

## 与 Claude Code 的差异

以下差异会写进用户指南：

- `session.root()` 等于 `session.cwd()`。
- `session.surfaces()` 不会列出远程 surface。
- `session.usage()` 没有 `cost`，`rateLimits` 为空，也没有 `breakdown`。
- 关闭会话记录时，`session.turns()` 为 0。
- `$.clock.sleep` 只接受 `next.signal` 作为 signal。

## 验证与验收

- 真实 QuickJS worker 测试：
  - `$.plugin` 的值；
  - headless 和终端两种运行时下，从给定快照读取每项会话信息；
  - 另一个插件代为回答和拒绝每一类调用；
  - 结构不对的回答被拒绝；
  - `$.clock.now()`；
  - `$.clock.sleep()` 计入预算、让 hook 超时、因 `next.signal` 而拒绝，以及随 hook 结束。
- 针对每个方法的输入和回答的校验测试。
- 针对快照的 CLI 测试：`/clear` 之后的会话 id、恢复会话的开始时间、开启和关闭会话记录时的回合数，以及上下文数据。
- 用构建好的 CLI 在 headless JSON、Ink 和 OpenTUI 终端中检查：
  - Mod 命令输出每一项信息；
  - 两次提示之后 `turns` 为 2，`tokens` 与模型报告的输入 token 数一致；
  - `/resume` 之后，`turns` 和 `startedAt` 来自被恢复的会话。

## 风险与待定问题

- `turns()` 的回答依赖会话记录。关闭会话记录时，统计回合的 Mod 只会读到 0。
- 这些数据是快照。如果以后的阶段允许 hook 在模型请求进行中运行，就必须改为在调用时读取 `usage`。
