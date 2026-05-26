# DaemonWorkspaceService 实施设计（方案 C）

> 关联：issue #4542, PR #4472, #3803, #4175
> 分支：`daemon_mode_b_main`
> 日期：2026-05-27
> 性质：实施设计文档（面向落地），非 RFC

---

## 1. 架构与边界

### 1.1 终态分层

```
                          CLIENTS
   webui    SDK/channels(via REST)    Zed/Goose(/acp)    future
     │             │                       │
═════╪═════════════╪═══════════════════════╪═════════════ L1 transport (薄)
   REST+SSE      REST+SSE              /acp (jsonrpc/sse)
   server.ts                           acpHttp/
     └─────────────┴───────────────────────┘
                          │ 业务/trust/audit 一律下沉 L2
═════════════════════════╪═══════════════════════════════ L2 应用层
   ┌──────────────────────────┐   ┌─────────────────────────────────┐
   │ AcpSessionBridge          │   │ DaemonWorkspaceService (facade)  │
   │ (← HttpAcpBridge 改名)    │   │  ┌──────────────────────────┐   │
   │ • channel/session 生命周期 │   │  │ FileService              │   │
   │ • prompt / cancel / close │   │  │ AuthService              │   │
   │ • EventBus / 权限仲裁      │   │  │ AgentsService            │   │
   │ • 依赖 child 的状态内省    │   │  │ MemoryService            │   │
   │   (mcp/skills/preflight)  │   │  └──────────────────────────┘   │
   └──────────┬───────────────┘   │  统一 WorkspaceRequestContext     │
              │                    └──────────┬──────────────────────┘
              │ L3 → child                    │
              ▼                               │ (纯本地，不碰 child)
══════════════════════════════════════════════════════════ L3 ACP-client
══════════════════════════════════════════════════════════ L4 agent
```

### 1.2 拆分判定函数

**唯一规则：操作的 scope 是 session 还是 workspace？**

- **session-scoped**（操作特定 sessionId：prompt/cancel/close/model/approval/metadata/heartbeat）**→ 留 `AcpSessionBridge`**
- **workspace-scoped**（操作工作区整体：file/auth/agents/memory/mcp-status/skills/env/preflight/tool-toggle/init）**→ 进 `DaemonWorkspaceService`**

workspace 方法中部分需要查询 child（status getters、restartMcpServer），通过 **injected callback** 委托 bridge 的 channel 完成，service 本身不持有 connection。

### 1.3 跨切依赖：callback 注入（非共享 infra）

当前 `publishWorkspaceEvent` 和 `knownClientIds` 由 bridge 持有（per-session bus fan-out / session-derived）。service 通过 **单向 callback 注入** 使用它们，不引入共享基础设施层。

**理由：**
1. EventBus 是 per-session bus（`bridge.ts:1457`），workspace-level bus 在代码注释中已挂在 PR 24（`bridge.ts:2611`）
2. `knownClientIds` 同样是派生自 session-attach state，注释明确 "PR 24 will replace it"（`bridge.ts:2658`）
3. 这两件是已立项独立工作，硬绑进本 PR 等于叠加额外 refactor
4. callback 注入对 service 是单向依赖（只持函数引用，不知道来自 bridge）；PR 24 落地后换注入源即可，service 接口不变

**硬规则：**
1. `DaemonWorkspaceServiceDeps` 中不得出现 `AcpSessionBridge` 类型引用——只用函数签名。
2. bridge 对外新暴露 `queryWorkspaceStatus` 和 `invokeWorkspaceCommand` 两个方法，供 service 通过 callback 调用。内部仍使用现有的 `requestWorkspaceStatus` / `liveChannelInfo` + timeout 逻辑，不新建抽象。

---

## 2. 构造时序与依赖注入

