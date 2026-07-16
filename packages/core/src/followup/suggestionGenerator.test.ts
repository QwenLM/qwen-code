/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { Config } from '../config/config.js';

const { mockGetCacheSafeParams, mockRunForkedAgent, mockRunSideQuery } =
  vi.hoisted(() => ({
    mockGetCacheSafeParams: vi.fn(),
    mockRunForkedAgent: vi.fn(),
    mockRunSideQuery: vi.fn(),
  }));

vi.mock('../utils/forkedAgent.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/forkedAgent.js')>();
  return {
    ...actual,
    getCacheSafeParams: mockGetCacheSafeParams,
    runForkedAgent: mockRunForkedAgent,
  };
});

vi.mock('../utils/sideQuery.js', () => ({
  runSideQuery: mockRunSideQuery,
}));

import {
  generatePromptSuggestion,
  getFilterReason,
  shouldFilterSuggestion,
} from './suggestionGenerator.js';

const conversationHistory: Content[] = [
  { role: 'user', parts: [{ text: 'fix this' }] },
  { role: 'model', parts: [{ text: 'I fixed it.' }] },
  { role: 'user', parts: [{ text: 'anything else?' }] },
  { role: 'model', parts: [{ text: 'You could run tests.' }] },
];

describe('generatePromptSuggestion', () => {
  beforeEach(() => {
    mockGetCacheSafeParams.mockReset();
    mockRunForkedAgent.mockReset();
    mockRunSideQuery.mockReset();
  });

  it('removes top-level and tool-nested media before a side query', async () => {
    const historyWithMedia: Content[] = [
      {
        role: 'user',
        parts: [
          { text: 'inspect these' },
          { inlineData: { mimeType: 'image/png', data: 'raw-image' } },
          {
            fileData: {
              mimeType: 'application/pdf',
              fileUri: 'file:///private/report.pdf',
            },
          },
        ],
      },
      { role: 'model', parts: [{ text: 'I inspected them.' }] },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'read_file',
              response: { output: 'image loaded' },
              parts: [
                {
                  inlineData: {
                    mimeType: 'image/jpeg',
                    data: 'raw-tool-image',
                  },
                },
              ],
            },
          },
        ],
      },
      { role: 'model', parts: [{ text: 'Done.' }] },
    ];
    mockRunSideQuery.mockResolvedValue({ text: 'run tests' });
    const config = {
      getFastModel: vi.fn(() => 'fast-model'),
      getModel: vi.fn(() => 'main-model'),
    } as unknown as Config;

    await generatePromptSuggestion(
      config,
      historyWithMedia,
      new AbortController().signal,
    );

    const options = mockRunSideQuery.mock.calls[0]?.[1] as {
      contents: Content[];
    };
    const serialized = JSON.stringify(options.contents);
    expect(serialized).toContain('[image: image/png]');
    expect(serialized).toContain('[image: image/jpeg]');
    expect(serialized).toContain('[document: application/pdf]');
    expect(serialized).not.toContain('raw-image');
    expect(serialized).not.toContain('raw-tool-image');
    expect(serialized).not.toContain('file:///private/report.pdf');
    expect(JSON.stringify(historyWithMedia)).toContain('raw-tool-image');
  });

  it('removes media from cache-shared history without mutating the snapshot', async () => {
    const cacheHistory: Content[] = [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/png', data: 'cached-image' } },
        ],
      },
      { role: 'model', parts: [{ text: 'Looked.' }] },
      { role: 'user', parts: [{ text: 'continue' }] },
      { role: 'model', parts: [{ text: 'Finished.' }] },
    ];
    const cacheSafe = {
      generationConfig: {},
      history: cacheHistory,
      model: 'main-model',
      version: 1,
    };
    mockGetCacheSafeParams.mockReturnValue(cacheSafe);
    mockRunForkedAgent.mockResolvedValue({
      text: null,
      jsonResult: { suggestion: 'run tests' },
      usage: { inputTokens: 10, outputTokens: 3, cacheHitTokens: 0 },
    });
    const config = {
      getFastModel: vi.fn(() => undefined),
      getModel: vi.fn(() => 'main-model'),
    } as unknown as Config;

    await generatePromptSuggestion(
      config,
      conversationHistory,
      new AbortController().signal,
      { enableCacheSharing: true },
    );

    const call = mockRunForkedAgent.mock.calls[0]?.[0] as {
      cacheSafeParams: { history: Content[] };
    };
    const serialized = JSON.stringify(call.cacheSafeParams.history);
    expect(serialized).toContain('[image: image/png]');
    expect(serialized).not.toContain('cached-image');
    expect(JSON.stringify(cacheSafe.history)).toContain('cached-image');
  });

  it('passes cache-safe model in cache mode when no explicit or fast model exists', async () => {
    mockGetCacheSafeParams.mockReturnValue({
      generationConfig: {},
      history: conversationHistory,
      model: 'main-model',
      version: 1,
    });
    mockRunForkedAgent.mockResolvedValue({
      text: null,
      jsonResult: { suggestion: 'run tests' },
      usage: { inputTokens: 10, outputTokens: 3, cacheHitTokens: 5 },
    });
    const config = {
      getFastModel: vi.fn(() => undefined),
      getModel: vi.fn(() => 'main-model'),
    } as unknown as Config;

    await generatePromptSuggestion(
      config,
      conversationHistory,
      new AbortController().signal,
      { enableCacheSharing: true },
    );

    expect(mockRunForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'main-model' }),
    );
  });

  it('passes the fast model in cache mode when one is configured', async () => {
    mockGetCacheSafeParams.mockReturnValue({
      generationConfig: {},
      history: conversationHistory,
      model: 'main-model',
      version: 1,
    });
    mockRunForkedAgent.mockResolvedValue({
      text: null,
      jsonResult: { suggestion: 'run tests' },
      usage: { inputTokens: 10, outputTokens: 3, cacheHitTokens: 5 },
    });
    const config = {
      getFastModel: vi.fn(() => 'openai:fast-model'),
      getModel: vi.fn(() => 'main-model'),
    } as unknown as Config;

    await generatePromptSuggestion(
      config,
      conversationHistory,
      new AbortController().signal,
      { enableCacheSharing: true },
    );

    expect(mockRunForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'openai:fast-model' }),
    );
  });
  it('passes preserveTools: true for Anthropic prompt-cache sharing', async () => {
    mockGetCacheSafeParams.mockReturnValue({
      generationConfig: {},
      history: conversationHistory,
      model: 'main-model',
      version: 1,
    });
    mockRunForkedAgent.mockResolvedValue({
      text: null,
      jsonResult: { suggestion: 'run tests' },
      usage: { inputTokens: 10, outputTokens: 3, cacheHitTokens: 5 },
    });
    const config = {
      getFastModel: vi.fn(() => undefined),
      getModel: vi.fn(() => 'main-model'),
    } as unknown as Config;

    await generatePromptSuggestion(
      config,
      conversationHistory,
      new AbortController().signal,
      { enableCacheSharing: true },
    );

    expect(mockRunForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ preserveTools: true }),
    );
  });

  it('passes preserveTools: false when fast model differs from cache-safe model', async () => {
    mockGetCacheSafeParams.mockReturnValue({
      generationConfig: {},
      history: conversationHistory,
      model: 'main-model',
      version: 1,
    });
    mockRunForkedAgent.mockResolvedValue({
      text: null,
      jsonResult: { suggestion: 'run tests' },
      usage: { inputTokens: 10, outputTokens: 3, cacheHitTokens: 5 },
    });
    const config = {
      getFastModel: vi.fn(() => 'different-fast-model'),
      getModel: vi.fn(() => 'main-model'),
    } as unknown as Config;

    await generatePromptSuggestion(
      config,
      conversationHistory,
      new AbortController().signal,
      { enableCacheSharing: true },
    );

    expect(mockRunForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ preserveTools: false }),
    );
  });
});

