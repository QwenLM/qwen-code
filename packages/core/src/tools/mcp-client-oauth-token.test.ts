/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transport } from '@modelcontextprotocol/client';
import type { MCPServerConfig } from '../config/config.js';
import type { OAuthCredentials } from '../mcp/token-storage/types.js';
import { _setMcpFetchForTest, createTransport } from './mcp-client.js';

const storage = vi.hoisted(() => ({
  creds: null as OAuthCredentials | null,
  getCredentials: vi.fn(),
  saveToken: vi.fn(),
  deleteCredentials: vi.fn(),
}));

// A real MCPOAuthProvider runs against the real storage class (including its
// expiry rule); only the backend (file / keychain) is replaced.
vi.mock('../mcp/oauth-token-storage.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../mcp/oauth-token-storage.js')>();
  return {
    MCPOAuthTokenStorage: class extends actual.MCPOAuthTokenStorage {
      override getCredentials = storage.getCredentials;
      override saveToken = storage.saveToken;
      override deleteCredentials = storage.deleteCredentials;
    },
  };
});

const SERVER = 'oauth-refresh-server';
const TOKEN_URL = 'https://auth.example/token';
const HOUR_MS = 60 * 60 * 1000;

type TransportInternals = Transport & {
  _fetch: typeof fetch;
  _requestInit?: { headers?: Record<string, string> };
};

/**
 * Authorization server that rotates refresh tokens: each refresh token works
 * once, and replaying a consumed one is an invalid_grant, like the real thing.
 */
function stubAuthorizationServer(expiresIn = 3600) {
  let generation = 0;
  let validRefreshToken = 'refresh-0';
  const refreshBodies: URLSearchParams[] = [];
  const handler = vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== TOKEN_URL) {
      throw new Error(`unexpected global fetch to ${url}`);
    }
    const body = new URLSearchParams(String(init?.body));
    refreshBodies.push(body);
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (body.get('refresh_token') !== validRefreshToken) {
      return new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'used' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }
    generation += 1;
    validRefreshToken = `refresh-${generation}`;
    return new Response(
      JSON.stringify({
        access_token: `access-${generation}`,
        token_type: 'Bearer',
        expires_in: expiresIn,
        refresh_token: validRefreshToken,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', handler);
  return { handler, refreshBodies };
}

/** Stand-in for the MCP transport's network layer; records the bearer sent. */
function stubMcpNetwork() {
  const sent: Array<{ authorization: string | null; headers: Headers }> = [];
  const mcpFetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push({ authorization: headers.get('authorization'), headers });
    return new Response(null, { status: 202 });
  });
  _setMcpFetchForTest(mcpFetch as unknown as typeof fetch);
  return sent;
}

function seedCredentials(clientId = 'client-id', lifetimeMs = HOUR_MS) {
  storage.creds = {
    serverName: SERVER,
    token: {
      accessToken: 'access-0',
      tokenType: 'Bearer',
      refreshToken: 'refresh-0',
      expiresAt: Date.now() + lifetimeMs,
    },
    clientId,
    tokenUrl: TOKEN_URL,
    updatedAt: Date.now(),
  };
}

async function transportFor(config: MCPServerConfig) {
  const transport = (await createTransport(
    SERVER,
    config,
    false,
  )) as unknown as TransportInternals;
  if (config.httpUrl) {
    await transport.start();
  }
  return transport;
}

// Streamable HTTP: a real SDK POST, so the headers are assembled as in prod.
const send = (transport: TransportInternals) =>
  transport.send({
    jsonrpc: '2.0',
    method: 'notifications/roots/list_changed',
  });

// SSE: call the transport's fetch directly (its stream needs a live server).
const sendRaw = (transport: TransportInternals, headers?: HeadersInit) =>
  transport._fetch('https://mcp.example/sse', { method: 'POST', headers });

