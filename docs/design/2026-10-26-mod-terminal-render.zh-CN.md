# Mod 终端渲染：输入框上方的横带

[English](2026-10-26-mod-terminal-render.md) | [简体中文](2026-10-26-mod-terminal-render.zh-CN.md)

状态：提议中。本阶段接在 #15443 的回合事件和 #15560 的 2.1.310 基线之后，由 #13749 跟踪。它遵循 Claude Code 2.1.310 插件 API 中 `ui.render`、`$.ui.resolve`、`$.ui.invalidate` 以及全局 `h` 和 `Fragment` 的声明；除图片绘制外，这些声明自 2.1.308 起没有变化。

## 问题与现状

Token Weather 是 #13749 第一个里程碑的样例。它在输入框正上方画一行上下文窗口的"天气预报"：图标、一个词、占用百分比、token 数，以及最近几轮的走势图。它需要三样 Qwen Code 还没有的东西：

- `AbovePrompt` 组件上的 `ui.render` hook，返回由 `Box` 和 `Text` 元素组成的树；
- `$.ui.resolve(e)`，把这些元素构造函数交给 hook；
- `$.ui.invalidate("ui.render")`，它的 `turn.complete` hook 每读一次数就调用一次，让横带重画。

它用到的其他部分，`session.start`、`turn.complete` 和 `$.session.usage()`，都已经能运行。现在 Qwen Code 在加载时跳过 `ui.render` hook，并提示 `Hooks for unsupported events will not run: ui.render`；`$.ui.resolve` 和 `$.ui.invalidate` 会抛出 `Mod API not supported`。宿主端也没有任何代码能画出 Mod 返回的树。

## 目标与非目标

目标：

- 在 Ink 终端里，为 `AbovePrompt` 位置触发 `ui.render`，输入与 Claude Code 一致，并画出 hook 返回的树。
- `$.ui.resolve(e)` 返回终端的元素表，画出其中的 `Box` 和 `Text`。提供 Claude Code 的元素构造函数和 JSX 所用的全局 `h` 和 `Fragment`。
- 在 `$.ui.invalidate("ui.render")` 以及该位置的输入变化时重画横带。
- 按 Claude Code 的规则判定一棵树，不合格的树什么都不画，输入框永远不等 Mod。
- Token Weather 无需修改即可运行。

非目标，各留给后续阶段：

- 其余十四个渲染组件，例如 `Spinner`、`PromptHint`、`ToolUse` 和 `Pane`。
- 其余终端元素：`Button`、`Input`、`Select`、`Link`、`Code`、`Markdown`、`Client`、`Raster` 和 `Image`。随它们一起的还有 `ui.press`、`ui.input`、`ui.select`、`ui.focus` 和 `ui.scroll` 事件，以及横带的焦点、折叠标记和滚动。
- `ui.resolve` hook，它为其他插件改写或扣下元素。
- `$.state` 及其写入时的重画，以及 `$.clock.after` 和 `every`。
- JSX 和 `.tsx` 入口。本阶段提供 `h` 和 `Fragment`；编译 JSX 是下一步（见 PR 计划）。
- OpenTUI 终端。在它那一步合入之前，OpenTUI 不提供这个位置；headless 运行没有可绘制的 surface。

## 方案

### 1. 绘制位置

hook 收到 Claude Code 为横带定义的输入：

| 字段                | Qwen Code 中的值                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `surface`           | `"terminal"`                                                                                                                |
| `component`         | `"AbovePrompt"`                                                                                                             |
| `requestId`         | `"above-prompt"`，唯一的实例                                                                                                |
| `viewport`          | `{ columns, rows, isFullscreen }`：终端尺寸，以及 Ink 是否在备用屏幕上绘制，与 `command.run` 的 `presentation` 携带的值相同 |
| `props.hasSurvey`   | 会话反馈调查显示在输入框上方时为 `true`                                                                                     |
| `props.isWorking`   | 模型回合进行中时为 `true`                                                                                                   |
| `props.maxRows`     | 横带可占的行数：终端行数的三分之一，至少 1 行                                                                               |
| `props.bodyColumns` | 输入区宽度减去 5 列，即 Claude Code 为折叠标记预留的位置                                                                    |
| `props.scroll`      | `{ offset: 0, bodyRows: maxRows - 1 }`                                                                                      |
| `props.view`        | `{}`：横带只画在主对话下，从不画在 agent 标签页里                                                                           |

