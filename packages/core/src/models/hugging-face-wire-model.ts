/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ContentGeneratorConfig } from '../core/contentGenerator.js';
import {
  defaultModalities,
  huggingFaceChatModalities,
} from '../core/modalityDefaults.js';
import { getRequestModel } from '../core/request-model.js';
import { isHuggingFaceRouterUrl, tokenLimit } from '../core/tokenLimits.js';
import { AuthType } from '../utils/auth-type.js';

export function applyHuggingFaceWireModelDefaults(
  config: Partial<ContentGeneratorConfig>,
  route: Pick<ContentGeneratorConfig, 'model' | 'authType' | 'baseUrl'>,
  inferred: { contextWindowSize: boolean; modalities: boolean },
): void {
  delete config.nominalModelCapabilities;
  if (
    route.authType !== AuthType.USE_OPENAI ||
    !isHuggingFaceRouterUrl(route.baseUrl) ||
    (!inferred.contextWindowSize && !inferred.modalities)
  ) {
    return;
  }

  const wireModel = getRequestModel(
    { ...config, authType: route.authType },
    route.model,
  );
  if (wireModel === route.model) return;

  const nominal: NonNullable<
    ContentGeneratorConfig['nominalModelCapabilities']
  > = {};
  if (inferred.contextWindowSize) {
    nominal.contextWindowSize = tokenLimit(route.model, 'input', route.baseUrl);
    config.contextWindowSize = tokenLimit(wireModel, 'input', route.baseUrl);
  }
  if (inferred.modalities) {
    nominal.modalities = defaultModalities(route.model, route.baseUrl);
    config.modalities = huggingFaceChatModalities(
      defaultModalities(wireModel, route.baseUrl),
    );
  }
  config.nominalModelCapabilities = nominal;
}
