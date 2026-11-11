/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsService } from '@qwen-code/resource';
import type { CustomClient } from '../../client/customClient.js';
import { ClientError } from '../../client/clientError.js';
import { PREDICTION_FORK_REQUEST } from '../../model-request/request-scope.js';
import { CustomApiImpl } from '../../client/impl/custom.js';
import { CustomOutboundPipeline } from '../../client/pipeline/customOutboundPipeline.js';
import { CustomResponse } from '../../client/response/customResponse.js';
import type { Model } from '../model/model.js';
import type { ModelStreamEvent } from '../event/modelStreamEvent.js';
import type { ModelStreamRequest } from '../modelStreamRequest.js';
import type { ModelStreamResponse } from '../modelStreamResponse.js';
import { ModelInferenceError } from '../modelInferenceError.js';
import { ModelTransportManager } from '../transport/modelTransportManager.js';
import type { ModelTransport } from '../transport/modelTransport.js';
import { OPENAI_CHAT_COMPLETIONS } from '../transport/modelProtocol.js';
import { ChatCompletionsTransport } from '../transport/impl/chatCompletionsTransport.js';
import { ResponsesTransport } from '../transport/impl/responsesTransport.js';
import { MessagesTransport } from '../transport/impl/messagesTransport.js';
import { CustomModelProvider } from './customModelProvider.js';
import { CustomProviderConfig } from './customProviderConfig.js';

const model: Model = {
  source: 'local',
  key: 'local/m',
  displayName: 'M',
  capabilities: {
    tools: true,
    vision: false,
    reasoning: { supported: true, supportedEfforts: ['low'] },
    contextWindows: [],
  },
  limits: { maxContextTokens: 200000 },
};
const start = (id = 'message'): ModelStreamEvent => ({
  type: 'message_start',
  message: { id, model: 'm', role: 'assistant' },
});
function text(value = 'answer'): ModelStreamEvent[] {
  return [
    {
      type: 'content_block_start',
      index: 0,
      contentBlock: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: value },
    },
    { type: 'content_block_stop', index: 0 },
  ];
}
function think(index = 0): ModelStreamEvent[] {
  return [
    {
      type: 'content_block_start',
      index,
      contentBlock: { type: 'thinking', thinking: '' },
    },
    {
      type: 'content_block_delta',
      index,
      delta: { type: 'thinking_delta', thinking: `thought-${index}` },
    },
    { type: 'content_block_stop', index },
  ];
}
const terminal: ModelStreamEvent[] = [
  {
    type: 'message_delta',
    delta: { stopReason: 'end_turn' },
    usage: { inputTokens: 10, outputTokens: 2 },
  },
  { type: 'message_stop' },
];
const socketError = () =>
  Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
