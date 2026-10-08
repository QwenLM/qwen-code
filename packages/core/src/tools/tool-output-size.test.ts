/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { estimatePartChars } from '../services/compactionInputSlimming.js';
import {
  attachToolOutputProvenance,
  getToolOutputProvenance,
  measureToolOutput,
} from './tool-output-size.js';

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

  it('bills structured responses here, leaving the shared estimator at its wrapper floor', () => {
    const part = {
      functionResponse: { name: 'mcp', response: { output: { rows: [1, 2] } } },
    };
    // estimatePartChars backs compaction timing, tool-result retention,
    // microcompaction and /context, so this module must not widen it.
    expect(estimatePartChars(part, 100)).toBe(64);
    const size = measureToolOutput([part]);
    expect(size.chars).toBe(JSON.stringify({ rows: [1, 2] }).length);
    expect(size.estimatedTokens).toBe(Math.ceil((64 + size.chars) / 4));
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
