/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Worktree snapshot capture/restore (P6, design D7). A snapshot is a
 * self-contained `tar.gz` of a managed worktree's tree plus a JSON metadata
 * header, saved before the worktree is deleted so the work survives cleanup
 * and can be restored when the chat is reopened. Only regenerable output the
 * has-work gate actually waives — ignored `node_modules`/`dist`/`coverage`
 * trees — plus the `.git` link and the session marker are excluded; tracked
 * or non-ignored files under those directory names are work and are
 * archived. Uncommitted tracked deletions are recorded in the header and
 * re-applied on restore, so a deleted file is not resurrected by extraction
 * over a recreated HEAD.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import {
  WORKTREE_SESSION_FILE,
  cacheContainerCheckouts,
  computeCarriedIdentities,
  hasHiddenIndexBit,
  REGENERABLE_QWEN_CACHE_DIRS,
  isDisposableIgnoredEntry,
  regenerableCacheContainerOf,
  worktreeHasPendingGitOperation,
  worktreeHasWork,
} from './gitWorktreeService.js';
import { runGit } from '../utils/git-branches.js';
import { NO_EXEC_CONFIG } from '../utils/gitUtils.js';

export const WORKTREE_SNAPSHOT_SCHEMA_VERSION = 2;
const META_READ_MAX_BYTES = 64 * 1024;

export interface WorktreeSnapshotMeta {
  version: number;
  sessionId: string;
  slug: string;
  /** The commit the worktree was created at (its detached base or branch tip). */
  baseCommit: string;
  /** The worktree HEAD at capture time (may be ahead of base). */
  headCommit: string;
  /** The checked-out branch, or '' for a detached worktree. */
  branch: string;
  dirty: {
    tracked: number;
    untracked: number;
    /**
     * Repo-relative tracked paths absent from the working tree at capture
     * (unstaged or staged deletions, and rename sources). Restore removes
     * them after extraction so the deletion survives; the archive alone
     * cannot represent an absent file.
     */
    deleted: string[];
  };
  /** Epoch ms when the snapshot was captured. */
  createdAt: number;
}

export interface CaptureWorktreeSnapshotOptions {
  worktreePath: string;
  /** Directory the snapshot files are written to (the session chats dir). */
  snapshotDir: string;
  meta: Omit<WorktreeSnapshotMeta, 'version' | 'createdAt'>;
}

export interface WorktreeSnapshotPaths {
  snapshotPath: string;
  metaPath: string;
  /** Whether actual archive contents and HEAD/branch match the final checkout. */
  checkoutMatchesCapture: boolean;
}

const COMMIT_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * A repo-relative path safe to join under a worktree root: relative, no
 * `..` or `.` segment, no backslash or drive/leading separator. The header is
 * validated input to a destructive restore step, so a traversal path is refused.
 */
function isSafeRelativePath(p: string): boolean {
  if (p.length === 0 || path.isAbsolute(p) || p.includes('\\')) return false;
  return !p
    .split('/')
    .some((segment) => segment === '..' || segment === '.' || segment === '');
}

/**
 * Strip leading `./` segments so a protected-path comparison cannot be
 * bypassed by `./.git` or `././.git` (F4-0). `path.resolve` would normalize
 * these to the same target, but the lexical `.git` / marker prefix checks
 * below run on the raw string, so normalize first.
 */
function normalizeRel(p: string): string {
  let n = p;
  while (n.startsWith('./')) n = n.slice(2);
  return n;
}

function canonicalArchiveMemberName(p: string): string {
  return normalizeRel(p).replace(/\/+$/, '');
}

/**
 * Whether a normalized repo-relative path names a protected target the
 * restore must never remove: the worktree's `.git` or the session marker.
 */
function isProtectedRel(norm: string): boolean {
  // Case-fold: on APFS/NTFS a '.GIT/config' entry aliases '.git/config', so
  // a case-sensitive comparison would let a restore remove the git link
  // (round-6 containment). Capture refuses case variants before starting tar
  // so it cannot create an archive its own reader would reject (R8-7). Also
  // block descendants of the session marker name so an archive cannot
  // pre-create a directory at WORKTREE_SESSION_FILE.
  const lower = norm.toLowerCase();
  const markerLower = WORKTREE_SESSION_FILE.toLowerCase();
  return (
    lower === '.git' ||
    lower.startsWith('.git/') ||
    lower === markerLower ||
    lower.startsWith(`${markerLower}/`)
  );
}

/**
 * The ignored disposable output the has-work gate waives, split into collapsed
 * directory entries (trailing slash) and individual ignored files. Built from
 * the `!!` records of the gate's own `status --porcelain --ignored=matching
 * -z` listing, so capture excludes exactly what the gate waives (R6-1) and a
 * large `node_modules` does not enumerate file-level and overflow the capture
 * buffer.
 */
interface DisposableIgnoredMatcher {
  dirs: string[];
  files: ReadonlySet<string>;
  /**
   * Subtrees excluded regardless of the ignore listing: nested checkouts under
   * `.qwen/worktrees/` that hold no work of their own, so archiving them would
   * only duplicate another checkout's clean tree. Everything else this matcher
   * excludes is derived from the ignore listing — the same geometry the
   * has-work gate waives — so no path the gate counts as work can be dropped
   * from the archive. A nested checkout that DOES hold work is refused before
   * this list is built instead of being silently excluded.
   */
  neverDirs: readonly string[];
}

/**
 * Whether a worktree-relative path is excluded from the snapshot. `.git`
 * (the worktree link file or a real dir) and the session marker are always
 * excluded. A path is excluded as regenerable output only when it is an
 * ignored disposable file or sits under an ignored disposable directory —
 * the same geometry the has-work gate waives — so a tracked or non-ignored
 * file under `dist/`, `node_modules/`, `coverage/`, `.qwen/tmp/` or
 * `.qwen/logs/` is archived rather than silently dropped, while ignored cache
 * and build output is excluded exactly as the gate waives it. The only
 * non-ignore-derived exclusions are nested checkouts with no work of their own
 * (`neverDirs`); one that holds work is refused outright in
 * {@link boundedSnapshotExclusions}.
 */
