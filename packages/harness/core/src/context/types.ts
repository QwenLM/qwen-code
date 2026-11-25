/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ToolOutputMaskingConfig {
  protectionThresholdTokens: number;
  minPrunableThresholdTokens: number;
  protectLatestTurn: boolean;
}

export interface ContextManagementConfig {
  enabled: boolean;
  tools: {
    outputMasking: ToolOutputMaskingConfig;
  };
}
