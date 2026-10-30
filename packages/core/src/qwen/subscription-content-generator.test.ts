/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GenerateContentParameters } from '@google/genai';
import type { ReasoningEffort } from '../core/reasoning-effort.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { AuthType } from '../utils/auth-type.js';
import { preloadRuntimeFetchModule } from '../utils/runtimeFetchOptions.js';
import { createSubscriptionContentGenerator } from './subscription-content-generator.js';
import { SubscriptionOAuthError } from './subscription-oauth-client.js';
import { getErrorMessage } from '../utils/errors.js';
import {
  QWEN_SUBSCRIPTION_BASE_URL,
  QWEN_SUBSCRIPTION_MODEL,
} from './oauth-config.js';

vi.mock('../utils/runtimeFetchOptions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/runtimeFetchOptions.js')>()),
  buildRuntimeFetchOptions: vi.fn(),
}));

const session = vi.hoisted(() => ({ getAccessToken: vi.fn() }));
vi.mock('./subscription-session.js', () => ({
  QwenSubscriptionSession: class {
    getAccessToken = session.getAccessToken;
  },
}));

const fetchMock = vi.fn<typeof fetch>();
const request: GenerateContentParameters = {
  model: QWEN_SUBSCRIPTION_MODEL,
  contents: [{ role: 'user', parts: [{ text: 'Reply OK' }] }],
};
function generator(overrides = {}) {
  const config = {
    authType: AuthType.QWEN_SUBSCRIPTION,
    model: QWEN_SUBSCRIPTION_MODEL,
    baseUrl: QWEN_SUBSCRIPTION_BASE_URL,
    maxRetries: 0,
    ...overrides,
  };
  return createSubscriptionContentGenerator(config, makeFakeConfig());
}
function completion(text = 'OK') {
  return Response.json({
    id: 'test-completion',
    object: 'chat.completion',
    model: QWEN_SUBSCRIPTION_MODEL,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  session.getAccessToken.mockReset();
  vi.stubEnv('DEV', true);
  process.env['DEV'] = 'true';
  vi.stubGlobal('fetch', fetchMock);
  session.getAccessToken.mockResolvedValue('synthetic-access');
  await preloadRuntimeFetchModule();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('uses the real Chat pipeline with dynamic credentials and no DashScope extras', async () => {
  fetchMock.mockResolvedValue(completion());
  const result = await generator({
    apiKey: 'stale-provider-key',
  }).generateContent(request, 'prompt');
  expect(result.candidates?.[0]?.content?.parts).toContainEqual({ text: 'OK' });
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toBe(`${QWEN_SUBSCRIPTION_BASE_URL}/chat/completions`);
  expect(new Headers(init?.headers).get('Authorization')).toBe(
    'Bearer synthetic-access',
  );
  expect(init?.redirect).toBe('error');
  expect(new Headers(init?.headers).has('X-DashScope-AuthType')).toBe(false);
  expect(JSON.parse(init?.body as string)).toMatchObject({
    model: QWEN_SUBSCRIPTION_MODEL,
    stream: false,
  });
  expect(JSON.parse(init?.body as string)).not.toHaveProperty('metadata');
  expect(JSON.parse(init?.body as string)).not.toHaveProperty(
    'enable_thinking',
  );
});

it('consumes a multi-chunk SSE stream through the real Chat pipeline', async () => {
  const chunks: Array<Record<string, unknown>> = ['O', 'K'].map((content) => ({
    id: 'stream',
    object: 'chat.completion.chunk',
    model: QWEN_SUBSCRIPTION_MODEL,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  }));
  chunks.push({
    id: 'stream',
    object: 'chat.completion.chunk',
    model: QWEN_SUBSCRIPTION_MODEL,
    choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
  });
  fetchMock.mockResolvedValue(
    new Response(
      chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') +
        'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    ),
  );
  const stream = await generator({
    reasoning: { effort: 'medium' },
  }).generateContentStream(request, 'prompt');
  let text = '';
  for await (const chunk of stream) {
    for (const part of chunk.candidates?.[0]?.content?.parts ?? [])
      text += part.text ?? '';
  }
  expect(text).toBe('OK');
  expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toMatchObject({
    stream: true,
    stream_options: { include_usage: true },
    enable_thinking: true,
    thinking_budget: 16384,
  });
  expect(
    JSON.parse(fetchMock.mock.calls[0][1]?.body as string),
  ).not.toHaveProperty('reasoning');
});

it.each(['qwen3.8-max', 'qwen3.8-flash'])(
  'sends native thinking budgets for %s',
  async (model) => {
    const budgets: Array<[ReasoningEffort, number]> = [
      ['low', 4096],
      ['medium', 16384],
      ['high', 32768],
      ['xhigh', 32768],
      ['max', 32768],
    ];
    for (const [effort, thinkingBudget] of budgets) {
      fetchMock.mockResolvedValue(completion());
      await generator({ model, reasoning: { effort } }).generateContent(
        { ...request, model },
        'prompt',
      );
      const body = JSON.parse(fetchMock.mock.lastCall![1]?.body as string);
      expect(body).toMatchObject({
        model,
        enable_thinking: true,
        thinking_budget: thinkingBudget,
      });
      for (const field of [
        'reasoning',
        'reasoning_effort',
        'chat_template_kwargs',
        'extra_body',
      ])
        expect(body).not.toHaveProperty(field);
    }
  },
);

it.each(['qwen3.8-max', 'qwen3.8-flash'])(
  'turns thinking off without a budget for %s',
  async (model) => {
    fetchMock.mockResolvedValue(completion());
    const extraBody = {
      enable_thinking: true,
      thinking_budget: 50,
      reasoning_effort: 'high',
      chat_template_kwargs: { enable_thinking: true, other_option: 'keep' },
    };
    const before = structuredClone(extraBody);
    await generator({
      model,
      reasoning: false,
      extra_body: extraBody,
    }).generateContent({ ...request, model }, 'prompt');
    const body = JSON.parse(fetchMock.mock.lastCall![1]?.body as string);
    expect(body).toMatchObject({
      enable_thinking: false,
      chat_template_kwargs: { other_option: 'keep' },
    });
    for (const field of ['thinking_budget', 'reasoning', 'reasoning_effort'])
      expect(body).not.toHaveProperty(field);
    expect(body.chat_template_kwargs).not.toHaveProperty('enable_thinking');
    expect(extraBody).toEqual(before);
  },
);

it('honors per-request thinking opt-out over an enabled session', async () => {
  fetchMock.mockImplementation(async () => completion());
  const active = generator({ reasoning: { effort: 'xhigh' } });
  await active.generateContent(
    { ...request, config: { thinkingConfig: { includeThoughts: false } } },
    'side-query',
  );
  const body = JSON.parse(fetchMock.mock.lastCall![1]?.body as string);
  expect(body.enable_thinking).toBe(false);
  for (const field of [
    'thinking_budget',
    'reasoning',
    'reasoning_effort',
    'chat_template_kwargs',
  ])
    expect(body).not.toHaveProperty(field);
  await active.generateContent(request, 'next-prompt');
  expect(JSON.parse(fetchMock.mock.lastCall![1]?.body as string)).toMatchObject(
    {
      enable_thinking: true,
      thinking_budget: 32768,
    },
  );
});

it.each([
  [{ enable_thinking: true, thinking_budget: 50 }, true, 50],
  [{ enable_thinking: false, thinking_budget: 50 }, false, undefined],
] as const)(
  'preserves native thinking overrides %j',
  async (extraBody, enabled, budget) => {
    fetchMock.mockResolvedValue(completion());
    await generator({
      reasoning: { effort: 'medium' },
      extra_body: extraBody,
    }).generateContent(request, 'prompt');
    const body = JSON.parse(fetchMock.mock.lastCall![1]?.body as string);
    expect(body.enable_thinking).toBe(enabled);
    expect(body.thinking_budget).toBe(budget);
    expect(body).not.toHaveProperty('reasoning');
  },
);

it('enables thinking without inventing a budget when no strength is set', async () => {
  fetchMock.mockResolvedValue(completion());
  await generator({ reasoning: {} }).generateContent(request, 'prompt');
  const body = JSON.parse(fetchMock.mock.lastCall![1]?.body as string);
  expect(body.enable_thinking).toBe(true);
  expect(body).not.toHaveProperty('thinking_budget');
  expect(body).not.toHaveProperty('reasoning');
});

it('keeps mandatory thinking enabled without an unsupported off switch', async () => {
  fetchMock.mockResolvedValue(completion());
  await generator({
    reasoning: false,
    thinkingMandatory: true,
  }).generateContent(request, 'prompt');
  const body = JSON.parse(fetchMock.mock.lastCall![1]?.body as string);
  expect(body.enable_thinking).toBe(true);
  expect(body).not.toHaveProperty('thinking_budget');
});

it('uses the request model to keep subscription fields off unknown models', async () => {
  fetchMock.mockResolvedValue(completion());
  await generator({ reasoning: { effort: 'low' } }).generateContent(
    { ...request, model: 'future-served-model' },
    'prompt',
  );
  const body = JSON.parse(fetchMock.mock.lastCall![1]?.body as string);
  expect(body).toMatchObject({
    model: 'future-served-model',
    reasoning: { effort: 'low' },
  });
  expect(body).not.toHaveProperty('enable_thinking');
  expect(body).not.toHaveProperty('thinking_budget');
});

it('refreshes the rejected token once on 401, preserving the request body', async () => {
  session.getAccessToken
    .mockResolvedValueOnce('synthetic-old')
    .mockResolvedValueOnce('synthetic-new');
  fetchMock
    .mockResolvedValueOnce(
      Response.json(
        { error: { code: 'PROXY_TOKEN_INVALID' } },
        { status: 401 },
      ),
    )
    .mockResolvedValueOnce(completion());
  await generator({ reasoning: { effort: 'low' } }).generateContent(
    request,
    'prompt',
  );
  expect(session.getAccessToken).toHaveBeenLastCalledWith(
    expect.any(AbortSignal),
    'synthetic-old',
  );
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(
    new Headers(fetchMock.mock.calls[1][1]?.headers).get('Authorization'),
  ).toBe('Bearer synthetic-new');
  expect(fetchMock.mock.calls[1][1]?.body).toBe(
    fetchMock.mock.calls[0][1]?.body,
  );
  expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toMatchObject({
    enable_thinking: true,
    thinking_budget: 4096,
  });
});

it.each([403, 404, 429])(
  'does not refresh or retry HTTP %s',
  async (status) => {
    fetchMock.mockResolvedValue(
      Response.json({ error: { message: 'denied' } }, { status }),
    );
    await expect(
      generator().generateContent(request, 'prompt'),
    ).rejects.toThrow();
    expect(session.getAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  },
);

it('does not replay a second 401', async () => {
  fetchMock.mockResolvedValue(
    Response.json({ error: { code: 'PROXY_TOKEN_INVALID' } }, { status: 401 }),
  );
  await expect(
    generator().generateContent(request, 'prompt'),
  ).rejects.toThrow();
  expect(session.getAccessToken).toHaveBeenCalledTimes(2);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('rejects production, gateway overrides before reading credentials', () => {
  expect(() => generator({ baseUrl: 'https://other.example/v1' })).toThrow(
    'Unsupported',
  );
  vi.stubEnv('DEV', false);
  process.env['DEV'] = 'false';
  expect(() => generator()).toThrow('development');
  expect(session.getAccessToken).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('allows a served per-request model without a client allowlist', async () => {
  fetchMock.mockResolvedValue(completion());
  await generator().generateContent(
    { ...request, model: 'new-server-model' },
    'prompt',
  );
  expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).model).toBe(
    'new-server-model',
  );
});

it('does not send requests after credentials have been removed', async () => {
  session.getAccessToken.mockRejectedValue(new Error('session_changed'));
  await expect(
    generator().generateContent(request, 'prompt'),
  ).rejects.toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([
  [
    'invalid_grant',
    400,
    'refresh',
    'Your Qwen session has expired. Run /auth to sign in again.',
  ],
  ['rate_limited', 429, 'refresh', 'Refresh limit reached. Try again later.'],
] as const)(
  'preserves %s token errors through the inference SDK',
  async (code, status, stage, message) => {
    session.getAccessToken.mockRejectedValue(
      new SubscriptionOAuthError(code, status, message, 30_000, stage),
    );
    const error = await generator()
      .generateContent(request, 'prompt')
      .catch((error) => error);
    expect(getErrorMessage(error)).toContain(message);
    expect(error).toMatchObject({
      cause: { code, status, stage, retryAfterMs: 30_000 },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

it('roundtrips a tool call and its result using Chat message roles', async () => {
  const toolCompletion = {
    id: 'tool-completion',
    object: 'chat.completion',
    model: QWEN_SUBSCRIPTION_MODEL,
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-lookup',
              type: 'function',
              function: { name: 'lookup', arguments: '{"key":"answer"}' },
            },
          ],
        },
      },
    ],
  };
  fetchMock
    .mockResolvedValueOnce(Response.json(toolCompletion))
    .mockResolvedValueOnce(completion('42'));
  const active = generator();
  const first = await active.generateContent(request, 'tool-prompt');
  expect(first.candidates?.[0]?.content?.parts).toContainEqual({
    functionCall: {
      id: 'call-lookup',
      name: 'lookup',
      args: { key: 'answer' },
    },
  });
  const next: GenerateContentParameters = {
    ...request,
    contents: [
      { role: 'user', parts: [{ text: 'Look up the answer' }] },
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call-lookup',
              name: 'lookup',
              args: { key: 'answer' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call-lookup',
              name: 'lookup',
              response: { output: '42' },
            },
          },
        ],
      },
    ],
  };
  const second = await active.generateContent(next, 'tool-prompt');
  expect(second.candidates?.[0]?.content?.parts).toContainEqual({ text: '42' });
  const body = JSON.parse(fetchMock.mock.calls[1][1]?.body as string);
  expect(body.messages).toContainEqual(
    expect.objectContaining({ role: 'tool', tool_call_id: 'call-lookup' }),
  );
  expect(JSON.stringify(body.messages)).toContain('42');
});

it('does not expose token refresh response bodies through SDK errors', async () => {
  session.getAccessToken.mockRejectedValue(
    new Error('backend echoed synthetic-secret-token'),
  );
  let failure: unknown;
  try {
    await generator().generateContent(request, 'prompt');
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  const error = failure as Error & { cause?: Error };
  expect(error.message + error.cause?.message).not.toContain(
    'synthetic-secret-token',
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

it('sends any selected model ID without a client allowlist', async () => {
  fetchMock.mockResolvedValue(completion());
  await generator({ model: 'future-served-model' }).generateContent(
    { ...request, model: 'future-served-model' },
    'prompt',
  );
  expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).model).toBe(
    'future-served-model',
  );
});
