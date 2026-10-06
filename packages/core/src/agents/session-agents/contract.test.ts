/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { isBlankAgentText } from './contract.js';

describe('isBlankAgentText', () => {
  it('treats whitespace and invisible characters as no text', () => {
    expect(isBlankAgentText('')).toBe(true);
    expect(isBlankAgentText(' \n\t ')).toBe(true);
    // What real squad leaders answered with: `trim()` keeps it.
    expect('\u200B'.trim()).toBe('\u200B');
    expect(isBlankAgentText('\u200B')).toBe(true);
    expect(isBlankAgentText(' \u200B\u200C\u200D\u2060\uFEFF\u00AD \n')).toBe(
      true,
    );
  });

  it('keeps any visible character', () => {
    expect(isBlankAgentText('\u200Bok')).toBe(false);
    expect(isBlankAgentText('.')).toBe(false);
    expect(isBlankAgentText('\u200B@alice\u200B')).toBe(false);
  });
});
