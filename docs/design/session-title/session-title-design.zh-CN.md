# 会话标题设计

[English](session-title-design.md) | [简体中文](session-title-design.zh-CN.md)

> 快速模型在助手首次回复后生成简短的会话标题。标题以
> `titleSource: 'auto' | 'manual'` 标记写入会话 JSONL，在会话选择器中显示，
> 也可以通过不带名称的 `/rename` 或 `/rename --auto` 重新生成。

## 概述

`/rename`（#3093）允许用户为会话命名，便于之后在选择器中找到它。在运行该命令
之前，选择器显示首条用户提示。提示可能在句子中间截断，也可能只描述引出讨论的
问题，无法反映会话最终完成的工作。多数用户会省略手动重命名这一步。

目标是让默认会话名称便于识别。

- **描述具体**。采用类似 Git 提交主题的写法，描述会话实际完成的工作。标题提示
  会在跟随对话语言时调整长度和大小写规则。
- **尽力生成**。首次回复后在后台触发，生成失败时静默处理。
- **尊重用户选择**。`/rename` 明确设置的标题优先于后台生成的标题，同一个会话
  在多个 CLI 标签页打开时也遵循这一原则。
- **支持按需重新生成**。当标题过时或用户希望换一个标题时，可运行不带名称的
  `/rename` 或 `/rename --auto`。

## 触发方式

| 触发方式 | 条件                                                                                                                                                                                   | 实现                                                      |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **自动** | 交互式会话或 ACP 会话在 `recordAssistantTurn` 之后触发。已有标题、显式标题写入尚未完成、记录器写入失败、已有生成请求在运行、达到尝试次数上限、通过环境变量禁用或未配置快速模型时跳过。 | `ChatRecordingService.maybeTriggerAutoTitle` 发起后台请求 |
| **手动** | 用户运行不带名称的 `/rename` 或 `/rename --auto`。                                                                                                                                     | `renameCommand.ts` 调用 `tryGenerateSessionTitle`         |

两条路径统一调用 `tryGenerateSessionTitle(config, signal)`，以使用一致的提示、
schema、模型选择和清洗逻辑。自动触发在后台尽力执行。用户按需生成标题时，
操作会等待生成结果，失败时会显示对应原因。

