/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { rm } from 'node:fs/promises';

// Prefix of the per-agent QWEN_HOMEs cli/acp-integration.test.ts creates
// directly under the OS temp dir. It must stay nested under the sweeper's
// prefix (HERMETIC_HOME_PREFIX in globalSetup.ts): sweepLeakedQwenHomes
// reclaims exactly the tmpdir entries that start with it and are older than
// a day, so a home outside it is orphaned permanently the moment a worker is
// torn down before its best-effort cleanup runs. globalSetup.test.ts pins
// this nesting.
export const ACP_HOME_PREFIX = 'qwen-e2e-home-acp-';

export async function removeScratchDir(dir: string): Promise<void> {
  try {
    // A CLI child outliving its test keeps writing under its scratch dir, so
    // the removal walk can reach a directory that refills before the rmdir —
    // retries absorb that. The catch is what matters: a cleanup that cannot
    // finish must not turn an all-green run red, the way the memory-file
    // restore did in #10325.
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  } catch (e) {
    console.error(`Warning: could not remove ${dir}:`, e);
  }
}
