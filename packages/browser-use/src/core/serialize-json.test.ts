/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { serializeJson } from './serialize-json.js';

describe('evaluation JSON serialization', () => {
  it('supports cross-realm JSON data, null prototypes, and repeated references', () => {
    const record = Object.assign(Object.create(null), { value: 1 });
    const data = vm.runInNewContext('({ list: [true, null, "text", 1.5] })');
    expect(JSON.parse(serializeJson([data, record, record]))).toEqual([
      { list: [true, null, 'text', 1.5] },
      { value: 1 },
      { value: 1 },
    ]);
  });

  it('rejects cycles, sparse arrays, extra array properties, and enumerable symbols', () => {
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    for (const value of [
      cycle,
      new Array(2),
      Object.assign([1], { extra: true }),
      { [Symbol('value')]: 1 },
    ]) {
      expect(() => serializeJson(value)).toThrow('JSON-serializable');
    }
  });

  it('reads getters once and never invokes a toJSON hook', () => {
    let reads = 0;
    const value = {
      get answer() {
        reads++;
        return reads === 1 ? 42 : NaN;
      },
    };
    Object.defineProperty(value, 'toJSON', { value: () => 'wrong' });
    expect(serializeJson(value)).toBe('{"answer":42}');
    expect(reads).toBe(1);
    expect(() => serializeJson({ toJSON: () => 1 })).toThrow(
      'JSON-serializable',
    );
  });

  it('keeps the injected encoder independent of its module and array iterators', () => {
    const encode = vm.runInNewContext(
      `(${serializeJson.toString()})`,
    ) as typeof serializeJson;
    const data = [1, 2];
    Object.defineProperty(data, Symbol.iterator, {
      value: () => [9][Symbol.iterator](),
    });
    expect(encode(data)).toBe('[1,2]');
    expect(() => encode({ nested: Infinity })).toThrow('JSON-serializable');
  });
});
