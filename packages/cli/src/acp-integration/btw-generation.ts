/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { getBtwSession } from '@qwen-code/qwen-code-core/agents/btw-session.js';
import type { GenerationEvent, GenerationResult } from './generation.js';

export const BTW_STREAM_TIMEOUT_MS = 305_000;

export async function executeBtwGeneration(
  config: Config,
  question: string,
  signal: AbortSignal,
  emit: (event: GenerationEvent) => Promise<void>,
): Promise<GenerationResult> {
  const model = config.getModel() ?? '';
  await emit({ type: 'started', model, modelSource: 'main' });
  let seq = 0;
  const { done } = getBtwSession(config).ask(question.trim(), {
    signal,
    onText: async (text) => {
      signal.throwIfAborted();
      await emit({ type: 'delta', seq: seq++, text });
    },
    onReset: async () => {
      signal.throwIfAborted();
      await emit({ type: 'reset' });
    },
  });
  const result = await done;
  signal.throwIfAborted();
  if (result.kind === 'failed') throw result.cause;
  if (result.kind === 'synthetic' && seq === 0) {
    await emit({ type: 'delta', seq: seq++, text: result.response });
  }
  return {
    model: result.usage?.model ?? model,
    modelSource: 'main',
    ...(result.usage
      ? {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        }
      : {}),
  };
}
