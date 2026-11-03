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
  /^(?:\.env.*|.*\.env|.*\.env~|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_rsa.*|id_ed25519.*|.*credentials.*|\.git-credentials|\.npmrc|\.netrc|gha-creds-.*\.json)$/;

// Git applies these pathspecs while enumerating, before any output is
// buffered: a full ignored listing of an installed checkout is several MB and
// used to overflow spawnSync's buffer before the JS filter could run.
const CREDENTIAL_PATHSPECS = [
  ':(glob)**/.env',
  ':(glob)**/.env*',
  ':(glob)**/*.env',
  ':(glob)**/*.env~',
  ':(glob)**/*.pem',
  ':(glob)**/*.key',
  ':(glob)**/*.p12',
  ':(glob)**/*.pfx',
  ':(glob)**/id_rsa*',
  ':(glob)**/id_ed25519*',
  ':(glob)**/*credentials*',
  ':(glob)**/.git-credentials',
  ':(glob)**/.npmrc',
  ':(glob)**/.netrc',
  ':(glob)**/gha-creds-*.json',
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

const EXCLUDED_SEGMENTS = new Set(['node_modules', 'dist']);

/** True for a path whose basename is credential-shaped. */
export function isCredentialShaped(path) {
  const name = basename(path);
  // A public key is not a credential; refusing id_rsa.pub would be noise.
  if (name.endsWith('.pub')) return false;
  return CREDENTIAL_BASENAME.test(name);
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
  // Git reports a real nested repository as its directory entry, which the
  // exclude pathspecs cannot match; drop installed/build segments here so a
  // vendored git dependency does not refuse the whole tree.
  return result.stdout
    .split('\0')
    .filter(Boolean)
    .filter((path) => !path.split('/').some((s) => EXCLUDED_SEGMENTS.has(s)))
    .sort();
}

/**
 * Returns local config entries that carry a credential PR code could read
 * with plain `git config`: fetch and push URLs (`remote.*.url`,
 * `remote.*.pushurl`), submodule URLs, `url.*.insteadOf` rewrites, and
 * `http.*.extraheader` values — the shape GitHub Actions itself writes an
 * `Authorization` header into. The credential-bearing headers are the
 * RFC 7235 pair, `Authorization` and `Proxy-Authorization`; other header
 * names stay clean. On an http(s) URL any userinfo counts: a token
 * used as the username (`https://<pat>@…`) is as readable as `user:pass@`.
 * The bare conventional username `git@` carries no secret and stays benign
 * in any spelling, matching `ssh://git@…` (SSH keys are not in the URL
 * either). `--includes` is load-bearing for the same reason as in prepare's
 * filter enumeration: `--local` alone names one file and skips
 * `include.path`, while the `git config --get` PR code uses follows it — a
 * credential defined in an included worktree file would otherwise be
 * readable in the tree but invisible to the scan.
 */
export function credentialBearingConfig(
  root,
  { maxBuffer = 8 * 1024 * 1024 } = {},
) {
  const result = spawnSync(
    'git',
    [
      '-C',
      root,
      'config',
      '--local',
      '--includes',
      '--get-regexp',
      '^(remote\\..*\\.(url|pushurl)|url\\..*\\.insteadof|submodule\\..*\\.url|http\\..*\\.extraheader)$',
    ],
    { encoding: 'utf8', maxBuffer },
  );
  // Exit 1 means the pattern matched nothing; anything else is a real failure.
  if (result.status === 1) return [];
  if (result.status !== 0) {
    throw new Error(
      `could not read local git config: ${(result.stderr || '').trim() || 'git failed'}`,
    );
  }
  const hasUserinfo = (value) => {
    const match = /^https?:\/\/([^/@\s]+)@/i.exec(value);
    // `git` is the conventional account name, not a secret, and account
    // names are case-insensitive; any other username-only userinfo may be
    // a token, so it stays refused.
    return match !== null && match[1].toLowerCase() !== 'git';
  };
  const isAuthHeader = (value) =>
    /^\s*(?:proxy-)?authorization\s*:/i.test(value);
  const hits = [];
  for (const line of result.stdout.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);
    const instead = /^url\.(.*)\.insteadof$/.exec(key);
    const extraheader = /^http\..*\.extraheader$/.test(key);
    if (
      extraheader
        ? isAuthHeader(value)
        : hasUserinfo(value) || (instead && hasUserinfo(instead[1]))
    ) {
      hits.push(key);
    }
  }
  return hits;
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
  const configHits = credentialBearingConfig(root, { maxBuffer });
  if (configHits.length > 0) {
    throw new Error(
      `credential-bearing git config in ${configHits[0]} — remove the credential from .git/config`,
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