## 架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        packages/core/src/services/                      │
│                                                                         │
│  ┌──────────────────────────┐                                           │
│  │ chatRecordingService.ts  │                                           │
│  │                          │                                           │
│  │  recordAssistantTurn()   │                                           │
│  │     │                    │                                           │
│  │     ↓                    │                                           │
│  │  maybeTriggerAutoTitle() │── guards ────→ IIFE(autoTitleController)  │
│  │     │                    │                       │                   │
│  │     └── resume hydrate   │                       ↓                   │
│  │         via              │          tryGenerateSessionTitle          │
│  │         getSessionTitle- │          (sessionTitle.ts)                │
│  │         Info             │                       │                   │
│  │                          │                       ↓                   │
│  └──────────────────────────┘          BaseLlmClient.generateJson       │
│                                        (fastModel + JSON schema)        │
│                                                       │                 │
│  ┌──────────────────────────┐                         ↓                 │
│  │ sessionService.ts        │         sanitizeTitle + sanity checks     │
│  │                          │                         │                 │
│  │  getSessionTitleInfo()   │◀── cross-process        ↓                 │
│  │      uses                │    re-read          persistCustomTitle    │
│  │  readLastJsonString-     │    before write        (…, 'auto')        │
│  │  FieldsSync              │                                           │
│  │  (sessionStorageUtils)   │                                           │
│  └──────────────────────────┘                                           │
│                                                                         │
│                          ┌─────────────────────┐                        │
│                          │ utils/terminalSafe  │                        │
│                          │ stripTerminalCtrl-  │                        │
│                          │ Sequences           │                        │
│                          └─────────────────────┘                        │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                     packages/cli/src/ui/                                │
│                                                                         │
│  commands/renameCommand.ts     ─── /rename <name>          → manual      │
│                                ─── /rename                 → auto       │
│                                ─── /rename --auto          → auto       │
│                                ─── /rename -- --literal    → manual     │
│                                ─── /rename --unknown-flag  → error      │
│                                                                         │
│  components/SessionPicker.tsx  ── dims rows where                       │
│                                   session.titleSource === 'auto'        │
└─────────────────────────────────────────────────────────────────────────┘
```

`ChatRecordingService` 检查触发条件后启动后台任务。任务通过快速模型生成并清洗
标题，再读取会话文件以处理跨进程重命名，最后写入标题。恢复会话时，
`getSessionTitleInfo` 提供上次记录的标题和来源。CLI 解析 `/rename` 的参数，
会话选择器为来源是 `auto` 的条目使用弱化样式。

### 文件

| 文件                                                 | 职责                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `packages/core/src/services/sessionTitle.ts`         | 发起单次模型请求，过滤历史，清洗标题。导出 `tryGenerateSessionTitle`。                            |
| `packages/core/src/services/chatRecordingService.ts` | 实现 `maybeTriggerAutoTitle` 的触发条件、跨进程重读和结束会话时的取消操作。                       |
| `packages/core/src/services/sessionService.ts`       | 提供公共方法 `getSessionTitleInfo`。 `renameSession` 接受 `titleSource`。                         |
| `packages/core/src/utils/sessionStorageUtils.ts`     | 通过 `extractLastJsonStringFields` 和 `readLastJsonStringFieldsSync` 从同一条记录读取标题及来源。 |
| `packages/core/src/utils/terminalSafe.ts`            | `stripTerminalControlSequences` 移除生成标题中的终端控制序列。                                    |
| `packages/cli/src/ui/commands/renameCommand.ts`      | 实现 `/rename` 和 `/rename --auto` 的快速模型生成、参数结束标记解析和失败提示。                   |
| `packages/cli/src/ui/components/SessionPicker.tsx`   | 为 `titleSource === 'auto'` 的条目使用弱化样式。                                                  |

## 提示设计

### 系统提示

单次标题请求会替换主 Agent 的系统提示，将模型任务限定为给会话命名。

标题生成只读取一次输出语言偏好，并根据同一次读取的内容选择提示和 schema，
再附加偏好文本（#16793）。

- 偏好带有 `auto` 标记，或偏好文件不存在、无法读取、内容为空时，标题跟随记录中
  用户本人消息的主要语言。一般使用 3-7 个词，中文、日文或韩文约用 8-20 个字符。
  对区分字母大小写的语言使用句首大写，仅将首词和专有名词的首字母大写。保留名称、
  标识符和路径的原始写法。
- 附加 `auto` 偏好时，请求明确将“用户的输入”定义为会话记录中用户本人发送的
  消息。偏好里关于显式指定语言的例外也按这些消息判断。
- 固定语言或没有 `auto` 标记的自定义偏好使用 3-7 个词、句首大写的标题提示和
  schema。请求按原有优先级附加偏好文本。
- 标题末尾省略标点，标题正文省略 Markdown 和引号。
- 明确指出用户实际想做的事，点出功能、问题或主题。避免 “Code changes”、
  “Help request” 之类笼统的标题。
- 提供四个正例（三个英文、一个中文）和四个反例（过于笼统、过长、大小写有误、
  末尾带标点）。
- 仅返回包含一个 `title` 键的 JSON 对象。

### 结构化输出（JSON schema）

`BaseLlmClient.generateJson` 通过工具调用 schema 返回结构化结果。没有 `auto`
标记的固定语言和自定义偏好使用以下 schema。

```ts
const TITLE_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description:
        'A concise sentence-case session title, 3-7 words, no trailing punctuation.',
    },
  },
  required: ['title'],
};
```

跟随会话语言时沿用相同的结构。标题描述允许对中文、日文和韩文使用字符数，
并将句首大写规则限定在有字母大小写的语言中。

采用工具调用来提取标题，主要考虑以下几点。

1. **跨服务商可靠性**。兼容 OpenAI 的端点、Gemini 和 Qwen 原生接口都支持工具
   调用。使用标签提取会依赖每个模型都遵循同一套文本约定。
2. **隔离推理前言**。工具参数按结构返回，即使答案前面有一段推理文本，也不会
   混进标题。
3. **简化后处理**。用 `typeof result.title === 'string'` 检查类型，再调用
   `sanitizeTitle`，即可处理常见的模型输出偏差。

模型仍可能返回符合 schema 但不适合显示的结果，例如空字符串、只有空白、500 个
字符、Markdown 围栏或控制字符。`sanitizeTitle` 会处理这些情况，返回 `''`
时服务返回 `{ok: false, reason: 'empty_result'}`。

### 调用参数

| 参数              | 值                          | 原因                                                             |
| ----------------- | --------------------------- | ---------------------------------------------------------------- |
| `model`           | 读取偏好前选定的快速模型    | 避免读取期间更改设置将请求发送到另一个模型。                     |
| `schema`          | 与所选提示匹配的标题 schema | 强制输出 `{title: string}`，并提供相容的长度和大小写指导。       |
| `maxOutputTokens` | `100`                       | 足够容纳简短标题和 schema 开销。                                 |
| `temperature`     | `0.2`                       | 输出大体确定，使重新生成的会话标题更稳定。                       |
| `maxAttempts`     | `1`                         | 标题是尽力生成的辅助元数据。重试会排在用户可见的主模型请求之后。 |

会话摘要可以回退到主模型。会话标题自动触发且频率较高，静默消耗主模型 token
会产生意外费用。手动运行 `/rename --auto` 时，缺少快速模型会返回
`no_fast_model`，让用户明确选择快速模型。

## 历史过滤

`geminiClient.getChat().getHistory()` 返回的 `Content[]` 包含工具调用、工具
响应（文件内容经常超过 10K token）以及模型思考片段。如果直接发给标题模型，
标题容易被“Called grep on auth module”这类实现细节带偏。

`filterToDialog` 仅保留有非空文本的 `user` 和 `model` 条目，并排除
`thought` 和 `thoughtSignature` 片段。`takeRecentDialog` 取最近 20 条消息，
避免从脱离上下文的模型回复或工具响应开始。`flattenToTail` 将消息转成
“角色: 文本”格式，再截取末尾 1000 个字符。

### 截取末尾 1000 个字符

如果会话以 `help me debug X` 开头，随后转向重构 Y，标题应描述 Y。按开头命名
会把会话固定在最初的描述上，截取末尾则能反映对话最后聚焦的任务。

### 处理 UTF-16 代理项

按 UTF-16 代码单元执行 `.slice(-1000)` 时，切到 CJK 补充字符或 emoji 可能
留下孤立的高位或低位代理项。部分服务商会因无效 UTF-16 返回 400，从而浪费一次
尝试。`flattenToTail` 会移除开头孤立的低位代理项。`sanitizeTitle` 在对输出
执行最大长度截断后，也会清理孤立的代理项。

## 持久化

### 持久化结果约定

`ChatRecordingService.recordCustomTitle()` 返回 `Promise<boolean>`。
`true` 表示 `custom_title` 记录已经按记录器的顺序写入 JSONL，内存中的标题和
来源已更新，标题观察者也已收到通知。创建文件失败、记录器已处于失败状态、前序
排队写入失败或本次标题写入失败时，返回 `false`，标题与观察者保留此前的状态。
记录器标准的 `flush()` 仍会报告持续存在的写入失败。

观察者在持久化完成后运行。观察者异常会单独处理，因为已写入的标题应被视为
重命名成功。回调接收持久化记录中保存的会话 ID，消费者应使用该 ID 来确定会话。
这样可以避免旧记录器的延迟写入在 `/clear`、恢复或分支切换后改写新会话的
输入栏标题。

后台自动标题共用同一条私有持久化路径，按尽力原则处理。公共调用表示显式的标题
请求，其中包括 `/rename --auto` 调用的 `recordCustomTitle(title, 'auto')`
以及远程控制入口发起的请求。

### 记录结构

`CustomTitleRecordPayload` 新增可选字段 `titleSource: 'auto' | 'manual'`。

```jsonc
{
  "type": "system",
  "subtype": "custom_title",
  "systemPayload": {
    "customTitle": "Debug login button on mobile",
    "titleSource": "auto",
  },
}
```

旧记录缺少该字段时按 `undefined` 处理。仅当来源严格匹配 `=== 'auto'` 时，
`SessionPicker` 才会弱化显示。升级前由用户通过 `/rename` 设置的标题因此仍
显示为手动标题。

### 恢复时加载标题

恢复会话时，`ChatRecordingService` 构造函数通过
`sessionService.getSessionTitleInfo(sessionId)` 同时读取标题和来源。
`finalize()` 会在每次会话生命周期事件中重新附加标题记录。如果恢复时漏掉
来源，每次恢复都会把自动标题重新写成手动标题，导致弱化样式消失。

### 从同一条记录读取标题和来源

`extractLastJsonStringFields` 一次扫描就能从**同一条匹配记录**返回
`customTitle` 和 `titleSource`。如果调用两次 `readLastJsonStringFieldSync`，
旧记录只有主字段时，两次读取可能命中不同记录，产生不匹配的字段组合。
提取器还要求主字段值有正确的结束引号，避免崩溃时截断的末尾记录被视为最新记录。

### 全文件扫描上限

尾部窗口的快速路径未命中时，第二阶段按 64KB 分块读取整个文件。上限为
`MAX_FULL_SCAN_BYTES = 64 MB`，用于防止损坏的多 GB JSONL 阻塞主事件循环和
会话选择器。这样可以限制文件损坏时的选择器延迟。

### 防止符号链接重定向

读取会话文件时使用 `O_NOFOLLOW`。Windows 未提供该常量时，使用普通只读方式
打开。此防御用于阻止 `~/.qwen/projects/<proj>/chats/` 中植入的符号链接把
元数据读取重定向到无关文件。

## 并发和边界情况

### 触发检查顺序

`maybeTriggerAutoTitle` 按下列顺序检查。命中任一条件即跳过，其余检查按成本
从低到高排列。

1. 已设置 `currentCustomTitle`。保留手动标题或先前的自动标题。
2. 写入器处于故障状态。记录器无法持久化标题，跳过以节省快速模型 token。
3. 显式标题写入尚未完成。用户和远程操作的意图从 JSONL 写入开始前就优先。
4. `autoTitleController !== undefined`。同一时间只允许一次生成尝试。
5. `autoTitleAttempts >= 3`。限制总尝试成本。
6. `autoTitleDisabledByEnv()`。通过 `QWEN_DISABLE_AUTO_TITLE=1` 显式禁用。
7. `!config.isInteractive() && !config.getExperimentalZedIntegration()`。
   跳过 ACP 之外的非交互式运行，包括一次性的 `qwen -p` 和 CI 运行。
8. `!config.getFastModel()`。缺少快速模型时跳过。

### 尝试次数上限选为 3 次

助手的第一轮可能只有工具调用，没有用户可见文本，例如一开始就执行 `grep`。
此时 `tryGenerateSessionTitle` 返回 `{ok: false, reason: 'empty_history'}`。
如果没有重试机会，首轮只有工具调用就可能使整个会话失去生成标题的机会。
上限为 3 次，既能覆盖这种常见情形，也能限制快速模型持续失败时的重试次数。

### 跨进程手动重命名竞争

打开同一会话文件的两个 CLI 标签页可能持有不同的内存状态。标签页 A 执行
`/rename foo` 并写入 `titleSource: manual`。此时标签页 B 的
`ChatRecordingService` 可能仍缓存 `currentCustomTitle = undefined`，从而
尝试用自动标题覆盖手动标题。

模型请求完成后，立即执行的异步函数通过 `sessionService.getSessionTitleInfo`
重读 JSONL。如果文件显示 `source: 'manual'`，任务会退出并同步内存状态，
后续对话轮次也会尊重该次重命名。每次成功生成标题只需额外读取 64KB 的文件尾部。

### 在 `finalize()` 时传递取消信号

`autoTitleController` 同时标识正在运行的任务。切换会话或关闭进程时，
`finalize()` 会在重新附加标题记录前调用 `autoTitleController.abort()`。
模型连接会及时取消，切换会话可立即继续。异步函数的 `finally` 块只在
`autoTitleController` 仍指向该任务时清理它，避免执行中的 `finalize()`
与并行的 `recordAssistantTurn` 竞争。

### 生成期间收到显式重命名

每次调用公共方法 `recordCustomTitle()` 都会增加待处理显式写入计数，并在等待
JSONL 写入前取消活跃的后台生成任务。`/rename --auto` 同样如此，因此用户
显式触发的模型标题与用户直接输入的标题具有相同优先级。后台任务在生成结束后
和实际写入前都会检查计数器、取消信号、当前标题和写入器状态。并发的显式重命名
由写入器串行处理，内存结果按相同顺序提交。如果后台标题已经进入写入队列，按
正常写入顺序，显式标题最终成为最后一条标题记录。

在显式标题待写入时，`finalize()` 会跳过对先前缓存标题的重新落盘。旧记录如果
进入重命名后的队列，可能在新标题写入成功后成为 JSONL 最后一条记录。标题锚点
按写入队列的逻辑顺序计数。未完成的标题写入之后排队的后续记录仍计入阈值，但会
等到最终的缓存标题确定后再写锚点。这使得进程关闭和 32KB 阈值触发的锚点写入都
能尊重已经成功的重命名。

跨进程重读仍会保护其他 CLI 进程写入的手动标题。设计接受最后一次检查和写入之间
有外部重命名的竞争窗口。

### 分支标题的写入顺序

`/branch` 在复制会话前先结束源记录器并调用 `flush()`。然后加载临时分支，
计算唯一标题，通过 `SessionService` 写入该标题，再重新加载分支，使其尾部和
标题缓存包含新记录。这些步骤全部成功后，才切换核心记录器和界面。源记录器
`flush()` 失败、标题写入失败或最终重载失败时，清理未完成的分支并继续使用
原会话。

`forkSession()` 会独占创建目标文件。如果在返回成功前写入或关闭新 JSONL
失败，也会删除目标文件，避免在调用方记录分支已创建之前遗留部分文件。

### 守护进程边界

活动的 ACP 标题操作等待 `recordCustomTitle()`，据此准确返回 `persisted`
或 `success`。这样能避免第二次 `flush()` 把后续无关的写入失败归因于本次
重命名。守护进程的元数据 PATCH 采用乐观更新。它立即更新活动状态并发布事件，
子进程尽力持久化，返回 `false` 时记入调试日志。强一致的 HTTP 元数据更新
超出本设计范围。

## 配置

### 用户可用设置

| 设置或环境变量              | 默认值 | 效果                                                                     |
| --------------------------- | ------ | ------------------------------------------------------------------------ |
| `fastModel`                 | 未设置 | 自动生成标题需要快速模型。缺少快速模型时跳过。                           |
| `QWEN_DISABLE_AUTO_TITLE=1` | 未设置 | 保留 `fastModel` 设置，同时关闭自动触发。用户仍可运行 `/rename --auto`。 |

环境变量是用户关闭自动触发的入口。会话标题是低成本的辅助功能，少量希望关闭
它的用户可以通过一次环境变量设置完成操作。

### 自动生成仅使用快速模型

每次助手回复后都会尝试触发自动标题。如果没有快速模型的用户每次新建会话都因
生成标题而静默消耗主模型 token，就可能到月度账单出来时才发现这项费用。缺少
快速模型时，自动触发直接跳过。手动运行 `/rename --auto` 会显示
`no_fast_model`，告知用户可以配置快速模型。

## 可观测性

`createDebugLogger('SESSION_TITLE')` 在生成器的异常处理分支调用
`debugLogger.warn`。自动标题是辅助功能，后台失败仅写入调试日志。

开发者可在调试日志中搜索 `[SESSION_TITLE]`，日志路径为
`~/.qwen/debug/<sessionId>.txt`，`latest.txt` 指向当前会话的日志。调用成功
时静默，失败时写入一条包含底层错误消息的 WARN 日志。

## 安全加固

标题值会原样显示在终端的会话选择器里，也会写入用户可读的 JSONL 文件。如果快速
模型遭到入侵或提示注入并返回恶意文本，两处表面都可能受到影响。

| 风险                               | 防护                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| ANSI、OSC-8 或 CSI 注入            | 写入 JSONL 和渲染选择器前均执行 `stripTerminalControlSequences`。                             |
| 通过 OSC-8 夹带可点击链接          | 将 OSC 序列作为整体清除。                                                                     |
| 无效的 UTF-16 代理项               | 模型输入由 `flattenToTail` 清理。模型输出由 `sanitizeTitle` 在最大长度截断后清理。            |
| 用户消息内容伪造记录子类型         | `lineContains: '"subtype":"custom_title"'` 筛选记录，避免用户文本中的同一字面值覆盖真实记录。 |
| 读取会话时被符号链接重定向         | 使用 `O_NOFOLLOW`。Windows 缺少该常量时跳过这项防护。                                         |
| JSONL 最后一条记录被截断           | `extractLastJsonStringFields` 要求有结束引号才将记录视为最新匹配。                            |
| 过大的文件阻塞会话选择器           | 第二阶段全文件扫描受 `MAX_FULL_SCAN_BYTES = 64 MB` 限制。                                     |
| 成对的 CJK 括号装饰（`【Draft】`） | 整体移除，避免留下孤立的右括号。                                                              |
| 未闭合的语言偏好标记               | 遇到下一个 `<` 时停止匹配，避免不完整的标记吞掉后续注释。                                     |

## 范围之外

| 项目                           | 原因                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 标题过时后自动重新生成         | 用户可通过不带名称的 `/rename` 或 `/rename --auto` 生成新标题。在会话进行中静默替换标题会使回看选择器的用户困惑。    |
| WebUI 和 VSCode 的弱化样式对齐 | 这些界面已读取 `customTitle`，目前按手动标题显示自动标题。后续可传递 `titleSource`。                                 |
| 在设置对话框里提供自动生成开关 | 环境变量已提供关闭入口。如果有用户需求，之后可以加入设置界面。                                                       |
| 为新增字符串补齐国际化词条     | 与现有 `/rename` 字符串一样，当前回退到英文。全仓国际化超出本设计范围。                                              |
| 迁移并重新分类旧记录           | 缺少 `titleSource` 时按手动标题处理，以兼容旧记录。重写旧记录可能丢失用户意图。                                      |
| 为无头一次性会话自动生成标题   | 自动触发跳过一次性的 `qwen -p` 和 CI 运行，以节省快速模型 token。长时间运行的 ACP 会话可恢复，因此可以自动生成标题。 |
