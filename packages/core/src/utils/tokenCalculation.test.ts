/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { estimateTokenCountSync } from './tokenCalculation.js';
import type { Part } from '@google/genai';

describe('estimateTokenCountSync', () => {
  it('should estimate tokens for plain text', () => {
    const parts: Part[] = [{ text: 'hello world' }];
    const tokens = estimateTokenCountSync(parts);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(20);
  });

  it('should estimate higher tokens for non-ASCII text', () => {
    const ascii: Part[] = [{ text: 'a'.repeat(100) }];
    const nonAscii: Part[] = [{ text: '日'.repeat(100) }];
    const asciiTokens = estimateTokenCountSync(ascii);
    const nonAsciiTokens = estimateTokenCountSync(nonAscii);
    expect(nonAsciiTokens).toBeGreaterThan(asciiTokens);
  });

  it('should estimate tokens for function response with string output', () => {
    const parts: Part[] = [
      {
        functionResponse: {
          name: 'read_file',
          response: { output: 'file contents here' },
        },
      },
    ];
    const tokens = estimateTokenCountSync(parts);
    expect(tokens).toBeGreaterThan(0);
  });

  it('should handle empty parts array', () => {
    expect(estimateTokenCountSync([])).toBe(0);
  });

  it('should use fast path for very long strings', () => {
    const longText = 'x'.repeat(200_000);
    const parts: Part[] = [{ text: longText }];
    const tokens = estimateTokenCountSync(parts);
    expect(tokens).toBeGreaterThan(40_000);
    expect(tokens).toBeLessThan(60_000);
  });

  it('should estimate image tokens', () => {
    const parts: Part[] = [
      { inlineData: { mimeType: 'image/png', data: 'base64data' } },
    ];
    const tokens = estimateTokenCountSync(parts);
    expect(tokens).toBe(3000);
  });

  it('should respect max recursion depth', () => {
    const parts: Part[] = [{ text: 'test' }];
    const tokens = estimateTokenCountSync(parts, 10);
    expect(tokens).toBe(0);
  });

  it('should handle multiple parts', () => {
    const parts: Part[] = [
      { text: 'hello' },
      { text: 'world' },
      {
        functionResponse: {
          name: 'tool',
          response: { output: 'result' },
        },
      },
    ];
    const tokens = estimateTokenCountSync(parts);
    expect(tokens).toBeGreaterThan(0);
  });
});
