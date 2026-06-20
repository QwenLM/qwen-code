/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { resolveGitDir } from './gitDiff.js';
import { createDebugLogger } from './debugLogger.js';

/**
 * Direct-read git helpers: resolve the current branch / HEAD by reading the
 * `.git` metadata files instead of spawning `git`. A plain file read is
 * microseconds versus milliseconds for a `git` subprocess on a hot path (the
 * status line re-reads the branch on render), and it cannot hang on a large
 * repository.
 *
 * Scope: this only covers reading the current branch / HEAD. Heavier git
 * operations (diff, log, merge-base, remotes) still belong on the `git` binary.
 *
 * The `.git` directory itself is resolved by {@link resolveGitDir} (shared with
 * gitDiff — it walks up to the repo root and follows a worktree `gitdir:`
 * pointer); here we add a small cache plus HEAD parsing and a reflog watcher.
 */

const SHORT_SHA_LENGTH = 7;

// Failure returns are intentionally silent for the common cases (not a repo, no
// HEAD): a status-line display must not log-spam. Only the unexpected paths
// (watcher errors) emit a debug line, consistent with the other utils here.
const debug = createDebugLogger('gitDirect');

// Bound the HEAD read: it is one short line, never megabytes.
const MAX_HEAD_BYTES = 4096;
// git's per-component length cap (a filesystem limit). Applied per
// slash-separated component, NOT to the whole ref — a valid ref can be longer
// than one component's limit.
const MAX_REF_COMPONENT_LENGTH = 255;

// Control chars (C0 0x00-0x1f, space 0x20, DEL 0x7f, C1 0x80-0x9f), zero-width
// (U+200B-U+200D, U+FEFF) and bidi-override (U+202A-U+202E, U+2066-U+2069)
// characters, the Unicode line separators, and the characters git disallows in a
// ref name: ~ ^ : ? * [ and backslash. With `git` no longer vetting the value, a
// hand-written HEAD could otherwise smuggle terminal escapes (CSI/OSC), bidi or
// zero-width spoofing, or line separators into the status-line branch name.
// The class is long but must stay on one line so the eslint-disable applies.
// prettier-ignore
// eslint-disable-next-line no-control-regex
const INVALID_REF_CHARS = /[\x00-\x20\x7f-\x9f\u200b-\u200d\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff~^:?*[\\]/;

/**
 * Validate a branch/ref name well enough to trust it as a display value — and,
 * defensively, before anything downstream might use it as a path segment. This
 * is a sufficient subset of git's `check-ref-format` rules: it rejects empty
 * names, leading/trailing slashes, leading/trailing dots, `..` (path
 * traversal), `@{`, `.lock` suffixes, and the control/space/special characters
 * git itself forbids.
 */
export function isValidRefName(name: string): boolean {
  // 'HEAD' is ambiguous with a detached HEAD and git rejects it as a branch name.
  if (!name || name === 'HEAD') return false;
  if (name.startsWith('/') || name.endsWith('/')) return false;
  if (name.startsWith('.') || name.endsWith('.')) return false;
  if (name.endsWith('.lock')) return false;
  if (name.includes('..') || name.includes('//')) return false;
  // git applies the dot/.lock rules per slash-separated component, not just to
  // the whole name: no component may start or end with a dot, or end with `.lock`.
  if (name.includes('/.') || name.includes('./') || name.includes('.lock/')) {
    return false;
  }
  if (name.includes('@{')) return false;
  if (INVALID_REF_CHARS.test(name)) return false;
  // Length limit is per slash-separated component (a filesystem cap), not the
  // whole ref — a deeply nested but valid ref can exceed any single component.
  if (name.split('/').some((c) => c.length > MAX_REF_COMPONENT_LENGTH)) {
    return false;
  }
  return true;
}

/** A SHA-1 (40 hex) or SHA-256 (64 hex) object id. */
export function isValidGitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value) || /^[0-9a-f]{64}$/.test(value);
}

// resolveGitDir walks ancestors and parses the worktree gitdir pointer on every
// call; a successful result is stable for a given cwd within a session, so it
// is cached. A miss (non-repo) is NOT cached — the directory may become a repo
// mid-session (git init / clone), so it is always re-checked. HEAD is never
// cached either: it is re-read every call so a branch switch shows at once.
const gitDirCache = new Map<string, string>();

/**
 * Clear all cached gitDir state (e.g. after a repo is created/removed). Both
 * the resolution cache and the shared reflog watchers are gitDir-keyed, so this
 * also tears the watchers down — clearing only half would leak their fds.
 */
export function clearGitDirCache(): void {
  closeAllRepoBranchWatches();
  gitDirCache.clear();
}

