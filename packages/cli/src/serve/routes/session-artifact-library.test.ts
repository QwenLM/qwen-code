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
      listWorkspaceSessions: vi.fn(() => (live ? [{ sessionId: id }] : [])),
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
  app.use(express.json());
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

const collectionRoute = '/workspaces/primary/artifact-library';
const secondId = '550e8400-e29b-41d4-a716-446655440001';

describe('workspace artifact collection routes', () => {
  it('reads live artifacts repeatedly without a client identity and deduplicates IDs', async () => {
    const owner = runtime();
    const { app, coordinator } = setup([owner]);
    const shared = vi.spyOn(coordinator, 'runSharedMany');
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request(app)
        .post(`${collectionRoute}/query`)
        .send({ sessionIds: [id, id.toUpperCase()] });
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual({
        v: 1,
        sessions: [{ v: 1, sessionId: id, artifacts: [] }],
        errors: [],
      });
    }
    expect(owner.bridge.getSessionArtifacts).toHaveBeenCalledTimes(2);
    expect(owner.bridge.getSessionArtifacts).toHaveBeenCalledWith(id);
    expect(shared).toHaveBeenCalledWith([id], expect.any(Function));
  });

  it('returns per-pair mutation warnings and does not repeat duplicate removals', async () => {
    const owner = runtime();
    vi.mocked(owner.bridge.removeSessionArtifactForWorkspaceOwner)
      .mockResolvedValueOnce({
        v: 1,
        sessionId: id,
        changes: [],
        warnings: ['persistence failed; registration kept'],
      })
      .mockRejectedValueOnce(new SessionNotFoundError(id));
    const { app, coordinator } = setup([owner]);
    const exclusive = vi.spyOn(coordinator, 'runExclusiveMany');
    const response = await request(app)
      .post(`${collectionRoute}/delete`)
      .send({
        artifacts: [
          { sessionId: id, artifactId: 'a' },
          { sessionId: id, artifactId: 'a' },
          { sessionId: id, artifactId: 'b' },
        ],
      });
    expect(response.status).toBe(200);
    expect(response.body.results).toEqual([
      {
        v: 1,
        sessionId: id,
        artifactId: 'a',
        changes: [],
        warnings: ['persistence failed; registration kept'],
      },
      {
        sessionId: id,
        artifactId: 'b',
        error: expect.objectContaining({
          status: 404,
          code: 'session_not_found',
        }),
      },
    ]);
    expect(
      owner.bridge.removeSessionArtifactForWorkspaceOwner,
    ).toHaveBeenCalledTimes(2);
    expect(exclusive).toHaveBeenCalledOnce();
  });

  it.each([
    ['query', {}],
    ['query', { sessionIds: [] }],
    ['query', { sessionIds: [id], extra: true }],
    ['query', { sessionIds: Array(101).fill(id) }],
    ['query', { sessionIds: [' '] }],
    ['delete', { sessionIds: [id] }],
    ['delete', { artifacts: [] }],
    ['delete', { artifacts: [{ sessionId: id }] }],
    ['delete', { artifacts: [{ sessionId: id, artifactId: '' }] }],
  ])('rejects malformed %s bodies', async (operation, body) => {
    const owner = runtime();
    const { app } = setup([owner]);
    expect(
      (await request(app).post(`${collectionRoute}/${operation}`).send(body))
        .status,
    ).toBe(400);
    expect(owner.bridge.getSessionArtifacts).not.toHaveBeenCalled();
    expect(
      owner.bridge.removeSessionArtifactForWorkspaceOwner,
    ).not.toHaveBeenCalled();
  });

  it('requires operator authority for batch removal', async () => {
    const owner = runtime();
    const { app } = setup([owner], true, false);
    const response = await request(app)
      .post(`${collectionRoute}/delete`)
      .send({ artifacts: [{ sessionId: id, artifactId: 'a' }] });
    expect(response.status).toBe(401);
    expect(
      owner.bridge.removeSessionArtifactForWorkspaceOwner,
    ).not.toHaveBeenCalled();
  });

  it.each(['query', 'delete'])(
    'rejects a foreign live owner in %s before accessing storage',
    async (operation) => {
      const selected = runtime('primary', false);
      const owner = runtime('other');
      const { app } = setup([selected, owner]);
      const location = vi.spyOn(
        SessionService.prototype,
        'getMaintainableSessionLocation',
      );
      const response = await request(app)
        .post(`${collectionRoute}/${operation}`)
        .send(
          operation === 'query'
            ? { sessionIds: [id] }
            : { artifacts: [{ sessionId: id, artifactId: 'a' }] },
        );
      expect(response.status).toBe(200);
      const error =
        operation === 'query'
          ? response.body.errors[0]
          : response.body.results[0].error;
      expect(error).toMatchObject({
        status: 409,
        code: 'session_workspace_conflict',
      });
      expect(location).not.toHaveBeenCalled();
      expect(
        owner.bridge.removeSessionArtifactForWorkspaceOwner,
      ).not.toHaveBeenCalled();
    },
  );

  it('rejects untrusted and unavailable workspaces before discovery', async () => {
    const owner = { ...runtime(), trusted: false };
    const { app } = setup([owner]);
    expect((await request(app).get(collectionRoute)).status).toBe(403);
    expect(owner.bridge.listWorkspaceSessions).not.toHaveBeenCalled();
    expect(
      (await request(app).get('/workspaces/unknown/artifact-library')).status,
    ).not.toBe(200);
  });

  it('rejects all collection operations when persistence is disabled', async () => {
    const owner = runtime();
    const { app } = setup([owner], false);
    const responses = [
      await request(app).get(collectionRoute),
      await request(app)
        .post(`${collectionRoute}/query`)
        .send({ sessionIds: [id] }),
      await request(app)
        .post(`${collectionRoute}/delete`)
        .send({ artifacts: [{ sessionId: id, artifactId: 'a' }] }),
    ];
    for (const response of responses) {
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('artifact_library_unavailable');
    }
    expect(owner.bridge.listWorkspaceSessions).not.toHaveBeenCalled();
  });

  it('shares cold projections across single, full and batch queries and refreshes after removal', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-library-batch-'));
    try {
      const owner = {
        ...runtime('primary', false),
        workspaceCwd: dir,
        sessionRuntimeBaseDir: path.join(dir, 'runtime'),
      };
      const storage = new Storage(dir, owner.sessionRuntimeBaseDir);
      const chats = path.join(storage.getProjectDir(), 'chats');
      await fs.mkdir(path.join(chats, 'archive'), { recursive: true });
      const artifact = (sessionId: string, artifactId: string) => ({
        id: artifactId,
        title: artifactId,
        kind: 'link',
        storage: 'external_url',
        url: `https://example.com/${artifactId}`,
        source: 'client',
        status: 'available',
        retention: 'restorable',
        clientRetained: false,
        createdAt: '2026-10-26T00:00:00Z',
        updatedAt: '2026-10-26T00:00:00Z',
      });
      // Use the same stable identities as real registrations.
      const { stableSessionArtifactId } = await import(
        '@qwen-code/qwen-code-core/services/session-artifact-persistence.js'
      );
      const ids = ['a', 'b', 'c'].map((name) =>
        stableSessionArtifactId(id, `url:https://example.com/${name}`),
      );
      for (const sessionId of [id, secondId]) {
        const artifacts =
          sessionId === id
            ? ['a', 'b', 'c'].map((name, index) => ({
                ...artifact(sessionId, name),
                id: ids[index],
              }))
            : [];
        const record = {
          uuid: `snapshot-${sessionId}`,
          parentUuid: null,
          sessionId,
          cwd: dir,
          timestamp: '2026-10-26T00:00:00Z',
          version: '0.26.1',
          type: 'system',
          subtype: 'session_artifact_snapshot',
          systemPayload: {
            v: 2,
            sessionId,
            sequence: 0,
            recordedAt: '2026-10-26T00:00:00Z',
            artifacts,
            tombstonedIds: [],
            stickyEphemeralIds: [],
          },
        };
        await fs.writeFile(
          path.join(
            chats,
            sessionId === secondId ? 'archive' : '',
            `${sessionId}.jsonl`,
          ),
          `${JSON.stringify(record)}\n`,
        );
      }
      const { app } = setup([owner]);
      const read = vi.spyOn(
        SessionService.prototype,
        'readSessionArtifactSnapshot',
      );
      const bulkRemove = vi.spyOn(
        SessionService.prototype,
        'removeSessionArtifactsForLibrary',
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        const single = await request(app).get(route);
        expect(single.status).toBe(200);
        expect(single.body.artifacts).toHaveLength(3);
      }
      expect(read).toHaveBeenCalledOnce();
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await request(app).get(collectionRoute);
        expect(response.status).toBe(200);
        expect(response.body.errors).toEqual([]);
        expect(response.body.sessions).toHaveLength(2);
        expect(
          response.body.sessions.find(
            (item: { sessionId: string }) => item.sessionId === id,
          ).artifacts,
        ).toHaveLength(3);
      }
      const batch = await request(app)
        .post(`${collectionRoute}/query`)
        .send({ sessionIds: [id, secondId, 'missing'] });
      expect(batch.body.sessions).toHaveLength(2);
      expect(batch.body.errors).toEqual([
        expect.objectContaining({ sessionId: 'missing', status: 404 }),
      ]);
      const archivedSingle = await request(app).get(
        `/workspaces/primary/session/${secondId}/artifact-library`,
      );
      expect(archivedSingle.status).toBe(200);
      expect(archivedSingle.body.artifacts).toEqual([]);
      expect(read).toHaveBeenCalledTimes(2);
      // Loading can overlap a cold read: only durable records may enter its cache.
      vi.mocked(owner.bridge.getSessionSummary).mockReturnValue({
        sessionId: id,
      } as never);
      await request(app)
        .post(`${collectionRoute}/query`)
        .send({ sessionIds: [id] });
      vi.mocked(owner.bridge.getSessionSummary)
        .mockImplementationOnce(() => {
          throw new SessionNotFoundError(id);
        })
        .mockImplementationOnce(() => {
          throw new SessionNotFoundError(id);
        })
        .mockReturnValue({ sessionId: id } as never);
      const racingRead = await request(app)
        .post(`${collectionRoute}/query`)
        .send({ sessionIds: [id] });
      expect(racingRead.body.sessions[0].artifacts).toHaveLength(3);
      vi.mocked(owner.bridge.getSessionSummary).mockImplementation(() => {
        throw new SessionNotFoundError(id);
      });
      expect(
        (
          await request(app)
            .post(`${collectionRoute}/query`)
            .send({ sessionIds: [id] })
        ).body.sessions[0].artifacts,
      ).toHaveLength(3);
      expect(read).toHaveBeenCalledTimes(3);
      const deletion = await request(app)
        .post(`${collectionRoute}/delete`)
        .send({
          artifacts: ids
            .slice(0, 2)
            .map((artifactId) => ({ sessionId: id, artifactId })),
        });
      expect(deletion.status).toBe(200);
      expect(deletion.body.results).toHaveLength(2);
      expect(
        deletion.body.results.every(
          (item: { changes: unknown[] }) => item.changes?.length === 1,
        ),
      ).toBe(true);
      expect(bulkRemove).toHaveBeenCalledOnce();
      const afterBatchSingle = await request(app).get(route);
      expect(afterBatchSingle.status).toBe(200);
      expect(afterBatchSingle.body.artifacts).toHaveLength(1);
      const refreshed = await request(app).get(collectionRoute);
      expect(refreshed.body.errors).toEqual([]);
      expect(
        refreshed.body.sessions
          .find((item: { sessionId: string }) => item.sessionId === id)
          .artifacts.map((item: { id: string }) => item.id),
      ).toEqual([ids[2]]);
      expect(read).toHaveBeenCalledTimes(4);
      const single = await request(app).delete(`${route}/${ids[2]}`);
      expect(single.status).toBe(200);
      const afterSingleGet = await request(app).get(route);
      expect(afterSingleGet.status).toBe(200);
      expect(afterSingleGet.body.artifacts).toEqual([]);
      const afterSingle = await request(app)
        .post(`${collectionRoute}/query`)
        .send({ sessionIds: [id] });
      expect(afterSingle.body.sessions[0].artifacts).toEqual([]);
      expect(read).toHaveBeenCalledTimes(5);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

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
  it.skipIf(process.platform === 'win32')(
    'preserves storage conflict errors for a looping transcript symlink',
    async () => {
      const dir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'qwen-library-link-'),
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
        const file = path.join(chats, `${id}.jsonl`);
        await fs.symlink(file, file);
        const { app } = setup([owner]);
        const response = await request(app).get(route);
        expect(response.status).toBe(409);
        expect(response.body.code).toBe('session_storage_conflict');
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
