#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Refuses credential-shaped ignored files in a `/verify-pr` round tree.
 *
 * The isolation gate checks known environment names and home-relative paths,
 * and `verify-pr-prepare.mjs` refuses untracked files; a gitignored credential
 * file is invisible to both. This scan lists ignored files one by one (git
 * status collapses ignored directories into one line, which is why a widened
 * pathspec set used to refuse every installed tree) and matches the basenames
 * a provider key or certificate typically uses.
 *
 * Installed dependencies and build output are excluded: `node_modules` alone
 * ships hundreds of `credentials*` files, and refusing a built tree would make
 * the recipe's own tree-build route unusable. A credential file placed in the
 * project (including a nested ignored directory) is still reported.
 *
 * Usage:
 *   node scripts/verify-pr-credential-scan.mjs <root>
 *
 * Exit codes: 0 clean, 1 credential-shaped entries found, 2 usage error.
 */

import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { isEntryPoint } from './lib/entry-point.js';

const EXCLUDED_DIRS = ['node_modules/', 'dist/', '.git/'];

const CREDENTIAL_BASENAME =
  /^(?:\.env(?:\..*)?|.*\.env|.*\.pem|.*\.key|credentials.*|\.npmrc|\.netrc)$/;

/** True for a path whose basename is credential-shaped. */
export function isCredentialShaped(path) {
  return CREDENTIAL_BASENAME.test(basename(path));
}

/** True for an ignored path under an installed/build directory. */
export function isExcluded(path) {
  return EXCLUDED_DIRS.some(
    (dir) => path === dir.slice(0, -1) || path.startsWith(dir),
  );
}

/**
 * Returns the ignored credential-shaped files under `root`, sorted. An empty
 * array is the clean state; a git failure is thrown so the caller can refuse
 * rather than treat it as clean.
 */
export function scanIgnoredCredentials(root) {
  const result = spawnSync(
    'git',
    [
      '-C',
      root,
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '-z',
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `could not list ignored files: ${(result.stderr || '').trim() || 'git failed'}`,
    );
  }
  return result.stdout
    .split('\0')
    .filter(Boolean)
    .filter((path) => !isExcluded(path))
    .filter((path) => isCredentialShaped(path))
    .sort();
}

function main(argv) {
  const root = argv[0];
  if (!root || argv.length > 1) {
    process.stderr.write(
      'Usage: node scripts/verify-pr-credential-scan.mjs <root>\n',
    );
    return 2;
  }
  let found;
  try {
    found = scanIgnoredCredentials(root);
  } catch (error) {
    process.stderr.write(`verify-pr credential scan: ${error.message}\n`);
    return 1;
  }
  for (const path of found) {
    process.stdout.write(`credential-shaped ignored entry: ${path}\n`);
  }
  return found.length === 0 ? 0 : 1;
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
