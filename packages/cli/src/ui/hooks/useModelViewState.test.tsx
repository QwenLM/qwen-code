/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { renderHook } from '../../test-utils/render.js';
import {
  coreEvents,
  type Config,
  type Model,
  type ModelConfig,
  type ReasoningEffortLevel,
} from '@qwen-code/core';
import { useModelViewState } from './useModelViewState.js';

import { testListedModel } from '../../../../core/src/test-utils/listed-model.js';

const { useModelMock } = vi.hoisted(() => ({
  useModelMock: vi.fn<() => Model | undefined>(),
}));
vi.mock('../contexts/ConfigContext.js', () => ({ useModel: useModelMock }));

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual = await importOriginal();
  const handlers = new Map<string, (payload: unknown) => void>();
  return {
    ...(actual as Record<string, unknown>),
    coreEvents: {
      ...((actual as Record<string, unknown>)['coreEvents'] as Record<
        string,
        unknown
      >),
      on: vi.fn((event: string, handler: (payload: unknown) => void) => {
        handlers.set(event, handler);
      }),
      off: vi.fn((event: string) => {
        handlers.delete(event);
      }),
      _trigger: (event: string, payload: unknown) => {
        handlers.get(event)?.(payload);
      },
    },
  };
});

interface MakeConfigOpts {
  model?: string;
  reasoningEffort?: ReasoningEffortLevel;
  contextWindow?: number;
  remaining?: number;
  limit?: number;
  resetTime?: string;
}

function makeConfig(opts: MakeConfigOpts = {}): Config {
  const listed = testListedModel(opts.model ?? 'opus-4-7');
  useModelMock.mockReturnValue(listed);
  const manager = {
    getModelConfig: vi.fn(
      (): ModelConfig => ({
        reasoning: { effort: opts.reasoningEffort },
        context: { contextWindow: opts.contextWindow },
      }),
    ),
  };
  return {
    getModel: vi.fn(() => opts.model ?? 'opus-4-7'),
    getSessionId: () => 'session-1',
    getModelProviderManager: () => manager,
    getQuotaRemaining: () => opts.remaining,
    getQuotaLimit: () => opts.limit,
    getQuotaResetTime: () => opts.resetTime,
  } as unknown as Config;
}

describe('useModelViewState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('initializes currentModel from config', async () => {
    const config = makeConfig({ model: 'opus-4-7' });
    const { result } = await renderHook(() => useModelViewState(config));
    expect(result.current.currentModel).toBe('opus-4-7');
  });

  it('initializes currentReasoningEffort from config', async () => {
    const config = makeConfig({ reasoningEffort: 'high' });
    const { result } = await renderHook(() => useModelViewState(config));
    expect(result.current.currentReasoningEffort).toBe('high');
  });

  it('refreshes currentModel from config on ModelChanged', async () => {
    const config = makeConfig({ model: 'opus-4-7' });
    const { result } = await renderHook(() => useModelViewState(config));
    expect(result.current.currentModel).toBe('opus-4-7');

    (config.getModel as ReturnType<typeof vi.fn>).mockReturnValue('sonnet-4-6');
    act(() => {
      // @ts-expect-error - test helper
      coreEvents._trigger('model-changed', {
        model: 'sonnet-4-6',
        sessionId: 'session-1',
      });
    });

    expect(result.current.currentModel).toBe('sonnet-4-6');
  });

  it('updates currentReasoningEffort on ReasoningEffortChanged', async () => {
    const config = makeConfig();
    const { result } = await renderHook(() => useModelViewState(config));
    expect(result.current.currentReasoningEffort).toBeUndefined();

    act(() => {
      // @ts-expect-error - test helper
      coreEvents._trigger('reasoning-effort-changed', {
        model: 'opus-4-7',
        reasoningEffort: 'none',
      });
    });

    expect(result.current.currentReasoningEffort).toBe('none');
  });

  it('refreshes provider preferences after model info changes', async () => {
    const config = makeConfig({
      model: 'performance',
      reasoningEffort: 'high',
      contextWindow: 272_000,
    });
    const { result } = await renderHook(() => useModelViewState(config));

    expect(result.current.currentReasoningEffort).toBe('high');
    expect(result.current.currentContextWindow).toBe(272_000);
    const model = useModelMock.mock.results[0]?.value;
    expect(
      config.getModelProviderManager().getModelConfig,
    ).toHaveBeenCalledWith(model);
    vi.mocked(config.getModelProviderManager().getModelConfig).mockReturnValue({
      reasoning: { effort: 'low' },
      context: { contextWindow: 128_000 },
    });

    act(() => {
      // @ts-expect-error - test helper
      coreEvents._trigger('model-info-changed');
    });

    expect(result.current.currentReasoningEffort).toBe('low');
    expect(result.current.currentContextWindow).toBe(128_000);
    expect(useModelMock.mock.results.at(-1)?.value).toBe(model);
  });

  it('exposes setCurrentModel for external mirroring (remote session)', async () => {
    const config = makeConfig({ model: 'opus-4-7' });
    const { result } = await renderHook(() => useModelViewState(config));
    act(() => {
      result.current.setCurrentModel('haiku-4-5');
    });
    expect(result.current.currentModel).toBe('haiku-4-5');
  });
});
