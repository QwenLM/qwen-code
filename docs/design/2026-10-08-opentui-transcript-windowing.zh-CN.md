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

窗口位于 app shell 已经渲染的 scrollbox 内部，所以 `stickyScroll`、滚动条以及 shell 的焦点策略全都不受影响，shell 自己的滚动接线也没有改动。占位 spacer 让滚动几何仍然覆盖整份转录，因此滚动条滑块和最大滚动偏移描述的仍是整个会话。

拖拽选择是唯一的例外，而且只在跨窗口边界时。把拖拽保持在 scrollbox 边缘附近会触发自动滚动；随后的窗口移动会卸载活动选区锚点所持有的那个 renderable，而 `Renderable.destroy()` 从不清除渲染器的选区，于是锚点会静默地重新落到拖拽从未覆盖过的行上，并在松开鼠标后继续保持错误。本次改动之前，滚动从不卸载任何转录条目，所以锚点不可能在拖拽中途消失。危害是一份画错的选区，下一次点击就会清掉，而这个 CLI 里没有任何东西读取渲染器的选区 —— 复制即选走的是 ink 侧路径 —— 所以它被记进后续项，而不是在这里加防护。

窗口在渲染期间计算，而不是在 effect 里：流式轮次会往 `items` 追加并触发重渲染，若在 effect 中计算会让最新的行有一帧未被挂载。

## 决定 2 —— 估算沿用 ink 的取值，测量按条目身份存储且在卸载后保留

未测量的条目按 ink 的取值估算（索引 0 为 `ESTIMATED_FIRST_ITEM_ROWS = 10`，之后为 `ESTIMATED_ITEM_ROWS = 3`），使滚动条和 spacer 运算从一开始就与 ink 使用同一套模型。随后从每个已挂载条目自己的节点读出真实高度，存进以 `(kind, id)` 为键的 `Map` —— 这正是 `findToolIndex` 已经在用来判别的那一对，而且必须是那一对：一次 subagent 调用会同时把携带同一个 call id 的 `tool` 卡片和 `task` 卡片放进转录。只用 `id` 作键会让两者每帧互相覆盖同一个槽位，于是高度表永远无法结算 —— 每帧都重渲染整份转录并重跑 O(session) 的前缀和 —— 并且最后写入的那张卡片会把自己的高度捐给另一张。键里也不能带位置下标：`task-end` 是按下标把 task 卡片 splice 掉的，那会让它上方的每个下标都移位。

记录的行数是 Yoga 的计算高度加上 `itemMarginTop`（条目 box 声明的外边距），而不是节点对外报告的 `height`。`updateFromLayout()` 存的是 `Math.max(layout.height, 1)`，所以一个什么都不画的 box —— `renderNothing`、被隐藏的 goal 卡片 —— 对外报告一行而 Yoga 算出零行；又因为这张表从不清空，那个幻影行是永久的。对外报告的 `height` 仍然会先读一次，用作 guard：一个尚未经历首次布局的节点报告 `0`，这是区分「还没布局」与「布局后为空」的唯一办法。

这个 Map 刻意在条目滚出窗口后仍保留 —— 绝不能把估算值重新套到已经测量过的条目上，否则窗口每次移动 spacer 都会跳变。改宽度时同样不清空：宽度真正让失效的是已挂载的那些条目，而它们在下一帧就会被重新测量；相反，清空整张表会把一个本身以行数计量的滚动位置底下的所有偏移重新编号 —— 一次上方内容毫无变化的改宽度，就能让可见轮次移动一百多个。

## 决定 3 —— 两个信号：滚动条的 `change` 事件与渲染器的 `frame` 事件

`ScrollBoxRenderable` 不提供滚动事件，而 `viewportCulling` 只剔除绘制、不释放任何 `TextBuffer`。定时器和 animation frame 轮询都被否决，理由与本轮扫描的决定 28 已经确立的一致 —— 无事发生时仍在重绘的 spinner 会被读成浪费 CPU。

