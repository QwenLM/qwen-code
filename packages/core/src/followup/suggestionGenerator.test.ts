/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { Config } from '../config/config.js';

const { mockGetCacheSafeParams, mockRunForkedAgent, mockAddEvent } = vi.hoisted(
  () => ({
    mockGetCacheSafeParams: vi.fn(),
    mockRunForkedAgent: vi.fn(),
    mockAddEvent: vi.fn(),
  }),
);

vi.mock('../utils/forkedAgent.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/forkedAgent.js')>();
  return {
    ...actual,
    getCacheSafeParams: mockGetCacheSafeParams,
    runForkedAgent: mockRunForkedAgent,
  };
});

vi.mock('../telemetry/uiTelemetry.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../telemetry/uiTelemetry.js')>();
  return {
    ...actual,
    uiTelemetryService: {
      addEvent: mockAddEvent,
    },
  };
});

import {
  generatePromptSuggestion,
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
    mockAddEvent.mockReset();
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
  });

  it('filters formatting', () => {
    expect(shouldFilterSuggestion('run the **tests**')).toBe(true);
    expect(shouldFilterSuggestion('line1\nline2')).toBe(true);
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
