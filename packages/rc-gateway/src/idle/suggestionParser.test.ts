/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { parseSuggestions } from './suggestionParser.js';

describe('parseSuggestions', () => {
  it('parses a clean JSON array of strings', () => {
    expect(parseSuggestions('["Run the tests","Show git status"]')).toEqual([
      'Run the tests',
      'Show git status',
    ]);
  });

  it('strips a ```json fenced block', () => {
    const raw = '```json\n["Stage the changes", "Write a commit"]\n```';
    expect(parseSuggestions(raw)).toEqual([
      'Stage the changes',
      'Write a commit',
    ]);
  });

  it('strips a bare ``` fence', () => {
    expect(parseSuggestions('```\n["Deploy"]\n```')).toEqual(['Deploy']);
  });

  it('recovers an array after a prose preamble', () => {
    const raw = 'Here are some suggestions:\n["Run tests", "Commit"]';
    expect(parseSuggestions(raw)).toEqual(['Run tests', 'Commit']);
  });

  it('drops a JSON OBJECT (not an array) to []', () => {
    // A whole-string parse yields an object → non-array → []; we do NOT
    // surprise-extract the inner array from an object.
    expect(parseSuggestions('{"suggestions":["a","b"]}')).toEqual([]);
  });

  it('skips non-string array elements', () => {
    expect(parseSuggestions('["keep", 42, null, {"x":1}, "alsokeep"]')).toEqual(
      ['keep', 'alsokeep'],
    );
  });

  it('returns [] for an empty array', () => {
    expect(parseSuggestions('[]')).toEqual([]);
  });

  it('returns [] for truncated / unterminated JSON', () => {
    expect(parseSuggestions('["Run the tes')).toEqual([]);
    expect(parseSuggestions('not json at all')).toEqual([]);
  });

  it('returns [] for non-string input', () => {
    expect(parseSuggestions(undefined)).toEqual([]);
    expect(parseSuggestions(42 as unknown as string)).toEqual([]);
  });

  it('caps the count and ellipsis-truncates over-long items, collapsing whitespace', () => {
    const long = 'x'.repeat(200);
    const out = parseSuggestions(
      JSON.stringify(['  spaced   out  ', long, 'three', 'four']),
      { max: 3, maxLen: 10 },
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toBe('spaced out');
    expect(out[1]).toBe('xxxxxxxxx…'); // 9 chars + ellipsis = maxLen 10
    expect(out[2]).toBe('three');
  });

  it('drops empty/whitespace-only items', () => {
    expect(parseSuggestions('["", "   ", "real"]')).toEqual(['real']);
  });
});
