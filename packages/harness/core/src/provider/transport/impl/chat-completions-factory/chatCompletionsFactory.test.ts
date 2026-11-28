/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { Model, ModelConfig } from '../../../model/model.js';
import type {
  ModelPrompt,
  ModelStreamRequest,
} from '../../../modelStreamRequest.js';
import type { ModelStreamEvent } from '../../../event/modelStreamEvent.js';
import { DefaultModelStreamAggregator } from '../../../aggregate/defaultModelStreamAggregator.js';
import { applyPromptCachePolicy } from '../../../impl/customPromptCache.js';
import {
  convertMessages,
  normalizeMessagesForAPI,
} from '../../../../protocol/provider/request-converter.js';
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '../../../../protocol/transcript/conversions.js';
import { buildChatCompletionsStreamReq } from './request/chatCompletionsStreamReqFactory.js';
import { buildChatCompletionsStreamEvents } from './response/chatCompletionsStreamRespFactory.js';

const model: Model = {
  source: 'local',
  key: 'example',
  displayName: 'Example',
  capabilities: {
    tools: true,
    vision: true,
    reasoning: { supported: true, supportedEfforts: ['low', 'high'] },
    contextWindows: [],
  },
  limits: { maxContextTokens: 200_000 },
};

function req(
  prompt: Partial<ModelPrompt>,
  config: ModelConfig = {},
  selectedModel = model,
): ModelStreamRequest {
  return {
    resolution: { model: selectedModel, config },
    prompt: { messages: [], ...prompt },
  };
}

async function collect(
  chunks: ReadonlyArray<Partial<ChatCompletionChunk>>,
): Promise<ModelStreamEvent[]> {
  async function* frames() {
    for (const chunk of chunks) yield chunk as ChatCompletionChunk;
  }
  const events: ModelStreamEvent[] = [];
  for await (const event of buildChatCompletionsStreamEvents(frames())) {
    events.push(event);
  }
  return events;
}

function aggregate(events: readonly ModelStreamEvent[]) {
  const aggregator = new DefaultModelStreamAggregator();
  for (const event of events) aggregator.process(event);
  return aggregator.getResult();
}

function withoutCacheControl(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, entry) =>
      key === 'cache_control' ? undefined : entry,
    ),
  );
}

