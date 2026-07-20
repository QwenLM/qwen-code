/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDaemonWorkspaceActions } from './actions.js';

// `listGoals`/`clearGoal` use raw global fetch (like the scheduled-task
// methods), so stub fetch and assert path, method, auth header, response
// normalization and error handling.
function makeActions(token?: string) {
  return createDaemonWorkspaceActions({
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

describe('goals workspace actions', () => {
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

  describe('listGoals', () => {
    it('GETs /goals and returns the goals with the dropped count', async () => {
      fetchMock.mockResolvedValue(
        ok({ v: 1, goals: [{ sessionId: 's1' }], droppedCount: 2 }),
      );

      const list = await makeActions('tok').listGoals();

      expect(list).toEqual({ goals: [{ sessionId: 's1' }], droppedCount: 2 });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/goals');
      expect(initOf(fetchMock.mock.calls[0]).method ?? 'GET').toBe('GET');
      expect(headersOf(init)['Authorization']).toBe('Bearer tok');
    });

    it('normalizes a missing goals array to empty', async () => {
      fetchMock.mockResolvedValue(ok({ v: 1 }));
      expect(await makeActions().listGoals()).toEqual({
        goals: [],
        droppedCount: 0,
      });
    });

    it('normalizes a non-array goals field to empty', async () => {
      fetchMock.mockResolvedValue(ok({ v: 1, goals: 'nope' }));
      expect(await makeActions().listGoals()).toEqual({
        goals: [],
        droppedCount: 0,
      });
    });

    it('normalizes a missing or nonsensical droppedCount to 0', async () => {
      fetchMock.mockResolvedValue(ok({ v: 1, goals: [], droppedCount: -1 }));
      expect((await makeActions().listGoals()).droppedCount).toBe(0);

      fetchMock.mockResolvedValue(ok({ v: 1, goals: [], droppedCount: 'two' }));
      expect((await makeActions().listGoals()).droppedCount).toBe(0);
    });

    it('throws on a non-ok response', async () => {
      fetchMock.mockResolvedValue(fail(500, { error: 'boom' }));
      await expect(makeActions().listGoals()).rejects.toThrow();
    });
  });

  describe('clearGoal', () => {
    it('POSTs to the per-session clear route with an encoded id', async () => {
      fetchMock.mockResolvedValue(ok({ cleared: true }));

      const result = await makeActions('tok').clearGoal('a/b c');

      expect(result).toEqual({ cleared: true });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/session/a%2Fb%20c/goal/clear');
      expect(initOf(fetchMock.mock.calls[0]).method).toBe('POST');
      expect(headersOf(init)['Authorization']).toBe('Bearer tok');
    });

    it('reuses the same daemon route a `/goal clear` in chat takes', async () => {
      fetchMock.mockResolvedValue(ok({ cleared: false }));
      await makeActions().clearGoal('s1');
      expect(fetchMock.mock.calls[0][0]).toBe('/session/s1/goal/clear');
    });

    it('throws on a non-ok response', async () => {
      fetchMock.mockResolvedValue(fail(404, { error: 'no session' }));
      await expect(makeActions().clearGoal('gone')).rejects.toThrow();
    });
  });
});
