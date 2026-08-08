/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockedFunction,
} from 'vitest';
import type { ContentGeneratorConfig } from '../contentGenerator.js';
import type { Config } from '../../config/config.js';
import type { DashScopeRequest } from './types.js';
import { FetchDashScopeTransport } from './transport.js';
import { DashScopeApiError } from './errors.js';
import {
  StreamInactivityTimeoutError,
  StreamLifetimeExceededError,
} from '../openaiContentGenerator/pipeline.js';
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  QWEN_STREAM_IDLE_TIMEOUT_MS_ENV,
} from '../openaiContentGenerator/constants.js';
import { buildRuntimeFetchOptions } from '../../utils/runtimeFetchOptions.js';
import type { AnthropicRuntimeFetchOptions } from '../../utils/runtimeFetchOptions.js';
import { classifyRetryError } from '../../utils/retryErrorClassification.js';

// The real implementation pins `fetch` to a bundled-undici function (to keep
// it version-matched with its dispatcher) even with no proxy configured,
// which would bypass `vi.stubGlobal('fetch', ...)` below — mock it the same
// way the OpenAI-compatible providers' tests do.
vi.mock('../../utils/runtimeFetchOptions.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../utils/runtimeFetchOptions.js')
  >()),
  buildRuntimeFetchOptions: vi.fn(),
}));

function createTestConfig(
  overrides: Partial<ContentGeneratorConfig> = {},
): ContentGeneratorConfig {
  return {
    apiKey: 'test-key',
    model: 'qwen3.8-max',
    ...overrides,
  } as ContentGeneratorConfig;
}

function createTestCliConfig(): Config {
  return {
    getCliVersion: vi.fn().mockReturnValue('1.0.0'),
    getProxy: vi.fn().mockReturnValue(undefined),
  } as unknown as Config;
}

function jsonResponse(
  payload: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function sseResponse(
  raw: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(new Blob([raw]).stream(), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'text/event-stream',
      ...(init.headers ?? {}),
    },
  });
}

/**
 * A ReadableStream that never enqueues or closes on its own, but errors as
 * soon as the fetch `signal` it was requested with aborts — mirroring how a
 * real (undici-backed) fetch ties response-body reads to the request's
 * AbortSignal. Without this, a guard-fired `abortRequest()` would have
 * nothing to tear down and the reader's pending `read()` would hang forever,
 * deadlocking the generator's own cleanup (`frames.return()` queues behind
 * the still-outstanding `frames.next()` call).
 */
function neverEndingSignalAwareStream(
  signal: AbortSignal | null | undefined,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener('abort', () => {
        controller.error(new DOMException('Aborted', 'AbortError'));
      });
    },
  });
}

/**
 * A signal-aware ReadableStream that drip-feeds `chunks` on their own delays
 * (mirroring a slow-but-healthy SSE body) and closes shortly after the last
 * one, but errors immediately if `signal` aborts — same abort-wiring as
 * {@link neverEndingSignalAwareStream}, used to prove the request-timeout
 * signal is no longer armed once headers have arrived.
 */
function dripFedSignalAwareStream(
  signal: AbortSignal | null | undefined,
  chunks: Array<{ delayMs: number; data: Uint8Array }>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener('abort', () => {
        controller.error(new DOMException('Aborted', 'AbortError'));
      });
      for (const chunk of chunks) {
        setTimeout(() => {
          try {
            controller.enqueue(chunk.data);
          } catch {
            // Stream may already be closed/errored — ignore.
          }
        }, chunk.delayMs);
      }
      const lastDelay = chunks.reduce((max, c) => Math.max(max, c.delayMs), 0);
      setTimeout(() => {
        try {
          controller.close();
        } catch {
          // Already closed/errored — ignore.
        }
      }, lastDelay + 10);
    },
  });
}

function testRequest(): DashScopeRequest {
  return {
    model: 'qwen3.8-max',
    input: { messages: [{ role: 'user', content: 'hi' }] },
    parameters: { result_format: 'message' },
  };
}

const ERROR_FRAME_400 = [
  'id:1',
  'event:error',
  ':HTTP_STATUS/400',
  'data:{"code":"InvalidParameter","message":"<400> InternalError.Algo.InvalidParameter: bad","request_id":"req-1"}',
  '',
].join('\n');

