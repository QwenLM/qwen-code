/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import { createDebugLogger } from '../../utils/debugLogger.js';

const debugLogger = createDebugLogger('TAGGED_THINKING_PARSER');

// Cross-matching aliases is intentional: <think>content</thinking> is valid.
// The default parser keeps its binary toggle; content-only demotion tracks depth.
const OPEN_TAGS = ['<think>', '<thinking>'] as const;
const CLOSE_TAGS = ['</think>', '</thinking>'] as const;
const ALL_TAGS = [...OPEN_TAGS, ...CLOSE_TAGS];

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

export interface TaggedThinkingParserOptions {
  /**
   * Consume nested blocks' own closing tags without stripping literal
   * closing tags in the visible answer. Only content-only demotion opts in.
   */
  trackNesting?: boolean;
}

export class TaggedThinkingParser {
  private mode: ParserMode = 'text';
  private thoughtDepth = 0;
  private buffer = '';

  constructor(private readonly options: TaggedThinkingParserOptions = {}) {}

  hasUnclosedThought(): boolean {
    return this.mode === 'thought';
  }

  parse(chunk: string, final = false): Part[] {
    this.buffer += chunk;

    // Pre-compute a lowercase copy once per call to avoid repeated
    // O(N) slice+toLowerCase allocations inside the character loop.
    const lower = this.buffer.toLowerCase();

    const parts: Part[] = [];
    let segment = '';
    let index = 0;

    while (index < this.buffer.length) {
      const activeTags =
        this.mode === 'text'
          ? OPEN_TAGS
          : this.options.trackNesting
            ? ALL_TAGS
            : CLOSE_TAGS;
      const matchedTag = findMatchingTag(lower, index, activeTags);

      if (matchedTag) {
        debugLogger.debug(
          `taggedThinking: detected tag "${matchedTag}" at offset ${index}`,
        );
        if (
          this.mode === 'thought' &&
          this.options.trackNesting &&
          !matchedTag.startsWith('</')
        ) {
          this.thoughtDepth += 1;
          segment += this.buffer.slice(index, index + matchedTag.length);
          index += matchedTag.length;
          continue;
        }
        appendPart(parts, segment, this.mode);
        segment = '';
        if (this.mode === 'text') {
          this.thoughtDepth = 1;
          this.mode = 'thought';
        } else if (--this.thoughtDepth === 0) {
          this.mode = 'text';
        }
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
      debugLogger.debug(
        `taggedThinking: emitted ${parts.length} part(s), buffered ${this.buffer.length} char(s)`,
      );
      return parts;
    }

    this.buffer = '';
    // Safety net: log when flushing an unclosed thought buffer
    // to make this silent data-loss scenario observable.
    if (this.mode === 'thought' && segment) {
      debugLogger.warn(
        `taggedThinking: flushing ${segment.length} chars of unclosed thought on stream end`,
      );
    }
    appendPart(parts, segment, this.mode);
    debugLogger.debug(
      `taggedThinking: emitted ${parts.length} part(s), flush complete`,
    );
    return parts;
  }
}

export function parseTaggedThinkingText(text: string): Part[] {
  return new TaggedThinkingParser().parse(text, true);
}
