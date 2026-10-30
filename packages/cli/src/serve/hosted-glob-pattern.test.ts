/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { braceExpand } from 'minimatch';
import { describe, expect, it } from 'vitest';
import {
  HOSTED_GLOB_MAX_ALTERNATIVES,
  checkHostedGlobPattern,
} from './hosted-glob-pattern.js';

describe('checkHostedGlobPattern', () => {
  it.each([
    'src/*.{ts,tsx}',
    '**/*.{ts,tsx,js,jsx}',
    '{a,b}{c,d}{e,f}',
    '{1..64}',
    '{a..z}',
    '{9007199254740990..9007199254740991}',
    'x{a,{b,c{d,e}}}y',
    'a/..b/*.ts',
    '[.][.]/**/*',
    '\\{a,b\\}',
    'file\\?.txt',
  ])('admits %s', (pattern) => {
    expect(checkHostedGlobPattern(pattern)).toBe('ok');
  });

  it.each([
    '/etc/host*',
    '../**/*',
    '{/etc,/zz}/host*',
    '{.,..}/**/*',
    '\\.\\./**/*',
    'src/{x,\\.\\.}/**/*',
  ])('refuses the escaping %s', (pattern) => {
    expect(checkHostedGlobPattern(pattern)).toBe('escapes');
  });

  it.each([
    ['a nesting bomb', '{a,'.repeat(3400) + 'x' + '}'.repeat(3400)],
    ['a range bomb', '{1..100000}/passwd'],
    ['an unsafe endpoint', '{9007199254740992..9007199254740992}/*'],
    ['an unsafe negative endpoint', '{-9007199254740992..-9007199254740992}/*'],
    ['a nonfinite endpoint', `{${'9'.repeat(310)}..${'9'.repeat(310)}}/*`],
    ['a nested unsafe range', '{{9007199254740992..9007199254740992},src}/*'],
    ['an unsafe step', '{1..2..9007199254740992}'],
    [
      'an unsafe span',
      '{-9007199254740991..9007199254740991..9007199254740991}',
    ],
    ['a product bomb', '{a,b}'.repeat(30)],
    ['one alternative too many', '{1..65}'],
    ['an unbalanced brace', '{a,b'],
    ['a stray closing brace', '{x},b}'],
    ['a sequence assembled inside a group', '{1..{,9999}}'],
    ['an overlong pattern', 'x'.repeat(1025)],
    // Both endpoints overflow Number, so the span is NaN and the bound would
    // fail open; the bare shape dedupes, the composite one does not.
    [
      'a range whose endpoints overflow',
      '{' + '9'.repeat(400) + '..' + '9'.repeat(400) + '}',
    ],
    [
      'an overflowing range prefixed onto brace groups',
      '{' +
        '9'.repeat(309) +
        '..' +
        '9'.repeat(309) +
        '}' +
        '{a,b,c,d}'.repeat(8) +
        '/*',
    ],
  ])('refuses %s before expanding it', (_name, pattern) => {
    const started = Date.now();
    expect(checkHostedGlobPattern(pattern)).toBe('too-complex');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('never admits a pattern that expands past the bound', () => {
    // Seeded, so a failure reproduces: any admitted pattern must expand to
    // at most the bound, or glob would search more than was checked.
    let seed = 0x2f6e2b1;
    const random = () => {
      // imul, not float multiply: seed * 1103515245 passes 2^53, loses its low
      // bits and collapses the recurrence to a ~1k-state cycle.
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed / 2 ** 31;
    };
    const tokens = ['{', '}', ',', 'a', 'b', '1', '..', '\\', '$', '/', '3'];
    const oversized: string[] = [];
    const generated = new Set<string>();
    for (let sample = 0; sample < 20000; sample++) {
      let pattern = '';
      const length = 1 + Math.floor(random() * 16);
      for (let index = 0; index < length; index++)
        pattern += tokens[Math.floor(random() * tokens.length)];
      generated.add(pattern);
      if (checkHostedGlobPattern(pattern) === 'too-complex') continue;
      if (braceExpand(pattern).length > HOSTED_GLOB_MAX_ALTERNATIVES)
        oversized.push(pattern);
    }
    expect(oversized).toEqual([]);
    // `oversized` is empty under the collapsed cycle too, so breadth is what
    // pins the period.
    expect(generated.size).toBeGreaterThan(15000);
  });
});
