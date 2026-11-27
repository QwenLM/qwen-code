/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND_FIXED_ENV_PREFIX } from '../config/brand.js';

/**
 * Feature gate for Bash PTY automation tools.
 *
 * Opt-in via an environment variable.
 * Default is disabled so the tools can ship without changing the default Bash
 * surface area:
 *   - Default (env var absent): disabled
 *   - Enabled: set the variable to 1
 */
export const ENV_ENABLE_BASH_PTY_TOOLS = `${BRAND_FIXED_ENV_PREFIX}ENABLE_BASH_PTY_TOOLS`;

export function isBashPtyToolsEnabled(): boolean {
  return process.env[ENV_ENABLE_BASH_PTY_TOOLS] === '1';
}
