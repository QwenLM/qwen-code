/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from 'vitest';
import type { GenerateContentParameters } from '@google/genai';
import { FunctionCallingConfigMode, FinishReason } from '@google/genai';
import {
  ResponsesPipeline,
  mergeStreamResponses,
  StreamInactivityTimeoutError,
} from './responses-pipeline.js';
import type { Config } from '../../config/config.js';
import type { ContentGeneratorConfig } from '../contentGenerator.js';
import type { ResponsesApiRequest } from './types.js';
import { preloadRuntimeFetchModule } from '../../utils/runtimeFetchOptions.js';

// The pipeline calls the `fetch` buildRuntimeFetchOptions returns (pinned
// alongside its dispatcher) rather than the global `fetch`, so the mock must
// intercept it there -- stubbing global `fetch` alone is bypassed and the
// real undici fetch attempts a live network call (see #8169 review).
const { buildRuntimeFetchOptionsMock } = vi.hoisted(() => ({
  buildRuntimeFetchOptionsMock: vi.fn(),
}));
vi.mock('../../utils/runtimeFetchOptions.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/runtimeFetchOptions.js')>();
  return {
    ...actual,
    buildRuntimeFetchOptions: buildRuntimeFetchOptionsMock,
  };
});

function sseStream(lines: string[]): ReadableStream<Uint8Array> {
  const body = lines.join('\n') + '\n';
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
}

function sseEvent(event: string, data: unknown): string[] {
  return [`event: ${event}`, `data: ${JSON.stringify(data)}`, ''];
}

// Splits the SSE body into small byte chunks so a single event/data line —
// or the JSON payload itself — lands across multiple reader.read() calls,
// exercising the pipeline's buffer/line-carry logic instead of always
// handing it one complete frame per read.
function sseStreamChunked(
  lines: string[],
  chunkSize = 5,
): ReadableStream<Uint8Array> {
  const body = lines.join('\n') + '\n';
  const bytes = new TextEncoder().encode(body);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
}

function makeCliConfig(): Config {
  return { getProxy: () => undefined } as unknown as Config;
}

function makeGeneratorConfig(
  overrides: Partial<ContentGeneratorConfig> = {},
): ContentGeneratorConfig {
  return {
    model: 'gpt-5',
    apiKey: 'test-key',
    baseUrl: 'https://api.openai.com',
    ...overrides,
  } as ContentGeneratorConfig;
}

function textRequest(text: string): GenerateContentParameters {
  return { model: 'gpt-5', contents: [{ role: 'user', parts: [{ text }] }] };
}

