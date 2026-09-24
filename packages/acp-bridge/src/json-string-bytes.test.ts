/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { estimateJsonStringBytes } from './json-string-bytes.js';

describe('estimateJsonStringBytes', () => {
  it('matches JSON.stringify UTF-8 bytes for every UTF-16 code unit', () => {
    const mismatches: Array<{ code: number; got: number; want: number }> = [];
    for (let code = 0; code <= 0xffff; code++) {
      const value = String.fromCharCode(code);
      const got = estimateJsonStringBytes(value, Number.MAX_SAFE_INTEGER);
      const want = Buffer.byteLength(JSON.stringify(value));
      if (got !== want) mismatches.push({ code, got, want });
    }
    expect({ count: mismatches.length, first: mismatches.slice(0, 5) }).toEqual(
      {
        count: 0,
        first: [],
      },
    );
  });

  it('matches JSON.stringify for paired surrogates and mixed escaping', () => {
    const samples = [
      '"\\\b\f\n\r\t',
      '\u0000\u001f',
      '\ud800',
      '\udc00',
      '\ud83d\ude00',
      'ASCII é 中 \ud83d\ude00 \ud800',
    ];
    for (const value of samples) {
      expect(estimateJsonStringBytes(value, Number.MAX_SAFE_INTEGER)).toBe(
        Buffer.byteLength(JSON.stringify(value)),
      );
    }
  });

  it('matches JSON.stringify for deterministic random strings', () => {
    let state = 0x5eed1234;
    const nextCodeUnit = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state & 0xffff;
    };
    for (let sample = 0; sample < 1000; sample++) {
      const length = nextCodeUnit() % 128;
      let value = '';
      for (let index = 0; index < length; index++) {
        value += String.fromCharCode(nextCodeUnit());
      }
      expect(estimateJsonStringBytes(value, Number.MAX_SAFE_INTEGER)).toBe(
        Buffer.byteLength(JSON.stringify(value)),
      );
    }
  });

  it('returns limit + 1 as soon as the encoded string exceeds the limit', () => {
    expect(estimateJsonStringBytes('\u0001'.repeat(100), 20)).toBe(21);
  });

  it('uses native byte counting for large strings that need no escaping', () => {
    const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt');
    try {
      const value = 'x'.repeat(8 * 1024 * 1024);
      expect(estimateJsonStringBytes(value, 1024)).toBe(1025);
      expect(estimateJsonStringBytes(value, Number.MAX_SAFE_INTEGER)).toBe(
        value.length + 2,
      );
      expect(charCodeAt).not.toHaveBeenCalled();
    } finally {
      charCodeAt.mockRestore();
    }
  });
});
