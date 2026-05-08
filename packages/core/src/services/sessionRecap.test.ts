/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { generateSessionRecap } from './sessionRecap.js';

const HISTORY: Content[] = [
  { role: 'user', parts: [{ text: 'Fix the bug' }] },
  { role: 'model', parts: [{ text: 'I will inspect it.' }] },
];

function makeConfig(generateContent: ReturnType<typeof vi.fn>): Config {
  return {
    getFastModel: vi.fn().mockReturnValue('qwen-fast'),
    getModel: vi.fn().mockReturnValue('qwen-main'),
    getGeminiClient: vi.fn().mockReturnValue({
      getChat: vi.fn().mockReturnValue({
        getHistory: vi.fn().mockReturnValue(HISTORY),
      }),
      generateContent,
    }),
  } as unknown as Config;
}

describe('generateSessionRecap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the fast model without thoughts for recap generation', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      candidates: [
        { content: { parts: [{ text: '<recap>Fixing a bug.</recap>' }] } },
      ],
    });
    const config = makeConfig(generateContent);
    const signal = new AbortController().signal;

    const result = await generateSessionRecap(config, signal);

    expect(result).toEqual({ text: 'Fixing a bug.', modelUsed: 'qwen-fast' });
    expect(generateContent).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        tools: [],
        maxOutputTokens: 300,
        temperature: 0.3,
        thinkingConfig: { includeThoughts: false },
      }),
      signal,
      'qwen-fast',
    );
  });
});
