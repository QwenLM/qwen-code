# Qwen-Code Daemon Session Artifacts API 可实施设计

> 输入资料：session artifacts daemon API 初版草案与 artifact design v1 草案。  
>  
> 源码基线：当前 qwen-code 代码。  
> 目标：基于现有 Daemon / ACP / SSE / SDK / hooks / extension 能力，设计一套可实施、可验证、边界清楚的 session artifacts API。

## 1. 设计结论

建议把 artifact 定义为：

> **Session 过程中由 agent、tool、hook、client 或 extension 明确登记的、用户可复用/点击/预览/下载的结构化产物引用。**

这个定义覆盖文件，也覆盖非文件 URL。关键不在于它是不是物理文件，而在于它是不是被系统明确声明为“产物”。

v1 建议新增：

- capability：`session_artifacts`
- artifact snapshot API：`GET /session/:id/artifacts`
- artifact changed event：`artifact_changed`
- tool result metadata：`ToolResult.artifacts?: ToolArtifact[]`
- bridge 内存索引：`SessionArtifactStore`
- SDK 方法：`DaemonClient.listSessionArtifacts()`、`DaemonSessionClient.artifacts()`
- 模型/skill/agent 可调用的轻量工具：`record_artifact`

建议 v1.1 或同批小增量新增：

- hook 输出 artifacts：`hookSpecificOutput.artifacts`
- client 手动注入 API：`POST /session/:id/artifacts`
- SDK 方法：`DaemonSessionClient.addArtifact()`

不建议 v1 做：

- workspace 扫描
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

- skill 根据表名、项目名、环境名拼出的 DataWorks 表详情 URL。
- agent 根据资源 ID 拼出的任务详情页、监控页、trace 页、数据库 lineage 页。
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
| 写入的 workspace 文件 | 是 | agent 明确生成/修改 |
| ArtifactTool 发布的 HTML URL | 是 | 工具明确发布 |
| skill 按规则拼出的业务详情 URL | 是，但需显式登记 | 用户需要右侧长期可点 |
| assistant 回答里的普通参考链接 | 否 | 噪音大、容易误报 |
| shell stdout 中出现的 URL | 否 | 语义不可靠 |
| web_fetch 请求过的 URL | 否 | 这是输入/来源，不是产物 |

### 2.2 Link Artifact 的产品语义

Link artifact 不是“网页内容”，而是“资源入口”。它应该在右侧产物区表现为可点击条目：

