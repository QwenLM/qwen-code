/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ModelMessage } from '../provider/event/modelCompleteEvent.js';
import type {
  ModelStreamMessage,
  ModelStreamRequest,
} from '../provider/modelStreamRequest.js';
import { ASK_USER_ASYNC_TOOL_NAME } from '../tools/tool-names.js';
import { SINGLE_REQUEST_FORK } from './request-scope.js';
import {
  allowsEmptyCompletionAfterAsyncQuestion,
  validateAssistantCompletion,
  EMPTY_ASSISTANT_COMPLETION_CODE,
  EmptyAssistantCompletionError,
  isEmptyAssistantCompletionError,
} from './empty-assistant-completion.js';

describe('EmptyAssistantCompletionError', () => {
  it('carries a stable semantic code and structured diagnostics', () => {
    const error = new EmptyAssistantCompletionError({
      reason: 'reasoning_only',
      finishReason: 'end_turn',
      contentBlockCount: 1,
      reasoningBlockCount: 1,
      textCharacterCount: 0,
      model: 'test-model',
      transport: 'external-openai',
      serverRequestId: 'server-1',
    });

    expect(error).toMatchObject({
      name: 'EmptyAssistantCompletionError',
      code: EMPTY_ASSISTANT_COMPLETION_CODE,
      retryable: true,
      reason: 'reasoning_only',
      finishReason: 'end_turn',
      model: 'test-model',
      transport: 'external-openai',
      serverRequestId: 'server-1',
    });
    expect(isEmptyAssistantCompletionError(error)).toBe(true);
  });
});

const questionMessages: ModelStreamMessage[] = [
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'ask', name: ASK_USER_ASYNC_TOOL_NAME, arguments: '{}' }],
  },
  { role: 'tool', toolCallId: 'ask', content: 'published' },
];
const emptyResult: ModelMessage = {
  messageId: 'm',
  model: 'test',
  blocks: [],
  stopReason: 'end_turn',
};

const questionRequest: ModelStreamRequest = {
  resolution: {
    model: {
      source: 'local',
      key: 'test',
      displayName: 'Test',
      capabilities: {
        tools: true,
        vision: false,
        reasoning: { supported: false, supportedEfforts: [] },
        contextWindows: [],
      },
      limits: { maxContextTokens: 200000 },
    },
    config: {},
  },
  prompt: { messages: questionMessages },
};

describe('allowsEmptyCompletionAfterAsyncQuestion', () => {
  it.each([
    ['no blocks', []],
    ['blank text', [{ type: 'text', text: '  ' }]],
  ] as const)(
    'accepts %s immediately after successful publication',
    (_name, blocks) => {
      expect(
        allowsEmptyCompletionAfterAsyncQuestion(questionRequest, {
          ...emptyResult,
          blocks,
        }),
      ).toBe(true);
      expect(() =>
        validateAssistantCompletion(
          questionRequest,
          { ...emptyResult, blocks },
          'test-transport',
        ),
      ).not.toThrow();
    },
  );

  it.each([
    ['no publication', []],
    [
      'failed publication',
      [
        questionMessages[0],
        { role: 'tool', toolCallId: 'ask', content: 'failed', isError: true },
      ],
    ],
    [
      'unmatched result',
      [
        questionMessages[0],
        { role: 'tool', toolCallId: 'other', content: 'published' },
      ],
    ],
    [
      'answer arrived',
      [...questionMessages, { role: 'user', content: 'Blue' }],
    ],
    [
      'assistant continued',
      [...questionMessages, { role: 'assistant', content: 'Working on it' }],
    ],
    [
      'another tool followed',
      [
        ...questionMessages,
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'sleep', name: 'Sleep', arguments: '{}' }],
        },
        { role: 'tool', toolCallId: 'sleep', content: 'timeout' },
      ],
    ],
    [
      'mixed tool batch',
      [
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'ask', name: ASK_USER_ASYNC_TOOL_NAME, arguments: '{}' },
            { id: 'read', name: 'Read', arguments: '{}' },
          ],
        },
        questionMessages[1],
        { role: 'tool', toolCallId: 'read', content: 'file' },
      ],
    ],
    ['missing publication result', [questionMessages[0]]],
  ] satisfies Array<[string, ModelStreamMessage[]]>)(
    'rejects %s',
    (_name, messages) => {
      expect(
        allowsEmptyCompletionAfterAsyncQuestion(
          { ...questionRequest, prompt: { messages } },
          emptyResult,
        ),
      ).toBe(false);
      expect(() =>
        validateAssistantCompletion(
          { ...questionRequest, prompt: { messages } },
          emptyResult,
          'test-transport',
        ),
      ).toThrow(EmptyAssistantCompletionError);
    },
  );

  it.each([
    { ...emptyResult, stopReason: undefined },
    { ...emptyResult, stopReason: 'max_tokens' },
    {
      ...emptyResult,
      blocks: [{ type: 'thinking', thinking: 'still thinking' }],
    },
    { ...emptyResult, blocks: [{ type: 'redacted_thinking', data: 'opaque' }] },
    { ...emptyResult, blocks: [{ type: 'text', text: 'answer' }] },
  ] satisfies ModelMessage[])(
    'does not exempt other completions: %j',
    (result) => {
      expect(
        allowsEmptyCompletionAfterAsyncQuestion(questionRequest, result),
      ).toBe(false);
    },
  );

  it('retains single-request fork semantics', () => {
    const request = {
      ...questionRequest,
      [SINGLE_REQUEST_FORK]: true,
    };
    expect(allowsEmptyCompletionAfterAsyncQuestion(request, emptyResult)).toBe(
      false,
    );
    expect(() =>
      validateAssistantCompletion(request, emptyResult, 'test-transport'),
    ).toThrow(EmptyAssistantCompletionError);
  });
});

describe('validateAssistantCompletion', () => {
  it.each([
    { ...emptyResult, stopReason: 'max_tokens' },
    { ...emptyResult, stopReason: 'refusal' },
    { ...emptyResult, blocks: [{ type: 'text', text: 'answer' }] },
    {
      ...emptyResult,
      blocks: [{ type: 'tool_use', id: 'read', name: 'Read', input: {} }],
    },
  ] satisfies ModelMessage[])('accepts nonempty or non-end-turn results: %j', (result) => {
    expect(() =>
      validateAssistantCompletion(questionRequest, result, 'test-transport'),
    ).not.toThrow();
  });

  it.each([
    ['reasoning_only', [{ type: 'thinking', thinking: 'thinking' }, { type: 'text', text: '  ' }], 1],
    ['no_visible_content', [{ type: 'text', text: '  ' }], 0],
  ] satisfies Array<[string, ModelMessage['blocks'], number]>)(
    'preserves %s diagnostics',
    (reason, blocks, reasoningBlockCount) => {
      expect(() =>
        validateAssistantCompletion(
          { ...questionRequest, prompt: { messages: [] } },
          { ...emptyResult, blocks },
          'test-transport',
        ),
      ).toThrow(expect.objectContaining({
        reason,
        finishReason: 'end_turn',
        contentBlockCount: blocks.length,
        reasoningBlockCount,
        textCharacterCount: 2,
        model: emptyResult.model,
        transport: 'test-transport',
      }));
    },
  );
});