```ts
// runQwenServe.ts 中的构造顺序

// 1. fsFactory 先构造（两者共享）
const fsFactory = resolveBridgeFsFactory({ ... });

// 2. bridge 先构造（它是 session/channel/EventBus 的 owner）
const bridge = createAcpSessionBridge({
  eventRingSize,
  boundWorkspace,
  fileSystem: createBridgeFileSystemAdapter(fsFactory),
  // ... 其他现有参数不变
});

// 3. service 后构造，接收 bridge 的 callback 集
const workspace = createDaemonWorkspaceService({
  fsFactory,
  deviceFlowRegistry,
  subagentManager,
  boundWorkspace,
  contextFilename,
  // 跨切 callback — service 不知道它们来自 bridge
  publishWorkspaceEvent: (event) => bridge.publishWorkspaceEvent(event),
  knownClientIds: () => bridge.knownClientIds(),
  // child 委托 callback — workspace-scoped ext method 通过 bridge 的 channel 到达 agent
  queryWorkspaceStatus: (method, idle) => bridge.queryWorkspaceStatus(method, idle),
  invokeWorkspaceCommand: (method, params, opts) => bridge.invokeWorkspaceCommand(method, params, opts),
});

// 4. 两者传给 server routes + /acp handler
createServeApp({ bridge, workspace, ... });
```

**构造顺序 bridge → service 是硬依赖**（service 需要 bridge 实例上的方法作为 callback 源）。

---

## 3. DaemonWorkspaceService 内部结构

### 3.1 目录布局

```
packages/cli/src/serve/workspace-service/
├── types.ts            ← WorkspaceRequestContext + sub-service interfaces
├── index.ts            ← facade factory (createDaemonWorkspaceService)
├── fileService.ts      ← wraps fsFactory
├── authService.ts      ← wraps DeviceFlowRegistry
├── agentsService.ts    ← wraps SubagentManager
├── memoryService.ts    ← wraps memory file ops
└── __tests__/
    ├── fileService.test.ts
    ├── authService.test.ts
    ├── agentsService.test.ts
    ├── memoryService.test.ts
    └── e2e.test.ts
```

### 3.2 Facade 接口

```ts
export interface DaemonWorkspaceService {
  file: FileService;
  auth: AuthService;
  agents: AgentsService;
  memory: MemoryService;

  // 纯本地
  initWorkspace(opts: InitWorkspaceOpts, ctx: WorkspaceRequestContext): Promise<void>;
  setToolEnabled(toolName: string, enabled: boolean, ctx: WorkspaceRequestContext): Promise<ToolToggleResult>;

  // 通过 callback 委托 child
  getMcpStatus(): Promise<ServeWorkspaceMcpStatus>;
  getSkillsStatus(): Promise<ServeWorkspaceSkillsStatus>;
  getProvidersStatus(): Promise<ServeWorkspaceProvidersStatus>;
  getEnvStatus(): Promise<ServeWorkspaceEnvStatus>;
  getPreflightStatus(): Promise<ServeWorkspacePreflightStatus>;
  restartMcpServer(serverName: string, ctx: WorkspaceRequestContext, opts?: RestartOpts): Promise<RestartResult>;
}
```

> `listWorkspaceSessions` / `recordHeartbeat` / `getHeartbeatState` / `publishWorkspaceEvent` / `knownClientIds` 留在 bridge——它们访问 bridge 内部的 per-session state（`byId` map / session bus），是 session 衍生的基础设施。service 通过 callback 消费，不直接拥有。

### 3.3 Facade Factory 签名

```ts
export interface DaemonWorkspaceServiceDeps {
  fsFactory: WorkspaceFileSystemFactory;
  deviceFlowRegistry: DeviceFlowRegistry;
  subagentManager: SubagentManager;
  boundWorkspace: string;
  contextFilename: string;
  persistDisabledTools: (workspace: string, tool: string, enabled: boolean) => Promise<void>;

  // 跨切 callback（session 衍生基础设施）
  publishWorkspaceEvent: (event: WorkspaceEvent) => void;
  knownClientIds: () => Set<string>;

  // child 委托 callback（workspace-scoped ext method 通过 bridge channel 到达 agent）
  queryWorkspaceStatus: <T>(method: string, idle: () => T) => Promise<T>;
  invokeWorkspaceCommand: <T>(method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<T>;
}

export function createDaemonWorkspaceService(
  deps: DaemonWorkspaceServiceDeps
): DaemonWorkspaceService;
```

