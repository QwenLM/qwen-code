/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Text-placeholder expansion and orphan-image filtering utilities.
 *
 * Handles two kinds of TUI paste placeholders:
 *
 * - Text placeholders: `[Pasted text #N: M lines]`
 *   → Eagerly expanded to full text before submission via `expandPastedTextRefs()`.
 *
 * - Image placeholders: `[Image #N]`
 *   → Kept in the prompt string; real base64 data flows through `PastedContent`.
 *   → Orphan cleanup via `filterOrphanedImages()`.
 */

import type { PastedContent } from './types.js';

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

/**
 * Matches text paste placeholders inserted by the TUI buffer.
 *
 * Formats:
 *   [Pasted text #1: 6 lines]
 *   [Pasted text #2: 501 chars]
 *
 * The `id` capture group is the numeric identifier.
 */
const TEXT_PLACEHOLDER_REGEX =
  /\[Pasted text #(\d+)(?:: \d+ (?:lines|chars))?\]/g;

/**
 * Matches image paste placeholders inserted by `onImagePaste()`.
 *
 * Format: `[Image #N]`
 */
const IMAGE_PLACEHOLDER_REGEX = /\[Image #(\d+)\]/g;

// ---------------------------------------------------------------------------
// expandPastedTextRefs
// ---------------------------------------------------------------------------

/**
 * Replace all `[Pasted text #N: M lines]` placeholders with their full text.
 *
 * Image placeholders (`[Image #N]`) are left untouched — they are resolved
 * later in the image pipeline stage of `processUserInput()`.
 *
 * @param input The raw input string (possibly containing placeholders).
 * @param pastedContents The full paste registry from the TUI buffer.
 * @returns The input with all text placeholders expanded.
 */
export function expandPastedTextRefs(
  input: string,
  pastedContents: Record<number, PastedContent>,
): string {
  return input.replace(TEXT_PLACEHOLDER_REGEX, (_match, idStr: string) => {
    const id = parseInt(idStr, 10);
    const entry = pastedContents[id];
    // Only expand text entries; image entries stay as [Image #N]
    if (entry && entry.type === 'text') {
      return entry.content;
    }
    // Unknown placeholder → leave as-is (defensive)
    return _match;
  });
}

// ---------------------------------------------------------------------------
// filterOrphanedImages
// ---------------------------------------------------------------------------

/**
 * Remove image `PastedContent` entries whose placeholder no longer appears
 * in the submitted input.
 *
 * An "orphan" arises when the user deleted `[Image #N]` from the buffer
 * before submitting. We detect this by scanning `input` for `[Image #N]`
 * references and keeping only those IDs.
 *
 * Text entries (`type: 'text'`) are always preserved — their content has
 * already been inlined by `expandPastedTextRefs()` and the entry is only
 * kept for reference in the returned map.
 *
 * @param pastedContents Full paste registry.
 * @param input The final input string after text expansion.
 * @returns A filtered copy with orphaned image entries removed.
 */
export function filterOrphanedImages(
  pastedContents: Record<number, PastedContent>,
  input: string,
): Record<number, PastedContent> {
  // Collect all image IDs still referenced in the input
  const referencedIds = new Set<number>();
  let match: RegExpExecArray | null;
  // Reset lastIndex before iteration
  IMAGE_PLACEHOLDER_REGEX.lastIndex = 0;
  while ((match = IMAGE_PLACEHOLDER_REGEX.exec(input)) !== null) {
    referencedIds.add(parseInt(match[1], 10));
  }

  const result: Record<number, PastedContent> = {};
  for (const [idStr, entry] of Object.entries(pastedContents)) {
    const id = parseInt(idStr, 10);
    if (entry.type === 'text' || referencedIds.has(id)) {
      result[id] = entry;
    }
    // else: orphaned image → drop
  }
  return result;
}

// ---------------------------------------------------------------------------
// parseImagePlaceholderIds
// ---------------------------------------------------------------------------

/**
 * Extract all `[Image #N]` IDs from an input string in order of appearance.
 *
 * Used by the image pipeline to determine the sequence in which images
 * should be injected into the API message.
 */
export function parseImagePlaceholderIds(input: string): number[] {
  const ids: number[] = [];
  let match: RegExpExecArray | null;
  IMAGE_PLACEHOLDER_REGEX.lastIndex = 0;
  while ((match = IMAGE_PLACEHOLDER_REGEX.exec(input)) !== null) {
    ids.push(parseInt(match[1], 10));
  }
  return ids;
}

// ---------------------------------------------------------------------------
// restoreImagePlaceholderText
// ---------------------------------------------------------------------------

/**
 * Replace `[Image #N]` placeholders with plain text for the given IDs.
 *
 * Used when a pasted path turns out not to be a readable image: the paste is
 * dropped from the image registry and its placeholder falls back to the text the
 * user actually pasted, so the turn is submitted instead of rejected.
 *
 * Placeholders whose ID is absent from `replacements` are left untouched.
 *
 * @param input The input string containing image placeholders.
 * @param replacements Map from paste ID → literal text to insert.
 */
export function restoreImagePlaceholderText(
  input: string,
  replacements: ReadonlyMap<number, string>,
): string {
  if (replacements.size === 0) return input;
  return input.replace(IMAGE_PLACEHOLDER_REGEX, (match, idStr: string) => {
    const replacement = replacements.get(parseInt(idStr, 10));
    return replacement ?? match;
  });
}
