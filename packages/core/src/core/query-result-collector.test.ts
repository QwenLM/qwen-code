/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { cloneUsage } from '../protocol/provider/empty-usage.js';
import { createAssistantMessage } from '../protocol/transcript/conversions.js';
import type { QueryEvent, Terminal } from './query-event.js';
import { collectQueryResults } from './query-result-collector.js';

function assistant(text: string) {
  return createAssistantMessage({
    messageId: `assistant-${text}`,

    blocks: [{ type: 'text', text }],

    model: 'test-model',
    stopReason: 'end_turn',

    usage: ((value) => ({
      inputTokens: value.input_tokens,
      outputTokens: value.output_tokens,
      cacheReadInputTokens: value.cache_read_input_tokens,
      cacheCreationInputTokens: value.cache_creation_input_tokens,
    }))(cloneUsage()),
  });
}

async function* fakeQuery(): AsyncGenerator<QueryEvent, Terminal> {
  yield { type: 'request_start' };
  yield assistant('malformed');
  yield {
    type: 'result_text_reset',
    reason: 'malformed_tool_use_retry',
  };
  yield { type: 'request_start' };
  yield assistant('recovered');
  return {
    reason: 'end_turn',
    numTurns: 2,
    usage: cloneUsage(),
    durationMs: 1,
  };
}

describe('collectQueryResults', () => {
  it.each(['event', 'message'] as const)(
    'closes the generator on %s callback failure',
    async (kind) => {
      let closed = false;
      const failure = new Error('callback failed');
      async function* stream(): AsyncGenerator<QueryEvent, Terminal> {
        try {
          yield assistant('partial');
          return {
            reason: 'end_turn',
            numTurns: 1,
            usage: cloneUsage(),
            durationMs: 1,
          };
        } finally {
          closed = true;
          await Promise.reject(new Error('cleanup failed'));
        }
      }
      await expect(
        collectQueryResults(
          stream(),
          kind === 'event'
            ? () => {
                throw failure;
              }
            : undefined,
          kind === 'message'
            ? async () => {
                throw failure;
              }
            : undefined,
        ),
      ).rejects.toBe(failure);
      expect(closed).toBe(true);
    },
  );

  it('resets aggregate text without removing durable messages', async () => {
    const result = await collectQueryResults(fakeQuery());

    expect(result.messages).toHaveLength(2);
    expect(result.textContent).toBe('recovered');
  });

  it('preserves text collected before the malformed request', async () => {
    async function* multiRequestQuery(): AsyncGenerator<QueryEvent, Terminal> {
      yield { type: 'request_start' };
      yield assistant('earlier');
      yield { type: 'request_start' };
      yield assistant('malformed');
      yield {
        type: 'result_text_reset',
        reason: 'malformed_tool_use_retry',
      };
      yield { type: 'request_start' };
      yield assistant('recovered');
      return {
        reason: 'end_turn',
        numTurns: 3,
        usage: cloneUsage(),
        durationMs: 1,
      };
    }

    const result = await collectQueryResults(multiRequestQuery());

    expect(result.messages).toHaveLength(3);
    expect(result.textContent).toBe('earlierrecovered');
  });
});
