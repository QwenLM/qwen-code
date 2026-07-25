# WebShell user message input annotations

## 背景

WebShell 的 `@` 能力已经支持在输入框中把选中的文件、扩展、MCP 资源以及 host 自定义 provider 项渲染为 chip。输入框内的 chip 来自 CodeMirror inline widget，widget 持有完整的 `WebShellComposerTag`，因此可以稳定拿到 `id`、`kind`、`label`、`value`、`serialized`、`removable` 以及 host 通过 `composerTagIcons` 注入的 icon。

当前 PR1 的第一版实现没有改变发送链路，只在用户消息渲染阶段从 `content` 文本中重新解析 `@...` 引用，再把能够识别的 built-in 引用渲染为 chip。这解决了部分可逆场景，例如 `@.qwen/`、`@ext:name`、`@mcp:name`，但它依赖文本猜测，无法覆盖所有真实输入。

review 反馈暴露了这个方向的根本问题：

- `@Makefile`、`@LICENSE`、`@src/Makefile` 是合法文件引用，但单靠文本无法和普通 mention 或 package-like token 稳定区分。
- `@dataset:users` 这类 custom provider 引用在发送后只剩文本，默认渲染拿不到原始 `kind`、`label`、`value` 和 icon。
- escaped MCP resource 与尾随标点的边界只能通过启发式处理，继续补规则会让 parser 越来越复杂，仍然无法证明完整正确。

因此 PR1 需要扩大范围：在不改变模型收到的 prompt 文本的前提下，把 composer 已经拥有的结构化输入 metadata 沿提交、transcript、本地消息和回放链路保存下来。用户消息渲染只使用 metadata 渲染 chip；旧消息或缺失 metadata 的消息保持原始文本显示，不再尝试从纯文本猜测引用。

这里不能把新增字段命名为 `composerTags`。`composerTag` 是当前 `@` chip 的实现细节，但 WebShell 的用户输入里还有 `/` slash command、skill command、custom command、system command、local command 等结构化输入。新的发送 metadata 应该表达“用户输入中的结构化注解”，本期只写入 `@` reference 注解，后续可以在同一字段中加入 `/` command 注解。

## 目标

- 用户在输入框中看到的 `@` reference chip，发送后在用户消息气泡中保持一致的 chip 渲染。
- 支持 built-in file、extension、MCP tags，包括无扩展名文件和 escaped MCP resource。
- 支持 host 自定义 provider 的默认 chip 渲染，只要 provider 在 accepted item 中提供了 `composerTag`。
- 保持模型侧 prompt 内容不变，daemon/model 仍然接收当前 `buildComposerPrompt(text, tags)` 生成的字符串。
- 保持 `renderUserMessageContent` 的覆盖能力；host 如果自定义了用户消息内容，仍然可以完全接管渲染。
- 对旧 transcript、旧 daemon、无 metadata 消息保持兼容：内容仍原样显示，只是不额外渲染 chip。
- 为 `/` command、skill command、custom command 等后续结构化输入预留统一扩展点。

## 非目标

- 不改变 `@` provider 注册协议。
- 不新增 skill 的 `@skill:` 支持；WebShell 当前通过 `/` 引用 skill。
- 不把 icon URL 写入持久化 transcript。icon 继续由 `composerTagIcons` 按 `kind` 在渲染时解析。
- 不把 metadata 传给模型，也不改变 daemon prompt 解析语义。
- 不尝试从纯文本 100% 还原所有 custom provider 或无扩展名文件引用。
- 本期不改变 `/` command 的渲染；只把 metadata 字段设计成可以承载 `/` command 注解。
- 本期不补 Ctrl+Y retry 的 annotation 重建；retry 复用原始用户消息，不新增重复 user echo。
- 本期不补 `onSubmitBefore` 失败后的 annotation 回滚；失败时 prompt 不进入发送链路，保持当前取消行为。

## 范围决策

