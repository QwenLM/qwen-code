# 立即发送回合中排队的消息

[English](2026-10-08-send-mid-turn-messages-now.md) | [简体中文](2026-10-08-send-mid-turn-messages-now.zh-CN.md)

状态：已实现。

## 问题

回合运行期间用户输入的消息走 `POST /session/:id/mid-turn-message`。daemon 把它
放进 `SessionEntry.midTurnMessageQueue`，ACP 子进程只在一个工具批次结束后或 Stop
检查时，才通过 `craft/drainMidTurnQueue` 取走它。因此消息要等正在流式输出的模型
回复结束，再等这次回复的工具批次结束。如果这次回复是纯文本回答，消息要等整段
回答结束后才作为新 prompt 执行。

使用 `qwen serve`、Web Shell 和脚本化 provider 实测（时间从插入算到携带该消息
的请求发出）：

| 插入时的状态                       | 延迟   | 在等什么                 |
| ---------------------------------- | ------ | ------------------------ |
| 模型流式输出 10 s 回答，无工具调用 | 8.3 s  | 回答结束，然后转为新回合 |
| 模型流式输出 6 s，随后一个快速工具 | 5.1 s  | 回复和工具               |
| 短步骤（1.5 s 回复，1 s 工具）     | 1.35 s | 下一个工具边界           |
| 第一个 token 之前静默 5 s          | 3.9 s  | 回复                     |
| 一条 8 s 的 shell 命令正在执行     | 6.1 s  | 命令结束                 |

daemon 和浏览器本身几乎不增加延迟：POST 在 2–4 ms 内返回，drain 到下一个请求
发出用时 10–50 ms。真实模型的一次回复可能流式输出数十秒，紧急的纠正没有快速
通道。唯一的办法是 Stop，但它会结束回合并取消正在运行的工具。

## 参考

- Claude Code：Enter 把消息放进队列，消息在下一个工具边界并入当前回合。另有
  一个“立即发送”键（Ctrl+Enter），会打断回合并立即执行消息；能挪到后台的
  shell 会先挪到后台。有一个可选模式把 Enter 改成打断。
- Codex：Enter 把消息 steer 进正在运行的回合，`instant_interrupt` 默认开启时会
  取消正在流式输出的回复；Tab 把消息排到回合结束之后。

默认行为保持不变：补充上下文的消息不应截断长回答或大的工具调用，排队行在送达
前也应可以编辑。打断改为显式操作。

## 目标与范围

- 回合中输入的消息仍在工具边界送达，行为不变。
- “立即发送”在前台回合流式输出模型回复时，让排队的消息在一次往返内送达。
- 正在运行的工具永远不被打断；工具结果与消息一起发出。

不在范围内：channel 回合（每个回复块在结束时投递）、cron 和后台通知回合，以及
输入框快捷键。Web Shell 目前把 Ctrl/Cmd+Enter 绑定为换行。

## 设计

### daemon

`POST /session/:id/mid-turn-messages/send-now`（能力标记
`session_mid_turn_send_now`）调用 bridge 的 `sendMidTurnMessagesNow`。它像其他
mid-turn 路由一样校验客户端。队列里有用户消息时，它向 agent 发送
`MID_TURN_SEND_NOW_METHOD`（`craft/midTurnSendNow`，参数 `{ sessionId }`），不
等待结果，返回 `{ requested: true }`；否则返回 `{ requested: false }`。只有
queue-only 的 steering 消息时不算，因为它们不归用户发送；agent 为立即发送发出的
drain（带 `userInputOnly: true` 的 `craft/drainMidTurnQueue`）也不会取走它们。
它们随下一次模型请求发出（截断之后就是同一回合的下一次请求）；如果回合先结束，
则走调用方依赖的回合结束处理。这个请求只是提示：
不认识该方法的 agent 返回 `-32601`，队列仍会在下一个工具边界被取走。

### agent

