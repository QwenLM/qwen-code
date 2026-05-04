/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';

const OPEN_TAGS = ['<think>', '<thinking>'] as const;
const CLOSE_TAGS = ['</think>', '</thinking>'] as const;

/** Longest tag length across all open/close variants ('</thinking>' = 11). */
const MAX_TAG_LENGTH = Math.max(
  ...OPEN_TAGS.map((t) => t.length),
  ...CLOSE_TAGS.map((t) => t.length),
);

type ParserMode = 'text' | 'thought';

function appendPart(parts: Part[], text: string, mode: ParserMode): void {
  if (!text) return;
  parts.push(mode === 'thought' ? { text, thought: true } : { text });
}

/**
 * Check whether the suffix starting at `offset` in the pre-computed
 * lowercase buffer is a prefix of any tag. The caller MUST pass a
 * fully-lowercased buffer to avoid repeated `toLowerCase()` allocations.
 */
function isPrefixOfAnyTag(
  lower: string,
  offset: number,
  tags: readonly string[],
): boolean {
  const remainingLen = lower.length - offset;
  if (remainingLen <= 0) return false;
  // If the remaining text is longer than the longest tag it cannot be a
  // prefix of any tag, so we can bail early without slicing.
  if (remainingLen > MAX_TAG_LENGTH) return false;
  // Slice is bounded to MAX_TAG_LENGTH (≤ 11 chars) → O(1).
  return tags.some((tag) =>
    tag.startsWith(lower.slice(offset, offset + remainingLen)),
  );
}

/**
 * Find a tag that matches the text at `offset` in the pre-computed
 * lowercase buffer. Returns the matched tag string or undefined.
 */
function findMatchingTag(
  lower: string,
  offset: number,
  tags: readonly string[],
): string | undefined {
  return tags.find((tag) => lower.startsWith(tag, offset));
}

export class TaggedThinkingParser {
  private mode: ParserMode = 'text';
  private buffer = '';

  parse(chunk: string, final = false): Part[] {
    this.buffer += chunk;

    // Pre-compute a lowercase copy once per call to avoid repeated
    // O(N) slice+toLowerCase allocations inside the character loop.
    const lower = this.buffer.toLowerCase();

    const parts: Part[] = [];
    let segment = '';
    let index = 0;

    while (index < this.buffer.length) {
      const activeTags = this.mode === 'text' ? OPEN_TAGS : CLOSE_TAGS;
      const matchedTag = findMatchingTag(lower, index, activeTags);

      if (matchedTag) {
        appendPart(parts, segment, this.mode);
        segment = '';
        this.mode = this.mode === 'text' ? 'thought' : 'text';
        index += matchedTag.length;
        continue;
      }

      if (!final && isPrefixOfAnyTag(lower, index, activeTags)) {
        break;
      }

      segment += this.buffer[index];
      index += 1;
    }

    if (index < this.buffer.length) {
      appendPart(parts, segment, this.mode);
      this.buffer = this.buffer.slice(index);
      return parts;
    }

    this.buffer = '';
    appendPart(parts, segment, this.mode);
    return parts;
  }
}

export function parseTaggedThinkingText(text: string): Part[] {
  return new TaggedThinkingParser().parse(text, true);
}
