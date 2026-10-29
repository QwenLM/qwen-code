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

describe('autofix-pr watch workspace actions', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the primary by its own route and another workspace by its id', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        v: 1,
        available: true,
        now: '2026-10-27T00:00:00.000Z',
        watches: [{ pr: 12 }],
      }),
    });
    const actions = makeActions('tok');
    expect(await actions.listAutofixPrWatches()).toEqual({
      available: true,
      now: '2026-10-27T00:00:00.000Z',
      watches: [{ pr: 12 }],
    });
    await actions.listAutofixPrWatches('w/1');
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/autofix-pr/watches',
      '/workspaces/w%2F1/autofix-pr/watches',
    ]);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok');
  });

  it('keeps a malformed answer to its shape, and throws on a refusal', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ v: 1, watches: 'x', unreadable: 3 }),
    });
    expect(await makeActions().listAutofixPrWatches()).toEqual({
      available: false,
      watches: [],
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({
        error: 'Workspace is not trusted.',
        code: 'untrusted_workspace',
      }),
    });
    await expect(makeActions().listAutofixPrWatches('w')).rejects.toThrow(
      /not trusted/,
    );
  });
});