### 3.4 各子服务接口

| 子服务 | 方法 | 所需 deps | 现有来源 |
|---|---|---|---|
| FileService | `read`, `readBytes`, `write`, `edit`, `glob`, `list`, `stat` | `fsFactory`, `boundWorkspace` | `serve/routes/workspaceFileRead.ts`, `workspaceFileWrite.ts`, `serve/fs/` |
| AuthService | `startFlow`, `getFlowStatus(flowId)`, `cancelFlow(flowId)`, `getAuthStatus` | `deviceFlowRegistry` | `serve/auth/deviceFlow.ts`, `server.ts:794-966` |
| AgentsService | `list`, `get(agentType)`, `create`, `update`, `delete` | `subagentManager`, `publishWorkspaceEvent`, `knownClientIds` | `serve/workspaceAgents.ts` |
| MemoryService | `list`, `read`, `write`, `delete` | `fsFactory` or direct fs, `publishWorkspaceEvent`, `knownClientIds` | `serve/workspaceMemory.ts` |

每个方法第一个参数都是 `ctx: WorkspaceRequestContext`，trust gate 在方法入口统一执行。

---

## 4. WorkspaceRequestContext

```ts
export interface WorkspaceRequestContext {
  originatorClientId?: string; // X-Qwen-Client-Id header（只读操作可缺失）
  sessionId?: string;          // audit 关联（如从 session context 内发起的操作）
  route: string;               // audit trail（如 "POST /file/write"）
  workspaceCwd: string;        // trust boundary root
}
```

> `originatorClientId` 为 optional——当前 file read 等只读路由在 header 缺失时照常工作（`clientId ?? undefined` 传入 `fsFactory.forRequest`）。write 路由在 clientId **存在时**才校验合法性。

**构建位置**：L1 route handler / `/acp` method handler 从 request headers/params 提取后传入 L2。L2 只消费，不自行提取 HTTP context。

---

## 5. AcpSessionBridge 瘦身与改名

### 5.1 从 bridge 迁出的方法

| 方法 | 去向 | 机制 | 理由 |
|---|---|---|---|
| `initWorkspace` | `workspace.initWorkspace` | 直接迁（纯本地） | 附带修 FIXME（bridge 没接 fsFactory，跳过 trust gate / audit） |
| `setWorkspaceToolEnabled` | `workspace.setToolEnabled` | 直接迁（纯本地） | 纯 file I/O + event fan-out，注释明确 "no ACP roundtrip" |
| `getWorkspaceMcpStatus` | `workspace.getMcpStatus` | via `queryWorkspaceStatus` callback | workspace-scoped status query |
| `getWorkspaceSkillsStatus` | `workspace.getSkillsStatus` | via `queryWorkspaceStatus` callback | 同上 |
| `getWorkspaceProvidersStatus` | `workspace.getProvidersStatus` | via `queryWorkspaceStatus` callback | 同上 |
| `getWorkspaceEnvStatus` | `workspace.getEnvStatus` | via `queryWorkspaceStatus` callback | 同上 |
| `getWorkspacePreflightStatus` | `workspace.getPreflightStatus` | via `queryWorkspaceStatus` callback | 同上 |
| `restartMcpServer` | `workspace.restartMcpServer` | via `invokeWorkspaceCommand` callback | workspace-scoped mutation |

> `listWorkspaceSessions` / `recordHeartbeat` / `getHeartbeatState` / `updateSessionMetadata` 保留在 bridge——它们访问 bridge 内部 `byId` session map，是 session-scoped 操作。

### 5.2 留在 bridge 的

