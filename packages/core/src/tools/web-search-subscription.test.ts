/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { QWEN_SUBSCRIPTION_WEB_SEARCH_URL } from '../qwen/oauth-config.js';
import { SubscriptionWebSearchBackend } from './web-search-subscription.js';
import { SubscriptionOAuthError } from '../qwen/subscription-oauth-client.js';

const { fetchMock, getAccessToken, dispatcher } = vi.hoisted(() => ({
  fetchMock: vi.fn<typeof fetch>(),
  getAccessToken: vi.fn(),
  dispatcher: {},
}));

vi.mock('../qwen/subscription-session.js', () => ({
  QwenSubscriptionSession: class {
    getAccessToken = getAccessToken;
  },
}));
vi.mock('../utils/runtimeFetchOptions.js', () => ({
  buildRuntimeFetchOptions: () => ({
    fetch: fetchMock,
    fetchOptions: { dispatcher },
  }),
}));

const query = 'Qwen Code official repository';
const text =
  '1. Qwen Code\n   https://github.com/QwenLM/qwen-code\n   Official repository.\n\n' +
  '2. Duplicate\n   https://github.com/QwenLM/qwen-code\n\nhttps://%invalid';
const config = {
  getCliVersion: () => 'test',
  getProxy: () => undefined,
} as Config;

interface RpcRequest {
  id?: number;
  method: string;
  params?: { protocolVersion?: string; name?: string; arguments?: unknown };
}

const requests: Array<{ rpc: RpcRequest; init: RequestInit }> = [];
let tools: Array<{ name: string; inputSchema: { type: 'object' } }>;
let result: {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function rpcResponse(rpc: RpcRequest): Response {
  if (rpc.method === 'notifications/initialized') {
    return new Response(null, { status: 204 });
  }
  return Response.json({
    jsonrpc: '2.0',
    id: rpc.id,
    result:
      rpc.method === 'initialize'
        ? {
            protocolVersion: rpc.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'search-fixture', version: '1' },
          }
        : rpc.method === 'tools/list'
          ? { tools }
          : result,
  });
}

beforeEach(() => {
  requests.length = 0;
  tools = [{ name: 'web_search', inputSchema: { type: 'object' } }];
  result = { content: [{ type: 'text', text }] };
  getAccessToken.mockReset().mockResolvedValue('private-test-token');
  fetchMock.mockReset().mockImplementation(async (input, init = {}) => {
    expect(String(input)).toBe(QWEN_SUBSCRIPTION_WEB_SEARCH_URL);
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init).toHaveProperty('dispatcher', dispatcher);
    const rpc = JSON.parse(String(init.body)) as RpcRequest;
    requests.push({ rpc, init });
    return rpcResponse(rpc);
  });
});

afterEach(() => vi.restoreAllMocks());

const search = (signal = new AbortController().signal, timeout = 5000) =>
  new SubscriptionWebSearchBackend(config, timeout).search({ query, signal });

