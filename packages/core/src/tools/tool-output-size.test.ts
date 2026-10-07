/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  attachToolOutputProvenance,
  getToolOutputProvenance,
  measureToolOutput,
  pressureAwareToolBudget,
} from './tool-output-size.js';

describe('pressure-aware defaults', () => {
  it('uses absolute headroom and independently respects explicit/disabled settings', () => {
    expect(pressureAwareToolBudget(80000, 2000, 20000, false, false)).toEqual({
      chars: 80000,
      lines: 2000,
    });
    expect(pressureAwareToolBudget(80000, 2000, 1000, false, false)).toEqual({
      chars: 4000,
      lines: 500,
    });
    expect(pressureAwareToolBudget(12345, 321, 1000, true, true)).toEqual({
      chars: 12345,
      lines: 321,
    });
    expect(pressureAwareToolBudget(1000000, 2000, 30000, true, false)).toEqual({
      chars: 1000000,
      lines: 2000,
    });
    expect(pressureAwareToolBudget(Infinity, 2000, 1000, true, false)).toEqual({
      chars: Infinity,
      lines: 500,
    });
    expect(pressureAwareToolBudget(80000, Infinity, 1000, false, true)).toEqual(
      { chars: 4000, lines: Infinity },
    );
    expect(
      pressureAwareToolBudget(80000, 2000, undefined, false, false),
    ).toEqual({ chars: 80000, lines: 2000 });
  });
});

describe('result-size provenance', () => {
  it('measures string, structured function responses and media without counting base64 characters', () => {
    expect(measureToolOutput('abcd')).toEqual({ chars: 4, estimatedTokens: 1 });
    expect(measureToolOutput([{ text: 'abcd' }, { text: 'efgh' }])).toEqual({
      chars: 8,
      estimatedTokens: 2,
    });
    const size = measureToolOutput([
      {
        functionResponse: {
          name: 'mcp',
          response: { output: { rows: [1, 2] } },
        },
      },
    ]);
    expect(size.chars).toBe(JSON.stringify({ rows: [1, 2] }).length);
    expect(size.estimatedTokens).toBeGreaterThan(16);
    expect(
      measureToolOutput(
        [{ inlineData: { mimeType: 'image/png', data: 'a'.repeat(100000) } }],
        100,
      ),
    ).toEqual({ chars: 0, estimatedTokens: 100 });
  });

  it('survives live shallow copies, stays off the wire, and never invents restored raw size', () => {
    const provenance = {
      callId: 'anonymous',
      toolName: 'shell',
      promptId: 'p',
      toolType: 'native' as const,
      rawSize: { chars: 100, estimatedTokens: 25 },
      truncated: true,
    };
    const [part] = attachToolOutputProvenance(
      [
        {
          functionResponse: { name: 'shell', response: { output: 'preview' } },
        },
      ],
      provenance,
    );
    expect(getToolOutputProvenance({ ...part })).toBe(provenance);
    expect(JSON.parse(JSON.stringify(part))).toEqual({
      functionResponse: { name: 'shell', response: { output: 'preview' } },
    });
    expect(getToolOutputProvenance(structuredClone(part))).toBeUndefined();
  });
});
