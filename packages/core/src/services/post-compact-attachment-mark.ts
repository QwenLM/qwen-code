/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';

/**
 * Structural mark on a generated post-compact attachment entry.
 *
 * Zero-width, so it is not one of the visible attachment openings. Rewind
 * uses it to tell restoration content from a real prompt that merely starts
 * with `<background-tasks>` or `<plan-mode-active>`.
 */
export const POST_COMPACT_ATTACHMENT_SENTINEL = '\u200b\u200c\u200d\u2060';

export function markPostCompactAttachmentParts(parts: Part[]): Part[] {
  const textIndex = parts.findIndex((part) => typeof part.text === 'string');
  if (textIndex < 0) {
    return [{ text: POST_COMPACT_ATTACHMENT_SENTINEL }, ...parts];
  }
  return parts.map((part, index) => {
    if (index !== textIndex || typeof part.text !== 'string') return part;
    if (part.text.includes(POST_COMPACT_ATTACHMENT_SENTINEL)) return part;
    return {
      ...part,
      text: POST_COMPACT_ATTACHMENT_SENTINEL + part.text,
    };
  });
}

export function hasPostCompactAttachmentSentinel(
  content: Content | undefined,
): boolean {
  return (
    content?.parts?.some(
      (part) =>
        typeof part.text === 'string' &&
        part.text.includes(POST_COMPACT_ATTACHMENT_SENTINEL),
    ) ?? false
  );
}
