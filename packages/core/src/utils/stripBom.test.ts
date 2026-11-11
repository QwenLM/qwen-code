/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { stripBOM } from './stripBom.js';

describe('stripBOM', () => {
  it('strips UTF-8 BOM from start of string', () => {
    expect(stripBOM('\uFEFF{"key": "value"}')).toBe('{"key": "value"}');
  });

  it('returns string unchanged when no BOM', () => {
    expect(stripBOM('{"key": "value"}')).toBe('{"key": "value"}');
  });

  it('returns empty string unchanged', () => {
    expect(stripBOM('')).toBe('');
  });

  it('strips only leading BOM, preserves BOM elsewhere', () => {
    expect(stripBOM('\uFEFFhello\uFEFFworld')).toBe('hello\uFEFFworld');
  });

  it('allows JSON.parse to succeed after stripping BOM', () => {
    const withBom = '\uFEFF{"name": "test"}';
    expect(() => JSON.parse(withBom)).toThrow();
    expect(JSON.parse(stripBOM(withBom))).toEqual({ name: 'test' });
  });
});
