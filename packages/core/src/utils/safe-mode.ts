/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isTruthy } from './bareMode.js';

const SAFE_MODE_ENV_VAR = 'QWEN_CODE_SAFE_MODE';

export function isSafeModeEnv(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): boolean {
  return isTruthy(env[SAFE_MODE_ENV_VAR]);
}
