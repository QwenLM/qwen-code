/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';

const OPENING_TAG = /^<(?:think|thinking)[ \t\r\n]*>/i;
const THINKING_TAG = /<\/?(?:think|thinking)[ \t\r\n]*>/gi;
/**
 * Bounds the leading-block buffer. A stream that opens a block and never
 * closes it, or closes it without ever following it with an answer, stays
 * undecided otherwise. Past this length the text is released verbatim and the
 * detector steps aside; the turn then keeps its pre-existing behavior.
 */
export const MAX_LEADING_THINKING_BLOCK_LENGTH = 64 * 1024;
/**
 * Mirrors the converter's quarantine cap for an unresolved tag prefix. Keeping
 * the same threshold means a stream that only ever wrote `<think` followed by
 * whitespace releases on the schedule it always did instead of being held by
 * this detector.
 */
const MAX_TAG_PREFIX_LENGTH = 128;

type LeadingScan =
  | { kind: 'none' }
  | { kind: 'pending' }
  | { kind: 'blocks'; thoughts: string[]; answer: string };

function skipWhitespace(text: string, offset: number): number {
  let index = offset;
  while (index < text.length && /\s/.test(text[index]!)) index++;
  return index;
}

function couldStartOpeningTag(text: string, offset: number): boolean {
  const candidate = text.slice(offset).toLowerCase();
  return ['<think', '<thinking'].some((tag) => {
    if (tag.startsWith(candidate)) return true;
    if (!candidate.startsWith(tag)) return false;
    return /^[ \t\r\n]*$/.test(candidate.slice(tag.length));
  });
}

/**
 * Splits a response that begins with one or more balanced, consecutive
 * `think`/`<thinking>` blocks from the visible answer that follows them.
 * Anything after the first non-block byte stays opaque: later tags are not
 * parsed, so prose and fenced code are never rewritten.
 */
function scanLeadingBlocks(text: string, final: boolean): LeadingScan {
  let offset = skipWhitespace(text, 0);
  const thoughts: string[] = [];
  // Start of the visible answer if the sequence stops here. Keeping it at the
  // closing tag, rather than at the first non-whitespace byte, preserves the
  // separator the model wrote between reasoning and answer.
  let answerStart = 0;

  for (;;) {
    if (offset >= text.length) {
      return final ? { kind: 'none' } : { kind: 'pending' };
    }

    const opening = OPENING_TAG.exec(text.slice(offset));
    if (!opening) {
      if (couldStartOpeningTag(text, offset)) {
        if (final) return { kind: 'none' };
        if (
          thoughts.length === 0 &&
          text.slice(offset).length > MAX_TAG_PREFIX_LENGTH
        ) {
          return { kind: 'none' };
        }
        return { kind: 'pending' };
      }
      if (thoughts.length === 0) return { kind: 'none' };
      return { kind: 'blocks', thoughts, answer: text.slice(answerStart) };
    }

    const innerStart = offset + opening[0].length;
    let depth = 1;
    let innerEnd = -1;
    let closingStart = -1;
    THINKING_TAG.lastIndex = innerStart;
    for (
      let match = THINKING_TAG.exec(text);
      match;
      match = THINKING_TAG.exec(text)
    ) {
      depth += match[0].startsWith('</') ? -1 : 1;
      if (depth === 0) {
        closingStart = match.index;
        innerEnd = match.index + match[0].length;
        break;
      }
    }

    if (depth !== 0) {
      return final ? { kind: 'none' } : { kind: 'pending' };
    }

    thoughts.push(text.slice(innerStart, closingStart));
    answerStart = innerEnd;
    offset = skipWhitespace(text, innerEnd);
  }
}

export class LeadingThinkingBlockDemoter {
  private pending = '';
  private decided = false;

  /**
   * Demotes a leading balanced block sequence only once a visible answer
   * follows it. Until then the text is buffered, because a block-only response
   * has to stay visible and cannot be re-classified after emission.
   */
  parse(text: string, final: boolean): Part[] {
    if (this.decided) {
      return text ? [{ text }] : [];
    }

    this.pending += text;
    const scan = scanLeadingBlocks(this.pending, final);
    if (
      scan.kind === 'pending' &&
      this.pending.length <= MAX_LEADING_THINKING_BLOCK_LENGTH
    ) {
      return [];
    }

    this.decided = true;
    const released = this.pending;
    this.pending = '';

    if (scan.kind !== 'blocks') {
      return released ? [{ text: released }] : [];
    }

    const parts: Part[] = scan.thoughts
      .filter((thought) => thought.length > 0)
      .map((thought) => ({ text: thought, thought: true }));
    if (scan.answer) parts.push({ text: scan.answer });
    return parts;
  }

  /** Releases buffered text verbatim when the stream ends before a verdict. */
  release(): string {
    const released = this.pending;
    this.pending = '';
    this.decided = true;
    return released;
  }
}
