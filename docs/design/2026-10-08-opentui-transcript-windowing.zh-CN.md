# OpenTUI 转录窗口化 —— 只挂载视口看得见的条目

[English](2026-10-08-opentui-transcript-windowing.md) | [简体中文](2026-10-08-opentui-transcript-windowing.zh-CN.md)

本文是所报「OpenTUI 渲染器下 `qwen --resume <id>` 白屏」修复的设计文档。两处改动一起落地：转录只挂载视口附近的条目，并且单个条目渲染失败不再能把整棵树带走。

## 问题

`@opentui` 为每个已挂载的 `text` 元素分配一个原生 `TextBuffer`，而 OpenTUI 的转录一次性挂载了全部历史条目。于是几千条记录的会话足以耗尽进程。下文所有数据都在 `main` 的 `d735e20f21` 上、配合 `@opentui/*` 0.5.10 测得 —— 也就是本次改动所发布的版本：

- 在所报会话（截断到前 2498 条记录）上，拼进生产 bundle 的计数器在第一次 `Failed to create TextBuffer` 时记录到 `created=16430 destroyed=0 rss=870MB`，此后每次分配都以同样的方式失败。
- 一次只创建单词大小 buffer 的隔离探测在恰好 65534 个存活 buffer 时失败，此时 `rss=228MB`。所以上限是进程内存而非固定的槽位数；而真实会话的 buffer 装的是折行后的对话正文而不是单词探针，因此大约在那个数值的四分之一处就会撞上。

失败是静默的，这正是它看起来像 resume 逻辑坏了、而不是分配失败的原因。异常落在 React host instance 的创建过程中，被 `@opentui/react` 自带的 `ErrorBoundary` 捕获。那个 boundary 的兜底是一个红色 `text` 元素，编译后是一次 `jsxDEV` 调用，而打包出的 CLI 里 `jsxDEV` 是 undefined，于是它的 `render()` 第二次抛出 —— `TypeError: (0, import_jsx_dev_runtime.jsxDEV) is not a function` —— React 随后卸载整个根。终端停在一个空的备用屏上，而进程仍然活着、仍然接受输入。两个错误都不会到达 pty；唯一看到它们的办法是用 `--preload` 模块钩住 `console.error`，这两个错误正是这样才捕到的。

ink 不会碰到这个问题。它的转录是虚拟化的（`virtualEstimatedItemHeight`：第一条 10 行，之后 3 行），并且已结算的轮次会交给终端回滚缓冲，所以存活文本元素的数量跟随视口而不是会话长度。

## 决定 1 —— 在既有 scrollbox 内做窗口，按行而不是按条目计预算

`packages/cli/src/ui/opentui/transcript-window.ts` 从行偏移表和滚动位置算出 `{ start, end, topPad, bottomPad }`，`transcript-view.tsx` 渲染

```
<box>            <!-- 转录根 -->
  <box height={topPad} />
  ...items.slice(start, end)
  <box height={bottomPad} />
</box>
```

预算的单位是行而不是条目数：一个条目可能是一行，也可能是四十行的工具卡片，而既是行填满视口、也是行消耗 buffer。`OVERSCAN_ROWS = 24`（每侧留一屏余量）意味着一次滚轮跳动不会在新窗口落地前露出空隙。

窗口位于 app shell 已经渲染的 scrollbox 内部，所以 `stickyScroll`、滚动条、拖拽选择以及 shell 的焦点策略全都不受影响，shell 自己的滚动接线也没有改动。占位 spacer 让滚动几何仍然覆盖整份转录，因此滚动条滑块和最大滚动偏移描述的仍是整个会话。

窗口在渲染期间计算，而不是在 effect 里：流式轮次会往 `items` 追加并触发重渲染，若在 effect 中计算会让最新的行有一帧未被挂载。

## 决定 2 —— 估算沿用 ink 的取值，测量按条目 id 存储且在卸载后保留

未测量的条目按 ink 的取值估算（索引 0 为 `ESTIMATED_FIRST_ITEM_ROWS = 10`，之后为 `ESTIMATED_ITEM_ROWS = 3`），使滚动条和 spacer 运算从一开始就与 ink 使用同一套模型。随后从每个已挂载条目的节点读出真实高度（`height + itemMarginTop`，即条目 box 声明的外边距），存进以条目 id 为键的 `Map`。

这个 Map 刻意在条目滚出窗口后仍保留 —— 绝不能把估算值重新套到已经测量过的条目上，否则窗口每次移动 spacer 都会跳变。只有在 `availableWidth` 变化时才清空，因为折行取决于宽度，此时在旧宽度下取得的所有测量值都失效了。

## 决定 3 —— 滚动位置在渲染器的 `frame` 事件上采样

`ScrollBoxRenderable` 不提供滚动事件，而 `viewportCulling` 只剔除绘制、不释放任何 `TextBuffer`。定时器和 animation frame 轮询都被否决，理由与本轮扫描的决定 28 已经确立的一致 —— 无事发生时仍在重绘的 spinner 会被读成浪费 CPU。因此该 hook 订阅 `renderer.on('frame')`：只有在真的画了东西时才发帧，而每次滚轮跳动、滚动条拖动和按键滚动都会绘制。空闲时开销为零，位置每帧至多读一次。

## 决定 4 —— 转录在滚动内容中的偏移是 `root.y - host.content.y`

`Renderable.y` 是绝对值：getter 会加上父节点的 `y`。沿树往上逐层累加 `y` 会把滚动位移算两次。转录根与滚动内容相减可以让中间层叠缩掉、并抵消该位移，剩下转录在可滚动区域内的行偏移。滚动宿主本身通过从转录根沿 `parent` 上溯、并对 `scrollTop`/`content`/`viewport` 做鸭子类型判定来找到，这样 shell 的树形状仍只对 shell 自己可见。

