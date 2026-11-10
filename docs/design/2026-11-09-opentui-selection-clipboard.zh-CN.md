# OpenTUI 選取複製、右鍵貼上與 scrollbar 顯示

[English](2026-11-09-opentui-selection-clipboard.md) | [简体中文](2026-11-09-opentui-selection-clipboard.zh-CN.md)

狀態：提案中
日期：2026-11-09

## 問題

OpenTUI 的文字選取目前只會反白。放開滑鼠不會複製、右鍵沒有反應，而且原生
scrollbar 一直佔用一欄。使用者期望的操作是：

- 完成任何 OpenTUI 區域（對話、footer、composer、dialog）的選取後自動複製；
- 在畫面任一處按右鍵（沒有對話選取時），把剪貼簿貼進 composer；
- 有對話選取時按右鍵，取消選取；
- PageUp/PageDown 與 Ctrl+Home/Ctrl+End 可在對話中移動；
- 對話不在尾部時顯示 **Jump to bottom** 提示；
- 可隱藏對話 scrollbar 以換取一欄空間。

Ink 已有自己的選取與右鍵選單；本次定義 OpenTUI 的行為，而不是複製 Ink
的選單模型。

## 目標

- 任何 OpenTUI 區域完成選取後都會複製到剪貼簿，選取維持反白。
- 複製成功後在右下角短暫顯示 `Copied N chars` 確認訊息。
- 在畫面任一處按右鍵：有對話選取時取消該選取。
- 在畫面任一處按右鍵：沒有選取時執行 composer 的 Ctrl+V 剪貼簿路徑（先處理
  圖片，再退回文字）。
- PageUp/PageDown 以一個視窗頁捲動；Ctrl+Home/Ctrl+End 跳到兩端；離開底部
  時顯示可跳至底部的提示。
- 原生 OpenTUI 對話 scrollbar 預設隱藏；明確設定
  `ui.showOpenTuiScrollbar: true` 才恢復 OpenTUI 原本的自動隱藏 bar。
- 行為拆成小型模組與測試，不塞進 app shell。

## 非目標

- 不提供應用程式內右鍵選單；連結、程式碼區塊、Select All 等操作不在本次範圍。
- 終端機原生 Shift+拖曳選取對應用程式不可見，應用程式不會自動複製它；該
  情況下右鍵仍由終端機處理。
- 已被虛擬化對話卸載的歷史無法複製。
- 不改動 Ink 現有的選取與右鍵行為。

## 設計方案

### 模組結構

| 檔案                                       | 職責                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `renderable-tree.ts`                       | `isRenderableWithin()`：把右鍵策略的選取範圍限定在對話區。                                                   |
| `selection-auto-copy.ts`                   | `useSelectionAutoCopy()`：複製任何非空的 OpenTUI 選取並回報成功。                                            |
| `copy-notice.tsx`                          | 右下角短暫顯示的 `Copied N chars` 確認訊息，兩秒後消失。                                                     |
| `transcript-mouse.ts`                      | `handleTranscriptRightClick()`：純右鍵策略（取消選取或貼上）。                                               |
| `scrollbar-visibility.ts`                  | `openTuiScrollbarOptions()`：把設定映射成 `{ visible: false }` 或 `undefined`（交給 OpenTUI 自動隱藏）。     |
| `native-clipboard.ts`                      | 原生剪貼簿橋接：寫入一律 Node 子程序；讀取先用 in-process addon，失敗才走 child。含 Windows/macOS 文字讀取。 |
| `jump-to-bottom-hint.tsx`                  | 既有的尾部判斷與浮動提示。                                                                                   |
| `input-submission.ts` / `input-prompt.tsx` | Composer handle 新增 `pasteClipboard()`，執行既有 Ctrl+V 路徑。                                              |

### 行為

1. 滑鼠選取完成時，OpenTUI 發出 `selection` 事件。Hook 會複製任何非空的
   選取文字，不檢查選取範圍：footer、composer、dialog 與其他區域都包含在
   內。選取維持反白；成功後 app shell 在右下角顯示兩秒的
   `Copied N chars` 訊息。jump hint 隱藏時訊息使用最底下那一列；hint 出現時
   訊息往上移一列，讓底部提示永遠從底部開始堆疊，而不是固定空出一列。
   剪貼簿寫入失敗時保持靜默。
2. 只有在沒有 dialog、approval modal、tool confirmation 時，才攔截右鍵。處理
   器同時掛在根 box 與對話 scrollbox 上；scrollbox 會停止事件冒泡，避免同一
   次點擊處理兩遍。若有範圍內的選取，`handleTranscriptRightClick()` 會取消
   它；否則呼叫 `composerHandle.current.pasteClipboard()`。對話項目的點擊
   handler（thinking block、tool card）會檢查左鍵，避免對應的右鍵放開事件
   在貼上後又切換卡片。
