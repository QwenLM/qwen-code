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
 * Installed dependencies and build output are excluded at any depth: a
 * workspace package's own `node_modules` and `dist` are as irrelevant as the
 * root ones, and `node_modules` alone ships hundreds of `credentials*` files.
 * The pathspecs both restrict enumeration to credential-shaped names and
 * exclude those directories, so an installed tree's multi-megabyte ignored
 * listing never reaches the output buffer. A credential file placed in the
 * project (including a nested ignored directory) is still reported. Two
 * exclusions are deliberate: credentials inside `node_modules`/`dist` are
 * accepted as installed/build content, and a nested git repository is refused
 * outright because git will not descend into it — scan that clone separately.
 *
 * Usage:
 *   node scripts/verify-pr-credential-scan.mjs <root>
 *
 * Exit codes: 0 clean, 1 credential-shaped entries found, 2 usage error.
 */

import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { isEntryPoint } from './lib/entry-point.js';

const CREDENTIAL_BASENAME =
  /^(?:\.env(?:\..*)?|.*\.env|.*\.pem|.*\.key|credentials.*|\.npmrc|\.netrc)$/;

// Git applies these pathspecs while enumerating, before any output is
// buffered: a full ignored listing of an installed checkout is several MB and
// used to overflow spawnSync's buffer before the JS filter could run.
const CREDENTIAL_PATHSPECS = [
  ':(glob)**/.env',
  ':(glob)**/.env.*',
  ':(glob)**/*.env',
  ':(glob)**/*.pem',
  ':(glob)**/*.key',
  ':(glob)**/credentials*',
  ':(glob)**/.npmrc',
  ':(glob)**/.netrc',
  ':(exclude,glob)**/node_modules/**',
  ':(exclude,glob)**/dist/**',
];

// A nested clone is a repository git does not descend into, so a credential
// file inside it would silently pass an ignored-file scan. Dependencies and
// build output keep their own exclusion: a vendored `.git` is no more a
// project credential than a vendored `.env`.
const NESTED_REPO_PATHSPECS = [
  ':(glob)**/.git',
  ':(exclude,glob)**/node_modules/**',
  ':(exclude,glob)**/dist/**',
];

/** True for a path whose basename is credential-shaped. */
export function isCredentialShaped(path) {
  return CREDENTIAL_BASENAME.test(basename(path));
}

export function gitScanArgs(root) {
  return [
    '-C',
    root,
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '-z',
    '--',
    ...CREDENTIAL_PATHSPECS,
  ];
}

/** Returns the nested repositories found under `root`, sorted. */
export function nestedGitRepos(root, { maxBuffer = 8 * 1024 * 1024 } = {}) {
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
      '--',
      ...NESTED_REPO_PATHSPECS,
    ],
    { encoding: 'utf8', maxBuffer },
  );
  if (result.status !== 0) {
    throw new Error(
      `could not list nested repositories: ${(result.stderr || '').trim() || 'git failed'}`,
    );
  }
  return result.stdout.split('\0').filter(Boolean).sort();
}

/**
 * Returns the ignored credential-shaped files under `root`, sorted. An empty
 * array is the clean state; a git failure is thrown so the caller can refuse
 * rather than treat it as clean, and a nested repository is refused because a
 * scan of the outer tree cannot see into it.
 */
export function scanIgnoredCredentials(
  root,
  { maxBuffer = 8 * 1024 * 1024 } = {},
) {
  const nested = nestedGitRepos(root, { maxBuffer });
  if (nested.length > 0) {
    throw new Error(
      `nested git repository under ${nested[0]} — scan that clone separately or remove it`,
    );
  }
  const result = spawnSync('git', gitScanArgs(root), {
    encoding: 'utf8',
    maxBuffer,
  });
  if (result.status !== 0) {
    throw new Error(
      `could not list ignored files: ${(result.stderr || '').trim() || 'git failed'}`,
    );
  }
  return result.stdout
    .split('\0')
    .filter(Boolean)
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
