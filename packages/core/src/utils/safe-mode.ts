/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const SAFE_MODE_ENV_VAR = 'QWEN_CODE_SAFE_MODE';

export function isSafeModeEnv(): boolean {
  const value = process.env[SAFE_MODE_ENV_VAR];
  return value === 'true' || value === '1';
}
