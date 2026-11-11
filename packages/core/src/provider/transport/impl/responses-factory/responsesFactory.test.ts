/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ResponseStreamEvent } from 'openai/resources/responses/responses';
import type { Model, ModelConfig } from '../../../model/model.js';
import type {
  ModelPrompt,
  ModelStreamRequest,
} from '../../../modelStreamRequest.js';
import type { ModelStreamEvent } from '../../../event/modelStreamEvent.js';
import { DefaultModelStreamAggregator } from '../../../aggregate/defaultModelStreamAggregator.js';
import { buildResponsesStreamReq } from './request/responsesStreamReqFactory.js';
import { buildResponsesStreamEvents } from './response/responsesStreamRespFactory.js';

const model: Model = {
  source: 'local',
  key: 'gpt',
  displayName: 'GPT',
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
): ModelStreamRequest {
  return { resolution: { model, config }, prompt: { messages: [], ...prompt } };
}

async function collect(
  frames: readonly unknown[],
): Promise<ModelStreamEvent[]> {
  async function* source() {
    for (const frame of frames) yield frame as ResponseStreamEvent;
  }
  const events: ModelStreamEvent[] = [];
  for await (const event of buildResponsesStreamEvents(source())) {
    events.push(event);
  }
  return events;
}

function aggregate(events: readonly ModelStreamEvent[]) {
  const aggregator = new DefaultModelStreamAggregator();
  for (const event of events) aggregator.process(event);
  return aggregator.getResult();
}

describe('buildResponsesStreamReq', () => {
  it('按 reasoning.id 合并思考回放，投影文本、function_call 与工具结果', () => {
    const body = buildResponsesStreamReq(
      req({
        messages: [
          { role: 'system', content: 'sys' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              {
                type: 'image',
                source: { type: 'url', url: 'https://x/a.png' },
              },
            ],
          },
          {
            role: 'assistant',
            content: [
              {
                type: 'thinking',
                thinking: 'visible',
                reasoning: {
                  id: 'rs_1',
                  type: 'reasoning',
                  status: 'completed',
                  summary: [{ type: 'summary_text', text: 'visible' }],
                },
              },
              {
                type: 'redacted_thinking',
                data: 'enc',
                reasoning: { id: 'rs_1', type: 'reasoning' },
              },
              // 其他协议的思考没有 reasoning.id，无法回放。
              { type: 'thinking', thinking: 'foreign' },
              { type: 'text', text: 'a' },
              { type: 'text', text: 'b' },
            ],
            toolCalls: [{ id: 'call_1', name: 'read', arguments: '' }],
          },
          {
            role: 'tool',
            toolCallId: 'call_1',
            content: [
              { type: 'text', text: 'out' },
              {
                type: 'image',
                source: { type: 'base64', mediaType: 'image/png', data: 'AAA' },
              },
            ],
          },
        ],
      }),
    );
    expect(body).toMatchObject({
      instructions: 'sys',
      store: false,
      include: ['reasoning.encrypted_content'],
    });
    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'look' },
          { type: 'input_image', image_url: 'https://x/a.png', detail: 'auto' },
        ],
      },
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'visible' }],
        encrypted_content: 'enc',
        status: 'completed',
      },
      { type: 'message', role: 'assistant', content: 'a\nb' },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'read',
        arguments: '{}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [
          { type: 'input_text', text: 'out' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
        ],
      },
    ]);
  });

  it('system 前缀只进入 instructions，中途 system 保留消息位置', () => {
    const body = buildResponsesStreamReq(req({
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'first' }] },
        { role: 'system', content: 'second' },
        { role: 'user', content: 'q' },
        { role: 'system', content: 'later' },
      ],
    }));
    expect(body.instructions).toBe('firstsecond');
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: 'q' },
      { type: 'message', role: 'system', content: 'later' },
    ]);
    expect(buildResponsesStreamReq(req({}))).not.toHaveProperty('instructions');
  });

  it('思考档位求解、tool_choice、top_k 忽略与 stop 报错', () => {
    const body = buildResponsesStreamReq(
      req(
        {
          tools: [{ name: 'read' }],
          toolChoice: { name: 'read' },
        },
        {
          context: { maxOutputTokens: 4096 },
          sampling: { topP: 0.5, topK: 5 },
          reasoning: { thinking: { type: 'enabled', budgetTokens: 4096 } },
        },
      ),
    );
    expect(body).toMatchObject({
      tool_choice: { type: 'function', name: 'read' },
      max_output_tokens: 4096,
      top_p: 0.5,
      reasoning: { effort: 'medium', summary: 'auto' },
    });
    expect(body).not.toHaveProperty('top_k');
    expect(
      buildResponsesStreamReq(
        req({}, { reasoning: { thinking: { type: 'disabled' } } }),
      ).reasoning,
    ).toEqual({ effort: 'none' });
    expect(() =>
      buildResponsesStreamReq(req({}, { sampling: { stop: ['x'] } })),
    ).toThrow(/stop/);
  });
});

