/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import type { Message, AssistantMessage } from './message-types.js';
import { getContentBlocks } from './message-types.js';
import { makeUser, makeAssistant } from './test-helpers.js';
import {
  groupMessagesByApiRound,
  parseTokenGapFromError,
  isPromptTooLongError,
  truncateHeadForPtlRetry,
  withPtlRetry,
  PTL_RETRY_MARKER,
  MAX_PTL_RETRIES,
  type PtlRecoveryObservation,
} from './ptl-retry.js';

function userMsg(text: string): Message {
  return makeUser([{ type: 'text' as const, text }]);
}

function modelMsg(text: string, overrideId?: string): AssistantMessage {
  const msg = makeAssistant([{ type: 'text' as const, text }]);
  if (overrideId) {
    msg.message = { ...msg.message, id: overrideId };
  }
  return msg;
}

const maximumContextLengthMessage =
  "This model's maximum context length is 1048576 tokens. However, you requested 1052983 tokens (1004983 in the messages, 48000 in the completion). Please reduce the length of the messages or completion.";
const maximumContextLengthResultedMessage =
  "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.";

function nestedMaximumContextLengthError(): Error {
  const body = JSON.stringify({
    code: 'provider_error',
    message: 'Error in upstream response',
    details: JSON.stringify({
      error: {
        code: 'invalid_request_error',
        message: maximumContextLengthMessage,
      },
    }),
  });
  return Object.assign(new Error(`Qoder API error: BAD_REQUEST - ${body}`), {
    status: 400,
  });
}

