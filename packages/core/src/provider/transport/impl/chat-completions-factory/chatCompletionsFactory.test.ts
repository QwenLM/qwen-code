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

describe('buildChatCompletionsStreamReq', () => {
  it('投影图片、工具调用、思考回放与工具结果', () => {
    const body = buildChatCompletionsStreamReq(
      req({
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'sys' }] },
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
      { role: 'system', content: 'sys' },
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
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ]);
  });

  it('非视觉模型的图片降级为占位文本，单文本收敛为字符串', () => {
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
      content: expect.stringContaining('does not support image input'),
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

  it('帧内 error 对象按迭代器失败抛出', async () => {
    await expect(
      collect([{ error: { message: 'boom' } } as Partial<ChatCompletionChunk>]),
    ).rejects.toThrow(/boom/);
  });
});
