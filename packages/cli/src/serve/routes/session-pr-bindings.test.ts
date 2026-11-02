/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ListWorkspaceSessionsResult } from '../server/session-list.js';
import type {
  WorkspaceEntry,
  WorkspaceEntryState,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import { createWorkspaceGenerationGuard } from '../workspace-registry.js';
import { registerSessionPrBindingsRoutes } from './session-pr-bindings.js';

function makeRuntime(
  overrides: Partial<{
    trusted: boolean;
    workspaceCwd: string;
  }> = {},
): WorkspaceRuntime {
  return {
    trusted: true,
    workspaceCwd: '/ws/a',
    sessionRuntimeBaseDir: '/tmp/runtime-a',
    bridge: {},
    ...overrides,
  } as unknown as WorkspaceRuntime;
}

function makeEntry(
  runtime?: WorkspaceRuntime,
  state: WorkspaceEntryState = 'active',
): WorkspaceEntry {
  return {
    workspaceId: runtime?.workspaceCwd ?? 'ws-absent',
    workspaceCwd: runtime?.workspaceCwd ?? '/ws/absent',
    primary: false,
    removable: true,
    internal: false,
    registrationIds: [],
    lastGenerationId: 1,
    state,
    ...(runtime
      ? {
          current: {
            generationId: 1,
            policyRevision: 'rev-1',
            runtime,
            guard: createWorkspaceGenerationGuard(),
          },
        }
      : {}),
    configuredRevision: 'rev-1',
    appliedRevision: 'rev-1',
  };
}

function page(
  sessions: Array<Record<string, unknown>>,
  nextCursor?: string,
): ListWorkspaceSessionsResult {
  return {
    sessions: sessions as unknown as ListWorkspaceSessionsResult['sessions'],
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

function appHarness(opts: {
  entries: WorkspaceEntry[];
  listSessions?: (
    runtime: WorkspaceRuntime,
    cursor: string | undefined,
  ) => Promise<ListWorkspaceSessionsResult>;
  registryError?: Error;
}) {
  const app = express();
  const sendBridgeError = vi.fn(
    (res: express.Response, err: unknown, meta: { route: string }) => {
      res.status(500).json({ error: String(err), route: meta.route });
    },
  );
  const listSessions = opts.listSessions ?? vi.fn(async () => page([]));
  registerSessionPrBindingsRoutes(app, {
    workspaceRegistry: {
      listAllEntries: () => {
        if (opts.registryError) throw opts.registryError;
        return opts.entries;
      },
    } as never,
    sendBridgeError: sendBridgeError as never,
    listSessions,
  });
  return { app, listSessions, sendBridgeError };
}

const BOUND_SESSION = {
  sessionId: 'session-1',
  updatedAt: '2026-11-01T10:00:00.000Z',
  sourceType: 'web-shell',
  prs: [
    {
      number: 101,
      url: 'https://github.com/acme/widgets/pull/101',
      state: 'open',
      createdAt: '2026-11-01T09:00:00.000Z',
      source: 'create',
    },
  ],
};

describe('GET /sessions/pr-bindings', () => {
  it('projects bound sessions with their PR entries', async () => {
    const h = appHarness({
      entries: [makeEntry(makeRuntime())],
      listSessions: async () =>
        page([
          BOUND_SESSION,
          { sessionId: 'session-2', prs: [] },
          // Real sidecar-less sessions have no prs key at all.
          { sessionId: 'session-no-prs' },
        ]),
    });

    const res = await request(h.app).get('/sessions/pr-bindings');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      bindings: [
        {
          sessionId: 'session-1',
          workspaceCwd: '/ws/a',
          sourceType: 'web-shell',
          updatedAt: '2026-11-01T10:00:00.000Z',
          prs: [
            {
              number: 101,
              url: 'https://github.com/acme/widgets/pull/101',
              state: 'open',
            },
          ],
        },
      ],
      partial: false,
    });
  });

  it('falls back to createdAt when a live summary lacks updatedAt', async () => {
    const h = appHarness({
      entries: [makeEntry(makeRuntime())],
      listSessions: async () =>
        page([
          {
            sessionId: 'live-session',
            createdAt: '2026-11-02T08:28:06.000Z',
            prs: [
              {
                number: 101,
                url: 'https://github.com/acme/widgets/pull/101',
                state: 'open',
              },
            ],
          },
        ]),
    });

    const res = await request(h.app).get('/sessions/pr-bindings');

    expect(res.status).toBe(200);
    expect(res.body.bindings[0].updatedAt).toBe('2026-11-02T08:28:06.000Z');
  });

  it('skips untrusted workspaces entirely', async () => {
    const listSessions = vi.fn(async () => page([BOUND_SESSION]));
    const h = appHarness({
      entries: [makeEntry(makeRuntime({ trusted: false }))],
      listSessions,
    });

    const res = await request(h.app).get('/sessions/pr-bindings');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bindings: [], partial: false });
    expect(listSessions).not.toHaveBeenCalled();
  });

  it('follows pagination cursors', async () => {
    const listSessions = vi.fn(
      async (_runtime: WorkspaceRuntime, cursor: string | undefined) =>
        cursor === undefined
          ? page([BOUND_SESSION], 'cursor-2')
          : page([
              {
                ...BOUND_SESSION,
                sessionId: 'session-3',
              },
            ]),
    );
    const h = appHarness({ entries: [makeEntry(makeRuntime())], listSessions });

    const res = await request(h.app).get('/sessions/pr-bindings');

    expect(res.status).toBe(200);
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(listSessions).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'cursor-2',
    );
    expect(
      res.body.bindings.map((b: { sessionId: string }) => b.sessionId),
    ).toEqual(['session-1', 'session-3']);
    // Activity-ordered pagination is not snapshot-isolated: any multi-page
    // scan is non-authoritative even when every page succeeds cleanly.
    expect(res.body.partial).toBe(true);
  });

  it('keeps other workspaces when one fails to list', async () => {
    const entries = [
      makeEntry(makeRuntime({ workspaceCwd: '/ws/broken' })),
      makeEntry(makeRuntime({ workspaceCwd: '/ws/ok' })),
    ];
    const h = appHarness({
      entries,
      listSessions: async (runtime) => {
        if (runtime.workspaceCwd === '/ws/broken') {
          throw new Error('disk on fire');
        }
        return page([BOUND_SESSION]);
      },
    });

    const res = await request(h.app).get('/sessions/pr-bindings');

    expect(res.status).toBe(200);
    expect(res.body.bindings).toHaveLength(1);
    expect(res.body.bindings[0].workspaceCwd).toBe('/ws/ok');
    expect(res.body.partial).toBe(true);
  });

  it('flags partial when the page cap is exhausted with cursors remaining', async () => {
    const listSessions = vi.fn(async () => page([BOUND_SESSION], 'more'));
    const h = appHarness({ entries: [makeEntry(makeRuntime())], listSessions });

    const res = await request(h.app).get('/sessions/pr-bindings');

    expect(res.status).toBe(200);
    expect(res.body.partial).toBe(true);
    expect(listSessions).toHaveBeenCalledTimes(50);
  });

  it('propagates page-level truncation as partial', async () => {
    const listSessions = vi.fn(async () => ({
      ...page([BOUND_SESSION]),
      truncated: true,
    }));
    const h = appHarness({ entries: [makeEntry(makeRuntime())], listSessions });

    const res = await request(h.app).get('/sessions/pr-bindings');

    expect(res.status).toBe(200);
    expect(res.body.partial).toBe(true);
  });

  it('flags partial on a live-merge degraded success', async () => {
    const listSessions = vi.fn(async () => ({
      ...page([BOUND_SESSION]),
      liveMergeFailed: true,
    }));
    const h = appHarness({ entries: [makeEntry(makeRuntime())], listSessions });

    const res = await request(h.app).get('/sessions/pr-bindings');

    expect(res.status).toBe(200);
    // Degraded success keeps the data it could read but stays
    // non-authoritative even when sessions are non-empty.
    expect(
      res.body.bindings.map((b: { sessionId: string }) => b.sessionId),
    ).toEqual(['session-1']);
    expect(res.body.partial).toBe(true);
  });

  it('routes registry failures through sendBridgeError', async () => {
    const h = appHarness({
      entries: [],
      registryError: new Error('registry closed'),
    });

    const res = await request(h.app).get('/sessions/pr-bindings');

    expect(res.status).toBe(500);
    expect(h.sendBridgeError).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Error),
      { route: 'GET /sessions/pr-bindings' },
    );
  });

  it.each(['draining', 'transitioning', 'blocked'] as const)(
    'flags partial when a trusted workspace is %s',
    async (state) => {
      const listSessions = vi.fn(async (_runtime: WorkspaceRuntime) =>
        page([BOUND_SESSION]),
      );
      const h = appHarness({
        entries: [
          makeEntry(makeRuntime({ workspaceCwd: '/ws/lifecycle' }), state),
          makeEntry(makeRuntime({ workspaceCwd: '/ws/active' })),
        ],
        listSessions,
      });

      const res = await request(h.app).get('/sessions/pr-bindings');

      expect(res.status).toBe(200);
      // The non-active workspace still serves sessions; its absence is not
      // an authoritative "no bindings".
      expect(res.body.partial).toBe(true);
      expect(res.body.bindings).toHaveLength(1);
      expect(res.body.bindings[0].sessionId).toBe('session-1');
      expect(res.body.bindings[0].workspaceCwd).toBe('/ws/active');
      expect(listSessions).toHaveBeenCalledTimes(1);
      expect(listSessions.mock.calls[0][0].workspaceCwd).toBe('/ws/active');
    },
  );

  it('flags partial when an entry has no current runtime', async () => {
    const h = appHarness({
      entries: [makeEntry(undefined), makeEntry(makeRuntime())],
      listSessions: async () => page([BOUND_SESSION]),
    });

    const res = await request(h.app).get('/sessions/pr-bindings');

    expect(res.status).toBe(200);
    expect(res.body.partial).toBe(true);
    expect(res.body.bindings).toHaveLength(1);
    expect(res.body.bindings[0].sessionId).toBe('session-1');
  });

  it('resets the pagination cursor per workspace', async () => {
    const listSessions = vi.fn(
      async (runtime: WorkspaceRuntime, cursor: string | undefined) => {
        const label = runtime.workspaceCwd === '/ws/a' ? 'a' : 'b';
        return cursor === undefined
          ? page(
              [{ ...BOUND_SESSION, sessionId: `${label}-1` }],
              `cursor-${label}-2`,
            )
          : page([{ ...BOUND_SESSION, sessionId: `${label}-2` }]);
      },
    );
    const h = appHarness({
      entries: [
        makeEntry(makeRuntime({ workspaceCwd: '/ws/a' })),
        makeEntry(makeRuntime({ workspaceCwd: '/ws/b' })),
      ],
      listSessions,
    });

    const res = await request(h.app).get('/sessions/pr-bindings');

    expect(res.status).toBe(200);
    expect(listSessions).toHaveBeenCalledTimes(4);
    // Each workspace's FIRST call must start without a cursor, and its
    // second call must forward its own cursor, not the previous
    // workspace's residual one.
    expect(listSessions.mock.calls[0][1]).toBeUndefined();
    expect(listSessions).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'cursor-a-2',
    );
    expect(listSessions).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      undefined,
    );
    expect(listSessions).toHaveBeenNthCalledWith(
      4,
      expect.anything(),
      'cursor-b-2',
    );
    expect(
      res.body.bindings.map((b: { sessionId: string }) => b.sessionId),
    ).toEqual(['a-1', 'a-2', 'b-1', 'b-2']);
  });

  it('keeps the page cap per workspace', async () => {
    const pagesByWorkspace = new Map<string, number>();
    const listSessions = vi.fn(async (runtime: WorkspaceRuntime) => {
      const n = (pagesByWorkspace.get(runtime.workspaceCwd) ?? 0) + 1;
      pagesByWorkspace.set(runtime.workspaceCwd, n);
      const session = {
        ...BOUND_SESSION,
        sessionId: `${runtime.workspaceCwd}#${n}`,
      };
      return n < 30 ? page([session], `cursor-${n}`) : page([session]);
    });
    const h = appHarness({
      entries: [
        makeEntry(makeRuntime({ workspaceCwd: '/ws/a' })),
        makeEntry(makeRuntime({ workspaceCwd: '/ws/b' })),
      ],
      listSessions,
    });

    const res = await request(h.app).get('/sessions/pr-bindings');

    expect(res.status).toBe(200);
    // 30 pages per workspace (60 total > MAX_PAGES): each workspace gets
    // its own full budget, so both tail sessions must appear.
    expect(listSessions).toHaveBeenCalledTimes(60);
    expect(res.body.bindings).toHaveLength(60);
    const ids = res.body.bindings.map(
      (b: { sessionId: string }) => b.sessionId,
    );
    expect(ids).toContain('/ws/a#30');
    expect(ids).toContain('/ws/b#30');
    // Multi-page scans are non-authoritative regardless of the cap.
    expect(res.body.partial).toBe(true);
  });

  it('skips untrusted workspaces but keeps scanning trusted ones', async () => {
    const listSessions = vi.fn(async (_runtime: WorkspaceRuntime) =>
      page([BOUND_SESSION]),
    );
    const h = appHarness({
      entries: [
        makeEntry(
          makeRuntime({ trusted: false, workspaceCwd: '/ws/untrusted' }),
        ),
        makeEntry(makeRuntime({ workspaceCwd: '/ws/trusted' })),
      ],
      listSessions,
    });

    const res = await request(h.app).get('/sessions/pr-bindings');

    expect(res.status).toBe(200);
    expect(res.body.partial).toBe(false);
    expect(res.body.bindings).toHaveLength(1);
    expect(res.body.bindings[0].sessionId).toBe('session-1');
    expect(res.body.bindings[0].workspaceCwd).toBe('/ws/trusted');
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(listSessions.mock.calls[0][0].workspaceCwd).toBe('/ws/trusted');
  });

  it('aggregates bindings across multiple healthy trusted workspaces', async () => {
    const h = appHarness({
      entries: [
        makeEntry(makeRuntime({ workspaceCwd: '/ws/a' })),
        makeEntry(makeRuntime({ workspaceCwd: '/ws/b' })),
      ],
      listSessions: async (runtime) =>
        page([
          {
            ...BOUND_SESSION,
            sessionId:
              runtime.workspaceCwd === '/ws/a' ? 'session-a' : 'session-b',
          },
        ]),
    });

    const res = await request(h.app).get('/sessions/pr-bindings');

    expect(res.status).toBe(200);
    expect(res.body.partial).toBe(false);
    expect(res.body.bindings).toEqual([
      expect.objectContaining({
        sessionId: 'session-a',
        workspaceCwd: '/ws/a',
      }),
      expect.objectContaining({
        sessionId: 'session-b',
        workspaceCwd: '/ws/b',
      }),
    ]);
  });

  it('retains already-listed pages when a later page fails', async () => {
    const listSessions = vi.fn(
      async (_runtime: WorkspaceRuntime, cursor: string | undefined) => {
        if (cursor === undefined) return page([BOUND_SESSION], 'cursor-2');
        throw new Error('bridge hiccup');
      },
    );
    const h = appHarness({ entries: [makeEntry(makeRuntime())], listSessions });

    const res = await request(h.app).get('/sessions/pr-bindings');

    expect(res.status).toBe(200);
    expect(
      res.body.bindings.map((b: { sessionId: string }) => b.sessionId),
    ).toEqual(['session-1']);
    expect(res.body.partial).toBe(true);
  });

  it('preserves merged and closed PR states verbatim', async () => {
    const h = appHarness({
      entries: [makeEntry(makeRuntime())],
      listSessions: async () =>
        page([
          {
            sessionId: 'session-terminal',
            prs: [
              {
                number: 101,
                url: 'https://github.com/acme/widgets/pull/101',
                state: 'merged',
              },
              {
                number: 102,
                url: 'https://github.com/acme/widgets/pull/102',
                state: 'closed',
              },
            ],
          },
        ]),
    });

    const res = await request(h.app).get('/sessions/pr-bindings');

    expect(res.status).toBe(200);
    expect(res.body.partial).toBe(false);
    expect(res.body.bindings).toHaveLength(1);
    expect(res.body.bindings[0].sessionId).toBe('session-terminal');
    // Terminal states are load-bearing for downstream retention; they must
    // survive the projection unchanged.
    expect(res.body.bindings[0].prs).toEqual([
      {
        number: 101,
        url: 'https://github.com/acme/widgets/pull/101',
        state: 'merged',
      },
      {
        number: 102,
        url: 'https://github.com/acme/widgets/pull/102',
        state: 'closed',
      },
    ]);
  });
});
