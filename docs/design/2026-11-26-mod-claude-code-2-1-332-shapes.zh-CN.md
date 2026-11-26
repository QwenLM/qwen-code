# 为 Claude Code 2.1.332 编写的 Mod

[English](2026-11-26-mod-claude-code-2-1-332-shapes.md) | [简体中文](2026-11-26-mod-claude-code-2-1-332-shapes.zh-CN.md)

状态：提议中。由 #13749 跟踪。本文依据 Claude Code 2.1.332 的插件 API 声明，是计划中的第一片：让按当前 Claude Code 版本编写的 Mod 能够加载，并能绘制。

## 问题与现状

Mod 运行时认得的是 Claude Code 2.1.318 的事件和数据形状。从 2.1.318 到 2.1.332，Claude Code 新增了一批事件名，Mod 自己提交的若干数据形状也加了字段。Qwen Code 对这些形状逐一按严格白名单检查。于是一个用了新名字或新字段的 Mod，在 Claude Code 里能加载、能绘制，在这里却会失败：

- **挂在新事件上的 hook。** `on()` 拒绝不认识的名字。只要已安装的任何一个 Mod 注册了 `session.stop`、`tool.run`、`ui.tip` 或 `vcs.*`，整个会话的 Mod 初始化都会失败，其它 Mod 也跟着不能用。
- **使新事件失效。** `$.ui.invalidate('tool.offer')` 抛错，`tool.list` 和 `ui.offer` 同样如此。
- **命令声明。** `$.command.register` 只接受 `name`、`description` 和 `argumentHint`。声明里只要还带了 `aliases`、`isHidden`、`isTerminalOnly`、`isWorkspaceFree`，或者更早就有的 `immediate`，就会被拒绝。
- **命令答复。** 带 `isTextDisplayOnly` 的 `command.run` 答复会被拒绝。
- **回合结束答复。** 带 `by` 的 `turn.complete` 答复会被拒绝。
- **提示符上方的 band。** 树里用了 `Progress`、`maxLines`、`wrap: "clip"`，或者 Box 的 `overflowX`、`mono`，就会被拒绝。

