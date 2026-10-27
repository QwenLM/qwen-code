/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { buildBtwCacheSafeParams } from '@qwen-code/qwen-code-core/utils/btwUtils.js';
import type {
  CachePathParams,
  ForkedQueryResult,
} from '@qwen-code/qwen-code-core/agents/forkedAgent.js';

const { runForkedAgent } = vi.hoisted(() => ({
  runForkedAgent:
    vi.fn<(params: CachePathParams) => Promise<ForkedQueryResult>>(),
}));
import { executeBtwGeneration } from './btw-generation.js';

vi.mock('@qwen-code/qwen-code-core/utils/btwUtils.js', () => ({
  buildBtwCacheSafeParams: vi.fn(),
  buildBtwPrompt: (question: string) => `btw: ${question}`,
}));
vi.mock('@qwen-code/qwen-code-core/agents/forkedAgent.js', () => ({
  runForkedAgent,
}));

const config = { getModel: () => 'main' } as unknown as Config;

beforeEach(() => vi.clearAllMocks());

describe('executeBtwGeneration', () => {
  it('streams the history-aware tool-free fork and returns usage', async () => {
    const cache = {
      model: 'session-model',
      generationConfig: {},
      history: [],
      version: 0,
    };
    vi.mocked(buildBtwCacheSafeParams).mockReturnValue(cache);
    vi.mocked(runForkedAgent).mockImplementation(async (params) => {
      if (!('cacheSafeParams' in params))
        throw new Error('Expected cache-path fork');
      await params.onText?.('Hello');
      await params.onText?.(' world');
      return {
        text: 'Hello world',
        model: 'resolved',
        usage: { inputTokens: 3, outputTokens: 2, cacheHitTokens: 1 },
      };
    });
    const emit = vi.fn().mockResolvedValue(undefined);
    const signal = new AbortController().signal;
    expect(await executeBtwGeneration(config, ' Why? ', signal, emit)).toEqual({
      model: 'resolved',
      modelSource: 'main',
      inputTokens: 3,
      outputTokens: 2,
    });
    expect(runForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        cacheSafeParams: cache,
        abortSignal: signal,
        userMessage: 'btw: Why?',
      }),
    );
    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { type: 'started', model: 'session-model', modelSource: 'main' },
      { type: 'delta', seq: 0, text: 'Hello' },
      { type: 'delta', seq: 1, text: ' world' },
    ]);
  });

  it('completes with no answer when no conversation context exists', async () => {
    vi.mocked(buildBtwCacheSafeParams).mockReturnValue(null);
    expect(
      await executeBtwGeneration(
        config,
        'Why?',
        new AbortController().signal,
        vi.fn(),
      ),
    ).toEqual({ model: 'main', modelSource: 'main' });
    expect(runForkedAgent).not.toHaveBeenCalled();
  });

  it('does not publish text or succeed after cancellation', async () => {
    vi.mocked(buildBtwCacheSafeParams).mockReturnValue({
      model: 'main',
      generationConfig: {},
      history: [],
      version: 0,
    });
    const controller = new AbortController();
    vi.mocked(runForkedAgent).mockImplementation(async (params) => {
      controller.abort();
      if ('cacheSafeParams' in params) await params.onText?.('late text');
      throw new Error('Should not reach completion');
    });
    const emit = vi.fn();
    await expect(
      executeBtwGeneration(config, 'Why?', controller.signal, emit),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
