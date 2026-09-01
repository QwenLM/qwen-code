/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HistoryItem, HistoryItemUser } from '../types.js';
import type { Content } from '@google/genai';
import {
  CompressionStatus,
  findApiHistoryPromptIndex,
  getApiHistoryPromptId,
  getStartupContextLength,
  isClearedMediaPlaceholder,
  isSystemReminderContent,
} from '@qwen-code/qwen-code-core';
import { isSlashCommand } from './commandUtils.js';

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
 */
function isUserTextContent(content: Content): boolean {
  if (content.role !== 'user') return false;
  if (!content.parts || content.parts.length === 0) return false;

  const hasFunctionResponse = content.parts.some(
    (part) => 'functionResponse' in part,
  );
  if (hasFunctionResponse) return false;

  // Exclude pure <system-reminder> entries (the startup prelude and the
  // mid-history MCP added-tool reminders). They are structural, not real user
  // prompts; counting them here would shift the rewind truncation index and
  // silently drop a real turn's context. A genuine user turn that merely has
  // a per-turn reminder prepended still has a non-reminder prompt part, so it
  // is NOT excluded.
  if (isSystemReminderContent(content)) return false;

  // Exclude microcompaction media-clear placeholders. `/compress-fast`'s
  // microcompaction replaces the top-level inlineData/fileData parts of
  // user entries with text placeholders. A media-only user entry never
  // produced a UI user turn, but once cleared it carries a text part;
  // counting it here desynchronizes the API prompt count from the UI turn
  // count and makes the walk below truncate one turn early, silently
  // dropping a turn the UI still shows. Match the FULL generated
  // placeholder shape, not just its prefix: microcompaction never rewrites
  // text parts, so a user prompt that merely begins with the prefix (e.g.
  // a pasted placeholder) is genuine and must keep counting. An entry that
  // mixes placeholders with real prompt text still counts (it IS a real
  // turn).
  //
  // Known limitation (exact-match collision): a genuine prompt whose ENTIRE
  // text equals a generated placeholder shape is indistinguishable from a
  // cleared media-only entry once serialized — both carry the identical
  // text. Such a prompt is excluded here, leaving the API prompt count one
  // behind the UI turn count. Every rewind target AFTER the colliding turn
  // then returns -1 and AppContainer surfaces a loud "Cannot rewind to a
  // turn that was compressed" abort. Rewinding TO the colliding turn itself
  // depends on position: as the first post-compression turn it works via
  // the uiUserTurnCount === 0 shortcut; mid-history the walk lands on the
  // next counted prompt and truncates one turn LATE, so the colliding
  // turn's prompt+response stays in model context while the UI removes the
  // turn (under-deletion of context, not loss of context the UI keeps).
  // Disambiguating any of this durably needs a structural sentinel on
  // cleared parts, which changes the persisted API history shape and is out
  // of scope for this fix; see the pinned tests in historyMapping.test.ts.
  //
  // The ACP session's private `#isUserTextContent`
  // (packages/cli/src/acp-integration/session/Session.ts) deliberately
  // keeps the bare text-presence check (`'text' in part && part.text`),
  // which counts these placeholders: ACP rewind maps against per-prompt
  // file-history snapshots, which ARE created for media-only prompts, so
  // cleared placeholders must stay counted there. Do not mirror this
  // exclusion into that twin.
  return content.parts.some(
    (part) =>
      'text' in part && !!part.text && !isClearedMediaPlaceholder(part.text),
  );
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
 * The API history may include:
 * - A startup context entry at the beginning
 * - User text prompts (corresponding to UI user turns)
 * - Model responses (with optional functionCall parts)
 * - Tool result entries: user(functionResponse) + model(response)
 *
 * This function counts user text Content entries (skipping tool results
 * and the startup context entry) to find the API boundary corresponding
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
  const targetIndex = uiHistory.findIndex(
    (item) => item.id === targetUserItemId,
  );
  if (targetIndex === -1) return -1;

  const compressionIndex = findLastSuccessfulCompressionIndex(uiHistory);
  if (compressionIndex !== -1 && targetIndex <= compressionIndex) return -1;

  const target = uiHistory[targetIndex]!;
  let allowRestoredPositionalFallback = false;
  if (isRealUserTurn(target) && target.promptId) {
    const identifiedIndex = findApiHistoryPromptIndex(
      apiHistory,
      target.promptId,
    );
    if (identifiedIndex !== -1) return identifiedIndex;

    let hasMarks = false;
    let targetIdOccurrences = 0;
    for (const entry of apiHistory) {
      const entryId = getApiHistoryPromptId(entry);
      if (entryId === undefined) continue;
      hasMarks = true;
      if (entryId === target.promptId) targetIdOccurrences++;
    }

    if (hasMarks) {
      // The target's identity is present but the lookup still failed: it is
      // duplicated, and the positional walk must never guess between two
      // entries marked with the same identity. Fail closed.
      if (targetIdOccurrences > 0) return -1;
      // Marks exist but none is the target's: the /restore shape. Checkpoint
      // JSON serialization drops the Symbol marks from restored entries
      // while later live sends stay marked, so the target's id matches
      // nothing. Allow the positional walk below, but only accept an
      // UNMARKED resolution: a marked entry is owned by its identity, and
      // accepting one positionally would guess across a truly mixed history.
      // A mark-free history (fully serialized) also falls through, as before.
      allowRestoredPositionalFallback = true;
    }
  }

  // Count how many UI user turns exist before the target
  let uiUserTurnCount = 0;
  for (
    let i = compressionIndex === -1 ? 0 : compressionIndex + 1;
    i < targetIndex;
    i++
  ) {
    const item = uiHistory[i]!;
    if (isRealUserTurn(item)) {
      uiUserTurnCount++;
    }
  }

  // Determine the starting index in the API history (skip startup context)
  const startIndex = getStartupContextLength(apiHistory, {
    includeCompressed: true,
  });

  if (uiUserTurnCount === 0) {
    // Marker-less auto-compaction (entrance 3): the API history carries a
    // compressed prefix but the UI has no summarizing compression boundary.
    // Rewinding to the first turn would silently truncate to
    // [prelude, summary, ack] and drop every real turn — fail loud instead.
    if (
      compressionIndex === -1 &&
      startIndex > getStartupContextLength(apiHistory)
    ) {
      return -1;
    }
    // The restored-history fallback may only resolve to an unmarked entry;
    // a marked entry is owned by its identity and must not be guessed
    // positionally.
    const firstEntry = apiHistory[startIndex];
    if (
      allowRestoredPositionalFallback &&
      firstEntry &&
      getApiHistoryPromptId(firstEntry) !== undefined
    ) {
      return -1;
    }
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
        // Same rule as the first-turn branch: the restored-history fallback
        // never resolves onto a marked entry.
        if (
          allowRestoredPositionalFallback &&
          getApiHistoryPromptId(apiHistory[i]!) !== undefined
        ) {
          return -1;
        }
        return i;
      }
    }
  }

  // If we didn't find enough user prompts (e.g., after compression),
  // signal that the target turn is unreachable.
  return -1;
}
