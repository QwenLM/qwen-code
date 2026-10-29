/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ContentGeneratorConfig } from './contentGenerator.js';
import { AuthType } from '../utils/auth-type.js';

export function getRequestModel(
  generation: Partial<ContentGeneratorConfig>,
  model = generation.model ?? '',
): string {
  if (
    generation.authType !== undefined &&
    generation.authType !== AuthType.USE_OPENAI &&
    generation.authType !== AuthType.QWEN_OAUTH
  )
    return model;
  const override = {
    ...generation.samplingParams,
    ...generation.extra_body,
  }['model'];
  return typeof override === 'string' ? override : model;
}