`surface`、`component`、`requestId`、`viewport` 和 `props.view` 不可修改：改写时改动或去掉它们，hook 即判为失败。其余 props 须保持原类型。`next(e)` 解析为引擎自己的节点 `{ type: "engine", ref: 0 }`，它在这个位置什么都不画。没有 hook，或所有 hook 都把 `next(e)` 原样传下去时，横带不占任何行。

### 2. 横带何时重画

位置的输入变化、Mod 加载时、插件请求时，都会运行一次渲染：

- **输入键**由视口的 `columns` 和 `isFullscreen` 以及 props 组成，按稳定的 JSON 比较。只改高度不会触发渲染，除非它改变了 `maxRows`。宽度或 `maxRows` 变化后要稳定 150 毫秒才运行，所以拖动调整窗口大小只跑一次渲染。
- **第一次渲染**在 `session.start` 之后运行；切换会话（`/clear`、`/resume`、`/branch`）之后也会再跑一次，因为横带依据的信息可能变了。
- **`$.ui.invalidate("ui.render")`** 请求重画调用方插件的 `ui.render` 注册可能选中的每个位置，并立即返回。Qwen Code 的 Mod 还没有定时器，所以这个调用总是来自其他某次调度，例如 `turn.complete`，渲染在那次调度结束后运行。多次调用会合并：一连串调用只跑一次渲染。渲染最多每 34 毫秒一次，即 Claude Code 对展开横带的频率。与 Claude Code 相同，某个插件的一次渲染超过这个时长时，它在随后一秒内降为常规频率，即每 100 毫秒最多一次，所以每次渲染都请求重画自己的 hook 不会一直占住调度队列。Claude Code 也允许对 `prompt.section` 等缓存事件调用 `$.ui.invalidate`；Qwen Code 里没有可丢弃的缓存，这类调用什么也不做。

渲染与命令、工具中间件和回合事件共用会话的调度队列，因为 Mod worker 一次只跑一个根调度：

- 新答复到来之前，横带保持上一棵树。第一次答复到来之前什么都不画。输入框从不等待渲染。
- 最多只有一个渲染在等待。更新的输入会替换正在等待的那个。
- 正在运行的渲染不会为了给更新的渲染让路而被取消。worker 若在 250 毫秒内处理不完取消，就会被终止，这会结束本会话的所有 Mod。更新的渲染改为等待。
- 排在工具调用后面的渲染，会一直等到该调用执行完、它的审批结束。

### 3. 元素、`h` 和 `Fragment`

`$.ui.resolve(e)` 不经调度，直接读取 `e.surface` 的元素表。这张表是一个冻结、无原型的对象。终端的表包含 Claude Code 声明的全部十一个构造函数，所以解构出 `Button` 的 Mod 也能加载。本阶段只画 `Box` 和 `Text`；含其他元素的树判为不合格，原因是 `<Element> is not drawn by Qwen Code yet`。参数不是 surface 已知的 `ui.render` 输入时，调用抛错。

构造函数接受 props（其中包括 `children`），返回一个深度冻结的纯数据元素，与 Claude Code 一致：

- `{ type, props?, hover?, children? }`，空的 `props` 和 `children` 省略；
- children 压平：丢弃 `null`、`undefined` 和布尔值，展开数组，数字转成字符串；
- `key` 只保留在 `Box` 上，转为字符串；
- `hover` 移到 props 旁边；会做校验，但本阶段不绘制。

