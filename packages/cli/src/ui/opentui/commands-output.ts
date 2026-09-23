/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command output parity for the OpenTUI renderer (PR1 slice 5).
 *
 * Mirrors the output side of the ink `useSlashCommandProcessor`:
 *  - `addMessage` (slashCommandProcessor.ts) — converts an internal
 *    `Message` into the history item shape the UI renders
 *  - the slash-command chat-recording helpers (`SLASH_COMMANDS_SKIP_RECORDING`
 *    and `serializeHistoryItemForRecording`)
 *
 * Everything here is renderer-neutral: the outputs are the original ink
 * `HistoryItemWithoutId` shapes, which the OpenTUI backend projects into its
 * neutral history model the same way the transcript adapter does.
 */

import {
  MessageType,
  type HistoryItemWithoutId,
  type Message,
} from '../types.js';

/**
 * Parity of `addMessage` in ui/hooks/slashCommandProcessor.ts: the exact
 * Message → HistoryItemWithoutId conversion the ink UI applies.
 */
export function messageToHistoryItem(
  message: Message,
  now: Date = message.timestamp,
): HistoryItemWithoutId {
  if (message.type === MessageType.ABOUT) {
    return {
      type: 'about',
      systemInfo: message.systemInfo,
    };
  }
  if (message.type === MessageType.HELP) {
    return {
      type: 'help',
      timestamp: now,
    };
  }
  if (message.type === MessageType.STATS) {
    return {
      type: 'stats',
      duration: message.duration,
    };
  }
  if (message.type === MessageType.MODEL_STATS) {
    return {
      type: 'model_stats',
    };
  }
  if (message.type === MessageType.TOOL_STATS) {
    return {
      type: 'tool_stats',
    };
  }
  if (message.type === MessageType.SKILL_STATS) {
    return {
      type: 'skill_stats',
    };
  }
  if (message.type === MessageType.QUIT) {
    return {
      type: 'quit',
      duration: message.duration,
    };
  }
  if (message.type === MessageType.COMPRESSION) {
    return {
      type: 'compression',
      compression: message.compression,
    };
  }
  if (message.type === MessageType.SUMMARY) {
    return {
      type: 'summary',
      summary: message.summary,
    };
  }
  if (message.type === MessageType.INSIGHT_PROGRESS) {
    return {
      type: 'insight_progress',
      progress: message.progress,
    };
  }
  return {
    type: message.type,
    text: message.content,
  };
}

/** Convenience builder for the INFO/WARNING/ERROR messages commands return. */
export function commandMessageItem(
  messageType: 'info' | 'warning' | 'error' | 'success',
  content: string,
): HistoryItemWithoutId {
  return { type: messageType, text: content };
}

/**
 * Re-export of the canonical `SLASH_COMMANDS_SKIP_RECORDING` set
 * (ui/utils/commandUtils.ts) — primary command names that are never written
 * to the chat recording service. Importing the original keeps both
 * renderers recording the same commands.
 */
export { SLASH_COMMANDS_SKIP_RECORDING } from '../utils/commandUtils.js';

/**
 * Parity of `serializeHistoryItemForRecording` in
 * ui/hooks/slashCommandProcessor.ts: Date timestamps become ISO strings so
 * the recorded items are JSON-serializable.
 */
export function serializeHistoryItemForRecording(
  item: HistoryItemWithoutId,
): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...item };
  if ('timestamp' in clone && clone['timestamp'] instanceof Date) {
    clone['timestamp'] = clone['timestamp'].toISOString();
  }
  return clone;
}
