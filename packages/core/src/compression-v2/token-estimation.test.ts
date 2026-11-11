/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from 'vitest';
import {
  countRequestTokens,
  createRequestTokenAnchor,
} from '../utils/request-token-count.js';
import { estimateTextTokens } from '../utils/tokenCalculation.js';
import { normalizeMessagesForAPI } from '../protocol/provider/request-converter.js';
import { systemPromptFromText } from '../prompts/system-prompt.js';
import { makeUser, makeAssistant } from './test-helpers.js';
import type { AssistantMessage, Message } from './message-types.js';
import { estimateBlocksTokenCount } from './message-types.js';

function request() {
  const input = {
    model: 'test-model',
    messages: [makeUser('previous prompt')] as Message[],
    systemPrompt: systemPromptFromText('system instructions'),
    tools: [{ name: 'test', parameters: {} }],
    projectionOptions: { targetModel: 'test-model' },
  };
  const response = makeAssistant([{ type: 'text', text: 'answer' }]);
  response.message = { ...response.message, model: input.model };
  response.message.usage!.input_tokens = 1000;
  response.message.usage!.output_tokens = 200;
  response.message.usage!.cache_read_input_tokens = 700;
  response.message.usage!.cache_creation_input_tokens = 100;
  response.requestTokenAnchor = createRequestTokenAnchor(input)(
    response.message.content,
  );
  return { input, response };
}

