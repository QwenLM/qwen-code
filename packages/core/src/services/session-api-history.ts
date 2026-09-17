/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import type {
  ChatCompressionRecordPayload,
  ChatRecord,
  GoalTurnEndRecordPayload,
  SlashCommandRecordPayload,
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

function appendApiHistoryRecord(
  history: Content[],
  record: ChatRecord,
  completedToolCallIds: ReadonlySet<string>,
): void {
  if (!record.message || record.subtype === 'realtime_message') return;

  const message = copyContentForApiHistory(record.message);
  if (record.subtype === 'mid_turn_user_message') {
    const previous = history.at(-1);
    if (
      previous?.role === 'user' &&
      !previous.parts?.some(
        (part) =>
          part.functionResponse?.id !== undefined &&
          completedToolCallIds.has(part.functionResponse.id),
      )
    ) {
      previous.parts = [...(previous.parts ?? []), ...(message.parts ?? [])];
      return;
    }
  }

  history.push(message);
}

function hasUniqueToolResult(history: Content[], toolCallId: unknown): boolean {
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) return false;
  let calls = 0;
  let results = 0;
  for (const content of history) {
    for (const part of content.parts ?? []) {
      if (part.functionCall?.id === toolCallId) calls += 1;
      if (part.functionResponse?.id === toolCallId) results += 1;
    }
  }
  return calls === 1 && results === 1;
}

export class SessionApiHistoryAccumulator {
  private history: Content[] = [];
  private compressionCandidate: unknown;
  private completedToolCallIds = new Set<string>();
  private lastMaterialRecord?: ChatRecord;

  add(record: ChatRecord): void {
    if (record.type === 'system') {
      if (record.subtype === 'slash_command') {
        const payload = record.systemPayload as
          | SlashCommandRecordPayload
          | undefined;
        const previous = this.lastMaterialRecord;
        const parts = previous?.message?.parts;
        // ACP records local command input as user and its output as a system
        // result. Neither belongs in model history. TUI invocations fence off
        // earlier input, including custom commands submitted to the model.
        if (
          payload?.phase === 'result' &&
          payload.sentToModel !== true &&
          Array.isArray(payload.outputHistoryItems) &&
          payload.outputHistoryItems.length > 0 &&
          payload.outputHistoryItems.every(
            (item) => item?.['type'] === 'assistant',
          ) &&
          previous?.type === 'user' &&
          previous.subtype === undefined &&
          previous.message?.role === 'user' &&
          parts?.length === 1 &&
          typeof parts[0].text === 'string' &&
          Object.keys(parts[0]).length === 1 &&
          parts[0].text === payload.rawCommand
        ) {
          this.history.pop();
        }
        if (previous?.type === 'user') this.lastMaterialRecord = undefined;
        return;
      }
      if (record.subtype === 'goal_turn_end') {
        const payload = record.systemPayload as
          | GoalTurnEndRecordPayload
          | undefined;
        const previous = this.lastMaterialRecord;
        const permit = record.goalContext;
        if (
          previous?.type === 'tool_result' &&
          typeof permit?.goalId === 'string' &&
          permit.goalId.length > 0 &&
          typeof permit.turnId === 'string' &&
          permit.turnId.length > 0 &&
          Number.isInteger(permit.revision) &&
          previous.goalContext?.goalId === permit.goalId &&
          previous.goalContext.revision === permit.revision &&
          previous.goalContext.turnId === permit.turnId &&
          previous.message?.parts?.some(
            (part) => part.functionResponse?.id === payload?.toolCallId,
          ) &&
          hasUniqueToolResult(this.history, payload?.toolCallId)
        ) {
          this.completedToolCallIds.add(payload!.toolCallId);
        }
        return;
      }
      if (!isApiHistoryCompressionCandidate(record)) return;
      const payload = record.systemPayload as ChatCompressionRecordPayload;
      this.compressionCandidate = payload.compressedHistory;
      this.history = Array.isArray(payload.compressedHistory)
        ? payload.compressedHistory.map(copyContentForApiHistory)
        : [];
      this.completedToolCallIds = new Set(
        Array.isArray(payload.completedToolCallIds)
          ? payload.completedToolCallIds.filter((toolCallId) =>
              hasUniqueToolResult(this.history, toolCallId),
            )
          : [],
      );
      this.lastMaterialRecord = undefined;
      return;
    }

    if (
      this.compressionCandidate !== undefined &&
      !Array.isArray(this.compressionCandidate)
    ) {
      return;
    }
    if (!record.message || record.subtype === 'realtime_message') return;
    for (const part of record.message.parts ?? []) {
      if (part.functionCall?.id) {
        this.completedToolCallIds.delete(part.functionCall.id);
      }
      if (part.functionResponse?.id) {
        this.completedToolCallIds.delete(part.functionResponse.id);
      }
    }
    appendApiHistoryRecord(this.history, record, this.completedToolCallIds);
    this.lastMaterialRecord = record;
  }

  getCompletedToolCallIds(): string[] {
    return [...this.completedToolCallIds];
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
  return buildSessionHistoryFromConversation(conversation, options).apiHistory;
}

export function buildSessionHistoryFromConversation(
  conversation: { messages: readonly ChatRecord[] },
  options: BuildApiHistoryOptions = {},
): { apiHistory: Content[]; completedToolCallIds?: string[] } {
  const accumulator = new SessionApiHistoryAccumulator();
  for (const record of conversation.messages) accumulator.add(record);
  const apiHistory = accumulator.finish(options);
  const completedToolCallIds = accumulator
    .getCompletedToolCallIds()
    .filter((toolCallId) => hasUniqueToolResult(apiHistory, toolCallId));
  return {
    apiHistory,
    ...(completedToolCallIds.length > 0 ? { completedToolCallIds } : {}),
  };
}
