/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  NOTIFICATION_LABEL_MAX_LENGTH,
  stripDisplayControlChars,
  stripTerminalControlSequences,
  truncateNotificationLabel,
} from './terminalSafe.js';

describe('stripDisplayControlChars', () => {
  it('preserves printable ASCII and TAB', () => {
    expect(stripDisplayControlChars('hello\tworld 123')).toBe(
      'hello\tworld 123',
    );
  });

  it('strips C0 controls except TAB (NUL, BEL, ESC, \\n, \\r, BS)', () => {
    const input = 'a\x00b\x07c\x1Bd\ne\rf\x08g';
    expect(stripDisplayControlChars(input)).toBe('abcdefg');
  });

  it('strips C1 controls (0x80-0x9F, including NEL \\u0085 and single-byte CSI)', () => {
    const input = 'before\u0085mid\u009Bafter';
    expect(stripDisplayControlChars(input)).toBe('beforemidafter');
  });

  it('keeps DEL (0x7F)', () => {
    // DEL is not in our strip ranges (C0 ends at 0x1F, C1 starts at 0x80).
    expect(stripDisplayControlChars('a\x7Fb')).toBe('a\x7Fb');
  });

  it('strips Unicode bidi embeddings/overrides U+202A-U+202E', () => {
    // LRE U+202A, RLE U+202B, PDF U+202C, LRO U+202D, RLO U+202E.
    const input = 'safe\u202Adanger\u202Cmore\u202Etrojan\u202C';
    expect(stripDisplayControlChars(input)).toBe('safedangermoretrojan');
  });

  it('strips Unicode bidi isolates U+2066-U+2069', () => {
    // LRI U+2066, RLI U+2067, FSI U+2068, PDI U+2069.
    const input = 'a\u2066b\u2067c\u2068d\u2069e';
    expect(stripDisplayControlChars(input)).toBe('abcde');
  });

  it('keeps characters adjacent to the bidi range (U+2029, U+202F, U+2065, U+206A)', () => {
    // U+2029 PARAGRAPH SEPARATOR — kept (we only strip 202A-202E).
    // U+202F NARROW NO-BREAK SPACE — kept.
    // U+2065 UNASSIGNED — kept.
    // U+206A INHIBIT SYMMETRIC SWAPPING — kept (outside 2066-2069 isolate range).
    const input = 'a\u2029b\u202Fc\u2065d\u206Ae';
    expect(stripDisplayControlChars(input)).toBe(
      'a\u2029b\u202Fc\u2065d\u206Ae',
    );
  });

  it('defends against Trojan-Source style sequences (CVE-2021-42574)', () => {
    // A classic Trojan-Source payload mixes RLO/LRO with PDF to visually
    // reorder source code in renderers. After stripping, the textual
    // order matches the byte order.
    const trojan = '/*\u202E } if (isAdmin) begin admin only \u202C*/';
    expect(stripDisplayControlChars(trojan)).toBe(
      '/* } if (isAdmin) begin admin only */',
    );
  });

  it('handles empty string', () => {
    expect(stripDisplayControlChars('')).toBe('');
  });

  it('is idempotent', () => {
    const input = 'a\x00b\u202Ec\u0085d\u2068e';
    const once = stripDisplayControlChars(input);
    expect(stripDisplayControlChars(once)).toBe(once);
  });
});

describe('stripTerminalControlSequences', () => {
  it('replaces OSC/CSI/SS sequences and remaining C0/C1 with single spaces', () => {
    // Pre-existing behavior — sanity test that the helper is reachable
    // and that the export shape did not regress when we added the new
    // function alongside it.
    const input = 'a\x1B[31mb\x1B]0;title\x07c';
    const out = stripTerminalControlSequences(input);
    expect(out).not.toContain('\x1B');
    expect(out).toContain('a');
    expect(out).toContain('b');
    expect(out).toContain('c');
  });
});

describe('truncateNotificationLabel', () => {
  it('strips controls, collapses whitespace, and trims', () => {
    expect(truncateNotificationLabel('a\u202eb\tc\n d ')).toBe('ab c d');
  });

  it('truncates ASCII over the cap to exactly the cap, ending in "..."', () => {
    const out = truncateNotificationLabel('x'.repeat(90));
    expect(out).toBe('x'.repeat(NOTIFICATION_LABEL_MAX_LENGTH - 3) + '...');
    expect(out.length).toBe(NOTIFICATION_LABEL_MAX_LENGTH);
  });

  it('returns an exactly-at-cap label unchanged (inclusive boundary)', () => {
    expect(truncateNotificationLabel('x'.repeat(80))).toBe('x'.repeat(80));
  });

  it('measures the cap in code points, not UTF-16 code units', () => {
    // 60 emoji = 60 code points but 120 UTF-16 units; 80 emoji = 160
    // units. Both are within the code-point cap and must pass through
    // unchanged — a code-unit gate would "truncate" them into something
    // longer than the input with a bogus ellipsis.
    expect(truncateNotificationLabel('\u{1F600}'.repeat(60))).toBe(
      '\u{1F600}'.repeat(60),
    );
    expect(truncateNotificationLabel('\u{1F600}'.repeat(80))).toBe(
      '\u{1F600}'.repeat(80),
    );
  });

  it('cuts astral labels on a code-point boundary without splitting a surrogate pair', () => {
    const out = truncateNotificationLabel('\u{1F600}'.repeat(90));
    expect(out).toBe('\u{1F600}'.repeat(77) + '...');
    expect([...out]).toHaveLength(80);
  });
});
