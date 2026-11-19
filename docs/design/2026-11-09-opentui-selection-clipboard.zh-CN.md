# OpenTUI 选取复制、右键操作与滚动条显示

[English](2026-11-09-opentui-selection-clipboard.md) | [简体中文](2026-11-09-opentui-selection-clipboard.zh-CN.md)

状态：提案中
日期：2026-11-09

## 问题

OpenTUI 的文字选取目前只会画出高亮。选取文字不会复制，右键没有任何作用，原生
transcript 滚动条也一直占用一列。期望的交互是：

- 完成 OpenTUI 选取后自动复制，不论选取属于哪个区域（transcript、footer、
  composer、对话框）；
- 在 shell 任意位置右键、且没有 transcript 选取时，把剪贴板贴到 composer；
- 在 transcript 选取上右键会取消选取；
- PageUp/PageDown 与 Ctrl+Home/Ctrl+End 可在 transcript 中移动；
- transcript 不在底部时显示 **Jump to bottom** 提示；
- 可以隐藏 transcript 滚动条，把那一列让给对话。

Ink 已有自己的选取与右键菜单；本变更定义 OpenTUI 的行为，而不是照搬 Ink 的菜单
模型。

## 目标

- 任意 OpenTUI 区域完成的选取都会复制到剪贴板，并保持高亮。
- 复制成功后，右下角短暂显示 `Copied N chars` 确认；在对话框或确认画面打开时复制
  不显示确认。
- 在 shell 任意位置右键、且存在属于 transcript 的选取时，清除该选取。
- 在 shell 任意位置右键、且没有选取时，执行 composer 的 Ctrl+V 剪贴板路径，包括
  图片优先处理与文字后备；前台 shell 拥有焦点时，剪贴板文字改为写入该 shell。对话框、
  工具确认或审批提示打开时，右键会被忽略。
- PageUp/PageDown 每次滚动一个视口页；Ctrl+Home/Ctrl+End 跳到两端；不在底部时
  显示跳到底部提示。
- 原生 OpenTUI transcript 滚动条默认隐藏。显式设置
  `ui.showOpenTuiScrollbar: true` 可恢复 OpenTUI 默认的滚动条：只要 transcript 内容
  超出视口就会显示（闲置时不会淡出）。
- 行为拆成带测试的小模块，而不是全部写在 app shell 里。

## 非目标

- 不提供应用内上下文菜单。链接操作、代码块操作与全选不在本变更范围内。
- 终端原生的 Shift+拖曳选取对应用不可见，因此应用不会自动复制它。应用仍会收到下
  一次点击：Shift+拖曳之后的右键会贴到 composer。设置 `ui.mouseTracking: false`
  可把右键菜单交还给终端。
- 虚拟化 transcript 已卸载的历史无法复制。
- Ink 既有的选取与右键行为不变。

## 设计方案

### 模块结构

| 文件                                       | 职责                                                                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `renderable-tree.ts`                       | `isRenderableWithin()`：把 renderer 选取限定在 transcript 范围内。                                                            |
| `selection-auto-copy.ts`                   | `useSelectionAutoCopy()`：复制任何非空的 OpenTUI 选取并回报成功。                                                             |
| `copy-notice.tsx`                          | 右下角暂时显示的 `Copied N chars` 确认；两秒后消失。                                                                          |
| `transcript-mouse.ts`                      | `handleTranscriptRightClick()`：纯右键策略（清除选取或贴上）。                                                                |
| `scrollbar-visibility.ts`                  | `openTuiScrollbarOptions()`：把设置映射为 `{ visible: false }` 或 `undefined`（OpenTUI 默认）。                               |
| `native-clipboard.ts`                      | 原生剪贴板桥接：写入与读取都在 Node 子进程执行；只有子进程无法运行时，读取才在进程内使用 addon。包含 Windows/macOS 文字读取。 |
| `jump-to-bottom-hint.tsx`                  | 新增的底部判断与浮动提示。                                                                                                    |
| `input-submission.ts` / `input-prompt.tsx` | composer handle 新增 `pasteClipboard()`，执行既有的 Ctrl+V 路径。                                                             |

### 行为

