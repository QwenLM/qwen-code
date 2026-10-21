/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionService } from '@qwen-code/qwen-code-core/services/sessionService.js';
import {
  SessionNotFoundError,
  type AcpSessionBridge,
} from '../acp-session-bridge.js';
import { createMutationGate } from '../auth.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import { SessionArchiveCoordinator } from '../server/session-archive.js';
import { sendBridgeError } from '../server/error-response.js';
import { ConversationRuntimeActivityGate } from '../conversations/conversation-runtime-activity.js';
import { registerSessionRoutes } from './session.js';

vi.mock('../../runtime/live-session-source.js', async (original) => ({
  ...(await original<typeof import('../../runtime/live-session-source.js')>()),
  readLoadableLiveConversationMetadata: vi.fn(async () => ({})),
}));

const id = '550e8400-e29b-41d4-a716-446655440000';
const route = `/workspaces/primary/session/${id}/artifact-library`;
function runtime(workspaceId = 'primary', live = true): WorkspaceRuntime {
  return {
    workspaceId,
    workspaceCwd: path.resolve('/workspace', workspaceId),
    sessionRuntimeBaseDir: path.resolve('/runtime', workspaceId),
    primary: workspaceId === 'primary',
    trusted: true,
    bridge: {
      getSessionSummary: vi.fn(() => {
        if (!live) throw new SessionNotFoundError(id);
        return { sessionId: id };
      }),
      getSessionArtifacts: vi.fn(async () => ({
        v: 1,
        sessionId: id,
        artifacts: [],
      })),
      removeSessionArtifactForWorkspaceOwner: vi.fn(async () => ({
        v: 1,
        sessionId: id,
        changes: [],
      })),
    } as unknown as AcpSessionBridge,
  } as WorkspaceRuntime;
}
function setup(runtimes = [runtime()], persistence = true, authorized = true) {
  const app = express();
  const registry = createWorkspaceRegistry(runtimes);
  const coordinator = new SessionArchiveCoordinator();
  const activity = new ConversationRuntimeActivityGate();
  registerSessionRoutes(app, {
    boundWorkspace: registry.primary.workspaceCwd,
    bridge: registry.primary.bridge,
    workspaceRegistry: registry,
    archiveCoordinator: coordinator,
    conversationRuntimeActivity: activity,
    mutate: createMutationGate({
      tokenConfigured: false,
      requireAuth: false,
      trustedLoopbackMode: authorized,
    }),
    sendBridgeError,
    sessionShellCommandEnabled: true,
    sessionArtifactsPersistenceAvailable: persistence,
    languageCodes: ['en'],
  });
  return { app, registry, coordinator, activity };
}
afterEach(() => vi.restoreAllMocks());

