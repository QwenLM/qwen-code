import { describe, expect, it } from 'bun:test';
import { resolveRequestContext } from '../interceptor-request-utils.ts';

describe('interceptor-request-utils', () => {
  it('extracts JSON body from Request input when init.body is absent', async () => {
    const req = new Request('https://example.com/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ foo: 'bar' }),
    });

    const result = await resolveRequestContext(req, undefined);
    expect(result.bodyStr).toBe(JSON.stringify({ foo: 'bar' }));
    expect(result.normalizedInit.method).toBe('POST');
  });

  it('prefers init.body when provided', async () => {
    const req = new Request('https://example.com/messages', {
      method: 'POST',
      body: JSON.stringify({ old: true }),
    });

    const result = await resolveRequestContext(req, {
      method: 'POST',
      body: JSON.stringify({ new: true }),
    });

    expect(result.bodyStr).toBe(JSON.stringify({ new: true }));
  });
});
