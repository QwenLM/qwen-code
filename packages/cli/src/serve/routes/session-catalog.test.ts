/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { SessionOrganizationError } from '@qwen-code/qwen-code-core/services/session-organization-service.js';
import { runWithoutDebugLogSession } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  InvalidCursorError,
  listWorkspaceSessionsForResponse,
} from '../server/session-list.js';
import { registerSessionCatalogRoutes } from './session-catalog.js';

const mocks = vi.hoisted(() => ({
  groups: vi.fn(async () => ({ groups: [], colorOptions: [] })),
}));
vi.mock('../server/session-list.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/session-list.js')>()),
  listWorkspaceSessionsForResponse: vi.fn(async () => ({ sessions: [] })),
}));
vi.mock('../session-organization-helpers.js', () => ({
  createSessionOrganizationService: () => ({ listGroups: mocks.groups }),
}));
vi.mock(
  '@qwen-code/qwen-code-core/utils/debugLogger.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@qwen-code/qwen-code-core/utils/debugLogger.js')
    >()),
    runWithoutDebugLogSession: vi.fn((read: () => unknown) => read()),
  }),
);

function setup(count = 3) {
  const runtimes = Array.from(
    { length: count },
    (_, index) =>
      ({
        workspaceId: `workspace-${index}`,
        workspaceCwd: path.resolve('/catalog', `workspace-${index}`),
        sessionRuntimeBaseDir: path.resolve('/catalog', `runtime-${index}`),
        primary: index === 0,
        trusted: index !== 2,
        bridge: {},
      }) as WorkspaceRuntime,
  );
  const registry = createWorkspaceRegistry(runtimes);
  const app = express();
  app.use(express.json());
  registerSessionCatalogRoutes(app, registry);
  return { app, registry, runtimes };
}

const list = vi.mocked(listWorkspaceSessionsForResponse);
beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue({ sessions: [] });
  mocks.groups.mockResolvedValue({ groups: [], colorOptions: [] });
});

