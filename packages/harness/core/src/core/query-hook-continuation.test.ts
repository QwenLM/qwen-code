/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { cloneUsage } from '../protocol/provider/empty-usage.js';
import {
  createAssistantMessage,
  createUserMessage,
} from '../protocol/transcript/conversions.js';
import { getRewindCandidates } from '../services/transcript/conversation-rewind.js';
import { resolveHookAfterResult } from './query-hook-continuation.js';
import type { QueryRuntimeState } from './query-runtime-state.js';

function makeState(): QueryRuntimeState {
  const historyMessage = createUserMessage('Earlier prompt');
  const assistantMessage = createAssistantMessage({
    messageId: 'assistant-1',

    blocks: [{ type: 'text', text: 'Earlier response' }],

    model: 'test-model',
    stopReason: 'end_turn',

    usage: ((value) => ({
      inputTokens: value.input_tokens,
      outputTokens: value.output_tokens,
      cacheReadInputTokens: value.cache_read_input_tokens,
      cacheCreationInputTokens: value.cache_creation_input_tokens,
    }))(cloneUsage()),
  });

  return {
    messages: [historyMessage, assistantMessage],
    turnCount: 1,
    stopHookActive: false,
    maxOutputTokensRecoveryCount: 0,
    malformedToolUseRetryCount: 0,
    hasAttemptedReactiveCompact: false,
    autoCompactTracking: { consecutiveFailures: 0 },
    preProjectedMessages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Projected earlier prompt' }],
      },
    ],
    preProjectedMessageCount: 1,
  };
}

describe('query-hook-continuation', () => {
  it('builds a stop-hook continuation and clears request context when requested', () => {
    const resolution = resolveHookAfterResult({
      afterResult: {
        blocked: true,
        inject: 'Please explain',
        clearContext: true,
        retryAsStopHook: true,
      },
      state: makeState(),
      promptId: 'prompt-1',
      permissionMode: 'default',
    });

    expect(resolution.terminalReason).toBeUndefined();
    expect(resolution.continuationMessage?.message.content).toBe(
      'Please explain',
    );
    expect(resolution.continuationMessage?.isMeta).toBe(true);
    expect(resolution.nextState?.transition).toEqual({
      reason: 'stop_hook_blocking',
    });
    expect(resolution.nextState?.stopHookActive).toBe(true);
    expect(resolution.nextState?.messages).toHaveLength(1);
    expect(resolution.nextState?.preProjectedMessages).toBeUndefined();
    expect(resolution.nextState?.preProjectedMessageCount).toBeUndefined();
  });

  it('keeps hook continuation messages out of rewind candidates', () => {
    const state = makeState();
    const resolution = resolveHookAfterResult({
      afterResult: {
        blocked: true,
        inject: 'Continue working toward the active thread goal.',
        retryAsStopHook: true,
      },
      state,
      promptId: 'prompt-1',
    });

    const continuationMessage = resolution.continuationMessage;
    expect(continuationMessage).toBeDefined();
    const candidates = getRewindCandidates([
      ...state.messages,
      continuationMessage!,
    ]);
    expect(candidates.map((candidate) => candidate.message.uuid)).toEqual(
      state.messages
        .filter((message) => message.type === 'user')
        .map((message) => message.uuid),
    );
  });

  it('returns a stopped terminal resolution without continuation state', () => {
    const resolution = resolveHookAfterResult({
      afterResult: {
        stopped: true,
      },
      state: makeState(),
      promptId: 'prompt-2',
    });

    expect(resolution).toEqual({
      terminalReason: 'stopped',
    });
  });
});