3. `pasteClipboard()` 交給 composer 既有的 Ctrl+V handler：先圖片、再文字，
   沿用貼上摺疊與提示。
4. PageUp/PageDown 使用 `ScrollBoxRenderable.scrollBy(±1, 'viewport')`。
   Ctrl+Home/Ctrl+End 使用 `scrollTo(0)` / `scrollTo(scrollHeight)`。前景
   shell、dialog 或 confirmation 擁有輸入時忽略。
5. Jump-to-bottom 提示訂閱 scrollbar 的 `change` 事件，並在每次 render 後
   重新檢查（串流成長）。它會把顯示狀態回報給 shell，讓 copy toast 疊在
   上方。dialog、confirmation、完成清單開啟時不掛載。
6. 對話 scrollbox 收到
   `scrollbarOptions={openTuiScrollbarOptions(settings.merged.ui?.showOpenTuiScrollbar)}`。
   未設定／false 隱藏；true 時留 undefined，讓 OpenTUI 保持自己的自動隱藏
   行為。
7. Linux 寫入走共用 `copyToClipboard()`：
   `wl-copy` → `xclip` → `xsel` → native `@teddyzhu/clipboard` addon →
   OSC 52。原生寫入一律在 Node 子程序中執行，即使 addon 可在本程序載入：
   clipboard-rs 在替換 X11 擁有者時會把
   `Somebody else owns the clipboard now` 之類的診斷**印到 stdout**，而 TUI
   的 stdout 就是 alternate screen，訊息會直接蓋在 composer 那一列。子程序的
   stdout 是 pipe，不會碰到畫面。子程序在 `setClipboardText()` 後多存活
   150ms，讓作業系統剪貼簿管理員完成接手；立即結束會讓下一次讀取拿到空字串。
   讀取優先在目前程序使用 addon，失敗才退回子程序。Node 路徑優先取
   `QWEN_NODE_BINARY`（npm Bun handoff 設定）或 `NVM_BIN`，因為 snap Bun
   的 PATH 可能沒有 nvm。右鍵貼上的讀取在沒有 `wl-paste`/`xclip` 時也走同一
   addon fallback。讀取會重試 addon 暫時性的
   `Somebody else owns the clipboard now` 佔用錯誤，並把這個字串從讀取結果與
   composer 提示路徑中濾掉，避免它被貼上或顯示成文字。讀取 helper 會用
   marker 框住 payload，native 印到 stdout 的診斷會被丟棄；超過上限的內容
   會整筆放棄，不會貼上被截斷的字串。

### 平台差異

- **macOS**：寫入使用內建 `pbcopy`；`readClipboardText()` 現在會透過
  `@teddyzhu/clipboard` 讀取文字，因此 OpenTUI 在 macOS 上也能右鍵貼上文字。
  npm 套件已包含 arm64/x64 的 Bun、`libopentui.dylib` 與 clipboard addon。
- **Windows**：寫入使用 `cmd /c chcp 65001 && clip`；文字與圖片讀取走 addon，
  `win32-x64-msvc`、`win32-arm64-msvc` 都已宣告。OpenTUI 的 npm 封裝仍待補：
  Bun 只有 `@oven/bun-windows-x64`（沒有 Windows ARM64），npm handoff 也還沒
  列出 Windows 套件。
- **非 Linux 文字讀取**會正規化並移除結尾換行，貼上時不會多出空白列。

### 設定

在 `settingsSchema.ts` 的 `ui` 下新增：

```json
"showOpenTuiScrollbar": false
```

- 標籤：`Show Scrollbar (OpenTUI)`。
- `requiresRestart: true`，讓 scrollbox 以新選項重建，避免移除 prop 後
  visibility 仍停在舊值。
- 預設 `false`，把多出的一欄還給對話。

### i18n

新的使用者可見字串是：

- 既有的 `Jump to bottom (ctrl+End)`，維持在 `MUST_TRANSLATE_KEYS` 與所有
  內建 locale。
- `Copied {{count}} chars`，同樣放進 `MUST_TRANSLATE_KEYS` 與每個 locale。

已移除的右鍵選單標籤會從同一批檔案刪除。

## 影響檔案

- `packages/cli/src/ui/opentui/renderable-tree.ts`（新）
- `packages/cli/src/ui/opentui/selection-auto-copy.ts`（新）
- `packages/cli/src/ui/opentui/copy-notice.tsx`（新）
- `packages/cli/src/ui/opentui/transcript-mouse.ts`（新）
- `packages/cli/src/ui/opentui/scrollbar-visibility.ts`（新）
- `packages/cli/src/ui/utils/native-clipboard.ts`（新 Linux fallback）
- `packages/cli/src/ui/utils/commandUtils.ts` / `clipboardUtils.ts`（fallback
  整合）
