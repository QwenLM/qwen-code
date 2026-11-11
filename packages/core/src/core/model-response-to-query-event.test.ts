/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  convertModelResponse,
  createModelResponseDelivery,
  getDeliveredModelMessage,
  getUndeliveredModelTools,
} from './model-response-to-query-event.js';
import type { AssistantBlockEvent, StreamEvent } from './query-event.js';
import type { ModelStreamResponse } from '../provider/modelStreamResponse.js';
import type {
  ModelContentBlock,
  ModelMessage,
} from '../provider/event/modelCompleteEvent.js';
import type {
  ModelStreamEvent,
  ModelStreamUsage,
  ModelStopReason,
} from '../provider/event/modelStreamEvent.js';
import { createModelStreamResponse } from '../provider/modelStreamResponseFactory.js';
import { buildChatCompletionsStreamEvents } from '../provider/transport/impl/chat-completions-factory/response/chatCompletionsStreamRespFactory.js';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import { ModelInferenceError } from '../provider/modelInferenceError.js';
import { convertMessages } from '../protocol/provider/request-converter.js';
import { UNPARSED_TOOL_INPUT } from '../protocol/provider/tool-input.js';
import { projectModelStreamEventForSdk } from '../engine/headless-projection.js';
import { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream';

const start = (usage?: ModelStreamUsage): ModelStreamEvent => ({
  type: 'message_start',
  message: {
    id: 'message-1',
    role: 'assistant',
    model: 'test-model',
    ...(usage ? { usage } : {}),
  },
});
const terminal = (
  stopReason: ModelStopReason = 'end_turn',
  usage?: ModelStreamUsage,
): ModelStreamEvent[] => [
  {
    type: 'message_delta',
    delta: { stopReason },
    ...(usage ? { usage } : {}),
  },
  { type: 'message_stop' },
];
const text = (index = 0, value = '回答'): ModelStreamEvent[] => [
  {
    type: 'content_block_start',
    index,
    contentBlock: { type: 'text', text: '' },
  },
  {
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text: value },
  },
  { type: 'content_block_stop', index },
];
const tool = (index = 0, json = '{"path":"a.ts"}'): ModelStreamEvent[] => [
  {
    type: 'content_block_start',
    index,
    contentBlock: {
      type: 'tool_use',
      id: `tool-${index}`,
      name: 'read_file',
      input: {},
    },
  },
  {
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: json },
  },
  { type: 'content_block_stop', index },
];

function responseFrom(
  events: ModelStreamEvent[],
  error?: unknown,
  cancel = vi.fn(),
): ModelStreamResponse {
  return createModelStreamResponse(
    (async function* () {
      yield* events;
      if (error !== undefined) throw error;
    })(),
    cancel,
  );
}

