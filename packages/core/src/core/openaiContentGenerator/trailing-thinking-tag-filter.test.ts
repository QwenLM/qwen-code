/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { TrailingThinkingTagFilter } from './trailing-thinking-tag-filter.js';

/** Feeds `chunks` in order; the last call is the final one. */
const run = (chunks: string[], completed = true): string => {
  const filter = new TrailingThinkingTagFilter();
  const last = chunks.length - 1;
  return chunks
    .map((chunk, index) =>
      filter.parse(chunk, index === last, index === last && completed),
    )
    .join('');
};

describe('TrailingThinkingTagFilter', () => {
  it('holds a trailing candidate and drops it on a normal finish', () => {
    const filter = new TrailingThinkingTagFilter();
    expect(filter.parse('Answer.\n</thi', false, false)).toBe('Answer.');
    expect(filter.parse('nking>', false, false)).toBe('');
    expect(filter.parse('', true, true)).toBe('');
  });

  it('releases the held candidate when the stream did not complete', () => {
    expect(run(['Answer.\n</thinking>'], false)).toBe('Answer.\n</thinking>');
  });

  it('keeps a tag-only response, which has no prose to orphan', () => {
    expect(run(['\n</thinking>'])).toBe('\n</thinking>');
  });

  it('carries a literal marker across chunk boundaries', () => {
    expect(run(['Use ```xml\n', '</thinking>\n```\n</thinking>'])).toBe(
      'Use ```xml\n</thinking>\n```\n</thinking>',
    );
  });

  it('treats an earlier closing tag as literal content', () => {
    expect(run(['The closer is </thinking>.\nAgain:\n</thinking>'])).toBe(
      'The closer is </thinking>.\nAgain:\n</thinking>',
    );
  });

  it('accepts a CRLF split across chunks without leaking the carriage return', () => {
    expect(run(['Answer.\r', '\n', '</thinking>'])).toBe('Answer.');
  });

  it('preserves an indented code block but strips a lazy continuation', () => {
    // A blank line plus four spaces or a tab is CommonMark indented code.
    expect(run(['Sample:\n\n    </thinking>'])).toBe(
      'Sample:\n\n    </thinking>',
    );
    expect(run(['Sample:\n\n\t</thinking>'])).toBe('Sample:\n\n\t</thinking>');
    // A single newline plus indent only continues the paragraph.
    expect(run(['Sample:\n    </thinking>'])).toBe('Sample:');
  });

  it('holds a tail up to the cap mid-stream and releases a longer one', () => {
    const padded = (spaces: number) =>
      'Answer.\n</thinking>' + ' '.repeat(spaces);
    const held = new TrailingThinkingTagFilter();
    // 12 + 115 = 127 stays within the cap, so only the prose is emitted.
    expect(held.parse(padded(115), false, false)).toBe('Answer.');
    const released = new TrailingThinkingTagFilter();
    // 12 + 117 = 129 exceeds it, so the whole tail is released at once.
    expect(released.parse(padded(117), false, false)).toBe(padded(117));
  });

  it('ignores the cap on the final call', () => {
    expect(run(['Answer.\n</thinking>' + ' '.repeat(200)])).toBe('Answer.');
  });
});