- 所有 session/channel 生命周期（spawn/load/resume/send/cancel/close/kill/detach）
- EventBus 持有 + `publishWorkspaceEvent` fan-out 实现（供 service callback 消费）
- `knownClientIds`（供 service callback 消费）
- `queryWorkspaceStatus` / `invokeWorkspaceCommand`（新暴露，封装 channel + timeout + error，供 service callback 委托）
- 权限仲裁 mediator
- session 配置变更（model/approvalMode/recap）
- session 状态（context/supportedCommands/metadata/heartbeat/listSessions）

### 5.3 改名

- `HttpAcpBridge` → `AcpSessionBridge`
- `createHttpAcpBridge` → `createAcpSessionBridge`
- 文件 `serve/httpAcpBridge.ts` → `serve/acpSessionBridge.ts`

无外部包消费者（验证过 `packages/cli/src/serve/` 和 `packages/acp-bridge/src/` 之外无引用），内部安全。

---

## 6. /acp northbound ext methods

### 6.1 命名空间

`qwen/workspace/...`（与现有 `qwen/control/...` 区分）：
- `qwen/control/...` = daemon→child 转发命令（southbound，经 AcpSessionBridge）
- `qwen/workspace/...` = daemon 本地工作区操作（northbound，终止于 DaemonWorkspaceService）

> 待 chiga0 确认。如改命名空间只需换方法名前缀，不影响架构。

### 6.2 方法列表

| method | 对应 REST | L2 调用 |
|---|---|---|
| `qwen/workspace/fs/read` | `GET /file?path=...` | `workspace.file.read(ctx, path)` |
| `qwen/workspace/fs/readBytes` | `GET /file/bytes?path=...` | `workspace.file.readBytes(ctx, path)` |
| `qwen/workspace/fs/write` | `POST /file/write` | `workspace.file.write(ctx, path, content)` |
| `qwen/workspace/fs/edit` | `POST /file/edit` | `workspace.file.edit(ctx, path, edits)` |
| `qwen/workspace/fs/glob` | `GET /glob?pattern=...` | `workspace.file.glob(ctx, pattern)` |
| `qwen/workspace/fs/list` | `GET /list?path=...` | `workspace.file.list(ctx, path)` |
| `qwen/workspace/fs/stat` | `GET /stat?path=...` | `workspace.file.stat(ctx, path)` |
| `qwen/workspace/auth/start` | `POST /workspace/auth/device-flow` | `workspace.auth.startFlow(ctx)` |
| `qwen/workspace/auth/status` | `GET /workspace/auth/status` | `workspace.auth.getAuthStatus(ctx)` |
| `qwen/workspace/auth/flow` | `GET /workspace/auth/device-flow/:id` | `workspace.auth.getFlowStatus(ctx, flowId)` |
| `qwen/workspace/auth/cancel` | `POST /workspace/auth/device-flow/:id` (cancel) | `workspace.auth.cancelFlow(ctx, flowId)` |
| `qwen/workspace/agents/list` | `GET /workspace/agents` | `workspace.agents.list(ctx)` |
| `qwen/workspace/agents/get` | `GET /workspace/agents/:agentType` | `workspace.agents.get(ctx, agentType)` |
| `qwen/workspace/agents/create` | `POST /workspace/agents` | `workspace.agents.create(ctx, spec)` |
| `qwen/workspace/agents/update` | `POST /workspace/agents/:agentType` | `workspace.agents.update(ctx, agentType, spec)` |
| `qwen/workspace/agents/delete` | `DELETE /workspace/agents/:agentType` | `workspace.agents.delete(ctx, agentType)` |
| `qwen/workspace/memory/list` | `GET /workspace/memory` | `workspace.memory.list(ctx)` |
| `qwen/workspace/memory/read` | `GET /workspace/memory/:key` | `workspace.memory.read(ctx, key)` |
| `qwen/workspace/memory/write` | `POST /workspace/memory` | `workspace.memory.write(ctx, key, content)` |
| `qwen/workspace/memory/delete` | `DELETE /workspace/memory/:key` | `workspace.memory.delete(ctx, key)` |
| `qwen/workspace/init` | `POST /workspace/init` | `workspace.initWorkspace(ctx, opts)` |
| `qwen/workspace/tool/toggle` | `POST /workspace/tool/toggle` | `workspace.setToolEnabled(ctx, toolName, enabled)` |
| `qwen/workspace/status/mcp` | `GET /workspace/mcp` | `workspace.getMcpStatus()` |
| `qwen/workspace/status/skills` | `GET /workspace/skills` | `workspace.getSkillsStatus()` |
| `qwen/workspace/status/providers` | `GET /workspace/providers` | `workspace.getProvidersStatus()` |
| `qwen/workspace/status/env` | `GET /workspace/env` | `workspace.getEnvStatus()` |
| `qwen/workspace/status/preflight` | `GET /workspace/preflight` | `workspace.getPreflightStatus()` |
| `qwen/workspace/mcp/restart` | `POST /workspace/mcp/restart` | `workspace.restartMcpServer(ctx, serverName, opts)` |

