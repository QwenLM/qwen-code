/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Config } from '../../../config/config.js';
import { mergeModelConfig } from '../../../provider/model/modelConfig.js';
import type { ClassifierInvokeFn } from './classifier.js';
import {
  invokeClassifierJson,
  CLASSIFIER_MAX_OUTPUT_TOKENS,
} from './classifier-invoke.js';

export function createClassifierInvoke(config: Config): ClassifierInvokeFn {
  return async (options) => {
    const { abortSignal, stage, onRequestMetadata } = options;
    const manager = config.getModelProviderManager();
    const base = await manager.select({ purpose: 'auto_permission' });
    const resolution = await manager.select({
      purpose: 'auto_permission',
      overrideSelection: {
        model: base.model,
        config: mergeModelConfig(base.config, {
          reasoning: { effort: stage === 'thinking' ? 'low' : 'none' },
          context: { maxOutputTokens: CLASSIFIER_MAX_OUTPUT_TOKENS },
        }),
      },
    });
    abortSignal.throwIfAborted();
    return invokeClassifierJson(options, async (messages) => {
      const requestId = randomUUID();
      onRequestMetadata?.({ model: resolution.model.key, requestId });
      const response = await manager.inference({
        resolution,
        prompt: { messages },
        control: { signal: abortSignal },
      });
      const message = await response.completed;
      onRequestMetadata?.({
        model: resolution.model.key,
        requestId,
        messageId: message.messageId,
      });
      return message.blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
    });
  };
}
