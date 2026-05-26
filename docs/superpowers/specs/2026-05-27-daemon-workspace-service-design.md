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

**唯一规则：操作是否需要与 live ACP child 交互？**

- **是 → 留 `AcpSessionBridge`**
- **否 → 进 `DaemonWorkspaceService`**

### 1.3 跨切依赖：callback 注入（非共享 infra）

当前 `publishWorkspaceEvent` 和 `knownClientIds` 由 bridge 持有（per-session bus fan-out / session-derived）。service 通过 **单向 callback 注入** 使用它们，不引入共享基础设施层。

**理由：**
1. EventBus 是 per-session bus（`bridge.ts:1457`），workspace-level bus 在代码注释中已挂在 PR 24（`bridge.ts:2611`）
2. `knownClientIds` 同样是派生自 session-attach state，注释明确 "PR 24 will replace it"（`bridge.ts:2658`）
3. 这两件是已立项独立工作，硬绑进本 PR 等于叠加额外 refactor
4. callback 注入对 service 是单向依赖（只持函数引用，不知道来自 bridge）；PR 24 落地后换注入源即可，service 接口不变

**硬规则：** `DaemonWorkspaceServiceDeps` 中不得出现 `AcpSessionBridge` 类型引用。

---

## 2. 构造时序与依赖注入

```ts
// runQwenServe.ts 中的构造顺序

// 1. fsFactory 先构造（两者共享）
const fsFactory = resolveBridgeFsFactory({ ... });

// 2. bridge 先构造（它是 EventBus/clientIds 的 owner）
const bridge = createAcpSessionBridge({
  eventRingSize,
  boundWorkspace,
  fileSystem: createBridgeFileSystemAdapter(fsFactory),
  // ... 其他现有参数不变
});

// 3. service 后构造，接收 bridge 的两个 callback
const workspace = createDaemonWorkspaceService({
  fsFactory,
  deviceFlowRegistry,
  subagentManager,
  boundWorkspace,
  contextFilename,
  publishWorkspaceEvent: (event) => bridge.publishWorkspaceEvent(event),
  knownClientIds: () => bridge.knownClientIds(),
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
  initWorkspace(opts: InitWorkspaceOpts, ctx: WorkspaceRequestContext): Promise<void>;
  listSessions(): SessionSummary[];
  recordHeartbeat(clientId: string): void;
  getHeartbeatState(): HeartbeatState;
}
```

### 3.3 Facade Factory 签名

```ts
export interface DaemonWorkspaceServiceDeps {
  fsFactory: WorkspaceFileSystemFactory;
  deviceFlowRegistry: DeviceFlowRegistry;
  subagentManager: SubagentManager;
  boundWorkspace: string;
  contextFilename: string;
  // 跨切 callback — 函数类型，不引用 bridge 接口
  publishWorkspaceEvent: (event: WorkspaceEvent) => void;
  knownClientIds: () => Set<string>;
}

export function createDaemonWorkspaceService(
  deps: DaemonWorkspaceServiceDeps
): DaemonWorkspaceService;
```

### 3.4 各子服务接口

| 子服务 | 方法 | 所需 deps | 现有来源 |
|---|---|---|---|
| FileService | `read`, `write`, `edit`, `glob`, `list`, `stat` | `fsFactory`, `boundWorkspace` | `serve/routes/workspaceFileRead.ts`, `workspaceFileWrite.ts`, `serve/fs/` |
| AuthService | `startDeviceFlow`, `pollDeviceFlow`, `getAuthStatus` | `deviceFlowRegistry` | `serve/auth/deviceFlow.ts` |
| AgentsService | `list`, `create`, `update`, `delete` | `subagentManager`, `publishWorkspaceEvent`, `knownClientIds` | `serve/workspaceAgents.ts` |
| MemoryService | `list`, `read`, `write`, `delete` | `fsFactory` or direct fs, `publishWorkspaceEvent`, `knownClientIds` | `serve/workspaceMemory.ts` |

每个方法第一个参数都是 `ctx: WorkspaceRequestContext`，trust gate 在方法入口统一执行。

---

## 4. WorkspaceRequestContext

```ts
export interface WorkspaceRequestContext {
  originatorClientId: string;  // X-Qwen-Client-Id header
  route: string;               // audit trail（如 "POST /file/write"）
  workspaceCwd: string;        // trust boundary root
}
```

**构建位置**：L1 route handler / `/acp` method handler 从 request headers/params 提取后传入 L2。L2 只消费，不自行提取 HTTP context。

---

## 5. AcpSessionBridge 瘦身与改名