但滚动条确实会发一个事件。`scrollTop` 就是滚动条的 `scrollPosition`，其 setter 驱动 slider，而 slider 的 `onChange` 链最终落在公开的 `verticalScrollBar.emit('change')` 上 —— 所以每一条滚动路径（滚轮、按键、程序化写入、点击轨道、拖动滑块）都会同步上报，且发生在 `requestRender()` 绘制之前。订阅它正是让「绝对跳转」安全的原因：点击轨道可以落在转录的任意位置，远在固定的 24 行 overscan 之外，而只在 `frame` 上采样会先画出一帧只有 spacer 的空隙 —— 那正是本设计要消除的症状。

`frame` 订阅保留下来，用于必须等布局完成的那一半：读取每个已挂载条目的真实行数。空闲时开销依然为零，因为没有东西移动时两个事件都不会发。

移动并不免费，这笔开销值得写明而不是留给以后去测。只移动窗口的情况下，bump 的是与测量同一个 `revision`，所以 O(session) 的高度映射与前缀和会重跑一遍并产出一个完全相同的数组；而转录里没有任何条目做过 memo，因此重执行的是每个已挂载条目的渲染路径，而不只是刚进入窗口的那一两个。在上限生效的 400 条目窗口下，那就是每步滚轮 400 条渲染路径。给条目加 memo 是这里值得做的那一半，本改动没有做。

## 决定 4 —— 转录在滚动内容中的偏移是 `root.y - host.content.y`

`Renderable.y` 是绝对值：getter 会加上父节点的 `y`。沿树往上逐层累加 `y` 会把滚动位移算两次。转录根与滚动内容相减可以让中间层叠缩掉、并抵消该位移，剩下转录在可滚动区域内的行偏移。滚动宿主本身通过从转录根沿 `parent` 上溯、并对 `scrollTop`/`content`/`viewport` 做鸭子类型判定来找到，这样 shell 的树形状仍只对 shell 自己可见。

## 决定 5 —— 测量已挂载条目不动任何东西；测量窗口刚拉进来的条目则结算滚动位置

用测量值替换估算值会改变它下方的偏移；对于一个本来就在屏幕上的条目，这在视觉上什么都不改变。本改动早先版本在那里写入的修正，方向和效果都是错的。

测量循环能看到的每个条目都已挂载，而已挂载的条目本就以刚读到的那个高度绘制着。两个 spacer 都取自「窗口内变化影响不到」的偏移：`topPad` 是 `offsets[start]`，只累加窗口之前的条目；`bottomPad` 是 `total - offsets[end]`，而修正窗口内某个条目会让 `total` 与 `offsets[end]` 变化同样的量。所以当高度表追上真实布局时，画面并没有移动，应付的补偿恰好为零。

窗口移动是另一种情况，它确实欠一笔补偿。当 `start` 减小时，从视口上方进入的那些条目原本是顶替 `topPad` 占位行的、按高度表当时的说法计费 —— 从未挂载过的按 `ESTIMATED_ITEM_ROWS`，重新回来的按它记录过的高度；测量它们的那一帧会把读者上方的表缩小这个差值。画面内容因此向上滑动这么多行，而滚动位置原地不动 —— 于是在两行一轮的轮次上，一次六行的滚轮跳动只走了两行。hook 现在会记下一次向上窗口移动拉进来的每个条目的身份、以及高度表当时给它计费的行数，而测量到某个条目的那一帧会把它实际花掉的行数从 `scrollTop` 里扣掉。记的是身份而不是下标，理由同决定 2。

说明「读者上方某段占位行计费错了」的是这笔计费本身，不是高度表，所以它由回应它的那次测量消费掉，无论表此前是否见过这个条目。让这一点成为必需的情形是：一个条目在窗口外时，它记录过的高度失效了 —— 改终端宽度会让每个窗口外的轮次重新换行，ctrl+O 会一次性翻转所有卡片，而决定 2 两种情况都不清表，于是这个轮次回来时仍按它过去绘制的行数计费，读者被移动了却没有任何回写。反过来，把一笔计费保留到回应它的那次测量之后是同一个错误的另一面：一个已挂载条目下一次高度变化会按一个从来不是「被拉入窗口」的来源去结算。因此，上一个 commit 就已经挂载的身份根本不计费：它的行数是绘制出来的，不是顶替占位行的。最后这一条只在计费循环脚下的下标空间发生位移时才会咬人 —— `task-end` 就是按下标 splice 的 —— 但那时帧会在完全没有滚动输入的情况下写 `scrollTop`。