- 本期接受同时修改 `packages/web-shell`、`packages/webui`、`packages/sdk-typescript` 和 `packages/acp-bridge`。前三者负责提交、本地 echo、transcript/message 类型和渲染；`packages/acp-bridge` 负责把 daemon user echo 写入可 replay 的 `user_message_chunk.update._meta`，否则刷新/重开 session 后无法恢复 annotation。
- 普通发送和 queued prompt 都需要支持 annotation。queued prompt 也会在用户消息区域显示本次输入，如果不携带 metadata，会和普通发送出现不一致。
- `renderUserMessageContent` 需要扩展入参，让 host 自定义 renderer 可以读取 `inputAnnotations`。默认 renderer 使用 metadata 渲染 chip；host renderer 仍然拥有最终覆盖权。
- 删除从纯文本推断 `@` chip 的 fallback，避免继续维护无法完整正确的启发式 parser。
- 本期只生成和渲染 `@` reference annotation；`/` command、skill command、custom command 只在数据结构上预留，不实现发送后 chip 渲染。

## 已检索到的结构化输入能力

当前 WebShell 输入侧至少有以下结构化能力：

- `@` references：由 `useAtMentionMenu` 提供，包含 built-in file、extension、MCP server/resource，以及 host 通过 `atProviders` 注入的自定义 provider。接受后会生成 `WebShellComposerTag`，并由 CodeMirror inline widget 渲染 chip。
- `/` slash commands：由 `slashCompletion.ts` 提供补全。顶层 command 来自 daemon 的 `session.available_commands`、WebShell local commands、custom commands、skill commands 和 system commands。
- `/` subcommands：`slashCompletion.ts` 支持显式 `subcommands`、内置 subcommand tree、implicit subcommand tree。例如 `/mcp desc`、`/stats model`、`/memory show`、`/skills <skill-name>`。
- command category：`commandDisplay.ts` 把 command 分为 `custom`、`skill`、`system`。`App.tsx` 会根据 `connection.skills` 把对应 command 标记为 skill category。
- local slash commands：`localCommands.ts` 中定义了 `help`、`theme`、`language`、`model`、`mcp`、`skills`、`memory`、`context`、`agents`、`goal`、`tasks`、`extensions` 等本地命令。
- shell mode / `!`：composer 可以以 shell mode 提交 `!${prompt}`，这是另一种用户输入语义，但不在本期渲染范围。

这些能力说明新增 metadata 字段应该是通用 annotation 列表，而不是只服务 `@` 的 tag 列表。

## 现状链路

### 输入框内

`useComposerCore` 在输入框中维护 inline tags。提交时已经能通过 `tagsOverride ?? composerTagsRef.current` 拿到完整 `WebShellComposerTag[]`。这些 tag 用于 `buildComposerPrompt(text, tags)`，最终合并进发送给 daemon 的 prompt 文本。

### 发送和本地 echo

`App.tsx` 的 `sendPrompt` 只接收 `text` 和 `images`，`sessionActions.sendPrompt(text, options)` 也只发送 prompt 文本。WebShell 为了乐观显示或本地命令 echo，会调用 `store.appendLocalUserMessage(text, images)`。

`appendLocalUserMessage` 目前只把 `text/images` 写入 `DaemonTextTranscriptBlock`，没有携带结构化输入 metadata。

### 回放到消息组件

`transcriptBlocksToDaemonMessages` 把 transcript user block 转成 `DaemonUserMessage`，当前只保留 `content`、`images`、`timestamp` 和 `source`。`UserMessage` 只能拿到 `content/images`，因此第一版实现只能通过文本 parser 重新猜测 tag。

## 方案概述

新增一条 UI-only metadata 链路。它分成两条相邻但职责不同的路径：当前页面的乐观 echo，以及 daemon transcript 的持久化 echo。

