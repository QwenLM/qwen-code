/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fork context preparation utilities.
 *
 * Builds API-ready MessageParam[] from runtime Message[] for use with
 * `runForkedAgent({ forkContextMessages })`. Self-contained — depends only
 * on protocol/transcript, not on compression-v2 internals.
 *
 * Used by:
 *   - compression-v2/fork-compact.ts   (context compaction)
 *   - services/autoMemoryExtractionService.ts (memory extraction)
 */

import type { Message } from '../protocol/transcript/message.js';
import { normalizeMessagesForAPI } from '../protocol/index.js';
import type { ModelStreamMessage } from '../provider/modelStreamRequest.js';
import type { NormalizeMessagesForAPIOptions } from '../protocol/provider/request-converter.js';
import { buildStartupMemoryPrefix } from '../prompts/context-injection.js';

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

const FORK_PLACEHOLDER_TEXT = 'Fork started — processing in background';

/**
 * Collect tool_use IDs from the trailing assistant turn that do not already
 * have a matching tool_result in the projected history.
 *
 * Runtime assistant responses are stored one content block per Message, while
 * normalizeMessagesForAPI() merges adjacent assistant fragments back into the
 * original turn. Inspecting the projected messages therefore preserves every
 * parallel tool call and avoids adding placeholders for completed calls.
 */
function getTrailingUnpairedToolUseIds(
  messages: readonly ModelStreamMessage[],
): string[] {
  const assistantIndex = messages.findLastIndex(
    (message) => message.role === 'assistant',
  );
  // Narrowing the indexed element (not the findLastIndex predicate) is what
  // lets us read the assistant `content` union below.
  const assistantMessage =
    assistantIndex < 0 ? undefined : messages[assistantIndex];
  if (assistantMessage?.role !== 'assistant') {
    return [];
  }

  const toolUseIds = (assistantMessage.toolCalls ?? []).map((call) => call.id);
  if (toolUseIds.length === 0) {
    return [];
  }

  const completedToolUseIds = new Set<string>();
  for (const message of messages.slice(assistantIndex + 1)) {
    if (message.role === 'tool') completedToolUseIds.add(message.toolCallId);
  }

  return toolUseIds.filter((id) => !completedToolUseIds.has(id));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Builds API-ready fork context messages from runtime Message[].
 *
 * Steps:
 *   1. Prepend startup memory context at the runtime Message[] layer
 *   2. Project to MessageParam[] via normalizeMessagesForAPI()
 *   3. Handle unpaired tool_use blocks with placeholder tool_results
 *      The startup memory user message (agentsMd / autoMemory / currentDate)
 *      is byte-aligned with the per-request prepend the main loop applies via
 *      buildRequestMessages.
 *
 * The output matches the parent's actual API prefix so the fork can hit
 * the prompt cache. Reminder attachments (`agent_listing_delta`,
 * `mcp_instructions_delta`, plan-mode events, …) are intentionally
 * preserved — historically we stripped them from the compaction
 * summarizer to avoid duplicate reminders in the post-compact history,
 * but the model handles `<system-reminder>` metadata correctly and the
 * cache hit is worth more than the marginal duplication. Nothing is
 * stripped by default.
 *
 * @param messages              Parent runtime history.
 * @param startupMemoryContext  Result of `createStartupMemoryContext(config)`.
 *   Passing the raw `MemoryContextManager.getUserContext()` record instead omits
 *   SDK memory and can diverge from the parent request's prefix. When omitted or
 *   empty the prepend is skipped — useful for callers without a Config.
 */
export function buildForkContextMessages(
  messages: readonly Message[],
  startupMemoryContext?: Readonly<Record<string, string>>,
  projectionOptions: NormalizeMessagesForAPIOptions = {},
): ModelStreamMessage[] {
  return buildForkContextMessagesFromPrefix(
    messages,
    buildStartupMemoryPrefix(startupMemoryContext),
    projectionOptions,
  );
}

/**
 * Builds an API-ready fork context from the exact ephemeral prefix used by the
 * parent request plus the history selected by the fork caller.
 *
 * Prefix and history are normalized together because adjacent user messages
 * must merge exactly as they did in the parent provider request.
 */
export function buildForkContextMessagesFromPrefix(
  messages: readonly Message[],
  requestPrefixMessages?: readonly Message[],
  projectionOptions: NormalizeMessagesForAPIOptions = {},
): ModelStreamMessage[] {
  const projected = normalizeMessagesForAPI([
    ...(requestPrefixMessages ?? []),
    ...messages,
  ], projectionOptions);

  return completeForkContextMessages(projected);
}

/**
 * Makes an already projected cache-safe request prefix valid as a standalone
 * fork request. A snapshot may be captured immediately after the parent model
 * emitted Agent tool_use blocks, before their tool_results have been appended
 * to the live history. Add successful placeholders for only those trailing
 * unpaired calls so the fork preserves the exact cached prefix without sending
 * an invalid tool protocol sequence.
 */
export function completeForkContextMessages(
  messages: readonly ModelStreamMessage[],
): ModelStreamMessage[] {
  const completed = [...messages];
  const toolUseIds = getTrailingUnpairedToolUseIds(completed);

  if (toolUseIds.length > 0) {
    const insertIndex = completed.findLastIndex((message) =>
      message.role === 'assistant' || message.role === 'tool',
    ) + 1;
    completed.splice(insertIndex, 0, ...toolUseIds.map((id): ModelStreamMessage => ({
      role: 'tool', toolCallId: id,
      content: [{ type: 'text', text: FORK_PLACEHOLDER_TEXT }],
      isError: false,
    })));
  }

  return completed;
}
