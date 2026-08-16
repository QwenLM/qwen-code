import { describe, it, expect, vi } from 'vitest';
import {
  wrapFetchWithCopilotAuth,
  COPILOT_SENTINEL_BASE_URL,
} from './copilot-fetch.js';
import type { CopilotTokenManager } from './copilot-auth.js';

function makeMockMgr(
  bearer: string,
  endpointsApi: string,
): CopilotTokenManager {
  return {
    getSnapshot: async () => ({
      bearer,
      endpointsApi,
      expiresAtMs: Date.now() + 3600_000,
    }),
    forceRefresh: vi.fn(async () => {}),
    getAvailableModelIds: async () => null,
  };
}

function makeCaptureFetch(): {
  fetch: typeof fetch;
  lastUrl: () => string;
  lastHeaders: () => Record<string, string>;
  lastBody: () => string;
  setResponse: (status: number, body: string) => void;
} {
  let capturedUrl = '';
  let capturedHeaders: Record<string, string> = {};
  let capturedBody = '';
  let resStatus = 200;
  let resBody = '{}';
  const mockFetch = (async (url: URL | string, init?: RequestInit) => {
    capturedUrl = typeof url === 'string' ? url : url.toString();
    capturedHeaders = (init?.headers as Record<string, string>) ?? {};
    capturedBody = init?.body ? String(init.body) : '';
    return new Response(resBody, { status: resStatus });
  }) as typeof fetch;
  return {
    fetch: mockFetch,
    lastUrl: () => capturedUrl,
    lastHeaders: () => capturedHeaders,
    lastBody: () => capturedBody,
    setResponse: (s, b) => {
      resStatus = s;
      resBody = b;
    },
  };
}

describe('wrapFetchWithCopilotAuth', () => {
  it('rewrites sentinel host to endpointsApi', async () => {
    const mgr = makeMockMgr(
      'tid=BEARER1',
      'https://api.individual.githubcopilot.com',
    );
    const cap = makeCaptureFetch();
    const wrapped = wrapFetchWithCopilotAuth(mgr, { fetchImpl: cap.fetch });
    await wrapped(`${COPILOT_SENTINEL_BASE_URL}/v1/messages`, {
      method: 'POST',
      body: '{}',
    });
    expect(cap.lastUrl()).toBe(
      'https://api.individual.githubcopilot.com/v1/messages',
    );
    expect(cap.lastUrl()).not.toContain('copilot-endpoint-rewritten');
  });

  it('injects Authorization: Bearer', async () => {
    const mgr = makeMockMgr(
      'tid=BEARER2',
      'https://api.individual.githubcopilot.com',
    );
    const cap = makeCaptureFetch();
    const wrapped = wrapFetchWithCopilotAuth(mgr, { fetchImpl: cap.fetch });
    await wrapped(`${COPILOT_SENTINEL_BASE_URL}/v1/messages`, {
      method: 'POST',
      body: '{}',
    });
    expect(cap.lastHeaders()['Authorization']).toBe('Bearer tid=BEARER2');
  });

  it('injects copilot-integration-id and editor-version', async () => {
    const mgr = makeMockMgr(
      'tid=BEARER3',
      'https://api.individual.githubcopilot.com',
    );
    const cap = makeCaptureFetch();
    const wrapped = wrapFetchWithCopilotAuth(mgr, { fetchImpl: cap.fetch });
    await wrapped(`${COPILOT_SENTINEL_BASE_URL}/v1/messages`, {
      method: 'POST',
      body: '{}',
    });
    expect(cap.lastHeaders()['copilot-integration-id']).toBe('vscode-chat');
    expect(cap.lastHeaders()['editor-version']).toMatch(/^qwen-code\//);
    expect(cap.lastHeaders()['editor-plugin-version']).toMatch(
      /^copilot-chat\//,
    );
    expect(cap.lastHeaders()['user-agent']).toMatch(/^GitHubCopilotChat\//);
    expect(cap.lastHeaders()['x-initiator']).toBe('user');
  });

  it('adds anthropic-beta on /messages paths', async () => {
    const mgr = makeMockMgr(
      'tid=BEARER4',
      'https://api.individual.githubcopilot.com',
    );
    const cap = makeCaptureFetch();
    const wrapped = wrapFetchWithCopilotAuth(mgr, { fetchImpl: cap.fetch });
    await wrapped(`${COPILOT_SENTINEL_BASE_URL}/v1/messages`, {
      method: 'POST',
      body: '{}',
    });
    expect(cap.lastHeaders()['anthropic-beta']).toContain('prompt-caching');
  });

  it('does NOT add anthropic-beta on /chat/completions paths', async () => {
    const mgr = makeMockMgr(
      'tid=BEARER5',
      'https://api.individual.githubcopilot.com',
    );
    const cap = makeCaptureFetch();
    const wrapped = wrapFetchWithCopilotAuth(mgr, { fetchImpl: cap.fetch });
    await wrapped(`${COPILOT_SENTINEL_BASE_URL}/chat/completions`, {
      method: 'POST',
      body: '{}',
    });
    expect(cap.lastHeaders()['anthropic-beta']).toBeUndefined();
  });

  it('adds Copilot-Vision-Request when body has image', async () => {
    const mgr = makeMockMgr(
      'tid=BEARER6',
      'https://api.individual.githubcopilot.com',
    );
    const cap = makeCaptureFetch();
    const wrapped = wrapFetchWithCopilotAuth(mgr, { fetchImpl: cap.fetch });
    await wrapped(`${COPILOT_SENTINEL_BASE_URL}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ content: [{ type: 'image_url', image_url: 'data:...' }] }],
      }),
    });
    expect(cap.lastHeaders()['Copilot-Vision-Request']).toBe('true');
  });

  it('401 → forceRefresh + retry once', async () => {
    const mgr = makeMockMgr(
      'tid=OLD',
      'https://api.individual.githubcopilot.com',
    );
    const cap = makeCaptureFetch();
    cap.setResponse(401, '{"error":"expired"}');
    const wrapped = wrapFetchWithCopilotAuth(mgr, { fetchImpl: cap.fetch });
    const res = await wrapped(`${COPILOT_SENTINEL_BASE_URL}/v1/messages`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(401); // still 401 after retry
    expect(mgr.forceRefresh).toHaveBeenCalledTimes(1);
  });

  it('429 → stderr breadcrumb, no retry', async () => {
    const mgr = makeMockMgr(
      'tid=RL',
      'https://api.individual.githubcopilot.com',
    );
    let fetchCalls = 0;
    const mockFetch = (async () => {
      fetchCalls++;
      return new Response('{"error":"rate_limited"}', {
        status: 429,
        headers: { 'retry-after': '60' },
      });
    }) as typeof fetch;
    const wrapped = wrapFetchWithCopilotAuth(mgr, { fetchImpl: mockFetch });
    const res = await wrapped(`${COPILOT_SENTINEL_BASE_URL}/v1/messages`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(429);
    expect(fetchCalls).toBe(1); // no retry
  });

  it('sentinel never appears on the wire', async () => {
    const mgr = makeMockMgr(
      'tid=SENT',
      'https://api.individual.githubcopilot.com',
    );
    const cap = makeCaptureFetch();
    const wrapped = wrapFetchWithCopilotAuth(mgr, { fetchImpl: cap.fetch });
    await wrapped(`${COPILOT_SENTINEL_BASE_URL}/responses`, {
      method: 'POST',
      body: '{}',
    });
    expect(cap.lastUrl()).not.toContain(
      'copilot-endpoint-rewritten-by-fetch.invalid',
    );
  });
});