describe('workspace artifact library routes', () => {
  it('reads live artifacts without a client identity under the shared barrier', async () => {
    const owner = runtime();
    const { app, coordinator } = setup([owner]);
    const shared = vi.spyOn(coordinator, 'runSharedMany');
    const res = await request(app).get(route);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(owner.bridge.getSessionArtifacts).toHaveBeenCalledWith(id);
    expect(shared).toHaveBeenCalledWith([id], expect.any(Function));
  });
  it('reads an archived library without a live session and reports the live limit', async () => {
    const owner = runtime('primary', false);
    const { app } = setup([owner]);
    vi.spyOn(
      SessionService.prototype,
      'getMaintainableSessionLocation',
    ).mockResolvedValue('archived');
    vi.spyOn(
      SessionService.prototype,
      'readSessionArtifactSnapshot',
    ).mockResolvedValue({
      v: 2,
      sessionId: id,
      sequence: 0,
      artifacts: [],
      tombstonedIds: [],
      stickyEphemeralIds: [],
      warnings: [],
    });
    const res = await request(app).get(route);
    expect(res.status).toBe(200);
    expect(res.body.artifacts).toEqual([]);
    expect(res.body.limits.maxArtifacts).toBe(200);
    expect(owner.bridge.getSessionArtifacts).not.toHaveBeenCalled();
  });

  it('removes as the workspace owner under the exclusive barrier', async () => {
    const owner = runtime();
    const { app, coordinator } = setup([owner]);
    const exclusive = vi.spyOn(coordinator, 'runExclusiveMany');
    const res = await request(app).delete(`${route}/artifact-1`);
    expect(res.status).toBe(200);
    expect(
      owner.bridge.removeSessionArtifactForWorkspaceOwner,
    ).toHaveBeenCalledWith(id, 'artifact-1');
    expect(exclusive).toHaveBeenCalledWith([id], expect.any(Function));
  });
  it('requires operator authority before owner deletion', async () => {
    const owner = runtime();
    const { app } = setup([owner], true, false);
    expect((await request(app).delete(`${route}/artifact-1`)).status).toBe(401);
    expect(
      owner.bridge.removeSessionArtifactForWorkspaceOwner,
    ).not.toHaveBeenCalled();
  });
  it.each(['get', 'delete'] as const)(
    'rejects %s when persistence is unavailable',
    async (method) => {
      const owner = runtime();
      const { app } = setup([owner], false);
      const res = await request(app)[method](
        method === 'get' ? route : `${route}/artifact-1`,
      );
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('artifact_library_unavailable');
      expect(owner.bridge.getSessionArtifacts).not.toHaveBeenCalled();
      expect(
        owner.bridge.removeSessionArtifactForWorkspaceOwner,
      ).not.toHaveBeenCalled();
    },
  );
  it.each(['get', 'delete'] as const)(
    'rejects ambiguous live ownership for %s',
    async (method) => {
      const a = runtime();
      const b = runtime('other');
      const { app } = setup([a, b]);
      const res = await request(app)[method](
        method === 'get' ? route : `${route}/artifact-1`,
      );
      expect(res.status).toBe(500);
      expect(res.body.code).toBe('ambiguous_session_owner');
      expect(a.bridge.getSessionArtifacts).not.toHaveBeenCalled();
      expect(
        a.bridge.removeSessionArtifactForWorkspaceOwner,
      ).not.toHaveBeenCalled();
    },
  );
  it.each(['get', 'delete'] as const)(
    'rejects a different live owner before %s touches cold storage',
    async (method) => {
      const selected = runtime('primary', false);
      const { app } = setup([selected, runtime('other')]);
      const location = vi
        .spyOn(SessionService.prototype, 'getMaintainableSessionLocation')
        .mockResolvedValue('active');
      const res = await request(app)[method](
        method === 'get' ? route : `${route}/artifact-1`,
      );
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('session_workspace_conflict');
      expect(location).not.toHaveBeenCalled();
    },
  );
  it('rejects an unavailable owner', async () => {
    const { app, registry } = setup();
    vi.spyOn(registry, 'resolveLiveSessionOwner').mockReturnValue({
      kind: 'unavailable',
    });
    const res = await request(app).get(route);
    expect(res.status).toBe(503);
  });
  it('rejects an untrusted workspace before owner deletion', async () => {
    const owner = { ...runtime(), trusted: false };
    const { app } = setup([owner]);
    expect((await request(app).delete(`${route}/artifact-1`)).status).toBe(403);
    expect(
      owner.bridge.removeSessionArtifactForWorkspaceOwner,
    ).not.toHaveBeenCalled();
  });
  it.each(['active', 'archived'] as const)(
    'releases the correct %s lease when a cold mutation fails',
    async (state) => {
      const { app } = setup([runtime('primary', false)]);
      vi.spyOn(
        SessionService.prototype,
        'getMaintainableSessionLocation',
      ).mockResolvedValue(state);
      const lease = {
        release: vi.fn(async () => {}),
        assertOwnedAndUnchanged: vi.fn(async () => {}),
      };
      const writer = vi
        .spyOn(SessionService.prototype, 'acquireSessionWriterLease')
        .mockResolvedValue(lease as never);
      const maintenance = vi
        .spyOn(SessionService.prototype, 'acquireSessionMaintenanceLease')
        .mockResolvedValue(lease as never);
      vi.spyOn(
        SessionService.prototype,
        'removeSessionArtifactForLibrary',
      ).mockRejectedValue(new Error('write failed'));
      expect((await request(app).delete(`${route}/artifact-1`)).status).toBe(
        500,
      );
      expect(state === 'active' ? writer : maintenance).toHaveBeenCalledOnce();
      expect(state === 'active' ? maintenance : writer).not.toHaveBeenCalled();
      expect(lease.release).toHaveBeenCalledOnce();
    },
  );
  it('returns no fabricated changes for an idempotent cold deletion', async () => {
    const { app } = setup([runtime('primary', false)]);
    vi.spyOn(
      SessionService.prototype,
      'getMaintainableSessionLocation',
    ).mockResolvedValue('archived');
    const lease = {
      release: vi.fn(async () => {}),
      assertOwnedAndUnchanged: vi.fn(async () => {}),
    };
    vi.spyOn(
      SessionService.prototype,
      'acquireSessionMaintenanceLease',
    ).mockResolvedValue(lease as never);
    vi.spyOn(
      SessionService.prototype,
      'removeSessionArtifactForLibrary',
    ).mockResolvedValue(false);
    const res = await request(app).delete(`${route}/absent`);
    expect(res.status).toBe(200);
    expect(res.body.changes).toEqual([]);
    expect(lease.release).toHaveBeenCalledOnce();
  });
  it.each(['get', 'delete'] as const)(
    'returns 404 for an absent or empty journal on %s',
    async (method) => {
      const { app } = setup([runtime('primary', false)]);
      vi.spyOn(
        SessionService.prototype,
        'getMaintainableSessionLocation',
      ).mockResolvedValue(undefined);
      const read = vi.spyOn(
        SessionService.prototype,
        'readSessionArtifactSnapshot',
      );
      const res = await request(app)[method](
        method === 'get' ? route : `${route}/artifact-1`,
      );
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('session_not_found');
      expect(read).not.toHaveBeenCalled();
    },
  );

  it('preserves the live removal warning result without fabricating a change', async () => {
    const owner = runtime();
    vi.mocked(
      owner.bridge.removeSessionArtifactForWorkspaceOwner,
    ).mockResolvedValue({
      v: 1,
      sessionId: id,
      changes: [],
      warnings: ['artifact removal not persisted; live artifact kept'],
    });
    const { app } = setup([owner]);
    const res = await request(app).delete(`${route}/artifact-1`);
    expect(res.status).toBe(200);
    expect(res.body.changes).toEqual([]);
    expect(res.body.warnings).toEqual([
      'artifact removal not persisted; live artifact kept',
    ]);
  });

  it('rejects an internal runtime after its activity gate is sealed', async () => {
    const owner = { ...runtime(), provenance: 'live-conversation' as const };
    const { app, activity } = setup([owner]);
    vi.spyOn(SessionService.prototype, 'getSessionLocation').mockResolvedValue(
      'active',
    );
    await activity.sealAndWait();
    const res = await request(app).delete(`${route}/artifact-1`);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('daemon_draining');
    expect(
      owner.bridge.removeSessionArtifactForWorkspaceOwner,
    ).not.toHaveBeenCalled();
  });
  it('holds the internal activity gate until an admitted deletion completes', async () => {
    const owner = { ...runtime(), provenance: 'live-conversation' as const };
    const { app, activity } = setup([owner]);
    vi.spyOn(SessionService.prototype, 'getSessionLocation').mockResolvedValue(
      'active',
    );
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.mocked(
      owner.bridge.removeSessionArtifactForWorkspaceOwner,
    ).mockImplementation(async () => {
      await pending;
      return { v: 1, sessionId: id, changes: [] };
    });
    const response = request(app)
      .delete(`${route}/artifact-1`)
      .then((res) => res);
    try {
      await vi.waitFor(() =>
        expect(
          owner.bridge.removeSessionArtifactForWorkspaceOwner,
        ).toHaveBeenCalledOnce(),
      );
      let drained = false;
      const drain = activity.sealAndWait().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      finish();
      expect((await response).status).toBe(200);
      await drain;
      expect(drained).toBe(true);
    } finally {
      finish();
      await response;
    }
  });
  it.each(['get', 'delete'] as const)(
    'maps a real non-regular storage entry on %s',
    async (method) => {
      const dir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'qwen-library-route-'),
      );
      try {
        const owner = {
          ...runtime('primary', false),
          workspaceCwd: dir,
          sessionRuntimeBaseDir: path.join(dir, 'runtime'),
        };
        const storage = new Storage(dir, owner.sessionRuntimeBaseDir);
        await fs.mkdir(
          path.join(storage.getProjectDir(), 'chats', `${id}.jsonl`),
          { recursive: true },
        );
        const { app } = setup([owner]);
        const res = await request(app)[method](
          method === 'get' ? route : `${route}/artifact-1`,
        );
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('session_storage_conflict');
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );
  it.each(['get', 'delete'] as const)(
    'returns 404 for a real zero-byte transcript on %s',
    async (method) => {
      const dir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'qwen-empty-library-route-'),
      );
      try {
        const owner = {
          ...runtime('primary', false),
          workspaceCwd: dir,
          sessionRuntimeBaseDir: path.join(dir, 'runtime'),
        };
        const storage = new Storage(dir, owner.sessionRuntimeBaseDir);
        const chats = path.join(storage.getProjectDir(), 'chats');
        await fs.mkdir(chats, { recursive: true });
        await fs.writeFile(path.join(chats, `${id}.jsonl`), '');
        const { app } = setup([owner]);
        const res = await request(app)[method](
          method === 'get' ? route : `${route}/artifact-1`,
        );
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('session_not_found');
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );
});
