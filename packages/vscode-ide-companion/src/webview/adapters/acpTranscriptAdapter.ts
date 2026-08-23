/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Thin adapter that bridges ACP session/update notifications into the shared
 * SDK daemon transcript reducer. The ACP `SessionNotification` payload is
 * structurally identical to the daemon `session_update` envelope, so no
 * per-field projection is needed: wrap the notification once, then let
 * `normalizeDaemonEvent` + `reduceDaemonTranscriptEvents` do the work.
 */
import type { SessionNotification } from '@agentclientprotocol/sdk';
import {
  normalizeDaemonEvent,
  reduceDaemonTranscriptEvents,
} from '@qwen-code/sdk/daemon';
import type { DaemonEvent, DaemonTranscriptState } from '@qwen-code/sdk/daemon';

/** Reduce one ACP notification into the transcript state. */
export function reduceSessionNotification(
  state: DaemonTranscriptState,
  notification: SessionNotification,
): DaemonTranscriptState {
  const event: DaemonEvent = {
    v: 1,
    type: 'session_update',
    data: notification,
  };
  return reduceDaemonTranscriptEvents(state, normalizeDaemonEvent(event));
}

/** Minimal shape of cached history rows (ChatMessage) delivered offline. */
export interface CachedTranscriptMessage {
  role?: string;
  content?: string;
}

/**
 * Convert one cached ChatMessage-shaped history row into the ACP
 * session/update notification the shared reducer already understands.
 * Returns `null` for rows without renderable text so offline restores and
 * load-failure fallbacks render the same timeline as live replays.
 */
export function cachedMessageToNotification(
  message: CachedTranscriptMessage,
  sessionId: string,
): SessionNotification | null {
  if (
    typeof message?.content !== 'string' ||
    message.content.trim().length === 0
  ) {
    return null;
  }
  const content = { type: 'text' as const, text: message.content };
  switch (message.role) {
    case 'user':
      return {
        sessionId,
        update: { sessionUpdate: 'user_message_chunk', content },
      };
    case 'assistant':
      return {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content },
      };
    case 'thinking':
      return {
        sessionId,
        update: { sessionUpdate: 'agent_thought_chunk', content },
      };
    default:
      return null;
  }
}
