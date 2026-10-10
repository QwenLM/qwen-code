/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { matchesHookPattern } from './hook-matcher.js';

// Whole-matcher edge trimming must not eat whitespace the pattern escapes:
// a whitespace char preceded by an odd number of backslashes is part of the
// regular expression, so trimming it leaves a trailing backslash that fails
// to compile and the matcher silently never matches.
describe('matchesHookPattern whole-matcher trim', () => {
  it('keeps a trailing escaped space so `\\.env\\ ` matches "a.env "', () => {
    expect(matchesHookPattern('\\.env\\ ', 'a.env ')).toBe(true);
  });

  it('still requires the escaped space to be present in the subject', () => {
    expect(matchesHookPattern('\\.env\\ ', 'a.env')).toBe(false);
  });

  it('trims a trailing space after an even number of backslashes', () => {
    // `C:\\ ` pads an escaped backslash; the space is padding, not pattern.
    expect(matchesHookPattern('C:\\\\ ', 'C:\\')).toBe(true);
  });

  it('still trims plain padding around the whole matcher', () => {
    expect(matchesHookPattern(' read_.* ', 'read_file')).toBe(true);
  });

  it('keeps leading escaped whitespace (starts with a backslash)', () => {
    expect(matchesHookPattern('\\ read', ' read')).toBe(true);
  });
});
