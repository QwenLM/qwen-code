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
- client 显式移除 API：`DELETE /session/:id/artifacts/:artifactId`
- SDK 方法：`DaemonSessionClient.addArtifact()`
- SDK 方法：`DaemonSessionClient.removeArtifact()`
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

| 类型                            | 是否进入 artifacts | 原因                                     |
| ------------------------------- | -----------------: | ---------------------------------------- |
| 普通源码编辑                    |                 否 | 属于 file change / diff，不是可复用产物  |
| 明确登记的生成型 workspace 文件 |                 是 | report / HTML / PDF / image 等可复用输出 |
| ArtifactTool 发布的 HTML URL    |                 是 | 工具明确发布                             |
| skill 按规则拼出的业务详情 URL  | 是，但必须显式登记 | 用户需要右侧长期可点                     |
| assistant 回答里的普通参考链接  |                 否 | 噪音大、容易误报                         |
| shell stdout 中出现的 URL       |                 否 | 语义不可靠                               |
| web_fetch 请求过的 URL          |                 否 | 这是输入/来源，不是产物                  |

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
  "artifacts": [
    {
      "id": "a1b2c3d4e5f6",
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
    "change": {
      "action": "created",
      "artifactId": "a1b2c3d4e5f6",
      "artifact": {
        "id": "a1b2c3d4e5f6",
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
    }
  }
}
```

`change.action`：

- `created`
- `updated`
- `removed`

V1 主要产生 `created` / `updated`；eviction 或显式删除场景产生 `removed`。

`artifact_changed.data.change.artifact` 在 `created` / `updated` / `removed` 时携带完整 `DaemonSessionArtifact`，shape 与 `GET /session/:id/artifacts` 中的单项一致；`removed` event 携带被删除前的最后完整 artifact。`removed` 必须携带 `reason`，V1 取值为 `eviction` 或 `explicit`。这样实时 UI 可以直接应用 event，不需要每条 event 后再 GET。Client 断线、丢 event 或收到未知 event type 时，再用 `GET /session/:id/artifacts` 做 snapshot sync。

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
  "changes": [
    {
      "action": "created",
      "artifactId": "a1b2c3d4e5f6",
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
  ]
}
```

`changes` 中的每一项都必须同步发布为一条 `artifact_changed` SSE event。这样即使一次 POST 触发 upsert 和 eviction，client 也能收到 created/updated 以及 removed 的完整增量。同一次 mutation 内如果多个输入归一到同一个 identity，只能在 `changes` 中产生一条最终 change。事件发布顺序是协议约束：先按 `changes[]` 中的顺序发布 `created` / `updated`，再发布 `removed`，避免 client 的本地镜像短暂进入服务端从未存在过的状态。

错误响应：

```json
{
  "v": 1,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "url must use http or https",
    "field": "url"
  }
}
```

状态码：

- `400 VALIDATION_FAILED`：字段校验失败，例如多 primary locator、不支持 URL scheme、metadata 超限。
- `401 UNAUTHORIZED` / `403 FORBIDDEN`：mutation gate 或 bearer token 校验失败。
- `404 SESSION_NOT_FOUND`：session 不存在。

### 4.5 Client Delete

作为 V1 的显式移除入口：

```http
DELETE /session/:id/artifacts/:artifactId
```

语义：

- 只从当前 live session artifact store 移除该 artifact。
- 不删除 workspace 文件、managed 文件或远端 URL。
- 成功返回 `DaemonSessionArtifactMutationResult`，其中包含一条 `action: 'removed'`、`reason: 'explicit'` 的 change。
- 如果 artifact 已经不存在，DELETE 仍按 idempotent success 处理，返回 `200` 和空 `changes: []`，不发布 SSE event。
- 同步发布对应 `artifact_changed` SSE event。

错误响应复用 Section 4.4 envelope；session 不存在仍返回 `404 SESSION_NOT_FOUND`。

安全：

- 这是 mutation route，应使用现有 mutation gate。
- 有 bearer token 的 daemon 才允许远程 client 调用。
- 不读取 URL。
- 不自动打开 URL。

### 4.6 V1 发布口径与兼容性

V1 合并后应作为一项完整的 session artifact 管理能力发布试用，而不是只发布一个半成品接口。完整能力的最小闭环是：

- Client 通过 `session_artifacts` capability 探测功能。
- Daemon 提供 `GET /session/:id/artifacts` snapshot。
- Daemon 通过现有 events stream 发布 `artifact_changed` 增量。
- `ArtifactTool` / `ToolResult.artifacts`、`record_artifact`、hook artifacts、client POST 四类入口都进入同一个 store。
- client DELETE 可从 live store 显式移除误登记 artifact。
- store 统一执行 validation、normalization、identity 去重、soft reservation eviction。
- SDK 能 list/add/remove，并能识别 `artifact_changed` event。

建议以 experimental/capability-gated 形式先发布试用。这里的 experimental 表示实现和 UI 可以继续打磨，不表示协议可以随意破坏：已经暴露给 client 的字段和事件语义必须按下列兼容性规则演进。

非 breaking 的后续扩展：

- 在 response artifact 上增加 optional field。
- 增加新的 `kind` / `status` / `source` / `storage` 字面量，但 typed SDK 必须把这些字段声明成 open union，client 必须容忍未知值：未知 `kind` 按 `other`，未知 `status` 显示为 unknown 状态且不阻断列表展示，未知 `source` 按未分组来源，未知 `storage` 仅按可用 `url` / `workspacePath` 做保守展示。
- 增加新的 route，例如 `GET /session/:id/artifacts/:artifactId`、preview route、pin route。
- 增加新的 event type，但现有 `artifact_changed` 语义不变。
- 增加新的 capability，例如 `session_artifacts_preview`、`session_artifacts_persistence`。
- 调整 soft reservation 的内部默认值，只要总上限和 eviction event 语义不破坏现有 client。

需要新 capability 或新版本的 breaking 变更：

- 修改 identity 规则导致同一个 URL/path 的 artifact id 改变。
- 把现有 optional field 改成 required field。
- 删除或改名现有字段。
- 改变 `artifact_changed.data.change.action` 的 `created` / `updated` / `removed` 语义。
- 改变 `GET /session/:id/artifacts` 的 envelope shape。
- 让普通 assistant 文本链接或普通文件编辑默认进入 artifact list。

## 5. 数据模型

### 5.1 Public SDK 类型

```ts
type OpenStringUnion<T extends string> = T | (string & {});

export type DaemonSessionArtifactKind = OpenStringUnion<
  | 'file'
  | 'link'
  | 'image'
  | 'video'
  | 'audio'
  | 'html'
  | 'pdf'
  | 'notebook'
  | 'other'
>;

export type DaemonSessionArtifactStatus = OpenStringUnion<
  'available' | 'missing'
>;

export type DaemonSessionArtifactSource = OpenStringUnion<
  'tool' | 'hook' | 'client'
>;

export type DaemonSessionArtifactStorage = OpenStringUnion<
  'workspace' | 'managed' | 'external_url' | 'published'
>;

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
  metadata?: Record<string, string | number | boolean | null>;
}

export interface DaemonSessionArtifactsEnvelope {
  v: 1;
  sessionId: string;
  artifacts: DaemonSessionArtifact[];
}

export interface DaemonArtifactChangedData {
  sessionId: string;
  change: DaemonSessionArtifactChange;
}

export interface DaemonSessionArtifactChange {
  action: 'created' | 'updated' | 'removed';
  artifactId: string;
  artifact?: DaemonSessionArtifact;
  reason?: 'eviction' | 'explicit';
}

export interface DaemonSessionArtifactMutationResult {
  v: 1;
  sessionId: string;
  changes: DaemonSessionArtifactChange[];
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

`ToolArtifactKind` / `ToolArtifactStorage` 的已知字面量集合必须只有一个实现来源，避免 core、acp-bridge、SDK 三处手工漂移。推荐做法：

- 在 core 中定义 `TOOL_ARTIFACT_KINDS` / `TOOL_ARTIFACT_STORAGES` const tuple，并导出 `ToolArtifactKind` / `ToolArtifactStorage`。
- acp-bridge 复用 core 类型作为输入校验的已知集合，并把 daemon public 类型声明为同一组值的协议投影。
- SDK 不手写第二份已知 union；通过 acp-bridge 导出的协议类型或构建期生成的 `.d.ts` re-export 已知字面量，再在 response-facing 类型上包一层 open union，以便容忍未来 daemon 返回的新值。
- 测试加一条 kind/storage round-trip，保证已知字面量在 core 输入、bridge store、SDK 输出中一致往返；另加 SDK unknown value fallback 测试，保证 open union 的运行时容错。

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

`ToolArtifact` 是工具返回的输入形态，`SessionArtifactInput` 是所有入口进入 store 前的统一内部输入形态，`DaemonSessionArtifact` 是对外返回形态。所有入口都必须先转换为 `SessionArtifactInput`，再由 `SessionArtifactStore` 补全公共字段。

```ts
export interface SessionArtifactInput extends ToolArtifact {
  source: 'tool' | 'hook' | 'client';
  toolCallId?: string;
  toolName?: string;
  hookName?: string;
  extensionId?: string;
  clientId?: string;
  trustedPublisher?: true;
  receivedSeq?: number;
}
```

`trustedPublisher` 是 bridge 内部私有标志，不是 public schema 或外部 payload 字段。它只能由 ArtifactTool executor / daemon publisher 的 in-process adapter 在构造 `SessionArtifactInput` 时写入，用来证明该输入确实来自本进程的发布路径。

来源转换规则：

- `ArtifactTool` / daemon publisher：executor 通过私有 in-process adapter 复制 `ToolArtifact` 字段，补 `source: 'tool'`、`toolCallId`、`toolName`、`trustedPublisher: true`。
- 其它 `ToolResult.artifacts`：复制 `ToolArtifact` 字段，补 `source: 'tool'`、`toolCallId`、`toolName`，但不设置 `trustedPublisher`。
- `record_artifact`：作为 tool source 进入，同样补 `source: 'tool'`、`toolCallId`、`toolName: 'record_artifact'`，但不允许 `storage: 'published'`，也不能设置 `trustedPublisher`。
- hook：复制 hook output artifacts，补 `source: 'hook'`、`hookName`、`extensionId`；如 hook 能拿到触发 tool context，也可补 `toolCallId` / `toolName`。Bridge 必须从 transport context 派生 `source: 'hook'`，不能信任 payload 里的 `source` 字段。
- client POST：复制 body，补 `source: 'client'`、`clientId`，不允许 `storage: 'published'`，也不能设置 `trustedPublisher`。
- `receivedSeq`：由 bridge/store 在接收输入时分配单调递增值，用于同一批内 deterministic ordering；外部输入不能指定该字段。
- BridgeClient 不得根据 `toolName`、payload `source`、`storage`、`managedId`、`url` 或 `_meta.artifacts` 中的任意字段推断 `trustedPublisher`。如果某条 ACP `_meta.artifacts` 路径无法携带不可伪造的 in-process 标记，V1 必须把它当普通 tool artifact 处理，不能执行 `storage: 'published'` managed upgrade。

补全规则：

- `id`：由 Section 7 的 identity hash 生成。
- `source`：由入口上下文决定，tool result / ArtifactTool 为 `tool`，hook 为 `hook`，client POST 为 `client`。
- `toolCallId` / `toolName`：由 tool call 上下文补入；hook/client 入口没有则不填。
- `hookName` / `extensionId` / `clientId`：有上下文时补入，用于审计和 UI 分组。
- `createdAt`：首次 upsert 时写入。
- `updatedAt`：每次 upsert 时刷新。
- `status`：workspace artifact upsert 时做 best-effort stat，存在且 containment check 通过则为 `available`，不存在或 symlink escape 则为 `missing`；managed / URL artifact 在 V1 不做本机 stat，始终为 `available`。
- `storage` 默认值：
  - 有 `workspacePath` 时为 `workspace`。
  - 有 `storage: 'published'` 时必须来自 `trustedPublisher`，否则校验失败。
  - 有 `managedId` 且没有 `url` 时为 `managed`。
  - 有 `url` 时为 `external_url`。
  - `ArtifactTool` 发布结果显式使用 `published`。
- `kind` 默认值：
  - `storage: 'published'` 且没有显式 `kind` 时为 `html`。
  - 有 `url` 且没有 `workspacePath` 时为 `link`。
  - 有 `workspacePath` 时按扩展名推断：`.html` -> `html`，图片扩展名 -> `image`，视频扩展名 -> `video`，音频扩展名 -> `audio`，`.pdf` -> `pdf`，`.ipynb` -> `notebook`，否则 `file`。
  - 无法推断时为 `other`。

### 5.4 字段约束

- `workspacePath` 只对 workspace 内文件对外展示，且必须是 workspace-relative path。
- `managedId` 是 daemon/qwen-home 托管产物引用，不能是本机绝对路径。
- `url` 只接受明确登记的 URL 或 ArtifactTool 发布 URL。
- `workspacePath`、`managedId`、`url` 必须且只能存在一个 primary locator；V1 拒绝普通输入同时携带多个 primary locator，避免同一逻辑资源按不同字段生成多个 identity。
- 唯一例外是可信 `storage: 'published'`：`url` 是 primary locator，`managedId` 可作为可选 managed reference 一起返回，用于未来下载/预览；此时 identity 只按 `url` 计算，`managedId` 不参与 identity。该例外只接受 `trustedPublisher: true` 的内部输入。
- 普通工具不得把 `~/.qwen`、`/tmp` 或其他本机绝对路径作为 `workspacePath` 返回。
- `title` 必填，trim 后长度 1-200 字符，不允许 ASCII 控制字符；它是 plain text，不承载 HTML 或 markdown 语义。
- `description` 是 UI 辅助 plain text，不进入模型上下文。
- `description` trim 后最多 1000 字符，不允许 ASCII 控制字符，不承载 HTML 或 markdown 语义。
- `metadata` 必须是小对象，只允许 primitive value。
- `metadata` 不放 secret、token、cookie、签名私钥。
- `sizeBytes` 是 best-effort。
- `DaemonSessionArtifactsEnvelope` 不返回宿主机绝对 `workspaceCwd`；client 只依赖 `workspacePath` 这类相对路径和 `storage` 字段展示。

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
];
```

保留现有 `llmContent`、`returnDisplay`、`resultFilePaths`，保证兼容。

`ArtifactTool` 当前 local publisher 可能把内容写入 qwen home 下的托管目录，并返回 `file://` 或远端 URL。Daemon artifact API 不应把 qwen home 本机绝对路径作为 `workspacePath` 暴露；应使用：

- `storage: 'published'`
- `url`: 已发布的可打开 URL，也是 published artifact 的 primary locator
- `managedId`: 可选的内部托管引用，不参与 identity
- ArtifactTool executor / daemon publisher 的私有 in-process adapter 在构造 `SessionArtifactInput` 时设置内部 `trustedPublisher: true`。Bridge 不得从模型参数、`toolName`、hook payload、client POST body 或普通 `_meta.artifacts` 字段推断该标志。

如果未来要让 daemon client 下载或预览托管内容，应新增专门的 managed artifact route，而不是把本机绝对路径塞进 public artifact。

### 6.3 record_artifact 工具

作为 V1 的模型/skill 显式登记入口，新增轻量内置工具：

```ts
ToolNames.RECORD_ARTIFACT = 'record_artifact';
```

用途：

- 模型显式登记非文件类产物。
- skill / agent.md 可以要求模型在拼出业务 URL 后调用该工具。
- 每次调用只登记一个 artifact；批量登记由模型多次调用工具完成，避免单次 tool call 出现部分成功/失败的反馈歧义。
- 不做网络请求。
- 不写 workspace 文件。
- 只写 session artifact index。

参数：

```ts
interface RecordArtifactParams {
  title: string;
  description?: string;
  kind?: ToolArtifactKind;
  storage?: Exclude<ToolArtifactStorage, 'published'>;
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
  llmContent: {
    recorded: true,
    title: params.title,
    location: params.workspacePath ?? params.managedId ?? params.url,
    note: 'The daemon will expose the assigned artifact id through artifact_changed and list APIs.',
  },
  returnDisplay: 'Recorded artifact: 用户画像资源详情',
  artifacts: [params],
};
```

`record_artifact` 在返回前做参数级 validation；失败时返回工具错误，不产生 `ToolResult.artifacts`。因为单次调用只有一个 artifact，V1 不需要定义批量 partial success。server-assigned `id` 由 daemon store 生成，并通过 `artifact_changed` / `GET /session/:id/artifacts` 暴露给 client。

`record_artifact` 不接受 `storage: 'published'`，也不接受 `url + managedId` 的 published 例外。模型/skill 只能登记 workspace、managed 或 external URL artifact；发布型 artifact 必须来自 ArtifactTool / daemon publisher。

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
- extension 提供 hooks，把企业内部资源 URL 注入右侧产物区。
- skill frontmatter 注册 PostToolUse hook，在 skill 生效期间自动登记 artifacts。
- 工具失败后，PostToolUse hook 登记 error trace、失败运行 dashboard 或排障链接。
- PostToolBatch artifacts 只有在具体运行时存在真实 PostToolBatch 调用点并能把结果送到 daemon bridge 时才接入；daemon ACP 主会话 V1 不假设该通道存在。

需要代码改动：

- `HookOutput.hookSpecificOutput.artifacts?: ToolArtifact[]`。
- `packages/core/src/hooks/hookAggregator.ts` 的 `mergeWithOrLogic()` 必须为 `artifacts` 增加 concat 逻辑，不走现有 `hookSpecificOutput` last-writer-wins。
- `packages/core/src/core/toolHookTriggers.ts` 的 `PostToolUseHookResult` / `PostToolBatchHookResult` 增加 `artifacts?: ToolArtifact[]`。
- `firePostToolUseHook()` 返回 `artifacts?: ToolArtifact[]`。
- `firePostToolBatchHook()` 返回 `artifacts?: ToolArtifact[]`。
- `packages/core/src/core/coreToolScheduler.ts` 必须纳入实现计划，因为它是 `firePostToolBatchHook()` 的调用点，也有独立的 `firePostToolUseHook()` 路径。
- 抽取共享 `collectHookArtifacts()` 或等价 helper，供 `coreToolScheduler.ts` 与 ACP `Session.ts` 两条 PostToolUse 路径复用同一 extraction / validation 前置逻辑，避免两处行为漂移。
- `Session.runTool()` 收集 tool result artifacts 与 hook artifacts，但二者使用不同传输：tool result artifacts 只来自成功返回的 tool result；hook artifacts 不依赖工具成功，失败路径也可以进入 store。
- ACP `Session.runTool()` 中，成功工具结果携带的 artifacts 继续附着到 `tool_call_update._meta.artifacts`；PostToolUse / PostToolUseFailure hook 返回的 artifacts 统一通过 `client.extNotification('qwen/notify/session/artifact-event', payload)` 单独发送。该 notification 必须在 hook artifacts 收集完成后同步 await；发送失败只记录 warning，不改变原工具失败/成功结果；这批 hook artifacts 不进入 daemon store，V1 不做持久重试。
- hook artifacts 与 `record_artifact` / client POST 走同一套 validation：URL scheme、workspace path containment、metadata size/type。
- batch-level artifacts 没有单一 tool call 时，只有在该运行时已经能向 bridge 发送 ACP `extNotification` 的情况下，才可使用 `qwen/notify/session/artifact-event`。

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

Transport 约定：

- `qwen/notify/session/artifact-event` 是 ACP `extNotification`，不是 SSE event，也不是 client-facing HTTP route。
- wire format 复用现有 `qwen/notify/session/*` 通知约定；例如 bridge 已有的 session notification demux 模式。
- 发送方只能是已经处在 ACP session 通道内、且有能力发送 `extNotification` 的运行时或 extension bridge。ACP `Session.ts` 可以发送该通知；`coreToolScheduler.ts` 本身不能直接向 daemon 主会话发送该通知。
- `BridgeClient` 在现有 `extNotification` 处理分支按 notification name demux：命中 `qwen/notify/session/artifact-event` 后读取 payload，转换为 `SessionArtifactInput[]`，再进入统一 ingest pipeline。
- Bridge 必须从 notification transport context 派生 `source: 'hook'`，payload 中的 `source` 只能作为兼容性提示；如果 payload source 与 transport context 不一致，bridge 覆盖为 `hook` 并记录 debug/warning。Notification payload 不能设置 `trustedPublisher`；如果携带 `storage: 'published'`，按普通 untrusted input 校验失败处理。

注意：`qwen/notify/session/artifact-event` 只是 explicit artifacts 的传输 envelope，不应形成第二套 store/validation/dedupe 管道。BridgeClient 必须把 `_meta.artifacts`、hook artifacts 与 `artifact-event.artifacts` 都转换为同一个 `SessionArtifactInput[]`，调用同一个 `ingestArtifacts()` / `SessionArtifactStore.upsertMany()`，复用同一套 validation、normalization、enrichment、eviction 和 `artifact_changed` 发布逻辑。ACP 主会话当前没有 PostToolBatch callsite，不能把 `coreToolScheduler.ts` 的 batch hook 当成 daemon artifacts 面板的默认来源；若后续要支持 daemon 主会话 batch artifacts，必须先增加真实调用点和测试。非 ACP 运行时如果没有 artifact notification sink，不能声明 daemon hook artifacts 支持。

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
- managed 文件：`sessionId + ':managed:' + normalizedManagedId`
- external / published URL：`sessionId + ':url:' + identityUrl`

identity 只描述资源位置，不包含 `source`。tool、hook、client 对同一 URL 或路径的登记合并成一条 artifact，避免右侧面板重复展示同一资源。V1 不维护 `provenance[]`、信任级别或 retention class；首次成功登记者拥有该 artifact 的展示字段和来源审计字段，后续同 identity 登记只表达“同一个资源再次被观察到”。

输入必须且只能携带一个定位字段：

- `workspacePath`
- `managedId`
- `url`

如果输入同时携带多个 primary locator，V1 直接拒绝，而不是尝试按优先级猜测 identity。这样可以避免一个 artifact 先按 `workspacePath` 去重、后续又按 `url` 去重而产生重复。

`storage: 'published'` 是唯一例外：它必须携带 `url` 作为 primary locator，可以额外携带 `managedId` 作为 managed reference。published identity 仍按 `url` 计算；`managedId` 只用于未来下载/预览，不参与去重。该例外只接受带内部 `trustedPublisher: true` 的输入；hook、client POST、`record_artifact` 或普通工具返回 `storage: 'published'` 时按校验失败处理。

对外 id：

- 用 identity 的 sha256 前 12 位。

### 7.1 Normalization

`normalizedWorkspacePath`：

- 输入必须是 workspace-relative path；如果入口传入绝对路径，先尝试转换为 workspace-relative path，失败则拒绝。
- 使用 `path.resolve(workspaceCwd, input)` 得到绝对路径。
- 校验 resolved path 必须位于 workspace 内：`path.relative(workspaceCwd, resolved)` 不能以 `..` 开头，且不能是绝对路径。
- 如果目标已存在，使用 `fs.realpath` 检查 symlink 最终目标仍在 workspace 内；symlink 指向 workspace 外则拒绝。
- 如果目标不存在，registration 可以保留该 artifact，但初始 `status` 必须是 `missing`；不能因为 `realpath` 失败就跳过 symlink containment。后续 GET TTL refresh 时必须重新执行同一 containment + realpath 检查。
- 如果 refresh 时发现路径已变成指向 workspace 外的 symlink，artifact 保留但 `status` 变为 `missing`，并清除 best-effort `sizeBytes`；V1 绝不把该路径报告为 `available`。
- 输出统一使用 POSIX slash，去掉开头的 `./`。
- 不做大小写折叠；即使 macOS 默认文件系统大小写不敏感，identity 仍按字符串区分，避免跨平台行为不一致。

`normalizedManagedId`：

- 输入先 trim ASCII whitespace。
- trim 后不能为空，长度不超过 200 字符。
- 拒绝 ASCII 控制字符。
- 拒绝 `/`、`\`、`..`，不允许表达路径层级或本机绝对路径语义。
- 不做大小写折叠，identity 按字符串区分。
- public `managedId` 返回 normalized 后的值。

`identityUrl` 与 `url`：

- 使用 WHATWG `new URL(input)` 解析，禁止字符串 `startsWith('http')` 这类宽松判断。
- 除 `ArtifactTool` trusted published URL 外，普通 link artifact 只允许 `http:` / `https:`。
- `url` 字段保存清理后的可点击 URL，供 client 打开；不要把 identity 用 URL 反写成可点击 URL。
- identity 另用内部 `identityUrl` 计算，不作为 public 字段返回。
- scheme 和 host 小写。
- 默认端口归一化：`https:443` / `http:80` 不保留。
- 保留 fragment；hash-routed SPA 中 fragment 可能是资源 identity 的一部分。
- 保留 query 参数原始顺序；有些平台对 query 顺序敏感，V1 不做 query sort。
- 拒绝或清除 `username` / `password`，不把 URL userinfo 存入 artifact store。

去重行为：

- 首次登记：`created`
- 同 identity 再登记：`updated`
- `createdAt` 保持不变。
- `updatedAt` 更新，但不参与 eviction 排序。
- 同一次 `upsertMany()` 内先按 identity 合并输入；同 identity 的 owner 由 `receivedSeq` 最小的输入决定，若没有 `receivedSeq` 则使用输入数组顺序。BridgeClient 不应把不同 transport event 的 artifacts 无序合并；如果必须合并，必须先分配 `receivedSeq` 再排序。每个最终 identity 只在 `changes[]` 里产生一条 change。若该 identity 在本批之前不存在则为 `created`，否则为 `updated`。
- 展示字段 `title`、`description`、`source`、`toolCallId`、`toolName`、`hookName`、`extensionId`、`clientId` 采用 first-writer-wins，不被后续同 identity 输入覆盖。
- 资源本体字段允许安全升级：同 URL identity 从 `external_url` 升级到 `published` 时，可以更新 `storage`、补充 `managedId`、更新 `kind` / `mimeType` / `sizeBytes`，并允许 publisher 覆盖 `title` / `description`，避免占位 link 标题永久遮蔽真实发布物。该升级只接受带内部 `trustedPublisher: true` 的 `storage: 'published'` 输入。
- `managedId` 从空补齐为 published managed reference 是允许的；已有 `managedId` 不被后续普通输入覆盖。
- `status` 和 `sizeBytes` 是 daemon 的 best-effort 派生字段，可以随 workspace stat 或 published artifact enrichment 刷新。
- `metadata` 保存首次登记时通过校验的小对象；后续同 identity 只有 `source: 'tool'` 或 `source: 'client'` 的输入可以做受控富化：只添加不存在的 key，不覆盖已有 key，合并后重新校验 primitive-only 与 4KB 总大小。hook 对已存在 artifact 的 metadata 富化默认忽略。若合并后超限，只丢弃本次 metadata 富化并记录 warning，artifact 的其它安全升级仍可继续。
- client POST 同 identity 不覆盖展示字段，也不改变 `retentionSource`；它只把内部 `clientRetained` 置为 `true`，用于表达用户手动保留意图。
- 实现应在单个 `SessionArtifactStore.upsertMany()` 内同步处理，避免异步读改写竞态。

内部 store 字段：

- `retentionSource`：首次成功登记者的 `source`，创建时赋值，之后不随 client POST 或重复 upsert 改变。
- `clientRetained`：布尔值，初始为 `source === 'client'`；任意通过 mutation gate 的 client POST 命中同 identity 时置为 `true`。`clientRetained` 不改变展示字段，也不迁移 `retentionSource` bucket。
- `insertSeq`：store 内单调递增序号，创建 artifact 时赋值一次，永不刷新。
- `receivedSeq`：输入接收顺序，只用于同批 deterministic coalescing，不作为 public 字段返回。

配额与保留策略：

- 每 session 最多 200 个 artifacts。
- V1 使用 soft source reservation，reservation 按内部 `retentionSource` 归属：
  - `tool`: 100
  - `client`: 50
  - `hook`: 50
- reservation 是最低保留额度，不是硬上限；未使用额度可以被其它来源借用，直到全局 200 上限。
- 新建 artifact 导致总量超过 200 时，按以下顺序选择 eviction candidate。本批 `upsertMany()` 新创建的 artifact 默认不进入候选池；eviction 先只在本批开始前已经存在的 artifacts 中选择候选。这样一个本批新登记的 missing artifact 可能在满 store 中挤掉仍然 live 的旧 artifact，这是 V1 为保证当前显式产物可见性作出的选择。
  1. 优先裁剪 `status: 'missing'` 且 `clientRetained === false` 的 artifact。
  2. 其次从 `retentionSource` 数量超过 reservation 的来源中裁剪 `clientRetained === false` 的 artifact。
  3. 再裁剪 `clientRetained === false` 的最旧 artifact。
  4. 如果所有 artifact 都是 `clientRetained === true`，裁剪最旧的 client-retained artifact。
- eviction 使用 cached `missing` 优先级前，必须对即将作为候选的 workspace artifacts 做 best-effort status refresh / containment check；如果刷新后为 `available`，不能继续把它当 missing 优先裁剪。刷新失败时保留原 cached 状态。
- `clientRetained` 是最后裁剪偏好，不是无限 pin，也不突破 200 全局上限或 soft reservation。所有 artifact 都是 client-retained 时，仍按最旧 client-retained artifact 裁剪。
- 如果裁完旧 artifact 后，本批新创建 artifact 自身仍超过剩余容量，store 必须在生成 `changes[]` 前按 `receivedSeq` / 输入顺序保留前 N 个新 identity，丢弃超出的本批输入并记录 warning/diagnostics。被丢弃的新输入不进入 store，不产生 `created` 或 `removed` change，因此同一次 mutation 内同一 identity 不会出现 `created` 后又 `removed`。
- “最旧”排序使用 `(createdAt, insertSeq)`，`insertSeq` 是 store 内部单调递增序号，用来稳定同毫秒或同批输入的 tiebreaker。
- 同 identity 重复登记会刷新 `updatedAt`，但 eviction 不看 `updatedAt`；因此其它来源不能通过高频重复登记把一个旧 artifact 固定在保留集合里。
- 返回 `createdAt` 升序。
- 裁剪必须为每个被移除 artifact 发送 `artifact_changed` / `removed`。V1 不提供其它裁剪事件。
- reservation 数值、`retentionSource`、`clientRetained` 与 `insertSeq` 是 V1 实现细节，不是 wire protocol 字段；后续可在不改变 API shape 的前提下调整默认值，或增加更细的 per-producer quota。

### 7.2 V1 生命周期限制

V1 的 store 是 live bridge session 内存索引：

- bridge/session 重启后 artifacts 不恢复。
- Client SSE 断线重连后应重新 `GET /session/:id/artifacts` 做 snapshot sync。
- V1 不要求额外 `artifacts_reset` event；如果后续支持 session 继续存在但 artifact store 被清空的运行模式，再增加 `artifacts_reset` 或等价 snapshot-invalidated event。
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
  - 工具成功后收集 `toolResult.artifacts`。
  - PostToolUse hook artifacts 独立于工具成功/失败收集，用于 error trace / dashboard 等失败诊断产物。
  - 失败路径 hook artifacts 不能依赖成功 result metadata；必要时直接调用 bridge artifact ingest。
  - 不从普通 `WRITE_FILE` / `EDIT` / `NOTEBOOK_EDIT` 自动派生 artifacts。
  - 传给 `emitResult()`。

### 8.3 Phase C-1: acp-bridge store and events

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
addSessionArtifacts(
  sessionId: string,
  artifacts: SessionArtifactInput[],
): DaemonSessionArtifactMutationResult;
removeSessionArtifact(
  sessionId: string,
  artifactId: string,
): DaemonSessionArtifactMutationResult;
```

BridgeClient：

- 从 `session_update/tool_call_update._meta.artifacts` 提取 artifacts。
- 从 `qwen/notify/session/artifact-event` 提取 explicit notification artifacts。
- 所有输入都转换为同一个 `SessionArtifactInput[]`。
- 基于 transport context 分配 `source`、`receivedSeq`。`trustedPublisher` 只能由 ArtifactTool executor / daemon publisher 的私有 in-process adapter 分配；BridgeClient 不得根据 `toolName`、payload 字段或普通 `_meta.artifacts` 内容推断。
- 统一调用 `ingestArtifacts()` / `SessionArtifactStore.upsertMany()`，不要为 notification artifacts 建第二套 validation 或 dedupe。
- `upsertMany()` 返回 `DaemonSessionArtifactMutationResult`，包含 created/updated 以及 eviction 产生的 removed changes。
- 对每个 change 发布 `artifact_changed`，先发布 created/updated，再发布 removed。
- `removeSessionArtifact()` 从 store 删除 artifact，返回 `reason: 'explicit'` 的 removed change，并发布 `artifact_changed`。

### 8.4 Phase C-2: serve snapshot API

改动：

- `packages/cli/src/serve/capabilities.ts`
  - 增加 `session_artifacts`。
- `packages/cli/src/serve/server.ts`
  - 增加 `GET /session/:id/artifacts`。
  - 增加 `DELETE /session/:id/artifacts/:artifactId`。

GET 行为：

- session 不存在：现有 404。
- 无 artifacts：返回空数组。
- workspace artifact 维护内部 status cache，例如 `lastStatAt`、`lastKnownSizeBytes`、`lastKnownStatus`。
- upsert 时做一次 best-effort stat。
- GET 默认使用 cache；仅当 `lastStatAt` 过期时按 TTL 刷新，例如 5-30 秒，并限制并发 stat 数量。刷新时必须重新执行 Section 7.1 的 workspace containment 与 realpath symlink check。
- stat 失败：GET 返回 `status: 'missing'`，不删除 artifact。
- stat 成功且 containment / realpath check 仍通过：如果此前 cache 是 `missing`，GET 返回 `status: 'available'`。
- 如果 refresh 发现 symlink escape 或 workspace containment 失败，GET 返回 `status: 'missing'`，不返回新的 `sizeBytes`。
- GET 可以静默刷新 status cache，但不得因为读请求发布 `artifact_changed`；V1 status 对 SSE 客户端是最终一致的。
- 如果后续需要实时 status 事件，应由后台 refresh 或显式 refresh mutation 发布 `artifact_changed` / `updated`，不要放在 GET 热读路径。
- managed / URL artifact 不探测本机路径，始终返回 `status: 'available'`。

### 8.5 Phase C-3: SDK list/event support

改动：

- `packages/sdk-typescript/src/daemon/types.ts`
  - 增加 artifact 类型。
- `packages/sdk-typescript/src/daemon/events.ts`
  - known event 增加 `artifact_changed`。
- `packages/sdk-typescript/src/daemon/DaemonClient.ts`
  - `listSessionArtifacts(sessionId, opts?, clientId?)`
  - `addSessionArtifact(sessionId, artifact, clientId?)`
  - `removeSessionArtifact(sessionId, artifactId, clientId?)`
- `packages/sdk-typescript/src/daemon/DaemonSessionClient.ts`
  - `artifacts(opts?)`
  - `addArtifact(artifact)`
  - `removeArtifact(artifactId)`
- `packages/sdk-typescript/src/index.ts`
  - 导出类型。

SDK singular add 映射到 bridge plural mutation：`addSessionArtifact(a)` 包装为 `addSessionArtifacts(sessionId, [a])`，返回完整 `DaemonSessionArtifactMutationResult`，不丢弃 eviction 产生的 removed changes。

### 8.6 Phase D: record_artifact explicit registration

改动：

- `packages/core/src/tools/tool-names.ts`
  - 增加 `RECORD_ARTIFACT: 'record_artifact'`。
- 新增 `packages/core/src/tools/record-artifact.ts`
  - 实现 `RecordArtifactTool`。
  - 参数使用 `workspacePath` / `managedId` / `url`，不接受任意本机绝对路径。
  - 不接受 `storage: 'published'` 或 `url + managedId` published 例外。
  - 输出 `ToolResult.artifacts`，复用 V1 store/event/list 链路。
- `Config.createToolRegistry`
  - feature-gated 或 skill/extension opt-in 注册，避免给所有 session 增加模型可见 tool。

### 8.7 Phase E: hook artifacts explicit registration

改动：

- `packages/core/src/hooks/types.ts`
  - `HookOutput.hookSpecificOutput.artifacts?: ToolArtifact[]`。
- `packages/core/src/hooks/hookAggregator.ts`
  - `mergeWithOrLogic()` 对 `artifacts` 多 hook concat，不走 last-writer-wins。
- `packages/core/src/core/toolHookTriggers.ts`
  - `PostToolUseHookResult` / `PostToolBatchHookResult` 增加 `artifacts?: ToolArtifact[]`。
- `packages/core/src/core/coreToolScheduler.ts`
  - 覆盖 core scheduler 的 PostToolUse / PostToolBatch artifacts 传播路径。
- `packages/cli/src/acp-integration/session/Session.ts`
  - 覆盖 ACP session 的 PostToolUse artifacts 传播路径。
- 两条 PostToolUse 路径复用同一个 hook artifact collection helper。
- ACP session V1 不声明 PostToolBatch artifacts 支持；如果产品要求 daemon 主会话 batch artifacts，必须在 ACP Session 增加真实 PostToolBatch callsite，而不是依赖 `coreToolScheduler.ts` 的非 daemon 主会话路径。
- 其他运行时如已有 batch-level artifact notification，可通过 `qwen/notify/session/artifact-event` 发给 bridge。
- BridgeClient 从 `qwen/notify/session/artifact-event` 提取 batch-level artifacts，走同一套 validation 和 upsert。

### 8.8 Phase F: client POST / SDK add explicit registration

改动：

- `packages/cli/src/serve/server.ts`
  - 增加 `POST /session/:id/artifacts`，走 `mutate({ strict: true })`。
  - 增加 `DELETE /session/:id/artifacts/:artifactId`，走 `mutate({ strict: true })`。
  - validate body。
  - source 设置为 `client`。
  - 转换为单元素 `SessionArtifactInput[]`，调用 bridge 的 `addSessionArtifacts()`。
  - POST 不接受 `storage: 'published'` 或 `trustedPublisher`。
  - DELETE 调用 bridge 的 `removeSessionArtifact()`；artifact 已不存在时返回空 `changes[]`，不发布 SSE。
  - 发布 `artifact_changed`，先发布 created/updated，再发布 removed。
- artifact add 不新增单数 bridge mutation；所有新增入口都走 `addSessionArtifacts()` / `upsertMany()`，避免 validation、coalescing、eviction 行为漂移。artifact remove 使用单独的 `removeSessionArtifact()`，因为它按 server-assigned artifact id 删除，不参与 input validation / identity coalescing。

- SDK 增加：
  - `DaemonClient.addSessionArtifact(sessionId, artifact, clientId?)`
  - `DaemonSessionClient.addArtifact(artifact)`
  - `DaemonClient.removeSessionArtifact(sessionId, artifactId, clientId?)`
  - `DaemonSessionClient.removeArtifact(artifactId)`

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
- Client 不得因为 `kind: 'image' | 'video' | 'audio' | 'html'` 就自动把 external URL 填入 `<img>`、`<video>`、`<audio>`、`iframe` 或类似会发起网络请求的预览元素。V1 对 external URL 只展示图标、标题、host 和点击入口；远程预览必须等用户显式点击，或后续通过单独 preview capability 与 sandbox 策略启用。
- Client 应对 loopback、RFC 1918、link-local、metadata service 等私网地址做 warning 或 block；Daemon V1 不解析 DNS，不承担 SSRF 防护的最终判断。

### 9.2 Path

- 对外只返回 `workspacePath`，它必须是 workspace-relative path。
- workspace 外 path 不作为 file artifact 暴露。
- `record_artifact` / hook / client POST 如果传 `workspacePath`，必须在 workspace 内。
- 校验算法见 Section 7.1：`path.resolve` + `path.relative` containment check，目标存在时再做 `fs.realpath` symlink escape check；目标不存在时 artifact 可以进入 store，但必须标记为 `missing`，后续 GET/status refresh 继续重跑同一校验。
- 拒绝 `..` escape、绝对路径 escape、symlink 指向 workspace 外、`~/.qwen`、`/tmp` 等本机外部路径。
- `managedId` 只能引用 daemon-managed storage；trim 后不能为空，拒绝路径分隔符、`..`、控制字符和本机绝对路径语义。

### 9.3 Metadata

- 限制大小，例如 JSON stringify 后不超过 4KB。
- 只允许 primitive value。
- 不允许 nested object/array，避免 UI 和持久化复杂化。
- 不放 secret、token、cookie、signed URL、私钥、访问凭证。
- metadata string value 如果被 UI 展示，必须作为 untrusted plain text 渲染或 escape；metadata 不是 HTML/markdown 扩展点。
- V1 不提供 `visibility`、`sensitivity`、`expiresAt`、`sourceId` 等无消费者字段；artifact visibility 固定为当前 session-local 语义。
- audit 维度通过首次登记者的 `source` / `toolCallId` / `toolName` / `hookName` / `extensionId` / `clientId`、`createdAt`、`updatedAt` 承载。
- 同 identity 后续登记默认不覆盖首次登记者的展示字段；唯一例外是 Section 7 定义的 trusted `external_url -> published` upgrade，此时 publisher 可以覆盖 `title` / `description`。metadata 只允许 Section 7 定义的受控富化，避免跨来源 metadata 注入。

### 9.4 Text Fields

- `title` / `description` 是 plain text，不是 HTML，也不是 markdown。
- Daemon validation 必须做长度、trim、ASCII 控制字符拒绝；不要把子串黑名单当作 XSS 安全边界。
- 所有可能进入 UI 的文本字段，包括 `title`、`description`、`metadata` string value、`toolName`、`hookName`、`extensionId`、`clientId`，client 都必须作为 untrusted text 渲染或 HTML escape，禁止通过 `innerHTML` 直接插入。

### 9.5 Anti-spam

- 每 session 最多 200 个 artifacts。
- soft reservation 默认 `tool: 100`、`client: 50`、`hook: 50`，未使用额度可被其它来源借用。
- `record_artifact` 每次 tool call 只登记 1 个 artifact。
- `POST /session/:id/artifacts` 走现有 rate limit / mutation gate。
- eviction 必须逐条发送 `artifact_changed` / `removed` event。
- Client 可按 source/toolName 分组或折叠。

### 9.6 Validation Diagnostics

- `record_artifact` 参数校验失败时返回工具错误，不产生 artifact。
- `POST /session/:id/artifacts` body 校验失败时返回 400。
- `_meta.artifacts`、hook artifacts 或 `artifact-event` 中的单条 malformed artifact 不应破坏原始 tool/session event；bridge 应跳过该 artifact，并记录 warning-level log。
- warning log 至少包含 sessionId、source、toolName / hookName / extensionId / clientId、失败字段和原因；不要记录 secret-like metadata value。
- debug log 可以记录经过脱敏和长度截断的 rejected artifact payload。
- 如果现有 telemetry/metrics 基础设施可用，增加 validation rejection counter，按 source 和 reason 打标签；如果暂时没有 metrics，日志是 V1 的最低要求。

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
- ArtifactTool executor / daemon publisher 的私有 in-process adapter 会设置内部 `trustedPublisher: true`；`record_artifact`、其它 tool result、hook payload、client POST 不会设置，BridgeClient 也不能通过 `toolName` 或 payload 字段推断。
- `write_file/edit/notebook_edit` 普通源码修改不自动派生 artifact。
- `read_file/grep/glob/shell` 不派生 artifact。
- 工具失败时不收集失败 tool result 的 artifacts；PostToolUse hook 显式返回的诊断 artifacts 仍可进入 store。
- 失败路径 hook artifacts 不依赖成功 result `_meta.artifacts`。

命令：

```bash
cd packages/cli && npx vitest run src/acp-integration/session/emitters/ToolCallEmitter.test.ts
cd packages/cli && npx vitest run src/acp-integration/session/Session.test.ts
```

### 13.3 Phase C-1 acp-bridge

覆盖：

- `SessionArtifactStore` created/updated/removed。
- `ToolArtifact` 到 `DaemonSessionArtifact` 的 enrichment。
- `SessionArtifactInput` 是所有入口统一的内部输入类型。
- 默认 `kind` / `storage` 推断，覆盖 published->html、html/image/video/audio/pdf/notebook/file。
- workspacePath / managedId / URL identity 去重，且 identity 不包含 source，跨 source 登记同一资源会合并为一条 artifact。
- 同时携带多个 primary locator 的普通 artifact 被拒绝；只有 `trustedPublisher: true` 且 `storage: 'published'` 允许 `url + managedId`，identity 只按 `url`。
- hook、client POST、`record_artifact` 或普通 tool result 伪造 `storage: 'published'` 会被拒绝或跳过并记录 warning。
- managedId normalization：trim、空值拒绝、路径分隔符拒绝、`..` 拒绝、控制字符拒绝、大小写不折叠。
- URL validation：scheme/host lowercase、default port 归一、fragment 保留、query 顺序保留、userinfo rejection/removal。
- `url` 保存清理后的可点击 URL，identity 用内部 `identityUrl`，两者不混用。
- Path validation：`../../etc/passwd`、workspace 外绝对路径、symlink escape 均被拒绝；不存在路径进入 store 时为 `missing`，GET TTL refresh 重新做 containment / realpath check。
- Title/description validation：长度限制、trim、控制字符拒绝、plain text、明显 HTML/script payload 拒绝。
- Metadata validation：大小限制、primitive-only、nested object/array 拒绝。
- 同 identity upsert 对展示字段和来源字段采用 first-writer-wins。
- 同 URL identity 支持可信 `external_url -> published` 资源本体升级，补齐 `managedId` / `kind` / `mimeType`，并允许 publisher 覆盖占位 `title` / `description`。
- tool/client 后续 metadata 只能添加缺失 key，不能覆盖已有 key，合并后重新满足 4KB 和 primitive-only 约束。
- hook 后续 metadata 富化默认忽略。
- 同一批内重复 identity 按 `receivedSeq` / 输入数组顺序确定 owner，并在 `changes[]` 中只产生一条最终 change。
- `retentionSource` 创建时赋值且不刷新；`clientRetained` 与 `retentionSource` 分离；`insertSeq` 创建时赋值且不刷新。
- soft reservation eviction：未用额度可借用，missing 优先裁剪，client-retained 最后裁剪，`createdAt + insertSeq` 稳定排序，且逐条发送 `reason: 'eviction'` 的 removed event。
- eviction 使用 missing 优先级前会刷新候选 workspace artifact 状态，避免 stale missing cache 优先裁剪已恢复文件。
- eviction 不会优先裁剪本批刚创建的 missing artifact；如果本批自身超过剩余容量，超出的本批新输入在产生 changes 前被丢弃并记录 diagnostics，不产生同 identity 的 `created` + `removed`。
- `clientRetained` 不突破全局 200 上限；全量 client-retained 时仍裁剪最旧项。
- malformed artifact 会产生 warning log / diagnostics，不影响原始 event。
- `_meta.artifacts` 被写入 store。
- `artifact_changed` 发布。
- `upsertMany()` / `addSessionArtifacts()` 返回包含 eviction changes 的 `DaemonSessionArtifactMutationResult`。
- `removeSessionArtifact()` 返回 `reason: 'explicit'` 的 removed change。

命令：

```bash
cd packages/acp-bridge && npx vitest run src/sessionArtifacts.test.ts
cd packages/acp-bridge && npx vitest run src/bridgeClient.test.ts
```

### 13.4 Phase C-2 serve

覆盖：

- `/capabilities` 包含 `session_artifacts`。
- `GET /session/:id/artifacts` 返回空列表。
- 有 artifacts 时返回 envelope。
- envelope 不返回宿主机绝对 `workspaceCwd`。
- 未知 session 返回现有错误。
- workspace artifact GET TTL refresh 时 best-effort stat，缺失文件返回 `status: 'missing'`，文件恢复后返回 `status: 'available'`。
- GET TTL refresh 会重新做 workspace containment / symlink realpath check；symlink escape 返回 `missing`。
- GET status refresh 不发布 `artifact_changed`；managed / URL artifact 不做本机 stat。
- GET 使用 status cache / TTL，避免每次热读对所有 artifacts 做同步 stat。

命令：

```bash
cd packages/cli && npx vitest run src/serve/server.test.ts
```

### 13.5 Phase C-3 SDK

覆盖：

- `listSessionArtifacts()` route 正确。
- `artifact_changed` known event narrowing，event artifact 是完整 `DaemonSessionArtifact`。
- public index 导出新增类型。
- public response enum 类型是 open union，client 对未知 kind/status/source/storage 有 fallback。
- SDK singular add 包装 bridge plural add 并返回完整 mutation result；SDK remove 调用 DELETE route。

命令：

```bash
cd packages/sdk-typescript && npx vitest run src/daemon/DaemonClient.test.ts
cd packages/sdk-typescript && npx vitest run src/daemon/events.test.ts
```

### 13.6 Phase D/E/F explicit registration tests

`record_artifact`：

- 校验 title / workspacePath / managedId / url。
- 不允许空 `workspacePath + managedId + url`，也不允许普通输入同时传多个 primary locator。
- 不允许 `storage: 'published'`。
- 不允许不支持的 URL scheme。
- URL userinfo 被拒绝或清除。
- 返回 `ToolResult.artifacts`。
- `llmContent` 返回结构化登记结果；每次 tool call 只登记一个 artifact。

hook artifacts：

- `HookOutput.hookSpecificOutput.artifacts` 通过 `createHookOutput()`、`toolHookTriggers.ts` 进入 `PostToolUseHookResult` / `PostToolBatchHookResult`。
- `hookAggregator.ts` 的 `mergeWithOrLogic()` 多 hook artifacts concat。
- `coreToolScheduler.ts` 和 ACP `Session.ts` 两条路径都能传播 PostToolUse artifacts。
- 两条 PostToolUse 路径复用共享 hook artifact collection helper。
- ACP main session 不声明 PostToolBatch artifacts；如后续增加真实 callsite，需要单测覆盖。
- PostToolUse / PostToolUseFailure hook artifacts 通过 `qwen/notify/session/artifact-event` extNotification 单独进入 bridge，不依赖成功 tool result `_meta.artifacts`。
- 已有 batch notification 的运行时可通过 `qwen/notify/session/artifact-event` 被写入 store。
- hook artifacts 与其他入口经过同一 validation。
- hook payload `source` 由 bridge 按 transport context 派生，不能伪造 tool source 或 trusted publisher。
- 工具失败时 hook 返回的 error/dashboard artifact 仍能进入 store。

client POST / SDK add：

- `POST /session/:id/artifacts` 成功 upsert。
- `POST` 返回 `DaemonSessionArtifactMutationResult`，包含 created/updated 以及 eviction removed changes。
- `POST` 触发 upsert + eviction 时，验证每个 `changes[]` 项都同步发布为 `artifact_changed` SSE event，且 created/updated 先于 removed。
- `POST` 在未授权/无 mutation token 时被拒绝。
- `POST` 对 workspace 外 path、path traversal、symlink escape 返回 400。
- `POST` 对 `storage: 'published'`、多 primary locator、metadata 超限返回结构化错误 envelope。
- `POST` 通过 bridge `addSessionArtifacts()` 单一路径写入。
- `DaemonClient.addSessionArtifact()` body 正确。
- `DELETE /session/:id/artifacts/:artifactId` 命中时返回 `reason: 'explicit'` 的 removed change，并发布对应 SSE event，不删除底层文件或 URL。
- `DELETE /session/:id/artifacts/:artifactId` 未命中时幂等返回空 `changes[]`，不发布 SSE event。

### 13.7 跨包集成测试

覆盖完整链路：

1. tool 返回 `ToolResult.artifacts`。
2. `ToolCallEmitter` 写入 `_meta.artifacts`。
3. `BridgeClient` 从 event 中提取 artifacts。
4. `SessionArtifactStore` validate / normalize / upsert。
5. SSE 发送 `artifact_changed`。
6. `GET /session/:id/artifacts` 返回同一个 artifact。
7. Client 断线重连后重新拉 snapshot 能恢复当前内存状态。
8. 填充 artifacts 到接近上限后新增 artifact，断言 SSE 同时包含 created 与 `reason: 'eviction'` 的 removed event，随后 GET 只返回裁剪后的状态。

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
- client 可通过 `DELETE /session/:id/artifacts/:artifactId` 显式移除误登记 artifact。
- 普通 `WRITE_FILE` / `EDIT` / `NOTEBOOK_EDIT` 不自动进入 artifact list。
- 普通 assistant 文本 URL 不进入 artifact list。
- SDK 能 list/add/remove artifacts，能识别 `artifact_changed`。
- SDK remove 对已不存在 artifact 的 idempotent empty result 映射正确。
- workspacePath / URL / metadata 安全边界有单测。
- managedId normalization 有单测。
- 同 identity first-writer-wins、published upgrade、metadata controlled enrichment、soft reservation eviction 有单测。
- eviction 会逐条通知 client 移除。
- validation failure 有 warning log / diagnostics。
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
