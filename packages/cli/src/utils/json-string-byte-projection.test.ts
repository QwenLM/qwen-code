/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  jsonStringJsonByteLength,
  projectJsonStringToByteBudget,
} from './json-string-byte-projection.js';

const BUDGET = 65_536;
const MARKER = '\n[... truncated for test transport ...]\n';

function jsonBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

describe('JSON string byte projection', () => {
  it('matches native JSON string byte accounting for Unicode and escapes', () => {
    const samples = [
      '',
      'plain ASCII',
      '"\\\n\b\f\r\t',
      '\0\u0001\u001f',
      '汉字',
      '😀',
      '\ud800',
      '\udc00',
      '\u2028\u2029',
      '\u007f\u0080\u07ff\u0800',
    ];

    for (const sample of samples) {
      expect(jsonStringJsonByteLength(sample)).toBe(jsonBytes(sample));
    }
  });

  it('matches native JSON byte accounting under fixed-seed fuzzing', () => {
    const atoms = [
      'a',
      '"',
      '\\',
      '\n',
      '\0',
      '汉',
      '😀',
      '\ud800',
      '\udc00',
      '\u2028',
    ];
    let state = 0x5eed1234;
    const random = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };

    for (let sampleIndex = 0; sampleIndex < 250; sampleIndex++) {
      const length = random() % 200;
      let value = '';
      for (let index = 0; index < length; index++) {
        value += atoms[random() % atoms.length];
      }
      expect(jsonStringJsonByteLength(value)).toBe(jsonBytes(value));
    }
  });

  it.each([65_535, 65_536, 65_537])(
    'enforces the JSON string boundary at %i bytes',
    (targetBytes) => {
      const value = 'x'.repeat(targetBytes - 2);
      const projected = projectJsonStringToByteBudget(value, BUDGET, MARKER);

      expect(jsonBytes(projected)).toBeLessThanOrEqual(BUDGET);
      expect(projected === value).toBe(targetBytes <= BUDGET);
    },
  );

  it.each([
    ['CJK', '汉'.repeat(100_000)],
    ['JSON escapes', '"\\\n\0'.repeat(30_000)],
    ['lone high surrogate', '\ud800'.repeat(100_000)],
    ['lone low surrogate', '\udc00'.repeat(100_000)],
  ])(
    'projects oversized %s strings within the exact budget',
    (_name, value) => {
      const projected = projectJsonStringToByteBudget(value, BUDGET, MARKER);

      expect(jsonBytes(projected)).toBeLessThanOrEqual(BUDGET);
      expect(projected).toContain(MARKER);
      expect(projected).not.toBe(value);
    },
  );

  it('keeps an approximately 20/80 head and tail preview', () => {
    const value =
      'HEAD-' + 'h'.repeat(200_000) + '-' + 't'.repeat(200_000) + '-TAIL';
    const projected = projectJsonStringToByteBudget(value, BUDGET, MARKER);
    const [head, tail] = projected.split(MARKER);

    expect(projected.startsWith('HEAD-')).toBe(true);
    expect(projected.endsWith('-TAIL')).toBe(true);
    expect(tail.length).toBeGreaterThan(head.length * 3.9);
    expect(tail.length).toBeLessThan(head.length * 4.1);
  });

  it.each(['-tail', '-tail!!'])(
    'never splits valid surrogate pairs with suffix alignment %s',
    (suffix) => {
      const value = 'head-' + '😀'.repeat(100_000) + suffix;
      const projected = projectJsonStringToByteBudget(value, BUDGET, MARKER);

      expect(projected).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
      expect(projected).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/u);
      expect(projected.endsWith(suffix)).toBe(true);
      expect(jsonBytes(projected)).toBeLessThanOrEqual(BUDGET);
    },
  );

  it('accounts for the marker and handles a budget smaller than the marker', () => {
    const value = 'abcdef';
    const projected = projectJsonStringToByteBudget(value, 5, MARKER);

    expect(projected).toBe('abc');
    expect(jsonBytes(projected)).toBe(5);
  });

  it('is idempotent and leaves small strings unchanged', () => {
    const small = 'small';
    const large = 'head-' + 'x'.repeat(100_000) + '-tail';
    const once = projectJsonStringToByteBudget(large, BUDGET, MARKER);

    expect(projectJsonStringToByteBudget(small, BUDGET, MARKER)).toBe(small);
    expect(projectJsonStringToByteBudget(once, BUDGET, MARKER)).toBe(once);
  });
});
