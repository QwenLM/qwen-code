/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HistoryItem, HistoryItemUser } from '../types.js';
import type { Content } from '@google/genai';
import {
  createDebugLogger,
  getStartupContextLength,
} from '@qwen-code/qwen-code-core';
import { isSlashCommand } from './commandUtils.js';
import {
  getApiUserTextIndices,
  getCompressionTailStartIndex,
  hasCompressionSummaryPair,
} from '../../utils/api-history-utils.js';

const debugLogger = createDebugLogger('HISTORY_MAPPING');

/**
 * Returns true when the history item represents a real user prompt that was
 * sent to the model, as opposed to a slash-command invocation (`/help`,
 * `/stats`, ...) which is stored with `type: 'user'` in the UI but never
 * reaches the API history or `turnParentUuids`.
 *
 * Typed as a type predicate so callers can drop their `as HistoryItemUser`
 * casts - a regression that loosened either side of the narrowing would now
 * be caught by tsc instead of silently bypassing it.
 */
export function isRealUserTurn(
  item: HistoryItem,
): item is HistoryItem & HistoryItemUser {
  if (item.type !== 'user' || !item.text) return false;
  if (typeof item.sentToModel === 'boolean') return item.sentToModel;
  // Legacy resumed sessions do not have sentToModel, so this fallback is
  // intentionally coupled to isSlashCommand's current lexical classifier.
  // Changes to slash-command classification must account for old sessions that
  // still rely on this inference.
  return !isSlashCommand(item.text) && !item.text.startsWith('?');
}

function getUiTurnOrdinals(
  uiHistory: HistoryItem[],
  targetUserItemId: number,
): { targetOrdinal: number; totalRealUserTurns: number } {
  let targetOrdinal = -1;
  let totalRealUserTurns = 0;

  for (const item of uiHistory) {
    if (!isRealUserTurn(item)) continue;

    totalRealUserTurns++;
    if (item.id === targetUserItemId) {
      targetOrdinal = totalRealUserTurns;
    }
  }

  return { targetOrdinal, totalRealUserTurns };
}

/**
 * Computes the number of API Content[] entries to keep when rewinding
 * to a specific user turn in the UI history.
 *
 * The API history may include:
 * - A startup context entry or startup context pair at the beginning
 * - User text prompts (corresponding to UI user turns)
 * - Model responses (with optional functionCall parts)
 * - Tool result entries: user(functionResponse) + model(response)
 *
 * This function counts user text Content entries (skipping tool results
 * and the startup context) to find the API boundary corresponding
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
  const { targetOrdinal, totalRealUserTurns } = getUiTurnOrdinals(
    uiHistory,
    targetUserItemId,
  );

  if (targetOrdinal < 0) return -1;

  const startIndex = getStartupContextLength(apiHistory);

  if (hasCompressionSummaryPair(apiHistory, startIndex)) {
    // Compression replaces the oldest N UI turns with one synthetic
    // summary/attachment prelude. The remaining API user-text entries are
    // the uncompressed tail, so align that tail against the end of the UI
    // turn list instead of counting from the front.
    const apiTailUserIndices = getApiUserTextIndices(
      apiHistory,
      getCompressionTailStartIndex(apiHistory, startIndex),
      true,
    );
    const compressedTurnCount = Math.max(
      0,
      totalRealUserTurns - apiTailUserIndices.length,
    );

    if (targetOrdinal <= compressedTurnCount) {
      debugLogger.info(
        `Rewind target turn ${targetOrdinal} is unreachable: compressed ${compressedTurnCount} of ${totalRealUserTurns} total turns, tail has ${apiTailUserIndices.length} entries`,
      );
      return -1;
    }

    return apiTailUserIndices[targetOrdinal - compressedTurnCount - 1]!;
  }

  if (targetOrdinal === 1) {
    // Rewinding to the first user turn: keep only startup context (if any)
    return startIndex;
  }

  const apiUserTextIndices = getApiUserTextIndices(
    apiHistory,
    startIndex,
    false,
  );
  const targetApiIndex = apiUserTextIndices[targetOrdinal - 1];
  if (targetApiIndex !== undefined) return targetApiIndex;

  return -1;
}
