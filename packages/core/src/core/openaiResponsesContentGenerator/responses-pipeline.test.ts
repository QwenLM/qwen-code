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
import type {
  Content,
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import { FunctionCallingConfigMode, FinishReason } from '@google/genai';
import { inspect } from 'node:util';
import {
  ResponsesPipeline,
  mergeStreamResponses,
  normalizeOpenAiWireBaseUrl,
  StreamInactivityTimeoutError,
  StreamLifetimeExceededError,
  StreamConnectTimeoutError,
  ErrorBodyTimeoutError,
} from './responses-pipeline.js';
import type { Config } from '../../config/config.js';
import type { ContentGeneratorConfig } from '../contentGenerator.js';
import type { ResponsesApiRequest } from './types.js';
import { preloadRuntimeFetchModule } from '../../utils/runtimeFetchOptions.js';
import { classifyRetryError } from '../../utils/retryErrorClassification.js';
import {
  collect,
  content,
  drain,
  fnCall,
  fnResponse,
  userText,
} from '../../test-utils/model-fixtures.js';

// The pipeline calls the `fetch` buildRuntimeFetchOptions returns (pinned
// alongside its dispatcher) rather than the global `fetch`, so the mock must
// intercept it there -- stubbing global `fetch` alone is bypassed and the
// real undici fetch attempts a live network call (see #8169 review).
const { buildRuntimeFetchOptionsMock, debugMock } = vi.hoisted(() => ({
  buildRuntimeFetchOptionsMock: vi.fn(),
  debugMock: vi.fn(),
}));
vi.mock('../../utils/debugLogger.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/debugLogger.js')>();
  return {
    ...actual,
    createDebugLogger: (tag: string) => ({
      ...actual.createDebugLogger(tag),
      debug: debugMock,
    }),
  };
});
vi.mock('../../utils/runtimeFetchOptions.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/runtimeFetchOptions.js')>();
  return {
    ...actual,
    buildRuntimeFetchOptions: buildRuntimeFetchOptionsMock,
  };
});

// Delivers `body` in `chunkSize`-byte reads (default: one read). Small chunks
// split an event/data line -- or the JSON payload, or a multi-byte character --
// across reader.read() calls, exercising the pipeline's buffer/line-carry
// logic instead of handing it one complete frame per read.
function byteStream(body: string, chunkSize = Infinity) {
  const bytes = new TextEncoder().encode(body);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
}

function sseStream(lines: string[], chunkSize?: number) {
  return byteStream(lines.join('\n') + '\n', chunkSize);
}

function sseEvent(event: string, data: unknown): string[] {
  return [`event: ${event}`, `data: ${JSON.stringify(data)}`, ''];
}

const deltaEvent = (delta: string) =>
  sseEvent('response.output_text.delta', { delta });
const DONE = sseEvent('response.completed', {
  response: { status: 'completed' },
});
const DONE_R1 = sseEvent('response.completed', {
  response: { id: 'r1', status: 'completed' },
});

// A data-only SSE line (no `event:` line): the shape the API actually emits.
function dataLine(type: string, fields: object): string {
  return `data: ${JSON.stringify({ type, ...fields })}`;
}

// A byte stream whose reads block until the test pushes a data-only frame (or
// completes the stream), so a test can drip-feed frames on fake-timer
// boundaries and exercise the idle watchdog / lifetime cap without ever
// hanging: an unpushed read stays pending, and enqueue/close resolve it.
function gatedByteStream() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const push = (type: string, fields: object) =>
    controller.enqueue(encoder.encode(dataLine(type, fields) + '\n'));
  return {
    stream,
    delta: (delta: string) => push('response.output_text.delta', { delta }),
    complete() {
      push('response.completed', { response: { status: 'completed' } });
      controller.close();
    },
  };
}

