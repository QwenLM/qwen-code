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

- 仅改 Web Shell 展示、此展示所需的既有 document 导出投影及对应的实测 renderer 体积上限，不改调度、取消、模型输入、transcript 记录、回放元数据或 daemon API。
- 不把 tick 按 Loop 重新分组，不臆造 Loop 次数或 chain ID，也不为每个 tick 创建独立会话。
- 不增加待唤醒角标、定时任务控制或新的设置项。
- 本切片不改变自动 user turn 的含义或可编辑性。
- 不把 `message.timestamp` 声称为调度器的实际触发时间：排队执行会使它晚于 `firedAt`，而 UI 投影没有这个独立字段。
- 不宣称能展示 autonomous 或 `loop.md` tick 的完整 `modelText`；这些记录的持久化 `displayText` 有意只包含短 echo。本切片不增加模型输入审计协议。

## 拟议改动

### 消息接线

`MessageItem` 将已有的 `message.source` 传给 `UserMessage`，`MessageList` 复用同一来源 predicate，使时间线与默认正文的自动来源分类一致。其 memo 还比较文件名、MIME 类型、预览文本、附件 ID 和 Blob 引用，确保仅附件变化也能进入展开区。宿主提供的内容替换仍完整控制正文，不改变这个来源分类或现有外层 `MessageTimestamp`；时间戳仍是唯一的时间展示，并保持当前语义。

### document 导出的版本化 source 投影

本切片遵循统一 [transcript 总契约](web-shell/chat-transcript-contract-prevalidation.md)（[中文版](web-shell/chat-transcript-contract-prevalidation.zh-CN.md)）。

离线回放把持久化的 cron subtype 恢复为 `DaemonTextTranscriptBlock.meta.source`。已发布的 V1 刻意排除这段 metadata，因此无法在真实导出的自动输入上启用新展示。不能原地放宽 V1：V2 仅允许既有 user block 携带可选的 `meta.source: 'cron'`，其 schema 从未修改的 V1 派生，新的 HTML 输出采用 V2。V1 的产生方和读取方仍保持封闭的字段集合，不接受该新增字段；renderer 同时接受 V1 与 V2，其它版本值仍被拒绝。V2 标签不带 timestamp、source record ID 或其它外围 metadata，既有 forbidden-field 防护门仍只允许 exporter 构造的单键对象。这里改变的是向外的 HTML document envelope，不改变调度、transcript 持久化、回放 metadata 生成或 daemon API；`rendererVersion` 仍然是精确的 CLI 版本或内容 hash，不与之混同的是 document 的 `schemaVersion`。

`build.mjs` 在该身份旁生成 `EXPORT_TRANSCRIPT_DOCUMENT_MAX_SCHEMA_VERSION`。本地源码构建支持 V2；委托 renderer 默认输出 V1，使已经发布的旧 runtime 始终能打开导出的 document。若委托的 renderer 已支持 V2，必须由调用方显式设置 `QWEN_EXPORT_RENDERER_SCHEMA_MAX_VERSION=2`，并为同一受支持 runtime 固定 renderer 身份与 JS/CSS 的 SRI 摘要。低层 HTML renderer 拒绝 `schemaVersion` 高于该上限的 document，而不输出固定 runtime 无法打开的文件。体积预算在注入身份后测量，不再测量带占位符的中间文本。

### 自动触发展示

只有同时满足以下条件时，`UserMessage` 才选择自动触发展示：

1. `source` 严格等于 `cron` 或 `loop`；且
2. 内容不匹配现有结构化 per-run 定时任务 prompt。

两种 source 使用同一个自动触发标签。持久化回放目前会把二者统一为 `cron`，若按 source 显示 Loop 专属标签，同一条消息在重载后就会改变外观。

摘要由原始展示文本折叠空白后生成，并通过 CSS 在视觉上截断，不缩短已存储或复制的文本。不从 prompt 文本推断调度或任务元数据。