Capabilities advertise 时在 `_meta.qwen.methods` 中声明这些方法。

---

## 7. 文件变更清单

### 7.1 新增

| 文件 | 用途 |
|---|---|
| `serve/workspace-service/types.ts` | `WorkspaceRequestContext` + sub-service interfaces |
| `serve/workspace-service/index.ts` | facade factory |
| `serve/workspace-service/fileService.ts` | FileService 实现 |
| `serve/workspace-service/authService.ts` | AuthService 实现 |
| `serve/workspace-service/agentsService.ts` | AgentsService 实现 |
| `serve/workspace-service/memoryService.ts` | MemoryService 实现 |
| `serve/workspace-service/__tests__/fileService.test.ts` | unit test |
| `serve/workspace-service/__tests__/authService.test.ts` | unit test |
| `serve/workspace-service/__tests__/agentsService.test.ts` | unit test |
| `serve/workspace-service/__tests__/memoryService.test.ts` | unit test |
| `serve/workspace-service/__tests__/e2e.test.ts` | 端到端 REST ↔ /acp 等价验证 |

### 7.2 修改

| 文件 | 变更 |
|---|---|
| `acp-bridge/src/bridge.ts` | 移除 8 个 workspace 方法（initWorkspace / setWorkspaceToolEnabled / 5 status getters / restartMcpServer）；新暴露 `queryWorkspaceStatus` + `invokeWorkspaceCommand`；重命名工厂函数 |
| `acp-bridge/src/bridgeTypes.ts` | 接口改名 `HttpAcpBridge` → `AcpSessionBridge`；移除 8 个 workspace 方法签名；新增 `queryWorkspaceStatus` + `invokeWorkspaceCommand` 签名 |
| `acp-bridge/src/bridgeOptions.ts` | 更新 JSDoc 引用 |
| `acp-bridge/src/status.ts` | 更新错误消息中的类名 |
| `cli/src/serve/httpAcpBridge.ts` → 改名 `acpSessionBridge.ts` | re-export 更新 |
| `cli/src/serve/runQwenServe.ts` | 构造 `DaemonWorkspaceService`，注入 callback，传给 routes 和 /acp handler |
| `cli/src/serve/server.ts` | routes 从直连 `fsFactory`/`DeviceFlowRegistry` 改为调 `workspace.file.*` / `workspace.auth.*` |
| `cli/src/serve/workspaceAgents.ts` | 业务逻辑迁入 `agentsService.ts`；原文件变成 route handler 薄壳（构建 ctx → 调 service） |
| `cli/src/serve/workspaceMemory.ts` | 同上 |
| `cli/src/serve/routes/workspaceFileRead.ts` | 同上 |
| `cli/src/serve/routes/workspaceFileWrite.ts` | 同上 |
| `/acp` handler（`acp-integration/` 或 `serve/` 内） | 新增 northbound method dispatch |

