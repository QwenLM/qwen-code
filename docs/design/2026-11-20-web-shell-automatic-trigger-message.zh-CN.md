# Web Shell 自动触发消息展示

[English](2026-11-20-web-shell-automatic-trigger-message.md) | [简体中文](2026-11-20-web-shell-automatic-trigger-message.zh-CN.md)

## 问题与现状

自调节 `/loop` 唤醒或 cron 触发会以带 `source: 'loop'` 或 `source: 'cron'` 的 user 角色记录进入 transcript。其 prompt 并不是用户当时亲自输入的消息。

Web Shell 目前把所有 user 角色记录都交给普通 `UserMessage` 气泡渲染。因此，每次 tick 的长延续 prompt 都会显示为一个用户大气泡。在作为动机的会话中，6 条自动记录各含 640–915 个字符，并重复了大量状态和约束。source 目前已驱动时间线上的时钟标记，但尚未影响消息正文。

现有 `ScheduledTaskRunMessage` 处理独立 per-run 定时任务的结构化 prompt，不覆盖普通的会话内 cron 触发或自调节 `/loop` 唤醒。Issue #17267 跟踪待唤醒状态的可见性，与本设计互补，但不覆盖这里的 transcript 展示。

## 目标

- 将普通 `cron` 和 `loop` 输入展示为紧凑的自动触发卡，而不是普通用户气泡。
- 显示一行 prompt 摘要，并保留现有外层消息时间戳的语义。
- 当详细展示文本能提供摘要之外的有效内容时，通过明确的展开控件显示。
- 保留现有 per-run 定时任务卡、附件、消息编辑、重试、source 元数据以及 turn/tool-call 行为。
- 静态 document 导出无需交互即可阅读。
- 避免构造被折叠详情隐藏的富文本。

## 范围边界

- 仅改 Web Shell 展示及对应的实测文档导出体积上限，不改调度、取消、模型输入、transcript 记录、回放元数据或 daemon API。
- 不把 tick 按 Loop 重新分组，不臆造 Loop 次数或 chain ID，也不为每个 tick 创建独立会话。
- 不增加待唤醒角标、定时任务控制或新的设置项。
- 本切片不改变自动 user turn 的含义或可编辑性。
- 不把 `message.timestamp` 声称为调度器的实际触发时间：排队执行会使它晚于 `firedAt`，而 UI 投影没有这个独立字段。
- 不宣称能展示 autonomous 或 `loop.md` tick 的完整 `modelText`；这些记录的持久化 `displayText` 有意只包含短 echo。本切片不增加模型输入审计协议。

## 拟议改动

### 消息接线

`MessageItem` 将已有的 `message.source` 传给 `UserMessage`，`MessageList` 复用同一来源 predicate，使时间线与正文分类一致。adapter 和消息比较器已经保留并比较该字段，因此不需要修改数据模型。现有外层 `MessageTimestamp` 仍是唯一的时间展示，并保持当前语义。

### 自动触发展示

只有同时满足以下条件时，`UserMessage` 才选择自动触发展示：

1. `source` 严格等于 `cron` 或 `loop`；且
2. 内容不匹配现有结构化 per-run 定时任务 prompt。

两种 source 使用同一个自动触发标签。持久化回放目前会把二者统一为 `cron`，若按 source 显示 Loop 专属标签，同一条消息在重载后就会改变外观。

摘要由原始展示文本折叠空白后生成，并通过 CSS 在视觉上截断，不缩短已存储或复制的文本。不从 prompt 文本推断调度或任务元数据。

interactive 和 readonly 视图默认显示紧凑摘要。既有“显示更多/收起”控件通过现有用户内容渲染管线显示完整展示文本，保留 annotations、链接、slash 高亮、附件引用与宿主定制。普通短 prompt 也保留该控件，避免窄屏布局使用户无法查看全文。

仅运行时的完整短 echo——`Autonomous loop tick`、`Loop tick — tasks from project loop.md`、`Loop tick — tasks from home loop.md` 和 `Loop tick — loop.md temporarily unavailable`——显示为无展开控件的静态紧凑卡片。这些标签有意不包含完整 `modelText`。仅以 `Loop tick — ` 开头的真实 prompt，或带未知未来 source label 的真实指令，仍在 interactive 视图保留展开控件，并在 document 导出中保留完整正文；匹配器按 fail-open 处理。

document 模式遵循默认展开的 `TranscriptDocumentExpandedContext`，且不显示交互式展开控件。详细内容默认包含；短 echo 不需要重复正文，并在调用内置 parser 前即被排除。

内置 renderer 路径中的富文本按需构造。关闭的 interactive 展开区不会调用默认 parser；展开时构造一次，默认展开的 document 输出也仍构造完整内容。宿主提供 `renderUserMessageContent` 或 `parseUserMessageContent` 时，绕过自动卡片变体，继续由宿主原有的完整内容替换或脱敏契约控制显示，不在其输出周围重新夹带原始摘要。

现有气泡和 selectors 保持不变。新增专用 selector 与 `data-source` 属性供浏览器测试识别。图片、文件、重试入口和内联编辑器继续留在当前外层布局中；编辑器仍使用完整原文。

自动触发卡禁用通用 400 px 溢出展开控件，避免用户连续展开两次。普通消息与 per-run 消息的该行为不变。

### 样式与本地化

