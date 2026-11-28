/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { createUserMessage } from '../protocol/transcript/conversions.js';
import { readCache, writeCache, isCacheFresh } from './cache.js';
import { extractFacets } from './facetExtractor.js';
import type { SessionMeta } from './types.js';

const { resolveSession } = vi.hoisted(() => ({ resolveSession: vi.fn() }));
vi.mock('./cache.js');
vi.mock('../services/transcript/repository.js', () => ({
  TranscriptRepository: class {
    resolveSession = resolveSession;
  },
}));

const session: SessionMeta = {
  id: 'history-session',
  projectRoot: '/project',
  filePath: '/project/session.jsonl',
  startTime: 1,
  lastUpdated: 2,
  messageCount: 1,
  userMessageCount: 1,
};
const semanticFacets = {
  topics: ['testing'],
  languages: ['TypeScript'],
  intents: ['fix'],
  entities: ['vitest'],
  sentiment: 'neutral',
  complexityEstimate: 'medium',
};

function setup() {
  const selectedModel = {
    key: 'selected',
    source: 'fixture-provider',
    limits: { maxOutputTokens: 2048 },
  };
  const select = vi.fn(async () => ({
    model: selectedModel,
    config: { reasoning: { effort: 'none' } },
  }));
  const inference = vi.fn(async () => ({
    completed: Promise.resolve({
      stopReason: 'end_turn',
      blocks: [{ type: 'text', text: JSON.stringify(semanticFacets) }],
    }),
  }));
  const provider = {
    listModels: async () => [
      { ...selectedModel, key: 'fixture-provider/session-model' },
      selectedModel,
    ],
    setMainModel: vi.fn(),
    select,
    inference,
  };
  const getModelProviderManager = vi.fn(() => provider);
  const config = {
    getModel: () => 'fixture-provider/session-model',
    isConfiguredCustomProviderModelKey: () => true,
    getModelProviderManager,
    getSessionId: () => 'facet-session',
    getModelRequestIdentity: () => 'test-account',
  } as unknown as Config;
  return {
    config,
    select,
    inference,
    selectedModel,
    getModelProviderManager,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isCacheFresh).mockResolvedValue(false);
  resolveSession.mockResolvedValue({
    messages: [createUserMessage('Fix TypeScript tests')],
  });
});

describe('extractFacets ModelProvider integration', () => {
  it('selects and infers for an uncached session, preserving the history session ID and cache shape', async () => {
    const f = setup();
    const result = await extractFacets(
      session,
      f.config,
      new AbortController().signal,
    );
    expect(f.select).toHaveBeenCalledExactlyOnceWith({ purpose: 'insights' });
    expect(f.inference).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        resolution: {
          model: f.selectedModel,
          config: { reasoning: { effort: 'none' } },
        },
        qoder: expect.objectContaining({
          identity: expect.objectContaining({ sessionId: 'history-session' }),
        }),
        prompt: expect.objectContaining({ messages: expect.arrayContaining([
          {
            role: 'user',
            content:
              'Analyze this coding session and extract facets:\n\nFix TypeScript tests',
          },
        ]), }),
      }),
    );
    expect(result).toEqual({
      ...semanticFacets,
      sessionId: session.id,
      languages: ['typescript'],
    });
    expect(writeCache).toHaveBeenCalledExactlyOnceWith(
      'facets',
      session.id,
      result,
    );
  });

  it('uses fresh cached facets without touching selection or inference', async () => {
    const f = setup();
    const cached = { ...semanticFacets, sessionId: session.id };
    vi.mocked(isCacheFresh).mockResolvedValueOnce(true);
    vi.mocked(readCache).mockResolvedValueOnce(cached);
    expect(
      await extractFacets(session, f.config, new AbortController().signal),
    ).toBe(cached);
    expect(resolveSession).not.toHaveBeenCalled();
    expect(f.getModelProviderManager).not.toHaveBeenCalled();
    expect(writeCache).not.toHaveBeenCalled();
  });

  it('does not select a model for a session with no visible user messages', async () => {
    const f = setup();
    resolveSession.mockResolvedValueOnce({
      messages: [createUserMessage('hidden', { isMeta: true })],
    });
    const result = await extractFacets(
      session,
      f.config,
      new AbortController().signal,
    );
    expect(result.topics).toEqual([]);
    expect(f.select).not.toHaveBeenCalled();
    expect(writeCache).toHaveBeenCalledWith('facets', session.id, result);
  });

  it('preserves default facets after selection failure without calling legacy inference or caching failure', async () => {
    const f = setup();
    f.select.mockRejectedValueOnce(new Error('model unavailable'));
    const result = await extractFacets(
      session,
      f.config,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      sessionId: session.id,
      topics: [],
      sentiment: 'neutral',
      complexityEstimate: 'low',
    });
    expect(f.inference).not.toHaveBeenCalled();
    expect(writeCache).not.toHaveBeenCalled();
  });
});
