# Qwen-Code Daemon Session Artifacts API 可实施设计

> 输入资料：session artifacts daemon API 初版草案与 artifact design v1 草案。  
>  
> 源码基线：当前 qwen-code 代码。  
> 目标：基于现有 Daemon / ACP / SSE / SDK / hooks / extension 能力，设计一套可实施、可验证、边界清楚的 session artifacts API。

## 1. 设计结论

建议把 artifact 定义为：

> **Session 中被显式登记的、用户可复用/点击/预览/下载/分享的结构化产物引用。普通源码变更不是 artifact；源码变更属于 file change / diff / patch history。**

这个定义覆盖文件，也覆盖非文件 URL。关键不在于它是不是物理文件，而在于它是不是被系统明确声明为“产物”。Artifacts 面板应该展示 session outputs，而不是所有 agent 动过的东西。

V1 完整能力建议包含：

- capability：`session_artifacts`
- artifact snapshot API：`GET /session/:id/artifacts`
- artifact changed event：`artifact_changed`
- tool result metadata：`ToolResult.artifacts?: ToolArtifact[]`
- `ArtifactTool` structured artifact metadata
- bridge 内存索引：`SessionArtifactStore`
- SDK 方法：`DaemonClient.listSessionArtifacts()`、`DaemonSessionClient.artifacts()`
- 模型/skill/agent 可调用的轻量工具：`record_artifact`
- hook 输出 artifacts：`hookSpecificOutput.artifacts`
- client 手动注入 API：`POST /session/:id/artifacts`
- SDK 方法：`DaemonSessionClient.addArtifact()`
- managed / published storage 引用模型

为了保持 V1 可控，不建议 V1 做：

- workspace 扫描
- 普通 `WRITE_FILE` / `EDIT` / `NOTEBOOK_EDIT` 自动进入 artifacts
- 普通文本 URL 自动抽取
- shell stdout 路径/URL 自动抽取
- artifact 内容返回
- artifact 历史版本
- artifact 持久化恢复
- 数据库/OSS/动态 iframe 沙箱

## 2. Link 是否算 Artifact

### 2.1 结论

**算，但必须是“声明式 link artifact”。**

例如这些应该算 artifact：

- skill 根据资源 ID 拼出的内部数据平台表详情 URL。
- agent 根据资源 ID 拼出的任务详情页、监控页、trace 页、lineage 页。
- MCP 工具返回的 dashboard / notebook / report URL。
- ArtifactTool 发布后的 HTML URL。
- 用户或 client 明确添加到 session 产物区的 URL。

这些不应该默认算 artifact：

- assistant 普通回答里的任意 markdown link。
- web_fetch 读到的网页 URL。
- grep/shell 输出中偶然出现的 URL。
- 引用资料、文档链接、参考链接。

核心标准：

| 类型 | 是否进入 artifacts | 原因 |
|---|---:|---|
| 普通源码编辑 | 否 | 属于 file change / diff，不是可复用产物 |
| 明确登记的生成型 workspace 文件 | 是 | report / HTML / PDF / image 等可复用输出 |
| ArtifactTool 发布的 HTML URL | 是 | 工具明确发布 |
| skill 按规则拼出的业务详情 URL | 是，但必须显式登记 | 用户需要右侧长期可点 |
| assistant 回答里的普通参考链接 | 否 | 噪音大、容易误报 |
| shell stdout 中出现的 URL | 否 | 语义不可靠 |
| web_fetch 请求过的 URL | 否 | 这是输入/来源，不是产物 |

### 2.2 Link Artifact 的产品语义

Link artifact 不是“网页内容”，而是“资源入口”。它应该在右侧产物区表现为可点击条目：

- 标题：`用户画像资源详情`
- 副标题：`internal data platform / prod`
- 类型：`link`
- URL host：`platform.example.com`
- 来源：`ToolResult.artifacts` / `ArtifactTool` / `record_artifact` / hook / client

Client 点击时打开 URL；Daemon 不读取、不验证、不预渲染该 URL。

## 3. 当前代码基线

### 3.1 Daemon REST 与 capability

相关源码：

- `packages/cli/src/serve/server.ts`
- `packages/cli/src/serve/capabilities.ts`
- `docs/developers/qwen-serve-protocol.md`

现状：

- `/capabilities` 返回 `features`，Client 必须基于 feature gate UI。
- session 级只读状态接口采用 REST 风格：
  - `GET /session/:id/status`
  - `GET /session/:id/context`
  - `GET /session/:id/tasks`
  - `GET /session/:id/events`
- capability 注册在 `SERVE_CAPABILITY_REGISTRY`。

设计：

- 新增 feature：`session_artifacts`
- 新增 route：`GET /session/:id/artifacts`
- 新增手动注入 mutation route：`POST /session/:id/artifacts`

### 3.2 Session EventBus

相关源码：

- `packages/acp-bridge/src/eventBus.ts`
- `packages/acp-bridge/src/bridge.ts`
- `packages/acp-bridge/src/bridgeClient.ts`
- `packages/sdk-typescript/src/daemon/events.ts`

现状：

- 每个 live session 有独立 `EventBus`。
- EventBus 支持 id、bounded replay ring、`Last-Event-ID`、backpressure。
- SDK 维护 known event list。

设计：

- artifact 实时更新复用现有 `/session/:id/events`。
- 新增 event type：`artifact_changed`
- Client 首次进入用 snapshot，之后用 event 增量；断线后重新拉 snapshot。

### 3.3 Tool Result 与 ArtifactTool

相关源码：

- `packages/core/src/tools/tools.ts`
- `packages/core/src/tools/tool-names.ts`
- `packages/core/src/tools/artifact/artifact-tool.ts`
- `packages/cli/src/acp-integration/session/Session.ts`
- `packages/cli/src/acp-integration/session/emitters/ToolCallEmitter.ts`