async function collect(response: ModelStreamResponse, signal?: AbortSignal) {
  const gen = convertModelResponse({
    response,
    requestId: 'request-1',
    signal,
  });
  const events: Array<StreamEvent | AssistantBlockEvent> = [];
  while (true) {
    const next = await gen.next();
    if (next.done) {
      return {
        events,
        result: next.value,
        message: next.value,
      };
    }
    events.push(next.value);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const modelResult = (): ModelMessage => ({
  messageId: 'message-1',
  model: 'test-model',
  blocks: [{ type: 'text', text: '回答' }],
  stopReason: 'end_turn',
});

function dualResponse(
  events: ModelStreamResponse['events'],
  completed: Promise<ModelMessage>,
): ModelStreamResponse {
  return {
    events,
    completed,
    partial: Promise.resolve({
      messageId: 'message-1',
      model: 'test-model',
      blocks: [],
      openBlocks: new Map(),
    }),
    cancel: vi.fn(),
  };
}

async function* items<T>(values: T[]) {
  yield* values;
}

describe('convertModelResponse', () => {
  it('终值与完成块均保持标准模型类型，QueryEvent 不生成旧消息外壳', async () => {
    const response = responseFrom([
      start({ inputTokens: 12 }),
      ...text(7),
      ...terminal('end_turn', { outputTokens: 6 }),
    ]);
    const { result, events } = await collect(response);
    expect(result).toMatchObject({
      messageId: 'message-1',
      model: 'test-model',
      stopReason: 'end_turn',
      usage: { inputTokens: 12, outputTokens: 6 },
    });
    expect(result.blocks[7]).toEqual({ type: 'text', text: '回答' });
    expect(result.blocks).toBe((await response.completed).blocks);
    expect(result).not.toHaveProperty('content');
    expect(result).not.toHaveProperty('stop_reason');
    expect(result.usage).not.toHaveProperty('request_id');
    expect(
      events.find((event) => event.type === 'assistant_block'),
    ).toMatchObject({
      message: { blocks: [{ type: 'text', text: '回答' }] },
      index: 7,
      requestId: 'request-1',
    });
  });

  it('转换六类原语和完整块，保持 index、消息外壳及先块后 stop 的时序', async () => {
    const { events, message } = await collect(
      responseFrom([start(), ...text(7), ...terminal()]),
    );
    expect(
      events.map((event) =>
        event.type === 'stream_event' ? event.event.type : event.type,
      ),
    ).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'assistant_block',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    const first = events[0];
    expect(first).toEqual({
      type: 'stream_event',
      requestId: 'request-1',
      event: start(),
    });
    expect(events[3]).toMatchObject({
      type: 'assistant_block',
      index: 7,
      requestId: 'request-1',
      message: {
        messageId: 'message-1',
        blocks: [{ type: 'text', text: '回答' }],
      },
    });
    expect(message).toMatchObject({
      messageId: 'message-1',
      model: 'test-model',
      stopReason: 'end_turn',
    });
  });

  it('直接使用 complete 内容，不在正常路径重建正文', async () => {
    const result = modelResult();
    const response = dualResponse(
      items([
        start(),
        {
          type: 'content_block_start' as const,
          index: 0,
          contentBlock: { type: 'text' as const, text: '' as const },
        },
        {
          type: 'content_block_complete' as const,
          index: 0,
          block: result.blocks[0],
        },
        { type: 'content_block_stop' as const, index: 0 },
        terminal()[0],
        { type: 'message_complete' as const, result },
        { type: 'message_stop' as const },
      ]),
      Promise.resolve(result),
    );
    expect((await collect(response)).message.blocks).toEqual([
      { type: 'text', text: '回答' },
    ]);
  });

  it('按字段更新 usage，保留开始用量、零值、缓存可用性和 reasoning 扩展', async () => {
    const { events, message } = await collect(
      responseFrom([
        start({
          inputTokens: 100,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 9,
        }),
        ...text(),
        ...terminal('end_turn', {
          outputTokens: 4,
          cacheReadInputTokens: 0,
          reasoningTokens: 2,
        }),
      ]),
    );
    expect(message.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 4,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 9,
      reasoningTokens: 2,
    });
    expect(message.usage).not.toHaveProperty('thinking_tokens');
    expect(message.usage).not.toHaveProperty('request_id');
    const delta = events.find(
      (event) =>
        event.type === 'stream_event' && event.event.type === 'message_delta',
    );
    expect(delta).toMatchObject({
      event: {
        usage: { inputTokens: 100, outputTokens: 4 },
        delta: { stopReason: 'end_turn' },
      },
    });
  });

  it('未上报的缓存计数保持缺省，块事件不补造默认用量', async () => {
    const { events, message } = await collect(
      responseFrom([start(), ...text(), ...terminal()]),
    );
    expect(message.usage?.cacheReadInputTokens).toBeUndefined();
    expect(message.usage?.cacheCreationInputTokens).toBeUndefined();
    const block = events.find((event) => event.type === 'assistant_block');
    if (block?.type !== 'assistant_block') throw new Error('缺少块');
    expect(block.message.usage).toBeUndefined();
    expect(block.message).not.toHaveProperty('content');
    expect(message.usage).not.toHaveProperty('server_tool_use');
  });

  it('后续明确上报的 input/output 零值覆盖旧值，不按帧相加', async () => {
    const { message } = await collect(
      responseFrom([
        start({ inputTokens: 10, outputTokens: 3 }),
        ...text(),
        ...terminal('end_turn', { inputTokens: 0, outputTokens: 0 }),
      ]),
    );
    expect(message.usage).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('思考元数据进入原语、块完成及整轮历史，回传时不丢失或共享可变对象', async () => {
    const reasoning = Object.freeze({
      id: 'rs-history',
      type: 'reasoning',
      status: 'completed' as const,
      summary: Object.freeze([
        Object.freeze({ type: 'summary_text', text: '原始摘要' }),
      ]),
      content: Object.freeze([
        Object.freeze({ type: 'reasoning_text', text: '原始内容' }),
      ]),
    });
    const response = responseFrom([
      start(),
      {
        type: 'content_block_start',
        index: 0,
        contentBlock: { type: 'thinking', thinking: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '显示摘要' },
      },
      { type: 'content_block_stop', index: 0, reasoning },
      {
        type: 'content_block_start',
        index: 1,
        contentBlock: { type: 'redacted_thinking', data: 'cipher', reasoning },
      },
      { type: 'content_block_stop', index: 1 },
      ...terminal(),
    ]);
    const { events, message } = await collect(response);
    expect(message.blocks).toEqual([
      {
        type: 'thinking',
        thinking: '显示摘要',
        reasoning,
      },
      { type: 'redacted_thinking', data: 'cipher', reasoning },
    ]);
    const completions = events.filter(
      (event) => event.type === 'assistant_block',
    );
    expect(completions.map((event) => event.message.blocks[0])).toEqual(
      (await response.completed).blocks,
    );
    const stop = events.find(
      (event) =>
        event.type === 'stream_event' &&
        event.event.type === 'content_block_stop',
    );
    expect(stop).toMatchObject({ event: { reasoning } });
    if (stop?.type === 'stream_event')
      expect(stop.event).not.toHaveProperty('reasoning_item');
    expect(convertMessages([{
      role: 'assistant',
      content: message.blocks.filter((block) => block.type !== 'tool_use'),
    }])[0].content).toEqual([
      { type: 'thinking', thinking: '显示摘要', reasoning },
      { type: 'redacted_thinking', data: 'cipher', reasoning },
    ]);
    const block = completions[0].message.blocks[0];
    if (block.type !== 'thinking' || !block.reasoning?.summary)
      throw new Error('缺少思考元数据');
    Object.defineProperty(block.reasoning.summary[0], 'text', {
      value: '下游修改',
    });
    expect(reasoning.summary[0].text).toBe('原始摘要');
    expect(message.blocks[0]).toMatchObject({ reasoning });
    expect((await response.completed).blocks[0]).toMatchObject({ reasoning });
  });

  it('保留 thinking 签名及 redacted 密文，缺省签名不补造', async () => {
    const events: ModelStreamEvent[] = [
      start(),
      {
        type: 'content_block_start',
        index: 0,
        contentBlock: { type: 'thinking', thinking: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '思考' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        contentBlock: { type: 'thinking', thinking: '' },
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'content_block_start',
        index: 2,
        contentBlock: { type: 'redacted_thinking', data: 'opaque+/=密文' },
      },
      { type: 'content_block_stop', index: 2 },
      ...text(3),
      ...terminal(),
    ];
    const converted = await collect(responseFrom(events));
    expect(converted.message.blocks.slice(0, 3)).toEqual([
      { type: 'thinking', thinking: '思考', signature: 'sig' },
      { type: 'thinking', thinking: '' },
      { type: 'redacted_thinking', data: 'opaque+/=密文' },
    ]);
    expect(
      converted.events.filter((event) => event.type === 'assistant_block')[2],
    ).toMatchObject({ message: { blocks: [{ data: 'opaque+/=密文' }] } });
  });

  it.each(['{"path":"a.ts"}', '{"path":"a.ts"', ''])(
    '转换合法工具参数 %s',
    async (json) => {
      const { message } = await collect(
        responseFrom([start(), ...tool(4, json), ...terminal('tool_use')]),
      );
      expect(message.blocks[4]).toEqual({
        type: 'tool_use',
        id: 'tool-4',
        name: 'read_file',
        input: json ? { path: 'a.ts' } : {},
      });
    },
  );

  it('修复后的完成事件仍先于对应 stop，最终结果与工具交付一致', async () => {
    const response = responseFrom([
      start(),
      ...tool(0, '{"path":"a.ts"'),
      ...terminal('tool_use'),
    ]);
    const { events, message } = await collect(response);
    const completeIndex = events.findIndex(
      (event) => event.type === 'assistant_block',
    );
    const stopIndex = events.findIndex(
      (event) =>
        event.type === 'stream_event' &&
        event.event.type === 'content_block_stop',
    );
    expect(completeIndex).toBeGreaterThan(-1);
    expect(stopIndex).toBe(completeIndex + 1);
    expect(events[completeIndex]).toMatchObject({
      message: { blocks: [{ input: { path: 'a.ts' } }] },
    });
    expect(message.blocks).toBe((await response.completed).blocks);
    expect(message.blocks[0]).not.toHaveProperty('inputJson');
    const streamedInput = events
      .flatMap((event) =>
        event.type === 'stream_event' &&
        event.event.type === 'content_block_delta' &&
        event.event.delta.type === 'input_json_delta'
          ? [event.event.delta.partial_json]
          : [],
      )
      .join('');
    expect(JSON.parse(streamedInput)).toEqual({ path: 'a.ts' });
  });

  it.each(['tool', 'text'] as const)(
    '修复前置工具后保持后续 %s 的交付顺序和 SDK 块回调',
    async (following) => {
      const response = responseFrom([
        start(),
        ...tool(0, '{"path":"a.ts"'),
        ...(following === 'tool' ? tool(1) : text(1)),
        ...terminal('tool_use'),
      ]);
      const { events } = await collect(response);
      const primitives = events.flatMap((event) =>
        event.type === 'stream_event' ? [event.event] : [],
      );
      expect(
        primitives.flatMap((event) =>
          event.type === 'content_block_start' ||
          event.type === 'content_block_stop'
            ? [[event.type, event.index]]
            : [],
        ),
      ).toEqual([
        ['content_block_start', 0],
        ['content_block_stop', 0],
        ['content_block_start', 1],
        ['content_block_stop', 1],
      ]);
      expect(
        events.flatMap((event) =>
          event.type === 'assistant_block' ? [event.index] : [],
        ),
      ).toEqual([0, 1]);

      const readable = new ReadableStream<Uint8Array>({
        start(controller) {
          const wire = primitives
            .map((event) =>
              JSON.stringify(projectModelStreamEventForSdk(event)),
            )
            .join('\n');
          controller.enqueue(new TextEncoder().encode(`${wire}\n`));
          controller.close();
        },
      });
      const sdk = MessageStream.fromReadableStream(readable);
      const callbacks: string[] = [];
      sdk.on('contentBlock', (block) => {
        callbacks.push(block.type === 'tool_use' ? block.id : block.type);
      });
      await sdk.finalMessage();
      expect(callbacks).toEqual([
        'tool-0',
        following === 'tool' ? 'tool-1' : 'text',
      ]);
    },
  );

  it('多个待修复工具与合法工具按原始关块顺序交付', async () => {
    const { events, message } = await collect(
      responseFrom([
        start(),
        ...tool(0, '{"path":"a.ts"'),
        ...tool(1),
        ...tool(2, '{"path":"c.ts"'),
        ...terminal('tool_use'),
      ]),
    );
    expect(
      events.flatMap((event) =>
        event.type === 'assistant_block' ? [event.index] : [],
      ),
    ).toEqual([0, 1, 2]);
    expect(message.blocks).toMatchObject([
      { input: { path: 'a.ts' } },
      { input: { path: 'a.ts' } },
      { input: { path: 'c.ts' } },
    ]);
  });

  it.each(['end_turn', 'max_tokens', 'refusal'] as const)(
    '%s 不修复参数，也不让后续合法工具提前交付',
    async (stopReason) => {
      const raw = '{"path":"a.ts"';
      const { events, message } = await collect(
        responseFrom([
          start(),
          ...tool(0, raw),
          ...tool(1),
          ...terminal(stopReason),
        ]),
      );
      expect(
        events.flatMap((event) =>
          event.type === 'assistant_block' ? [event.index] : [],
        ),
      ).toEqual([0, 1]);
      expect(message.blocks[0]).toMatchObject({ input: {}, inputJson: raw });
    },
  );

  it.each(['tool_calls', 'length', 'content_filter', null] as const)(
    'Chat Completions 的 %s 结束原因仅在明确工具终态时修复',
    async (finishReason) => {
      const raw = '{"path":"a.ts"';
      const frames = (async function* () {
        yield {
          id: 'wire-message',
          model: 'test-model',
          choices: [
            {
              index: 0,
              finish_reason: finishReason,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'wire-tool',
                    type: 'function',
                    function: { name: 'read_file', arguments: raw },
                  },
                ],
              },
            },
          ],
        } as ChatCompletionChunk;
      })();
      const response = createModelStreamResponse(
        buildChatCompletionsStreamEvents(frames),
      );
      if (finishReason === null) {
        await expect(collect(response)).rejects.toBeInstanceOf(
          ModelInferenceError,
        );
        expect((await response.partial).openBlocks.get(0)).toMatchObject({
          inputJson: raw,
        });
        return;
      }
      const { events, message } = await collect(response);
      if (finishReason === 'tool_calls') {
        expect(message.blocks[0]).toMatchObject({ input: { path: 'a.ts' } });
        expect(message.blocks[0]).not.toHaveProperty('inputJson');
      } else {
        expect(message.blocks[0]).toMatchObject({ input: {}, inputJson: raw });
        expect(
          events.find((event) => event.type === 'assistant_block'),
        ).toMatchObject({
          message: {
            blocks: [
              { input: { [UNPARSED_TOOL_INPUT]: { reason: 'json_parse' } } },
            ],
          },
        });
      }
    },
  );

  it('取消暂存修复时保留原始残片，不交付工具调用', async () => {
    let release!: () => void;
    let ready!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stopped = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const raw = '{"path":"a.ts"';
    const response = createModelStreamResponse(
      (async function* () {
        yield start();
        yield* tool(0, raw);
        yield* tool(1);
        ready();
        await waiting;
        yield* terminal('tool_use');
      })(),
      () => release(),
    );
    const controller = new AbortController();
    const delivery = createModelResponseDelivery();
    const events: Array<StreamEvent | AssistantBlockEvent> = [];
    const consuming = (async () => {
      for await (const event of convertModelResponse({
        response,
        requestId: 'repair-abort',
        delivery,
        signal: controller.signal,
      }))
        events.push(event);
    })();
    await stopped;
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(consuming).rejects.toMatchObject({ name: 'AbortError' });
    expect(events.some((event) => event.type === 'assistant_block')).toBe(false);
    expect((await response.partial).openBlocks.get(0)).toMatchObject({
      inputJson: raw,
    });
    expect(delivery.deliveredBlocks.size).toBe(0);
    expect((await response.partial).blocks[1]).toMatchObject({
      input: { path: 'a.ts' },
    });
  });

  it.each(['eof', 'network'] as const)(
    '%s 在正常终态前结束时不交付可补括号的工具调用',
    async (failure) => {
      const raw = '{"path":"a.ts"';
      const error =
        failure === 'network'
          ? new ModelInferenceError('断流', {
              kind: 'network',
              phase: 'after_output',
            })
          : undefined;
      const response = responseFrom(
        [start(), ...tool(0, raw), ...tool(1)],
        error,
      );
      const delivery = createModelResponseDelivery();
      const events: Array<StreamEvent | AssistantBlockEvent> = [];
      await expect(
        (async () => {
          for await (const event of convertModelResponse({
            response,
            requestId: 'repair-interrupted',
            delivery,
          })) {
            events.push(event);
          }
        })(),
      ).rejects.toBeInstanceOf(ModelInferenceError);
      expect(events.some((event) => event.type === 'assistant_block')).toBe(
        false,
      );
      expect(getUndeliveredModelTools(delivery)).toEqual([
        { id: 'tool-0', name: 'read_file', argumentLength: raw.length },
      ]);
      expect((await response.partial).openBlocks.get(0)).toMatchObject({
        inputJson: raw,
      });
      expect(delivery.deliveredBlocks.size).toBe(0);
      expect(
        getDeliveredModelMessage(await response.partial, delivery).blocks,
      ).toEqual([]);
    },
  );

  it.each([
    ['{"path":', 'json_parse'],
    ['[]', 'object_required'],
    ['null', 'object_required'],
    ['42', 'object_required'],
  ])('无效工具参数 %s 保留失败证据，不静默降成空对象', async (json, reason) => {
    const response = responseFrom([start(), ...tool(0, json), ...terminal('tool_use')]);
    const { events, message } = await collect(response);
    const expected = {
      [UNPARSED_TOOL_INPUT]: { reason, raw: json, length: json.length },
    };
    expect(message.blocks[0]).toMatchObject({ input: {}, inputJson: json });
    expect(message.blocks).toBe((await response.completed).blocks);
    expect(
      events.find((event) => event.type === 'assistant_block'),
    ).toMatchObject({ message: { blocks: [{ input: expected }] } });
  });

  it('先交付断流前的事件，再原样抛出推理契约错误，不返回中断结果', async () => {
    const error = new ModelInferenceError('断流', {
      kind: 'network',
      phase: 'after_output',
      cause: Object.assign(new Error('断流'), { code: 'ECONNRESET' }),
    });
    const response = responseFrom(
      [start(), ...tool(), ...text(3, '部分回答').slice(0, 2)],
      error,
    );
    const events: Array<StreamEvent | AssistantBlockEvent> = [];
    await expect(
      (async () => {
        for await (const event of convertModelResponse({
          response,
          requestId: 'request-1',
        })) {
          events.push(event);
        }
      })(),
    ).rejects.toBe(error);
    expect(
      events.filter((event) => event.type === 'assistant_block'),
    ).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: 'stream_event',
      event: { index: 3, delta: { text: '部分回答' } },
    });
  });

  it('events 正常耗尽后，completed 的拒绝仍原样向上抛出', async () => {
    const error = new Error('完成失败');
    const response = dualResponse(items([start()]), Promise.reject(error));
    await expect(collect(response)).rejects.toBe(error);
    expect(response.cancel).toHaveBeenCalledWith(error);
  });

  it('等待 completed 后直接返回转换后的消息，不包装 outcome', async () => {
    const done = deferred<ModelMessage>();
    const response = dualResponse(items([]), done.promise);
    const pending = collect(response);
    let finished = false;
    void pending.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    done.resolve(modelResult());
    expect(await pending).toMatchObject({
      events: [],
      message: {
        messageId: 'message-1',
        blocks: [{ text: '回答' }],
      },
    });
    expect(response.cancel).not.toHaveBeenCalled();
  });

  it.each(['end_turn', 'tool_use', 'refusal', 'max_tokens'] as const)(
    '%s 仅映射停止原因，不决定工具或空回答策略',
    async (reason) => {
      const withTool = await collect(
        responseFrom([start(), ...tool(), ...terminal(reason)]),
      );
      expect(withTool.message.stopReason).toBe(reason);
      expect(withTool.message.blocks[0].type).toBe('tool_use');
      const empty = await collect(responseFrom([start(), ...terminal(reason)]));
      expect(empty.message).toMatchObject({ stopReason: reason, blocks: [] });
    },
  );

  it('仅有 thinking 的结果照常映射，不判定语义空回答', async () => {
    const { message } = await collect(
      dualResponse(
        items([]),
        Promise.resolve({
          ...modelResult(),
          blocks: [{ type: 'thinking', thinking: '思考' }],
        }),
      ),
    );
    expect(message.blocks).toEqual([
      { type: 'thinking', thinking: '思考' },
    ]);
  });

  it('不在映射层校验流终态，缺失的停止原因保持缺省', async () => {
    const { message } = await collect(responseFrom([start(), ...tool()]));
    expect(message.stopReason).toBeUndefined();
    expect(message.blocks[0].type).toBe('tool_use');
  });

  it('message_complete 不额外 yield，最终正文以 completed 的结果为准', async () => {
    const response = dualResponse(
      items([
        start(),
        { type: 'message_complete' as const, result: modelResult() },
      ]),
      Promise.resolve({
        ...modelResult(),
        blocks: [{ type: 'text', text: '最终结果' }],
      }),
    );
    const { events, message } = await collect(response);
    expect(events).toHaveLength(1);
    expect(message.blocks).toEqual([
      { type: 'text', text: '最终结果' },
    ]);
  });

  it('abort 能解除 pending next，即使底层 cancel 不关闭事件迭代器', async () => {
    const controller = new AbortController();
    const pending = deferred<IteratorResult<ModelStreamEvent>>();
    const completed = deferred<ModelMessage>();
    const close = vi.fn(() =>
      Promise.resolve({ done: true as const, value: undefined }),
    );
    const response = dualResponse(
      {
        [Symbol.asyncIterator]: () => ({
          next: () => pending.promise,
          return: close,
        }),
      },
      completed.promise,
    );
    const error = new Error('主动取消');
    const reading = collect(response, controller.signal);
    controller.abort(error);
    await expect(reading).rejects.toBe(error);
    expect(response.cancel).toHaveBeenCalledExactlyOnceWith(error);
    expect(close).toHaveBeenCalledTimes(1);
    completed.reject(error);
    pending.resolve({ done: true, value: undefined });
  });

  it('等待 completed 时也能取消，取消异常原样向上抛出', async () => {
    const controller = new AbortController();
    const done = deferred<ModelMessage>();
    const response = dualResponse(items([start()]), done.promise);
    response.cancel = vi.fn(() => done.reject(controller.signal.reason));
    const gen = convertModelResponse({
      response,
      requestId: 'request-1',
      signal: controller.signal,
    });
    await gen.next();
    const error = new Error('取消等待');
    const waiting = gen.next();
    controller.abort(error);
    await expect(waiting).rejects.toBe(error);
    expect(response.cancel).toHaveBeenCalledExactlyOnceWith(error);
  });

  it('已取消信号不消费流，仍调用 cancel', async () => {
    const controller = new AbortController();
    controller.abort();
    const next = vi.fn();
    const response = dualResponse(
      { [Symbol.asyncIterator]: () => ({ next }) },
      Promise.reject(controller.signal.reason),
    );
    await expect(collect(response, controller.signal)).rejects.toBe(
      controller.signal.reason,
    );
    expect(next).not.toHaveBeenCalled();
    expect(response.cancel).toHaveBeenCalledTimes(1);
  });

  it('消费者提前 return 会取消响应并关闭迭代器', async () => {
    const source = items([start()]);
    const close = vi.spyOn(source, 'return');
    const response = dualResponse(
      source,
      new Promise<ModelMessage>(() => undefined),
    );
    const gen = convertModelResponse({ response, requestId: 'request-1' });
    await gen.next();
    await gen.return(modelResult());
    expect(response.cancel).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    '清理失败不覆盖原始错误（异步：%s）',
    async (asyncFailure) => {
      const error = new Error('原始错误');
      const response = dualResponse(items([start()]), Promise.reject(error));
      response.cancel = vi.fn(() => {
        if (asyncFailure) return Promise.reject(new Error('清理失败'));
        throw new Error('清理失败');
      });
      await expect(collect(response)).rejects.toBe(error);
      expect(response.cancel).toHaveBeenCalledExactlyOnceWith(error);
    },
  );

  it('下游修改单块消息不影响上游数据或最终结果', async () => {
    const gen = convertModelResponse({
      response: responseFrom([start(), ...tool(), ...terminal('tool_use')]),
      requestId: 'request-1',
    });
    while (true) {
      const next = await gen.next();
      if (next.done) {
        expect(next.value.blocks[0]).toMatchObject({
          input: { path: 'a.ts' },
        });
        break;
      }
      if (next.value.type === 'assistant_block') {
        const block = next.value.message.blocks[0];
        if (block.type === 'tool_use') block.input['path'] = '已修改';
      }
    }
  });

  it('按输入逐条映射完整块，不在转换层做工具去重', async () => {
    const block: ModelContentBlock = {
      type: 'tool_use',
      id: 'tool-0',
      name: 'read_file',
      input: {},
    };
    const response = dualResponse(
      items([
        start(),
        { type: 'content_block_complete' as const, index: 0, block },
        { type: 'content_block_complete' as const, index: 1, block },
      ]),
      Promise.resolve(modelResult()),
    );
    const { events } = await collect(response);
    expect(
      events
        .filter((event) => event.type === 'assistant_block')
        .map((event) => event.index),
    ).toEqual([0, 1]);
  });

  it('后续 undefined usage 字段不擦除已经上报的值', async () => {
    const { message } = await collect(
      responseFrom([
        start({ inputTokens: 100, cacheReadInputTokens: 20 }),
        ...text(),
        ...terminal('end_turn', { inputTokens: undefined, outputTokens: 5 }),
      ]),
    );
    expect(message.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 5,
      cacheReadInputTokens: 20,
    });
  });

  it('结束后移除取消监听，不再取消已完成响应', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const response = dualResponse(items([]), Promise.resolve(modelResult()));
    await collect(response, controller.signal);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    controller.abort();
    expect(response.cancel).not.toHaveBeenCalled();
  });
});

