/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ListWorkspaceSessionsResult } from '../server/session-list.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';
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
  runtimes: WorkspaceRuntime[];
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
      listAll: () => {
        if (opts.registryError) throw opts.registryError;
        return opts.runtimes;
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
  sourceId: 'client-1',
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
      runtimes: [makeRuntime()],
      listSessions: async () =>
        page([BOUND_SESSION, { sessionId: 'session-2', prs: [] }]),
    });

    const res = await request(h.app).get('/sessions/pr-bindings');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      bindings: [
        {
          sessionId: 'session-1',
          workspaceCwd: '/ws/a',
          sourceType: 'web-shell',
          sourceId: 'client-1',
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
      runtimes: [makeRuntime()],
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
      runtimes: [makeRuntime({ trusted: false })],
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
    const h = appHarness({ runtimes: [makeRuntime()], listSessions });

    const res = await request(h.app).get('/sessions/pr-bindings');

    expect(res.status).toBe(200);
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(
      res.body.bindings.map((b: { sessionId: string }) => b.sessionId),
    ).toEqual(['session-1', 'session-3']);
  });

  it('keeps other workspaces when one fails to list', async () => {
    const runtimes = [
      makeRuntime({ workspaceCwd: '/ws/broken' }),
      makeRuntime({ workspaceCwd: '/ws/ok' }),
    ];
    const h = appHarness({
      runtimes,
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
    const h = appHarness({ runtimes: [makeRuntime()], listSessions });

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
    const h = appHarness({ runtimes: [makeRuntime()], listSessions });

    const res = await request(h.app).get('/sessions/pr-bindings');

    expect(res.status).toBe(200);
    expect(res.body.partial).toBe(true);
  });

  it('routes registry failures through sendBridgeError', async () => {
    const h = appHarness({
      runtimes: [],
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
});
