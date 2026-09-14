/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
  if (result.status === 0) return result.stdout.trim();
  // git exits 1 when the key is absent, and a spawn failure means git itself
  // is unavailable — the ownership probe below reports that shape as having
  // no repository. Any other status is a read failure (a refused config on a
  // shared host, a config error) the hooks decision must not be made from.
  if (result.status === 1 || result.error) return undefined;
  console.error(
    `worktree setup failed: could not read core.hooksPath (${result.stderr.trim()})`,
  );
  process.exit(1);
}

// Husky runs `git config core.hooksPath .husky/_` with no --worktree, so the
// value always lands in the config of the root that owns the repository while
// the `.husky/_` wrappers are created in the working directory it was invoked
// from. Git names that root: `--git-dir` differs from `--git-common-dir` only
// in a linked worktree, whose config every sibling worktree shares. The shape
// of `.git` is no proxy for it — a file also means a `--separate-git-dir` clone
// or a submodule, which own their config, and no `.git` means no repository.
function repositoryConfigOwnership() {
  const probe = spawnSync(
    'git',
    ['rev-parse', '--git-dir', '--git-common-dir'],
    { cwd: rootDir, env, encoding: 'utf8' },
  );
  if (probe.status !== 0) return 'none';
  const [gitDir, commonDir] = probe.stdout.trim().split(/\r?\n/);
  return gitDir === commonDir ? 'owns' : 'linked';
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
    // Without a repository there is no config for husky to write. With the key
    // unset in a linked worktree, husky's write would add it to the config
    // every worktree of this repository shares while only this checkout
    // receives `.husky/_`, silently repointing hook resolution for roots that
    // never got the wrappers. Leave both alone and say so instead.
    const ownership = repositoryConfigOwnership();
    if (
      ownership === 'none' ||
      (hooksPath === undefined && ownership === 'linked')
    ) {
      console.log(
        ownership === 'none'
          ? 'worktree setup: git could not resolve a repository for this ' +
              'checkout; skipping Husky because there is no repository config ' +
              'for it to write.'
          : 'worktree setup: core.hooksPath is unset and this checkout does not ' +
              'own the repository config; skipping Husky so the hooks path is ' +
              'not rewritten for every other worktree. Re-run this script here ' +
              'once hooks are installed in the primary checkout.',
      );
      exitWithResult(result);
    }
    // Husky exits 0 on every soft failure (`.git can't be found`, a refused
    // `git config` write), so success takes both proofs: the config value says
    // git will use the hooks, and a wrapper on disk says husky wrote them here.
    const husky = runPnpm(['exec', 'husky']);
    if (
      husky.status === 0 &&
      (getHooksPath() !== '.husky/_' ||
        !existsSync(resolve(rootDir, '.husky', '_', 'pre-commit')))
    ) {
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