`acpAgent` 把请求转给 `Session.sendMidTurnInputNow()`，后者为正在运行的回合
记下这个请求，并唤醒当前可被打断的回复。`#openResponseInterrupt` 为前台、非 channel 回合的主
prompt 循环和 Stop 续跑中的每次模型回复开启打断能力：

1. 发送时使用的 signal 组合了回合的 signal 与每次回复各自的 controller，模型流
   通过 `watch` 读取。
2. 流处于打开状态、还没有开始工具调用、且其所在回合记有请求时，通过现有的
   drain 请求为用户消息发出一次提前 drain。取到的消息放进之后每次 drain 都会先
   读取的缓冲区（`midTurnRecoveredMessages`）。如果这次 drain 超时、宿主在回复仍在
   流式输出时才回复，迟到的回复按同样方式处理。
3. 只有当 drain 取到了输入、回复仍处于打开状态、并且还没有开始工具调用（无论
   调用已完整产出，还是参数仍在流式生成）时，controller 才以
   `MID_TURN_INPUT_ABORT_REASON` 中止。LlmChat 按取消处理：已经输出的部分保留在
   历史和 transcript 中。`watch` 吸收这次中止，并像流正常结束一样结束。
4. 对于没有 function call 的回复，`takeInput` 会等待仍在进行中的提前 drain；只有
   本次回复的 drain 取到了输入时，才取出缓冲区和队列中的内容，返回要发送的用户
   消息，循环在同一回合内发送它。回复被打断时，消息带有前缀
   `[User message received while you were responding; your response was interrupted]`；
   回复已经结束时，前缀是 `[User message received while you were responding]`。
   其他情况下仍和以前一样，在下一个工具边界送达。此时如果回合已被停止，就不再
   从宿主取走任何输入，仍在排队的消息由宿主转为新回合。
5. 如果回合在发送提前 drain 取到的输入之前被取消或失败，回合结束时会把这些输入
   记入对话和 transcript，与工具运行被停止时保留宿主已交出的输入的做法一致。

### Web Shell

daemon 声明该能力时，daemon 已接管的 mid-turn 排队行在删除、编辑旁边显示
“立即发送”。它通过 SDK 的 `sendMidTurnMessagesNow` 调用路由（使用 session
客户端；会话切换后恢复的行则用 daemon 客户端和该会话持久化的 client id），之后
排队行照常在收到 `mid_turn_message_injected` 时消失。

### 决策

- **显式操作，而非默认。** Enter 保留编辑窗口，也不会因为一句补充截断回复；
  消息是否紧急由用户决定。
- **作用于整个会话。** drain 会取走整个队列，所以在某一行点“立即发送”会按顺序
  送出队列里所有等待的消息。
- **先 drain 再中止。** 先中止可能导致没有内容可发：消息可能已经不在了（被删除，
  或被另一次 drain 取走），回合会以被截断的回答结束。先 drain 使多余的请求只多
  一次内存中的往返，并且永远不会白白截断回复。
- **工具调用开始后不打断。** 已经开始工具调用的回复继续运行，即使调用参数仍在
  流式生成；队列留在宿主那里。之后边界 drain 会把消息随工具结果一起送出；如果
  某个工具结束了回合，宿主会像以前一样把消息转为下一个 prompt。不会留下没有结果
  的工具调用，也不会丢弃 provider 已经宣告的调用。
- **限定在当前回合。** 请求绑定到它到达时所在的回合。每次发出 drain 请求时都会
  清除它（该请求会取走之前排队的全部内容）；该回合结束时，无论是正常完成、失败
  还是被停止，也会清除。回合之间到达的请求会被忽略。因此一个本回合没来得及处理
  的请求，不会让之后用普通 Enter 输入的消息截断后续回合的回复。
- **取走的输入不会滞留。** 宿主一旦交出排队的输入，用户就会看到它已送达，宿主也
  不会再把它转为新回合。被取消或失败的回合已取走但没发出的输入，会保留在该回合
  的对话中，不会被丢弃。只有超时、且在它要打断的回复结束后才得到回复的 drain，
  会走现有的迟到恢复路径，在下一个工具边界送达。
