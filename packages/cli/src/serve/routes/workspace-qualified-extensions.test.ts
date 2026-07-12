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
    publishWorkspaceEvent: vi.fn(),
    refreshExtensionsForAllSessions: vi.fn(async () => ({
      refreshed: 1,
      failed: 0,
    })),
    broadcastExtensionsChanged: vi.fn(),
    getDaemonStatusSnapshot: vi.fn(() => ({
      limits: {
        maxSessions: 20,
        maxPendingPromptsPerSession: 5,
        eventRingSize: 8000,
        compactedReplayMaxBytes: 4 * 1024 * 1024,
        channelIdleTimeoutMs: 0,
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

async function makeHarness(opts?: { secondaryTrusted?: boolean }) {
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
    trusted: true,
    workspaceId: 'primary-id',
  });
  const secondary = makeRuntime(canonicalSecondary, {
    primary: false,
    trusted: opts?.secondaryTrusted ?? true,
    workspaceId: hashDaemonWorkspace(canonicalSecondary),
  });
  const registry = createWorkspaceRegistry([primary, secondary]);
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
    const h = await makeHarness();
    try {
      const response = await auth(request(h.app).get('/capabilities'));
      expect(response.status).toBe(200);
      expect(response.body.features).toContain('extension_management_v2');
      expect(response.body.features).not.toContain(
        'workspace_qualified_extensions',
      );
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
            effectiveActivation: 'disabled',
            activationSource: 'default',
          },
        ],
      });
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
      ).toHaveBeenCalledWith(extensionId, h.secondary.workspaceCwd, 'enabled');
      expect(
        h.secondary.bridge.refreshExtensionsForAllSessions,
      ).toHaveBeenCalledOnce();
      expect(
        h.primary.bridge.refreshExtensionsForAllSessions,
      ).not.toHaveBeenCalled();
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

  it('does not overlap generation reconciliation after a runtime refresh times out', async () => {
    vi.useFakeTimers();
    const h = await makeHarness();
    mockExtensionManager();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let releaseRefresh = () => {};
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    vi.mocked(h.secondary.bridge.refreshExtensionsForAllSessions)
      .mockImplementationOnce(async () => {
        await refreshGate;
        return { refreshed: 1, failed: 0 };
      })
      .mockResolvedValue({ refreshed: 1, failed: 0 });
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(
        h.secondary.bridge.refreshExtensionsForAllSessions,
      ).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(90_000);

      expect(
        h.secondary.bridge.refreshExtensionsForAllSessions,
      ).toHaveBeenCalledOnce();
      expect(
        h.primary.bridge.refreshExtensionsForAllSessions,
      ).toHaveBeenCalledOnce();
      expect(process.stderr.write).toHaveBeenCalledWith(
        expect.stringContaining(
          `extension generation reconciliation failed for workspace ${h.secondary.workspaceId}`,
        ),
      );

      releaseRefresh();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(
        h.secondary.bridge.refreshExtensionsForAllSessions,
      ).toHaveBeenCalledTimes(2);
    } finally {
      releaseRefresh();
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

      expect(
        late.bridge.refreshExtensionsForAllSessions,
      ).toHaveBeenCalledOnce();
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
    vi.mocked(h.secondary.bridge.refreshExtensionsForAllSessions)
      .mockResolvedValueOnce({ refreshed: 0, failed: 1 })
      .mockResolvedValue({ refreshed: 1, failed: 0 });
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

  it('does not let a late lower-generation reconcile move applied state backwards', async () => {
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
    vi.mocked(ExtensionManager.prototype.setExtensionWorkspaceActivation)
      .mockResolvedValueOnce(snapshot(8))
      .mockResolvedValueOnce(snapshot(9));
    vi.mocked(
      ExtensionManager.prototype.getExtensionStoreSnapshot,
    ).mockResolvedValue(snapshot(9));
    let releaseFirst: (() => void) | undefined;
    vi.mocked(h.secondary.bridge.refreshExtensionsForAllSessions)
      .mockImplementationOnce(
        async () =>
          await new Promise<{ refreshed: number; failed: number }>(
            (resolve) => {
              releaseFirst = () => resolve({ refreshed: 1, failed: 0 });
            },
          ),
      )
      .mockResolvedValue({ refreshed: 1, failed: 0 });
    try {
      const first = await auth(
        request(h.app)
          .put(
            `/workspaces/${encodeURIComponent(h.secondary.workspaceId)}/extensions/${extensionId}/activation`,
          )
          .send({ state: 'enabled' }),
      );
      await vi.waitFor(() =>
        expect(
          h.secondary.bridge.refreshExtensionsForAllSessions,
        ).toHaveBeenCalledOnce(),
      );

      const second = await auth(
        request(h.app)
          .put(
            `/workspaces/${encodeURIComponent(h.secondary.workspaceId)}/extensions/${extensionId}/activation`,
          )
          .send({ state: 'disabled' }),
      );
      await expect(
        pollOperation(h.app, second.body.operationId),
      ).resolves.toMatchObject({ status: 'succeeded' });

      releaseFirst?.();
      await expect(
        pollOperation(h.app, first.body.operationId),
      ).resolves.toMatchObject({ status: 'succeeded' });
      const projection = await auth(
        request(h.app).get(
          `/workspaces/${encodeURIComponent(h.secondary.workspaceId)}/extensions`,
        ),
      );
      expect(projection.body.appliedGeneration).toBe(9);
    } finally {
      releaseFirst?.();
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
        h.primary.bridge.refreshExtensionsForAllSessions,
      ).toHaveBeenCalledOnce();
      expect(
        h.secondary.bridge.refreshExtensionsForAllSessions,
      ).toHaveBeenCalledOnce();
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
      expect(
        late.bridge.refreshExtensionsForAllSessions,
      ).toHaveBeenCalledOnce();
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
      const started = await request(h.app)
        .post('/extensions/install')
        .set('Host', host())
        .set('Authorization', 'Bearer secret')
        .send({
          source: '@scope/demo',
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
    } finally {
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
      expect(commitPrepared).toHaveBeenCalledWith(prepared);
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
        pollOperation(h.app, started.body.operationId),
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
      expect(ExtensionManager.prototype.refreshCache).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('routes uninstall lookup failures through the bridge error handler', async () => {
    const h = await makeHarness();
    mockExtensionManager();
    vi.mocked(ExtensionManager.prototype.refreshCache).mockRejectedValueOnce(
      new Error('extension lookup failed'),
    );
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