`h(tag, props, ...children)` 和 `Fragment` 是每个插件环境里的全局量，与 Claude Code 相同。`h` 遇到函数形式的 tag 时，用 props 和压平后的 children 调用它，children 总是数组，与 Claude Code 的 `h` 相同。未知的字符串 tag 抛出 Claude Code 的报错 `JSX element <X> is not an element: a render hook draws with the table $.ui.resolve(e) returns`。`Fragment` 返回一个包住子节点的纵向 `Box`。

### 4. 判定一棵树

每个 hook 的答复按它返回时的样子单独检查；调度链结束后，整棵树再检查一次。两次检查都由 core 里的同一个模块完成，分别在 worker 端和宿主端，规则与 Claude Code 相同：

- 根节点必须是元素，不能是字符串；最多 32 层、20,000 个节点；
- `Box` 和 `Text` 只接受 Claude Code 的 props，每个都有取值规则：枚举、数值范围、以单元格或百分比表示的尺寸、以单元格或 `xs` 到 `xl` 档位表示的间距，以及符合 Claude Code 颜色模式的颜色；
- `Text` 只能包含字符串和 `Text`；`Text` 里放 `Box` 不合格；
- 引擎节点可以放在普通 `Box` 里，不能放在 `Text` 里，也不能放在设置了 `display`、`overflow`、`position`、尺寸或偏移的 `Box` 下；
- 文本里不能有控制字符，制表符、换行和回车除外。

答复不合格的 hook 单独跳过：它的 `.catch` 会运行，它从 `next(e)` 拿到的结果仍然生效，或者由下一个处理器代替它运行。最终的树不合格时什么都不画。被接受的树再按 Claude Code 的方式调整：

- `Box` 的 `key` 若不是 1 到 10,000 个字符的字符串，就去掉；
- 终端没有的 `borderStyle` 画成无边框；
- 文本总量超过 100,000 个字符时截断，结尾写 `… <n> more characters, not drawn`；截断不会拆开代理对。

调试日志用 Claude Code 的原话记录每次拒绝和调整，例如 `<plugin>: ui.render hook skipped: returned the wrong shape (a tree AbovePrompt refuses: <reason>)` 和 `<plugin>: ui.render (AbovePrompt) refused: <reason>; nothing was drawn`。拒绝按原因每次加载记一次，调整按位置和类别每次加载记一次，所以每次渲染长度都在变的文本截断只记一次。Claude Code 也会把这些行显示在对话记录里，但只在热重载插件目录时。Qwen Code 还没有热重载，所以这些行只进调试日志。

### 5. 在 Ink 中绘制

- **位置。** 横带放在输入区里，位于会话反馈调查和输入框之间，只在输入框显示时显示。占用输入区位置的对话框会把它一起替换掉。agent 标签页使用自己的输入区，不显示横带。
- **尺寸。** 横带最多 `maxRows` 行高，更高的树会被裁掉。它按 `bodyColumns` 的宽度布局，超出输入区宽度的水平内容会被裁掉。
- **映射。** `Box` 画成 Ink 的 `Box`，`Text` 画成 Ink 的 `Text`，并做以下转换：
  - `Box` 里的字符串画成一个 `Text`；
  - 文本换行值 `end` 和 `middle` 分别转换为 `truncate-end` 和 `truncate-middle`；
  - 间距档位换算成单元格：`xs` 和 `sm` 为横 1、竖 0，`md` 为 2 和 1，`lg` 为 3 和 1，`xl` 为 4 和 2；
  - `weight: "semibold"` 或 `"bold"` 画成粗体；`size`、`mono`、`tabular` 和 `dir` 丢弃，与 Claude Code 的终端一致；
  - 属于 Claude Code 主题键的颜色映射到当前 Qwen Code 主题：`text` 对应主文本色，`subtle` 和 `inactive` 对应次文本色，`success`、`error` 和 `warning` 对应状态色，`claude` 和 `suggestion` 对应强调色；
  - Claude Code 的其他主题键，例如 `permission` 或 `diffAdded`，本阶段画成默认颜色；
  - 其他颜色在 Ink 能接受时（颜色名或十六进制值）照常绘制，否则画成默认颜色；
  - 所有文本都做终端清洗，与 Mod 的对话记录行相同；制表符展开为空格，补到下一个 8 列制表位，与 Claude Code 的 Ink 相同。
