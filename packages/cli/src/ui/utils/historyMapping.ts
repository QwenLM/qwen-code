/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HistoryItem, HistoryItemUser } from '../types.js';
import type { Content } from '@google/genai';
import type { ApiUserPromptOptions } from '@qwen-code/qwen-code-core';
import {
  CompressionStatus,
  findApiHistoryPromptIndex,
  getStartupContextLength,
  isApiUserPrompt,
} from '@qwen-code/qwen-code-core';
import { isSlashCommand } from './commandUtils.js';

/** TUI rewind excludes cleared media-only placeholders from legacy counts. */
const TUI_API_USER_PROMPT_OPTIONS: ApiUserPromptOptions = {
  excludeClearedMediaPlaceholders: true,
};

/**
 * Returns true when the history item represents a user prompt sent to the
 * model, rather than a slash command handled only by the UI.
 */
export function isRealUserTurn(
  item: HistoryItem,
): item is HistoryItem & HistoryItemUser {
  if (item.type !== 'user' || !item.text) return false;
  if (typeof item.sentToModel === 'boolean') return item.sentToModel;
  // Legacy resumed sessions do not have sentToModel metadata.
  return !isSlashCommand(item.text) && !item.text.startsWith('?');
}

/** Returns true for user text prompts, excluding tool results. */
export function isUserTextContent(content: Content): boolean {
  return isApiUserPrompt(content, TUI_API_USER_PROMPT_OPTIONS);
}

/** Finds the last successful summarizing compression marker. */
function findLastSuccessfulCompressionIndex(history: HistoryItem[]): number {
  return history.findLastIndex(
    (item) =>
      item.type === 'compression' &&
      item.compression.compressionStatus === CompressionStatus.COMPRESSED &&
      item.compression.compressionKind !== 'fast',
  );
}

/**
 * Computes the number of API history entries to keep when rewinding to a UI
 * user turn. Identified turns resolve only by their stable identity; legacy
 * turns retain the positional mapping used before prompt identities existed.
 */
export function computeApiTruncationIndex(
  uiHistory: HistoryItem[],
  targetUserItemId: number,
  apiHistory: Content[],
): number {
  const targetIndex = uiHistory.findIndex(
    (item) => item.id === targetUserItemId,
  );
  if (targetIndex === -1) return -1;

  const compressionIndex = findLastSuccessfulCompressionIndex(uiHistory);
  if (compressionIndex !== -1 && targetIndex <= compressionIndex) return -1;

  // Count visible user turns before the target for legacy positional mapping.
  let uiUserTurnCount = 0;
  for (
    let index = compressionIndex === -1 ? 0 : compressionIndex + 1;
    index < targetIndex;
    index++
  ) {
    if (isRealUserTurn(uiHistory[index]!)) uiUserTurnCount++;
  }

  const startIndex = getStartupContextLength(apiHistory, {
    includeCompressed: true,
  });

  // Marker-less auto-compaction has already absorbed the first turn.
  if (
    uiUserTurnCount === 0 &&
    compressionIndex === -1 &&
    startIndex > getStartupContextLength(apiHistory)
  ) {
    return -1;
  }

  const target = uiHistory[targetIndex]!;
  if (
    isRealUserTurn(target) &&
    target.promptId &&
    !target.promptIdFileKeyOnly
  ) {
    if (
      uiHistory.some(
        (item, index) =>
          index !== targetIndex &&
          isRealUserTurn(item) &&
          !item.promptIdFileKeyOnly &&
          item.promptId === target.promptId,
      )
    ) {
      return -1;
    }
    return findApiHistoryPromptIndex(apiHistory, target.promptId, startIndex);
  }

  if (uiUserTurnCount === 0) return startIndex;

  let realUserPromptCount = 0;
  for (let index = startIndex; index < apiHistory.length; index++) {
    if (isUserTextContent(apiHistory[index]!)) {
      realUserPromptCount++;
      // Truncate immediately before the target prompt.
      if (realUserPromptCount > uiUserTurnCount) return index;
    }
  }

  return -1;
}
