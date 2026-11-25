/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BRAND_FIXED_ENV_PREFIX,
  DEFAULT_BACKGROUND_WIND_DOWN_POLICY,
  type BackgroundWindDownPolicy,
} from '@qwen-code/core';

const PRINT_BG_WAIT_CEILING_ENV = `${BRAND_FIXED_ENV_PREFIX.replace(/_$/, '')}CLI_PRINT_BG_WAIT_CEILING_MS`;

/** Explicit print wait limits replace the default hard bound; 0 waits indefinitely. */
export function readPrintBackgroundWindDownPolicy(
  env: NodeJS.ProcessEnv = process.env,
): BackgroundWindDownPolicy {
  const raw = env[PRINT_BG_WAIT_CEILING_ENV];
  if (
    raw === undefined ||
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(Number(raw))
  ) {
    return DEFAULT_BACKGROUND_WIND_DOWN_POLICY;
  }
  return { waitCeilingMs: Number(raw) };
}
