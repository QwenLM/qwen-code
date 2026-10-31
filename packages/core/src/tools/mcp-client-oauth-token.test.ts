/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transport } from '@modelcontextprotocol/client';
import type { MCPServerConfig } from '../config/config.js';
import type { OAuthCredentials } from '../mcp/token-storage/types.js';
import { clearInflightTokenReadsForTest } from '../mcp/oauth-provider.js';
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

/** Whether `promise` has settled yet, readable without awaiting it. */
function track(promise: Promise<unknown>) {
  const state = { done: false };
  const markDone = () => {
    state.done = true;
  };
  promise.then(markDone, markDone);
  return state;
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
    clearInflightTokenReadsForTest();
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
    vi.restoreAllMocks();
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

    // Only the fetch wrapper writes the OAuth header.
    expect(transport._requestInit?.headers).toEqual({ 'X-Tenant': 'acme' });

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

  it('sends no stale bearer once no token can be obtained', async () => {
    stubAuthorizationServer();
    const sent = stubMcpNetwork();
    const transport = await transportFor({
      httpUrl: 'https://mcp.example/mcp',
      headers: { 'X-Tenant': 'acme' },
    });

    storage.creds = null;
    vi.setSystemTime(Date.now() + 2 * HOUR_MS);
    await send(transport);

    const last = sent.at(-1)!;
    expect(last.authorization).toBeNull();
    expect(last.headers.get('x-tenant')).toBe('acme');
  });

  it('keeps a due token that cannot be refreshed until it actually expires', async () => {
    const { handler } = stubAuthorizationServer();
    const sent = stubMcpNetwork();
    seedCredentials();
    storage.creds!.token.refreshToken = undefined;
    const transport = await transportFor({
      httpUrl: 'https://mcp.example/mcp',
    });

    // Inside the buffer with nothing to refresh with: still accepted.
    vi.setSystemTime(Date.now() + 56 * 60 * 1000);
    await send(transport);
    expect(sent.at(-1)?.authorization).toBe('Bearer access-0');

    // Past expiry nothing usable is left.
    vi.setSystemTime(Date.now() + 5 * 60 * 1000);
    await send(transport);
    expect(sent.at(-1)?.authorization).toBeNull();
    expect(handler).not.toHaveBeenCalled();
    expect(storage.deleteCredentials).not.toHaveBeenCalled();
  });

  it('sends no stale bearer on SSE once no token can be obtained', async () => {
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

    storage.creds = null;
    vi.setSystemTime(Date.now() + 2 * HOUR_MS);
    await sendRaw(transport);

    // Neither the connect-time headers nor the fetch wrapper carry it.
    expect(transport._requestInit?.headers).toBeUndefined();
    expect(sent).toEqual([null]);
  });

  it('keeps a user-configured Authorization header apart from the OAuth one', async () => {
    stubAuthorizationServer();
    const sent = stubMcpNetwork();
    const transport = await transportFor({
      httpUrl: 'https://mcp.example/mcp',
      headers: { Authorization: 'Basic user-configured' },
    });

    // A usable OAuth token takes precedence.
    await send(transport);
    expect(sent.at(-1)?.authorization).toBe('Bearer access-0');

    // With none left, the configured header goes out, not the stale token.
    storage.creds = null;
    vi.setSystemTime(Date.now() + 2 * HOUR_MS);
    await send(transport);
    expect(sent.at(-1)?.authorization).toBe('Basic user-configured');
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
    expect(storage.deleteCredentials).not.toHaveBeenCalled();
  });

  it('does not ask again for a due token while a refresh attempt is backing off', async () => {
    stubAuthorizationServer();
    const sent = stubMcpNetwork();
    seedCredentials();
    storage.creds!.token.refreshToken = undefined;
    const transport = await transportFor({
      httpUrl: 'https://mcp.example/mcp',
    });

    vi.setSystemTime(Date.now() + 56 * 60 * 1000);
    await send(transport);
    const reads = storage.getCredentials.mock.calls.length;
    await send(transport);
    await send(transport);
    expect(storage.getCredentials).toHaveBeenCalledTimes(reads);
    expect(sent.at(-1)?.authorization).toBe('Bearer access-0');

    // The back-off is short: once it is over the next request asks again.
    vi.setSystemTime(Date.now() + 60 * 1000);
    await send(transport);
    expect(storage.getCredentials).toHaveBeenCalledTimes(reads + 1);
    expect(sent.at(-1)?.authorization).toBe('Bearer access-0');

    // It never carries the token past its real expiry (3 minutes from now).
    vi.setSystemTime(Date.now() + 2 * 60 * 1000 + 50 * 1000);
    await send(transport);
    expect(sent.at(-1)?.authorization).toBe('Bearer access-0');
    vi.setSystemTime(Date.now() + 15 * 1000);
    await send(transport);
    expect(sent.at(-1)?.authorization).toBeNull();
  });

  it('uses the cached token while a due refresh hangs, then refreshes on the next attempt', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    // AbortSignal.timeout runs on an internal timer these fake timers don't
    // drive: hand out signals the test aborts itself.
    const timeouts: AbortController[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController();
      timeouts.push(controller);
      return controller.signal;
    });
    const authServer =
      stubAuthorizationServer().handler.getMockImplementation()!;
    let hung = true;
    const tokenRequest = vi.fn((url: string, init?: RequestInit) =>
      hung
        ? new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener('abort', () =>
              reject(init.signal!.reason),
            ),
          )
        : authServer(url, init),
    );
    vi.stubGlobal('fetch', tokenRequest);
    const sent = stubMcpNetwork();
    const transport = await transportFor({
      httpUrl: 'https://mcp.example/mcp',
    });

    // Due, but the token endpoint doesn't answer: the request goes out with
    // the cached token after the wait bound, which is not past its expiry.
    vi.setSystemTime(Date.now() + 56 * 60 * 1000);
    const dueRequest = send(transport);
    const due = track(dueRequest);
    await vi.advanceTimersByTimeAsync(5000);
    expect(due.done).toBe(true);
    await dueRequest;
    expect(sent.at(-1)?.authorization).toBe('Bearer access-0');
    expect(tokenRequest).toHaveBeenCalledOnce();
    // The refresh request itself is bounded.
    expect(timeouts).toHaveLength(1);

    // Backing off: neither storage nor the token endpoint is asked again.
    const reads = storage.getCredentials.mock.calls.length;
    const backingOff = send(transport);
    const backOff = track(backingOff);
    await vi.advanceTimersByTimeAsync(0);
    expect(backOff.done).toBe(true);
    await backingOff;
    expect(storage.getCredentials).toHaveBeenCalledTimes(reads);
    expect(tokenRequest).toHaveBeenCalledOnce();

    // The hung request times out; that says nothing about the credentials.
    timeouts[0].abort(new DOMException('timed out', 'TimeoutError'));
    await vi.advanceTimersByTimeAsync(0);
    expect(storage.deleteCredentials).not.toHaveBeenCalled();

    // The next attempt starts a new request and, the endpoint being back,
    // the rotated token is sent.
    hung = false;
    vi.setSystemTime(Date.now() + 31 * 1000);
    const retry = send(transport);
    await vi.advanceTimersByTimeAsync(20);
    await retry;
    expect(tokenRequest).toHaveBeenCalledTimes(2);
    expect(sent.at(-1)?.authorization).toBe('Bearer access-1');
    expect(storage.deleteCredentials).not.toHaveBeenCalled();
  });

  it('never asks again for a token without an expiry', async () => {
    const { handler } = stubAuthorizationServer();
    const sent = stubMcpNetwork();
    storage.creds!.token.expiresAt = undefined;
    const transport = await transportFor({
      httpUrl: 'https://mcp.example/mcp',
    });

    const reads = storage.getCredentials.mock.calls.length;
    vi.setSystemTime(Date.now() + 1000 * HOUR_MS);
    await send(transport);
    await send(transport);

    expect(sent.map((r) => r.authorization)).toEqual(
      Array(2).fill('Bearer access-0'),
    );
    expect(storage.getCredentials).toHaveBeenCalledTimes(reads);
    expect(handler).not.toHaveBeenCalled();
  });

  it('sends the current token on the SSE stream-open request, also after a reconnect', async () => {
    const { handler } = stubAuthorizationServer();
    const authServer = handler.getMockImplementation()!;
    const transport = await transportFor({ url: 'https://mcp.example/sse' });
    const streamOpens: Array<string | null> = [];
    const streams: Array<ReadableStreamDefaultController<Uint8Array>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === TOKEN_URL) {
          return authServer(url, init);
        }
        streamOpens.push(new Headers(init?.headers).get('authorization'));
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streams.push(controller);
            controller.enqueue(
              new TextEncoder().encode(
                'retry: 10\n\nevent: endpoint\ndata: /messages\n\n',
              ),
            );
          },
        });
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }),
    );

    try {
      await transport.start();
      expect(streamOpens).toEqual(['Bearer access-0']);

      // The stream drops after the token went past its buffer.
      vi.setSystemTime(Date.now() + 56 * 60 * 1000);
      streams[0].close();
      await vi.waitFor(() => expect(streamOpens).toHaveLength(2), {
        timeout: 3000,
      });
      expect(streamOpens[1]).toBe('Bearer access-1');
    } finally {
      await transport.close();
    }
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
