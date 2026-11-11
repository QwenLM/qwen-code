/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CoreEvent,
  coreEvents,
  type Config,
  runLogger,
  type TranscriptWriterHandle,
} from '@qwen-code/core';
import {
  getPreferredContextWindow,
  getPreferredGeneration,
  getPreferredReasoningEffort,
} from './modelPreference.js';

export async function recordTranscriptRuntimeConfig(
  config: Config,
  writer: TranscriptWriterHandle | null | undefined,
  reason: string,
): Promise<void> {
  if (!writer) {
    return;
  }

  const modelKey = config.getModel();
  const identity = config.getModelRequestIdentity();
  const sessionId = config.getSessionId();
  const model = await config.getModelProviderManager().getModel(modelKey);
  if (
    modelKey !== config.getModel() ||
    identity !== config.getModelRequestIdentity() ||
    sessionId !== config.getSessionId()
  )
    return;
  const reasoningEffort = getPreferredReasoningEffort(config, model);
  const contextWindow = getPreferredContextWindow(config, model);
  await writer.recordRuntimeConfig({
    model: modelKey,
    reasoningEffort: reasoningEffort ?? null,
    contextWindow: contextWindow ?? null,
    generation: getPreferredGeneration(config, model) ?? null,
  });
  runLogger.log(
    '[session.runtime_config] transcript.recorded',
    `session=${writer.getSessionId()}`,
    `model=${modelKey}`,
    `reasoning_effort=${reasoningEffort ?? 'none'}`,
    `context_window=${contextWindow ?? 'none'}`,
    `reason=${reason}`,
  );
}

export interface TranscriptRuntimeConfigRecorderOptions {
  /**
   * 会话归属。多会话宿主必须传：coreEvents 是进程级总线，不过滤会把别的会话的
   * 模型切换写进本会话 transcript。单会话进程（TUI）沿用裸订阅。
   */
  readonly sessionId?: string;
}

export function registerTranscriptRuntimeConfigRecorder(
  config: Config,
  getWriter: () => TranscriptWriterHandle | null | undefined,
  options: TranscriptRuntimeConfigRecorderOptions = {},
): () => void {
  const record = (reason: string) => {
    void recordTranscriptRuntimeConfig(config, getWriter(), reason).catch(
      (error) => {
        runLogger.warn(
          '[session.runtime_config] transcript.record_failed',
          error,
          `session=${getWriter()?.getSessionId() ?? 'none'}`,
          `reason=${reason}`,
        );
      },
    );
  };

  const handleModelChanged = () => record('model_changed');
  const handleReasoningEffortChanged = () => record('reasoning_effort_changed');
  const handleContextWindowChanged = () => record('context_window_changed');

  if (options.sessionId !== undefined) {
    const sessionId = options.sessionId;
    const unsubscribers = [
      coreEvents.onSessionEvent(
        CoreEvent.ModelChanged,
        sessionId,
        handleModelChanged,
      ),
      coreEvents.onSessionEvent(
        CoreEvent.ReasoningEffortChanged,
        sessionId,
        handleReasoningEffortChanged,
      ),
      coreEvents.onSessionEvent(
        CoreEvent.ContextWindowChanged,
        sessionId,
        handleContextWindowChanged,
      ),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }

  coreEvents.on(CoreEvent.ModelChanged, handleModelChanged);
  coreEvents.on(CoreEvent.ReasoningEffortChanged, handleReasoningEffortChanged);
  coreEvents.on(CoreEvent.ContextWindowChanged, handleContextWindowChanged);

  return () => {
    coreEvents.off(CoreEvent.ModelChanged, handleModelChanged);
    coreEvents.off(
      CoreEvent.ReasoningEffortChanged,
      handleReasoningEffortChanged,
    );
    coreEvents.off(CoreEvent.ContextWindowChanged, handleContextWindowChanged);
  };
}