这次写入走的仍是感知 sticky 的 setter，而该 setter 会按落点重算 `_hasManualScroll` —— 那正是上面那个无条件修正犯的错：把视图留在尾部上方一行，就让 shell 的底部钉住在整个会话余下时间里都失效。所以它带 guard：只有当写入前和写入后的位置都严格在尾部上方时才触发。那种情况下读者自己的滚动早已把钉住关掉了，所以这次结算无法改变钉住正在做的事。在尾部 —— 钉住生效的地方 —— 什么都不写，也什么都不欠：进入的条目在读者下方，不在上方。

## 决定 6 —— 条目数上限保住视口顶部

`MAX_MOUNTED_ITEMS = 400` 是针对「窗口由大量单行条目构成」的兜底，也是本设计对同时存活的原生 buffer 数量施加的唯一上界。它在 `viewportRows + 2 * OVERSCAN_ROWS` 超过 `MAX_MOUNTED_ITEMS * rowHeight` 时开始生效 —— 单行条目对应 353 行的视口，双行条目对应 753 行。从那之后直到视口高 `MAX_MOUNTED_ITEMS` 行为止，已挂载条目仍然覆盖视口，只是底部 overscan 被裁掉；再往上就没有任何窗口能覆盖视口了，此时收缩保留顶部若干行，因为阅读从那里开始。60 行的现实视口至多产出 `60 + 2 * 24 + 1` 个条目。

## 决定 7 —— 会话预览锚定在顶部

`OpenTuiTranscriptView` 还有第二个调用方：会话选择器的预览面板。它被裁剪且不滚动。默认锚定底部会让它从第一轮翻到最后一轮，所以视图接受一个 `initialAnchor`，预览传 `'top'`。

## 决定 8 —— 条目渲染失败时什么都不画，而不是把整棵树带走

窗口化消除了导致白屏的压力，但那种失败模式本身才是它静默的原因。现在每个已挂载条目都包在 `OpenTuiErrorBoundary` 里，兜底渲染 `null`，于是一次分配失败只会让一个条目空白，而 banner、composer、footer 和退出路径都还活着；错误送到 `OPEN_TUI_TRANSCRIPT` debug logger。

boundary 位于条目的 `<box>` 内部而不是外面。测量环节已不再依赖这个位置 —— 每个条目 box 通过 ref 回调以自己的身份登记自己的节点，所以没有任何地方需要从「它在根节点子列表里的位置」反推条目，日后往根节点加一个同级元素（一条「N new turns」提示、一行加载中）也不会让它错位。仍然把 boundary 留在 box 内部，是为了让一个失败的条目画零行而不是两行。兜底刻意取 `null` 而不是 boundary 默认的报错文本。默认兜底渲染 `text`，而 `text` 需要一个全新的 `TextBuffer` —— 正是刚刚耗尽的那个资源 —— 所以它可能在这个「唯一职责就是活过失败」的处理器里再次失败；上游就是这样逐级放大的，它的兜底恰恰是那句根本跑不起来的 `jsxDEV` 调用。什么都不画的兜底两样都不依赖。顶层那个致命 boundary、它的模块级错误存储以及退出时的 stderr 回显都未改动，仍然捕获条目之外的一切。

## 验证

单元测试：

