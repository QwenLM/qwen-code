/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from './config.js';

/** Model used by built-in lightweight tasks when no model was selected. */
export async function getDefaultUtilityModel(
  _session: Config,
): Promise<string> {
  return 'lite';
}
