/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';

export interface CompressionConfig {
  autoCompact: { maxConsecutiveFailures: number };
}

export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  autoCompact: { maxConsecutiveFailures: 3 },
};

type CompressionConfigProvider = Partial<Pick<Config, 'getCompressionConfig'>>;

export function getCompressionConfig(
  config: CompressionConfigProvider | undefined,
): CompressionConfig {
  return config?.getCompressionConfig?.() ?? DEFAULT_COMPRESSION_CONFIG;
}
