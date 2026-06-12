# DaemonWorkspaceService Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract all workspace-scoped capabilities from HttpAcpBridge into a new DaemonWorkspaceService, enabling /acp transport parity and honest rename to AcpSessionBridge.

**Architecture:** Scope-based split — workspace-scoped ops go to a new facade (DaemonWorkspaceService) with 4 internal sub-services; session-scoped ops stay in bridge. Child-dependent workspace ops delegate via injected callbacks. Both REST and /acp call the same L2 service.

**Tech Stack:** TypeScript, Vitest, Express (REST routes), JSON-RPC (ACP), supertest (integration)

**Spec:** `docs/superpowers/specs/2026-05-27-daemon-workspace-service-design.md`

---

## File Map

### New Files
| File | Responsibility |
|---|---|
| `packages/cli/src/serve/workspace-service/types.ts` | WorkspaceRequestContext, sub-service interfaces, deps interface, result types |
| `packages/cli/src/serve/workspace-service/index.ts` | Facade factory `createDaemonWorkspaceService` |
| `packages/cli/src/serve/workspace-service/fileService.ts` | FileService — wraps fsFactory |
| `packages/cli/src/serve/workspace-service/authService.ts` | AuthService — wraps DeviceFlowRegistry |
| `packages/cli/src/serve/workspace-service/agentsService.ts` | AgentsService — wraps SubagentManager |
| `packages/cli/src/serve/workspace-service/memoryService.ts` | MemoryService — wraps memory file ops |
| `packages/cli/src/serve/workspace-service/__tests__/fileService.test.ts` | FileService unit tests |
| `packages/cli/src/serve/workspace-service/__tests__/authService.test.ts` | AuthService unit tests |
| `packages/cli/src/serve/workspace-service/__tests__/agentsService.test.ts` | AgentsService unit tests |
| `packages/cli/src/serve/workspace-service/__tests__/memoryService.test.ts` | MemoryService unit tests |
| `packages/cli/src/serve/workspace-service/__tests__/facade.test.ts` | Facade + workspace-scoped methods (status/tool/init/restart) unit tests |
| `packages/cli/src/serve/workspace-service/__tests__/e2e.test.ts` | REST ↔ /acp equivalence e2e tests |

### Modified Files
| File | Change |
|---|---|
| `packages/acp-bridge/src/bridgeTypes.ts` | Rename interface + remove 8 methods + add 2 new methods |
| `packages/acp-bridge/src/bridge.ts` | Remove 8 workspace methods, expose `queryWorkspaceStatus` + `invokeWorkspaceCommand`, rename factory |
| `packages/acp-bridge/src/bridgeOptions.ts` | Update JSDoc references |
| `packages/acp-bridge/src/status.ts` | Update error message class name |
| `packages/cli/src/serve/httpAcpBridge.ts` → rename to `acpSessionBridge.ts` | Update re-exports |
| `packages/cli/src/serve/runQwenServe.ts` | Construct workspace service, inject callbacks |
| `packages/cli/src/serve/server.ts` | Rewire workspace routes to call service |
| `packages/cli/src/serve/workspaceAgents.ts` | Extract business logic → agentsService, keep as route shell |
| `packages/cli/src/serve/workspaceMemory.ts` | Extract business logic → memoryService, keep as route shell |
| `packages/cli/src/serve/routes/workspaceFileRead.ts` | Rewire to call FileService |
| `packages/cli/src/serve/routes/workspaceFileWrite.ts` | Rewire to call FileService |

---

## Task 1: Types & Interfaces

**Files:**
- Create: `packages/cli/src/serve/workspace-service/types.ts`

- [ ] **Step 1: Create types file with all interfaces**

