/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { extractJsonFromText } from './extractJson.js';

describe('extractJsonFromText', () => {
  // ---- Pure JSON (no wrapping) ----
  it('returns pure JSON object as-is', () => {
    const json = '{"key": "value"}';
    expect(extractJsonFromText(json)).toBe(json);
  });

  it('returns pure JSON array as-is', () => {
    const json = '[1, 2, 3]';
    expect(extractJsonFromText(json)).toBe(json);
  });

  // ---- Level 1: ```json fence ----
  it('extracts from ```json fence', () => {
    const text = '```json\n{"key": "value"}\n```';
    expect(extractJsonFromText(text)).toBe('{"key": "value"}');
  });

  it('extracts from ```json fence with leading prose', () => {
    const text = 'Here is the result:\n```json\n{"key": "value"}\n```';
    expect(extractJsonFromText(text)).toBe('{"key": "value"}');
  });

  it('extracts from ```json fence with trailing text', () => {
    const text = '```json\n{"key": "value"}\n```\nSome explanation.';
    expect(extractJsonFromText(text)).toBe('{"key": "value"}');
  });

  it('handles ```json fence without closing fence', () => {
    const text = '```json\n{"key": "value"}';
    expect(extractJsonFromText(text)).toBe('{"key": "value"}');
  });

  // ---- Level 2: ``` generic fence ----
  it('extracts from generic ``` fence when content starts with {', () => {
    const text = '```\n{"key": "value"}\n```';
    expect(extractJsonFromText(text)).toBe('{"key": "value"}');
  });

  it('extracts from ``` fence with language tag', () => {
    const text = '```javascript\n{"key": "value"}\n```';
    expect(extractJsonFromText(text)).toBe('{"key": "value"}');
  });

  it('ignores generic fence when content is not JSON', () => {
    const text = '```\nsome code here\n```';
    // Level 2 returns null (not JSON-like), falls to Level 3 (no { or [)
    expect(extractJsonFromText(text)).toBe(text);
  });

  // ---- Level 3: Bracket-balanced extraction ----
  it('extracts JSON from prose + bare JSON', () => {
    const text = 'The answer is: {"key": "value"} and that is it.';
    expect(extractJsonFromText(text)).toBe('{"key": "value"}');
  });

  it('extracts nested JSON correctly', () => {
    const text = 'Result: {"a": {"b": "c"}, "d": [1, 2]}';
    expect(extractJsonFromText(text)).toBe('{"a": {"b": "c"}, "d": [1, 2]}');
  });

  it('handles strings containing braces', () => {
    const text = 'Output: {"msg": "hello {world}"}';
    expect(extractJsonFromText(text)).toBe('{"msg": "hello {world}"}');
  });

  it('extracts array from prose', () => {
    const text = 'List: [1, 2, 3] done.';
    expect(extractJsonFromText(text)).toBe('[1, 2, 3]');
  });

  // ---- Edge cases ----
  it('returns original text when no JSON found', () => {
    const text = 'This is just plain text.';
    expect(extractJsonFromText(text)).toBe(text);
  });

  it('returns original for empty string', () => {
    expect(extractJsonFromText('')).toBe('');
  });

  it('returns original for whitespace-only', () => {
    expect(extractJsonFromText('   ')).toBe('   ');
  });

  it('handles multi-line JSON in fence', () => {
    const text = '```json\n{\n  "key": "value",\n  "num": 42\n}\n```';
    const result = extractJsonFromText(text);
    expect(JSON.parse(result)).toEqual({ key: 'value', num: 42 });
  });
});