```text
CodeMirror inline tags
  -> submitText / submitPromptFromEditor
  -> sendPrompt options
  -> sessionActions.sendPrompt / sessionActions.submitPrompt options
  -> A. store.appendLocalUserMessage(text, images, { inputAnnotations })
     -> 当前 tab 立即显示用户消息 chip
  -> B. PromptRequest._meta.inputAnnotations
     -> bridge echoPromptToSessionBus 合并到 user_message_chunk.update._meta
     -> replay/load 得到同一批 session_update 事件
     -> normalizeDaemonEvent 生成 user.text.delta.meta.inputAnnotations
     -> reduceDaemonTranscriptEvents 写入 DaemonTextTranscriptBlock.meta.inputAnnotations
     -> transcriptBlocksToDaemonMessages
     -> DaemonUserMessage.inputAnnotations
     -> UserMessage default renderer
```

`content` 仍然是模型和 daemon 需要处理的 prompt 文本。`inputAnnotations` 只描述 UI 渲染需要的结构化输入，不参与模型输入。

## 数据结构

新增通用输入注解结构，顶层字段命名为 `inputAnnotations`：

```ts
interface DaemonUserMessage {
  id: string;
  role: 'user';
  content: string;
  images?: Array<{ data: string; mimeType: string }>;
  source?: string;
  inputAnnotations?: DaemonInputAnnotation[];
}
```

`DaemonInputAnnotation` 表达“content 中某一段文本对应的结构化语义”。设计原则是只新增外层 annotation wrapper，内部 payload 尽量复用现有 `@` 和 `/` 的对象格式，避免出现一套与 `WebShellComposerTag`、`CommandInfo` 平行的新协议。本期只落 `type: 'reference'`，后续 `/` command 可以复用同一个数组继续扩展：

```ts
interface DaemonInputReferenceAnnotation {
  type: 'reference';
  start: number;
  end: number;
  text: string;
  reference: DaemonInputReference;
}

interface DaemonInputReference {
  id: string;
  kind?: string;
  label?: string;
  value?: string;
  serialized?: string;
  removable?: boolean;
}

type DaemonInputAnnotation = DaemonInputReferenceAnnotation;
```

`start/end` 是相对最终 `content` 的 UTF-16 offset，与 React/CodeMirror 当前字符串处理一致。它避免后续渲染再靠 `serialized` 从 `content` 中反查位置，也为多个相同引用、相同 command、inline 文本混排留下空间。

本期 `@` reference payload 直接复用现有 `WebShellComposerTag`：

```ts
interface WebShellComposerTag {
  id: string;
  kind?: string;
  label?: string;
  value?: string;
  serialized?: string;
  removable?: boolean;
}
```

未来 `/` command payload 直接复用现有 `CommandInfo`，只在 annotation 层补 `subcommandPath`：

```ts
interface CommandInfo {
  name: string;
  description: string;
  argumentHint?: string;
  subcommands?: string[];
  source?: string;
  displayCategory?: 'custom' | 'skill' | 'system';
}
```

在 SDK transcript block 的 `meta` 中存储同样的 `inputAnnotations`：

```ts
interface DaemonTextDeltaMeta {
  inputAnnotations?: DaemonInputAnnotation[];
}
```

实现时 SDK 包不应该 import WebShell client 类型。SDK 中定义与 `WebShellComposerTag`、`CommandInfo` 字段兼容的最小 meta 结构，WebShell adapter 再把该结构转换成 client 渲染所需类型。这样可以避免 SDK 反向依赖 WebShell，同时保持字段形态与现有 `@` / `/` 格式一致。

## 关键修改点

### 1. 提交链路携带 inputAnnotations

调整 editor submit 的参数形态，让 `sendPrompt` 能拿到提交时的 `DaemonInputAnnotation[]`。

建议新增轻量 options 字段：

```ts
interface SendPromptInputMetadata {
  inputAnnotations?: DaemonInputAnnotation[];
}
```

`useComposerCore.submitText()` 在生成 prompt 文本时已经知道 `tags` 和最终 `prompt`。它需要把本期 `@` tags 转换成 `reference` annotations，再调用上层 `onSubmit`：

- `promptText`: 当前发送给 daemon 的文本，保持不变。
- `images`: 当前图片。
- `inputAnnotations`: 提交瞬间的结构化输入注解快照。

