/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDaemonWorkspaceActions } from './actions.js';

// The scheduled-task methods use raw global fetch (like glob/stat/list), so we
// stub fetch and assert the HTTP method, path (with id encoding), JSON body,
// auth header, and error handling.
function makeActions(token?: string) {
  return createDaemonWorkspaceActions({
    // These methods never touch the client, only requireClient's non-null check.
    getClient: () => ({}) as never,
    getWorkspaceCwd: () => '/ws',
    baseUrl: '',
    token,
  });
}

const ok = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
});
const fail = (status: number, body: unknown) => ({
  ok: false,
  status,
  json: async () => body,
});

describe('scheduled-tasks workspace actions', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const initOf = (call: unknown[]) => call[1] as RequestInit;
  const headersOf = (init: RequestInit) =>
    (init.headers ?? {}) as Record<string, string>;

  it('lists tasks with a GET and returns the tasks array', async () => {
    fetchMock.mockResolvedValue(
      ok({ v: 1, tasks: [{ id: 'a' }, { id: 'b' }] }),
    );
    const tasks = await makeActions('tok').listScheduledTasks();
    expect(tasks).toEqual([{ id: 'a' }, { id: 'b' }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/scheduled-tasks');
    expect(initOf(fetchMock.mock.calls[0]).method ?? 'GET').toBe('GET');
    expect(headersOf(init)['Authorization']).toBe('Bearer tok');
  });

  it('returns [] when the response omits tasks', async () => {
    fetchMock.mockResolvedValue(ok({ v: 1 }));
    expect(await makeActions().listScheduledTasks()).toEqual([]);
  });

  it('creates a task with a POST + JSON body', async () => {
    fetchMock.mockResolvedValue(ok({ id: 'x' }));
    const res = await makeActions().createScheduledTask({
      cron: '0 9 * * *',
      prompt: 'p',
      delivery: {
        kind: 'channel',
        target: {
          channelName: 'dingtalk',
          chatId: 'group-42',
          isGroup: true,
        },
      },
    });
    expect(res).toEqual({ id: 'x' });
    const init = initOf(fetchMock.mock.calls[0]);
    expect(fetchMock.mock.calls[0][0]).toBe('/scheduled-tasks');
    expect(init.method).toBe('POST');
    expect(headersOf(init)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toMatchObject({
      cron: '0 9 * * *',
      prompt: 'p',
      delivery: {
        kind: 'channel',
        target: {
          channelName: 'dingtalk',
          chatId: 'group-42',
          isGroup: true,
        },
      },
    });
  });

  it('updates with a PATCH and URL-encodes the id', async () => {
    fetchMock.mockResolvedValue(ok({ id: 'a/b' }));
    await makeActions().updateScheduledTask('a/b', {
      enabled: false,
      delivery: null,
    });
    const init = initOf(fetchMock.mock.calls[0]);
    expect(fetchMock.mock.calls[0][0]).toBe('/scheduled-tasks/a%2Fb');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({
      enabled: false,
      delivery: null,
    });
  });

  it('deletes with a DELETE', async () => {
    fetchMock.mockResolvedValue(ok({ deleted: true, id: 'id1' }));
    await makeActions().deleteScheduledTask('id1');
    const init = initOf(fetchMock.mock.calls[0]);
    expect(fetchMock.mock.calls[0][0]).toBe('/scheduled-tasks/id1');
    expect(init.method).toBe('DELETE');
  });

  it('throws with the server error message on a non-ok response', async () => {
    fetchMock.mockResolvedValue(
      fail(400, { error: 'bad cron', code: 'invalid_cron' }),
    );
    await expect(
      makeActions().createScheduledTask({ cron: 'x', prompt: 'p' }),
    ).rejects.toThrow(/bad cron/);
  });

  describe('workspace-qualified targeting', () => {
    it('lists a named workspace via the qualified route', async () => {
      fetchMock.mockResolvedValue(ok({ v: 1, tasks: [] }));
      await makeActions().listScheduledTasks('ws-2');
      expect(fetchMock.mock.calls[0][0]).toBe(
        '/workspaces/ws-2/scheduled-tasks',
      );
    });

    it('creates in a named workspace via the qualified route', async () => {
      fetchMock.mockResolvedValue(ok({ id: 'x' }));
      await makeActions().createScheduledTask(
        { cron: '0 9 * * *', prompt: 'p' },
        'ws-2',
      );
      expect(fetchMock.mock.calls[0][0]).toBe(
        '/workspaces/ws-2/scheduled-tasks',
      );
      expect(initOf(fetchMock.mock.calls[0]).method).toBe('POST');
    });

    it('patches / runs / deletes a task in a named workspace', async () => {
      fetchMock.mockResolvedValue(ok({ id: 'a' }));
      await makeActions().updateScheduledTask('a', { enabled: false }, 'ws-2');
      await makeActions().runScheduledTask('a', 'ws-2');
      await makeActions().deleteScheduledTask('a', 'ws-2');
      expect(fetchMock.mock.calls[0][0]).toBe(
        '/workspaces/ws-2/scheduled-tasks/a',
      );
      expect(fetchMock.mock.calls[1][0]).toBe(
        '/workspaces/ws-2/scheduled-tasks/a/run',
      );
      expect(fetchMock.mock.calls[2][0]).toBe(
        '/workspaces/ws-2/scheduled-tasks/a',
      );
    });

    it('url-encodes both the workspace selector and the task id', async () => {
      fetchMock.mockResolvedValue(ok({ id: 'a' }));
      await makeActions().updateScheduledTask(
        'a/b',
        { enabled: false },
        '/abs/path',
      );
      expect(fetchMock.mock.calls[0][0]).toBe(
        '/workspaces/%2Fabs%2Fpath/scheduled-tasks/a%2Fb',
      );
    });

    it('falls back to the primary (unqualified) route when omitted', async () => {
      fetchMock.mockResolvedValue(ok({ v: 1, tasks: [] }));
      await makeActions().listScheduledTasks();
      await makeActions().listScheduledTasks(undefined);
      expect(fetchMock.mock.calls[0][0]).toBe('/scheduled-tasks');
      expect(fetchMock.mock.calls[1][0]).toBe('/scheduled-tasks');
    });
  });
});