现状：

- `ToolResult` 当前包含 `llmContent`、`returnDisplay`、`resultFilePaths?`、`error?`。
- `ArtifactTool` 已能发布 HTML 并返回 URL，但没有结构化 artifact metadata。
- `ToolCallEmitter.emitResult()` 的 `_meta` 已有扩展位。

设计：

- 增加 `ToolResult.artifacts?: ToolArtifact[]`。
- `ArtifactTool` 成功时填充 `artifacts`。
- `ToolCallEmitter.emitResult()` 把 artifacts 放入 `_meta.artifacts`。
- BridgeClient 消费 `_meta.artifacts`，写入 session artifact store。

### 3.4 Hooks / Extensions / Plugins 现状

相关源码：

- `packages/core/src/hooks/types.ts`
- `packages/core/src/core/toolHookTriggers.ts`
- `packages/core/src/hooks/hookRunner.ts`
- `packages/core/src/hooks/sessionHooksManager.ts`
- `packages/core/src/hooks/registerSkillHooks.ts`
- `packages/core/src/extension/extensionManager.ts`
- `docs/developers/channel-plugins.md`

当前已有能力：

- hook 事件包括 `PreToolUse`、`PostToolUse`、`PostToolBatch`、`SessionStart`、`Stop`、`SubagentStart`、`SubagentStop` 等。
- hook 类型包括 command、HTTP、function、prompt。
- command hook stdout 支持 JSON 形式的 `HookOutput`。
- HTTP hook response 支持 JSON 形式的 `HookOutput`。
- session hooks 可通过 `SessionHooksManager` 运行时注册。
- skill frontmatter 可注册 session-scoped command/HTTP hooks。
- extension 可提供 commands、skills、hooks、MCP servers、channels。
- channel plugin 主要是消息平台适配，能观察 tool call / response chunk，但不是 daemon artifact 注入通道。

当前缺口：

- hook output 只有 `additionalContext`、decision、stopReason 等通用字段。
- 当前没有标准 `hookSpecificOutput.artifacts`。
- 当前 daemon 只有 `GET /workspace/hooks` 和 `GET /session/:id/hooks` 状态接口，没有“hook 主动注入 artifact”的 route。

结论：

- hooks/extensions 是很好的自定义 artifact 入口，但需要扩展 hook output schema。
- channel plugin 不建议作为 artifact 注入主通道；它适合外部聊天平台展示，不适合维护 daemon session artifact index。

## 4. API 设计

### 4.1 Capability

新增：

```json
"session_artifacts"
```

Client 只有看到该 feature 才展示 artifacts 面板和调用相关 API。

### 4.2 List Artifacts

```http
GET /session/:id/artifacts
```

响应：

```json
{
  "v": 1,
  "sessionId": "session-123",
  "workspaceCwd": "/repo",
  "artifacts": [
    {
      "id": "a1b2c3d4",
      "kind": "link",
      "storage": "external_url",
      "title": "用户画像资源详情",
      "description": "内部数据平台资源详情页",
      "url": "https://platform.example.com/resources/user-profile",
      "mimeType": "text/html",
      "status": "available",
      "source": "tool",
      "toolCallId": "call_abc",
      "toolName": "artifact",
      "createdAt": "2026-06-26T10:00:00.000Z",
      "updatedAt": "2026-06-26T10:00:00.000Z",
      "metadata": {
        "resourceType": "data_platform_resource",
        "env": "prod"
      }
    }
  ]
}
```

### 4.3 Artifact Changed Event

通过现有：

```http
GET /session/:id/events
```

新增 event：

```json
{
  "v": 1,
  "type": "artifact_changed",
  "data": {
    "sessionId": "session-123",
    "change": "created",
    "artifact": {
      "id": "a1b2c3d4",
      "kind": "link",
      "storage": "external_url",
      "title": "用户画像资源详情",
      "url": "https://platform.example.com/resources/user-profile",
      "status": "available",
      "source": "tool",
      "toolName": "artifact",
      "createdAt": "2026-06-26T10:00:00.000Z",
      "updatedAt": "2026-06-26T10:00:00.000Z"
    }
  }
}
```

`change`：

- `created`
- `updated`
- `removed`

V1 主要产生 `created` / `updated`；eviction 或显式删除场景产生 `removed`。

### 4.4 Client Manual Insert

作为 V1 的 client 显式登记入口：

```http
POST /session/:id/artifacts
```

用途：

- WebUI/IDE/外部 client 手动添加自定义 link artifact。
- 扩展或集成层在不经过模型工具调用时向右侧产物面板插入资源。

请求：

```json
{
  "kind": "link",
  "storage": "external_url",
  "title": "任务详情",
  "description": "调度任务 task_123 的详情页",
  "url": "https://ops.example.com/tasks/task_123",
  "mimeType": "text/html",
  "metadata": {
    "resourceType": "scheduler_task"
  }
}
```

响应：

```json
{
  "v": 1,
  "sessionId": "session-123",
  "change": "created",
  "artifact": {
    "id": "a1b2c3d4e5f6",
    "kind": "link",
    "storage": "external_url",
    "title": "任务详情",
    "description": "调度任务 task_123 的详情页",
    "url": "https://ops.example.com/tasks/task_123",
    "mimeType": "text/html",
    "status": "available",
    "source": "client",
    "createdAt": "2026-06-26T10:00:00.000Z",
    "updatedAt": "2026-06-26T10:00:00.000Z",
    "metadata": {
      "resourceType": "scheduler_task"
    }
  }
}
```

安全：

- 这是 mutation route，应使用现有 mutation gate。
- 有 bearer token 的 daemon 才允许远程 client 调用。
- 不读取 URL。
- 不自动打开 URL。

## 5. 数据模型

### 5.1 Public SDK 类型