describe('ModelStreamResponse 终态残缺结果与交付投影', () => {
  it('partial 保留四类残缺内容与已收到的消息元信息，不产生残缺事件', async () => {
    const error = new ModelInferenceError('断流', {
      kind: 'network',
      phase: 'after_output',
    });
    const reasoning = {
      id: 'rs-1',
      status: 'incomplete' as const,
      summary: [{ type: 'summary_text', text: '摘要' }],
    };
    const response = responseFrom(
      [
        start({ inputTokens: 12, cacheReadInputTokens: 4 }),
        ...text(0, '完整正文'),
        ...text(7, '残缺正文').slice(0, 2),
        ...tool(9, '{"path":').slice(0, 2),
        {
          type: 'content_block_start',
          index: 10,
          contentBlock: { type: 'thinking', thinking: '', reasoning },
        },
        {
          type: 'content_block_delta',
          index: 10,
          delta: { type: 'thinking_delta', thinking: '思考片段' },
        },
        {
          type: 'content_block_delta',
          index: 10,
          delta: { type: 'signature_delta', signature: '签名片段' },
        },
        {
          type: 'content_block_start',
          index: 11,
          contentBlock: { type: 'redacted_thinking', data: '密文', reasoning },
        },
        {
          type: 'message_delta',
          delta: { stopReason: 'refusal' },
          usage: { outputTokens: 6, cacheReadInputTokens: 0 },
        },
      ],
      error,
    );
    await expect(response.completed).rejects.toBe(error);
    const result = await response.partial;
    expect(result).toEqual({
      messageId: 'message-1',
      model: 'test-model',
      stopReason: 'refusal',
      usage: { inputTokens: 12, outputTokens: 6, cacheReadInputTokens: 0 },
      blocks: [{ type: 'text', text: '完整正文' }],
      openBlocks: new Map([
        [7, { type: 'text', text: '残缺正文' }],
        [
          9,
          {
            type: 'tool_use',
            id: 'tool-9',
            name: 'read_file',
            inputJson: '{"path":',
          },
        ],
        [
          10,
          {
            type: 'thinking',
            thinking: '思考片段',
            signature: '签名片段',
            reasoning,
          },
        ],
        [11, { type: 'redacted_thinking', data: '密文', reasoning }],
      ]),
    });
    expect(result.blocks[0]).toEqual({ type: 'text', text: '完整正文' });
    expect(result).not.toHaveProperty('type');
    for (const block of result.openBlocks.values()) {
      expect(block).not.toHaveProperty('kind');
      expect(block).not.toHaveProperty('input');
    }
    const eventTypes: string[] = [];
    await expect(
      (async () => {
        for await (const event of response.events) eventTypes.push(event.type);
      })(),
    ).rejects.toBe(error);
    expect(eventTypes.filter((type) => type.endsWith('_partial'))).toEqual([]);
    expect(eventTypes).not.toContain('message_complete');
    expect(
      eventTypes.filter((type) => type === 'content_block_complete'),
    ).toHaveLength(1);
  });
  it('partial 在流结束前保持 pending，正常结束后提供独立完整块快照', async () => {
    const ready = deferred<void>();
    const finish = deferred<void>();
    const response = createModelStreamResponse(
      (async function* () {
        yield start();
        yield* text(7, '正文').slice(0, 2);
        ready.resolve();
        await finish.promise;
        yield { type: 'content_block_stop', index: 7 } as const;
        yield* terminal();
      })(),
    );
    const resolved = vi.fn();
    void response.partial.then(resolved);
    await ready.promise;
    expect(resolved).not.toHaveBeenCalled();
    finish.resolve();
    expect((await response.completed).blocks[7]).toEqual({
      type: 'text',
      text: '正文',
    });
    await expect(response.partial).resolves.toMatchObject({
      openBlocks: new Map(),
    });
    const complete = await response.completed;
    const partial = await response.partial;
    expect(partial.blocks).toEqual(complete.blocks);
    expect(partial.blocks).not.toBe(complete.blocks);
    Object.assign(partial.blocks[7], { text: '修改快照' });
    expect(complete.blocks[7]).toEqual({ type: 'text', text: '正文' });
    expect(resolved).toHaveBeenCalledOnce();
  });

  it('开始前失败仍 resolve 空残缺结果，错误仅由双通道传播', async () => {
    const error = new ModelInferenceError('连接失败', {
      kind: 'network',
      phase: 'before_output',
    });
    const response = responseFrom([], error);
    void response.completed.catch(() => undefined);
    await expect(collect(response)).rejects.toBe(error);
    await expect(response.completed).rejects.toBe(error);
    await expect(response.partial).resolves.toMatchObject({
      blocks: [],
      openBlocks: new Map(),
    });
  });
  it.each([false, true])(
    '未闭合块不能成为 completed 成功结果（收到 message_stop：%s）',
    async (messageStopped) => {
      const response = responseFrom([
        start(),
        ...text(2, '部分正文').slice(0, 2),
        ...(messageStopped ? terminal() : []),
      ]);
      void response.completed.catch(() => undefined);
      await expect(collect(response)).rejects.toMatchObject({
        kind: 'protocol',
        phase: 'after_output',
      });
      await expect(response.completed).rejects.toMatchObject({
        kind: 'protocol',
      });
      await expect(response.partial).resolves.toMatchObject({
        messageId: 'message-1',
        model: 'test-model',
        openBlocks: new Map([[2, { type: 'text', text: '部分正文' }]]),
      });
    },
  );

  it('断流拒绝双通道，partial 同时提供完整块与标准残缺块', async () => {
    const error = new ModelInferenceError('断流', {
      kind: 'network',
      phase: 'after_output',
    });
    const response = responseFrom(
      [start(), ...text(5, '完成'), ...tool(3).slice(0, 2)],
      error,
    );
    void response.completed.catch(() => undefined);
    const iterator = response.events[Symbol.asyncIterator]();
    const completedBlocks: ModelContentBlock[] = [];
    await expect(
      (async () => {
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          if (next.value.type === 'content_block_complete')
            completedBlocks.push(next.value.block);
        }
      })(),
    ).rejects.toBe(error);
    await expect(response.completed).rejects.toBe(error);
    expect(completedBlocks).toEqual([{ type: 'text', text: '完成' }]);
    await expect(response.partial).resolves.toMatchObject({
      messageId: 'message-1',
      model: 'test-model',
      openBlocks: new Map([
        [
          3,
          {
            type: 'tool_use',
            id: 'tool-3',
            name: 'read_file',
            inputJson: '{"path":"a.ts"}',
          },
        ],
      ]),
    });
    const partial = await response.partial;
    expect(partial.blocks[5]).toEqual(completedBlocks[0]);
    expect(partial.blocks[5]).not.toBe(completedBlocks[0]);
    expect(Object.keys(partial.blocks)).toEqual(['5']);
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it('取消时 resolve 残缺结果，迟到事件不改变结果，重复取消不重复清理', async () => {
    const ready = deferred<void>();
    const late = deferred<void>();
    const closed = deferred<void>();
    const cancel = vi.fn();
    const response = createModelStreamResponse(
      (async function* () {
        try {
          yield start();
          yield* text(0, '已闭合');
          yield* text(1, '前缀').slice(0, 2);
          ready.resolve();
          await late.promise;
          yield {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'text_delta', text: '迟到' },
          } as const;
        } finally {
          closed.resolve();
        }
      })(),
      cancel,
    );
    void response.completed.catch(() => undefined);
    await ready.promise;
    const resolved = vi.fn();
    void response.partial.then(resolved);
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    const error = new DOMException('取消', 'AbortError');
    await response.cancel?.(error);
    await response.cancel?.(error);
    await expect(response.completed).rejects.toBe(error);
    const result = await response.partial;
    expect(result).toEqual({
      messageId: 'message-1',
      model: 'test-model',
      blocks: [{ type: 'text', text: '已闭合' }],
      openBlocks: new Map([[1, { type: 'text', text: '前缀' }]]),
      stopReason: undefined,
      usage: undefined,
    });
    late.resolve();
    await closed.promise;
    expect(await response.partial).toBe(result);
    expect(result.openBlocks.get(1)).toEqual({ type: 'text', text: '前缀' });
    expect(result.blocks).toEqual([{ type: 'text', text: '已闭合' }]);
    expect(resolved).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledExactlyOnceWith(error);
  });

  it('断流投影保留完成块与开放正文，开放工具即使 JSON 合法也不可执行', async () => {
    const error = new ModelInferenceError('断流', {
      kind: 'network',
      phase: 'after_output',
    });
    const response = responseFrom(
      [
        start({ inputTokens: 12 }),
        ...tool(0),
        ...text(2, '完成正文'),
        ...text(7, '部分正文').slice(0, 2),
        ...tool(9).slice(0, 2),
        {
          type: 'content_block_start',
          index: 10,
          contentBlock: { type: 'thinking', thinking: '' },
        },
        {
          type: 'content_block_delta',
          index: 10,
          delta: { type: 'thinking_delta', thinking: '开放思考' },
        },
        {
          type: 'message_delta',
          delta: { stopReason: 'refusal' },
          usage: { outputTokens: 6 },
        },
      ],
      error,
    );
    const delivery = createModelResponseDelivery();
    const stream = convertModelResponse({
      response,
      requestId: 'request-1',
      delivery,
    });
    await expect(
      (async () => {
        for await (const _event of stream) {
          /* 消费到断流。 */
        }
      })(),
    ).rejects.toBe(error);
    const partial = getDeliveredModelMessage(await response.partial, delivery);
    expect(partial.blocks.flatMap((_block, index) => [index])).toEqual([
      0, 2, 7,
    ]);
    expect(partial.blocks.filter(() => true)).toEqual([
      {
        type: 'tool_use',
        id: 'tool-0',
        name: 'read_file',
        input: { path: 'a.ts' },
      },
      { type: 'text', text: '完成正文' },
      { type: 'text', text: '部分正文' },
    ]);
    expect(getUndeliveredModelTools(delivery)).toEqual([
      {
        id: 'tool-9',
        name: 'read_file',
        argumentLength: '{"path":"a.ts"}'.length,
      },
    ]);
    expect(partial).toMatchObject({
      stopReason: 'refusal',
      usage: { inputTokens: 12, outputTokens: 6 },
    });
    expect(partial).not.toHaveProperty('content');
    expect(partial.usage).not.toHaveProperty('request_id');
    expect(delivery.receivedUsage).toBe(true);
    expect([...(await response.partial).openBlocks.keys()]).toEqual([7, 9, 10]);
  });

  it('上游已读完时取消，只保留消费者读到的文本前缀与消息元数据', async () => {
    const response = responseFrom([
      start({ inputTokens: 10 }),
      ...text(0, '前缀').slice(0, 2),
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '后缀' },
      },
      { type: 'content_block_stop', index: 0 },
      ...tool(4),
      ...terminal('tool_use', { outputTokens: 99 }),
    ]);
    await response.completed;
    const iterator = response.events[Symbol.asyncIterator]();
    const next = vi.spyOn(iterator, 'next');
    vi.spyOn(response.events, Symbol.asyncIterator).mockReturnValue(iterator);
    const controller = new AbortController();
    const delivery = createModelResponseDelivery();
    const stream = convertModelResponse({
      response,
      requestId: 'request-1',
      signal: controller.signal,
      delivery,
    });
    await stream.next();
    await stream.next();
    await stream.next();
    controller.abort();
    await expect(stream.next()).rejects.toBe(controller.signal.reason);
    expect(next).toHaveBeenCalledTimes(3);
    const rawPartial = await response.partial;
    const partial = getDeliveredModelMessage(rawPartial, delivery);
    expect(partial.blocks).toEqual([{ type: 'text', text: '前缀' }]);
    expect(getUndeliveredModelTools(delivery)).toEqual([]);
    expect(partial.stopReason).toBeUndefined();
    expect(partial.usage?.outputTokens).toBeUndefined();
    expect(rawPartial.stopReason).toBe('tool_use');
    expect(rawPartial.usage?.outputTokens).toBe(99);
    expect(rawPartial.blocks[4].type).toBe('tool_use');
    expect(rawPartial.blocks[0]).toEqual({ type: 'text', text: '前缀后缀' });
    expect(delivery.receivedUsage).toBe(false);
    expect((await response.completed).blocks[0]).toEqual({
      type: 'text',
      text: '前缀后缀',
    });
  });

  it('上游已闭合正文但随后断流，取消从 partial 完整块取回已展示前缀', async () => {
    const error = new ModelInferenceError('断流', {
      kind: 'network',
      phase: 'after_output',
    });
    const response = responseFrom(
      [
        start(),
        ...text(0, '前缀').slice(0, 2),
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '未展示后缀' },
        },
        { type: 'content_block_stop', index: 0 },
        ...tool(4),
      ],
      error,
    );
    await expect(response.completed).rejects.toBe(error);
    const controller = new AbortController();
    const delivery = createModelResponseDelivery();
    const stream = convertModelResponse({
      response,
      requestId: 'request-1',
      signal: controller.signal,
      delivery,
    });
    for (let i = 0; i < 3; i++) await stream.next();
    controller.abort();
    await expect(stream.next()).rejects.toBe(controller.signal.reason);
    const partial = getDeliveredModelMessage(await response.partial, delivery);
    expect((await response.partial).openBlocks.size).toBe(0);
    expect(partial.blocks).toEqual([{ type: 'text', text: '前缀' }]);
    expect(getUndeliveredModelTools(delivery)).toEqual([]);
  });

  it('已展示开放正文时取消能解除 pending next，不等待底层源流结束', async () => {
    const ready = deferred<void>();
    const late = deferred<void>();
    const closed = deferred<void>();
    const response = createModelStreamResponse(
      (async function* () {
        try {
          yield start();
          yield* text(2, '已展示').slice(0, 2);
          ready.resolve();
          await late.promise;
          yield { type: 'content_block_stop', index: 2 } as const;
        } finally {
          closed.resolve();
        }
      })(),
    );
    const controller = new AbortController();
    const delivery = createModelResponseDelivery();
    const stream = convertModelResponse({
      response,
      requestId: 'request-1',
      signal: controller.signal,
      delivery,
    });
    try {
      for (let i = 0; i < 3; i++) await stream.next();
      await ready.promise;
      const pending = stream.next();
      controller.abort();
      await expect(pending).rejects.toBe(controller.signal.reason);
      const partial = getDeliveredModelMessage(
        await response.partial,
        delivery,
      );
      expect((await response.partial).openBlocks.has(2)).toBe(true);
      expect(partial.blocks[2]).toEqual({ type: 'text', text: '已展示' });
    } finally {
      late.resolve();
      await closed.promise;
    }
  });

  it('上游工具已闭合但尚未交付完整块时，取消不会把它变成可执行调用', async () => {
    const response = responseFrom([
      start(),
      ...tool(3),
      ...terminal('tool_use'),
    ]);
    await response.completed;
    const iterator = response.events[Symbol.asyncIterator]();
    const next = vi.spyOn(iterator, 'next');
    vi.spyOn(response.events, Symbol.asyncIterator).mockReturnValue(iterator);
    const controller = new AbortController();
    const delivery = createModelResponseDelivery();
    const stream = convertModelResponse({
      response,
      requestId: 'request-1',
      signal: controller.signal,
      delivery,
    });
    await stream.next();
    await stream.next();
    await stream.next();
    controller.abort();
    await expect(stream.next()).rejects.toBe(controller.signal.reason);
    expect(next).toHaveBeenCalledTimes(3);
    const partial = getDeliveredModelMessage(await response.partial, delivery);
    expect(partial.blocks).toEqual([]);
    expect(getUndeliveredModelTools(delivery)).toEqual([
      {
        id: 'tool-3',
        name: 'read_file',
        argumentLength: '{"path":"a.ts"}'.length,
      },
    ]);
  });

  it('完整块已交付但原语 stop 尚未消费时，不重复保留同一块', async () => {
    const response = responseFrom([
      start(),
      ...tool(3),
      ...terminal('tool_use'),
    ]);
    await response.completed;
    const controller = new AbortController();
    const delivery = createModelResponseDelivery();
    const stream = convertModelResponse({
      response,
      requestId: 'request-1',
      signal: controller.signal,
      delivery,
    });
    for (let i = 0; i < 4; i++) await stream.next();
    controller.abort();
    await expect(stream.next()).rejects.toBe(controller.signal.reason);
    const partial = getDeliveredModelMessage(await response.partial, delivery);
    expect(partial.blocks.flatMap((_block, index) => [index])).toEqual([3]);
    expect(partial.blocks[3].type).toBe('tool_use');
    expect(getUndeliveredModelTools(delivery)).toEqual([]);
  });

  it('正文只来自 response.partial 的标准残缺块，不使用消费记录重新拼接 delta', async () => {
    const error = new Error('断流');
    const response = dualResponse(
      items([start(), ...text(2, '增量占位').slice(0, 2)]),
      Promise.reject(error),
    );
    const responseWithPartial = {
      ...response,
      partial: Promise.resolve({
        messageId: 'message-1',
        model: 'test-model',
        blocks: [],
        openBlocks: new Map([[2, { type: 'text' as const, text: '残缺正文' }]]),
      }),
    };
    const delivery = createModelResponseDelivery();
    await expect(
      (async () => {
        for await (const _event of convertModelResponse({
          response: responseWithPartial,
          requestId: 'request-1',
          delivery,
        })) {
          /* 消费到失败。 */
        }
      })(),
    ).rejects.toBe(error);
    const partial = getDeliveredModelMessage(
      await responseWithPartial.partial,
      delivery,
    );
    expect(partial.blocks[2]).toEqual({ type: 'text', text: '残缺正文' });
    expect(delivery.textLengths.get(2)).toBe(4);
  });

  it('已交付完整块的正文只取自 partial，交付记录仅保留 index', async () => {
    const error = new Error('断流');
    const response = {
      ...dualResponse(
        items([
          start(),
          {
            type: 'content_block_complete' as const,
            index: 0,
            block: { type: 'text' as const, text: '完成事件正文' },
          },
          { type: 'message_complete' as const, result: modelResult() },
        ]),
        Promise.reject(error),
      ),
      partial: Promise.resolve({
        ...modelResult(),
        blocks: [{ type: 'text' as const, text: '终态快照正文' }],
        openBlocks: new Map(),
      }),
    };
    const delivery = createModelResponseDelivery();
    await expect(
      (async () => {
        for await (const _event of convertModelResponse({
          response,
          requestId: 'request-1',
          delivery,
        })) {
          /* 消费到完成拒绝。 */
        }
      })(),
    ).rejects.toBe(error);
    expect(delivery.deliveredBlocks).toEqual(new Set([0]));
    expect(delivery.message.blocks).toEqual([]);
    expect(delivery).not.toHaveProperty('completedBlocks');
    const rawPartial = await response.partial;
    const partial = getDeliveredModelMessage(rawPartial, delivery);
    expect(partial.blocks).toEqual([{ type: 'text', text: '终态快照正文' }]);
    expect(partial.blocks[0]).toBe(rawPartial.blocks[0]);
  });
});

