/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HistoryItem } from '../types.js';
import type { Content } from '@google/genai';
import { isSlashCommand } from './commandUtils.js';

/**
 * Returns true when the history item represents a real user prompt that was
 * sent to the model, as opposed to a slash-command invocation (`/help`,
 * `/stats`, …) which is stored with `type: 'user'` in the UI but never
 * reaches the API history or `turnParentUuids`.
 */
export function isRealUserTurn(item: HistoryItem): boolean {
  if (item.type !== 'user' || !item.text) return false;
  return !isSlashCommand(item.text) && !item.text.startsWith('?');
}

/**
 * The well-known startup context model acknowledgment.
 * Used to identify the startup context pair in the API history.
 */
const STARTUP_CONTEXT_MODEL_ACK = 'Got it. Thanks for the context!';

/**
 * Checks if a Content entry is a user-initiated text prompt
 * as opposed to a tool result (functionResponse).
 */
function isUserTextContent(content: Content): boolean {
  if (content.role !== 'user') return false;
  if (!content.parts || content.parts.length === 0) return false;

  const hasFunctionResponse = content.parts.some(
    (part) => 'functionResponse' in part,
  );
  if (hasFunctionResponse) return false;

  return content.parts.some((part) => 'text' in part && part.text);
}

/**
 * Detects whether the API history starts with the startup context pair
 * (user env context + model acknowledgment).
 */
function hasStartupContext(apiHistory: Content[]): boolean {
  if (apiHistory.length < 2) return false;
  const first = apiHistory[0];
  const second = apiHistory[1];
  if (first?.role !== 'user' || second?.role !== 'model') return false;
  return (
    second.parts?.some(
      (part) => 'text' in part && part.text === STARTUP_CONTEXT_MODEL_ACK,
    ) ?? false
  );
}

/**
 * Computes the number of API Content[] entries to keep when rewinding
 * to a specific user turn in the UI history.
 *
 * The API history may include:
 * - A startup context pair: [user(env), model(ack)] at the beginning
 * - User text prompts (corresponding to UI user turns)
 * - Model responses (with optional functionCall parts)
 * - Tool result entries: user(functionResponse) + model(response)
 *
 * This function counts user text Content entries (skipping tool results
 * and the startup context pair) to find the API boundary corresponding
 * to the target UI user turn.
 *
 * Note: In IDE mode, additional user Content entries may be injected for
 * IDE context. This function does not account for those and will produce
 * incorrect results. Rewind is therefore disabled in IDE mode (guarded
 * in openRewindSelector).
 *
 * @param uiHistory The full UI history array
 * @param targetUserItemId The ID of the user HistoryItem to rewind to
 * @param apiHistory The current API Content[] array
 * @returns The number of Content entries to keep, or -1 if the target turn
 *   could not be located (e.g., it was absorbed by chat compression).
 */
export function computeApiTruncationIndex(
  uiHistory: HistoryItem[],
  targetUserItemId: number,
  apiHistory: Content[],
): number {
  // Count how many UI user turns exist before the target
  let uiUserTurnCount = 0;
  for (const item of uiHistory) {
    if (item.id === targetUserItemId) {
      break;
    }
    if (isRealUserTurn(item)) {
      uiUserTurnCount++;
    }
  }

  // Determine the starting index in the API history (skip startup context)
  const startIndex = hasStartupContext(apiHistory) ? 2 : 0;

  if (uiUserTurnCount === 0) {
    // Rewinding to the first user turn: keep only startup context (if any)
    return startIndex;
  }

  // Walk the API history from after the startup context, counting
  // user text prompts to find the one corresponding to the target turn.
  let realUserPromptCount = 0;

  for (let i = startIndex; i < apiHistory.length; i++) {
    if (isUserTextContent(apiHistory[i]!)) {
      realUserPromptCount++;
      // The target turn is the (uiUserTurnCount + 1)th real user prompt.
      // We want to truncate right before it.
      if (realUserPromptCount > uiUserTurnCount) {
        return i;
      }
    }
  }

  // If we didn't find enough user prompts (e.g., after compression),
  // signal that the target turn is unreachable.
  return -1;
}
