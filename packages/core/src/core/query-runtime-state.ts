/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelStreamMessage } from '../provider/modelStreamRequest.js';
import type { Message, UserMessage } from '../protocol/transcript/message.js';
import {
  createAutoCompactTrackingState,
  type AutoCompactTrackingState,
} from '../compression-v2/types.js';

export type QueryTransition =
  | { reason: 'next_turn' }
  | { reason: 'after_hook_continuation' }
  | { reason: 'stop_hook_blocking' }
  | { reason: 'max_output_tokens_escalate'; nextMaxOutputTokens: number }
  | { reason: 'max_output_tokens_recovery'; attempt: number }
  | { reason: 'prompt_too_long_recovery'; attempt: number }
  | { reason: 'reactive_compact_retry' }
  | { reason: 'token_budget_continuation' }
  | { reason: 'goal_auto_continuation' }
  | { reason: 'malformed_tool_use_retry' };

export interface QueryRuntimeState {
  messages: Message[];
  turnCount: number;
  transition?: QueryTransition;
  stopHookActive: boolean;
  maxOutputTokensRecoveryCount: number;
  malformedToolUseRetryCount: 0 | 1;
  maxOutputTokensOverride?: number;
  hasAttemptedReactiveCompact: boolean;
  pendingToolUseSummary?: Promise<null>;
  pendingUserMessageUuid?: string;
  preProjectedMessages?: readonly ModelStreamMessage[];
  preProjectedMessageCount?: number;
  compressionState?: {
    promptTooLongRetryCount: number;
  };
  /** Auto-compact retry budget for this user query only. */
  autoCompactTracking: AutoCompactTrackingState;
}

export function createInitialQueryRuntimeState(options: {
  history: readonly Message[] | undefined;
  userMessage: UserMessage;
  messagesAfterUser?: readonly Message[];
  maxOutputTokensOverride?: number;
  preProjectedMessages?: readonly ModelStreamMessage[];
  preProjectedMessageCount?: number;
  stopHookActive?: boolean;
}): QueryRuntimeState {
  const {
    history,
    userMessage,
    messagesAfterUser,
    maxOutputTokensOverride,
    preProjectedMessages,
    preProjectedMessageCount,
  } = options;

  return {
    messages: [...(history ?? []), userMessage, ...(messagesAfterUser ?? [])],
    turnCount: 0,
    stopHookActive: options.stopHookActive ?? false,
    maxOutputTokensRecoveryCount: 0,
    malformedToolUseRetryCount: 0,
    maxOutputTokensOverride,
    hasAttemptedReactiveCompact: false,
    pendingToolUseSummary: undefined,
    pendingUserMessageUuid: userMessage.uuid,
    preProjectedMessages,
    preProjectedMessageCount,
    compressionState: {
      promptTooLongRetryCount: 0,
    },
    autoCompactTracking: createAutoCompactTrackingState(),
  };
}

export function createHistoryOnlyRuntimeState(options: {
  history: readonly Message[] | undefined;
  maxOutputTokensOverride?: number;
  preProjectedMessages?: readonly ModelStreamMessage[];
  preProjectedMessageCount?: number;
  stopHookActive?: boolean;
}): QueryRuntimeState {
  const {
    history,
    maxOutputTokensOverride,
    preProjectedMessages,
    preProjectedMessageCount,
  } = options;

  return {
    messages: [...(history ?? [])],
    turnCount: 0,
    stopHookActive: options.stopHookActive ?? false,
    maxOutputTokensRecoveryCount: 0,
    malformedToolUseRetryCount: 0,
    maxOutputTokensOverride,
    hasAttemptedReactiveCompact: false,
    pendingToolUseSummary: undefined,
    pendingUserMessageUuid: undefined,
    preProjectedMessages,
    preProjectedMessageCount,
    compressionState: {
      promptTooLongRetryCount: 0,
    },
    autoCompactTracking: createAutoCompactTrackingState(),
  };
}

export function getPendingUserMessage(
  state: QueryRuntimeState,
): UserMessage | undefined {
  return getPendingTurnMessages(state)?.[0];
}

/**
 * Returns the unsent user turn as one ordered bundle.
 *
 * Input attachments are inserted immediately after the current user message,
 * so the pending user is not necessarily the final runtime message. Treating
 * the entire suffix as one bundle keeps the user and its attachments outside
 * compaction and lets callers restore them in their original order.
 */
export function getPendingTurnMessages(
  state: QueryRuntimeState,
): readonly [UserMessage, ...Message[]] | undefined {
  if (!state.pendingUserMessageUuid) {
    return undefined;
  }

  // The pending turn is always the runtime-history suffix: the current user
  // message followed only by its input attachments. Scan back from the end so
  // this stays cheap on long histories instead of scanning from the front on
  // every request.
  let userIndex = state.messages.length - 1;
  while (userIndex >= 0 && state.messages[userIndex]?.type === 'attachment') {
    userIndex--;
  }

  const pendingUser = state.messages[userIndex];
  if (
    pendingUser?.type !== 'user' ||
    pendingUser.uuid !== state.pendingUserMessageUuid
  ) {
    return undefined;
  }

  return [pendingUser, ...state.messages.slice(userIndex + 1)];
}

export function getRequestBaseHistory(
  state: QueryRuntimeState,
  pendingRequestMessages: readonly Message[] = [],
): readonly Message[] {
  const pendingTurn = getPendingTurnMessages(state);
  const history = pendingTurn
    ? state.messages.slice(0, state.messages.length - pendingTurn.length)
    : state.messages;
  if (pendingRequestMessages.length === 0) return history;
  const pendingIds = new Set(
    pendingRequestMessages.map((message) => message.uuid),
  );
  return history.filter((message) => !pendingIds.has(message.uuid));
}

export function createContinuationState(
  state: QueryRuntimeState,
  patch: Partial<QueryRuntimeState> & Pick<QueryRuntimeState, 'messages'>,
  transition: QueryTransition,
): QueryRuntimeState {
  return {
    ...state,
    ...patch,
    transition,
  };
}
