/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  ExtensionManager,
  hashDaemonWorkspace,
  type Extension,
  type ExtensionStoreSnapshot,
} from '@qwen-code/qwen-code-core';
import { createServeApp } from '../server.js';
import { ClientMcpSenderRegistry } from '../acp-http/client-mcp-sender-registry.js';
import {
  canonicalizeWorkspace,
  createWorkspaceFileSystemFactory,
} from '../fs/index.js';
import type { ServeOptions } from '../types.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import { getWorkspaceRuntimeCoordinator } from '../workspace-runtime-coordinator.js';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import type { DaemonWorkspaceService } from '../workspace-service/types.js';

const extensionId = 'a'.repeat(64);
const baseOpts: ServeOptions = {
  hostname: '127.0.0.1',
  port: 4198,
  mode: 'http-bridge',
};
const activeApps = new Set<ReturnType<typeof createServeApp>>();

function host(): string {
  return `127.0.0.1:${baseOpts.port}`;
}

function makeBridge(): AcpSessionBridge {
  return {
    permissionPolicy: 'first-responder',
    knownClientIds: () => new Set<string>(['client-1']),
    isChannelLive: vi.fn(() => true),
    getRuntimeEpoch: vi.fn(() => 1),
    publishWorkspaceEvent: vi.fn(),
    refreshExtensionsForAllSessions: vi.fn(async () => ({
      refreshed: 1,
      failed: 0,
    })),
    refreshWorkspaceExtensions: vi.fn(async () => ({
      refreshed: 1,
      failed: 0,
      generation: 7,
      runtimeEpoch: 1,
    })),
    broadcastExtensionsChanged: vi.fn(),
    getDaemonStatusSnapshot: vi.fn(() => ({
      limits: {
        maxSessions: 20,
        maxPendingPromptsPerSession: 5,
        eventRingSize: 8000,
        compactedReplayMaxBytes: 4 * 1024 * 1024,
        channelIdleTimeoutMs: null,
        sessionIdleTimeoutMs: 1_800_000,
      },
      sessionCount: 0,
      pendingPermissionCount: 0,
      channelLive: false,
      permissionPolicy: 'first-responder',
      sessions: [],
    })),
    listWorkspaceSessions: vi.fn(() => []),
    getSessionSummary: vi.fn(() => {
      throw new Error('not found');
    }),
    sessionCount: 0,
    activePromptCount: 0,
    pendingPromptTotal: 0,
    lastActivityAt: null,
  } as unknown as AcpSessionBridge;
}

function makeWorkspaceService(): DaemonWorkspaceService {
  return {
    invalidateWorkspaceSkillsStatus: vi.fn(),
    refreshExtensionsForAllSessions: vi.fn(async () => ({
      refreshed: 1,
      failed: 0,
    })),
  } as unknown as DaemonWorkspaceService;
}

function makeRuntime(
  workspaceCwd: string,
  opts: { primary: boolean; trusted: boolean; workspaceId: string },
): WorkspaceRuntime {
  return {
    workspaceId: opts.workspaceId,
    workspaceCwd,
    primary: opts.primary,
    trusted: opts.trusted,
    env: { mode: 'parent-process', overlayKeys: [] },
    bridge: makeBridge(),
    workspaceService: makeWorkspaceService(),
    routeFileSystemFactory: createWorkspaceFileSystemFactory({
      boundWorkspaces: [workspaceCwd],
      trusted: opts.trusted,
      emit: () => {},
    }),
    clientMcpSenderRegistry: new ClientMcpSenderRegistry(),
  };
}

async function makeHarness(opts?: {
  primaryTrusted?: boolean;
  secondaryTrusted?: boolean;
  singleWorkspace?: boolean;
}) {
  const scratch = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'qwen-extension-management-v2-'),
  );
  const primaryCwd = path.join(scratch, 'primary');
  const secondaryCwd = path.join(scratch, 'secondary');
  await fsp.mkdir(primaryCwd, { recursive: true });
  await fsp.mkdir(secondaryCwd, { recursive: true });
  const canonicalPrimary = canonicalizeWorkspace(primaryCwd);
  const canonicalSecondary = canonicalizeWorkspace(secondaryCwd);
  const primary = makeRuntime(canonicalPrimary, {
    primary: true,
    trusted: opts?.primaryTrusted ?? true,
    workspaceId: 'primary-id',
  });
  const secondary = makeRuntime(canonicalSecondary, {
    primary: false,
    trusted: opts?.secondaryTrusted ?? true,
    workspaceId: hashDaemonWorkspace(canonicalSecondary),
  });
  const registry = createWorkspaceRegistry(
    opts?.singleWorkspace ? [primary] : [primary, secondary],
  );
  const app = createServeApp(
    { ...baseOpts, workspace: canonicalPrimary, token: 'secret' },
    undefined,
    {
      workspaceRegistry: registry,
    },
  );
  activeApps.add(app);
  return { app, scratch, primary, secondary, registry };
}

function auth(pending: request.Test): request.Test {
  return pending
    .set('Host', host())
    .set('Authorization', 'Bearer secret')
    .set('X-Qwen-Client-Id', 'client-1');
}

function mockExtensionManager(
  installType: 'archive-url' | 'local' = 'archive-url',
): Extension {
  const extension = {
    id: extensionId,
    name: 'demo',
    version: '1.0.0',
    path: '/extensions/demo',
    isActive: true,
    config: { name: 'demo', version: '1.0.0' },
    installMetadata: {
      type: installType,
      source:
        installType === 'archive-url'
          ? 'https://example.com/demo.zip'
          : '/extensions/demo.zip',
    },
    contextFiles: [],
  } as Extension;
  const snapshot: ExtensionStoreSnapshot = {
    version: 2,
    generation: 7,
    legacyProjectionHash: 'hash',
    extensions: {
      [extensionId]: {
        name: 'demo',
        defaultActivation: 'disabled',
        workspaceOverrides: {},
      },
    },
  };
  vi.spyOn(ExtensionManager.prototype, 'refreshCache').mockResolvedValue();
  vi.spyOn(
    ExtensionManager.prototype,
    'refreshCacheWithSnapshot',
  ).mockResolvedValue(snapshot);
  vi.spyOn(ExtensionManager.prototype, 'getLoadedExtensions').mockReturnValue([
    extension,
  ]);
  vi.spyOn(
    ExtensionManager.prototype,
    'getExtensionStoreSnapshot',
  ).mockResolvedValue(snapshot);
  vi.spyOn(
    ExtensionManager.prototype,
    'getExtensionActivation',
  ).mockResolvedValue({
    default: 'disabled',
    workspace: 'inherit',
    effective: 'disabled',
    source: 'default',
  });
  vi.spyOn(
    ExtensionManager.prototype,
    'getExtensionActivationFromSnapshot',
  ).mockReturnValue({
    default: 'disabled',
    workspace: 'inherit',
    effective: 'disabled',
    source: 'default',
  });
  vi.spyOn(
    ExtensionManager.prototype,
    'setExtensionDefaultActivation',
  ).mockResolvedValue(snapshot);
  vi.spyOn(
    ExtensionManager.prototype,
    'setExtensionWorkspaceActivation',
  ).mockResolvedValue(snapshot);
  vi.spyOn(
    ExtensionManager.prototype,
    'clearExtensionWorkspaceActivation',
  ).mockResolvedValue(snapshot);
  vi.spyOn(
    ExtensionManager.prototype,
    'uninstallExtensionById',
  ).mockResolvedValue(snapshot);
  return extension;
}

