/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';

let cached: boolean | undefined;

/**
 * Probes the daemon host's `git` binary once. Sandboxed or minimal hosts may
 * not ship one, and the Web Shell must hide cloning rather than offer an
 * affordance that always fails.
 */
export function isGitAvailable(): boolean {
  if (cached !== undefined) return cached;
  try {
    execFileSync('git', ['--version'], {
      stdio: 'ignore',
      timeout: 3000,
      windowsHide: true,
    });
    cached = true;
  } catch {
    cached = false;
  }
  return cached;
}
