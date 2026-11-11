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
import {
  buildMalformedToolUseRecoveryState,
  buildMaxOutputTokensRecoveryState,
  buildPromptTooLongRecoveryState,
  buildReactiveCompactRecoveryState,
  getEscalatedMaxOutputTokens,
} from './query-recovery.js';
import type { QueryRuntimeState } from './query-runtime-state.js';
import { MAX_PTL_RETRIES } from '../compression-v2/ptl-retry.js';

function makeAssistant(text: string) {
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

describe('query-recovery', () => {
  it('preserves the malformed assistant and appends a corrective meta message', () => {
    const originalUser = createUserMessage('Run the tool');
    const malformedAssistant = makeAssistant('<invoke>');
    const state: QueryRuntimeState = {
      messages: [originalUser],
      turnCount: 0,
      stopHookActive: false,
      maxOutputTokensRecoveryCount: 0,
      malformedToolUseRetryCount: 0,
      hasAttemptedReactiveCompact: false,
      autoCompactTracking: { consecutiveFailures: 0 },
    };

    const recovery = buildMalformedToolUseRecoveryState({
      state,
      assistantMessages: [malformedAssistant],
      promptId: 'prompt-1',
      permissionMode: 'default',
      nextTurnCount: 1,
    });

    expect(recovery.state.messages).toEqual([
      originalUser,
      malformedAssistant,
      recovery.correctiveMessage,
    ]);
    expect(recovery.state.transition).toEqual({
      reason: 'malformed_tool_use_retry',
    });
    expect(recovery.state.malformedToolUseRetryCount).toBe(1);
    expect(recovery.state.turnCount).toBe(1);
    expect(recovery.correctiveMessage).toMatchObject({
      isMeta: true,
      promptId: 'prompt-1',
      permissionMode: 'default',
      origin: { kind: 'malformed-tool-use-retry' },
    });
    expect(recovery.state.pendingUserMessageUuid).toBe(
      recovery.correctiveMessage.uuid,
    );
  });

  it('does not escalate an explicit output token limit from the caller', () => {
    expect(
      getEscalatedMaxOutputTokens({
        currentOverride: 256,
        requestedMaxOutputTokens: 256,
        modelMaxOutputTokens: 1024,
      }),
    ).toBeNull();
  });

  it('escalates an internal output token cap when the model allows a larger limit', () => {
    expect(
      getEscalatedMaxOutputTokens({
        currentOverride: 256,
        requestedMaxOutputTokens: undefined,
        modelMaxOutputTokens: 1024,
      }),
    ).toBe(1024);

    expect(
      getEscalatedMaxOutputTokens({
        currentOverride: 1024,
        requestedMaxOutputTokens: 1024,
        modelMaxOutputTokens: 1024,
      }),
    ).toBeNull();
  });

  it('appends a recovery user message after hitting the output token limit', () => {
    const state: QueryRuntimeState = {
      messages: [createUserMessage('Earlier prompt'), makeAssistant('Partial')],
      turnCount: 1,
      stopHookActive: false,
      maxOutputTokensRecoveryCount: 0,
      malformedToolUseRetryCount: 0,
      hasAttemptedReactiveCompact: false,
      autoCompactTracking: { consecutiveFailures: 0 },
    };

    const nextState = buildMaxOutputTokensRecoveryState({
      state,
      promptId: 'prompt-1',
      permissionMode: 'default',
    });

    expect(nextState).not.toBeNull();
    expect(nextState?.transition).toEqual({
      reason: 'max_output_tokens_recovery',
      attempt: 1,
    });
    expect(nextState?.maxOutputTokensRecoveryCount).toBe(1);
    expect(nextState?.messages.at(-1)).toMatchObject({
      type: 'user',
      message: {
        content: `Output token limit hit. Resume directly — no apology or recap.
Continue from the last verifiable point in the visible conversation and tool results.
Break the remaining work into smaller pieces.`,
      },
      isMeta: true,
      promptId: 'prompt-1',
      permissionMode: 'default',
      origin: { kind: 'human' },
    });
  });

  it('drops the projected prefix after prompt-too-long recovery truncates runtime history', () => {
    const firstUser = createUserMessage('Earlier prompt');
    const assistant = makeAssistant('Earlier response');
    const pendingUser = createUserMessage('Current prompt');
    const state: QueryRuntimeState = {
      messages: [firstUser, assistant, pendingUser],
      turnCount: 0,
      stopHookActive: false,
      maxOutputTokensRecoveryCount: 0,
      malformedToolUseRetryCount: 0,
      hasAttemptedReactiveCompact: false,
      autoCompactTracking: { consecutiveFailures: 0 },
      pendingUserMessageUuid: pendingUser.uuid,
      preProjectedMessages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Projected earlier prompt' }],
        },
      ],
      preProjectedMessageCount: 1,
      compressionState: {
        promptTooLongRetryCount: 0,
      },
    };

    const nextState = buildPromptTooLongRecoveryState({
      state,
      error: new Error(
        'Prompt is too long: 120000 tokens exceeds the limit 100000',
      ),
    });

    expect(nextState).not.toBeNull();
    expect(nextState?.transition).toEqual({
      reason: 'prompt_too_long_recovery',
      attempt: 1,
    });
    expect(nextState?.preProjectedMessages).toBeUndefined();
    expect(nextState?.preProjectedMessageCount).toBeUndefined();
    expect(nextState?.messages.at(-1)?.uuid).toBe(pendingUser.uuid);
  });

  it('rejects another truncation after three retries without a successful main response, including after compaction', () => {
    const firstUser = createUserMessage('Earlier prompt');
    const assistant = makeAssistant('Earlier response');
    const pendingUser = createUserMessage('Current prompt');
    const state: QueryRuntimeState = {
      messages: [firstUser, assistant, pendingUser],
      turnCount: 0,
      stopHookActive: false,
      maxOutputTokensRecoveryCount: 0,
      malformedToolUseRetryCount: 0,
      hasAttemptedReactiveCompact: false,
      autoCompactTracking: { consecutiveFailures: 0 },
      pendingUserMessageUuid: pendingUser.uuid,
      compressionState: {
        promptTooLongRetryCount: MAX_PTL_RETRIES,
      },
    };

    const nextState = buildPromptTooLongRecoveryState({
      state,
      error: new Error(
        'Prompt is too long: 120000 tokens exceeds the limit 100000',
      ),
    });

    expect(nextState).toBeNull();

    const compactedState = buildReactiveCompactRecoveryState({
      state,
      newHistory: [firstUser, assistant, pendingUser],
    });
    expect(compactedState.compressionState?.promptTooLongRetryCount).toBe(
      MAX_PTL_RETRIES,
    );
    expect(
      buildPromptTooLongRecoveryState({
        state: compactedState,
        error: new Error('Prompt is too long'),
      }),
    ).toBeNull();
  });
});
