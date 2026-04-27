/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';

const OPEN_TAGS = ['<think>', '<thinking>'] as const;
const CLOSE_TAGS = ['</think>', '</thinking>'] as const;

type ParserMode = 'text' | 'thought';

function appendPart(parts: Part[], text: string, mode: ParserMode): void {
  if (!text) return;
  parts.push(mode === 'thought' ? { text, thought: true } : { text });
}

function isPrefixOfAnyTag(input: string, tags: readonly string[]): boolean {
  if (!input) return false;
  const lowerInput = input.toLowerCase();
  return tags.some((tag) => tag.startsWith(lowerInput));
}

function findMatchingTag(
  input: string,
  offset: number,
  tags: readonly string[],
): string | undefined {
  const remaining = input.slice(offset).toLowerCase();
  return tags.find((tag) => remaining.startsWith(tag));
}

export class TaggedThinkingParser {
  private mode: ParserMode = 'text';
  private buffer = '';

  parse(chunk: string, final = false): Part[] {
    this.buffer += chunk;

    const parts: Part[] = [];
    let segment = '';
    let index = 0;

    while (index < this.buffer.length) {
      const activeTags = this.mode === 'text' ? OPEN_TAGS : CLOSE_TAGS;
      const matchedTag = findMatchingTag(this.buffer, index, activeTags);

      if (matchedTag) {
        appendPart(parts, segment, this.mode);
        segment = '';
        this.mode = this.mode === 'text' ? 'thought' : 'text';
        index += matchedTag.length;
        continue;
      }

      const remaining = this.buffer.slice(index);
      if (!final && isPrefixOfAnyTag(remaining, activeTags)) {
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