describe('createTransport OAuth bearer token per request', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    storage.getCredentials.mockImplementation(async () => storage.creds);
    storage.saveToken.mockImplementation(
      async (
        serverName: string,
        token: OAuthCredentials['token'],
        clientId: string,
        tokenUrl: string,
      ) => {
        storage.creds = {
          serverName,
          token,
          clientId,
          tokenUrl,
          updatedAt: Date.now(),
        };
      },
    );
    seedCredentials();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    _setMcpFetchForTest(undefined);
    storage.creds = null;
    vi.clearAllMocks();
  });

  it('sends the refreshed token once a stored token passes its expiry buffer', async () => {
    const { handler } = stubAuthorizationServer();
    const sent = stubMcpNetwork();
    const transport = await transportFor({
      httpUrl: 'https://mcp.example/mcp',
    });

    // The connect-time token seeds the cache: no storage read for request 1.
    const readsBefore = storage.getCredentials.mock.calls.length;
    await send(transport);
    expect(sent.at(-1)?.authorization).toBe('Bearer access-0');

    // Still outside the 5 minute buffer: no refresh, no storage read.
    vi.setSystemTime(Date.now() + 30 * 60 * 1000);
    await send(transport);
    await send(transport);
    expect(sent.at(-1)?.authorization).toBe('Bearer access-0');
    expect(storage.getCredentials).toHaveBeenCalledTimes(readsBefore);
    expect(handler).not.toHaveBeenCalled();

    // Inside the buffer: the next request carries the rotated token.
    vi.setSystemTime(Date.now() + 26 * 60 * 1000);
    await send(transport);
    expect(sent.at(-1)?.authorization).toBe('Bearer access-1');
    expect(handler).toHaveBeenCalledOnce();

    // The new token is cached too.
    const readsAfterRefresh = storage.getCredentials.mock.calls.length;
    await send(transport);
    expect(sent.at(-1)?.authorization).toBe('Bearer access-1');
    expect(storage.getCredentials).toHaveBeenCalledTimes(readsAfterRefresh);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('refreshes once when concurrent requests cross the expiry buffer', async () => {
    const { handler } = stubAuthorizationServer();
    const sent = stubMcpNetwork();
    const transport = await transportFor({
      httpUrl: 'https://mcp.example/mcp',
    });
    await send(transport);

    vi.setSystemTime(Date.now() + 56 * 60 * 1000);
    await Promise.all(Array.from({ length: 5 }, () => send(transport)));

    expect(handler).toHaveBeenCalledOnce();
    expect(sent.slice(-5).map((r) => r.authorization)).toEqual(
      Array(5).fill('Bearer access-1'),
    );
    expect(storage.deleteCredentials).not.toHaveBeenCalled();
  });

  it('refreshes once across transports of the same server', async () => {
    const { handler } = stubAuthorizationServer();
    const sent = stubMcpNetwork();
    const config = { httpUrl: 'https://mcp.example/mcp' };
    const first = await transportFor(config);
    const second = await transportFor(config);

    vi.setSystemTime(Date.now() + 56 * 60 * 1000);
    await Promise.all([send(first), send(second), send(first), send(second)]);

    expect(handler).toHaveBeenCalledOnce();
    expect(sent.map((r) => r.authorization)).toEqual(
      Array(4).fill('Bearer access-1'),
    );
    expect(storage.deleteCredentials).not.toHaveBeenCalled();
  });

  it('uses the explicit oauth config for refreshes and keeps custom headers', async () => {
    const { refreshBodies } = stubAuthorizationServer();
    const sent = stubMcpNetwork();
    const transport = await transportFor({
      httpUrl: 'https://mcp.example/mcp',
      headers: { 'X-Tenant': 'acme' },
      oauth: { enabled: true, clientId: 'client-id', scopes: ['read'] },
    });

    expect(transport._requestInit?.headers).toMatchObject({
      'X-Tenant': 'acme',
      Authorization: 'Bearer access-0',
    });

    vi.setSystemTime(Date.now() + 56 * 60 * 1000);
    await send(transport);

    expect(refreshBodies[0].get('scope')).toBe('read');
    const last = sent.at(-1)!;
    expect(last.authorization).toBe('Bearer access-1');
    expect(last.headers.get('x-tenant')).toBe('acme');
  });

  it('refreshes stored credentials with only the stored client id', async () => {
    const { refreshBodies } = stubAuthorizationServer();
    stubMcpNetwork();
    const transport = await transportFor({
      httpUrl: 'https://mcp.example/mcp',
    });

    vi.setSystemTime(Date.now() + 56 * 60 * 1000);
    await send(transport);

    expect(refreshBodies[0].get('client_id')).toBe('client-id');
    expect(refreshBodies[0].has('scope')).toBe(false);
  });

  it('leaves the request untouched when no token can be obtained', async () => {
    stubAuthorizationServer();
    const sent = stubMcpNetwork();
    const transport = await transportFor({
      httpUrl: 'https://mcp.example/mcp',
    });

    storage.creds = null;
    vi.setSystemTime(Date.now() + 2 * HOUR_MS);
    await send(transport);

    // The connect-time header stays; the wrapper does not override it.
    expect(sent.at(-1)?.authorization).toBe('Bearer access-0');
  });

  it('sends the refreshed token on SSE transports too', async () => {
    const { handler } = stubAuthorizationServer();
    const transport = await transportFor({ url: 'https://mcp.example/sse' });
    const sent: Array<string | null> = [];
    const authServer = handler.getMockImplementation()!;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === TOKEN_URL) {
          return authServer(url, init);
        }
        sent.push(new Headers(init?.headers).get('authorization'));
        return new Response(null, { status: 202 });
      }),
    );

    await sendRaw(transport);
    vi.setSystemTime(Date.now() + 56 * 60 * 1000);
    await Promise.all([sendRaw(transport), sendRaw(transport)]);

    expect(sent).toEqual([
      'Bearer access-0',
      'Bearer access-1',
      'Bearer access-1',
    ]);
    expect(storage.deleteCredentials).not.toHaveBeenCalled();
  });
  it('does not refresh on every request when the token lives under the buffer', async () => {
    const { handler } = stubAuthorizationServer(300);
    const sent = stubMcpNetwork();
    seedCredentials('client-id', 300 * 1000);
    // Connecting refreshes once: a 300s token is inside the 5 minute buffer.
    const transport = await transportFor({
      httpUrl: 'https://mcp.example/mcp',
    });
    expect(handler).toHaveBeenCalledOnce();

    for (let i = 0; i < 5; i++) {
      await send(transport);
    }
    vi.setSystemTime(Date.now() + 100 * 1000);
    await send(transport);
    expect(handler).toHaveBeenCalledOnce();
    expect(sent.at(-1)?.authorization).toBe('Bearer access-1');

    // Past half of the lifetime the next request refreshes, once.
    vi.setSystemTime(Date.now() + 60 * 1000);
    await Promise.all([send(transport), send(transport)]);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(sent.at(-1)?.authorization).toBe('Bearer access-2');
    expect(storage.deleteCredentials).not.toHaveBeenCalled();
  });

  it('refreshes a dynamically registered client that has no clientId in config', async () => {
    const { refreshBodies } = stubAuthorizationServer();
    const sent = stubMcpNetwork();
    seedCredentials('registered-id');
    const transport = await transportFor({
      httpUrl: 'https://mcp.example/mcp',
      oauth: { enabled: true },
    });

    vi.setSystemTime(Date.now() + 56 * 60 * 1000);
    await send(transport);

    expect(refreshBodies[0].get('client_id')).toBe('registered-id');
    expect(sent.at(-1)?.authorization).toBe('Bearer access-1');
    expect(storage.deleteCredentials).not.toHaveBeenCalled();
  });

  it('refreshes stored credentials with the configured client secret', async () => {
    const { handler, refreshBodies } = stubAuthorizationServer();
    const sent = stubMcpNetwork();
    const config = {
      httpUrl: 'https://mcp.example/mcp',
      oauth: { enabled: false, clientSecret: 'secret', scopes: ['read'] },
    };
    const first = await transportFor(config);
    const second = await transportFor(config);

    vi.setSystemTime(Date.now() + 56 * 60 * 1000);
    await Promise.all([send(first), send(second)]);

    // Whichever caller starts the shared refresh presents the full config.
    expect(handler).toHaveBeenCalledOnce();
    expect(refreshBodies[0].get('client_id')).toBe('client-id');
    expect(refreshBodies[0].get('client_secret')).toBe('secret');
    expect(refreshBodies[0].get('scope')).toBe('read');
    expect(sent.map((r) => r.authorization)).toEqual(
      Array(2).fill('Bearer access-1'),
    );
  });

  it('keeps the cached token while a due refresh fails to read storage', async () => {
    stubAuthorizationServer();
    const transport = await transportFor({ url: 'https://mcp.example/sse' });
    const sent: Array<string | null> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        sent.push(new Headers(init?.headers).get('authorization'));
        return new Response(null, { status: 202 });
      }),
    );
    storage.getCredentials.mockRejectedValue(new Error('keychain locked'));

    // Due (inside the buffer) but not yet expired: the cached token is fine.
    vi.setSystemTime(Date.now() + 56 * 60 * 1000);
    await sendRaw(transport);
    // Expired: nothing usable is left, so the request goes out unchanged.
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
    await sendRaw(transport);

    expect(sent).toEqual(['Bearer access-0', null]);
  });

  it('keeps the headers of a Request passed as the fetch input', async () => {
    stubAuthorizationServer();
    const transport = await transportFor({ url: 'https://mcp.example/sse' });
    const seen: Headers[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        seen.push(new Headers(init?.headers));
        return new Response(null, { status: 202 });
      }),
    );

    await transport._fetch(
      new Request('https://mcp.example/sse', { headers: { 'X-Req': '1' } }),
    );

    expect(seen[0].get('x-req')).toBe('1');
    expect(seen[0].get('authorization')).toBe('Bearer access-0');
  });
});