- **失败处理。** 横带外面包一个错误边界。绘制时抛错的树什么都不显示，这个答复也不再重画；下一个答复重新绘制。
- **布局。** Ink 会测量对话记录下方各控件的高度，来确定对话记录视口的大小。横带的高度要加入这次测量的输入，和 live agent 面板现在的做法一样，这样备用屏幕就不会把输入框裁掉。
- **接线。** 交互式 Mod 会话新增一个小 store，保存横带的上一棵树。横带用 `useSyncExternalStore` 读取它。Ink 把位置的输入报告给会话，由会话计算输入键并排队渲染。

### 6. 哪些宿主触发这个位置

`load` 请求列出宿主能绘制的渲染位置。Ink 列出 `AbovePrompt`；本阶段 OpenTUI 和 headless 运行都不列。worker 只在提供了位置的宿主里把 `ui.render` 算作已支持：

- 在其他宿主里，`ui.render` hook 照旧被跳过，并列在启动提示行里。
- `$.session.version()` 只在 `ui.render` 会运行的宿主里列出它。
- `$.ui.resolve` 和 `$.ui.invalidate` 在所有宿主里都可用，所以请求重画的 `turn.complete` hook 在不绘制的宿主里也不会失败。

加载结果告诉宿主是否有插件挂了 `ui.render`，只有这时 Ink 才排队渲染。两种终端里 `$.session.surfaces()` 都保持为 `["terminal"]`。

## 设计决策

- **先做一个位置。** `AbovePrompt` 是 Token Weather 绘制的位置，而且引擎在这里什么都不画，`next(e)` 很简单。整条链路都在它上面搭起来并测试：调度、元素模型、校验、排程和绘制。之后的位置只需增加 props 和引擎节点。
- **数据树，由宿主绘制。** Mod 从不接触 Ink。它的答复以 JSON 形式跨过 worker 边界，受现有的大小和深度限制约束；之后 OpenTUI 也能画同一棵树。
- **不靠取消来替换渲染。** Claude Code 会中止过期的渲染。在 Qwen Code 里，取消可能终止 worker，结束本会话的所有 Mod，所以渲染改为合并和等待。
- **完整沿用 Claude Code 的校验，包括本阶段不绘制的部分。** 对 `Box` 和 `Text` 而言，Qwen Code 接受的树 Claude Code 也接受，反之亦然。在这里测过的 Mod 到 Claude Code 里不会出错，`hover` 以后开始绘制时也照样能通过校验。
- **由宿主提供位置。** Ink 和 OpenTUI 报告的 surface 都是 `terminal`，所以支持与否不能由 surface 名决定。`load` 请求里的能力字段让每个宿主提供它能绘制的位置。

## 与 Claude Code 的差异

以下内容写入用户指南：

- 只触发 `AbovePrompt` 位置，且只在 Ink 中。`Box` 和 `Text` 以外的元素会使整棵树不合格。
- 横带没有折叠标记、焦点、滚动和 `n more` 行。高于 `maxRows` 的树会被裁掉。`maxRows` 取终端行数的三分之一；Claude Code 在全屏时给出底部槽剩余的行数，否则给出终端高度。`bodyColumns` 保留 Claude Code 的五列预留。
- `$.ui.invalidate` 在调用它的那次调度结束后才生效，因为 Qwen Code 的 Mod 没有定时器。
- 渲染可能要排在工具调用及其审批之后，期间横带保持上一棵树。排在正在运行的渲染后面的工具调用、命令或回合事件也要等待该渲染完成，最长为链上每个 `ui.render` hook 各 10 秒。
- `ui.resolve` hook 作为不支持的事件被跳过。`hover` 会校验，但不绘制。
- 拒绝信息只进调试日志，因为 Qwen Code 没有热重载。
- 虽然有 `h` 和 `Fragment`，但还不编译 JSX。

