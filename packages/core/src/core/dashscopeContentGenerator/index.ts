/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../contentGenerator.js';
import type { Config } from '../../config/config.js';
import { DashScopeContentGenerator } from './dashscope-content-generator.js';

export { DashScopeContentGenerator } from './dashscope-content-generator.js';

export function createDashScopeContentGenerator(
  contentGeneratorConfig: ContentGeneratorConfig,
  cliConfig: Config,
): ContentGenerator {
  return new DashScopeContentGenerator(contentGeneratorConfig, cliConfig);
}
