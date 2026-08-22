<!--
Maintainers prioritize PRs with a clear reviewer test plan — without it, review may be delayed.

Don't hard-wrap paragraphs: GitHub renders single newlines as <br>, so wrapped text shows as a narrow column. Write each paragraph or list item as one long line.
-->

## What this PR does

Enables application-level drag text selection on the statusline and read-only footer chrome when Virtualized History is active. It introduces a multi-rect containment check (`pointInAnyViewport`) in the selection coordinate helpers and attaches a dedicated ref to the rendered Footer component. The selection controller uses this footer rect alongside the history list viewport rect to allow mouse selection while preserving existing click handlers for the composer text input area.

## Why it's needed

When Virtualized History mode is enabled, SGR mouse tracking suppresses native terminal text selection across the entire screen. The application's fallback selection mechanism previously restricted drag selection strictly to the history list viewport region. Because statusline indicators (such as current model, git branch, working directory, and context usage) render inside the footer sibling below the history list, statusline text fell into a selection dead zone and could not be selected or copied by users.

## Reviewer Test Plan

<!--
How a reviewer can confirm this PR: reproduction steps, expected vs observed behavior, and evidence. CI runs on macOS, Windows, and Linux — Tested on is what you verified locally.

User-visible / TUI: Before/After with tmux-real-user-testing skill, screenshots, or a short recording.
Non–user-visible (refactor, types, docs): commands and output below; write N/A under Before/After.
-->

### How to verify

1. Launch Qwen Code and enable Virtualized History in settings (`/settings` → Virtualized History enabled).
2. Configure a visible statusline containing text (e.g., git branch, model name, or working directory).
3. Attempt to drag-select across the text rendered in the statusline/footer area using the mouse.
4. **Expected Outcome:** Text in the statusline highlights during drag, and releasing the left mouse button copies the highlighted text to the clipboard.
5. Attempt to click or drag inside the active composer text input box.
6. **Expected Outcome:** The composer input box retains its existing click-to-position-cursor behavior and does not trigger text selection.

### Evidence (Before & After)

* **Before:** Dragging across statusline text when Virtualized History is enabled produced no selection highlight, leaving footer text uncopyable.
* **After:** Dragging across statusline text highlights the selected region and copies it on mouse release.

*(Note: Please attach a screenshot or short screen recording of statusline drag-selection working here before submitting).*

### Tested on

|     OS     | Status |
| :--------: | :----: |
|  🍏 macOS  |  N/A   |
| 🪟 Windows |   ✅   |
|  🐧 Linux  |  N/A   |

<!-- ✅ tested · ⚠️ not tested · N/A -->

### Environment (optional)

Tested locally on Node.js v24 running on Windows 11 with PowerShell via `npm start`.

## Risk & Scope

- Main risk or tradeoff: Minimal. Selection rect expansion is strictly scoped to the measured `footerRef` bounding box, keeping it geometrically disjoint from the active composer input.
- Not validated / out of scope: Cross-region drag selection spanning from history into the footer in a single drag gesture (drags clamp strictly to the region in which they initiated).
- Breaking changes / migration notes: None. `getFooterRect` is an optional prop on `TextSelectionControllerProps` for backward compatibility.

## Linked Issues

Fixes #<replace-with-your-issue-number>

<details>
<summary>中文说明</summary>

## 此 PR 所做的修改

在启用“虚拟化历史记录” (Virtualized History) 模式时，允许对状态栏和只读页脚区域进行应用程序级的鼠标拖拽文本选择。通过在选择坐标辅助函数中引入多矩形包含检测 (`pointInAnyViewport`)，并为渲染的 Footer 组件绑定专属 ref，选择控制器可以同时使用页脚矩形和历史列表视口矩形来支持鼠标选择，同时完整保留 Composer 文本输入区域现有的点击交互逻辑。

## 为什么需要此修改

启用“虚拟化历史记录”模式时，SGR 鼠标追踪会在整个终端屏幕范围内抑制终端原生的文本选择。此前应用程序的回退选择机制仅严格限制在历史列表视口区域内。由于状态栏信息（例如当前模型、Git 分支、工作目录和 Context 使用量）渲染在历史列表下方的页脚兄弟节点中，导致状态栏文本处于选择盲区，用户无法对其进行选择或复制。

## 审查者测试计划

### 如何验证

1. 启动 Qwen Code 并开启“虚拟化历史记录”设置（进入 `/settings` 开启 Virtualized History）。
2. 配置显示带有文本的状态栏（如 Git 分支、模型名称或工作目录）。
3. 使用鼠标在状态栏/页脚区域显示的文本上尝试拖拽选择。
4. **预期结果：** 状态栏文本在拖拽过程中被高亮选中，松开鼠标左键后选中的文本成功复制到剪贴板。
5. 尝试在活跃的 Composer 文本输入框内点击或拖拽。
6. **预期结果：** Composer 输入框保持原有的点击定位光标行为，不会触发文本选择。

### 证明（修改前与修改后）

* **修改前：** 开启虚拟化历史记录时，在状态栏文本上拖拽不会产生任何选择高亮，导致页脚文本无法复制。
* **修改后：** 在状态栏文本上拖拽可以正常高亮选中文本，并在松开鼠标时完成复制。

*(注意：请在提交前在此处附上状态栏拖拽选择生效的截图或短视频/GIF)*。

### 测试环境

|     系统     | 状态 |
| :----------: | :--: |
|  🍏 macOS   | N/A  |
| 🪟 Windows  |  ✅  |
|  🐧 Linux   | N/A  |

### 环境（可选）

本地在 Windows 11 PowerShell 环境下运行 Node.js v24，通过 `npm start` 验证。

## 风险与影响范围

- 主要风险或权衡：极低。选择矩形的扩充严格限定在测得的 `footerRef` 边界框内，与活跃的 Composer 输入框在几何空间上完全隔离。
- 未验证 / 超出范围：单次拖拽动作中跨越历史记录与页脚两个区域的跨区选择（拖拽严格限制在其起始的单区域内）。
- 破坏性变更 / 迁移说明：无。`TextSelectionControllerProps` 中的 `getFooterRect` 为可选属性，保持向后兼容。

## 关联 Issue

Fixes #<replace-with-your-issue-number>

</details>
