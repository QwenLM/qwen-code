/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import type {
  ChatCompressionRecordPayload,
  ChatRecord,
} from './chatRecordingService.js';

export interface BuildApiHistoryOptions {
  /**
   * Whether to strip thought parts from the history.
   * Thought parts are content parts that have `thought: true`.
   * Keeping thoughts ensures `reasoning_content` from reasoning models
   * (e.g. DeepSeek) is properly passed back in subsequent API calls.
   * @default false
   */
  stripThoughtsFromHistory?: boolean;
}

function stripThoughtsFromContent(content: Content): Content | null {
  if (!content.parts) return content;

  const filteredParts = content.parts.filter((part) => !(part as Part).thought);
  if (filteredParts.length === 0) return null;
  return { ...content, parts: filteredParts };
}

function copyContentForApiHistory(content: Content): Content {
  return {
    ...content,
    parts: content.parts?.map((part) => {
      if ('functionCall' in part && part.functionCall) {
        return {
          ...part,
          functionCall: {
            ...part.functionCall,
            args: part.functionCall.args
              ? { ...part.functionCall.args }
              : part.functionCall.args,
          },
        };
      }
      if ('functionResponse' in part && part.functionResponse) {
        return {
          ...part,
          functionResponse: { ...part.functionResponse },
        };
      }
      return { ...part };
    }),
  };
}

function appendApiHistoryRecord(history: Content[], record: ChatRecord): void {
  if (!record.message || record.subtype === 'realtime_message') return;

  const message = copyContentForApiHistory(record.message);
  if (record.subtype === 'mid_turn_user_message') {
    const previous = history.at(-1);
    if (previous?.role === 'user') {
      previous.parts = [...(previous.parts ?? []), ...(message.parts ?? [])];
      return;
    }
  }

  history.push(message);
}

export class SessionApiHistoryAccumulator {
  private history: Content[] = [];
  private compressionCandidate: unknown;

  add(record: ChatRecord): void {
    if (record.type === 'system') {
      if (!isApiHistoryCompressionCandidate(record)) return;
      const payload = record.systemPayload as ChatCompressionRecordPayload;
      this.compressionCandidate = payload.compressedHistory;
      this.history = Array.isArray(payload.compressedHistory)
        ? payload.compressedHistory.map(copyContentForApiHistory)
        : [];
      return;
    }

    if (
      this.compressionCandidate !== undefined &&
      !Array.isArray(this.compressionCandidate)
    ) {
      return;
    }
    appendApiHistoryRecord(this.history, record);
  }

  finish(options: BuildApiHistoryOptions = {}): Content[] {
    if (
      this.compressionCandidate !== undefined &&
      !Array.isArray(this.compressionCandidate)
    ) {
      return (this.compressionCandidate as Content[]).map(
        copyContentForApiHistory,
      );
    }
    if (!options.stripThoughtsFromHistory) return this.history;
    return this.history
      .map(stripThoughtsFromContent)
      .filter((content): content is Content => content !== null);
  }
}

export function isApiHistoryCompressionCandidate(record: ChatRecord): boolean {
  if (record.type !== 'system' || record.subtype !== 'chat_compression') {
    return false;
  }
  const payload = record.systemPayload as
    | ChatCompressionRecordPayload
    | undefined;
  return Boolean(payload?.compressedHistory);
}

export function buildApiHistoryFromConversation(
  conversation: { messages: readonly ChatRecord[] },
  options: BuildApiHistoryOptions = {},
): Content[] {
  const accumulator = new SessionApiHistoryAccumulator();
  for (const record of conversation.messages) accumulator.add(record);
  return accumulator.finish(options);
}
