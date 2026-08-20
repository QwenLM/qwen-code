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
  };
}

function makeCaptureFetch(): {
  fetch: typeof fetch;
  lastUrl: () => string;
  lastHeaders: () => Record<string, string>;
  lastRequest: () => Request;
  setResponse: (status: number, body: string) => void;
} {
  let capturedUrl = '';
  let capturedHeaders: Record<string, string> = {};
  let capturedRequest: Request | undefined;
  let resStatus = 200;
  let resBody = '{}';
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedRequest = new Request(input, init);
    capturedUrl = capturedRequest.url;
    capturedHeaders = Object.fromEntries(capturedRequest.headers);
    return new Response(resBody, { status: resStatus });
  }) as typeof fetch;
  return {
    fetch: mockFetch,
    lastUrl: () => capturedUrl,
    lastHeaders: () => capturedHeaders,
    lastRequest: () => {
      if (!capturedRequest) {
        throw new Error('Fetch was not called');
      }
      return capturedRequest.clone();
    },
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
    expect(cap.lastHeaders()['authorization']).toBe('Bearer tid=BEARER2');
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
    expect(cap.lastHeaders()['copilot-vision-request']).toBe('true');
  });

  it('preserves a Request input method, headers, and JSON body', async () => {
    const mgr = makeMockMgr(
      'tid=REQUEST',
      'https://api.individual.githubcopilot.com',
    );
    const cap = makeCaptureFetch();
    const wrapped = wrapFetchWithCopilotAuth(mgr, { fetchImpl: cap.fetch });
    const input = new Request(`${COPILOT_SENTINEL_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-header': 'from-request',
      },
      body: JSON.stringify({ message: 'from-request' }),
    });

    await wrapped(input);

    const outgoing = cap.lastRequest();
    expect(outgoing.method).toBe('POST');
    expect(outgoing.headers.get('x-request-header')).toBe('from-request');
    expect(await outgoing.text()).toBe('{"message":"from-request"}');
  });

  it('applies init overrides without discarding an unoverridden Request body', async () => {
    const mgr = makeMockMgr(
      'tid=INIT',
      'https://api.individual.githubcopilot.com',
    );
    const cap = makeCaptureFetch();
    const wrapped = wrapFetchWithCopilotAuth(mgr, { fetchImpl: cap.fetch });
    const input = new Request(`${COPILOT_SENTINEL_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-header': 'from-request',
      },
      body: JSON.stringify({ message: 'from-request' }),
    });

    await wrapped(input, {
      method: 'PUT',
      headers: { 'x-init-header': 'from-init' },
    });

    const outgoing = cap.lastRequest();
    expect(outgoing.method).toBe('PUT');
    expect(outgoing.headers.get('x-init-header')).toBe('from-init');
    expect(outgoing.headers.get('x-request-header')).toBeNull();
    expect(await outgoing.text()).toBe('{"message":"from-request"}');
  });

  it('preserves a FormData Request body', async () => {
    const mgr = makeMockMgr(
      'tid=FORM',
      'https://api.individual.githubcopilot.com',
    );
    const cap = makeCaptureFetch();
    const wrapped = wrapFetchWithCopilotAuth(mgr, { fetchImpl: cap.fetch });
    const form = new FormData();
    form.set('field', 'value');
    const input = new Request(`${COPILOT_SENTINEL_BASE_URL}/v1/messages`, {
      method: 'POST',
      body: form,
    });

    await wrapped(input);

    const outgoing = cap.lastRequest();
    expect(outgoing.headers.get('content-type')).toMatch(
      /^multipart\/form-data; boundary=/,
    );
    expect((await outgoing.formData()).get('field')).toBe('value');
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
