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
 * does. Callers fail closed in either case rather than guess between entries.
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

/**
 * Whether `record` is one the recorder stamped as a system-injected background
 * notification rather than user input.
 *
 * `createNotificationRecord` (chatRecordingService.ts) is the only producer of
 * `subtype: 'notification'` and it always pairs it with `provenance: 'system'`.
 * Both are required so a legacy or hand-written transcript cannot claim the
 * recovery trim on one half of the stamp, and so a real user prompt that
 * happens to LOOK like an envelope (its `provenance` is `'real_user'`) can
 * never be mistaken for one — which is exactly what shape alone cannot rule
 * out. `'cron'` is deliberately excluded: `recordCronPrompt` reuses the same
 * `provenance` but carries a user-authored prompt, and the shape predicate
 * this signal refines never trimmed those.
 */
function isSystemNotificationRecord(record: ChatRecord): boolean {
  return record.provenance === 'system' && record.subtype === 'notification';
}

export class SessionApiHistoryAccumulator {
  private history: Content[] = [];
  /**
   * Per-entry companion to {@link history}: `true` when the entry was appended
   * from a record the recorder stamped as a system-injected notification.
   *
   * Kept as a parallel array because the authoritative stamp lives on the
   * `ChatRecord` and cannot ride along on `Content` (that type comes from
   * `@google/genai`). Every mutation of `history` is mirrored here so the two
   * can never drift out of alignment.
   */
  private systemNotificationFlags: boolean[] = [];
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
          this.systemNotificationFlags.pop();
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
            return copy;
          })
        : [];
      // Compressed history is raw `Content[]` with no source record behind it,
      // so no entry can claim the authoritative notification stamp.
      this.systemNotificationFlags = this.history.map(() => false);
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
    const lengthBeforeAppend = this.history.length;
    appendApiHistoryRecord(this.history, record, this.completedToolCallIds);
    // A `mid_turn_user_message` merges into the previous entry instead of
    // pushing; only a real append gets a flag, so the two arrays stay aligned.
    if (this.history.length > lengthBeforeAppend) {
      this.systemNotificationFlags.push(isSystemNotificationRecord(record));
    }
    this.lastMaterialRecord = record;
  }

  getCompletedToolCallIds(): string[] {
    return [...this.completedToolCallIds];
  }

  finish(options: BuildApiHistoryOptions = {}): Content[] {
    return this.finishSession(options).apiHistory;
  }

  /**
   * The same projection as {@link finish}, plus how many TRAILING entries of
   * the returned history came from records the recorder stamped as
   * system-injected background notifications.
   *
   * This is the authoritative provenance signal that `Content` cannot carry
   * (its type comes from `@google/genai`). Session recovery uses it to tell a
   * real user prompt that happens to look like a `<task-notification>`
   * envelope from a cold notification record — the two are identical by shape,
   * and only the record's own stamp separates them. A trailing COUNT rather
   * than a full index set is all a consumer needs, because the only question
   * ever asked is how far back from the end the notification run reaches.
   *
   * The count is derived here, alongside the entries, so it survives
   * `stripThoughtsFromHistory` dropping entries: the flags are filtered in
   * lockstep with the history they describe.
   */
  finishSession(options: BuildApiHistoryOptions = {}): {
    apiHistory: Content[];
    trailingSystemNotifications: number;
  } {
    if (
      this.compressionCandidate !== undefined &&
      !Array.isArray(this.compressionCandidate)
    ) {
      return {
        apiHistory: (this.compressionCandidate as Content[]).map(
          copyContentForApiHistory,
        ),
        trailingSystemNotifications: 0,
      };
    }
    let apiHistory = this.history;
    let flags = this.systemNotificationFlags;
    if (options.stripThoughtsFromHistory) {
      const keptHistory: Content[] = [];
      const keptFlags: boolean[] = [];
      for (let i = 0; i < apiHistory.length; i++) {
        const stripped = stripThoughtsFromContent(apiHistory[i]!);
        if (stripped === null) continue;
        keptHistory.push(stripped);
        keptFlags.push(flags[i] === true);
      }
      apiHistory = keptHistory;
      flags = keptFlags;
    }
    let trailingSystemNotifications = 0;
    for (let i = flags.length - 1; i >= 0 && flags[i]; i--) {
      trailingSystemNotifications++;
    }
    return { apiHistory, trailingSystemNotifications };
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
): {
  apiHistory: Content[];
  completedToolCallIds?: string[];
  trailingSystemNotifications: number;
} {
  const accumulator = new SessionApiHistoryAccumulator();
  for (const record of conversation.messages) accumulator.add(record);
  const { apiHistory, trailingSystemNotifications } =
    accumulator.finishSession(options);
  const completedToolCallIds = accumulator
    .getCompletedToolCallIds()
    .filter((toolCallId) => hasUniqueToolResult(apiHistory, toolCallId));
  return {
    apiHistory,
    ...(completedToolCallIds.length > 0 ? { completedToolCallIds } : {}),
    // Always present, including as 0: unlike `completedToolCallIds`, zero is
    // not the absence of information. It is the recorder affirmatively saying
    // the tail is NOT a system notification, which is precisely what stops an
    // envelope-shaped real prompt from being trimmed. Omitting it would drop
    // the consumer back to shape-only guessing.
    trailingSystemNotifications,
  };
}
