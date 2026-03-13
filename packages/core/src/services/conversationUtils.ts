/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import type {
  ChatCompressionRecordPayload,
  UiTelemetryRecordPayload,
} from './chatRecordingService.js';
import { uiTelemetryService } from '../telemetry/uiTelemetry.js';
import type { ConversationRecord } from './sessionService.js';

/**
 * Options for building API history from conversation.
 */
export interface BuildApiHistoryOptions {
  /**
   * Whether to strip thought parts from the history.
   * Thought parts are content parts that have `thought: true`.
   * @default true
   */
  stripThoughtsFromHistory?: boolean;
}

/**
 * Strips thought parts from a Content object.
 * Thought parts are identified by having `thought: true`.
 * Returns null if the content only contained thought parts.
 */
function stripThoughtsFromContent(content: Content): Content | null {
  if (!content.parts) return content;

  const filteredParts = content.parts.filter((part) => !(part as Part).thought);

  // If all parts were thoughts, remove the entire content
  if (filteredParts.length === 0) {
    return null;
  }

  return {
    ...content,
    parts: filteredParts,
  };
}

/**
 * Builds the model-facing chat history (Content[]) from a reconstructed
 * conversation. This keeps UI history intact while applying chat compression
 * checkpoints for the API history used on resume.
 *
 * Strategy:
 * - Find the latest system/chat_compression record (if any).
 * - Use its compressedHistory snapshot as the base history.
 * - Append all messages after that checkpoint (skipping system records).
 * - If no checkpoint exists, return the linear message list (message field only).
 */
export function buildApiHistoryFromConversation(
  conversation: ConversationRecord,
  options: BuildApiHistoryOptions = {},
): Content[] {
  const { stripThoughtsFromHistory = true } = options;
  const { messages } = conversation;

  let lastCompressionIndex = -1;
  let compressedHistory: Content[] | undefined;

  messages.forEach((record, index) => {
    if (record.type === 'system' && record.subtype === 'chat_compression') {
      const payload = record.systemPayload as
        | ChatCompressionRecordPayload
        | undefined;
      if (payload?.compressedHistory) {
        lastCompressionIndex = index;
        compressedHistory = payload.compressedHistory;
      }
    }
  });

  if (compressedHistory && lastCompressionIndex >= 0) {
    const baseHistory: Content[] = structuredClone(compressedHistory);

    // Append everything after the compression record (newer turns)
    for (let i = lastCompressionIndex + 1; i < messages.length; i++) {
      const record = messages[i];
      if (record.type === 'system') continue;
      if (record.message) {
        baseHistory.push(structuredClone(record.message as Content));
      }
    }

    if (stripThoughtsFromHistory) {
      return baseHistory
        .map(stripThoughtsFromContent)
        .filter((content): content is Content => content !== null);
    }
    return baseHistory;
  }

  // Fallback: return linear messages as Content[]
  const result = messages
    .map((record) => record.message)
    .filter((message): message is Content => message !== undefined)
    .map((message) => structuredClone(message));

  if (stripThoughtsFromHistory) {
    return result
      .map(stripThoughtsFromContent)
      .filter((content): content is Content => content !== null);
  }
  return result;
}

/**
 * Replays stored UI telemetry events to rebuild metrics when resuming a session.
 * Also restores the last prompt token count from the best available source.
 */
export function replayUiTelemetryFromConversation(
  conversation: ConversationRecord,
): void {
  uiTelemetryService.reset();

  for (const record of conversation.messages) {
    if (record.type !== 'system' || record.subtype !== 'ui_telemetry') {
      continue;
    }
    const payload = record.systemPayload as
      | UiTelemetryRecordPayload
      | undefined;
    const uiEvent = payload?.uiEvent;
    if (uiEvent) {
      uiTelemetryService.addEvent(uiEvent);
    }
  }

  const resumePromptTokens = getResumePromptTokenCount(conversation);
  if (resumePromptTokens !== undefined) {
    uiTelemetryService.setLastPromptTokenCount(resumePromptTokens);
  }
}

/**
 * Returns the best available prompt token count for resuming telemetry:
 * - If a chat compression checkpoint exists, use its new token count.
 * - Otherwise, use the last assistant usageMetadata input (fallback to total).
 */
export function getResumePromptTokenCount(
  conversation: ConversationRecord,
): number | undefined {
  let fallback: number | undefined;

  for (let i = conversation.messages.length - 1; i >= 0; i--) {
    const record = conversation.messages[i];
    if (record.type === 'system' && record.subtype === 'chat_compression') {
      const payload = record.systemPayload as
        | ChatCompressionRecordPayload
        | undefined;
      if (payload?.info) {
        return payload.info.newTokenCount;
      }
    }

    if (fallback === undefined && record.type === 'assistant') {
      const usage = record.usageMetadata;
      if (usage) {
        fallback = usage.totalTokenCount ?? usage.promptTokenCount;
      }
    }
  }

  return fallback;
}
