/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  Config,
  OutboundSessionIdHeaderSettings,
} from '../config/config.js';
import {
  buildSessionAwareFetch,
  buildSessionIdHeaders,
  SESSION_ID_HEADER,
  wrapFetchWithSessionId,
} from './outbound-session-id.js';

function config(
  sessionId = 'session-1',
  sessionIdHeader?: OutboundSessionIdHeaderSettings,
): Config {
  return {
    getSessionId: vi.fn().mockReturnValue(sessionId),
    getOutboundSessionIdHeaderSettings: vi
      .fn()
      .mockReturnValue(sessionIdHeader),
  } as unknown as Config;
}

describe('outbound session ID', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    'routify.alibaba-inc.com',
    'routify-online.alibaba-inc.com',
    'routify-pub.alibaba-inc.com',
  ])('matches the documented Routify host %s', (host) => {
    expect(
      buildSessionIdHeaders(config(), `https://${host}/protocol/openai/v1`),
    ).toEqual({ [SESSION_ID_HEADER]: 'session-1' });
  });

  it('uses the current session ID for Routify requests', async () => {
    const cliConfig = config();
    const baseFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(),
    );
    const wrappedFetch = wrapFetchWithSessionId(baseFetch, cliConfig);

    await wrappedFetch(
      'https://routify-pub.alibaba-inc.com/protocol/openai/v1',
      {
        headers: {
          Authorization: 'Bearer token',
          session_id: 'custom-value',
        },
      },
    );
    vi.mocked(cliConfig.getSessionId).mockReturnValue('session-2');
    await wrappedFetch(
      'https://routify-pub.alibaba-inc.com/protocol/anthropic/v1',
    );

    const firstHeaders = new Headers(baseFetch.mock.calls[0][1]?.headers);
    const secondHeaders = new Headers(baseFetch.mock.calls[1][1]?.headers);
    expect(firstHeaders.get('authorization')).toBe('Bearer token');
    expect(firstHeaders.get(SESSION_ID_HEADER)).toBe('session-1');
    expect(secondHeaders.get(SESSION_ID_HEADER)).toBe('session-2');
  });

  it.each([
    'https://sub.routify-pub.alibaba-inc.com/protocol/openai/v1',
    'https://routify-preview.alibaba-inc.com/protocol/openai/v1',
    'https://api.openai.com/v1',
    'http://routify.alibaba-inc.com/protocol/openai/v1',
    'not a URL',
  ])('does not inject the header into %s', async (url) => {
    const baseFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(),
    );
    const wrappedFetch = wrapFetchWithSessionId(baseFetch, config());

    await wrappedFetch(url, {
      headers: { 'X-Existing': 'value' },
    });

    expect(baseFetch).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ headers: { 'X-Existing': 'value' } }),
    );
  });

  it('does not send an empty session ID', () => {
    expect(
      buildSessionIdHeaders(
        config(''),
        'https://routify.alibaba-inc.com/protocol/openai/v1',
      ),
    ).toEqual({});
  });

  it('preserves headers carried by a Request object', async () => {
    const baseFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(),
    );
    const wrappedFetch = wrapFetchWithSessionId(baseFetch, config());

    await wrappedFetch(
      new Request('https://routify-pub.alibaba-inc.com/protocol/openai/v1', {
        headers: { Authorization: 'Bearer token' },
      }),
    );

    const headers = new Headers(baseFetch.mock.calls[0][1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer token');
    expect(headers.get(SESSION_ID_HEADER)).toBe('session-1');
  });

  it('merges Request and init headers before adding the session ID', async () => {
    const baseFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(),
    );
    const wrappedFetch = wrapFetchWithSessionId(baseFetch, config());

    await wrappedFetch(
      new Request('https://routify-pub.alibaba-inc.com/protocol/openai/v1', {
        headers: {
          Authorization: 'Bearer token',
          'X-Shared': 'request',
        },
      }),
      { headers: { 'X-Extra': 'value', 'X-Shared': 'init' } },
    );

    const headers = new Headers(baseFetch.mock.calls[0][1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer token');
    expect(headers.get('x-extra')).toBe('value');
    expect(headers.get('x-shared')).toBe('init');
    expect(headers.get(SESSION_ID_HEADER)).toBe('session-1');
  });

  it('wraps a supplied runtime fetch with session ID injection', async () => {
    const runtimeFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(),
    );
    const sessionAwareFetch = buildSessionAwareFetch(runtimeFetch, config());

    await sessionAwareFetch(
      'https://routify-pub.alibaba-inc.com/protocol/openai/v1',
    );

    const headers = new Headers(runtimeFetch.mock.calls[0][1]?.headers);
    expect(headers.get(SESSION_ID_HEADER)).toBe('session-1');
  });

  it('falls back to globalThis.fetch when no runtime fetch exists', async () => {
    const fetchStub = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(),
    );
    vi.stubGlobal('fetch', fetchStub);
    const sessionAwareFetch = buildSessionAwareFetch(undefined, config());

    await sessionAwareFetch(
      'https://routify-pub.alibaba-inc.com/protocol/openai/v1',
    );

    const headers = new Headers(fetchStub.mock.calls[0][1]?.headers);
    expect(headers.get(SESSION_ID_HEADER)).toBe('session-1');
  });
});

