/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Message } from './message-types.js';
import { estimateBlocksTokenCount, getContentBlocks } from './message-types.js';
import { createUserMessage } from '../protocol/transcript/conversions.js';
import { runLogger } from '../utils/runLogger.js';
import type { Config } from '../config/config.js';

import { isRecord } from '../protocol/provider/qoder-api-error.js';
import {
  observationMonotonicNow,
  observationElapsedMs,
} from '../model-request/observation.js';

export const MAX_PTL_RETRIES = 3;
export const PTL_RETRY_MARKER =
  '[earlier conversation truncated for compaction retry]';

/**
 * Group messages by API round.  A new group starts when an `assistant` message
 * appears with a different `message.id` from the previous assistant — i.e. a
 * genuinely new API response, not a continuation of the same streaming turn.
 *
 * The sole boundary gate is the assistant response id.  Streaming chunks from
 * the same API response share an id, so boundaries only fire at the start of a
 * new round.
 */
export function groupMessagesByApiRound(
  messages: readonly Message[],
): Message[][] {
  if (messages.length === 0) {
    return [];
  }

  const groups: Message[][] = [];
  let current: Message[] = [];
  let lastAssistantId: string | undefined;

  for (const msg of messages) {
    if (msg.type === 'assistant') {
      if (msg.message.id !== lastAssistantId && current.length > 0) {
        groups.push(current);
        current = [msg];
      } else {
        current.push(msg);
      }
      lastAssistantId = msg.message.id;
    } else {
      current.push(msg);
    }
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}

/**
 * Try to extract a token gap from a model API error message.
 * The provider may report errors like:
 *   "Request payload size exceeds the limit: 1048576 bytes"
 *   "Please reduce your prompt; it contains N tokens which exceeds the limit M"
 *   "Input tokens exceed the configured limit of M tokens. Your messages resulted in N tokens."
 * Returns the gap in tokens, or null if unparseable.
 */
export function parseTokenGapFromError(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error ?? '');

  const parseGap = (
    match: RegExpMatchArray | null,
    usedIndex: number,
    limitIndex: number,
  ): number | null => {
    const usedText = match?.[usedIndex];
    const limitText = match?.[limitIndex];
    if (!usedText || !limitText) return null;

    const used = parseInt(usedText.replace(/,/g, ''), 10);
    const limit = parseInt(limitText.replace(/,/g, ''), 10);
    if (!isNaN(used) && !isNaN(limit) && used > limit) {
      return used - limit;
    }
    return null;
  };

  // Used count first: "N tokens ... limit M" or "N tokens > maximum M".
  const usedFirstGap = parseGap(
    message.match(
      /(\d[\d,]*)\s*tokens?\b[\s\S]*?(?:limit(?:\s+(?:of|is))?|maximum|>)\s*[:=]?\s*(\d[\d,]*)/i,
    ),
    1,
    2,
  );
  if (usedFirstGap !== null) return usedFirstGap;

  // Limit count first: "limit of M tokens ... resulted in N tokens".
  const limitFirstGap = parseGap(
    message.match(
      /(?:configured\s+)?limit(?:\s+(?:of|is))?\s*[:=]?\s*(\d[\d,]*)\s*tokens?\b[\s\S]*?(?:result(?:ed)?\s+in|contains?|used)\s*(\d[\d,]*)\s*tokens?\b/i,
    ),
    2,
    1,
  );
  if (limitFirstGap !== null) return limitFirstGap;

  return null;
}

const PROMPT_TOO_LONG_MESSAGE_FRAGMENTS = [
  'too many tokens',
  'exceeds the limit',
  'token limit',
  'prompt is too long',
  'prompt exceeds max length',
  'input is too long',
  'exceed the configured limit',
  'context_length_exceeded',
  'maximum context length',
  'request payload size exceeds',
  'content too large',
  'range of input length should be',
] as const;

