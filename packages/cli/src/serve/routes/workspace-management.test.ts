/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _setSandboxMountExistsForTest } from '@qwen-code/acp-bridge/workspacePaths';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import {
  registerWorkspaceManagementRoutes,
  type WorkspaceManagementRouteDeps,
  type WorkspaceRuntimeRemovalController,
} from './workspace-management.js';
import { NativeDirectoryPickerUnavailableError } from '../native-directory-picker.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  workspaceRegistrationId,
  WorkspaceRegistrationStoreCommittedError,
  WorkspaceRegistrationStoreLimitError,
  type WorkspaceRegistrationStore,
} from '../workspace-registration-store.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { prepareManagedScratchRoot } from '../managed-scratch-workspace.js';

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
    syncRuntimeMetadata: vi.fn((runtime: WorkspaceRuntime) => {
      const current = byCwd.get(runtime.workspaceCwd);
      if (!current || current === runtime) return;
      if (runtime.displayName === undefined) {
        delete current.displayName;
      } else {
        current.displayName = runtime.displayName;
      }
      current.registrationIds = [...(runtime.registrationIds ?? [])];
    }),
    resolveWorkspaceCwd: () => undefined,
    resolveLiveSessionOwner: () => ({ kind: 'not_found' }),
    beginDrain: vi.fn((runtime: WorkspaceRuntime) => {
      if (draining.has(runtime)) return false;
      draining.add(runtime);
      return true;
    }),
    cancelDrain: vi.fn((runtime: WorkspaceRuntime) => draining.delete(runtime)),
    commitDrain: vi.fn(),
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
    getActivity: vi.fn(() => ({
      pendingSessionStarts,
      channelWorkers: 0,
      voiceSessions: 0,
    })),
    disposeRuntime: vi.fn().mockResolvedValue(undefined),
  };
}

describe('owned workspace runtime publication', () => {
  it('allows only the daemon-owned Live runtime to nest under the primary workspace', async () => {
    const registry = createMockRegistry([
      makeRuntime('/Users/test', { primary: true }),
    ]);
    const runtime = makeRuntime(
      '/Users/test/Documents/Qwen Code/Conversations',
      {
        provenance: 'live-conversation',
        removable: false,
      },
    );
    const runtimeRemoval = createRemovalController();
    const { handle } = createApp({
      workspaceRegistry: registry,
      createWorkspaceRuntime: vi.fn().mockResolvedValue(runtime),
      runtimeRemoval,
    });

    await expect(
      handle.publishOwnedRuntime(
        runtime.workspaceCwd,
        'live-conversation',
        () => undefined,
      ),
    ).resolves.toBe(runtime);
    expect(registry.getByWorkspaceCwd(runtime.workspaceCwd)).toBe(runtime);
  });

  it('keeps nested owned runtimes blocked for non-Live provenance', async () => {
    const registry = createMockRegistry([
      makeRuntime('/Users/test', { primary: true }),
    ]);
    const runtime = makeRuntime('/Users/test/nested-scratch', {
      provenance: 'managed-scratch',
    });
    const createWorkspaceRuntime = vi.fn().mockResolvedValue(runtime);
    const { handle } = createApp({
      workspaceRegistry: registry,
      createWorkspaceRuntime,
      runtimeRemoval: createRemovalController(),
    });

    await expect(
      handle.publishOwnedRuntime(
        runtime.workspaceCwd,
        'managed-scratch',
        () => undefined,
      ),
    ).rejects.toThrow('nests with an existing workspace');
    expect(createWorkspaceRuntime).not.toHaveBeenCalled();
  });

  it('does not let the Live root contain an existing workspace', async () => {
    const registry = createMockRegistry([
      makeRuntime('/Users/test/Documents/Qwen Code/Conversations/project', {
        primary: true,
      }),
    ]);
    const runtime = makeRuntime(
      '/Users/test/Documents/Qwen Code/Conversations',
      {
        provenance: 'live-conversation',
        removable: false,
      },
    );
    const createWorkspaceRuntime = vi.fn().mockResolvedValue(runtime);
    const { handle } = createApp({
      workspaceRegistry: registry,
      createWorkspaceRuntime,
      runtimeRemoval: createRemovalController(),
    });

    await expect(
      handle.publishOwnedRuntime(
        runtime.workspaceCwd,
        'live-conversation',
        () => undefined,
      ),
    ).rejects.toThrow('nests with an existing workspace');
    expect(createWorkspaceRuntime).not.toHaveBeenCalled();
  });

  it('shares registry publication and runtime-added hooks', async () => {
    const registry = createMockRegistry([
      makeRuntime('/primary', { primary: true }),
    ]);
    const runtime = makeRuntime('/owned-live', {
      provenance: 'live-conversation',
      removable: false,
    });
    const runtimeRemoval = createRemovalController();
    runtimeRemoval.runtimeAdded = vi.fn().mockResolvedValue(undefined);
    const { handle } = createApp({
      workspaceRegistry: registry,
      createWorkspaceRuntime: vi.fn().mockResolvedValue(runtime),
      runtimeRemoval,
    });

    await expect(
      handle.publishOwnedRuntime(
        runtime.workspaceCwd,
        'live-conversation',
        (candidate) => {
          expect(candidate).toBe(runtime);
        },
      ),
    ).resolves.toBe(runtime);

    expect(registry.getByWorkspaceCwd(runtime.workspaceCwd)).toBe(runtime);
    expect(runtimeRemoval.runtimeAdded).toHaveBeenCalledWith(runtime);
    expect(runtimeRemoval.disposeRuntime).not.toHaveBeenCalled();
  });

  it('immediately disposes a candidate rejected before publication', async () => {
    const registry = createMockRegistry([
      makeRuntime('/primary', { primary: true }),
    ]);
    const runtime = makeRuntime('/owned-invalid', {
      provenance: 'live-conversation',
      removable: false,
    });
    const runtimeRemoval = createRemovalController();
    const { handle } = createApp({
      workspaceRegistry: registry,
      createWorkspaceRuntime: vi.fn().mockResolvedValue(runtime),
      runtimeRemoval,
    });

    await expect(
      handle.publishOwnedRuntime(
        runtime.workspaceCwd,
        'live-conversation',
        () => {
          throw new Error('ownership rejected');
        },
      ),
    ).rejects.toThrow('ownership rejected');

    expect(registry.getManagedByWorkspaceCwd(runtime.workspaceCwd)).toBe(
      undefined,
    );
    expect(runtimeRemoval.disposeRuntime).toHaveBeenCalledWith(
      runtime,
      'workspace_removed',
    );
  });

  it('rejects and disposes a primary owned-runtime candidate', async () => {
    const registry = createMockRegistry([
      makeRuntime('/primary', { primary: true }),
    ]);
    const runtime = makeRuntime('/owned-primary', {
      primary: true,
      provenance: 'live-conversation',
      removable: false,
    });
    const runtimeRemoval = createRemovalController();
    const { handle } = createApp({
      workspaceRegistry: registry,
      createWorkspaceRuntime: vi.fn().mockResolvedValue(runtime),
      runtimeRemoval,
    });

    await expect(
      handle.publishOwnedRuntime(
        runtime.workspaceCwd,
        'live-conversation',
        () => undefined,
      ),
    ).rejects.toThrow('Daemon-owned workspace runtime must not be primary');

    expect(registry.add).not.toHaveBeenCalled();
    expect(registry.getManagedByWorkspaceCwd(runtime.workspaceCwd)).toBe(
      undefined,
    );
    expect(runtimeRemoval.disposeRuntime).toHaveBeenCalledWith(
      runtime,
      'workspace_removed',
    );
  });

  it('disposes a candidate rejected by final pre-publication validation', async () => {
    const registry = createMockRegistry([
      makeRuntime('/primary', { primary: true }),
    ]);
    const runtime = makeRuntime('/owned-invalid-before-publication', {
      provenance: 'live-conversation',
      removable: false,
    });
    const runtimeRemoval = createRemovalController();
    runtimeRemoval.runtimeAdded = vi.fn().mockResolvedValue(undefined);
    const validate = vi
      .fn()
      .mockRejectedValueOnce(new Error('root changed before publication'));
    const { handle } = createApp({
      workspaceRegistry: registry,
      createWorkspaceRuntime: vi.fn().mockResolvedValue(runtime),
      runtimeRemoval,
    });

    await expect(
      handle.publishOwnedRuntime(
        runtime.workspaceCwd,
        'live-conversation',
        validate,
      ),
    ).rejects.toThrow('root changed before publication');

    expect(validate).toHaveBeenCalledOnce();
    expect(registry.getManagedByWorkspaceCwd(runtime.workspaceCwd)).toBe(
      undefined,
    );
    expect(runtimeRemoval.runtimeAdded).not.toHaveBeenCalled();
    expect(runtimeRemoval.disposeRuntime).toHaveBeenCalledWith(
      runtime,
      'workspace_removed',
    );
  });

  it('keeps a candidate unpublished and the topology lock free during final validation', async () => {
    const registry = createMockRegistry([
      makeRuntime('/primary', { primary: true }),
    ]);
    const runtime = makeRuntime('/owned-pending-validation', {
      provenance: 'live-conversation',
      removable: false,
    });
    let releaseValidation: (() => void) | undefined;
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const validate = vi.fn(async () => validationGate);
    const runWorkspaceTrustOperation = vi.fn(async (operation) => operation());
    const { handle } = createApp({
      workspaceRegistry: registry,
      createWorkspaceRuntime: vi.fn().mockResolvedValue(runtime),
      runtimeRemoval: createRemovalController(),
      runWorkspaceTrustOperation,
    });

    const publication = handle.publishOwnedRuntime(
      runtime.workspaceCwd,
      'live-conversation',
      validate,
    );
    await vi.waitFor(() => expect(validate).toHaveBeenCalledOnce());
    expect(registry.getByWorkspaceCwd(runtime.workspaceCwd)).toBeUndefined();
    expect(
      registry.getManagedByWorkspaceCwd(runtime.workspaceCwd),
    ).toBeUndefined();
    expect(registry.add).not.toHaveBeenCalled();
    expect(runWorkspaceTrustOperation).not.toHaveBeenCalled();

    releaseValidation?.();
    await expect(publication).resolves.toBe(runtime);
    expect(registry.add).toHaveBeenCalledOnce();
    expect(runWorkspaceTrustOperation).toHaveBeenCalledTimes(1);
    expect(registry.getByWorkspaceCwd(runtime.workspaceCwd)).toBe(runtime);
  });
});