async function pollOperation(
  app: ReturnType<typeof createServeApp>,
  operationId: string,
  operationBasePath = '/extensions/operations',
) {
  for (let i = 0; i < 100; i++) {
    const response = await auth(
      request(app).get(
        `${operationBasePath}/${encodeURIComponent(operationId)}`,
      ),
    );
    if (
      response.status === 200 &&
      response.body.status !== 'queued' &&
      response.body.status !== 'running'
    ) {
      return response.body;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`operation ${operationId} did not settle`);
}

describe('extension management v2 REST', () => {
  it('keeps runtime refresh out of config routes', async () => {
    const h = await makeHarness({ singleWorkspace: true });

    const legacy = await auth(
      request(h.app).post('/workspace/extensions/refresh'),
    );
    expect(legacy.status).toBe(200);
    expect(
      h.primary.workspaceService.refreshExtensionsForAllSessions,
    ).toHaveBeenCalledOnce();
    expect(h.primary.bridge.refreshWorkspaceExtensions).not.toHaveBeenCalled();

    const workspaceConfig = await auth(
      request(h.app).post('/workspace/config/extensions/refresh'),
    );
    expect(workspaceConfig.status).toBe(404);
    expect(h.primary.bridge.refreshWorkspaceExtensions).not.toHaveBeenCalled();
    expect(
      h.primary.workspaceService.refreshExtensionsForAllSessions,
    ).toHaveBeenCalledOnce();

    const qualifiedConfig = await auth(
      request(h.app).post('/workspaces/primary-id/config/extensions/refresh'),
    );
    expect(qualifiedConfig.status).toBe(404);
    expect(h.primary.bridge.refreshWorkspaceExtensions).not.toHaveBeenCalled();
  });

  it('does not start the selected runtime through a config route', async () => {
    const h = await makeHarness();
    try {
      const response = await auth(
        request(h.app).post(
          `/workspaces/${encodeURIComponent(h.secondary.workspaceId)}/config/extensions/refresh`,
        ),
      );

      expect(response.status).toBe(404);
      expect(
        h.secondary.bridge.refreshWorkspaceExtensions,
      ).not.toHaveBeenCalled();
      expect(
        h.primary.bridge.refreshWorkspaceExtensions,
      ).not.toHaveBeenCalled();
      expect(
        h.primary.workspaceService.refreshExtensionsForAllSessions,
      ).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('enforces extension activation config owners in daemon routes', async () => {
    const h = await makeHarness();
    mockExtensionManager();
    const enableExtension = vi
      .spyOn(ExtensionManager.prototype, 'enableExtension')
      .mockResolvedValue({ generation: 7 } as never);
    try {
      const singularWorkspace = await auth(
        request(h.app)
          .post('/workspace/config/extensions/demo/enable')
          .send({ scope: 'workspace' }),
      );
      expect(singularWorkspace.status).toBe(400);
      expect(singularWorkspace.body).toMatchObject({
        code: 'workspace_scope_requires_qualified_workspace',
      });

      const qualifiedUser = await auth(
        request(h.app)
          .post(
            `/workspaces/${encodeURIComponent(h.secondary.workspaceId)}/config/extensions/demo/enable`,
          )
          .send({ scope: 'user' }),
      );
      expect(qualifiedUser.status).toBe(400);
      expect(qualifiedUser.body).toMatchObject({
        code: 'global_scope_requires_singular_owner',
      });
      expect(enableExtension).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('keeps global config independent of primary trust and only gates qualified mutations', async () => {
    const h = await makeHarness({
      primaryTrusted: false,
      secondaryTrusted: false,
    });
    mockExtensionManager();
    let globalManagerTrusted: boolean | undefined;
    vi.spyOn(
      ExtensionManager.prototype,
      'prepareExtensionInstall',
    ).mockImplementation(async function (this: ExtensionManager) {
      globalManagerTrusted = (
        this as unknown as { isWorkspaceTrusted: boolean }
      ).isWorkspaceTrusted;
      return {} as never;
    });
    vi.spyOn(
      ExtensionManager.prototype,
      'commitPreparedExtension',
    ).mockResolvedValue({
      identity: { id: extensionId, name: 'demo' },
      version: '1.0.0',
      generation: 7,
    } as never);
    vi.spyOn(
      ExtensionManager.prototype,
      'disposePreparedExtension',
    ).mockResolvedValue();
    const enableExtension = vi
      .spyOn(ExtensionManager.prototype, 'enableExtension')
      .mockResolvedValue({ generation: 7 } as never);
    try {
      const globalInventory = await auth(
        request(h.app).get('/workspace/config/extensions'),
      );
      expect(globalInventory.status).toBe(200);

      const globalMutation = await auth(
        request(h.app)
          .post('/workspace/config/extensions/install')
          .send({ source: '@scope/demo', consent: true }),
      );
      expect(globalMutation.status).toBe(202);
      await pollOperation(
        h.app,
        globalMutation.body.operationId,
        '/workspace/config/extensions/operations',
      );
      expect(globalManagerTrusted).toBe(true);

      const qualifiedBase = `/workspaces/${encodeURIComponent(h.secondary.workspaceId)}/config/extensions`;
      const qualifiedInventory = await auth(request(h.app).get(qualifiedBase));
      expect(qualifiedInventory.status).toBe(200);

      const qualifiedOperations = await auth(
        request(h.app).get(`${qualifiedBase}/operations`),
      );
      expect(qualifiedOperations.status).toBe(200);

      const qualifiedOperation = await auth(
        request(h.app).get(`${qualifiedBase}/operations/missing`),
      );
      expect(qualifiedOperation.status).toBe(404);
      expect(qualifiedOperation.body).toMatchObject({
        code: 'extension_operation_not_found',
      });

      const qualifiedMutation = await auth(
        request(h.app)
          .post(`${qualifiedBase}/demo/enable`)
          .send({ scope: 'workspace' }),
      );
      expect(qualifiedMutation.status).toBe(403);
      expect(qualifiedMutation.body).toMatchObject({
        code: 'untrusted_workspace',
      });
      expect(enableExtension).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('isolates legacy-primary and global config operations', async () => {
    const h = await makeHarness();
    mockExtensionManager();
    vi.spyOn(ExtensionManager.prototype, 'enableExtension').mockResolvedValue({
      generation: 7,
    } as never);
    try {
      const legacy = await auth(
        request(h.app)
          .post('/workspace/extensions/demo/enable')
          .send({ scope: 'workspace' }),
      );
      expect(legacy.status).toBe(202);
      const globalMiss = await auth(
        request(h.app).get(
          `/workspace/config/extensions/operations/${legacy.body.operationId}`,
        ),
      );
      expect(globalMiss.status).toBe(404);
      await pollOperation(
        h.app,
        legacy.body.operationId,
        '/workspace/extensions/operations',
      );

      const global = await auth(
        request(h.app)
          .post('/workspace/config/extensions/demo/enable')
          .send({ scope: 'user' }),
      );
      expect(global.status).toBe(202);
      const legacyMiss = await auth(
        request(h.app).get(
          `/workspace/extensions/operations/${global.body.operationId}`,
        ),
      );
      expect(legacyMiss.status).toBe(404);
      await pollOperation(
        h.app,
        global.body.operationId,
        '/workspace/config/extensions/operations',
      );
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('shares unfinished operation admission across config owners', async () => {
    const h = await makeHarness();
    mockExtensionManager();
    let releaseEnable = () => {};
    const enableGate = new Promise<void>((resolve) => {
      releaseEnable = resolve;
    });
    vi.spyOn(ExtensionManager.prototype, 'enableExtension').mockImplementation(
      async () => {
        await enableGate;
        return { generation: 7 } as never;
      },
    );
    const qualifiedBase = `/workspaces/${encodeURIComponent(h.secondary.workspaceId)}/config/extensions`;
    try {
      const globalRequests = Array.from({ length: 5 }, () =>
        auth(
          request(h.app)
            .post('/workspace/config/extensions/demo/enable')
            .send({ scope: 'user' }),
        ),
      );
      const qualifiedRequests = Array.from({ length: 5 }, () =>
        auth(
          request(h.app)
            .post(`${qualifiedBase}/demo/enable`)
            .send({ scope: 'workspace' }),
        ),
      );
      const [globalOperations, qualifiedOperations] = await Promise.all([
        Promise.all(globalRequests),
        Promise.all(qualifiedRequests),
      ]);

      expect(
        [...globalOperations, ...qualifiedOperations].every(
          (response) => response.status === 202,
        ),
      ).toBe(true);

      const rejected = await auth(
        request(h.app)
          .post('/workspace/extensions/demo/enable')
          .send({ scope: 'workspace' }),
      );
      expect(rejected.status).toBe(429);
      expect(rejected.body).toMatchObject({ code: 'extension_queue_full' });

      releaseEnable();
      await Promise.all([
        ...globalOperations.map((operation) =>
          pollOperation(
            h.app,
            operation.body.operationId,
            '/workspace/config/extensions/operations',
          ),
        ),
        ...qualifiedOperations.map((operation) =>
          pollOperation(
            h.app,
            operation.body.operationId,
            `${qualifiedBase}/operations`,
          ),
        ),
      ]);
    } finally {
      releaseEnable();
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    for (const app of activeApps) {
      (
        app.locals as { stopExtensionGenerationReconciler?: () => void }
      ).stopExtensionGenerationReconciler?.();
    }
    activeApps.clear();
    vi.restoreAllMocks();
  });

  it('advertises extension_management_v2 but not the abandoned capability', async () => {
    const h = await makeHarness({ singleWorkspace: true });
    try {
      const response = await auth(request(h.app).get('/capabilities'));
      expect(response.status).toBe(200);
      expect(response.body.features).toContain('extension_management_v2');
      expect(response.body.features).not.toContain(
        'workspace_qualified_extensions',
      );
      expect(response.body.workspaces).toEqual([
        expect.objectContaining({
          id: h.primary.workspaceId,
          cwd: h.primary.workspaceCwd,
          primary: true,
        }),
      ]);
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('returns a global catalog with generation and default activation', async () => {
    const h = await makeHarness();
    mockExtensionManager();
    try {
      const response = await auth(request(h.app).get('/extensions'));
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        v: 1,
        generation: 7,
        extensions: [
          {
            id: extensionId,
            name: 'demo',
            installType: 'archive-url',
            defaultActivation: 'disabled',
            workspaceOverrideCount: 0,
          },
        ],
      });
      expect(
        ExtensionManager.prototype.refreshCacheWithSnapshot,
      ).toHaveBeenCalledOnce();
      expect(
        ExtensionManager.prototype.getExtensionStoreSnapshot,
      ).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('stops request parsing after rejecting an invalid extension id', async () => {
    const h = await makeHarness();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const globalResponse = await auth(
        request(h.app)
          .put('/extensions/not-an-extension-id/activation')
          .send({ state: 'invalid' }),
      );
      const workspaceResponse = await auth(
        request(h.app)
          .put(
            `/workspaces/${encodeURIComponent(h.secondary.workspaceId)}/extensions/not-an-extension-id/activation`,
          )
          .send({ state: 'invalid' }),
      );

      expect(globalResponse.body).toMatchObject({
        code: 'invalid_extension_id',
      });
      expect(workspaceResponse.body).toMatchObject({
        code: 'invalid_extension_id',
      });
      expect(stderr).not.toHaveBeenCalledWith(
        expect.stringContaining('Cannot set headers after they are sent'),
      );
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('returns the selected workspace projection, including when untrusted', async () => {
    const h = await makeHarness({ secondaryTrusted: false });
    mockExtensionManager();
    try {
      const response = await auth(
        request(h.app).get(
          `/workspaces/${encodeURIComponent(h.secondary.workspaceId)}/extensions`,
        ),
      );
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        v: 1,
        workspaceId: h.secondary.workspaceId,
        workspaceCwd: h.secondary.workspaceCwd,
        desiredGeneration: 7,
        extensions: [
          {
            extensionId,
            defaultActivation: 'disabled',
            workspaceActivation: null,
            activationSource: 'default',
          },
        ],
      });
      expect(
        ExtensionManager.prototype.getExtensionActivationFromSnapshot,
      ).toHaveBeenCalledWith(
        extensionId,
        expect.objectContaining({ generation: 7 }),
        h.secondary.workspaceCwd,
      );
      expect(
        ExtensionManager.prototype.getExtensionActivation,
      ).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('changes only the target workspace activation and refreshes its runtime', async () => {
    const h = await makeHarness();
    mockExtensionManager();
    try {
      const started = await auth(
        request(h.app)
          .put(
            `/workspaces/${encodeURIComponent(h.secondary.workspaceId)}/extensions/${extensionId}/activation`,
          )
          .send({ state: 'enabled' }),
      );
      expect(started.status).toBe(202);
      expect(started.headers['location']).toBe(
        `/extensions/operations/${started.body.operationId}`,
      );
      const operation = await pollOperation(h.app, started.body.operationId);
      expect(operation.status).toBe('succeeded');
      expect(
        ExtensionManager.prototype.setExtensionWorkspaceActivation,
      ).toHaveBeenCalledWith(
        extensionId,
        h.secondary.workspaceCwd,
        'enabled',
        expect.any(Function),
      );
      expect(
        h.secondary.bridge.refreshWorkspaceExtensions,
      ).toHaveBeenCalledOnce();
      expect(
        h.primary.bridge.refreshWorkspaceExtensions,
      ).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('keeps a workspace management lease until an extension operation settles', async () => {
    const h = await makeHarness();
    mockExtensionManager();
    let finishCommit!: () => void;
    vi.mocked(
      ExtensionManager.prototype.setExtensionWorkspaceActivation,
    ).mockImplementationOnce(
      async (_extensionId, _workspaceCwd, _state, onCommitted) =>
        await new Promise<ExtensionStoreSnapshot>((resolve) => {
          finishCommit = () => {
            onCommitted?.(7);
            resolve({
              version: 2,
              generation: 7,
              legacyProjectionHash: 'hash',
              extensions: {},
            });
          };
        }),
    );
    try {
      const started = await auth(
        request(h.app)
          .put(
            `/workspaces/${encodeURIComponent(h.secondary.workspaceId)}/extensions/${extensionId}/activation`,
          )
          .send({ state: 'enabled' }),
      );

      expect(started.status).toBe(202);
      expect(getWorkspaceRuntimeCoordinator(h.secondary).hasActiveWork()).toBe(
        true,
      );
      await vi.waitFor(() => expect(finishCommit).toBeTypeOf('function'));
      finishCommit();
      await pollOperation(h.app, started.body.operationId);
      expect(getWorkspaceRuntimeCoordinator(h.secondary).hasActiveWork()).toBe(
        false,
      );
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('returns the effective activation after clearing a workspace override', async () => {
    const h = await makeHarness();
    mockExtensionManager();
    vi.mocked(
      ExtensionManager.prototype.getExtensionActivation,
    ).mockResolvedValue({
      default: 'enabled',
      workspace: 'inherit',
      effective: 'enabled',
      source: 'default',
    });
    try {
      const started = await auth(
        request(h.app).delete(
          `/workspaces/${encodeURIComponent(h.secondary.workspaceId)}/extensions/${extensionId}/activation`,
        ),
      );

      expect(started.status).toBe(202);
      await expect(
        pollOperation(h.app, started.body.operationId),
      ).resolves.toMatchObject({
        status: 'succeeded',
        result: { status: 'disabled', name: 'demo' },
      });
      expect(
        ExtensionManager.prototype.getExtensionActivation,
      ).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('reports a post-commit failure as succeeded with warnings', async () => {
    const h = await makeHarness();
    mockExtensionManager();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.mocked(
      h.secondary.workspaceService.invalidateWorkspaceSkillsStatus,
    ).mockImplementationOnce(() => {
      throw new Error('status invalidation failed');
    });
    try {
      const started = await auth(
        request(h.app).delete(
          `/workspaces/${encodeURIComponent(h.secondary.workspaceId)}/extensions/${extensionId}/activation`,
        ),
      );

      expect(started.status).toBe(202);
      await expect(
        pollOperation(h.app, started.body.operationId),
      ).resolves.toMatchObject({
        status: 'succeeded_with_warnings',
        warnings: [
          expect.objectContaining({
            error: expect.stringMatching(/status invalidation failed/),
            workspaceId: h.secondary.workspaceId,
          }),
        ],
      });
      expect(
        h.primary.workspaceService.invalidateWorkspaceSkillsStatus,
      ).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('includes the mutation status in post-commit failure broadcasts', async () => {
    const h = await makeHarness();
    mockExtensionManager();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.mocked(
      h.secondary.workspaceService.invalidateWorkspaceSkillsStatus,
    ).mockImplementationOnce(() => {
      throw new Error('status invalidation failed');
    });
    try {
      const started = await auth(
        request(h.app).delete(
          `/workspaces/${encodeURIComponent(h.secondary.workspaceId)}/extensions/${extensionId}/activation`,
        ),
      );

      await expect(
        pollOperation(h.app, started.body.operationId),
      ).resolves.toMatchObject({
        status: 'succeeded_with_warnings',
        result: { status: 'disabled', name: 'demo' },
      });
      expect(
        h.secondary.bridge.broadcastExtensionsChanged,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'disabled', failed: 1 }),
      );
      expect(
        h.primary.bridge.broadcastExtensionsChanged,
      ).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('keeps generation polling serialized while a runtime refresh is in flight', async () => {
    vi.useFakeTimers();
    const h = await makeHarness();
    mockExtensionManager();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let releaseRefresh = () => {};
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    vi.mocked(h.secondary.bridge.refreshWorkspaceExtensions!)
      .mockImplementationOnce(async () => {
        await refreshGate;
        return { refreshed: 1, failed: 0, generation: 7, runtimeEpoch: 1 };
      })
      .mockResolvedValue({
        refreshed: 1,
        failed: 0,
        generation: 7,
        runtimeEpoch: 1,
      } as never);
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(
        h.secondary.bridge.refreshWorkspaceExtensions,
      ).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(90_000);

      expect(
        h.secondary.bridge.refreshWorkspaceExtensions,
      ).toHaveBeenCalledOnce();
      expect(
        h.primary.bridge.refreshWorkspaceExtensions,
      ).toHaveBeenCalledOnce();

      releaseRefresh();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(
        h.secondary.bridge.refreshWorkspaceExtensions,
      ).toHaveBeenCalledOnce();
    } finally {
      releaseRefresh();
      vi.useRealTimers();
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('runs generation polling through the workspace extension lane', async () => {
    vi.useFakeTimers();
    const h = await makeHarness();
    mockExtensionManager();
    let releaseLane = () => {};
    const laneGate = new Promise<void>((resolve) => {
      releaseLane = resolve;
    });
    const coordinator = getWorkspaceRuntimeCoordinator(h.secondary);
    const blocker = coordinator.runExtensionsPhysicalReconciliation(
      async () => await laneGate,
    );
    try {
      await vi.advanceTimersByTimeAsync(30_000);

      expect(
        h.secondary.bridge.refreshWorkspaceExtensions,
      ).not.toHaveBeenCalled();

      releaseLane();
      await blocker;
      await vi.waitFor(() =>
        expect(
          h.secondary.bridge.refreshWorkspaceExtensions,
        ).toHaveBeenCalledOnce(),
      );
    } finally {
      releaseLane();
      await blocker;
      vi.useRealTimers();
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('does not wake a cold runtime during generation reconciliation', async () => {
    vi.useFakeTimers();
    const h = await makeHarness();
    mockExtensionManager();
    const secondaryLive = vi.mocked(h.secondary.bridge.isChannelLive);
    secondaryLive.mockReturnValue(false);
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(
        h.secondary.bridge.refreshWorkspaceExtensions,
      ).not.toHaveBeenCalled();

      secondaryLive.mockReturnValue(true);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(
        h.secondary.bridge.refreshWorkspaceExtensions,
      ).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('retries generation reconciliation after a runtime refresh fails', async () => {
    vi.useFakeTimers();
    const h = await makeHarness();
    mockExtensionManager();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.mocked(h.secondary.bridge.refreshWorkspaceExtensions!)
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValue({
        refreshed: 1,
        failed: 0,
        generation: 7,
        runtimeEpoch: 1,
      } as never);
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(
        h.secondary.bridge.refreshWorkspaceExtensions,
      ).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(30_000);

      expect(
        h.secondary.bridge.refreshWorkspaceExtensions,
      ).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('reconciles runtimes when the authoritative generation rolls back', async () => {
    vi.useFakeTimers();
    const h = await makeHarness();
    mockExtensionManager();
    const rolledBackSnapshot: ExtensionStoreSnapshot = {
      version: 2,
      generation: 6,
      legacyProjectionHash: 'rolled-back-hash',
      extensions: {
        [extensionId]: {
          name: 'demo',
          defaultActivation: 'disabled',
          workspaceOverrides: {},
        },
      },
    };
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(
        h.secondary.bridge.refreshWorkspaceExtensions,
      ).toHaveBeenCalledOnce();

      vi.mocked(
        ExtensionManager.prototype.getExtensionStoreSnapshot,
      ).mockResolvedValue(rolledBackSnapshot);
      vi.mocked(
        ExtensionManager.prototype.refreshCacheWithSnapshot,
      ).mockResolvedValue(rolledBackSnapshot);
      vi.mocked(
        h.secondary.bridge.refreshWorkspaceExtensions!,
      ).mockResolvedValue({
        refreshed: 1,
        failed: 0,
        generation: 6,
        runtimeEpoch: 1,
      } as never);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(
        h.secondary.bridge.refreshWorkspaceExtensions,
      ).toHaveBeenCalledTimes(2);
      const projection = await auth(
        request(h.app).get(
          `/workspaces/${encodeURIComponent(h.secondary.workspaceId)}/extensions`,
        ),
      );
      expect(projection.body).toMatchObject({
        desiredGeneration: 6,
        appliedGeneration: 6,
      });
    } finally {
      vi.useRealTimers();
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('reconciles a runtime added after the generation stabilizes', async () => {
    vi.useFakeTimers();
    const h = await makeHarness();
    mockExtensionManager();
    try {
      await vi.advanceTimersByTimeAsync(30_000);

      const lateCwd = path.join(h.scratch, 'late-stable');
      await fsp.mkdir(lateCwd, { recursive: true });
      const late = makeRuntime(canonicalizeWorkspace(lateCwd), {
        primary: false,
        trusted: true,
        workspaceId: 'late-stable-id',
      });
      h.registry.add(late);

      await vi.advanceTimersByTimeAsync(30_000);

      expect(late.bridge.refreshWorkspaceExtensions).toHaveBeenCalledOnce();
      const projection = await auth(
        request(h.app).get('/workspaces/late-stable-id/extensions'),
      );
      expect(projection.body).toMatchObject({
        desiredGeneration: 7,
        appliedGeneration: 7,
      });
    } finally {
      vi.useRealTimers();
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('advances applied generation only after the workspace reconciles', async () => {
    const h = await makeHarness();
    mockExtensionManager();
    vi.mocked(h.secondary.bridge.refreshWorkspaceExtensions!)
      .mockResolvedValueOnce({
        refreshed: 0,
        failed: 1,
        runtimeEpoch: 1,
      } as never)
      .mockResolvedValue({
        refreshed: 1,
        failed: 0,
        generation: 7,
        runtimeEpoch: 1,
      } as never);
    try {
      const activation = await auth(
        request(h.app)
          .put(
            `/workspaces/${encodeURIComponent(h.secondary.workspaceId)}/extensions/${extensionId}/activation`,
          )
          .send({ state: 'enabled' }),
      );
      expect(activation.status).toBe(202);
      await expect(
        pollOperation(h.app, activation.body.operationId),
      ).resolves.toMatchObject({ status: 'succeeded_with_warnings' });

      const drifted = await auth(
        request(h.app).get(
          `/workspaces/${encodeURIComponent(h.secondary.workspaceId)}/extensions`,
        ),
      );
      expect(drifted.body).toMatchObject({
        desiredGeneration: 7,
        appliedGeneration: 0,
      });

      const refresh = await auth(
        request(h.app).post(
          `/workspaces/${encodeURIComponent(h.secondary.workspaceId)}/extensions/refresh`,
        ),
      );
      expect(refresh.status).toBe(202);
      await expect(
        pollOperation(h.app, refresh.body.operationId),
      ).resolves.toMatchObject({ status: 'succeeded' });

      const converged = await auth(
        request(h.app).get(
          `/workspaces/${encodeURIComponent(h.secondary.workspaceId)}/extensions`,
        ),
      );
      expect(converged.body).toMatchObject({
        desiredGeneration: 7,
        appliedGeneration: 7,
      });
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('serializes runtime reconciliation in generation order', async () => {
    const h = await makeHarness();
    mockExtensionManager();
    const snapshot = (generation: number): ExtensionStoreSnapshot => ({
      version: 2,
      generation,
      legacyProjectionHash: 'hash',
      extensions: {
        [extensionId]: {
          name: 'demo',
          defaultActivation: 'disabled',
          workspaceOverrides: {},
        },
      },
    });
    let releaseFirstCommit: (() => void) | undefined;
    vi.mocked(ExtensionManager.prototype.setExtensionWorkspaceActivation)
      .mockImplementationOnce(
        async (_id, _workspace, _activation, committed) => {
          committed?.(8);
          await new Promise<void>((resolve) => {
            releaseFirstCommit = resolve;
          });
          return snapshot(8);
        },
      )
      .mockImplementationOnce(
        async (_id, _workspace, _activation, committed) => {
          committed?.(9);
          return snapshot(9);
        },
      );
    vi.mocked(
      ExtensionManager.prototype.getExtensionStoreSnapshot,
    ).mockResolvedValue(snapshot(9));
    vi.mocked(h.secondary.bridge.refreshWorkspaceExtensions!).mockResolvedValue(
      {
        refreshed: 1,
        failed: 0,
        generation: 9,
        runtimeEpoch: 1,
      } as never,
    );
    try {
      const first = await auth(
        request(h.app)
          .put(
            `/workspaces/${encodeURIComponent(h.secondary.workspaceId)}/extensions/${extensionId}/activation`,
          )
          .send({ state: 'enabled' }),
      );
      await vi.waitFor(() => expect(releaseFirstCommit).toBeDefined());

      const second = await auth(
        request(h.app)
          .put(
            `/workspaces/${encodeURIComponent(h.secondary.workspaceId)}/extensions/${extensionId}/activation`,
          )
          .send({ state: 'disabled' }),
      );
      await vi.waitFor(async () => {
        const operation = await auth(
          request(h.app).get(
            `/extensions/operations/${second.body.operationId}`,
          ),
        );
        expect(operation.body).toMatchObject({
          status: 'running',
          phase: 'reconciling',
        });
      });
      expect(
        h.secondary.bridge.refreshWorkspaceExtensions,
      ).not.toHaveBeenCalled();

      releaseFirstCommit?.();
      await expect(
        pollOperation(h.app, second.body.operationId),
      ).resolves.toMatchObject({ status: 'succeeded' });
      await expect(
        pollOperation(h.app, first.body.operationId),
      ).resolves.toMatchObject({
        status: 'succeeded',
        result: { activation: 'deferred' },
      });
      expect(
        h.secondary.bridge.refreshWorkspaceExtensions,
      ).toHaveBeenCalledOnce();
      const projection = await auth(
        request(h.app).get(
          `/workspaces/${encodeURIComponent(h.secondary.workspaceId)}/extensions`,
        ),
      );
      expect(projection.body.appliedGeneration).toBe(9);
    } finally {
      releaseFirstCommit?.();
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('fans a global default change out to every registered workspace', async () => {
    const h = await makeHarness();
    mockExtensionManager();
    try {
      const started = await auth(
        request(h.app)
          .put(`/extensions/${extensionId}/activation`)
          .send({ state: 'disabled' }),
      );
      expect(started.status).toBe(202);
      const operation = await pollOperation(h.app, started.body.operationId);
      expect(operation.status).toBe('succeeded');
      expect(
        h.primary.bridge.refreshWorkspaceExtensions,
      ).toHaveBeenCalledOnce();
      expect(
        h.secondary.bridge.refreshWorkspaceExtensions,
      ).toHaveBeenCalledOnce();
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('defers physical refresh for a draining runtime while advancing its desired generation', async () => {
    const h = await makeHarness();
    mockExtensionManager();
    expect(h.registry.beginDrain(h.secondary)).toBe(true);
    try {
      const started = await auth(
        request(h.app)
          .put(`/extensions/${extensionId}/activation`)
          .send({ state: 'disabled' }),
      );
      expect(started.status).toBe(202);
      await expect(
        pollOperation(h.app, started.body.operationId),
      ).resolves.toMatchObject({ status: 'succeeded' });

      expect(
        h.primary.bridge.refreshWorkspaceExtensions,
      ).toHaveBeenCalledOnce();
      expect(
        h.secondary.bridge.refreshWorkspaceExtensions,
      ).not.toHaveBeenCalled();
      expect(
        getWorkspaceRuntimeCoordinator(h.secondary).status().capabilities
          .extensions,
      ).toMatchObject({
        desiredGeneration: 7,
      });
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('includes runtimes registered while a global mutation is committing', async () => {
    const h = await makeHarness();
    mockExtensionManager();
    let commitStarted = false;
    let releaseCommit = () => {};
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    vi.mocked(
      ExtensionManager.prototype.setExtensionDefaultActivation,
    ).mockImplementation(async () => {
      commitStarted = true;
      await commitGate;
      return {
        version: 2,
        generation: 7,
        legacyProjectionHash: 'hash',
        extensions: {
          [extensionId]: {
            name: 'demo',
            defaultActivation: 'disabled',
            workspaceOverrides: {},
          },
        },
      };
    });
    try {
      const started = await auth(
        request(h.app)
          .put(`/extensions/${extensionId}/activation`)
          .send({ state: 'disabled' }),
      );
      expect(started.status).toBe(202);
      await vi.waitFor(() => expect(commitStarted).toBe(true));

      const lateCwd = path.join(h.scratch, 'late');
      await fsp.mkdir(lateCwd, { recursive: true });
      const late = makeRuntime(canonicalizeWorkspace(lateCwd), {
        primary: false,
        trusted: true,
        workspaceId: 'late-id',
      });
      h.registry.add(late);
      releaseCommit();

      await expect(
        pollOperation(h.app, started.body.operationId),
      ).resolves.toMatchObject({ status: 'succeeded' });
      expect(late.bridge.refreshWorkspaceExtensions).toHaveBeenCalledOnce();
      const projection = await auth(
        request(h.app).get('/workspaces/late-id/extensions'),
      );
      expect(projection.body).toMatchObject({
        desiredGeneration: 7,
        appliedGeneration: 7,
      });
    } finally {
      releaseCommit();
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('validates mutation clients against the targeted runtime set', async () => {
    const h = await makeHarness();
    mockExtensionManager();
    vi.spyOn(h.primary.bridge, 'knownClientIds').mockReturnValue(
      new Set(['primary-client']),
    );
    vi.spyOn(h.secondary.bridge, 'knownClientIds').mockReturnValue(
      new Set(['secondary-client']),
    );
    const secondaryAuth = (pending: request.Test) =>
      pending
        .set('Host', host())
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'secondary-client');
    try {
      const wrongRuntime = await request(h.app)
        .put(
          `/workspaces/${encodeURIComponent(h.secondary.workspaceId)}/extensions/${extensionId}/activation`,
        )
        .set('Host', host())
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'primary-client')
        .send({ state: 'enabled' });
      expect(wrongRuntime.status).toBe(400);
      expect(wrongRuntime.body).toMatchObject({ code: 'invalid_client_id' });

      const targeted = await secondaryAuth(
        request(h.app)
          .put(
            `/workspaces/${encodeURIComponent(h.secondary.workspaceId)}/extensions/${extensionId}/activation`,
          )
          .send({ state: 'enabled' }),
      );
      expect(targeted.status).toBe(202);
      await expect(
        pollOperation(h.app, targeted.body.operationId),
      ).resolves.toMatchObject({ status: 'succeeded' });

      const global = await secondaryAuth(
        request(h.app)
          .put(`/extensions/${extensionId}/activation`)
          .send({ state: 'disabled' }),
      );
      expect(global.status).toBe(202);
      await expect(
        pollOperation(h.app, global.body.operationId),
      ).resolves.toMatchObject({ status: 'succeeded' });
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('allows bearer-authenticated global install without a workspace client id', async () => {
    const h = await makeHarness();
    mockExtensionManager();
    const prepareInstall = vi
      .spyOn(ExtensionManager.prototype, 'prepareExtensionInstall')
      .mockResolvedValue({} as never);
    vi.spyOn(
      ExtensionManager.prototype,
      'commitPreparedExtension',
    ).mockResolvedValue({
      identity: { id: extensionId, name: 'demo' },
      version: '1.0.0',
      generation: 7,
    } as never);
    vi.spyOn(
      ExtensionManager.prototype,
      'disposePreparedExtension',
    ).mockResolvedValue();
    try {
      const started = await request(h.app)
        .post('/extensions/install')
        .set('Host', host())
        .set('Authorization', 'Bearer secret')
        .send({
          source: '@scope/demo:plugin',
          consent: true,
          activation: { scope: 'user' },
        });

      expect(started.status).toBe(202);
      await expect(
        pollOperation(h.app, started.body.operationId),
      ).resolves.toMatchObject({
        status: 'succeeded',
        result: { status: 'installed', name: 'demo' },
      });
      expect(prepareInstall).toHaveBeenCalledWith(
        expect.objectContaining({
          installMetadata: expect.objectContaining({
            source: '@scope/demo',
            type: 'npm',
            pluginName: 'plugin',
          }),
        }),
      );
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('does not accept a primary extension interaction through another workspace', async () => {
    const h = await makeHarness();
    mockExtensionManager();
    vi.spyOn(
      ExtensionManager.prototype,
      'prepareExtensionInstall',
    ).mockImplementation(async function (this: ExtensionManager) {
      const manager = this as unknown as {
        requestSetting?: (setting: {
          name: string;
          description: string;
          envVar: string;
        }) => Promise<string>;
      };
      await manager.requestSetting?.({
        name: 'API key',
        description: 'API key used by this extension',
        envVar: 'API_KEY',
      });
      return {} as never;
    });
    try {
      const started = await auth(
        request(h.app)
          .post('/workspace/config/extensions/install')
          .send({ source: '@scope/demo', consent: true }),
      );
      expect(started.status).toBe(202);

      let interactionId = '';
      await vi.waitFor(async () => {
        const operation = await auth(
          request(h.app).get(
            `/workspace/config/extensions/operations/${started.body.operationId}`,
          ),
        );
        expect(operation.body.status).toBe('waiting_for_input');
        interactionId = operation.body.interaction.id as string;
      });

      const crossWorkspace = await auth(
        request(h.app)
          .post(
            `/workspaces/${encodeURIComponent(h.secondary.workspaceId)}/config/extensions/operations/${started.body.operationId}/interactions/${interactionId}`,
          )
          .send({ value: 'secret' }),
      );
      expect(crossWorkspace.status).toBe(404);

      const stillWaiting = await auth(
        request(h.app).get(
          `/workspace/config/extensions/operations/${started.body.operationId}`,
        ),
      );
      expect(stillWaiting.body.status).toBe('waiting_for_input');

      const cancel = await auth(
        request(h.app)
          .post(
            `/workspace/config/extensions/operations/${started.body.operationId}/interactions/${interactionId}`,
          )
          .send({ cancelled: true }),
      );
      expect(cancel.status).toBe(200);
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('preserves prototype-named extension update states', async () => {
    const h = await makeHarness();
    mockExtensionManager();
    vi.spyOn(
      ExtensionManager.prototype,
      'checkForAllExtensionUpdates',
    ).mockImplementation(async (onResult) => {
      onResult('__proto__', 'update available' as never);
    });
    try {
      const legacy = await auth(
        request(h.app).post('/workspace/extensions/check-updates'),
      );
      expect(legacy.status).toBe(200);
      expect(Object.hasOwn(legacy.body.states, '__proto__')).toBe(true);
      expect(legacy.body.states['__proto__']).toBe('update available');

      const started = await auth(
        request(h.app).post('/extensions/check-updates'),
      );
      expect(started.status).toBe(202);
      const operation = await pollOperation(h.app, started.body.operationId);
      expect(operation.status).toBe('succeeded');
      expect(Object.hasOwn(operation.result.states, '__proto__')).toBe(true);
      expect(operation.result.states['__proto__']).toBe('update available');
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('times out a legacy update check while its cache refresh stalls', async () => {
    vi.useFakeTimers();
    const h = await makeHarness();
    mockExtensionManager();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stalledRefresh = new Promise<void>(() => {});
    const refreshCache = vi
      .spyOn(ExtensionManager.prototype, 'refreshCache')
      .mockImplementationOnce(async () => await stalledRefresh)
      .mockResolvedValue(undefined);
    try {
      const response = auth(
        request(h.app).post('/workspace/extensions/check-updates'),
      ).then((result) => result);
      await vi.waitFor(() => expect(refreshCache).toHaveBeenCalledOnce());

      await vi.advanceTimersByTimeAsync(2 * 60_000);

      await expect(response).resolves.toMatchObject({
        status: 500,
        body: { code: 'extension_prepare_timeout' },
      });
      const next = await auth(
        request(h.app).post('/workspace/extensions/check-updates'),
      );
      expect(next.status).toBe(200);
    } finally {
      vi.useRealTimers();
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('reports legacy global mutations as applied after runtime reconciliation', async () => {
    const h = await makeHarness();
    mockExtensionManager();
    vi.spyOn(
      ExtensionManager.prototype,
      'prepareExtensionInstall',
    ).mockResolvedValue({} as never);
    vi.spyOn(
      ExtensionManager.prototype,
      'commitPreparedExtension',
    ).mockResolvedValue({
      identity: { id: extensionId, name: 'demo' },
      version: '1.0.0',
      generation: 7,
    } as never);
    vi.spyOn(
      ExtensionManager.prototype,
      'disposePreparedExtension',
    ).mockResolvedValue();
    try {
      const started = await auth(
        request(h.app)
          .post('/workspace/extensions/install')
          .send({ source: '@scope/demo', consent: true }),
      );

      expect(started.status).toBe(202);
      await expect(
        pollOperation(
          h.app,
          started.body.operationId,
          '/workspace/extensions/operations',
        ),
      ).resolves.toMatchObject({ status: 'succeeded' });

      const projection = await auth(
        request(h.app).get(
          `/workspaces/${encodeURIComponent(h.secondary.workspaceId)}/extensions`,
        ),
      );
      expect(projection.body).toMatchObject({
        desiredGeneration: 7,
        appliedGeneration: 7,
      });
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('reports legacy workspace activation mutations as applied immediately', async () => {
    const h = await makeHarness();
    mockExtensionManager();
    vi.spyOn(ExtensionManager.prototype, 'enableExtension').mockResolvedValue({
      generation: 7,
    } as never);
    vi.spyOn(ExtensionManager.prototype, 'disableExtension').mockResolvedValue({
      generation: 8,
    } as never);
    try {
      const enable = await auth(
        request(h.app)
          .post('/workspace/extensions/demo/enable')
          .send({ scope: 'workspace' }),
      );
      expect(enable.status).toBe(202);
      await expect(
        pollOperation(
          h.app,
          enable.body.operationId,
          '/workspace/extensions/operations',
        ),
      ).resolves.toMatchObject({ status: 'succeeded' });

      const enabledProjection = await auth(
        request(h.app).get(
          `/workspaces/${encodeURIComponent(h.primary.workspaceId)}/extensions`,
        ),
      );
      expect(enabledProjection.body).toMatchObject({
        desiredGeneration: 7,
        appliedGeneration: 7,
      });

      vi.mocked(
        ExtensionManager.prototype.getExtensionStoreSnapshot,
      ).mockResolvedValue({
        version: 2,
        generation: 8,
        legacyProjectionHash: 'hash',
        extensions: {},
      });
      vi.mocked(
        ExtensionManager.prototype.refreshCacheWithSnapshot,
      ).mockResolvedValue({
        version: 2,
        generation: 8,
        legacyProjectionHash: 'hash',
        extensions: {},
      });
      const disable = await auth(
        request(h.app)
          .post('/workspace/extensions/demo/disable')
          .send({ scope: 'workspace' }),
      );
      expect(disable.status).toBe(202);
      await expect(
        pollOperation(
          h.app,
          disable.body.operationId,
          '/workspace/extensions/operations',
        ),
      ).resolves.toMatchObject({ status: 'succeeded' });

      const disabledProjection = await auth(
        request(h.app).get(
          `/workspaces/${encodeURIComponent(h.primary.workspaceId)}/extensions`,
        ),
      );
      expect(disabledProjection.body).toMatchObject({
        desiredGeneration: 8,
        appliedGeneration: 8,
      });
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('updates archive URL extensions through the global V2 route', async () => {
    const h = await makeHarness();
    mockExtensionManager();
    const prepared = {} as never;
    const prepareUpdate = vi
      .spyOn(ExtensionManager.prototype, 'prepareExtensionUpdate')
      .mockResolvedValue({ upToDate: false, prepared });
    const commitPrepared = vi
      .spyOn(ExtensionManager.prototype, 'commitPreparedExtension')
      .mockResolvedValue({
        identity: { id: extensionId, name: 'demo' },
        version: '2.0.0',
        generation: 8,
      } as never);
    const disposePrepared = vi
      .spyOn(ExtensionManager.prototype, 'disposePreparedExtension')
      .mockResolvedValue();
    vi.mocked(h.primary.bridge.refreshWorkspaceExtensions!).mockResolvedValue({
      refreshed: 1,
      failed: 0,
      generation: 8,
      runtimeEpoch: 1,
    } as never);
    vi.mocked(h.secondary.bridge.refreshWorkspaceExtensions!).mockResolvedValue(
      {
        refreshed: 1,
        failed: 0,
        generation: 8,
        runtimeEpoch: 1,
      } as never,
    );
    try {
      const started = await auth(
        request(h.app).post(`/extensions/${extensionId}/update`),
      );

      expect(started.status).toBe(202);
      await expect(
        pollOperation(h.app, started.body.operationId),
      ).resolves.toMatchObject({
        status: 'succeeded',
        result: {
          status: 'updated',
          name: 'demo',
          updated: true,
          version: '2.0.0',
        },
      });
      expect(prepareUpdate).toHaveBeenCalledWith({
        extension: expect.objectContaining({
          id: extensionId,
          installMetadata: expect.objectContaining({ type: 'archive-url' }),
        }),
        signal: expect.any(AbortSignal),
      });
      expect(commitPrepared).toHaveBeenCalledWith(
        prepared,
        expect.any(Function),
      );
      expect(disposePrepared).toHaveBeenCalledWith(prepared);
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('reports an up-to-date V2 update as checked without committing', async () => {
    const h = await makeHarness();
    const extension = mockExtensionManager();
    const prepareUpdate = vi
      .spyOn(ExtensionManager.prototype, 'prepareExtensionUpdate')
      .mockResolvedValue({ upToDate: true, extension });
    const commitPrepared = vi.spyOn(
      ExtensionManager.prototype,
      'commitPreparedExtension',
    );
    try {
      const started = await auth(
        request(h.app).post(`/extensions/${extensionId}/update`),
      );

      expect(started.status).toBe(202);
      await expect(
        pollOperation(h.app, started.body.operationId),
      ).resolves.toMatchObject({
        status: 'succeeded',
        result: {
          status: 'checked',
          name: 'demo',
          updated: false,
          reason: 'up_to_date',
        },
      });
      expect(commitPrepared).not.toHaveBeenCalled();
    } finally {
      prepareUpdate.mockRestore();
      commitPrepared.mockRestore();
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('preserves structured update preparation error codes', async () => {
    const h = await makeHarness();
    mockExtensionManager();
    const timeout = Object.assign(
      new Error('preparation timed out\n\u001b[31mforged\u001b[0m'),
      {
        code: 'extension_prepare_timeout',
      },
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.spyOn(
      ExtensionManager.prototype,
      'prepareExtensionUpdate',
    ).mockRejectedValue(timeout);
    try {
      const started = await auth(
        request(h.app).post('/workspace/extensions/demo/update'),
      );

      expect(started.status).toBe(202);
      await expect(
        pollOperation(
          h.app,
          started.body.operationId,
          '/workspace/extensions/operations',
        ),
      ).resolves.toMatchObject({
        status: 'failed',
        code: 'extension_prepare_timeout',
        error:
          'Update check failed for extension "demo": preparation timed outforged',
      });
      expect(stderr).not.toHaveBeenCalledWith(
        expect.stringContaining('\nforged'),
      );
      expect(stderr).not.toHaveBeenCalledWith(
        expect.stringContaining('\u001b'),
      );
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('still rejects non-updatable extensions through the global V2 route', async () => {
    const h = await makeHarness();
    mockExtensionManager('local');
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const prepareUpdate = vi.spyOn(
      ExtensionManager.prototype,
      'prepareExtensionUpdate',
    );
    try {
      const started = await auth(
        request(h.app).post(`/extensions/${extensionId}/update`),
      );

      expect(started.status).toBe(202);
      await expect(
        pollOperation(h.app, started.body.operationId),
      ).resolves.toMatchObject({
        status: 'failed',
        error: 'Extension "demo" is not remotely updatable.',
      });
      expect(prepareUpdate).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('validates uninstall clients before reading extension state', async () => {
    const h = await makeHarness();
    mockExtensionManager();
    try {
      const response = await request(h.app)
        .delete(`/extensions/${extensionId}`)
        .set('Host', host())
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'invalid client id');

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'invalid_client_id' });
      expect(
        ExtensionManager.prototype.getExtensionStoreSnapshot,
      ).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('routes uninstall store lookup failures through the bridge error handler', async () => {
    const h = await makeHarness();
    mockExtensionManager();
    vi.mocked(
      ExtensionManager.prototype.getExtensionStoreSnapshot,
    ).mockRejectedValueOnce(new Error('extension lookup failed'));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const response = await auth(
        request(h.app).delete(`/extensions/${extensionId}`),
      );

      expect(response.status).toBe(500);
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining(
          'bridge error (DELETE /extensions/:extensionId)',
        ),
      );
      expect(stderr).not.toHaveBeenCalledWith(
        expect.stringContaining('unhandled error'),
      );
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('uninstalls by store identity when the extension is not loadable', async () => {
    const h = await makeHarness();
    mockExtensionManager();
    vi.mocked(ExtensionManager.prototype.getLoadedExtensions).mockReturnValue(
      [],
    );
    try {
      const started = await auth(
        request(h.app).delete(`/extensions/${extensionId}`),
      );

      expect(started.status).toBe(202);
      await expect(
        pollOperation(h.app, started.body.operationId),
      ).resolves.toMatchObject({
        status: 'succeeded',
        result: { status: 'uninstalled', name: 'demo' },
      });
      expect(
        ExtensionManager.prototype.uninstallExtensionById,
      ).toHaveBeenCalledWith(
        extensionId,
        false,
        undefined,
        expect.any(Function),
      );
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('rejects workspace activation on an untrusted target', async () => {
    const h = await makeHarness({ secondaryTrusted: false });
    mockExtensionManager();
    try {
      const response = await auth(
        request(h.app)
          .put(
            `/workspaces/${encodeURIComponent(h.secondary.workspaceId)}/extensions/${extensionId}/activation`,
          )
          .send({ state: 'enabled' }),
      );
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('untrusted_workspace');
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('does not expose workspace-qualified install/update/uninstall routes', async () => {
    const h = await makeHarness();
    mockExtensionManager();
    try {
      const response = await auth(
        request(h.app)
          .post(
            `/workspaces/${encodeURIComponent(h.secondary.workspaceId)}/extensions/install`,
          )
          .send({ source: 'https://github.com/example/extension' }),
      );
      expect(response.status).toBe(404);
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });
});