describe('FetchDashScopeTransport', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    (
      buildRuntimeFetchOptions as unknown as MockedFunction<
        (
          sdkType: 'anthropic',
          proxyUrl?: string,
        ) => AnthropicRuntimeFetchOptions
      >
    ).mockReturnValue({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('postJson', () => {
    it('posts to the resolved endpoint with the expected headers and no SSE header', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ output: { choices: [] } }));
      const transport = new FetchDashScopeTransport(
        createTestConfig(),
        createTestCliConfig(),
      );
      const body = testRequest();
      await transport.postJson(body, { signal: new AbortController().signal });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
      );
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-key');
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['User-Agent']).toBe(
        `QwenCode/1.0.0 (${process.platform}; ${process.arch})`,
      );
      expect(headers['X-DashScope-SSE']).toBeUndefined();
      expect(JSON.parse(init.body as string)).toEqual(body);
    });

    it('merges customHeaders last, allowing overrides', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ output: { choices: [] } }));
      const transport = new FetchDashScopeTransport(
        createTestConfig({
          customHeaders: { 'User-Agent': 'custom-agent', 'X-Extra': 'yes' },
        }),
        createTestCliConfig(),
      );
      await transport.postJson(testRequest(), {
        signal: new AbortController().signal,
      });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['User-Agent']).toBe('custom-agent');
      expect(headers['X-Extra']).toBe('yes');
    });

    it('returns the parsed JSON payload on 2xx', async () => {
      const payload = {
        output: { choices: [{ finish_reason: 'stop' }] },
        request_id: 'req-ok',
      };
      fetchMock.mockResolvedValue(jsonResponse(payload));
      const transport = new FetchDashScopeTransport(
        createTestConfig(),
        createTestCliConfig(),
      );
      const result = await transport.postJson(testRequest(), {
        signal: new AbortController().signal,
      });
      expect(result).toEqual(payload);
    });

    it('reads apiKey at request time, not construction time', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(jsonResponse({ output: { choices: [] } })),
      );
      const config = createTestConfig({ apiKey: 'first-key' });
      const transport = new FetchDashScopeTransport(
        config,
        createTestCliConfig(),
      );
      await transport.postJson(testRequest(), {
        signal: new AbortController().signal,
      });
      config.apiKey = 'second-key';
      await transport.postJson(testRequest(), {
        signal: new AbortController().signal,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstHeaders = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
        .headers as Record<string, string>;
      const secondHeaders = (
        fetchMock.mock.calls[1] as [string, RequestInit]
      )[1].headers as Record<string, string>;
      expect(firstHeaders['Authorization']).toBe('Bearer first-key');
      expect(secondHeaders['Authorization']).toBe('Bearer second-key');
    });

    it('throws DashScopeApiError with status/code for a JSON error body', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(
          {
            code: 'InvalidParameter',
            message: '<400> InternalError.Algo.InvalidParameter: bad',
            request_id: 'req-json',
          },
          { status: 400 },
        ),
      );
      const transport = new FetchDashScopeTransport(
        createTestConfig(),
        createTestCliConfig(),
      );
      const error = await transport
        .postJson(testRequest(), { signal: new AbortController().signal })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DashScopeApiError);
      expect((error as DashScopeApiError).status).toBe(400);
      expect((error as DashScopeApiError).code).toBe('InvalidParameter');
      expect((error as DashScopeApiError).requestId).toBe('req-json');
    });

    it('throws DashScopeApiError with status/code for an SSE-framed error body', async () => {
      fetchMock.mockResolvedValue(
        sseResponse(ERROR_FRAME_400, { status: 400 }),
      );
      const transport = new FetchDashScopeTransport(
        createTestConfig(),
        createTestCliConfig(),
      );
      const error = await transport
        .postJson(testRequest(), { signal: new AbortController().signal })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DashScopeApiError);
      expect((error as DashScopeApiError).status).toBe(400);
      expect((error as DashScopeApiError).code).toBe('InvalidParameter');
      expect((error as DashScopeApiError).requestId).toBe('req-1');
    });

    it('rejects with an abort error when the caller signal is aborted', async () => {
      const controller = new AbortController();
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const err = new Error('Aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      );
      const transport = new FetchDashScopeTransport(
        createTestConfig(),
        createTestCliConfig(),
      );
      const promise = transport.postJson(testRequest(), {
        signal: controller.signal,
      });
      controller.abort();
      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('redacts proxy credentials from fetch failures', async () => {
      fetchMock.mockRejectedValue(
        new Error(
          'connect ECONNREFUSED http://proxy-user:proxy-pass@proxy.local:8080',
        ),
      );
      const transport = new FetchDashScopeTransport(
        createTestConfig(),
        createTestCliConfig(),
      );

      const error = await transport
        .postJson(testRequest(), { signal: new AbortController().signal })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        'http://<redacted>@proxy.local:8080',
      );
      expect((error as Error).message).not.toContain('proxy-user');
      expect((error as Error).message).not.toContain('proxy-pass');
    });

    it('classifies a configured request timeout as retryable ETIMEDOUT', async () => {
      vi.useFakeTimers();
      try {
        fetchMock.mockImplementation(
          (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'));
              });
            }),
        );
        const transport = new FetchDashScopeTransport(
          createTestConfig({ timeout: 50 }),
          createTestCliConfig(),
        );
        const captured = transport
          .postJson(testRequest(), {
            signal: new AbortController().signal,
          })
          .catch((e: unknown) => e);

        await vi.advanceTimersByTimeAsync(50);
        const error = await captured;

        expect(error).toMatchObject({ code: 'ETIMEDOUT' });
        expect(error).not.toMatchObject({ name: 'AbortError' });
        expect(classifyRetryError(error).diagnosis).toBe('retryable');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('postSse', () => {
    it('posts with the X-DashScope-SSE header', async () => {
      fetchMock.mockResolvedValue(sseResponse(''));
      const transport = new FetchDashScopeTransport(
        createTestConfig(),
        createTestCliConfig(),
      );
      await transport.postSse(testRequest(), {
        signal: new AbortController().signal,
      });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['X-DashScope-SSE']).toBe('enable');
    });

    it('round-trips frames decoded from the mocked SSE body', async () => {
      const raw = [
        'id:1',
        'event:result',
        ':HTTP_STATUS/200',
        'data:{"output":{"choices":[{"finish_reason":"null","message":{"role":"assistant","content":[],"reasoning_content":"Hi"}}]},"usage":{},"request_id":"r1"}',
        '',
        'id:2',
        'event:result',
        ':HTTP_STATUS/200',
        'data:{"output":{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":[{"text":"OK"}]}}]},"usage":{},"request_id":"r1"}',
        '',
      ].join('\n');
      fetchMock.mockResolvedValue(sseResponse(raw));
      const transport = new FetchDashScopeTransport(
        createTestConfig(),
        createTestCliConfig(),
      );
      const frames = await transport.postSse(testRequest(), {
        signal: new AbortController().signal,
      });
      const collected = [];
      for await (const frame of frames) {
        collected.push(frame);
      }
      expect(collected).toHaveLength(2);
      expect(collected[0]?.event).toBe('result');
      expect(collected[0]?.httpStatus).toBe(200);
      expect(JSON.parse(collected[1]?.data ?? '{}')).toMatchObject({
        output: { choices: [{ finish_reason: 'stop' }] },
      });
    });

    it('throws DashScopeApiError for a JSON error body on a streaming request', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(
          {
            code: 'InvalidParameter',
            message: '<400> bad',
            request_id: 'req-json-stream',
          },
          { status: 400 },
        ),
      );
      const transport = new FetchDashScopeTransport(
        createTestConfig(),
        createTestCliConfig(),
      );
      const error = await transport
        .postSse(testRequest(), { signal: new AbortController().signal })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DashScopeApiError);
      expect((error as DashScopeApiError).status).toBe(400);
    });

    it('throws DashScopeApiError for an SSE-framed error body on a streaming request', async () => {
      fetchMock.mockResolvedValue(
        sseResponse(ERROR_FRAME_400, { status: 400 }),
      );
      const transport = new FetchDashScopeTransport(
        createTestConfig(),
        createTestCliConfig(),
      );
      const error = await transport
        .postSse(testRequest(), { signal: new AbortController().signal })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DashScopeApiError);
      expect((error as DashScopeApiError).status).toBe(400);
      expect((error as DashScopeApiError).code).toBe('InvalidParameter');
    });

    describe('stream guards', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
      });

      it('throws StreamInactivityTimeoutError when the stream goes silent past the idle timeout', async () => {
        fetchMock.mockImplementation((_url: string, init: RequestInit) =>
          Promise.resolve(
            new Response(
              neverEndingSignalAwareStream(init.signal ?? undefined),
              { status: 200, headers: { 'content-type': 'text/event-stream' } },
            ),
          ),
        );
        const transport = new FetchDashScopeTransport(
          createTestConfig({ streamIdleTimeoutMs: 50 }),
          createTestCliConfig(),
        );
        const frames = await transport.postSse(testRequest(), {
          signal: new AbortController().signal,
        });
        const captured = frames.next().catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(50);
        const result = await captured;
        expect(result).toBeInstanceOf(StreamInactivityTimeoutError);
      });

      it('throws StreamLifetimeExceededError when the stream exceeds its lifetime cap', async () => {
        fetchMock.mockImplementation((_url: string, init: RequestInit) =>
          Promise.resolve(
            new Response(
              neverEndingSignalAwareStream(init.signal ?? undefined),
              { status: 200, headers: { 'content-type': 'text/event-stream' } },
            ),
          ),
        );
        const transport = new FetchDashScopeTransport(
          createTestConfig({
            streamIdleTimeoutMs: 0,
            streamMaxLifetimeMs: 80,
          }),
          createTestCliConfig(),
        );
        const frames = await transport.postSse(testRequest(), {
          signal: new AbortController().signal,
        });
        const captured = frames.next().catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(80);
        const result = await captured;
        expect(result).toBeInstanceOf(StreamLifetimeExceededError);
      });

      it('does not charge consumer pauses against the stream lifetime cap', async () => {
        const raw = [
          'id:1',
          'event:result',
          ':HTTP_STATUS/200',
          'data:{"output":{"choices":[{"finish_reason":"null","message":{"role":"assistant","content":[{"text":"first"}]}}]},"usage":{},"request_id":"r1"}',
          '',
          'id:2',
          'event:result',
          ':HTTP_STATUS/200',
          'data:{"output":{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":[{"text":"second"}]}}]},"usage":{},"request_id":"r1"}',
          '',
        ].join('\n');
        fetchMock.mockResolvedValue(sseResponse(raw));
        const transport = new FetchDashScopeTransport(
          createTestConfig({
            streamIdleTimeoutMs: 0,
            streamMaxLifetimeMs: 50,
          }),
          createTestCliConfig(),
        );
        const frames = await transport.postSse(testRequest(), {
          signal: new AbortController().signal,
        });

        const first = await frames.next();
        expect(first.value?.data).toContain('"text":"first"');

        await vi.advanceTimersByTimeAsync(100);

        const terminal = await frames.next();
        expect(terminal.value?.data).toContain('"finish_reason":"stop"');

        await vi.advanceTimersByTimeAsync(100);

        await expect(frames.next()).resolves.toMatchObject({ done: true });
      });

      it('treats QWEN_STREAM_IDLE_TIMEOUT_MS=0 as disabling the idle guard, not falling back to the default', async () => {
        // The settings-field `streamIdleTimeoutMs: 0` already disables the
        // guard; this pins the env knob to the same "0 disables" semantics —
        // the exact contract `StreamInactivityTimeoutError`'s own message
        // tells users to rely on ("or 0 to disable it").
        vi.stubEnv(QWEN_STREAM_IDLE_TIMEOUT_MS_ENV, '0');
        fetchMock.mockImplementation((_url: string, init: RequestInit) =>
          Promise.resolve(
            new Response(
              neverEndingSignalAwareStream(init.signal ?? undefined),
              { status: 200, headers: { 'content-type': 'text/event-stream' } },
            ),
          ),
        );
        const transport = new FetchDashScopeTransport(
          // No streamIdleTimeoutMs config → env applies. Lifetime disabled too
          // so only the idle guard's env resolution is under test.
          createTestConfig({ streamMaxLifetimeMs: 0 }),
          createTestCliConfig(),
        );
        const frames = await transport.postSse(testRequest(), {
          signal: new AbortController().signal,
        });
        let settled = false;
        frames.next().then(
          () => (settled = true),
          () => (settled = true),
        );
        // Well past the default idle timeout — must NOT trip if `0` truly
        // disabled the guard instead of silently falling back to the default.
        await vi.advanceTimersByTimeAsync(
          DEFAULT_STREAM_IDLE_TIMEOUT_MS + 60000,
        );
        expect(settled).toBe(false);
      });

      it('rejects an oversized QWEN_STREAM_IDLE_TIMEOUT_MS env value and falls back to the default instead of clamping', async () => {
        // Node's setTimeout silently compresses delays above 2^31-1ms to ~1ms,
        // so using an oversized value verbatim would abort the stream almost
        // immediately. Asserting no trip before the default — and a trip AT
        // the default — proves the value was rejected, not used verbatim.
        vi.stubEnv(QWEN_STREAM_IDLE_TIMEOUT_MS_ENV, '9999999999999');
        fetchMock.mockImplementation((_url: string, init: RequestInit) =>
          Promise.resolve(
            new Response(
              neverEndingSignalAwareStream(init.signal ?? undefined),
              { status: 200, headers: { 'content-type': 'text/event-stream' } },
            ),
          ),
        );
        const transport = new FetchDashScopeTransport(
          createTestConfig({ streamMaxLifetimeMs: 0 }),
          createTestCliConfig(),
        );
        const frames = await transport.postSse(testRequest(), {
          signal: new AbortController().signal,
        });
        let settled = false;
        let result: unknown;
        const consume = frames.next().then(
          (r) => {
            settled = true;
            result = r;
          },
          (e: unknown) => {
            settled = true;
            result = e;
          },
        );
        await vi.advanceTimersByTimeAsync(DEFAULT_STREAM_IDLE_TIMEOUT_MS - 1);
        expect(settled).toBe(false); // not before the default → not used verbatim
        await vi.advanceTimersByTimeAsync(1);
        await consume;
        expect(settled).toBe(true); // trips at the default
        expect(result).toBeInstanceOf(StreamInactivityTimeoutError);
      });
    });

    // Uses REAL timers deliberately: `AbortSignal.timeout` is backed by a
    // native (non-JS) timer that vitest's fake-timer install does not
    // intercept, so a fake-timer test cannot actually exercise the request
    // timeout / stream-body race this guards against.
    it('does not kill a healthy stream once headers have arrived, even past the request timeout', async () => {
      const encoder = new TextEncoder();
      const frame1 =
        [
          'id:1',
          'event:result',
          ':HTTP_STATUS/200',
          'data:{"output":{"choices":[{"finish_reason":"null","message":{"role":"assistant","content":[],"reasoning_content":"Hi"}}]},"usage":{},"request_id":"r1"}',
          '',
        ].join('\n') + '\n';
      const frame2 =
        [
          'id:2',
          'event:result',
          ':HTTP_STATUS/200',
          'data:{"output":{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":[{"text":"OK"}]}}]},"usage":{},"request_id":"r1"}',
          '',
        ].join('\n') + '\n';

      fetchMock.mockImplementation((_url: string, init: RequestInit) =>
        Promise.resolve(
          new Response(
            dripFedSignalAwareStream(init.signal ?? undefined, [
              { delayMs: 10, data: encoder.encode(frame1) },
              // This chunk arrives well past `timeout` below — a healthy,
              // actively-flowing stream must not be killed for that.
              { delayMs: 150, data: encoder.encode(frame2) },
            ]),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
        ),
      );

      const transport = new FetchDashScopeTransport(
        createTestConfig({
          timeout: 30,
          streamIdleTimeoutMs: 10_000,
          streamMaxLifetimeMs: 10_000,
        }),
        createTestCliConfig(),
      );

      const frames = await transport.postSse(testRequest(), {
        signal: new AbortController().signal,
      });

      const collected: Array<{ data: string }> = [];
      for await (const frame of frames) {
        collected.push(frame);
      }

      expect(collected).toHaveLength(2);
      expect(collected[1]?.data).toContain('"finish_reason":"stop"');
    });
  });
});
