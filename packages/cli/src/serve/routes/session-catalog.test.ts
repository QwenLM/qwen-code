/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  addDaemonRequestAttribute,
  hashDaemonWorkspace,
} from '@qwen-code/qwen-code-core/telemetry/daemon-tracing.js';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionGroupCatalog } from '@qwen-code/qwen-code-core';
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
  groups: vi.fn<() => Promise<SessionGroupCatalog>>(),
  organization: vi.fn(),
  span: vi.fn(),
  attribute: vi.fn(),
}));
vi.mock(
  '@qwen-code/qwen-code-core/telemetry/daemon-tracing.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@qwen-code/qwen-code-core/telemetry/daemon-tracing.js')
    >()),
    withDaemonSpan: mocks.span,
    addDaemonRequestAttribute: mocks.attribute,
  }),
);
const memberScope = new AsyncLocalStorage<string>();
vi.mock('../server/session-list.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/session-list.js')>()),
  listWorkspaceSessionsForResponse: vi.fn(async () => ({ sessions: [] })),
}));
vi.mock('../session-organization-helpers.js', () => ({
  createSessionOrganizationService: mocks.organization,
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
  mocks.span.mockImplementation(
    (
      _name: string,
      attributes: Record<string, string>,
      read: () => Promise<unknown>,
    ) => memberScope.run(attributes['qwen-code.workspace.hash']!, read),
  );
  mocks.attribute.mockReset();
  list.mockResolvedValue({ sessions: [] });
  mocks.groups.mockResolvedValue({ groups: [], colorOptions: [] });
  mocks.organization.mockReturnValue({ listGroups: mocks.groups });
});

describe('POST /sessions/catalog', () => {
  it('returns three ordered, independently owned pages and groups in their runtime storage contexts', async () => {
    const h = setup();
    const catalogs = h.runtimes.map((runtime) => ({
      groups: [
        {
          id: 'shared-group-id',
          name: runtime.workspaceId,
          color: 'blue' as const,
          order: 0,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      colorOptions: ['blue' as const],
    }));
    list.mockImplementation(async (bridge, cwd, options, readOptions) => {
      const runtime = h.runtimes.find((item) => item.workspaceCwd === cwd)!;
      expect(bridge).toBe(runtime.bridge);
      expect(readOptions?.mergeLive).toBe(runtime.trusted);
      expect(new Storage(cwd).getRuntimeBaseDir()).toBe(
        readOptions?.runtimeBaseDir,
      );
      expect(options).toMatchObject({ size: 1, sourceType: 'default' });
      expect(readOptions).toMatchObject({ paginateMerged: true });
      return { sessions: [], nextCursor: `next:${cwd}`, truncated: true };
    });
    mocks.organization.mockImplementation((cwd: string) => ({
      listGroups: async () => {
        const runtime = h.runtimes.find((item) => item.workspaceCwd === cwd)!;
        expect(new Storage(cwd).getRuntimeBaseDir()).toBe(
          runtime.sessionRuntimeBaseDir,
        );
        return catalogs[h.runtimes.indexOf(runtime)];
      },
    }));
    const res = await request(h.app)
      .post('/sessions/catalog')
      .send({
        workspaces: 'all',
        options: { size: 1, sourceType: 'default' },
        includeGroups: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.workspaces).toEqual(
      h.runtimes.map((runtime, index) => ({
        workspace: runtime.workspaceCwd,
        workspaceId: runtime.workspaceId,
        cwd: runtime.workspaceCwd,
        sessions: [],
        nextCursor: `next:${runtime.workspaceCwd}`,
        truncated: true,
        groups: catalogs[index],
      })),
    );
    expect(list).toHaveBeenCalledTimes(3);
    expect(mocks.organization.mock.calls.map(([cwd]) => cwd)).toEqual(
      h.runtimes.map((runtime) => runtime.workspaceCwd),
    );
    expect(list.mock.calls[2]?.[3]?.mergeLive).toBe(false);
    expect(runWithoutDebugLogSession).toHaveBeenCalledOnce();
  });

  it('isolates each member scan span and reports batch count and truncation', async () => {
    const h = setup();
    const writes: Array<{ scope?: string; key: string; value: unknown }> = [];
    mocks.attribute.mockImplementation((key: string, value: unknown) => {
      writes.push({ scope: memberScope.getStore(), key, value });
    });
    list.mockImplementation(async (_bridge, cwd) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(memberScope.getStore()).toBe(hashDaemonWorkspace(cwd));
      addDaemonRequestAttribute(
        'qwen-code.daemon.session_list.persisted_sessions',
        1,
      );
      return { sessions: [], truncated: cwd === h.runtimes[1]!.workspaceCwd };
    });
    const res = await request(h.app)
      .post('/sessions/catalog')
      .send({ workspaces: 'all' });
    expect(res.status).toBe(200);
    expect(mocks.span).toHaveBeenCalledTimes(3);
    expect(writes.filter((write) => write.scope === undefined)).toEqual([
      {
        scope: undefined,
        key: 'qwen-code.daemon.session_catalog.members',
        value: 3,
      },
      {
        scope: undefined,
        key: 'qwen-code.daemon.session_catalog.truncated',
        value: true,
      },
    ]);
    expect(
      new Set(
        writes
          .filter((write) => write.scope !== undefined)
          .map((write) => write.scope),
      ).size,
    ).toBe(3);
  });

  it('reuses the organized page group catalog without another store read', async () => {
    const h = setup(1);
    const groups: SessionGroupCatalog = { groups: [], colorOptions: ['blue'] };
    list.mockResolvedValueOnce({ sessions: [], groups });
    const res = await request(h.app)
      .post('/sessions/catalog')
      .send({
        workspaces: 'all',
        options: { view: 'organized' },
        includeGroups: true,
      });
    expect(res.body.workspaces[0].groups).toEqual(groups);
    expect(list.mock.calls[0]?.[3]?.includeGroups).toBe(true);
    expect(mocks.organization).not.toHaveBeenCalled();
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
    expect(
      res.body.workspaces.map(
        (member: { workspace: string }) => member.workspace,
      ),
    ).toEqual(['workspace-1', h.runtimes[2]!.workspaceCwd]);
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
    expect(member.workspace).toBe('workspace-1');
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
      {
        status: 404,
        code: 'workspace_not_found',
        message: 'Workspace is not registered with this daemon.',
      },
      {
        status: 404,
        code: 'workspace_not_found',
        message: 'Workspace is not registered with this daemon.',
      },
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

  describe.each(['sessions', 'groups'] as const)(
    'lifecycle changes during %s reads',
    (phase) => {
      it('retains the page when only the policy revision advances', async () => {
        const h = setup();
        const entry = h.registry.getEntryByWorkspaceId('workspace-1')!;
        const generation = entry.current!;
        const advanceRevision = () => {
          h.registry.advancePolicyRevision(entry, 'updated-policy');
        };
        list.mockImplementation(async () => {
          if (phase === 'sessions') advanceRevision();
          return { sessions: [], nextCursor: 'next-page' };
        });
        const groups = { groups: [], colorOptions: ['blue' as const] };
        mocks.groups.mockImplementation(async () => {
          if (phase === 'groups') advanceRevision();
          return groups;
        });

        const res = await request(h.app)
          .post('/sessions/catalog')
          .send({
            workspaces: [{ workspace: 'workspace-1' }],
            includeGroups: true,
          });

        expect(entry.current).not.toBe(generation);
        expect(entry.current?.generationId).toBe(generation.generationId);
        expect(entry.current?.runtime).toBe(generation.runtime);
        expect(entry.current?.guard).toBe(generation.guard);
        expect(generation.guard.closed).toBe(false);
        expect(res.status).toBe(200);
        expect(res.body.workspaces).toEqual([
          {
            workspace: 'workspace-1',
            workspaceId: entry.workspaceId,
            cwd: entry.workspaceCwd,
            sessions: [],
            nextCursor: 'next-page',
            groups,
          },
        ]);
        expect(mocks.groups).toHaveBeenCalledOnce();
      });

      it.each(['drain', 'remove', 'replace'] as const)(
        'discards the page on %s',
        async (change) => {
          const h = setup();
          const runtime = h.runtimes[1]!;
          const entry = h.registry.getEntryByWorkspaceId(runtime.workspaceId)!;
          const generation = entry.current!;
          const observed: {
            generationIdChanged?: boolean;
            guardClosed?: boolean;
          } = {};
          const changeLifecycle = () => {
            if (change === 'replace') {
              h.registry.beginReplacement(entry, 'replacement-policy');
              h.registry.activateReplacement(
                entry,
                { ...runtime, trusted: false },
                'replacement-policy',
              );
              observed.generationIdChanged =
                entry.current?.generationId !== generation.generationId;
            } else {
              h.registry.beginDrain(runtime);
              observed.guardClosed = generation.guard.closed;
              if (change === 'remove') h.registry.completeDrain(runtime);
            }
          };
          list.mockImplementation(async () => {
            if (phase === 'sessions') changeLifecycle();
            return { sessions: [] };
          });
          mocks.groups.mockImplementation(async () => {
            if (phase === 'groups') changeLifecycle();
            return { groups: [], colorOptions: [] };
          });

          const res = await request(h.app)
            .post('/sessions/catalog')
            .send({
              workspaces: [{ workspace: runtime.workspaceId }],
              includeGroups: true,
            });

          if (change === 'replace') {
            expect(observed.generationIdChanged).toBe(true);
          } else {
            expect(observed.guardClosed).toBe(false);
          }
          expect(res.status).toBe(200);
          expect(res.body.workspaces[0].error).toMatchObject({
            status: 503,
            code: 'workspace_runtime_unavailable',
          });
          expect(res.body.workspaces[0]).not.toHaveProperty('sessions');
          expect(mocks.groups).toHaveBeenCalledTimes(
            phase === 'groups' ? 1 : 0,
          );
        },
      );
    },
  );

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
    { workspaces: 'all', unexpected: true },
    { workspaces: [{ workspace: 'workspace-0', unexpected: true }] },
    { workspaces: 'all', options: { cursor: 'wrong-level' } },
    {
      workspaces: Array.from({ length: 21 }, () => ({
        workspace: 'workspace-0',
      })),
    },
    { workspaces: [{ workspace: 'x'.repeat(4097) }] },
    {
      workspaces: 'all',
      options: { view: 'organized', group: 'x'.repeat(257) },
    },
    { workspaces: 'all', options: { parentSessionId: 'x'.repeat(257) } },
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
      .send({ workspaces: 'all', includeGroups: true });
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