describe('subscription MCP search', () => {
  it('uses the actual SDK handshake and tool schema, preserving text and returned sources', async () => {
    expect(await search()).toEqual({
      ok: true,
      outcome: {
        answerText: text,
        sources: [
          { url: 'https://github.com/QwenLM/qwen-code', opened: false },
        ],
        executedQueries: [query],
        searchCount: 1,
      },
    });
    expect(requests.map(({ rpc }) => rpc.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/call',
    ]);
    expect(requests.at(-1)?.rpc.params).toMatchObject({
      name: 'web_search',
      arguments: { query },
    });
  });

  it('obtains a current token separately for every HTTP request', async () => {
    getAccessToken.mockImplementation(
      async () => `token-${getAccessToken.mock.calls.length}`,
    );
    expect((await search()).ok).toBe(true);
    expect(getAccessToken).toHaveBeenCalledTimes(requests.length);
    requests.forEach(({ init }, index) => {
      expect(new Headers(init.headers).get('authorization')).toBe(
        `Bearer token-${index + 1}`,
      );
    });
  });

  it('refreshes and replays the same request once after 401', async () => {
    let token = 'original';
    getAccessToken.mockImplementation(async (_signal, rejected?: string) => {
      if (rejected) token = 'rotated';
      return token;
    });
    fetchMock.mockImplementationOnce(async (_input, init = {}) => {
      requests.push({ rpc: JSON.parse(String(init.body)) as RpcRequest, init });
      return new Response('unauthorized', { status: 401 });
    });
    expect((await search()).ok).toBe(true);
    expect(requests[0].init.body).toBe(requests[1].init.body);
    expect(new Headers(requests[0].init.headers).get('authorization')).toBe(
      'Bearer original',
    );
    expect(new Headers(requests[1].init.headers).get('authorization')).toBe(
      'Bearer rotated',
    );
    expect(
      getAccessToken.mock.calls.filter((call) => call[1] !== undefined),
    ).toEqual([[expect.any(AbortSignal), 'original']]);
  });

  it.each([401, 403, 500, 307])(
    'fails safely without an unbounded retry for HTTP %s',
    async (status) => {
      fetchMock.mockResolvedValue(
        new Response('private-test-token', {
          status,
          headers: { location: 'https://outside.invalid/search' },
        }),
      );
      const response = await search();
      expect(response.ok).toBe(false);
      expect(JSON.stringify(response)).not.toContain('private-test-token');
      expect(fetchMock).toHaveBeenCalledTimes(status === 401 ? 2 : 1);
      for (const [input, init] of fetchMock.mock.calls) {
        expect(String(input)).toBe(QWEN_SUBSCRIPTION_WEB_SEARCH_URL);
        expect(init?.redirect).toBe('error');
      }
    },
  );

  it('does not send requests when credentials have been cleared', async () => {
    getAccessToken.mockRejectedValue(new Error('private-test-token'));
    const response = await search();
    expect(response.ok).toBe(false);
    expect(JSON.stringify(response)).not.toContain('private-test-token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not call an absent remote tool', async () => {
    tools = [];
    expect((await search()).ok).toBe(false);
    expect(requests.some(({ rpc }) => rpc.method === 'tools/call')).toBe(false);
  });

  it('preserves the backend permission error without suggesting reauthorization', async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        {
          error: 'access_denied',
          error_description: 'Web search is not available for this account.',
        },
        { status: 403 },
      ),
    );
    expect(await search()).toMatchObject({
      ok: false,
      message: 'Web search is not available for this account.',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ['invalid_grant', 400, undefined, 'session has expired'],
    [
      'rate_limited',
      429,
      'Wait before refreshing your session.',
      'Wait before refreshing your session.',
    ],
    ['network_error', undefined, undefined, 'network request failed'],
  ] as const)(
    'preserves a %s credential failure through the MCP transport',
    async (code, status, message, expected) => {
      getAccessToken.mockRejectedValue(
        new SubscriptionOAuthError(code, status, message, undefined, 'refresh'),
      );
      const response = await search();
      expect(response).toMatchObject({ ok: false });
      if (response.ok) throw new Error('Expected search failure');
      expect(response.message).toContain(expected);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('does not replay a rate-limited search or suggest signing in again', async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        {
          error: 'slow_down',
          error_description: 'Search quota exceeded. Retry later.',
        },
        { status: 429, headers: { 'Retry-After': '30' } },
      ),
    );
    expect(await search()).toMatchObject({
      ok: false,
      message: 'Search quota exceeded. Retry later.',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    'rejects tool errors and empty text (isError=%s)',
    async (isError) => {
      result = {
        isError,
        content: isError ? [{ type: 'text', text: 'private-test-token' }] : [],
      };
      const response = await search();
      expect(response.ok).toBe(false);
      expect(JSON.stringify(response)).not.toContain('private-test-token');
    },
  );

  it('rejects overlong queries before requesting credentials', async () => {
    const response = await new SubscriptionWebSearchBackend(
      config,
      5000,
    ).search({
      query: 'a'.repeat(501),
      signal: new AbortController().signal,
    });
    expect(response.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('cancels an in-flight HTTP request', async () => {
    fetchMock.mockImplementation(
      async (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const controller = new AbortController();
    const pending = search(controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();
    expect(await pending).toMatchObject({
      ok: false,
      message: 'Web search was cancelled.',
    });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('bounds the entire search with a deadline', async () => {
    fetchMock.mockImplementation(
      async (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const response = await search(undefined, 40);
    expect(response.ok).toBe(false);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});
