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
import { FunctionCallingConfigMode } from '@google/genai';
import { ResponsesPipeline } from './responses-pipeline.js';
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
});
