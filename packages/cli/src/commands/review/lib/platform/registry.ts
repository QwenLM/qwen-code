/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Provider registry. Detection (URL grammar, remote probing, settings
// override) arrives with the second provider — until then every subcommand
// gets the GitHub reader, and this function is the one place that answer
// comes from.

import { githubReader } from './github.js';
import type { ReviewPlatformReader } from './types.js';

export function getPlatformReader(): ReviewPlatformReader {
  return githubReader;
}
