/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { SubscriptionWebSearchBackend } from './web-search-subscription.js';

const { fetchMock, log } = vi.hoisted(() => ({
  fetchMock: vi.fn<typeof fetch>(),
  log: vi.fn(),
}));

vi.mock('../qwen/subscription-session.js', () => ({
  QwenSubscriptionSession: class {
    getAccessToken = async () => 'synthetic-access';
  },
}));

vi.mock('../utils/runtimeFetchOptions.js', () => ({
  buildRuntimeFetchOptions: () => ({ fetch: fetchMock }),
}));

vi.mock('../utils/debugLogger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/debugLogger.js')>()),
  createDebugLogger: () => ({
    isEnabled: () => true,
    debug: log,
    info: log,
    warn: log,
    error: log,
  }),
}));

const config = {
  getCliVersion: () => 'test',
  getProxy: () => undefined,
} as Config;

const cases = [
  [
    402,
    'PROXY_ENTITLEMENT_INSUFFICIENT_CREDITS',
    'insufficient credits: top up and retry',
  ],
  [403, 'PROXY_MEMBER_REQUIRED', 'membership required: upgrade to plus or pro'],
  [429, 'PROXY_RATE_LIMITED', 'concurrent request limit exceeded'],
  [
    503,
    'PROXY_UPSTREAM_UNAVAILABLE',
    'service temporarily unavailable, please retry',
  ],
] as const;

beforeEach(() => {
  fetchMock.mockReset();
  log.mockClear();
});

it.each(cases)(
  'exposes the gateway message for HTTP %s without retrying',
  async (status, code, message) => {
    fetchMock.mockImplementation(async () =>
      Response.json(
        {
          error: {
            code,
            message,
            request_id: 'body-request-repro',
            retryable: status >= 429,
          },
        },
        {
          status,
          headers: {
            'x-request-id': 'caller-request-repro',
            'x-gateway-request-id': 'gateway-request-repro',
          },
        },
      ),
    );
    const result = await new SubscriptionWebSearchBackend(config, 5000).search({
      query: 'reproduction',
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(false);
    expect.soft(result).toMatchObject({
      message: expect.stringContaining(message),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const diagnostics = JSON.stringify([result, log.mock.calls]);
    expect.soft(diagnostics).toContain('gateway-request-repro');
    expect.soft(diagnostics).toContain('body-request-repro');
    expect.soft(diagnostics).toContain(code);
  },
);
