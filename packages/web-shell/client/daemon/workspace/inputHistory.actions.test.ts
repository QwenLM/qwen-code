/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDaemonWorkspaceActions } from './actions.js';

function makeActions(token?: string) {
  return createDaemonWorkspaceActions({
    getClient: () => ({}) as never,
    getWorkspaceCwd: () => '/ws',
    baseUrl: '',
    token,
  });
}

describe('input history workspace actions', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads primary and workspace-qualified input history with ETag and 304 support', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          kind: 'prompt',
          entries: ['from desktop'],
          revision: 'rev1',
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 304,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          kind: 'shell',
          entries: ['git status'],
          revision: 'rev2',
        }),
      });

    const actions = makeActions('tok');
    expect(await actions.loadInputHistory({ kind: 'prompt' })).toEqual({
      notModified: false,
      kind: 'prompt',
      entries: ['from desktop'],
      revision: 'rev1',
    });

    expect(
      await actions.loadInputHistory({
        kind: 'prompt',
        ifNoneMatch: '"v1:rev1"',
      }),
    ).toEqual({ notModified: true });

    expect(
      await actions.loadInputHistory({
        kind: 'shell',
        limit: 50,
        workspaceId: 'ws/2',
      }),
    ).toEqual({
      notModified: false,
      kind: 'shell',
      entries: ['git status'],
      revision: 'rev2',
    });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/workspace/input-history?kind=prompt',
      '/workspace/input-history?kind=prompt',
      '/workspaces/ws%2F2/input-history?kind=shell&limit=50',
    ]);
    const secondHeaders = new Headers(
      (fetchMock.mock.calls[1][1] as RequestInit).headers,
    );
    expect(secondHeaders.get('authorization')).toBe('Bearer tok');
    expect(secondHeaders.get('if-none-match')).toBe('"v1:rev1"');
  });

  it('posts local input history entries to primary and qualified routes', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        kind: 'prompt',
        entries: ['/clear'],
        revision: 'rev3',
      }),
    });

    const actions = makeActions('tok');
    await actions.recordInputHistory({ kind: 'prompt', entry: '/clear' });
    await actions.recordInputHistory({
      kind: 'prompt',
      entry: '/recap',
      workspaceId: 'ws-2',
    });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/workspace/input-history',
      '/workspaces/ws-2/input-history',
    ]);
    const firstInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(firstInit.method).toBe('POST');
    expect(JSON.parse(firstInit.body as string)).toEqual({
      kind: 'prompt',
      entry: '/clear',
    });
  });

  it('throws on daemon refusal', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({
        error: 'Workspace is not trusted.',
        code: 'untrusted_workspace',
      }),
    });
    await expect(
      makeActions().loadInputHistory({
        kind: 'prompt',
        workspaceId: 'untrusted',
      }),
    ).rejects.toThrow(/not trusted/);
  });
});
