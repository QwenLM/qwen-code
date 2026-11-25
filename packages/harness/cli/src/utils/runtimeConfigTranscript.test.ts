/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  coreEvents,
  type Config,
  type TranscriptWriterHandle,
} from '@qwen-code/core';
import { registerTranscriptRuntimeConfigRecorder } from './runtimeConfigTranscript.js';
import { testProviderModel } from '../../../core/src/test-utils/model-resolution.js';

function createConfig(): Config {
  return {
    getModel: () => 'gmodel',
    getModelRequestIdentity: () => 'test-account',
    getSessionId: () => 'session-a',
    getModelProviderManager: () => ({
      getModel: async () => testProviderModel('gmodel'),
      getModelConfig: () => ({
        reasoning: { effort: 'low' },
        context: { contextWindow: 200_000 },
      }),
    }),
  } as unknown as Config;
}

function createWriter() {
  const recordRuntimeConfig = vi.fn(async () => {});
  const writer = {
    recordRuntimeConfig,
    getSessionId: () => 'session-a',
  } as unknown as TranscriptWriterHandle;
  return { writer, recordRuntimeConfig };
}

describe('registerTranscriptRuntimeConfigRecorder', () => {
  it('指定会话时只记录本会话的运行配置变更', async () => {
    const { writer, recordRuntimeConfig } = createWriter();
    const unsubscribe = registerTranscriptRuntimeConfigRecorder(
      createConfig(),
      () => writer,
      { sessionId: 'session-a' },
    );

    coreEvents.emitModelChanged('session-b', 'other-model');
    expect(recordRuntimeConfig).not.toHaveBeenCalled();

    coreEvents.emitModelChanged('session-a', 'gmodel');
    coreEvents.emitReasoningEffortChanged('session-a', 'low', 'gmodel');
    coreEvents.emitContextWindowChanged('session-a', 200_000, 'gmodel');
    await vi.waitFor(() =>
      expect(recordRuntimeConfig).toHaveBeenCalledTimes(3),
    );
    expect(recordRuntimeConfig).toHaveBeenLastCalledWith({
      model: 'gmodel',
      reasoningEffort: 'low',
      contextWindow: 200_000,
      generation: { reasoning: { effort: 'low' } },
    });

    unsubscribe();
    coreEvents.emitModelChanged('session-a', 'gmodel');
    expect(recordRuntimeConfig).toHaveBeenCalledTimes(3);
  });

  it('不指定会话时记录任意会话的变更（单会话宿主沿用）', async () => {
    const { writer, recordRuntimeConfig } = createWriter();
    const unsubscribe = registerTranscriptRuntimeConfigRecorder(
      createConfig(),
      () => writer,
    );

    coreEvents.emitModelChanged('session-c', 'gmodel');
    await vi.waitFor(() =>
      expect(recordRuntimeConfig).toHaveBeenCalledTimes(1),
    );
    expect(recordRuntimeConfig).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gmodel' }),
    );

    unsubscribe();
  });
});
