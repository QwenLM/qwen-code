/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../src/daemon/DaemonClient.js';
import type { DaemonTransport } from '../src/daemon/DaemonTransport.js';

describe('hook history REST API', () => {
  it('uses native REST for encoded session/turn and workspace-qualified pages', async () => {
    const restFetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      async () =>
        new Response(JSON.stringify({ coverage: 'unrecorded' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const fetch = vi.fn();
    const transport = {
      type: 'acp-ws',
      restFetch,
      fetch,
    } as unknown as DaemonTransport;
    const client = new DaemonClient({
      baseUrl: 'https://daemon.example',
      transport,
    });
    await client.getSessionTurnHooksPage('session/1', 'session########1', {
      snapshot: 'signed',
      start: 50,
      limit: 50,
    });
    await client
      .workspaceById('workspace/id')
      .getSessionTurnHooksPage('session/1', 'session########1');
    expect(fetch).not.toHaveBeenCalled();
    expect(restFetch.mock.calls[0]?.[0]).toBe(
      'https://daemon.example/session/session%2F1/turns/session%23%23%23%23%23%23%23%231/hooks?snapshot=signed&start=50&limit=50',
    );
    expect(restFetch.mock.calls[1]?.[0]).toBe(
      'https://daemon.example/workspaces/workspace%2Fid/session/session%2F1/turns/session%23%23%23%23%23%23%23%231/hooks',
    );
  });
});