interactive 和 readonly 视图默认显示紧凑摘要。既有“显示更多/收起”控件通过内置用户内容渲染管线显示完整展示文本，保留 annotations、链接、slash 高亮与附件引用。宿主替换保持对正文的既有所有权，不插入自动卡片内部。普通短 prompt 也保留该控件，避免窄屏布局使用户无法查看全文。

仅以下四种与 Web Shell runtime 完全一致的短 echo——`Autonomous loop tick`、`Loop tick — tasks from project loop.md`、`Loop tick — tasks from home loop.md` 和 `Loop tick — loop.md temporarily unavailable`——显示为无展开控件的静态紧凑卡片。若其它 producer 添加前缀或后缀，完整可用文本仍保留展开控件，不会被当成这些纯标签。标签在窄布局中换行展示完整文本，不省略为 hover 才可读的内容，因此不必仅为阅读 echo 本身增加展开入口。仅以 `Loop tick — ` 开头的真实 prompt，或带未知未来 source label 的真实指令，仍在 interactive 与 readonly 视图保留展开控件，并在 document 导出中保留完整正文；匹配器按 fail-open 处理。

document 模式遵循默认展开的 `TranscriptDocumentExpandedContext`，且不显示交互式展开控件。详细内容默认包含；短 echo 不需要重复正文，并在调用内置 parser 前即被排除。

内置 renderer 路径中的富文本按需构造。关闭的 interactive 展开区不会调用默认 parser；展开时构造一次，默认展开的 document 输出也仍构造完整内容。来源、内容、图片数、文件数和编辑态发生变化时视作新的展示代际。通过 React state 而非在 render 期间写 ref 来比较这些字段，在解析任何新内容前同步收起上代详情，避免 defer 或放弃 render 时把状态泄漏到已提交展示。代际身份直接逐字段比较，不为每条消息反复拼接完整 prompt 字符串。宿主提供 `renderUserMessageContent`、`parseUserMessageContent` 或自定义 composer tag renderer 时，绕过自动卡片变体，继续由宿主原有的完整内容替换或脱敏契约控制显示，不在其输出周围重新夹带原始摘要。摘要与 echo predicate 只随来源和内容 memoize，编辑草稿不会反复扫描未变化的指令。

现有气泡和 selectors 保持不变。新增专用 selector 与 `data-source` 属性供浏览器测试识别。图片、文件、重试入口和内联编辑器继续留在当前外层布局中；编辑器仍使用完整原文。

自动触发卡禁用通用 400 px 溢出展开控件，避免用户连续展开两次。自动变体不测量未消费的 overflow 标志，也不订阅 ResizeObserver；普通消息与 per-run 消息保持既有高度测量。

### 样式与本地化

在 `UserMessage.module.css` 中添加作用域样式，复用现有定时任务卡的视觉 tokens、图标处理与语义颜色。自动触发的 header 用 `flex-wrap: nowrap` 保持在同一 flex line，不改共享的 per-run header。`.scheduledTaskHeading` 在可用宽度内缩小；已知完整 echo 只在自身摘要内换行，保证全文可读。在 `i18n.tsx` 添加英文 `userMessage.automatic.title`，并分别在 `i18n-zh-cn.ts`、`i18n-zh-tw.ts` 与 `i18n-ru-part5.ts` 添加简体中文、繁体中文和俄文标签，使所有支持的 catalog 都显示本地化标题。

## 关键设计决策

