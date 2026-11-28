/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { escapeAtSymbols } from './atMentionUtils.js';

describe('escapeAtSymbols', () => {
  it('escapes a bare @ symbol', () => {
    expect(escapeAtSymbols('test@domain.com')).toBe('test\\@domain.com');
  });

  it('escapes a leading @ symbol', () => {
    expect(escapeAtSymbols('@scope/pkg')).toBe('\\@scope/pkg');
  });

  it('escapes multiple @ symbols', () => {
    expect(escapeAtSymbols('a@b and c@d')).toBe('a\\@b and c\\@d');
  });

  it('does not double-escape an already escaped @', () => {
    expect(escapeAtSymbols('test\\@domain.com')).toBe('test\\@domain.com');
  });

  it('returns text with no @ unchanged', () => {
    expect(escapeAtSymbols('hello world')).toBe('hello world');
  });

  it('returns empty string unchanged', () => {
    expect(escapeAtSymbols('')).toBe('');
  });
});