1. 鼠标选取完成时，OpenTUI 会发出 `selection`。hook 复制任何非空的选取文字，不限
   transcript 范围：footer、composer、对话框与其他区域都包含在内。选取保持高亮；
   成功时 app shell 在右下角显示两秒的 `Copied N chars` 提示。提示隐藏时使用跳到
   底部提示的那一行，提示显示时则上移一行，让底部元素始终从底部往上堆叠，不会留下
   空行。剪贴板写入失败时不显示任何内容；在对话框、审批弹窗、工具确认或补全列表打
   开时复制也不显示：提示绝不会盖在弹窗上。
2. 只有在没有对话框、审批弹窗或工具确认打开时，才拦截 shell 任意位置的右键按下。
   处理函数挂在根 box 与 transcript scrollbox 上；scrollbox 会停止事件冒泡，所以其
   中的一次点击只处理一次。若存在属于 transcript 且有非空文字的选取，
   `handleTranscriptRightClick()` 会清除它。单纯的左键点击会让 OpenTUI 留下一个长
   度为零的选取，其容器是被点击文字的父节点；这种选取不算数，所以下一次右键仍会贴
   上。否则调用 `composerHandle.current.pasteClipboard()`；若前台 shell 拥有输入焦点，
   则读取剪贴板文字并写入该 shell，与终端贴到已聚焦 shell 的目的地相同。transcript 条目的点击处
   理函数（思考块、工具卡片）会检查是否为左键，避免对应的右键放开在贴上的同时切换
   卡片展开状态。
3. `pasteClipboard()` 委托给 composer 既有的 Ctrl+V 处理函数：先处理剪贴板图片，
   再处理文字，沿用相同的贴上折叠与提示。
4. PageUp/PageDown 使用 `ScrollBoxRenderable.scrollBy(±1, 'viewport')`。
   Ctrl+Home/Ctrl+End 使用 `scrollTo(0)` / `scrollTo(scrollHeight)`。这些按键来自
   共用的 `PAGE_UP`、`PAGE_DOWN`、`SCROLL_HOME` 与 `SCROLL_END` 绑定，因此
   Ctrl+PageUp/PageDown 也会滚动，重新绑定也会同时作用于两个 renderer。当前台
   shell、对话框或确认画面拥有输入时会忽略这些按键。
5. 跳到底部提示监听滚动条的 `change` 事件，并在每次渲染后重新检查，以涵盖流式输出
   造成的内容增长。它会把自己的显示状态回报给 shell，让复制提示能堆叠在它上方。对
   话框、确认画面或补全列表打开时不挂载它。
6. transcript scrollbox 接收
   `scrollbarOptions={openTuiScrollbarOptions(settings.merged.ui?.showOpenTuiScrollbar)}`。
   未设置或为 false 时隐藏滚动条；为 true 时 `scrollbarOptions` 保持 undefined，
   让 OpenTUI 使用自己的显示规则：内容超出视口时显示滚动条。
7. Linux 剪贴板写入使用共用的 `copyToClipboard()` 分派：
   `wl-copy` → `xclip` → `xsel` → 原生 `@teddyzhu/clipboard` addon → OSC 52。
   即使 addon 能在进程内加载，原生写入也一律在 Node 子进程执行：clipboard-rs 在替
   换 X11 拥有者时会把 `Somebody else owns the clipboard now` 之类的诊断打印到
   stdout，而在进程内 stdout 就是 TUI 的 alternate screen，消息会直接出现在
   composer 那一行。子进程的 stdout 是 pipe。子进程在 `setClipboardText()` 之后
   多存活 150 ms，让操作系统的剪贴板管理器接手拥有权。没有剪贴板管理器接手时，X11
   选取会随拥有者一起消失，因此写入成功后，桥接会再用一个子进程把剪贴板读回来；若
   文字没有保留下来，或读回已执行但失败／逾时，复制会回报失败，`copyToClipboard()` 改走 OSC 52，而不是确认一
   个已经消失的复制。读取基于同样的理由也在子进程执行，只有无法启动 Node 子进程时
   （例如 PATH 上没有 Node）才在进程内使用 addon；子进程已执行但失败时不会退回。
   Node 路径来自 `QWEN_NODE_BINARY`（由 npm Bun handoff 设置）或 `NVM_BIN`，因为
   Bun 的 snap PATH 可能不包含 nvm。
   右键贴上只有在没有安装 `wl-paste`/`xclip` 时，读取才使用同一个 addon 后备；可用
   工具的回答（包括剪贴板为空）即为最终结果。读取会重试 addon 暂时性的
   `Somebody else owns the clipboard now` 拥有权错误，并把这个字符串从读取结果中滤
   掉，使它绝不会被当成文字贴上。读取 helper 用标记框住 payload，丢弃原生 stdout
   诊断；第一个标记就是 helper 自己写的，所以本身含有该标记的剪贴板文字会完整保留。
   超过上限的 payload 会整笔丢弃，而不是贴上被截断的内容。