如果当前 `onSubmit` 签名不适合直接扩展，可以新增第四个 metadata 参数，避免破坏已有调用：

```ts
onSubmit(promptText, images, commitAccepted, { inputAnnotations });
```

本期 annotation 生成规则：

- 对 `buildComposerPrompt(text, tags)` 生成的 tag prefix 计算 `start/end`。
- 每个 tag 对应一个 `type: 'reference'` annotation。
- `annotation.text` 使用最终 prompt 中的实际 serialized 文本。
- `annotation.reference` 保存原有 `WebShellComposerTag` 的最小安全字段：`id/kind/label/value/serialized/removable`。
- 不保存 icon URL；icon 仍由 `kind + composerTagIcons` 在渲染时解析。

如果将来 `/` command 也需要结构化渲染，可在 slash completion accept 时生成 `type: 'command'` annotation，或者在 submit 阶段根据命中的 `CommandInfo` 生成 command annotation。command payload 直接保存现有 `CommandInfo` 字段，subcommand 信息放在 annotation wrapper 的 `subcommandPath` 中。

### 2. 本地 transcript echo 保存 metadata

扩展 SDK transcript store：

```ts
appendLocalUserMessage(
  text: string,
  images?: Array<{ data: string; mimeType: string }>,
  meta?: { inputAnnotations?: DaemonInputAnnotation[] },
): void;
```

`appendLocalUserTranscriptMessage` 同步接收 `meta`：

```ts
appendLocalUserTranscriptMessage(state, text, { images, meta });
```

创建 user text block 后写入：

```ts
if (opts.meta) {
  block.meta = { ...block.meta, ...opts.meta };
}
```

这条链路只保证当前前端 store 中的乐观用户消息立即带 chip。它不单独保证刷新或重新打开 session 后仍能拿到 metadata，因为刷新后的 transcript 来自 daemon replay，而不是当前 tab 内存中的 local append。

没有 input annotations 的本地 slash command 继续传空 metadata，不改变现有行为。

### 3. daemon prompt echo 持久化 metadata

`PromptRequest` 当前已经支持 `_meta?: Record<string, unknown> | null`。发送时把同一份 `inputAnnotations` 写入 `PromptRequest._meta.inputAnnotations`：

```ts
const promptRequest = {
  prompt: toDaemonPromptContent(text, normalizedImages),
  _meta: inputAnnotations.length > 0 ? { inputAnnotations } : undefined,
};
```

bridge 在 `sendPrompt` 内会把 request 交给 agent prompt，同时通过 `echoPromptToSessionBus` 发布 `user_message_chunk`。这里需要把 request `_meta.inputAnnotations` 合并到 echo 的 `update._meta` 中：

```ts
_meta: {
  ...pickUserInputEchoMeta(req._meta),
  serverTimestamp,
  source: 'bridge-echo',
}
```

`pickUserInputEchoMeta` 只保留 `inputAnnotations`，不把未知 request meta 原样写入用户消息 transcript。这样可以避免把 telemetry、requestId、retry 等非 UI 数据暴露给 `UserMessage`。

replay 时，`DaemonSessionProvider` 会把 `compactedReplay/liveJournal` 重新 normalize 成 UI events；`normalizeDaemonEvent` 已经会把 `user_message_chunk.update._meta` 放到 `user.text.delta.meta`；transcript reducer 已经会把 text event 的 `meta` 写入 `DaemonTextTranscriptBlock.meta`。因此只要 daemon echo 事件里带上 `inputAnnotations`，刷新和重新打开同一 session 后就能恢复 chip 渲染。

### 4. transcript adapter 转发 metadata

`transcriptBlocksToDaemonMessages` 当前已经读取 user block 的 `meta.source`。在同一位置读取 `meta.inputAnnotations`，校验为数组后写到 `DaemonUserMessage.inputAnnotations`。

这里需要做最小结构校验，避免 transcript 中的未知 meta 影响渲染：