- 标题：`用户画像表详情`
- 副标题：`MaxCompute / prod`
- 类型：`link`
- URL host：`dataworks.example.com`
- 来源：`record_artifact` / hook / client

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
- 手动注入 route 若加入，应为 mutation route：`POST /session/:id/artifacts`

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
      "title": "用户画像表详情",
      "description": "MaxCompute 表 dim_user_profile 的 DataWorks 详情页",
      "url": "https://dataworks.example.com/table/dim_user_profile",
      "mimeType": "text/html",
      "status": "available",
      "source": "tool",
      "toolCallId": "call_abc",
      "toolName": "record_artifact",
      "createdAt": "2026-06-26T10:00:00.000Z",
      "updatedAt": "2026-06-26T10:00:00.000Z",
      "metadata": {
        "resourceType": "maxcompute_table",
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
      "title": "用户画像表详情",
      "url": "https://dataworks.example.com/table/dim_user_profile",
      "status": "available",
      "source": "tool",
      "toolName": "record_artifact",
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

v1 主要产生 `created` / `updated`。

### 4.4 Client Manual Insert

建议作为 v1.1 或同批独立小 PR：

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
  "artifact": {}
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

export type DaemonSessionArtifactSource =
  | 'tool'
  | 'hook'
  | 'client'
  | 'extension';

export interface DaemonSessionArtifact {
  id: string;
  kind: DaemonSessionArtifactKind;
  title: string;
  description?: string;
  status: DaemonSessionArtifactStatus;
  source: DaemonSessionArtifactSource;
  createdAt: string;
  updatedAt: string;
  path?: string;
  url?: string;
  mimeType?: string;
  sizeBytes?: number;
  toolCallId?: string;
  toolName?: string;
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

export interface ToolArtifact {
  kind?: ToolArtifactKind;
  title: string;
  description?: string;
  path?: string;
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

### 5.3 字段约束

- `path` 只对 workspace 内文件对外展示，且必须是 workspace-relative path。
- `url` 只接受明确登记的 URL。
- `path` 和 `url` 至少存在一个。
- `description` 是 UI 辅助文字，不进入模型上下文。
- `metadata` 必须是小对象，只允许 primitive value。
- `metadata` 不放 secret、token、cookie、签名私钥。
- `sizeBytes` 是 best-effort。

## 6. Artifact 采集来源

### 6.1 写入类工具

成功执行后派生 file artifact：

- `ToolNames.WRITE_FILE`
- `ToolNames.EDIT`
- `ToolNames.NOTEBOOK_EDIT`

不派生：

- `read_file`
- `grep_search`
- `glob`
- `list_directory`
- `web_fetch`
- `run_shell_command`

### 6.2 ArtifactTool

`ArtifactTool` 成功发布后返回：

```ts
artifacts: [
  {
    kind: 'html',
    title,
    path: file_path,
    url,
    mimeType: 'text/html',
  },
]
```

保留现有 `llmContent`、`returnDisplay`、`resultFilePaths`，保证兼容。

### 6.3 record_artifact 工具

新增轻量内置工具：

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
  path?: string;
  url?: string;
  mimeType?: string;
  metadata?: Record<string, string | number | boolean | null>;
}
```

示例：

```json
{
  "title": "dim_user_profile 表详情",
  "description": "DataWorks 生产环境表详情页",
  "kind": "link",
  "url": "https://dataworks.example.com/table/dim_user_profile?env=prod",
  "mimeType": "text/html",
  "metadata": {
    "resourceType": "maxcompute_table",
    "env": "prod"
  }
}
```

返回：

```ts
return {
  llmContent: 'Recorded artifact "dim_user_profile 表详情".',
  returnDisplay: 'Recorded artifact: dim_user_profile 表详情',
  artifacts: [params],
};
```

权限建议：

- 默认 `allow`，因为它只修改 session UI metadata。
- URL 不自动打开。
- Client 展示 host，用户点击前可辨识目标。
- 如果未来允许 `file://`，必须只允许 workspace 内文件；v1 不建议 `record_artifact` 接受 `file://` URL。

### 6.4 Hook 输出 artifacts

当前 hooks 已支持 command/HTTP/function/prompt，并且 command/HTTP hook 可以返回 JSON `HookOutput`。建议扩展 `hookSpecificOutput`：

```json
{
  "continue": true,
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "artifacts": [
      {
        "kind": "link",
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

- `HookOutput` 或专门 hook output 类型增加 `artifacts?: ToolArtifact[]`。
- `firePostToolUseHook()` 返回 `artifacts?: ToolArtifact[]`。
- `firePostToolBatchHook()` 返回 `artifacts?: ToolArtifact[]`。
- `Session.runTool()` 合并 hook artifacts 与 tool artifacts。
- batch-level artifacts 没有单一 tool call 时，可通过 ACP `extNotification` 发送：
  - `qwen/notify/session/artifact-event`

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

## 7. Store 与去重

artifact identity：

- workspace 文件：`sessionId + ':path:' + normalizedPath`
- URL：`sessionId + ':url:' + normalizedUrl`
- 客户端传入 `idempotencyKey` 时：`sessionId + ':key:' + idempotencyKey`

对外 id：

- 用 identity 的 sha256 前 12 位。

去重行为：

- 首次登记：`created`
- 同 identity 再登记：`updated`
- `createdAt` 保持不变。
- `updatedAt` 更新。
- `toolCallId/toolName/source` 更新为最近来源。

保留策略：

- 每 session 最多 200 个 artifacts。
- 返回 `createdAt` 升序。
- 超出时裁掉最旧项。
- 裁剪不发送 `removed`，因为它不代表真实资源删除。

## 8. 内部实现链路

### 8.1 core

改动：

- `packages/core/src/tools/tools.ts`
  - 增加 `ToolArtifact`。
  - 扩展 `ToolResult.artifacts?`。
- `packages/core/src/tools/tool-names.ts`
  - 增加 `RECORD_ARTIFACT: 'record_artifact'`。
- 新增 `packages/core/src/tools/record-artifact.ts`
  - 实现 `RecordArtifactTool`。
- `packages/core/src/tools/artifact/artifact-tool.ts`
  - 成功 publish 后填充 `artifacts`。
- `Config.createToolRegistry`
  - 注册 `RecordArtifactTool`。

### 8.2 cli ACP session

改动：

- `packages/cli/src/acp-integration/session/types.ts`
  - `ToolCallResultParams.artifacts?`
- `packages/cli/src/acp-integration/session/emitters/ToolCallEmitter.ts`
  - `_meta.artifacts = params.artifacts`
- `packages/cli/src/acp-integration/session/Session.ts`
  - 工具成功后收集 artifacts。
  - 合并来源：
    - `toolResult.artifacts`
    - 写入类工具派生 artifacts
    - PostToolUse hook artifacts
  - 传给 `emitResult()`。
  - PostToolBatch hook artifacts 通过 `qwen/notify/session/artifact-event` 发给 bridge。

### 8.3 acp-bridge

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
addSessionArtifact(
  sessionId: string,
  artifact: SessionArtifactInput,
  source: 'client' | 'extension',
): ArtifactChangedResult;
```

BridgeClient：

- 从 `session_update/tool_call_update._meta.artifacts` 提取 artifacts。
- 从 `qwen/notify/session/artifact-event` 提取 batch-level artifacts。
- upsert store。
- 发布 `artifact_changed`。

### 8.4 serve

改动：

- `packages/cli/src/serve/capabilities.ts`
  - 增加 `session_artifacts`。
- `packages/cli/src/serve/server.ts`
  - 增加 `GET /session/:id/artifacts`。
  - 可选增加 `POST /session/:id/artifacts`，走 `mutate({ strict: true })`。

GET 行为：

- session 不存在：现有 404。
- 无 artifacts：返回空数组。
- workspace path artifact 可 best-effort stat。
- URL artifact 不探测。

POST 行为：

- validate body。
- source 设置为 `client`。
- 调用 bridge upsert。
- 发布 `artifact_changed`。

### 8.5 SDK

改动：

- `packages/sdk-typescript/src/daemon/types.ts`
  - 增加 artifact 类型。
- `packages/sdk-typescript/src/daemon/events.ts`
  - known event 增加 `artifact_changed`。
- `packages/sdk-typescript/src/daemon/DaemonClient.ts`
  - `listSessionArtifacts(sessionId, opts?, clientId?)`
  - `addSessionArtifact(sessionId, artifact, clientId?)`
- `packages/sdk-typescript/src/daemon/DaemonSessionClient.ts`
  - `artifacts(opts?)`
  - `addArtifact(artifact)`
- `packages/sdk-typescript/src/index.ts`
  - 导出类型。

## 9. 安全边界

### 9.1 URL

- 只允许 `http:` / `https:`。
- `record_artifact` 不允许 `file://`。
- `ArtifactTool` 返回的 `file://` URL 保持例外，因为它来自已授权 publish。
- Daemon 不 fetch URL。
- Client 展示 host。
- URL 不自动打开。

### 9.2 Path

- 对外只返回 workspace-relative path。
- workspace 外 path 不作为 file artifact 暴露。
- `POST /session/:id/artifacts` 如果传 path，必须在 workspace 内。

### 9.3 Metadata

- 限制大小，例如 JSON stringify 后不超过 4KB。
- 只允许 primitive value。
- 不允许 nested object/array，避免 UI 和持久化复杂化。
- 不放 secret。

### 9.4 Anti-spam

- 每 session 最多 200 个 artifacts。
- `record_artifact` 可以每次 tool call 最多登记 10 个 artifacts。
- `POST /session/:id/artifacts` 走现有 rate limit / mutation gate。
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

skill 或 agent.md 可以写：

```md
当你根据工具结果构造出可供用户查看的业务资源 URL 时，调用 record_artifact 工具登记它。

登记规则：
- title 使用资源的人类可读名称。
- kind 使用 link。
- url 使用最终可点击 URL。
- metadata.resourceType 填资源类型，例如 maxcompute_table、scheduler_task。
- 不要把普通参考文档链接登记为 artifact。
```

模型执行后：

1. 调用业务工具拿到表名、任务 ID、节点 ID。
2. 按 skill 规则拼 URL。
3. 调用 `record_artifact`。
4. Daemon 右侧产物区出现该 link。

这个方案不要求 skill 编写 hook，也不要求 extension/plugin 代码，最适合多数业务规则。

## 12. Hook / Extension 使用方式

extension 可在 `qwen-extension.json` 或 `hooks/hooks.json` 中提供 PostToolUse hook：

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "mcp__dataworks__get_table",
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

脚本 stdout：

```json
{
  "continue": true,
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "artifacts": [
      {
        "kind": "link",
        "title": "dim_user_profile 表详情",
        "url": "https://dataworks.example.com/table/dim_user_profile",
        "mimeType": "text/html",
        "metadata": {
          "resourceType": "maxcompute_table"
        }
      }
    ]
  }
}
```

这适合企业插件：把“如何从工具结果拼业务 URL”的逻辑固化在 extension 中，而不是写进每个 prompt。

## 13. 测试计划

### 13.1 core

覆盖：

- `ToolResult.artifacts` 类型编译。
- `ArtifactTool` 成功返回 html artifact。
- `RecordArtifactTool` 校验 title/url/path。
- `RecordArtifactTool` 不允许空 path+url。
- `RecordArtifactTool` 不允许不支持的 URL scheme。
- `RecordArtifactTool` 返回 `artifacts`。

命令：

```bash
cd packages/core && npx vitest run src/tools/artifact/artifact-tool.test.ts
cd packages/core && npx vitest run src/tools/record-artifact.test.ts
```

### 13.2 cli session

覆盖：

- `ToolCallEmitter.emitResult()` 输出 `_meta.artifacts`。
- `write_file/edit/notebook_edit` 成功派生 file artifact。
- `read_file/grep/glob/shell` 不派生 artifact。
- `record_artifact` 产生 link artifact。
- PostToolUse hook artifacts 合并进 tool result update。
- 工具失败不产生 artifacts。

命令：

```bash
cd packages/cli && npx vitest run src/acp-integration/session/emitters/ToolCallEmitter.test.ts
cd packages/cli && npx vitest run src/acp-integration/session/Session.test.ts
```

### 13.3 acp-bridge

覆盖：

- `SessionArtifactStore` created/updated/remove。
- path/url/idempotencyKey 去重。
- 上限裁剪。
- `_meta.artifacts` 被写入 store。
- extNotification artifact-event 被写入 store。
- `artifact_changed` 发布。
- malformed artifact 被忽略，不影响原始 event。

命令：

```bash
cd packages/acp-bridge && npx vitest run src/sessionArtifacts.test.ts
cd packages/acp-bridge && npx vitest run src/bridgeClient.test.ts
```

### 13.4 serve

覆盖：

- `/capabilities` 包含 `session_artifacts`。
- `GET /session/:id/artifacts` 返回空列表。
- 有 artifacts 时返回 envelope。
- 未知 session 返回现有错误。
- `POST /session/:id/artifacts` 成功 upsert。
- `POST` 在未授权/无 mutation token 时被拒绝。

命令：

```bash
cd packages/cli && npx vitest run src/serve/server.test.ts
```

### 13.5 SDK

覆盖：

- `listSessionArtifacts()` route 正确。
- `addSessionArtifact()` body 正确。
- `artifact_changed` known event narrowing。
- public index 导出新增类型。

命令：

```bash
cd packages/sdk-typescript && npx vitest run src/daemon/DaemonClient.test.ts
cd packages/sdk-typescript && npx vitest run src/daemon/events.test.ts
```

### 13.6 手工验收

场景 A：文件产物

1. agent 写入 `lineage.html`。
2. `GET /session/:id/artifacts` 返回 html file artifact。
3. SSE 收到 `artifact_changed`。

场景 B：业务链接产物

1. skill 要求模型拼 DataWorks URL。
2. 模型调用 `record_artifact`。
3. 右侧产物区出现 link artifact。

场景 C：hook 产物

1. extension 注册 PostToolUse hook。
2. hook 根据 tool output 返回 artifacts。
3. 右侧产物区出现 hook source artifact。

场景 D：普通链接不进入产物区

1. assistant 回复 markdown link。
2. artifact list 不变化。

## 14. 验收标准

实现完成后至少满足：

- `session_artifacts` feature 存在。
- `GET /session/:id/artifacts` 可用。
- `artifact_changed` event 可用。
- 写文件生成 file/html/notebook artifact。
- `ArtifactTool` 生成 URL artifact。
- `record_artifact` 能登记 link artifact。
- 普通 assistant 文本 URL 不进入 artifact list。
- hook 能通过 `hookSpecificOutput.artifacts` 注入 artifact。
- client 可选通过 `POST /session/:id/artifacts` 注入 artifact。
- SDK 能 list/add artifacts。
- `npm run build && npm run typecheck` 通过。

## 15. 推荐落地顺序

1. `ToolArtifact` + `ToolResult.artifacts?`
2. `ArtifactTool` structured artifacts
3. `RecordArtifactTool`
4. `ToolCallEmitter._meta.artifacts`
5. `Session.runTool()` artifact collection
6. `SessionArtifactStore`
7. BridgeClient 消费 `_meta.artifacts`
8. `GET /session/:id/artifacts`
9. SDK list/event 类型
10. hook output artifacts
11. `POST /session/:id/artifacts`
12. SDK addArtifact
13. 协议文档与 tests

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

为了让用户、skill、agent、extension 都能方便插入非文件产物，推荐提供三层入口：

1. **模型/skill 入口**：`record_artifact` 工具。
2. **hook/extension 入口**：`hookSpecificOutput.artifacts`。
3. **client 入口**：`POST /session/:id/artifacts`。

这三层最终都进入同一个 `SessionArtifactStore`，通过同一个 `GET /session/:id/artifacts` 查询，通过同一个 `artifact_changed` SSE 事件更新 UI。这样能覆盖业务 link、文件、HTML、图片、视频等产物，同时保持协议简单、来源清晰、边界可控。
