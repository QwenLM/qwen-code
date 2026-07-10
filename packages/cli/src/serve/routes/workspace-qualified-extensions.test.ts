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

const baseOpts: ServeOptions = {
  hostname: '127.0.0.1',
  port: 4198,
  mode: 'http-bridge',
};

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

async function makeHarness(opts?: {
  secondaryTrusted?: boolean;
  token?: string;
}) {
  const scratch = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'qwen-workspace-qualified-extensions-'),
  );
  const primaryCwd = canonicalizeWorkspace(path.join(scratch, 'primary'));
  const secondaryCwd = canonicalizeWorkspace(path.join(scratch, 'secondary'));
  await fsp.mkdir(primaryCwd, { recursive: true });
  await fsp.mkdir(secondaryCwd, { recursive: true });

  const primary = makeRuntime(primaryCwd, {
    primary: true,
    trusted: true,
    workspaceId: 'primary-id',
  });
  const secondary = makeRuntime(secondaryCwd, {
    primary: false,
    trusted: opts?.secondaryTrusted ?? true,
    workspaceId: hashDaemonWorkspace(secondaryCwd),
  });

  const app = createServeApp(
    { ...baseOpts, workspace: primaryCwd, token: opts?.token },
    undefined,
    {
      workspaceRegistry: createWorkspaceRegistry([primary, secondary]),
    },
  );

  return {
    app,
    scratch,
    primaryCwd,
    secondaryCwd,
    secondaryId: secondary.workspaceId,
    primaryBridge: primary.bridge,
    secondaryBridge: secondary.bridge,
  };
}

/**
 * Spies `ExtensionManager.prototype` so the routes exercise their real
 * dispatch/queue logic without touching the network or a real install.
 */
function mockExtensionManager(overrides?: {
  loadedExtensions?: () => Extension[];
}): () => void {
  const spies = [
    vi
      .spyOn(ExtensionManager.prototype, 'refreshCache')
      .mockResolvedValue(undefined as never),
    vi
      .spyOn(ExtensionManager.prototype, 'getLoadedExtensions')
      .mockImplementation(overrides?.loadedExtensions ?? (() => [])),
    vi.spyOn(ExtensionManager.prototype, 'installExtension').mockResolvedValue({
      name: 'installed-ext',
      config: { version: '1.0.0' },
    } as unknown as Extension),
    vi
      .spyOn(ExtensionManager.prototype, 'enableExtension')
      .mockResolvedValue(undefined as never),
  ];
  return () => spies.forEach((spy) => spy.mockRestore());
}

