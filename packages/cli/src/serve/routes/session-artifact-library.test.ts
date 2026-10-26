/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import type { Server } from 'node:http';
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
  createWorkspaceGenerationGuard,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import { SessionArchiveCoordinator } from '../server/session-archive.js';
import { sendBridgeError } from '../server/error-response.js';
import { ConversationRuntimeActivityGate } from '../conversations/conversation-runtime-activity.js';
import { registerSessionRoutes } from './session.js';
import { WorkspaceArtifactCache } from '../server/workspace-artifact-cache.js';
import { ArtifactLibraryStream } from '../server/artifact-library-stream.js';
import type { WorkspaceSessionArtifactsEnvelope } from '../server/session-artifact-library.js';

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
      getSessionSummary: vi.fn((sessionId: string) => {
        if (!live) throw new SessionNotFoundError(sessionId);
        return {
          sessionId,
          createdAt: '2026-10-26T00:00:00Z',
          displayName: 'Live task',
        };
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
        sessions: [
          {
            v: 1,
            sessionId: id,
            artifacts: [],
            session: {
              createdAt: '2026-10-26T00:00:00Z',
              displayName: 'Live task',
              archiveState: 'active',
              sourceType: 'default',
            },
          },
        ],
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
    vi.spyOn(SessionService.prototype, 'getSessionListItem').mockResolvedValue({
      sessionId: id,
      cwd: owner.workspaceCwd,
      startTime: '2020-01-01T00:00:00Z',
      mtime: 0,
      prompt: 'Archived task',
      filePath: 'archived.jsonl',
      sourceType: 'resource_inspection',
      sourceId: 'inspection-1',
      isArchived: true,
    });
    const res = await request(app).get(route);
    expect(res.status).toBe(200);
    expect(res.body.artifacts).toEqual([]);
    expect(res.body.limits.maxArtifacts).toBe(200);
    expect(res.body.session).toEqual({
      displayName: 'Archived task',
      createdAt: '2020-01-01T00:00:00Z',
      archiveState: 'archived',
      sourceType: 'resource_inspection',
      sourceId: 'inspection-1',
    });
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

function streamEnvelope(sessionId: string): WorkspaceSessionArtifactsEnvelope {
  return {
    v: 1,
    sessionId,
    artifacts: [],
    generatedAt: '2026-10-26T00:00:00Z',
    limits: { maxArtifacts: 200 },
    session: {
      createdAt: '2026-10-25T00:00:00Z',
      archiveState: 'active',
      sourceType: 'default',
    },
  };
}

function parseLibraryEvents(text: string) {
  return text.split('\n\n').flatMap((frame) => {
    const lines = frame.split('\n');
    if (!lines[0]?.startsWith('event: ')) return [];
    return [
      {
        event: lines[0].slice(7),
        data: JSON.parse(lines[1]!.slice(6)) as Record<string, unknown>,
      },
    ];
  });
}

async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function serverUrl(server: Server) {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  return `http://127.0.0.1:${address.port}${collectionRoute}/query`;
}

async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

describe('artifact library progressive queries', () => {
  it.each(['all', 'query'] as const)(
    'streams %s results and preserves partial failure semantics',
    async (operation) => {
      const { app } = setup();
      vi.spyOn(
        WorkspaceArtifactCache.prototype,
        'sessionIds',
      ).mockResolvedValue([id, secondId, 'missing']);
      vi.spyOn(WorkspaceArtifactCache.prototype, 'read').mockImplementation(
        async (sessionId) => {
          if (sessionId === secondId)
            throw new Error('private filesystem details');
          if (sessionId === 'missing')
            throw new SessionNotFoundError(sessionId);
          return streamEnvelope(sessionId);
        },
      );
      const query =
        operation === 'all'
          ? request(app).get(collectionRoute)
          : request(app)
              .post(`${collectionRoute}/query`)
              .send({ sessionIds: [id, secondId, 'missing'] });
      const response = await query.set('Accept', 'text/event-stream');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      const events = parseLibraryEvents(response.text);
      expect(events[0]).toEqual({ event: 'start', data: { v: 1, total: 3 } });
      expect(events.find((event) => event.event === 'session')?.data).toEqual(
        streamEnvelope(id),
      );
      expect(events.at(-1)).toEqual({
        event: 'complete',
        data: {
          v: 1,
          total: 3,
          succeeded: 1,
          failed: operation === 'all' ? 1 : 2,
          skipped: operation === 'all' ? 1 : 0,
        },
      });
      expect(events.filter((event) => event.event === 'complete')).toHaveLength(
        1,
      );
      expect(response.text).not.toContain('private filesystem details');
      expect(
        events.find((event) => event.data['sessionId'] === secondId)?.data,
      ).toMatchObject({ status: 500, code: 'artifact_library_failed' });
    },
  );

  it('replenishes read slots and emits later sessions before a blocked first session', async () => {
    const { app } = setup();
    const ids = Array.from(
      { length: 6 },
      (_, index) => `${id.slice(0, -1)}${index}`,
    );
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let peak = 0;
    vi.spyOn(WorkspaceArtifactCache.prototype, 'read').mockImplementation(
      async (sessionId) => {
        active++;
        peak = Math.max(peak, active);
        if (sessionId === id) await blocked;
        else await new Promise<void>((resolve) => setImmediate(resolve));
        active--;
        return streamEnvelope(sessionId);
      },
    );
    const server = await listen(app);
    let reading: Promise<void> | undefined;
    let received = '';
    try {
      const response = await fetch(serverUrl(server), {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sessionIds: ids }),
      });
      const reader = response.body!.getReader();
      reading = (async () => {
        const decoder = new TextDecoder();
        while (true) {
          const next = await reader.read();
          if (next.done) return;
          received += decoder.decode(next.value, { stream: true });
        }
      })();
      await vi.waitFor(() =>
        expect(received).toContain(`"sessionId":"${ids[5]}"`),
      );
      expect(received).not.toContain(`"sessionId":"${id}"`);
      expect(received).not.toContain('event: complete');
      expect(peak).toBe(4);
      release();
      await reading;
      expect(parseLibraryEvents(received).at(-1)?.data).toEqual({
        v: 1,
        total: 6,
        succeeded: 6,
        failed: 0,
        skipped: 0,
      });
    } finally {
      release();
      await reading;
      await closeServer(server);
    }
  });

  it('retains JSON selection order when reads finish out of order', async () => {
    const { app } = setup();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(WorkspaceArtifactCache.prototype, 'read').mockImplementation(
      async (sessionId) => {
        if (sessionId === id) await blocked;
        else release();
        return streamEnvelope(sessionId);
      },
    );
    const response = await request(app)
      .post(`${collectionRoute}/query`)
      .send({ sessionIds: [id, secondId] });
    expect(response.body.sessions).toEqual([
      streamEnvelope(id),
      streamEnvelope(secondId),
    ]);
    expect(response.headers['content-type']).toContain('application/json');
  });

  it('releases archive barriers before waiting for result writes', async () => {
    const { app, coordinator } = setup();
    vi.spyOn(WorkspaceArtifactCache.prototype, 'read').mockResolvedValue(
      streamEnvelope(id),
    );
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = ArtifactLibraryStream.prototype.send;
    const send = vi
      .spyOn(ArtifactLibraryStream.prototype, 'send')
      .mockImplementation(async function (
        this: ArtifactLibraryStream,
        event,
        data,
      ) {
        if (event === 'session') await blocked;
        return original.call(this, event, data);
      });
    const response = request(app)
      .post(`${collectionRoute}/query`)
      .set('Accept', 'text/event-stream')
      .send({ sessionIds: [id] })
      .then((value) => value);
    try {
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith('session', expect.any(Object)),
      );
      let acquired = false;
      const exclusive = coordinator.runExclusiveMany([id], async () => {
        acquired = true;
      });
      await vi.waitFor(() => expect(acquired).toBe(true));
      await exclusive;
    } finally {
      release();
      await response;
    }
  });

  it('stops dispatching on disconnect while keeping in-flight reads under their barriers', async () => {
    const { app, coordinator } = setup();
    const ids = Array.from(
      { length: 6 },
      (_, index) => `${id.slice(0, -1)}${index}`,
    );
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = vi
      .spyOn(WorkspaceArtifactCache.prototype, 'read')
      .mockImplementation(async (sessionId) => {
        await blocked;
        return streamEnvelope(sessionId);
      });
    let isClosed = () => false;
    const send = ArtifactLibraryStream.prototype.send;
    vi.spyOn(ArtifactLibraryStream.prototype, 'send').mockImplementation(
      function (this: ArtifactLibraryStream, event, data) {
        isClosed = () => this.closed;
        return send.call(this, event, data);
      },
    );
    const server = await listen(app);
    const abort = new AbortController();
    try {
      const response = await fetch(serverUrl(server), {
        method: 'POST',
        signal: abort.signal,
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sessionIds: ids }),
      });
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4));
      await response.body!.cancel();
      abort.abort();
      await vi.waitFor(() => expect(isClosed()).toBe(true));
      await expect(
        coordinator.runExclusiveMany(ids.slice(0, 4), async () => undefined),
      ).rejects.toThrow('being archived');
      release();
      await vi.waitFor(async () => {
        await coordinator.runExclusiveMany(
          ids.slice(0, 4),
          async () => undefined,
        );
      });
      expect(read).toHaveBeenCalledTimes(4);
    } finally {
      release();
      abort.abort();
      await closeServer(server);
    }
  });

  it('terminates with an SSE error when the runtime closes during a read', async () => {
    const owner = {
      ...runtime(),
      generationGuard: createWorkspaceGenerationGuard(),
    };
    const { app } = setup([owner]);
    vi.spyOn(WorkspaceArtifactCache.prototype, 'read').mockImplementation(
      async () => {
        owner.generationGuard!.close();
        return streamEnvelope(id);
      },
    );
    const response = await request(app)
      .post(`${collectionRoute}/query`)
      .set('Accept', 'text/event-stream')
      .send({ sessionIds: [id] });
    const events = parseLibraryEvents(response.text);
    expect(events.map((event) => event.event)).toEqual(['start', 'error']);
    expect(events[1]!.data).toMatchObject({
      status: 503,
      code: 'workspace_runtime_unavailable',
    });
  });

  it('keeps validation and persistence failures as HTTP JSON before streaming', async () => {
    const { app } = setup();
    const invalid = await request(app)
      .post(`${collectionRoute}/query`)
      .set('Accept', 'text/event-stream')
      .send({ sessionIds: [] });
    expect(invalid.status).toBe(400);
    expect(invalid.headers['content-type']).toContain('application/json');
    const disabled = await request(setup([runtime()], false).app)
      .get(collectionRoute)
      .set('Accept', 'text/event-stream');
    expect(disabled.status).toBe(409);
    expect(disabled.headers['content-type']).toContain('application/json');
  });
});
