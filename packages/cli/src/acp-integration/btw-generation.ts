/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import {
  buildBtwCacheSafeParams,
  buildBtwPrompt,
} from '@qwen-code/qwen-code-core/utils/btwUtils.js';
import { runForkedAgent } from '@qwen-code/qwen-code-core/agents/forkedAgent.js';
import type { GenerationEvent, GenerationResult } from './generation.js';

export const BTW_STREAM_TIMEOUT_MS = 305_000;

export async function executeBtwGeneration(
  config: Config,
  question: string,
  signal: AbortSignal,
  emit: (event: GenerationEvent) => Promise<void>,
): Promise<GenerationResult> {
  const cacheSafeParams = buildBtwCacheSafeParams(config);
  const model = cacheSafeParams?.model ?? config.getModel() ?? '';
  await emit({ type: 'started', model, modelSource: 'main' });
  if (!cacheSafeParams) return { model, modelSource: 'main' };
  let seq = 0;
  const result = await runForkedAgent({
    config,
    userMessage: buildBtwPrompt(question.trim()),
    cacheSafeParams,
    abortSignal: signal,
    onText: async (text) => {
      signal.throwIfAborted();
      await emit({ type: 'delta', seq: seq++, text });
    },
  });
  signal.throwIfAborted();
  return {
    model: result.model,
    modelSource: 'main',
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  };
}
