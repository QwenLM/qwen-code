import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCopilotTokenManager } from './copilot-auth.js';

describe('cache atomicity', () => {
  it('100 concurrent getSnapshot calls never split bearer/endpoints', async () => {
    const cacheFile = join(
      mkdtempSync(join(tmpdir(), 'copi-atomic-')),
      'copilot.json',
    );
    let count = 0;
    const f = (async () => {
      count++;
      return new Response(
        JSON.stringify({
          token: 'tid=ATOMIC;proxy-ep=proxy.individual.githubcopilot.com',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const mgr = createCopilotTokenManager({ cacheFile, fetchImpl: f });
    const snaps = await Promise.all(
      Array.from({ length: 100 }, () => mgr.getSnapshot()),
    );
    const firstBearer = snaps[0].bearer.valueOf();
    expect(snaps.every((s) => s.bearer.valueOf() === firstBearer)).toBe(true);
    expect(snaps.every((s) => s.endpointsApi === snaps[0].endpointsApi)).toBe(
      true,
    );
    expect(count).toBe(1);
  });
});