function isExcludedFromSnapshot(
  relativePath: string,
  matcher: DisposableIgnoredMatcher,
): boolean {
  const norm = relativePath.replace(/^\.\//, '').replace(/\/$/, '');
  if (norm.length === 0) return false;
  if (norm === '.git' || norm.startsWith('.git/')) return true;
  if (norm === WORKTREE_SESSION_FILE) return true;
  if (
    matcher.neverDirs.some(
      (dir) => norm === dir.replace(/\/$/, '') || norm.startsWith(dir),
    )
  ) {
    return true;
  }
  if (matcher.files.has(norm)) return true;
  const withSlash = `${norm}/`;
  return matcher.dirs.some((dir) => withSlash.startsWith(dir));
}

/**
 * Check the filesystem entries, including clean tracked files absent from
 * `git status`: a protected case variant would make the archive unreadable by
 * the restore policy. Check only entries the archive actually includes, and
 * never follow a directory symlink while enumerating.
 */
async function assertNoProtectedCaseVariantPaths(
  worktreePath: string,
  matcher: DisposableIgnoredMatcher,
  prefix = '',
): Promise<void> {
  const directory = path.join(worktreePath, prefix);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (rel === '.git' || rel === WORKTREE_SESSION_FILE) continue;
    if (isProtectedRel(rel)) {
      throw new Error(
        `Worktree snapshot: a case-variant protected path cannot be archived faithfully: ${rel}`,
      );
    }
    if (isExcludedFromSnapshot(rel, matcher)) continue;
    if (entry.isDirectory()) {
      await assertNoProtectedCaseVariantPaths(worktreePath, matcher, rel);
    } else if (entry.isSymbolicLink()) {
      assertSnapshotSymlinkTargetBytes(
        await fs.readlink(path.join(directory, entry.name)),
        rel,
      );
    } else if (!entry.isFile()) {
      // node-tar silently emits no entry for FIFOs, sockets and devices.
      throw new Error(
        `Worktree snapshot: non-regular filesystem entry cannot be archived faithfully: ${rel}`,
      );
    }
  }
}

async function atomicWriteFile(
  target: string,
  write: (tmp: string) => Promise<void>,
): Promise<void> {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    // The archive can hold private work (e.g. a 0600 ignored file). Create the
    // temp file owner-only BEFORE any content is written: node-tar opens its
    // output at 0o666 & ~umask (0644 under the default umask), so chmod-ing
    // only after the write would leave the archive world-readable for the
    // whole capture (R5-1). Creating it 0600 first keeps it private from the
    // first byte through the rename; the later write preserves the mode.
    const handle = await fs.open(tmp, 'w', 0o600);
    await handle.close();
    await write(tmp);
    await fs.chmod(tmp, 0o600).catch(() => {});
    await fs.rename(tmp, target);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Read the worktree's HEAD and dirty-state summary to build a snapshot meta
 * header (P6 U3). The session marker is excluded from the counts (it is
 * daemon bookkeeping, not work, and is excluded from the archive too).
 * Tracked deletions and rename sources are recorded so restore can re-apply
 * them. Rejects if the worktree's own `.git` is missing or its git state
 * cannot be read — the caller must not snapshot-and-delete a worktree it
 * cannot describe, and git's upward discovery from a worktree whose own
 * `.git` is gone would otherwise answer about the enclosing repository.
 */
export async function buildWorktreeSnapshotMeta(
  worktreePath: string,
  info: {
    sessionId: string;
    slug: string;
    baseCommit: string;
  },
): Promise<Omit<WorktreeSnapshotMeta, 'version' | 'createdAt'>> {
  if (!COMMIT_OID_PATTERN.test(info.baseCommit)) {
    throw new Error(
      `Worktree snapshot meta: invalid baseCommit id (${info.baseCommit})`,
    );
  }
  await fs.access(path.join(worktreePath, '.git'));
  // A hidden index bit (assume-unchanged / skip-worktree) hides a second file
  // version — a staged draft or a tracked deletion — from `git status`, so the
  // worktree tar + status-derived header cannot represent it faithfully and a
  // restore would lose it (P1). Refuse the capture; the caller preserves the
  // checkout. Full index-state capture is part of the restore affordance (U5).
  if (await hasHiddenIndexBit(worktreePath)) {
    throw new Error(
      'Worktree snapshot meta: an index flag hides a file version; the capture cannot be faithful',
    );
  }
  // A paused merge/rebase/cherry-pick/revert/bisect holds private operation
  // state the tar cannot represent at all: the draft would vanish with the
  // admin dir even if the working files are archived. Refuse the capture;
  // the caller preserves the checkout (P1).
  if (await worktreeHasPendingGitOperation(worktreePath)) {
    throw new Error(
      'Worktree snapshot meta: an in-progress git operation holds private state that a snapshot cannot represent',
    );
  }
  const headCommit = (
    await runGit(worktreePath, [
      ...NO_EXEC_CONFIG,
      '--no-optional-locks',
      'rev-parse',
      'HEAD',
    ])
  ).trim();
  // Always read the branch actually checked out now — never trust a
  // creation-time value: a session may `git switch -c` after a detached
  // creation, and a restore must recreate that branch, not a detached
  // checkout (P2). Empty for a detached HEAD.
  const branch = (
    await runGit(worktreePath, [
      ...NO_EXEC_CONFIG,
      '--no-optional-locks',
      'branch',
      '--show-current',
    ])
  ).trim();
  const status = await runGit(worktreePath, [
    ...NO_EXEC_CONFIG,
    '--no-optional-locks',
    'status',
    '--porcelain',
    '--untracked-files=normal',
    '-z',
  ]);
  let tracked = 0;
  let untracked = 0;
  const deleted: string[] = [];
  // skip-worktree paths hide the worktree/index difference from `git status`:
  // a staged edit on such a path exists ONLY in the index (the sparse
  // worktree keeps the HEAD content), and Y=' ' cannot prove otherwise.
  // `ls-files -v` marks those entries with `S` whether or not sparse-checkout
  // is enabled (P1 sparse-cone).
  const skipWorktree = new Set<string>();
  const lsV = await runGit(
    worktreePath,
    [
      ...NO_EXEC_CONFIG,
      '-c',
      'advice.sparseIndexExpanded=false',
      '--no-optional-locks',
      'ls-files',
      '-v',
      '-z',
    ],
    undefined,
    64 * 1024 * 1024,
  );
  for (const row of lsV.split('\0')) {
    // `ls-files -v` emits `<tag> <path>` (no mode/sha columns): S marks the
    // skip-worktree bit. Collect exactly those paths.
    if (row.startsWith('S ')) skipWorktree.add(row.slice(2));
  }
  const records = status.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length === 0) continue;
    const xy = record.slice(0, 2);
    const entry = record.slice(3);
    // The archive captures the worktree, not the index. When a path has a
    // staged change (X is a status letter, not ' ' or '?') AND the worktree
    // differs from the index (Y is not ' '), the staged version exists only
    // in the index — the worktree tar would not contain it, and deleting the
    // checkout would lose it (e.g. `git add` then keep editing → `MM`). The
    // snapshot cannot represent that state faithfully, so refuse the capture
    // and let the caller preserve the checkout. Full index-state capture is
    // part of the restore affordance (P6 U5).
    if (xy[0] !== ' ' && xy[0] !== '?' && xy[1] !== ' ') {
      throw new Error(
        `Worktree snapshot meta: staged content differs from the worktree at ${entry}; the index cannot be represented faithfully`,
      );
    }
    // Same loss even with Y=' ': on a skip-worktree path the index may hold
    // a staged blob the sparse working tree never materialized (P1). The
    // stage-vs-worktree check above cannot see it, so refuse explicitly.
    if (
      (xy[0] === 'M' ||
        xy[0] === 'A' ||
        xy[0] === 'R' ||
        xy[0] === 'C' ||
        xy[0] === 'T') &&
      skipWorktree.has(entry)
    ) {
      throw new Error(
        `Worktree snapshot meta: staged content on a skip-worktree path at ${entry}; the sparse worktree cannot represent it`,
      );
    }
    // A rename/copy record is followed by a second NUL-separated record
    // naming the source path — for staged (X) AND worktree-side (Y)
    // renames. A rename deletes the source; a copy keeps it.
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
      const source = records[i + 1] ?? '';
      i += 1;
      if (entry === WORKTREE_SESSION_FILE) continue;
      tracked += 1;
      // A rename source is a deletion too, but a protected path (the git
      // link or the marker, if tracked) must never enter the deleted list:
      // the reader refuses protected deletions, so recording one would make
      // the whole archive unreadable (round-6).
      if (
        (xy[0] === 'R' || xy[1] === 'R') &&
        source.length > 0 &&
        !isProtectedRel(normalizeRel(source))
      ) {
        deleted.push(source);
      }
      continue;
    }
    if (entry === WORKTREE_SESSION_FILE) continue;
    if (xy === '??') {
      untracked += 1;
      continue;
    }
    tracked += 1;
    // Same protected-path policy the reader enforces (case-folded): a
    // case-variant marker deletion on a case-sensitive volume must not
    // enter the deleted list, or the capture writes a header its own
    // reader refuses (round-7).
    if (
      (xy[0] === 'D' || xy[1] === 'D') &&
      !isProtectedRel(normalizeRel(entry))
    ) {
      deleted.push(entry);
    }
  }
  // git output is decoded as UTF-8; a non-UTF-8 filename arrives as U+FFFD
  // and could not be re-applied by name on restore. Refuse the capture (the
  // caller preserves the checkout) rather than record a deletion that would
  // silently fail to restore.
  if (deleted.some((p) => p.includes('\uFFFD'))) {
    throw new Error(
      'Worktree snapshot meta: a deleted path is not valid UTF-8; cannot restore it faithfully',
    );
  }
  return {
    ...info,
    branch,
    headCommit,
    dirty: { tracked, untracked, deleted },
  };
}

