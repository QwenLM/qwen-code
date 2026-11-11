/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MAX_PTL_RETRIES,
  truncateHeadForPtlRetry,
} from '../compression-v2/ptl-retry.js';
import { createUserMessage } from '../protocol/transcript/conversions.js';
import type {
  AssistantMessage,
  Message,
} from '../protocol/transcript/message.js';
import { MALFORMED_TOOL_USE_RETRY_PROMPT } from './malformed-tool-use.js';

import {
  createContinuationState,
  type QueryRuntimeState,
} from './query-runtime-state.js';

export const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 2;

export function buildMalformedToolUseRecoveryState(options: {
  state: QueryRuntimeState;
  assistantMessages: readonly AssistantMessage[];
  promptId: string;
  permissionMode?: string;
  nextTurnCount: number;
}): {
  state: QueryRuntimeState;
  correctiveMessage: ReturnType<typeof createUserMessage>;
} {
  const { state, assistantMessages, promptId, permissionMode, nextTurnCount } =
    options;
  const correctiveMessage = createUserMessage(MALFORMED_TOOL_USE_RETRY_PROMPT, {
    isMeta: true,
    permissionMode,
    origin: { kind: 'malformed-tool-use-retry' },
  });
  correctiveMessage.promptId = promptId;

  return {
    state: createContinuationState(
      state,
      {
        messages: [...state.messages, ...assistantMessages, correctiveMessage],
        pendingUserMessageUuid: correctiveMessage.uuid,
        turnCount: nextTurnCount,
        malformedToolUseRetryCount: 1,
      },
      { reason: 'malformed_tool_use_retry' },
    ),
    correctiveMessage,
  };
}

export function shouldRecoverFromMaxOutputTokens(stopReason: string | null) {
  return stopReason === 'max_tokens';
}

export function buildMaxOutputTokensRecoveryState(options: {
  state: QueryRuntimeState;
  promptId: string;
  permissionMode?: string;
}): QueryRuntimeState | null {
  const { state, promptId, permissionMode } = options;
  if (state.maxOutputTokensRecoveryCount >= MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
    return null;
  }

  const recoveryMessage = createUserMessage(
    `Output token limit hit. Resume directly — no apology or recap.
Continue from the last verifiable point in the visible conversation and tool results.
Break the remaining work into smaller pieces.`,
    {
      isMeta: true,
      permissionMode,
      origin: { kind: 'human' },
    },
  );
  recoveryMessage.promptId = promptId;

  return createContinuationState(
    state,
    {
      messages: [...state.messages, recoveryMessage],
      pendingUserMessageUuid: recoveryMessage.uuid,
      maxOutputTokensRecoveryCount: state.maxOutputTokensRecoveryCount + 1,
      maxOutputTokensOverride: undefined,
    },
    {
      reason: 'max_output_tokens_recovery',
      attempt: state.maxOutputTokensRecoveryCount + 1,
    },
  );
}

export function getEscalatedMaxOutputTokens(options: {
  currentOverride?: number;
  requestedMaxOutputTokens?: number;
  modelMaxOutputTokens?: number;
}): number | null {
  const { currentOverride, requestedMaxOutputTokens, modelMaxOutputTokens } =
    options;

  if (requestedMaxOutputTokens !== undefined) {
    return null;
  }

  const current = currentOverride;
  if (!modelMaxOutputTokens || modelMaxOutputTokens <= 0) {
    return null;
  }
  if (current === undefined) {
    return null;
  }
  if (modelMaxOutputTokens <= current) {
    return null;
  }
  return modelMaxOutputTokens;
}

export function buildMaxOutputTokensEscalationState(options: {
  state: QueryRuntimeState;
  nextMaxOutputTokens: number;
}): QueryRuntimeState {
  return createContinuationState(
    options.state,
    {
      messages: options.state.messages,
      maxOutputTokensOverride: options.nextMaxOutputTokens,
    },
    {
      reason: 'max_output_tokens_escalate',
      nextMaxOutputTokens: options.nextMaxOutputTokens,
    },
  );
}

export function buildPromptTooLongRecoveryState(options: {
  state: QueryRuntimeState;
  error: unknown;
}): QueryRuntimeState | null {
  const { state, error } = options;
  const currentCount = state.compressionState?.promptTooLongRetryCount ?? 0;
  if (currentCount >= MAX_PTL_RETRIES) {
    return null;
  }
  const truncated = truncateHeadForPtlRetry([...state.messages], error);
  if (!truncated) {
    return null;
  }

  const nextPendingUserMessage = truncated.at(-1);
  const pendingUserMessageUuid =
    nextPendingUserMessage?.type === 'user' &&
    nextPendingUserMessage.uuid === state.pendingUserMessageUuid
      ? nextPendingUserMessage.uuid
      : undefined;

  const nextAttempt = currentCount + 1;

  return createContinuationState(
    state,
    {
      messages: truncated,
      pendingUserMessageUuid,
      preProjectedMessages: undefined,
      preProjectedMessageCount: undefined,
      compressionState: {
        ...(state.compressionState ?? { promptTooLongRetryCount: 0 }),
        promptTooLongRetryCount: nextAttempt,
      },
    },
    {
      reason: 'prompt_too_long_recovery',
      attempt: nextAttempt,
    },
  );
}

/**
 * Build a QueryRuntimeState that replaces the current messages with the
 * reactively-compacted history, clears pre-projected caches, and marks
 * `hasAttemptedReactiveCompact` so the reactive path fires at most once
 * per query iteration.
 */
export function buildReactiveCompactRecoveryState(options: {
  state: QueryRuntimeState;
  newHistory: readonly Message[];
}): QueryRuntimeState {
  const { state, newHistory } = options;

  // Preserve the pending user message if it survived compaction.
  const pendingUuid = state.pendingUserMessageUuid;
  const preservedPending =
    pendingUuid !== undefined &&
    newHistory.some(
      (m) => m.type === 'user' && (m as { uuid?: string }).uuid === pendingUuid,
    )
      ? pendingUuid
      : undefined;

  return createContinuationState(
    state,
    {
      messages: [...newHistory],
      hasAttemptedReactiveCompact: true,
      pendingUserMessageUuid: preservedPending,
      // Clear pre-projected caches so the next iteration re-projects from
      // the freshly compacted history.
      preProjectedMessages: undefined,
      preProjectedMessageCount: undefined,
    },
    { reason: 'reactive_compact_retry' },
  );
}