describe('outbound session ID — user-configured header', () => {
  const OPENCODE = {
    enabled: true,
    headerName: 'x-opencode-session',
    trustedHosts: ['opencode.ai'],
  };

  it('sends the configured header to a trusted host', () => {
    expect(
      buildSessionIdHeaders(
        config('session-1', OPENCODE),
        'https://opencode.ai/zen/go/v1/chat/completions',
      ),
    ).toEqual({ 'x-opencode-session': 'session-1' });
  });

  it('sends nothing when the feature is off, whatever the hosts say', () => {
    expect(
      buildSessionIdHeaders(
        config('session-1', { ...OPENCODE, enabled: false }),
        'https://opencode.ai/zen/go/v1',
      ),
    ).toEqual({});
    expect(
      buildSessionIdHeaders(config(), 'https://opencode.ai/zen/go/v1'),
    ).toEqual({});
  });

  it.each([
    'https://api.openai.com/v1',
    'https://evil-opencode.ai/zen/go/v1',
    'https://opencode.ai.evil.example/v1',
    'http://opencode.ai/zen/go/v1',
  ])('does not send the configured header to %s', (url) => {
    expect(buildSessionIdHeaders(config('session-1', OPENCODE), url)).toEqual(
      {},
    );
  });

  it('sends nothing when enabled with an empty host list', () => {
    expect(
      buildSessionIdHeaders(
        config('session-1', { ...OPENCODE, trustedHosts: [] }),
        'https://opencode.ai/zen/go/v1',
      ),
    ).toEqual({});
    expect(
      buildSessionIdHeaders(
        config('session-1', { enabled: true, trustedHosts: undefined }),
        'https://opencode.ai/zen/go/v1',
      ),
    ).toEqual({});
  });

  it('defaults the header name to session_id and matches hosts case-insensitively', () => {
    expect(
      buildSessionIdHeaders(
        config('session-1', { enabled: true, trustedHosts: ['OpenCode.AI '] }),
        'https://opencode.ai/zen/go/v1',
      ),
    ).toEqual({ [SESSION_ID_HEADER]: 'session-1' });
  });

  it('skips an invalid header name but keeps the built-in branch', () => {
    for (const headerName of ['x opencode', 'x:y', 'x\r\nInjected: 1', '']) {
      expect(
        buildSessionIdHeaders(
          config('session-1', { ...OPENCODE, headerName }),
          'https://opencode.ai/zen/go/v1',
        ),
      ).toEqual({});
    }
    expect(
      buildSessionIdHeaders(
        config('session-1', { ...OPENCODE, headerName: 'x:y' }),
        'https://routify-pub.alibaba-inc.com/protocol/openai/v1',
      ),
    ).toEqual({ [SESSION_ID_HEADER]: 'session-1' });
  });

  it('emits both headers when a built-in host is also user-trusted under another name', () => {
    expect(
      buildSessionIdHeaders(
        config('session-1', {
          enabled: true,
          headerName: 'x-session',
          trustedHosts: ['routify-pub.alibaba-inc.com'],
        }),
        'https://routify-pub.alibaba-inc.com/protocol/openai/v1',
      ),
    ).toEqual({ [SESSION_ID_HEADER]: 'session-1', 'x-session': 'session-1' });
  });

  it('re-resolves the session ID per request across rotations', async () => {
    const cliConfig = config('session-1', OPENCODE);
    const baseFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(),
    );
    const wrappedFetch = wrapFetchWithSessionId(baseFetch, cliConfig);

    await wrappedFetch('https://opencode.ai/zen/go/v1/chat/completions');
    vi.mocked(cliConfig.getSessionId).mockReturnValue('session-2');
    await wrappedFetch('https://opencode.ai/zen/go/v1/chat/completions');

    const firstHeaders = new Headers(baseFetch.mock.calls[0][1]?.headers);
    const secondHeaders = new Headers(baseFetch.mock.calls[1][1]?.headers);
    expect(firstHeaders.get('x-opencode-session')).toBe('session-1');
    expect(secondHeaders.get('x-opencode-session')).toBe('session-2');
  });

  it('does not send an empty session ID through the configured header', () => {
    expect(
      buildSessionIdHeaders(config('', OPENCODE), 'https://opencode.ai/v1'),
    ).toEqual({});
  });
});