describe('POST /sessions/catalog', () => {
  it('returns three ordered, independently owned pages and groups in their runtime storage contexts', async () => {
    const h = setup();
    list.mockImplementation(async (_bridge, cwd, options, readOptions) => {
      expect(new Storage(cwd).getRuntimeBaseDir()).toBe(
        readOptions?.runtimeBaseDir,
      );
      expect(options).toMatchObject({ size: 1, sourceType: 'default' });
      expect(readOptions).toMatchObject({ paginateMerged: true });
      return { sessions: [], nextCursor: `next:${cwd}`, truncated: true };
    });
    mocks.groups.mockImplementation(async () => {
      expect(
        h.runtimes.map((runtime) => runtime.sessionRuntimeBaseDir),
      ).toContain(new Storage('/unused').getRuntimeBaseDir());
      return { groups: [], colorOptions: [] };
    });
    const res = await request(h.app)
      .post('/sessions/catalog')
      .send({
        workspaces: 'all',
        options: { size: 1, sourceType: 'default' },
        includeGroups: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.workspaces).toEqual(
      h.runtimes.map((runtime) => ({
        workspace: runtime.workspaceCwd,
        workspaceId: runtime.workspaceId,
        cwd: runtime.workspaceCwd,
        sessions: [],
        nextCursor: `next:${runtime.workspaceCwd}`,
        truncated: true,
        groups: { groups: [], colorOptions: [] },
      })),
    );
    expect(list).toHaveBeenCalledTimes(3);
    expect(mocks.groups).toHaveBeenCalledTimes(3);
    expect(list.mock.calls[2]?.[3]?.mergeLive).toBe(false);
    expect(runWithoutDebugLogSession).toHaveBeenCalledOnce();
  });

  it('reads only selected workspaces and preserves each cursor and shared filters', async () => {
    const h = setup();
    const options = {
      view: 'organized',
      archiveState: 'archived',
      group: 'local-group',
      sourceType: 'channel',
      sourceId: 'bot',
      size: 2,
    };
    const res = await request(h.app)
      .post('/sessions/catalog')
      .send({
        workspaces: [
          { workspace: 'workspace-1', cursor: 'page-b' },
          { workspace: h.runtimes[2]!.workspaceCwd, cursor: 'page-c' },
        ],
        options,
      });
    expect(res.status).toBe(200);
    expect(list.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      [h.runtimes[1]!.workspaceCwd, { ...options, cursor: 'page-b' }],
      [h.runtimes[2]!.workspaceCwd, { ...options, cursor: 'page-c' }],
    ]);
    expect(mocks.groups).not.toHaveBeenCalled();
  });

  it('qualifies stored session rows with their canonical owning workspace', async () => {
    const h = setup();
    list.mockResolvedValueOnce({
      sessions: [
        {
          sessionId: 'stored-session',
          workspaceCwd: '/old-alias',
          createdAt: '2026-01-01T00:00:00Z',
          clientCount: 0,
          hasActivePrompt: false,
        },
      ],
    });
    const res = await request(h.app)
      .post('/sessions/catalog')
      .send({
        workspaces: [{ workspace: 'workspace-1' }],
      });
    const member = res.body.workspaces[0];
    expect(member.cwd).toBe(h.runtimes[1]!.workspaceCwd);
    expect(member.sessions[0].workspaceCwd).toBe(member.cwd);
  });

  it('excludes internal workspaces and reports unknown selectors without primary fallback', async () => {
    const h = setup();
    h.registry.add({
      ...h.runtimes[1]!,
      workspaceId: 'internal',
      workspaceCwd: '/internal',
      provenance: 'live-conversation',
    });
    const all = await request(h.app)
      .post('/sessions/catalog')
      .send({ workspaces: 'all' });
    expect(all.body.workspaces).toHaveLength(3);
    list.mockClear();
    const res = await request(h.app)
      .post('/sessions/catalog')
      .send({
        workspaces: [{ workspace: 'internal' }, { workspace: '/missing' }],
      });
    expect(res.status).toBe(200);
    expect(
      res.body.workspaces.map((member: { error: unknown }) => member.error),
    ).toEqual([
      expect.objectContaining({ status: 404, code: 'workspace_not_found' }),
      expect.objectContaining({ status: 404, code: 'workspace_not_found' }),
    ]);
    expect(list).not.toHaveBeenCalled();
  });

  it.each(['draining', 'transitioning', 'blocked'] as const)(
    'reports %s entries while retaining healthy pages',
    async (state) => {
      const h = setup();
      h.registry.getEntryByWorkspaceId('workspace-1')!.state = state;
      const res = await request(h.app)
        .post('/sessions/catalog')
        .send({ workspaces: 'all' });
      expect(res.body.workspaces[1]).toMatchObject({
        cwd: h.runtimes[1]!.workspaceCwd,
        error: { status: 503, code: 'workspace_runtime_unavailable' },
      });
      expect(res.body.workspaces[0].sessions).toEqual([]);
      expect(res.body.workspaces[2].sessions).toEqual([]);
      expect(list).toHaveBeenCalledTimes(2);
    },
  );

  it('fails closed when a workspace is removed between pages', async () => {
    const h = setup();
    const body = { workspaces: [{ workspace: 'workspace-1' }] };
    expect(
      (await request(h.app).post('/sessions/catalog').send(body)).body
        .workspaces[0].sessions,
    ).toEqual([]);
    h.registry.beginDrain(h.runtimes[1]!);
    h.registry.commitDrain(h.runtimes[1]!);
    h.registry.completeDrain(h.runtimes[1]!);
    const res = await request(h.app).post('/sessions/catalog').send(body);
    expect(res.body.workspaces[0].error.code).toBe('workspace_not_found');
    expect(list).toHaveBeenCalledOnce();
  });

  it('discards a page when its generation closes during the read', async () => {
    const h = setup();
    list.mockImplementation(async () => {
      h.registry.getEntryByWorkspaceId('workspace-1')!.current!.guard.close();
      return { sessions: [] };
    });
    const res = await request(h.app)
      .post('/sessions/catalog')
      .send({
        workspaces: [{ workspace: 'workspace-1' }],
        includeGroups: true,
      });
    expect(res.body.workspaces[0].error.code).toBe(
      'workspace_runtime_unavailable',
    );
    expect(res.body.workspaces[0]).not.toHaveProperty('sessions');
    expect(mocks.groups).not.toHaveBeenCalled();
  });

  it('rejects untrusted primary while allowing persisted secondary inspection', async () => {
    const h = setup();
    const entry = h.registry.primaryEntry;
    h.registry.beginReplacement(entry, 'untrusted');
    h.registry.activateReplacement(
      entry,
      { ...h.runtimes[0]!, trusted: false },
      'untrusted',
    );
    const res = await request(h.app)
      .post('/sessions/catalog')
      .send({ workspaces: 'all' });
    expect(res.body.workspaces[0].error).toMatchObject({
      code: 'untrusted_workspace',
      status: 403,
    });
    expect(res.body.workspaces[2].sessions).toEqual([]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it.each([
    [new InvalidCursorError('bad'), 'invalid_cursor', 400],
    [
      new SessionOrganizationError('Missing group', 'group_not_found'),
      'group_not_found',
      404,
    ],
    [new Error('private storage path'), 'session_catalog_failed', 500],
  ])('isolates member failure %s', async (error, code, status) => {
    const h = setup();
    list.mockRejectedValueOnce(error);
    const res = await request(h.app)
      .post('/sessions/catalog')
      .send({ workspaces: 'all' });
    expect(res.status).toBe(200);
    expect(res.body.workspaces[0].error).toMatchObject({ code, status });
    expect(res.body.workspaces[0]).not.toHaveProperty('sessions');
    expect(res.body.workspaces[1].sessions).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain('private storage path');
  });

  it.each([
    {},
    { workspaces: [] },
    { workspaces: ['workspace-0'] },
    { workspaces: 'all', options: { size: 101 } },
    { workspaces: 'all', options: { size: 0 } },
    { workspaces: 'all', options: { size: 1.5 } },
    { workspaces: 'all', options: { group: 'pinned' } },
    {
      workspaces: 'all',
      options: { view: 'organized', parentSessionId: 'parent' },
    },
    { workspaces: 'all', options: { sourceId: 'orphan' } },
    { workspaces: 'all', options: { sourceType: 'invalid type' } },
    { workspaces: 'all', options: { archiveState: 'all' } },
    { workspaces: 'all', includeGroups: 'true' },
    { workspaces: [{ workspace: 'workspace-0', cursor: 'x'.repeat(16385) }] },
  ])(
    'rejects malformed envelopes before any storage reads: %j',
    async (body) => {
      const h = setup();
      expect(
        (await request(h.app).post('/sessions/catalog').send(body)).status,
      ).toBe(400);
      expect(list).not.toHaveBeenCalled();
      expect(mocks.groups).not.toHaveBeenCalled();
    },
  );

  it('rejects all selections over the workspace bound without silently truncating', async () => {
    const h = setup(21);
    const res = await request(h.app)
      .post('/sessions/catalog')
      .send({ workspaces: 'all' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('too_many_workspaces');
    expect(list).not.toHaveBeenCalled();
  });

  it('reports oversized pages explicitly without dropping healthy members', async () => {
    const h = setup();
    list.mockResolvedValueOnce({
      sessions: [],
      nextCursor: 'x'.repeat(512 * 1024),
    });
    const res = await request(h.app)
      .post('/sessions/catalog')
      .send({ workspaces: 'all' });
    expect(res.body.workspaces[0].error).toMatchObject({
      status: 413,
      code: 'catalog_response_too_large',
    });
    expect(res.body.workspaces[0]).not.toHaveProperty('sessions');
    expect(res.body.workspaces[1].sessions).toEqual([]);
  });

  it('limits simultaneous reads to four and keeps request ordering', async () => {
    const h = setup(9);
    let active = 0;
    let maximum = 0;
    list.mockImplementation(async (_bridge, cwd) => {
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { sessions: [], nextCursor: cwd };
    });
    const res = await request(h.app)
      .post('/sessions/catalog')
      .send({ workspaces: 'all' });
    expect(maximum).toBe(4);
    expect(
      res.body.workspaces.map(
        (member: { nextCursor: string }) => member.nextCursor,
      ),
    ).toEqual(h.runtimes.map((runtime) => runtime.workspaceCwd));
  });

  it('aborts active reads and leaves queued workspaces unread on disconnect', async () => {
    const h = setup(8);
    const server = h.app.listen(0);
    let finished = 0;
    list.mockImplementation(async (_bridge, _cwd, _options, readOptions) => {
      await new Promise<void>((resolve) => {
        readOptions!.signal!.addEventListener('abort', () => resolve(), {
          once: true,
        });
      });
      finished++;
      return { sessions: [] };
    });
    const pending = request(server)
      .post('/sessions/catalog')
      .send({ workspaces: 'all' });
    pending.end(() => {});
    try {
      await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(4));
      pending.abort();
      await vi.waitFor(() => expect(finished).toBe(4));
      expect(list).toHaveBeenCalledTimes(4);
      expect(list.mock.calls.every((call) => call[3]?.signal?.aborted)).toBe(
        true,
      );
      expect(mocks.groups).not.toHaveBeenCalled();
    } finally {
      pending.abort();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
