/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ContentGeneratorConfig } from '../contentGenerator.js';
import { DashScopeOpenAICompatibleProvider } from './provider/dashscope.js';

export function supportsOpenAIPrefixCaching(
  contentGeneratorConfig: ContentGeneratorConfig,
): boolean {
  return DashScopeOpenAICompatibleProvider.isDashScopeProvider(
    contentGeneratorConfig,
  );
}