// Before/after digests alone miss an A/B/A write: tar can hold the intermediate
// bytes. Compare actual archive contents with the final checkout instead of
// discarding a completed snapshot whose earlier bytes may still be useful.
interface SnapshotPathKinds {
  files: Set<string>;
  directories: Set<string>;
}

async function readSnapshotPathKinds(
  snapshotPath: string,
): Promise<SnapshotPathKinds> {
  const files = new Set<string>();
  const directories = new Set<string>();
  const includeParents = (relativePath: string) => {
    let parent = '';
    for (const part of relativePath.split('/').filter(Boolean).slice(0, -1)) {
      parent = `${parent}${part}/`;
      directories.add(parent);
    }
  };
  let unsafeEntryError: Error | undefined;
  await tar.t({
    file: snapshotPath,
    strict: true,
    onReadEntry: (entry) => {
      if (unsafeEntryError) return;
      if (entry.path === '.' || /^\.\/+$/.test(entry.path)) {
        if (entry.type !== 'Directory') {
          unsafeEntryError = new Error(
            'Worktree snapshot: archive member has an empty or root path',
          );
        }
        return;
      }
      const rel = canonicalArchiveMemberName(entry.path);
      if (!rel) {
        unsafeEntryError = new Error(
          'Worktree snapshot: archive member has an empty or root path',
        );
        return;
      }
      if (entry.type === 'Directory') {
        directories.add(`${rel}/`);
      } else {
        files.add(rel);
      }
      includeParents(rel);
    },
  });
  if (unsafeEntryError) throw unsafeEntryError;
  return { files, directories };
}

async function checkoutMatchesCapture(
  worktreePath: string,
  snapshotPath: string,
  matcher: DisposableIgnoredMatcher,
  meta: CaptureWorktreeSnapshotOptions['meta'],
  knownPaths?: SnapshotPathKinds,
): Promise<boolean> {
  const known = knownPaths ?? (await readSnapshotPathKinds(snapshotPath));
  const regularFiles: string[] = [];
  const symlinks = new Map<string, string>();
  const directories = new Set<string>();
  const current = new Map<string, string>();
  const collect = async (prefix = ''): Promise<void> => {
    const entries = await fs.readdir(path.join(worktreePath, prefix), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      // A restored index is allowed to ignore a force-tracked archived file.
      // Archive membership, not that new index, decides what is restorable.
      if (
        isExcludedFromSnapshot(rel, matcher) &&
        !known.files.has(rel) &&
        (entry.isFile() ||
          entry.isSymbolicLink() ||
          (entry.isDirectory() && !known.directories.has(`${rel}/`)))
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        directories.add(`${rel}/`);
        await collect(rel);
      } else if (entry.isSymbolicLink()) {
        const target = await fs.readlink(path.join(worktreePath, rel));
        assertSnapshotSymlinkTargetBytes(target, rel);
        symlinks.set(rel, target);
      } else if (entry.isFile()) {
        regularFiles.push(rel);
      } else {
        throw new Error(
          `Worktree snapshot: non-regular filesystem entry cannot be archived faithfully: ${rel}`,
        );
      }
    }
  };
  await collect();

  // Membership is a Set lookup, never a linear scan per entry: on a checkout
  // with hundreds of thousands of files, `regularFiles.includes(...)` inside
  // this loop ran O(N^2) comparisons in one synchronous microtask (the hashing
  // it follows is async, but this loop is not) and pinned the daemon event
  // loop for minutes. Order does not matter here, so the same Set also feeds
  // the hashing (its stable insertion order keeps the batches deterministic).
  const regularFileSet = new Set(regularFiles);
  for (const entry of await computeCarriedIdentities(
    worktreePath,
    regularFileSet,
  )) {
    if (entry.hash === null || !regularFileSet.has(entry.path)) {
      throw new Error('Worktree snapshot: contents changed during capture');
    }
    current.set(
      entry.path,
      `file:${entry.hash}:${entry.executable ? '1' : '0'}`,
    );
  }
  if (current.size !== regularFiles.length) {
    throw new Error('Worktree snapshot: contents changed during capture');
  }
  for (const [rel, target] of symlinks) {
    current.set(rel, `symlink:${JSON.stringify(target)}`);
  }

  const objectFormat = (
    await runGit(worktreePath, [
      ...NO_EXEC_CONFIG,
      '--no-optional-locks',
      'rev-parse',
      '--show-object-format',
    ])
  ).trim();
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
    throw new Error(
      `Unsupported Git object format in worktree snapshot: ${objectFormat}`,
    );
  }
  const captured = new Map<string, string>();
  const hardlinks = new Map<string, string>();
  let archiveValid = true;
  const captureEntry = (relativePath: string, content: string): void => {
    if (captured.has(relativePath)) {
      archiveValid = false;
      return;
    }
    captured.set(relativePath, content);
  };
  await tar.t({
    file: snapshotPath,
    strict: true,
    onReadEntry: (entry) => {
      const rel = canonicalArchiveMemberName(entry.path);
      if (!rel && entry.type !== 'Directory') {
        archiveValid = false;
        return;
      }
      if (!rel || rel === '.') return;
      if (isProtectedRel(rel)) {
        archiveValid = false;
        return;
      }
      if (entry.type === 'File') {
        const hash = createHash(objectFormat);
        hash.update(`blob ${entry.size}\0`);
        entry.on('data', (chunk: Buffer) => hash.update(chunk));
        entry.on('end', () => {
          captureEntry(
            rel,
            `file:${hash.digest('hex')}:${
              (entry.mode ?? 0) & 0o100 ? '1' : '0'
            }`,
          );
        });
      } else if (entry.type === 'SymbolicLink') {
        captureEntry(rel, `symlink:${JSON.stringify(entry.linkpath ?? '')}`);
      } else if (entry.type === 'Link') {
        if (hardlinks.has(rel)) {
          archiveValid = false;
        } else {
          hardlinks.set(rel, canonicalArchiveMemberName(entry.linkpath ?? ''));
        }
      } else if (entry.type === 'Directory') {
        captureEntry(`${rel}/`, 'directory');
      } else {
        archiveValid = false;
      }
    },
  });
  for (const [rel, target] of hardlinks) {
    const content = captured.get(target);
    if (content === undefined || !content.startsWith('file:')) {
      archiveValid = false;
    } else {
      captureEntry(rel, content);
    }
  }
  const mismatch = [
    ...new Set([...current.keys(), ...directories, ...captured.keys()]),
  ]
    .sort()
    .find((rel) =>
      rel.endsWith('/')
        ? directories.has(rel) !== known.directories.has(rel)
        : current.get(rel) !== captured.get(rel),
    );
  await fs.access(path.join(worktreePath, '.git'));
  const [headCommit, branch] = await Promise.all([
    runGit(worktreePath, [
      ...NO_EXEC_CONFIG,
      '--no-optional-locks',
      'rev-parse',
      'HEAD',
    ]),
    runGit(worktreePath, [
      ...NO_EXEC_CONFIG,
      '--no-optional-locks',
      'branch',
      '--show-current',
    ]),
  ]);
  return (
    archiveValid &&
    mismatch === undefined &&
    headCommit.trim() === meta.headCommit &&
    branch.trim() === meta.branch
  );
}