```ts
export type DaemonSessionArtifactKind =
  | 'file'
  | 'link'
  | 'image'
  | 'video'
  | 'audio'
  | 'html'
  | 'pdf'
  | 'notebook'
  | 'other';

export type DaemonSessionArtifactStatus = 'available' | 'missing';

export type DaemonSessionArtifactSource = 'tool' | 'hook' | 'client';

export type DaemonSessionArtifactStorage =
  | 'workspace'
  | 'managed'
  | 'external_url'
  | 'published';

export interface DaemonSessionArtifact {
  id: string;
  kind: DaemonSessionArtifactKind;
  storage: DaemonSessionArtifactStorage;
  title: string;
  description?: string;
  status: DaemonSessionArtifactStatus;
  source: DaemonSessionArtifactSource;
  createdAt: string;
  updatedAt: string;
  workspacePath?: string;
  managedId?: string;
  url?: string;
  mimeType?: string;
  sizeBytes?: number;
  toolCallId?: string;
  toolName?: string;
  hookName?: string;
  extensionId?: string;
  clientId?: string;
  sourceId?: string;
  visibility?: 'session';
  expiresAt?: string;
  sensitivity?: 'normal' | 'sensitive';
  metadata?: Record<string, string | number | boolean | null>;
}

export interface DaemonSessionArtifactsEnvelope {
  v: 1;
  sessionId: string;
  workspaceCwd: string;
  artifacts: DaemonSessionArtifact[];
}

export interface DaemonArtifactChangedData {
  sessionId: string;
  change: 'created' | 'updated' | 'removed';
  artifact: DaemonSessionArtifact;
}
```

### 5.2 Core ToolArtifact 类型

```ts
export type ToolArtifactKind =
  | 'file'
  | 'link'
  | 'image'
  | 'video'
  | 'audio'
  | 'html'
  | 'pdf'
  | 'notebook'
  | 'other';

export type ToolArtifactStorage =
  | 'workspace'
  | 'managed'
  | 'external_url'
  | 'published';

export interface ToolArtifact {
  kind?: ToolArtifactKind;
  storage?: ToolArtifactStorage;
  title: string;
  description?: string;
  workspacePath?: string;
  managedId?: string;
  url?: string;
  mimeType?: string;
  metadata?: Record<string, string | number | boolean | null>;
}
```

并扩展：

```ts
export interface ToolResult {
  llmContent: unknown;
  returnDisplay: unknown;
  resultFilePaths?: string[];
  artifacts?: ToolArtifact[];
  error?: unknown;
}
```

### 5.3 Input 到 Public Artifact 的补全规则

`ToolArtifact` 是输入形态，`DaemonSessionArtifact` 是对外返回形态。所有入口都必须先转换为统一的 `SessionArtifactInput`，再由 `SessionArtifactStore` 补全公共字段。

补全规则：

- `id`：由 Section 7 的 identity hash 生成。
- `source`：由入口上下文决定，tool result / ArtifactTool 为 `tool`，hook 为 `hook`，client POST 为 `client`。
- `toolCallId` / `toolName`：由 tool call 上下文补入；hook/client 入口没有则不填。
- `hookName` / `extensionId` / `clientId` / `sourceId`：有上下文时补入，用于审计和 UI 分组。
- `createdAt`：首次 upsert 时写入。
- `updatedAt`：每次 upsert 时刷新。
- `status`：workspace / managed artifact 初始为 `available`，GET 时 best-effort stat 后可变为 `missing`；URL artifact 始终为 `available`。
- `visibility`：V1 固定为 `session`。
- `sensitivity`：默认 `normal`；`metadata` 不得携带 secret、token、cookie 或签名凭证。
- `storage` 默认值：
  - 有 `workspacePath` 时为 `workspace`。
  - 有 `managedId` 且没有 `url` 时为 `managed`。
  - 有 `url` 时为 `external_url`。
  - `ArtifactTool` 发布结果显式使用 `published`。
- `kind` 默认值：
  - 有 `url` 且没有 `workspacePath` 时为 `link`。
  - 有 `workspacePath` 时按扩展名推断：`.html` -> `html`，图片扩展名 -> `image`，`.pdf` -> `pdf`，`.ipynb` -> `notebook`，否则 `file`。
  - 无法推断时为 `other`。

### 5.4 字段约束

- `workspacePath` 只对 workspace 内文件对外展示，且必须是 workspace-relative path。
- `managedId` 是 daemon/qwen-home 托管产物引用，不能是本机绝对路径。
- `url` 只接受明确登记的 URL 或 ArtifactTool 发布 URL。
- `workspacePath`、`managedId`、`url` 至少存在一个。
- 普通工具不得把 `~/.qwen`、`/tmp` 或其他本机绝对路径作为 `workspacePath` 返回。
- `description` 是 UI 辅助文字，不进入模型上下文。
- `metadata` 必须是小对象，只允许 primitive value。
- `metadata` 不放 secret、token、cookie、签名私钥。
- `sizeBytes` 是 best-effort。

## 6. Artifact 采集来源

### 6.1 文件输出入口

V1 不从普通文件编辑工具自动派生 artifact。

不自动派生：

- `ToolNames.WRITE_FILE`
- `ToolNames.EDIT`
- `ToolNames.NOTEBOOK_EDIT`
- `read_file`
- `grep_search`
- `glob`
- `list_directory`
- `web_fetch`
- `run_shell_command`

原因：

- 普通源码编辑、配置修改、测试修复属于 file change / diff / patch history。
- 自动把每次 source edit 放入 artifacts 面板会制造大量噪音。
- 右侧产物区应该保留给可复用、可预览、可下载或可分享的 session outputs。

文件可以进入 artifact store 的条件：

- 工具结果显式返回 `ToolResult.artifacts`。
- `ArtifactTool` 发布输出。
- V1 的 `record_artifact` / hook / client POST 显式登记。
- 未来如需要便利派生，只允许生成型输出文件，并要求工具结果或结构化 metadata 标记为 artifact；不要从普通 `WRITE_FILE` / `EDIT` 默认推断。