describe('buildChatCompletionsStreamReq', () => {
  describe.each([true, false])('连续请求，provider 缓存开启=%s', (enabled) => {
    it.each([
      { name: '字符串', content: 'read output' },
      { name: '空字符串', content: '' },
      { name: '单个文本块', content: [{ type: 'text', text: 'one' }] },
      {
        name: '多个文本块',
        content: [
          { type: 'text', text: 'one' },
          { type: 'text', text: 'two' },
        ],
      },
      {
        name: '图文块',
        content: [
          { type: 'text', text: 'before image' },
          {
            type: 'image',
            source: { type: 'base64', mediaType: 'image/png', data: 'AAA' },
          },
          { type: 'text', text: 'after image' },
        ],
      },
      { name: '空数组', content: [] },
    ] as const)('断点移走后保持历史 user 和工具正文：$name', ({ content }) => {
      const firstCall = createAssistantMessage({
        messageId: 'first',
        model: 'example',
        blocks: [{ type: 'tool_use', id: 'first', name: 'Read', input: {} }],
      });
      const secondCall = createAssistantMessage({
        messageId: 'second',
        model: 'example',
        blocks: [{ type: 'tool_use', id: 'second', name: 'Read', input: {} }],
      });
      const first = [createUserMessage('read two files in order')];
      const second = [
        ...first,
        firstCall,
        createToolResultMessage(
          [
            {
              type: 'tool_result',
              tool_use_id: 'first',
              content,
              is_error: false,
            },
          ],
          firstCall.uuid,
        ),
      ];
      const third = [
        ...second,
        secondCall,
        createToolResultMessage(
          [
            {
              type: 'tool_result',
              tool_use_id: 'second',
              content: 'next output',
              is_error: false,
            },
          ],
          secondCall.uuid,
        ),
      ];
      const histories = [first, second, third];
      const saved = structuredClone(histories);
      const bodies = histories.map((history) => {
        const messages = convertMessages([
          {
            role: 'system',
            content: [
              { type: 'text', text: 'stable rules' },
              { type: 'text', text: 'environment' },
            ],
          },
          ...normalizeMessagesForAPI(history),
        ]);
        const prompt = applyPromptCachePolicy(
          { messages },
          enabled ? { type: 'ephemeral' } : undefined,
        );
        return buildChatCompletionsStreamReq(req(prompt));
      });

      expect(withoutCacheControl(bodies[1].messages.slice(0, 2))).toEqual(
        withoutCacheControl(bodies[0].messages),
      );
      expect(withoutCacheControl(bodies[2].messages.slice(0, 4))).toEqual(
        withoutCacheControl(bodies[1].messages),
      );
      expect(bodies[0].messages[0].content).toEqual([
        { type: 'text', text: 'stable rules' },
        {
          type: 'text',
          text: 'environment',
          ...(enabled ? { cache_control: { type: 'ephemeral' } } : {}),
        },
      ]);
      expect(withoutCacheControl(bodies[0].messages[1].content)).toEqual([
        { type: 'text', text: 'read two files in order' },
      ]);
      for (const body of bodies.slice(1)) {
        const result = body.messages[3];
        expect(result).toMatchObject({ role: 'tool', tool_call_id: 'first' });
        expect(result).not.toHaveProperty('cache_control');
        if (Array.isArray(content) && content.length === 0) {
          expect(result.content).toBe('');
        } else {
          expect(Array.isArray(result.content)).toBe(true);
        }
      }
      expect(bodies[2].messages[3]).toEqual(
        withoutCacheControl(bodies[1].messages[3]),
      );
      if (enabled) {
        expect(bodies[0].messages[1].content).toEqual([
          {
            type: 'text',
            text: 'read two files in order',
            cache_control: { type: 'ephemeral' },
          },
        ]);
        const firstResult = bodies[1].messages[3].content;
        if (Array.isArray(firstResult)) {
          expect(firstResult.at(-1)).toHaveProperty('cache_control', {
            type: 'ephemeral',
          });
          expect(firstResult.slice(0, -1)).toEqual(
            withoutCacheControl(firstResult.slice(0, -1)),
          );
        }
        expect(bodies[2].messages[5].content).toEqual([
          {
            type: 'text',
            text: 'next output',
            cache_control: { type: 'ephemeral' },
          },
        ]);
      } else {
        expect(bodies).toEqual(withoutCacheControl(bodies));
      }
      expect(histories).toEqual(saved);
    });
  });

  it('system 和 user 的原生字符串保持原样', () => {
    const messages = [
      { role: 'system', content: 'rules\n\n' },
      { role: 'user', content: ' question\n' },
    ] as const;
    expect(buildChatCompletionsStreamReq(req({ messages })).messages).toEqual(
      messages,
    );
  });

  it('system 缓存断点移走时保留原文本块及边界', () => {
    const marked = buildChatCompletionsStreamReq(
      req({
        messages: [
          {
            role: 'system',
            content: [
              { type: 'text', text: 'first' },
              {
                type: 'text',
                text: 'second',
                cacheControl: { type: 'ephemeral' },
              },
            ],
          },
        ],
      }),
    );
    const next = buildChatCompletionsStreamReq(
      req({
        messages: [
          {
            role: 'system',
            content: [
              { type: 'text', text: 'first' },
              { type: 'text', text: 'second' },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'q', cacheControl: { type: 'ephemeral' } },
            ],
          },
        ],
      }),
    );
    expect(next.messages[0]).toEqual(withoutCacheControl(marked.messages[0]));
  });

  it('工具整体缓存断点沿用 Chat Completions 的文本分片扩展', () => {
    const body = buildChatCompletionsStreamReq(
      req({
        messages: [
          {
            role: 'tool',
            toolCallId: 'read',
            content: 'result',
            cacheControl: { type: 'ephemeral', ttl: '1h' },
          },
        ],
      }),
    );
    expect(body.messages[0]).toEqual({
      role: 'tool',
      tool_call_id: 'read',
      content: [
        { type: 'text', text: 'result', cache_control: { type: 'ephemeral' } },
      ],
    });
  });

  it('缓存断点投影到分片：system 保留分片，单文本与工具结果不收敛为字符串', () => {
    const cacheControl = { type: 'ephemeral', ttl: '1h' } as const;
    const body = buildChatCompletionsStreamReq(
      req({
        messages: [
          {
            role: 'system',
            content: [
              { type: 'text', text: 'stable' },
              { type: 'text', text: 'dynamic', cacheControl },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'text', text: 'q', cacheControl }],
          },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }],
          },
          {
            role: 'tool',
            toolCallId: 'c1',
            content: [{ type: 'text', text: 'ok', cacheControl }],
          },
        ],
      }),
    );
    const ephemeral = { type: 'ephemeral' };
    expect(body.messages[0]).toEqual({
      role: 'system',
      content: [
        { type: 'text', text: 'stable' },
        { type: 'text', text: 'dynamic', cache_control: ephemeral },
      ],
    });
    expect(body.messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'q', cache_control: ephemeral }],
    });
    expect(body.messages[3]).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: [{ type: 'text', text: 'ok', cache_control: ephemeral }],
    });
  });

  it('投影图片、工具调用、思考回放与工具结果', () => {
    const body = buildChatCompletionsStreamReq(
      req({
        messages: [
          {
            role: 'system',
            content: [
              { type: 'text', text: 'sys' },
              { type: 'text', text: 'dyn' },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              {
                type: 'image',
                source: { type: 'base64', mediaType: 'image/png', data: 'AAA' },
              },
            ],
          },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'hmm' },
              { type: 'redacted_thinking', data: 'opaque' },
              { type: 'text', text: 'a' },
              { type: 'text', text: 'b' },
            ],
            toolCalls: [{ id: 'c1', name: 'read', arguments: '{"p":1}' }],
          },
          { role: 'tool', toolCallId: 'c1', content: 'ok', isError: true },
        ],
      }),
    );
    expect(body.messages).toEqual([
      {
        role: 'system',
        content: [
          { type: 'text', text: 'sys' },
          { type: 'text', text: 'dyn' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,AAA' },
          },
        ],
      },
      {
        role: 'assistant',
        content: 'a\nb',
        reasoning_content: 'hmm',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'read', arguments: '{"p":1}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'c1',
        content: [{ type: 'text', text: 'ok' }],
      },
    ]);
  });

  it('非视觉模型的图片降级为占位文本，保留数组边界', () => {
    const body = buildChatCompletionsStreamReq(
      req(
        {
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'url', url: 'https://x/a.png' },
                },
              ],
            },
          ],
        },
        {},
        { ...model, capabilities: { ...model.capabilities, vision: false } },
      ),
    );
    expect(body.messages[0]).toEqual({
      role: 'user',
      content: [
        {
          type: 'text',
          text: expect.stringContaining('does not support image input'),
        },
      ],
    });
  });

  it('生成参数、tool_choice 与思考配置', () => {
    const body = buildChatCompletionsStreamReq(
      req(
        {
          tools: [{ name: 'read' }],
          toolChoice: { name: 'read' },
        },
        {
          context: { maxOutputTokens: 4096 },
          sampling: { topP: 0.9, topK: 20 },
          reasoning: {
            effort: 'high',
            thinking: { type: 'enabled', budgetTokens: 4096 },
            preserve: false,
          },
        },
      ),
    );
    expect(body).toMatchObject({
      tool_choice: { type: 'function', function: { name: 'read' } },
      top_p: 0.9,
      top_k: 20,
      max_tokens: 4096,
      reasoning_effort: 'high',
      enable_thinking: true,
      thinking_budget: 4096,
      preserve_thinking: false,
    });
  });

  it('显式关闭思考；无工具时不落 tool_choice；不支持思考的模型不落思考键', () => {
    const disabled = buildChatCompletionsStreamReq(
      req(
        { toolChoice: 'required' },
        { reasoning: { thinking: { type: 'disabled' } } },
      ),
    );
    expect(disabled).toMatchObject({
      reasoning_effort: 'none',
      enable_thinking: false,
    });
    expect(disabled).not.toHaveProperty('tool_choice');

    const plain = buildChatCompletionsStreamReq(
      req(
        {},
        { reasoning: { effort: 'high' } },
        {
          ...model,
          capabilities: {
            ...model.capabilities,
            reasoning: { supported: false, supportedEfforts: [] },
          },
        },
      ),
    );
    expect(plain).not.toHaveProperty('reasoning_effort');
  });
});

