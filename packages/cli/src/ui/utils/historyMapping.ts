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
 * TUI rewind's binding of the shared user-prompt classifier. Exported so the
 * OpenTUI parity path counts prompts under the exact same rule.
 */
export const TUI_API_USER_PROMPT_OPTIONS: ApiUserPromptOptions = {
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
 * than part of the shared rule (ACP must keep those entries counted), and for
 * the exact-match collision this leaves behind — which is what prompt
 * identity resolves.
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
 * Round-30 exception: a placeholder-shaped target text proves nothing. A
 * cleared media-only entry carries exactly that shape and keeps its mark
 * through microcompaction, and the documented exact-match collision means
 * a genuine prompt with the same full text is indistinguishable from the
 * cleared entry once serialized. The proof refuses such text outright so
 * the caller falls back to the positional walk (whose loud -1 is the
 * fail-safe pinned for the collision class) instead of resolving onto the
 * placeholder entry and silently truncating everything after it.
 */
function isApiEntryOwnedByText(entry: Content, targetText: string): boolean {
  if (entry.role !== 'user' || !entry.parts) return false;
  if (isClearedMediaPlaceholder(targetText)) return false;
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
    // Ownership gate (round-28 structural close of the twin-trust class that
    // R24-1 .. R27-1 each patched per-entrance, refined by round-29).
    // Identities are minted `sessionId########<n>` by entrances whose
    // counters restart independently, so a `promptId` can be worn by API
    // entries that do NOT belong to the rewind target: an earlier/later
    // twin's entry, a cron/duplicate re-send with no UI claimant, or an
    // absorbed turn's re-minted mark. A unique post-`startIndex` match is
    // therefore never provably the target's own entry on the id alone — the
    // round-27 attempt to whitelist by scanning the UI history for twin
    // claimants still resolved a target onto a twin's boundary whenever the
    // positional walk could not land (or landed late) while an impostor wore
    // the id.
    //
    // The target's OWN entry is the one whose user prompt text equals the
    // target's text. Accept the identity match only under that ownership
    // proof, and prefer it over the positional walk: it lands exactly even
    // when the walk is desynchronized by an absorbed turn or a placeholder
    // collision. Any other outcome — no match, an ambiguous (multi) match, a
    // match owned by a different turn, or a NON-UNIQUE ownership proof —
    // falls back to the positional walk, the exact pre-identity behavior,
    // whose loud -1 is the safe refusal.
    //
    // Round-29 uniqueness: the text proof stops being a proof whenever the
    // same text is in play twice. Cron/duplicate re-sends and re-minted
    // twins re-send the SAME prompt text, so an impostor's entry passes the
    // text gate and the resolution lands on a boundary that is not the
    // target's own — silently dropping context the UI still shows, or
    // keeping context the UI deleted (the same-text variants of R27-1 and
    // R26-1). The proof is unique only when no other real non-file-key-only
    // UI turn claims the same promptId with the same text (with two
    // claimants the matched entry could belong to either), and at most one
    // post-`startIndex` entry carries the target's text (a second copy is a
    // re-send whose mark can sit at a different position than the target's
    // own boundary). file-key-only restored items never own marked entries,
    // so they still cannot demote a proof — the pinned surviving-twin
    // resolutions stay correct because the surviving twin IS the rewind
    // target in those states and no other turn claims its id with its text.
    // Demoting a same-text state is conservative: it can turn an exact
    // resolution into a loud -1 (the walk is desynced there), never a
    // silent wrong boundary. The durable close remains per-entry provenance
    // (non-re-mintable ids) at the mint sites.
    //
    // Round-30 residue: the proof still cannot distinguish the target from
    // a same-text impostor when exactly one same-text entry is in play — a
    // claimant-less re-send (no UI claimant to scan) or a placeholder
    // collision re-mint (the cleared-media entry itself passes the text
    // proof). Two demotions backstop it without a new gate condition: the
    // proof refuses placeholder-shaped text outright (see
    // `isApiEntryOwnedByText`), and an acceptance whose positional walk
    // lands EARLIER than the match trusts the walk instead (see the
    // acceptance branch below).
    const identifiedIndex = findApiHistoryPromptIndex(
      apiHistory,
      target.promptId,
      startIndex,
    );
    const ownershipProofIsUnique = (): boolean => {
      if (
        uiHistory.some(
          (item, index) =>
            index !== targetIndex &&
            isRealUserTurn(item) &&
            !item.promptIdFileKeyOnly &&
            item.promptId === target.promptId &&
            item.text === target.text,
        )
      ) {
        return false;
      }
      let sameTextEntries = 0;
      for (let i = startIndex; i < apiHistory.length; i++) {
        if (isApiEntryOwnedByText(apiHistory[i]!, target.text)) {
          sameTextEntries++;
          if (sameTextEntries > 1) return false;
        }
      }
      return true;
    };
    if (
      identifiedIndex !== -1 &&
      isApiEntryOwnedByText(apiHistory[identifiedIndex]!, target.text) &&
      ownershipProofIsUnique()
    ) {
      // Round-30 backstop: even a unique, ownership-proven match cannot be
      // trusted when the positional walk lands EARLIER than it. An earlier
      // landing means counted prompt entries precede the match that the UI
      // turn count does not account for — entries of turns the UI deleted,
      // or of a claimant-less re-send whose UI item never existed — while
      // the target's own entry is absent. Accepting the match would then
      // truncate at the impostor's boundary and silently keep the
      // prompt+response of a turn the UI deleted. No compressed prefix can
      // explain this desync (startIndex skips the prefix, and excluded
      // placeholder/reminder entries desync the walk LATE, never early),
      // so the walk's earlier answer is the exact pre-identity boundary —
      // the safe baseline this gate exists to preserve. A walk that lands
      // late or cannot land (-1) leaves the identity preferred: that is the
      // absorbed-turn/placeholder-collision exactness pinned by the
      // round-28 tests.
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