在 `UserMessage.module.css` 中添加作用域样式，复用现有定时任务卡的视觉 tokens、图标处理、元信息换行与语义颜色。在 `i18n.tsx` 添加英文 `userMessage.automatic.title`，并分别在 `i18n-zh-cn.ts`、`i18n-zh-tw.ts` 与 `i18n-ru-part5.ts` 添加简体中文、繁体中文和俄文标签，使所有支持的 catalog 都显示本地化标题。

## 关键设计决策

| 决策                                              | 理由                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 修改 `UserMessage` 展示变体，不改 transcript role | user 角色记录仍是 turn 起点，现有编辑、删除、重试、时间线和 tool-call 消费者继续看到同一条消息。 |
| 在 `UserMessage` 内部接入                         | 保留附件、自定义内容渲染、编辑、失败处理与 per-run 卡片，不建立平行消息路径。                    |
| 优先使用现有 per-run 卡片                         | 其结构化任务名、cron、task ID、触发方式和 session mode 比通用自动卡信息更完整。                  |
| 使用与 source 无关的可见标签                      | 回放把持久化自动记录映射为 `cron`；同一次 tick 不能在重载后被重新标成别的类型。                  |
| 只保留现有外层时间戳                              | 当前值是投影/执行时间，不一定是调度触发时间；卡片内再显示一次会重复并夸大其含义。                |
| 短 echo 不显示冗余展开控件                        | 短 echo 已完整可见，而完整模型输入不能由当前投影提供；“展开完整指令”既无意义也有误导性。         |
| 按需构造详情内容                                  | 长会话不应为了显示紧凑摘要而解析或宿主渲染每一条隐藏指令。                                       |
| 不按 wakeup ID 分组                               | 自调节 rearm 会创建新的 one-shot ID，它不是稳定的 Loop 链身份。                                  |

## 涉及文件

- `packages/web-shell/client/utils/automatic-trigger.ts` 与对应测试 — 统一的 source 与 fail-open echo predicate。
- `packages/web-shell/client/components/MessageList.tsx` — 为时间线分类复用该 predicate。
- `packages/web-shell/client/components/MessageItem.tsx` — 传递 source。
- `packages/web-shell/client/components/messages/UserMessage.tsx` — 选择紧凑变体、保留宿主覆盖控制并按需构造详情。
- `packages/web-shell/client/components/messages/UserMessage.module.css` — 作用域卡片与展开样式。
- `packages/web-shell/client/i18n.tsx`、`i18n-zh-cn.ts`、`i18n-zh-tw.ts` 与 `i18n-ru-part5.ts` — 所有支持 catalog 的标签。
- `packages/web-shell/client/i18n.test.ts` — 本地目录覆盖。
- `packages/web-shell/client/components/MessageItem.dom.test.tsx` — props 传递和 source 更新覆盖。
- `packages/web-shell/client/components/messages/UserMessage.test.tsx` — 组件行为与回归覆盖。
- `packages/web-templates/src/export-html/build.mjs` — 针对新增展示及既有静态导出行为，实测并调整 renderer 体积上限。
- `packages/web-shell/client/e2e/web-shell.automatic-trigger-message.spec.ts` — 确定性浏览器覆盖与截图。

## 验证计划

- 单测覆盖 `cron` 与 `loop`、普通/未知 source、per-run 优先级、展开、短 echo 控件抑制、宿主渲染惰性、附件、编辑、source 触发的重置、空内容、document 展开，以及以 `Loop tick — ` 开头的真实指令在 interactive 和 document 视图中的保留。验证自动触发标题在所有支持的 catalog 中均已本地化。
- 验证现有 `MessageItem` 仅改变 source 时会更新转发的 props，并验证普通长消息在 source 变为自动来源后恢复紧凑状态。
- 运行聚焦 Web Shell 测试、包级 typecheck、lint 和 format 检查，再运行贡献流程要求的仓库 build 与 typecheck。重建 `dist/transcript.js` 与 web-templates，确认实测 renderer 为 2,151,698 字节，低于调整后的 2,152,000 字节上限，本地余量为 302 字节。回归用例覆盖未知 `tasks from` source label、宿主的独立替换或脱敏渲染、readonly 展开，以及不需要 document parser 的已知 echo。
- 用同一组 cron、loop、普通和 per-run fixture 对 baseline 与修改后构建运行 Playwright 场景，在桌面与移动宽度截取紧凑和展开状态，并断言 document 无横向溢出。
- 保留面向模型的 JSONL 内容与回放 source 断言作为回归证据；这些层不需要生产改动。

## 验收标准

- 自动输入默认占用紧凑卡片，不再以普通气泡展示完整 prompt。
- 存在详细展示文本时，用户一次操作即可按既有富内容渲染查看；短 echo 不出现冗余或误导性的展开控件。
- 普通用户消息与结构化 per-run 定时任务消息保持当前展示。
- 内置路径在关闭展开区时延后默认富文本 parser，而宿主提供的替换或脱敏渲染保持对消息正文的完全控制。
- 附件、编辑、重试、source 元数据、既有时间戳语义、turn 边界和 tool-call 导航继续工作。
- 静态 document 默认包含详细展示文本，且没有交互控件。
- 聚焦测试与浏览器检查通过，桌面和移动宽度均无横向溢出。

## 未决问题

本纯展示切片没有未决问题。稳定的 Loop 分组，以及忠实反映触发时间/模型输入的投影，需要独立的数据设计，明确延后。
