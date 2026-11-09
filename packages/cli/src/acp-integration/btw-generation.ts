/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { getBtwSession } from '@qwen-code/qwen-code-core/agents/btw-session.js';
import { formatBtwToolCallNotice } from '../ui/utils/btw-view.js';
import { t } from '../i18n/index.js';
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
  let emitted = '';
  const { done } = getBtwSession(config).ask(question.trim(), {
    signal,
    onText: async (text) => {
      signal.throwIfAborted();
      emitted += text;
      await emit({ type: 'delta', seq: seq++, text });
    },
    onReset: async () => {
      signal.throwIfAborted();
      emitted = '';
      await emit({ type: 'reset' });
    },
  });
  const result = await done;
  signal.throwIfAborted();
  if (result.kind === 'failed') throw result.cause;
  // `seq` never rewinds on reset, so decide on text the client can still see.
  if (emitted.trim() === '') {
    const notice =
      result.kind === 'tool-call'
        ? formatBtwToolCallNotice(result.toolName)
        : result.kind === 'empty'
          ? t('No response received.')
          : result.kind === 'unavailable'
            ? t('No conversation context available for /btw')
            : null;
    if (notice !== null) {
      await emit({ type: 'delta', seq: seq++, text: notice });
    }
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
