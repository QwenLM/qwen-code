import { describe, it, expect, vi } from 'vitest';
import {
  fetchCopilotModels,
  enableAllCopilotModels,
} from './copilot-models.js';
import { wrapFetchWithCopilotAuth } from './copilot-fetch.js';
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

describe('fetchCopilotModels', () => {
  it('parses {data: [...]} catalog', async () => {
    const mgr = makeMockMgr(
      'tid=CAT',
      'https://api.individual.githubcopilot.com',
    );
    const innerFetch = (async (url: URL | string) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/models')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'claude-opus-4.7',
                capabilities: { limits: { max_context_window_tokens: 200000 } },
              },
              {
                id: 'gpt-5.2',
                capabilities: { limits: { max_context_window_tokens: 400000 } },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const wrapped = wrapFetchWithCopilotAuth(mgr, { fetchImpl: innerFetch });
    const models = await fetchCopilotModels(mgr, { fetchImpl: wrapped });
    expect(models).not.toBeNull();
    expect(models!.length).toBe(2);
    expect(models![0].slug).toBe('claude-opus-4.7');
    expect(models![0].contextWindow).toBe(200000);
  });

  it('returns null on timeout/failure (degrade to static)', async () => {
    const mgr = makeMockMgr(
      'tid=FAIL',
      'https://api.individual.githubcopilot.com',
    );
    const failingFetch = (async () =>
      new Response('', { status: 500 })) as typeof fetch;
    const wrapped = wrapFetchWithCopilotAuth(mgr, { fetchImpl: failingFetch });
    const models = await fetchCopilotModels(mgr, { fetchImpl: wrapped });
    expect(models).toBeNull();
  });
});

describe('enableAllCopilotModels', () => {
  it('POSTs policy with openai-intent and x-interaction-type headers', async () => {
    const mgr = makeMockMgr(
      'tid=EN',
      'https://api.individual.githubcopilot.com',
    );
    const capturedHeaders: Array<Record<string, string>> = [];
    const innerFetch = (async (url: URL | string, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/models/') && u.endsWith('/policy')) {
        capturedHeaders.push((init?.headers as Record<string, string>) ?? {});
        return new Response('{"state":"enabled"}', { status: 200 });
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const wrapped = wrapFetchWithCopilotAuth(mgr, { fetchImpl: innerFetch });
    await enableAllCopilotModels(mgr, {
      fetchImpl: wrapped,
      modelIds: ['claude-opus-4.7', 'gpt-5.2'],
    });
    expect(capturedHeaders.length).toBe(2);
    expect(capturedHeaders[0]['openai-intent']).toBe('chat-policy');
    expect(capturedHeaders[0]['x-interaction-type']).toBe('chat-policy');
  });

  it('swallows enable errors (best-effort) but logs warning', async () => {
    const mgr = makeMockMgr(
      'tid=EN2',
      'https://api.individual.githubcopilot.com',
    );
    const innerFetch = (async (url: URL | string) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/models/') && u.endsWith('/policy')) {
        return new Response('{"error":"forbidden"}', { status: 403 });
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const wrapped = wrapFetchWithCopilotAuth(mgr, { fetchImpl: innerFetch });
    // should not throw
    await expect(
      enableAllCopilotModels(mgr, {
        fetchImpl: wrapped,
        modelIds: ['claude-opus-4.7'],
      }),
    ).resolves.toBeUndefined();
  });
});