---

## 8. SDK 兼容与错误格式

### 8.1 SDK backward compat

REST API surface（路径、HTTP 方法、请求/响应 JSON schema）保持不变。`sdk-typescript` 中的 `DaemonClient` / `DaemonSessionClient` 无需任何改动。

验证方式：现有 `packages/sdk-typescript/test/unit/DaemonClient.test.ts` 和 `DaemonSessionClient.test.ts` 在本 PR 中必须零修改通过。

### 8.2 /acp trust gate 拒绝的错误格式

两传输语义等价但编码不同：

| 场景 | REST | /acp (JSON-RPC) |
|---|---|---|
| 无效/缺失 bearer token | `401 { error, code: "unauthorized" }` | `{ error: { code: -32001, message: "unauthorized" } }` |
| 无效 clientId | `400 { error, code: "invalid_client_id" }` | `{ error: { code: -32602, message: "invalid_client_id", data: {...} } }` |
| trust gate 拒绝（路径逃逸等） | `403 { error, code: "forbidden" }` | `{ error: { code: -32003, message: "forbidden", data: {...} } }` |

> JSON-RPC error codes 遵循 [ACP error code registry](https://spec.acpprotocol.org)（标准范围 -32000 ~ -32099 为 server-defined application errors）。具体 code 值在实现时对齐 `/acp` 现有 error 映射逻辑（`acp-integration/errorCodes.ts`）。

---

## 9. 测试策略

| 层 | 测试类型 | 覆盖目标 |
|---|---|---|
| Sub-service unit | Jest，mock fsFactory / DeviceFlowRegistry / SubagentManager / callbacks | 业务逻辑正确性 + trust gate 拒绝非法 clientId |
| Route integration | 现有 route test 改为经 service（验证 HTTP surface 不变） | 回归保障，REST 路径不 break |
| E2e 等价验证 | 启动真实 serve + HTTP 请求 | REST 和 `/acp` 对同一操作返回等价结果；trust gate 两端一致拒绝 |

### E2e 验证矩阵

- File read/write：REST `GET /file` vs `/acp` `qwen/workspace/fs/read` → 同结果
- Agent CRUD：REST `POST /workspace/agents` vs `/acp` `qwen/workspace/agents/create` → 同行为
- Trust gate rejection：无效 clientId 两路径都 403
- Workspace init：验证 fsFactory 走通 + audit trail 产出

---

## 10. PR 形态

单 PR 原子提交，包含：
- DaemonWorkspaceService 全部新建文件
- REST route handler 改为调 service
- bridge 瘦身（迁出 8 个 workspace 方法）+ 新暴露 2 个 child 委托方法
- `HttpAcpBridge` → `AcpSessionBridge` 改名
- `/acp` northbound ext methods 新增（27 个）
- 全量测试（unit + integration + e2e）

---

## 11. 明确不做（scope boundary）

- workspace-scoped EventBus（PR 24 territory）
- workspace-scoped ClientRegistry（PR 24 territory）
- L2 ↔ L3 拆分（把 `ClientSideConnection` 从 bridge 拆出）
- REST 做成 `/acp` compat shim（长期方向）
- channels standalone 模式统一（独立部署形态问题）
- `listWorkspaceSessions` / `recordHeartbeat` / `getHeartbeatState` / `updateSessionMetadata` 迁移（session-scoped，保留原位）
- `publishWorkspaceEvent` / `knownClientIds` 的 ownership 转移（session 衍生基础设施，保留 bridge 持有，service 通过 callback 消费）

---

## 12. 待 chiga0 确认的决策点

1. `/acp` northbound 命名空间：`qwen/workspace/...` vs 其他（如复用 `qwen/control/...`）
2. 改名是否同 PR：倾向同 PR，但可按反馈拆出

> 以上两点如需调整，只影响命名和 commit 边界，不影响架构。
