/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { ndjsonSafeStringify } from './ndjson-safe-stringify.js';

describe('ndjsonSafeStringify', () => {
  it('序列化普通对象', () => {
    const obj = { type: 'message', content: 'hello' };
    expect(ndjsonSafeStringify(obj)).toBe(
      '{"type":"message","content":"hello"}',
    );
  });

  it('转义 U+2028 LINE SEPARATOR', () => {
    const obj = { text: 'line1\u2028line2' };
    const result = ndjsonSafeStringify(obj);
    // 原始字符不应出现
    expect(result).not.toContain('\u2028');
    // 应包含转义形式
    expect(result).toContain('\\u2028');
    // 解析回来应还原
    expect(JSON.parse(result)).toEqual(obj);
  });

  it('转义 U+2029 PARAGRAPH SEPARATOR', () => {
    const obj = { text: 'para1\u2029para2' };
    const result = ndjsonSafeStringify(obj);
    expect(result).not.toContain('\u2029');
    expect(result).toContain('\\u2029');
    expect(JSON.parse(result)).toEqual(obj);
  });

  it('同时转义 U+2028 和 U+2029', () => {
    const obj = { text: 'a\u2028b\u2029c\u2028d' };
    const result = ndjsonSafeStringify(obj);
    expect(result).not.toContain('\u2028');
    expect(result).not.toContain('\u2029');
    expect(JSON.parse(result)).toEqual(obj);
  });

  it('不含特殊字符时不改变输出', () => {
    const obj = { a: 1, b: 'normal\ntext\ttab' };
    expect(ndjsonSafeStringify(obj)).toBe(JSON.stringify(obj));
  });

  it('处理 null 和原始类型', () => {
    expect(ndjsonSafeStringify(null)).toBe('null');
    expect(ndjsonSafeStringify(42)).toBe('42');
    expect(ndjsonSafeStringify('hello')).toBe('"hello"');
    expect(ndjsonSafeStringify(true)).toBe('true');
  });

  it('输出不包含换行符（可安全用于 NDJSON）', () => {
    const obj = { type: 'system', content: 'init\u2028\u2029' };
    const result = ndjsonSafeStringify(obj);
    // NDJSON 要求每条消息占一行，输出中不应有 \n \r U+2028 U+2029
    expect(result).not.toMatch(/[\n\r\u2028\u2029]/);
  });
});
