/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkDaemonHealth,
  checkExtensionPairing,
  getDaemonFeatures,
} from './discovery.js';

describe('checkDaemonHealth', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('never sends a stored bearer token before pairing authenticates the daemon', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      checkDaemonHealth({
        baseUrl: 'http://127.0.0.1:4170',
        token: 'daemon-token',
      }),
    ).resolves.toEqual({ reachable: true, status: 'ok' });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init).not.toHaveProperty('headers');
  });
});

describe('getDaemonFeatures', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns advertised string feature tags', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            features: ['client_mcp_over_ws', 'browser_automation_mcp', 42],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const features = await getDaemonFeatures({
      baseUrl: 'http://127.0.0.1:4170',
      token: 'secret',
    });
    expect([...features]).toEqual([
      'client_mcp_over_ws',
      'browser_automation_mcp',
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4170/capabilities',
      expect.objectContaining({
        headers: { Authorization: 'Bearer secret' },
      }),
    );
  });

  it('fails closed to an empty feature set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('down'))),
    );
    await expect(
      getDaemonFeatures({ baseUrl: 'http://127.0.0.1:4170' }),
    ).resolves.toEqual(new Set());
  });
});

describe('checkExtensionPairing', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fails closed when no pairing credential is stored', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      checkExtensionPairing({ baseUrl: 'http://127.0.0.1:4170' }),
    ).resolves.toEqual({ paired: false, reason: 'missing_credential' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('verifies the stored pairing credential with the daemon', async () => {
    const secret = 'pairing-secret';
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { challenge: string };
      const key = createHash('sha256').update(secret).digest();
      const proof = createHmac('sha256', key)
        .update(`qwen-extension-daemon:${request.challenge}`)
        .digest('base64url');
      return new Response(JSON.stringify({ paired: true, proof }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      checkExtensionPairing({
        baseUrl: 'http://127.0.0.1:4170',
        token: 'daemon-token',
        extensionPairingCredential: `credential-id.${secret}`,
      }),
    ).resolves.toEqual({ paired: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:4170/extension/pairing/verify');
    expect(init).toEqual(
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );
    expect(init?.headers).not.toHaveProperty('Authorization');
    expect(String(init?.body)).toContain('credential-id');
    expect(String(init?.body)).not.toContain(secret);
  });

  it('rejects a daemon that cannot prove it issued the stored credential', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ proof: 'wrong' }), { status: 200 }),
      ),
    );

    await expect(
      checkExtensionPairing({
        baseUrl: 'http://127.0.0.1:4170',
        extensionPairingCredential: 'credential-id.pairing-secret',
      }),
    ).resolves.toEqual({ paired: false, reason: 'rejected' });
  });

  it('treats daemon rejection as unpaired', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401 })),
    );

    await expect(
      checkExtensionPairing({
        baseUrl: 'http://127.0.0.1:4170',
        extensionPairingCredential: 'credential-id.stale',
      }),
    ).resolves.toEqual({ paired: false, reason: 'rejected' });
  });
});