describe('Provider 多次尝试的投影边界', () => {
  it('重试后的 message_start 清空旧 delivery 和 usage', async () => {
    const final: ModelMessage = {
      messageId: 'final', model: 'test-model', stopReason: 'end_turn',
      blocks: [{ type: 'text', text: 'final answer' }], usage: { outputTokens: 2 },
    };
    const response = dualResponse((async function* () {
      const old: Array<import('../provider/event/modelStreamEvent.js').ModelStreamEvent | import('../provider/event/modelCompleteEvent.js').ModelCompleteEvent> = [
        start({ inputTokens: 999 }),
        { type: 'content_block_complete', index: 1, block: { type: 'thinking', thinking: 'old' } },
      ];
      const next = [start(), ...text(0, 'final answer'), ...terminal('end_turn', { outputTokens: 2 })];
      yield* old;
      yield* next;
    })(), Promise.resolve(final));
    const delivery = createModelResponseDelivery();
    const source = convertModelResponse({ response, requestId: 'logical', delivery });
    const blocks: AssistantBlockEvent[] = [];
    let result;
    for (;;) {
      const next = await source.next();
      if (next.done) { result = next.value; break; }
      if (next.value.type === 'assistant_block') blocks.push(next.value);
    }
    expect(blocks[0].requestId).toBe('logical');
    expect(delivery.deliveredBlocks.has(1)).toBe(false);
    expect(delivery.message.usage?.inputTokens).toBeUndefined();
    expect(result?.blocks).toEqual(final.blocks);
    expect(result?.usage).toEqual({ outputTokens: 2, inputTokens: undefined, cacheReadInputTokens: undefined, cacheCreationInputTokens: undefined, reasoningTokens: undefined });
  });
});
