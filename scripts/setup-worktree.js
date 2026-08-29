/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { constants as osConstants } from 'node:os';

const corepack = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
const args = ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline'];
const result = spawnSync(corepack, args, {
  env: {
    ...process.env,
    QWEN_SKIP_PREPARE: '1',
  },
  shell: process.platform === 'win32',
  stdio: 'inherit',
});

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
