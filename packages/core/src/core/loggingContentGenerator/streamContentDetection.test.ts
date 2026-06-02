/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { GenerateContentResponse } from '@google/genai';
import { hasUserVisibleContent } from './streamContentDetection.js';

function chunkWithParts(parts: unknown[]): GenerateContentResponse {
  const r = new GenerateContentResponse();
  r.candidates = [
    {
      content: { role: 'model', parts: parts as never },
    },
  ];
  return r;
}

describe('hasUserVisibleContent', () => {
  it('returns true for non-empty text part', () => {
    expect(hasUserVisibleContent(chunkWithParts([{ text: 'hi' }]))).toBe(true);
  });

  it('returns false for empty text part', () => {
    expect(hasUserVisibleContent(chunkWithParts([{ text: '' }]))).toBe(false);
  });

  it('returns true for functionCall part', () => {
    expect(
      hasUserVisibleContent(
        chunkWithParts([{ functionCall: { name: 'read', args: {} } }]),
      ),
    ).toBe(true);
  });

  it('returns true for inlineData part', () => {
    expect(
      hasUserVisibleContent(
        chunkWithParts([
          { inlineData: { mimeType: 'image/png', data: 'abc' } },
        ]),
      ),
    ).toBe(true);
  });

  it('returns true for executableCode part', () => {
    expect(
      hasUserVisibleContent(
        chunkWithParts([
          { executableCode: { language: 'PYTHON', code: 'print(1)' } },
        ]),
      ),
    ).toBe(true);
  });

  it('returns true for thought / reasoning part with thought: true', () => {
    expect(hasUserVisibleContent(chunkWithParts([{ thought: true }]))).toBe(
      true,
    );
  });

  it('returns false for thought: false (explicit non-thought part)', () => {
    // Codebase convention: `thought` is a boolean flag where false means
    // "explicitly not a thought." A part with only `thought: false` and no
    // other content must not trigger TTFT.
    expect(hasUserVisibleContent(chunkWithParts([{ thought: false }]))).toBe(
      false,
    );
  });

  it('returns false for thought: undefined / missing (default non-thought)', () => {
    // A bare object without the `thought` key is the common case for non-thinking
    // chunks; must not match the thought branch.
    expect(hasUserVisibleContent(chunkWithParts([{}]))).toBe(false);
  });

  it('returns true when thought: true coexists with empty text', () => {
    // First Anthropic <thinking> chunk often arrives as { text: '', thought: true }.
    // Per design doc D1, "thought / reasoning content" is user-visible — TTFT fires.
    expect(
      hasUserVisibleContent(chunkWithParts([{ text: '', thought: true }])),
    ).toBe(true);
  });

  it('returns true when any part is user-visible (mixed)', () => {
    expect(
      hasUserVisibleContent(chunkWithParts([{ text: '' }, { text: 'hi' }])),
    ).toBe(true);
  });

  it('returns false for empty parts array', () => {
    expect(hasUserVisibleContent(chunkWithParts([]))).toBe(false);
  });

  it('returns false when candidates is missing', () => {
    const r = new GenerateContentResponse();
    expect(hasUserVisibleContent(r)).toBe(false);
  });

  it('returns false when content is missing', () => {
    const r = new GenerateContentResponse();
    r.candidates = [{}];
    expect(hasUserVisibleContent(r)).toBe(false);
  });

  it('returns false when parts is undefined', () => {
    const r = new GenerateContentResponse();
    r.candidates = [{ content: { role: 'model' } }];
    expect(hasUserVisibleContent(r)).toBe(false);
  });

  it('returns false for usage-only / role-only chunks', () => {
    const r = new GenerateContentResponse();
    r.candidates = [{ content: { role: 'model', parts: [] } }];
    r.usageMetadata = { totalTokenCount: 42 };
    expect(hasUserVisibleContent(r)).toBe(false);
  });

  it('handles parts that are non-objects defensively', () => {
    expect(
      hasUserVisibleContent(
        chunkWithParts([null, undefined, 'string', 42, { text: 'real' }]),
      ),
    ).toBe(true);
    expect(hasUserVisibleContent(chunkWithParts([null, undefined, 'x']))).toBe(
      false,
    );
  });
});
