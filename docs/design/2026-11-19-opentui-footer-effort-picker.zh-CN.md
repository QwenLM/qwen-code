# OpenTUI footer 可點擊的 reasoning effort

[English](2026-11-19-opentui-footer-effort-picker.md) | [简体中文](2026-11-19-opentui-footer-effort-picker.zh-CN.md)

- 狀態：已實作，等待審查
- 日期：2026-11-19
- 範圍：僅 OpenTUI 互動式 renderer；Ink 不變

## 問題

OpenTUI footer 已經會在模型名稱旁顯示目前的 reasoning tier（`<model> <effort>`），但 tier 只是純文字。要切換仍得記住 `/effort` 指令並手動輸入，即使同樣的 effort picker 在其他桌面 UI 只差一個點擊。

第二個問題出現在 provider entry 帶有靜態 effort knob 的模型（`generationConfig.extra_body.reasoning_effort` 或 `generationConfig.samplingParams.reasoning_effort`，可能是 flat 或 nested）。這些 raw request 值最後才合併，優先權高於 `model.reasoningEffort`。只寫 global 設定的 picker 可能回報成功，但實際 wire 與重開後仍是靜態 tier。

## 目標

- 只讓 status line 中的 tier run 可點；模型名稱與其他 status-line 內容保持不可點。
- 開啟既有 effort picker，並預選 footer 目前顯示的 tier。
- 選取結果跨 session 持久化。
- 選取後留下單一權威：移除作用中 provider entry 的靜態 effort key，避免重開後蓋過 global tier。
- 與選取自動複製共存：在 footer 拖曳選取文字不可開啟 picker。
- Ink 行為維持不變。

## 非目標

- 不新增 effort picker UI；重用既有對話框。
- 不改 provider 專屬 budget knob（`thinking_budget`、`budget_tokens`、`thinkingLevel`）；它們仍是明確的 escape hatch。
- 不寫入 operator 所有的 System/SystemDefaults 設定。
- 不處理 provider model switch 邏輯。

## 設計

### 點擊目標

`useStatusLineState` 只在 status line preset 包含 `model-with-reasoning`、顯示中的 reasoning 有 tier，且模型至少提供一個 tier 時回傳 `reasoningSegment`。Footer 在已換行的 status line 中定位該精確 segment，僅把 tier 子字串包進可點擊 box。

含有 ANSI escape 的行，或換行把 model segment 拆開的行，保持不可點。這避免切斷 escape sequence 或猜測欄位。

### 點擊與拖曳

OpenTUI 在可選取文字上按左鍵會先啟動選取並在派送 `onMouseDown` 前返回，因此無法用 mousedown 錨點區分點擊與拖曳。Footer 在 `mouseUp` 時檢查 renderer 目前的選取是否含文字：

- 空選取：視為點擊，開啟 picker
- 非空選取：可能是拖曳自動複製，不開啟

這也相容 PR 16799 的選取自動複製行為。

### Footer 開啟的 picker

Footer 以 `openedFromFooter: true` 開啟 effort 對話框。對話框：

- 以顯示路徑回報的 tier 預選，讓高亮列與 footer 一致，即使 tier 來自靜態 provider knob；
- 立即套用 tier；
- 把結果寫入 transcript，但不記錄成使用者輸入的 `/effort` 指令。

直接 `/effort` 維持原本的預選與記錄行為。

### 持久化

選取會把 `model.reasoningEffort` 寫入擁有 `modelProviders` 的 scope，並清除其他優先權更高的 writable scope 中的同名 key，與 ACP session 的 reasoning 持久化一致。

作用中的 provider entry 以 protocol + model id 定位，先比對 live base URL，再比對持久化的 `model.baseUrl`。若無法唯一識別，就跳過靜態改寫，避免動到 sibling provider。

對辨識出的 entry，從 `extra_body` 與 `samplingParams` 移除靜態 effort key（flat `reasoning_effort` 與 nested `reasoning.effort`），保留兄弟鍵。`model.generationConfig` 的全域 fallback 也以同樣方式處理。移除動作以逐路徑 `undefined` 寫入，讓 JSONC writer 產生 delete operation；整包物件寫入會被深度合併，舊 key 會留下。

Provider array 寫入沿用 provider-install adapter 的 placeholder 保留邏輯：寫檔前還原原始 `${VAR}`，避免把 env 展開後的密鑰寫進 `settings.json`。寫入使用 `throwOnWriteFailure`；持久化失敗時對話框回報錯誤，而不是成功訊息。

Live 與 registry 副本也會在目前 session 清理，避免同模型 sub-agent 在重開前繼承舊靜態 knob。

### 模型涵蓋範圍

此入口適用於有 effort tier 的模型：內建 GPT、DeepSeek、tiered Qwen 家族，以及任何宣告 `capabilities.reasoning.efforts` 的模型。Toggle-only 或沒有 reasoning 能力的模型不顯示可點目標。

## 限制與已知問題

- System/SystemDefaults 設定由 operator 擁有；其中的靜態 effort key 仍優先於持久化 tier，picker 無法改寫。
- Provider 專屬 budget knob 不會映射到 canonical ladder。
- 含 `.` 的 provider id 無法用 settings dot path 定位；其靜態 key 移除會跳過，避免破壞設定樹。
- 改寫 `modelProviders.<key>` 是整包 array 寫入；若載入到儲存之間有同一個 provider array 的並行修改，可能被覆蓋。
- Status line 為了點擊目標拆成三個 text run；rebase 到 selection-clipboard PR 後需要做一次視覺確認。
- 原始持久化錯誤以技術文字顯示，未翻譯。

## 驗證

- 目標單元測試涵蓋 segment 暴露、toggle-only 不可點、footer 預選、點擊與拖曳選取、provider entry 定位（自訂 key、live/persisted base URL、sibling 不動）、flat/nested 靜態移除、全域 `model.generationConfig` 移除、workspace tier 清除、placeholder 路徑形狀，以及失敗通知。
- PTY 端到端測試會點擊 footer tier、選擇不同 tier、確認 `model.reasoningEffort` 與 provider 靜態 knob 已移除、重新啟動 CLI，並讀回新 tier。
- `prettier`、`eslint` 與 CLI TypeScript build 通過。

## 驗收標準

- 點擊 tier 會開啟 picker；點擊其他 status-line 內容不會。
- 拖曳選取後在 tier 上放開不會開啟 picker。
- 選擇 tier 後 footer 與實際 request 設定都會更新。
- 重開後選擇的 tier 仍生效，且在 writable scope 中沒有 provider 靜態 knob 蓋過它。
- Ink 輸出與互動不變。

## 後續工作

- 為 JSONC delete 路徑補一個使用暫存真實 settings 檔的測試。
- 決定 System 所有的靜態 knob 是否要顯示使用者可見警告。
- Selection-clipboard PR 合併後，重新檢查 footer 選取複製。
