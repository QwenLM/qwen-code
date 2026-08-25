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
  StreamLifetimeExceededError,
  StreamConnectTimeoutError,
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

// A byte ReadableStream whose reads block until a chunk is pushed (or it is
// ended), so a test can drip-feed frames on fake-timer boundaries and exercise
// the idle watchdog / lifetime cap without ever hanging: an unpushed read stays
// pending, and enqueue/close resolve it. Each pushed line gets its own trailing
// newline so it parses as a complete data-only SSE frame.
function gatedByteStream(): {
  stream: ReadableStream<Uint8Array>;
  push: (dataLine: string) => void;
  end: () => void;
} {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push(dataLine: string) {
      controller.enqueue(encoder.encode(dataLine + '\n'));
    },
    end() {
      controller.close();
    },
  };
}

function makeCliConfig(proxy?: string, sessionId = ''): Config {
  // Config.getSessionId() is typed `string` and never returns undefined, so
  // the mock must not either -- the reachable "no usable session" state is
  // the empty string.
  return {
    getProxy: () => proxy,
    getSessionId: () => sessionId,
  } as unknown as Config;
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
    // Pin the explicit Content-Type: undici defaults a string body to
    // text/plain;charset=UTF-8 when it is absent, which strict
    // OpenAI-compatible gateways reject with 415/400.
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body) as ResponsesApiRequest;
    expect(body.model).toBe('gpt-5');
    expect(body.stream).toBe(true);
    // We never reference previous_response_id, so nothing benefits from
    // server-side storage; the spec pairs this with reasoning.encrypted_content
    // as the intended stateless-replay recipe.
    expect(body.store).toBe(false);
    // A toolless request must NOT carry tool_choice or parallel_tool_calls --
    // strict endpoints 400 a tool_choice with no `tools` key (compaction and
    // text-mode side queries take this path).
    expect(body.tool_choice).toBeUndefined();
    expect(body.parallel_tool_calls).toBeUndefined();
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: 'hello' },
    ]);

    expect(chunks.map((c) => c.candidates?.[0]?.content?.parts)).toEqual([
      [{ text: 'hi' }],
      [],
    ]);
  });

  it('keys prompt_cache_key on the session so it stays stable across turns', async () => {
    // userPromptId is `${sessionId}########${counter}` and changes on every
    // send, so keying on it directly gives each turn its own cache namespace
    // and no request can hit the prefix cache the previous one wrote. Nothing
    // errors when that happens -- the loss is pure cost and latency, which is
    // exactly why it needs a test rather than being noticed in use. Matches
    // the Chat wire's `qwen-code:${sessionId}` key (prefix-caching.ts).
    const keys: Array<string | undefined> = [];
    for (const turn of ['sess-abc########1', 'sess-abc########2']) {
      fetchMock.mockClear();
      mockResponse(
        sseEvent('response.completed', { response: { status: 'completed' } }),
      );
      const pipeline = new ResponsesPipeline(
        makeGeneratorConfig(),
        makeCliConfig(undefined, 'sess-abc'),
      );
      for await (const _ of pipeline.executeStream(textRequest('hi'), turn)) {
        // drain
      }
      keys.push(
        (JSON.parse(fetchMock.mock.calls[0]![1].body) as ResponsesApiRequest)
          .prompt_cache_key,
      );
    }

    expect(keys[0]).toBe('qwen-code:sess-abc');
    expect(keys[1]).toBe(keys[0]);
  });

  it('falls back to userPromptId as prompt_cache_key when the session id is empty', async () => {
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

    it('translates a legacy extra_body.enable_thinking into reasoning.effort=medium and strips it from the wire body', async () => {
      mockResponse(
        sseEvent('response.completed', { response: { status: 'completed' } }),
      );
      const pipeline = new ResponsesPipeline(
        makeGeneratorConfig({
          extra_body: { enable_thinking: true },
        }),
        makeCliConfig(),
      );
      for await (const _ of pipeline.executeStream(textRequest('hi'), 'p1')) {
        // drain
      }
      const body = JSON.parse(fetchMock.mock.calls[0]![1].body) as Record<
        string,
        unknown
      >;
      expect(body['reasoning']).toEqual({ effort: 'medium', summary: 'auto' });
      expect(body['include']).toEqual(['reasoning.encrypted_content']);
      // `enable_thinking` has no meaning on this wire; it must never appear
      // top-level on the request, translated or not.
      expect(body['enable_thinking']).toBeUndefined();
    });

    it('prefers an explicit reasoning.effort over a legacy extra_body.enable_thinking', async () => {
      mockResponse(
        sseEvent('response.completed', { response: { status: 'completed' } }),
      );
      const pipeline = new ResponsesPipeline(
        makeGeneratorConfig({
          reasoning: { effort: 'high' },
          extra_body: { enable_thinking: true },
        }),
        makeCliConfig(),
      );
      for await (const _ of pipeline.executeStream(textRequest('hi'), 'p1')) {
        // drain
      }
      const body = JSON.parse(
        fetchMock.mock.calls[0]![1].body,
      ) as ResponsesApiRequest;
      expect(body.reasoning).toEqual({ effort: 'high', summary: 'auto' });
    });

    it('omits reasoning when reasoning is false even with a legacy extra_body.enable_thinking set', async () => {
      mockResponse(
        sseEvent('response.completed', { response: { status: 'completed' } }),
      );
      const pipeline = new ResponsesPipeline(
        makeGeneratorConfig({
          reasoning: false,
          extra_body: { enable_thinking: true },
        }),
        makeCliConfig(),
      );
      for await (const _ of pipeline.executeStream(textRequest('hi'), 'p1')) {
        // drain
      }
      const body = JSON.parse(fetchMock.mock.calls[0]![1].body) as Record<
        string,
        unknown
      >;
      expect(body['reasoning']).toBeUndefined();
      expect(body['include']).toBeUndefined();
      expect(body['enable_thinking']).toBeUndefined();
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
      // parallel_tool_calls is stamped only alongside tools; pin it here so a
      // regression dropping it (degrading fan-out to sequential calls) fails.
      expect(body.parallel_tool_calls).toBe(true);
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

    it('omits tool_choice and parallel_tool_calls entirely when there are no tools, even with functionCallingConfig.mode set', async () => {
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
      // No tools -> neither field is sent (a mode with no tools must not
      // resurrect them); strict endpoints reject tool_choice without `tools`.
      expect(body.tool_choice).toBeUndefined();
      expect(body.parallel_tool_calls).toBeUndefined();
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

  it('throws a descriptive error carrying the body excerpt and stamps .status on a non-ok HTTP response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"bad request"}',
    });
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
    // The body excerpt is the only carrier of the API's reason (invalid schema,
    // quota, model-not-found); a refactor dropping it must fail here.
    expect((caught as Error).message).toMatch(
      /Responses API error 400: .*bad request/,
    );
    // The .status stamp is what geminiChat's shouldRetryOnError -> getErrorStatus
    // reads to fail-fast/retry connection-time errors; a plain Error carries none.
    expect((caught as { status?: number }).status).toBe(400);
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

  it('keeps the configured samplingParams.max_tokens ceiling when the per-send maxOutputTokens is larger (smaller wins)', async () => {
    // C5 regression: the per-send window-clamped value must NOT reopen a
    // smaller user-configured max_tokens ceiling. reconcileMaxTokens (the
    // shared "smaller wins" invariant both sibling wires call) picks the
    // minimum, so config 1000 caps a per-send 8000. A plain `?? ` precedence
    // (request first) would leak 8000.
    mockResponse(
      sseEvent('response.completed', { response: { status: 'completed' } }),
    );
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig({ samplingParams: { max_tokens: 1000 } }),
      makeCliConfig(),
    );
    const request: GenerateContentParameters = {
      model: 'gpt-5',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      config: { maxOutputTokens: 8000 },
    };
    for await (const _ of pipeline.executeStream(request, 'p1')) {
      // drain
    }
    const body = JSON.parse(
      fetchMock.mock.calls[0]![1].body,
    ) as ResponsesApiRequest;
    expect(body.max_output_tokens).toBe(1000);
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
      // Pin the code field too: getTransportCode reads `.code` off the error
      // chain to classify the stall as a retryable transport error; a mutant
      // dropping/renaming it passes the instanceof check but silently makes
      // the stall non-retryable for every downstream consumer.
      // eslint-disable-next-line vitest/valid-expect -- same deferred-await pattern as above
      const codeAssertion = expect(pending).rejects.toMatchObject({
        code: 'ETIMEDOUT',
      });
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      await codeAssertion;
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

  it('resets the idle timer on each chunk and completes a slow-but-active stream', async () => {
    // The watchdog arms a fresh timer inside every readChunk(), so a stream
    // that keeps delivering deltas is never interrupted even when its total
    // duration far exceeds the idle window. A mutant arming a single timer
    // once at stream start would fail this (it fires at t=1000 mid-stream).
    vi.useFakeTimers();
    try {
      const gated = gatedByteStream();
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        body: gated.stream,
        text: async () => '',
      });
      const pipeline = new ResponsesPipeline(
        makeGeneratorConfig({ streamIdleTimeoutMs: 1000 }),
        makeCliConfig(),
      );
      const chunks: unknown[] = [];
      let error: unknown;
      const consume = (async () => {
        for await (const chunk of pipeline.executeStream(
          textRequest('hi'),
          'p1',
        )) {
          chunks.push(chunk);
        }
      })().catch((e: unknown) => {
        error = e;
      });
      // A chunk every 800ms (< 1000ms idle) across 2400ms total: each drip
      // resets the idle timer, so it must never fire.
      await vi.advanceTimersByTimeAsync(800);
      gated.push(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'a' })}`,
      );
      await vi.advanceTimersByTimeAsync(800);
      gated.push(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'b' })}`,
      );
      await vi.advanceTimersByTimeAsync(800);
      gated.push(
        `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}`,
      );
      gated.end();
      await consume;
      expect(error).toBeUndefined();
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      // A late advance after completion must not produce a delayed throw.
      await vi.advanceTimersByTimeAsync(5000);
    } finally {
      vi.useRealTimers();
    }
  });

  // --- Critical: total-lifetime cap (issue #8597) ---

  it('caps the total stream lifetime even when chunks keep resetting the idle watchdog (issue #8597)', async () => {
    vi.useFakeTimers();
    try {
      const gated = gatedByteStream(); // drip-fed, never ends
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        body: gated.stream,
        text: async () => '',
      });
      const pipeline = new ResponsesPipeline(
        makeGeneratorConfig({
          streamIdleTimeoutMs: 1000,
          streamMaxLifetimeMs: 3000,
        }),
        makeCliConfig(),
      );
      let error: unknown;
      const consume = (async () => {
        for await (const _ of pipeline.executeStream(textRequest('hi'), 'p1')) {
          /* drain */
        }
      })().catch((e: unknown) => {
        error = e;
      });
      // A chunk every 500ms: every drip resets the 1s idle watchdog, so it can
      // never fire (the CI-hang shape). The 3s lifetime cap does NOT reset.
      for (let i = 0; i < 5; i++) {
        gated.push(
          `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'x' })}`,
        );
        await vi.advanceTimersByTimeAsync(500);
      }
      await vi.advanceTimersByTimeAsync(1000); // push past the cap
      await consume;
      expect(error).toBeInstanceOf(StreamLifetimeExceededError);
      expect(error).toMatchObject({ code: 'ETIMEDOUT' });
      expect((error as StreamLifetimeExceededError).maxLifetimeMs).toBe(3000);
      expect((error as Error).message).toContain('QWEN_STREAM_MAX_LIFETIME_MS');
    } finally {
      vi.useRealTimers();
    }
  }, 15000);

  it('does not interrupt a drip-fed stream that completes within the lifetime cap', async () => {
    vi.useFakeTimers();
    try {
      const gated = gatedByteStream();
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        body: gated.stream,
        text: async () => '',
      });
      const pipeline = new ResponsesPipeline(
        makeGeneratorConfig({
          streamIdleTimeoutMs: 1000,
          streamMaxLifetimeMs: 3000,
        }),
        makeCliConfig(),
      );
      let done = false;
      let error: unknown;
      const consume = (async () => {
        for await (const _ of pipeline.executeStream(textRequest('hi'), 'p1')) {
          /* drain */
        }
      })().then(
        () => (done = true),
        (e: unknown) => (error = e),
      );
      gated.push(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'a' })}`,
      );
      await vi.advanceTimersByTimeAsync(500);
      gated.push(
        `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}`,
      );
      gated.end(); // completes at t=500, well under the 3s cap
      await consume;
      expect(error).toBeUndefined();
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  }, 15000);

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
    const err = await pipeline
      .connectStream(textRequest('hi'), 'p1')
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/Responses API error 500: .*server/);
    // .status must be stamped so a connection-time 5xx is retryable on this
    // wire (getErrorStatus reads it); without it retry never triggers.
    expect((err as { status?: number }).status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects the connect phase with a retryable ETIMEDOUT when headers never arrive within the timeout', async () => {
    // C3 regression: fetch resolves only when response headers arrive, so a
    // hung LB / tarpitting proxy that completes TCP/TLS but never sends headers
    // would block the turn forever (the idle watchdog only wraps reader.read(),
    // which runs after connect resolves). The connect-phase timeout (driven by
    // ContentGeneratorConfig.timeout) must reject instead.
    vi.useFakeTimers();
    try {
      let fetchSignal: AbortSignal | undefined;
      fetchMock.mockImplementation((_url: string, init: RequestInit) => {
        fetchSignal = init.signal ?? undefined;
        // Never resolves on its own: only the connect timeout can end this.
        return new Promise<never>(() => {});
      });
      const pipeline = new ResponsesPipeline(
        makeGeneratorConfig({ timeout: 1000 }),
        makeCliConfig(),
      );
      const pending = pipeline
        .connectStream(textRequest('hi'), 'p1')
        .then(() => undefined)
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1000);
      const err = await pending;
      expect(err).toBeInstanceOf(StreamConnectTimeoutError);
      expect(err).toMatchObject({ code: 'ETIMEDOUT' });
      expect((err as StreamConnectTimeoutError).connectTimeoutMs).toBe(1000);
      // The timeout also aborts the in-flight fetch so the socket is freed.
      expect(fetchSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  }, 15000);

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

  it('forwards user aborts to fetch via a composed connect signal', async () => {
    // The connect phase composes the caller's signal with a connect-timeout
    // controller (so a timeout can also abort the fetch), so fetch no longer
    // receives the exact user signal object -- it receives one that aborts when
    // the user signal aborts. Pin the propagation, not the identity.
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
    const passed = fetchMock.mock.calls[0]![1].signal as AbortSignal;
    expect(passed).toBeInstanceOf(AbortSignal);
    expect(passed.aborted).toBe(false);
    controller.abort();
    expect(passed.aborted).toBe(true);
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

  it('rejects a 200 SSE response that carries no body', async () => {
    // The no-body guard is the one connect-phase validation with no test; a
    // gateway returning 200 + empty body would otherwise crash the turn with a
    // bare TypeError (reading getReader) instead of this classifiable error.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: undefined,
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
    }).rejects.toThrow(/returned no body/);
  });

  it('passes the configured proxy through to buildRuntimeFetchOptions', async () => {
    // The explicit-proxy hand-off is ungated by any assertion; a refactor
    // dropping the getProxy() argument would silently send Responses requests
    // direct in proxy-required environments. Pin the exact call.
    mockResponse(
      sseEvent('response.completed', { response: { status: 'completed' } }),
    );
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig(),
      makeCliConfig('http://proxy.example:8080'),
    );
    for await (const _ of pipeline.executeStream(textRequest('hi'), 'p1')) {
      // drain
    }
    expect(buildRuntimeFetchOptionsMock).toHaveBeenCalledWith(
      'openai',
      'http://proxy.example:8080',
    );
  });

  it('builds the Authorization header from apiKeyEnvKey when apiKey is unset', async () => {
    // The request-time env fallback is exercised by zero fixtures (all hardcode
    // apiKey). Unlike the embed client, this pipeline builds the header by raw
    // fetch, so there is no SDK self-heal: a config with only apiKeyEnvKey must
    // still authenticate.
    const prev = process.env['RESP_TEST_KEY'];
    process.env['RESP_TEST_KEY'] = 'env-secret';
    try {
      mockResponse(
        sseEvent('response.completed', { response: { status: 'completed' } }),
      );
      const pipeline = new ResponsesPipeline(
        makeGeneratorConfig({
          apiKey: undefined,
          apiKeyEnvKey: 'RESP_TEST_KEY',
        }),
        makeCliConfig(),
      );
      for await (const _ of pipeline.executeStream(textRequest('hi'), 'p1')) {
        // drain
      }
      expect(fetchMock.mock.calls[0]![1].headers['Authorization']).toBe(
        'Bearer env-secret',
      );
    } finally {
      if (prev === undefined) delete process.env['RESP_TEST_KEY'];
      else process.env['RESP_TEST_KEY'] = prev;
    }
  });

  it('sends no Authorization header when neither apiKey nor apiKeyEnvKey resolves', async () => {
    const prev = process.env['RESP_TEST_KEY_MISSING'];
    delete process.env['RESP_TEST_KEY_MISSING'];
    try {
      mockResponse(
        sseEvent('response.completed', { response: { status: 'completed' } }),
      );
      const pipeline = new ResponsesPipeline(
        makeGeneratorConfig({
          apiKey: undefined,
          apiKeyEnvKey: 'RESP_TEST_KEY_MISSING',
        }),
        makeCliConfig(),
      );
      for await (const _ of pipeline.executeStream(textRequest('hi'), 'p1')) {
        // drain
      }
      expect(
        fetchMock.mock.calls[0]![1].headers['Authorization'],
      ).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env['RESP_TEST_KEY_MISSING'] = prev;
    }
  });

  it('treats an empty-string baseUrl as unset and falls back to the default origin', async () => {
    // The round-1 empty-string baseUrl shape: `'' || default` must resolve to
    // api.openai.com rather than producing `/v1/responses` against no origin.
    mockResponse(
      sseEvent('response.completed', { response: { status: 'completed' } }),
    );
    const pipeline = new ResponsesPipeline(
      makeGeneratorConfig({ baseUrl: '' }),
      makeCliConfig(),
    );
    for await (const _ of pipeline.executeStream(textRequest('hi'), 'p1')) {
      // drain
    }
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://api.openai.com/v1/responses',
    );
  });

  it('mergeStreamResponses([]) returns an empty candidates array, not undefined', () => {
    const merged = mergeStreamResponses([]);
    expect(merged.candidates).toEqual([]);
  });

  // Issue #9452: an already-persisted session replays prior-turn reasoning
  // items by id. When the ACTIVE endpoint refuses those ids as too long, every
  // send in that session fails forever -- the history is on disk and every
  // rebuild produces the same rejected ids. These exercise recovery entirely
  // through the public pipeline/fetch seam. All ids and encrypted payloads are
  // synthetic.
  describe('reasoning id rejection recovery', () => {
    const LONG_ID_A = `rs_${'a'.repeat(80)}`;
    const LONG_ID_B = `rs_${'b'.repeat(80)}`;
    const SHORT_ID = 'rs_short';

    function sig(id: string): string {
      return JSON.stringify({ id, encrypted_content: `enc-${id}` });
    }

    // Input items this produces, in order:
    //   0 message(user)     1 reasoning(LONG_ID_A, summary)
    //   2 reasoning(SHORT_ID, summary)  3 reasoning(LONG_ID_B, no summary)
    //   4 message(user)
    function replayRequest(): GenerateContentParameters {
      return {
        model: 'gpt-5',
        contents: [
          { role: 'user', parts: [{ text: 'hello' }] },
          {
            role: 'model',
            parts: [
              {
                thought: true,
                text: 'first thought',
                thoughtSignature: sig(LONG_ID_A),
              },
              {
                thought: true,
                text: 'second thought',
                thoughtSignature: sig(SHORT_ID),
              },
              { thought: true, thoughtSignature: sig(LONG_ID_B) },
            ],
          },
          { role: 'user', parts: [{ text: 'continue' }] },
        ],
      };
    }

    const ORIGINAL_INPUT = [
      { type: 'message', role: 'user', content: 'hello' },
      {
        type: 'reasoning',
        id: LONG_ID_A,
        encrypted_content: `enc-${LONG_ID_A}`,
        summary: [{ type: 'summary_text', text: 'first thought' }],
      },
      {
        type: 'reasoning',
        id: SHORT_ID,
        encrypted_content: `enc-${SHORT_ID}`,
        summary: [{ type: 'summary_text', text: 'second thought' }],
      },
      {
        type: 'reasoning',
        id: LONG_ID_B,
        encrypted_content: `enc-${LONG_ID_B}`,
        summary: [],
      },
      { type: 'message', role: 'user', content: 'continue' },
    ];

    // Only the two over-long ids are downgraded; the short reasoning item is
    // replayed untouched. The signature-only item has no summary to preserve
    // and is dropped rather than becoming an empty assistant message.
    const OVER_LONG_ONLY_INPUT = [
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'message', role: 'assistant', content: 'first thought' },
      {
        type: 'reasoning',
        id: SHORT_ID,
        encrypted_content: `enc-${SHORT_ID}`,
        summary: [{ type: 'summary_text', text: 'second thought' }],
      },
      { type: 'message', role: 'user', content: 'continue' },
    ];

    const ALL_REASONING_INPUT = [
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'message', role: 'assistant', content: 'first thought' },
      { type: 'message', role: 'assistant', content: 'second thought' },
      { type: 'message', role: 'user', content: 'continue' },
    ];

    function errorResponse(status: number, body: string) {
      return {
        ok: false,
        status,
        headers: { get: () => 'application/json' },
        text: async () => body,
      };
    }

    function okResponse(lines: string[]) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        body: sseStream(lines),
        text: async () => '',
      };
    }

    const COMPLETED = sseEvent('response.completed', {
      response: { id: 'r1', status: 'completed' },
    });

    /** The shape the OpenAI Responses API returns directly. */
    function directBody(param: string, message: string): string {
      return JSON.stringify({
        error: {
          message,
          type: 'invalid_request_error',
          param,
          code: 'string_above_max_length',
        },
      });
    }

    /**
     * The shape a gateway returns: the upstream error JSON is embedded, quoted
     * and escaped, inside the proxy's own error message -- with a raw control
     * character spliced in, so `JSON.parse` on the whole body throws.
     */
    function proxiedBody(
      param: string,
      message: string,
      rawControlChar: string,
    ): string {
      const inner = JSON.stringify({
        error: {
          message,
          type: 'invalid_request_error',
          param,
          code: 'string_above_max_length',
        },
      });
      const escaped = inner.replace(/"/g, '\\"');
      return `{"error":{"message":"litellm.BadRequestError: OpenAIException -${rawControlChar}${escaped}","type":null,"param":null,"code":"400"}}`;
    }

    const MAX_64_MESSAGE =
      "Invalid 'input[1].id': string too long. Expected a string with " +
      'maximum length 64, but got a string with length 83 instead.';
    const NO_MAX_MESSAGE = "Invalid 'input[1].id': string too long.";

    async function drain(
      pipeline: ResponsesPipeline,
      request: GenerateContentParameters,
    ): Promise<unknown> {
      try {
        for await (const _ of pipeline.executeStream(request, 'p1')) {
          // drain
        }
        return undefined;
      } catch (err) {
        return err;
      }
    }

    function parsedCall(index: number): ResponsesApiRequest {
      return JSON.parse(
        fetchMock.mock.calls[index]![1].body,
      ) as ResponsesApiRequest;
    }

    /**
     * The first request must go out exactly as it does today, and the retry
     * must differ from it in `input` and nothing else.
     */
    function expectRetryDiffersOnlyByInput(retryInput: unknown) {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const first = parsedCall(0);
      const second = parsedCall(1);
      expect(first.input).toEqual(ORIGINAL_INPUT);
      expect(second.input).toEqual(retryInput);
      expect({ ...second, input: null }).toEqual({ ...first, input: null });
    }

    // ── RED behaviors ────────────────────────────────────────────────────

    it('downgrades every over-long reasoning id and retries when the endpoint reports a maximum', async () => {
      fetchMock.mockResolvedValueOnce(
        errorResponse(400, directBody('input[1].id', MAX_64_MESSAGE)),
      );
      fetchMock.mockResolvedValueOnce(okResponse(COMPLETED));
      const pipeline = new ResponsesPipeline(
        makeGeneratorConfig(),
        makeCliConfig(),
      );

      expect(await drain(pipeline, replayRequest())).toBeUndefined();
      expectRetryDiffersOnlyByInput(OVER_LONG_ONLY_INPUT);
    });

    it('downgrades every replayed reasoning item and retries when no maximum is reported', async () => {
      fetchMock.mockResolvedValueOnce(
        errorResponse(400, directBody('input[1].id', NO_MAX_MESSAGE)),
      );
      fetchMock.mockResolvedValueOnce(okResponse(COMPLETED));
      const pipeline = new ResponsesPipeline(
        makeGeneratorConfig(),
        makeCliConfig(),
      );

      expect(await drain(pipeline, replayRequest())).toBeUndefined();
      expectRetryDiffersOnlyByInput(ALL_REASONING_INPUT);
    });

    it('recovers when the rejection is nested in a proxied message carrying a raw newline', async () => {
      fetchMock.mockResolvedValueOnce(
        errorResponse(400, proxiedBody('input[1].id', MAX_64_MESSAGE, '\n')),
      );
      fetchMock.mockResolvedValueOnce(okResponse(COMPLETED));
      const pipeline = new ResponsesPipeline(
        makeGeneratorConfig(),
        makeCliConfig(),
      );

      expect(await drain(pipeline, replayRequest())).toBeUndefined();
      expectRetryDiffersOnlyByInput(OVER_LONG_ONLY_INPUT);
    });

    it('recovers when the rejection is nested in a proxied message carrying a raw tab', async () => {
      fetchMock.mockResolvedValueOnce(
        errorResponse(400, proxiedBody('input[1].id', MAX_64_MESSAGE, '\t')),
      );
      fetchMock.mockResolvedValueOnce(okResponse(COMPLETED));
      const pipeline = new ResponsesPipeline(
        makeGeneratorConfig(),
        makeCliConfig(),
      );

      expect(await drain(pipeline, replayRequest())).toBeUndefined();
      expectRetryDiffersOnlyByInput(OVER_LONG_ONLY_INPUT);
    });

    it('treats a maximum reported against a different parameter as absent', async () => {
      // The message names input[7].id but the rejected param is input[1].id --
      // trusting 64 here would keep replaying whichever ids happen to be
      // shorter than a limit that was never stated for this parameter.
      const foreign =
        "Invalid 'input[7].id': string too long. Expected a string with " +
        'maximum length 64, but got a string with length 83 instead.';
      fetchMock.mockResolvedValueOnce(
        errorResponse(400, directBody('input[1].id', foreign)),
      );
      fetchMock.mockResolvedValueOnce(okResponse(COMPLETED));
      const pipeline = new ResponsesPipeline(
        makeGeneratorConfig(),
        makeCliConfig(),
      );

      expect(await drain(pipeline, replayRequest())).toBeUndefined();
      expectRetryDiffersOnlyByInput(ALL_REASONING_INPUT);
    });

    it('treats a maximum reported against ambiguous parameters as absent', async () => {
      const ambiguous =
        "Invalid 'input[1].id' and 'input[3].id': strings too long. " +
        'Expected a string with maximum length 64.';
      fetchMock.mockResolvedValueOnce(
        errorResponse(400, directBody('input[1].id', ambiguous)),
      );
      fetchMock.mockResolvedValueOnce(okResponse(COMPLETED));
      const pipeline = new ResponsesPipeline(
        makeGeneratorConfig(),
        makeCliConfig(),
      );

      expect(await drain(pipeline, replayRequest())).toBeUndefined();
      expectRetryDiffersOnlyByInput(ALL_REASONING_INPUT);
    });

    it('retries exactly once and surfaces the second rejection unchanged', async () => {
      fetchMock.mockResolvedValueOnce(
        errorResponse(400, directBody('input[1].id', MAX_64_MESSAGE)),
      );
      fetchMock.mockResolvedValueOnce(
        errorResponse(
          400,
          directBody('input[1].id', `${MAX_64_MESSAGE} SECOND-ATTEMPT`),
        ),
      );
      fetchMock.mockResolvedValueOnce(okResponse(COMPLETED));
      const pipeline = new ResponsesPipeline(
        makeGeneratorConfig(),
        makeCliConfig(),
      );

      const err = await drain(pipeline, replayRequest());
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((err as Error | undefined)?.message).toContain('SECOND-ATTEMPT');
      expect((err as { status?: number }).status).toBe(400);
    });

    it('does not recover a second time when the retry is itself rejected', async () => {
      // The bound has to be structural, not incidental: after the first
      // recovery the surviving short reasoning item sits at input[2], so a
      // rejection naming IT with a smaller maximum is one this classifier
      // would happily act on. An implementation that recovered from inside
      // its own retry would send a third request here.
      fetchMock.mockResolvedValueOnce(
        errorResponse(400, directBody('input[1].id', MAX_64_MESSAGE)),
      );
      fetchMock.mockResolvedValueOnce(
        errorResponse(
          400,
          directBody(
            'input[2].id',
            "Invalid 'input[2].id': string too long. Expected a string with " +
              'maximum length 4, but got a string with length 8 instead.',
          ),
        ),
      );
      fetchMock.mockResolvedValueOnce(okResponse(COMPLETED));
      const pipeline = new ResponsesPipeline(
        makeGeneratorConfig(),
        makeCliConfig(),
      );

      const err = await drain(pipeline, replayRequest());
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((err as { status?: number }).status).toBe(400);
      expect((err as Error).message).toContain('input[2].id');
      expect(parsedCall(1).input).toEqual(OVER_LONG_ONLY_INPUT);
    });

    // ── Controls: every one of these must NOT retry ──────────────────────

    it('control: sends one request when the endpoint accepts the long ids', async () => {
      fetchMock.mockResolvedValueOnce(okResponse(COMPLETED));
      const pipeline = new ResponsesPipeline(
        makeGeneratorConfig(),
        makeCliConfig(),
      );

      expect(await drain(pipeline, replayRequest())).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(parsedCall(0).input).toEqual(ORIGINAL_INPUT);
    });

    it.each([
      [
        'an unrelated 400',
        400,
        JSON.stringify({
          error: {
            message: 'Unsupported model',
            param: 'model',
            code: 'model_not_found',
          },
        }),
      ],
      [
        'a matching body under 500',
        500,
        directBody('input[1].id', MAX_64_MESSAGE),
      ],
      [
        'a matching body under 429',
        429,
        directBody('input[1].id', MAX_64_MESSAGE),
      ],
      ['a malformed body', 400, '<html><body>Bad Gateway</body></html>'],
      [
        'a primitive JSON body',
        400,
        JSON.stringify('string_above_max_length on input[1].id'),
      ],
      [
        'an array JSON body',
        400,
        JSON.stringify([
          {
            message: MAX_64_MESSAGE,
            param: 'input[1].id',
            code: 'string_above_max_length',
          },
        ]),
      ],
      [
        'split code and param across objects',
        400,
        JSON.stringify({
          error: { code: 'string_above_max_length', message: MAX_64_MESSAGE },
          detail: { param: 'input[1].id' },
        }),
      ],
      [
        'duplicate relevant keys',
        400,
        '{"error":{"code":"string_above_max_length","code":"other","param":"input[1].id","message":"' +
          MAX_64_MESSAGE +
          '"}}',
      ],
      [
        'prose-only mention of the rejection',
        400,
        JSON.stringify({
          error: {
            message: `upstream reported string_above_max_length for input[1].id`,
            code: '400',
          },
        }),
      ],
      [
        'a negative item index',
        400,
        directBody('input[-1].id', "Invalid 'input[-1].id': string too long."),
      ],
      [
        'an unsafe item index',
        400,
        directBody(
          'input[99999999999999999999].id',
          "Invalid 'input[99999999999999999999].id': string too long.",
        ),
      ],
      [
        'a named item that is not a reasoning item',
        400,
        directBody(
          'input[0].id',
          "Invalid 'input[0].id': string too long. Expected a string with " +
            'maximum length 64, but got a string with length 83 instead.',
        ),
      ],
      [
        'a named reasoning id within the reported maximum',
        400,
        directBody(
          'input[2].id',
          "Invalid 'input[2].id': string too long. Expected a string with " +
            'maximum length 64, but got a string with length 8 instead.',
        ),
      ],
      [
        'a matching object quoted inside an unrelated debug field',
        400,
        JSON.stringify({
          error: {
            message: 'Unsupported model',
            param: 'model',
            code: 'model_not_found',
          },
          debug: `example: ${directBody('input[1].id', MAX_64_MESSAGE)}`,
        }),
      ],
      [
        'trailing non-whitespace after the top-level object',
        400,
        `${directBody('input[1].id', MAX_64_MESSAGE)} trailing`,
      ],
      [
        'an unterminated string tail after a matching object',
        400,
        `{"error":{"message":"${MAX_64_MESSAGE}","param":"input[1].id",` +
          '"code":"string_above_max_length"},"tail":"oops',
      ],
      [
        'an unknown backslash escape in the rejection fields',
        400,
        '{"error":{"message":"Invalid \'input[1]\\.id\': string too long. ' +
          'Expected a string with maximum length 64, but got a string with ' +
          'length 83 instead.","param":"input[1]\\.id",' +
          '"code":"string_above_max_length"}}',
      ],
    ])('control: does not retry on %s', async (_label, status, body) => {
      fetchMock.mockResolvedValueOnce(errorResponse(status as number, body));
      fetchMock.mockResolvedValueOnce(okResponse(COMPLETED));
      const pipeline = new ResponsesPipeline(
        makeGeneratorConfig(),
        makeCliConfig(),
      );

      const err = await drain(pipeline, replayRequest());
      expect(err).toBeInstanceOf(Error);
      expect((err as { status?: number }).status).toBe(status);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(parsedCall(0).input).toEqual(ORIGINAL_INPUT);
    });
  });
});