- 必须是数组。
- 每个 annotation 必须有非空 string `id/type/text`。
- `start` 和 `end` 必须是有限数字，且满足 `0 <= start < end <= content.length`。
- 本期只生成并渲染 `type: 'reference'` 的 annotation；后续 command annotation 可以在同一字段下扩展。
- reference payload 按 `WebShellComposerTag` 的字段做最小净化，只接受 `id/kind/label/value/serialized` 的 string 值和 `removable` 的 boolean 值。
- command payload 按 `CommandInfo` 的字段做最小净化，只接受 `name/description/argumentHint/source/displayCategory` 的 string 值和 `subcommands` 的 string 数组。
- 不保留未知字段。

### 5. UserMessage 优先使用 inputAnnotations

`UserMessage` props 增加：

```ts
inputAnnotations?: DaemonInputAnnotation[];
```

`renderUserMessageContent` 入参同步增加同名字段：

```ts
renderUserMessageContent?.({ content, images, inputAnnotations });
```

默认渲染逻辑改成：

1. 如果 `inputAnnotations` 中存在合法的 `type: 'reference'` 注解，按 `start/end` 切分 `content` 并渲染 chip。
2. 如果 metadata 缺失或没有合法 annotation，直接渲染原始文本。
3. 如果 host 提供 `renderUserMessageContent`，继续优先使用 host renderer。

metadata 渲染不再从 `content` 中猜 tag 类型，也不需要按 serialized 文本查找位置。range 非法或互相重叠时忽略对应 annotation，保证不隐藏任何用户内容。

### 6. 删除文本 parser fallback

`splitComposerTagContent` 不再保留。原因是旧 parser 只能靠字符串形态猜测引用类型：

- `@Makefile` 和 `@alice` 都可能是合法文本。
- `@dataset:users` 需要 provider metadata 才知道 label/value/icon。
- escaped MCP resource 的尾部标点很难靠通用规则证明正确。

因此默认用户消息只在 annotation 存在时渲染 chip；缺失 annotation 时展示原始文本。这样 review 中的 `@Makefile` 问题不再依赖启发式，因为新消息会从 metadata 获得明确的 file tag。

## Custom provider 行为

provider 如果在 accepted item 中提供：

```ts
composerTag: {
  id: 'dataset:users',
  kind: 'dataset',
  label: 'Dataset',
  value: 'users',
  serialized: '@dataset:users',
}
```

发送后默认用户消息可以渲染：

- label: `Dataset`
- value: `users`
- icon: 通过 `composerTagIcons.dataset` 解析

provider 如果没有提供 `composerTag`，发送后仍然只有纯文本，默认 renderer 不承诺自动识别 custom provider。host 仍然可以用 `renderUserMessageContent` 自行处理。

## 兼容性

- 旧 transcript 没有 `meta.inputAnnotations`，继续按原始文本显示。
- 新 client 读取旧 daemon 事件时没有行为变化。
- 旧 client 读取带 `meta.inputAnnotations` 的 transcript 时会忽略未知 meta。
- `content` 不变，因此 daemon prompt 解析、模型输入、slash command 文本、历史 prompt 内容不受影响。
- `renderUserMessageContent` 的优先级不变，host 自定义渲染不会被默认 chip 覆盖。

## 测试计划

### Unit tests

- `appendLocalUserTranscriptMessage` 保存 `meta.inputAnnotations`。
- `createDaemonTranscriptStore().appendLocalUserMessage` 能接收并保留 metadata。
- `sessionActions.sendPrompt` 和 `sessionActions.submitPrompt` 能把 `inputAnnotations` 写入 `PromptRequest._meta`。
- bridge `echoPromptToSessionBus` 只把 `inputAnnotations` 合并到 `user_message_chunk.update._meta`，不把未知 request meta 写入 transcript echo。
- replay 的 `user_message_chunk.update._meta.inputAnnotations` 能经 `normalizeDaemonEvent` 和 reducer 写入 `DaemonTextTranscriptBlock.meta.inputAnnotations`。
- `transcriptBlocksToDaemonMessages` 将 user block 的 `meta.inputAnnotations` 转成 `DaemonUserMessage.inputAnnotations`。
- `transcriptBlocksToDaemonMessages` 过滤非法 annotation meta。
- `UserMessage` 使用 reference annotation 渲染 `@Makefile`、`@LICENSE`、`@src/Makefile`。
- `UserMessage` 使用 reference annotation 渲染 custom provider tag，并解析 `composerTagIcons`。
- `UserMessage` 在 metadata 缺失时保持原始文本显示。
- `UserMessage` 在 annotation range 非法或重叠时忽略该 annotation，不丢失原文。
- 预留的 command annotation 类型可以被 schema 校验保留，但本期默认渲染忽略它，不影响 reference 渲染。

