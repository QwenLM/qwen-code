/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';
import { createSessionAgentsHttpApi } from './session-agents-api';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('posts a retry to the run route of the session workspace', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 202,
    json: () => Promise.resolve({ runId: 'run 1' }),
  });
  vi.stubGlobal('fetch', fetchMock);
  const api = createSessionAgentsHttpApi(
    'http://daemon/',
    'secret',
    '/repo/a b',
  );

  await expect(api.retryRun('s/1', 'run 1')).resolves.toEqual({
    runId: 'run 1',
  });

  expect(fetchMock).toHaveBeenCalledWith(
    'http://daemon/workspaces/%2Frepo%2Fa%20b/agent/sessions/s%2F1/runs/run%201/retry',
    expect.objectContaining({
      method: 'POST',
      body: '{}',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer secret',
      },
    }),
  );
});

it('surfaces a refused retry as an error with the server message', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ message: 'This run cannot be retried.' }),
    }),
  );
  const api = createSessionAgentsHttpApi('http://daemon', undefined, '/repo');
  await expect(api.retryRun('s1', 'r1')).rejects.toThrow(
    'This run cannot be retried.',
  );
});
