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
  isClearedMediaPlaceholder,
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
 * Ownership proof for the identity gate in `computeApiTruncationIndex`:
 * returns true when `entry` is the API-history entry owned by the UI turn
 * whose prompt text is `targetText`.
 *
 * A `promptId` match alone never proves ownership (twins, cron/duplicate
 * re-sends and re-minted absorbed marks all wear the same id), but a turn's
 * own entry carries exactly that turn's prompt text. Comparing the entry's
 * user text parts against the target's text is therefore the minimal
 * per-entry proof that a matched entry belongs to the rewind target —
 * conclusive only while no other turn sent the same text; callers must
 * establish that uniqueness before trusting the proof (see
 * `computeApiTruncationIndex`). System-reminder parts never equal a
 * genuine prompt, so for ordinary text a plain part comparison is
 * sufficient.
 *
 * A placeholder-shaped target text is ambiguous on its own — a cleared
 * media-only entry carries exactly that shape and keeps its mark through
 * microcompaction — so the caller pairs this proof with an ordinal check
 * for those targets rather than trusting the text alone.
 */
function isApiEntryOwnedByText(entry: Content, targetText: string): boolean {
  if (entry.role !== 'user' || !entry.parts) return false;
  return entry.parts.some((part) => 'text' in part && part.text === targetText);
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
    // Rewinding to the first user turn: keep only startup context (if any).
    // This returns BEFORE the identity shortcut below: identities are minted
    // `sessionId########<n>` by entrances whose counters restart
    // independently, so a UNIQUE match on a first turn can be another
    // entrance's re-mint of the same id. If the first turn's own entry was
    // absorbed by marker-less compression while the re-minted twin
    // survived, the shortcut would resolve the absorbed turn onto the twin
    // and bypass the entrance-3 refusal above — silently truncating at the
    // wrong boundary (R25-1). Positional mapping loses nothing here: a
    // reachable first turn's boundary is exactly `startIndex`.
    return startIndex;
  }

  // The positional mapping: walk the API history from after the startup
  // context, counting user text prompts, and truncate right before the
  // (uiUserTurnCount + 1)th one. This is exactly the behavior that shipped
  // before identities existed, so it is the safe baseline - whenever it
  // lands, the result is what a pre-identity session would have produced.
  const positionalTruncationIndex = (): number => {
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
    // Not enough user prompts (e.g., after compression): unreachable.
    return -1;
  };

  const target = uiHistory[targetIndex]!;
  if (
    isRealUserTurn(target) &&
    target.promptId &&
    !target.promptIdFileKeyOnly
  ) {
    // Ownership gate. Identities are minted `sessionId########<n>` by
    // entrances whose counters restart independently, so an entry wearing the
    // target's id is not necessarily the target's own: it can be an earlier
    // or later twin's, a claimant-less re-send's, or an absorbed turn's
    // re-minted mark. A unique match is therefore not proof on the id alone.
    //
    // The target's own entry is the one carrying the target's text, so accept
    // a match only under that proof and prefer it over the positional walk —
    // it lands exactly even where the walk is desynced by an absorbed turn.
    // Any other outcome falls back to the walk, whose loud -1 is the safe
    // refusal. `docs/design/rewind-stable-prompt-identity.md` lists every
    // accepted condition and why each exists.
    const identifiedIndex = findApiHistoryPromptIndex(
      apiHistory,
      target.promptId,
      startIndex,
    );
    // `text` is DISPLAY text; the entry carries MODEL-FACING text. They are
    // the same string on the live path, but the resume builder substitutes
    // synthetic display strings (notably '[User message with attachments]'),
    // and comparing those against the entry can never match — the gate then
    // silently never fired for such turns. Prefer the model-facing text the
    // resume builder records for exactly this comparison.
    const ownerText = target.promptOwnerText ?? target.text;
    const ownershipProofIsUnique = (): boolean => {
      if (
        uiHistory.some(
          (item, index) =>
            index !== targetIndex &&
            isRealUserTurn(item) &&
            !item.promptIdFileKeyOnly &&
            item.promptId === target.promptId &&
            (item.promptOwnerText ?? item.text) === ownerText,
        )
      ) {
        return false;
      }
      let sameTextEntries = 0;
      for (let i = startIndex; i < apiHistory.length; i++) {
        if (isApiEntryOwnedByText(apiHistory[i]!, ownerText)) {
          sameTextEntries++;
          if (sameTextEntries > 1) return false;
        }
      }
      return true;
    };
    // A cleared-media placeholder as the target's OWN text is ambiguous: it
    // is either a cleared media-only entry wearing a re-minted mark, or a
    // genuine prompt the user typed whose whole text equals the generated
    // placeholder — the #9437 collision, whose own entry IS the match.
    //
    // Text alone cannot separate the two: a cleared media-only entry and a
    // genuine placeholder-texted prompt are byte-identical once serialized.
    // Their ORDINAL differs, though: the target's own entry is the
    // (number of preceding turns with a model-facing prompt text)-th such
    // entry, while a cleared entry wearing a re-minted mark sits at some
    // other ordinal. Both sides of the comparison must count that SAME
    // population. The API side uses the walk's own filtered binding, which
    // skips cleared-media placeholders (a media-only turn never had a UI
    // turn) and can never count a text-less entry; the UI side accordingly
    // counts real turns that carried a model-facing text, which the resume
    // builder records (`promptHasModelText`) because an attachment-only turn
    // displays a synthetic string while its entry has no text part. Counting
    // different populations lets the two divergence directions cancel and
    // admit an impostor (R32-1).
    //
    // The check is scoped to placeholder-texted targets on purpose. Ordinal
    // agreement is a positional proof, so it breaks down exactly where
    // positions have desynced — an absorbed turn — which is the case
    // identity exists to resolve and which the round-28 tests pin. Those
    // targets carry ordinary text and never reach this branch.
    const matchOrdinalAgrees = (matchIndex: number): boolean => {
      let expected = 0;
      for (
        let i = compressionIndex === -1 ? 0 : compressionIndex + 1;
        i < targetIndex;
        i++
      ) {
        const item = uiHistory[i]!;
        if (isRealUserTurn(item) && item.promptHasModelText !== false) {
          expected++;
        }
      }
      let counted = 0;
      for (let i = startIndex; i < matchIndex; i++) {
        if (isUserTextContent(apiHistory[i]!)) counted++;
      }
      return counted === expected;
    };
    const ownershipProven = (matchIndex: number): boolean =>
      isApiEntryOwnedByText(apiHistory[matchIndex]!, ownerText) &&
      (!isClearedMediaPlaceholder(ownerText) || matchOrdinalAgrees(matchIndex));
    if (
      identifiedIndex !== -1 &&
      ownershipProven(identifiedIndex) &&
      ownershipProofIsUnique()
    ) {
      // Even a unique, ownership-proven match is demoted when the
      // positional walk lands EARLIER than it: an early walk means counted
      // entries precede the match that the UI turn count does not account
      // for — entries of turns the UI deleted, or of a claimant-less
      // re-send. No compressed prefix explains an early walk (startIndex
      // skips the prefix, and excluded entries desync the walk LATE, never
      // early). The walk's answer is the exact pre-identity boundary, so
      // preferring it can never produce a truncation shape the pre-identity
      // mapping would not have produced. A walk that lands late or cannot
      // land leaves identity preferred, which is the absorbed-turn
      // exactness this gate is for.
      const positional = positionalTruncationIndex();
      if (positional !== -1 && positional < identifiedIndex) {
        return positional;
      }
      return identifiedIndex;
    }
    return positionalTruncationIndex();
  }

  return positionalTruncationIndex();
}