describe('owned Conversations runtime quarantine', () => {
  it('drains and disposes the internal runtime without persistence or rollback', async () => {
    const runtime = makeRuntime('/owned-live', {
      provenance: 'live-conversation',
      removable: false,
    });
    const registry = createMockRegistry([runtime]);
    const runtimeRemoval = createRemovalController();
    const { handle } = createApp({
      workspaceRegistry: registry,
      runtimeRemoval,
    });

    await expect(
      handle.quarantineOwnedRuntime(runtime),
    ).resolves.toBeUndefined();

    expect(registry.beginDrain).toHaveBeenCalledWith(runtime);
    expect(runtimeRemoval.beginDrain).toHaveBeenCalledWith(runtime);
    expect(registry.commitDrain).toHaveBeenCalledWith(runtime);
    expect(runtimeRemoval.disposeRuntime).toHaveBeenCalledWith(
      runtime,
      'workspace_removed',
    );
    expect(runtimeRemoval.completeDrain).toHaveBeenCalledWith(runtime);
    expect(registry.completeDrain).toHaveBeenCalledWith(runtime);
    expect(runtimeRemoval.cancelDrain).not.toHaveBeenCalled();
    expect(registry.cancelDrain).not.toHaveBeenCalled();
    expect(
      registry.getManagedByWorkspaceId(runtime.workspaceId),
    ).toBeUndefined();
  });

  it('keeps the runtime draining when disposal cannot be proven', async () => {
    const runtime = makeRuntime('/owned-live', {
      provenance: 'live-conversation',
      removable: false,
    });
    const registry = createMockRegistry([runtime]);
    const runtimeRemoval = createRemovalController();
    vi.mocked(runtimeRemoval.disposeRuntime).mockRejectedValueOnce(
      new Error('dispose failed'),
    );
    const { handle } = createApp({
      workspaceRegistry: registry,
      runtimeRemoval,
    });

    await expect(handle.quarantineOwnedRuntime(runtime)).rejects.toThrow(
      'Failed to quarantine the Conversations runtime',
    );

    expect(runtimeRemoval.completeDrain).not.toHaveBeenCalled();
    expect(registry.completeDrain).not.toHaveBeenCalled();
    expect(runtimeRemoval.cancelDrain).not.toHaveBeenCalled();
    expect(registry.cancelDrain).not.toHaveBeenCalled();
    expect(registry.getByWorkspaceId(runtime.workspaceId)).toBeUndefined();
    expect(registry.getManagedByWorkspaceId(runtime.workspaceId)).toBe(runtime);
  });

  it('rejects non-Conversations runtimes before touching drain state', async () => {
    const runtime = makeRuntime('/ordinary', {
      provenance: 'existing',
      removable: true,
    });
    const registry = createMockRegistry([runtime]);
    const runtimeRemoval = createRemovalController();
    const { handle } = createApp({
      workspaceRegistry: registry,
      runtimeRemoval,
    });

    await expect(handle.quarantineOwnedRuntime(runtime)).rejects.toThrow(
      'Only the owned Conversations runtime may be quarantined',
    );
    expect(registry.beginDrain).not.toHaveBeenCalled();
    expect(runtimeRemoval.beginDrain).not.toHaveBeenCalled();
  });
});