- `transcript-window.test.ts`（10 条）钉住偏移前缀和、空转录、恰好放进视口、滚动夹紧、两侧 overscan、跨底边界的条目、混合高度下的 spacer 运算，以及上限。
- `transcript-view.test.tsx` 新增三条针对 2000 条会话的无宿主窗口化测试：默认视图挂载尾部而不挂载头部，锚定顶部的面板挂载头部而不挂载尾部，两者元素数都低于 400。第四条钉住无宿主面板在 frame 上仍然测量真实高度，把宿主查找挪回测量循环之前会让它变红。把切片换成 `items.slice(0)` 会让这四条、外加下面 harness 上十三条里的七条失败。
- 同一文件新增了针对「frame 驱动的那一半」的滚动宿主 harness —— jsdom 否则根本到不了那里：它把视图上溯的宿主、以及视图回读的已布局树，都装到 JSX mock 产出的 DOM 节点上。宿主的 `content.y` 携带滚动位移、而 `root.y` 是一个非零静态值，所以决定 4 那个偏移的两个操作数都不为零、也都不是对方；删掉 `- host.content.y` 会让三条测试失败。spacer 把自己的 `height` prop 转发成 `data-height`，测试因此读得到它；JSX mock 会统计元素数，测试因此能区分「重渲染了」和「没重渲染」。
- 十三条测试跑在这个 harness 上。每一条都至少被下面某个变异杀死，下面那条选择器测试也有自己的变异；每次跑完树都按字节还原。下面各条的受害清单是在最后三条测试出现之前测出来的，所以写的是十条；那三条对应清单末尾的三个变异，每个都实测只杀死它自己那一条。
  - 对本来就已测量过的条目结算高度差 —— 也就是决定 5 移除掉的那个修正 → `records real heights without moving the scroll position`、`travels the whole distance over turns shorter than the estimate`
  - 对本来就已挂载的条目（而不只对窗口刚拉进来的那个）结算滚动位置 → `travels the whole distance over turns shorter than the estimate`
  - 完全不结算 → `travels the whole distance over turns shorter than the estimate`
  - 高度表以 `item.id` 为键 → `keeps a separate height slot for two live items sharing one id`
  - 把测到的高度归给相邻条目 → 所有会读测量高度的十一条测试：这个 harness 上的十条，外加 `measures real heights in a host-less pane`
  - 读被夹紧的对外 `height` 而不是 Yoga 的值 → `reaches the tail past turns that paint no rows of their own`
  - 按 height prop 而不是宿主视口给窗口定尺寸 → `sizes the window from the host viewport, not the height prop`
  - 去掉 `fallback={renderNothing}` → `paints nothing for a turn that throws and keeps the rest`
  - 无条件 bump `revision` → 又是那条共享 id 的测试，通过它的渲染计数
  - 去掉滚动条订阅 → `answers a scrollbar jump without waiting for a frame`、`sizes the window from the host viewport, not the height prop`、`drops the frame and scroll-bar subscriptions on unmount`
  - 从决定 4 的偏移里删掉 `- host.content.y`，或在偏移 memo 里无视高度表 → 分别让上面三条、五条失败
  - 只对高度表从未见过的条目结算，于是一个在窗口外期间记录高度已失效的条目会移动读者、却没有任何回写 → `settles a turn whose recorded height went stale while it was off-window`
  - 把一笔计费保留到回应它的那次测量之后 → `spends a charge on the measurement that answers it, not on a later one`
  - 给上一个 commit 就已经挂载的身份计费 → `never charges a turn the previous commit already had mounted`
- 没有任何变异是专门针对 `keeps the reading position across a resize` 的 —— 只有上面那条「相邻条目键」能波及它，而那个变异会打破一切读测量高度的测试。它当初针对的「改宽度时清空高度表」已经不存在，而 hook 现在根本看不到宽度。它作为决定 2「改宽度不清空这张表」的行为钉保留，不作为变异证明。
- `session-picker.test.tsx` 新增一条测试：40 条记录的预览挂载头部而不挂载尾部。删掉 `initialAnchor="top"` 会让它、且只让它失败。它的 `@opentui/react` mock 也补上了窗口化 hook 要读的 `useRenderer` 导出；缺了它，五条 Space-to-preview 测试会抛异常。
- 整个 `src/ui/opentui` 套件通过（84 个文件、1715 条测试）。