Token Weather 样例读取的是 `e.hasSurvey` 和 `e.bodyColumns`，但 Claude Code 把这两个字段都声明在 `e.props` 下。所以无论在 Claude Code 还是 Qwen Code 里，这个样例都从不给调查让位，并且总按 80 列布局。Qwen Code 保持 Claude Code 的输入结构，不加别名。

## PR 计划

1. **Core。** `ui.render` 根调度、`$.ui.resolve`、`$.ui.invalidate`、`h` 和 `Fragment`、树校验、`load` 中的宿主能力字段和加载结果标志。还没有宿主提供位置，所以什么都不会绘制。测试使用真实的 worker。
2. **Ink。** Mod 会话中的渲染排程、store、输入区里的横带、布局测量输入，以及用户指南。Token Weather 端到端可运行。
3. **JSX。** `.tsx` 和 `.jsx` 入口及导入，用 `h` 工厂和 `Fragment` 编译。
4. **OpenTUI。** 同样的横带，由同一棵归一化后的树绘制。

每一步是一个单独的 PR。第 2 步之后，第 3 步和第 4 步可以并行。

## 验证与验收

- 真实 QuickJS worker 测试：
  - 元素表：冻结、十一个名字，其余九个使树不合格并给出原因；
  - 构造函数、children 和 key，以及 `h` 和 `Fragment`；
  - 每条校验规则，以及 Claude Code 的原因文字；
  - 失败的 hook 被跳过且其 `.catch` 运行，以及不合格的最终树；
  - 文本截断、去掉的 key 和 `borderStyle` 的退化；
  - `$.ui.invalidate` 在其调度结束后到达宿主；
  - `ui.render` 只在提供了位置的宿主中算作支持，体现在启动提示行和 `$.session.version()` 中。
- Mod 会话测试：
  - 每种输入变化都触发渲染，只改高度时不触发；
  - 150 毫秒的稳定等待；
  - 合并；
  - 不取消正在运行的渲染，以及它与工具调度的先后顺序；
  - 切换会话，以及关闭会话；
  - 失败的渲染什么都不画。
- Ink 测试：
  - 横带位于输入框上方，被对话框替换，在 agent 标签页中不出现；
  - props、间距档位、主题键和颜色的映射；
  - 在 `maxRows` 处裁剪；
  - 错误边界；
  - 布局测量包含横带。
- 用构建好的 CLI 连接夹具服务器，原样安装 Token Weather：
  - Ink 在第一次读数后于输入框上方显示预报行，并在每轮之后重画；
  - 调整窗口大小后按新宽度重画；
  - 调查出现时 `hasSurvey` 为真；
  - headless 和 OpenTUI 运行在启动提示行中列出 `ui.render`，其余功能正常。

验收标准：Token Weather 的那一行在 Ink 中显示，包含其截图中的图标、词、百分比、token 数和走势图，并在每轮之后更新，且不拖慢输入框。

## 风险与未决问题

- 横带会占用对话记录的行数。三分之一终端高度的上限让它保持很小。是否要更贴近 Claude Code 的全屏底部槽，尚未决定。
- 排在长时间工具调用后面的渲染会让横带过时。对每轮才变一次的横带来说可以接受。worker 支持并发根调度后可以解决。
- 慢的渲染 hook 会让排在它后面的工具中间件延迟，最长为链上每个 `ui.render` hook 各 10 秒。
- 由于没有热重载来显示拒绝信息，是否在 `--debug` 下把它们也写进对话记录，尚未决定。
