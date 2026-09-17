/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PromptFile } from '../adapters/promptTypes';
import {
  dedupeAttachmentName,
  MAX_FILE_ATTACHMENT_DATA_BYTES,
  sanitizeAttachmentName,
} from './imageIngestion';

/**
 * The stem of a folded paste's attachment name when the paste carries nothing
 * to derive one from. A name is otherwise the card's title, so the sent message
 * and the card show the same string.
 */
const FOLDED_PASTE_NAME_STEM = 'pasted-text';

/**
 * A paste at or above either threshold is folded into an attachment card
 * instead of being inserted into the editor.
 *
 * The line count keeps the rule legible to a user; the character count keeps it
 * honest, because one minified line can carry megabytes. A fragment left inline
 * stays under the daemon's 16,384-character mid-turn insertion limit — that
 * limit bounds one queued message, so a draft assembled from several sub-
 * threshold pastes or from typing can still exceed it.
 *
 * These thresholds are deliberately larger than the terminal UI's
 * `isLargePaste` thresholds (10 lines / 1,000 characters): the terminal folds
 * into a placeholder inside a single-line prompt, while this folds into an
 * attachment card. Neither consumer can import the other's module, so the two
 * are separate policies by intent, not by oversight.
 */
export const PASTE_FOLD_MIN_LINES = 200;
export const PASTE_FOLD_MIN_CHARS = 8_000;

/** How much of the paste the card shows as its title. */
export const PASTE_TITLE_MAX_CHARS = 24;

/** Input window per title character, so collapsed whitespace still fills it. */
const TITLE_SCAN_FACTOR = 4;

/**
 * The characters the attachment-name sanitizer would rewrite or strip, plus the
 * two path separators its leading-path rule would cut at. A folded paste's name
 * is its title, so the title has to already be usable as one.
 */
const TITLE_UNSAFE_RE = /[<>:"|?*\\/]|\p{Cc}|\p{Cf}|\p{Cs}/gu;

function pastedTextByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Titles a folded card with the beginning of the paste itself, and doubles as
 * the attachment's name: line breaks and runs of whitespace collapse to single
 * spaces, and characters a file name cannot carry become spaces too, so a paste
 * whose first line is one word still yields a title that reads and a name the
 * sanitizer will not rewrite. Falls back to the stem when there is no content.
 */
export function pastedTextTitle(text: string, fallbackName: string): string {
  // The window is capped, so a paste that is one multi-megabyte line is sliced
  // rather than copied whole; the leading scan is a single pass to the first
  // non-whitespace character.
  const start = text.search(/\S/);
  if (start === -1) return fallbackName;
  const window = text.slice(
    start,
    start + PASTE_TITLE_MAX_CHARS * TITLE_SCAN_FACTOR,
  );
  const flat = window
    .replace(TITLE_UNSAFE_RE, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (flat.length <= PASTE_TITLE_MAX_CHARS) {
    // The window is capped, so a whitespace gap wider than it can end before
    // the content resumes. Mark that instead of passing a shortened title off
    // as the whole beginning.
    return window.length < text.length - start ? `${flat}…` : flat;
  }
  const clipped = flat.slice(0, PASTE_TITLE_MAX_CHARS);
  const safe = /[\uD800-\uDBFF]$/.test(clipped)
    ? clipped.slice(0, -1)
    : clipped;
  // The clip can land on a space, which reads as a gap before the ellipsis and
  // would sit inside the file name this title becomes.
  return `${safe.trimEnd()}…`;
}

export function countTextLines(text: string): number {
  let lines = 1;
  for (
    let index = text.indexOf('\n');
    index !== -1;
    index = text.indexOf('\n', index + 1)
  ) {
    lines += 1;
  }
  return lines;
}

export function shouldFoldPastedText(text: string): boolean {
  const overThreshold =
    text.length >= PASTE_FOLD_MIN_CHARS ||
    countTextLines(text) >= PASTE_FOLD_MIN_LINES;
  if (!overThreshold) return false;
  // An attachment this large cannot be uploaded, so the paste keeps today's
  // inline behavior rather than becoming a card that can never be sent.
  return pastedTextByteLength(text) <= MAX_FILE_ATTACHMENT_DATA_BYTES;
}

/**
 * Builds the card for a folded paste. The name is the card's title with a
 * `.txt` suffix, so the sent message shows what the card showed; the suffix is
 * load-bearing, not cosmetic — the daemon derives a stored attachment's type
 * from its stored name, so a name without it resolves the content as an opaque
 * blob instead of text.
 */
export function createPastedTextFile(
  text: string,
  taken: ReadonlySet<string>,
): PromptFile {
  const title = pastedTextTitle(text, FOLDED_PASTE_NAME_STEM);
  return {
    name: dedupeAttachmentName(sanitizeAttachmentName(`${title}.txt`), taken),
    media_type: 'text/plain',
    text,
    size: pastedTextByteLength(text),
  };
}