- `packages/cli/src/utils/npm-runtime.ts`（把 Node binary 傳給 Bun）
- `packages/cli/src/ui/opentui/jump-to-bottom-hint.tsx`（既有）
- `packages/cli/src/ui/opentui/transcript-view.tsx`（項目點擊的左鍵檢查）
- `packages/cli/src/ui/opentui/input-submission.ts`
- `packages/cli/src/ui/opentui/input-prompt.tsx`
- `packages/cli/src/ui/opentui/opentui-app-shell.tsx`
- `packages/cli/src/config/settingsSchema.ts`
- `packages/cli/src/i18n/mustTranslateKeys.ts` 與九個 locale 檔
- 新模組旁的測試與更新後的 app-shell 測試

## 關鍵決策

- **右鍵是二選一。** 有選取＝取消；沒選取＝貼上。沒有選單，行為可預期。
- **貼上涵蓋整個畫面，取消只限對話選取。** 處理器同時掛在根 box 與
  scrollbox，composer、footer、狀態列都能右鍵貼上；只有對話區的選取會抑制
  貼上，composer 自己的選取不影響。
- **底部提示從底部堆疊。** jump hint 佔最底列；hint 隱藏時 copy toast 使用
  同一列，hint 出現時 toast 往上移一列，不再固定預留兩列。
- **所有 OpenTUI 選取都自動複製。** Hook 不檢查選取範圍，footer、composer、
  dialog 與其他區域的選取也會複製；右鍵策略仍只處理對話區。
- **重用 composer 的 Ctrl+V 路徑。** 剪貼簿可能是圖片、大型貼上或需要
  placeholder 摺疊的文字；另寫一套貼上會逐漸偏離。
- **scrollbar 預設隱藏、設定啟用。** 未設定或 false 傳
  `{ visible: false }`；明確 true 才交給 OpenTUI 原本的可見性邏輯。
- **設定需重啟。** scrollbox 選項是結構性的；重啟可避免關閉後再打開時 bar
  仍隱藏。

## 風險與限制

- Linux 寫入優先 `wl-copy`／`xclip`／`xsel`，再來 native addon，最後 OSC
  52。三者都沒有時，VTE 可能忽略 OSC 52 卻仍回報成功；最可靠仍是安裝
  `wl-clipboard`。Native addon 的 Bun → Node 子程序需要可執行的 Node；snap
  Bun 無法 spawn nvm Node（local OpenTUI 請用內附 Bun 1.4.4）。子程序寫入後
  多存活 150ms，讓剪貼簿管理員接手；沒有這段停頓，緊接著的右鍵讀取常會拿到
  空字串。
- 自動複製涵蓋所有 OpenTUI 選取，包含 composer 與 dialog 文字；編輯時複製
  是刻意行為，但可能覆寫剪貼簿。
- 右鍵貼上依賴 `ui.mouseTracking`；關閉後滑鼠交還終端機。
- scrollbar 設定需重啟，且只影響 OpenTUI。

## 驗證計畫

- 單元測試：`isRenderableWithin`、任意區域選取自動複製／空白／失敗／解除
  訂閱、copy toast 的數量與逾時、jump hint 的顯示狀態回報、右鍵取消與貼上、
  非右鍵、scrollbar 選項映射、尾部判斷、提示顯示與點擊；native bridge 測試
  涵蓋 in-process、Node 子程序、讀取正規化、佔用錯誤過濾、marker framing、
  overflow 與失敗分支；`readClipboardText()` 測試涵蓋 darwin/win32 走 addon
  與移除結尾空白。
- App shell 測試：無選取右鍵呼叫 `pasteClipboard`；在 footer（scrollbox
  外）右鍵也會貼上；有對話選取右鍵呼叫 `clearSelection` 且不貼上；
  PageUp/PageDown 與 Ctrl+Home/End 仍通過。
- 使用 Bundled Bun OpenTUI build 手動 E2E：選取對話／footer／composer／
  dialog 文字並確認自動複製 + toast；右鍵貼上；右鍵取消；PageUp/PageDown；
  Ctrl+Home/End；jump hint；預設隱藏 scrollbar；
  `ui.showOpenTuiScrollbar: true` 重啟後顯示。
- i18n must-translate 測試與相關 OpenTUI 測試。

## 待決問題

- 若未來出現更多 OpenTUI 專屬選項，是否要移到 renderer 專屬子群組？等有
  第二個選項再討論。
