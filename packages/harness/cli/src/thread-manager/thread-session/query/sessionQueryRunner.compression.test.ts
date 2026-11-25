/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  CacheSafeQuerySnapshot,
  CompressionPipeline,
  Config,
  ModelConfig,
  SessionStateStore,
} from '@qwen-code/core';
import { testModelResolution } from '../../../../../core/src/test-utils/model-resolution.js';
import type { CompactModelSelectContext } from '../../../../../core/src/provider/model/modelSelectContext.js';
import { SessionQueryRunner } from './sessionQueryRunner.js';
import type { SessionQueryRunnerConfig } from './sessionQueryRunner.js';

function createCompactFixture() {
  const selection = testModelResolution('snapshot-model', {
    config: {
      reasoning: { effort: 'high', thinking: { type: 'disabled' }, preserve: false },
      context: { contextWindow: 200_000, maxOutputTokens: 321 },
      sampling: { temperature: 0 },
    },
  });
  const manager = {
    getModel: vi.fn(async () => selection.model),
    getModelConfig: vi.fn((): ModelConfig | undefined => undefined),
    select: vi.fn(async (_input: CompactModelSelectContext) => selection),
  };
  const config = {
    getModel: vi.fn(() => 'snapshot-model'),
    getSessionId: () => 'compression-session',
    getModelRequestIdentity: () => 'compression-owner',
    hasModelProviderManager: () => true,
    getModelProviderManager: () => manager,
    getWorkspaceContext: () => ({ getDirectories: () => [] }),
    getModelPolicy: () => undefined,
    getEffectiveContextWindow: vi.fn(),
  } as unknown as Config;
  const compress = vi.fn(
    async (..._args: Parameters<CompressionPipeline['compress']>) => ({
      newHistory: null,
      info: { originalTokenCount: 123, newTokenCount: 123, compressionStatus: 'noop' },
    }),
  );
  const snapshot: CacheSafeQuerySnapshot = {
    modelResolution: selection,
    model: selection.model.key,
    systemPrompt: [{ type: 'text', text: 'snapshot system prompt' }],
    forkContextMessages: [],
    requestPrefixMessages: [],
    toolSchemas: [],
    generation: { temperature: 0, maxTokens: 321, reasoning: { preserve: false } },
    thinkingBudget: 0,
    reasoningEffort: 'high',
    contextWindow: 200_000,
  };
  const compressionAbortControllers = new Set<AbortController>();
  const runner = Object.assign(Object.create(SessionQueryRunner.prototype), {
    cwdContext: { cwd: process.cwd(), originalCwd: process.cwd() },
    runnerConfig: {
      config,
      compressionPipeline: { compress } as unknown as CompressionPipeline,
    } as SessionQueryRunnerConfig,
    messages: [],
    sessionId: 'compression-session',
    lastCacheSafeSnapshot: snapshot,
    sessionStateStore: {} as SessionStateStore,
    compressionAbortControllers,
  }) as SessionQueryRunner;
  return { runner, selection, manager, config, compress, snapshot, compressionAbortControllers };
}

