/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DaemonClient,
  DaemonHttpError,
} from '../../src/daemon/DaemonClient.js';
import type { DaemonTransport } from '../../src/daemon/DaemonTransport.js';
import type { DaemonUpdateStatus } from '../../src/daemon/index.js';

function makeClient(reply: DaemonUpdateStatus, status = 200) {
  const fetch = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(reply), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  const transport: DaemonTransport = {
    type: 'acp-ws',
    supportsReplay: false,
    connected: true,
    fetch: vi.fn().mockRejectedValue(new Error('Updates must use REST')),
    async *subscribeEvents() {},
    dispose: vi.fn(),
  };
  const client = new DaemonClient({
    baseUrl: 'http://daemon',
    token: 'secret',
    fetch,
    transport,
  });
  return { client, fetch, transport };
}

describe('daemon update client', () => {
  it('checks status through authenticated REST even with an ACP transport', async () => {
    const status: DaemonUpdateStatus = {
      state: 'available',
      currentVersion: '1.0.0',
      latestVersion: '2.0.0',
      canInstall: true,
    };
    const { client, fetch, transport } = makeClient(status);
    await expect(client.daemonUpdateStatus()).resolves.toEqual(status);
    expect(fetch.mock.calls[0]?.[0]).toBe('http://daemon/daemon/update');
    expect(
      new Headers(fetch.mock.calls[0]?.[1]?.headers).get('Authorization'),
    ).toBe('Bearer secret');
    await client.daemonUpdateStatus(true);
    expect(fetch.mock.calls[1]?.[0]).toBe(
      'http://daemon/daemon/update?refresh=true',
    );
    expect(transport.fetch).not.toHaveBeenCalled();
    client.dispose();
  });

  it.each(['prepare', 'restart'] as const)(
    'sends an empty authenticated REST %s request',
    async (action) => {
      const status: DaemonUpdateStatus = {
        state: action === 'prepare' ? 'installing' : 'restarting',
        latestVersion: '2.0.0',
        canInstall: false,
      };
      const { client, fetch, transport } = makeClient(status, 202);
      await expect(
        action === 'prepare'
          ? client.prepareDaemonUpdate()
          : client.restartDaemonForUpdate(),
      ).resolves.toEqual(status);
      const [url, init] = fetch.mock.calls[0]!;
      expect(url).toBe(`http://daemon/daemon/update/${action}`);
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe('{}');
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        'Bearer secret',
      );
      expect(transport.fetch).not.toHaveBeenCalled();
      client.dispose();
    },
  );

  it('preserves HTTP errors from unsupported or unauthorized installations', async () => {
    const { client } = makeClient(
      { state: 'unavailable', canInstall: false },
      409,
    );
    await expect(client.prepareDaemonUpdate()).rejects.toBeInstanceOf(
      DaemonHttpError,
    );
    client.dispose();
  });
});
