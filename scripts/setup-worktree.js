/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { constants as osConstants } from 'node:os';

const corepack = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
const env = {
  ...process.env,
  QWEN_SKIP_PREPARE: '1',
};

function install(cacheMode) {
  return spawnSync(
    corepack,
    ['pnpm', 'install', '--frozen-lockfile', cacheMode],
    {
      env,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    },
  );
}

function exitWithResult(result) {
  if (result.error) {
    console.error(`worktree setup failed: ${result.error.message}`);
    process.exit(1);
  }

  if (result.signal) {
    console.error(`worktree setup killed by signal ${result.signal}`);
    const signalNumber = osConstants.signals[result.signal];
    process.exit(signalNumber ? 128 + signalNumber : 1);
  }

  process.exit(result.status ?? 1);
}

const cachedInstall = install('--offline');
if (cachedInstall.status === 0) {
  process.exit(0);
}

if (
  cachedInstall.error ||
  cachedInstall.signal ||
  (cachedInstall.status !== null && cachedInstall.status >= 128)
) {
  exitWithResult(cachedInstall);
}

console.warn('Cached install unavailable; retrying with registry access.');
exitWithResult(install('--prefer-offline'));