```ts
// packages/cli/src/serve/workspace-service/types.ts
import type { WorkspaceFileSystemFactory } from '../fs/index.js';
import type { DeviceFlowRegistry } from '../auth/deviceFlow.js';
import type {
  ServeWorkspaceMcpStatus,
  ServeWorkspaceSkillsStatus,
  ServeWorkspaceProvidersStatus,
  ServeWorkspaceEnvStatus,
  ServeWorkspacePreflightStatus,
} from '@qwen-code/acp-bridge';

// --- Request Context ---

export interface WorkspaceRequestContext {
  originatorClientId?: string;
  sessionId?: string;
  route: string;
  workspaceCwd: string;
}

// --- Sub-service interfaces ---

export interface FileService {
  read(ctx: WorkspaceRequestContext, path: string, opts?: { maxBytes?: number }): Promise<FileReadResult>;
  readBytes(ctx: WorkspaceRequestContext, path: string): Promise<Buffer>;
  write(ctx: WorkspaceRequestContext, path: string, content: string, opts?: { mode?: string }): Promise<FileWriteResult>;
  edit(ctx: WorkspaceRequestContext, path: string, edits: FileEdit[]): Promise<FileEditResult>;
  glob(ctx: WorkspaceRequestContext, pattern: string): Promise<string[]>;
  list(ctx: WorkspaceRequestContext, path: string): Promise<ListEntry[]>;
  stat(ctx: WorkspaceRequestContext, path: string): Promise<StatResult>;
}

export interface AuthService {
  startFlow(ctx: WorkspaceRequestContext): Promise<DeviceFlowStartResult>;
  getFlowStatus(ctx: WorkspaceRequestContext, flowId: string): Promise<DeviceFlowStatus>;
  cancelFlow(ctx: WorkspaceRequestContext, flowId: string): Promise<void>;
  getAuthStatus(ctx: WorkspaceRequestContext): Promise<AuthStatusResult>;
}

export interface AgentsService {
  list(ctx: WorkspaceRequestContext): Promise<AgentSummary[]>;
  get(ctx: WorkspaceRequestContext, agentType: string): Promise<AgentDetail>;
  create(ctx: WorkspaceRequestContext, spec: AgentCreateSpec): Promise<AgentDetail>;
  update(ctx: WorkspaceRequestContext, agentType: string, spec: AgentUpdateSpec): Promise<AgentDetail>;
  delete(ctx: WorkspaceRequestContext, agentType: string, opts?: { scope?: string }): Promise<void>;
}

export interface MemoryService {
  list(ctx: WorkspaceRequestContext): Promise<MemoryEntry[]>;
  read(ctx: WorkspaceRequestContext, key: string): Promise<MemoryContent>;
  write(ctx: WorkspaceRequestContext, key: string, content: string): Promise<void>;
  delete(ctx: WorkspaceRequestContext, key: string): Promise<void>;
}

// --- Facade interface ---

export interface DaemonWorkspaceService {
  file: FileService;
  auth: AuthService;
  agents: AgentsService;
  memory: MemoryService;

  initWorkspace(opts: InitWorkspaceOpts, ctx: WorkspaceRequestContext): Promise<void>;
  setToolEnabled(toolName: string, enabled: boolean, ctx: WorkspaceRequestContext): Promise<ToolToggleResult>;

  getMcpStatus(): Promise<ServeWorkspaceMcpStatus>;
  getSkillsStatus(): Promise<ServeWorkspaceSkillsStatus>;
  getProvidersStatus(): Promise<ServeWorkspaceProvidersStatus>;
  getEnvStatus(): Promise<ServeWorkspaceEnvStatus>;
  getPreflightStatus(): Promise<ServeWorkspacePreflightStatus>;
  restartMcpServer(serverName: string, ctx: WorkspaceRequestContext, opts?: RestartMcpOpts): Promise<RestartMcpResult>;
}

// --- Deps (callback injection) ---

export interface WorkspaceEvent {
  type: string;
  data: Record<string, unknown>;
  originatorClientId?: string;
}

export interface DaemonWorkspaceServiceDeps {
  fsFactory: WorkspaceFileSystemFactory;
  deviceFlowRegistry: DeviceFlowRegistry;
  subagentManager: unknown; // type from workspaceAgents.ts — refine during implementation
  boundWorkspace: string;
  contextFilename: string;
  persistDisabledTools: (workspace: string, tool: string, enabled: boolean) => Promise<void>;

  // Cross-cutting callbacks (session-derived infrastructure)
  publishWorkspaceEvent: (event: WorkspaceEvent) => void;
  knownClientIds: () => Set<string>;

  // Child delegation callbacks
  queryWorkspaceStatus: <T>(method: string, idle: () => T) => Promise<T>;
  invokeWorkspaceCommand: <T>(method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<T>;
}

// --- Result types (refine from existing code during implementation) ---

export interface FileReadResult { content: string; truncated: boolean; bytesRead: number; }
export interface FileWriteResult { ok: boolean; filePath: string; bytesWritten: number; mode?: string; }
export interface FileEdit { oldText: string; newText: string; }
export interface FileEditResult { ok: boolean; filePath: string; }
export interface ListEntry { name: string; type: 'file' | 'directory' | 'symlink'; }
export interface StatResult { exists: boolean; isFile: boolean; isDirectory: boolean; size: number; }
export interface DeviceFlowStartResult { flowId: string; verificationUri: string; userCode: string; }
export interface DeviceFlowStatus { state: string; /* refine from existing types */ }
export interface AuthStatusResult { authenticated: boolean; /* refine from existing */ }
export interface AgentSummary { agentType: string; /* refine */ }
export interface AgentDetail { agentType: string; /* refine */ }
export interface AgentCreateSpec { agentType: string; content: string; /* refine */ }
export interface AgentUpdateSpec { content: string; /* refine */ }
export interface MemoryEntry { key: string; /* refine */ }
export interface MemoryContent { key: string; content: string; }
export interface InitWorkspaceOpts { /* refine from bridge.ts:3256 */ }
export interface ToolToggleResult { toolName: string; enabled: boolean; }
export interface RestartMcpOpts { entryIndex?: number; }
export interface RestartMcpResult { serverName: string; restarted: boolean; durationMs?: number; }
```

> **Note:** Result types marked `/* refine */` should be aligned with existing response shapes during implementation. Read the current route handlers to get exact fields.

- [ ] **Step 2: Verify types compile**

Run: `cd packages/cli && npx tsc --noEmit src/serve/workspace-service/types.ts`
Expected: No errors (may need to adjust imports based on actual export paths)

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/serve/workspace-service/types.ts
git commit -m "feat(serve): add DaemonWorkspaceService type definitions"
```

---

## Task 2: FileService (TDD)

**Files:**
- Create: `packages/cli/src/serve/workspace-service/__tests__/fileService.test.ts`
- Create: `packages/cli/src/serve/workspace-service/fileService.ts`

- [ ] **Step 1: Write failing tests for FileService.read**

```ts
// packages/cli/src/serve/workspace-service/__tests__/fileService.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createFileService } from '../fileService.js';
import type { WorkspaceRequestContext } from '../types.js';

function makeCtx(overrides: Partial<WorkspaceRequestContext> = {}): WorkspaceRequestContext {
  return { route: 'GET /file', workspaceCwd: '/workspace', ...overrides };
}

