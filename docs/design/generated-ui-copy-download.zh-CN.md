# Generated UI 复制与下载

[English](generated-ui-copy-download.md) | [简体中文](generated-ui-copy-download.zh-CN.md)

状态：进行中。第 1 步（卡片运行时和宿主）由加入本文档的 PR 实现。第 2 步（skill 和评测）尚未实现。

## 问题

Generated UI 卡片无法把当前结果交到卡片之外。它的 JavaScript 运行在没有 DOM、剪贴板和下载能力的 QuickJS Worker 里，视图帧的 sandbox 也不允许这两者。#14019 的验收评测（#16811）因此有两项检查失败，参考文档和 gating 模型都是如此：

- `bill.copies-current`：复制账单拆分的当前结果后，剪贴板里什么都没有。
- `comparator.exports-current-csv`：导出比价器的当前方案时没有开始任何下载。

#14019 的计划把这两项都放在阶段 8：由宿主替卡片执行复制和下载。本文档覆盖阶段 8 的这前一半；另一半卡片修订另行推进。

## 目标与非目标

目标：

- 卡片可以在点击处理函数里，用这次点击时的值复制文本、下载一个小的文本文件。
- 由宿主而不是生成的代码执行这些动作，宿主校验收到的内容，并在卡片外显示结果。
- 浏览器拒绝延迟的剪贴板写入时，复制仍然可以完成。

非目标：

- 读取剪贴板、二进制或链接形式的下载、文件选择器。
- 为内置 Generated UI 卡片以外的 MCP App 提供复制或下载。
- 不经点击的动作，例如在初始化或输入时复制。
- 告诉模型复制或下载了什么。

## 卡片 API

```js
ui.copy(text);
ui.download(filename, mimeType, text);
```

- `text` 是非空字符串：`ui.copy` 最多 16 KiB UTF-8，`ui.download` 最多 64 KiB。
- `mimeType` 只能是 `text/csv`、`text/plain`、`application/json` 和 `text/markdown` 之一。
- `filename` 是非空字符串，最多 100 个字符。App 在发出请求前加上 MIME 类型对应的扩展名（`.csv`、`.txt`、`.json`、`.md`），Web Shell 会清理文件名并再次设置扩展名。
- 两者都返回 `undefined`。结果由宿主显示，卡片读不到。

guest 能直接判断无效的调用时会拒绝，抛出卡片可以捕获的错误，和 `ui.state.set` 一样：

- 类型错误、空值或不支持的 MIME 类型抛出 `TypeError`；
- 超过大小限制抛出 `RangeError`；
- 不在处理 `click` 事件的轮次里调用，或在同一轮里第二次调用，抛出 `Error`。

因此初始化时调用会抛错。如果没有捕获，它会结束这次激活，服务端的显示前检查会把它报告为 `VIEW_ERROR`。

## 哪些轮次会执行动作

只有同时满足以下条件，App 才执行一轮的动作：

1. App 自己为这一轮发出的请求是 `click` 类型的事件。Worker 的返回无法改变这一点。
2. 这一轮的补丁已应用。没有补丁的轮次也算已应用，复制或导出按钮通常就是这种情况。
3. 这一轮发出时用的是当前的输入修订号，所以显示和动作用的都是用户看到的值。App 判断一次更新是否“已应用”时用的也是这个条件。

否则 App 丢弃这个动作，并显示自己的提示：值已经变化，所以没有复制或下载，再点一次即可重试。这和保存的状态有意不同。状态会为每个通过校验的轮次保存，包括被取代的轮次，因为 Worker 里的数据已经变了；而复制或导出用户已经看不到的值是错的。

## 线路契约

Worker 的轮次结果新增一个可选字段：

```ts
effect?:
  | { kind: 'copy'; text: string }
  | { kind: 'download'; filename: string; mimeType: string; text: string };
```

App 把被接受的动作发给宿主：

- **复制：** 私有请求 `qwen-code/generated-ui-copy/write`，参数为 `{ text }`。宿主以实验性 capability `qwen-code/generated-ui-copy` 声明支持。
- **下载：** 标准 MCP Apps 请求 `ui/download-file`，只带一个内嵌资源 `{ uri: "file:///<filename>", mimeType, text }`。宿主只向内置 Generated UI 卡片声明 `downloadFile`。

和视图状态一样，两个请求都不指明卡片：宿主替它挂载的那张卡片作答。宿主没有相应 capability 时，App 显示“此宿主无法复制或下载”的提示，guest 的调用仍然不会抛错。

## 宿主行为

Web Shell 自己校验每个请求，不依赖 App 的检查。以下情况宿主拒绝请求：

- 卡片不是内置 Generated UI 卡片、页面是静态转录视图、卡片被隐藏或已卸载，或这张卡片的另一个动作还在执行；
- 下载带的不是恰好一个内嵌文本资源，例如 `resource_link` 或 `blob`；
- 违反上面的大小或 MIME 规则。

卸载会丢弃尚未完成的请求的结果；浏览器已经开始的剪贴板写入仍会完成。

