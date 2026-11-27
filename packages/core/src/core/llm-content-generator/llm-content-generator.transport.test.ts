/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Config } from '../../config/config.js';
import { retryContext } from '../../utils/retryContext.js';

const { dispatcher, runtimeFetch, buildRuntimeFetchOptionsMock } = vi.hoisted(
  () => ({
    dispatcher: { dispatch: vi.fn() },
    runtimeFetch: vi.fn<typeof globalThis.fetch>(),
    buildRuntimeFetchOptionsMock: vi.fn(),
  }),
);

vi.mock('../../utils/runtimeFetchOptions.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/runtimeFetchOptions.js')>();
  return {
    ...actual,
    preloadRuntimeFetchModule: vi.fn().mockResolvedValue(undefined),
    buildRuntimeFetchOptions: buildRuntimeFetchOptionsMock,
  };
});

import {
  GeminiConnectTimeoutError,
  LlmContentGenerator,
} from './llm-content-generator.js';

function okResponse(): Response {
  return Response.json({
    candidates: [{ content: { parts: [{ text: 'answer' }], role: 'model' } }],
  });
}

beforeEach(() => {
  runtimeFetch.mockReset().mockImplementation(async () => okResponse());
  buildRuntimeFetchOptionsMock
    .mockReset()
    .mockReturnValue({ fetch: runtimeFetch, fetchOptions: { dispatcher } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('keeps the Mod reasoning opt-out and disables redirects on the real Google SDK', async () => {
  const generator = new LlmContentGenerator(
    {
      apiKey: 'test-key',
      vertexai: false,
      httpOptions: { baseUrl: 'https://example.test' },
    },
    { model: 'gemini-test', reasoning: { effort: 'high' } },
  );
  const request = {
    model: 'gemini-test',
    contents: 'hello',
    config: { thinkingConfig: { includeThoughts: false } },
  };

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
  expect(runtimeFetch).toHaveBeenCalledTimes(2);
  expect(runtimeFetch).toHaveBeenNthCalledWith(
    1,
    url,
    expect.objectContaining({
      method: 'POST',
      redirect: 'error',
      dispatcher,
    }),
  );
  expect(runtimeFetch).toHaveBeenNthCalledWith(
    2,
    url,
    expect.objectContaining({
      method: 'POST',
      dispatcher,
    }),
  );
  expect(runtimeFetch.mock.calls[1]?.[1]).not.toHaveProperty('redirect');
  expect(
    JSON.parse(String(runtimeFetch.mock.calls[0]?.[1]?.body)).generationConfig
      .thinkingConfig,
  ).toEqual({ includeThoughts: false });
  expect(
    JSON.parse(String(runtimeFetch.mock.calls[1]?.[1]?.body)).generationConfig
      .thinkingConfig,
  ).toEqual({ includeThoughts: true, thinkingLevel: 'HIGH' });
});

it('does not send a Google SDK request whose signal was already aborted', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  const generator = new LlmContentGenerator({
    apiKey: 'test-key',
    vertexai: false,
    httpOptions: { baseUrl: 'https://example.test' },
  });

  await expect(
    generator.generateContent(
      {
        model: 'gemini-test',
        contents: 'hello',
        config: { abortSignal: AbortSignal.abort() },
      },
      'mod',
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetch).not.toHaveBeenCalled();
  expect(runtimeFetch).not.toHaveBeenCalled();
});

const HELLO_REQ = { model: 'gemini-test', contents: 'hello' };
const SINGLE_ATTEMPT = {
  attempt: 1,
  retryTotalDelayMs: 0,
  requestSetupMs: 0,
  singleAttempt: true,
};

function makeGen(
  cg: Record<string, unknown> = {},
  opts: {
    vertexai?: boolean;
    baseUrl?: string;
    retryOptions?: { attempts?: number };
  } = {},
  cliConfig?: Config,
) {
  return new LlmContentGenerator(
    {
      apiKey: 'test-key',
      vertexai: opts.vertexai ?? false,
      httpOptions: {
        baseUrl: opts.baseUrl ?? 'https://generativelanguage.googleapis.com',
        ...(opts.retryOptions ? { retryOptions: opts.retryOptions } : {}),
      },
    },
    { model: 'gemini-test', ...cg },
    cliConfig,
  );
}

it.each([
  [
    'official Gemini',
    false,
    'https://generativelanguage.googleapis.com',
    false,
  ],
  ['custom Gemini proxy', false, 'https://proxy.example.test', true],
  ['Vertex AI', true, 'https://vertex-proxy.example.test', false],
] as const)(
  'routes %s through buildRuntimeFetchOptions("gemini") with dispatcher and proxy without synthesizing X-Server-Timeout',
  async (_label, vertexai, baseUrl, expectBearer) => {
    const cliConfig = {
      getProxy: () => 'http://proxy.example:8080',
      getSessionId: () => 'session-1',
      getOutboundAllowDynamicHeaderValues: () => false,
    } as unknown as Config;

    const answer = await makeGen(
      { timeout: 600_000 },
      { vertexai, baseUrl },
      cliConfig,
    ).generateContent(HELLO_REQ, 'prompt-id');

    expect(answer.text).toBe('answer');
    expect(buildRuntimeFetchOptionsMock).toHaveBeenCalledWith(
      'gemini',
      'http://proxy.example:8080',
    );
    const init = runtimeFetch.mock.calls[0]?.[1] as RequestInit & {
      dispatcher?: unknown;
    };
    expect(init.dispatcher).toBe(dispatcher);
    const headers = new Headers(init.headers);
    expect(headers.has('x-server-timeout')).toBe(false);
    expect(headers.has('authorization')).toBe(expectBearer);
  },
);

it('preserves opt-in SDK httpOptions.retryOptions semantics (omitted=1, {}=5, explicit, singleAttempt)', async () => {
  vi.useFakeTimers();
  const busy503 = () =>
    new Response(JSON.stringify({ error: { message: 'busy' } }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });

  // Omitting retryOptions performs a single fetch (matching @google/genai).
  runtimeFetch.mockResolvedValueOnce(busy503());
  await expect(
    makeGen({ timeout: 0 }).generateContent(HELLO_REQ, 'prompt-id'),
  ).rejects.toThrow();
  expect(runtimeFetch).toHaveBeenCalledTimes(1);

  // Explicit empty retryOptions defaults attempts to 5 (matching @google/genai).
  runtimeFetch.mockReset().mockImplementation(async () => busy503());
  await Promise.all([
    expect(
      makeGen({ timeout: 0 }, { retryOptions: {} }).generateContent(
        HELLO_REQ,
        'prompt-id',
      ),
    ).rejects.toThrow(),
    vi.advanceTimersByTimeAsync(30_000),
  ]);
  expect(runtimeFetch).toHaveBeenCalledTimes(5);

  // Explicit attempts retries with jitter outside singleAttempt and skips inside singleAttempt.
  const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0); // -30% jitter -> 700ms
  try {
    const generator = makeGen(
      { timeout: 0 },
      { retryOptions: { attempts: 3 } },
    );
    runtimeFetch
      .mockReset()
      .mockResolvedValueOnce(
        new Response('service unavailable', { status: 503 }),
      )
      .mockResolvedValueOnce(okResponse());
    const pending = generator.generateContent(HELLO_REQ, 'prompt-id');
    await vi.advanceTimersByTimeAsync(650);
    expect(runtimeFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).text).toBe('answer');
    expect(runtimeFetch).toHaveBeenCalledTimes(2);

    runtimeFetch.mockReset().mockResolvedValueOnce(busy503());
    await expect(
      retryContext.run(SINGLE_ATTEMPT, () =>
        generator.generateContent(HELLO_REQ, 'prompt-id'),
      ),
    ).rejects.toThrow();
    expect(runtimeFetch).toHaveBeenCalledTimes(1);
  } finally {
    randomSpy.mockRestore();
  }
});

it('honors Retry-After delta-seconds and clamped HTTP-date headers on 429/503 retries', async () => {
  vi.useFakeTimers();
  const generator = makeGen({ timeout: 0 }, { retryOptions: { attempts: 2 } });

  // Delta-seconds Retry-After on 429.
  runtimeFetch
    .mockResolvedValueOnce(
      new Response('rate limited', {
        status: 429,
        headers: { 'Retry-After': '5' },
      }),
    )
    .mockResolvedValueOnce(okResponse());
  const deltaPending = generator.generateContent(HELLO_REQ, 'prompt-id');
  await vi.advanceTimersByTimeAsync(4_900);
  expect(runtimeFetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(200);
  expect((await deltaPending).text).toBe('answer');
  expect(runtimeFetch).toHaveBeenCalledTimes(2);

  // HTTP-date Retry-After on 503 clamped to DEFAULT_SDK_RETRY_MAX_DELAY_MS (60s).
  const farFuture = new Date(Date.now() + 300_000).toUTCString();
  runtimeFetch
    .mockReset()
    .mockResolvedValueOnce(
      new Response('unavailable', {
        status: 503,
        headers: { 'Retry-After': farFuture },
      }),
    )
    .mockResolvedValueOnce(okResponse());
  const datePending = generator.generateContent(HELLO_REQ, 'prompt-id');
  await vi.advanceTimersByTimeAsync(59_000);
  expect(runtimeFetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_500);
  expect((await datePending).text).toBe('answer');
  expect(runtimeFetch).toHaveBeenCalledTimes(2);
});

it('does not leak abort listeners on a shared AbortSignal and still propagates mid-stream aborts', async () => {
  const shared = new AbortController();
  const generator = makeGen({ timeout: 5_000 });
  for (let i = 0; i < 25; i += 1) {
    await generator.generateContent(
      { ...HELLO_REQ, config: { abortSignal: shared.signal } },
      `prompt-${i}`,
    );
  }
  expect(getEventListeners(shared.signal, 'abort')).toHaveLength(0);

  let observedSignal: AbortSignal | undefined;
  let releaseStream!: () => void;
  runtimeFetch.mockImplementationOnce(async (_url, init) => {
    observedSignal = init?.signal ?? undefined;
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'a' }], role: 'model' } }] })}\n\n`,
            ),
          );
          releaseStream = () => controller.close();
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  });
  const stream = await generator.generateContentStream(
    { ...HELLO_REQ, config: { abortSignal: shared.signal } },
    'prompt-stream-abort',
  );
  const first = await stream.next();
  expect(first.done).toBe(false);
  expect(observedSignal?.aborted).toBe(false);
  shared.abort(new Error('user cancelled'));
  expect(observedSignal?.aborted).toBe(true);
  releaseStream();
  await stream.return?.(undefined);
  expect(getEventListeners(shared.signal, 'abort')).toHaveLength(0);
});

it('cancels a late Response.body when connect timeout wins Promise.race', async () => {
  vi.useFakeTimers();
  let resolveFetch!: (res: Response) => void;
  runtimeFetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
  );

  await Promise.all([
    expect(
      makeGen({ timeout: 50 }).generateContent(HELLO_REQ, 'late-body'),
    ).rejects.toBeInstanceOf(GeminiConnectTimeoutError),
    vi.advanceTimersByTimeAsync(60),
  ]);

  const cancelSpy = vi.fn().mockResolvedValue(undefined);
  const lateResponse = new Response('late', { status: 200 });
  Object.defineProperty(lateResponse.body, 'cancel', { value: cancelSpy });
  resolveFetch(lateResponse);
  await Promise.resolve();
  await Promise.resolve();
  expect(cancelSpy).toHaveBeenCalledTimes(1);
});

it('redacts synchronous fetch throws without leaking connect timers or unhandled rejections', async () => {
  vi.useFakeTimers();
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    runtimeFetch.mockImplementationOnce(() => {
      throw new Error(
        'sync connect error http://user:secret@proxy.example:8080',
      );
    });

    await expect(
      makeGen({ timeout: 50 }).generateContent(HELLO_REQ, 'sync-throw'),
    ).rejects.toThrow(
      'sync connect error http://<redacted>@proxy.example:8080',
    );

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
  }
});

it.each([
  [
    false,
    'GOOGLE_GEMINI_BASE_URL',
    'https://proxy.example.test/gateway/v1beta/',
    'https://proxy.example.test/gateway/v1beta/models/gemini-test:generateContent',
  ],
  [
    true,
    'GOOGLE_VERTEX_BASE_URL',
    'https://vertex.example.test/gateway/V1BETA///',
    'https://vertex.example.test/gateway/v1beta1/publishers/google/models/gemini-test:generateContent',
  ],
] as const)(
  'normalizes trailing /v1beta on env-populated %s (%s)',
  async (vertexai, env, rawUrl, expectedUrl) => {
    vi.stubEnv(env, rawUrl);
    const generator = new LlmContentGenerator(
      { apiKey: 'test-key', vertexai },
      { model: 'gemini-test' },
    );
    await generator.generateContent(HELLO_REQ, 'env-base-url');
    expect(runtimeFetch.mock.calls[0]?.[0]).toBe(expectedUrl);
  },
);

it('falls back to contentGeneratorConfig.proxy when cliConfig is omitted and redacts proxy errors', async () => {
  runtimeFetch.mockRejectedValueOnce(
    new Error('connect ECONNREFUSED http://user:secret@proxy.example:8080'),
  );
  await expect(
    makeGen({ proxy: 'http://user:secret@proxy.example:8080' }).generateContent(
      HELLO_REQ,
      'prompt-id',
    ),
  ).rejects.toThrow('http://<redacted>@proxy.example:8080');
  expect(buildRuntimeFetchOptionsMock).toHaveBeenCalledWith(
    'gemini',
    'http://user:secret@proxy.example:8080',
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
