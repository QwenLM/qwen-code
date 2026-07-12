/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import {
  registerWorkspaceManagementRoutes,
  type WorkspaceManagementRouteDeps,
  type WorkspaceRuntimeRemovalController,
} from './workspace-management.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  workspaceRegistrationId,
  WorkspaceRegistrationStoreLimitError,
  type WorkspaceRegistrationStore,
} from '../workspace-registration-store.js';

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStderrLine: vi.fn(),
}));

// Use the canonical tmpdir so the test path matches what
// realpathSync.native resolves (e.g. /tmp → /private/tmp on macOS).
const REAL_DIR = realpathSync.native(tmpdir());
function createMockRegistry(
  runtimes: WorkspaceRuntime[] = [],
): WorkspaceRegistry {
  const byCwd = new Map(runtimes.map((r) => [r.workspaceCwd, r]));
  const byId = new Map(runtimes.map((r) => [r.workspaceId, r]));
  const draining = new Set<WorkspaceRuntime>();
  const add = vi.fn((runtime: WorkspaceRuntime) => {
    runtimes.push(runtime);
    byCwd.set(runtime.workspaceCwd, runtime);
    byId.set(runtime.workspaceId, runtime);
  });
  return {
    primary: runtimes[0]!,
    list: () =>
      Object.freeze(
        runtimes.filter((runtime) => !draining.has(runtime)),
      ) as readonly WorkspaceRuntime[],
    listManaged: () =>
      Object.freeze([...runtimes]) as readonly WorkspaceRuntime[],
    getByWorkspaceCwd: (cwd: string) => {
      const runtime = byCwd.get(cwd);
      return runtime && !draining.has(runtime) ? runtime : undefined;
    },
    getManagedByWorkspaceCwd: (cwd: string) => byCwd.get(cwd),
    getByWorkspaceId: (id: string) => {
      const runtime = byId.get(id);
      return runtime && !draining.has(runtime) ? runtime : undefined;
    },
    getManagedByWorkspaceId: (id: string) => byId.get(id),
    resolveWorkspaceCwd: () => undefined,
    resolveLiveSessionOwner: () => ({ kind: 'not_found' }),
    beginDrain: vi.fn((runtime: WorkspaceRuntime) => {
      if (draining.has(runtime)) return false;
      draining.add(runtime);
      return true;
    }),
    cancelDrain: vi.fn((runtime: WorkspaceRuntime) => draining.delete(runtime)),
    completeDrain: vi.fn((runtime: WorkspaceRuntime) => {
      draining.delete(runtime);
      const index = runtimes.indexOf(runtime);
      if (index < 0) return false;
      runtimes.splice(index, 1);
      byCwd.delete(runtime.workspaceCwd);
      byId.delete(runtime.workspaceId);
      return true;
    }),
    add,
  } as unknown as WorkspaceRegistry;
}

function makeRuntime(
  cwd: string,
  overrides: Partial<WorkspaceRuntime> = {},
): WorkspaceRuntime {
  return {
    workspaceId: `id-${cwd}`,
    workspaceCwd: cwd,
    primary: false,
    trusted: true,
    removable: true,
    bridge: {
      sessionCount: 0,
      activePromptCount: 0,
      shutdown: vi.fn().mockResolvedValue(undefined),
      killAllSync: vi.fn(),
    },
    ...overrides,
  } as unknown as WorkspaceRuntime;
}

function createApp(overrides?: Partial<WorkspaceManagementRouteDeps>) {
  const app = express();
  app.use(express.json());
  const deps: WorkspaceManagementRouteDeps = {
    workspaceRegistry: createMockRegistry([makeRuntime(REAL_DIR)]),
    mutate: () => (_req: Request, _res: Response, next: () => void) => next(),
    safeBody: (req: Request) => (req.body ?? {}) as Record<string, unknown>,
    createWorkspaceRuntime: vi
      .fn()
      .mockImplementation((cwd: string) => Promise.resolve(makeRuntime(cwd))),
    ...overrides,
  };
  const handle = registerWorkspaceManagementRoutes(app, deps);
  return { app, deps, handle };
}

function createRemovalController(
  pendingSessionStarts = 0,
): WorkspaceRuntimeRemovalController {
  return {
    beginDrain: vi.fn(),
    cancelDrain: vi.fn(),
    completeDrain: vi.fn(),
    getActivity: vi.fn(() => ({ pendingSessionStarts, channelWorkers: 0 })),
    disposeRuntime: vi.fn().mockResolvedValue(undefined),
  };
}

