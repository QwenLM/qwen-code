# 跨 resume 保留 startup prelude

[English](./2026-11-06-resume-startup-prelude-cache.md)

**状态：** 提案
**Issue：** [#14215](https://github.com/QwenLM/qwen-code/issues/14215)、[#8277](https://github.com/QwenLM/qwen-code/issues/8277)
**相关：** [#14246](https://github.com/QwenLM/qwen-code/issues/14246)（git snapshot 移入 prelude）、[#16362](https://github.com/QwenLM/qwen-code/pull/16362)（date reminder 从 history 读取）

## 问题

resume 后的 session 送出的 prompt 前缀，与被 resume 的 session 不同。
`Client.startChat()` 会用存档历史调用 `getInitialChatHistory()`，而该函数会用
**当下**的日期、目录树、git snapshot、MCP instructions、skills、deferred tools
重新生成 startup prelude，并插在存档 turns 前面。因此第一个 user message 与前
一个 process 送出的不同。

对 implicit prefix cache（vLLM、llama.cpp）而言，可重用前缀只到第一个不同的
token。实际回报的 417k-token 对话中，vLLM 只重用约 14k tokens 的 system
prompt，接着重算约 186k tokens，TTFT 126 秒。该 session 的 transcript 第一笔
user record 是真正的 prompt，**没有存 startup prelude**，所以 resume 时无从
重播。

## 提案

把 prelude 存下来并重播。

1. `startChat()` 生成 startup prelude 时，将它写成 `system` record：
   `subtype: 'startup_context'`，`message` 为该 prelude `Content`。此 record
   会先留在内存，等 transcript 的第一条真实 record 到来时才写入：若立刻落盘，
   一个从未送出 turn 的 session 也会产生 transcript，session 列表便会把这个
   空 session 当成真实对话。
2. 还原时（`SessionApiHistoryAccumulator`）保留**最新**的
   `startup_context` record，并将它放到重建后 API history 的最前面。它不会被
   当成 user turn，也不会被算成 prompt。
3. `getInitialChatHistory()` 检测到 `extraHistory[0]` 已经是 startup prelude
   时，直接返回存档历史，不再重建。
4. `startChat()` 只在「这次有生成 prelude」时记录；resume 且已有存档 prelude
   时不重复写入。

保留最新一笔，让 `/compress` 或 auto-compaction 重建的 prelude 在下次 resume
时取代压缩前的那笔。ACP resume 会跳过 replay 后的 refresh（新的 ACP session
仍保留）；in-session 日期 refresh 与 auto-compaction 重建也会在安装新 prelude
前先记录，让下次 resume 重播「最后一次 request 实际使用」的前缀。

## Freshness 与限制

- 存下来的 prelude 会保留原始日期与 git snapshot。日期由 #16362 的
  history-derived date reminder 处理：prelude 带有 `DATE_REMINDER_METADATA`，
  日期变了会在**尾端**加 reminder。git snapshot 则刻意冻结在 session 开始时；
  模型若要最新状态可自行跑 `git status`。
- 在此变更之前建立的 session 没有 `startup_context` record。第一次 resume 仍
  会重建 prelude（一次 cache miss），并把新 prelude 记录下来，之后的 resume
  就能重用。
- Managed session 的 journal 若无法携带此 record，会退回目前的重建行为。
- 存下来的 MCP / skills / deferred-tool 清单可能过时。后续可在 request 尾端
  补 delta；本提案刻意不动前缀。
- 这与 request-tail memory catalog（#14203）及 image payload eviction
  （#15495）是不同问题；已受那些改写影响的 session 仍需各自的修正。

## 验收

- 含 `startup_context` record 的对话还原后，API history 只有一个 prelude，
  且以最新一笔为准。
- `getInitialChatHistory()` 收到存档 prelude 时，第一个 entry 与长度不变，
  不再重建日期/git snapshot。
- 新生成的 prelude 只记录一次；重播的 prelude 不会再记录。
- 只记录 startup prelude 不会建立 transcript；prelude 会在第一条真实 record
  之前写入。
- 既有 image、compression、date-reminder、rewind 测试维持绿灯。

## 其他方案

- **静态 prelude，不放日期/git status：** 改动较小，但会改变每个 session 的
  model-facing context，而且仍需要 tail reminder。
- **每轮 request-only copy：** 可保持 history immutable，但无法还原从未存过的
  prelude。
- **resume 时直接不送 prelude：** 上一个 request 有送，前缀仍会在同一位置不同。