生成型输出示例：

- report：`.html`、`.pdf`、`.md`
- media：`.png`、`.jpg`、`.mp4`、`.mp3`
- office/data：`.xlsx`、`.docx`、`.pptx`、`.csv`
- notebook：作为交付物生成的 `.ipynb`

即使是 notebook，也要区分“编辑已有 notebook 源文件”和“生成给用户查看/下载的 notebook artifact”。

### 6.2 ArtifactTool

`ArtifactTool` 成功发布后返回：

```ts
artifacts: [
  {
    kind: 'html',
    storage: 'published',
    title,
    url,
    managedId,
    mimeType: 'text/html',
  },
]
```

保留现有 `llmContent`、`returnDisplay`、`resultFilePaths`，保证兼容。

`ArtifactTool` 当前 local publisher 可能把内容写入 qwen home 下的托管目录，并返回 `file://` 或远端 URL。Daemon artifact API 不应把 qwen home 本机绝对路径作为 `workspacePath` 暴露；应使用：

- `storage: 'published'`
- `url`: 已发布的可打开 URL
- `managedId`: 可选的内部托管引用

如果未来要让 daemon client 下载或预览托管内容，应新增专门的 managed artifact route，而不是把本机绝对路径塞进 public artifact。

### 6.3 record_artifact 工具

作为 V1 的模型/skill 显式登记入口，新增轻量内置工具：

```ts
ToolNames.RECORD_ARTIFACT = 'record_artifact'
```

用途：

- 模型显式登记非文件类产物。
- skill / agent.md 可以要求模型在拼出业务 URL 后调用该工具。
- 不做网络请求。
- 不写 workspace 文件。
- 只写 session artifact index。

参数：

```ts
interface RecordArtifactParams {
  title: string;
  description?: string;
  kind?: ToolArtifactKind;
  storage?: ToolArtifactStorage;
  workspacePath?: string;
  managedId?: string;
  url?: string;
  mimeType?: string;
  metadata?: Record<string, string | number | boolean | null>;
}
```

示例：

```json
{
  "title": "用户画像资源详情",
  "description": "内部数据平台生产环境资源详情页",
  "kind": "link",
  "storage": "external_url",
  "url": "https://platform.example.com/resources/user-profile?env=prod",
  "mimeType": "text/html",
  "metadata": {
    "resourceType": "data_platform_resource",
    "env": "prod"
  }
}
```

返回：

```ts
return {
  llmContent: 'Recorded artifact "用户画像资源详情".',
  returnDisplay: 'Recorded artifact: 用户画像资源详情',
  artifacts: [params],
};
```

权限建议：

- 不建议默认注册到所有 session；应 feature-gated，或由 skill/extension 显式启用。
- 如果启用，可以默认 `allow`，因为它只修改 session UI metadata。
- URL 不自动打开。
- Client 展示 host，用户点击前可辨识目标。
- 如果未来允许 `file://`，必须只允许 workspace 内文件；V1 不建议 `record_artifact` 接受 `file://` URL。
- 与 hook/client POST 一样，必须经过统一 artifact validation。

### 6.4 Hook 输出 artifacts

作为 V1 的 hook/extension 显式登记入口扩展。当前 hooks 已支持 command/HTTP/function/prompt，并且 command/HTTP hook 可以返回 JSON `HookOutput`。建议扩展 `hookSpecificOutput`：

```json
{
  "continue": true,
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "artifacts": [
      {
        "kind": "link",
        "storage": "external_url",
        "title": "调度任务详情",
        "url": "https://ops.example.com/task/task_123",
        "mimeType": "text/html",
        "metadata": {
          "resourceType": "scheduler_task"
        }
      }
    ]
  }
}
```

适合场景：

- PostToolUse hook 观察某个 MCP/tool 输出，按组织规则拼业务 URL。
- PostToolBatch hook 在一批工具完成后汇总多个资源入口。
- extension 提供 hooks，把企业内部资源 URL 注入右侧产物区。
- skill frontmatter 注册 PostToolUse hook，在 skill 生效期间自动登记 artifacts。

需要代码改动：

- `HookOutput.hookSpecificOutput.artifacts?: ToolArtifact[]`。
- `packages/core/src/hooks/hookAggregator.ts` 对多个 hook 的 `artifacts` 做 concat，不走 last-writer-wins。
- `packages/core/src/core/toolHookTriggers.ts` 的 `PostToolUseHookResult` / `PostToolBatchHookResult` 增加 `artifacts?: ToolArtifact[]`。
- `firePostToolUseHook()` 返回 `artifacts?: ToolArtifact[]`。
- `firePostToolBatchHook()` 返回 `artifacts?: ToolArtifact[]`。
- `packages/core/src/core/coreToolScheduler.ts` 必须纳入实现计划，因为它是 `firePostToolBatchHook()` 的调用点，也有独立的 `firePostToolUseHook()` 路径。
- `Session.runTool()` 合并 hook artifacts 与 tool artifacts。
- hook artifacts 与 `record_artifact` / client POST 走同一套 validation：URL scheme、workspace path containment、metadata size/type。
- batch-level artifacts 没有单一 tool call 时，可通过 ACP `extNotification` 发送 `qwen/notify/session/artifact-event`。

`qwen/notify/session/artifact-event` payload：

```json
{
  "artifacts": [
    {
      "kind": "link",
      "storage": "external_url",
      "title": "批处理任务详情",
      "url": "https://ops.example.com/task/batch_123",
      "mimeType": "text/html"
    }
  ],
  "source": "hook",
  "hookEventName": "PostToolBatch",
  "hookName": "task-artifacts",
  "extensionId": "example-extension"
}
```

### 6.5 Client / Extension 直接插入

