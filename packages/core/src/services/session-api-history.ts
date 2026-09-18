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

const API_HISTORY_PROMPT_ID = Symbol('apiHistoryPromptId');

type IdentifiedContent = Content & {
  [API_HISTORY_PROMPT_ID]?: string;
};

export function markApiHistoryPrompt(
  content: Content,
  promptId: unknown,
): void {
  if (typeof promptId === 'string' && promptId.length > 0) {
    (content as IdentifiedContent)[API_HISTORY_PROMPT_ID] = promptId;
  }
}

export function getApiHistoryPromptId(content: Content): string | undefined {
  return (content as IdentifiedContent)[API_HISTORY_PROMPT_ID];
}

/**
 * Locates the single API history entry at or after `startIndex` marked with
 * `promptId`.
 *
 * Returns -1 when no entry carries the identity **and** when more than one
 * does. Identities are minted per entrance (`sessionId########<n>`) and their
 * counters restart independently, so a duplicate is possible; callers treat
 * both cases the same way — the identity does not resolve, so fall back to
 * whatever mapping was used before identities existed rather than guess
 * between two candidates.
 *
 * Entries before `startIndex` are excluded from the scan entirely. Rewind
 * callers pass the startup-context/compressed-prefix length there: marks
 * inside the compressed prefix belong to absorbed turns (restored from the
 * compression record's `promptIds`), and resolving one would truncate at the
 * prefix, silently dropping the summary and every real turn.
 */
export function findApiHistoryPromptIndex(
  history: readonly Content[],
  promptId: string,
  startIndex = 0,
): number {
  let match = -1;
  for (let index = startIndex; index < history.length; index++) {
    if (getApiHistoryPromptId(history[index]!) !== promptId) continue;
    if (match !== -1) return -1;
    match = index;
  }
  return match;
}

const API_HISTORY_NOTIFICATION = Symbol('apiHistoryNotification');

type NotificationMarkedContent = Content & {
  [API_HISTORY_NOTIFICATION]?: true;
};

/**
 * Marks a user-role API history entry as the model-facing half of a
 * background-notification-style turn (a drained background-agent notification,
 * a cron fire, a teammate envelope). The UI renders those turns as
 * `notification` items, never as user turns, so the TUI rewind census must
 * pair them against notification items rather than user turns. The rendered
 * text cannot carry that fact: a cron fire submits the raw job prompt with no
 * `<task-notification>` envelope, so provenance has to ride the entry itself
 * (R40-3). The submit path records the subtype on the `ChatRecord`; this mark
 * is its in-memory projection, so it survives nothing the record does not —
 * resume re-attaches it from the record's subtype.
 */
export function markApiHistoryNotification(content: Content): void {
  (content as NotificationMarkedContent)[API_HISTORY_NOTIFICATION] = true;
}

export function isApiHistoryNotification(content: Content): boolean {
  return (
    (content as NotificationMarkedContent)[API_HISTORY_NOTIFICATION] === true
  );
}

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
  if (record.type === 'user' && !record.subtype) {
    markApiHistoryPrompt(message, record.promptId);
  }
  if (record.subtype === 'notification' || record.subtype === 'cron') {
    markApiHistoryNotification(message);
  }

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
        ? payload.compressedHistory.map((content, index) => {
            const copy = copyContentForApiHistory(content);
            markApiHistoryPrompt(copy, payload.promptIds?.[index]);
            if (payload.notificationMarks?.[index]) {
              markApiHistoryNotification(copy);
            }
            return copy;
          })
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
