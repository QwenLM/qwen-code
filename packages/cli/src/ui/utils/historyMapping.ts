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
export function isUserTextContent(content: Content): boolean {
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
 * `computeApiTruncationIndex`). System-reminder parts and cleared-media
 * placeholders never equal a genuine prompt, so a plain text part
 * comparison is sufficient.
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
      return identifiedIndex;
    }
    return positionalTruncationIndex();
  }

  return positionalTruncationIndex();
}
