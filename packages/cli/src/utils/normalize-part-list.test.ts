/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { Part } from '@google/genai';
import { normalizePartList } from './normalize-part-list.js';

describe('normalizePartList', () => {
  it('should return empty array for null input', () => {
    expect(normalizePartList(null)).toEqual([]);
  });

  it('should return empty array for undefined input', () => {
    expect(normalizePartList(undefined as unknown as null)).toEqual([]);
  });

  it('should convert string to Part array', () => {
    const result = normalizePartList('test string');
    expect(result).toEqual([{ text: 'test string' }]);
  });

  it('should convert array of strings to Part array', () => {
    const result = normalizePartList(['hello', 'world']);
    expect(result).toEqual([{ text: 'hello' }, { text: 'world' }]);
  });

  it('should convert array of mixed strings and Parts to Part array', () => {
    const part: Part = { text: 'existing' };
    const result = normalizePartList(['new', part]);
    expect(result).toEqual([{ text: 'new' }, part]);
  });

  it('should convert single Part object to array', () => {
    const part: Part = { text: 'single part' };
    const result = normalizePartList(part);
    expect(result).toEqual([part]);
  });

  it('should handle empty array', () => {
    expect(normalizePartList([])).toEqual([]);
  });
});
