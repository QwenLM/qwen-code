/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { QueryEvent } from '../core/query-event.js';
import type { Message } from '../protocol/transcript/message.js';

export interface SubagentMessageContext {
  sessionId: string;
  parentToolUseId?: string;
}

/**
 * Stamp subagent-emitted messages with the root session ID and the parent
 * Agent tool_use_id so transcript persistence, resume, and SDK projection all
 * preserve the parent-child relationship.
 */
export function attachSubagentMessageContext(
  message: Message,
  context: SubagentMessageContext,
): Message {
  const { sessionId, parentToolUseId } = context;

  if (message.type === 'assistant') {
    return {
      ...message,
      sessionId,
      session_id: sessionId,
      parent_tool_use_id: parentToolUseId ?? null,
    };
  }

  if (message.type === 'user') {
    return {
      ...message,
      sessionId,
      parent_tool_use_id: parentToolUseId ?? null,
    };
  }

  return {
    ...message,
    sessionId,
  };
}

export function attachSubagentQueryEventContext(
  event: QueryEvent,
  context: SubagentMessageContext,
): QueryEvent {
  if (
    event.type === 'assistant' ||
    event.type === 'user' ||
    event.type === 'system'
  ) {
    return attachSubagentMessageContext(event, context);
  }

  if (event.type === 'stream_event') {
    return {
      ...event,
      session_id: context.sessionId,
      parent_tool_use_id: context.parentToolUseId ?? null,
    };
  }

  return event;
}