function makeCliConfig(
  proxy?: string,
  sessionId: string | (() => string) = '',
  allowDynamicHeaderValues = false,
  freeform = false,
): Config {
  // getSessionId() is typed `string` and never returns undefined, so neither
  // may the mock: the reachable "no usable session" state is ''. connect()
  // stamps its own User-Agent and resolves customHeaders placeholders per
  // request from Config; the consent gate defaults off, as in production.
  return {
    getProxy: () => proxy,
    getSessionId: typeof sessionId === 'function' ? sessionId : () => sessionId,
    getCliVersion: () => '9.9.9-test',
    getOutboundAllowDynamicHeaderValues: () => allowDynamicHeaderValues,
    getFreeform: () => freeform,
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
  return { model: 'gpt-5', contents: [userText(text)] };
}

/** The OpenAI Responses API's own rejection of an over-long input string. */
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

const MAX_64_MESSAGE =
  "Invalid 'input[1].id': string too long. Expected a string with " +
  'maximum length 64, but got a string with length 83 instead.';
const MAX_64_BODY = directBody('input[1].id', MAX_64_MESSAGE);

describe('normalizeOpenAiWireBaseUrl', () => {
  it('maps the empty default and a /v1-suffixed URL onto the same origin', () => {
    // The Responses wire strips a trailing /v1 before appending /v1/responses,
    // so these spellings are one endpoint — the credential-reuse comparison in
    // ModelsConfig depends on this exact rule.
    for (const [baseUrl, origin] of [
      ['', 'https://api.openai.com'],
      [undefined, 'https://api.openai.com'],
      ['https://api.openai.com/v1', 'https://api.openai.com'],
      ['https://api.openai.com/v1/', 'https://api.openai.com'],
      ['https://api.openai.com/', 'https://api.openai.com'],
      ['https://proxy.example/v1/', 'https://proxy.example'],
    ] as const) {
      expect(normalizeOpenAiWireBaseUrl(baseUrl)).toBe(origin);
    }
  });
});

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
    // Restores what fake-timer and env-stubbing cases change, even on failure.
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  // A 200 response; a null contentType models an absent header.
  function okResponse(
    body: ReadableStream<Uint8Array> | undefined,
    contentType: string | null = 'text/event-stream',
  ) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => contentType },
      body,
      text: async () => '',
    };
  }

  // A non-2xx response without a body stream: its text comes from text().
  function errorResponse(status: number, body: string) {
    return {
      ok: false,
      status,
      headers: { get: () => 'application/json' },
      text: async () => body,
    };
  }

  function mockResponse(lines: string[], chunkSize?: number) {
    fetchMock.mockResolvedValue(okResponse(sseStream(lines, chunkSize)));
  }

  const pipe = (
    overrides?: Partial<ContentGeneratorConfig>,
    cliConfig = makeCliConfig(),
  ) => new ResponsesPipeline(makeGeneratorConfig(overrides), cliConfig);

  const streamed = (
    pipeline = pipe(),
    request = textRequest('hi'),
    promptId = 'p1',
  ) => collect(pipeline.executeStream(request, promptId));

  const partsOf = (chunks: GenerateContentResponse[]) =>
    chunks.map((c) => c.candidates?.[0]?.content?.parts);

  // Drains one stream: resolves to what it threw, or undefined on success.
  const streamError = (pipeline = pipe(), request = textRequest('hi')) =>
    drain(pipeline.executeStream(request, 'p1')).then(
      () => undefined,
      (e: unknown) => e,
    );

  // The connect phase's rejection, or undefined when it connected.
  const connectError = (pipeline = pipe(), signal?: AbortSignal) =>
    pipeline.connectStream(textRequest('hi'), 'p1', signal).then(
      () => undefined as unknown,
      (e: unknown) => e,
    );

  // The connect-phase rejection for a real `Response` carrying this body.
  function rejectWith(body: string, status: number) {
    fetchMock.mockResolvedValue(new Response(body, { status }));
    return connectError();
  }

  const sentBody = (call = 0) =>
    JSON.parse(fetchMock.mock.calls[call]![1].body) as ResponsesApiRequest &
      Record<string, unknown>;
  const sentHeaders = (call = 0) =>
    new Headers(fetchMock.mock.calls[call]![1].headers);

  // Answers with a bare completed stream, drains one request and returns the
  // body it sent.
  async function sendBody(
    pipeline = pipe(),
    request = textRequest('hi'),
    promptId = 'p1',
  ) {
    mockResponse(DONE);
    await drain(pipeline.executeStream(request, promptId));
    return sentBody();
  }

  // Answers with a bare completed stream and runs one execute().
  function executeDone(pipeline = pipe()) {
    mockResponse(DONE);
    return pipeline.execute(textRequest('hi'), 'p1');
  }

  // Table row runner: sends one request and asserts each expected top-level
  // body key, one assertion per key.
  type BodyCase = [
    title: string,
    overrides: Partial<ContentGeneratorConfig>,
    expected: Record<string, unknown>,
    request?: GenerateContentParameters,
  ];
  async function expectBody(...[, overrides, expected, request]: BodyCase) {
    const body = await sendBody(pipe(overrides), request);
    for (const [key, value] of Object.entries(expected)) {
      expect(body[key]).toEqual(value);
    }
  }

  it.each([
    { freeform: false, tool: 'function', call: 'function_call' },
    { freeform: true, tool: 'custom', call: 'custom_tool_call' },
  ])(
    'uses $tool tools and matching history when Freeform=$freeform',
    async ({ freeform, tool, call }) => {
      const body = await sendBody(
        pipe(undefined, makeCliConfig(undefined, '', false, freeform)),
        {
          model: 'gpt-6-astra',
          contents: [
            content('model', fnCall('exec', { source: 'text(1);' }, 'c1')),
            content('user', fnResponse('exec', { output: '1' }, 'c1')),
          ],
          config: { tools: [{ functionDeclarations: [{ name: 'exec' }] }] },
        },
      );
      expect(body.tools?.[0]?.type).toBe(tool);
      expect(body.input.map((item) => item.type)).toEqual([
        call,
        `${call}_output`,
      ]);
    },
  );

  it('POSTs to <baseUrl>/v1/responses with the converted request body', async () => {
    mockResponse([...deltaEvent('hi'), ...DONE_R1]);
    const chunks = await streamed(pipe(), textRequest('hello'), 'prompt-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://api.openai.com/v1/responses',
    );
    const headers = sentHeaders();
    expect(headers.get('Authorization')).toBe('Bearer test-key');
    expect(headers.get('Accept')).toBe('text/event-stream');
    // Pin the explicit Content-Type: undici defaults a string body to
    // text/plain;charset=UTF-8 when it is absent, which strict
    // OpenAI-compatible gateways reject with 415/400.
    expect(headers.get('Content-Type')).toBe('application/json');
    const body = sentBody();
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

    expect(partsOf(chunks)).toEqual([[{ text: 'hi' }], []]);
  });

  it('logs only request metadata, never raw request-body bytes (issue #11667)', async () => {
    // Synthetic markers that must never reach the debug log: a user prompt, a
    // tool name, a replayed reasoning id, and its encrypted content. The
    // pre-fix code logged `body.substring(0, 500)` -- `model` first, then
    // `input` -- so all four leaked into the per-session debug file.
    const promptMarker = 'PROMPT_SECRET_MARKER_7f3a';
    const toolMarker = 'TOOL_SECRET_MARKER_9c1b';
    const reasoningIdMarker = 'REASONING_ID_SECRET_2d4e';
    const encryptedMarker = 'ENCRYPTED_CONTENT_SECRET_5b6f';
    const thoughtSignature = JSON.stringify({
      id: reasoningIdMarker,
      encrypted_content: encryptedMarker,
    });
    await sendBody(
      pipe(),
      {
        model: 'gpt-5',
        contents: [
          userText(`${promptMarker} hello`),
          content('model', { thought: true, thoughtSignature }),
        ],
        config: { tools: [{ functionDeclarations: [{ name: toolMarker }] }] },
      },
      'prompt-1',
    );

    const logged = debugMock.mock.calls.flat().map(String).join(' ');
    // No raw content may leak into the debug log.
    expect(logged).not.toContain(promptMarker);
    expect(logged).not.toContain(toolMarker);
    expect(logged).not.toContain(reasoningIdMarker);
    expect(logged).not.toContain(encryptedMarker);
    // …but the transport diagnostic must stay: method + redacted URL, byte
    // length, and per-input-item-type counts.
    expect(logged).toContain('POST https://api.openai.com/v1/responses');
    expect(logged).toContain('bodyBytes=');
    expect(logged).toContain('inputItems=');
    expect(logged).toContain('message=1');
    expect(logged).toContain('reasoning=1');
  });

  it('keys prompt_cache_key on the session so it stays stable across turns', async () => {
    // userPromptId is `${sessionId}########${counter}` and changes on every
    // send, so keying on it gives each turn its own cache namespace and no
    // request can hit the prefix the previous one wrote. Nothing errors when
    // that happens -- the loss is pure cost and latency, which is why it needs
    // a test. Matches the Chat wire's `qwen-code:${sessionId}` key
    // (prefix-caching.ts).
    const keys: Array<string | undefined> = [];
    for (const turn of ['sess-abc########1', 'sess-abc########2']) {
      fetchMock.mockClear();
      const cliConfig = makeCliConfig(undefined, 'sess-abc');
      const body = await sendBody(pipe(undefined, cliConfig), undefined, turn);
      keys.push(body.prompt_cache_key);
    }

    expect(keys[0]).toBe('qwen-code:sess-abc');
    expect(keys[1]).toBe(keys[0]);
  });

  it('falls back to userPromptId as prompt_cache_key when the session id is empty', async () => {
    const body = await sendBody(pipe(), undefined, 'short-id');
    expect(body.prompt_cache_key).toBe('short-id');
  });

  it('hashes userPromptId into a fixed-length prompt_cache_key when it exceeds 64 characters', async () => {
    // A mutation removing the truncation branch would silently disable
    // prompt caching (the Responses API rejects/ignores an over-length
    // prompt_cache_key) with no visible error -- pin the hashed shape.
    const longId = 'x'.repeat(100);
    const { prompt_cache_key } = await sendBody(pipe(), undefined, longId);
    expect(prompt_cache_key).not.toBe(longId);
    expect(prompt_cache_key).toHaveLength(64);
    expect(prompt_cache_key).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    [
      'strips a trailing /v1 from baseUrl before appending /v1/responses',
      'https://api.openai.com/v1',
    ],
    [
      'defaults to https://api.openai.com when no baseUrl is configured',
      undefined,
    ],
    // The round-1 empty-string baseUrl shape: `'' || default` must resolve to
    // api.openai.com rather than producing `/v1/responses` against no origin.
    [
      'treats an empty-string baseUrl as unset and falls back to the default origin',
      '',
    ],
  ])('%s', async (_title, baseUrl) => {
    await sendBody(pipe({ baseUrl }));
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://api.openai.com/v1/responses',
    );
  });

  describe('reasoning request shape', () => {
    it.each([undefined, { effort: 'high' }])(
      'applies default below an existing raw override %j',
      async (raw) => {
        const config = makeCliConfig();
        config.getResolvedModelConfig = vi.fn().mockReturnValue({
          capabilities: {
            reasoning: {
              profile: 'openai-reasoning',
              efforts: ['low', 'medium', 'high'],
              defaultEffort: 'medium',
            },
          },
        });
        const pipeline = pipe(
          {
            model: 'company-alias',
            authType: 'openai-responses' as ContentGeneratorConfig['authType'],
            ...(raw ? { extra_body: { reasoning: raw } } : {}),
          },
          config,
        );
        const body = await sendBody(pipeline, {
          ...textRequest('hi'),
          model: 'company-alias',
        });
        expect(body.reasoning).toEqual(
          raw ?? { effort: 'medium', summary: 'auto' },
        );
      },
    );

    it.each<BodyCase>([
      [
        'passes the effort straight through with no clamping, plus include + summary auto',
        { reasoning: { effort: 'max' } },
        {
          reasoning: { effort: 'max', summary: 'auto' },
          include: ['reasoning.encrypted_content'],
        },
      ],
      [
        'omits reasoning and include entirely when reasoning is false',
        { reasoning: false },
        { reasoning: undefined, include: undefined },
      ],
      // `enable_thinking` has no meaning on this wire; it must never appear
      // top-level on the request, translated or not.
      [
        'translates a legacy extra_body.enable_thinking into reasoning.effort=medium and strips it from the wire body',
        { extra_body: { enable_thinking: true } },
        {
          reasoning: { effort: 'medium', summary: 'auto' },
          include: ['reasoning.encrypted_content'],
          enable_thinking: undefined,
        },
      ],
      [
        'prefers an explicit reasoning.effort over a legacy extra_body.enable_thinking',
        {
          reasoning: { effort: 'high' },
          extra_body: { enable_thinking: true },
        },
        { reasoning: { effort: 'high', summary: 'auto' } },
      ],
      [
        'omits reasoning when reasoning is false even with a legacy extra_body.enable_thinking set',
        { reasoning: false, extra_body: { enable_thinking: true } },
        {
          reasoning: undefined,
          include: undefined,
          enable_thinking: undefined,
        },
      ],
    ])('%s', expectBody);
  });

  it.each<BodyCase>([
    [
      'maps samplingParams onto temperature/top_p/max_output_tokens',
      { samplingParams: { temperature: 0.4, top_p: 0.9, max_tokens: 2048 } },
      { temperature: 0.4, top_p: 0.9, max_output_tokens: 2048 },
    ],
    // 'model' already exists on the request, so extra_body must not clobber it.
    [
      'merges extra_body keys that do not already exist on the request',
      { extra_body: { service_tier: 'priority', model: 'ignored' } },
      { service_tier: 'priority', model: 'gpt-5' },
    ],
    // textRequest() has no config.tools, so apiRequest.tools is present as a
    // key with value undefined — extra_body must still be able to set it.
    [
      'lets extra_body fill in a field left undefined by the request itself',
      { extra_body: { instructions: 'from extra_body' } },
      { instructions: 'from extra_body' },
    ],
    // The production guard checks `requestRecord[key] === undefined`, so an
    // explicit 0 is preserved; a truthiness guard would let extra_body win.
    [
      'does not let extra_body overwrite an explicit samplingParams.temperature of 0',
      { samplingParams: { temperature: 0 }, extra_body: { temperature: 1 } },
      { temperature: 0 },
    ],
    [
      'drops function_call items with no matching function_call_output before sending',
      {},
      { input: [] },
      {
        model: 'gpt-5',
        contents: [content('model', fnCall('f', {}, 'call_1'))],
      },
    ],
    // --- Critical (a): per-send window-clamped output budget (#5950) ---
    [
      'sends request.config.maxOutputTokens as max_output_tokens when no samplingParams cap is set',
      {},
      { max_output_tokens: 512 },
      { ...textRequest('hi'), config: { maxOutputTokens: 512 } },
    ],
    [
      'lets request.config.maxOutputTokens override the static samplingParams.max_tokens',
      { samplingParams: { max_tokens: 2048 } },
      { max_output_tokens: 512 },
      { ...textRequest('hi'), config: { maxOutputTokens: 512 } },
    ],
    // C5 regression: the per-send window-clamped value must NOT reopen a
    // smaller user-configured max_tokens ceiling. reconcileMaxTokens (the
    // shared "smaller wins" invariant both sibling wires call) picks the
    // minimum, so config 1000 caps a per-send 8000; a plain `??` precedence
    // (request first) would leak 8000.
    [
      'keeps the configured samplingParams.max_tokens ceiling when the per-send maxOutputTokens is larger (smaller wins)',
      { samplingParams: { max_tokens: 1000 } },
      { max_output_tokens: 1000 },
      { ...textRequest('hi'), config: { maxOutputTokens: 8000 } },
    ],
  ])('%s', expectBody);

  describe('tool_choice from toolConfig.functionCallingConfig.mode', () => {
    function requestWithTool(
      mode?: FunctionCallingConfigMode,
    ): GenerateContentParameters {
      return {
        model: 'gpt-5',
        contents: [userText('hi')],
        config: {
          tools: [{ functionDeclarations: [{ name: 'read_file' }] }],
          ...(mode ? { toolConfig: { functionCallingConfig: { mode } } } : {}),
        },
      };
    }

    it.each<BodyCase>([
      // parallel_tool_calls is stamped only alongside tools; pin it here so a
      // regression dropping it (degrading fan-out to sequential calls) fails.
      [
        'defaults to auto when no functionCallingConfig is set',
        {},
        { tool_choice: 'auto', parallel_tool_calls: true },
        requestWithTool(),
      ],
      [
        'maps ANY to required, forcing a tool call',
        {},
        { tool_choice: 'required' },
        requestWithTool(FunctionCallingConfigMode.ANY),
      ],
      [
        'maps NONE to none',
        {},
        { tool_choice: 'none' },
        requestWithTool(FunctionCallingConfigMode.NONE),
      ],
      // No tools -> neither field is sent (a mode with no tools must not
      // resurrect them); strict endpoints reject tool_choice without `tools`.
      [
        'omits tool_choice and parallel_tool_calls entirely when there are no tools, even with functionCallingConfig.mode set',
        {},
        { tool_choice: undefined, parallel_tool_calls: undefined },
        {
          ...textRequest('hi'),
          config: {
            toolConfig: {
              functionCallingConfig: { mode: FunctionCallingConfigMode.ANY },
            },
          },
        },
      ],
    ])('%s', expectBody);
  });

  it('throws a descriptive error carrying the body excerpt and stamps .status on a non-ok HTTP response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"bad request"}',
    });
    const caught = await streamError();
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
      ...deltaEvent('foo'),
      ...deltaEvent('bar'),
      ...sseEvent('response.completed', {
        response: {
          status: 'completed',
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        },
      }),
    ]);
    const result = await pipe().execute(textRequest('hi'), 'p1');
    expect(result.candidates?.[0]?.content?.parts).toEqual([
      { text: 'foo' },
      { text: 'bar' },
    ]);
    expect(result.usageMetadata?.totalTokenCount).toBe(5);
  });

  describe.each(['', ' '])('SSE field separator %j', (separator) => {
    it.each([
      { eventLines: true, trailingNewline: true },
      { eventLines: false, trailingNewline: true },
      { eventLines: true, trailingNewline: false },
      { eventLines: false, trailingNewline: false },
    ])(
      'parses chunked frames with %j',
      async ({ eventLines, trailingNewline }) => {
        const events = [
          { type: 'response.output_text.delta', delta: 'hello' },
          {
            type: 'response.completed',
            response: { id: 'response-framing', status: 'completed' },
          },
        ];
        const body =
          events
            .map(({ type, ...data }) =>
              [
                ...(eventLines ? [`event:${separator}${type}`] : []),
                `data:${separator}${JSON.stringify(eventLines ? data : { type, ...data })}`,
              ].join('\n'),
            )
            .join('\n\n') + (trailingNewline ? '\n\n' : '');
        fetchMock.mockResolvedValue(okResponse(byteStream(body, 5)));
        const chunks = await streamed(
          pipe(),
          textRequest('hello'),
          'prompt-framing',
        );
        expect(partsOf(chunks)).toEqual([[{ text: 'hello' }], []]);
        expect(chunks.at(-1)?.candidates?.[0]?.finishReason).toBe(
          FinishReason.STOP,
        );
        expect(chunks.at(-1)?.responseId).toBe('response-framing');
      },
    );
  });

  const DATA_ONLY = [
    dataLine('response.output_text.delta', { delta: 'hi' }),
    dataLine('response.completed', {
      response: { id: 'r1', status: 'completed' },
    }),
  ];

  it('parses data-only SSE frames (no event: line) -- the shape the Responses API actually emits', async () => {
    // sseEvent() always prepends an `event: ` line, so tests built on it never
    // exercise the data-only branch that parses `data['type']` directly and
    // handles `[DONE]`; a regression there would leave them green while
    // breaking every real OpenAI call.
    mockResponse([...DATA_ONLY, 'data: [DONE]']);
    const chunks = await streamed(pipe(), textRequest('hello'), 'prompt-1');
    expect(partsOf(chunks)).toEqual([[{ text: 'hi' }], []]);
  });

  it('parses data-only SSE frames split across multiple reader.read() chunks', async () => {
    mockResponse(DATA_ONLY, 5);
    const chunks = await streamed(pipe(), textRequest('hello'), 'prompt-1');
    expect(partsOf(chunks)).toEqual([[{ text: 'hi' }], []]);
  });

  it('recovers the final frame when the stream ends mid-line with no trailing newline', async () => {
    // Unlike a stream missing only its trailing blank line, here the
    // connection drops before any newline follows the last `data: ` line, so
    // `buffer.split('\n')` never splits it out for the per-line loop:
    // `currentEventType` is set but `dataAccumulator` stays empty, and the
    // post-loop flush (gated on both) would silently drop the frame.
    const body = DONE_R1.slice(0, 2).join('\n'); // event + data, no newline
    fetchMock.mockResolvedValue(okResponse(byteStream(body)));
    const chunks = await streamed(pipe(), textRequest('hello'), 'prompt-1');
    expect(partsOf(chunks)).toEqual([[]]);
  });

  it('parses correctly when frames are split across multiple reader.read() chunks', async () => {
    // 5-byte chunks guarantee every "event: "/"data: " line and the JSON
    // payload itself get split mid-token across reads.
    mockResponse(
      [
        ...deltaEvent('foo'),
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
      ],
      5,
    );
    const result = await pipe().execute(textRequest('hi'), 'p1');
    expect(result.candidates?.[0]?.content?.parts).toEqual([
      { text: 'foo' },
      { text: 'why', thought: true },
      fnCall('read_file', { path: 'a.ts' }, 'call_1'),
    ]);
    expect(result.usageMetadata?.totalTokenCount).toBe(2);
  });

  // --- Critical (b): mid-stream idle-timeout watchdog ---

  it('fails a silent mid-stream stall with a retryable ETIMEDOUT after the idle timeout', async () => {
    vi.useFakeTimers();
    // Emit one delta frame, then go silent forever: the never-resolving pull()
    // keeps the second reader.read() pending so only the idle watchdog can
    // end the stream.
    const line = dataLine('response.output_text.delta', { delta: 'hi' });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${line}\n`));
      },
      pull: () => new Promise<void>(() => {}),
    });
    fetchMock.mockResolvedValue(okResponse(body));
    const gen = pipe({ streamIdleTimeoutMs: 1000 }).executeStream(
      textRequest('hi'),
      'p1',
    );
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
  });

  it('does not fire the idle watchdog while chunks keep arriving', async () => {
    // A fully delivered, promptly-closing stream must complete cleanly even
    // with a tiny idle timeout configured -- the timer resets per chunk and
    // the terminal `done` resolves before it can fire.
    mockResponse([...deltaEvent('foo'), ...DONE]);
    const chunks = await streamed(pipe({ streamIdleTimeoutMs: 1000 }));
    expect(partsOf(chunks)).toEqual([[{ text: 'foo' }], []]);
  });

  it('resets the idle timer on each chunk and completes a slow-but-active stream', async () => {
    // The watchdog arms a fresh timer inside every readChunk(), so a stream
    // that keeps delivering deltas is never interrupted even when its total
    // duration far exceeds the idle window. A mutant arming a single timer
    // once at stream start would fail this (it fires at t=1000 mid-stream).
    vi.useFakeTimers();
    const gated = gatedByteStream();
    fetchMock.mockResolvedValue(okResponse(gated.stream));
    let chunks: unknown[] = [];
    let error: unknown;
    const consume = streamed(pipe({ streamIdleTimeoutMs: 1000 })).then(
      (c) => (chunks = c),
      (e: unknown) => (error = e),
    );
    // A chunk every 800ms (< 1000ms idle) across 2400ms total: each drip
    // resets the idle timer, so it must never fire.
    await vi.advanceTimersByTimeAsync(800);
    gated.delta('a');
    await vi.advanceTimersByTimeAsync(800);
    gated.delta('b');
    await vi.advanceTimersByTimeAsync(800);
    gated.complete();
    await consume;
    expect(error).toBeUndefined();
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // A late advance after completion must not produce a delayed throw.
    await vi.advanceTimersByTimeAsync(5000);
  });

  // --- Critical: total-lifetime cap (issue #8597) ---

  it('caps the total stream lifetime even when chunks keep resetting the idle watchdog (issue #8597)', async () => {
    vi.useFakeTimers();
    const gated = gatedByteStream(); // drip-fed, never ends
    fetchMock.mockResolvedValue(okResponse(gated.stream));
    const consume = streamError(
      pipe({ streamIdleTimeoutMs: 1000, streamMaxLifetimeMs: 3000 }),
    );
    // A chunk every 500ms: every drip resets the 1s idle watchdog, so it can
    // never fire (the CI-hang shape). The 3s lifetime cap does NOT reset.
    for (let i = 0; i < 5; i++) {
      gated.delta('x');
      await vi.advanceTimersByTimeAsync(500);
    }
    await vi.advanceTimersByTimeAsync(1000); // push past the cap
    const error = await consume;
    expect(error).toBeInstanceOf(StreamLifetimeExceededError);
    expect(error).toMatchObject({ code: 'ETIMEDOUT' });
    expect((error as StreamLifetimeExceededError).maxLifetimeMs).toBe(3000);
    expect((error as Error).message).toContain('QWEN_STREAM_MAX_LIFETIME_MS');
  }, 15000);

  it('does not interrupt a drip-fed stream that completes within the lifetime cap', async () => {
    vi.useFakeTimers();
    const gated = gatedByteStream();
    fetchMock.mockResolvedValue(okResponse(gated.stream));
    const pipeline = pipe({
      streamIdleTimeoutMs: 1000,
      streamMaxLifetimeMs: 3000,
    });
    let done = false;
    let error: unknown;
    const consume = drain(pipeline.executeStream(textRequest('hi'), 'p1')).then(
      () => (done = true),
      (e: unknown) => (error = e),
    );
    gated.delta('a');
    await vi.advanceTimersByTimeAsync(500);
    gated.complete(); // completes at t=500, well under the 3s cap
    await consume;
    expect(error).toBeUndefined();
    expect(done).toBe(true);
  }, 15000);

  // --- Critical (c): eager connect so retryWithBackoff sees connect errors ---

  it('connectStream performs the fetch eagerly, before the body is iterated', async () => {
    mockResponse([...deltaEvent('hi'), ...DONE]);
    const gen = await pipe().connectStream(textRequest('hi'), 'p1');
    // Network I/O already happened while awaiting the returned promise -- a
    // lazy `async *` generator would leave this at 0 until the first next().
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await drain(gen);
  });

  it('preserves structured gateway diagnostics past 500 characters and safe response headers', async () => {
    const message = `${'x'.repeat(700)} resource missing; test-key`;
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          routify_response: {
            padding: 'x'.repeat(700),
            trace_id: 'trace-after-500',
            request_id: 'body-request',
            model_name: 'test-model',
            ak_quota: { api_key: 'never-log-this-upstream-key' },
            error_detail: {
              error: {
                message,
                code: 'not_found',
                type: 'upstream_error',
                param: 'model',
              },
            },
          },
        }),
        {
          status: 404,
          headers: {
            'x-request-id': 'header-request',
            'retry-after': '3',
            'x-should-retry': 'true',
            'set-cookie': 'secret-cookie',
            authorization: 'Bearer response-secret',
          },
        },
      ),
    );
    const error = await connectError();
    expect(error).toMatchObject({
      status: 404,
      requestId: 'header-request',
      code: 'not_found',
      type: 'upstream_error',
      param: 'model',
    });
    const rendered = `${inspect(error)} ${JSON.stringify(error)}`;
    expect(rendered).toContain('trace-after-500');
    expect(rendered).toContain('resource missing');
    for (const secret of [
      'test-key',
      'never-log-this-upstream-key',
      'secret-cookie',
      'response-secret',
    ]) {
      expect(rendered).not.toContain(secret);
    }
    const headers = (error as { headers: Headers }).headers;
    expect(headers.get('retry-after')).toBe('3');
    expect(headers.get('x-should-retry')).toBe('true');
    expect(headers.has('authorization')).toBe(false);
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
    const err = await connectError();
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
    let fetchSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      fetchSignal = init.signal ?? undefined;
      // Never resolves on its own: only the connect timeout can end this.
      return new Promise<never>(() => {});
    });
    const pending = connectError(pipe({ timeout: 1000 }));
    await vi.advanceTimersByTimeAsync(1000);
    const err = await pending;
    expect(err).toBeInstanceOf(StreamConnectTimeoutError);
    expect(err).toMatchObject({ code: 'ETIMEDOUT' });
    expect((err as StreamConnectTimeoutError).connectTimeoutMs).toBe(1000);
    // The timeout also aborts the in-flight fetch so the socket is freed.
    expect(fetchSignal?.aborted).toBe(true);
  }, 15000);

  // --- Suggestions: previously untested added behavior ---

  it('accumulates a multi-line data: block (joined with \\n) into a single frame', async () => {
    // Every other test emits one data: line per event, so the `event: ` +
    // multi-`data:` accumulation path never runs; a last-line-wins mutant
    // would silently drop a split frame.
    mockResponse([
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta",',
      'data: "delta":"multi"}',
      '',
    ]);
    expect(partsOf(await streamed())).toEqual([[{ text: 'multi' }]]);
  });

  it('decodes multi-byte UTF-8 split across reader.read() chunks', async () => {
    // JSON.stringify emits raw (unescaped) non-ASCII, so byte-chunking splits
    // real multi-byte characters across reads -- exercising the decoder's
    // { stream: true } flag. Dropping it corrupts split code points to U+FFFD.
    const text = '你好😀世界';
    mockResponse(
      [dataLine('response.output_text.delta', { delta: text }), DATA_ONLY[1]!],
      3,
    );
    const chunks = await streamed();
    expect(chunks[0]?.candidates?.[0]?.content?.parts).toEqual([{ text }]);
  });

  it('propagates responseId and finishReason through execute()/mergeStreamResponses', async () => {
    mockResponse([
      ...deltaEvent('foo'),
      ...sseEvent('response.completed', {
        response: {
          id: 'r1',
          status: 'completed',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      }),
    ]);
    const result = await pipe().execute(textRequest('hi'), 'p1');
    expect(result.responseId).toBe('r1');
    expect(result.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
  });

  it('applies customHeaders to the fetch request', async () => {
    await sendBody(pipe({ customHeaders: { 'X-Proxy-Auth': 'token' } }));
    expect(sentHeaders().get('X-Proxy-Auth')).toBe('token');
  });

  it.each(['Authorization', 'authorization', 'AuThOrIzAtIoN'])(
    'replaces default headers case-insensitively with custom %s',
    async (authorization) => {
      await executeDone(
        pipe({
          customHeaders: {
            [authorization]: 'Bearer gateway-token',
            accept: 'text/event-stream; charset=utf-8',
            'content-type': 'application/json; charset=utf-8',
            'X-Gateway': 'custom',
          },
        }),
      );

      const headers = sentHeaders();
      expect(headers.get('authorization')).toBe('Bearer gateway-token');
      expect(headers.get('accept')).toBe('text/event-stream; charset=utf-8');
      expect(headers.get('content-type')).toBe(
        'application/json; charset=utf-8',
      );
      expect(headers.get('x-gateway')).toBe('custom');
    },
  );

  // Issue #11936: this wire builds its request headers by hand in connect(),
  // so it never entered the placeholder machinery the Chat / Anthropic /
  // Gemini wires go through -- a customHeaders value of `${session_id}`
  // reached the gateway verbatim (consent gate on AND off), no first-party
  // session_id header was added for the allowlisted gateways, and no QwenCode
  // User-Agent was stamped.
  describe('outbound correlation headers', () => {
    const SESSION_HEADER = 'x-opencode-session';

    it('stamps a QwenCode User-Agent', async () => {
      await executeDone();

      expect(sentHeaders().get('user-agent')).toBe(
        `QwenCode/9.9.9-test (${process.platform}; ${process.arch})`,
      );
    });

    it('expands ${session_id} per request when the consent gate is on', async () => {
      await executeDone(
        pipe(
          { customHeaders: { [SESSION_HEADER]: 'sess=${session_id}' } },
          makeCliConfig(undefined, 'session-abc', true),
        ),
      );

      expect(sentHeaders().get(SESSION_HEADER)).toBe('sess=session-abc');
    });

    it('drops a placeholder-bearing header instead of sending the literal when the gate is off', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await executeDone(
        pipe(
          { customHeaders: { [SESSION_HEADER]: '${session_id}' } },
          makeCliConfig(undefined, 'session-abc', false),
        ),
      );

      expect(sentHeaders().get(SESSION_HEADER)).toBeNull();
      warn.mockRestore();
    });

    it('re-expands ${session_id} when the session id rotates between requests', async () => {
      // A Config whose session id changes under a live pipeline -- what /new
      // and /resume do. Expansion has to happen per request, not be baked in
      // once, or the documented rotation silently stops.
      fetchMock.mockImplementation(async () => okResponse(sseStream(DONE)));
      let sessionId = 'first-session';
      const pipeline = pipe(
        { customHeaders: { [SESSION_HEADER]: '${session_id}' } },
        makeCliConfig(undefined, () => sessionId, true),
      );

      await pipeline.execute(textRequest('hi'), 'p1');
      sessionId = 'second-session';
      await pipeline.execute(textRequest('hi'), 'p2');

      expect(sentHeaders(0).get(SESSION_HEADER)).toBe('first-session');
      expect(sentHeaders(1).get(SESSION_HEADER)).toBe('second-session');
    });

    it('adds the first-party session_id header for an allowlisted gateway host', async () => {
      await executeDone(
        pipe(
          { baseUrl: 'https://routify.alibaba-inc.com' },
          makeCliConfig(undefined, 'session-abc'),
        ),
      );

      expect(sentHeaders().get('session_id')).toBe('session-abc');
    });
  });

  it('redacts credentials from the logged request URL', async () => {
    await executeDone(
      pipe({ baseUrl: 'https://review-user:review-secret@gateway.example' }),
    );

    expect(debugMock).toHaveBeenCalledWith(
      'POST https://<redacted>@gateway.example/v1/responses',
      expect.stringContaining('bodyBytes='),
      expect.stringContaining('inputItems='),
    );
    expect(inspect(debugMock.mock.calls)).not.toContain('review-secret');
    expect(inspect(debugMock.mock.calls)).not.toContain('review-user');
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://review-user:review-secret@gateway.example/v1/responses',
    );
  });

  it('redacts credentials when fetch rejects an invalid custom header value', async () => {
    buildRuntimeFetchOptionsMock.mockReturnValue({ fetch: globalThis.fetch });
    const error = await connectError(
      pipe({
        baseUrl: 'http://127.0.0.1:1',
        customHeaders: {
          'X-Gateway':
            'https://review-user:review-secret@gateway.example\ninvalid',
        },
      }),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/invalid header value/i);
    expect(inspect(error)).not.toContain('review-user');
    expect(inspect(error)).not.toContain('review-secret');
  });

  it.each([0, 480, 650])(
    'does not expose error-body credentials at offset %i on the propagated error',
    async (offset) => {
      const prefix = 'x'.repeat(offset);
      const error = await rejectWith(
        `${prefix}https://review-user:review-error-secret@gateway.example/denied`,
        502,
      );

      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ status: 502 });
      expect((error as Error).message).toBe(
        `Responses API error 502: ${`${prefix}https://<redacted>@gateway.example/denied`.slice(0, 500)}`,
      );
      for (const rendered of [inspect(error), JSON.stringify(error)]) {
        expect(rendered).not.toContain('review-user');
        expect(rendered).not.toContain('review-error-secret');
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['', 'early@'])(
    'does not expose credentials cut off by the error-body read limit (password prefix: %s)',
    async (passwordPrefix) => {
      const error = await rejectWith(
        `https://review-user:${passwordPrefix}${'long-secret'.repeat(7_000)}@gateway.example`,
        502,
      );

      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ status: 502 });
      for (const rendered of [inspect(error), JSON.stringify(error)]) {
        expect(rendered).not.toContain('review-user');
        expect(rendered).not.toContain('long-secret');
      }
    },
  );

  it.each([false, true])(
    'redacts escaped URL credentials in JSON errors (quoted upstream: %s)',
    async (quoted) => {
      const upstream = JSON.stringify({
        error: {
          message: 'https://review-user:review-secret@gateway.example/denied',
        },
      }).replaceAll('/', '\\/');
      const body = quoted
        ? JSON.stringify({ error: { message: upstream } })
        : upstream;
      const error = await rejectWith(body, 502);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('gateway.example/denied');
      for (const rendered of [inspect(error), JSON.stringify(error)]) {
        expect(rendered).not.toContain('review-user');
        expect(rendered).not.toContain('review-secret');
      }
    },
  );

  it('preserves fail-fast quota classification for oversized error bodies', async () => {
    const body = JSON.stringify({
      error: {
        code: 'Throttling.AllocationQuota',
        message: 'Allocated quota exceeded',
      },
    }).padEnd(64_001, ' ');
    const error = await rejectWith(body, 429);

    expect(error).toMatchObject({ status: 429 });
    expect(classifyRetryError(error)).toMatchObject({ diagnosis: 'fail-fast' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('handles long backslash runs without blocking error diagnostics', async () => {
    const start = performance.now();
    const error = await rejectWith('\\'.repeat(64_001), 502);
    const elapsed = performance.now() - start;

    expect(error).toMatchObject({ status: 502 });
    expect((error as Error).message).toBe(
      `Responses API error 502: ${'\\'.repeat(500)}`,
    );
    expect(elapsed).toBeLessThan(1_000);
  });

  it('forwards user aborts to fetch via a composed connect signal', async () => {
    // The connect phase composes the caller's signal with a connect-timeout
    // controller (so a timeout can also abort the fetch), so fetch receives
    // not the user's signal object but one that aborts when it does. Pin the
    // propagation, not the identity.
    const controller = new AbortController();
    mockResponse(DONE);
    await drain(
      pipe().executeStream(textRequest('hi'), 'p1', controller.signal),
    );
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
    fetchMock.mockResolvedValue(okResponse(body));
    // Idle watchdog off so the abort, not the timer, is what ends the stream.
    const gen = pipe({ streamIdleTimeoutMs: 0 }).executeStream(
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
    await sendBody();
    expect(fetchMock.mock.calls[0]![1].dispatcher).toBe(dispatcher);
  });

  it('redacts proxy credentials from a fetch rejection', async () => {
    fetchMock.mockRejectedValue(
      new Error('fetch failed http://user:secret@proxy.example:8080'),
    );
    const message = ((await streamError()) as Error).message;
    expect(message).toMatch(/<redacted>@proxy\.example/);
    expect(message).not.toContain('secret');
  });

  it('rejects a 200 response whose content-type is not SSE', async () => {
    fetchMock.mockResolvedValue(
      okResponse(sseStream(DONE), 'application/json'),
    );
    await expect(streamed()).rejects.toThrow(/non-SSE content-type/);
  });

  it('skips an unparseable data: frame and still yields the surrounding valid events', async () => {
    mockResponse([
      dataLine('response.output_text.delta', { delta: 'a' }),
      'data: {not valid json',
      dataLine('response.output_text.delta', { delta: 'b' }),
      'data: [DONE]',
    ]);
    expect(partsOf(await streamed())).toEqual([
      [{ text: 'a' }],
      [{ text: 'b' }],
    ]);
  });

  it('rejects a 200 SSE response that carries no body', async () => {
    // The no-body guard is the one connect-phase validation with no test; a
    // gateway returning 200 + empty body would otherwise crash the turn with a
    // bare TypeError (reading getReader) instead of this classifiable error.
    fetchMock.mockResolvedValue(okResponse(undefined));
    await expect(streamed()).rejects.toThrow(/returned no body/);
  });

  it('passes the configured proxy through to buildRuntimeFetchOptions', async () => {
    // The explicit-proxy hand-off is ungated by any assertion; a refactor
    // dropping the getProxy() argument would silently send Responses requests
    // direct in proxy-required environments. Pin the exact call.
    await sendBody(pipe(undefined, makeCliConfig('http://proxy.example:8080')));
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
    vi.stubEnv('RESP_TEST_KEY', 'env-secret');
    await sendBody(pipe({ apiKey: undefined, apiKeyEnvKey: 'RESP_TEST_KEY' }));
    expect(sentHeaders().get('Authorization')).toBe('Bearer env-secret');
  });

  it('sends no Authorization header when neither apiKey nor apiKeyEnvKey resolves', async () => {
    vi.stubEnv('RESP_TEST_KEY_MISSING', undefined);
    await sendBody(
      pipe({ apiKey: undefined, apiKeyEnvKey: 'RESP_TEST_KEY_MISSING' }),
    );
    expect(sentHeaders().get('Authorization')).toBeNull();
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
          userText('hello'),
          content(
            'model',
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
          ),
          userText('continue'),
        ],
      };
    }

    const message = (role: string, text: string) => ({
      type: 'message',
      role,
      content: text,
    });
    const reasoning = (id: string, ...summary: string[]) => ({
      type: 'reasoning',
      id,
      encrypted_content: `enc-${id}`,
      summary: summary.map((text) => ({ type: 'summary_text', text })),
    });

    const ORIGINAL_INPUT = [
      message('user', 'hello'),
      reasoning(LONG_ID_A, 'first thought'),
      reasoning(SHORT_ID, 'second thought'),
      reasoning(LONG_ID_B),
      message('user', 'continue'),
    ];

    // Only the two over-long ids are downgraded; the short reasoning item is
    // replayed untouched. The signature-only item has no summary to preserve
    // and is dropped rather than becoming an empty assistant message.
    const OVER_LONG_ONLY_INPUT = [
      message('user', 'hello'),
      message('assistant', 'first thought'),
      reasoning(SHORT_ID, 'second thought'),
      message('user', 'continue'),
    ];

    const ALL_REASONING_INPUT = [
      message('user', 'hello'),
      message('assistant', 'first thought'),
      message('assistant', 'second thought'),
      message('user', 'continue'),
    ];

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
      const escaped = directBody(param, message).replace(/"/g, '\\"');
      return `{"error":{"message":"litellm.BadRequestError: OpenAIException -${rawControlChar}${escaped}","type":null,"param":null,"code":"400"}}`;
    }

    const NO_MAX_MESSAGE = "Invalid 'input[1].id': string too long.";

    // Queues a 400 per rejection body, then a success, and replays `request`:
    // resolves to the surfaced error, or undefined on success.
    function replayAfter(rejections: string[], request = replayRequest()) {
      for (const body of rejections) {
        fetchMock.mockResolvedValueOnce(errorResponse(400, body));
      }
      fetchMock.mockResolvedValueOnce(okResponse(sseStream(DONE_R1)));
      return streamError(pipe(), request);
    }

    /**
     * The first request must go out exactly as it does today, and the retry
     * must differ from it in `input` and nothing else.
     */
    function expectRetryDiffersOnlyByInput(retryInput: unknown) {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const first = sentBody(0);
      const second = sentBody(1);
      expect(first.input).toEqual(ORIGINAL_INPUT);
      expect(second.input).toEqual(retryInput);
      expect({ ...second, input: null }).toEqual({ ...first, input: null });
    }

    const encryptedError = {
      error: {
        type: 'invalid_request_error',
        code: 'invalid_encrypted_content',
        message: 'The encrypted content could not be decrypted or parsed.',
      },
    };
    const encryptedBodies = [
      JSON.stringify(encryptedError),
      'data: ' +
        JSON.stringify({
          routify_response: {
            success: false,
            status: 400,
            error_detail: encryptedError,
          },
        }) +
        '\n\n',
    ];

    it.each(encryptedBodies)(
      'recovers once from rejected encrypted replay: %s',
      async (body) => {
        const request = replayRequest();
        const original = structuredClone(request);
        expect(await replayAfter([body], request)).toBeUndefined();
        expectRetryDiffersOnlyByInput(ALL_REASONING_INPUT);
        expect(request).toEqual(original);
      },
    );

    it('preserves tool call/result pairs when recovering encrypted replay', async () => {
      const request = replayRequest();
      request.contents = [
        ...(request.contents as Content[]),
        content('model', fnCall('lookup', { value: 1 }, 'call_1')),
        content('user', fnResponse('lookup', { output: 'found' }, 'call_1')),
      ];
      expect(await replayAfter([encryptedBodies[0]!], request)).toBeUndefined();
      const first = sentBody(0);
      const second = sentBody(1);
      expect(first.input.filter((i) => i.type === 'reasoning')).toHaveLength(3);
      expect(second.input.filter((i) => i.type === 'reasoning')).toHaveLength(
        0,
      );
      expect(second.input.slice(-2)).toEqual(first.input.slice(-2));
      expect(second.input.slice(-2).map((i) => i.type)).toEqual([
        'function_call',
        'function_call_output',
      ]);
    });

    it('surfaces the second encrypted rejection without looping', async () => {
      fetchMock.mockResolvedValue(errorResponse(400, encryptedBodies[0]!));
      expect(await streamError(pipe(), replayRequest())).toMatchObject({
        status: 400,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not retry encrypted rejection without reasoning in the request', async () => {
      fetchMock.mockResolvedValue(errorResponse(400, encryptedBodies[0]!));
      expect(await streamError(pipe(), textRequest('hello'))).toMatchObject({
        status: 400,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // ── RED behaviors ────────────────────────────────────────────────────

    it.each([
      [
        'downgrades every over-long reasoning id and retries when the endpoint reports a maximum',
        MAX_64_BODY,
        OVER_LONG_ONLY_INPUT,
      ],
      [
        'preserves replay recovery when the error body also contains credentials',
        directBody(
          'input[1].id',
          `${MAX_64_MESSAGE} https://review-user:review-secret@gateway.example`,
        ),
        OVER_LONG_ONLY_INPUT,
      ],
      [
        'downgrades every replayed reasoning item and retries when no maximum is reported',
        directBody('input[1].id', NO_MAX_MESSAGE),
        ALL_REASONING_INPUT,
      ],
      [
        'recovers when the rejection is nested in a proxied message carrying a raw newline',
        proxiedBody('input[1].id', MAX_64_MESSAGE, '\n'),
        OVER_LONG_ONLY_INPUT,
      ],
      [
        'recovers when the rejection is nested in a proxied message carrying a raw tab',
        proxiedBody('input[1].id', MAX_64_MESSAGE, '\t'),
        OVER_LONG_ONLY_INPUT,
      ],
      // The message names input[7].id but the rejected param is input[1].id --
      // trusting 64 here would keep replaying whichever ids happen to be
      // shorter than a limit that was never stated for this parameter.
      [
        'treats a maximum reported against a different parameter as absent',
        directBody('input[1].id', MAX_64_MESSAGE.replace('[1]', '[7]')),
        ALL_REASONING_INPUT,
      ],
      [
        'treats a maximum reported against ambiguous parameters as absent',
        directBody(
          'input[1].id',
          "Invalid 'input[1].id' and 'input[3].id': strings too long. " +
            'Expected a string with maximum length 64.',
        ),
        ALL_REASONING_INPUT,
      ],
    ])('%s', async (_title, rejection, retryInput) => {
      expect(await replayAfter([rejection])).toBeUndefined();
      expectRetryDiffersOnlyByInput(retryInput);
    });

    it('does not retry an oversized rejection even when redaction would shrink it below the limit', async () => {
      const rejection = directBody(
        'input[1].id',
        `${MAX_64_MESSAGE} https://review-user:${'s'.repeat(1_000)}@gateway.example`,
      );

      const error = await replayAfter([rejection.padEnd(64_001, ' ')]);

      expect(error).toMatchObject({ status: 400 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sentBody(0).input).toEqual(ORIGINAL_INPUT);
    });

    it('retries exactly once and surfaces the second rejection unchanged', async () => {
      const err = await replayAfter([
        MAX_64_BODY,
        directBody('input[1].id', `${MAX_64_MESSAGE} SECOND-ATTEMPT`),
      ]);
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
      const err = await replayAfter([
        MAX_64_BODY,
        directBody(
          'input[2].id',
          "Invalid 'input[2].id': string too long. Expected a string with " +
            'maximum length 4, but got a string with length 8 instead.',
        ),
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((err as { status?: number }).status).toBe(400);
      expect((err as Error).message).toContain('input[2].id');
      expect(sentBody(1).input).toEqual(OVER_LONG_ONLY_INPUT);
    });

    // ── Controls: every one of these must NOT retry ──────────────────────

    it('control: sends one request when the endpoint accepts the long ids', async () => {
      expect(await replayAfter([])).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sentBody(0).input).toEqual(ORIGINAL_INPUT);
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
      ['a matching body under 500', 500, MAX_64_BODY],
      ['a matching body under 429', 429, MAX_64_BODY],
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
        directBody('input[0].id', MAX_64_MESSAGE.replace('[1]', '[0]')),
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
          debug: `example: ${MAX_64_BODY}`,
        }),
      ],
      [
        'trailing non-whitespace after the top-level object',
        400,
        `${MAX_64_BODY} trailing`,
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
      [
        'a raw newline inside an unrelated top-level field',
        400,
        `{"error":{"message":"${MAX_64_MESSAGE}","param":"input[1].id",` +
          '"code":"string_above_max_length"},"debug":"first\nsecond"}',
      ],
      [
        'a raw NUL inside the recognized error message',
        400,
        `{"error":{"message":"${MAX_64_MESSAGE}\u0000","param":"input[1].id",` +
          '"code":"string_above_max_length"}}',
      ],
      [
        'a vertical tab after the top-level object',
        400,
        `${MAX_64_BODY}\u000b`,
      ],
      ['a form feed after the top-level object', 400, `${MAX_64_BODY}\u000c`],
      [
        'a no-break space after the top-level object',
        400,
        `${MAX_64_BODY}\u00a0`,
      ],
    ])('control: does not retry on %s', async (_label, status, body) => {
      fetchMock.mockResolvedValueOnce(errorResponse(status as number, body));
      const err = await replayAfter([]);
      expect(err).toBeInstanceOf(Error);
      expect((err as { status?: number }).status).toBe(status);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sentBody(0).input).toEqual(ORIGINAL_INPUT);
    });
  });

  describe('non-2xx error body bounds', () => {
    // Resolves with the sentinel when `pending` has not settled inside
    // `ms` of REAL time, so an unbounded wait fails as an assertion instead
    // of hanging the file until the runner's own timeout.
    const UNBOUNDED = 'UNBOUNDED';
    function withRealDeadline<T>(
      pending: Promise<T>,
      ms = 2000,
    ): Promise<T | typeof UNBOUNDED> {
      return Promise.race([
        pending,
        new Promise<typeof UNBOUNDED>((resolve) => {
          const t = setTimeout(() => resolve(UNBOUNDED), ms);
          t.unref?.();
        }),
      ]);
    }

    function abortError() {
      const abortErr = new Error('The operation was aborted');
      abortErr.name = 'AbortError';
      return abortErr;
    }

    /**
     * A 503 whose body flushes one chunk and then never produces another -- a
     * proxy that has committed its status line and stalled. Pending reads
     * reject with AbortError once the request's signal fires, matching what
     * undici does to an in-flight body when the request is aborted. `text`
     * stands in for the response's text().
     */
    function stalled503(init: RequestInit, text: () => Promise<string>) {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":{"message":"'));
          init.signal?.addEventListener(
            'abort',
            () => {
              try {
                controller.error(abortError());
              } catch {
                // Already closed or errored.
              }
            },
            { once: true },
          );
        },
        cancel() {
          cancelled = true;
        },
      });
      const response = { ...errorResponse(503, ''), body: stream, text };
      return { response, wasCancelled: () => cancelled };
    }

    it('bounds a stalled non-2xx error body with a retryable ETIMEDOUT', async () => {
      // The connect timer is cleared once headers arrive, so a proxy that
      // flushes `503` and then stalls its body left the old
      // `await response.text()` waiting with no bound at all.
      let fetchSignal: AbortSignal | undefined;
      let stalled!: ReturnType<typeof stalled503>;
      fetchMock.mockImplementation((_url: string, init: RequestInit) => {
        fetchSignal = init.signal ?? undefined;
        // A real stalled body stalls `text()` too.
        stalled = stalled503(init, () => new Promise<string>(() => {}));
        return Promise.resolve(stalled.response);
      });

      const outcome = await withRealDeadline(
        connectError(pipe({ timeout: 100 })),
      );

      expect(outcome).not.toBe(UNBOUNDED);
      expect(outcome).toBeInstanceOf(ErrorBodyTimeoutError);
      // Retry-classifiable, like every other transport bound on this wire.
      expect(outcome).toMatchObject({ code: 'ETIMEDOUT' });
      expect((outcome as Error).message).toMatch(/error response body/i);
      expect((outcome as Error).message).toContain('503');
      // The abandoned body and the underlying request are both released.
      expect(stalled.wasCancelled()).toBe(true);
      expect(fetchSignal?.aborted).toBe(true);
    }, 15000);

    it('preserves caller AbortError semantics while a non-2xx body is read', async () => {
      // `.catch(() => "")` around the body read swallowed the caller's
      // cancellation and reported an ordinary status-503 failure instead.
      const caller = new AbortController();
      fetchMock.mockImplementation((_url: string, init: RequestInit) =>
        Promise.resolve(
          stalled503(
            init,
            () =>
              new Promise<string>((_resolve, reject) => {
                init.signal?.addEventListener(
                  'abort',
                  () => reject(abortError()),
                  { once: true },
                );
              }),
          ).response,
        ),
      );

      const pending = connectError(
        // Long enough that only the caller's abort can end this.
        pipe({ timeout: 30_000 }),
        caller.signal,
      );
      const abortTimer = setTimeout(() => caller.abort(), 20);
      abortTimer.unref?.();

      const outcome = await withRealDeadline(pending);

      expect(outcome).not.toBe(UNBOUNDED);
      expect((outcome as Error).name).toBe('AbortError');
      // Not transformed into an HTTP status failure.
      expect((outcome as { status?: number }).status).toBeUndefined();
      expect((outcome as Error).message).not.toContain('503');
    }, 15000);

    it('control: a complete streamed error body still classifies for replay recovery', async () => {
      // Bounding the read must not cost the classifier the bytes it needs:
      // the whole body, delivered in chunks, has to arrive intact.
      fetchMock.mockResolvedValueOnce({
        ...errorResponse(400, MAX_64_BODY),
        body: byteStream(MAX_64_BODY, 7),
      });
      fetchMock.mockResolvedValueOnce(okResponse(sseStream(DONE_R1)));

      const thoughtSignature = JSON.stringify({
        id: `rs_${'a'.repeat(80)}`,
        encrypted_content: 'enc',
      });
      await streamed(pipe(), {
        model: 'gpt-5',
        contents: [
          userText('hello'),
          content('model', {
            thought: true,
            text: 'a thought',
            thoughtSignature,
          }),
          userText('continue'),
        ],
      });

      // The rejection was read in full and acted on: one retry went out.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('control: an oversized error body fails closed instead of being classified from a prefix', async () => {
      // A body whose first 64,000 characters happen to be a complete,
      // classifiable object must NOT license a replay recovery -- acting on a
      // truncated body is acting on evidence we do not have.
      const oversized = `${MAX_64_BODY}${' '.repeat(70_000)}`;
      fetchMock.mockResolvedValueOnce({
        ...errorResponse(400, oversized),
        body: byteStream(oversized),
      });
      fetchMock.mockResolvedValueOnce(okResponse(sseStream([])));

      const err = await connectError();

      expect((err as { status?: number }).status).toBe(400);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // The surfaced excerpt stays short whatever the body's size.
      expect((err as Error).message.length).toBeLessThan(700);
    });
  });

  describe('SSE content-type guard', () => {
    // Valid NDJSON: bare JSON objects, one per line, with no SSE framing --
    // exactly what these media types promise and what the reader, which only
    // understands `event:`/`data:` lines, silently turns into zero candidates.
    const NDJSON_LINES = [
      JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' }),
      JSON.stringify({
        type: 'response.completed',
        response: { id: 'r1', status: 'completed' },
      }),
    ];

    it.each(['application/x-ndjson', 'application/stream+json'])(
      'rejects %s, which the SSE reader cannot parse',
      async (contentType) => {
        fetchMock.mockResolvedValue(
          okResponse(sseStream(NDJSON_LINES), contentType),
        );
        await expect(streamed()).rejects.toThrow(/non-SSE content-type/);
      },
    );

    // A response that declares nothing is not a response that declares SSE:
    // the same NDJSON body the labelled cases reject was accepted whenever
    // the header was simply absent, and framed into zero candidates.
    it('rejects a 200 response that declares no content-type at all', async () => {
      fetchMock.mockResolvedValue(okResponse(sseStream(NDJSON_LINES), null));
      await expect(streamed()).rejects.toThrow(/non-SSE content-type/);
    });

    it('control: accepts text/event-stream case-insensitively and with parameters', async () => {
      fetchMock.mockResolvedValue(
        okResponse(
          sseStream([...deltaEvent('hi'), ...DONE_R1]),
          'Text/Event-Stream; charset=utf-8',
        ),
      );
      const chunks = await streamed();
      expect(chunks[0]?.candidates?.[0]?.content?.parts).toEqual([
        { text: 'hi' },
      ]);
    });
  });

  // A per-send `request.config` carries the caller's own sampling and thinking
  // decisions. The sibling Chat wire honors both (pipeline.ts:
  // addParameterIfDefined's request fallback, and buildReasoningConfig's
  // includeThoughts:false opt-out); this wire dropped them on the floor, so
  // the same call produced a different body depending only on which wire it
  // took.
  describe('request-scoped controls', () => {
    const requestWith = (
      config: NonNullable<GenerateContentParameters['config']>,
    ) => ({ ...textRequest('hi'), config });
    const optOut = () =>
      requestWith({ thinkingConfig: { includeThoughts: false } });
    const budget = () =>
      requestWith({ thinkingConfig: { thinkingBudget: 1024 } });
    const OFF = { reasoning: undefined, include: undefined };
    const ENCRYPTED = ['reasoning.encrypted_content'];

    it.each<BodyCase>([
      // 0 is a meaningful temperature, not an absent one; max-token
      // reconciliation is untouched by this.
      [
        'honors request temperature and topP when samplingParams omits those keys',
        { samplingParams: { max_tokens: 321 } },
        { temperature: 0, top_p: 0.25, max_output_tokens: 321 },
        requestWith({ temperature: 0, topP: 0.25 }),
      ],
      [
        'control: honors request temperature and topP when there are no samplingParams at all',
        {},
        { temperature: 0.7, top_p: 0.9 },
        requestWith({ temperature: 0.7, topP: 0.9 }),
      ],
      [
        'control: an explicit samplingParams value still wins over the request value',
        { samplingParams: { temperature: 0.9, top_p: 0.1 } },
        { temperature: 0.9, top_p: 0.1 },
        requestWith({ temperature: 0, topP: 0.25 }),
      ],
      // The encrypted-reasoning include exists only to round-trip reasoning;
      // it must go with it.
      [
        'suppresses reasoning and include when the request opts out with includeThoughts:false',
        { reasoning: { effort: 'high' } },
        OFF,
        optOut(),
      ],
      [
        'suppresses a legacy extra_body.enable_thinking when the request opts out',
        { extra_body: { enable_thinking: true } },
        { ...OFF, enable_thinking: undefined },
        optOut(),
      ],
      // The opt-out has to survive the whole build, not just buildReasoning():
      // leaving `reasoning`/`include` off the request literal is exactly what
      // makes the fill-only extra_body merge eligible to put them back, so a
      // configured extra_body silently re-enabled thinking on the wire.
      [
        'does not let extra_body reintroduce reasoning or include when the request opts out',
        {
          reasoning: { effort: 'high' },
          extra_body: {
            reasoning: { effort: 'low' },
            include: ['reasoning.encrypted_content'],
          },
        },
        OFF,
        optOut(),
      ],
      [
        'control: extra_body still fills reasoning and include when the request does not opt out',
        {
          extra_body: {
            reasoning: { effort: 'low' },
            include: ['reasoning.encrypted_content'],
          },
        },
        { reasoning: { effort: 'low' }, include: ENCRYPTED },
        budget(),
      ],
      [
        'control: a generated reasoning still outranks extra_body when the request does not opt out',
        {
          reasoning: { effort: 'high' },
          extra_body: { reasoning: { effort: 'low' }, include: ['ignored'] },
        },
        { reasoning: { effort: 'high', summary: 'auto' }, include: ENCRYPTED },
        budget(),
      ],
      [
        'control: a request opt-out leaves unrelated extra_body keys alone',
        {
          reasoning: { effort: 'high' },
          extra_body: { service_tier: 'priority' },
        },
        { ...OFF, service_tier: 'priority' },
        optOut(),
      ],
      [
        'control: a thinkingConfig without includeThoughts leaves configured reasoning intact',
        { reasoning: { effort: 'high' } },
        { reasoning: { effort: 'high', summary: 'auto' }, include: ENCRYPTED },
        budget(),
      ],
    ])('%s', expectBody);
  });
});