| 决策                                              | 理由                                                                                                                                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 修改 `UserMessage` 展示变体，不改 transcript role | user 角色记录仍是 turn 起点，现有编辑、删除、重试、时间线和 tool-call 消费者继续看到同一条消息。                                                                                                     |
| 在 `UserMessage` 内部接入                         | 保留附件、自定义内容渲染、编辑、失败处理与 per-run 卡片，不建立平行消息路径。                                                                                                                        |
| 优先使用现有 per-run 卡片                         | 其结构化任务名、cron、task ID、触发方式和 session mode 比通用自动卡信息更完整。                                                                                                                      |
| 使用与 source 无关的可见标签                      | 回放把持久化自动记录映射为 `cron`；同一次 tick 不能在重载后被重新标成别的类型。                                                                                                                      |
| 只保留现有外层时间戳                              | 当前值是投影/执行时间，不一定是调度触发时间；卡片内再显示一次会重复并夸大其含义。                                                                                                                    |
| 短 echo 不显示冗余展开控件                        | 短 echo 已完整可见，而完整模型输入不能由当前投影提供；“展开完整指令”既无意义也有误导性。                                                                                                             |
| 按需构造详情内容                                  | 长会话不应为了显示紧凑摘要而解析或宿主渲染每一条隐藏指令。                                                                                                                                           |
| 不按 wakeup ID 分组                               | 自调节 rearm 会创建新的 one-shot ID，它不是稳定的 Loop 链身份。                                                                                                                                      |
| 升级 document schema，而非放宽 V1                 | V1 的 allowlist 是安全契约。V2 仅在 user block 中带来已有的规范化 cron 路由标签，不带其它 metadata。writer 按 renderer 声明的 schema 上限选择版本：当前本地 renderer 输出 V2，pre-V2 委托仍输出 V1。 |

## 涉及文件

- `packages/web-shell/client/utils/automatic-trigger.ts` 与对应测试 — 统一的 source 与 fail-open echo predicate。
- `packages/web-shell/client/components/MessageList.tsx` — 为时间线分类复用该 predicate。
- `packages/web-shell/client/components/MessageItem.tsx` — 传递 source，并让附件更新穿过 memo 判等。
- `packages/web-shell/client/components/messages/UserMessage.tsx` — 选择紧凑变体、保留宿主覆盖控制并按需构造详情。
- `packages/web-shell/client/components/messages/UserMessage.module.css` — 作用域卡片与展开样式。
- `packages/web-shell/client/i18n.tsx`、`i18n-zh-cn.ts`、`i18n-zh-tw.ts` 与 `i18n-ru-part5.ts` — 所有支持 catalog 的标签。
- `packages/web-shell/client/i18n.test.ts` — 本地化消息目录覆盖。
- `packages/web-shell/client/components/MessageItem.dom.test.tsx` — props 传递和 source 更新覆盖。
- `packages/web-shell/client/components/messages/UserMessage.test.tsx` — 组件行为与回归覆盖。
- `packages/web-templates/src/export-html/build.mjs` — schema 能力上限生成、委托兼容性和实际产物的体积测量。
- `packages/web-templates/src/index.ts` — 向 HTML formatter 暴露 renderer 的 schema 能力上限。
- `packages/cli/src/ui/utils/export/export-transcript-document.ts` — 保留 V1 表示形式，增加 V2 及其派生 schema，以承载规范化的 cron 路由标签，且不带出外围 metadata。
- `packages/cli/src/ui/utils/export/index.ts` — 在既有 V1 接口旁导出两个版本的工厂与 document 类型。
- `packages/cli/src/ui/utils/export/formatters/html.ts` — 按 renderer 声明的 schema 上限选择 HTML 版本，并在读取时校验两种受支持的版本。
- `packages/cli/src/ui/utils/export/export-transcript-document.test.ts` — V2 来源与 metadata 边界、非 cron 来源以及 V1 兼容性覆盖。
- `packages/cli/src/ui/utils/export/formatters/html.test.ts` — 默认和委托 schema 上限、委托及旧版 HTML 输出、非法配置与默认产物恢复覆盖。
- `packages/web-templates/src/export-html/src/document-main.tsx` — 接受 V1 与 V2，但拒绝其它 schema 版本、V1 用户 metadata，以及 user Cron 标签以外的异常 metadata。
- `docs/design/web-shell/chat-transcript-contract-prevalidation.md` 与 `.zh-CN.md` — 完整英中规范文档中的 allowlist、版本规则和生产 schema 约定。
- `packages/web-shell/client/e2e/web-shell.automatic-trigger-message.spec.ts` — 确定性浏览器覆盖与截图。

## 验证计划