**复制。** 宿主在 Web Shell 页面里调用 `navigator.clipboard.writeText`。视图帧里的点击会让页面获得短暂激活，浏览器会把它传播到祖先帧。写入被拒绝时，例如轮次排队期间激活已过期，宿主栏保留这段文本并显示一个宿主自己的 **Copy** 按钮。点击它时，复制发生在宿主栏自己的点击里。保留的文本会在下一次动作、重置、重新打开和卸载时丢弃。

**下载。** 宿主用文本构造一个 `Blob`，以清理后的文件名点击一个临时链接，随后释放 object URL。浏览器仍可能询问或拦截，所以结果只说明下载已开始，而不说明文件已保存。

**结果。** 宿主栏在一个 `role="status"` 元素里显示每次结果。它的 `data-generated-ui-effect` 属性取值为 `copied`、`copy-pending`（等待点击宿主栏的 Copy 按钮）、`downloaded` 和 `refused`。`data-generated-ui-effect-count` 属性随每次结果递增（包括宿主栏 Copy 按钮带来的结果），所以重复的结果（例如连续两次 `copied`）也是一次新的观测。保存状态仍使用自己的 `data-generated-ui-save` 属性。只要卡片有动作结果，宿主栏就会显示，而不再只在卡片被保留或保存状态时显示；宿主也会为内置卡片安装请求处理函数，无论它有没有卡片 id。

## 限制

| 限制                   | 值                                                            |
| ---------------------- | ------------------------------------------------------------- |
| 复制的文本             | 16 KiB UTF-8                                                  |
| 下载的文本             | 64 KiB UTF-8                                                  |
| 文件名                 | 清理前 100 个字符                                             |
| MIME 类型              | `text/csv`、`text/plain`、`application/json`、`text/markdown` |
| 每轮动作数             | 1，且只来自 `click` 轮次                                      |
| 每张卡片进行中的动作数 | 1                                                             |

## 推进步骤

1. **运行时和宿主**（本 PR）：guest 中的 `ui.copy` 和 `ui.download`、轮次结果的 `effect` 字段、App 的轮次规则、提示和请求，以及 Web Shell 的校验、复制、下载、后备按钮和结果属性，覆盖所有语言。
2. **Skill 和评测：** 在 Generated UI skill 和工具描述里教这两个调用，让参考账单拆分和比价器用它们实现复制和导出，并把 `bill.copies-current` 和 `comparator.exports-current-csv` 翻转为通过。

## 风险

- **覆盖剪贴板。** 生成的代码可以替换用户的剪贴板。只有点击能触发，每次点击一次，内容来自用户自己的值，宿主显示每次结果。
- **不想要的下载。** 每次点击一次，只有文本，大小有上限，扩展名被强制设置，文件无法伪装成可执行文件。
- **激活时限。** 在一次本地实验里（三个 origin，帧嵌套方式相同），WebKit 在点击后经过 300 ms 的中转延迟仍允许写剪贴板，延迟 1.2 s 或没有点击时则拒绝。所以排队的点击可能失去激活，由宿主栏的 Copy 按钮兜底。无头 Chromium 在没有授予权限时拒绝写入，所以没有测出它的激活规则；两个引擎在没有点击时都能开始下载。
- **其他宿主。** 没有这两个 capability 的宿主改为显示 App 的提示；实现了 `ui/download-file` 但没有私有复制请求的 MCP 宿主只能下载。

## 验证

第 1 步：

- 运行时测试：参数错误可以捕获，不在 `click` 轮次中调用或第二次调用会抛错，轮次结果带上动作。
- 服务端检查测试：初始化时未捕获的调用是 `VIEW_ERROR`。
- App 测试：只有在当前输入修订号上已应用的点击轮次才发送动作；被取代和过时的轮次显示提示；没有 capability 的宿主显示不可用提示。
- 宿主测试：上面每种拒绝、复制成功、写入被拒后的后备按钮、下载链接和文件名、递增的计数、对隐藏卡片和转录视图的拒绝。
- 在真实 daemon 上用 Chromium 做的浏览器检查：一张手写卡片能复制当前值、以清理后的文件名下载 CSV，每次结果都让计数递增；撤销剪贴板权限后，写入被拒时宿主栏提供 Copy 按钮，允许写入后点击它即可复制。在真实 daemon 上的 WebKit 页面里，Playwright 的输入既没有到达视图也没有到达 App，所以 WebKit 只由上面的激活实验覆盖。

第 2 步：

- Replay：`bill.copies-current` 和 `comparator.exports-current-csv` 通过，其余固定项不变。
- 用 gating 模型对账单拆分和比价器用例做一次 live 运行，结果写在 PR 里。

## 验收标准

- 在 Web Shell 里，点击处理函数可以复制当前文本、下载小的文本文件，宿主在卡片外显示结果。
- 初始化、input 和 change 处理函数、被取代或过时的轮次、隐藏的卡片、其他 MCP App 和转录视图都无法触发这两个动作。
- 剪贴板写入被拒后，宿主栏留下一个可用的 Copy 按钮。
- 第 2 步之后，两项验收检查在 replay 和 live 运行中都通过。
