/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ContentGeneratorConfig } from './contentGenerator.js';
import { AuthType } from '../utils/auth-type.js';
import { retryContext } from '../utils/retryContext.js';

export function getSystemPromptModel(
  generation: Partial<ContentGeneratorConfig>,
  model = generation.model ?? '',
): string {
  if (
    generation.authType === AuthType.USE_ANTHROPIC ||
    generation.authType === AuthType.USE_OPENAI_RESPONSES
  ) {
    return generation.model ?? model;
  }
  if (generation.authType === AuthType.QWEN_SUBSCRIPTION) {
    const override = generation.extra_body?.['model'];
    return !retryContext.getStore()?.singleAttempt &&
      typeof override === 'string'
      ? override
      : model;
  }
  return getRequestModel(generation, model);
}

export function getRequestModel(
  generation: Partial<ContentGeneratorConfig>,
  model = generation.model ?? '',
): string {
  if (
    retryContext.getStore()?.singleAttempt ||
    (generation.authType !== undefined &&
      generation.authType !== AuthType.USE_OPENAI &&
      generation.authType !== AuthType.QWEN_OAUTH)
  )
    return model;
  const override = {
    ...generation.samplingParams,
    ...generation.extra_body,
  }['model'];
  return typeof override === 'string' ? override : model;
}