describe('buildResponsesStreamEvents', () => {
  it('推理密文落 redacted_thinking，function_call 用 call_id，停止原因为 tool_use', async () => {
    const reasoningItem = {
      type: 'reasoning',
      id: 'rs_1',
      status: 'completed',
      summary: [
        { type: 'summary_text', text: 'p1' },
        { type: 'summary_text', text: 'p2' },
      ],
      encrypted_content: 'enc',
    };
    const events = await collect([
      { type: 'response.created', response: { id: 'resp', model: 'gpt' } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...reasoningItem, summary: [] },
      },
      {
        type: 'response.reasoning_summary_part.added',
        output_index: 0,
        item_id: 'rs_1',
        summary_index: 0,
      },
      {
        type: 'response.reasoning_summary_text.delta',
        output_index: 0,
        item_id: 'rs_1',
        delta: 'p1',
      },
      {
        type: 'response.reasoning_summary_part.added',
        output_index: 0,
        item_id: 'rs_1',
        summary_index: 1,
      },
      {
        type: 'response.reasoning_summary_text.delta',
        output_index: 0,
        item_id: 'rs_1',
        delta: 'p2',
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: reasoningItem,
      },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'message', id: 'msg_1', content: [] },
      },
      {
        type: 'response.output_text.delta',
        output_index: 1,
        item_id: 'msg_1',
        delta: 'hi',
      },
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: {
          type: 'message',
          id: 'msg_1',
          content: [{ type: 'output_text', text: 'hi' }],
        },
      },
      {
        type: 'response.output_item.added',
        output_index: 2,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'read',
          arguments: '',
        },
      },
      {
        type: 'response.output_item.done',
        output_index: 2,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'read',
          arguments: '{"a":1}',
        },
      },
      {
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 9,
            output_tokens: 4,
            input_tokens_details: { cached_tokens: 3 },
            output_tokens_details: { reasoning_tokens: 2 },
          },
        },
      },
    ]);
    const message = aggregate(events);
    expect(message.messageId).toBe('resp');
    expect(message.blocks).toEqual([
      {
        type: 'thinking',
        thinking: 'p1\n\np2',
        reasoning: {
          id: 'rs_1',
          type: 'reasoning',
          status: 'completed',
          summary: reasoningItem.summary,
        },
      },
      {
        type: 'redacted_thinking',
        data: 'enc',
        reasoning: { id: 'rs_1', type: 'reasoning' },
      },
      { type: 'text', text: 'hi' },
      { type: 'tool_use', id: 'call_1', name: 'read', input: { a: 1 } },
    ]);
    expect(message.stopReason).toBe('tool_use');
    expect(message.usage).toEqual({
      inputTokens: 9,
      outputTokens: 4,
      cacheReadInputTokens: 3,
      reasoningTokens: 2,
    });
  });

  it('缺 created 帧时兜底 message_start；content_filter 映射为 refusal', async () => {
    const events = await collect([
      {
        type: 'response.output_text.delta',
        output_index: 0,
        item_id: 'm',
        delta: 'x',
      },
      {
        type: 'response.incomplete',
        response: { incomplete_details: { reason: 'content_filter' } },
      },
    ]);
    expect(events[0]).toMatchObject({ type: 'message_start' });
    expect(events[1]).toEqual({
      type: 'content_block_start',
      index: 0,
      contentBlock: { type: 'text', text: '' },
    });
    expect(aggregate(events).stopReason).toBe('refusal');
  });

  it('response.failed 与 error 事件按迭代器失败抛出', async () => {
    await expect(
      collect([
        {
          type: 'response.failed',
          response: { error: { code: 'server_error', message: 'down' } },
        },
      ]),
    ).rejects.toThrow(/server_error: down/);
    await expect(
      collect([{ type: 'error', code: 'rate_limit', message: 'slow' }]),
    ).rejects.toThrow(/rate_limit: slow/);
  });
});
