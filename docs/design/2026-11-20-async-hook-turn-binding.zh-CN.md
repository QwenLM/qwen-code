# 把异步 hook 输出的消费绑定到被接纳的轮次

[English](2026-11-20-async-hook-turn-binding.md) | [简体中文](2026-11-20-async-hook-turn-binding.zh-CN.md)

- **状态**：本改动提出。闭合 `LlmClient` 路径上异步 hook 的「已消费未送达」窗口（能力台账 L11 follow-up，#17284 R1-2 项）：drain 之后、请求送达之前退出的轮次不再丢失待交付块，Retry 会重附它。
- **日期**：2026-11-20，基于 `main` `83f4a903241c`。
- **相关**：[异步 hook 输出交付](2026-11-16-async-hook-output-delivery.zh-CN.md)（#17477，本改动加固的 drain）；[ACP legacy 交付](2026-11-20-acp-legacy-async-hook-delivery.zh-CN.md)（#17890，其 wrapper 已在发送前早退之后 drain）；follow-up 台账 #17284（R1-2）。

## 缺陷

异步 drain 是取走即清空，且在 `LlmClient` 请求组装处、send 上游运行。任何在 drain 之后、请求到达 provider 之前退出的轮次，都会消费该块却不交付，而 registry 已被清空，事后无旁证。现实窗口按序：

1. **ToolResult 结果感知 loop detection** 在 drain 之后、`turn.run` 之前返回该轮——块被清空、从未进入 history（永久丢失）。
2. **失败 attempt 后的 Retry**：首个 attempt drain 了块并 push 进进程内 history；provider 随后失败；Retry 剥掉那条含块的孤儿 history entry、并从调用方原始 parts（不含块）重建，于是块在 history 与 wire 双双丢失。
3. **drain 与 send 之间的抛出**（initial-memory recall、ToolResult microcompact、tool-result memory）或消费者弃流。
4. **chat 侧 push 前退出**（managed-session block、需订阅登录、hard-rescue 仍超限、setup-error 回滚），在 `turn.run` 之后、history push 之前。

push 之后的 provider 失败本身**不是**丢失：块留在进程内 history、随下一请求送达——只有 Retry strip（窗口 2）会移除它。

## 决策

把 drain 移到紧邻 `turn.run` 之前，并用 history-push 快照（而非 prompt id）结算残余窗口。

- **为何不按 prompt id 保留**：主 Retry 通路（TUI Ctrl+Y）mint 新 prompt id 且不传 `historyPromptId`，故按 prompt id 键控的保留无法把失败 attempt 与其 Retry 关联。可靠的关联信号是 history-push 快照与被剥的 Retry entries 本身。
- **为何不在 chat 内（紧贴 provider）drain**：压缩阈值在 push 前估算组装后请求（含异步块）；更晚 drain 会破坏该不变量、history-push 语义，以及全部现有调用点见证（其 mock 了 `Turn.run`）。
- **插入点**：把 gate + drain + append 从请求组装处移到紧邻 `turn.run` 之前（goal-event yield 与 message-display 构造之后、push-snapshot source 赋值之前）。所有权门原样随行（同作用域）。这一步零键控成本地消灭窗口 1 与 3，并保持压缩阈值、gate 语义、全部现有见证完好。尾部回执检测改用 `isUserPromptSubmitContextPartText` 读最终消息形状（ACP wrapper 的写法），不再依赖组装期的 `appendedHookContext` 布尔。
- **push 前结算（窗口 4）**：把 drained part 暂存 client 字段；在 send 的 `finally` 里按 history-push 快照结算——push 未落地则保留该 part，交给下一次 drain-eligible send 在新 drain 点重附（重附前重新过所有权门）。push 已落地则该 part 已在 history，不得重附（push 后失败随下一请求送达）。
- **Retry 重附（窗口 2）**：在既有的从被剥 Retry entries 保留日期提醒 / workflow envelope 旁，识别被剥 entries 中的异步信封 part 并重附。被剥即 history 已无副本，故重附不会双份交付；它与 restore 路径互斥。
- **顺序说明**：drain 后移使 ToolResult 轮上异步块落在 exploration/loop reminder 与 tool-result memory 之后（现在在其前）。现有见证只要求块在 `functionResponse` parts 之后，仍成立；wire 顺序变化在此明示。ToolResult 的 size-only microcompact checkpoint 也在新 drain 点之前估算 `requestToSend`（组装处的旧 drain 曾先于它），故其尺寸估算不再计入异步块；该块受大小上限（#17736）约束，而 chat 在 `turn.run` 内自身的压缩阈值仍在 push 前估算含块的已 drain 请求。

## 范围

- **在内**：drain 后移 + 尾部回执检测、push 前结算、Retry 重附、各窗口调用点见证、本设计文档。所有权门、大小上限（#17736）、线上顺序分类器、仅进程内持久化边界均不变。
- **在外（follow-up，#17284）**：ACP legacy wrapper 已在发送前早退之后 drain（#17890）；其自身残余窗口与显示投影 / resume 溯源项仍独立。压缩 checkpoint 对块的持久化是预存在的，不变。

## 验证

`client.test.ts` 调用点见证（真实 `AsyncHookRegistry`、mock `Turn.run`）：现有 12 条交付/所有权见证保持绿；4 条新见证钉住 (a) ToolResult loop-detection 退出后块仍 pending、下一 send 送达；(b) Retry 从被剥的孤儿 entry 找回块并恰好重附一次，且把块从该 entry 移除、使 restore 路径不会重附第二份；(c) chat 侧 push 前抛出后块留给下一 send、不双份；(d) 保留的块不被带闸的侧问 send 消费。变异见证：整文件回退到改动前实现使 4 条新见证全红、12 条现有见证保持绿；禁用 Retry 找回使 Retry 见证转红；强制结算把每次 send 都当作已 push（从不保留）恰使两条 push 前保留见证转红。改动文件 `prettier`/`eslint` 干净；改动文件通过类型检查（以 CI 的 frozen-lockfile 构建为权威）。