describe('shouldFilterSuggestion', () => {
  it('filters "done"', () => {
    expect(shouldFilterSuggestion('done')).toBe(true);
  });

  it('filters meta-text', () => {
    expect(shouldFilterSuggestion('nothing found')).toBe(true);
    expect(shouldFilterSuggestion('no suggestion needed')).toBe(true);
    expect(shouldFilterSuggestion('silence')).toBe(true);
    expect(shouldFilterSuggestion('staying silent here')).toBe(true);
  });

  it('filters meta-wrapped text', () => {
    expect(shouldFilterSuggestion('(silence)')).toBe(true);
    expect(shouldFilterSuggestion('[no suggestion]')).toBe(true);
  });

  it('filters error messages', () => {
    expect(shouldFilterSuggestion('api error: 500')).toBe(true);
    expect(shouldFilterSuggestion('prompt is too long')).toBe(true);
  });

  it('filters prefixed labels', () => {
    expect(shouldFilterSuggestion('Suggestion: commit this')).toBe(true);
  });

  it('filters single words not in whitelist', () => {
    expect(shouldFilterSuggestion('hmm')).toBe(true);
    expect(shouldFilterSuggestion('maybe')).toBe(true);
  });

  it('allows whitelisted single words', () => {
    expect(shouldFilterSuggestion('yes')).toBe(false);
    expect(shouldFilterSuggestion('commit')).toBe(false);
    expect(shouldFilterSuggestion('push')).toBe(false);
    expect(shouldFilterSuggestion('no')).toBe(false);
  });

  it('allows slash commands as single word', () => {
    expect(shouldFilterSuggestion('/commit')).toBe(false);
  });

  it('filters too many words', () => {
    expect(
      shouldFilterSuggestion(
        'this is a very long suggestion with way too many words in it to show',
      ),
    ).toBe(true);
  });

  it('filters suggestions >= 100 chars', () => {
    expect(shouldFilterSuggestion('a'.repeat(100))).toBe(true);
  });

  it('filters multiple sentences', () => {
    expect(shouldFilterSuggestion('Run the tests. Then commit.')).toBe(true);
    expect(shouldFilterSuggestion('Hello! How are you?')).toBe(true);
    expect(shouldFilterSuggestion('Do this. Then do that.')).toBe(true);
    // Abbreviation skipped, then real sentence boundary detected
    expect(shouldFilterSuggestion('Check Dr. Smith. Then commit.')).toBe(true);
    // Non-word char before punctuation — still detected as sentence boundary
    expect(shouldFilterSuggestion('Run (see docs). Then deploy')).toBe(true);
  });

  it('does not filter abbreviations as multiple sentences', () => {
    // Issue #6077 — "vs." followed by a capitalized word should pass.
    expect(
      shouldFilterSuggestion(
        "Let's start with the Weeds vs. Wildflowers audit.",
      ),
    ).toBe(false);
    expect(shouldFilterSuggestion('Weeds vs. Wildflowers audit')).toBe(false);
    // Common honorifics and abbreviations
    expect(shouldFilterSuggestion('Check Dr. Smith notes')).toBe(false);
    expect(shouldFilterSuggestion('Ask Mr. Jones for help')).toBe(false);
    expect(shouldFilterSuggestion('Talk to Ms. Patel next')).toBe(false);
    expect(shouldFilterSuggestion('See Prof. Lee today')).toBe(false);
    expect(shouldFilterSuggestion('Visit St. Petersburg office')).toBe(false);
    expect(shouldFilterSuggestion('Check etc. Tasks remaining')).toBe(false);
    expect(shouldFilterSuggestion('Review options etc. Then commit')).toBe(
      false,
    );
    // Latin shorthands with an internal period
    expect(shouldFilterSuggestion('Use e.g. Docker to build')).toBe(false);
    expect(shouldFilterSuggestion('Use i.e. Docker to build')).toBe(false);
    // Capitalized variants still recognized as abbreviations
    expect(shouldFilterSuggestion('Use E.g. Docker to build')).toBe(false);
    expect(shouldFilterSuggestion('Use I.e. Docker to build')).toBe(false);
  });

  it('filters formatting', () => {
    expect(shouldFilterSuggestion('run the **tests**')).toBe(true);
    expect(shouldFilterSuggestion('line1\nline2')).toBe(true);
  });

  it('filters control characters and ANSI escapes', () => {
    expect(shouldFilterSuggestion('run\rtests')).toBe(true); // carriage return
    expect(shouldFilterSuggestion('run\x1b[31mtests')).toBe(true); // ESC/CSI
    expect(shouldFilterSuggestion('run\ttests')).toBe(true); // tab (C0)
    expect(shouldFilterSuggestion('run\x7ftests')).toBe(true); // DEL
    expect(shouldFilterSuggestion('run\x9btests')).toBe(true); // C1 CSI
    expect(getFilterReason('run\x1b[31mtests')).toBe('control_chars');
  });

  it('filters evaluative language', () => {
    expect(shouldFilterSuggestion('looks good to me')).toBe(true);
    expect(shouldFilterSuggestion('thanks for the help')).toBe(true);
    expect(shouldFilterSuggestion('that works perfectly')).toBe(true);
  });

  it('filters AI-voice patterns', () => {
    expect(shouldFilterSuggestion('Let me check that')).toBe(true);
    expect(shouldFilterSuggestion("I'll run the tests")).toBe(true);
    expect(shouldFilterSuggestion("Here's what I found")).toBe(true);
  });

  it('does not false-positive on evaluative substrings', () => {
    expect(shouldFilterSuggestion('run nicely formatted tests')).toBe(false);
    expect(shouldFilterSuggestion('fix the greatest issue')).toBe(false);
    expect(shouldFilterSuggestion('create thanksgiving banner')).toBe(false);
  });

  it('allows good suggestions', () => {
    expect(shouldFilterSuggestion('run the tests')).toBe(false);
    expect(shouldFilterSuggestion('commit this')).toBe(false);
    expect(shouldFilterSuggestion('try it out')).toBe(false);
    expect(shouldFilterSuggestion('push it')).toBe(false);
    expect(shouldFilterSuggestion('create a PR')).toBe(false);
  });
});