对不想让模型调用工具的场景，提供：

```http
POST /session/:id/artifacts
```

适合：

- IDE 插件把当前打开的预览 URL 加入产物区。
- WebUI 用户手动添加一个资源链接。
- Channel plugin 或外部集成在任务过程中登记平台资源。

与 hook 输出的区别：

- hook 输出适合 agent 执行链路内部。
- POST route 适合 daemon client / UI / 外部集成。
- POST body 必须经过统一 artifact validation，不允许任意本机绝对路径或不支持的 URL scheme。

## 7. Store 与去重

artifact identity：

- workspace 文件：`sessionId + ':workspace:' + normalizedWorkspacePath`
- managed 文件：`sessionId + ':managed:' + managedId`
- external / published URL：`sessionId + ':url:' + normalizedUrl`

对外 id：

- 用 identity 的 sha256 前 12 位。

### 7.1 Normalization

`normalizedWorkspacePath`：

- 输入必须是 workspace-relative path；如果入口传入绝对路径，先尝试转换为 workspace-relative path，失败则拒绝。
- 使用 `path.resolve(workspaceCwd, input)` 得到绝对路径。
- 校验 resolved path 必须位于 workspace 内：`path.relative(workspaceCwd, resolved)` 不能以 `..` 开头，且不能是绝对路径。
- 如果目标已存在，使用 `fs.realpath` 检查 symlink 最终目标仍在 workspace 内；symlink 指向 workspace 外则拒绝。
- 输出统一使用 POSIX slash，去掉开头的 `./`。
- 不做大小写折叠；即使 macOS 默认文件系统大小写不敏感，identity 仍按字符串区分，避免跨平台行为不一致。

`normalizedUrl`：

- 使用 WHATWG `new URL(input)` 解析，禁止字符串 `startsWith('http')` 这类宽松判断。
- 除 `ArtifactTool` trusted published URL 外，普通 link artifact 只允许 `http:` / `https:`。
- scheme 和 host 小写。
- 默认端口归一化：`https:443` / `http:80` 不保留。
- 删除 fragment。
- 对 query params 按 key/value 排序后重新序列化。
- 拒绝或清除 `username` / `password`，不把 URL userinfo 存入 artifact store。

去重行为：

- 首次登记：`created`
- 同 identity 再登记：`updated`
- `createdAt` 保持不变。
- `updatedAt` 更新。
- 同一批输入中重复 identity 按数组顺序处理，后者覆盖前者。
- 不同来源同时 upsert 同一 identity 时，按 bridge 收到事件的顺序 last-write-wins；实现应在单个 `SessionArtifactStore.upsertMany()` 内同步处理，避免异步读改写竞态。
- `metadata` 做浅合并，后写同名 key 覆盖先写；`title`、`description`、`toolCallId`、`toolName`、`source`、`hookName` 等顶层字段以后写值为准。

保留策略：

- 每 session 最多 200 个 artifacts。
- 返回 `createdAt` 升序。
- 超出时裁掉最旧项。
- 裁剪必须为每个被移除 artifact 发送 `artifact_changed` / `removed`，或发送一次 `artifacts_trimmed` 让 client 重新拉 snapshot；V1 推荐发送逐条 `removed`，避免 client 长期保留 stale state。
- 后续可增加 per-source quota，避免单个工具或 hook 挤掉所有高价值 artifacts。

### 7.2 V1 生命周期限制

V1 的 store 是 live bridge session 内存索引：

- bridge/session 重启后 artifacts 不恢复。
- Client SSE 断线重连后应重新 `GET /session/:id/artifacts` 做 snapshot sync。
- 历史恢复、跨进程持久化和 session load replay 属于后续阶段。

## 8. 内部实现链路

以下 Phase 是同一 V1 完整能力的工程实施顺序，不代表对外拆成多个版本。实现 PR 可以按 Phase 拆小，但合并后的设计基准是一项完整 session artifacts 能力。

### 8.1 Phase A: core types and ArtifactTool

改动：

- `packages/core/src/tools/tools.ts`
  - 增加 `ToolArtifactKind`、`ToolArtifactStorage`、`ToolArtifact`。
  - 扩展 `ToolResult.artifacts?`。
- `packages/core/src/tools/artifact/artifact-tool.ts`
  - 成功 publish 后填充 `artifacts`。
  - 使用 `storage: 'published'`，不把 qwen home 本机路径作为 `workspacePath` 暴露。

Phase A 先接入 `ToolResult.artifacts` 和 `ArtifactTool`；`record_artifact` 在 Phase D 接入，但仍属于同一个 V1 完整能力。

### 8.2 Phase B: cli ACP session metadata

改动：

- `packages/cli/src/acp-integration/session/types.ts`
  - `ToolCallResultParams.artifacts?`
- `packages/cli/src/acp-integration/session/emitters/ToolCallEmitter.ts`
  - `_meta.artifacts = params.artifacts`
- `packages/cli/src/acp-integration/session/Session.ts`
  - 工具成功后只收集 `toolResult.artifacts`。
  - 不从普通 `WRITE_FILE` / `EDIT` / `NOTEBOOK_EDIT` 自动派生 artifacts。
  - 传给 `emitResult()`。

### 8.3 Phase C: acp-bridge store and events

新增：

- `packages/acp-bridge/src/sessionArtifacts.ts`
  - 类型
  - normalize
  - validation
  - id/hash
  - `SessionArtifactStore`

Bridge session entry 增加：

```ts
artifacts: SessionArtifactStore;
```

Bridge interface 增加：

```ts
getSessionArtifacts(sessionId: string): SessionArtifactsEnvelope;
```

BridgeClient：

- 从 `session_update/tool_call_update._meta.artifacts` 提取 artifacts。
- upsert store。
- 发布 `artifact_changed`。
- 如果 store 因上限裁剪 artifact，发布对应 `removed` event。