describe('ResponsesPipeline', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    // buildRuntimeFetchOptions lazy-loads undici; production always calls
    // this via createContentGenerator before constructing any generator.
    await preloadRuntimeFetchModule();
  });

  beforeEach(() => {
    fetchMock = vi.fn();
    buildRuntimeFetchOptionsMock.mockReturnValue({ fetch: fetchMock });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function mockResponse(lines: string[], status = 200) {
    fetchMock.mockResolvedValue({
      ok: status < 400,
      status,
      headers: { get: () => 'text/event-stream' },
      body: sseStream(lines),
      text: async () => '',
    });
  }

  it('POSTs to <baseUrl>/v1/responses with the converted request body', async () => {
    mockResponse([
      ...sseEvent('response.output_text.delta', { delta: 'hi' }),
      ...sseEvent('response.completed', {
        response: { id: 'r1', status: 'completed' },
      }),
    ]);
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig(),
      makeCliConfig(),
    );
    const chunks = [];
    for await (const chunk of pipeline.executeStream(
      textRequest('hello'),
      'prompt-1',
    )) {
      chunks.push(chunk);
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.headers['Authorization']).toBe('Bearer test-key');
    expect(init.headers['Accept']).toBe('text/event-stream');
    const body = JSON.parse(init.body) as ResponsesApiRequest;
    expect(body.model).toBe('gpt-5');
    expect(body.stream).toBe(true);
    // We never reference previous_response_id, so nothing benefits from
    // server-side storage; the spec pairs this with reasoning.encrypted_content
    // as the intended stateless-replay recipe.
    expect(body.store).toBe(false);
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: 'hello' },
    ]);

    expect(chunks.map((c) => c.candidates?.[0]?.content?.parts)).toEqual([
      [{ text: 'hi' }],
      [],
    ]);
  });

  it('passes userPromptId through as prompt_cache_key when within the length limit', async () => {
    mockResponse(
      sseEvent('response.completed', { response: { status: 'completed' } }),
    );
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig(),
      makeCliConfig(),
    );
    for await (const _ of pipeline.executeStream(
      textRequest('hi'),
      'short-id',
    )) {
      // drain
    }
    const body = JSON.parse(
      fetchMock.mock.calls[0]![1].body,
    ) as ResponsesApiRequest;
    expect(body.prompt_cache_key).toBe('short-id');
  });

  it('hashes userPromptId into a fixed-length prompt_cache_key when it exceeds 64 characters', async () => {
    // A mutation removing the truncation branch would silently disable
    // prompt caching (the Responses API rejects/ignores an over-length
    // prompt_cache_key) with no visible error -- pin the hashed shape.
    mockResponse(
      sseEvent('response.completed', { response: { status: 'completed' } }),
    );
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig(),
      makeCliConfig(),
    );
    const longId = 'x'.repeat(100);
    for await (const _ of pipeline.executeStream(textRequest('hi'), longId)) {
      // drain
    }
    const body = JSON.parse(
      fetchMock.mock.calls[0]![1].body,
    ) as ResponsesApiRequest;
    expect(body.prompt_cache_key).not.toBe(longId);
    expect(body.prompt_cache_key).toHaveLength(64);
    expect(body.prompt_cache_key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('strips a trailing /v1 from baseUrl before appending /v1/responses', async () => {
    mockResponse(
      sseEvent('response.completed', { response: { status: 'completed' } }),
    );
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig({ baseUrl: 'https://api.openai.com/v1' }),
      makeCliConfig(),
    );
    for await (const _ of pipeline.executeStream(textRequest('hi'), 'p1')) {
      // drain
    }
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://api.openai.com/v1/responses',
    );
  });

  it('defaults to https://api.openai.com when no baseUrl is configured', async () => {
    mockResponse(
      sseEvent('response.completed', { response: { status: 'completed' } }),
    );
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig({ baseUrl: undefined }),
      makeCliConfig(),
    );
    for await (const _ of pipeline.executeStream(textRequest('hi'), 'p1')) {
      // drain
    }
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://api.openai.com/v1/responses',
    );
  });

  describe('reasoning request shape', () => {
    it('passes the effort straight through with no clamping, plus include + summary auto', async () => {
      mockResponse(
        sseEvent('response.completed', { response: { status: 'completed' } }),
      );
      const pipeline = new ResponsesPipeline(
        makeGeneratorConfig({ reasoning: { effort: 'max' } }),
        makeCliConfig(),
      );
      for await (const _ of pipeline.executeStream(textRequest('hi'), 'p1')) {
        // drain
      }
      const body = JSON.parse(
        fetchMock.mock.calls[0]![1].body,
      ) as ResponsesApiRequest;
      expect(body.reasoning).toEqual({ effort: 'max', summary: 'auto' });
      expect(body.include).toEqual(['reasoning.encrypted_content']);
    });

    it('omits reasoning and include entirely when reasoning is false', async () => {
      mockResponse(
        sseEvent('response.completed', { response: { status: 'completed' } }),
      );
      const pipeline = new ResponsesPipeline(
        makeGeneratorConfig({ reasoning: false }),
        makeCliConfig(),
      );
      for await (const _ of pipeline.executeStream(textRequest('hi'), 'p1')) {
        // drain
      }
      const body = JSON.parse(
        fetchMock.mock.calls[0]![1].body,
      ) as ResponsesApiRequest;
      expect(body.reasoning).toBeUndefined();
      expect(body.include).toBeUndefined();
    });
  });

  it('maps samplingParams onto temperature/top_p/max_output_tokens', async () => {
    mockResponse(
      sseEvent('response.completed', { response: { status: 'completed' } }),
    );
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig({
        samplingParams: { temperature: 0.4, top_p: 0.9, max_tokens: 2048 },
      }),
      makeCliConfig(),
    );
    for await (const _ of pipeline.executeStream(textRequest('hi'), 'p1')) {
      // drain
    }
    const body = JSON.parse(
      fetchMock.mock.calls[0]![1].body,
    ) as ResponsesApiRequest;
    expect(body.temperature).toBe(0.4);
    expect(body.top_p).toBe(0.9);
    expect(body.max_output_tokens).toBe(2048);
  });

  it('merges extra_body keys that do not already exist on the request', async () => {
    mockResponse(
      sseEvent('response.completed', { response: { status: 'completed' } }),
    );
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig({
        extra_body: { service_tier: 'priority', model: 'ignored' },
      }),
      makeCliConfig(),
    );
    for await (const _ of pipeline.executeStream(textRequest('hi'), 'p1')) {
      // drain
    }
    const body = JSON.parse(
      fetchMock.mock.calls[0]![1].body,
    ) as ResponsesApiRequest & { service_tier?: string };
    expect(body.service_tier).toBe('priority');
    // 'model' already exists on the request, so extra_body must not clobber it.
    expect(body.model).toBe('gpt-5');
  });

  it('lets extra_body fill in a field left undefined by the request itself', async () => {
    mockResponse(
      sseEvent('response.completed', { response: { status: 'completed' } }),
    );
    // textRequest() has no config.tools, so apiRequest.tools is present as a
    // key with value undefined — extra_body must still be able to set it.
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig({
        extra_body: { instructions: 'from extra_body' },
      }),
      makeCliConfig(),
    );
    for await (const _ of pipeline.executeStream(textRequest('hi'), 'p1')) {
      // drain
    }
    const body = JSON.parse(
      fetchMock.mock.calls[0]![1].body,
    ) as ResponsesApiRequest;
    expect(body.instructions).toBe('from extra_body');
  });

  describe('tool_choice from toolConfig.functionCallingConfig.mode', () => {
    function requestWithTool(
      mode?: FunctionCallingConfigMode,
    ): GenerateContentParameters {
      return {
        model: 'gpt-5',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        config: {
          tools: [{ functionDeclarations: [{ name: 'read_file' }] }],
          ...(mode ? { toolConfig: { functionCallingConfig: { mode } } } : {}),
        },
      };
    }

    it('defaults to auto when no functionCallingConfig is set', async () => {
      mockResponse(
        sseEvent('response.completed', { response: { status: 'completed' } }),
      );
      const pipeline = new ResponsesPipeline(
        makeGeneratorConfig(),
        makeCliConfig(),
      );
      for await (const _ of pipeline.executeStream(requestWithTool(), 'p1')) {
        // drain
      }
      const body = JSON.parse(
        fetchMock.mock.calls[0]![1].body,
      ) as ResponsesApiRequest;
      expect(body.tool_choice).toBe('auto');
    });

    it('maps ANY to required, forcing a tool call', async () => {
      mockResponse(
        sseEvent('response.completed', { response: { status: 'completed' } }),
      );
      const pipeline = new ResponsesPipeline(
        makeGeneratorConfig(),
        makeCliConfig(),
      );
      for await (const _ of pipeline.executeStream(
        requestWithTool(FunctionCallingConfigMode.ANY),
        'p1',
      )) {
        // drain
      }
      const body = JSON.parse(
        fetchMock.mock.calls[0]![1].body,
      ) as ResponsesApiRequest;
      expect(body.tool_choice).toBe('required');
    });

    it('maps NONE to none', async () => {
      mockResponse(
        sseEvent('response.completed', { response: { status: 'completed' } }),
      );
      const pipeline = new ResponsesPipeline(
        makeGeneratorConfig(),
        makeCliConfig(),
      );
      for await (const _ of pipeline.executeStream(
        requestWithTool(FunctionCallingConfigMode.NONE),
        'p1',
      )) {
        // drain
      }
      const body = JSON.parse(
        fetchMock.mock.calls[0]![1].body,
      ) as ResponsesApiRequest;
      expect(body.tool_choice).toBe('none');
    });

    it('ignores functionCallingConfig.mode when there are no tools', async () => {
      mockResponse(
        sseEvent('response.completed', { response: { status: 'completed' } }),
      );
      const pipeline = new ResponsesPipeline(
        makeGeneratorConfig(),
        makeCliConfig(),
      );
      const request: GenerateContentParameters = {
        model: 'gpt-5',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        config: {
          toolConfig: {
            functionCallingConfig: { mode: FunctionCallingConfigMode.ANY },
          },
        },
      };
      for await (const _ of pipeline.executeStream(request, 'p1')) {
        // drain
      }
      const body = JSON.parse(
        fetchMock.mock.calls[0]![1].body,
      ) as ResponsesApiRequest;
      expect(body.tool_choice).toBe('auto');
    });
  });

  it('drops function_call items with no matching function_call_output before sending', async () => {
    mockResponse(
      sseEvent('response.completed', { response: { status: 'completed' } }),
    );
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig(),
      makeCliConfig(),
    );
    const request: GenerateContentParameters = {
      model: 'gpt-5',
      contents: [
        {
          role: 'model',
          parts: [{ functionCall: { id: 'call_1', name: 'f', args: {} } }],
        },
      ],
    };
    for await (const _ of pipeline.executeStream(request, 'p1')) {
      // drain
    }
    const body = JSON.parse(
      fetchMock.mock.calls[0]![1].body,
    ) as ResponsesApiRequest;
    expect(body.input).toEqual([]);
  });

  it('throws a descriptive error on a non-ok HTTP response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"bad request"}',
    });
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig(),
      makeCliConfig(),
    );
    await expect(async () => {
      for await (const _ of pipeline.executeStream(textRequest('hi'), 'p1')) {
        // drain
      }
    }).rejects.toThrow(/Responses API error 400/);
  });

  it('execute() merges all streamed chunks into a single response', async () => {
    mockResponse([
      ...sseEvent('response.output_text.delta', { delta: 'foo' }),
      ...sseEvent('response.output_text.delta', { delta: 'bar' }),
      ...sseEvent('response.completed', {
        response: {
          status: 'completed',
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        },
      }),
    ]);
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig(),
      makeCliConfig(),
    );
    const result = await pipeline.execute(textRequest('hi'), 'p1');
    expect(result.candidates?.[0]?.content?.parts).toEqual([
      { text: 'foo' },
      { text: 'bar' },
    ]);
    expect(result.usageMetadata?.totalTokenCount).toBe(5);
  });

  it('parses data-only SSE frames (no event: line) -- the shape the Responses API actually emits', async () => {
    // Every other test builds frames with sseEvent(), which always prepends
    // an `event: ` line, so it never exercises the data-only branch that
    // parses `data['type']` directly and handles `[DONE]`. A regression
    // there would leave the whole suite green while breaking every real
    // OpenAI call.
    const dataOnlyLines = [
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' })}`,
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: { id: 'r1', status: 'completed' },
      })}`,
      'data: [DONE]',
    ];
    mockResponse(dataOnlyLines);
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig(),
      makeCliConfig(),
    );
    const chunks = [];
    for await (const chunk of pipeline.executeStream(
      textRequest('hello'),
      'prompt-1',
    )) {
      chunks.push(chunk);
    }
    expect(chunks.map((c) => c.candidates?.[0]?.content?.parts)).toEqual([
      [{ text: 'hi' }],
      [],
    ]);
  });

  it('parses data-only SSE frames split across multiple reader.read() chunks', async () => {
    const dataOnlyLines = [
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' })}`,
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: { id: 'r1', status: 'completed' },
      })}`,
    ];
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: sseStreamChunked(dataOnlyLines, 5),
      text: async () => '',
    });
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig(),
      makeCliConfig(),
    );
    const chunks = [];
    for await (const chunk of pipeline.executeStream(
      textRequest('hello'),
      'prompt-1',
    )) {
      chunks.push(chunk);
    }
    expect(chunks.map((c) => c.candidates?.[0]?.content?.parts)).toEqual([
      [{ text: 'hi' }],
      [],
    ]);
  });

  it('recovers the final frame when the stream ends mid-line with no trailing newline', async () => {
    // Distinct from a stream missing only its trailing blank-line
    // terminator: here the connection drops before any newline at all
    // follows the last `data: ` line, so it is never split out of
    // `buffer` by `buffer.split('\n')` and never reaches the main
    // per-line loop. Without handling this, `currentEventType` is set
    // but `dataAccumulator` stays empty, and the post-loop flush (gated
    // on `currentEventType && dataAccumulator`) silently drops the frame.
    const body = [
      'event: response.completed',
      `data: ${JSON.stringify({ response: { id: 'r1', status: 'completed' } })}`,
    ].join('\n'); // no trailing newline
    const encoder = new TextEncoder();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(body));
          controller.close();
        },
      }),
      text: async () => '',
    });
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig(),
      makeCliConfig(),
    );
    const chunks = [];
    for await (const chunk of pipeline.executeStream(
      textRequest('hello'),
      'prompt-1',
    )) {
      chunks.push(chunk);
    }
    expect(chunks.map((c) => c.candidates?.[0]?.content?.parts)).toEqual([[]]);
  });

  it('parses correctly when frames are split across multiple reader.read() chunks', async () => {
    const lines = [
      ...sseEvent('response.output_text.delta', { delta: 'foo' }),
      ...sseEvent('response.reasoning_summary_text.delta', { delta: 'why' }),
      ...sseEvent('response.output_item.done', {
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"path":"a.ts"}',
        },
      }),
      ...sseEvent('response.completed', {
        response: {
          status: 'completed',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      }),
    ];
    // 5-byte chunks guarantee every "event: "/"data: " line and the JSON
    // payload itself get split mid-token across reads.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: sseStreamChunked(lines, 5),
      text: async () => '',
    });
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig(),
      makeCliConfig(),
    );
    const result = await pipeline.execute(textRequest('hi'), 'p1');
    expect(result.candidates?.[0]?.content?.parts).toEqual([
      { text: 'foo' },
      { text: 'why', thought: true },
      {
        functionCall: {
          id: 'call_1',
          name: 'read_file',
          args: { path: 'a.ts' },
        },
      },
    ]);
    expect(result.usageMetadata?.totalTokenCount).toBe(2);
  });

  // --- Critical (a): per-send window-clamped output budget (#5950) ---

  it('sends request.config.maxOutputTokens as max_output_tokens when no samplingParams cap is set', async () => {
    mockResponse(
      sseEvent('response.completed', { response: { status: 'completed' } }),
    );
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig(),
      makeCliConfig(),
    );
    const request: GenerateContentParameters = {
      model: 'gpt-5',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      config: { maxOutputTokens: 512 },
    };
    for await (const _ of pipeline.executeStream(request, 'p1')) {
      // drain
    }
    const body = JSON.parse(
      fetchMock.mock.calls[0]![1].body,
    ) as ResponsesApiRequest;
    expect(body.max_output_tokens).toBe(512);
  });

  it('lets request.config.maxOutputTokens override the static samplingParams.max_tokens', async () => {
    mockResponse(
      sseEvent('response.completed', { response: { status: 'completed' } }),
    );
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig({ samplingParams: { max_tokens: 2048 } }),
      makeCliConfig(),
    );
    const request: GenerateContentParameters = {
      model: 'gpt-5',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      config: { maxOutputTokens: 512 },
    };
    for await (const _ of pipeline.executeStream(request, 'p1')) {
      // drain
    }
    const body = JSON.parse(
      fetchMock.mock.calls[0]![1].body,
    ) as ResponsesApiRequest;
    expect(body.max_output_tokens).toBe(512);
  });

  // --- Critical (b): mid-stream idle-timeout watchdog ---

  it('fails a silent mid-stream stall with a retryable ETIMEDOUT after the idle timeout', async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      // Emit one delta frame, then go silent forever: the never-resolving
      // pull() keeps the second reader.read() pending so only the idle
      // watchdog can end the stream.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: 'response.output_text.delta',
                delta: 'hi',
              })}\n`,
            ),
          );
        },
        pull() {
          return new Promise<void>(() => {});
        },
      });
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        body,
        text: async () => '',
      });
      const pipeline = new ResponsesPipeline(
        makeGeneratorConfig({ streamIdleTimeoutMs: 1000 }),
        makeCliConfig(),
      );
      const gen = pipeline.executeStream(textRequest('hi'), 'p1');
      const first = await gen.next();
      expect(first.value?.candidates?.[0]?.content?.parts).toEqual([
        { text: 'hi' },
      ]);
      const pending = gen.next();
      // eslint-disable-next-line vitest/valid-expect -- awaited via `assertion` below, after the fake timers advance (handler attached early so the timeout rejection is not unhandled)
      const assertion = expect(pending).rejects.toBeInstanceOf(
        StreamInactivityTimeoutError,
      );
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire the idle watchdog while chunks keep arriving', async () => {
    // A fully delivered, promptly-closing stream must complete cleanly even
    // with a tiny idle timeout configured -- the timer resets per chunk and
    // the terminal `done` resolves before it can fire.
    mockResponse([
      ...sseEvent('response.output_text.delta', { delta: 'foo' }),
      ...sseEvent('response.completed', { response: { status: 'completed' } }),
    ]);
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig({ streamIdleTimeoutMs: 1000 }),
      makeCliConfig(),
    );
    const chunks = [];
    for await (const chunk of pipeline.executeStream(textRequest('hi'), 'p1')) {
      chunks.push(chunk);
    }
    expect(chunks.map((c) => c.candidates?.[0]?.content?.parts)).toEqual([
      [{ text: 'foo' }],
      [],
    ]);
  });

  // --- Critical (c): eager connect so retryWithBackoff sees connect errors ---

  it('connectStream performs the fetch eagerly, before the body is iterated', async () => {
    mockResponse([
      ...sseEvent('response.output_text.delta', { delta: 'hi' }),
      ...sseEvent('response.completed', { response: { status: 'completed' } }),
    ]);
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig(),
      makeCliConfig(),
    );
    const gen = await pipeline.connectStream(textRequest('hi'), 'p1');
    // Network I/O already happened while awaiting the returned promise -- a
    // lazy `async *` generator would leave this at 0 until the first next().
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for await (const _ of gen) {
      // drain
    }
  });

  it('connectStream rejects on a connection-time HTTP error so retry sees it', async () => {
    // A 5xx at request time must reject the awaited promise (which
    // generateContentStream returns into retryWithBackoff) rather than
    // escaping later during lazy iteration outside the retry wrapper.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => '{"error":"server"}',
    });
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig(),
      makeCliConfig(),
    );
    await expect(
      pipeline.connectStream(textRequest('hi'), 'p1'),
    ).rejects.toThrow(/Responses API error 500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // --- Suggestions: previously untested added behavior ---

  it('accumulates a multi-line data: block (joined with \\n) into a single frame', async () => {
    // Every other test emits exactly one data: line per event, so the
    // `event: ` + multi-`data:` accumulation path never runs; a last-line-wins
    // mutant would silently drop a split frame.
    const lines = [
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta",',
      'data: "delta":"multi"}',
      '',
    ];
    mockResponse(lines);
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig(),
      makeCliConfig(),
    );
    const chunks = [];
    for await (const chunk of pipeline.executeStream(textRequest('hi'), 'p1')) {
      chunks.push(chunk);
    }
    expect(chunks.map((c) => c.candidates?.[0]?.content?.parts)).toEqual([
      [{ text: 'multi' }],
    ]);
  });

  it('decodes multi-byte UTF-8 split across reader.read() chunks', async () => {
    // JSON.stringify emits raw (unescaped) non-ASCII, so byte-chunking splits
    // real multi-byte characters across reads -- exercising the decoder's
    // { stream: true } flag. Dropping it corrupts split code points to U+FFFD.
    const text = '你好😀世界';
    const lines = [
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}`,
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: { id: 'r1', status: 'completed' },
      })}`,
    ];
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: sseStreamChunked(lines, 3),
      text: async () => '',
    });
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig(),
      makeCliConfig(),
    );
    const chunks = [];
    for await (const chunk of pipeline.executeStream(textRequest('hi'), 'p1')) {
      chunks.push(chunk);
    }
    expect(chunks[0]?.candidates?.[0]?.content?.parts).toEqual([{ text }]);
  });

  it('does not let extra_body overwrite an explicit samplingParams.temperature of 0', async () => {
    mockResponse(
      sseEvent('response.completed', { response: { status: 'completed' } }),
    );
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig({
        samplingParams: { temperature: 0 },
        extra_body: { temperature: 1 },
      }),
      makeCliConfig(),
    );
    for await (const _ of pipeline.executeStream(textRequest('hi'), 'p1')) {
      // drain
    }
    const body = JSON.parse(
      fetchMock.mock.calls[0]![1].body,
    ) as ResponsesApiRequest;
    // The production guard checks `requestRecord[key] === undefined`, so an
    // explicit 0 is preserved; a truthiness guard would let extra_body win.
    expect(body.temperature).toBe(0);
  });

  it('propagates responseId and finishReason through execute()/mergeStreamResponses', async () => {
    mockResponse([
      ...sseEvent('response.output_text.delta', { delta: 'foo' }),
      ...sseEvent('response.completed', {
        response: {
          id: 'r1',
          status: 'completed',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      }),
    ]);
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig(),
      makeCliConfig(),
    );
    const result = await pipeline.execute(textRequest('hi'), 'p1');
    expect(result.responseId).toBe('r1');
    expect(result.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
  });

  it('applies customHeaders to the fetch request', async () => {
    mockResponse(
      sseEvent('response.completed', { response: { status: 'completed' } }),
    );
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig({ customHeaders: { 'X-Proxy-Auth': 'token' } }),
      makeCliConfig(),
    );
    for await (const _ of pipeline.executeStream(textRequest('hi'), 'p1')) {
      // drain
    }
    expect(fetchMock.mock.calls[0]![1].headers['X-Proxy-Auth']).toBe('token');
  });

  it('forwards the exact AbortSignal to fetch', async () => {
    const controller = new AbortController();
    mockResponse(
      sseEvent('response.completed', { response: { status: 'completed' } }),
    );
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig(),
      makeCliConfig(),
    );
    for await (const _ of pipeline.executeStream(
      textRequest('hi'),
      'p1',
      controller.signal,
    )) {
      // drain
    }
    expect(fetchMock.mock.calls[0]![1].signal).toBe(controller.signal);
  });

  it('aborts the read loop when the AbortSignal fires mid-stream', async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller.signal.addEventListener('abort', () =>
          c.error(new DOMException('Aborted', 'AbortError')),
        );
      },
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body,
      text: async () => '',
    });
    // Idle watchdog off so the abort, not the timer, is what ends the stream.
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig({ streamIdleTimeoutMs: 0 }),
      makeCliConfig(),
    );
    const gen = pipeline.executeStream(
      textRequest('hi'),
      'p1',
      controller.signal,
    );
    const pending = gen.next();
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow(/Abort/);
  });

  it('forwards the runtime dispatcher to fetch', async () => {
    const dispatcher = { marker: 'dispatcher' };
    buildRuntimeFetchOptionsMock.mockReturnValue({
      fetch: fetchMock,
      fetchOptions: { dispatcher },
    });
    mockResponse(
      sseEvent('response.completed', { response: { status: 'completed' } }),
    );
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig(),
      makeCliConfig(),
    );
    for await (const _ of pipeline.executeStream(textRequest('hi'), 'p1')) {
      // drain
    }
    expect(fetchMock.mock.calls[0]![1].dispatcher).toBe(dispatcher);
  });

  it('redacts proxy credentials from a fetch rejection', async () => {
    fetchMock.mockRejectedValue(
      new Error('fetch failed http://user:secret@proxy.example:8080'),
    );
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig(),
      makeCliConfig(),
    );
    let caught: unknown;
    try {
      for await (const _ of pipeline.executeStream(textRequest('hi'), 'p1')) {
        // drain
      }
    } catch (err) {
      caught = err;
    }
    const message = (caught as Error).message;
    expect(message).toMatch(/<redacted>@proxy\.example/);
    expect(message).not.toContain('secret');
  });

  it('rejects a 200 response whose content-type is not SSE', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      body: sseStream(
        sseEvent('response.completed', { response: { status: 'completed' } }),
      ),
      text: async () => '',
    });
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig(),
      makeCliConfig(),
    );
    await expect(async () => {
      for await (const _ of pipeline.executeStream(textRequest('hi'), 'p1')) {
        // drain
      }
    }).rejects.toThrow(/non-SSE content-type/);
  });

  it('skips an unparseable data: frame and still yields the surrounding valid events', async () => {
    const lines = [
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'a' })}`,
      'data: {not valid json',
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'b' })}`,
      'data: [DONE]',
    ];
    mockResponse(lines);
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig(),
      makeCliConfig(),
    );
    const chunks = [];
    for await (const chunk of pipeline.executeStream(textRequest('hi'), 'p1')) {
      chunks.push(chunk);
    }
    expect(chunks.map((c) => c.candidates?.[0]?.content?.parts)).toEqual([
      [{ text: 'a' }],
      [{ text: 'b' }],
    ]);
  });

  it('mergeStreamResponses([]) returns an empty candidates array, not undefined', () => {
    const merged = mergeStreamResponses([]);
    expect(merged.candidates).toEqual([]);
  });
});