function setup(
  step: (
    attempt: number,
    request: ModelStreamRequest,
  ) => AsyncGenerator<ModelStreamEvent>,
  transport?: ModelTransport,
  client = {} as CustomClient,
) {
  const requests: ModelStreamRequest[] = [];
  const stream = vi.fn<ModelTransport['stream']>((_client, request) => {
    requests.push(request);
    return step(requests.length, request);
  });
  const provider = new CustomModelProvider({
    transportManager: new ModelTransportManager([
      transport ?? { protocol: OPENAI_CHAT_COMPLETIONS, stream },
    ]),
    config: new CustomProviderConfig({
      providerId: 'local',
      baseUrl: 'https://unused.invalid',
      apiKey: 'secret-key',
      protocol: transport?.protocol ?? OPENAI_CHAT_COMPLETIONS,
      models: [model],
    }),
    client,
    settingsService: new SettingsService(),
    scope: 'user',
  });
  const input: ModelStreamRequest = {
    resolution: { model, config: { sampling: { temperature: 0.2 } } },
    prompt: { messages: [{ role: 'user', content: 'hello' }] },
  };
  return {
    provider,
    input,
    stream,
    requests,
    execute: () => provider.inference(input),
  };
}
async function events(response: ModelStreamResponse) {
  const collected = [];
  for await (const event of response.events) collected.push(event);
  return collected;
}
function failures(response: ModelStreamResponse) {
  return Promise.all([
    response.completed.catch((error: unknown) => error),
    events(response).catch((error: unknown) => error),
  ]);
}
async function flush() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CustomModelProvider inference retries', () => {
  it.each([
    'HTTP 500',
    'HTTP 429',
    'connection failure',
    'interrupted reasoning',
    'empty completion',
    'reasoning-only completion',
    'premature EOF',
  ])('attempts a prediction fork only once after %s', async (failure) => {
    const h = setup(async function* () {
      if (failure.startsWith('HTTP')) {
        throw new ClientError('transient', {
          statusCode: failure === 'HTTP 500' ? 500 : 429,
        });
      }
      yield start();
      if (
        failure === 'interrupted reasoning' ||
        failure === 'reasoning-only completion'
      ) {
        yield* think();
      }
      if (
        failure === 'connection failure' ||
        failure === 'interrupted reasoning'
      ) {
        throw socketError();
      }
      if (failure !== 'premature EOF') yield* terminal;
    });
    Object.assign(h.input, { [PREDICTION_FORK_REQUEST]: true });
    const response = await h.execute();
    const failed = failures(response);
    await vi.runAllTimersAsync();
    const [completed, streamed] = await failed;
    expect(completed).toBeInstanceOf(ModelInferenceError);
    expect(streamed).toBe(completed);
    expect(h.stream).toHaveBeenCalledOnce();
    expect((await response.partial).blocks).toEqual(
      failure.includes('reasoning')
        ? [{ type: 'thinking', thinking: 'thought-0' }]
        : [],
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries before payload even when only completed is consumed and preserves model/prompt', async () => {
    const h = setup(async function* (attempt) {
      yield start();
      if (attempt === 1) throw socketError();
      yield* text();
      yield* terminal;
    });
    const response = await h.execute();
    await vi.runAllTimersAsync();
    expect((await response.completed).blocks).toEqual([
      { type: 'text', text: 'answer' },
    ]);
    expect(h.stream).toHaveBeenCalledTimes(2);
    for (const request of h.requests) {
      expect(request.resolution).toBe(h.input.resolution);
      expect(request.prompt).toBe(h.input.prompt);
    }
    expect(
      (await events(response)).filter(
        (event) => event.type === 'message_start',
      ),
    ).toHaveLength(1);
  });

  it('delivers reasoning live but aggregates only the successful attempt', async () => {
    const h = setup(async function* (attempt) {
      yield start(`a${attempt}`);
      if (attempt === 1) {
        yield* think();
        yield* think(1);
        throw socketError();
      }
      yield* text();
      yield* terminal;
    });
    const response = await h.execute();
    const iterator = response.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({
      type: 'message_start',
      message: { id: 'a1' },
    });
    expect(h.stream).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    expect(await response.completed).toMatchObject({
      messageId: 'a2',
      blocks: [{ type: 'text', text: 'answer' }],
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    expect((await response.partial).blocks).toEqual([
      { type: 'text', text: 'answer' },
    ]);
  });

  it('exhausts the reasoning budget with the same terminal error on both channels', async () => {
    const h = setup(async function* (attempt) {
      yield start(`a${attempt}`);
      yield* think();
      throw socketError();
    });
    const response = await h.execute();
    const failed = failures(response);
    await vi.runAllTimersAsync();
    const [completed, streamed] = await failed;
    expect(completed).toBe(streamed);
    expect(completed).toMatchObject({ kind: 'network', phase: 'after_output' });
    expect(h.stream).toHaveBeenCalledTimes(3);
    expect((await response.partial).messageId).toBe('a3');
  });

  it.each(['text', 'tool'] as const)(
    'protects emitted %s from replay',
    async (kind) => {
      const h = setup(async function* () {
        yield start();
        if (kind === 'text') yield* text('partial');
        else
          yield {
            type: 'content_block_start',
            index: 0,
            contentBlock: {
              type: 'tool_use',
              id: 'call',
              name: 'read',
              input: {},
            },
          };
        throw socketError();
      });
      const failed = failures(await h.execute());
      await vi.runAllTimersAsync();
      expect((await failed)[0]).toMatchObject({ phase: 'after_output' });
      expect(h.stream).toHaveBeenCalledTimes(1);
    },
  );

  it('never replays a delivered complete tool', async () => {
    const tool = setup(async function* () {
      yield start();
      yield {
        type: 'content_block_start',
        index: 0,
        contentBlock: { type: 'tool_use', id: 'call', name: 'read', input: {} },
      };
      yield { type: 'content_block_stop', index: 0 };
      throw socketError();
    });
    const failed = failures(await tool.execute());
    await vi.runAllTimersAsync();
    await failed;
    expect(tool.stream).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'bounds semantic-empty replays independently (reasoning=%s)',
    async (reasoning) => {
      const h = setup(async function* () {
        yield start();
        if (reasoning) yield* think();
        yield* terminal;
      });
      const response = await h.execute();
      const failed = failures(response);
      await vi.runAllTimersAsync();
      expect((await failed)[0]).toMatchObject({
        code: 'empty_assistant_completion',
      });
      expect(h.stream).toHaveBeenCalledTimes(3);
    },
  );

  it('only publishes terminal events from a validated completion', async () => {
    const h = setup(async function* (attempt) {
      yield start();
      if (attempt === 1) yield* think();
      else yield* text();
      yield* terminal;
    });
    const response = await h.execute();
    const collected = events(response);
    await vi.runAllTimersAsync();
    await response.completed;
    expect(
      (await collected).filter((event) => event.type === 'message_complete'),
    ).toHaveLength(1);
    expect(
      (await collected).filter((event) => event.type === 'message_stop'),
    ).toHaveLength(1);
  });

  it('bounds repeated transport failures to five attempts', async () => {
    const h = setup(async function* () {
      yield start();
      throw socketError();
    });
    const failed = failures(await h.execute());
    await vi.runAllTimersAsync();
    await failed;
    expect(h.stream).toHaveBeenCalledTimes(5);
  });

  it.each(['refusal', 'max_tokens'] as const)(
    'never retries after %s',
    async (stopReason) => {
      const h = setup(async function* () {
        yield start();
        yield { type: 'message_delta', delta: { stopReason } };
        throw socketError();
      });
      const failed = failures(await h.execute());
      await vi.runAllTimersAsync();
      await failed;
      expect(h.stream).toHaveBeenCalledTimes(1);
    },
  );

  it.each([401, 403, 400, 413])(
    'preserves terminal HTTP %s and redacts the API key',
    async (statusCode) => {
      const h = setup(async function* () {
        yield start();
        throw new ClientError('upstream rejected secret-key', { statusCode });
      });
      const failed = failures(await h.execute());
      await vi.runAllTimersAsync();
      const [error, streamed] = await failed;
      expect(error).toBe(streamed);
      expect(error).toMatchObject({
        status: statusCode,
        phase: 'before_output',
        message: 'upstream rejected [REDACTED]',
      });
      expect(h.stream).toHaveBeenCalledTimes(1);
    },
  );

  it.each([408, 429, 500, 503])(
    'retries transient HTTP %s',
    async (statusCode) => {
      const h = setup(async function* (attempt) {
        if (attempt === 1) throw new ClientError('transient', { statusCode });
        yield start();
        yield* text();
        yield* terminal;
      });
      const response = await h.execute();
      await vi.runAllTimersAsync();
      await response.completed;
      expect(h.stream).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['protocol', 'certificate'] as const)(
    'does not retry %s errors with nested network causes',
    async (kind) => {
      const cause = socketError();
      const error =
        kind === 'protocol'
          ? new ModelInferenceError('invalid sequence', {
              kind: 'protocol',
              phase: 'before_output',
              cause,
            })
          : Object.assign(new Error('certificate rejected', { cause }), {
              code: 'CERT_HAS_EXPIRED',
            });
      const h = setup(async function* () {
        yield* [];
        throw error;
      });
      const failed = failures(await h.execute());
      await vi.runAllTimersAsync();
      await failed;
      expect(h.stream).toHaveBeenCalledTimes(1);
    },
  );

  it('honors Retry-After and cancels a backoff without sending again', async () => {
    const h = setup(async function* () {
      yield* [];
      throw new ModelInferenceError('busy', {
        kind: 'server',
        phase: 'before_output',
        retryAfterMs: 2000,
      });
    });
    const controller = new AbortController();
    const response = await h.provider.inference({
      ...h.input,
      control: { signal: controller.signal },
    });
    const failed = failures(response);
    await flush();
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.stream).toHaveBeenCalledTimes(1);
    const reason = new Error('cancel retry');
    controller.abort(reason);
    expect((await failed)[0]).toBe(reason);
    expect(h.requests[0].control?.signal?.aborted).toBe(true);
    await vi.runAllTimersAsync();
    expect(h.stream).toHaveBeenCalledTimes(1);
  });

  it('cancel aborts an active transport even without a caller signal and ignores late events', async () => {
    const h = setup(async function* (_attempt, request) {
      yield start();
      yield* think();
      await new Promise<void>((resolve) =>
        request.control?.signal?.addEventListener('abort', () => resolve(), {
          once: true,
        }),
      );
      yield* text('late');
      yield* terminal;
    });
    const response = await h.execute();
    const failed = failures(response);
    await flush();
    const reason = new Error('explicit cancellation');
    await response.cancel?.(reason);
    const [error, streamed] = await failed;
    expect(error).toBe(reason);
    expect(streamed).toBe(reason);
    expect(h.requests[0].control?.signal?.aborted).toBe(true);
    expect((await response.partial).blocks).toEqual([
      { type: 'thinking', thinking: 'thought-0' },
    ]);
    await vi.runAllTimersAsync();
    expect(h.stream).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'detects EOF without message_stop (stop reason received=%s)',
    async (hasReason) => {
      const h = setup(async function* (attempt) {
        yield start();
        if (attempt === 1) {
          if (hasReason) yield terminal[0];
          return;
        }
        yield* text();
        yield* terminal;
      });
      const response = await h.execute();
      await vi.runAllTimersAsync();
      expect((await response.completed).blocks).toEqual([
        { type: 'text', text: 'answer' },
      ]);
      expect(h.stream).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['refusal', 'max_tokens'] as const)(
    'accepts a normal %s completion without resampling',
    async (stopReason) => {
      const h = setup(async function* () {
        yield start();
        yield { type: 'message_delta', delta: { stopReason } };
        yield { type: 'message_stop' };
      });
      const response = await h.execute();
      await vi.runAllTimersAsync();
      expect((await response.completed).stopReason).toBe(stopReason);
      expect(h.stream).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps malformed responses terminal even with a nested socket error', async () => {
    const h = setup(async function* () {
      yield start();
      throw new ClientError('invalid SSE event', {
        code: 'malformed_response',
        cause: socketError(),
      });
    });
    const failed = failures(await h.execute());
    await vi.runAllTimersAsync();
    expect((await failed)[0]).toMatchObject({ kind: 'protocol' });
    expect(h.stream).toHaveBeenCalledTimes(1);
  });

  it('stop cancels pending retries without stopping another provider', async () => {
    const h = setup(async function* () {
      yield start();
      throw socketError();
    });
    const other = setup(async function* () {
      yield start();
      yield* text();
      yield* terminal;
    });
    const response = await h.execute();
    const failed = failures(response);
    await flush();
    await h.provider.stop();
    const [error, streamed] = await failed;
    expect(error).toBe(streamed);
    expect(error).toMatchObject({ name: 'AbortError' });
    await vi.runAllTimersAsync();
    expect(h.stream).toHaveBeenCalledTimes(1);
    expect((await (await other.execute()).completed).blocks).toEqual([
      { type: 'text', text: 'answer' },
    ]);
  });

  it('isolates concurrent inference retry state', async () => {
    const counts = new Map<string, number>();
    const h = setup(async function* (_attempt, request) {
      const key = String(request.prompt.messages[0].content);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count === 1) throw socketError();
      yield start(key);
      yield* text(key);
      yield* terminal;
    });
    const first = await h.execute();
    const second = await h.provider.inference({
      ...h.input,
      prompt: { messages: [{ role: 'user', content: 'other' }] },
    });
    await vi.runAllTimersAsync();
    expect((await first.completed).blocks).toEqual([
      { type: 'text', text: 'hello' },
    ]);
    expect((await second.completed).blocks).toEqual([
      { type: 'text', text: 'other' },
    ]);
    expect([...counts.values()]).toEqual([2, 2]);
  });
});

describe('CustomModelProvider premature EOF through real transports', () => {
  it.each([
    {
      transport: new ChatCompletionsTransport(),
      api: 'chatCompletions',
      partial: [
        {
          id: 'first',
          model: 'm',
          choices: [
            {
              index: 0,
              delta: { reasoning_content: 'thinking' },
              finish_reason: null,
            },
          ],
        },
      ],
      success: [
        {
          id: 'second',
          model: 'm',
          choices: [
            { index: 0, delta: { content: 'answer' }, finish_reason: 'stop' },
          ],
        },
      ],
    },
    {
      transport: new ResponsesTransport(),
      api: 'responses',
      partial: [
        { type: 'response.created', response: { id: 'first', model: 'm' } },
        {
          type: 'response.reasoning_summary_text.delta',
          output_index: 0,
          item_id: 'rs',
          delta: 'thinking',
        },
      ],
      success: [
        { type: 'response.created', response: { id: 'second', model: 'm' } },
        {
          type: 'response.output_text.delta',
          output_index: 0,
          delta: 'answer',
        },
        { type: 'response.completed', response: {} },
      ],
    },
    {
      transport: new MessagesTransport(),
      api: 'messages',
      partial: [
        { type: 'message_start', message: { id: 'first', model: 'm' } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: 'thinking' },
        },
      ],
      success: [
        { type: 'message_start', message: { id: 'second', model: 'm' } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: 'answer' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ],
    },
  ])(
    'recovers truncated $api without mixing attempts',
    async ({ transport, api, partial, success }) => {
      const wire = vi
        .fn()
        .mockImplementationOnce(async function* () {
          yield* partial;
        })
        .mockImplementationOnce(async function* () {
          yield* success;
        });
      const client = {
        api: { inference: { [api]: { stream: wire } } },
      } as unknown as CustomClient;
      const h = setup(
        async function* () {
          yield* [];
        },
        transport,
        client,
      );
      const response = await h.execute();
      const collected = events(response);
      await vi.runAllTimersAsync();
      expect((await response.completed).blocks).toEqual([
        { type: 'text', text: 'answer' },
      ]);
      expect(wire).toHaveBeenCalledTimes(2);
      expect(
        (await collected).filter((event) => event.type === 'message_complete'),
      ).toHaveLength(1);
    },
  );
});

it('preserves HTTP 403/code 122 as a third-party auth failure', async () => {
  const pipeline = new CustomOutboundPipeline();
  const reply = CustomResponse.initial();
  reply.raw = new Response(
    JSON.stringify({ error: { code: '122', message: 'Forbidden' } }),
    { status: 403 },
  );
  const wire = vi.spyOn(pipeline, 'execute').mockResolvedValue(reply);
  const h = setup(
    async function* () {
      yield* [];
    },
    new ResponsesTransport(),
    { api: new CustomApiImpl(pipeline) },
  );
  const response = await h.execute();

  await expect(response.completed).rejects.toMatchObject({
    code: '122',
    status: 403,
    kind: 'auth',
  });
  expect(wire).toHaveBeenCalledTimes(1);
});
