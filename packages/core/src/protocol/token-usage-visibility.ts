/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_EXPOSE_TOKEN_USAGE, readBrandEnv } from '../config/brand.js';

export function shouldExposeTokenUsage(): boolean {
  return isTruthyEnv(readBrandEnv(ENV_EXPOSE_TOKEN_USAGE));
}

export function maskTokenCountForPublicOutput(value: number): number {
  return shouldExposeTokenUsage() ? value : 0;
}

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}