### 8.4 Phase C: serve snapshot API

改动：

- `packages/cli/src/serve/capabilities.ts`
  - 增加 `session_artifacts`。
- `packages/cli/src/serve/server.ts`
  - 增加 `GET /session/:id/artifacts`。

GET 行为：

- session 不存在：现有 404。
- 无 artifacts：返回空数组。
- workspace / managed artifact 在每次 GET 时 best-effort stat。
- stat 失败：返回 `status: 'missing'`，不从 store 中删除。
- stat 成功：如果此前是 `missing`，返回时恢复 `status: 'available'`。
- URL artifact 不探测，始终返回 `status: 'available'`。

### 8.5 Phase C: SDK list/event support

改动：

- `packages/sdk-typescript/src/daemon/types.ts`
  - 增加 artifact 类型。
- `packages/sdk-typescript/src/daemon/events.ts`
  - known event 增加 `artifact_changed`。
- `packages/sdk-typescript/src/daemon/DaemonClient.ts`
  - `listSessionArtifacts(sessionId, opts?, clientId?)`
- `packages/sdk-typescript/src/daemon/DaemonSessionClient.ts`
  - `artifacts(opts?)`
- `packages/sdk-typescript/src/index.ts`
  - 导出类型。

### 8.6 Phase D: record_artifact explicit registration

改动：

- `packages/core/src/tools/tool-names.ts`
  - 增加 `RECORD_ARTIFACT: 'record_artifact'`。
- 新增 `packages/core/src/tools/record-artifact.ts`
  - 实现 `RecordArtifactTool`。
  - 参数使用 `workspacePath` / `managedId` / `url`，不接受任意本机绝对路径。
  - 输出 `ToolResult.artifacts`，复用 V1 store/event/list 链路。
- `Config.createToolRegistry`
  - feature-gated 或 skill/extension opt-in 注册，避免给所有 session 增加模型可见 tool。

### 8.7 Phase E: hook artifacts explicit registration

改动：

- `packages/core/src/hooks/types.ts`
  - `HookOutput.hookSpecificOutput.artifacts?: ToolArtifact[]`。
- `packages/core/src/hooks/hookAggregator.ts`
  - `artifacts` 多 hook concat，不走 last-writer-wins。
- `packages/core/src/core/toolHookTriggers.ts`
  - `PostToolUseHookResult` / `PostToolBatchHookResult` 增加 `artifacts?: ToolArtifact[]`。
- `packages/core/src/core/coreToolScheduler.ts`
  - 覆盖 core scheduler 的 PostToolUse / PostToolBatch artifacts 传播路径。
- `packages/cli/src/acp-integration/session/Session.ts`
  - 覆盖 ACP session 的 PostToolUse artifacts 传播路径。
- batch-level artifacts 通过 `qwen/notify/session/artifact-event` 发给 bridge。
- BridgeClient 从 `qwen/notify/session/artifact-event` 提取 batch-level artifacts，走同一套 validation 和 upsert。

### 8.8 Phase F: client POST / SDK add explicit registration

改动：

- `packages/cli/src/serve/server.ts`
  - 增加 `POST /session/:id/artifacts`，走 `mutate({ strict: true })`。
  - validate body。
  - source 设置为 `client`。
  - 调用 bridge upsert。
  - 发布 `artifact_changed`。
- Bridge interface 增加：

```ts
addSessionArtifact(
  sessionId: string,
  artifact: SessionArtifactInput,
  source: 'client',
): ArtifactChangedResult;
```

- SDK 增加：
  - `DaemonClient.addSessionArtifact(sessionId, artifact, clientId?)`
  - `DaemonSessionClient.addArtifact(artifact)`

## 9. 安全边界

### 9.1 URL

- 普通 link artifact 只允许 `http:` / `https:`。
- 必须使用 WHATWG `new URL(input)` 解析并检查 `parsed.protocol`，禁止基于字符串前缀判断。
- 存储前拒绝或清除 `parsed.username` / `parsed.password`，避免 URL credential 泄漏。
- `record_artifact` / hook / client POST 不允许 `file://`。
- `ArtifactTool` 返回的 `file://` published URL 保持例外，因为它来自已授权 publish；remote daemon 场景应优先使用远端 publisher 的 `https:` URL。
- Daemon 不 fetch URL。
- Client 展示 host。
- URL 不自动打开。
- Client 应对 loopback、RFC 1918、link-local、metadata service 等私网地址做 warning 或 block；Daemon V1 不解析 DNS，不承担 SSRF 防护的最终判断。

### 9.2 Path

- 对外只返回 `workspacePath`，它必须是 workspace-relative path。
- workspace 外 path 不作为 file artifact 暴露。
- `record_artifact` / hook / client POST 如果传 `workspacePath`，必须在 workspace 内。
- 校验算法见 Section 7.1：`path.resolve` + `path.relative` containment check，目标存在时再做 `fs.realpath` symlink escape check。
- 拒绝 `..` escape、绝对路径 escape、symlink 指向 workspace 外、`~/.qwen`、`/tmp` 等本机外部路径。
- `managedId` 只能引用 daemon-managed storage，不允许包含路径分隔符或本机绝对路径语义。

### 9.3 Metadata

- 限制大小，例如 JSON stringify 后不超过 4KB。
- 只允许 primitive value。
- 不允许 nested object/array，避免 UI 和持久化复杂化。
- 不放 secret、token、cookie、signed URL、私钥、访问凭证。
- `sensitivity` 可标记为 `sensitive`，但 V1 不实现跨用户 RBAC；V1 visibility 固定为 session-local。
- audit 维度通过 `source`、`toolCallId`、`toolName`、`hookName`、`extensionId`、`clientId`、`sourceId`、`createdAt`、`updatedAt` 预留。

### 9.4 Anti-spam

