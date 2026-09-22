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
  getApiHistoryPromptId,
  getStartupContextLength,
  isApiUserPrompt,
} from '@qwen-code/qwen-code-core';
import { isSlashCommand } from './commandUtils.js';

/**
 * TUI rewind's binding of the shared user-prompt classifier. Deliberately
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
 * Thin binding of the shared classifier: TUI rewind excludes microcompaction
 * media-clear placeholders because a cleared media-only entry never produced
 * a visible user turn, so counting it would desynchronize the API prompt
 * count from the UI turn count and truncate one turn early. See
 * `ApiUserPromptOptions` in core for why that exclusion is an option rather
 * than part of the shared rule — ACP must keep those entries counted — and
 * for the exact-match collision it leaves behind, which remains an open
 * limitation pinned by the tests in this file's suite.
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
 * A turn whose API entry carries its stable identity resolves by that
 * identity; everything else keeps the positional mapping used before prompt
 * identities existed. That mapping counts user text Content entries (skipping
 * tool results and the startup context entry) to find the API boundary
 * corresponding to the target UI user turn.
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
 *   could not be located (e.g., it was absorbed by chat compression, or its
 *   identity is claimed by more than one turn on either side).
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

  // Marker-less auto-compaction: the API history carries a compressed prefix
  // but the UI has no summarizing compression boundary, so the first turn has
  // already been absorbed. Rewinding to it would silently truncate to
  // [prelude, summary, ack] and drop every real turn — fail loud instead.
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
    const identified = findApiHistoryPromptIndex(
      apiHistory,
      target.promptId,
      startIndex,
    );
    if (identified !== -1) return identified;
    // The resolver also refuses when TWO entries claim this identity, and
    // there the positional walk below would be guessing between them. An
    // entry that carries no mark at all is expected — only first-party user
    // prompts are marked, every other send stays positional — so fall
    // through to the mapping this function had before identities existed.
    const claimed = apiHistory.some(
      (content, index) =>
        index >= startIndex &&
        getApiHistoryPromptId(content) === target.promptId,
    );
    if (claimed) return -1;
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

  // Not enough user prompts after the startup context (e.g. after
  // compression): the target turn is unreachable.
  return -1;
}
