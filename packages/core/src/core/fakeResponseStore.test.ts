/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { promises } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CountTokensResponse } from '@google/genai';
import { FakeResponseStore, type FakeResponse } from './fakeResponseStore.js';
import { SessionIdInvariantError } from '../utils/sessionIdInvariantError.js';

describe('FakeResponseStore', () => {
  it('returns responses strictly in recorded order', () => {
    const store = new FakeResponseStore([
      { method: 'countTokens', response: { totalTokens: 1 } },
      { method: 'countTokens', response: { totalTokens: 2 } },
    ]);

    expect(
      (store.getNextResponse('countTokens', {}) as CountTokensResponse)
        .totalTokens,
    ).toBe(1);
    expect(
      (store.getNextResponse('countTokens', {}) as CountTokensResponse)
        .totalTokens,
    ).toBe(2);
  });

  it('throws when responses are exhausted', () => {
    const store = new FakeResponseStore([]);
    expect(() => store.getNextResponse('countTokens', { some: 'req' })).toThrow(
      /No more mock responses for countTokens/,
    );
  });

  it('throws when the next response is for a different method', () => {
    const store = new FakeResponseStore([
      { method: 'embedContent', response: {} },
    ]);
    expect(() => store.getNextResponse('countTokens', {})).toThrow(
      /next response was for embedContent but expected countTokens/,
    );
  });

  it('enforces the expectedSessionId invariant on utility responses', () => {
    const responses: FakeResponse[] = [
      {
        method: 'utilityGenerateContent',
        response: 'ok',
        expectedSessionId: 'session-a',
      },
      {
        method: 'utilityGenerateContent',
        response: 'ok',
        expectedSessionId: 'session-a',
      },
    ];
    const store = new FakeResponseStore(responses);

    expect(
      store.getNextResponse('utilityGenerateContent', {
        sessionId: 'session-a',
      }),
    ).toBe('ok');
    expect(() =>
      store.getNextResponse('utilityGenerateContent', {
        sessionId: 'session-b',
      }),
    ).toThrow(SessionIdInvariantError);
  });

  it('does not check sessionId when expectedSessionId is absent', () => {
    const store = new FakeResponseStore([
      { method: 'utilityGenerateContent', response: 'ok' },
    ]);
    expect(
      store.getNextResponse('utilityGenerateContent', {
        sessionId: 'anything',
      }),
    ).toBe('ok');
  });

  it('parses a JSONL recording file via fromFile', async () => {
    const file = join(tmpdir(), `fake-responses-${process.pid}.jsonl`);
    await promises.writeFile(
      file,
      [
        JSON.stringify({
          method: 'countTokens',
          response: { totalTokens: 7 },
        }),
        '',
        JSON.stringify({ method: 'utilityGenerateContent', response: 'hi' }),
      ].join('\n'),
      'utf-8',
    );
    try {
      const store = await FakeResponseStore.fromFile(file);
      expect(
        (store.getNextResponse('countTokens', {}) as CountTokensResponse)
          .totalTokens,
      ).toBe(7);
      expect(store.getNextResponse('utilityGenerateContent', {})).toBe('hi');
    } finally {
      await promises.unlink(file);
    }
  });
});