describe('POST /workspaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 501 when createWorkspaceRuntime is not provided', async () => {
    const { app } = createApp({ createWorkspaceRuntime: undefined });
    const res = await request(app)
      .post('/workspaces')
      .send({ cwd: '/some/path' });
    expect(res.status).toBe(501);
    expect(res.body.code).toBe('not_implemented');
  });

  it('returns 400 for missing cwd', async () => {
    const { app } = createApp();
    const res = await request(app).post('/workspaces').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_path');
  });

  it('returns 400 for empty cwd', async () => {
    const { app } = createApp();
    const res = await request(app).post('/workspaces').send({ cwd: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_path');
  });

  it('returns 400 for relative path', async () => {
    const { app } = createApp();
    const res = await request(app)
      .post('/workspaces')
      .send({ cwd: 'relative/path' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_path');
  });

  it('returns 400 for a non-boolean persist flag', async () => {
    const { app } = createApp();
    const res = await request(app)
      .post('/workspaces')
      .send({ cwd: REAL_DIR, persist: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_persist_flag');
  });

  it('returns 400 for path exceeding max length', async () => {
    const { app } = createApp();
    const longPath = '/' + 'a'.repeat(5000);
    const res = await request(app).post('/workspaces').send({ cwd: longPath });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_path');
  });

  it('returns 400 when path does not exist', async () => {
    const { app } = createApp();
    const res = await request(app)
      .post('/workspaces')
      .send({ cwd: '/nonexistent_path_abc123xyz' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_path');
  });

  it('returns 409 for duplicate workspace (same canonical path)', async () => {
    // Registry already has REAL_DIR; posting it again should 409.
    const { app } = createApp();
    const res = await request(app).post('/workspaces').send({ cwd: REAL_DIR });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('workspace_exists');
  });

  it('returns 201 on successful registration', async () => {
    // Use /tmp (exists, is a dir) but ensure it's NOT in the registry.
    const { app } = createApp({
      workspaceRegistry: createMockRegistry([makeRuntime('/some-other-dir')]),
    });
    const res = await request(app).post('/workspaces').send({ cwd: REAL_DIR });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: expect.any(String),
      cwd: expect.any(String),
      primary: false,
      trusted: true,
    });
    expect(res.body).not.toHaveProperty('persisted');
  });

  it('does not double-count a runtime while its addition hook is pending', async () => {
    const firstDir = await mkdtemp(join(REAL_DIR, 'qws-capacity-a-'));
    const secondDir = await mkdtemp(join(REAL_DIR, 'qws-capacity-b-'));
    try {
      const registry = createMockRegistry(
        Array.from({ length: 23 }, (_, index) =>
          makeRuntime(`/registered-${index}`),
        ),
      );
      let releaseAddition!: () => void;
      const additionPending = new Promise<void>((resolve) => {
        releaseAddition = resolve;
      });
      const runtimeRemoval = createRemovalController();
      runtimeRemoval.runtimeAdded = vi
        .fn()
        .mockReturnValueOnce(additionPending)
        .mockResolvedValue(undefined);
      const { app } = createApp({
        workspaceRegistry: registry,
        runtimeRemoval,
      });

      const first = request(app).post('/workspaces').send({ cwd: firstDir });
      const firstResult = first.then((response) => response);
      await vi.waitFor(() => {
        expect(runtimeRemoval.runtimeAdded).toHaveBeenCalledOnce();
      });
      const second = await request(app)
        .post('/workspaces')
        .send({ cwd: secondDir });
      releaseAddition();

      expect((await firstResult).status).toBe(201);
      expect(second.status).toBe(201);
      expect(registry.listManaged()).toHaveLength(25);
    } finally {
      await Promise.all([
        rm(firstDir, { recursive: true, force: true }),
        rm(secondDir, { recursive: true, force: true }),
      ]);
    }
  });

  it('keeps a registered runtime when an optional adapter fails to attach', async () => {
    const registry = createMockRegistry([makeRuntime('/some-other-dir')]);
    const runtimeRemoval = createRemovalController();
    runtimeRemoval.runtimeAdded = vi
      .fn()
      .mockRejectedValue(new Error('worker unavailable'));
    const { app } = createApp({
      workspaceRegistry: registry,
      runtimeRemoval,
    });

    const res = await request(app).post('/workspaces').send({ cwd: REAL_DIR });

    expect(res.status).toBe(201);
    expect(registry.getByWorkspaceCwd(REAL_DIR)).toBeDefined();
    expect(runtimeRemoval.disposeRuntime).not.toHaveBeenCalled();
  });

  it('does not echo resolved paths in 409 error messages', async () => {
    const { app } = createApp();
    const res = await request(app).post('/workspaces').send({ cwd: REAL_DIR });
    // Generic error message — does not reveal canonical/internal paths.
    expect(res.body.error).toBe('Workspace already registered');
  });

  it('persists a newly registered workspace before returning success', async () => {
    const add = vi.fn().mockResolvedValue(true);
    const { app, deps } = createApp({
      workspaceRegistry: createMockRegistry([makeRuntime('/some-other-dir')]),
      workspaceRegistrationStore: {
        add,
      } as unknown as WorkspaceRegistrationStore,
    });
    const res = await request(app)
      .post('/workspaces')
      .send({ cwd: REAL_DIR, persist: true });
    expect(res.status).toBe(201);
    expect(res.body.persisted).toBe(true);
    expect(add).toHaveBeenCalledWith(REAL_DIR);
    expect(deps.workspaceRegistry.add).toHaveBeenCalledTimes(1);
  });

  it('promotes an existing secondary workspace to persistent idempotently', async () => {
    const add = vi.fn().mockResolvedValue(false);
    const { app } = createApp({
      workspaceRegistrationStore: {
        add,
        read: vi.fn().mockResolvedValue({ workspaces: [REAL_DIR] }),
      } as unknown as WorkspaceRegistrationStore,
    });
    const res = await request(app)
      .post('/workspaces')
      .send({ cwd: REAL_DIR, persist: true });
    expect(res.status).toBe(200);
    expect(res.body.persisted).toBe(true);
    expect(add).toHaveBeenCalledWith(REAL_DIR);
  });

  it('promotes an existing workspace without a dynamic runtime factory', async () => {
    const add = vi.fn().mockResolvedValue(true);
    const { app } = createApp({
      createWorkspaceRuntime: undefined,
      workspaceRegistrationStore: {
        add,
        read: vi.fn().mockResolvedValue({ workspaces: [] }),
      } as unknown as WorkspaceRegistrationStore,
    });
    const res = await request(app)
      .post('/workspaces')
      .send({ cwd: REAL_DIR, persist: true });

    expect(res.status).toBe(200);
    expect(res.body.persisted).toBe(true);
    expect(add).toHaveBeenCalledWith(REAL_DIR);
  });

  it('rejects persistence for the primary workspace', async () => {
    const primary = { ...makeRuntime(REAL_DIR), primary: true };
    const { app } = createApp({
      workspaceRegistry: createMockRegistry([primary]),
      workspaceRegistrationStore: {} as WorkspaceRegistrationStore,
    });

    const res = await request(app)
      .post('/workspaces')
      .send({ cwd: REAL_DIR, persist: true });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_persist_target');
  });

  it('rejects promotion of a nested active workspace', async () => {
    const { app } = createApp({
      workspaceRegistry: createMockRegistry([
        makeRuntime(realpathSync.native('/')),
        makeRuntime(REAL_DIR),
      ]),
      workspaceRegistrationStore: {} as WorkspaceRegistrationStore,
    });

    const res = await request(app)
      .post('/workspaces')
      .send({ cwd: REAL_DIR, persist: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('workspace_nested');
  });

  it('returns the documented limit error when promoting at store capacity', async () => {
    const add = vi.fn();
    const { app } = createApp({
      workspaceRegistrationStore: {
        add,
        read: vi.fn().mockResolvedValue({
          workspaces: Array.from({ length: 24 }, (_, index) => `/w/${index}`),
        }),
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app)
      .post('/workspaces')
      .send({ cwd: REAL_DIR, persist: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('workspace_limit_reached');
    expect(add).not.toHaveBeenCalled();
  });

  it('returns the limit error when a concurrent writer fills the store', async () => {
    const { app } = createApp({
      workspaceRegistrationStore: {
        read: vi.fn().mockResolvedValue({ workspaces: [] }),
        add: vi
          .fn()
          .mockRejectedValue(
            new WorkspaceRegistrationStoreLimitError('limit reached'),
          ),
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app)
      .post('/workspaces')
      .send({ cwd: REAL_DIR, persist: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('workspace_limit_reached');
  });

  it('rejects persist when no registration store is available', async () => {
    const { app } = createApp();
    const res = await request(app)
      .post('/workspaces')
      .send({ cwd: REAL_DIR, persist: true });
    expect(res.status).toBe(501);
    expect(res.body.code).toBe('persistence_not_available');
  });

  it('reports filesystem persistence failures without registering runtime', async () => {
    const registry = createMockRegistry([makeRuntime('/some-other-dir')]);
    const { app } = createApp({
      workspaceRegistry: registry,
      workspaceRegistrationStore: {
        add: vi.fn().mockRejectedValue(new Error('disk full')),
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app)
      .post('/workspaces')
      .send({ cwd: REAL_DIR, persist: true });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('workspace_registration_store_error');
    expect(registry.add).not.toHaveBeenCalled();
  });

  it('preserves runtime creation failures before persistence begins', async () => {
    const add = vi.fn();
    const { app } = createApp({
      workspaceRegistry: createMockRegistry([makeRuntime('/some-other-dir')]),
      createWorkspaceRuntime: vi
        .fn()
        .mockRejectedValue(new Error('runtime failed')),
      workspaceRegistrationStore: {
        add,
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app)
      .post('/workspaces')
      .send({ cwd: REAL_DIR, persist: true });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('runtime_creation_failed');
    expect(add).not.toHaveBeenCalled();
  });

  it('rolls back a newly persisted record when runtime registration fails', async () => {
    const runtime = makeRuntime(REAL_DIR);
    const registry = createMockRegistry([makeRuntime('/some-other-dir')]);
    registry.add = vi.fn(() => {
      throw new Error('workspace id collision');
    });
    const removeById = vi.fn().mockResolvedValue(true);
    const { app } = createApp({
      workspaceRegistry: registry,
      createWorkspaceRuntime: vi.fn().mockResolvedValue(runtime),
      workspaceRegistrationStore: {
        add: vi.fn().mockResolvedValue(true),
        removeById,
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app)
      .post('/workspaces')
      .send({ cwd: REAL_DIR, persist: true });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('runtime_creation_failed');
    expect(removeById).toHaveBeenCalledWith(
      expect.stringMatching(/^[a-f0-9]{16}$/),
    );
    expect(runtime.bridge.shutdown).toHaveBeenCalledTimes(1);
  });
});

describe('DELETE /workspaces/:workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('validates force and protects primary and static runtimes', async () => {
    const primary = makeRuntime(REAL_DIR, {
      primary: true,
      removable: false,
    });
    const runtimeRemoval = createRemovalController();
    const primaryApp = createApp({
      workspaceRegistry: createMockRegistry([primary]),
      runtimeRemoval,
    }).app;

    const invalid = await request(primaryApp)
      .delete(`/workspaces/${encodeURIComponent(primary.workspaceId)}`)
      .send({ force: 'yes' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('invalid_force_flag');

    const forbidden = await request(primaryApp).delete(
      `/workspaces/${encodeURIComponent(primary.workspaceId)}`,
    );
    expect(forbidden.status).toBe(409);
    expect(forbidden.body.code).toBe('primary_workspace_removal_forbidden');

    const staticRuntime = makeRuntime(REAL_DIR, { removable: false });
    const staticApp = createApp({
      workspaceRegistry: createMockRegistry([staticRuntime]),
      runtimeRemoval,
    }).app;
    const staticResult = await request(staticApp).delete(
      `/workspaces/${encodeURIComponent(staticRuntime.workspaceId)}`,
    );
    expect(staticResult.status).toBe(409);
    expect(staticResult.body.code).toBe('static_workspace_removal_forbidden');
  });

  it('does not expose workspace counts for an unknown removal selector', async () => {
    const { app } = createApp({
      runtimeRemoval: createRemovalController(),
    });

    const res = await request(app).delete('/workspaces/unknown-workspace');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('workspace_mismatch');
    expect(res.body).not.toHaveProperty('workspaceCount');
  });

  it('returns the fast busy snapshot without disturbing runtime gates', async () => {
    const runtime = makeRuntime(REAL_DIR);
    Object.assign(runtime.bridge, { sessionCount: 1, activePromptCount: 1 });
    const runtimeRemoval = createRemovalController();
    const { app, deps } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
      runtimeRemoval,
    });

    const res = await request(app).delete(
      `/workspaces/${encodeURIComponent(runtime.workspaceId)}`,
    );

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'workspace_busy',
      activity: { sessions: 1, activePrompts: 1 },
    });
    expect(runtimeRemoval.beginDrain).not.toHaveBeenCalled();
    expect(deps.workspaceRegistry.beginDrain).not.toHaveBeenCalled();
  });

  it('rolls every gate back when the final frozen snapshot becomes busy', async () => {
    const runtime = makeRuntime(REAL_DIR);
    const runtimeRemoval = createRemovalController();
    vi.mocked(runtimeRemoval.getActivity)
      .mockReturnValueOnce({ pendingSessionStarts: 0, channelWorkers: 0 })
      .mockReturnValueOnce({ pendingSessionStarts: 1, channelWorkers: 0 });
    const acpHandle = {
      beginWorkspaceDrain: vi.fn(),
      cancelWorkspaceDrain: vi.fn(),
      getWorkspaceActivity: vi.fn(() => ({
        acpConnections: 0,
        memoryTasks: 0,
      })),
    };
    const { app, deps } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
      runtimeRemoval,
      getAcpHandle: () => acpHandle as never,
    });

    const res = await request(app).delete(
      `/workspaces/${encodeURIComponent(runtime.workspaceId)}`,
    );

    expect(res.status).toBe(409);
    expect(res.body.activity.pendingSessionStarts).toBe(1);
    expect(acpHandle.beginWorkspaceDrain).toHaveBeenCalledWith(
      runtime.workspaceId,
    );
    expect(acpHandle.cancelWorkspaceDrain).toHaveBeenCalledWith(
      runtime.workspaceId,
    );
    expect(runtimeRemoval.cancelDrain).toHaveBeenCalledWith(runtime);
    expect(deps.workspaceRegistry.cancelDrain).toHaveBeenCalledWith(runtime);
    expect(deps.workspaceRegistry.getByWorkspaceId(runtime.workspaceId)).toBe(
      runtime,
    );
  });

  it('rolls drain back when persistent identity removal fails', async () => {
    const runtime = makeRuntime(REAL_DIR);
    const runtimeRemoval = createRemovalController();
    const { app, deps } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
      runtimeRemoval,
      workspaceRegistrationStore: {
        removeByIds: vi.fn().mockRejectedValue(new Error('disk full')),
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app).delete(
      `/workspaces/${encodeURIComponent(runtime.workspaceId)}`,
    );

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('workspace_persist_failed');
    expect(runtimeRemoval.cancelDrain).toHaveBeenCalledWith(runtime);
    expect(runtimeRemoval.disposeRuntime).not.toHaveBeenCalled();
    expect(deps.workspaceRegistry.getByWorkspaceId(runtime.workspaceId)).toBe(
      runtime,
    );
  });

  it('force-removes activity, aliases, runtime resources, and registry state', async () => {
    const runtime = makeRuntime(REAL_DIR, {
      registrationIds: ['raw-alias-a', 'raw-alias-b'],
    });
    Object.assign(runtime.bridge, { sessionCount: 2, activePromptCount: 1 });
    const runtimeRemoval = createRemovalController(1);
    const removeByIds = vi.fn().mockResolvedValue(2);
    const acpHandle = {
      beginWorkspaceDrain: vi.fn(),
      cancelWorkspaceDrain: vi.fn(),
      getWorkspaceActivity: vi.fn(() => ({
        acpConnections: 1,
        memoryTasks: 1,
      })),
      commitWorkspaceRemoval: vi.fn(),
      disposeWorkspace: vi.fn(),
    };
    const { app, deps } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
      runtimeRemoval,
      getAcpHandle: () => acpHandle as never,
      workspaceRegistrationStore: {
        removeByIds,
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app)
      .delete(`/workspaces/${encodeURIComponent(runtime.workspaceId)}`)
      .send({ force: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      removed: true,
      workspaceId: runtime.workspaceId,
      forced: true,
      persistedRegistrationRemoved: true,
      activity: {
        sessions: 2,
        activePrompts: 1,
        pendingSessionStarts: 1,
        acpConnections: 1,
        memoryTasks: 1,
      },
    });
    expect(removeByIds).toHaveBeenCalledWith(
      expect.arrayContaining([
        'raw-alias-a',
        'raw-alias-b',
        workspaceRegistrationId(runtime.workspaceCwd),
      ]),
    );
    expect(runtimeRemoval.disposeRuntime).toHaveBeenCalledWith(
      runtime,
      'workspace_removed',
    );
    expect(runtimeRemoval.completeDrain).toHaveBeenCalledWith(runtime);
    expect(acpHandle.commitWorkspaceRemoval).toHaveBeenCalledWith(
      runtime.workspaceId,
    );
    expect(acpHandle.disposeWorkspace).toHaveBeenCalledWith(
      runtime.workspaceId,
    );
    expect(
      deps.workspaceRegistry.getManagedByWorkspaceId(runtime.workspaceId),
    ).toBeUndefined();
  });

  it('does not reactivate a runtime when cleanup fails after persistence commits', async () => {
    const runtime = makeRuntime(REAL_DIR);
    Object.assign(runtime.bridge, { sessionCount: 1 });
    const runtimeRemoval = createRemovalController();
    vi.mocked(runtimeRemoval.disposeRuntime).mockRejectedValueOnce(
      new Error('bridge cleanup failed'),
    );
    const acpHandle = {
      beginWorkspaceDrain: vi.fn(),
      cancelWorkspaceDrain: vi.fn(),
      getWorkspaceActivity: vi.fn(() => ({
        acpConnections: 0,
        memoryTasks: 0,
      })),
      commitWorkspaceRemoval: vi.fn(() => {
        throw new Error('commit cleanup failed');
      }),
      disposeWorkspace: vi.fn(() => {
        throw new Error('mount cleanup failed');
      }),
    };
    const { app, deps } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
      runtimeRemoval,
      getAcpHandle: () => acpHandle as never,
      workspaceRegistrationStore: {
        removeByIds: vi.fn().mockResolvedValue(1),
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app)
      .delete(`/workspaces/${encodeURIComponent(runtime.workspaceId)}`)
      .send({ force: true });

    expect(res.status).toBe(200);
    expect(res.body.forced).toBe(true);
    expect(runtimeRemoval.disposeRuntime).toHaveBeenCalledWith(
      runtime,
      'workspace_removed',
    );
    expect(runtimeRemoval.cancelDrain).not.toHaveBeenCalled();
    expect(runtimeRemoval.completeDrain).toHaveBeenCalledWith(runtime);
    expect(acpHandle.cancelWorkspaceDrain).not.toHaveBeenCalled();
    expect(runtime.bridge.killAllSync).toHaveBeenCalledOnce();
    expect(deps.workspaceRegistry.cancelDrain).not.toHaveBeenCalled();
    expect(
      deps.workspaceRegistry.getManagedByWorkspaceId(runtime.workspaceId),
    ).toBeUndefined();
  });

  it('accepts a URL-encoded absolute cwd selector', async () => {
    const runtime = makeRuntime(REAL_DIR);
    const { app, deps } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
      runtimeRemoval: createRemovalController(),
    });

    const res = await request(app).delete(
      `/workspaces/${encodeURIComponent(runtime.workspaceCwd)}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.workspaceCwd).toBe(runtime.workspaceCwd);
    expect(
      deps.workspaceRegistry.getManagedByWorkspaceCwd(runtime.workspaceCwd),
    ).toBeUndefined();
  });

  it('canonicalizes a symlink cwd selector before removal', async () => {
    const selectorRoot = await mkdtemp(join(REAL_DIR, 'qws-selector-'));
    const selector = join(selectorRoot, 'workspace-alias');
    await symlink(REAL_DIR, selector, 'dir');
    const runtime = makeRuntime(REAL_DIR);
    const { app, deps } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
      runtimeRemoval: createRemovalController(),
    });

    try {
      const res = await request(app).delete(
        `/workspaces/${encodeURIComponent(selector)}`,
      );

      expect(res.status).toBe(200);
      expect(res.body.workspaceCwd).toBe(runtime.workspaceCwd);
      expect(
        deps.workspaceRegistry.getManagedByWorkspaceCwd(runtime.workspaceCwd),
      ).toBeUndefined();
    } finally {
      await rm(selectorRoot, { recursive: true, force: true });
    }
  });

  it('reserves the cwd against concurrent remove and add operations', async () => {
    const runtime = makeRuntime(REAL_DIR);
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const runtimeRemoval = createRemovalController();
    vi.mocked(runtimeRemoval.disposeRuntime).mockReturnValue(cleanup);
    const { app } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
      runtimeRemoval,
    });

    const firstRemoval = request(app).delete(
      `/workspaces/${encodeURIComponent(runtime.workspaceId)}`,
    );
    const firstResult = firstRemoval.then((res) => res);
    await vi.waitFor(() => {
      expect(runtimeRemoval.disposeRuntime).toHaveBeenCalledWith(
        runtime,
        'workspace_removed',
      );
    });

    const duplicateRemoval = await request(app).delete(
      `/workspaces/${encodeURIComponent(runtime.workspaceId)}`,
    );
    expect(duplicateRemoval.status).toBe(409);
    expect(duplicateRemoval.body.code).toBe('workspace_removal_in_progress');

    const concurrentAdd = await request(app)
      .post('/workspaces')
      .send({ cwd: runtime.workspaceCwd });
    expect(concurrentAdd.status).toBe(409);
    expect(concurrentAdd.body.code).toBe('workspace_removal_in_progress');

    finishCleanup();
    expect((await firstResult).status).toBe(200);
    const replacement = await request(app)
      .post('/workspaces')
      .send({ cwd: runtime.workspaceCwd });
    expect(replacement.status).toBe(201);
  });

  it('waits for an in-flight removal after sealing and rejects new work', async () => {
    const runtime = makeRuntime(REAL_DIR);
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const runtimeRemoval = createRemovalController();
    vi.mocked(runtimeRemoval.disposeRuntime).mockReturnValue(cleanup);
    const { app, handle } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
      runtimeRemoval,
    });
    const removal = request(app).delete(
      `/workspaces/${encodeURIComponent(runtime.workspaceId)}`,
    );
    const removalResult = removal.then((res) => res);
    await vi.waitFor(() => {
      expect(runtimeRemoval.disposeRuntime).toHaveBeenCalled();
    });

    let sealed = false;
    const seal = handle.sealAndWait().then(() => {
      sealed = true;
    });
    await Promise.resolve();
    expect(sealed).toBe(false);
    const rejected = await request(app)
      .post('/workspaces')
      .send({ cwd: runtime.workspaceCwd });
    expect(rejected.status).toBe(503);

    finishCleanup();
    expect((await removalResult).status).toBe(200);
    await seal;
    expect(sealed).toBe(true);
  });

  it('finishes sealing when an in-flight removal fails', async () => {
    const runtime = makeRuntime(REAL_DIR);
    let failPersistence!: (error: Error) => void;
    const persistence = new Promise<number>((_resolve, reject) => {
      failPersistence = reject;
    });
    const removeByIds = vi.fn().mockReturnValue(persistence);
    const { app, handle } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
      runtimeRemoval: createRemovalController(),
      workspaceRegistrationStore: {
        removeByIds,
      } as unknown as WorkspaceRegistrationStore,
    });
    const removal = request(app).delete(
      `/workspaces/${encodeURIComponent(runtime.workspaceId)}`,
    );
    const removalResult = removal.then((res) => res);
    await vi.waitFor(() => expect(removeByIds).toHaveBeenCalledOnce());

    let sealed = false;
    const seal = handle.sealAndWait().then(() => {
      sealed = true;
    });
    await Promise.resolve();
    expect(sealed).toBe(false);

    failPersistence(new Error('disk full'));
    const result = await removalResult;
    expect(result.status).toBe(500);
    expect(result.body.code).toBe('workspace_persist_failed');
    await seal;
    expect(sealed).toBe(true);
  });

  it('returns a coded error when removal fails before persistence commits', async () => {
    const runtime = makeRuntime(REAL_DIR);
    const registry = createMockRegistry([runtime]);
    vi.mocked(registry.beginDrain).mockImplementationOnce(() => {
      throw new Error('drain failed');
    });
    const { app } = createApp({
      workspaceRegistry: registry,
      runtimeRemoval: createRemovalController(),
    });

    const res = await request(app).delete(
      `/workspaces/${encodeURIComponent(runtime.workspaceId)}`,
    );

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('workspace_runtime_removal_failed');
  });

  it('rejects removal after workspace management is sealed', async () => {
    const runtime = makeRuntime(REAL_DIR);
    const { app, handle } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
      runtimeRemoval: createRemovalController(),
    });
    await handle.sealAndWait();

    const res = await request(app).delete(
      `/workspaces/${encodeURIComponent(runtime.workspaceId)}`,
    );

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('daemon_shutting_down');
  });
});

describe('persistent workspace registrations', () => {
  it('returns 501 for registration management without a store', async () => {
    const { app } = createApp();

    const list = await request(app).get('/workspace-registrations');
    expect(list.status).toBe(501);
    expect(list.body.code).toBe('persistence_not_available');

    const remove = await request(app).delete(
      '/workspace-registrations/missing',
    );
    expect(remove.status).toBe(501);
    expect(remove.body.code).toBe('persistence_not_available');
  });

  it('lists desired registrations and whether they are active', async () => {
    const alias = '/raw/symlink-alias';
    const aliasId = workspaceRegistrationId(alias);
    const read = vi.fn().mockResolvedValue({
      schemaVersion: 1,
      primaryWorkspace: '/primary',
      workspaces: [REAL_DIR, alias, '/currently-unavailable'],
    });
    const { app } = createApp({
      workspaceRegistry: createMockRegistry([
        makeRuntime(REAL_DIR, { registrationIds: [aliasId] }),
      ]),
      workspaceRegistrationStore: {
        read,
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app).get('/workspace-registrations');

    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([
      expect.objectContaining({
        id: workspaceRegistrationId(REAL_DIR),
        cwd: REAL_DIR,
        active: true,
        persisted: true,
      }),
      expect.objectContaining({
        id: aliasId,
        cwd: alias,
        active: true,
        persisted: true,
      }),
      expect.objectContaining({
        cwd: '/currently-unavailable',
        active: false,
        persisted: true,
      }),
    ]);
  });

  it('forgets persistence without unloading an active runtime', async () => {
    const aliasId = workspaceRegistrationId('/raw/symlink-alias');
    const active = makeRuntime(REAL_DIR, { registrationIds: [aliasId] });
    const removeById = vi.fn().mockResolvedValue(true);
    const { app } = createApp({
      workspaceRegistry: createMockRegistry([active]),
      workspaceRegistrationStore: {
        removeById,
      } as unknown as WorkspaceRegistrationStore,
    });
    const registrationId = workspaceRegistrationId(REAL_DIR);

    const res = await request(app).delete(
      `/workspace-registrations/${registrationId}`,
    );

    expect(res.status).toBe(200);
    expect(removeById).toHaveBeenCalledWith(registrationId);
    expect(res.body).toEqual({
      removed: true,
      active: true,
      restartRequired: true,
    });

    const aliasResult = await request(app).delete(
      `/workspace-registrations/${aliasId}`,
    );
    expect(aliasResult.status).toBe(200);
    expect(aliasResult.body).toMatchObject({
      removed: true,
      active: true,
      restartRequired: true,
    });
  });

  it('treats a draining runtime registration as active', async () => {
    const active = makeRuntime(REAL_DIR);
    const registry = createMockRegistry([active]);
    expect(registry.beginDrain(active)).toBe(true);
    const { app } = createApp({
      workspaceRegistry: registry,
      workspaceRegistrationStore: {
        removeById: vi.fn().mockResolvedValue(true),
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app).delete(
      `/workspace-registrations/${workspaceRegistrationId(REAL_DIR)}`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      active: true,
      restartRequired: true,
    });
  });

  it('returns 404 when a registration does not exist', async () => {
    const { app } = createApp({
      workspaceRegistrationStore: {
        removeById: vi.fn().mockResolvedValue(false),
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app).delete('/workspace-registrations/missing');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('workspace_registration_not_found');
  });

  it('returns a store error when registrations cannot be read', async () => {
    const { app } = createApp({
      workspaceRegistrationStore: {
        read: vi.fn().mockRejectedValue(new Error('read failed')),
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app).get('/workspace-registrations');

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('workspace_registration_store_error');
  });

  it('returns a store error when a registration cannot be forgotten', async () => {
    const { app } = createApp({
      workspaceRegistrationStore: {
        removeById: vi.fn().mockRejectedValue(new Error('write failed')),
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app).delete('/workspace-registrations/id');

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('workspace_registration_store_error');
  });

  it('waits for an in-flight forget after sealing and rejects another one', async () => {
    let finishForget!: () => void;
    const forgetting = new Promise<boolean>((resolve) => {
      finishForget = () => resolve(true);
    });
    const removeById = vi.fn().mockReturnValueOnce(forgetting);
    const { app, handle } = createApp({
      workspaceRegistrationStore: {
        removeById,
      } as unknown as WorkspaceRegistrationStore,
    });
    const first = request(app).delete('/workspace-registrations/first');
    const firstResult = first.then((res) => res);
    await vi.waitFor(() => expect(removeById).toHaveBeenCalledOnce());

    let sealed = false;
    const seal = handle.sealAndWait().then(() => {
      sealed = true;
    });
    await Promise.resolve();
    expect(sealed).toBe(false);
    const second = await request(app).delete('/workspace-registrations/second');
    expect(second.status).toBe(503);
    expect(second.body.code).toBe('daemon_shutting_down');

    finishForget();
    expect((await firstResult).status).toBe(200);
    await seal;
    expect(sealed).toBe(true);
  });
});