describe('FileService', () => {
  describe('read', () => {
    it('calls fsFactory.forRequest with context and delegates to readFile', async () => {
      const mockFs = { readFile: vi.fn().mockResolvedValue({ content: 'hello', truncated: false, bytesRead: 5 }) };
      const fsFactory = { forRequest: vi.fn().mockReturnValue(mockFs) };
      const service = createFileService({ fsFactory: fsFactory as any, boundWorkspace: '/workspace' });

      const result = await service.read(makeCtx({ originatorClientId: 'c1' }), 'src/app.ts');

      expect(fsFactory.forRequest).toHaveBeenCalledWith({
        originatorClientId: 'c1',
        route: 'GET /file',
      });
      expect(mockFs.readFile).toHaveBeenCalledWith('src/app.ts', undefined);
      expect(result.content).toBe('hello');
    });

    it('works without originatorClientId (read-only, no auth required)', async () => {
      const mockFs = { readFile: vi.fn().mockResolvedValue({ content: '', truncated: false, bytesRead: 0 }) };
      const fsFactory = { forRequest: vi.fn().mockReturnValue(mockFs) };
      const service = createFileService({ fsFactory: fsFactory as any, boundWorkspace: '/workspace' });

      await service.read(makeCtx(), 'README.md');

      expect(fsFactory.forRequest).toHaveBeenCalledWith({
        originatorClientId: undefined,
        route: 'GET /file',
      });
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && npx vitest run src/serve/workspace-service/__tests__/fileService.test.ts`
Expected: FAIL — `createFileService` not found

- [ ] **Step 3: Implement FileService**

```ts
// packages/cli/src/serve/workspace-service/fileService.ts
import type { WorkspaceFileSystemFactory } from '../fs/index.js';
import type { FileService, WorkspaceRequestContext, FileReadResult, FileWriteResult, FileEdit, FileEditResult, ListEntry, StatResult } from './types.js';

export interface FileServiceDeps {
  fsFactory: WorkspaceFileSystemFactory;
  boundWorkspace: string;
}

export function createFileService(deps: FileServiceDeps): FileService {
  const { fsFactory } = deps;

  function scopedFs(ctx: WorkspaceRequestContext) {
    return fsFactory.forRequest({
      originatorClientId: ctx.originatorClientId,
      route: ctx.route,
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    });
  }

  return {
    async read(ctx, path, opts) {
      const fs = scopedFs(ctx);
      return fs.readFile(path, opts?.maxBytes);
    },
    async readBytes(ctx, path) {
      const fs = scopedFs(ctx);
      return fs.readFileBytes(path);
    },
    async write(ctx, path, content, opts) {
      const fs = scopedFs(ctx);
      return fs.writeFile(path, content, opts);
    },
    async edit(ctx, path, edits) {
      const fs = scopedFs(ctx);
      return fs.editFile(path, edits);
    },
    async glob(ctx, pattern) {
      const fs = scopedFs(ctx);
      return fs.glob(pattern);
    },
    async list(ctx, path) {
      const fs = scopedFs(ctx);
      return fs.listDirectory(path);
    },
    async stat(ctx, path) {
      const fs = scopedFs(ctx);
      return fs.stat(path);
    },
  };
}
```

> **Important:** The method names on `WorkspaceFileSystem` (`readFile`, `readFileBytes`, `writeFile`, `editFile`, `glob`, `listDirectory`, `stat`) must be verified against the actual interface at `packages/cli/src/serve/fs/workspaceFileSystem.ts`. Adjust if they differ.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && npx vitest run src/serve/workspace-service/__tests__/fileService.test.ts`
Expected: PASS

- [ ] **Step 5: Add tests for write (trust gate validates clientId when present)**

Add to the test file:
```ts
  describe('write', () => {
    it('passes originatorClientId to forRequest for audit', async () => {
      const mockFs = { writeFile: vi.fn().mockResolvedValue({ ok: true, filePath: '/workspace/f.ts', bytesWritten: 3 }) };
      const fsFactory = { forRequest: vi.fn().mockReturnValue(mockFs) };
      const service = createFileService({ fsFactory: fsFactory as any, boundWorkspace: '/workspace' });

      await service.write(makeCtx({ originatorClientId: 'c1', route: 'POST /file/write' }), 'f.ts', 'abc');

      expect(fsFactory.forRequest).toHaveBeenCalledWith({
        originatorClientId: 'c1',
        route: 'POST /file/write',
      });
      expect(mockFs.writeFile).toHaveBeenCalledWith('f.ts', 'abc', undefined);
    });
  });
```

- [ ] **Step 6: Run full FileService tests**

Run: `cd packages/cli && npx vitest run src/serve/workspace-service/__tests__/fileService.test.ts`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/serve/workspace-service/fileService.ts packages/cli/src/serve/workspace-service/__tests__/fileService.test.ts
git commit -m "feat(serve): add FileService wrapping fsFactory (TDD)"
```

---

## Task 3: AuthService (TDD)

**Files:**
- Create: `packages/cli/src/serve/workspace-service/__tests__/authService.test.ts`
- Create: `packages/cli/src/serve/workspace-service/authService.ts`

- [ ] **Step 1: Read existing auth route logic**

Read: `packages/cli/src/serve/server.ts:794-966` (device flow routes) and `packages/cli/src/serve/auth/deviceFlow.ts` to understand the DeviceFlowRegistry interface.

- [ ] **Step 2: Write failing test**

```ts
// packages/cli/src/serve/workspace-service/__tests__/authService.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createAuthService } from '../authService.js';
import type { WorkspaceRequestContext } from '../types.js';

const ctx: WorkspaceRequestContext = { route: 'POST /workspace/auth/device-flow', workspaceCwd: '/w' };

describe('AuthService', () => {
  it('startFlow delegates to registry.start and returns flowId + verificationUri + userCode', async () => {
    const registry = {
      start: vi.fn().mockReturnValue({ id: 'flow-1', verificationUri: 'https://auth.example/device', userCode: 'ABCD-1234' }),
    };
    const service = createAuthService({ deviceFlowRegistry: registry as any });

    const result = await service.startFlow(ctx);

    expect(registry.start).toHaveBeenCalled();
    expect(result.flowId).toBe('flow-1');
    expect(result.verificationUri).toBe('https://auth.example/device');
  });

  it('cancelFlow delegates to registry.cancel', async () => {
    const registry = { cancel: vi.fn().mockReturnValue({ cancelled: true }) };
    const service = createAuthService({ deviceFlowRegistry: registry as any });

    await service.cancelFlow(ctx, 'flow-1');

    expect(registry.cancel).toHaveBeenCalledWith('flow-1', undefined);
  });
});
```

- [ ] **Step 3: Run test — verify fail**

Run: `cd packages/cli && npx vitest run src/serve/workspace-service/__tests__/authService.test.ts`
Expected: FAIL

- [ ] **Step 4: Implement AuthService**

```ts
// packages/cli/src/serve/workspace-service/authService.ts
import type { DeviceFlowRegistry } from '../auth/deviceFlow.js';
import type { AuthService, WorkspaceRequestContext, DeviceFlowStartResult, DeviceFlowStatus, AuthStatusResult } from './types.js';

export interface AuthServiceDeps {
  deviceFlowRegistry: DeviceFlowRegistry;
}

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { deviceFlowRegistry } = deps;

  return {
    async startFlow(ctx) {
      const flow = deviceFlowRegistry.start(ctx.originatorClientId);
      return { flowId: flow.id, verificationUri: flow.verificationUri, userCode: flow.userCode };
    },
    async getFlowStatus(ctx, flowId) {
      return deviceFlowRegistry.get(flowId);
    },
    async cancelFlow(ctx, flowId) {
      deviceFlowRegistry.cancel(flowId, ctx.originatorClientId);
    },
    async getAuthStatus(_ctx) {
      return deviceFlowRegistry.getStatus();
    },
  };
}
```

> **Note:** Method names on `DeviceFlowRegistry` (`start`, `get`, `cancel`, `getStatus`) must be verified against `packages/cli/src/serve/auth/deviceFlow.ts`. Adjust signatures as needed.

- [ ] **Step 5: Run test — verify pass**

Run: `cd packages/cli && npx vitest run src/serve/workspace-service/__tests__/authService.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/serve/workspace-service/authService.ts packages/cli/src/serve/workspace-service/__tests__/authService.test.ts
git commit -m "feat(serve): add AuthService wrapping DeviceFlowRegistry (TDD)"
```

---

## Task 4: AgentsService (TDD)

**Files:**
- Create: `packages/cli/src/serve/workspace-service/__tests__/agentsService.test.ts`
- Create: `packages/cli/src/serve/workspace-service/agentsService.ts`

- [ ] **Step 1: Read existing agent logic**

Read: `packages/cli/src/serve/workspaceAgents.ts` — extract the business logic (validation, SubagentManager calls, event publishing). Note: this file is ~700+ lines with route handling mixed in.

- [ ] **Step 2: Write failing test — list + clientId validation**

```ts
// packages/cli/src/serve/workspace-service/__tests__/agentsService.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createAgentsService } from '../agentsService.js';
import type { WorkspaceRequestContext } from '../types.js';

const ctx: WorkspaceRequestContext = { route: 'GET /workspace/agents', workspaceCwd: '/w', originatorClientId: 'c1' };

describe('AgentsService', () => {
  it('list returns agents from subagentManager', async () => {
    const subagentManager = { list: vi.fn().mockResolvedValue([{ agentType: 'reviewer' }]) };
    const deps = {
      subagentManager,
      publishWorkspaceEvent: vi.fn(),
      knownClientIds: () => new Set(['c1']),
    };
    const service = createAgentsService(deps as any);

    const result = await service.list(ctx);

    expect(result).toEqual([{ agentType: 'reviewer' }]);
  });

  it('create publishes workspace event after success', async () => {
    const subagentManager = { create: vi.fn().mockResolvedValue({ agentType: 'helper', content: '...' }) };
    const publishWorkspaceEvent = vi.fn();
    const deps = {
      subagentManager,
      publishWorkspaceEvent,
      knownClientIds: () => new Set(['c1']),
    };
    const service = createAgentsService(deps as any);

    await service.create(ctx, { agentType: 'helper', content: 'prompt' });

    expect(publishWorkspaceEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_created' }));
  });

  it('rejects unknown clientId on mutation', async () => {
    const deps = {
      subagentManager: { create: vi.fn() },
      publishWorkspaceEvent: vi.fn(),
      knownClientIds: () => new Set(['c2']), // c1 not in set
    };
    const service = createAgentsService(deps as any);

    await expect(service.create(ctx, { agentType: 'x', content: '' }))
      .rejects.toThrow(/not registered/);
  });
});
```

- [ ] **Step 3: Run test — verify fail**

Run: `cd packages/cli && npx vitest run src/serve/workspace-service/__tests__/agentsService.test.ts`
Expected: FAIL

- [ ] **Step 4: Implement AgentsService**

Extract business logic from `packages/cli/src/serve/workspaceAgents.ts` into:
```ts
// packages/cli/src/serve/workspace-service/agentsService.ts
import type { AgentsService, WorkspaceRequestContext, WorkspaceEvent } from './types.js';

export interface AgentsServiceDeps {
  subagentManager: any; // refine type from workspaceAgents.ts
  publishWorkspaceEvent: (event: WorkspaceEvent) => void;
  knownClientIds: () => Set<string>;
}

function validateClientId(deps: AgentsServiceDeps, ctx: WorkspaceRequestContext): void {
  if (ctx.originatorClientId && !deps.knownClientIds().has(ctx.originatorClientId)) {
    throw new Error(`Client id "${ctx.originatorClientId}" is not registered for this workspace`);
  }
}

export function createAgentsService(deps: AgentsServiceDeps): AgentsService {
  return {
    async list(_ctx) {
      return deps.subagentManager.list();
    },
    async get(_ctx, agentType) {
      return deps.subagentManager.get(agentType);
    },
    async create(ctx, spec) {
      validateClientId(deps, ctx);
      const result = await deps.subagentManager.create(spec);
      deps.publishWorkspaceEvent({
        type: 'agent_created',
        data: { agentType: spec.agentType },
        originatorClientId: ctx.originatorClientId,
      });
      return result;
    },
    async update(ctx, agentType, spec) {
      validateClientId(deps, ctx);
      const result = await deps.subagentManager.update(agentType, spec);
      deps.publishWorkspaceEvent({
        type: 'agent_updated',
        data: { agentType },
        originatorClientId: ctx.originatorClientId,
      });
      return result;
    },
    async delete(ctx, agentType, opts) {
      validateClientId(deps, ctx);
      await deps.subagentManager.delete(agentType, opts);
      deps.publishWorkspaceEvent({
        type: 'agent_deleted',
        data: { agentType },
        originatorClientId: ctx.originatorClientId,
      });
    },
  };
}
```

> **Important:** The actual SubagentManager interface and event types must be extracted from `workspaceAgents.ts` during implementation. The above is the pattern; exact method names/params will differ.

- [ ] **Step 5: Run test — verify pass**

Run: `cd packages/cli && npx vitest run src/serve/workspace-service/__tests__/agentsService.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/serve/workspace-service/agentsService.ts packages/cli/src/serve/workspace-service/__tests__/agentsService.test.ts
git commit -m "feat(serve): add AgentsService with clientId validation and event publish (TDD)"
```

---

## Task 5: MemoryService (TDD)

**Files:**
- Create: `packages/cli/src/serve/workspace-service/__tests__/memoryService.test.ts`
- Create: `packages/cli/src/serve/workspace-service/memoryService.ts`

- [ ] **Step 1: Read existing memory logic**

Read: `packages/cli/src/serve/workspaceMemory.ts` — understand how memory CRUD works (likely file-based with `writeWorkspaceContextFile` or similar).

- [ ] **Step 2: Write failing test**

```ts
// packages/cli/src/serve/workspace-service/__tests__/memoryService.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createMemoryService } from '../memoryService.js';
import type { WorkspaceRequestContext } from '../types.js';

const ctx: WorkspaceRequestContext = { route: 'POST /workspace/memory', workspaceCwd: '/w', originatorClientId: 'c1' };

describe('MemoryService', () => {
  it('write publishes workspace event', async () => {
    const publishWorkspaceEvent = vi.fn();
    const deps = {
      // mock whatever memory backend is used
      publishWorkspaceEvent,
      knownClientIds: () => new Set(['c1']),
      boundWorkspace: '/w',
    };
    const service = createMemoryService(deps as any);

    await service.write(ctx, 'user-prefs', 'dark mode');

    expect(publishWorkspaceEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'memory_written' }));
  });

  it('rejects unknown clientId on write', async () => {
    const deps = {
      publishWorkspaceEvent: vi.fn(),
      knownClientIds: () => new Set(['other']),
      boundWorkspace: '/w',
    };
    const service = createMemoryService(deps as any);

    await expect(service.write(ctx, 'key', 'val')).rejects.toThrow(/not registered/);
  });
});
```

- [ ] **Step 3: Implement MemoryService**

Extract logic from `packages/cli/src/serve/workspaceMemory.ts`. Pattern identical to AgentsService: validate clientId on mutations, delegate to backend, publish event.

- [ ] **Step 4: Run tests — verify pass**

Run: `cd packages/cli && npx vitest run src/serve/workspace-service/__tests__/memoryService.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/serve/workspace-service/memoryService.ts packages/cli/src/serve/workspace-service/__tests__/memoryService.test.ts
git commit -m "feat(serve): add MemoryService with event publish (TDD)"
```

---

## Task 6: Facade + Workspace-Scoped Methods (TDD)

**Files:**
- Create: `packages/cli/src/serve/workspace-service/__tests__/facade.test.ts`
- Create: `packages/cli/src/serve/workspace-service/index.ts`

- [ ] **Step 1: Write failing test for facade construction + status delegation**

```ts
// packages/cli/src/serve/workspace-service/__tests__/facade.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createDaemonWorkspaceService } from '../index.js';
import type { WorkspaceRequestContext } from '../types.js';

const ctx: WorkspaceRequestContext = { route: 'POST /workspace/init', workspaceCwd: '/w' };

describe('DaemonWorkspaceService', () => {
  function makeDeps(overrides = {}) {
    return {
      fsFactory: { forRequest: vi.fn().mockReturnValue({}) },
      deviceFlowRegistry: {},
      subagentManager: {},
      boundWorkspace: '/w',
      contextFilename: 'QWEN.md',
      persistDisabledTools: vi.fn(),
      publishWorkspaceEvent: vi.fn(),
      knownClientIds: () => new Set<string>(),
      queryWorkspaceStatus: vi.fn().mockImplementation((_m, idle) => Promise.resolve(idle())),
      invokeWorkspaceCommand: vi.fn(),
      ...overrides,
    };
  }

  it('exposes file, auth, agents, memory sub-services', () => {
    const service = createDaemonWorkspaceService(makeDeps());
    expect(service.file).toBeDefined();
    expect(service.auth).toBeDefined();
    expect(service.agents).toBeDefined();
    expect(service.memory).toBeDefined();
  });

  it('getMcpStatus delegates to queryWorkspaceStatus callback', async () => {
    const idle = { servers: [] };
    const queryWorkspaceStatus = vi.fn().mockResolvedValue(idle);
    const service = createDaemonWorkspaceService(makeDeps({ queryWorkspaceStatus }));

    const result = await service.getMcpStatus();

    expect(queryWorkspaceStatus).toHaveBeenCalled();
    expect(result).toBe(idle);
  });

  it('setToolEnabled calls persistDisabledTools + publishes event', async () => {
    const persistDisabledTools = vi.fn().mockResolvedValue(undefined);
    const publishWorkspaceEvent = vi.fn();
    const service = createDaemonWorkspaceService(makeDeps({ persistDisabledTools, publishWorkspaceEvent }));

    const result = await service.setToolEnabled('Bash', false, ctx);

    expect(persistDisabledTools).toHaveBeenCalledWith('/w', 'Bash', false);
    expect(publishWorkspaceEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tool_toggled',
      data: { toolName: 'Bash', enabled: false },
    }));
    expect(result).toEqual({ toolName: 'Bash', enabled: false });
  });
});
```

- [ ] **Step 2: Run test — verify fail**

Run: `cd packages/cli && npx vitest run src/serve/workspace-service/__tests__/facade.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement facade factory**

```ts
// packages/cli/src/serve/workspace-service/index.ts
import type { DaemonWorkspaceService, DaemonWorkspaceServiceDeps } from './types.js';
import { createFileService } from './fileService.js';
import { createAuthService } from './authService.js';
import { createAgentsService } from './agentsService.js';
import { createMemoryService } from './memoryService.js';
import { SERVE_STATUS_EXT_METHODS } from '@qwen-code/acp-bridge';

export { type DaemonWorkspaceService, type DaemonWorkspaceServiceDeps, type WorkspaceRequestContext } from './types.js';

export function createDaemonWorkspaceService(deps: DaemonWorkspaceServiceDeps): DaemonWorkspaceService {
  const file = createFileService({ fsFactory: deps.fsFactory, boundWorkspace: deps.boundWorkspace });
  const auth = createAuthService({ deviceFlowRegistry: deps.deviceFlowRegistry });
  const agents = createAgentsService({
    subagentManager: deps.subagentManager,
    publishWorkspaceEvent: deps.publishWorkspaceEvent,
    knownClientIds: deps.knownClientIds,
  });
  const memory = createMemoryService({
    publishWorkspaceEvent: deps.publishWorkspaceEvent,
    knownClientIds: deps.knownClientIds,
    boundWorkspace: deps.boundWorkspace,
  });

  return {
    file,
    auth,
    agents,
    memory,

    async initWorkspace(opts, ctx) {
      // Migrate logic from bridge.ts:3256 — local file creation via fsFactory
      const fs = deps.fsFactory.forRequest({ originatorClientId: ctx.originatorClientId, route: ctx.route });
      // ... path validation + file creation (copy from bridge.ts:3256-3350)
    },

    async setToolEnabled(toolName, enabled, ctx) {
      await deps.persistDisabledTools(deps.boundWorkspace, toolName, enabled);
      deps.publishWorkspaceEvent({
        type: 'tool_toggled',
        data: { toolName, enabled },
        ...(ctx.originatorClientId ? { originatorClientId: ctx.originatorClientId } : {}),
      });
      return { toolName, enabled };
    },

    async getMcpStatus() {
      return deps.queryWorkspaceStatus(SERVE_STATUS_EXT_METHODS.workspaceMcp, () => createIdleMcpStatus(deps.boundWorkspace));
    },
    async getSkillsStatus() {
      return deps.queryWorkspaceStatus(SERVE_STATUS_EXT_METHODS.workspaceSkills, () => ({ skills: [] }));
    },
    async getProvidersStatus() {
      return deps.queryWorkspaceStatus(SERVE_STATUS_EXT_METHODS.workspaceProviders, () => ({ providers: [] }));
    },
    async getEnvStatus() {
      return deps.queryWorkspaceStatus(SERVE_STATUS_EXT_METHODS.workspaceEnv, () => ({ env: [] }));
    },
    async getPreflightStatus() {
      return deps.queryWorkspaceStatus(SERVE_STATUS_EXT_METHODS.workspacePreflight, () => ({ checks: [] }));
    },

    async restartMcpServer(serverName, ctx, opts) {
      const params: Record<string, unknown> = { serverName };
      if (opts?.entryIndex !== undefined) params['entryIndex'] = opts.entryIndex;
      const result = await deps.invokeWorkspaceCommand(
        SERVE_STATUS_EXT_METHODS.workspaceMcpRestart ?? 'qwen/control/workspace/mcp/restart',
        params,
      );
      deps.publishWorkspaceEvent({
        type: 'mcp_server_restarted',
        data: { serverName, ...(result as object) },
        ...(ctx.originatorClientId ? { originatorClientId: ctx.originatorClientId } : {}),
      });
      return result as any;
    },
  };
}
```

> **Critical:** `initWorkspace` implementation must be copied from `bridge.ts:3256-3350` (path validation, symlink checks, file creation). Use `fsFactory.forRequest(ctx)` instead of raw `node:fs/promises` — this fixes the existing FIXME.

- [ ] **Step 4: Run test — verify pass**

Run: `cd packages/cli && npx vitest run src/serve/workspace-service/__tests__/facade.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/serve/workspace-service/index.ts packages/cli/src/serve/workspace-service/__tests__/facade.test.ts
git commit -m "feat(serve): add DaemonWorkspaceService facade with status/tool/init/restart (TDD)"
```

---

## Task 7: Bridge — Expose Child Delegation + Remove Workspace Methods

**Files:**
- Modify: `packages/acp-bridge/src/bridge.ts`
- Modify: `packages/acp-bridge/src/bridgeTypes.ts`

- [ ] **Step 1: Add `queryWorkspaceStatus` and `invokeWorkspaceCommand` to bridge interface**

In `packages/acp-bridge/src/bridgeTypes.ts`, add to the interface (which is still named `HttpAcpBridge` at this point):

```ts
  queryWorkspaceStatus<T>(method: string, idle: () => T): Promise<T>;
  invokeWorkspaceCommand<T>(method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<T>;
```

- [ ] **Step 2: Implement them in bridge.ts**

In `packages/acp-bridge/src/bridge.ts`, add to the returned object (near the existing `requestWorkspaceStatus` usage):

```ts
    queryWorkspaceStatus(method, idle) {
      return requestWorkspaceStatus(method, idle);
    },
    invokeWorkspaceCommand(method, params, opts) {
      const info = liveChannelInfo();
      if (!info) throw new SessionNotFoundError(`workspace-command:${method}`);
      const timeout = opts?.timeoutMs ?? initTimeoutMs;
      return withTimeout(
        Promise.race([
          info.connection.extMethod(method, { ...params, cwd: boundWorkspace }),
          getChannelClosedReject(info),
        ]),
        timeout,
        method,
      ) as Promise<any>;
    },
```

- [ ] **Step 3: Remove the 8 workspace methods from bridge**

Remove from bridge.ts:
- `initWorkspace` (lines ~3256-3550)
- `setWorkspaceToolEnabled` (lines ~3071-3093)
- `getWorkspaceMcpStatus` / `getWorkspaceSkillsStatus` / `getWorkspaceProvidersStatus` / `getWorkspaceEnvStatus` / `getWorkspacePreflightStatus` (lines ~2665-2790)
- `restartMcpServer` (lines ~3093-3256)

Remove their signatures from `bridgeTypes.ts`.

- [ ] **Step 4: Run bridge tests to verify nothing is broken**

Run: `cd packages/acp-bridge && npx vitest run`
Expected: Some tests may reference removed methods — fix those (they should now test via the facade in integration).

- [ ] **Step 5: Commit**

```bash
git add packages/acp-bridge/src/bridge.ts packages/acp-bridge/src/bridgeTypes.ts
git commit -m "refactor(bridge): extract workspace methods, expose queryWorkspaceStatus + invokeWorkspaceCommand"
```

---

## Task 8: Bridge Rename (HttpAcpBridge → AcpSessionBridge)

**Files:**
- Modify: `packages/acp-bridge/src/bridgeTypes.ts`
- Modify: `packages/acp-bridge/src/bridge.ts`
- Modify: `packages/acp-bridge/src/bridgeOptions.ts`
- Modify: `packages/acp-bridge/src/status.ts`
- Modify: `packages/acp-bridge/src/index.ts`
- Rename: `packages/cli/src/serve/httpAcpBridge.ts` → `packages/cli/src/serve/acpSessionBridge.ts`
- Modify: `packages/cli/src/serve/runQwenServe.ts` (import paths)
- Modify: all files importing `HttpAcpBridge` or `createHttpAcpBridge`

- [ ] **Step 1: Rename interface + factory function in acp-bridge package**

In `bridgeTypes.ts`:
```ts
// Before: export interface HttpAcpBridge {
// After:
export interface AcpSessionBridge {
```

In `bridge.ts`:
```ts
// Before: export function createHttpAcpBridge(
// After:
export function createAcpSessionBridge(
```

Add deprecated re-export for safety:
```ts
/** @deprecated Use AcpSessionBridge */
export type HttpAcpBridge = AcpSessionBridge;
/** @deprecated Use createAcpSessionBridge */
export const createHttpAcpBridge = createAcpSessionBridge;
```

- [ ] **Step 2: Rename file in cli package**

```bash
git mv packages/cli/src/serve/httpAcpBridge.ts packages/cli/src/serve/acpSessionBridge.ts
```

- [ ] **Step 3: Update all imports project-wide**

```bash
# Find and fix all references
grep -rn "HttpAcpBridge\|createHttpAcpBridge\|httpAcpBridge" packages/ --include="*.ts" | grep -v node_modules | grep -v ".test.ts"
```

Update each file to use new names. Key files:
- `packages/cli/src/serve/runQwenServe.ts`
- `packages/cli/src/serve/workspaceAgents.ts`
- `packages/cli/src/serve/workspaceMemory.ts`
- `packages/cli/src/serve/server.ts`
- `packages/acp-bridge/src/status.ts` (error message string)
- `packages/acp-bridge/src/bridgeOptions.ts` (JSDoc)

- [ ] **Step 4: Run typecheck**

Run: `cd packages/cli && npx tsc --noEmit && cd ../acp-bridge && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 5: Run full test suites**

Run: `cd packages/acp-bridge && npx vitest run && cd ../cli && npx vitest run`
Expected: All pass (tests still use deprecated alias or are updated)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(bridge): rename HttpAcpBridge → AcpSessionBridge"
```

---

## Task 9: Wire Service into runQwenServe + REST Routes

**Files:**
- Modify: `packages/cli/src/serve/runQwenServe.ts`
- Modify: `packages/cli/src/serve/server.ts`
- Modify: `packages/cli/src/serve/workspaceAgents.ts`
- Modify: `packages/cli/src/serve/workspaceMemory.ts`
- Modify: `packages/cli/src/serve/routes/workspaceFileRead.ts`
- Modify: `packages/cli/src/serve/routes/workspaceFileWrite.ts`

- [ ] **Step 1: Construct service in runQwenServe.ts**

Add after bridge construction:
```ts
import { createDaemonWorkspaceService } from './workspace-service/index.js';

// After bridge is created:
const workspace = createDaemonWorkspaceService({
  fsFactory,
  deviceFlowRegistry,
  subagentManager,  // from existing construction
  boundWorkspace,
  contextFilename,
  persistDisabledTools,
  publishWorkspaceEvent: (event) => bridge.publishWorkspaceEvent(event),
  knownClientIds: () => bridge.knownClientIds(),
  queryWorkspaceStatus: (method, idle) => bridge.queryWorkspaceStatus(method, idle),
  invokeWorkspaceCommand: (method, params, opts) => bridge.invokeWorkspaceCommand(method, params, opts),
});
```

Pass `workspace` to `createServeApp`.

- [ ] **Step 2: Rewire workspace status routes in server.ts**

Replace direct bridge calls with service calls:
```ts
// Before:
app.get('/workspace/mcp', async (_req, res) => {
  res.status(200).json(await bridge.getWorkspaceMcpStatus());
});

// After:
app.get('/workspace/mcp', async (_req, res) => {
  res.status(200).json(await workspace.getMcpStatus());
});
```

Repeat for `/workspace/skills`, `/workspace/providers`, `/workspace/env`, `/workspace/preflight`, `/workspace/init`, tool toggle route.

- [ ] **Step 3: Rewire workspaceAgents.ts route shell**

Change `mountWorkspaceAgentsRoutes` to receive `workspace.agents` instead of `bridge`:
```ts
// deps.bridge.publishWorkspaceEvent → service handles internally
// deps.bridge.knownClientIds() → service handles internally
// Route handler becomes thin: parse request → build ctx → call service → send response
```

- [ ] **Step 4: Rewire workspaceMemory.ts route shell**

Same pattern as agents.

- [ ] **Step 5: Rewire file routes**

`workspaceFileRead.ts` and `workspaceFileWrite.ts` — change from calling `fsFactory.forRequest` directly to calling `workspace.file.*`:
```ts
// Before:
const fs = getFsFactory(req, res);
const result = await fs.readFile(path, maxBytes);

// After:
const ctx = buildRequestContext(req);
const result = await workspace.file.read(ctx, path, { maxBytes });
```

- [ ] **Step 6: Run full test suite**

Run: `cd packages/cli && npx vitest run`
Expected: All existing route tests pass (HTTP surface unchanged)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(serve): wire DaemonWorkspaceService into REST routes"
```

---

## Task 10: /acp Northbound Method Dispatch

**Files:**
- Modify: relevant `/acp` handler file (locate via `grep -rn "extMethod\|acpHttp\|acp-integration" packages/cli/src/`)
- Create or modify: northbound method dispatcher

- [ ] **Step 1: Locate the /acp method dispatch entry point**

```bash
grep -rn "method.*dispatch\|handleMethod\|jsonrpc.*method" packages/cli/src/acp-integration/ packages/cli/src/serve/ --include="*.ts" | grep -v test | head -20
```

- [ ] **Step 2: Add workspace method dispatch**

In the /acp handler that routes JSON-RPC methods, add a switch/map for `qwen/workspace/*`:

```ts
// Pattern (exact location depends on codebase structure):
case 'qwen/workspace/fs/read': {
  const ctx = buildAcpRequestContext(connection, 'qwen/workspace/fs/read');
  const { path } = params;
  return workspace.file.read(ctx, path);
}
case 'qwen/workspace/fs/write': {
  const ctx = buildAcpRequestContext(connection, 'qwen/workspace/fs/write');
  const { path, content, mode } = params;
  return workspace.file.write(ctx, path, content, { mode });
}
// ... all 27 methods
```

> Build a helper `buildAcpRequestContext` that extracts clientId from the ACP connection and constructs `WorkspaceRequestContext`.

- [ ] **Step 3: Add capabilities advertisement**

Ensure `_meta.qwen.methods` includes all `qwen/workspace/*` methods in the `initialize` response.

- [ ] **Step 4: Run typecheck**

Run: `cd packages/cli && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(serve): add /acp northbound workspace methods (27 qwen/workspace/* endpoints)"
```

---

## Task 11: E2e Equivalence Tests

**Files:**
- Create: `packages/cli/src/serve/workspace-service/__tests__/e2e.test.ts`

- [ ] **Step 1: Build /acp test harness helper**

```ts
// Helper for sending JSON-RPC to /acp endpoint via supertest
import request from 'supertest';

async function acpCall(app: any, method: string, params: Record<string, unknown> = {}, token = 'test-token') {
  const res = await request(app)
    .post('/acp')
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'application/json')
    .send({ jsonrpc: '2.0', id: 1, method, params });
  return res.body;
}
```

- [ ] **Step 2: Write equivalence tests**

```ts
// packages/cli/src/serve/workspace-service/__tests__/e2e.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createServeApp } from '../../server.js';
// ... setup with mocked bridge + workspace

describe('REST ↔ /acp equivalence', () => {
  let app: any;

  beforeAll(() => {
    // Create app with both REST and /acp wired to same workspace service
    app = createServeApp({ /* ... test deps */ });
  });

  describe('file read', () => {
    it('returns same content via both transports', async () => {
      const restRes = await request(app).get('/file?path=README.md').set('Authorization', 'Bearer tok');
      const acpRes = await acpCall(app, 'qwen/workspace/fs/read', { path: 'README.md' });

      expect(restRes.body.content).toBe(acpRes.result.content);
    });
  });

  describe('trust gate rejection', () => {
    it('rejects invalid clientId via REST (400)', async () => {
      const res = await request(app)
        .post('/file/write')
        .set('Authorization', 'Bearer tok')
        .set('X-Qwen-Client-Id', 'unknown-client')
        .send({ path: 'x.ts', content: 'y' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_client_id');
    });

    it('rejects invalid clientId via /acp (JSON-RPC error)', async () => {
      const res = await acpCall(app, 'qwen/workspace/fs/write', { path: 'x.ts', content: 'y' });
      expect(res.error.code).toBe(-32602);
      expect(res.error.message).toContain('invalid_client_id');
    });
  });
});
```

- [ ] **Step 3: Run e2e tests**

Run: `cd packages/cli && npx vitest run src/serve/workspace-service/__tests__/e2e.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/serve/workspace-service/__tests__/e2e.test.ts
git commit -m "test(serve): add REST ↔ /acp equivalence e2e tests"
```

---

## Task 12: Final Verification

- [ ] **Step 1: Run full typecheck across all packages**

```bash
cd packages/acp-bridge && npx tsc --noEmit && cd ../cli && npx tsc --noEmit && cd ../sdk-typescript && npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 2: Run full test suites**

```bash
cd packages/acp-bridge && npx vitest run && cd ../cli && npx vitest run
```
Expected: All pass. SDK tests should pass WITHOUT modification (REST surface unchanged).

- [ ] **Step 3: Verify SDK tests pass unmodified**

```bash
cd packages/sdk-typescript && npx vitest run
```
Expected: All pass — confirms backward compatibility.

- [ ] **Step 4: Run lint**

```bash
cd packages/cli && npm run lint && cd ../acp-bridge && npm run lint
```
Expected: No errors

- [ ] **Step 5: Final commit (if any cleanup needed)**

```bash
git status
# If clean, no commit needed. If lint fixes:
git add -A && git commit -m "chore: lint fixes"
```

- [ ] **Step 6: Verify git log is clean**

```bash
git log --oneline -15
```

Confirm commits tell a coherent story for the single-PR reviewer.
