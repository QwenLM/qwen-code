/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isValidRefName } from './gitDirect.js';
import { runGit } from './git-branches.js';

export interface GitRemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

// C1 controls plus Unicode's Default_Ignorable set — zero-width marks,
// line/paragraph separators, the bidi marks and embeddings (LRM/RLM/ALM
// included: a URL is a run of neutral characters, exactly what bidi
// reordering spoofing targets), soft hyphen, variation selectors. Based on
// gitDirect's INVALID_REF_CHARS display policy, extended to the full
// ignorable set for this HTML-rendered surface. Space is deliberately
// allowed: local-path remotes may contain it. (No eslint-disable needed:
// no-control-regex only covers ASCII 0x00-0x1f.)
const INVISIBLE_CHARS =
  // The class intentionally matches combining marks (CGJ, Mongolian FVS,
  // variation selectors) as individual code points — stripping them is the
  // point, not matching a whole grapheme.
  // eslint-disable-next-line no-misleading-character-class
  /[\x7f-\x9f\u00ad\u034f\u061c\u180b-\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufe00-\ufe0f]/;

/**
 * Whether `name` is acceptable for `git remote add`. Git applies its refname
 * rules to `refs/remotes/<name>/*`, so the branch predicate is the right
 * base; on top of it reject `/` (a remote is a single component) and a
 * leading `-` (the value is passed in the execFile arg vector and must never
 * read as an option).
 */
export function isValidRemoteName(name: string): boolean {
  return isValidRefName(name) && !name.includes('/') && !name.startsWith('-');
}

/**
 * Whether `url` is safe to pass to `git remote add`. Git accepts almost any
 * non-empty string (https/ssh/scp-like/local paths), so this only guards the
 * exec vector (leading `-`, control chars), the display surface (invisible
 * characters) and rejects blanks.
 */
export function isValidRemoteUrl(url: string): boolean {
  return (
    url.length > 0 &&
    !url.startsWith('-') &&
    !CONTROL_CHARS.test(url) &&
    !INVISIBLE_CHARS.test(url)
  );
}

// Removal targets a remote git already has configured, so it must not be
// stricter than git itself (a hand-edited `.git/config` can hold names the
// add predicate rejects) — only the exec vector is guarded.
export function isRemovableRemoteName(name: string): boolean {
  return name.length > 0 && !name.startsWith('-') && !CONTROL_CHARS.test(name);
}

// Bound the per-name lookup fan-out: the name list comes from config the
// user may not have authored, and 2N concurrent git processes for a
// many-remote repo would pressure the daemon that serves every workspace.
const REMOTE_LOOKUP_CONCURRENCY = 8;

function isNoSuchRemoteError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { stdout?: unknown; stderr?: unknown };
  const text = `${typeof e.stdout === 'string' ? e.stdout : ''}\n${
    typeof e.stderr === 'string' ? e.stderr : ''
  }`;
  return /no such remote/i.test(text);
}

/**
 * List the configured remotes of the repository at `cwd`, in the order
 * `git remote` prints them (sorted). A remote without a push-URL override
 * reports `pushUrl === fetchUrl`.
 *
 * Uses the structured accessors (`git remote` + `git remote get-url`), not
 * the rendered `git remote -v`: git annotates that output for
 * promisor/partial-clone remotes (`… (fetch) [blob:none]`), and parsing the
 * rendered surface is exactly the trap `commands/review/lib/remote-match.ts`
 * already had to patch once. Outside a repository `git remote` itself fails
 * with `fatal: not a git repository`, which the route layer classifies.
 */
export async function fetchGitRemotes(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<GitRemoteInfo[]> {
  const namesRaw = await runGit(cwd, ['remote'], env);
  const names = namesRaw
    .split('\n')
    .filter((line) => line.trim() !== '')
    // The exec-vector guard: a hand-written config could name a remote that
    // would read as a flag to `get-url`.
    .filter((name) => isRemovableRemoteName(name));
  const lookup = async (name: string): Promise<GitRemoteInfo | null> => {
    try {
      const [fetchUrl, pushUrl] = await Promise.all([
        runGit(cwd, ['remote', 'get-url', name], env),
        // `--push` answers the pushurl override, falling back to the
        // fetch url when there is none — exactly what the UI displays.
        runGit(cwd, ['remote', 'get-url', '--push', name], env),
      ]);
      return { name, fetchUrl: fetchUrl.trim(), pushUrl: pushUrl.trim() };
    } catch (err) {
      // Only the vanished-remote race (a concurrent `git remote remove`
      // won between the listing and the lookup) is omitted. Any other
      // failure — spawn error, timeout — rethrows: silently dropping rows
      // would answer 200 with a truncated list. A configured remote with
      // no URL is neither case — `get-url` falls back to answering the
      // remote name, per git's own semantics.
      if (isNoSuchRemoteError(err)) return null;
      throw err;
    }
  };
  const infos: Array<GitRemoteInfo | null> = [];
  for (let i = 0; i < names.length; i += REMOTE_LOOKUP_CONCURRENCY) {
    const batch = await Promise.all(
      names.slice(i, i + REMOTE_LOOKUP_CONCURRENCY).map(lookup),
    );
    infos.push(...batch);
  }
  return infos.filter((info): info is GitRemoteInfo => info !== null);
}

/**
 * Add a remote and return the fresh list. Throws when the name or URL fails
 * validation, or when git rejects the add (e.g. duplicate name).
 */
export async function gitRemoteAdd(
  cwd: string,
  name: string,
  url: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<GitRemoteInfo[]> {
  const trimmedUrl = url.trim();
  if (!isValidRemoteName(name)) {
    throw new Error(`invalid remote name: ${name}`);
  }
  if (!isValidRemoteUrl(trimmedUrl)) {
    throw new Error('invalid remote url');
  }
  await runGit(cwd, ['remote', 'add', name, trimmedUrl], env);
  return fetchGitRemotes(cwd, env);
}

/**
 * Remove a remote (and its remote-tracking refs, per git semantics) and
 * return the fresh list. Throws when git reports no such remote.
 */
export async function gitRemoteRemove(
  cwd: string,
  name: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<GitRemoteInfo[]> {
  if (!isRemovableRemoteName(name)) {
    throw new Error(`invalid remote name: ${name}`);
  }
  await runGit(cwd, ['remote', 'remove', name], env);
  return fetchGitRemotes(cwd, env);
}