## 决定 5 —— 视口上方的高度修正要同步移动滚动位置，但钉在底部时除外

用测量值替换估算值会改变它下方的所有偏移。如果修正在视口上边界之上，用户正在看的行就会滑动，所以 hook 把同一个增量加到 `host.scrollTop` 上。

第一帧被排除。在读到真实偏移之前，位置是占位值 `Number.MAX_SAFE_INTEGER`，含义是「钉在尾部」，此时每个条目都算在它上方 —— 在那里做修正会与 `stickyScroll` 打架，而后者在内容增长时本就会重新钉住视图。只有在已知真实滚动位置之后才施加修正。

## 决定 6 —— 条目数上限保住视口顶部

`MAX_MOUNTED_ITEMS = 400` 是针对「窗口由大量单行条目构成」的兜底。它只在视口本身比上限还高时才生效，而这种情况下没有任何窗口能覆盖视口；收缩时保留顶部若干行，因为阅读从那里开始。60 行的现实视口至多产出 `60 + 2 * 24 + 1` 个条目。

## 决定 7 —— 会话预览锚定在顶部

`OpenTuiTranscriptView` 还有第二个调用方：会话选择器的预览面板。它被裁剪且不滚动。默认锚定底部会让它从第一轮翻到最后一轮，所以视图接受一个 `initialAnchor`，预览传 `'top'`。

## 决定 8 —— 条目渲染失败时什么都不画，而不是把整棵树带走

窗口化消除了导致白屏的压力，但那种失败模式本身才是它静默的原因。现在每个已挂载条目都包在 `OpenTuiErrorBoundary` 里，兜底渲染 `null`，于是一次分配失败只会让一个条目空白，而 banner、composer、footer 和退出路径都还活着；错误送到 `OPEN_TUI_TRANSCRIPT` debug logger。

boundary 位于条目的 `<box>` 内部而不是外面：替换掉 box 的 boundary 会移除一个子节点，破坏测量环节所依赖的 `[topPad, ...items, bottomPad]` 下标映射。兜底刻意取 `null` 而不是 boundary 默认的报错文本。默认兜底渲染 `text`，而 `text` 需要一个全新的 `TextBuffer` —— 正是刚刚耗尽的那个资源 —— 所以它可能在这个「唯一职责就是活过失败」的处理器里再次失败；上游就是这样逐级放大的，它的兜底恰恰是那句根本跑不起来的 `jsxDEV` 调用。什么都不画的兜底两样都不依赖。顶层那个致命 boundary、它的模块级错误存储以及退出时的 stderr 回显都未改动，仍然捕获条目之外的一切。

## 验证

单元测试：

- `transcript-window.test.ts`（10 条）钉住偏移前缀和、空转录、恰好放进视口、滚动夹紧、两侧 overscan、跨底边界的条目、混合高度下的 spacer 运算，以及上限。
- `transcript-view.test.tsx` 新增两条针对 2000 条会话的回归测试：默认视图挂载尾部而不挂载头部，锚定顶部的面板挂载头部而不挂载尾部，两者元素数都低于 400。两条都做过变异验证 —— 把切片换成 `items.slice(0)` 会让它们失败。
- 整个 `src/ui/opentui` 套件通过（84 个文件、1698 条测试）。会话选择器的预览面板会挂载转录视图，所以它的 `@opentui/react` mock 补上了窗口化 hook 要读的 `useRenderer` 导出；缺了它，五条 Space-to-preview 测试会抛异常。

实机（Bun 下的 opentui 腿，100x32 pty，`--resume` 所报会话；修复前后由同一棵树构建，只施加本次改动）：

| 实验臂                                      | 修复前                                                                                                  | 修复后                                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| resume，前 2498 条记录                      | `non-space cells: 0`（白屏）；`Failed to create TextBuffer`，此时 `created=16430 destroyed=0 rss=870MB` | `non-space cells: 1318`；分配总数停在 500 以下（计数器最后一档是 `created=400 destroyed=0 rss=532MB`），无失败，条目 boundary 未被触发 |
| resume，全部 2781 条记录                    | `non-space cells: 0`（白屏）                                                                            | `non-space cells: 1237`，`1 / 6` 个不同帧，进程存活于备用屏                                                                            |
| `s18w-wheel-scroll`（既有场景）             | 静息 `OVF25..OVF48`，上滚后 `OVF05..OVF28`                                                              | 截图逐字节相同                                                                                                                         |
| `s18x-wheel-window`（新增：400 个单行轮次） | `W377..W400`、`W317..W340`、`W117..W140`、`W377..W400`                                                  | 截图逐字节相同                                                                                                                         |

两个滚动场景是透明性检查：`s18x-wheel-window` 是一份 400 行的转录，窗口确实必须移动 —— 分两步上滚再滚回底部 —— 而 `s18w-wheel-scroll` 是既有的溢出场景。两者产出的每一个文件，共 23 个，在 harness 写出的三种维度（纯文本、补齐后的单元格网格、带 ANSI/SGR 的渲染结果）外加原始 pty 流上，修复前后都逐字节相同。它们也不是空洞的：`s18x` 的四份带样式截图有三个不同的摘要，其中 `00-bottom` 与 `03-back-bottom` 如预期互相一致；`s18w` 的三份有两个。

## 后续项

- 另外两个所报缺陷 —— composer 光标（#227）与闪烁的 markdown h3（#228）—— 本次改动未触及。
- 在 resume 复现腿里，注入的 SGR 滚轮序列不会滚动转录。有无本次改动行为完全一致，所以那是该实验腿的属性而非窗口化的属性；同样的序列在 `s18w`/`s18x` 腿里滚动正常。作为 harness 问题留存。