- **保留部分输出。** 被截断的文本保留在 transcript（Web Shell 把它显示在该回合
  折叠的处理过程中）和上下文中，模型可以接着写或改变方向。如果在第一个 token
  之前就被打断，历史中会出现连续两段用户内容；已验证 OpenAI 兼容请求会把它们
  作为一条用户消息发送。

## 兼容性

- 新 Web Shell、旧 daemon：没有该能力标记，不显示“立即发送”。
- 新 daemon、旧 agent：请求以 `-32601` 失败并被忽略，投递仍在工具边界。
- 桌面端 ACP 客户端和独立的 channels 宿主用各自的队列响应 drain，不会发送该
  请求，行为不变。

## 验证

- 单元测试：`Session.test.ts` 覆盖被截断的回复在同一回合内得到回应；请求遇到
  空队列；回复已经调用工具、工具调用参数仍在流式生成、drain 在途时才开始工具
  调用，或者工具结束了回合；drain 在回复结束后才返回；超时的立即发送 drain 在
  回复进行中、回复结束后和回合结束后才回复；从超时的 drain 恢复的输入；Stop hook
  续跑；channel 回合及其 Stop 续跑；drain 在途时重复收到请求；工具边界的 drain
  等待提前 drain；回合被取消时保留已取走的输入；回合被停止后不再 drain；回合之间
  的请求；本回合没来得及处理的请求；以及被停止的回合遗留的请求。
  `acpAgent.test.ts` 覆盖请求路由。`bridge.test.ts` 覆盖只输入消息时不发送请求、
  只有在用户消息等待时立即发送才发出请求、立即发送的 drain 不取走 queue-only
  steering，以及客户端校验。`server.test.ts` 和 `multi-workspace-sessions.test.ts`
  覆盖路由及其按 owner 的转发，SDK 测试覆盖两个客户端，Web Shell 测试覆盖排队行
  按钮、它在主应用和 chat pane 中的接线、hook 和 session action。去掉上述决策
  背后 agent 端的任何一道保护都会让测试失败，只有回合绑定与回合结束时的清除互为
  备份：两者同时去掉会让两个测试失败。
- 端到端，使用与上文相同的测试环境；按 Enter 后立刻点“立即发送”：

| 插入时的状态              | 只按 Enter | 立即发送 |
| ------------------------- | ---------- | -------- |
| 10 s 回答正在流式输出     | 8.3 s      | 14 ms    |
| 快速工具之前的 6 s 回复   | 5.1 s      | 10 ms    |
| 短步骤                    | 1.35 s     | 10 ms    |
| 第一个 token 之前静默 5 s | 3.9 s      | 11 ms    |
| 8 s 的 shell 命令正在执行 | 6.1 s      | 6.1 s    |

在 Web Shell 中，输入的消息保持排队并显示“立即发送”，点击后 44 ms 到达模型。
被打断后的请求带着作为 assistant 消息的部分回答，后面是加了前缀的用户消息；
重新加载后 transcript 仍保持这个顺序。

## 风险

- 被打断的回复仍按已产出的 token 计费，下一次请求会重新发送上下文。立即发送是
  用户的显式操作，prompt 缓存也让重新发送的成本较低。
- 工具运行期间点“立即发送”，在工具结束前看不到效果。Claude Code 在这种情况下
  会把正在运行的 shell 挪到后台，这一点留待以后。
- 只有在 provider 宣告了工具调用之后才能识别它。provider 流式输出工具调用参数
  却不带调用 id、只在参数完整后才宣告调用（目前的 OpenAI Responses 路径），或者
  模型以文本形式写工具调用时，写到一半的调用仍可能被截断。
- 如果 drain 已经发出时恰好开始了一个工具调用，而这个工具又结束了回合，在这个
  很窄的窗口里，取走的输入会保留在对话和 transcript 中，但不会在该回合得到回答。
