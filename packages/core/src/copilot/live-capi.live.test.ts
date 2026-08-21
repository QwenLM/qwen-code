import { describe, it, expect, beforeAll } from 'vitest';
import {
  createCopilotTokenManager,
  discoverGithubToken,
} from './copilot-auth.js';
import {
  wrapFetchWithCopilotAuth,
  COPILOT_SENTINEL_BASE_URL,
} from './copilot-fetch.js';
import { routeForModel } from './copilot-route.js';

const describeLive =
  process.env['COPILOT_LIVE_TEST'] === '1' ? describe : describe.skip;

describeLive('live CAPI', () => {
  let hasToken = false;
  beforeAll(async () => {
    try {
      const discovered = await discoverGithubToken();
      hasToken = !!discovered.token;
    } catch {
      hasToken = false;
    }
    if (process.env['COPILOT_LIVE_TEST'] === '1' && !hasToken) {
      throw new Error('COPILOT_LIVE_TEST=1 set but no ghu_/gho_ token found');
    }
  });

  it('claude-sonnet-4.6 via ghu_ returns 200 (messages wire)', async () => {
    const mgr = createCopilotTokenManager();
    const wrapped = wrapFetchWithCopilotAuth(mgr);
    const res = await wrapped(`${COPILOT_SENTINEL_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4.6',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Say hi in 3 words' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content?.[0]?.text).toBeDefined();
  });

  it('gpt-5.4 via ghu_ returns 200 (responses wire)', async () => {
    const mgr = createCopilotTokenManager();
    const wrapped = wrapFetchWithCopilotAuth(mgr);
    const res = await wrapped(`${COPILOT_SENTINEL_BASE_URL}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        input: 'Say hi in 3 words',
      }),
    });
    expect(res.status).toBe(200);
  });

  it('routeForModel maps claude-* to messages wire', () => {
    expect(routeForModel('claude-sonnet-4.6')).toBe('messages');
  });
});
