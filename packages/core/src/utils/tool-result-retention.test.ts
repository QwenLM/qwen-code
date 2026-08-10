/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { Content } from '@google/genai';
import {
  OVERSIZED_TOOL_RESULT_THRESHOLD_CHARS,
  analyzeToolResultRetention,
} from './tool-result-retention.js';

function toolResultContent(output: string, name = 'shell'): Content {
  return {
    role: 'user',
    parts: [{ functionResponse: { name, response: { output } } }],
  };
}

function textContent(text: string): Content {
  return { role: 'model', parts: [{ text }] };
}

describe('analyzeToolResultRetention', () => {
  it('returns zeroed stats for an empty history', () => {
    const stats = analyzeToolResultRetention([]);
    expect(stats).toEqual({
      toolResultCount: 0,
      totalChars: 0,
      largestResultChars: 0,
      oversizedResultCount: 0,
      oversizedThresholdChars: OVERSIZED_TOOL_RESULT_THRESHOLD_CHARS,
    });
  });

  it('ignores non-tool-result parts', () => {
    const stats = analyzeToolResultRetention([
      textContent('hello'),
      { role: 'user', parts: [{ text: 'a prompt' }] },
    ]);
    expect(stats.toolResultCount).toBe(0);
    expect(stats.totalChars).toBe(0);
  });

  it('aggregates size and counts across tool results', () => {
    const small = 'x'.repeat(100);
    const medium = 'y'.repeat(500);
    const stats = analyzeToolResultRetention([
      toolResultContent(small),
      toolResultContent(medium),
      textContent('noise'),
    ]);
    expect(stats.toolResultCount).toBe(2);
    expect(stats.totalChars).toBe(
      JSON.stringify({ output: small }).length +
        JSON.stringify({ output: medium }).length,
    );
    expect(stats.largestResultChars).toBe(
      JSON.stringify({ output: medium }).length,
    );
    expect(stats.oversizedResultCount).toBe(0);
  });

  it('counts oversized results above the default threshold', () => {
    const oversized = 'z'.repeat(OVERSIZED_TOOL_RESULT_THRESHOLD_CHARS + 1);
    const stats = analyzeToolResultRetention([
      toolResultContent(oversized),
      toolResultContent('small'),
    ]);
    expect(stats.oversizedResultCount).toBe(1);
  });

  it('supports a custom threshold', () => {
    const stats = analyzeToolResultRetention([toolResultContent('abcdef')], {
      thresholdChars: 5,
    });
    expect(stats.oversizedThresholdChars).toBe(5);
    expect(stats.oversizedResultCount).toBe(1);
  });

  it('handles tool results without a response payload', () => {
    const stats = analyzeToolResultRetention([
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'shell', response: undefined } }],
      },
    ]);
    expect(stats.toolResultCount).toBe(1);
    expect(stats.totalChars).toBe(0);
  });

  it('handles contents with no parts', () => {
    const stats = analyzeToolResultRetention([
      { role: 'user' },
      toolResultContent('ok'),
    ]);
    expect(stats.toolResultCount).toBe(1);
  });

  it('measures structured (Part[]) responses by their serialized size', () => {
    const stats = analyzeToolResultRetention([
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'mcp_tool',
              response: { content: [{ text: 'structured output' }] },
            },
          },
        ],
      },
    ]);
    expect(stats.totalChars).toBe(
      JSON.stringify({ content: [{ text: 'structured output' }] }).length,
    );
  });

  it('does not throw on circular response payloads', () => {
    const circular: Record<string, unknown> = { output: 'data' };
    circular['self'] = circular;
    const stats = analyzeToolResultRetention([
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'shell', response: circular } }],
      },
    ]);
    expect(stats.toolResultCount).toBe(1);
    expect(stats.totalChars).toBe(0);
  });
});
