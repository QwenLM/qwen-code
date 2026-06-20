/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { resolveGitDir } from './gitDiff.js';
import { findGitRoot } from './gitUtils.js';

/**
 * Direct-read git helpers: resolve the current branch / HEAD by reading the
 * `.git` metadata files instead of spawning `git`. This mirrors the approach
 * Claude Code takes for hot-path reads (branch in the status line) — a plain
 * file read is microseconds versus milliseconds for a `git` subprocess, and it
 * cannot hang on a large repository.
 *
 * Scope: this only covers reading the current branch / HEAD. Heavier git
 * operations (diff, log, merge-base, remotes) still belong on the `git` binary.
 *
 * The `.git` directory itself is resolved by {@link resolveGitDir} (shared with
 * gitDiff — it walks up to the repo root and follows a worktree `gitdir:`
 * pointer); here we add a small cache plus HEAD parsing and a reflog watcher.
 */

const SHORT_SHA_LENGTH = 7;

// Control chars (0x00-0x1f), space (0x20), DEL (0x7f), and the characters git
// disallows in a ref name: ~ ^ : ? * [ and backslash.
// eslint-disable-next-line no-control-regex
const INVALID_REF_CHARS = /[\x00-\x20\x7f~^:?*[\\]/;

/**
 * Validate a branch/ref name well enough to trust it as a display value — and,
 * defensively, before anything downstream might use it as a path segment. This
 * is a sufficient subset of git's `check-ref-format` rules: it rejects empty
 * names, leading/trailing slashes, leading/trailing dots, `..` (path
 * traversal), `@{`, `.lock` suffixes, and the control/space/special characters
 * git itself forbids.
 */
export function isValidRefName(name: string): boolean {
  if (!name) return false;
  if (name.startsWith('/') || name.endsWith('/')) return false;
  if (name.startsWith('.') || name.endsWith('.')) return false;
  if (name.endsWith('.lock')) return false;
  if (name.includes('..') || name.includes('//')) return false;
  if (name.includes('@{')) return false;
  if (INVALID_REF_CHARS.test(name)) return false;
  return true;
}

/** A SHA-1 (40 hex) or SHA-256 (64 hex) object id. */
export function isValidGitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value) || /^[0-9a-f]{64}$/.test(value);
}

// resolveGitDir walks ancestors and parses the worktree gitdir pointer on every
// call; its result is stable for a given cwd within a session, so cache it
// (misses included). HEAD itself is never cached — it is re-read on every call
// so a branch switch is reflected immediately.
const gitDirCache = new Map<string, string | null>();

/** Clear the cached gitDir results (e.g. after a repo is created/removed). */
export function clearGitDirCache(): void {
  gitDirCache.clear();
}

/**
 * Resolve the gitDir for `cwd` and verify it is trustworthy for an automatic,
 * zero-click display read.
 *
 * Security: `resolveGitDir` follows a `.git`-FILE `gitdir:` pointer verbatim, so
 * a crafted project could point it at an arbitrary out-of-repo path and make us
 * read/watch a file outside the repo (the old `git rev-parse` path refused this
 * with exit 128). We require containment: after resolving symlinks, the gitDir
 * must be the repo's own `<root>/.git`, or a linked worktree / submodule gitdir
 * under some `.git/worktrees/` or `.git/modules/`. Anything else is rejected.
 */
