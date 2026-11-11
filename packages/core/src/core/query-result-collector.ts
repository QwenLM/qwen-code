/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared helper for collecting results from a query() async generator.
 *
 * Used by both runForkedAgent() and runSubagent() to avoid duplicating
 * the event-collection loop.
 */

import type { Message } from '../protocol/transcript/message.js';
import type { NonNullableUsage } from '../protocol/schemas/common.js';
import type { QueryEvent, Terminal } from './query-event.js';

export interface QueryCollectorResult {
  /** All durable messages (assistant + user) yielded during the query loop. */
  messages: Message[];
  /** Accumulated token usage across all API calls. */
  totalUsage: NonNullableUsage;
  /** Concatenated text content from all assistant responses. */
  textContent: string;
  /** Terminal info from the generator return value. */
  terminal: Terminal;
}

/**
 * Drains a query() async generator, collecting messages, text content,
 * and the terminal usage/reason.
 *
 * @param generator - The async generator returned by query().
 * @param onEvent - Optional callback invoked for each yielded QueryEvent.
 */
export async function collectQueryResults(
  generator: AsyncGenerator<QueryEvent, Terminal>,
  onEvent?: (event: QueryEvent) => void,
  onMessage?: (message: Message) => Promise<void> | void,
  mapMessage?: (message: Message) => Message,
): Promise<QueryCollectorResult> {
  const messages: Message[] = [];
  const textParts: string[] = [];
  let currentRequestTextStart = 0;

  let iterResult: IteratorResult<QueryEvent, Terminal> | undefined;
  try {
    iterResult = await generator.next();
    while (!iterResult.done) {
      const event: QueryEvent = iterResult.value;
      onEvent?.(event);

      if (event.type === 'request_start') {
        currentRequestTextStart = textParts.length;
      } else if (event.type === 'result_text_reset') {
        textParts.length = currentRequestTextStart;
      }

      if (
        event.type === 'assistant' ||
        event.type === 'user' ||
        event.type === 'system'
      ) {
        const message = mapMessage
          ? mapMessage(event as Message)
          : (event as Message);
        // Only user/assistant count as primary conversation turns. system
        // messages (e.g. compact_boundary) flow through onMessage so callers
        // can persist them to the sidechain, but don't belong in the
        // returned `messages` array used for text/usage accounting.
        if (event.type === 'assistant' || event.type === 'user') {
          messages.push(message);
        }
        await onMessage?.(message);

        if (event.type === 'assistant') {
          const assistantMessage = message as Extract<
            Message,
            { type: 'assistant' }
          >;
          for (const block of assistantMessage.message.content) {
            // Guard against malformed content (e.g., null entries from upstream)
            if (block != null && block.type === 'text') {
              textParts.push(block.text);
            }
          }
        }
      }

      iterResult = await generator.next();
    }
  } finally {
    if (!iterResult?.done) {
      // Preserve the callback/iteration error if cleanup also fails.
      try {
        await generator.return(undefined as never);
      } catch {
        // The original failure remains authoritative.
      }
    }
  }

  const terminal: Terminal = iterResult.value;

  return {
    messages,
    totalUsage: terminal.usage,
    textContent: textParts.join(''),
    terminal,
  };
}