const MEDIA_TOO_LARGE_MESSAGE_FRAGMENTS = [
  'media_too_large',
  'request_too_large',
  'image_block',
  'document_block',
  'media_budget',
  'too much media',
  'image(s) exceed api size limit',
  'image was too large',
  'request too large (',
  'pdf too large',
  'too many images',
  'too many documents',
] as const;

const STRUCTURED_PROVIDER_ERROR_KEYS = [
  'message',
  'details',
  'body',
  'error',
  'cause',
] as const;

function isPromptTooLongMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    PROMPT_TOO_LONG_MESSAGE_FRAGMENTS.some((fragment) =>
      lower.includes(fragment),
    ) ||
    (lower.includes('invalid_argument') && lower.includes('token'))
  );
}

function isMediaTooLargeMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return MEDIA_TOO_LARGE_MESSAGE_FRAGMENTS.some((fragment) =>
    lower.includes(fragment),
  );
}

function parseJsonValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

export function hasStructuredMediaTooLargeDetails(error: unknown): boolean {
  const queue: unknown[] = [error];
  const seenObjects = new Set<object>();
  const seenStrings = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (typeof current === 'string') {
      if (seenStrings.has(current)) continue;
      seenStrings.add(current);
      if (isMediaTooLargeMessage(current)) return true;
      const parsed = parseJsonValue(current);
      if (parsed !== undefined) queue.push(parsed);
      continue;
    }
    if (!isRecord(current) || seenObjects.has(current)) continue;
    seenObjects.add(current);

    if (current['cause'] !== undefined) queue.push(current['cause']);
    for (const key of STRUCTURED_PROVIDER_ERROR_KEYS) {
      if (current[key] !== undefined) queue.push(current[key]);
    }
  }

  return false;
}

/**
 * Determine whether an error is a prompt-too-long / context-window error.
 * These typically come as INVALID_ARGUMENT (400) with messages about token
 * limits, RESOURCE_EXHAUSTED for very large payloads, or HTTP 413.
 */
export function isPromptTooLongError(error: unknown): boolean {
  // HTTP 413 (Content Too Large) is a definitive signal from the API that the
  // request payload exceeded the allowed size — treat it as prompt-too-long.
  if (
    error != null &&
    typeof error === 'object' &&
    'status' in error &&
    (error as { status: unknown }).status === 413
  ) {
    return true;
  }

  // Provider 已按 wire 错误码判定过超长，错误文本里可能只有业务码没有关键词。
  if (
    error != null &&
    typeof error === 'object' &&
    'kind' in error &&
    (error as { kind: unknown }).kind === 'prompt_too_long'
  ) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error ?? '');
  return isPromptTooLongMessage(message);
}

function estimateGroupTokens(group: readonly Message[]): number {
  return estimateBlocksTokenCount(
    group.flatMap((msg) => getContentBlocks(msg)),
  );
}

/**
 * Truncate the oldest API-round groups to reduce the prompt size.
 * Returns the truncated message array, or null if truncation is not possible.
 */
export function truncateHeadForPtlRetry(
  messages: Message[],
  error: unknown,
): Message[] | null {
  // Strip any previous retry marker
  if (
    messages.length > 0 &&
    messages[0]?.type === 'user' &&
    messages[0]?.isMeta
  ) {
    const blocks = getContentBlocks(messages[0]);
    if (blocks[0]?.type === 'text' && blocks[0]?.text === PTL_RETRY_MARKER) {
      messages = messages.slice(1);
    }
  }

  const groups = groupMessagesByApiRound(messages);
  if (groups.length < 2) {
    return null; // Can't drop if only one group
  }

  // Calculate how many groups to drop
  const tokenGap = parseTokenGapFromError(error);
  let dropCount: number;

  if (tokenGap !== null) {
    // Drop groups until we cover the gap
    let accumulated = 0;
    dropCount = 0;
    for (const group of groups) {
      accumulated += estimateGroupTokens(group);
      dropCount++;
      if (accumulated >= tokenGap) break;
    }
  } else {
    // Fallback: drop 20% of groups
    dropCount = Math.max(1, Math.floor(groups.length * 0.2));
  }

  // Never drop all groups
  dropCount = Math.min(dropCount, groups.length - 1);
  if (dropCount < 1) {
    return null;
  }

  const remaining = groups.slice(dropCount).flat();

  // If the first remaining message is an assistant message, prepend a synthetic
  // user message to satisfy API's role-alternation requirement.
  if (remaining.length > 0 && remaining[0]?.type === 'assistant') {
    remaining.unshift(
      createUserMessage([{ type: 'text' as const, text: PTL_RETRY_MARKER }], {
        isMeta: true,
      }),
    );
  }

  return remaining;
}