describe('groupMessagesByApiRound', () => {
  it('should return empty array for empty input', () => {
    expect(groupMessagesByApiRound([])).toEqual([]);
  });

  it('should group by assistant message.id boundaries', () => {
    const q1 = userMsg('q1');
    const a1 = modelMsg('a1'); // unique id from makeAssistant
    const q2 = userMsg('q2');
    const a2 = modelMsg('a2'); // different unique id
    const messages = [q1, a1, q2, a2];
    const groups = groupMessagesByApiRound(messages);
    // Each new assistant id starts a new group:
    // group 0: [q1]  (preamble before first assistant)
    // group 1: [a1, q2]  (a1's round, includes follow-up user)
    // group 2: [a2]  (a2's round)
    expect(groups).toHaveLength(3);
    expect(groups[0]).toEqual([q1]);
    expect(groups[1]).toEqual([a1, q2]);
    expect(groups[2]).toEqual([a2]);
  });

  it('should keep tool call/response pairs with same assistant id in one group', () => {
    const sharedId = 'shared-assistant-id';
    const q = userMsg('do something');
    // Tool call and final response share the same message.id (same API round)
    const toolCall = modelMsg('', sharedId);
    // Override content to be a tool_use block
    toolCall.message = {
      ...toolCall.message,
      content: [
        { type: 'tool_use' as const, id: 'some-id', name: 'Read', input: {} },
      ],
    };
    const toolResult = makeUser([
      {
        type: 'tool_result' as const,
        tool_use_id: 'some-id',
        content: 'data',
        is_error: false,
      },
    ]);
    const done = modelMsg('done', sharedId); // same API round
    const messages: Message[] = [q, toolCall, toolResult, done];
    const groups = groupMessagesByApiRound(messages);
    // group 0: [q]  (preamble)
    // group 1: [toolCall, toolResult, done]  (all share same assistant id)
    expect(groups).toHaveLength(2);
    expect(groups[1]).toHaveLength(3);
  });

  it('should split tool calls from different API rounds', () => {
    const q = userMsg('do something');
    const toolCall1 = makeAssistant([
      { type: 'tool_use' as const, id: 'id-1', name: 'Read', input: {} },
    ]);
    const toolResult1 = makeUser([
      {
        type: 'tool_result' as const,
        tool_use_id: 'id-1',
        content: 'data1',
        is_error: false,
      },
    ]);
    // New API round — different message.id from makeAssistant
    const toolCall2 = makeAssistant([
      { type: 'tool_use' as const, id: 'id-2', name: 'Write', input: {} },
    ]);
    const toolResult2 = makeUser([
      {
        type: 'tool_result' as const,
        tool_use_id: 'id-2',
        content: 'data2',
        is_error: false,
      },
    ]);
    const messages: Message[] = [
      q,
      toolCall1,
      toolResult1,
      toolCall2,
      toolResult2,
    ];
    const groups = groupMessagesByApiRound(messages);
    // group 0: [q]
    // group 1: [toolCall1, toolResult1]
    // group 2: [toolCall2, toolResult2]
    expect(groups).toHaveLength(3);
  });

  it('should handle single message', () => {
    const hello = userMsg('hello');
    const groups = groupMessagesByApiRound([hello]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual([hello]);
  });
});

describe('parseTokenGapFromError', () => {
  it('should parse "N tokens > M" format', () => {
    const error = new Error(
      'Request contains 150000 tokens which exceeds the limit of 128000',
    );
    expect(parseTokenGapFromError(error)).toBe(22000);
  });

  it('should parse with commas in numbers', () => {
    const error = new Error('Prompt has 1,500,000 tokens, limit is 1,048,576');
    expect(parseTokenGapFromError(error)).toBe(451424);
  });

  it('should parse a configured limit before the actual input count', () => {
    const error = new Error(
      'Input tokens exceed the configured limit of 922000 tokens. Your messages resulted in 922784 tokens.',
    );
    expect(parseTokenGapFromError(error)).toBe(784);
  });

  it('should leave the provider maximum context length gap unparsed', () => {
    expect(
      parseTokenGapFromError(nestedMaximumContextLengthError()),
    ).toBeNull();
  });

  it('should leave a maximum context length gap with resulted in wording unparsed', () => {
    expect(
      parseTokenGapFromError(new Error(maximumContextLengthResultedMessage)),
    ).toBeNull();
  });

  it('should return null for non-PTL errors', () => {
    expect(parseTokenGapFromError(new Error('quota exceeded'))).toBeNull();
  });

  it('should return null for null/undefined', () => {
    expect(parseTokenGapFromError(null)).toBeNull();
    expect(parseTokenGapFromError(undefined)).toBeNull();
  });

  it('should handle string errors', () => {
    expect(
      parseTokenGapFromError('contains 200000 tokens > maximum 128000'),
    ).toBe(72000);
  });
});

describe('isPromptTooLongError', () => {
  it('should detect "too many tokens" errors', () => {
    expect(isPromptTooLongError(new Error('Too many tokens in request'))).toBe(
      true,
    );
  });

  it('should detect "exceeds the limit" errors', () => {
    expect(
      isPromptTooLongError(new Error('Request payload size exceeds the limit')),
    ).toBe(true);
  });

  it('should detect configured input token limit errors', () => {
    expect(
      isPromptTooLongError(
        new Error(
          'Input tokens exceed the configured limit of 922000 tokens. Your messages resulted in 922784 tokens.',
        ),
      ),
    ).toBe(true);
  });

  it('should detect the nested provider maximum context length error', () => {
    expect(isPromptTooLongError(nestedMaximumContextLengthError())).toBe(true);
  });

  it('should detect maximum context length errors without requiring token counts', () => {
    expect(
      isPromptTooLongError(new Error(maximumContextLengthResultedMessage)),
    ).toBe(true);
    expect(
      isPromptTooLongError(new Error('Maximum context length exceeded')),
    ).toBe(true);
    expect(
      parseTokenGapFromError(new Error('Maximum context length exceeded')),
    ).toBeNull();
  });

  it('should detect "prompt is too long" errors', () => {
    expect(isPromptTooLongError(new Error('Prompt is too long'))).toBe(true);
  });

  it.each([
    'Prompt exceeds max length',
    'Error in upstream response: {"error":{"code":"1261","message":"Prompt exceeds max length"}}',
  ])('should detect GLM prompt length errors: %s', (message) => {
    expect(isPromptTooLongError(new Error(message))).toBe(true);
  });

  it('should detect "content too large" errors', () => {
    expect(isPromptTooLongError(new Error('Content too large for model'))).toBe(
      true,
    );
  });

  it('should detect provider input length range errors', () => {
    expect(
      isPromptTooLongError(
        new Error(
          '<400> InternalError.Algo.InvalidParameter: Range of input length should be [1, 262144]',
        ),
      ),
    ).toBe(true);
  });

  it('should detect HTTP 413 status code errors', () => {
    const err = Object.assign(new Error('Qoder API error: 413 - some body'), {
      status: 413,
    });
    expect(isPromptTooLongError(err)).toBe(true);
  });

  it('should detect HTTP 413 even with unrelated message', () => {
    const err = Object.assign(new Error('unknown error'), { status: 413 });
    expect(isPromptTooLongError(err)).toBe(true);
  });

  it('should not treat other HTTP status codes as PTL', () => {
    const err = Object.assign(new Error('server error'), { status: 500 });
    expect(isPromptTooLongError(err)).toBe(false);
  });

  it('should not detect unrelated errors', () => {
    expect(isPromptTooLongError(new Error('quota exceeded'))).toBe(false);
    expect(isPromptTooLongError(new Error('network error'))).toBe(false);
  });
});

describe('truncateHeadForPtlRetry', () => {
  it('should return null when less than 2 groups', () => {
    expect(truncateHeadForPtlRetry([userMsg('hello')], new Error())).toBeNull();
  });

  it('should drop 20% of groups on unparseable error', () => {
    const messages = [
      userMsg('q1'),
      modelMsg('a1'),
      userMsg('q2'),
      modelMsg('a2'),
      userMsg('q3'),
      modelMsg('a3'),
      userMsg('q4'),
      modelMsg('a4'),
      userMsg('q5'),
      modelMsg('a5'),
    ];
    const result = truncateHeadForPtlRetry(messages, new Error('unknown'));
    expect(result).not.toBeNull();
    // 6 groups total, floor(6 * 0.2) = 1 group dropped
    // First group [userMsg('q1')] is dropped
    // Remaining starts with modelMsg('a1') → marker prepended
    expect(result![0].type).toBe('user');
    expect(result![0].isMeta).toBe(true);
    const blocks = getContentBlocks(result![0]);
    expect(blocks[0]).toEqual(
      expect.objectContaining({
        type: 'text',
        text: PTL_RETRY_MARKER,
      }),
    );
  });

  it('should strip existing retry marker before regrouping', () => {
    const messages: Message[] = [
      makeUser([{ type: 'text' as const, text: PTL_RETRY_MARKER }], {
        isMeta: true,
      }),
      modelMsg('a1'),
      userMsg('q2'),
      modelMsg('a2'),
      userMsg('q3'),
      modelMsg('a3'),
    ];
    const result = truncateHeadForPtlRetry(messages, new Error('unknown'));
    expect(result).not.toBeNull();
    // After stripping marker, should have 3 groups, drop floor(20%) = 1
  });

  it('should prepend user marker when first remaining is model', () => {
    const messages = [
      userMsg('q1'),
      modelMsg('a1'),
      userMsg('q2'),
      modelMsg('a2'),
    ];
    const result = truncateHeadForPtlRetry(messages, new Error('error'));
    if (result && result[0]?.type === 'assistant') {
      // Should have been prepended
      expect(false).toBe(true);
    }
    // First message should always be user type
    expect(result?.[0]?.type).toBe('user');
  });

  it('should never drop all groups', () => {
    const messages = [userMsg('q1'), modelMsg('a1')];
    const result = truncateHeadForPtlRetry(messages, new Error('error'));
    // 2 groups, should drop at most 1
    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThan(0);
  });
});

describe('withPtlRetry', () => {
  it('should return result on first success', async () => {
    const generateFn = vi.fn().mockResolvedValue('summary');
    const messages = [userMsg('hello')];
    const result = await withPtlRetry(generateFn, messages);
    expect(result).toBe('summary');
    expect(generateFn).toHaveBeenCalledTimes(1);
  });

  it('should retry after the nested provider maximum context length error', async () => {
    const generateFn = vi
      .fn()
      .mockRejectedValueOnce(nestedMaximumContextLengthError())
      .mockResolvedValue('summary after retry');
    const messages = [
      userMsg('q1'),
      modelMsg('a1'),
      userMsg('q2'),
      modelMsg('a2'),
    ];

    await expect(withPtlRetry(generateFn, messages)).resolves.toBe(
      'summary after retry',
    );
    expect(generateFn).toHaveBeenCalledTimes(2);
    expect(generateFn.mock.calls[1]?.[0]).not.toContain(messages[0]);
    expect(generateFn.mock.calls[1]?.[0]).toContain(messages.at(-1));
  });

  it.each([
    'Too many tokens in request',
    'Error in upstream response: {"error":{"code":"1261","message":"Prompt exceeds max length"}}',
  ])('should retry on PTL error and succeed: %s', async (message) => {
    const generateFn = vi
      .fn()
      .mockRejectedValueOnce(new Error(message))
      .mockResolvedValue('summary after retry');

    const messages = [
      userMsg('q1'),
      modelMsg('a1'),
      userMsg('q2'),
      modelMsg('a2'),
    ];
    const result = await withPtlRetry(generateFn, messages);
    expect(result).toBe('summary after retry');
    expect(generateFn).toHaveBeenCalledTimes(2);
    expect(generateFn.mock.calls[1]?.[0]).not.toContain(messages[0]);
    expect(generateFn.mock.calls[1]?.[0]).toContain(messages.at(-1));
  });

  it('should throw non-PTL errors immediately', async () => {
    const generateFn = vi.fn().mockRejectedValue(new Error('quota exceeded'));

    await expect(withPtlRetry(generateFn, [userMsg('hello')])).rejects.toThrow(
      'quota exceeded',
    );
    expect(generateFn).toHaveBeenCalledTimes(1);
  });

  it('should throw after MAX_PTL_RETRIES attempts', async () => {
    const generateFn = vi.fn().mockRejectedValue(new Error('Too many tokens'));

    const messages = Array.from({ length: 20 }, (_, i) => [
      userMsg(`q${i}`),
      modelMsg(`a${i}`),
    ]).flat();

    const onRecovery = vi.fn();
    await expect(
      withPtlRetry(generateFn, messages, { onRecovery }),
    ).rejects.toThrow('Too many tokens');
    // 1 initial + MAX_PTL_RETRIES retries
    expect(generateFn).toHaveBeenCalledTimes(MAX_PTL_RETRIES + 1);
    expect(onRecovery.mock.calls.map(([event]) => event.outcome)).toEqual([
      'ready',
      'ready',
      'ready',
      'stopped',
    ]);
    expect(onRecovery.mock.lastCall?.[0]).toMatchObject({
      stopReason: 'retry_exhausted',
      attempt: MAX_PTL_RETRIES + 1,
      droppedMessages: 0,
    });
  });

  it('isolates recovery observer errors without changing truncation or the terminal error', async () => {
    const error = new Error('Too many tokens');
    const generateFn = vi
      .fn<(messages: Message[]) => Promise<string>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValue('summary');
    const messages = [userMsg('first'), modelMsg('answer'), userMsg('last')];
    const onRecovery = vi.fn<(observation: PtlRecoveryObservation) => void>(
      () => {
        throw new Error('observer failed');
      },
    );
    await expect(
      withPtlRetry(generateFn, messages, { onRecovery }),
    ).resolves.toBe('summary');
    expect(generateFn).toHaveBeenCalledTimes(2);
    expect(generateFn.mock.calls[1]?.[0]).not.toContain(messages[0]);
    expect(generateFn.mock.calls[1]?.[0]).toContain(messages[2]);
    const terminalError = new Error('quota exceeded');
    await expect(
      withPtlRetry(vi.fn().mockRejectedValue(terminalError), messages, {
        onRecovery,
      }),
    ).rejects.toBe(terminalError);
    expect(onRecovery.mock.lastCall?.[0]).toMatchObject({
      outcome: 'stopped',
      stopReason: 'non_ptl',
    });
  });

  it('isolates rejected recovery observations without waiting for them', async () => {
    const onRecovery = vi.fn(async () => {
      throw new Error('async observer failed');
    });
    const messages = [userMsg('first'), modelMsg('answer'), userMsg('last')];
    const generate = vi
      .fn()
      .mockRejectedValueOnce(new Error('Too many tokens'))
      .mockResolvedValue('summary');
    await expect(
      withPtlRetry(generate, messages, { onRecovery }),
    ).resolves.toBe('summary');
    const error = new Error('quota exceeded');
    await expect(
      withPtlRetry(vi.fn().mockRejectedValue(error), messages, { onRecovery }),
    ).rejects.toBe(error);
    await Promise.resolve();
  });

  it('keeps the original failure when observation clocks throw and skips clocks without an observer', async () => {
    const error = new Error('quota exceeded');
    const now = vi.spyOn(performance, 'now').mockImplementation(() => {
      throw new Error('clock failed');
    });
    try {
      await expect(
        withPtlRetry(vi.fn().mockRejectedValue(error), [userMsg('hello')]),
      ).rejects.toBe(error);
      expect(now).not.toHaveBeenCalled();
      const onRecovery = vi.fn();
      await expect(
        withPtlRetry(vi.fn().mockRejectedValue(error), [userMsg('hello')], {
          onRecovery,
        }),
      ).rejects.toBe(error);
      expect(onRecovery).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'stopped',
          stopReason: 'non_ptl',
          actionDurationMs: undefined,
        }),
      );
    } finally {
      now.mockRestore();
    }
  });

  it('should throw if truncation is not possible', async () => {
    const generateFn = vi
      .fn()
      .mockRejectedValue(new Error('Prompt is too long'));

    // Only one message, can't truncate
    const onRecovery = vi.fn();
    await expect(
      withPtlRetry(generateFn, [userMsg('hello')], { onRecovery }),
    ).rejects.toThrow('Prompt is too long');
    expect(generateFn).toHaveBeenCalledTimes(1);
    expect(onRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'stopped',
        stopReason: 'cannot_truncate',
        droppedMessages: 0,
      }),
    );
  });
});
