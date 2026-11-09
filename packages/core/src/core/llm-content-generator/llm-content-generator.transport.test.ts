/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';
import { retryContext } from '../../utils/retryContext.js';
import { LlmContentGenerator } from './llm-content-generator.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('disables redirects on the real Google SDK for single-attempt calls only', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
    Response.json({
      candidates: [{ content: { parts: [{ text: 'answer' }], role: 'model' } }],
    }),
  );
  vi.stubGlobal('fetch', fetch);
  const generator = new LlmContentGenerator({
    apiKey: 'test-key',
    vertexai: false,
    httpOptions: { baseUrl: 'https://example.test' },
  });
  const request = { model: 'gemini-test', contents: 'hello' };

  const answer = await retryContext.run(
    {
      attempt: 1,
      retryTotalDelayMs: 0,
      requestSetupMs: 0,
      singleAttempt: true,
    },
    () => generator.generateContent(request, 'mod'),
  );
  await generator.generateContent(request, 'session');

  const url = 'https://example.test/v1beta/models/gemini-test:generateContent';
  expect(answer.text).toBe('answer');
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch).toHaveBeenNthCalledWith(
    1,
    url,
    expect.objectContaining({ method: 'POST', redirect: 'error' }),
  );
  expect(fetch).toHaveBeenNthCalledWith(
    2,
    url,
    expect.not.objectContaining({ redirect: 'error' }),
  );
});

it.each([
  [false, 'GOOGLE_GEMINI_BASE_URL'],
  [true, 'GOOGLE_VERTEX_BASE_URL'],
])('rejects an implicit Google endpoint override (%s, %s)', (vertexai, env) => {
  vi.stubEnv(env, 'https://ambient.example.test');
  const options = { apiKey: 'test-key', vertexai };
  const config = { model: 'gemini-test', isolatedRoute: true };

  expect(() => new LlmContentGenerator({ ...options }, config)).toThrow(
    'Configure baseUrl explicitly',
  );
  expect(() => new LlmContentGenerator({ ...options })).not.toThrow();
  expect(
    () =>
      new LlmContentGenerator(
        {
          ...options,
          httpOptions: { baseUrl: 'https://explicit.example.test' },
        },
        config,
      ),
  ).not.toThrow();

  vi.stubEnv(env, undefined);
  expect(() => new LlmContentGenerator({ ...options }, config)).not.toThrow();
});
