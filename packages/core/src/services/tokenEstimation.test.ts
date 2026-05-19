/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { Content } from '@google/genai';
import {
  estimateContentTokens,
  estimatePromptTokens,
} from './tokenEstimation.js';

const textContent = (text: string): Content => ({
  role: 'user',
  parts: [{ text }],
});

describe('estimateContentTokens', () => {
  it('returns 0 for empty array', () => {
    expect(estimateContentTokens([])).toBe(0);
  });

  it('estimates plain text at ~chars/4', () => {
    // "hello world" = 11 chars → ceil(11/4) = 3
    expect(estimateContentTokens([textContent('hello world')])).toBe(3);
  });

  it('sums tokens across multiple messages', () => {
    const a = textContent('aaaa'); // 4/4 = 1
    const b = textContent('bbbbbbbb'); // 8/4 = 2
    expect(estimateContentTokens([a, b])).toBe(3);
  });

  it('estimates inlineData via imageTokenEstimate', () => {
    const c: Content = {
      role: 'user',
      parts: [{ inlineData: { mimeType: 'image/png', data: 'xxx' } }],
    };
    // estimateContentChars uses imageTokenEstimate * TOKEN_TO_CHAR_RATIO (4)
    // for inlineData, so estimateContentTokens divides back by 4 → 1600
    expect(estimateContentTokens([c], 1600)).toBe(1600);
  });

  it('estimates functionCall (json-dense) contributes some positive count', () => {
    const c: Content = {
      role: 'model',
      parts: [{ functionCall: { name: 'foo', args: { a: 1, b: 2 } } }],
    };
    const result = estimateContentTokens([c]);
    expect(result).toBeGreaterThan(0);
  });

  it('estimates functionResponse (nested parts) contributes some positive count', () => {
    // functionResponse takes a distinct branch in estimateContentChars
    // (nested parts walk + json-stringify fallback). Tool-heavy
    // conversations are where context grows fastest, so locking coverage
    // here protects the trigger from undercounting. (review #4168 R3.5)
    const c: Content = {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'tool',
            response: { result: 'data'.repeat(100) },
          },
        },
      ],
    };
    const result = estimateContentTokens([c]);
    expect(result).toBeGreaterThan(0);
  });
});

describe('estimatePromptTokens', () => {
  const history: Content[] = [
    textContent('older message a'),
    textContent('older message b'),
  ];
  const user = textContent('current user message');

  it('uses lastPromptTokenCount + user-message estimate when count > 0', () => {
    const userEst = estimateContentTokens([user]);
    expect(estimatePromptTokens(history, user, 5000)).toBe(5000 + userEst);
  });

  it('falls back to full estimate when lastPromptTokenCount is 0', () => {
    const fullEst = estimateContentTokens([...history, user]);
    expect(estimatePromptTokens(history, user, 0)).toBe(fullEst);
  });

  it('adds lastCandidatesTokenCount in the steady-state branch (R10.1)', () => {
    // R10.1: `lastPromptTokenCount` from the previous turn covers the
    // input sent on that turn but NOT the model response that has since
    // been appended to history. Without the candidates term, the
    // estimate lags by one response (typically 500–5000 tokens), which
    // matters when the hard tier sits only HARD_BUFFER (~3K) from the
    // window edge — the rescue fires late and the API call overflows.
    const userEst = estimateContentTokens([user]);
    const lastPrompt = 5000;
    const lastCandidates = 800;
    expect(
      estimatePromptTokens(history, user, lastPrompt, 1600, lastCandidates),
    ).toBe(lastPrompt + lastCandidates + userEst);
  });

  it('defaults lastCandidatesTokenCount to 0 for backward-compatible callers', () => {
    // The new param is optional with default 0 so existing callers
    // (none-yet outside geminiChat) keep their pre-R10 behavior. The
    // missing-response under-count is documented; the hard-rescue path
    // upstream now plumbs the real value.
    const userEst = estimateContentTokens([user]);
    expect(estimatePromptTokens(history, user, 5000)).toBe(5000 + userEst);
  });
});
