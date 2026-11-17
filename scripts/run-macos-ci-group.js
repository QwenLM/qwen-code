/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function runMacOsGroup(group, shard, spawn = spawnSync) {
  const options = {
    stdio: 'inherit',
    env:
      group === 'scripts'
        ? process.env
        : { ...process.env, NODE_OPTIONS: '--max-old-space-size=3072' },
  };
  const run = (args) => spawn('npm', args, options).status ?? 1;

  if (group === 'cli' || group === 'core') {
    return run([
      'run',
      'test:ci',
      `--workspace=packages/${group}`,
      '--',
      `--shard=${shard}`,
    ]);
  }
  if (group === 'scripts') {
    const standalone = run(['run', 'test:standalone:runtimes:ci']);
    const scripts = run(['run', 'test:scripts:unit']);
    return standalone || scripts;
  }
  if (group !== 'rest') {
    throw new Error(`Unknown macOS test group: ${group}`);
  }

  const metadata = spawn(
    'npm',
    ['pkg', 'get', 'scripts.test:ci', '--workspaces', '--json'],
    { encoding: 'utf8' },
  );
  if (metadata.status !== 0) return metadata.status ?? 1;
  const workspaces = Object.entries(JSON.parse(metadata.stdout))
    .filter(
      ([name, script]) =>
        typeof script === 'string' &&
        name !== '@qwen-code/qwen-code' &&
        name !== '@qwen-code/qwen-code-core',
    )
    .map(([name]) => `--workspace=${name}`);
  if (workspaces.length === 0) {
    throw new Error('No remaining workspace test suites were discovered');
  }
  return run(['run', 'test:ci', ...workspaces]);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = runMacOsGroup(process.argv[2], process.argv[3]);
}