- 每 session 最多 200 个 artifacts。
- `record_artifact` 可以每次 tool call 最多登记 10 个 artifacts。
- `POST /session/:id/artifacts` 走现有 rate limit / mutation gate。
- eviction 必须通知 client：逐条 `removed` event 或 `artifacts_trimmed` resync event。
- Client 可按 source/toolName 分组或折叠。

## 10. 与“普通链接”的边界

右侧 artifacts 面板只展示声明式 artifacts；聊天正文仍可显示普通链接。

不做自动抽取的原因：

- 普通回答里的文档链接、引用链接、调试链接会大量误入产物区。
- URL 可能是示例、模板、半成品、错误输出。
- 自动抽取会让模型无法控制“哪些链接值得用户后续使用”。
- 安全上，显式登记更容易做来源标记和 UI 警示。

如果业务强烈需要从文本中提取 URL，应作为 Client 可选 UX：

- 仅在聊天正文附近显示。
- 不进入 daemon artifact store。
- 不触发 `artifact_changed`。

## 11. Skill / Agent 使用方式

V1 提供 `record_artifact` 后，skill 或 agent.md 可以写：

```md
当你根据工具结果构造出可供用户查看的业务资源 URL 时，调用 record_artifact 工具登记它。

登记规则：
- title 使用资源的人类可读名称。
- kind 使用 link。
- storage 使用 external_url。
- url 使用最终可点击 URL。
- metadata.resourceType 填资源类型，例如 data_platform_resource、scheduler_task。
- 不要把普通参考文档链接登记为 artifact。
```

模型执行后：

1. 调用业务工具拿到资源 ID、任务 ID、节点 ID。
2. 按 skill 规则拼 URL。
3. 调用 `record_artifact`。
4. Daemon 右侧产物区出现该 link。

这个方案不要求 skill 编写 hook，也不要求 extension/plugin 代码，最适合多数业务规则。

## 12. Hook / Extension 使用方式