/**
 * Capture a worktree to
 * `<snapshotDir>/<sessionId>.<createdAt>.<pid>.worktree-snapshot.tar.gz`
 * with a `.json` metadata header beside it. Both writes are atomic (stage to a
 * temp file, rename), so a crash mid-capture never leaves a half-written
 * archive a later restore would trust. Rejects on any capture error — the
 * caller must not delete the worktree without a durable snapshot.
 */
async function readSnapshotExclusions(
  worktreePath: string,
): Promise<DisposableIgnoredMatcher> {
  // The ignored disposable output the exclusion geometry consults, taken
  // from the SAME listing the has-work gate waives (`status --porcelain
  // --ignored=matching -z`, the `!!` records) so the two geometries cannot
  // drift: a contents-matching rule (`packages/app/node_modules/**`)
  // collapses one level deeper here than `ls-files --directory` would, and
  // the mismatch let the gate count work the archive then dropped (R6-1).
  // Ignored entries stay directory-collapsed, so a large node_modules does
  // not enumerate file-level and overflow the capture buffer; tracked and
  // non-ignored files are not `!!` records and are archived.
  const statusOut = await runGit(
    worktreePath,
    [
      ...NO_EXEC_CONFIG,
      '--no-optional-locks',
      'status',
      '--porcelain',
      '--untracked-files=all',
      '--ignored=matching',
      '-z',
    ],
    undefined,
    64 * 1024 * 1024,
  );
  const ignoredEntries: string[] = [];
  const records = statusOut.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length === 0) continue;
    const xy = record.slice(0, 2);
    const relativePath = normalizeRel(record.slice(3).replace(/\/$/, ''));
    // Refuse BEFORE starting tar: throwing from tar's asynchronous filter
    // escapes the capture promise as an uncaught exception. The normal .git
    // link and daemon marker are intentionally omitted, not capture errors;
    // only their case variants must follow the reader's fail-closed policy.
    // An absent case-variant deletion is safe: it is absent from the tar and
    // buildWorktreeSnapshotMeta already omits it from the deletion header.
    if (
      !xy.includes('D') &&
      relativePath !== '.git' &&
      !relativePath.startsWith('.git/') &&
      relativePath !== WORKTREE_SESSION_FILE &&
      isProtectedRel(relativePath)
    ) {
      throw new Error(
        `Worktree snapshot: a case-variant protected path cannot be archived faithfully: ${relativePath}`,
      );
    }
    // A rename/copy record is followed by a bare source-path record on
    // EITHER side (X or Y): never reinterpret that source as an ignored entry
    // (e.g. a source literally named '!! node_modules/source.txt').
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
      i += 1;
    }
    if (xy === '!!') ignoredEntries.push(record.slice(3));
  }
  // A regenerable cache that holds a checkout is not disposable: the same
  // listing that waives `.qwen/tmp/` for the archive is the one the gate reads,
  // so excluding it here would certify a snapshot that carries none of the
  // nested work. Those containers keep their entries (except a clean linked
  // worktree, which `boundedSnapshotExclusions` excludes by its own path).
  const cacheHolders = new Set<string>();
  for (const cacheDir of REGENERABLE_QWEN_CACHE_DIRS) {
    const checkouts = await cacheContainerCheckouts(
      worktreePath,
      `.qwen/${cacheDir}`,
    );
    if (checkouts.length > 0) cacheHolders.add(`.qwen/${cacheDir}`);
  }
  const insideCacheHolder = (entry: string): boolean => {
    const container = regenerableCacheContainerOf(entry);
    return container !== undefined && cacheHolders.has(container);
  };
  const matcher: DisposableIgnoredMatcher = {
    dirs: ignoredEntries.filter(
      (e) =>
        e.endsWith('/') && isDisposableIgnoredEntry(e) && !insideCacheHolder(e),
    ),
    files: new Set(
      ignoredEntries.filter(
        (e) =>
          !e.endsWith('/') &&
          isDisposableIgnoredEntry(e) &&
          !insideCacheHolder(e),
      ),
    ),
    neverDirs: await boundedSnapshotExclusions(worktreePath, ignoredEntries),
  };
  await assertNoProtectedCaseVariantPaths(worktreePath, matcher);
  return matcher;
}