describe('SessionQueryRunner manual compression model snapshot', () => {
  it('preserves the exact cached ModelSelection and its complete configuration', async () => {
    const { runner, selection, manager, config, compress, snapshot } = createCompactFixture();
    await runner.compressNow({ customContext: { caller: 'manual' } });
    const options = compress.mock.calls[0]![1];
    expect(options.modelResolution).toBe(selection);
    expect(options.modelResolution.config.sampling?.temperature).toBe(0);
    expect(options.modelResolution.config.reasoning?.thinking).toEqual({ type: 'disabled' });
    expect(options.customContext).toEqual({ caller: 'manual' });
    expect(options.systemPrompt).toBe(snapshot.systemPrompt);
    expect(manager.getModel).not.toHaveBeenCalled();
    expect(manager.select).not.toHaveBeenCalled();
    expect(manager.getModelConfig).not.toHaveBeenCalled();
    expect(config.getEffectiveContextWindow).not.toHaveBeenCalled();
    for (const key of ['model', 'resolveCompactRequest', 'customModelOverride', 'thinkingBudget', 'generation']) {
      expect(options).not.toHaveProperty(key);
    }
  });

  it('adapts the delayed compact policy result to a provider selection', async () => {
    const { runner, selection, manager, compress } = createCompactFixture();
    await runner.compressNow();
    const prepared = await compress.mock.calls[0]![1].resolveCompactSelection!();
    expect(prepared.selection).toEqual(selection);
    expect(prepared.selection.config).toBe(selection.config);
    expect(prepared.selection).not.toHaveProperty('policy');
    expect(prepared.source).toBe('current');
    expect(manager.select).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'compact', parentSelection: selection }));
  });

  it.each([false, true])(
    'prepares snapshotless manual compression without copying session preferences (explicit=%s)',
    async (explicit) => {
      const { runner, config, manager, selection, compress } =
        createCompactFixture();
      const getSchema = vi.fn(() => []);
      Object.assign(runner, {
        lastCacheSafeSnapshot: null,
        createSystemPromptResolver: vi.fn(async () => async () => ({
          blocks: [],
        })),
        runnerConfig: {
          config,
          compressionPipeline: { compress },
          toolRegistryFactory: {
            create: () => ({ getSchema }) as never,
          },
        },
      });
      manager.getModelConfig.mockReturnValue({
        sampling: { temperature: 0.6 },
      });
      const prepared = { ...selection, preparedParentOnly: true as const };
      manager.select.mockResolvedValueOnce(prepared);
      await runner.compressNow(
        explicit ? { model: 'snapshot-model' } : undefined,
      );
      const prepareInput = manager.select.mock.calls[0]![0];
      expect(prepareInput).toMatchObject({
        purpose: 'compact',
        prepareParent: true,
      });
      expect(prepareInput.parentSelection).toBeUndefined();
      if (explicit) {
        expect(prepareInput.parentOverride).toMatchObject({
          key: 'snapshot-model',
          config: { sampling: { temperature: 0.6 } },
        });
        expect(manager.getModelConfig).toHaveBeenCalled();
      } else {
        expect(prepareInput).not.toHaveProperty('parentOverride');
        expect(prepareInput.overrideSelection).toBeUndefined();
        expect(manager.getModel).not.toHaveBeenCalled();
        expect(manager.getModelConfig).not.toHaveBeenCalled();
        expect(config.getEffectiveContextWindow).not.toHaveBeenCalled();
      }
      expect(manager.select).toHaveBeenCalledOnce();
      const options = compress.mock.calls[0]![1];
      expect(options.modelResolution).toEqual(selection);
      const selected = await options.resolveCompactSelection!();
      expect(selected.selection).toEqual(selection);
      expect(manager.select.mock.calls[1]![0].parentSelection).toEqual(
        selection,
      );
      expect(manager.select).toHaveBeenCalledTimes(2);
    },
  );

  it('releases the compression controller when the pipeline rejects', async () => {
    const { runner, compress, compressionAbortControllers } = createCompactFixture();
    const failure = new Error('compression failed');
    compress.mockRejectedValue(failure);
    await expect(runner.compressNow()).rejects.toBe(failure);
    expect(compressionAbortControllers.size).toBe(0);
  });

  it('preserves cancellation while preparing the delayed compact selection', async () => {
    const { runner, compress, compressionAbortControllers } = createCompactFixture();
    compress.mockImplementation(async (_history, options) => {
      [...compressionAbortControllers][0]!.abort();
      await options.resolveCompactSelection!();
      throw new Error('unreachable');
    });
    await expect(runner.compressNow()).rejects.toMatchObject({ name: 'AbortError' });
    expect(compressionAbortControllers.size).toBe(0);
  });
});
