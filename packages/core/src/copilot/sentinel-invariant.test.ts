import { describe, it, expect } from 'vitest';
import {
  wrapFetchWithCopilotAuth,
  COPILOT_SENTINEL_BASE_URL,
} from './copilot-fetch.js';
import type { CopilotTokenManager } from './copilot-auth.js';

const mgr: CopilotTokenManager = {
  getSnapshot: async () => ({
    bearer: 'tid=INV',
    endpointsApi: 'https://api.tenant.example.com',
    expiresAtMs: Date.now() + 3600_000,
  }),
  forceRefresh: async () => {},
  getAvailableModelIds: async () => null,
};

describe('sentinel invariant', () => {
  it('sentinel host never appears on the wire', async () => {
    let capturedUrl = '';
    const f = (async (url: URL | string) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const wrapped = wrapFetchWithCopilotAuth(mgr, { fetchImpl: f });
    await wrapped(`${COPILOT_SENTINEL_BASE_URL}/v1/messages`, {
      method: 'POST',
      body: '{}',
    });
    expect(capturedUrl).not.toContain(
      'copilot-endpoint-rewritten-by-fetch.invalid',
    );
  });

  it('rewritten URL contains the real endpointsApi host (positive assertion)', async () => {
    let capturedUrl = '';
    const f = (async (url: URL | string) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const wrapped = wrapFetchWithCopilotAuth(mgr, { fetchImpl: f });
    await wrapped(`${COPILOT_SENTINEL_BASE_URL}/responses`, {
      method: 'POST',
      body: '{}',
    });
    expect(capturedUrl).toContain('api.tenant.example.com');
  });
});