V1 提供 hook artifacts 后，extension 可在 `qwen-extension.json` 或 `hooks/hooks.json` 中提供 PostToolUse hook：

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "mcp__data_platform__get_resource",
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/table-artifact.js"
          }
        ]
      }
    ]
  }
}
```

当前 qwen-code extension/hook 变量替换仍支持 `${CLAUDE_PLUGIN_ROOT}`；如果后续引入新的 qwen-specific root 变量，示例可随实现同步迁移。

脚本 stdout：

```json
{
  "continue": true,
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "artifacts": [
      {
        "kind": "link",
        "storage": "external_url",
        "title": "用户画像资源详情",
        "url": "https://platform.example.com/resources/user-profile",
        "mimeType": "text/html",
        "metadata": {
          "resourceType": "data_platform_resource"
        }
      }
    ]
  }
}
```

这适合企业插件：把“如何从工具结果拼业务 URL”的逻辑固化在 extension 中，而不是写进每个 prompt。

## 13. 测试计划

### 13.1 Phase A core

覆盖：

- `ToolResult.artifacts` 类型编译。
- `ArtifactTool` 成功返回 `storage: 'published'` 的 html artifact。
- `ArtifactTool` 不把 qwen home 本机绝对路径作为 `workspacePath` 暴露。
- `ToolArtifact.kind` / `storage` 默认推断规则有单测覆盖。

命令：

```bash
cd packages/core && npx vitest run src/tools/artifact/artifact-tool.test.ts
```

### 13.2 Phase B cli session

覆盖：

- `ToolCallEmitter.emitResult()` 输出 `_meta.artifacts`。
- `toolResult.artifacts` 被传给 `emitResult()`。
- `write_file/edit/notebook_edit` 普通源码修改不自动派生 artifact。
- `read_file/grep/glob/shell` 不派生 artifact。
- 工具失败不产生 artifacts。

命令：

```bash
cd packages/cli && npx vitest run src/acp-integration/session/emitters/ToolCallEmitter.test.ts
cd packages/cli && npx vitest run src/acp-integration/session/Session.test.ts
```

### 13.3 Phase C acp-bridge

覆盖：

- `SessionArtifactStore` created/updated/removed。
- `ToolArtifact` 到 `DaemonSessionArtifact` 的 enrichment。
- 默认 `kind` / `storage` 推断。
- workspacePath / managedId / URL identity 去重。
- URL normalization：scheme/host lowercase、default port、fragment drop、query sort、userinfo rejection/removal。
- Path validation：`../../etc/passwd`、workspace 外绝对路径、symlink escape 均被拒绝。
- Metadata validation：大小限制、primitive-only、nested object/array 拒绝。
- 上限裁剪会发送 removed event 或 trimmed resync event。
- `_meta.artifacts` 被写入 store。
- `artifact_changed` 发布。
- malformed artifact 被忽略，不影响原始 event。

命令：

```bash
cd packages/acp-bridge && npx vitest run src/sessionArtifacts.test.ts
cd packages/acp-bridge && npx vitest run src/bridgeClient.test.ts
```

### 13.4 Phase C serve

覆盖：

- `/capabilities` 包含 `session_artifacts`。
- `GET /session/:id/artifacts` 返回空列表。
- 有 artifacts 时返回 envelope。
- 未知 session 返回现有错误。
- workspace artifact GET 时 best-effort stat，缺失文件返回 `status: 'missing'`，文件恢复后返回 `status: 'available'`。

命令：

```bash
cd packages/cli && npx vitest run src/serve/server.test.ts
```

### 13.5 Phase C SDK

覆盖：

- `listSessionArtifacts()` route 正确。
- `artifact_changed` known event narrowing。
- public index 导出新增类型。

命令：

```bash
cd packages/sdk-typescript && npx vitest run src/daemon/DaemonClient.test.ts
cd packages/sdk-typescript && npx vitest run src/daemon/events.test.ts
```

### 13.6 Phase D/E/F explicit registration tests

`record_artifact`：

- 校验 title / workspacePath / managedId / url。
- 不允许空 `workspacePath + managedId + url`。
- 不允许不支持的 URL scheme。
- URL userinfo 被拒绝或清除。
- 返回 `ToolResult.artifacts`。

hook artifacts：

- `HookOutput.hookSpecificOutput.artifacts` 通过 `createHookOutput()`、`toolHookTriggers.ts` 进入 `PostToolUseHookResult` / `PostToolBatchHookResult`。
- `hookAggregator.ts` 多 hook artifacts concat。
- `coreToolScheduler.ts` 和 ACP `Session.ts` 两条路径都能传播 PostToolUse artifacts。
- PostToolBatch artifacts 通过 `qwen/notify/session/artifact-event` 被写入 store。
- hook artifacts 与其他入口经过同一 validation。

client POST / SDK add：

- `POST /session/:id/artifacts` 成功 upsert。
- `POST` 在未授权/无 mutation token 时被拒绝。
- `POST` 对 workspace 外 path、path traversal、symlink escape 返回 400。
- `DaemonClient.addSessionArtifact()` body 正确。

### 13.7 跨包集成测试

覆盖完整链路：

1. tool 返回 `ToolResult.artifacts`。
2. `ToolCallEmitter` 写入 `_meta.artifacts`。
3. `BridgeClient` 从 event 中提取 artifacts。
4. `SessionArtifactStore` validate / normalize / upsert。
5. SSE 发送 `artifact_changed`。
6. `GET /session/:id/artifacts` 返回同一个 artifact。
7. Client 断线重连后重新拉 snapshot 能恢复当前内存状态。

### 13.8 手工验收

场景 A：文件产物

1. ArtifactTool 发布 `lineage.html`。
2. `GET /session/:id/artifacts` 返回 `storage: 'published'` 的 html artifact。
3. SSE 收到 `artifact_changed`。

场景 B：普通源码编辑不进入产物区

1. agent 修改源码文件。
2. file change / diff 正常出现。
3. artifact list 不变化。

场景 C：显式业务链接产物

1. skill 要求模型拼内部资源详情 URL。
2. 模型调用 `record_artifact`。
3. 右侧产物区出现 link artifact。

场景 D：hook 产物

1. extension 注册 PostToolUse hook。
2. hook 根据 tool output 返回 artifacts。
3. 右侧产物区出现 hook source artifact。

场景 E：普通链接不进入产物区

1. assistant 回复 markdown link。
2. artifact list 不变化。

## 14. 验收标准

V1 完整能力实现后至少满足：

- `session_artifacts` feature 存在。
- `GET /session/:id/artifacts` 可用。
- `artifact_changed` event 可用。
- `ArtifactTool` 生成 published html artifact。
- `ToolResult.artifacts` 能进入 daemon artifact store。
- `record_artifact` 能登记 link / workspace artifact，且 feature-gated 或 opt-in 注册。
- hook 能通过 `hookSpecificOutput.artifacts` 注入 artifact，多个 hook artifacts concat。
- client 可通过 `POST /session/:id/artifacts` 注入 artifact。
- 普通 `WRITE_FILE` / `EDIT` / `NOTEBOOK_EDIT` 不自动进入 artifact list。
- 普通 assistant 文本 URL 不进入 artifact list。
- SDK 能 list/add artifacts，能识别 `artifact_changed`。
- workspacePath / URL / metadata 安全边界有单测。
- eviction 会通知 client 移除或 resync。
- hook/client/record_artifact 三个入口经过同一 validation。
- `npm run build && npm run typecheck` 通过。

## 15. 推荐落地顺序

V1 内部建议按以下顺序实现；这是工程排期，不是能力拆分：

1. `ToolArtifact` + `ToolResult.artifacts?`
2. `ArtifactTool` structured artifacts
3. `ToolCallEmitter._meta.artifacts`
4. `Session.runTool()` 只收集 `toolResult.artifacts`
5. `SessionArtifactStore` validation / normalize / enrichment / upsert
6. BridgeClient 消费 `_meta.artifacts`
7. `GET /session/:id/artifacts`
8. SDK list/event 类型
9. `RecordArtifactTool`
10. hook output artifacts
11. `qwen/notify/session/artifact-event`
12. `POST /session/:id/artifacts`
13. SDK addArtifact
14. managed / published storage 引用补齐
15. 协议文档与 tests

## 16. 后续路线

Phase 2：历史恢复

- artifacts 写入 chat recording metadata。
- HistoryReplayer 重放 artifacts。
- `session/load` 后 artifact list 可恢复。

Phase 3：详情与预览

- `GET /session/:id/artifacts/:artifactId`
- preview metadata。
- 图片/PDF/HTML 预览策略。

Phase 4：安全动态预览

- 独立 sandbox origin。
- iframe sandbox。
- HTML/React artifact shim。

Phase 5：长期存储

- OSS/MinIO。
- retention policy。
- pin/delete/version history。

## 17. 总结

Link 可以是 artifact，但必须显式登记。右侧产物区不应该自动收集所有文本链接。

V1 对外是一项完整能力，内部由统一 store 和四类入口组成：

1. **工具入口**：`ToolResult.artifacts` / `ArtifactTool` 产生结构化 artifact metadata。
2. **模型/skill 入口**：`record_artifact` 工具。
3. **hook/extension 入口**：`hookSpecificOutput.artifacts`。
4. **client 入口**：`POST /session/:id/artifacts`。

这些入口最终都进入同一个 `SessionArtifactStore`，通过同一个 `GET /session/:id/artifacts` 查询，通过同一个 `artifact_changed` SSE 事件更新 UI。这样能覆盖业务 link、文件、HTML、图片、视频等产物，同时保持协议简单、来源清晰、边界可控。最重要的边界是：Artifacts 是被声明的 session outputs，不是所有普通文件编辑或普通链接的集合。