### 5.1 从 bridge 迁出的方法

| 方法 | 去向 | 理由 |
|---|---|---|
| `initWorkspace` | `workspace.initWorkspace` | 纯本地文件 I/O；附带修 FIXME（bridge 没接 fsFactory，跳过 trust gate / audit） |
| `listWorkspaceSessions` | `workspace.listSessions` | 只遍历 byId map，纯 daemon state |
| `recordHeartbeat` / `getHeartbeatState` | facade 顶层方法 | 纯 daemon 心跳状态 |

### 5.2 留在 bridge 的

- 所有 session/channel 生命周期（spawn/load/resume/send/cancel/close/kill/detach）
- EventBus 持有 + `publishWorkspaceEvent` fan-out 实现
- `knownClientIds`（派生自 sessions）
- 权限仲裁 mediator
- 依赖 child 的状态内省（mcp/skills/providers/env/preflight）
- session 配置变更（model/approvalMode/recap）
- `setWorkspaceToolEnabled` / `restartMcpServer`（需要 child 同步）

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
| `qwen/workspace/fs/write` | `POST /file/write` | `workspace.file.write(ctx, path, content)` |
| `qwen/workspace/fs/edit` | `POST /file/edit` | `workspace.file.edit(ctx, path, edits)` |
| `qwen/workspace/fs/glob` | `GET /glob?pattern=...` | `workspace.file.glob(ctx, pattern)` |
| `qwen/workspace/fs/list` | `GET /list?path=...` | `workspace.file.list(ctx, path)` |
| `qwen/workspace/fs/stat` | `GET /stat?path=...` | `workspace.file.stat(ctx, path)` |
| `qwen/workspace/auth/start` | `POST /workspace/auth/start` | `workspace.auth.startDeviceFlow(ctx)` |
| `qwen/workspace/auth/poll` | `POST /workspace/auth/poll` | `workspace.auth.pollDeviceFlow(ctx, code)` |
| `qwen/workspace/auth/status` | `GET /workspace/auth/status` | `workspace.auth.getAuthStatus(ctx)` |
| `qwen/workspace/agents/list` | `GET /workspace/agents` | `workspace.agents.list(ctx)` |
| `qwen/workspace/agents/create` | `POST /workspace/agents` | `workspace.agents.create(ctx, spec)` |
| `qwen/workspace/agents/update` | `PUT /workspace/agents/:id` | `workspace.agents.update(ctx, id, spec)` |
| `qwen/workspace/agents/delete` | `DELETE /workspace/agents/:id` | `workspace.agents.delete(ctx, id)` |
| `qwen/workspace/memory/list` | `GET /workspace/memory` | `workspace.memory.list(ctx)` |
| `qwen/workspace/memory/read` | `GET /workspace/memory/:key` | `workspace.memory.read(ctx, key)` |
| `qwen/workspace/memory/write` | `POST /workspace/memory` | `workspace.memory.write(ctx, key, content)` |
| `qwen/workspace/memory/delete` | `DELETE /workspace/memory/:key` | `workspace.memory.delete(ctx, key)` |
| `qwen/workspace/init` | `POST /workspace/init` | `workspace.initWorkspace(ctx, opts)` |

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
| `acp-bridge/src/bridge.ts` | 移除 `initWorkspace` / `listWorkspaceSessions` / heartbeat 方法；重命名工厂函数 |
| `acp-bridge/src/bridgeTypes.ts` | 接口改名 `HttpAcpBridge` → `AcpSessionBridge`；移除迁出方法签名 |
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

## 8. 测试策略

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

## 9. PR 形态

单 PR 原子提交，包含：
- DaemonWorkspaceService 全部新建文件
- REST route handler 改为调 service
- bridge 瘦身 + 方法迁出
- `HttpAcpBridge` → `AcpSessionBridge` 改名
- `/acp` northbound ext methods 新增
- 全量测试（unit + integration + e2e）

---

## 10. 明确不做（scope boundary）

- workspace-scoped EventBus（PR 24 territory）
- workspace-scoped ClientRegistry（PR 24 territory）
- L2 ↔ L3 拆分（把 `ClientSideConnection` 从 bridge 拆出）
- REST 做成 `/acp` compat shim（长期方向）
- channels standalone 模式统一（独立部署形态问题）

---

## 11. 待 chiga0 确认的决策点

1. `/acp` northbound 命名空间：`qwen/workspace/...` vs 其他（如复用 `qwen/control/...`）
2. 改名是否同 PR：倾向同 PR，但可按反馈拆出

> 以上两点如需调整，只影响命名和 commit 边界，不影响架构。
