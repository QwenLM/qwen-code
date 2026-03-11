/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  decodeUnicodeEscapedString,
  shouldUseUnicodeEscapedPaths,
} from './unicodeEscaping.js';

describe('unicodeEscaping', () => {
  it('should detect affected qwen models', () => {
    expect(shouldUseUnicodeEscapedPaths('qwen3.5-plus')).toBe(true);
    expect(shouldUseUnicodeEscapedPaths('qwen3.5-397B-A17B')).toBe(true);
    expect(shouldUseUnicodeEscapedPaths('qwen3-coder-plus')).toBe(false);
  });

  it('should decode single-escaped unicode text', () => {
    expect(decodeUnicodeEscapedString('\\u4e2d\\u6587-1.md')).toBe('中文-1.md');
  });

  it('should decode double-escaped unicode text', () => {
    expect(decodeUnicodeEscapedString('\\\\u4e2d\\\\u6587-1.md')).toBe(
      '中文-1.md',
    );
  });

  it('should leave plain ascii text unchanged', () => {
    expect(decodeUnicodeEscapedString('/tmp/test/file-1.md')).toBe(
      '/tmp/test/file-1.md',
    );
  });
});
