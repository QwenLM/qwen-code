/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentConfig } from '@google/genai';
import type { ReasoningEffortLevel } from './settingsValueTypes.js';

export interface ModelConfig {
  model?: string;
  generateContentConfig?: GenerateContentConfig;
  /** Explicit reasoning effort used by internal model aliases. */
  reasoningEffort?: ReasoningEffortLevel;
}

export interface ModelConfigOverride {
  match: {
    model?: string; // Can be a model name or an alias
    overrideScope?: string;
    isRetry?: boolean;
  };
  modelConfig: ModelConfig;
}

export interface ModelConfigAlias {
  extends?: string;
  modelConfig: ModelConfig;
}

export interface ModelConfigsSetting {
  aliases?: Record<string, ModelConfigAlias>;
  customAliases?: Record<string, ModelConfigAlias>;
  overrides?: ModelConfigOverride[];
  customOverrides?: ModelConfigOverride[];
}