/** True if `p` exists and is a directory. */
async function isDir(p: string): Promise<boolean> {
  try {
    return (await fsPromises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** A git object store: `objects/` + `refs/` (standalone repo, or a worktree's common dir). */
async function hasGitStore(dir: string): Promise<boolean> {
  const [objects, refs] = await Promise.all([
    isDir(path.join(dir, 'objects')),
    isDir(path.join(dir, 'refs')),
  ]);
  return objects && refs;
}

/**
 * Read the first line of a file with O_NOFOLLOW (refuse symlinks atomically) and
 * a bounded prefix (never load a pathologically large file). Returns null on any
 * failure. Shared by the HEAD and commondir reads.
 */
async function readFirstLineNoFollow(filePath: string): Promise<string | null> {
  let fh: fsPromises.FileHandle;
  try {
    // O_NOFOLLOW refuses a symlink (ELOOP). O_NONBLOCK never blocks on a FIFO —
    // a crafted `.git/HEAD` or commondir named pipe would otherwise hang here
    // and pin a libuv thread-pool slot. Both are no-ops on a regular file.
    fh = await fsPromises.open(
      filePath,
      (fs.constants?.O_RDONLY ?? 0) |
        (fs.constants?.O_NOFOLLOW ?? 0) |
        (fs.constants?.O_NONBLOCK ?? 0),
    );
  } catch {
    return null;
  }
  try {
    const buf = Buffer.allocUnsafe(MAX_HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, MAX_HEAD_BYTES, 0);
    return buf.toString('utf-8', 0, bytesRead).split('\n', 1)[0] ?? '';
  } catch {
    return null;
  } finally {
    // Per the codebase convention a close error must not escape — the docstring
    // promises null on any failure.
    await fh.close().catch(() => {});
  }
}

/**
 * Verify `gitDir` is a real git directory, the way git itself decides — so the
 * automatic, zero-click display read can't be tricked where `git rev-parse`
 * couldn't.
 *
 * Security: `resolveGitDir` follows a `.git`-FILE `gitdir:` pointer verbatim, so
 * a crafted project could aim it at an arbitrary path or stand up a fake `.git`
 * with just a HEAD; the old `git rev-parse` path refused both with "not a git
 * repository" (exit 128). git treats a directory as a gitdir only if the object
 * store is present: a standalone repo has `objects/` + `refs/` directly; a
 * linked worktree / submodule gitdir instead carries a `commondir` file
 * pointing at the main gitdir that does. Incomplete forgeries (a lone HEAD, or a
 * path-shaped `.git/worktrees/x` containing only a HEAD) have neither and are
 * rejected. This matches git's own validity check rather than a path shape,
 * which a `gitdir:` pointer can fake.
 */
async function isRealGitDir(gitDir: string): Promise<boolean> {
  if (await hasGitStore(gitDir)) return true;
  // A worktree/submodule gitdir has no object store of its own; commondir points
  // at the main gitdir that does. Read it bounded + O_NOFOLLOW, like HEAD, so a
  // crafted oversized or symlinked commondir can't OOM or redirect us.
  const rel = await readFirstLineNoFollow(path.join(gitDir, 'commondir'));
  if (!rel) return false;
  return hasGitStore(path.resolve(gitDir, rel.trim()));
}

async function resolveTrustedGitDir(cwd: string): Promise<string | null> {
  const gitDir = await resolveGitDir(cwd);
  if (!gitDir) return null;
  return (await isRealGitDir(gitDir)) ? gitDir : null;
}

async function getCachedGitDir(cwd: string): Promise<string | null> {
  const key = path.resolve(cwd);
  const cached = gitDirCache.get(key);
  if (cached !== undefined) return cached;
  const gitDir = await resolveTrustedGitDir(key);
  // Only cache a successful resolution. A null (non-repo) result may become
  // valid later (git init / clone mid-session), so always re-check.
  if (gitDir !== null) gitDirCache.set(key, gitDir);
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
  // O_NOFOLLOW refuses a symlinked HEAD atomically (no lstat→read TOCTOU); the
  // bounded read parses only the first line so a huge file isn't loaded.
  const firstLine = await readFirstLineNoFollow(path.join(gitDir, 'HEAD'));
  if (firstLine === null) return null;
  const content = firstLine.trim();

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

/** Close every shared reflog watcher and drop the entries. */
function closeAllRepoBranchWatches(): void {
  for (const entry of repoBranchWatches.values()) {
    try {
      entry.watcher.close();
    } catch {
      // already closed
    }
  }
  repoBranchWatches.clear();
}

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
      await fsPromises.access(logsHeadPath, fs.constants?.F_OK ?? 0);
      // Refuse a symlinked reflog: we'd otherwise place a persistent watch on a
      // file outside the repo. A residual lstat→watch TOCTOU remains (fs.watch
      // has no O_NOFOLLOW form), but the watch only ever fires readGitHead —
      // which opens HEAD with O_NOFOLLOW — and never reads logs/HEAD's content.
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
            repoBranchWatches.get(gitDir)?.subscribers.forEach((cb) => {
              // Isolate subscriber failures: in this shared-watcher fan-out one
              // throwing callback must not halt the others or crash the watch.
              try {
                cb();
              } catch {
                // ignore a subscriber's own error
              }
            });
          }
        });
      } catch (err) {
        // fs.watch throws synchronously if logs/HEAD vanished after access()
        // (TOCTOU: git gc / reflog expire / worktree removal) or a platform
        // watch limit (ENOSPC) is hit. Fall back to a no-op rather than
        // rejecting (which the hook's bare `void init()` would surface as an
        // unhandled rejection).
        debug.warn(`failed to watch reflog for ${gitDir}: ${err}`);
        return () => {};
      }
      // fs.FSWatcher is an EventEmitter: an unhandled 'error' (reflog removed
      // by `git gc` / `reflog expire`, worktree removal, inode change, or a
      // platform watch limit) would crash the process. Tear the watch down
      // instead — subscribers simply stop auto-refreshing.
      watcher.on('error', (err: Error) => {
        debug.warn(
          `reflog watcher error for ${gitDir}; branch will no longer auto-update: ${err?.message}`,
        );
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
