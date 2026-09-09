/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPinnedPnpmPackage } from './pnpm-package.js';

const corepack = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
// The script lives in <repo>/scripts, so it bootstraps the checkout it
// belongs to no matter which directory the caller runs it from.
const rootDir = fileURLToPath(new URL('..', import.meta.url));
getPinnedPnpmPackage(
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')),
);
const env = {
  ...process.env,
  QWEN_SKIP_PREPARE: '1',
  QWEN_SKIP_NOTICE_GENERATION: '1',
};

// A spread of process.env is an ordinary object: on Windows the path
// variable canonically arrives as `Path`, so a case-sensitive `env.PATH`
// read misses it and corepack is never found.
function envValue(name) {
  if (process.platform !== 'win32') return env[name];
  const key = Object.keys(env).find((key) => key.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function pathValue() {
  return envValue('PATH') ?? '';
}

function findOnPath(command) {
  for (const entry of pathValue().split(delimiter)) {
    const directory = entry.replace(/^"(.*)"$/, '$1');
    const candidate = resolve(directory || '.', command);
    if (existsSync(candidate)) return candidate;
  }

  return undefined;
}

const corepackPath = findOnPath(corepack);
if (!corepackPath) {
  console.error(
    'worktree setup failed: Corepack is required to verify the pinned pnpm package',
  );
  process.exit(1);
}

function runPnpm(args) {
  return spawnSync(corepack, ['pnpm', ...args], {
    cwd: rootDir,
    env,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });
}

function getHooksPath() {
  const result = spawnSync('git', ['config', '--get', 'core.hooksPath'], {
    cwd: rootDir,
    env,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

// Husky runs `git config core.hooksPath .husky/_` with no --worktree, so the
// value always lands in the config of the root that owns `.git` while the
// `.husky/_` wrappers are created in the working directory it was invoked from.
// Those are the same root here unless `.git` is a file, which is how git marks
// a linked worktree pointing at the primary's `.git/worktrees/<name>`.
function ownsRepositoryConfig() {
  const gitEntry = statSync(resolve(rootDir, '.git'), {
    throwIfNoEntry: false,
  });
  return gitEntry === undefined || gitEntry.isDirectory();
}

function install(cacheMode) {
  const result = runPnpm(['install', '--frozen-lockfile', cacheMode]);
  if (result.status === 0) {
    const hooksPath = getHooksPath();
    if (
      envValue('HUSKY') === '0' ||
      (hooksPath !== undefined && hooksPath !== '.husky/_')
    ) {
      exitWithResult(result);
    }
    // With the key unset, husky's write would add it to the config shared by
    // every worktree of this repository while only this checkout receives
    // `.husky/_`, silently repointing hook resolution for roots that never got
    // the wrappers. Leave that config alone and say so instead. `prepare.js`'s
    // `run('husky')` needs no such guard: it installs the checkout that owns
    // the config it writes.
    if (hooksPath === undefined && !ownsRepositoryConfig()) {
      console.log(
        'worktree setup: core.hooksPath is unset and this linked worktree does ' +
          'not own the repository config; skipping Husky so the hooks path is ' +
          'not rewritten for every other worktree.',
      );
      exitWithResult(result);
    }
    const husky = runPnpm(['exec', 'husky']);
    if (husky.status === 0 && getHooksPath() !== '.husky/_') {
      console.error('worktree setup failed: Husky did not install hooks');
      process.exit(1);
    }
    exitWithResult(husky);
  }
  return result;
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

// install() exits the process on every path where the install succeeded, so it
// returns only a failed result and the registry retry below is the only
// decision left for this driver to make.
const cachedInstall = install('--offline');

if (
  cachedInstall.error ||
  cachedInstall.signal ||
  (cachedInstall.status !== null && cachedInstall.status >= 128)
) {
  exitWithResult(cachedInstall);
}

console.warn('Cached install unavailable; retrying with registry access.');
exitWithResult(install('--prefer-offline'));