/**
 * The `neverDirs` half of the matcher: nested checkouts under this checkout's
 * own `.qwen/worktrees/`. Those are OTHER trees, and archiving a clean one only
 * duplicates a working tree that its branch still reconstructs — so a clean
 * nested checkout is excluded, exactly as before.
 *
 * A nested checkout that holds work is a different matter. The git worktree's
 * files are unique bytes, and they vanish with the parent directory, so
 * excluding it would delete work the has-work gate had already counted (the
 * gate sees `?? .qwen/worktrees/`). Instead of silently dropping it, refuse the
 * capture: `captureWorktreeSnapshot` throwing makes every caller preserve the
 * checkout, which is the fail-closed direction.
 *
 * Nothing else is excluded here. Qwen's regenerable caches are excluded through
 * the ignore listing (`isDisposableIgnoredEntry`), so they are skipped only
 * where git actually ignores them.
 */
async function boundedSnapshotExclusions(
  worktreePath: string,
  ignoredEntries: readonly string[],
): Promise<readonly string[]> {
  const managedDir = path.join(worktreePath, '.qwen', 'worktrees');
  const relative = path
    .relative(path.resolve(worktreePath), path.resolve(managedDir))
    .split(path.sep)
    .join('/');
  const exclusions: string[] = [];
  // A regenerable cache is skipped only where git ignores it. Git collapses a
  // broad rule (`.qwen/`) to one `!! .qwen/` entry, so an ignored ANCESTOR
  // counts as covering the cache too; without that, a common `.qwen/` rule
  // would put the whole scratch tree back into the archive.
  //
  // The container is a cache only while nothing inside it is a checkout.
  // `.qwen/tmp/review-pr-<n>` is a linked worktree in this repository's own
  // workflow, and a nested checkout's bytes live nowhere else: a dirty one
  // refuses the capture, a clean one is excluded by its own path, and an
  // independent repository (`.git` is a DIRECTORY) is never excluded at all.
  // Only when the container holds no checkout may the prefix go, which is what
  // keeps the multi-GB cache out of the archive.
  for (const cacheDir of REGENERABLE_QWEN_CACHE_DIRS) {
    const trailing = `.qwen/${cacheDir}/`;
    const covered = ignoredEntries.some(
      (entry) => entry.endsWith('/') && trailing.startsWith(entry),
    );
    if (!covered) continue;
    const checkouts = await cacheContainerCheckouts(
      worktreePath,
      `.qwen/${cacheDir}`,
    );
    if (checkouts.length === 0) {
      exclusions.push(trailing);
      continue;
    }
    for (const child of checkouts) {
      if (child.kind === 'dir') continue;
      const childPath = path.join(worktreePath, '.qwen', cacheDir, child.name);
      if (await worktreeHasWork(childPath)) {
        throw new Error(
          `Worktree snapshot: nested checkout .qwen/${cacheDir}/${child.name} holds work; refusing to capture a parent that would delete it`,
        );
      }
      exclusions.push(`${trailing}${child.name}/`);
    }
  }
  if (relative.length === 0 || relative.startsWith('..')) return exclusions;
  let entries;
  try {
    entries = await fs.readdir(managedDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return exclusions;
    throw error;
  }
  for (const entry of entries) {
    // A plain file (or symlink) here is content, not another checkout: leave it
    // to the archive.
    if (!entry.isDirectory()) continue;
    const child = path.join(managedDir, entry.name);
    // `lstat`, never a followed probe: `.git` as a DIRECTORY is a repository
    // whose only object database lives inside this directory (an independent
    // `git init` under the checkout). Excluding it would delete its commits —
    // the archive drops `.git` unconditionally — and the gate reads the tree
    // clean, so nothing else would refuse. Only a registered LINKED worktree,
    // whose `.git` is a file naming a git dir elsewhere, can be excluded.
    const gitEntry = await fs
      .lstat(path.join(child, '.git'))
      .catch(() => undefined);
    if (gitEntry === undefined || gitEntry.isDirectory()) {
      continue;
    }
    if (await worktreeHasWork(child)) {
      throw new Error(
        `Worktree snapshot: nested checkout ${relative}/${entry.name} holds work; refusing to capture a parent that would delete it`,
      );
    }
    exclusions.push(`${relative}/${entry.name}/`);
  }
  return exclusions;
}

export async function verifyRestoredWorktreeSnapshot(options: {
  worktreePath: string;
  snapshotPath: string;
  meta: CaptureWorktreeSnapshotOptions['meta'];
}): Promise<boolean> {
  const matcher = await readSnapshotExclusions(options.worktreePath);
  const knownPaths = await readSnapshotPathKinds(options.snapshotPath);
  return checkoutMatchesCapture(
    options.worktreePath,
    options.snapshotPath,
    matcher,
    options.meta,
    knownPaths,
  );
}

function assertSnapshotSymlinkTargetBytes(
  target: string,
  relativePath: string,
): void {
  // The fs/tar string bridge cannot distinguish a literal U+FFFD from a
  // decoded non-UTF-8 target. Refuse either rather than silently rewrite it.
  if (target.includes('\uFFFD')) {
    throw new Error(
      `Snapshot symlink target cannot be preserved byte-for-byte: ${relativePath}`,
    );
  }
}

export async function captureWorktreeSnapshot(
  options: CaptureWorktreeSnapshotOptions,
): Promise<WorktreeSnapshotPaths> {
  const { worktreePath, snapshotDir, meta } = options;
  if (
    !COMMIT_OID_PATTERN.test(meta.baseCommit) ||
    !COMMIT_OID_PATTERN.test(meta.headCommit)
  ) {
    throw new Error('Worktree snapshot: invalid commit id');
  }
  await fs.access(path.join(worktreePath, '.git'));
  const fullMeta: WorktreeSnapshotMeta = {
    version: WORKTREE_SNAPSHOT_SCHEMA_VERSION,
    createdAt: Date.now(),
    ...meta,
  };
  const serializedMeta = `${JSON.stringify(fullMeta, null, 2)}\n`;
  if (Buffer.byteLength(serializedMeta, 'utf8') > META_READ_MAX_BYTES) {
    throw new Error('Worktree snapshot metadata exceeds 64 KiB');
  }
  await fs.mkdir(snapshotDir, { recursive: true });
  // A session UUID may be reused (superseded records, caller-supplied id):
  // never let a later capture overwrite an earlier archive pair of the same
  // sessionId. Suffix by capture time and pid; readers glob on the
  // `<sessionId>.*.worktree-snapshot.*` prefix (D7) (P1 collision).
  const base = path.join(
    snapshotDir,
    `${meta.sessionId}.${fullMeta.createdAt}.${process.pid}.worktree-snapshot`,
  );
  const snapshotPath = `${base}.tar.gz`;
  const metaPath = `${base}.json`;

  let matchesCheckout = true;
  await atomicWriteFile(snapshotPath, async (tmp) => {
    const matcher = await readSnapshotExclusions(worktreePath);
    await tar.create(
      {
        cwd: worktreePath,
        file: tmp,
        gzip: true,
        portable: true,
        noMtime: true,
        // tar 7.5.22 can close gzip twice while finishing parallel hardlink
        // jobs, escaping its promise as an unhandled stream error.
        jobs: 1,
        filter: (p) => !isExcludedFromSnapshot(p, matcher),
      },
      ['.'],
    );
    matchesCheckout = await checkoutMatchesCapture(
      worktreePath,
      tmp,
      // A nested checkout that was clean when it was excluded and gained a
      // draft while tar ran must not be skipped and reported as a match.
      await readSnapshotExclusions(worktreePath),
      meta,
    );
  });

  try {
    await atomicWriteFile(metaPath, async (tmp) => {
      await fs.writeFile(tmp, serializedMeta, 'utf8');
    });
  } catch (error) {
    await fs.rm(snapshotPath, { force: true }).catch(() => {});
    throw error;
  }

  return {
    snapshotPath,
    metaPath,
    checkoutMatchesCapture: matchesCheckout,
  };
}

/**
 * Read and validate a snapshot metadata header. An unknown schema version is
 * refused rather than mis-restored; a missing or malformed header rejects.
 * Version 1 headers (no recorded deletions) are refused: they cannot
 * faithfully restore a tracked deletion.
 */
export async function readWorktreeSnapshotMeta(
  metaPath: string,
): Promise<WorktreeSnapshotMeta> {
  if ((await fs.stat(metaPath)).size > META_READ_MAX_BYTES) {
    throw new Error(`Worktree snapshot metadata exceeds 64 KiB: ${metaPath}`);
  }
  const raw = await fs.readFile(metaPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`Worktree snapshot meta at ${metaPath} is not an object`);
  }
  const v = parsed as Record<string, unknown>;
  if (v['version'] !== WORKTREE_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported worktree snapshot version ${String(v['version'])} at ${metaPath}`,
    );
  }
  const safeCount = (value: unknown): boolean =>
    Number.isSafeInteger(value) && (value as number) >= 0;
  if (
    typeof v['sessionId'] !== 'string' ||
    v['sessionId'].length === 0 ||
    typeof v['slug'] !== 'string' ||
    v['slug'].length === 0 ||
    typeof v['baseCommit'] !== 'string' ||
    typeof v['headCommit'] !== 'string' ||
    typeof v['branch'] !== 'string' ||
    !safeCount(v['createdAt'])
  ) {
    throw new Error(`Worktree snapshot meta at ${metaPath} is malformed`);
  }
  const dirty = v['dirty'];
  if (dirty === null || typeof dirty !== 'object') {
    throw new Error(`Worktree snapshot meta at ${metaPath} is malformed`);
  }
  const d = dirty as Record<string, unknown>;
  if (
    !safeCount(d['tracked']) ||
    !safeCount(d['untracked']) ||
    !Array.isArray(d['deleted']) ||
    !d['deleted'].every(
      (p) =>
        typeof p === 'string' &&
        isSafeRelativePath(normalizeRel(p)) &&
        !isProtectedRel(normalizeRel(p)),
    )
  ) {
    throw new Error(`Worktree snapshot meta at ${metaPath} is malformed`);
  }
  return parsed as WorktreeSnapshotMeta;
}

export interface SelectedWorktreeSnapshot
  extends Pick<WorktreeSnapshotPaths, 'snapshotPath' | 'metaPath'> {
  meta: WorktreeSnapshotMeta;
  mtimeNs: bigint;
}

export async function selectWorktreeSnapshot(options: {
  directory: string;
  sessionId: string;
  slug: string;
  archiveKey?: string;
}): Promise<SelectedWorktreeSnapshot | undefined> {
  if (!path.isAbsolute(options.directory)) {
    throw new Error('Snapshot directory must be an absolute path');
  }
  const archiveSuffix = '.worktree-snapshot.tar.gz';
  const metaSuffix = '.worktree-snapshot.json';
  const archiveKey = options.archiveKey;
  if (
    archiveKey !== undefined &&
    (archiveKey.length === 0 ||
      archiveKey.includes('..') ||
      archiveKey.includes('/') ||
      archiveKey.includes('\\') ||
      !archiveKey.endsWith(archiveSuffix) ||
      !archiveKey.startsWith(`${options.sessionId}.`))
  ) {
    throw new Error('Invalid worktree snapshot archive key');
  }
  let directoryStat;
  try {
    directoryStat = await fs.lstat(options.directory);
  } catch (error) {
    if (
      archiveKey !== undefined &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return undefined;
    }
    throw error;
  }
  if (!directoryStat.isDirectory()) {
    throw new Error('Snapshot directory is not a directory');
  }
  const names = await fs.readdir(options.directory);
  const prefix = `${options.sessionId}.`;
  const matchingNames = names.filter(
    (name) =>
      name.startsWith(prefix) &&
      (name.endsWith(archiveSuffix) || name.endsWith(metaSuffix)),
  );
  if (archiveKey !== undefined && !matchingNames.includes(archiveKey)) {
    return undefined;
  }
  const bases = new Set(
    (archiveKey === undefined ? matchingNames : [archiveKey]).map((name) =>
      name.endsWith(archiveSuffix)
        ? name.slice(0, -'.tar.gz'.length)
        : name.slice(0, -'.json'.length),
    ),
  );
  const selected: SelectedWorktreeSnapshot[] = [];
  for (const base of [...bases].sort()) {
    const snapshotPath = path.join(options.directory, `${base}.tar.gz`);
    const metaPath = path.join(options.directory, `${base}.json`);
    for (const file of [snapshotPath, metaPath]) {
      let stat;
      try {
        stat = await fs.lstat(file, { bigint: true });
      } catch (error) {
        if (
          archiveKey !== undefined &&
          (error as NodeJS.ErrnoException).code === 'ENOENT'
        ) {
          return undefined;
        }
        throw error;
      }
      if (!stat.isFile() || stat.nlink !== 1n) {
        throw new Error(
          `Snapshot pair file is not an owned regular file: ${file}`,
        );
      }
      if (file === metaPath && stat.size > 64n * 1024n) {
        throw new Error(`Snapshot metadata exceeds 64 KiB: ${file}`);
      }
    }
    const meta = await readWorktreeSnapshotMeta(metaPath);
    if (
      !COMMIT_OID_PATTERN.test(meta.baseCommit) ||
      !COMMIT_OID_PATTERN.test(meta.headCommit)
    ) {
      throw new Error(`Snapshot pair has invalid commit ids: ${metaPath}`);
    }
    if (meta.sessionId !== options.sessionId) {
      throw new Error(`Snapshot pair identity mismatch: ${metaPath}`);
    }
    if (meta.slug !== options.slug) {
      if (archiveKey !== undefined) {
        throw new Error(`Snapshot pair identity mismatch: ${metaPath}`);
      }
      continue;
    }
    const mtimeNs = (await fs.lstat(snapshotPath, { bigint: true })).mtimeNs;
    selected.push({ snapshotPath, metaPath, meta, mtimeNs });
  }
  selected.sort(
    (a, b) =>
      b.meta.createdAt - a.meta.createdAt ||
      (a.mtimeNs === b.mtimeNs ? 0 : a.mtimeNs < b.mtimeNs ? 1 : -1) ||
      (a.snapshotPath < b.snapshotPath
        ? -1
        : a.snapshotPath > b.snapshotPath
          ? 1
          : 0),
  );
  return (
    selected.find(
      (entry) => path.basename(entry.snapshotPath) === archiveKey,
    ) ?? (archiveKey === undefined ? selected[0] : undefined)
  );
}

/**
 * Extract a snapshot over a freshly recreated worktree and re-apply the
 * recorded tracked deletions, without losing any archived content. The caller
 * recreates the worktree (detached at the recorded HEAD, or on the recorded
 * branch) first. Extract non-link members with strict mode, then re-create
 * archived symlinks after all other members.
 *
 * 1. Clear a conflicting HEAD target for every archived non-directory entry:
 *    node-tar replaces a file with a directory but not a directory with a
 *    file, so a dir→file replacement would otherwise silently drop the
 *    archived file.
 * 2. Re-apply the *pure* deletions (paths absent from the archive) before
 *    extraction, so a deleted tracked file is not resurrected from HEAD. A
 *    deleted path the session recreated (present in the archive) is left for
 *    extraction to restore — removing it would delete the session's new
 *    content. A deleted path that became a directory holds archived content
 *    and is likewise left alone.
 * 3. Extract with `strict`, so any residual conflict fails loudly rather than
 *    silently dropping content.
 *
 * Regenerable directories were excluded at capture and are not restored.
 * Index state (staged vs unstaged) is not preserved — the contract is that no
 * file content is lost.
 */
export async function restoreWorktreeSnapshot(
  snapshotPath: string,
  targetWorktreePath: string,
  meta: WorktreeSnapshotMeta,
): Promise<void> {
  await fs.mkdir(targetWorktreePath, { recursive: true });
  const root = path.resolve(targetWorktreePath);
  const realRoot = await fs.realpath(root);
  const archived = new Map<string, string>();
  const hardlinks: Array<[string, string]> = [];
  const archivedSymlinks = new Map<string, string>();
  let unsafeEntryError: Error | undefined;
  await tar.t({
    file: snapshotPath,
    strict: true,
    onReadEntry: (entry) => {
      if (unsafeEntryError) return;
      if (entry.path === '.' || /^\.\/+$/.test(entry.path)) {
        if (entry.type !== 'Directory') {
          unsafeEntryError = new Error(
            `Unsafe path in snapshot archive: ${entry.path}`,
          );
        }
        return;
      }
      const norm = canonicalArchiveMemberName(entry.path);
      if (!norm) {
        unsafeEntryError = new Error(
          `Unsafe path in snapshot archive: ${entry.path}`,
        );
        return;
      }
      if (
        entry.type !== 'File' &&
        entry.type !== 'Directory' &&
        entry.type !== 'SymbolicLink' &&
        entry.type !== 'Link'
      ) {
        unsafeEntryError = new Error(
          `Unsupported entry type in snapshot archive: ${entry.type}`,
        );
        return;
      }
      if (archived.has(norm)) {
        unsafeEntryError = new Error(
          `Duplicate path in snapshot archive: ${entry.path}`,
        );
        return;
      }
      archived.set(norm, entry.type);
      if (entry.type === 'Link') {
        hardlinks.push([norm, entry.linkpath ?? '']);
      }
      if (entry.type === 'SymbolicLink') {
        const target = entry.linkpath ?? '';
        try {
          assertSnapshotSymlinkTargetBytes(target, norm);
        } catch (error) {
          unsafeEntryError =
            error instanceof Error ? error : new Error(String(error));
          return;
        }
        archivedSymlinks.set(norm, target);
      }
    },
  });
  if (unsafeEntryError) throw unsafeEntryError;
  const confine = (rel: string): string => {
    const norm = normalizeRel(rel);
    if (!isSafeRelativePath(norm)) {
      throw new Error(`Unsafe path in snapshot meta: ${rel}`);
    }
    if (isProtectedRel(norm)) {
      throw new Error(`Snapshot meta names a protected path: ${rel}`);
    }
    const target = path.resolve(root, norm);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`Snapshot path escapes worktree root: ${rel}`);
    }
    return target;
  };
  // The lexical confine() above is not enough: a committed symlink can make a
  // lexically-inside path resolve outside the root, and fs.rm follows the
  // parent symlink (deleting an outside file). Resolve the parent's realpath
  // and require it under the real root before any removal.
  const assertRealContained = async (target: string, rel: string) => {
    for (let parent = path.dirname(target); ; parent = path.dirname(parent)) {
      let realParent: string;
      try {
        realParent = await fs.realpath(parent);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const replacesTrackedEntry =
          code === 'ENOTDIR' &&
          archived.get(
            normalizeRel(path.relative(root, parent).split(path.sep).join('/')),
          ) === 'Directory';
        if (code !== 'ENOENT' && !replacesTrackedEntry) throw error;
        // Missing descendants are created later. A tracked regular file (or a
        // symlink to a file) can also stand where an archived Directory
        // belongs, making a deeper realpath throw ENOTDIR; that entry is
        // removed only after all containment and protected-path checks pass.
        // At least one real ancestor must still prove containment.
        if (parent === root) throw error;
        continue;
      }
      if (
        realParent !== realRoot &&
        !realParent.startsWith(realRoot + path.sep)
      ) {
        throw new Error(
          `Snapshot path resolves outside worktree root via symlink: ${rel}`,
        );
      }
      const resolved = path.join(realParent, path.relative(parent, target));
      const resolvedRel = path
        .relative(realRoot, resolved)
        .split(path.sep)
        .join('/');
      if (resolvedRel && isProtectedRel(resolvedRel)) {
        throw new Error(
          `Snapshot path resolves to a protected path via symlink: ${rel}`,
        );
      }
      return;
    }
  };
  // Check every member, including Directory entries, before ANY removal or
  // extraction. preservePaths disables node-tar's own traversal protection;
  // lexical checks alone would miss a pre-existing parent symlink (R8 audit).
  for (const [rel] of archived) {
    await assertRealContained(confine(rel), rel);
  }
  for (const [, rawTarget] of hardlinks) {
    const targetRel = canonicalArchiveMemberName(rawTarget);
    const target = confine(targetRel);
    if (archived.get(targetRel) !== 'File') {
      throw new Error(
        `Snapshot hardlink target is not an archived regular file: ${rawTarget}`,
      );
    }
    await assertRealContained(target, targetRel);
    const realTarget = await fs.realpath(target).catch(() => null);
    if (realTarget !== null) {
      if (
        realTarget !== realRoot &&
        !realTarget.startsWith(realRoot + path.sep)
      ) {
        throw new Error(
          `Snapshot hardlink resolves outside worktree root: ${targetRel}`,
        );
      }
      const realTargetRel = path
        .relative(realRoot, realTarget)
        .split(path.sep)
        .join('/');
      if (realTargetRel && isProtectedRel(realTargetRel)) {
        throw new Error(
          `Snapshot hardlink resolves to a protected path: ${targetRel}`,
        );
      }
    }
  }
  // All containment checks have completed before removing anything. Clear a
  // tracked regular file or in-root non-protected symlink only where a
  // Directory member explicitly replaces it, after every nested protected-path
  // check passes, so nested descendants restore into a real directory without
  // hitting ENOTDIR or traversing a committed symlink into another directory.
  const filesToClear: string[] = [];
  for (const [rel, type] of archived) {
    if (type !== 'Directory') continue;
    const target = confine(rel);
    const stat = await fs.lstat(target).catch((error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      if (
        code === 'ENOTDIR' &&
        filesToClear.some((file) => target.startsWith(file + path.sep))
      ) {
        return null;
      }
      throw error;
    });
    if (stat?.isFile()) {
      await assertRealContained(target, rel);
      const realTarget = await fs.realpath(target);
      const realRel = path
        .relative(realRoot, realTarget)
        .split(path.sep)
        .join('/');
      // A nested member can alias the top-level protected gitfile through an
      // existing symlink. Parent containment alone does not protect that file.
      if (isProtectedRel(realRel)) {
        throw new Error(
          `Snapshot directory replacement targets a protected path: ${rel}`,
        );
      }
      filesToClear.push(target);
    } else if (stat?.isSymbolicLink()) {
      await assertRealContained(target, rel);
      const realTarget = await fs.realpath(target).catch(() => null);
      if (realTarget === null) {
        throw new Error(
          `Snapshot path resolves outside worktree root via symlink: ${rel}`,
        );
      }
      if (
        realTarget !== realRoot &&
        !realTarget.startsWith(realRoot + path.sep)
      ) {
        throw new Error(
          `Snapshot path resolves outside worktree root via symlink: ${rel}`,
        );
      }
      const realRel = path
        .relative(realRoot, realTarget)
        .split(path.sep)
        .join('/');
      if (realRel && isProtectedRel(realRel)) {
        throw new Error(
          `Snapshot directory replacement targets a protected path: ${rel}`,
        );
      }
      filesToClear.push(target);
    }
  }
  for (const target of filesToClear) {
    await fs.rm(target, { force: true });
  }
  for (const [rel, type] of archived) {
    if (type === 'Directory') continue;
    const target = confine(rel);
    const stat = await fs.lstat(target).catch(() => null);
    if (stat?.isDirectory()) {
      await assertRealContained(target, rel);
      await fs.rm(target, { recursive: true, force: true });
    }
  }
  for (const rel of meta.dirty.deleted) {
    const target = confine(rel);
    const norm = normalizeRel(rel).replace(/\/$/, '');
    if (archived.has(norm)) continue;
    const stat = await fs.lstat(target).catch(() => null);
    if (stat?.isDirectory()) continue;
    await assertRealContained(target, rel);
    await fs.rm(target, { force: true, recursive: true });
  }

  // Git does not track directories. Prune empty unarchived HEAD parent
  // directories along deleted paths BEFORE tar.extract and archivedSymlinks
  // so archived dir->file and dir->symlink replacements never hit ENOTDIR or
  // traverse a newly materialized symlink to delete another directory.
  const parents = new Set<string>();
  for (const rel of meta.dirty.deleted) {
    let parent = path.posix.dirname(normalizeRel(rel).replace(/\/+$/, ''));
    while (parent !== '.' && parent !== '..') {
      parents.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  const hasSymlinkComponent = async (rel: string): Promise<boolean> => {
    let cursor = '';
    for (const part of rel.split('/')) {
      cursor = cursor ? `${cursor}/${part}` : part;
      const stat = await fs.lstat(confine(cursor)).catch((error) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return null;
        throw error;
      });
      if (stat === null) return false;
      if (stat.isSymbolicLink()) return true;
    }
    return false;
  };
  for (const rel of [...parents].sort(
    (left, right) => right.split('/').length - left.split('/').length,
  )) {
    if (archived.has(rel)) continue;
    if (await hasSymlinkComponent(rel)) continue;
    const target = confine(rel);
    const stat = await fs.lstat(target).catch((error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw error;
    });
    if (!stat?.isDirectory()) continue;
    await assertRealContained(target, rel);
    const entries = await fs.readdir(target);
    if (entries.length === 0) await fs.rmdir(target);
  }

  await tar.extract({
    file: snapshotPath,
    cwd: targetWorktreePath,
    strict: true,
    // Replace existing HEAD files so creation applies the archived mode.
    unlink: true,
    // Keep absolute and ../ link targets (R8-5), but never materialize an
    // archived SymbolicLink or Link during extraction: a later member could
    // traverse a newly created symlink (or a hardlink to a HEAD relative
    // symlink) as a parent and escape the worktree root.
    filter: (_path, entry) =>
      'type' in entry && entry.type !== 'SymbolicLink' && entry.type !== 'Link',
    // Lexical member checks and real-ancestor checks above remain the
    // OUT-OF-ROOT gate alongside the deferred link creation below.
    preservePaths: true,
  });
  for (const [memberRel, rawTarget] of hardlinks) {
    const targetRel = canonicalArchiveMemberName(rawTarget);
    const memberPath = confine(memberRel);
    const targetPath = confine(targetRel);
    await assertRealContained(memberPath, memberRel);
    await assertRealContained(targetPath, targetRel);
    const targetStat = await fs.lstat(targetPath);
    if (!targetStat.isFile()) {
      throw new Error(
        `Snapshot hardlink target is not a regular file: ${rawTarget}`,
      );
    }
    await fs.mkdir(path.dirname(memberPath), { recursive: true });
    const memberStat = await fs.lstat(memberPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (memberStat?.isDirectory()) {
      throw new Error(
        `Snapshot hardlink conflicts with a directory: ${memberRel}`,
      );
    }
    if (memberStat !== null) await fs.unlink(memberPath);
    await fs.link(targetPath, memberPath);
  }
  for (const [rel, linkTarget] of archivedSymlinks) {
    const target = confine(rel);
    await assertRealContained(target, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const stat = await fs.lstat(target).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (stat?.isDirectory()) {
      throw new Error(`Snapshot symlink conflicts with a directory: ${rel}`);
    }
    if (stat !== null) await fs.unlink(target);
    await fs.symlink(linkTarget, target);
  }
}