### Integration / browser verification

- 在本地 WebShell 选择 `.qwen/`、`Makefile` 或 `LICENSE`，发送后用户消息仍显示 file chip。
- 选择 MCP resource，发送后用户消息显示 MCP chip，resource 中的转义字符不被错误 trim。
- 注入一个 custom provider，选择后发送，用户消息显示 custom label/value/icon。
- 刷新页面或重新打开同一 session，用户消息 chip 仍然存在。

## 风险和控制

- 风险：跨包类型增加会扩大 PR 面积。控制方式是在 SDK 中定义最小 `DaemonInputAnnotation`，避免 SDK import WebShell client 类型。
- 风险：metadata 与 `content` 不一致会导致渲染错位。控制方式是 UserMessage 只使用合法且不重叠的 range，非法 annotation 直接忽略，不隐藏任何用户内容。
- 风险：持久化 custom provider 信息可能包含 host 自定义字段。控制方式是只保存 `id/kind/label/value/serialized/removable`，不保存未知字段和 icon URL。
- 风险：PR1 范围扩大后 review 成本上升。控制方式是提交说明明确 motivation：这是为了解决纯文本 parser 无法正确还原 file/custom/MCP identity 的根因，同时保持 model-facing prompt 不变。
- 风险：顶层 metadata 命名过窄会限制后续 `/` 能力。控制方式是使用 `inputAnnotations` 作为统一入口，本期只写入 `type: 'reference'`。

## 实施顺序

1. 在 SDK transcript 类型中增加 input annotation meta 的最小结构。
2. 扩展 `appendLocalUserTranscriptMessage` 和 `DaemonTranscriptStore.appendLocalUserMessage`。
3. 扩展 WebShell submit options，从 `useComposerCore` 到 `App.sendPrompt`、queued prompt submit 传递 `inputAnnotations`。
4. 在乐观 echo 写入 `store.appendLocalUserMessage` 时带上 `inputAnnotations`。
5. 在 daemon `PromptRequest._meta` 中写入 `inputAnnotations`，并让 bridge user echo 把它合并到 `user_message_chunk.update._meta`。
6. 在 `transcriptBlocksToDaemonMessages` 中转发并净化 `meta.inputAnnotations`。
7. 扩展 `DaemonUserMessage`、`MessageList` 到 `UserMessage` 的 props 链路。
8. 扩展 `renderUserMessageContent` 入参，向 host renderer 暴露 `inputAnnotations`。
9. `UserMessage` 默认渲染只使用 metadata；无 metadata 时原样文本显示。
10. 补齐 unit tests 和浏览器验收截图。

## PR 描述要点

PR 描述需要说明：

- 这不是改变模型 prompt，而是保存 WebShell 已经拥有的 UI input annotation metadata。
- 纯文本 parser 无法可靠区分 `@Makefile`、`@alice`、`@dataset:users` 等形态，因此 metadata 是必要的。
- 旧消息仍兼容为原始文本显示，custom provider 只有在提供 `composerTag` 时才享受默认 chip 渲染。
- 新字段命名为 `inputAnnotations`，本期只承载 `@` reference，后续可以承载 `/` command、skill command、custom command 等结构化输入。
- `renderUserMessageContent` 仍然是 host 的最终覆盖出口。