describe('unified request token counting', () => {
  it('includes fixed overhead without a response, including large CJK text', () => {
    const input = {
      model: 'test-model',
      messages: [makeUser('abcd')],
      systemPrompt: systemPromptFromText('中文'),
      tools: [{ name: '工具' }],
    };
    expect(countRequestTokens(input)).toEqual({
      source: 'estimate',
      tokens: Math.floor(
        1 + 2.6 + estimateTextTokens(JSON.stringify(input.tools)),
      ),
    });
    expect(estimateTextTokens('中'.repeat(100_001))).toBeCloseTo(130001.3);
  });

  it('uses input + output + new content and counts cache exactly once', () => {
    const { input, response } = request();
    expect(
      countRequestTokens({
        ...input,
        messages: [...input.messages, response, makeUser('abcd')],
      }),
    ).toEqual({ source: 'usage', tokens: 1201 });
  });

  it('reuses usage when the provider echoes a model alias instead of the key', () => {
    const { input, response } = request();
    // Providers may echo an alias such as `auto` in
    // completion payloads. The anchor fingerprint binds the canonical model
    // at request time, so the alias must not disable usage anchoring — that
    // would force every threshold check onto the overestimating heuristic.
    response.message = { ...response.message, model: 'auto' };
    expect(
      countRequestTokens({
        ...input,
        messages: [...input.messages, response, makeUser('abcd')],
      }),
    ).toEqual({ source: 'usage', tokens: 1201 });
    // A genuinely different canonical model still re-estimates via the
    // request fingerprint, which embeds the model used at anchor creation.
    expect(
      countRequestTokens({
        ...input,
        model: 'other-model',
        messages: [...input.messages, response, makeUser('abcd')],
      }).source,
    ).toBe('estimate');
  });

  it.each([
    'model',
    'history',
    'system',
    'tools',
    'projection',
    'response',
    'missing-anchor',
    'missing-usage',
  ])('re-estimates after %s changes', (change) => {
    const { input, response } = request();
    input.messages.push(response);
    if (change === 'model') input.model = 'other-model';
    if (change === 'history') input.messages[0] = makeUser('changed history');
    if (change === 'system')
      input.systemPrompt = systemPromptFromText('changed system');
    if (change === 'tools') input.tools = [];
    if (change === 'projection')
      input.projectionOptions = { targetModel: 'other-model' };
    if (change === 'response')
      response.message = {
        ...response.message,
        content: [{ type: 'text', text: 'changed answer' }],
      };
    if (change === 'missing-anchor') delete response.requestTokenAnchor;
    if (change === 'missing-usage') delete response.message.usage;
    expect(countRequestTokens(input).source).toBe('estimate');
    expect(countRequestTokens(input).tokens).toBeLessThan(1000);
  });

  it('captures input identity before overhead can change during sampling', () => {
    const { input, response } = request();
    const bindResponse = createRequestTokenAnchor(input);
    input.systemPrompt = systemPromptFromText('changed while sampling');
    response.requestTokenAnchor = bindResponse(response.message.content);
    expect(
      countRequestTokens({ ...input, messages: [...input.messages, response] })
        .source,
    ).toBe('estimate');
  });

  it('re-estimates when an explicit provider projection changes the request', () => {
    const { input, response } = request();
    const changed = {
      ...input,
      messages: [...input.messages, response],
      normalizedMessages: normalizeMessagesForAPI([
        makeUser('different input'),
      ]),
    };
    expect(countRequestTokens(changed).source).toBe('estimate');
  });

  it('reuses private persisted usage only for the exact response', () => {
    const { input, response } = request();
    const usage = { ...response.message.usage!, request_id: 'saved-request' };
    response.requestTokenAnchor = createRequestTokenAnchor(input)(
      response.message.content,
      'saved-request',
    );
    delete response.requestId;
    delete response.message.usage;
    const resumed = {
      ...input,
      messages: [...input.messages, response],
      latestUsage: usage,
    };
    expect(countRequestTokens(resumed)).toEqual({
      source: 'usage',
      tokens: 1200,
    });
    expect(
      countRequestTokens({
        ...resumed,
        latestUsage: { ...usage, request_id: 'different-request' },
      }).source,
    ).toBe('estimate');
  });

  it('does not reuse older usage when the latest response lacks usage', () => {
    const { input, response } = request();
    const later = makeAssistant([{ type: 'text', text: 'later' }]);
    delete later.message.usage;
    expect(
      countRequestTokens({
        ...input,
        messages: [...input.messages, response, makeUser('next'), later],
      }).source,
    ).toBe('estimate');
  });

  it('validates the complete response when it is split into assistant blocks', () => {
    const { input, response } = request();
    const content = [
      { type: 'text' as const, text: 'first' },
      { type: 'text' as const, text: 'second' },
    ];
    const anchor = createRequestTokenAnchor(input)(content);
    const first: AssistantMessage = {
      ...response,
      requestTokenAnchor: anchor,
      message: {
        ...response.message,
        content: [content[0]],
        stop_reason: null,
        usage: undefined,
      },
    };
    const last: AssistantMessage = {
      ...response,
      requestTokenAnchor: anchor,
      message: { ...response.message, content: [content[1]] },
    };
    expect(
      countRequestTokens({
        ...input,
        messages: [...input.messages, first, last],
      }),
    ).toEqual({ source: 'usage', tokens: 1200 });
    expect(
      countRequestTokens({ ...input, messages: [...input.messages, last] })
        .source,
    ).toBe('estimate');
  });

  it('counts expanded attachments instead of their raw DTO or zero', () => {
    const attachment = {
      type: 'attachment',
      uuid: 'att',
      timestamp: new Date().toISOString(),
      attachment: {
        type: 'task_reminder',
        content: [
          {
            id: '1',
            subject: 'x'.repeat(40000),
            description: 'large',
            status: 'pending',
            blocks: [],
            blockedBy: [],
          },
        ],
        itemCount: 1,
      },
    } as unknown as Message;
    const input = {
      model: 'test-model',
      messages: [makeUser('prompt'), attachment],
    };
    expect(countRequestTokens(input).tokens).toBeGreaterThan(1000);
    expect(
      countRequestTokens({
        ...input,
        normalizedMessages: normalizeMessagesForAPI(input.messages),
      }),
    ).toEqual(countRequestTokens(input));
  });

  it('压缩工具结果内容按标准文本规则估算且只在总量上取整', () => {
    expect(
      estimateBlocksTokenCount([
        {
          type: 'tool_result',
          tool_use_id: 'first',
          content: 'abc',
          is_error: false,
        },
        {
          type: 'tool_result',
          tool_use_id: 'second',
          content: Object.freeze([Object.freeze({ type: 'text', text: '中' })]),
          is_error: true,
        },
      ]),
    ).toBe(Math.floor(estimateTextTokens('abc') + estimateTextTokens('中')));
    expect(estimateBlocksTokenCount([])).toBe(0);
  });

  it('uses fixed image costs inside tool results instead of base64 size', () => {
    const image = {
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        mediaType: 'image/png' as const,
        data: 'a'.repeat(40000),
      },
    };
    const messages = [
      { role: 'tool' as const, toolCallId: 'tool', content: [image] },
    ];
    expect(
      estimateBlocksTokenCount([
        {
          type: 'tool_result',
          tool_use_id: 'tool',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: image.source.mediaType,
                data: image.source.data,
              },
            },
          ],
          is_error: false,
        },
      ]),
    ).toBe(3000);
    expect(
      countRequestTokens({
        model: 'test-model',
        messages: [],
        normalizedMessages: messages,
      }).tokens,
    ).toBe(3000);
  });
});