### 平台差异

- **macOS**：写入使用内置的 `pbcopy`；`readClipboardText()` 现在通过
  `@teddyzhu/clipboard` addon 读取文字，因此在 macOS 上运行 OpenTUI 时可以右键贴
  上文字。npm 包已附带 arm64 与 x64 的 Bun、`libopentui.dylib` 资源与剪贴板
  addon。
- **Windows**：写入使用 `cmd /c chcp 65001 && clip`；文字与图片读取使用 addon，
  并声明了 `win32-x64-msvc` 与 `win32-arm64-msvc`。OpenTUI 的 npm 打包仍待完成：
  Bun 只发布 `@oven/bun-windows-x64`（没有 Windows ARM64），npm handoff 也还没有
  列出 Windows 包。
- **非 Linux 的文字读取**会经过规范化并去掉结尾换行，复制的一行贴上时不会多出空
  白行。

### 设置

在 `settingsSchema.ts` 的 `ui` 下新增：

```json
"showOpenTuiScrollbar": false
```

- 标签：`Show Scrollbar (OpenTUI)`。
- `requiresRestart: true`，让 scrollbox 用新选项重建，而不是依赖移除的 prop 来重
  置显示状态。
- 默认 `false`，把多出的一列让给对话。

### i18n

新的面向用户字符串有：

- 新增的 `Jump to bottom (ctrl+End)` 提示 key，加入 `MUST_TRANSLATE_KEYS` 与所有
  内置语言；
- `Copied {{count}} chars` 及其单数形式 `Copied 1 char`，同样加入
  `MUST_TRANSLATE_KEYS` 与每个语言。

## 影响文件

- `packages/cli/src/ui/opentui/renderable-tree.ts`（新增）
- `packages/cli/src/ui/opentui/selection-auto-copy.ts`（新增）
- `packages/cli/src/ui/opentui/copy-notice.tsx`（新增）
- `packages/cli/src/ui/opentui/transcript-mouse.ts`（新增）
- `packages/cli/src/ui/opentui/scrollbar-visibility.ts`（新增）
- `packages/cli/src/ui/utils/native-clipboard.ts`（新增 Linux 后备）
- `packages/cli/src/ui/utils/commandUtils.ts` / `clipboardUtils.ts`（后备整合）
- `packages/cli/src/utils/npm-runtime.ts`（把 Node 可执行文件传给 Bun）
- `packages/cli/src/ui/opentui/jump-to-bottom-hint.tsx`（新增）
- `packages/cli/src/ui/opentui/transcript-view.tsx`（条目点击的左键判断）
- `packages/cli/src/ui/opentui/input-submission.ts`
- `packages/cli/src/ui/opentui/input-prompt.tsx`
- `packages/cli/src/ui/opentui/opentui-app-shell.tsx`
- `packages/cli/src/config/settingsSchema.ts`
- `packages/cli/src/i18n/mustTranslateKeys.ts` 与九个语言文件
- 新模块旁的新测试，以及更新的 app shell 测试

## 关键决策

- **右键是双向开关。** 有选取代表“取消”，没有选取代表“贴上”。没有菜单，行为保持
  可预期。
- **贴上作用于整个 shell；清除只限 transcript。** 处理函数挂在根 box 与 scrollbox
  上，所以 composer、footer 与状态区域都能贴上。只有 transcript 选取会抑制贴上；
  composer 选取不会。