实机（Bun 下的 opentui 腿，100x32 pty，`--resume` 所报会话；修复前后由同一棵树构建，只施加本次改动）：

| 实验臂                                      | 修复前                                                                                                  | 修复后                                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| resume，前 2498 条记录                      | `non-space cells: 0`（白屏）；`Failed to create TextBuffer`，此时 `created=16430 destroyed=0 rss=870MB` | `non-space cells: 1318`；分配总数停在 500 以下（计数器最后一档是 `created=400 destroyed=0 rss=532MB`），无失败，条目 boundary 未被触发 |
| resume，全部 2781 条记录                    | `non-space cells: 0`（白屏）                                                                            | `non-space cells: 1237`，`1 / 6` 个不同帧，进程存活于备用屏                                                                            |
| `s18w-wheel-scroll`（既有场景）             | 静息 `OVF25..OVF48`，上滚后 `OVF05..OVF28`                                                              | 截图逐字节相同                                                                                                                         |
| `s18x-wheel-window`（新增：400 个单行轮次） | `W377..W400`、`W317..W340`、`W117..W140`、`W377..W400`                                                  | 截图逐字节相同                                                                                                                         |

两个滚动场景是透明性检查：`s18x-wheel-window` 是一份 400 行的转录，窗口确实必须移动 —— 分两步上滚再滚回底部 —— 而 `s18w-wheel-scroll` 是既有的溢出场景。两者产出的每一个文件，共 23 个，在 harness 写出的三种维度（纯文本、补齐后的单元格网格、带 ANSI/SGR 的渲染结果）外加原始 pty 流上，修复前后都逐字节相同。它们也不是空洞的：`s18x` 的四份带样式截图有三个不同的摘要，其中 `00-bottom` 与 `03-back-bottom` 如预期互相一致；`s18w` 的三份有两个。

## 后续项

- 跨窗口边界的拖拽选择是坏的，如决定 1 所记：按住拖拽触发的自动滚动会移动窗口，窗口移动会卸载选区锚点所持有的 renderable，而 `Renderable.destroy()` 不清除渲染器的选区，于是锚点重新落到拖拽从未覆盖过的行上。修法是让 hook 感知选区 —— 在 `renderer.getSelection()?.isDragging` 期间抑制淘汰，或清除选区 —— 之所以推迟，是因为这个 CLI 里没有任何东西读取渲染器的选区：复制即选是 ink 侧路径，而错误的选区只是画错、短暂存在，并被下一次点击清掉。一旦有复制即选的绑定接到 OpenTUI 渲染器上，它就变成正确性缺陷。没有 jsdom 测试能到达这里，所以验收腿是实机：在转录里起一次拖拽，按住越过底边直到自动滚动把窗口移动超过 `OVERSCAN_ROWS`，松手，检查复制到的文本是被拖动的那一段。
- 决定 8 是在转录条目这一层为一个 bundle 级缺陷做的补偿，而同一条升级路径在其余每一棵子树上依然存活。`esbuild.config.js` 把 `process.env.NODE_ENV` 定义为 `'production'`，于是 `react/jsx-dev-runtime` 解析到的那份构建里 `jsxDEV` 是 `void 0`，而 `@opentui/react` 的根 boundary 恰恰要通过 `jsxDEV` 渲染它的 fallback。因此 banner、composer、footer 或对话框里的资源耗尽类失败仍会白屏。修复应落在构建配置或上游，不在本改动。
- 另外两个所报缺陷 —— 被读作「没有光标」的 composer 光标，以及闪烁的 markdown h3 —— 本次改动未触及。光标由另一处改动处理（#13693）；h3 闪烁目前没有任何跟踪条目。
- 在 resume 复现腿里，注入的 SGR 滚轮序列不会滚动转录。有无本次改动行为完全一致，所以那是该实验腿的属性而非窗口化的属性；同样的序列在 `s18w`/`s18x` 腿里滚动正常。作为 harness 问题留存。
