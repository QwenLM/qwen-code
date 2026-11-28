/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ContextManagementConfig } from './types.js';

export const generalistProfile: ContextManagementConfig = {
  enabled: true,
  tools: {
    outputMasking: {
      protectionThresholdTokens: 50_000,
      minPrunableThresholdTokens: 30_000,
      protectLatestTurn: true,
    },
  },
};
