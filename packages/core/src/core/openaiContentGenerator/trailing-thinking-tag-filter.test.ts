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

/** Splits `text` into single characters. */
const byChar = (text: string): string[] => [...text];

/**
 * Every chunking of `text` that uses at most `maxCuts` cut points, including
 * the unsplit one. Chunk-invariance is a property, so the exhaustive set is
 * the evidence rather than a seeded sample.
 */
const chunkingsUpTo = (text: string, maxCuts: number): string[][] => {
  const out: string[][] = [];
  const build = (cuts: number[]): string[] => {
    const points = [0, ...cuts, text.length];
    const chunks: string[] = [];
    for (let index = 0; index < points.length - 1; index++) {
      const end = points[index + 1]!;
      const start = points[index]!;
      if (end > start) chunks.push(text.slice(start, end));
    }
    return chunks;
  };
  const walk = (start: number, acc: number[]): void => {
    out.push(build(acc));
    if (acc.length === maxCuts) return;
    for (let cut = start; cut < text.length; cut++) {
      walk(cut + 1, [...acc, cut]);
    }
  };
  walk(1, []);
  return out;
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

  it('carries a literal marker across three or more parse calls', () => {
    // The marker window is only consulted when the marker itself is split;
    // a two-piece split still lands inside one window here.
    const text = 'Use:\n<textarea>\n</thinking>';
    expect(run(['Use:\n<text', 'area', '>\n</thinking>'])).toBe(text);
    expect(run(byChar(text))).toBe(text);
  });

  it('releases an incomplete trailing fragment on a normal finish', () => {
    // A gateway finishing a cut stream, or a model emitting a truncated
    // closer: `</thi` is not a closer, so it is not a leak.
    expect(run(['Answer.\n</thi'])).toBe('Answer.\n</thi');
    expect(run(['Answer.\n</th', 'i'])).toBe('Answer.\n</thi');
  });

  it('treats an earlier closing tag as literal content', () => {
    expect(run(['The closer is </thinking>.\nAgain:\n</thinking>'])).toBe(
      'The closer is </thinking>.\nAgain:\n</thinking>',
    );
  });

  it('accepts a CRLF split across chunks without leaking the carriage return', () => {
    expect(run(['Answer.\r', '\n', '</thinking>'])).toBe('Answer.');
    // An earlier line break must not disable the hold: `candidateStart` then
    // comes from the line start rather than the `\r`.
    expect(run(['Answer.\nMore.\r', '\n</thinking>'])).toBe('Answer.\nMore.');
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

  it('keeps a repeated closer however the deltas were cut', () => {
    // One-shot is the reference; the earlier closer lands at index 0 in the
    // split framings, so a prefix-only check saw an empty string and let the
    // identical suffix be deleted.
    const input = '\n</thinking>\nAnswer.\n</thinking>';
    expect(run([input])).toBe(input);
    expect(run(['\n</thinking>', '\nAnswer.', '\n</thinking>'])).toBe(input);
    expect(run(byChar(input))).toBe(input);
  });

  it('keeps a repeated closer behind an HTML comment at any framing', () => {
    const input = '<!-- </thinking> -->\nTail.\n</thinking>';
    expect(run([input])).toBe(input);
    expect(run(byChar(input))).toBe(input);
    // Split inside the earlier closer: neither half alone is a closer.
    expect(run(['<!-- </thi', 'nking> -->\nTail.\n</thinking>'])).toBe(input);
  });

  it('is invariant to chunk boundaries when a closer repeats', () => {
    // Identical model bytes must not keep or lose their final closing tag
    // depending on where the provider cut the SSE deltas.
    const inputs = [
      '\n</thinking>\n</thinking>',
      '</thinking>\nAnswer.\n</thinking>',
      '\n</thinking>\n\nAnswer.\n</thinking>',
      '<!-- </thinking> -->\nTail.\n</thinking>',
      'First the closer:\n</thinking>\nthen again:\n</thinking>',
      'Answer.\n</thinking>',
      'Answer.\nMore.\r\n</thinking>',
    ];
    for (const input of inputs) {
      const oneShot = run([input]);
      for (const chunks of chunkingsUpTo(input, 2)) {
        expect(run(chunks)).toBe(oneShot);
      }
    }
  });
});
