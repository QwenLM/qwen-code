/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createUserMessage } from '../protocol/transcript/conversions.js';
import type { UserMessage } from '../protocol/transcript/message.js';
import type { HookAfterResult } from './hook-coordinator-types.js';
import {
  createContinuationState,
  type QueryRuntimeState,
  type QueryTransition,
} from './query-runtime-state.js';

export interface HookContinuationResolution {
  terminalReason?: 'stopped';
  continuationMessage?: UserMessage;
  nextState?: QueryRuntimeState;
}

function buildContinuationMessage(options: {
  text: string;
  promptId: string;
  permissionMode?: string;
}): UserMessage {
  const message = createUserMessage(options.text, {
    // Hook continuations drive the model but are not human input: isMeta keeps
    // them out of the TUI history, rewind candidates, and title/suggestion
    // pickers while normalizeMessagesForAPI still sends them to the model.
    isMeta: true,
    origin: { kind: 'human' },
    permissionMode: options.permissionMode,
  });
  message.promptId = options.promptId;
  return message;
}

export function resolveHookAfterResult(options: {
  afterResult: HookAfterResult | null;
  state: QueryRuntimeState;
  promptId: string;
  permissionMode?: string;
}): HookContinuationResolution {
  const { afterResult, state, promptId, permissionMode } = options;
  if (!afterResult) {
    return {};
  }

  if (afterResult.stopped) {
    return {
      terminalReason: 'stopped',
    };
  }

  if (!afterResult.inject) {
    return {};
  }

  const stopHookActive =
    afterResult.retryAsStopHook === true || afterResult.blocked === true;
  const continuationMessage = buildContinuationMessage({
    text: afterResult.inject,
    promptId,
    permissionMode,
  });

  const transition: QueryTransition = stopHookActive
    ? { reason: 'stop_hook_blocking' }
    : { reason: 'after_hook_continuation' };
  // TODO: Replace runtime-only clearContext handling with a session-owner
  // protocol that starts a new session instead of mutating durable history.
  const history = afterResult.clearContext ? [] : state.messages;

  return {
    continuationMessage,
    nextState: createContinuationState(
      state,
      {
        messages: [...history, continuationMessage],
        pendingUserMessageUuid: continuationMessage.uuid,
        preProjectedMessages: afterResult.clearContext
          ? undefined
          : state.preProjectedMessages,
        preProjectedMessageCount: afterResult.clearContext
          ? undefined
          : state.preProjectedMessageCount,
        stopHookActive,
      },
      transition,
    ),
  };
}