describe('POST /workspaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reserves the Conversations root and its children but allows its parent', async () => {
    const parent = await mkdtemp(join(REAL_DIR, 'qws-conversations-reserved-'));
    const reserved = join(parent, 'conversations');
    const child = join(reserved, 'child');
    const missingChild = join(reserved, 'missing');
    const alias = join(parent, 'conversation-alias');
    await mkdir(child, { recursive: true });
    await symlink(reserved, alias, 'dir');
    try {
      const { app } = createApp({
        workspaceRegistry: createMockRegistry([
          makeRuntime('/unrelated-primary', { primary: true }),
        ]),
        reservedWorkspaceRoots: [reserved],
        runtimeRemoval: createRemovalController(),
      });

      for (const cwd of [reserved, child, missingChild, alias]) {
        const response = await request(app)
          .post('/workspaces')
          .send({ cwd, persist: false });
        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({
          code: 'conversation_workspace_reserved',
        });
      }

      await expect(
        request(app).post('/workspaces').send({ cwd: parent, persist: false }),
      ).resolves.toMatchObject({ status: 201 });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('allows scratch creation but protects existing paths in loopback development', async () => {
    const parent = await mkdtemp(join(REAL_DIR, 'qws-scratch-route-'));
    try {
      const root = prepareManagedScratchRoot(join(parent, 'root'), []);
      const mutate = vi.fn(
        (options?: { strict?: boolean }) =>
          (_req: Request, res: Response, next: () => void) => {
            if (options?.strict) {
              res.status(401).json({ code: 'token_required' });
              return;
            }
            next();
          },
      );
      const { app } = createApp({
        workspaceRegistry: createMockRegistry([makeRuntime('/workspace')]),
        managedScratchRoot: root,
        runtimeRemoval: createRemovalController(),
        mutate,
      });

      const scratch = await request(app)
        .post('/workspaces')
        .send({ kind: 'scratch' });
      const existing = await request(app)
        .post('/workspaces')
        .send({ cwd: REAL_DIR });

      expect(scratch.status).toBe(201);
      expect(existing.status).toBe(401);
      expect(mutate).toHaveBeenCalledWith();
      expect(mutate).toHaveBeenCalledWith({ strict: true });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('does not let the internal Conversations runtime block scratch creation', async () => {
    const parent = await mkdtemp(join(REAL_DIR, 'qws-scratch-live-route-'));
    try {
      const root = prepareManagedScratchRoot(join(parent, 'root'), []);
      const internal = makeRuntime(root.canonicalRoot, {
        provenance: 'live-conversation',
      });
      const { app } = createApp({
        workspaceRegistry: createMockRegistry([
          makeRuntime('/workspace', { primary: true }),
          internal,
        ]),
        managedScratchRoot: root,
        runtimeRemoval: createRemovalController(),
      });

      const response = await request(app)
        .post('/workspaces')
        .send({ kind: 'scratch' });

      expect(response.status).toBe(201);
      expect(response.body.cwd).toMatch(/scratch-/u);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
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

  it.each([
    { kind: 'unknown' },
    { kind: 'scratch', cwd: REAL_DIR },
    { kind: 'scratch', persist: false },
    { kind: 'scratch', displayName: 'Scratch' },
    { kind: 'scratch', extra: true },
  ])('rejects invalid discriminated requests: %j', async (body) => {
    const { app } = createApp();
    const res = await request(app).post('/workspaces').send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_workspace_request');
  });

  it('returns 501 when the complete scratch ownership contract is absent', async () => {
    const { app } = createApp();
    const res = await request(app)
      .post('/workspaces')
      .send({ kind: 'scratch' });
    expect(res.status).toBe(501);
    expect(res.body.code).toBe('scratch_not_available');
  });

  it('creates a trusted ephemeral runtime with managed provenance', async () => {
    const parent = await mkdtemp(join(REAL_DIR, 'qws-scratch-route-'));
    try {
      const root = prepareManagedScratchRoot(join(parent, 'root'), []);
      const runtimeRemoval = createRemovalController();
      const factory = vi.fn((cwd: string) =>
        Promise.resolve(makeRuntime(cwd, { trusted: true })),
      );
      const storeAdd = vi.fn();
      const { app, deps } = createApp({
        workspaceRegistry: createMockRegistry([makeRuntime('/workspace')]),
        createWorkspaceRuntime: factory,
        managedScratchRoot: root,
        runtimeRemoval,
        workspaceRegistrationStore: {
          add: storeAdd,
        } as unknown as WorkspaceRegistrationStore,
      });

      const res = await request(app)
        .post('/workspaces')
        .send({ kind: 'scratch' });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        primary: false,
        trusted: true,
        persisted: false,
      });
      expect(factory).toHaveBeenCalledWith(res.body.cwd, {
        provenance: 'managed-scratch',
      });
      expect(deps.workspaceRegistry.add).toHaveBeenCalledOnce();
      expect(storeAdd).not.toHaveBeenCalled();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('re-registers a scratch child as existing without restoring managed trust', async () => {
    const parent = await mkdtemp(join(REAL_DIR, 'qws-scratch-route-'));
    try {
      const root = prepareManagedScratchRoot(join(parent, 'root'), []);
      const retained = join(root.canonicalRoot, 'scratch-retained');
      await mkdir(retained);
      const factory = vi.fn((cwd: string, options: { provenance: string }) =>
        Promise.resolve(
          makeRuntime(cwd, {
            trusted: options.provenance === 'managed-scratch',
          }),
        ),
      );
      const { app } = createApp({
        workspaceRegistry: createMockRegistry([makeRuntime('/workspace')]),
        createWorkspaceRuntime: factory,
        managedScratchRoot: root,
        runtimeRemoval: createRemovalController(),
      });

      const existing = await request(app)
        .post('/workspaces')
        .send({ cwd: retained });
      const sibling = await request(app)
        .post('/workspaces')
        .send({ kind: 'scratch' });

      expect(existing.status).toBe(201);
      expect(existing.body.trusted).toBe(false);
      expect(sibling.status).toBe(201);
      expect(sibling.body.trusted).toBe(true);
      expect(factory).toHaveBeenNthCalledWith(1, retained, {
        provenance: 'existing',
      });
      expect(factory).toHaveBeenNthCalledWith(2, sibling.body.cwd, {
        provenance: 'managed-scratch',
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('rejects ordinary registration inside a reserved non-scratch descendant', async () => {
    const parent = await mkdtemp(join(REAL_DIR, 'qws-scratch-route-'));
    try {
      const root = prepareManagedScratchRoot(join(parent, 'root'), []);
      const reserved = join(root.canonicalRoot, 'project');
      await mkdir(reserved);
      const { app } = createApp({
        workspaceRegistry: createMockRegistry([makeRuntime('/workspace')]),
        managedScratchRoot: root,
      });

      const res = await request(app)
        .post('/workspaces')
        .send({ cwd: reserved });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('scratch_root_conflict');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('preserves a created directory when runtime construction fails', async () => {
    const parent = await mkdtemp(join(REAL_DIR, 'qws-scratch-route-'));
    try {
      const root = prepareManagedScratchRoot(join(parent, 'root'), []);
      const { app } = createApp({
        workspaceRegistry: createMockRegistry([makeRuntime('/workspace')]),
        createWorkspaceRuntime: vi
          .fn()
          .mockRejectedValue(new Error('construction failed')),
        managedScratchRoot: root,
        runtimeRemoval: createRemovalController(),
      });

      const res = await request(app)
        .post('/workspaces')
        .send({ kind: 'scratch' });

      expect(res.status).toBe(500);
      const [retained] = await readdir(root.canonicalRoot);
      expect(retained).toMatch(/^scratch-/);
      expect(writeStderrLine).toHaveBeenCalledWith(
        expect.stringContaining(
          `retained directory: ${join(root.canonicalRoot, retained!)}`,
        ),
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('reserves capacity before scratch filesystem work can yield', async () => {
    const parent = await mkdtemp(join(REAL_DIR, 'qws-scratch-route-'));
    const existingDir = await mkdtemp(join(REAL_DIR, 'qws-existing-route-'));
    try {
      const root = prepareManagedScratchRoot(join(parent, 'root'), []);
      const registry = createMockRegistry(
        Array.from({ length: 24 }, (_, index) =>
          makeRuntime(`/workspace-${index}`),
        ),
      );
      let releaseFactory!: () => void;
      const blocked = new Promise<void>((resolve) => {
        releaseFactory = resolve;
      });
      const { app } = createApp({
        workspaceRegistry: registry,
        createWorkspaceRuntime: vi.fn(async (cwd: string) => {
          await blocked;
          return makeRuntime(cwd);
        }),
        managedScratchRoot: root,
        runtimeRemoval: createRemovalController(),
      });

      const scratchPromise = request(app)
        .post('/workspaces')
        .send({ kind: 'scratch' })
        .then((response) => response);
      await vi.waitFor(async () => {
        expect(await readdir(root.canonicalRoot)).toHaveLength(1);
      });
      const existing = await request(app)
        .post('/workspaces')
        .send({ cwd: existingDir });
      releaseFactory();

      expect(existing.status).toBe(409);
      expect(existing.body.code).toBe('workspace_limit_reached');
      expect((await scratchPromise).status).toBe(201);
      expect(registry.listManaged()).toHaveLength(25);
    } finally {
      await Promise.all([
        rm(parent, { recursive: true, force: true }),
        rm(existingDir, { recursive: true, force: true }),
      ]);
    }
  });

  it('sealing waits for construction and disposes an unregistered runtime once', async () => {
    const parent = await mkdtemp(join(REAL_DIR, 'qws-scratch-route-'));
    try {
      const root = prepareManagedScratchRoot(join(parent, 'root'), []);
      const runtimeRemoval = createRemovalController();
      let releaseFactory!: () => void;
      const blocked = new Promise<void>((resolve) => {
        releaseFactory = resolve;
      });
      const runtime = makeRuntime('/placeholder');
      const factory = vi.fn(async (cwd: string) => {
        await blocked;
        return { ...runtime, workspaceCwd: cwd } as WorkspaceRuntime;
      });
      const registry = createMockRegistry([makeRuntime('/workspace')]);
      const { app, handle } = createApp({
        workspaceRegistry: registry,
        createWorkspaceRuntime: factory,
        managedScratchRoot: root,
        runtimeRemoval,
      });
      const responsePromise = request(app)
        .post('/workspaces')
        .send({ kind: 'scratch' })
        .then((response) => response);
      await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
      let sealed = false;
      const sealPromise = handle.sealAndWait().then(() => {
        sealed = true;
      });
      await Promise.resolve();
      expect(sealed).toBe(false);
      releaseFactory();
      await sealPromise;

      expect((await responsePromise).status).toBe(503);
      expect(registry.add).not.toHaveBeenCalled();
      expect(runtimeRemoval.disposeRuntime).toHaveBeenCalledOnce();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('disposes a runtime that violates the managed scratch contract', async () => {
    const parent = await mkdtemp(join(REAL_DIR, 'qws-scratch-route-'));
    try {
      const root = prepareManagedScratchRoot(join(parent, 'root'), []);
      const runtimeRemoval = createRemovalController();
      const { app, deps } = createApp({
        workspaceRegistry: createMockRegistry([makeRuntime('/workspace')]),
        createWorkspaceRuntime: vi.fn((cwd: string) =>
          Promise.resolve(makeRuntime(cwd, { trusted: false })),
        ),
        managedScratchRoot: root,
        runtimeRemoval,
      });

      const res = await request(app)
        .post('/workspaces')
        .send({ kind: 'scratch' });

      expect(res.status).toBe(500);
      expect(deps.workspaceRegistry.add).not.toHaveBeenCalled();
      expect(runtimeRemoval.disposeRuntime).toHaveBeenCalledOnce();
      expect(await readdir(root.canonicalRoot)).toHaveLength(1);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
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

  // #7139 wiring: with a container sandbox active, a Windows-shaped cwd is
  // translated to its bind mount BEFORE the absolute-path guard — the 400
  // moves from the isAbsolute rejection to the (deeper) existence check,
  // because the root-level translated mount cannot exist in a test.
  it.skipIf(process.platform === 'win32')(
    'translates a Windows-shaped cwd past the absolute-path guard in a sandbox',
    async () => {
      vi.stubEnv('SANDBOX', 'qwen-code-sandbox-0');
      _setSandboxMountExistsForTest((p) => p === '/c/qwen-repro');
      try {
        const { app } = createApp();
        const res = await request(app)
          .post('/workspaces')
          .send({ cwd: 'C:\\qwen-repro' });
        expect(res.status).toBe(400);
        // Past the guard: the failure is now the realpath existence check,
        // not the absolute-path rejection.
        expect(res.body.error).toBe('Path does not exist or is not accessible');
      } finally {
        vi.unstubAllEnvs();
        _setSandboxMountExistsForTest(undefined);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'still rejects a Windows-shaped cwd outside a sandbox',
    async () => {
      vi.stubEnv('SANDBOX', '');
      try {
        const { app } = createApp();
        const res = await request(app)
          .post('/workspaces')
          .send({ cwd: 'C:\\qwen-repro' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('`cwd` must be an absolute path');
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

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
    const { app, deps } = createApp({
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
    expect(deps.createWorkspaceRuntime).toHaveBeenCalledWith(REAL_DIR, {
      provenance: 'existing',
    });
  });

  it('does not expose the hidden Live runtime to workspace nesting checks', async () => {
    const parent = await mkdtemp(join(REAL_DIR, 'qws-live-parent-'));
    const liveRoot = join(parent, 'Documents', 'Qwen Code', 'Conversations');
    try {
      const { app } = createApp({
        workspaceRegistry: createMockRegistry([
          makeRuntime('/some-other-dir', { primary: true }),
          makeRuntime(liveRoot, {
            provenance: 'live-conversation',
            removable: false,
          }),
        ]),
      });

      const res = await request(app).post('/workspaces').send({ cwd: parent });

      expect(res.status).toBe(201);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('still blocks a user workspace inside the hidden Live runtime', async () => {
    const parent = await mkdtemp(join(REAL_DIR, 'qws-live-parent-'));
    const liveRoot = join(parent, 'Documents', 'Qwen Code', 'Conversations');
    const child = join(liveRoot, 'conversation');
    try {
      await mkdir(child, { recursive: true });
      const { app } = createApp({
        workspaceRegistry: createMockRegistry([
          makeRuntime('/some-other-dir', { primary: true }),
          makeRuntime(liveRoot, {
            provenance: 'live-conversation',
            removable: false,
          }),
        ]),
      });

      const res = await request(app).post('/workspaces').send({ cwd: child });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('workspace_nested');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('sets a display name on a process-local registration', async () => {
    const runtime = makeRuntime(REAL_DIR);
    const registry = createMockRegistry([makeRuntime('/some-other-dir')]);
    const add = vi.fn();
    const read = vi.fn();
    const { app } = createApp({
      workspaceRegistry: registry,
      createWorkspaceRuntime: vi.fn().mockResolvedValue(runtime),
      workspaceRegistrationStore: {
        add,
        read,
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app).post('/workspaces').send({
      cwd: REAL_DIR,
      displayName: 'Qwen SDK',
    });

    expect(res.status).toBe(201);
    expect(res.body.displayName).toBe('Qwen SDK');
    expect(runtime.displayName).toBe('Qwen SDK');
    expect(registry.getByWorkspaceCwd(REAL_DIR)).toBe(runtime);
    expect(add).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('registers and persists an optional display name', async () => {
    const add = vi.fn().mockResolvedValue(true);
    const registry = createMockRegistry([makeRuntime('/some-other-dir')]);
    const { app } = createApp({
      workspaceRegistry: registry,
      workspaceRegistrationStore: {
        add,
        read: vi.fn().mockResolvedValue({ workspaces: [] }),
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app).post('/workspaces').send({
      cwd: REAL_DIR,
      persist: true,
      displayName: 'Qwen SDK',
    });

    expect(res.status).toBe(201);
    expect(res.body.displayName).toBe('Qwen SDK');
    expect(add).toHaveBeenCalledWith(REAL_DIR, 'Qwen SDK');
    expect(registry.getByWorkspaceCwd(REAL_DIR)?.displayName).toBe('Qwen SDK');
    expect(registry.getByWorkspaceCwd(REAL_DIR)?.registrationIds).toEqual([
      workspaceRegistrationId(REAL_DIR),
    ]);
  });

  it('restores the name of an inactive persisted registration', async () => {
    const registrationId = workspaceRegistrationId(REAL_DIR);
    const runtime = makeRuntime(REAL_DIR);
    const add = vi.fn().mockResolvedValue(false);
    const registry = createMockRegistry([makeRuntime('/some-other-dir')]);
    const { app } = createApp({
      workspaceRegistry: registry,
      createWorkspaceRuntime: vi.fn().mockResolvedValue(runtime),
      workspaceRegistrationStore: {
        add,
        read: vi.fn().mockResolvedValue({
          workspaces: [REAL_DIR],
          displayNames: { [registrationId]: 'Persisted name' },
        }),
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app)
      .post('/workspaces')
      .send({ cwd: REAL_DIR, persist: true });

    expect(res.status).toBe(201);
    expect(res.body.displayName).toBe('Persisted name');
    expect(runtime.displayName).toBe('Persisted name');
    expect(runtime.registrationIds).toEqual([registrationId]);
    expect(add).toHaveBeenCalledWith(REAL_DIR);
  });

  it.each([
    { displayName: null },
    { displayName: 'a'.repeat(257) },
    { displayName: 'bad\u0000name' },
  ])('rejects an invalid display name: $displayName', async (body) => {
    const { app, deps } = createApp({
      workspaceRegistry: createMockRegistry([makeRuntime('/some-other-dir')]),
    });

    const res = await request(app)
      .post('/workspaces')
      .send({ cwd: REAL_DIR, ...body });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_display_name');
    expect(deps.createWorkspaceRuntime).not.toHaveBeenCalled();
  });

  it('persists a display name when promoting a process-local workspace', async () => {
    const runtime = makeRuntime(REAL_DIR, { displayName: 'Old name' });
    const add = vi.fn().mockResolvedValue(true);
    const { app } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
      workspaceRegistrationStore: {
        add,
        read: vi.fn().mockResolvedValue({ workspaces: [] }),
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app).post('/workspaces').send({
      cwd: REAL_DIR,
      persist: true,
      displayName: 'Promoted name',
    });

    expect(res.status).toBe(200);
    expect(add).toHaveBeenCalledWith(REAL_DIR, 'Promoted name');
    expect(runtime.displayName).toBe('Promoted name');
    expect(runtime.registrationIds).toEqual([
      workspaceRegistrationId(REAL_DIR),
    ]);
  });

  it('clears a process-local name when promoting with an empty name', async () => {
    const runtime = makeRuntime(REAL_DIR, { displayName: 'Old name' });
    const add = vi.fn().mockResolvedValue(true);
    const { app } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
      workspaceRegistrationStore: {
        add,
        read: vi.fn().mockResolvedValue({ workspaces: [] }),
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app).post('/workspaces').send({
      cwd: REAL_DIR,
      persist: true,
      displayName: '   ',
    });

    expect(res.status).toBe(200);
    expect(add).toHaveBeenCalledWith(REAL_DIR);
    expect(res.body).not.toHaveProperty('displayName');
    expect(runtime.displayName).toBeUndefined();
  });

  it('uses the stored name when another daemon wins a promotion race', async () => {
    const runtime = makeRuntime(REAL_DIR, { displayName: 'Old name' });
    const registrationId = workspaceRegistrationId(REAL_DIR);
    const add = vi.fn().mockResolvedValue(false);
    const read = vi
      .fn()
      .mockResolvedValueOnce({ workspaces: [] })
      .mockResolvedValueOnce({
        workspaces: [REAL_DIR],
        displayNames: { [registrationId]: 'Stored winner' },
      });
    const { app } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
      workspaceRegistrationStore: {
        add,
        read,
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app).post('/workspaces').send({
      cwd: REAL_DIR,
      persist: true,
      displayName: 'Requested name',
    });

    expect(res.status).toBe(200);
    expect(add).toHaveBeenCalledWith(REAL_DIR, 'Requested name');
    expect(res.body.displayName).toBe('Stored winner');
    expect(runtime.displayName).toBe('Stored winner');
  });

  it('clears a stale name when another daemon persists no name', async () => {
    const runtime = makeRuntime(REAL_DIR, { displayName: 'Old name' });
    const add = vi.fn().mockResolvedValue(false);
    const read = vi
      .fn()
      .mockResolvedValueOnce({ workspaces: [] })
      .mockResolvedValueOnce({ workspaces: [REAL_DIR] });
    const { app } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
      workspaceRegistrationStore: {
        add,
        read,
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app).post('/workspaces').send({
      cwd: REAL_DIR,
      persist: true,
      displayName: 'Requested name',
    });

    expect(res.status).toBe(200);
    expect(add).toHaveBeenCalledWith(REAL_DIR, 'Requested name');
    expect(res.body).not.toHaveProperty('displayName');
    expect(runtime.displayName).toBeUndefined();
  });

  it('does not change a runtime name when promotion persistence fails', async () => {
    const runtime = makeRuntime(REAL_DIR, { displayName: 'Old name' });
    const { app } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
      workspaceRegistrationStore: {
        add: vi.fn().mockRejectedValue(new Error('disk full')),
        read: vi.fn().mockResolvedValue({ workspaces: [] }),
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app).post('/workspaces').send({
      cwd: REAL_DIR,
      persist: true,
      displayName: 'Promoted name',
    });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('workspace_registration_store_error');
    expect(runtime.displayName).toBe('Old name');
  });

  it('validates trust under the topology gate before publishing a runtime', async () => {
    const registry = createMockRegistry([makeRuntime('/some-other-dir')]);
    const created = makeRuntime(REAL_DIR, { trusted: true });
    const validated = makeRuntime(REAL_DIR, { trusted: false });
    const events: string[] = [];
    const validateWorkspaceRuntimeForPublication = vi.fn(async (runtime) => {
      expect(runtime).toBe(created);
      events.push('validated');
      return validated;
    });
    const runWorkspaceTrustOperation = vi.fn(async (operation) => {
      expect(registry.getByWorkspaceCwd(REAL_DIR)).toBeUndefined();
      events.push('gate-entered');
      const result = await operation();
      events.push('gate-exited');
      return result;
    });
    const { app } = createApp({
      workspaceRegistry: registry,
      createWorkspaceRuntime: vi.fn().mockResolvedValue(created),
      validateWorkspaceRuntimeForPublication,
      runWorkspaceTrustOperation,
    });
    const requestTrustReconcile = vi.fn().mockResolvedValue(undefined);
    app.locals['requestTrustReconcile'] = requestTrustReconcile;

    const res = await request(app).post('/workspaces').send({ cwd: REAL_DIR });

    expect(res.status).toBe(201);
    expect(res.body.trusted).toBe(false);
    expect(registry.getByWorkspaceCwd(REAL_DIR)).toBe(validated);
    expect(events).toEqual(['gate-entered', 'validated', 'gate-exited']);
    expect(requestTrustReconcile).toHaveBeenCalledOnce();
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
        read: vi.fn().mockResolvedValue({ workspaces: [] }),
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

  it('does not rename an already-persisted workspace on repeated POST', async () => {
    const runtime = makeRuntime(REAL_DIR, {
      displayName: 'Process-local name',
    });
    const add = vi.fn();
    const { app } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
      workspaceRegistrationStore: {
        add,
        read: vi.fn().mockResolvedValue({
          workspaces: [REAL_DIR],
          displayNames: {
            [workspaceRegistrationId(REAL_DIR)]: 'Stored name',
          },
        }),
      } as unknown as WorkspaceRegistrationStore,
    });
    const res = await request(app).post('/workspaces').send({
      cwd: REAL_DIR,
      persist: true,
      displayName: 'Renamed',
    });
    expect(res.status).toBe(200);
    expect(res.body.persisted).toBe(true);
    expect(res.body.displayName).toBe('Stored name');
    expect(runtime.displayName).toBe('Stored name');
    expect(runtime.registrationIds).toEqual([
      workspaceRegistrationId(REAL_DIR),
    ]);
    expect(add).not.toHaveBeenCalled();
  });

  it('clears a process-local name when the persisted record has no name', async () => {
    const runtime = makeRuntime(REAL_DIR, {
      displayName: 'Process-local name',
    });
    const add = vi.fn();
    const { app } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
      workspaceRegistrationStore: {
        add,
        read: vi.fn().mockResolvedValue({ workspaces: [REAL_DIR] }),
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app).post('/workspaces').send({
      cwd: REAL_DIR,
      persist: true,
      displayName: 'Renamed',
    });

    expect(res.status).toBe(200);
    expect(res.body.persisted).toBe(true);
    expect(res.body).not.toHaveProperty('displayName');
    expect(runtime.displayName).toBeUndefined();
    expect(add).not.toHaveBeenCalled();
  });

  it('does not duplicate a persisted alias when promoting its runtime', async () => {
    const alias = '/raw/workspace-alias';
    const add = vi.fn();
    const runtime = makeRuntime(REAL_DIR, {
      registrationIds: [workspaceRegistrationId(alias)],
    });
    const { app } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
      workspaceRegistrationStore: {
        add,
        read: vi.fn().mockResolvedValue({ workspaces: [alias] }),
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app)
      .post('/workspaces')
      .send({ cwd: REAL_DIR, persist: true });

    expect(res.status).toBe(200);
    expect(res.body.persisted).toBe(true);
    expect(add).not.toHaveBeenCalled();
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

  it('promotes a workspace that contains the hidden Live runtime', async () => {
    const parent = await mkdtemp(join(REAL_DIR, 'qws-live-parent-'));
    const liveRoot = join(parent, 'Documents', 'Qwen Code', 'Conversations');
    const add = vi.fn().mockResolvedValue(true);
    try {
      const { app } = createApp({
        workspaceRegistry: createMockRegistry([
          makeRuntime('/some-other-dir', { primary: true }),
          makeRuntime(parent),
          makeRuntime(liveRoot, {
            provenance: 'live-conversation',
            removable: false,
          }),
        ]),
        workspaceRegistrationStore: {
          add,
          read: vi.fn().mockResolvedValue({ workspaces: [] }),
        } as unknown as WorkspaceRegistrationStore,
      });

      const res = await request(app)
        .post('/workspaces')
        .send({ cwd: parent, persist: true });

      expect(res.status).toBe(200);
      expect(add).toHaveBeenCalledWith(parent);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
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
        read: vi.fn().mockResolvedValue({ workspaces: [] }),
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
        read: vi.fn().mockResolvedValue({ workspaces: [] }),
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

describe('PATCH /workspaces/:workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates a process-local workspace by id', async () => {
    const runtime = makeRuntime(REAL_DIR);
    const setDisplayNameByIds = vi.fn().mockRejectedValue(new Error('broken'));
    const { app } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
      workspaceRegistrationStore: {
        setDisplayNameByIds,
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app)
      .patch(`/workspaces/${encodeURIComponent(runtime.workspaceId)}`)
      .send({ displayName: '  Payments  ' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: runtime.workspaceId,
      cwd: REAL_DIR,
      displayName: 'Payments',
      primary: false,
      trusted: true,
    });
    expect(runtime.displayName).toBe('Payments');
    expect(setDisplayNameByIds).not.toHaveBeenCalled();
  });

  it('does not expose the internal Conversations runtime by id', async () => {
    const runtime = makeRuntime(REAL_DIR, {
      provenance: 'live-conversation',
      displayName: 'Live',
    });
    const { app } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
    });

    const res = await request(app)
      .patch(`/workspaces/${encodeURIComponent(runtime.workspaceId)}`)
      .send({ displayName: 'Renamed' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('workspace_mismatch');
    expect(runtime.displayName).toBe('Live');
  });

  it('clears a workspace display name by cwd', async () => {
    const runtime = makeRuntime(REAL_DIR, { displayName: 'Payments' });
    const { app } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
    });

    const res = await request(app)
      .patch(`/workspaces/${encodeURIComponent(REAL_DIR)}`)
      .send({ displayName: null });

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('displayName');
    expect(runtime.displayName).toBeUndefined();
  });

  it('updates every persistent registration alias before the runtime', async () => {
    const aliases = ['alias-a', 'alias-b'];
    const runtime = makeRuntime(REAL_DIR, {
      displayName: 'Old name',
      registrationIds: aliases,
    });
    const setDisplayNameByIds = vi.fn(
      async (_ids: readonly string[], _displayName?: string) => {
        expect(runtime.displayName).toBe('Old name');
        return 2;
      },
    );
    const { app } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
      workspaceRegistrationStore: {
        setDisplayNameByIds,
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app)
      .patch(`/workspaces/${encodeURIComponent(runtime.workspaceId)}`)
      .send({ displayName: 'New name' });

    expect(res.status).toBe(200);
    expect(setDisplayNameByIds).toHaveBeenCalledWith(aliases, 'New name');
    expect(runtime.displayName).toBe('New name');
  });

  it.each([
    [{}, 'empty_patch'],
    [{ unsupported: true }, 'unsupported_field'],
    [{ displayName: 'New name', unsupported: true }, 'unsupported_field'],
    [{ displayName: 42 }, 'invalid_display_name'],
    [{ displayName: 'x'.repeat(257) }, 'invalid_display_name'],
    [{ displayName: 'bad\u007fname' }, 'invalid_display_name'],
  ])('rejects an invalid update %#', async (body, code) => {
    const runtime = makeRuntime(REAL_DIR, { displayName: 'Old name' });
    const { app } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
    });

    const res = await request(app)
      .patch(`/workspaces/${encodeURIComponent(runtime.workspaceId)}`)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
    expect(runtime.displayName).toBe('Old name');
  });

  it('leaves the runtime unchanged when persistence fails', async () => {
    const runtime = makeRuntime(REAL_DIR, {
      displayName: 'Old name',
      registrationIds: [workspaceRegistrationId(REAL_DIR)],
    });
    const { app } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
      workspaceRegistrationStore: {
        setDisplayNameByIds: vi.fn().mockRejectedValue(new Error('disk full')),
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app)
      .patch(`/workspaces/${encodeURIComponent(runtime.workspaceId)}`)
      .send({ displayName: 'New name' });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('workspace_registration_store_error');
    expect(runtime.displayName).toBe('Old name');
  });

  it('keeps a committed update when lock release fails', async () => {
    const runtime = makeRuntime(REAL_DIR, {
      displayName: 'Old name',
      registrationIds: [workspaceRegistrationId(REAL_DIR)],
    });
    const { app } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
      workspaceRegistrationStore: {
        setDisplayNameByIds: vi
          .fn()
          .mockRejectedValue(
            new WorkspaceRegistrationStoreCommittedError('release failed'),
          ),
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app)
      .patch(`/workspaces/${encodeURIComponent(runtime.workspaceId)}`)
      .send({ displayName: 'New name' });

    expect(res.status).toBe(200);
    expect(runtime.displayName).toBe('New name');
    expect(writeStderrLine).toHaveBeenCalledWith('qwen serve: release failed');
  });

  it('serializes removal and shutdown behind a pending update', async () => {
    const runtime = makeRuntime(REAL_DIR, {
      registrationIds: [workspaceRegistrationId(REAL_DIR)],
    });
    let finishUpdate!: () => void;
    const pendingUpdate = new Promise<number>((resolve) => {
      finishUpdate = () => resolve(1);
    });
    const setDisplayNameByIds = vi.fn().mockReturnValue(pendingUpdate);
    const { app, handle } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
      runtimeRemoval: createRemovalController(),
      workspaceRegistrationStore: {
        setDisplayNameByIds,
      } as unknown as WorkspaceRegistrationStore,
    });

    const pendingUpdateResult = request(app)
      .patch(`/workspaces/${encodeURIComponent(runtime.workspaceId)}`)
      .send({ displayName: 'New name' });
    const updateResult = pendingUpdateResult.then((res) => res);
    await vi.waitFor(() => expect(setDisplayNameByIds).toHaveBeenCalledOnce());

    const removal = await request(app).delete(
      `/workspaces/${encodeURIComponent(runtime.workspaceId)}`,
    );
    expect(removal.status).toBe(409);
    expect(removal.body.code).toBe('workspace_registration_in_progress');

    let sealed = false;
    const seal = handle.sealAndWait().then(() => {
      sealed = true;
    });
    await Promise.resolve();
    expect(sealed).toBe(false);

    finishUpdate();
    expect((await updateResult).status).toBe(200);
    await seal;
    expect(sealed).toBe(true);
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

  it('returns 501 when runtime removal is unavailable', async () => {
    const runtime = makeRuntime(REAL_DIR);
    const { app } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
      runtimeRemoval: undefined,
    });

    const res = await request(app).delete(
      `/workspaces/${encodeURIComponent(runtime.workspaceId)}`,
    );

    expect(res.status).toBe(501);
    expect(res.body.code).toBe('workspace_runtime_removal_unsupported');
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

  it('does not expose the internal Conversations runtime by id', async () => {
    const runtime = makeRuntime(REAL_DIR, {
      provenance: 'live-conversation',
    });
    const runtimeRemoval = createRemovalController();
    const { app } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
      runtimeRemoval,
    });

    const res = await request(app).delete(
      `/workspaces/${encodeURIComponent(runtime.workspaceId)}`,
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('workspace_mismatch');
    expect(runtimeRemoval.beginDrain).not.toHaveBeenCalled();
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

  it('blocks non-force removal while a Voice operation is active', async () => {
    const runtime = makeRuntime(REAL_DIR);
    const runtimeRemoval = createRemovalController();
    vi.mocked(runtimeRemoval.getActivity).mockReturnValue({
      pendingSessionStarts: 0,
      channelWorkers: 0,
      voiceSessions: 1,
    });
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
      activity: { voiceSessions: 1 },
    });
    expect(runtimeRemoval.beginDrain).not.toHaveBeenCalled();
    expect(deps.workspaceRegistry.beginDrain).not.toHaveBeenCalled();
  });

  it('rolls every gate back when the final frozen snapshot becomes busy', async () => {
    const runtime = makeRuntime(REAL_DIR);
    const runtimeRemoval = createRemovalController();
    vi.mocked(runtimeRemoval.getActivity)
      .mockReturnValueOnce({
        pendingSessionStarts: 0,
        channelWorkers: 0,
        voiceSessions: 0,
      })
      .mockReturnValueOnce({
        pendingSessionStarts: 1,
        channelWorkers: 0,
        voiceSessions: 0,
      });
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
    const requestTrustReconcile = vi.fn().mockResolvedValue(undefined);
    app.locals['requestTrustReconcile'] = requestTrustReconcile;

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
    expect(requestTrustReconcile).toHaveBeenCalledOnce();
  });

  it('continues rolling gates back when cancel hooks throw', async () => {
    const runtime = makeRuntime(REAL_DIR);
    const runtimeRemoval = createRemovalController();
    vi.mocked(runtimeRemoval.getActivity)
      .mockReturnValueOnce({
        pendingSessionStarts: 0,
        channelWorkers: 0,
        voiceSessions: 0,
      })
      .mockReturnValueOnce({
        pendingSessionStarts: 1,
        channelWorkers: 0,
        voiceSessions: 0,
      });
    vi.mocked(runtimeRemoval.cancelDrain).mockImplementation(() => {
      throw new Error('controller rollback failed');
    });
    const acpHandle = {
      beginWorkspaceDrain: vi.fn(),
      cancelWorkspaceDrain: vi.fn(() => {
        throw new Error('ACP rollback failed');
      }),
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
    expect(deps.workspaceRegistry.commitDrain).toHaveBeenCalledWith(runtime);
    expect(
      vi.mocked(deps.workspaceRegistry.commitDrain).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(runtimeRemoval.disposeRuntime).mock.invocationCallOrder[0]!,
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
    vi.mocked(writeStderrLine).mockImplementationOnce(() => {
      throw new Error('stderr closed');
    });
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

  it('continues cleanup when registry drain commit fails after persistence commits', async () => {
    const runtime = makeRuntime(REAL_DIR);
    const registry = createMockRegistry([runtime]);
    vi.mocked(registry.commitDrain).mockImplementationOnce(() => {
      throw new Error('registry commit failed');
    });
    const runtimeRemoval = createRemovalController();
    const { app } = createApp({
      workspaceRegistry: registry,
      runtimeRemoval,
      workspaceRegistrationStore: {
        removeByIds: vi.fn().mockResolvedValue(1),
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app)
      .delete(`/workspaces/${encodeURIComponent(runtime.workspaceId)}`)
      .send({ force: true });

    expect(res.status).toBe(200);
    expect(runtimeRemoval.disposeRuntime).toHaveBeenCalledWith(
      runtime,
      'workspace_removed',
    );
    expect(runtimeRemoval.completeDrain).toHaveBeenCalledWith(runtime);
    expect(registry.completeDrain).toHaveBeenCalledWith(runtime);
    expect(registry.cancelDrain).not.toHaveBeenCalled();
    expect(
      registry.getManagedByWorkspaceId(runtime.workspaceId),
    ).toBeUndefined();
    expect(writeStderrLine).toHaveBeenCalledWith(
      'qwen serve: failed to commit workspace registry drain: registry commit failed',
    );
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
    await symlink(
      REAL_DIR,
      selector,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
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
      displayNames: {
        [workspaceRegistrationId(REAL_DIR)]: 'Canonical workspace',
        [aliasId]: 'Alias workspace',
      },
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
        displayName: 'Canonical workspace',
        active: true,
        persisted: true,
      }),
      expect.objectContaining({
        id: aliasId,
        cwd: alias,
        displayName: 'Alias workspace',
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

  it('keeps legacy Conversations registrations inactive and only forgets the stored record', async () => {
    const reserved = '/reserved/qwen-code/conversations';
    const registrationId = workspaceRegistrationId(reserved);
    const internal = makeRuntime(reserved, {
      provenance: 'live-conversation',
      removable: false,
      registrationIds: [registrationId],
    });
    const registry = createMockRegistry([internal]);
    const removeById = vi.fn().mockResolvedValue(true);
    const store = {
      read: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        primaryWorkspace: '/primary',
        workspaces: [reserved],
      }),
      removeById,
    } as unknown as WorkspaceRegistrationStore;
    const { app } = createApp({
      workspaceRegistry: registry,
      workspaceRegistrationStore: store,
      reservedWorkspaceRoots: [reserved],
    });

    const listed = await request(app).get('/workspace-registrations');
    expect(listed.status).toBe(200);
    expect(listed.body.entries).toEqual([
      expect.objectContaining({
        id: registrationId,
        cwd: reserved,
        active: false,
        persisted: true,
      }),
    ]);

    const removed = await request(app).delete(
      `/workspace-registrations/${registrationId}`,
    );
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({
      removed: true,
      active: false,
      restartRequired: false,
    });
    expect(removeById).toHaveBeenCalledWith(registrationId);
    expect(internal.registrationIds).toEqual([registrationId]);
    expect(registry.listManaged()).toContain(internal);
    expect(registry.syncRuntimeMetadata).not.toHaveBeenCalled();
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
    expect(active.registrationIds).toEqual([]);
  });

  it('does not require restart when forgetting an alias of a static runtime', async () => {
    const aliasId = workspaceRegistrationId('/raw/static-alias');
    const active = makeRuntime(REAL_DIR, {
      removable: false,
      registrationIds: [aliasId],
    });
    const { app } = createApp({
      workspaceRegistry: createMockRegistry([active]),
      workspaceRegistrationStore: {
        removeById: vi.fn().mockResolvedValue(true),
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app).delete(
      `/workspace-registrations/${aliasId}`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      active: true,
      restartRequired: false,
    });
    expect(active.registrationIds).toEqual([]);
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
        read: vi.fn().mockResolvedValue({ workspaces: [] }),
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
        read: vi.fn().mockResolvedValue({ workspaces: [] }),
        removeById: vi.fn().mockRejectedValue(new Error('write failed')),
      } as unknown as WorkspaceRegistrationStore,
    });

    const res = await request(app).delete('/workspace-registrations/id');

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('workspace_registration_store_error');
  });

  it('serializes forget and runtime removal for the same workspace', async () => {
    const registrationId = workspaceRegistrationId(REAL_DIR);
    const runtime = makeRuntime(REAL_DIR);
    let finishForget!: () => void;
    const forgetting = new Promise<boolean>((resolve) => {
      finishForget = () => resolve(true);
    });
    let finishRemoval!: () => void;
    const removing = new Promise<number>((resolve) => {
      finishRemoval = () => resolve(1);
    });
    const removeById = vi.fn().mockReturnValue(forgetting);
    const removeByIds = vi.fn().mockReturnValue(removing);
    const { app } = createApp({
      workspaceRegistry: createMockRegistry([runtime]),
      runtimeRemoval: createRemovalController(),
      workspaceRegistrationStore: {
        read: vi.fn().mockResolvedValue({ workspaces: [] }),
        removeById,
        removeByIds,
      } as unknown as WorkspaceRegistrationStore,
    });

    const pendingForget = request(app).delete(
      `/workspace-registrations/${registrationId}`,
    );
    const forgetResult = pendingForget.then((res) => res);
    await vi.waitFor(() => expect(removeById).toHaveBeenCalledOnce());
    const removalWhileForgetting = await request(app).delete(
      `/workspaces/${encodeURIComponent(runtime.workspaceId)}`,
    );
    expect(removalWhileForgetting.status).toBe(409);
    expect(removalWhileForgetting.body.code).toBe(
      'workspace_registration_in_progress',
    );
    finishForget();
    expect((await forgetResult).status).toBe(200);

    const pendingRemoval = request(app).delete(
      `/workspaces/${encodeURIComponent(runtime.workspaceId)}`,
    );
    const removalResult = pendingRemoval.then((res) => res);
    await vi.waitFor(() => expect(removeByIds).toHaveBeenCalledOnce());
    const forgetWhileRemoving = await request(app).delete(
      `/workspace-registrations/${registrationId}`,
    );
    expect(forgetWhileRemoving.status).toBe(409);
    expect(forgetWhileRemoving.body.code).toBe('workspace_removal_in_progress');
    finishRemoval();
    expect((await removalResult).status).toBe(200);
  });

  it('serializes an inactive forget with adding the same workspace', async () => {
    const registrationId = workspaceRegistrationId(REAL_DIR);
    let finishForget!: () => void;
    const forgetting = new Promise<boolean>((resolve) => {
      finishForget = () => resolve(true);
    });
    const removeById = vi.fn().mockReturnValue(forgetting);
    const { app, deps } = createApp({
      workspaceRegistry: createMockRegistry([makeRuntime('/some-other-dir')]),
      workspaceRegistrationStore: {
        read: vi.fn().mockResolvedValue({ workspaces: [REAL_DIR] }),
        removeById,
      } as unknown as WorkspaceRegistrationStore,
    });

    const pendingForget = request(app).delete(
      `/workspace-registrations/${registrationId}`,
    );
    const forgetResult = pendingForget.then((res) => res);
    await vi.waitFor(() => expect(removeById).toHaveBeenCalledOnce());
    const addWhileForgetting = await request(app)
      .post('/workspaces')
      .send({ cwd: REAL_DIR });

    expect(addWhileForgetting.status).toBe(409);
    expect(addWhileForgetting.body.code).toBe('workspace_exists');
    expect(deps.createWorkspaceRuntime).not.toHaveBeenCalled();
    finishForget();
    expect((await forgetResult).status).toBe(200);
  });

  it('waits for an in-flight forget after sealing and rejects another one', async () => {
    let finishForget!: () => void;
    const forgetting = new Promise<boolean>((resolve) => {
      finishForget = () => resolve(true);
    });
    const removeById = vi.fn().mockReturnValueOnce(forgetting);
    const { app, handle } = createApp({
      workspaceRegistrationStore: {
        read: vi.fn().mockResolvedValue({ workspaces: [] }),
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

  it('waits for an inactive forget that is still reading its registration', async () => {
    let finishRead!: () => void;
    const reading = new Promise<{ workspaces: string[] }>((resolve) => {
      finishRead = () => resolve({ workspaces: [] });
    });
    const read = vi.fn().mockReturnValue(reading);
    const removeById = vi.fn().mockResolvedValue(true);
    const { app, handle } = createApp({
      workspaceRegistrationStore: {
        read,
        removeById,
      } as unknown as WorkspaceRegistrationStore,
    });
    const pendingForget = request(app).delete(
      '/workspace-registrations/inactive',
    );
    const forgetResult = pendingForget.then((res) => res);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());

    let sealed = false;
    const seal = handle.sealAndWait().then(() => {
      sealed = true;
    });
    await Promise.resolve();
    expect(sealed).toBe(false);
    expect(removeById).not.toHaveBeenCalled();

    finishRead();
    expect((await forgetResult).status).toBe(200);
    await seal;
    expect(sealed).toBe(true);
    expect(removeById).toHaveBeenCalledOnce();
  });

  it('finishes a sealed forget operation when registration reading fails', async () => {
    let failRead!: () => void;
    const reading = new Promise<never>((_resolve, reject) => {
      failRead = () => reject(new Error('read failed'));
    });
    const read = vi.fn().mockReturnValue(reading);
    const { app, handle } = createApp({
      workspaceRegistrationStore: {
        read,
      } as unknown as WorkspaceRegistrationStore,
    });
    const pendingForget = request(app).delete(
      '/workspace-registrations/inactive',
    );
    const forgetResult = pendingForget.then((res) => res);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());

    let sealed = false;
    const seal = handle.sealAndWait().then(() => {
      sealed = true;
    });
    await Promise.resolve();
    expect(sealed).toBe(false);

    failRead();
    expect((await forgetResult).status).toBe(500);
    await seal;
    expect(sealed).toBe(true);
  });
});

describe('GET /workspace-path-suggestions', () => {
  let base: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    base = await mkdtemp(join(REAL_DIR, 'qwen-suggest-'));
    await mkdir(join(base, 'alpha'));
    await mkdir(join(base, 'alpine'));
    await mkdir(join(base, 'beta'));
    await mkdir(join(base, '.hidden'));
    await writeFile(join(base, 'a-file.txt'), 'x');
    await symlink(join(base, 'beta'), join(base, 'beta-link'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('lists only directories inside a prefix ending with a separator', async () => {
    const { app } = createApp();
    const res = await request(app)
      .get('/workspace-path-suggestions')
      .query({ prefix: `${base}/` });
    expect(res.status).toBe(200);
    expect(res.body.dir).toBe(base);
    const names = res.body.suggestions.map((s: { name: string }) => s.name);
    // Plain files are excluded; symlinked directories are navigable.
    expect(names).toEqual(['alpha', 'alpine', 'beta', 'beta-link']);
    expect(res.body.truncated).toBe(false);
    for (const s of res.body.suggestions) {
      expect(s.path).toBe(join(base, s.name));
    }
  });

  it('filters by the case-insensitive final segment of the prefix', async () => {
    const { app } = createApp();
    const res = await request(app)
      .get('/workspace-path-suggestions')
      .query({ prefix: join(base, 'ALP') });
    expect(res.status).toBe(200);
    expect(res.body.dir).toBe(base);
    const names = res.body.suggestions.map((s: { name: string }) => s.name);
    expect(names).toEqual(['alpha', 'alpine']);
  });

  it('hides dot-directories unless the filter starts with a dot', async () => {
    const { app } = createApp();
    const withoutDot = await request(app)
      .get('/workspace-path-suggestions')
      .query({ prefix: `${base}/` });
    expect(
      withoutDot.body.suggestions.map((s: { name: string }) => s.name),
    ).not.toContain('.hidden');

    const withDot = await request(app)
      .get('/workspace-path-suggestions')
      .query({ prefix: join(base, '.hi') });
    expect(
      withDot.body.suggestions.map((s: { name: string }) => s.name),
    ).toEqual(['.hidden']);
  });

  it('returns an empty list for a nonexistent directory', async () => {
    const { app } = createApp();
    const res = await request(app)
      .get('/workspace-path-suggestions')
      .query({ prefix: join(base, 'no-such-dir', 'x') });
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([]);
  });

  it('rejects a relative prefix', async () => {
    const { app } = createApp();
    const res = await request(app)
      .get('/workspace-path-suggestions')
      .query({ prefix: 'relative/path' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_prefix');
  });

  it('rejects a missing prefix', async () => {
    const { app } = createApp();
    const res = await request(app).get('/workspace-path-suggestions');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_prefix');
  });

  it('rejects an over-long prefix before touching the filesystem', async () => {
    const { app } = createApp();
    const res = await request(app)
      .get('/workspace-path-suggestions')
      .query({ prefix: '/' + 'x'.repeat(5000) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_prefix');
  });
});

describe('POST /workspace-directory-picker', () => {
  it('remains available in loopback development without a configured token', async () => {
    const mutate = vi.fn(
      (options?: { strict?: boolean }) =>
        (_req: Request, res: Response, next: () => void) => {
          if (options?.strict) {
            res.status(401).json({ code: 'token_required' });
            return;
          }
          next();
        },
    );
    const { app } = createApp({
      mutate,
      pickWorkspaceDirectory: vi.fn().mockResolvedValue(undefined),
    });

    const res = await request(app).post('/workspace-directory-picker');

    expect(res.status).toBe(200);
    expect(res.body.selected).toBe(false);
  });

  it('returns the absolute path selected by the native picker', async () => {
    const pickWorkspaceDirectory = vi.fn().mockResolvedValue('/Users/me/code');
    const { app } = createApp({ pickWorkspaceDirectory });

    const res = await request(app).post('/workspace-directory-picker');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      kind: 'workspace-directory-picker',
      selected: true,
      path: '/Users/me/code',
    });
  });

  it('returns selected=false when the user cancels', async () => {
    const { app } = createApp({
      pickWorkspaceDirectory: vi.fn().mockResolvedValue(undefined),
    });

    const res = await request(app).post('/workspace-directory-picker');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      kind: 'workspace-directory-picker',
      selected: false,
    });
  });

  it('returns 501 when the native picker is unavailable', async () => {
    const { app } = createApp({
      pickWorkspaceDirectory: vi
        .fn()
        .mockRejectedValue(new NativeDirectoryPickerUnavailableError()),
    });

    const res = await request(app).post('/workspace-directory-picker');

    expect(res.status).toBe(501);
    expect(res.body.code).toBe('directory_picker_unavailable');
    expect(writeStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('native directory picker unavailable'),
    );
  });

  it('returns 500 when the picker fails unexpectedly', async () => {
    const { app } = createApp({
      pickWorkspaceDirectory: vi.fn().mockRejectedValue(new Error('boom')),
    });

    const res = await request(app).post('/workspace-directory-picker');

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('directory_picker_failed');
    expect(writeStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('native directory picker failed: boom'),
    );
  });

  it('passes an abort signal to the picker', async () => {
    const pickWorkspaceDirectory = vi.fn().mockResolvedValue('/tmp');
    const { app } = createApp({ pickWorkspaceDirectory });

    await request(app).post('/workspace-directory-picker');

    expect(pickWorkspaceDirectory).toHaveBeenCalledWith(
      expect.any(AbortSignal),
    );
  });

  it('does not abort the picker before it can resolve, for the body the Web Shell actually sends', async () => {
    // A real picker resolves only after the user interacts — model that with a
    // delay so an already-aborted signal surfaces as a rejection.
    const pickWorkspaceDirectory = vi.fn(
      (signal?: AbortSignal) =>
        new Promise<string | undefined>((resolve, reject) => {
          setTimeout(() => {
            if (signal?.aborted) {
              reject(new Error('The operation was aborted'));
              return;
            }
            resolve('/Users/me/code');
          }, 50);
        }),
    );
    const { app } = createApp({ pickWorkspaceDirectory });

    const res = await request(app).post('/workspace-directory-picker').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      kind: 'workspace-directory-picker',
      selected: true,
      path: '/Users/me/code',
    });
  });

  it('still aborts a picker that is genuinely in flight when the client hangs up', async () => {
    let observed: AbortSignal | undefined;
    const { app } = createApp({
      pickWorkspaceDirectory: vi.fn((signal?: AbortSignal) => {
        observed = signal;
        return new Promise<string | undefined>(() => {});
      }),
    });
    const req = request(app).post('/workspace-directory-picker').send({});
    req.end(() => {});
    await new Promise((r) => setTimeout(r, 30));
    req.abort();
    await new Promise((r) => setTimeout(r, 60));
    expect(observed?.aborted).toBe(true);
  });
});
