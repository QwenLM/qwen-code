# `/btw` 会话历史与请求生命周期

[English](2026-11-06-btw-session-history.md) | [简体中文](2026-11-06-btw-session-history.zh-CN.md)

状态：已实现，待人工验证。

## 问题

`/btw` 通过对话的单轮分叉回答旁路问题。此前的行为有以下缺口：

- 每个旁路问题都是孤立的。模型看不到之前的旁路回答，无参 `/btw` 只会报用法错误。
- 分叉只发送最近 40 条历史并去掉工具列表，请求前缀与主 agent 不同。长会话会丢上下文，
  也无法复用提示词缓存。
- 第二次 `/btw` 会取消第一次。
- 分叉忽略流式重试。重新发起请求的重试会保留失败那次的部分文本，答案可能重复一段前缀；
  远程流已经把这段文本发给了客户端。
- 交互模式下答案只在完成后显示，重试过程不可见。
- 模型试图调用工具时，结果显示为 "No response received."
- 分叉提示词没有禁止"让我查一下……"这类承诺动作的说法。

## 目标

1. 每个会话保留最多 20 条已回答的旁路问题，在之后的旁路问题中以 user/model 轮次
   追加在主对话之后。所有入口（TUI、ACP、daemon、Web Shell、channels、SDK）共享
   目标会话的历史。
2. 发送完整的 curated 历史，并保留父请求的工具声明、关闭函数调用，使分叉的前缀与主请求一致。
   对于没有 `NONE` 函数调用模式的 provider（Anthropic），改为去掉工具声明，因为保留它们会
   重新启用工具调用。
3. 旁路问题可以并发运行。只有显式取消（Esc、Ctrl+C、Ctrl+D）会中止当前显示的那个；
   切换显示其他问题不会取消。
4. TUI 中无参 `/btw` 重新打开最新的运行中问题，否则打开最新的回答，都没有才提示用法。
5. 重试重新发起请求时回退已流式输出的文本，并通过 `reset` 流事件通知远程客户端。
6. TUI：流式显示答案，显示带倒计时的重试状态，浏览之前的回答（←/→），复制答案（`c`），
   清空之前的回答（`x`）。
7. 在持续 30 秒及以上的轮次中，加载指示器提示 `/btw`，直到用户用过一次。

## 非目标

- 把旁路问题写入 transcript 或跨重启保存。
- 模态面板或新的快捷键配置。现有底部区域保持原布局。
- OpenTUI 的按键操作。OpenTUI 渲染同一个条目，因此获得流式、历史和重开，但没有浏览/复制/清空键。
- 修改 Anthropic 转换器。它没有函数调用模式 `NONE` 的映射，因此 Anthropic 上的分叉会去掉
  父请求的工具声明，而不是保留它们并让 `tool_choice` 落到默认的 `auto`。

## 设计

### Core

- `packages/core/src/agents/btw-session.ts` 新增 `BtwSession`，每个 `Config` 和会话 id 一个
  （`getBtwSession(config)`）。会话 id 变化（`/clear`、`/new`、resume）时释放旧会话并中止其请求。
- `ask(question, { signal, onText, onReset })` 发起请求并返回 `{ id, done }`。会话累积流式文本
  和重试状态，每个请求只结算一次，只有 `answered` 结果进入历史。其他结果为 `tool-call`
  （模型试图调用工具）、`empty`、`unavailable`（没有对话上下文）、`failed` 和 `cancelled`。
- `buildBtwCacheSafeParams(config, exchanges, options)` 返回 curated 历史，后接这些问答。
  默认读取最近 40 条历史（`/advisor` 的用法）；`{ fullHistory: true }` 读取完整的 curated
  历史，`runBtwQuery` 传入该选项。`buildBtwPrompt` 使用更完整的 system reminder。
- `runForkedAgent`（缓存路径）新增 `fullHistory`、`disableFunctionCalls`（保留工具的同时把
  函数调用模式设为 `NONE`）和 `onRetry`。不带 `isContinuation` 的重试会清空已累积文本。
  保留工具的分叉发出函数调用时，结果中带 `toolCallName`。

### CLI TUI

- `btwCommand` 向会话提问，并把请求交给 `ui/utils/btw-view.ts`。它订阅会话，通过现有的
  `setBtwItem` 推送派生条目。`btwAbortControllerRef` 现在归视图所有：中止它（`cancelBtw`）
  会取消仍在运行的当前请求。显示另一个请求，或用 Space/Enter 关闭，只解除订阅，不取消请求。
  即使正在浏览一条已结算的旧回答，只要视图自己的请求仍在运行，Space/Enter 也不会关闭视图。
- 输入框为空且 btw 区域可见时：←/→ 进入浏览模式并浏览之前的回答；在浏览模式中，`c` 复制
  当前答案，`x` 移除之前的回答；其他任何按键都会退出浏览模式并正常输入。底部提示只列出
  当前可用的操作。
- `TipHistory` 保存 `btwUseCount`。命令只在提示开启时计数，关闭提示的用户不会写这个文件。

### 远程入口

- ACP `/btw`、`sessionBtw` 方法和 btw 生成流都通过 `getBtwSession`。
- 生成事件新增 `{ type: 'reset' }`。bridge 客户端转发它，serve 的 btw 流清空答案快照。
  基于快照的客户端无需改动。重新发起的重试没有留下可见文本时，流会发出与 TUI 相同的
  结果提示。

## 风险

- 完整历史让每个旁路问题与主请求一样大，这是对齐缓存前缀的代价；线程化历史最多再加 20 条回答。
  超出上下文的请求会显示失败，按 `x` 可清空线程化的回答。
- 连接同一个 daemon 会话的多个客户端共享该会话的旁路问题历史。
- 按方向键会进入浏览模式，此时紧接着输入的 `c` 或 `x` 会被当作快捷键而不是普通字符。
  其他任何按键都会退出该模式，底部提示只在浏览时显示这些快捷键。没有可浏览内容时，
  方向键不会进入浏览模式。

## 验证

- 单元测试：`btw-session.test.ts`、`forkedAgent.cache.test.ts`（函数调用模式、重新发起与续接
  重试、工具调用名、完整历史）、`btwUtils.test.ts`、`btw-view.test.ts`、`btwCommand.test.ts`、
  `btw-generation.test.ts`、`btw-stream.test.ts`、`BtwMessage.test.tsx`、
  `tipHistory.test.ts`、`btw-tip.test.ts`、`bridgeClient.test.ts`。
- 人工：连续问两个旁路问题，确认第二个能引用第一个；执行无参 `/btw`；在第一个运行时发起第二个
  `/btw`；对运行中的问题按 Esc；浏览、复制和清空。

## 验收标准

1. 第二个旁路问题的请求在主对话之后包含第一个问题及其回答。
2. 无参 `/btw` 重新打开运行中的问题，否则打开最后一次回答。
3. 新的 `/btw` 不会取消仍在运行的旧问题；Esc 取消当前显示的问题且不记录。
4. 重新发起的重试不会留下失败那次的文本，本地和远程流都一样。
5. 模型只调用工具时显示工具调用提示，且不记录。
6. 在持续 30 秒及以上的轮次中，加载指示器提示 `/btw`，直到第一次使用；关闭提示时从不显示。
