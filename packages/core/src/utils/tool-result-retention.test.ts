/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { Content } from '@google/genai';
import {
  DEFAULT_IMAGE_TOKEN_ESTIMATE,
  TOKEN_TO_CHAR_RATIO,
} from '../services/compactionInputSlimming.js';
import {
  OVERSIZED_TOOL_RESULT_THRESHOLD_CHARS,
  analyzeToolResultRetention,
} from './tool-result-retention.js';

// Mirrors `createFunctionResponsePart`: results keep media on nested parts.
const PARTS_KEY = 'parts';
// `estimatePartChars` adds a fixed wrapper floor per functionResponse part.
const WRAPPER_FLOOR_CHARS = 64;

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
    // String outputs are measured as raw chars (no JSON-escaping inflation).
    const small = 'x'.repeat(100);
    const medium = 'y'.repeat(500);
    const stats = analyzeToolResultRetention([
      toolResultContent(small),
      toolResultContent(medium),
      textContent('noise'),
    ]);
    expect(stats.toolResultCount).toBe(2);
    expect(stats.totalChars).toBe(
      small.length + medium.length + 2 * WRAPPER_FLOOR_CHARS,
    );
    expect(stats.largestResultChars).toBe(medium.length + WRAPPER_FLOOR_CHARS);
    expect(stats.oversizedResultCount).toBe(0);
  });

  it('measures newline-dense outputs by raw chars, not serialized size', () => {
    // Regression: JSON.stringify doubles every "\n" and adds framing, which
    // inflated compliant shell outputs past the threshold (review R1-2).
    const dense = 'line\n'.repeat(5980); // 29_900 raw chars
    const stats = analyzeToolResultRetention([toolResultContent(dense)]);
    expect(stats.largestResultChars).toBe(29_900 + WRAPPER_FLOOR_CHARS);
    expect(stats.oversizedResultCount).toBe(0);
  });

  it('counts oversized results strictly above the default threshold', () => {
    const oversized = 'z'.repeat(OVERSIZED_TOOL_RESULT_THRESHOLD_CHARS + 1);
    const stats = analyzeToolResultRetention([
      toolResultContent(oversized),
      toolResultContent('small'),
    ]);
    expect(stats.oversizedResultCount).toBe(1);
  });

  it('does not flag a result measured at exactly the threshold (strict >)', () => {
    const exact = 'z'.repeat(
      OVERSIZED_TOOL_RESULT_THRESHOLD_CHARS - WRAPPER_FLOOR_CHARS,
    );
    const stats = analyzeToolResultRetention([toolResultContent(exact)]);
    expect(stats.oversizedResultCount).toBe(0);
  });

  it('supports a custom threshold', () => {
    const stats = analyzeToolResultRetention([toolResultContent('abcdef')], {
      thresholdChars: 5,
    });
    expect(stats.oversizedThresholdChars).toBe(5);
    expect(stats.oversizedResultCount).toBe(1);
  });

  it('compares each result against its own tool budget when a resolver is supplied', () => {
    const budgets: Record<string, number> = {
      big_budget_tool: 500_000,
      small_budget_tool: 100,
    };
    const stats = analyzeToolResultRetention(
      [
        // Compliant high-budget result (e.g. MCP): not flagged.
        toolResultContent('m'.repeat(60_000), 'big_budget_tool'),
        // Exceeds its own small budget: flagged.
        toolResultContent('s'.repeat(200), 'small_budget_tool'),
        // Unknown tool falls back to the default threshold: not flagged.
        toolResultContent('u'.repeat(500), 'unknown_tool'),
      ],
      { resolveToolBudgetChars: (name) => budgets[name] },
    );
    expect(stats.oversizedResultCount).toBe(1);
  });

  it('never flags results from tools with an infinite budget', () => {
    const huge = 'r'.repeat(100_000);
    const stats = analyzeToolResultRetention([toolResultContent(huge)], {
      resolveToolBudgetChars: () => Infinity,
    });
    expect(stats.oversizedResultCount).toBe(0);
    expect(stats.totalChars).toBe(huge.length + WRAPPER_FLOOR_CHARS);
  });

  it('handles tool results without a response payload', () => {
    const stats = analyzeToolResultRetention([
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'shell', response: undefined } }],
      },
    ]);
    expect(stats.toolResultCount).toBe(1);
    // No payload at all: only the wrapper floor counts.
    expect(stats.totalChars).toBe(WRAPPER_FLOOR_CHARS);
  });

  it('handles contents with no parts', () => {
    const stats = analyzeToolResultRetention([
      { role: 'user' },
      toolResultContent('ok'),
    ]);
    expect(stats.toolResultCount).toBe(1);
  });

  it('bills nested media parts at the image estimate, not base64 length', () => {
    const stats = analyzeToolResultRetention([
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'read_file',
              response: { output: 'img' },
              [PARTS_KEY]: [{ inlineData: {} }],
            },
          },
        ],
      },
    ]);
    const imageChars = DEFAULT_IMAGE_TOKEN_ESTIMATE * TOKEN_TO_CHAR_RATIO;
    expect(stats.totalChars).toBe(
      'img'.length + imageChars + WRAPPER_FLOOR_CHARS,
    );
  });

  it('does not throw on unserializable structured payloads', () => {
    const circular: Record<string, unknown> = { content: [{ text: 'data' }] };
    circular['self'] = circular;
    const stats = analyzeToolResultRetention([
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'mcp', response: circular } }],
      },
    ]);
    // No string output and no nested parts: only the wrapper floor counts.
    expect(stats.toolResultCount).toBe(1);
    expect(stats.totalChars).toBe(WRAPPER_FLOOR_CHARS);
  });
});