身份注入后实测 renderer JavaScript 为 **2,152,990 字节**，其中包含 reader 对 user metadata 的边界校验及附件引用校验；分离的组件 CSS 为 **2,427,188 字节**。告警基线即实测的 **2,152,990**，硬上限为 **2,153,420 字节**，为工具链差异保留 430 字节。这里按真实产物重新校准基线，不用旧的占位文本峰值掩盖 metadata 校验带来的体积增长。

- 单测覆盖 `cron` 与 `loop`、普通/未知 source、per-run 优先级、展开、短 echo 控件抑制、内置渲染惰性、附件、编辑、来源、内容、附件数与编辑态变化时在解析前收起旧详情、空内容、document 展开，以及以 `Loop tick — ` 开头的真实指令在 interactive 和 document 视图中的保留。验证自动触发标题在所有支持的 catalog 中均已本地化。
- 验证现有 `MessageItem` 仅改变 source 时会更新转发的 props，并验证普通长消息在 source 变为自动来源后恢复紧凑状态。
- 运行用户消息、自动触发 predicate 及全部支持 catalog 的聚焦测试，再执行贡献流程要求的仓库 build 与 typecheck。在身份注入后实测 renderer 字节，与文档记录的告警峰值对照，并在该峰值上方恰好 430 字节设置硬上限，保证告警阈值严格小于硬上限；同时验证当前尺寸不告警以及未来增长会告警。
- 在桌面与移动宽度断言日历与摘要同处一行，带详情的展开按钮也处在同一行。完整短 echo 在自身摘要内换行可读，自动头部样式不污染 per-run 共享样式，且页面没有横向溢出。
- 覆盖固定数量文件的各字段更新、没有宿主覆盖时的 per-run 优先级、observer 清理，以及展开 → 编辑 → 取消 → 收起 → 再次展开。
- 用同一组 cron、loop、普通和 per-run fixture 对 baseline 与修改后构建运行 Playwright 场景，在桌面与移动宽度截取紧凑和展开状态，并断言 document 无横向溢出。
- document 导出断言持久化 cron 记录的 `schemaVersion: 2`，其 user block 仅含 `meta.source: 'cron'`，普通与 `goal_runtime` 输入不携带该字段。覆盖额外 timestamp 被拒绝、V1 拒绝新增标签，以及旧 V1 HTML 的生成。重新生成真实 HTTP 导出，验证 V2 标记、紧凑展示和全局折叠/展开。
- 使用 pre-V2 委托身份及实际已发布资源的 SRI，断言输出的 V1 不新增 metadata，并可由该已发布 renderer 打开。负对照中，同一信封改标为 V2 必须被该 renderer 拒绝。委托用例后恢复默认 V2 writer，并校验不支持或未匹配的 schema 上限配置被拒绝。
- 保留面向模型的 JSONL 内容与回放 source 断言作为回归证据；这些层不需要生产改动。

## 验收标准

- 自动输入默认占用紧凑卡片，不再以普通气泡展示完整 prompt。
- 存在详细展示文本时，用户一次操作即可按既有富内容渲染查看；短 echo 不出现冗余或误导性的展开控件。
- 普通用户消息与结构化 per-run 定时任务消息保持当前展示。
- 内置路径在关闭展开区时延后默认富文本 parser，而宿主提供的替换或脱敏渲染保持对消息正文的完全控制。
- 附件、编辑、重试、source 元数据、既有时间戳语义、turn 边界和 tool-call 导航继续工作。
- 当前本地 V2 renderer 的输出携带规范化 cron 路由标签而不带出外围 metadata；pre-V2 委托输出兼容的 V1。reader 接受 V1 与 V2、拒绝未知版本，默认包含详细展示文本，且无需交互式触发控件。
- 聚焦测试与浏览器检查通过，桌面和移动宽度均无横向溢出。

## 未决问题

本纯展示切片没有未决问题。稳定的 Loop 分组，以及忠实反映触发时间/模型输入的投影，需要独立的数据设计，明确延后。
