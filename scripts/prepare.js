/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';

// Release workflow jobs set this when they run explicit build/bundle steps after
// npm ci. Workflows that rely on prepare-during-install should leave it unset.
const skipPrepare = ['1', 'true'].includes(
  (process.env.QWEN_SKIP_PREPARE ?? '').toLowerCase(),
);

if (skipPrepare) {
  console.log('Skipping prepare because QWEN_SKIP_PREPARE is set.');
  process.exit(0);
}

run('husky');
run('npm', ['run', 'build']);
run('npm', ['run', 'bundle']);

function run(command, args = []) {
  const result = spawnSync(command, args, {
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.signal) {
    console.error(`${command} exited with signal ${result.signal}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    const label = args.length ? `${command} ${args.join(' ')}` : command;
    console.error(`prepare: ${label} exited with status ${result.status}`);
    process.exit(result.status ?? 1);
  }
}