/**
 * Wrap an LLM call with prompt-too-long retry logic.
 *
 * If the call fails with a PTL error, truncate the oldest API-round groups
 * from the message history and retry, up to MAX_PTL_RETRIES times.
 *
 * @param generateFn  Function that takes messages and returns a response string.
 * @param messages    The initial message history to send.
 * @returns           The LLM response text.
 * @throws            The original error if retries are exhausted or truncation fails.
 */
export interface PtlRetryOptions {
  config?: Config;
  beforeTokenCount?: number;
  /** Observer failures must never change truncation or retry decisions. */
  onRecovery?: (observation: PtlRecoveryObservation) => void;
}

export interface PtlRecoveryObservation {
  error: unknown;
  outcome: 'ready' | 'stopped';
  stopReason?: 'non_ptl' | 'retry_exhausted' | 'cannot_truncate';
  attempt: number;
  beforeMessages: number;
  remainingMessages: number;
  droppedMessages: number;
  actionDurationMs?: number;
}

function observePtlRecovery(
  observer: PtlRetryOptions['onRecovery'],
  observation: () => PtlRecoveryObservation,
): void {
  try {
    const result = observer?.(observation()) as unknown;
    if (result instanceof Promise) void result.catch(() => {});
  } catch {
    // Passive observers must not alter the request or its error.
  }
}

export async function withPtlRetry(
  generateFn: (messages: Message[]) => Promise<string>,
  messages: Message[],
  options?: PtlRetryOptions,
): Promise<string> {
  let currentMessages = messages;
  let ptlAttempts = 0;
  let onRecovery: PtlRetryOptions['onRecovery'];
  try {
    onRecovery = options?.onRecovery;
  } catch {
    // Optional observer access cannot change retry behavior.
  }

  for (;;) {
    try {
      return await generateFn(currentMessages);
    } catch (error) {
      const recoveryStartedAt = onRecovery
        ? observationMonotonicNow()
        : undefined;
      const observe = (
        outcome: PtlRecoveryObservation['outcome'],
        stopReason?: PtlRecoveryObservation['stopReason'],
        remainingMessages = currentMessages.length,
      ) =>
        observePtlRecovery(onRecovery, () => ({
          error,
          outcome,
          stopReason,
          attempt: ptlAttempts,
          beforeMessages: currentMessages.length,
          remainingMessages,
          droppedMessages: currentMessages.length - remainingMessages,
          actionDurationMs: observationElapsedMs(recoveryStartedAt),
        }));
      if (!isPromptTooLongError(error)) {
        observe('stopped', 'non_ptl');
        throw error;
      }

      ptlAttempts++;
      if (ptlAttempts > MAX_PTL_RETRIES) {
        observe('stopped', 'retry_exhausted');
        runLogger.debug(
          `[CompressionV2] PTL retry exhausted after ${ptlAttempts} attempts`,
        );
        throw error;
      }

      const truncated = truncateHeadForPtlRetry(currentMessages, error);
      if (!truncated) {
        observe('stopped', 'cannot_truncate');
        runLogger.debug('[CompressionV2] PTL retry: cannot truncate further');
        throw error;
      }

      runLogger.debug(
        `[CompressionV2] PTL retry attempt ${ptlAttempts}: ` +
          `${currentMessages.length} → ${truncated.length} messages`,
      );
      observe('ready', undefined, truncated.length);
      currentMessages = truncated;
    }
  }
}
