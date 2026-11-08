/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { Content } from '@google/genai';
import {
  estimateContentTokens,
  estimateContextTextTokens,
  estimatePromptTokens,
  getUsageOutputTokenCountForPromptEstimate,
} from './tokenEstimation.js';

const textContent = (text: string): Content => ({
  role: 'user',
  parts: [{ text }],
});

describe('estimateContextTextTokens', () => {
  it('uses the shared ASCII and CJK context-reporting heuristic', () => {
    expect(estimateContextTextTokens('abcdefgh')).toBe(2);
    expect(estimateContextTextTokens('中文')).toBe(3);
    expect(estimateContextTextTokens('abcd中')).toBe(3);
  });

  it('returns zero for empty text', () => {
    expect(estimateContextTextTokens('')).toBe(0);
  });
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

  it('includes the previous turn candidate tokens in the steady-state estimate', () => {
    const userEst = estimateContentTokens([user]);
    expect(estimatePromptTokens(history, user, 5000, 1200)).toBe(
      5000 + 1200 + userEst,
    );
  });

  it('keeps custom image-token estimates as the fifth argument', () => {
    const imageUser: Content = {
      role: 'user',
      parts: [{ inlineData: { mimeType: 'image/png', data: 'xxx' } }],
    };

    expect(estimatePromptTokens(history, imageUser, 5000, 1200, 1600)).toBe(
      5000 + 1200 + 1600,
    );
  });

  it('falls back to full estimate when lastPromptTokenCount is 0', () => {
    const fullEst = estimateContentTokens([...history, user]);
    expect(estimatePromptTokens(history, user, 0)).toBe(fullEst);
  });

  describe('conservative mode (window-clamp callers)', () => {
    it('defaults to non-conservative (identical to the 5-arg call) when omitted', () => {
      const userEst = estimateContentTokens([user]);
      expect(estimatePromptTokens(history, user, 5000, 1200)).toBe(
        estimatePromptTokens(history, user, 5000, 1200, undefined, false),
      );
      expect(
        estimatePromptTokens(history, user, 5000, 1200, undefined, false),
      ).toBe(5000 + 1200 + userEst);
    });

    it('inflates only the new-content term by 1.5x (ceil), not the API-authoritative running total', () => {
      const userEst = estimateContentTokens([user]);
      const conservativeEst = Math.ceil(userEst * 1.5);
      expect(
        estimatePromptTokens(history, user, 5000, 1200, undefined, true),
      ).toBe(5000 + 1200 + conservativeEst);
    });

    it('reproduces the real-world 2026-07-28 window-overflow scenario: a large CJK-heavy tool result under-counted by char/4 without conservative mode, corrected with it', () => {
      // Mirrors the KAT-Coder-V2.5-Dev / Nex-N2-mini real failures: several
      // parallel read_file results returning CJK-dense design docs pushed
      // the true prompt to ~35,619 tokens while char/4 (which does not
      // account for CJK density) estimated a smaller figure from
      // lastPromptTokenCount + this turn's new content alone, causing
      // maxOutputTokens to be clamped too loosely and
      // `prompt + max_tokens` to exceed the window by ~1 token in
      // production (see Research/Discovery_QwenCode-MainTurnOutputClamp-
      // SeparateBug_20260728.md in the ArgoStack repo).
      const cjkToolResult: Content = {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'read_file',
              // A realistic stand-in for a CJK-dense design doc chunk.
              response: { output: '设计文档章节内容。'.repeat(2000) },
            },
          },
        ],
      };
      const lastPromptTokenCount = 25_000;
      const nonConservative = estimatePromptTokens(
        [],
        cjkToolResult,
        lastPromptTokenCount,
        0,
      );
      const conservative = estimatePromptTokens(
        [],
        cjkToolResult,
        lastPromptTokenCount,
        0,
        undefined,
        true,
      );
      // Conservative mode must produce a strictly larger (safer, smaller
      // effective output budget) estimate for the same inputs.
      expect(conservative).toBeGreaterThan(nonConservative);
      expect(conservative).toBe(
        lastPromptTokenCount +
          Math.ceil(estimateContentTokens([cjkToolResult]) * 1.5),
      );
    });
  });
});

describe('getUsageOutputTokenCountForPromptEstimate', () => {
  it('uses totalTokenCount when available to avoid candidate/thought overlap ambiguity', () => {
    expect(
      getUsageOutputTokenCountForPromptEstimate({
        promptTokenCount: 100,
        totalTokenCount: 180,
        candidatesTokenCount: 70,
        thoughtsTokenCount: 50,
      }),
    ).toBe(80);
  });

  it('does not double-count thoughts that appear included in candidates', () => {
    expect(
      getUsageOutputTokenCountForPromptEstimate({
        promptTokenCount: 100,
        candidatesTokenCount: 150,
        thoughtsTokenCount: 120,
      }),
    ).toBe(150);
  });

  it('adds thoughts when they exceed candidates and are likely disjoint', () => {
    expect(
      getUsageOutputTokenCountForPromptEstimate({
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        thoughtsTokenCount: 120,
      }),
    ).toBe(170);
  });

  it('adds equal candidate and thought counts because equality does not prove overlap', () => {
    expect(
      getUsageOutputTokenCountForPromptEstimate({
        promptTokenCount: 100,
        candidatesTokenCount: 80,
        thoughtsTokenCount: 80,
      }),
    ).toBe(160);
  });

  it('clamps negative disjoint output token counts to zero', () => {
    expect(
      getUsageOutputTokenCountForPromptEstimate({
        promptTokenCount: 100,
        candidatesTokenCount: -10,
        thoughtsTokenCount: -5,
      }),
    ).toBe(0);
  });
});
