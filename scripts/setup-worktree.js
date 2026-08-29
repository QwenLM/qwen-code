/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { delimiter, resolve } from 'node:path';

import { getPinnedPnpmPackage } from './pnpm-package.js';

const corepack = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const packageManager = getPinnedPnpmPackage(
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')),
);
const env = {
  ...process.env,
  QWEN_SKIP_PREPARE: '1',
  QWEN_SKIP_NOTICE_GENERATION: '1',
};

function findOnPath(command) {
  for (const entry of (env.PATH ?? '').split(delimiter)) {
    const directory = entry.replace(/^"(.*)"$/, '$1');
    const candidate = resolve(directory || '.', command);
    if (existsSync(candidate)) return candidate;
  }

  return undefined;
}

const corepackPath = findOnPath(corepack);

function runPnpm(args) {
  const runner = corepackPath
    ? [corepack, ['pnpm', ...args]]
    : [npx, ['--yes', packageManager, ...args]];
  let result = spawnSync(runner[0], runner[1], {
    env,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });

  if (corepackPath && result.error?.code === 'ENOENT') {
    result = spawnSync(npx, ['--yes', packageManager, ...args], {
      env,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });
  }

  return result;
}

function install(cacheMode) {
  return runPnpm(['install', '--frozen-lockfile', cacheMode]);
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
