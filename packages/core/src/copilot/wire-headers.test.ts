import { describe, it, expect } from 'vitest';
import {
  wrapFetchWithCopilotAuth,
  COPILOT_SENTINEL_BASE_URL,
} from './copilot-fetch.js';
import type { CopilotTokenManager } from './copilot-auth.js';

const mgr: CopilotTokenManager = {
  getSnapshot: async () => ({
    bearer: 'tid=HDR',
    endpointsApi: 'https://api.individual.githubcopilot.com',
    expiresAtMs: Date.now() + 3600_000,
  }),
  forceRefresh: async () => {},
  getAvailableModelIds: async () => null,
};

describe('wire headers per path', () => {
  it('/v1/messages gets anthropic-beta', async () => {
    let h: Record<string, string> = {};
    const f = (async (_u: URL | string, init?: RequestInit) => {
      h = (init?.headers as Record<string, string>) ?? {};
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    await wrapFetchWithCopilotAuth(mgr, { fetchImpl: f })(
      `${COPILOT_SENTINEL_BASE_URL}/v1/messages`,
      { method: 'POST', body: '{}' },
    );
    expect(h['anthropic-beta']).toBeDefined();
  });

  it('/models gets X-GitHub-Api-Version', async () => {
    let h: Record<string, string> = {};
    const f = (async (_u: URL | string, init?: RequestInit) => {
      h = (init?.headers as Record<string, string>) ?? {};
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    await wrapFetchWithCopilotAuth(mgr, { fetchImpl: f })(
      `${COPILOT_SENTINEL_BASE_URL}/models`,
      { headers: {} },
    );
    expect(h['X-GitHub-Api-Version']).toBe('2026-06-01');
  });

  it('/v1/messages does NOT get X-GitHub-Api-Version', async () => {
    let h: Record<string, string> = {};
    const f = (async (_u: URL | string, init?: RequestInit) => {
      h = (init?.headers as Record<string, string>) ?? {};
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    await wrapFetchWithCopilotAuth(mgr, { fetchImpl: f })(
      `${COPILOT_SENTINEL_BASE_URL}/v1/messages`,
      { method: 'POST', body: '{}' },
    );
    expect(h['X-GitHub-Api-Version']).toBeUndefined();
  });

  it('caller Authorization is replaced, not duplicated', async () => {
    let h: Record<string, string> = {};
    const f = (async (_u: URL | string, init?: RequestInit) => {
      h = (init?.headers as Record<string, string>) ?? {};
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    await wrapFetchWithCopilotAuth(mgr, { fetchImpl: f })(
      `${COPILOT_SENTINEL_BASE_URL}/responses`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer caller-placeholder-token' },
        body: '{}',
      },
    );
    // Copilot bearer must REPLACE the caller's Authorization, not duplicate.
    // Headers.forEach normalizes to lowercase 'authorization'; setting
    // 'Authorization' (capital A) creates a separate Record key, so undici
    // appends both → CAPI receives the caller's invalid placeholder token.
    expect(h['Authorization']).toBe('Bearer tid=HDR');
    expect(h['authorization']).toBeUndefined();
  });
});
