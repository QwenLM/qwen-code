/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { DaemonClient } from '@qwen-code/sdk/daemon';
import type { DaemonTransport } from '@qwen-code/sdk/daemon';
import { expect, it, vi } from 'vitest';
import { createDaemonWorkspaceActions } from './actions';

function setup(baseUrl: string) {
  const restFetch = vi.fn().mockResolvedValue(new Response('{}'));
  const acpFetch = vi.fn();
  const client = new DaemonClient({
    baseUrl,
    token: 'secret',
    transport: { restFetch, fetch: acpFetch } as unknown as DaemonTransport,
  });
  const actions = createDaemonWorkspaceActions({
    baseUrl,
    token: 'secret',
    getClient: () => client,
    getWorkspaceCwd: () => '/primary',
  });
  return { actions, restFetch, acpFetch };
}

it('preserves a prefixed daemon URL and encoded glob query on native REST', async () => {
  const { actions, restFetch, acpFetch } = setup('https://daemon/prefix/');
  restFetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ matches: ['src/a.ts'] })),
  );
  await expect(
    actions.globWorkspace('src/*.ts', {
      cwd: '/secondary a',
      includeIgnored: false,
    }),
  ).resolves.toEqual({ matches: ['src/a.ts'] });
  const [input, init] = restFetch.mock.calls[0];
  const url = new URL(input);
  expect(url.pathname).toBe('/prefix/glob');
  expect(url.searchParams.get('pattern')).toBe('src/*.ts');
  expect(url.searchParams.get('cwd')).toBe('/secondary a');
  expect(url.searchParams.get('includeIgnored')).toBe('0');
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret');
  expect(acpFetch).not.toHaveBeenCalled();
});

it('keeps a scheduled-task write scoped to its encoded non-primary workspace', async () => {
  const { actions, restFetch, acpFetch } = setup('https://daemon/prefix');
  await actions.updateScheduledTask(
    'task/a',
    { enabled: false },
    '/secondary b',
  );
  const [url, init] = restFetch.mock.calls[0];
  expect(url).toBe(
    'https://daemon/prefix/workspaces/%2Fsecondary%20b/scheduled-tasks/task%2Fa',
  );
  expect(init.method).toBe('PATCH');
  expect(JSON.parse(init.body)).toEqual({ enabled: false });
  expect(new Headers(init.headers).get('content-type')).toBe(
    'application/json',
  );
  expect(acpFetch).not.toHaveBeenCalled();
});

it('retains the existing server error for a native goal request on an empty base URL', async () => {
  const { actions, restFetch } = setup('');
  restFetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: 'Unavailable goal' }), {
      status: 503,
    }),
  );
  await expect(actions.listGoals()).rejects.toThrow('Unavailable goal');
  expect(restFetch.mock.calls[0][0]).toBe('/goals');
});