async function pollOperation(
  app: ReturnType<typeof createServeApp>,
  base: string,
  operationId: string,
  token?: string,
) {
  for (let i = 0; i < 100; i++) {
    let pending = request(app)
      .get(`${base}/extensions/operations/${encodeURIComponent(operationId)}`)
      .set('Host', host());
    if (token) pending = pending.set('Authorization', `Bearer ${token}`);
    const res = await pending;
    if (
      res.status === 200 &&
      res.body.status !== 'queued' &&
      res.body.status !== 'running'
    ) {
      return res.body;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`operation ${operationId} did not settle`);
}

describe('workspace-qualified extensions REST', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('advertises the workspace_qualified_extensions capability', async () => {
    const h = await makeHarness();
    try {
      const res = await request(h.app).get('/capabilities').set('Host', host());
      expect(res.status).toBe(200);
      expect(res.body.features).toContain('workspace_qualified_extensions');
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('reads status from a trusted non-primary workspace (by id and by cwd)', async () => {
    const h = await makeHarness();
    const restore = mockExtensionManager();
    try {
      const byId = await request(h.app)
        .get(`/workspaces/${encodeURIComponent(h.secondaryId)}/extensions`)
        .set('Host', host());
      expect(byId.status).toBe(200);
      expect(byId.body).toMatchObject({
        workspaceCwd: h.secondaryCwd,
        extensions: [],
      });

      const byCwd = await request(h.app)
        .get(`/workspaces/${encodeURIComponent(h.secondaryCwd)}/extensions`)
        .set('Host', host());
      expect(byCwd.status).toBe(200);
      expect(byCwd.body.workspaceCwd).toBe(h.secondaryCwd);
    } finally {
      restore();
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('allows reading status from an untrusted workspace (reads resolve-only)', async () => {
    const h = await makeHarness({ secondaryTrusted: false });
    const restore = mockExtensionManager();
    try {
      const res = await request(h.app)
        .get(`/workspaces/${encodeURIComponent(h.secondaryCwd)}/extensions`)
        .set('Host', host());
      expect(res.status).toBe(200);
      expect(res.body.workspaceCwd).toBe(h.secondaryCwd);
    } finally {
      restore();
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('rejects an unknown workspace selector with workspace_mismatch', async () => {
    const h = await makeHarness();
    try {
      const res = await request(h.app)
        .get(
          `/workspaces/${encodeURIComponent(path.join(h.scratch, 'nope'))}/extensions`,
        )
        .set('Host', host());
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('workspace_mismatch');
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('refuses mutations on an untrusted workspace with untrusted_workspace', async () => {
    const h = await makeHarness({ secondaryTrusted: false, token: 'secret' });
    const restore = mockExtensionManager();
    try {
      const res = await request(h.app)
        .post(
          `/workspaces/${encodeURIComponent(h.secondaryCwd)}/extensions/ext-a/enable`,
        )
        .set('Host', host())
        .set('Authorization', 'Bearer secret')
        .send({ scope: 'workspace' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('untrusted_workspace');
      // The trust gate short-circuits before any extension work.
      expect(
        vi.mocked(ExtensionManager.prototype.enableExtension),
      ).not.toHaveBeenCalled();
    } finally {
      restore();
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('runs a mutation on the target workspace bridge, not the primary', async () => {
    const h = await makeHarness({ token: 'secret' });
    const restore = mockExtensionManager({
      loadedExtensions: () => [{ name: 'ext-a' } as Extension],
    });
    try {
      const res = await request(h.app)
        .post(
          `/workspaces/${encodeURIComponent(h.secondaryCwd)}/extensions/ext-a/enable`,
        )
        .set('Host', host())
        .set('Authorization', 'Bearer secret')
        .send({ scope: 'workspace' });
      expect(res.status).toBe(202);
      expect(typeof res.body.operationId).toBe('string');

      const op = await pollOperation(
        h.app,
        `/workspaces/${encodeURIComponent(h.secondaryCwd)}`,
        res.body.operationId,
        'secret',
      );
      expect(op.status).toBe('succeeded');
      // The secondary runtime's bridge refreshed sessions, not the primary's.
      expect(
        vi.mocked(h.secondaryBridge.refreshExtensionsForAllSessions),
      ).toHaveBeenCalledTimes(1);
      expect(
        vi.mocked(h.primaryBridge.refreshExtensionsForAllSessions),
      ).not.toHaveBeenCalled();
    } finally {
      restore();
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('shares the primary controller across singular and plural routes', async () => {
    const h = await makeHarness({ token: 'secret' });
    const restore = mockExtensionManager({
      loadedExtensions: () => [{ name: 'ext-a' } as Extension],
    });
    try {
      const started = await request(h.app)
        .post('/workspace/extensions/ext-a/enable')
        .set('Host', host())
        .set('Authorization', 'Bearer secret')
        .send({ scope: 'workspace' });
      expect(started.status).toBe(202);
      const { operationId } = started.body;

      // The same operation is observable via the plural primary route.
      const viaPlural = await request(h.app)
        .get(
          `/workspaces/${encodeURIComponent(h.primaryCwd)}/extensions/operations/${encodeURIComponent(operationId)}`,
        )
        .set('Host', host())
        .set('Authorization', 'Bearer secret');
      expect(viaPlural.status).toBe(200);
      expect(viaPlural.body.operationId).toBe(operationId);
    } finally {
      restore();
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('isolates operation history per workspace', async () => {
    const h = await makeHarness({ token: 'secret' });
    const restore = mockExtensionManager();
    try {
      const started = await request(h.app)
        .post(
          `/workspaces/${encodeURIComponent(h.secondaryCwd)}/extensions/ext-a/enable`,
        )
        .set('Host', host())
        .set('Authorization', 'Bearer secret')
        .send({ scope: 'workspace' });
      expect(started.status).toBe(202);
      const { operationId } = started.body;

      // The primary workspace's controller does not know the secondary's op.
      const onPrimary = await request(h.app)
        .get(
          `/workspaces/${encodeURIComponent(h.primaryCwd)}/extensions/operations/${encodeURIComponent(operationId)}`,
        )
        .set('Host', host())
        .set('Authorization', 'Bearer secret');
      expect(onPrimary.status).toBe(404);
      expect(onPrimary.body.code).toBe('extension_operation_not_found');
    } finally {
      restore();
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });
});
