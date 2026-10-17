/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HistoryItem, HistoryItemUser } from '../types.js';
import type { Content } from '@google/genai';
import type { ApiUserPromptOptions } from '@qwen-code/qwen-code-core';
import { CompressionStatus } from '@qwen-code/qwen-code-core/core/turn.js';
import { findApiHistoryPromptIndex } from '@qwen-code/qwen-code-core/services/session-api-history.js';
import { getStartupContextLength } from '@qwen-code/qwen-code-core/core/environmentContext.js';
import { isApiUserPrompt } from '@qwen-code/qwen-code-core/services/api-user-prompt.js';
import { isSlashCommand } from './commandUtils.js';

/**
 * The dormant OpenTUI mapper's binding of the user-prompt classifier. Deliberately
 * module-private: `isUserTextContent` below is the only door to this rule, and
 * the OpenTUI parity path reaches it by importing that function. Exporting the
 * options would let a caller compose `isApiUserPrompt(x, …)` directly and
 * re-create the per-surface twin this consolidation removes.
 */
const TUI_API_USER_PROMPT_OPTIONS: ApiUserPromptOptions = {
  excludeClearedMediaPlaceholders: true,
};

/**
 * Returns true when the history item represents a real user prompt that was
 * sent to the model, as opposed to a slash-command invocation (`/help`,
 * `/stats`, …) which is stored with `type: 'user'` in the UI but never
 * reaches the API history or `turnParentUuids`.
 *
 * Typed as a type predicate so callers can drop their `as HistoryItemUser`
 * casts — a regression that loosened either side of the narrowing would now
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

/**
 * Checks if a Content entry is a user-initiated text prompt
 * as opposed to a tool result (functionResponse).
 *
 * Kept for the dormant OpenTUI positional mapper. Live Ink and ACP rewind
 * resolve identities instead; content shape is not a turn identity.
 */
export function isUserTextContent(content: Content): boolean {
  return isApiUserPrompt(content, TUI_API_USER_PROMPT_OPTIONS);
}

/**
 * Finds the last successful *summarizing* compression marker. Fast
 * (rule-based) compression markers are excluded: `/compress-fast` removes no
 * user prompts from the API history and inserts no summary prefix, so its
 * marker is not a truncation boundary — treating it as one collapses the
 * rewind anchor and silently drops the pre-marker history.
 */
function findLastSuccessfulCompressionIndex(history: HistoryItem[]): number {
  return history.findLastIndex(
    (item) =>
      item.type === 'compression' &&
      item.compression.compressionStatus === CompressionStatus.COMPRESSED &&
      item.compression.compressionKind !== 'fast',
  );
}

/**
 * Computes the number of API Content[] entries to keep when rewinding
 * to a specific user turn in the UI history.
 *
 * Identified turns require exactly one matching entry in the retained region
 * of each history; a missing or ambiguous identity returns -1. Legacy turns
 * require a shared source-record link rather than positional mapping.
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
 *   could not be located, or its identity is missing or ambiguous.
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

  const retainedStart = compressionIndex === -1 ? 0 : compressionIndex + 1;

  const startIndex = getStartupContextLength(apiHistory, {
    includeCompressed: true,
  });

  const target = uiHistory[targetIndex]!;
  if (isRealUserTurn(target)) {
    const rewindId = target.promptId ?? target.rewindId;
    if (!rewindId) return -1;
    // Only the retained region is resolvable: a twin above the compression
    // boundary is already unmappable, and refusing the turn that *can* be
    // resolved uniquely would widen the refusal past the ambiguous pair.
    if (
      uiHistory.some(
        (item, index) =>
          index !== targetIndex &&
          index >= retainedStart &&
          isRealUserTurn(item) &&
          (item.promptId ?? item.rewindId) === rewindId,
      )
    ) {
      return -1;
    }
    return findApiHistoryPromptIndex(apiHistory, rewindId, startIndex);
  }
  return -1;
}

/**
 * Whether the target is retained, so a refusal means its model association
 * could not be resolved rather than that compression absorbed it.
 */
export function isRetainedUserTurn(
  uiHistory: HistoryItem[],
  targetUserItemId: number,
): boolean {
  const targetIndex = uiHistory.findIndex(
    (item) => item.id === targetUserItemId,
  );
  if (targetIndex === -1) return false;
  const target = uiHistory[targetIndex]!;
  if (!isRealUserTurn(target)) return false;
  return targetIndex > findLastSuccessfulCompressionIndex(uiHistory);
}
