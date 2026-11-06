# 跨 resume 保留 startup prelude

[English](./2026-11-06-resume-startup-prelude-cache.md)

**狀態：** 提案
**Issue：** [#14215](https://github.com/QwenLM/qwen-code/issues/14215)、[#8277](https://github.com/QwenLM/qwen-code/issues/8277)
**相關：** [#14246](https://github.com/QwenLM/qwen-code/issues/14246)（git snapshot 移入 prelude）、[#16362](https://github.com/QwenLM/qwen-code/pull/16362)（date reminder 從 history 讀取）

## 問題

resume 後的 session 送出的 prompt 前綴，與被 resume 的 session 不同。
`Client.startChat()` 會用存檔歷史呼叫 `getInitialChatHistory()`，而該函式會用
**當下**的日期、目錄樹、git snapshot、MCP instructions、skills、deferred tools
重新產生 startup prelude，並插在存檔 turns 前面。因此第一個 user message 與前一
個 process 送出的不同。

對 implicit prefix cache（vLLM、llama.cpp）而言，可重用前綴只到第一個不同的
token。實際回報的 417k-token 對話中，vLLM 只重用約 14k tokens 的 system
prompt，接著重算約 186k tokens，TTFT 126 秒。該 session 的 transcript 第一筆
user record 是真正的 prompt，**沒有存 startup prelude**，所以 resume 時無從
重播。

## 提案

把 prelude 存下來並重播。

1. `startChat()` 產生 startup prelude 時，將它寫成 `system` record：
   `subtype: 'startup_context'`，`message` 為該 prelude `Content`。
2. 還原時（`SessionApiHistoryAccumulator`）保留**最新**的
   `startup_context` record，並將它放到重建後 API history 的最前面。它不會被
   當成 user turn，也不會被算成 prompt。
3. `getInitialChatHistory()` 偵測到 `extraHistory[0]` 已經是 startup prelude
   時，直接回傳存檔歷史，不再重建。
4. `startChat()` 只在「這次有產生 prelude」時記錄；resume 且已有存檔 prelude
   時不重複寫入。

保留最新一筆，讓 `/compress` 或 auto-compaction 重建的 prelude 在下次 resume
時取代壓縮前的那筆。ACP resume 會跳過 replay 後的 refresh（新的 ACP session
仍保留）；in-session 日期 refresh 與 auto-compaction 重建也會在安裝新 prelude
前先記錄，讓下次 resume 重播「最後一次 request 實際使用」的前綴。

## Freshness 與限制

- 存下來的 prelude 會保留原始日期與 git snapshot。日期由 #16362 的
  history-derived date reminder 處理：prelude 帶有 `DATE_REMINDER_METADATA`，
  日期變了會在**尾端**加 reminder。git snapshot 則刻意凍結在 session 開始時；
  模型若要最新狀態可自行跑 `git status`。
- 在此變更之前建立的 session 沒有 `startup_context` record。第一次 resume 仍
  會重建 prelude（一次 cache miss），並把新 prelude 記錄下來，之後的 resume
  就能重用。
- Managed session 的 journal 若無法攜帶此 record，會退回目前的重建行為。
- 存下來的 MCP / skills / deferred-tool 清單可能過時。後續可在 request 尾端
  補 delta；本提案刻意不動前綴。
- 這與 request-tail memory catalog（#14203）及 image payload eviction
  （#15495）是不同問題；已受那些改寫影響的 session 仍需各自的修正。

## 驗收

- 含 `startup_context` record 的對話還原後，API history 只有一個 prelude，
  且以最新一筆為準。
- `getInitialChatHistory()` 收到存檔 prelude 時，第一個 entry 與長度不變，
  不再重建日期/git snapshot。
- 新產生的 prelude 只記錄一次；重播的 prelude 不會再記錄。
- 既有 image、compression、date-reminder、rewind 測試維持綠燈。

## 其他方案

- **靜態 prelude，不放日期/git status：** 改動較小，但會改變每個 session 的
  model-facing context，而且仍需要 tail reminder。
- **每輪 request-only copy：** 可保持 history immutable，但無法還原從未存過的
  prelude。
- **resume 時直接不送 prelude：** 上一個 request 有送，前綴仍會在同一位置不同。