- **右下角元素从底部堆叠。** 跳到底部提示占用最底行；提示隐藏时复制提示移入该行，
  提示出现时上移一行，而不是固定保留两行。
- **自动复制所有 OpenTUI 选取。** hook 不限 transcript 范围，所以 footer、
  composer、对话框与其他区域的选取也会复制；右键策略仍只限 transcript。
- **复用 composer 的 Ctrl+V 路径。** 剪贴板可能是图片、大段贴上或需要占位符折叠的
  文字；另写一套贴上实现会逐渐分歧。
- **默认隐藏滚动条，通过设置启用。** `undefined`（`showOpenTuiScrollbar` 未设置
  或为 false）传入 `{ visible: false }`；显式为 true 时保留 OpenTUI 原本的显示逻
  辑。
- **需要重启的设置。** scrollbox 选项属于结构性设置；重启可避免设置重新打开后仍残
  留隐藏的滚动条。

## 风险与限制

- Linux 剪贴板写入优先使用 `wl-copy`/`xclip`/`xsel`，其次是原生 addon，最后是
  OSC 52。全部不可用时，即使写入回报成功，VTE 也可能忽略 OSC 52；安装
  `wl-clipboard` 可获得最可靠的结果。原生 addon 的 Bun → Node 子进程路径需要 Node
  可执行文件；snap 版 Bun 无法启动 nvm 的 Node（本地 OpenTUI 构建请使用附带的
  Bun 1.4.4）。子进程写入后多存活 150 ms，让剪贴板管理器接手；没有这段停顿，紧接
  着的右键读取常会读到空剪贴板。在没有剪贴板管理器的 X11 上，原生复制无法在子进程
  结束后保留；读回检查会把它转为改走 OSC 52，而终端仍可能忽略 OSC 52。
- 自动复制涵盖所有 OpenTUI 选取，包括 composer 与对话框文字；编辑时复制是刻意的
  行为，但可能覆盖剪贴板。
- 右键贴上依赖 `ui.mouseTracking`；关闭后鼠标交还给终端。
- 滚动条设置需要重启，且只适用于 OpenTUI。

## 验证计划

- 单元测试涵盖 `isRenderableWithin`、来自任意区域的选取自动复制／空文字／失败／取
  消订阅、复制提示的字数与逾时、跳到底部提示的显示回调、右键清除或贴上与非右键按
  钮、滚动条选项映射、滚动到底部的判断，以及提示的显示与点击；原生剪贴板桥接测试
  涵盖进程内、Node 子进程、复制读回、读取规范化、拥有权错误过滤、标记框定、超出上
  限与失败分支，helper 脚本测试则在 Node 子进程中针对假的 addon 实际执行复制／读取
  脚本（往返、忙碌重试，以及无法启动的 Node 可执行文件）；`readClipboardText()`
  测试涵盖 darwin/win32 通过 addon 读取、去掉结尾空白，以及可用工具回报剪贴板为空
  后不再启动 addon。
- app shell 测试：没有选取时右键调用 `pasteClipboard`；在 footer（scrollbox 之
  外）右键也会贴上；有属于 transcript 的选取时调用 `clearSelection` 而不贴上；单
  纯点击留下的零长度选取仍会贴上；PageUp/PageDown（包括 Ctrl+PageUp）与
  Ctrl+Home/End 仍正常。composer 测试通过已挂载的 handle 贴上，transcript 测试钉
  住右键放开不会展开思考块或工具卡片。
- 使用附带 Bun 的 OpenTUI 构建进行手动 E2E：选取 transcript／footer／composer 文
  字并确认自动复制与提示，对话框文字复制时不显示提示；右键贴上；右键取消选取；
  PageUp/PageDown；Ctrl+Home/End；跳到底部提示；默认隐藏滚动条；重启后
  `ui.showOpenTuiScrollbar: true`。
- i18n 必须翻译测试与相关 OpenTUI 测试。

## 待决问题

- 如果出现更多 OpenTUI 专用选项，滚动条设置是否应放在 renderer 专属的子分组下？
  出现第二个选项时再讨论。
