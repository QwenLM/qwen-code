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
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isEntryPoint } from './lib/entry-point.js';

const CREDENTIAL_BASENAME =
  /^(?:\.env.*|.*\.env|.*\.env~|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_(?:rsa|ed25519|ecdsa|dsa).*|.*credentials.*|\.git-credentials|\.npmrc|\.netrc|gha-creds-.*\.json)$/;

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
  ':(glob)**/id_ecdsa*',
  ':(glob)**/id_dsa*',
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

/**
 * Returns the nested repositories found under `root`, sorted. Three surfaces
 * are enumerated, because git collapses a nested working tree to a directory
 * entry on each of them: an ignored clone, an untracked NON-ignored clone
 * (the shape a round's own `git clone` leaves behind), and a populated
 * submodule (a mode-160000 gitlink whose directory carries a `.git`).
 * Dependencies and build output keep their exclusion on every surface: a
 * vendored `.git` is no more a project credential than a vendored `.env`.
 */
export function nestedGitRepos(root, { maxBuffer = 8 * 1024 * 1024 } = {}) {
  const git = (args) => {
    const result = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      maxBuffer,
    });
    if (result.status !== 0) {
      throw new Error(
        `could not list nested repositories: ${(result.stderr || '').trim() || 'git failed'}`,
      );
    }
    return result.stdout;
  };
  const excluded = (path) =>
    path.split('/').some((segment) => EXCLUDED_SEGMENTS.has(segment));
  const found = new Set();
  const ignored = git([
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '-z',
    '--',
    ...NESTED_REPO_PATHSPECS,
  ]);
  for (const path of ignored.split('\0')) {
    if (!path || excluded(path)) continue;
    found.add(path.replace(/\/$/, ''));
  }
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']);
  for (const entry of untracked.split('\0')) {
    if (!entry.endsWith('/') || excluded(entry)) continue;
    if (existsSync(join(root, entry, '.git'))) {
      found.add(entry.replace(/\/$/, ''));
    }
  }
  const staged = git(['ls-files', '--stage', '-z']);
  for (const record of staged.split('\0')) {
    if (!record.startsWith('160000 ')) continue;
    const tab = record.indexOf('\t');
    const path = tab === -1 ? '' : record.slice(tab + 1);
    if (!path || excluded(path)) continue;
    // An unpopulated gitlink has no working tree to read; its URL is covered
    // by the config value scan instead.
    if (existsSync(join(root, path, '.git'))) found.add(path);
  }
  return [...found].sort();
}

/**
 * Returns local config entries that carry a credential PR code could read
 * with plain `git config`. The scan inspects VALUES, not a list of keys: any
 * config value can hold a URL with a token (`http.proxy`, a novel mirror
 * key, tomorrow's sibling of `pushurl`), so a key allowlist never converges.
 * A value hits when it embeds http(s) userinfo or when it is an
 * `Authorization` / `Proxy-Authorization` header (the RFC 7235 pair GitHub
 * Actions writes into `http.*.extraheader`); other header names stay clean.
 * The two URL-bearing KEY families are judged too: `url.*.insteadOf` /
 * `url.*.pushInsteadOf` rewrites and `http.<url>.*` sections carry their URL
 * in the key, not the value. On an http(s) URL any userinfo counts — a token
 * used as the username (`https://<pat>@…`) is as readable as `user:pass@` —
 * except the bare conventional account name `git@` in any spelling, which
 * carries no secret, matching `ssh://git@…`. `--includes` follows
 * `include.path` the way the `git config --get` PR code uses does, and
 * `--list --null` frames each `key\nvalue` record so a multi-line value
 * cannot forge entries. A `credential.helper` COMMAND is out of this
 * URL/header contract by design (see the design record); prepare disables
 * helpers for its own reads.
 */
export function credentialBearingConfig(
  root,
  { maxBuffer = 8 * 1024 * 1024 } = {},
) {
  const result = spawnSync(
    'git',
    ['-C', root, 'config', '--local', '--includes', '--list', '--null'],
    { encoding: 'utf8', maxBuffer },
  );
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
  for (const record of result.stdout.split('\0')) {
    if (!record) continue;
    const newline = record.indexOf('\n');
    const key = newline === -1 ? record : record.slice(0, newline);
    const value = newline === -1 ? '' : record.slice(newline + 1);
    const rewrite = /^url\.(.*)\.(insteadof|pushinsteadof)$/.exec(key);
    const httpSection = /^http\.(.+)\.[^.]+$/.exec(key);
    if (
      hasUserinfo(value) ||
      isAuthHeader(value) ||
      (rewrite && hasUserinfo(rewrite[1])) ||
      (httpSection && hasUserinfo(httpSection[1]))
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