describe('buildChatCompletionsStreamEvents', () => {
  it('finish_reason 之后的尾帧 usage 进入 message_delta，收尾只发一次', async () => {
    const events = await collect([
      {
        id: 'r1',
        model: 'm',
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
      },
      {
        id: 'r1',
        model: 'm',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
      {
        id: 'r1',
        model: 'm',
        choices: [],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
    ]);
    expect(events.filter((e) => e.type === 'message_delta')).toEqual([
      {
        type: 'message_delta',
        delta: { stopReason: 'end_turn' },
        usage: { inputTokens: 3, outputTokens: 2 },
      },
    ]);
    expect(events.filter((e) => e.type === 'message_stop')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'message_stop' });
  });

  it('工具块开启前先关闭文本块，聚合出文本与工具调用', async () => {
    const events = await collect([
      {
        id: 'r1',
        model: 'm',
        choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }],
      },
      {
        id: 'r1',
        model: 'm',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'c1',
                  function: { name: 'read', arguments: '{"a":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'r1',
        model: 'm',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '1}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ]);
    const stopOfText = events.findIndex(
      (e) => e.type === 'content_block_stop' && e.index === 0,
    );
    const startOfTool = events.findIndex(
      (e) => e.type === 'content_block_start' && e.index === 1,
    );
    expect(stopOfText).toBeLessThan(startOfTool);
    const message = aggregate(events);
    expect(message.stopReason).toBe('tool_use');
    expect(message.blocks).toEqual([
      { type: 'text', text: 'x' },
      { type: 'tool_use', id: 'c1', name: 'read', input: { a: 1 } },
    ]);
  });

  it('finish_reason=length 时不关闭未完成工具块，保留文本并透出 abandonedToolCalls', async () => {
    const events = await collect([
      {
        id: 'r1',
        model: 'm',
        choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
      },
      {
        id: 'r1',
        model: 'm',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'c1',
                  function: { name: 'write_file', arguments: '{"content":"unclosed' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'r1',
        model: 'm',
        choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
      },
    ]);
    expect(
      events.some((e) => e.type === 'content_block_stop' && e.index === 0),
    ).toBe(true);
    expect(
      events.some((e) => e.type === 'content_block_stop' && e.index === 1),
    ).toBe(false);
    const message = aggregate(events);
    expect(message.stopReason).toBe('max_tokens');
    expect(message.blocks).toEqual([{ type: 'text', text: 'partial' }]);
    expect(message.abandonedToolCalls).toEqual([
      { index: 1, id: 'c1', name: 'write_file' },
    ]);
  });

  it('帧内 error 对象按迭代器失败抛出', async () => {
    await expect(
      collect([{ error: { message: 'boom' } } as Partial<ChatCompletionChunk>]),
    ).rejects.toThrow(/boom/);
  });
});
