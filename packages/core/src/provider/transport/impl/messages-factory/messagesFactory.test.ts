/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources/messages/messages';
import type { Model, ModelConfig } from '../../../model/model.js';
import type {
  ModelPrompt,
  ModelStreamRequest,
} from '../../../modelStreamRequest.js';
import type { ModelStreamEvent } from '../../../event/modelStreamEvent.js';
import { DefaultModelStreamAggregator } from '../../../aggregate/defaultModelStreamAggregator.js';
import { buildMessagesStreamReq } from './request/messagesStreamReqFactory.js';
import { buildMessagesStreamEvents } from './response/messagesStreamRespFactory.js';

const model: Model = {
  source: 'local',
  key: 'claude',
  displayName: 'Claude',
  capabilities: {
    tools: true,
    vision: true,
    reasoning: { supported: true, supportedEfforts: ['low', 'xhigh'] },
    contextWindows: [],
  },
  limits: { maxContextTokens: 200_000, maxOutputTokens: 32_000 },
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
    for (const frame of frames) yield frame as RawMessageStreamEvent;
  }
  const events: ModelStreamEvent[] = [];
  for await (const event of buildMessagesStreamEvents(source())) {
    events.push(event);
  }
  return events;
}

function aggregate(events: readonly ModelStreamEvent[]) {
  const aggregator = new DefaultModelStreamAggregator();
  for (const event of events) aggregator.process(event);
  return aggregator.getResult();
}

describe('buildMessagesStreamReq', () => {
  it('投影思考回放、工具调用、工具结果与图片，并合并同角色消息', () => {
    const body = buildMessagesStreamReq(
      req({
        messages: [
          {
            role: 'system',
            content: [
              {
                type: 'text',
                text: 'sys',
                cacheControl: { type: 'ephemeral', ttl: '1h' },
              },
            ],
          },
          { role: 'system', content: 'leading' },
          { role: 'user', content: 'q' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'hmm' },
              { type: 'redacted_thinking', data: 'opaque' },
              { type: 'text', text: '' },
              { type: 'text', text: 'a' },
            ],
            toolCalls: [{ id: 'c1', name: 'read', arguments: '{"p":1}' }],
          },
          { role: 'tool', toolCallId: 'c1', content: 'bad', isError: true },
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', mediaType: 'image/png', data: 'AAA' },
                cacheControl: { type: 'ephemeral', ttl: '10m' },
              },
            ],
          },
        ],
      }),
    );
    expect(body.max_tokens).toBe(32_000);
    expect(body.system).toEqual([
      {
        type: 'text',
        text: 'sys',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
      { type: 'text', text: 'leading' },
    ]);
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm', signature: '' },
          { type: 'redacted_thinking', data: 'opaque' },
          { type: 'text', text: 'a' },
          { type: 'tool_use', id: 'c1', name: 'read', input: { p: 1 } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'c1',
            content: 'bad',
            is_error: true,
          },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'AAA' },
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ]);
  });

  it('preserveThinking 为 false 时丢弃思考块', () => {
    const body = buildMessagesStreamReq(
      req(
        {
          messages: [
            {
              role: 'assistant',
              content: [
                { type: 'thinking', thinking: 'hmm', signature: 's' },
                { type: 'text', text: 'a' },
              ],
            },
          ],
        },
        { reasoning: { preserve: false } },
      ),
    );
    expect(body.messages).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
    ]);
  });

  it('生成参数、tool_choice 与思考配置', () => {
    const body = buildMessagesStreamReq(
      req(
        {
          tools: [{ name: 'read' }],
          toolChoice: 'required',
        },
        {
          context: { maxOutputTokens: 4096 },
          sampling: { topP: 0.8, topK: 10 },
          reasoning: { effort: 'xhigh', thinking: { type: 'adaptive' } },
        },
      ),
    );
    expect(body).toMatchObject({
      tool_choice: { type: 'any' },
      max_tokens: 4096,
      top_p: 0.8,
      top_k: 10,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'xhigh' },
    });
    expect(
      buildMessagesStreamReq(
        req({ tools: [{ name: 'read' }], toolChoice: { name: 'read' } }),
      ).tool_choice,
    ).toEqual({ type: 'tool', name: 'read' });
    expect(
      buildMessagesStreamReq(
        req(
          {},
          { reasoning: { thinking: { type: 'enabled', budgetTokens: 2048 } } },
        ),
      ).thinking,
    ).toEqual({ type: 'enabled', budget_tokens: 2048 });
    const disabled = buildMessagesStreamReq(
      req({}, { reasoning: { effort: 'none' } }),
    );
    expect(disabled.thinking).toEqual({ type: 'disabled' });
    expect(disabled).not.toHaveProperty('output_config');
  });
});

describe('buildMessagesStreamEvents', () => {
  it('忽略服务端工具块并重排为连续索引，合并 start 与 delta 的 usage', async () => {
    const events = await collect([
      {
        type: 'message_start',
        message: {
          id: 'msg',
          model: 'claude',
          usage: {
            input_tokens: 10,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 4,
          },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'server_tool_use',
          id: 's',
          name: 'web_search',
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{}' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'thinking', thinking: 'pre', signature: '' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'thinking_delta', thinking: '-fix' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'signature_delta', signature: 'sig' },
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_use', id: 'c1', name: 'read', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '{"a":1}' },
      },
      { type: 'content_block_stop', index: 2 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 7 },
      },
      { type: 'message_stop' },
    ]);
    expect(
      events
        .filter((e) => e.type === 'content_block_start')
        .map((e) => e.index),
    ).toEqual([0, 1]);
    const message = aggregate(events);
    expect(message.blocks).toEqual([
      { type: 'thinking', thinking: 'pre-fix', signature: 'sig' },
      { type: 'tool_use', id: 'c1', name: 'read', input: { a: 1 } },
    ]);
    expect(message.stopReason).toBe('tool_use');
    expect(message.usage).toEqual({
      inputTokens: 10,
      outputTokens: 7,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 4,
    });
  });

  it('model_context_window_exceeded 映射为 max_tokens', async () => {
    const events = await collect([
      { type: 'message_start', message: { id: 'm', model: 'x', usage: {} } },
      {
        type: 'message_delta',
        delta: { stop_reason: 'model_context_window_exceeded' },
      },
      { type: 'message_stop' },
    ]);
    expect(aggregate(events).stopReason).toBe('max_tokens');
  });

  it('error 事件按迭代器失败抛出', async () => {
    await expect(
      collect([
        { type: 'error', error: { type: 'overloaded_error', message: 'busy' } },
      ]),
    ).rejects.toThrow(/overloaded_error: busy/);
  });
});