实测到的失败表现记录在[基线](#基线)一节。

## 目标与非目标

目标：

- 一个为 2.1.332 编写、只用到 Qwen Code 已运行能力的 Mod，能加载、能注册命令、能绘制 band。
- 每个新字段要么实现，要么接受后丢弃。规则是：如果忽略某个字段会让 Mod 做出作者明确选择不做的事，就实现它；否则只校验形状，然后丢弃。
- Qwen Code 不运行的名字保持现有行为：能加载，挂在上面的 hook 被跳过，每个插件报告一次。

非目标：

- 运行任何新事件（`session.stop`、`tool.run`、`tool.judge`、`tool.offer`、`ui.tip`、`vcs.*` 等）。
- 新的 `$` 方法（`$.agent.call`、`$.theme.*`、`$.wasm.compile` 等），以及新的渲染位置（`StatusLine`、`BesidePrompt` 等）。
- 命令答复的 `context` 和 `exitCode`。它们会在后面的切片里随模型上下文一起做。

## 兼容契约

以下内容遵循 2.1.332 的声明。

1. **事件名。** 可识别的事件表换成 2.1.332 的版本，包括引擎事件、`$` API 事件和 `classic.*` settings hook 事件。新增 25 个名字（含 `classic.PreSkillShellCommand`），以及 `vcs` 等新命名空间。`$.session.version()` 报告 `claudeCode: "2.1.332"`。
2. **可失效的事件。** `$.ui.invalidate` 接受的列表新增 `tool.list`、`tool.offer` 和 `ui.offer`。
3. **命令声明。**
   - `aliases`：最多 8 个名字，每个的写法规则与 `name` 相同。不论输入的是哪个名字，`command.run` 收到的都是规范的 `name`。如果某个别名已被另一个 Mod 命令占用（作为名字或别名，比较时不区分大小写），整次注册都会被拒绝。
   - `isTerminalOnly`：在交互式终端之外不列出；输入时会报告"不可用"，不会运行。
   - `immediate`、`isHidden` 和 `isWorkspaceFree`：接受，值为 `true`。
4. **命令答复。** 接受 `isTextDisplayOnly: true`。
5. **回合结束答复。** 接受 `by`（字符串列表）。这个字段归引擎所有，hook 写进去的内容会被引擎替换。
6. **band 的元素和属性。**
   - `Progress` 是叶子元素，属性有 `label`（不能为空）、`value`、`max`、`valueText` 和 `color`。
   - Text 接受 `maxLines`（从 1 开始的整数）和 `wrap: "clip"`。
   - Box 接受 `overflowX: "visible" | "scroll"` 和 `mono`。
   - 设置了 `mono` 的 Box 里不能放引擎自己绘制的内容，这一点和设置了尺寸的 Box 一样。
   - `anchor` 仍然拒绝：它只在 `BesidePrompt` 中有效，而 Qwen Code 不绘制 `BesidePrompt`。

## Qwen 的设计决定

- **`ui.backdrop` 继续认得。** Claude Code 2.1.332 去掉了它，但为 2.1.318–2.1.331 编写的 Mod 可能还在用。继续认得它，这类 Mod 就能加载，只是这个 hook 被跳过，而不是整体失败。
- **丢弃的字段只走到校验为止。** `immediate`、`isHidden`、`isWorkspaceFree`、`isTextDisplayOnly` 和 `by` 在 worker 里校验形状后就被去掉，任何宿主类型都不会多出一个没人读的字段。
  - `immediate`：回合进行中输入的 Mod 命令本来就会等回合结束，这正是不带这个标志时的行为。若在回合中途运行，也会撞上 worker 一次只处理一个派发的规则。
  - `isHidden`：Qwen Code 的隐藏命令不参与任何查找，隐藏了就连输入也无法运行。所以命令照常列出。忽略这个标志只会显示一个作者想低调处理的命令，不会运行作者没有要求的东西。
  - `isWorkspaceFree`：Qwen Code 没有远程附着的终端，这个标志没有可以改变的东西。
  - `isTextDisplayOnly`：Mod 命令的文本本来就是一条信息行，不会进入任何模型请求。
  - `by`：Qwen Code 显示的每条 note 本来就标出了插件名。
- **别名沿用 Qwen Code 现有的解析规则。** 主名字优先于别名，所以和内置命令或其他扩展命令同名的别名不会运行这个 Mod 命令。两个 Mod 之间共用名字或别名，在注册时就会被拦下。
- **headless 运行中的 `isTerminalOnly`。** 命令只声明为交互模式可用。headless 运行本来就认得其它模式的命令，并以 `The command "/<name>" is not supported in this mode.` 拒绝它们，所以这一行不会变成发给模型的提示，也不需要新增提示文案。
- **终端如何绘制新属性。** 各渲染器的外观由 Qwen Code 自己决定：
  - `wrap: "clip"` 按 `truncate-end` 绘制，截断标记沿用各终端的做法：Ink 显示 `…`，OpenTUI 不显示标记。
  - 没有截断式 wrap 时，`maxLines: 1` 按 `truncate-end` 绘制，与单行截断一样。`maxLines` 更大时，把 Text 截到那么多行。
  - `overflowX: "scroll"` 把其中每个 Text 截在 Box 边缘：如果 Text 自己的 wrap 已经会截断就照它的，否则按 `truncate-end`。在这样的 Box 里，`maxLines` 不起作用；自己设了 `width` 的 Box 按原样保留其中的内容。
  - `mono` 在终端上不产生任何变化，终端本来就是等宽的。
  - `Progress` 绘制为：label、10 格进度条，再加 `valueText`；没有 `valueText` 时显示整数百分比。没有已知终点的 Progress 绘制 label 加上它的 `valueText`；没有 `valueText` 时绘制一个暗色省略号。
- **`blur` 仍然拒绝。** Claude Code 只在 Box 放在允许模糊层的位置时才接受它：Box 本身绝对定位或包含绝对定位的子节点，里面只有 Box、Text 和非交互的 Svg，一棵树最多四个，并且树里有引擎节点时一个都不能有。终端会把它画成清晰的，所以只接受取值，就会让 Qwen Code 画出 Claude Code 拒绝的树。它的位置规则和检查这些规则的切片一起做。
- **两个终端一致。** Ink 和 OpenTUI 通过共用的 band 辅助函数，以相同方式绘制这些属性。`modBandLayout` 会去掉 `overflowX` 和 `mono`，两个渲染器都不会收到自己不认识的属性。

## 宿主接口

这一片不需要宿主新提供任何东西。字段的校验和丢弃在 worker 里完成；命令加载器从它已经收到的声明里读取 `aliases` 和 `isTerminalOnly`；渲染器读的仍是它本来就绘制的那棵树。

## 基线

在 `main`（`a37a7612c9`）上实测：使用打包后的 CLI、隔离的 `HOME` 和本地回环的模型 fixture。

| Mod                                                                    | 实测表现                                                                                                    |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 已安装的某个 Mod 挂了 `session.stop`                                   | 整个会话的 Mod 初始化失败：headless 运行在发出任何模型请求之前就以 exit 1 退出，其它 Mod 也都不运行。       |
| `$.command.register` 带 `aliases`，或带 `isTerminalOnly` 和 `isHidden` | 报 `Invalid Mod command specification.`；命令没有注册上，于是 headless 下的 `/pa hi` 被当作提示发给了模型。 |
| `$.ui.invalidate('tool.offer')`                                        | 抛出 `$.ui.invalidate takes ui.render or a cached-answer event, not tool.offer`。                           |
| `turn.complete` 答复 `{ ...next, text, by }`                           | 这条 note 消失了，也没有任何一行说明原因；不带 `by` 时同一条 note 能正常显示。                              |
| band 树里用了 `maxLines`、`wrap: "clip"` 和 `overflowX`                | Ink 中 band 一片空白。                                                                                      |
| `$.ui.resolve(e).Progress`                                             | 为 `undefined`。                                                                                            |
| Claude Code 的 token-weather 示例，原样运行                            | 在 Ink 和 OpenTUI（Bun 下设 `QWEN_TUI_RENDERER=opentui`）中都能画出 band。                                  |

## 验证与验收

- 单元测试：
  - 事件表与 2.1.332 的声明集合相等；
  - 每个新字段都被接受，Qwen Code 会运行的那些能到达命令加载器，而真正未知的键仍被拒绝；
  - Mod 之间的别名冲突会拒绝注册；
  - `label` 为空的 `Progress` 会被拒绝；
  - `mono` 会挡住引擎节点；
  - Ink 和 OpenTUI 按上文所述绘制 `Progress`、`maxLines`、`clip` 和 `overflowX`。
- 集成测试（`integration-tests/cli/mods-claude-332.test.ts`）使用为本改动编写的 Mod fixture。它挂 `session.stop` 和 `vcs.*`，注册一个带别名的命令和一个 `isTerminalOnly` 命令，并返回 `by`。测试检查：插件能加载且它的 note 能显示；别名能运行，且 `command.run` 收到的是规范名字；headless 下的终端专用命令被拒绝，且没有发出模型请求。
- 交互检查：原样运行 Claude Code 的 token-weather 示例，它在 Ink 和 OpenTUI 中都能画出 band。另用一个探针 Mod，在两个终端里分别绘制 `Progress`、`maxLines` 和 `clip`。

## 留给后续切片

Claude Code 2.1.332 在 Qwen Code 已运行的面上还改了下面这些。这一片保持原样：

- **提示符上方的 band 变成每个插件一行。** `AbovePrompt` 对每个挂了它的插件各问一次，带上 `e.plugin`，再由 `AbovePromptList` 把各行堆起来。它的输入还新增了 `isCollapsed`。Qwen Code 仍然用一条链画一个 band，所以不调用 `next(e)` 就直接答复的 hook 会把排在它后面的插件的行挡住。随 Pane 切片（S2）一起做。
- **`blur`** 及其位置规则，见上文。S2。
- **`tool.call`**：检查结果的 hook 即使已经调用过 `next`，也能在 `.catch` 里拒绝。**`tool.check`**：`op` 和 `isCeilingUnread` 两项事实，以及只写出发起询问的插件的 ask。随文件与进程切片（S3）一起做。
- **代理的 `turn.start`**：现在每个 hook 都会收到；另外在代理的首个请求之前，最多等这些 hook 三秒。随模型上下文切片（S4）一起做。
- **`CommandPresentation.isColorless`**，以及碰到用量上限时立刻以 API 错误拒绝的 `$.model.complete`。放在 S1 的后续改动里。

## 风险与待定问题

- `maxLines` 大于 1 时，最后一行被截掉后不显示省略号。
- 用 `isTerminalOnly` 想对 ACP 客户端隐藏命令的 Mod 看不到变化：ACP 目前还不提供 Mod 命令。
- 标了 `isHidden` 的命令仍会出现在补全和 `/help` 中。