async function resolveTrustedGitDir(cwd: string): Promise<string | null> {
  const gitDir = await resolveGitDir(cwd);
  if (!gitDir) return null;
  const root = findGitRoot(cwd);
  if (!root) return null;
  try {
    const realRoot = await fsPromises.realpath(root);
    const realGitDir = await fsPromises.realpath(gitDir);
    if (realGitDir === path.join(realRoot, '.git')) return gitDir;
    const segs = realGitDir.split(path.sep);
    for (let i = 0; i + 1 < segs.length; i++) {
      if (
        segs[i] === '.git' &&
        (segs[i + 1] === 'worktrees' || segs[i + 1] === 'modules')
      ) {
        return gitDir;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function getCachedGitDir(cwd: string): Promise<string | null> {
  const key = path.resolve(cwd);
  const cached = gitDirCache.get(key);
  if (cached !== undefined) return cached;
  const gitDir = await resolveTrustedGitDir(key);
  gitDirCache.set(key, gitDir);
  return gitDir;
}

/** Parsed HEAD: a branch name, or a detached commit (full object id). */
export interface GitHead {
  type: 'branch' | 'detached';
  /** Branch name when `type === 'branch'`, otherwise the full commit sha. */
  name: string;
}

/**
 * Read and parse `<gitDir>/HEAD` directly. Returns null when HEAD is missing,
 * unreadable, or unrecognized.
 *
 * The branch name is taken verbatim from the `ref: refs/heads/<branch>` line,
 * so packed-refs never need to be consulted. A detached HEAD holds the raw
 * object id, which is returned as-is (callers shorten it for display).
 */
export async function readGitHead(gitDir: string): Promise<GitHead | null> {
  const headPath = path.join(gitDir, 'HEAD');
  let content: string;
  try {
    // Refuse a symlinked HEAD: readFile would otherwise follow it out of the
    // repo and surface the target file's first line.
    if ((await fsPromises.lstat(headPath)).isSymbolicLink()) return null;
    content = (await fsPromises.readFile(headPath, 'utf-8')).trim();
  } catch {
    return null;
  }

  if (content.startsWith('ref:')) {
    const ref = content.slice(4).trim();
    if (!ref.startsWith('refs/heads/')) return null;
    const name = ref.slice('refs/heads/'.length);
    if (!isValidRefName(name)) return null;
    return { type: 'branch', name };
  }
  // Detached HEAD: the file holds a raw (SHA-1 or SHA-256) object id.
  if (isValidGitSha(content)) {
    return { type: 'detached', name: content };
  }
  return null;
}

/**
 * Resolve a display string for the current branch of `cwd`: the branch name,
 * or a short commit hash when detached. Returns undefined when `cwd` is not in
 * a git repository or HEAD can't be read.
 */
export async function resolveBranchName(
  cwd: string,
): Promise<string | undefined> {
  const gitDir = await getCachedGitDir(cwd);
  if (!gitDir) return undefined;
  const head = await readGitHead(gitDir);
  if (!head) return undefined;
  return head.type === 'branch'
    ? head.name
    : head.name.slice(0, SHORT_SHA_LENGTH);
}

interface RepoBranchWatch {
  watcher: fs.FSWatcher;
  subscribers: Set<() => void>;
}

// Keyed by resolved gitDir so that multiple subscribers on the same repository
// share a single fs.watch.
const repoBranchWatches = new Map<string, RepoBranchWatch>();

/**
 * Subscribe to branch changes for `cwd`'s repository.
 *
 * Multiple subscribers on the same git dir share one `fs.watch` on
 * `<gitDir>/logs/HEAD` (the reflog, which moves on branch switch / commit /
 * reset). The returned disposer removes this subscriber and tears the watch
 * down once the last subscriber leaves. If the repo can't be resolved or has
 * no reflog yet, the disposer is a harmless no-op.
 */
export async function watchRepoBranch(
  cwd: string,
  onChange: () => void,
): Promise<() => void> {
  const gitDir = await getCachedGitDir(cwd);
  if (!gitDir) return () => {};

  let entry = repoBranchWatches.get(gitDir);
  if (!entry) {
    const logsHeadPath = path.join(gitDir, 'logs', 'HEAD');
    try {
      await fsPromises.access(logsHeadPath, fs.constants.F_OK);
      // Refuse a symlinked reflog: we'd otherwise place a persistent watch on a
      // file outside the repo.
      if ((await fsPromises.lstat(logsHeadPath)).isSymbolicLink()) {
        return () => {};
      }
    } catch {
      // No reflog yet (unborn repo) or unreadable. Return a no-op without
      // caching a watcher-less entry, so a later caller can establish the
      // watch once the reflog appears (e.g. after the first commit).
      return () => {};
    }
    // A concurrent caller may have registered the entry while we awaited
    // access(); this post-await block runs atomically w.r.t. other microtasks,
    // so re-checking here guarantees a single watcher per gitDir.
    const existing = repoBranchWatches.get(gitDir);
    if (existing) {
      entry = existing;
    } else {
      let watcher: fs.FSWatcher;
      try {
        watcher = fs.watch(logsHeadPath, (eventType: string) => {
          if (eventType === 'change' || eventType === 'rename') {
            repoBranchWatches.get(gitDir)?.subscribers.forEach((cb) => cb());
          }
        });
      } catch {
        // fs.watch throws synchronously if logs/HEAD vanished after access()
        // (TOCTOU: git gc / reflog expire / worktree removal) or a platform
        // watch limit (ENOSPC) is hit. Fall back to a no-op rather than
        // rejecting (which the hook's bare `void init()` would surface as an
        // unhandled rejection).
        return () => {};
      }
      // fs.FSWatcher is an EventEmitter: an unhandled 'error' (reflog removed
      // by `git gc` / `reflog expire`, worktree removal, inode change, or a
      // platform watch limit) would crash the process. Tear the watch down
      // instead — subscribers simply stop auto-refreshing.
      watcher.on('error', () => {
        const current = repoBranchWatches.get(gitDir);
        if (current?.watcher === watcher) {
          try {
            watcher.close();
          } catch {
            // already closed
          }
          repoBranchWatches.delete(gitDir);
        }
      });
      entry = { watcher, subscribers: new Set() };
      repoBranchWatches.set(gitDir, entry);
    }
  }

  entry.subscribers.add(onChange);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const e = repoBranchWatches.get(gitDir);
    if (!e) return;
    e.subscribers.delete(onChange);
    if (e.subscribers.size === 0) {
      e.watcher.close();
      repoBranchWatches.delete(gitDir);
    }
  };
}
