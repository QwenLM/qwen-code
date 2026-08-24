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
import { splitMessageContentForImages } from '../../utils/imageSupport.js';

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
 * Anti-merge marker the shared transcript reducer honors: `canMergeTextDelta`
 * refuses to fold a chunk carrying it into the active block. Cached history
 * rows are discrete messages, but `readJsonlMessages` reconstructs runs of
 * consecutive same-role rows per turn (Tool Result / telemetry / Plan rows);
 * seeded as bare chunks they would merge into one plain-concatenated block,
 * unlike live replays where each row arrives stamped.
 */
const CACHED_ROW_META = { qwenDiscreteMessage: true } as const;

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
  const text =
    message.role === 'user'
      ? splitMessageContentForImages(message.content).text
      : message.content;
  if (text.trim().length === 0) {
    return null;
  }
  const content = { type: 'text' as const, text };
  switch (message.role) {
    case 'user':
      return {
        sessionId,
        update: {
          sessionUpdate: 'user_message_chunk',
          content,
          _meta: CACHED_ROW_META,
        },
      };
    case 'assistant':
      return {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content,
          _meta: CACHED_ROW_META,
        },
      };
    case 'thinking':
      return {
        sessionId,
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content,
          _meta: CACHED_ROW_META,
        },
      };
    default:
      return null;
  }
}
