/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { splitForDiscord } from './streamSplit.js';

/** Count unbalanced fence state across a sequence (should be 0 per message). */
function fenceBalanced(msg: string): boolean {
  const n = msg
    .split('\n')
    .filter((l) => l.trimStart().startsWith('```')).length;
  return n % 2 === 0;
}

describe('splitForDiscord', () => {
  it('returns a single message when it already fits', () => {
    expect(splitForDiscord('hello world')).toEqual(['hello world']);
  });

  it('returns [] for empty input', () => {
    expect(splitForDiscord('')).toEqual([]);
  });

  it('every output message is within the cap', () => {
    const text = Array.from(
      { length: 200 },
      (_, i) => `line ${i} of prose`,
    ).join('\n');
    const out = splitForDiscord(text, 200);
    expect(out.length).toBeGreaterThan(1);
    for (const m of out) expect(m.length).toBeLessThanOrEqual(200);
  });

  it('closes the fence at a cut and reopens with the same language', () => {
    // A fenced code block that must span at least two messages at a small cap.
    const code = Array.from(
      { length: 60 },
      (_, i) => `const x${i} = ${i};`,
    ).join('\n');
    const text = `Here is code:\n\`\`\`ts\n${code}\n\`\`\`\ndone`;
    const out = splitForDiscord(text, 200);
    expect(out.length).toBeGreaterThan(1);
    for (const m of out) {
      expect(m.length).toBeLessThanOrEqual(200); // fence chars counted in budget
      expect(fenceBalanced(m)).toBe(true); // each message is self-contained
    }
    // The reopened messages carry the language tag.
    const reopened = out.filter((m) => m.startsWith('```ts'));
    expect(reopened.length).toBeGreaterThanOrEqual(1);
  });

  it('the spec scenario: a 3500-char chunk with a fence splits at safe boundaries', () => {
    const code = Array.from(
      { length: 300 },
      (_, i) => `row_${i} = compute(${i})`,
    ).join('\n');
    const text = `Result:\n\`\`\`python\n${code}\n\`\`\``;
    expect(text.length).toBeGreaterThan(3500);
    const out = splitForDiscord(text); // default 2000 cap
    expect(out.length).toBeGreaterThan(1);
    for (const m of out) {
      expect(m.length).toBeLessThanOrEqual(2000);
      // the message containing the fence MUST end with a closed fence
      expect(fenceBalanced(m)).toBe(true);
    }
    // continuing-code messages open a new fence
    expect(out.slice(1).some((m) => m.startsWith('```python'))).toBe(true);
  });

  it('splits an over-long single line at a word break then hard cut', () => {
    const line = 'word '.repeat(100).trim(); // 499 chars, spaces present
    const out = splitForDiscord(line, 50);
    expect(out.length).toBeGreaterThan(1);
    for (const m of out) {
      expect(m.length).toBeLessThanOrEqual(50);
      expect(m.startsWith(' ')).toBe(false); // boundary space dropped
    }
    // round-trips to the same words
    expect(out.join(' ').replace(/\s+/g, ' ')).toBe(line);
  });

  it('splits a >cap no-space line INSIDE a fence, balanced, within the cap', () => {
    // The nastiest path: one giant token inside a code block. Each emitted piece
    // must carry BOTH a reopen prefix and a closing suffix, and the fence chars
    // must be counted in the budget (the openedInFence === inFence invariant).
    const giant = 'a'.repeat(5000);
    const text = `\`\`\`ts\n${giant}\n\`\`\``;
    const out = splitForDiscord(text, 2000);
    expect(out.length).toBeGreaterThan(2);
    for (const m of out) {
      expect(m.length).toBeLessThanOrEqual(2000); // fence overhead counted
      expect(fenceBalanced(m)).toBe(true); // every piece self-contained
    }
    // the code content survives across the pieces
    const code = out
      .join('')
      .replace(/```ts/g, '')
      .replace(/```/g, '')
      .replace(/\n/g, '');
    expect(code).toBe(giant);
  });

  it('hard-cuts a single long word with no spaces', () => {
    const out = splitForDiscord('x'.repeat(120), 50);
    expect(out.length).toBe(3);
    expect(out.map((m) => m.length)).toEqual([50, 50, 20]);
    expect(out.join('')).toBe('x'.repeat(120));
  });

  it('reassembles to the original prose (no content lost) when no fences', () => {
    const text = Array.from({ length: 40 }, (_, i) => `para ${i}`).join('\n');
    const out = splitForDiscord(text, 30);
    expect(out.join('\n')).toBe(text);
  });
});
