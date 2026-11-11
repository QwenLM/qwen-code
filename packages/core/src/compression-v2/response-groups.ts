/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getContentBlocks,
  type AssistantMessage,
  type Message,
} from './message-types.js';

export interface CompactionResponseSplit {
  /** Only these messages may be sent to the summary generator. */
  summaryHistory: Message[];
  /** The latest response group, including its results and subsequent input. */
  preservedMessages: Message[];
}

function isResponse(message: Message): message is AssistantMessage {
  return (
    message.type === 'assistant' &&
    !message.isVirtual &&
    !message.isApiErrorMessage
  );
}

function responseKey(message: AssistantMessage): string | undefined {
  if (message.responseGroupId) return `local:${message.responseGroupId}`;
  if (message.requestId) return `request:${message.requestId}`;
  if (message.message.id) return `provider:${message.message.id}`;
  return undefined;
}

/**
 * Split at the beginning of the latest model response, never at a tool result
 * or user-role boundary. A response may occupy several assistant block records.
 * Records without enough legacy identity are kept rather than guessed apart.
 */
export function splitForCompaction(
  history: readonly Message[],
): CompactionResponseSplit {
  const messages = history.filter((message) => message.type !== 'progress');
  let previousKey: string | undefined;
  let latestStart = 0;
  let hasSummaryResponse = false;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (!isResponse(message)) continue;
    const key = responseKey(message);
    if (key === undefined) {
      return { summaryHistory: [], preservedMessages: messages };
    }
    if (key !== previousKey) {
      hasSummaryResponse ||= previousKey !== undefined;
      latestStart = index;
      previousKey = key;
    }
  }

  if (!hasSummaryResponse) {
    return { summaryHistory: [], preservedMessages: messages };
  }
  return {
    summaryHistory: messages.slice(0, latestStart),
    preservedMessages: messages.slice(latestStart),
  };
}

/** Do not replay old orphan calls whose results were seen before compaction. */
export function canPreserveResponseGroup(
  messages: readonly Message[],
  seenFunctionResponseIds: ReadonlySet<string>,
): boolean {
  const results = new Set<string>();
  for (const message of messages) {
    if (message.type !== 'user') continue;
    for (const block of getContentBlocks(message)) {
      if (block.type === 'tool_result') results.add(block.tool_use_id);
    }
  }
  for (const message of messages) {
    if (message.type !== 'assistant') continue;
    for (const block of message.message.content) {
      if (
        block.type === 'tool_use' &&
        seenFunctionResponseIds.has(block.id) &&
        !results.has(block.id)
      )
        return false;
    }
  }
  return true;
}
