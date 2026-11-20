/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import nodeFs from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomBytes, randomInt } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { execFile, execSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import type { SimpleGit, SimpleGitOptions } from 'simple-git';
import { Storage } from '../config/storage.js';
import { isCommandAvailable } from '../utils/shell-utils.js';
import { isNodeError } from '../utils/errors.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { fileExists, isWithinRoot } from '../utils/fileUtils.js';
import { NO_EXEC_CONFIG } from '../utils/gitUtils.js';
import { runGit, runGitCapture } from '../utils/git-branches.js';
import { loadSimpleGit } from '../utils/load-simple-git.js';
import { gitEnv, gitRemoteEnv } from '../utils/git-branches.js';
import { initRepositoryWithMainBranch } from './gitInit.js';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';

const debugLogger = createDebugLogger('GIT_WORKTREE_SERVICE');

/** Prefix applied to every general-purpose worktree branch. */
export const WORKTREE_BRANCH_PREFIX = 'worktree-';

/** Returns the canonical branch name for a worktree slug. */
export function worktreeBranchForSlug(slug: string): string {
  return `${WORKTREE_BRANCH_PREFIX}${slug}`;
}

/**
 * The bare branch name from a `rev-parse --symbolic-full-name HEAD` answer.
 * `--abbrev-ref` qualifies a short name as `heads/<name>` when a same-named
 * tag (or other ref) makes it ambiguous, which would never equal the bare
 * name recorded in the sidecar; the full ref is namespace-independent, so
 * stripping the fixed `refs/heads/` prefix recovers the exact branch name
 * even for a branch literally named `heads/foo`. A detached HEAD reports
 * `HEAD`, which is returned unchanged for the caller to interpret.
 */
function bareBranchName(symbolicRef: string): string {
  return symbolicRef.startsWith('refs/heads/')
    ? symbolicRef.slice('refs/heads/'.length)
    : symbolicRef;
}

/**
 * Error detection for the dirty-carry `stash apply` and `stash create` calls.
 * simple-git's default treats a non-zero exit as an error only when stderr is
 * non-empty (`exitCode && stdErr.length`); a git command that fails with an
 * empty stderr — observed on the CI fleet's git build, where a held index lock
 * / read-only git directory made the apply exit non-zero yet resolve, and on
 * git 2.39.5 where `stash create` exits 1 writing nothing to either stream —
 * would otherwise leave the error unset and record a carry that never landed
 * (or an empty "nothing to carry"). Judge by the real process exit status so
 * any non-zero exit surfaces, regardless of which stream git reported on.
 */
export const carryApplyErrorDetection: NonNullable<
  SimpleGitOptions['errors']
> = (error, result) => {
  if (error) return error;
  if (result.exitCode === 0) return undefined;
  const message = Buffer.concat([...result.stdOut, ...result.stdErr])
    .toString('utf8')
    .trim();
  return new Error(message || `git exited with code ${result.exitCode}`);
};

/**
 * Filename of the in-worktree session marker. Created at worktree
 * provisioning time and consulted by `exit_worktree` to decide
 * whether the current session is allowed to drop the worktree. Marker
 * writers keep it and ownership-transfer temp files out of commits via
 * the repository's common `.git/info/exclude`.
 */
export const WORKTREE_SESSION_FILE = '.qwen-session';
const WORKTREE_SESSION_MARKER_MAX_BYTES = 512;

/**
 * Upper bound on the serialized carried-overlay path list. The branch
 * preparation journal persists `carriedPaths` and its reader refuses
 * records above 64 KiB (`BRANCH_WORKTREE_JOURNAL_MAX_BYTES`); an overlay
 * too large to record would make every later phase transition — including
 * the rollback's own — throw, stranding the worktree and its journal.
 * Half the journal cap leaves room for the rest of the record. Overlays
 * above the bound are not carried (fail-open to committed state), keeping
 * every created worktree rollbackable.
 */
export const CARRIED_PATHS_MAX_BYTES = 32 * 1024;

/** Root-level staged marker siblings (`.qwen-session.<hex>.tmp`), matching
 * the anchored info/exclude rule. */
const WORKTREE_SESSION_TMP_PATTERN = new RegExp(
  `^${WORKTREE_SESSION_FILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[^/]*\\.tmp$`,
);

export class WorktreeSessionMarkerOwnerChangedError extends Error {
  constructor() {
    super('Worktree session marker owner changed');
    this.name = 'WorktreeSessionMarkerOwnerChangedError';
  }
}

/**
 * The dirty carry's tracked snapshot could not be applied cleanly. Either
 * it conflicted with the worktree base (a 3-way `stash apply` that wrote
 * conflict markers and unmerged index entries, `conflict: true`) or it
 * failed for an environment reason such as an unwritable index
 * (`conflict: false`). The worktree is restored to committed state when
 * `restoreFailed` is false; callers must not present the overlay as carried,
 * and may distinguish a content conflict from an environment failure via
 * `conflict`. When `restoreFailed` is true the restore itself failed (locked
 * index, read-only git dir) and the worktree may still hold a half-applied
 * overlay — a fail-open caller must NOT baseline it as committed user state.
 */
export class WorktreeDirtyCarryConflictError extends Error {
  readonly conflict: boolean;
  readonly restoreFailed: boolean;
  constructor(
    message: string,
    options?: { conflict?: boolean; restoreFailed?: boolean },
  ) {
    super(message);
    this.name = 'WorktreeDirtyCarryConflictError';
    this.conflict = options?.conflict ?? true;
    this.restoreFailed = options?.restoreFailed ?? false;
  }
}

/**
 * Ignored directories whose contents are regenerable build or
 * dependency output. They are exempt from the ignored-content check in
 * {@link worktreeHasWork} so a checkout where an agent ran `npm install`
 * or a build stays cleanable; every other ignored entry (agent artifacts
 * like `.qwen/pr-drafts/`) still counts as work. An entry matches when
 * its first path segment is in the set (root output, `node_modules/…`)
 * or when it is an ignored directory whose last segment is in the set
 * (a monorepo's `packages/app/node_modules/`); a nested ignored file
 * outside those trees still counts as work.
 */
export const DISPOSABLE_IGNORED_ROOTS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'coverage',
]);

/**
 * One path of the dirty overlay a creation carried, with the content
 * identity it had at carry time (R9-6). The managed-session has-work gate
 * waives a carried path only while its current state still matches this
 * identity: a session that stages, deletes, or further edits a carried file
 * has produced new work the source checkout does not hold, so the gate must
 * read it as work and the reaper must snapshot it. Path equality alone
 * cannot tell the original carried copy from a later edit to the same path.
 *
 * `hash === null` records a carried deletion (the carry removed the path);
 * any other state of that path is new work. `executable` is the carried
 * file's exec bit, so a mode-only change is new work too. Non-regular
 * carried entries (symlinks, directories) get no content identity. A carried
 * untracked symlink is still waived by the general symlink waiver (it holds no
 * data in this checkout — removing it only unlinks it); any other non-regular
 * carried entry reads as work, the conservative direction (R5-6).
 */
export interface CarriedEntry {
  path: string;
  hash: string | null;
  executable: boolean;
}

/**
 * Compute carry-time content identities for the overlay paths inside a
 * worktree: absent paths become carried deletions, regular files are hashed
 * with `git hash-object --no-filters` (raw bytes, batched to bound argv) and
 * carry their exec bit. Non-regular entries are omitted (a carried untracked
 * symlink falls to the general symlink waiver; other non-regular entries read
 * as work). Rejects on a read/hash failure — a caller that cannot describe
 * the overlay must not record an exemption it cannot later verify.
 */
export async function computeCarriedIdentities(
  worktreePath: string,
  paths: readonly string[],
): Promise<CarriedEntry[]> {
  const entries: CarriedEntry[] = [];
  const present: Array<{ path: string; executable: boolean }> = [];
  for (const rel of paths) {
    let stat;
    try {
      stat = await fs.lstat(path.join(worktreePath, rel));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        entries.push({ path: rel, hash: null, executable: false });
        continue;
      }
      throw error;
    }
    if (stat.isFile()) {
      // Git derives the index mode from the OWNER exec bit alone (100755 vs
      // 100644). A wider mask (0o111) would read a git-visible mode change
      // like 0755→0655 as unchanged and waive it (R6-2).
      present.push({ path: rel, executable: (stat.mode & 0o100) !== 0 });
    }
  }
  const BATCH = 200;
  for (let i = 0; i < present.length; i += BATCH) {
    const batch = present.slice(i, i + BATCH);
    // --no-filters hashes the raw on-disk bytes. A path's clean filter (eol /
    // text / a custom clean command) can normalize an edit away, so hashing
    // filtered content would read a changed carried file as pristine and let
    // the reaper delete the session's new bytes without a snapshot (R4-1).
    const out = await runGit(worktreePath, [
      ...NO_EXEC_CONFIG,
      'hash-object',
      '--no-filters',
      '--',
      ...batch.map((e) => e.path),
    ]);
    const hashes = out.split('\n').filter((line) => line.length > 0);
    if (hashes.length !== batch.length) {
      throw new Error(
        `computeCarriedIdentities: hash-object returned ${hashes.length} hashes for ${batch.length} paths`,
      );
    }
    for (let j = 0; j < batch.length; j++) {
      entries.push({
        path: batch[j].path,
        hash: hashes[j],
        executable: batch[j].executable,
      });
    }
  }
  return entries;
}

/**
 * Whether the source checkout still holds the carried overlay, content-for-
 * content. The no-archive collection of a pristine carried-only worktree is
 * safe only on that premise: the overlay is a copy of the source's dirty state,
 * so deleting the worktree's copy loses nothing while the source keeps it. The
 * gate verifies the worktree side, but the source may have moved on (reverted,
 * re-edited, or lost the files) — nothing else checks it (R5-2). Compare the
 * source's current identities for the carried paths against the recorded ones.
 * Fail-closed: a source that cannot be read, or whose content no longer matches,
 * does NOT authorize the no-archive delete (the caller snapshots instead).
 */
export async function carriedOverlayStillHeldBySource(
  sourcePath: string,
  carriedEntries: readonly CarriedEntry[],
  worktreePath?: string,
): Promise<boolean> {
  try {
    // carriedFrom may name a SUBDIRECTORY of the source checkout (a session
    // /cd'd below the top): the overlay paths are repo-relative, so resolve
    // the checkout top before joining them. A gone or unreadable source
    // fails rev-parse and falls to the catch — including an all-deletions
    // overlay, whose absent paths would otherwise lstat as ENOENT and
    // masquerade as "still absent" in a source that no longer exists.
    const sourceTop = (
      await runGit(sourcePath, [
        ...NO_EXEC_CONFIG,
        'rev-parse',
        '--show-toplevel',
      ])
    ).trim();
    // Upward discovery can land in an UNRELATED repository when the source
    // checkout's own .git is gone (a corrupted sibling worktree under the
    // main repo's managed dir discovers the enclosing main repo — the
    // R5-14 decoy again). When the managed worktree is known, require the
    // source to resolve into the SAME repository (identical git common
    // dir); the carry always comes from a checkout of that repository.
    if (worktreePath !== undefined) {
      const [sourceCommon, worktreeCommon] = await Promise.all([
        runGit(sourceTop, [...NO_EXEC_CONFIG, 'rev-parse', '--git-common-dir']),
        runGit(worktreePath, [
          ...NO_EXEC_CONFIG,
          'rev-parse',
          '--git-common-dir',
        ]),
      ]);
      const [sourceReal, worktreeReal] = await Promise.all([
        fs.realpath(path.resolve(sourceTop, sourceCommon.trim())),
        fs.realpath(path.resolve(worktreePath, worktreeCommon.trim())),
      ]);
      if (sourceReal !== worktreeReal) return false;
    }
    const current = new Map(
      (
        await computeCarriedIdentities(
          sourceTop,
          carriedEntries.map((e) => e.path),
        )
      ).map((e) => [e.path, e]),
    );
    for (const stored of carriedEntries) {
      const cur = current.get(stored.path);
      if (stored.hash === null) {
        // A missing identity can also mean a present non-regular path.
        if (cur === undefined || cur.hash !== null) return false;
      } else if (
        cur === undefined ||
        cur.hash === null ||
        cur.hash !== stored.hash ||
        cur.executable !== stored.executable
      ) {
        return false;
      }
    }
    return true;
  } catch (error) {
    debugLogger.debug(
      `carriedOverlayStillHeldBySource: cannot verify source ${sourcePath}, refusing no-archive collection: ${error}`,
    );
    return false;
  }
}

/**
 * Whether the index hides any path's worktree changes from `git status` via
 * an assume-unchanged (lowercase tag) or skip-worktree (`S`) bit. Such a bit
 * lets a session edit read clean, so a predicate gating a destructive sink
 * must refuse it — except for paths legitimately omitted by
 * `git sparse-checkout`. Those omissions are verified against Git's own
 * current rules, not inferred from core.sparseCheckout=true alone: an
 * unexpected S on an included path can hide a tracked deletion. An exempt
 * path must also be genuinely absent, so a materialized S path is never
 * waived. Refusing every S would instead strand legitimate sparse omissions.
 * Older Git without `check-rules` recomputes the index flags in a private
 * copy via `sparse-checkout reapply`. All other probe failures remain
 * fail-closed. Pins the worktree's own `.git` (no upward
 * discovery): only the named sparse-index expansion advice is suppressed;
 * any other stderr output counts as hidden.
 */
/**
 * Only an ENOENT leaf below a directory ancestor is a genuine omission.
 * Unreadable entries and non-directory ancestors cannot prove absence.
 * Probes are memoized only within one enumeration.
 */
async function isPathProvablyAbsent(
  repoRoot: string,
  relativePath: string,
  ancestorProbes: Map<string, boolean>,
): Promise<boolean> {
  const candidate = path.join(repoRoot, relativePath);
  try {
    await fs.lstat(candidate);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  let ancestor = path.dirname(candidate);
  const walked: string[] = [];
  const decide = (verdict: boolean): boolean => {
    for (const item of walked) ancestorProbes.set(item, verdict);
    return verdict;
  };
  for (;;) {
    const memoized = ancestorProbes.get(ancestor);
    if (memoized !== undefined) return decide(memoized);
    try {
      const verdict = (await fs.stat(ancestor)).isDirectory();
      ancestorProbes.set(ancestor, verdict);
      return decide(verdict);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        ancestorProbes.set(ancestor, false);
        return decide(false);
      }
    }
    walked.push(ancestor);
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return false;
    ancestor = parent;
  }
}

async function legacySparseOmissionMayHideWork(
  worktreePath: string,
  omitted: ReadonlySet<string>,
): Promise<boolean> {
  const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-sparse-'));
  const index = path.join(probeDir, 'index');
  const privateWorktree = path.join(probeDir, 'worktree');
  try {
    const indexPath = (
      await runGit(worktreePath, [
        ...NO_EXEC_CONFIG,
        'rev-parse',
        '--git-path',
        'index',
      ])
    ).trim();
    await fs.mkdir(privateWorktree);
    await fs.copyFile(
      path.resolve(worktreePath, indexPath),
      index,
      fsConstants.COPYFILE_EXCL,
    );
    // reapply also cleans stale sparse directories. Redirect both its index
    // and work-tree to private files, including any directory removals.
    const env = {
      ...gitEnv(),
      GIT_INDEX_FILE: index,
      GIT_WORK_TREE: privateWorktree,
    };
    const reapplied = await execFileAsync(
      'git',
      [
        ...NO_EXEC_CONFIG,
        '-c',
        'submodule.recurse=false',
        '--no-optional-locks',
        'sparse-checkout',
        'reapply',
      ],
      {
        cwd: worktreePath,
        env,
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
      },
    );
    if (reapplied.stderr.trim().length > 0) return true;
    const listed = await execFileAsync(
      'git',
      [
        ...NO_EXEC_CONFIG,
        '-c',
        'advice.sparseIndexExpanded=false',
        '--no-optional-locks',
        'ls-files',
        '-v',
        '-z',
      ],
      {
        cwd: worktreePath,
        env,
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
      },
    );
    if (listed.stderr.trim().length > 0) return true;
    const remaining = new Set<string>();
    for (const entry of listed.stdout.split('\0')) {
      const tag = entry[0];
      if (/[a-z]/.test(tag ?? '')) return true;
      if (tag !== 'S') continue;
      const relativePath = entry.slice(2);
      if (relativePath.includes('\uFFFD') || !omitted.has(relativePath)) {
        return true;
      }
      remaining.add(relativePath);
    }
    // A disappeared S means Git considers that path included, so the
    // original bit may have hidden a tracked deletion rather than an
    // ordinary sparse omission.
    return remaining.size !== omitted.size;
  } finally {
    await fs.rm(probeDir, { recursive: true, force: true });
  }
}

export async function hasHiddenIndexBit(
  worktreePath: string,
): Promise<boolean> {
  try {
    await fs.access(path.join(worktreePath, '.git'));
    // The listing's size follows the repository (~64 B/tracked path), not the
    // question; give it a much larger buffer than the default so a large index
    // does not overflow into the fail-closed "has work" answer (R3-2). A truly
    // enormous index still fails closed (preserve), never deletes bare.
    const { stdout, stderr } = await runGitCapture(
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
    if (stderr.trim().length > 0) {
      debugLogger.debug(
        `worktreeHasWork: ls-files -v probe at ${worktreePath} reported on stderr, treating as work: ${stderr.trim()}`,
      );
      return true;
    }
    const skipWorktree = new Set<string>();
    for (const entry of stdout.split('\0')) {
      if (entry.length === 0) continue;
      const tag = entry[0];
      if (/[a-z]/.test(tag)) return true;
      if (tag === 'S') {
        const relativePath = entry.slice(2);
        // A replacement character cannot reliably recover the original path
        // bytes. Git could therefore disagree about directory inclusion.
        if (relativePath.includes('\uFFFD')) return true;
        skipWorktree.add(relativePath);
      }
    }
    if (skipWorktree.size > 0) {
      // The effective value includes legacy shared local configuration,
      // which can exist without extensions.worktreeConfig.
      const sparse = await runGitCapture(worktreePath, [
        ...NO_EXEC_CONFIG,
        'config',
        '--type=bool',
        '--get',
        'core.sparseCheckout',
      ])
        .then(({ stdout: out }) => out.trim())
        .catch(() => 'false');
      if (sparse !== 'true') return true;
      // A materialized S path is never a legitimate omission, even when
      // sparse.expectFilesOutsideOfPatterns=true keeps it out of status.
      // Only an ENOENT leaf below a directory ancestor may be waived.
      const omitted: string[] = [];
      const ancestorProbes = new Map<string, boolean>();
      for (const rel of skipWorktree) {
        if (!(await isPathProvablyAbsent(worktreePath, rel, ancestorProbes))) {
          return true;
        }
        omitted.push(rel);
      }
      // Git's rules, not merely core.sparseCheckout=true, decide whether an
      // omitted path is legitimate. A hand-set S on an included path can
      // hide a tracked deletion from status and both cleanup digests.
      let unsupported = false;
      let stdinError: unknown;
      const included = await new Promise<{
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const child = execFile(
          'git',
          [
            ...NO_EXEC_CONFIG,
            '--no-optional-locks',
            'sparse-checkout',
            'check-rules',
            '-z',
          ],
          {
            cwd: worktreePath,
            env: gitEnv(),
            timeout: 30_000,
            maxBuffer: 64 * 1024 * 1024,
            encoding: 'utf8',
          },
          (error, stdout, stderr) => {
            if (error && stderr.includes("unknown subcommand: `check-rules'")) {
              unsupported = true;
              resolve({ stdout, stderr });
            } else if (error) reject(error);
            else if (stdinError !== undefined) reject(stdinError);
            else resolve({ stdout, stderr });
          },
        );
        child.on('error', reject);
        // An unsupported command can close stdin before its real stderr
        // arrives. Keep other input failures for that completion handler.
        child.stdin?.on('error', (error) => {
          stdinError = error;
        });
        child.stdin?.end(`${omitted.join('\0')}\0`);
      });
      if (unsupported) {
        return await legacySparseOmissionMayHideWork(
          worktreePath,
          skipWorktree,
        );
      }
      if (included.stderr.trim().length > 0) return true;
      const includedPaths = new Set(included.stdout.split('\0'));
      for (const rel of skipWorktree) {
        if (includedPaths.has(rel)) return true;
      }
    }
    return false;
  } catch (error) {
    debugLogger.debug(
      `worktreeHasWork: ls-files -v probe at ${worktreePath} failed, treating as work: ${error}`,
    );
    return true;
  }
}

/**
 * Whether a merge/rebase/cherry-pick/revert/bisect is paused in this worktree.
 * The paused operation's private state lives in the per-worktree gitdir and
 * is NOT representable by a worktree tar + status header: cleanup must
 * preserve, never delete and hope a restore recreates it (P1).
 *
 * Checked are pseudo-ref files (MERGE_AUTOSTASH, MERGE_HEAD, REBASE_HEAD,
 * CHERRY_PICK_HEAD, REVERT_HEAD, BISECT_START) AND the pause DIRECTORIES
 * (rebase-merge, rebase-apply, sequencer) — rebase `break`/`exec` and `git am`
 * carry their state only in these directories. REBASE_HEAD can outlive
 * `rebase --quit`, so it alone does not prove a pause: require a pause
 * directory too. All paths resolve through one `rev-parse --git-dir` (the
 * real admin dir of a linked worktree), so an in-progress operation reads as
 * pending even on linked worktrees. Fail-closed: a read error counts as
 * pending.
 */
export async function worktreeHasPendingGitOperation(
  worktreePath: string,
): Promise<boolean> {
  const files = [
    'MERGE_AUTOSTASH',
    'MERGE_HEAD',
    'REBASE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'BISECT_START',
  ];
  const pauseDirs = ['rebase-merge', 'rebase-apply', 'sequencer'];
  try {
    const gitDir = (
      await runGit(worktreePath, [...NO_EXEC_CONFIG, 'rev-parse', '--git-dir'])
    ).trim();
    const root = path.resolve(worktreePath, gitDir);
    for (const rel of [...files, ...pauseDirs]) {
      try {
        await fs.access(path.join(root, rel));
        if (rel === 'REBASE_HEAD') {
          const paused = await Promise.all(
            pauseDirs.map(async (dir) => {
              try {
                await fs.access(path.join(root, dir));
                return true;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                  throw error;
                }
                return false;
              }
            }),
          );
          if (!paused.includes(true)) continue;
        }
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return false;
  } catch (error) {
    debugLogger.debug(
      `worktreeHasPendingGitOperation: probe at ${worktreePath} failed, treating as pending: ${error}`,
    );
    return true;
  }
}

/**
 * Whether the worktree holds an initialized submodule's state: a populated
 * gitlink in the index, or a persisting submodule object store. A submodule
 * has its own object database, which can hold unpushed commits that live
 * nowhere else; removing the checkout (or archiving only its working files)
 * would discard them, and `submodule.<name>.ignore=dirty` can hide the dirt
 * from `git status`. A destructive sink must therefore preserve such a
 * checkout. Fail-closed: a read error counts as populated.
 */
export async function worktreeHasPopulatedGitlink(
  worktreePath: string,
): Promise<boolean> {
  try {
    await fs.access(path.join(worktreePath, '.git'));
    const { stdout, stderr } = await runGitCapture(
      worktreePath,
      [
        ...NO_EXEC_CONFIG,
        '-c',
        'advice.sparseIndexExpanded=false',
        '--no-optional-locks',
        'ls-files',
        '--stage',
        '-z',
      ],
      undefined,
      64 * 1024 * 1024,
    );
    if (stderr.trim().length > 0) return true;
    for (const entry of stdout.split('\0')) {
      if (!entry.startsWith('160000 ')) continue;
      const separator = entry.indexOf('\t');
      if (separator < 0) return true;
      const gitlinkPath = path.resolve(
        worktreePath,
        entry.slice(separator + 1),
      );
      if (
        gitlinkPath === worktreePath ||
        !gitlinkPath.startsWith(`${worktreePath}${path.sep}`)
      ) {
        return true;
      }
      const populated = await fs
        .lstat(gitlinkPath)
        .then(async (stat) => {
          if (!stat.isDirectory()) return true;
          return (await fs.readdir(gitlinkPath)).length > 0;
        })
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        });
      if (populated) return true;
    }
    // A submodule's object database (possibly holding unpushed commits)
    // persists in the per-worktree admin dir `<git-dir>/modules/<name>` even
    // when the working directory is emptied (deinit) OR the gitlink leaves
    // the index entirely (`git rm lib`, staged or committed) — `git worktree
    // remove` then deletes the store with the admin dir, and the archive
    // cannot cover it (it sits outside the worktree root). Scan it
    // UNCONDITIONALLY: gating on the index gitlink let a staged removal
    // bypass the preserve (R5-3 round-6). A worktree that never initialized
    // a submodule has no modules dir; the ENOENT-tolerant readdir keeps that
    // case cheap.
    const gitDir = (
      await runGit(worktreePath, [...NO_EXEC_CONFIG, 'rev-parse', '--git-dir'])
    ).trim();
    const modulesDir = path.resolve(worktreePath, gitDir, 'modules');
    // ENOENT means "never initialized a submodule" — cheap and clean. Any
    // OTHER read error (EACCES on a store created by another user, ENOTDIR,
    // EMFILE) must rethrow into the outer fail-closed catch: a store that
    // exists but cannot be listed may hold the only copy of unpushed
    // commits, and a blanket catch would answer "no store" and let the
    // reaper delete it (R7-1).
    const modules = await fs
      .readdir(modulesDir)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [] as string[];
        throw error;
      });
    if (modules.length > 0) return true;
    return false;
  } catch (error) {
    debugLogger.debug(
      `worktreeHasPopulatedGitlink: probe at ${worktreePath} failed, treating as populated: ${error}`,
    );
    return true;
  }
}

/**
 * The one "is there work here?" predicate for every path that destroys a
 * worktree checkout: the CLI startup sweep (`cleanupStaleAgentWorktrees`)
 * and the daemon's orphan reaper both gate `removeUserWorktree` on this,
 * so the two reapers cannot drift into disagreeing policies again
 * (#12758).
 *
 * Runs `git status --porcelain --untracked-files=normal
 * --ignored=matching`: tracked, untracked and ignored entries all count
 * as work, except disposable build output ({@link DISPOSABLE_IGNORED_ROOTS}),
 * symlinks (removing the checkout only unlinks them; the target lives
 * elsewhere — this is what keeps `worktree.symlinkDirectories` checkouts
 * reapable, nested values included, which git reports as a collapsed parent
 * holding nothing but links), and the session marker
 * ({@link WORKTREE_SESSION_FILE}) when git lists it as ignored (its exclude
 * rule) or untracked (a fixture without one). A marker the repository tracks
 * counts as work like any other tracked change: an edit to a tracked path is
 * indistinguishable from user work, and since `writeWorktreeSessionMarker`
 * overwrites a tracked marker unconditionally the daemon can be the author of
 * that edit, so such a preserve is permanent rather than transient. The argv
 * tokens added for this probe are literals placed after the `status`
 * subcommand and are never caller-derived (see `load-simple-git.ts`), and
 * `runGitCapture` scrubs the environment (`gitEnv`) so an inherited
 * `GIT_DIR` or `status.showUntrackedFiles=no` cannot make a dirty checkout
 * read clean.
 *
 * Fail-closed: any read error counts as work, preserving the checkout —
 * including the one kind that arrives as a zero exit status: git reports
 * a directory it cannot open as a stderr warning, leaving that content
 * absent from stdout, so any stderr output preserves the checkout too.
 * The `.git` access check exists because `runGitCapture` does not pin the
 * repository: without it, git's upward discovery from a path whose own
 * `.git` is gone (a sweep's `fs.rm` that threw partway, a restore that
 * dropped the link file) would answer about the *enclosing* repository —
 * and a clean enclosing repo would read as "no work", authorizing the
 * destructive sinks this predicate gates.
 */
export async function worktreeHasWork(
  worktreePath: string,
  carriedEntries?: readonly CarriedEntry[],
): Promise<boolean> {
  // A hidden index bit (assume-unchanged / skip-worktree) hides a path's
  // worktree changes from `git status`, so a session edit under such a bit
  // would read clean and be deleted bare. Refuse on any hidden bit before
  // either probe — carried or not — mirroring the prepared-worktree gate's
  // `ls-files -v` check. Fail-closed: a probe error counts as work.
  if (await hasHiddenIndexBit(worktreePath)) return true;
  // A paused merge/rebase/cherry-pick holds private operation state
  // (MERGE_AUTOSTASH) that neither the archive nor a fresh checkout can
  // recreate — never let a sink collect a checkout in that state (P1).
  if (await worktreeHasPendingGitOperation(worktreePath)) return true;
  // An initialized submodule holds its own object database (possibly unpushed
  // commits) that neither the worktree tar nor `git worktree remove` preserves,
  // and submodule.<name>.ignore=dirty can hide its dirt from status. Count it
  // as work so no destructive sink collects the checkout (P1 submodule).
  if (await worktreeHasPopulatedGitlink(worktreePath)) return true;
  // With a recorded carried overlay, exempt exactly those paths whose
  // current state still matches the carry-time identity, so a checkout
  // whose only content is the pristine carried copy reads clean (R9-6).
  // Absent/empty keeps the status probe below unchanged.
  if (carriedEntries && carriedEntries.length > 0) {
    return hasNonCarriedWork(
      worktreePath,
      new Map(carriedEntries.map((e) => [e.path, e])),
    );
  }
  try {
    await fs.access(path.join(worktreePath, '.git'));
    const { stdout, stderr } = await runGitCapture(worktreePath, [
      ...NO_EXEC_CONFIG,
      '--no-optional-locks',
      'status',
      '--porcelain',
      '--untracked-files=normal',
      '--ignored=matching',
    ]);
    // `git status` reports a directory it cannot open as a stderr warning
    // with exit 0, so that content is absent from stdout with no line to
    // preserve it — the one read error that arrives without rejecting.
    // Fail closed on it; the sweep's keeping line then carries the reason.
    if (stderr.trim().length > 0) {
      debugLogger.debug(
        `worktreeHasWork: status probe at ${worktreePath} reported on stderr, treating as work: ${stderr.trim()}`,
      );
      return true;
    }
    for (const line of stdout.split('\n')) {
      if (line.trim().length === 0) continue;
      const entry = line.slice(3);
      const status = line.slice(0, 2);
      let waived: string | null = null;
      if (
        (status === '!!' || status === '??') &&
        (entry === WORKTREE_SESSION_FILE ||
          WORKTREE_SESSION_TMP_PATTERN.test(entry))
      ) {
        waived = 'session-marker';
      } else if (status === '!!' && isDisposableIgnoredEntry(entry)) {
        waived = 'disposable-output';
      } else if (
        (status === '!!' || status === '??') &&
        (await isSymlinkEntry(worktreePath, entry))
      ) {
        waived = 'symlink';
      }
      if (waived === null) return true;
      // A waiver authorizes `git worktree remove --force` plus a branch
      // delete, and it destroys the very state that authorized it — so name
      // the entry while it can still be read. Stays at `debug` for the
      // reason the sweep's own breadcrumb records: `info` on every CLI start
      // that has any dirty worktree is log noise.
      debugLogger.debug(
        `worktreeHasWork: waiving ${status} ${entry} (${waived}) at ${worktreePath}`,
      );
    }
    return false;
  } catch (error) {
    debugLogger.debug(
      `worktreeHasWork: status probe at ${worktreePath} failed, treating as work: ${error}`,
    );
    return true;
  }
}

/**
 * Whether a carried path's current state still matches its carry-time
 * identity, so waiving it loses no work. A carried deletion must still be
 * an unstaged deletion of an absent path; carried content must still be an
 * unstaged tracked edit (` M`) or untracked file (`??`) with the same blob
 * hash and exec bit. Any other status — staged (`M `, `A `, `D `), a
 * deletion of carried content, a symlink replacement — or any content/mode
 * drift is new work the source checkout does not hold. `current` is absent
 * when the path is now non-regular (symlink/dir), which never matches.
 */
function carriedEntryMatches(
  stored: CarriedEntry,
  current: CarriedEntry | undefined,
  status: string,
): boolean {
  if (stored.hash === null) {
    return status === ' D' && current !== undefined && current.hash === null;
  }
  if (status !== ' M' && status !== '??') return false;
  return (
    current !== undefined &&
    current.hash === stored.hash &&
    current.executable === stored.executable
  );
}

/**
 * Carried-aware variant of {@link worktreeHasWork}: a checkout whose only
 * content is the pristine recorded carried overlay reads clean, while any
 * non-carried work — and any session change to a carried path — still
 * preserves it (R9-6). One collapsed probe, `status --porcelain
 * --untracked-files=all --ignored=matching -z`: non-ignored untracked files
 * stay file-level (so a carried path matches exactly and non-ASCII paths are
 * not C-quoted), while ignored entries collapse to directories — the same
 * geometry the base predicate uses, so a large `node_modules` does not
 * enumerate file-level and overflow the capture buffer, and nested ignored
 * disposable output is waived exactly as capture excludes it. The carried
 * waiver is content-aware: a carried path is exempt only while its current
 * state matches the carry-time identity ({@link carriedEntryMatches}), because
 * path equality alone cannot distinguish the original carried copy from a
 * later edit, stage, or delete of the same path. The reaper's session-marker /
 * disposable-output / symlink waivers apply on top of the carried exemption
 * for non-carried entries. Fail-closed like the base predicate: any read error
 * or stderr output counts as work.
 */
async function hasNonCarriedWork(
  worktreePath: string,
  carried: ReadonlyMap<string, CarriedEntry>,
): Promise<boolean> {
  try {
    await fs.access(path.join(worktreePath, '.git'));
    // Snapshot the carried paths' current identities once, so a further
    // edit / stage / delete of a carried path reads as work rather than
    // being waived by path equality alone.
    const current = new Map(
      (await computeCarriedIdentities(worktreePath, [...carried.keys()])).map(
        (e) => [e.path, e],
      ),
    );
    // Verify every carried entry against its current identity independent of
    // whether `git status` lists it: a carried untracked file the session
    // deleted leaves no status record, so the status loop alone would read the
    // checkout clean and collect it without a snapshot (R5-8). Any drift — a
    // content file edited, deleted, or replaced by a non-regular entry, or a
    // carried deletion restored — is work.
    for (const [rel, stored] of carried) {
      const cur = current.get(rel);
      if (stored.hash === null) {
        if (cur !== undefined && cur.hash !== null) return true;
      } else if (
        cur === undefined ||
        cur.hash === null ||
        cur.hash !== stored.hash ||
        cur.executable !== stored.executable
      ) {
        return true;
      }
    }
    // One collapsed probe: --ignored=matching lists ignored entries (dirs
    // collapsed, so a large node_modules does not enumerate file-level and
    // overflow the capture buffer), --untracked-files=all keeps non-ignored
    // untracked files file-level so a carried path matches exactly, and -z
    // keeps raw bytes (no C-quoting of non-ASCII paths). This mirrors the base
    // predicate's ignored geometry, so nested ignored disposable output
    // (`packages/app/node_modules/`) is waived here exactly as capture
    // excludes it.
    const { stdout, stderr } = await runGitCapture(
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
    if (stderr.trim().length > 0) {
      debugLogger.debug(
        `worktreeHasWork: carried status probe at ${worktreePath} reported on stderr, treating as work: ${stderr.trim()}`,
      );
      return true;
    }
    for (const record of stdout.split('\0')) {
      if (record.length === 0) continue;
      const status = record.slice(0, 2);
      const entry = record.slice(3);
      // The carry applies the stash without --index, so the overlay never
      // contains rename/copy records; one means the index was touched inside
      // the worktree. Refuse.
      if (status[0] === 'R' || status[0] === 'C') return true;
      const stored = carried.get(entry);
      let waived: string | null = null;
      if (stored !== undefined) {
        if (!carriedEntryMatches(stored, current.get(entry), status)) {
          return true;
        }
        waived = 'carried-overlay';
      } else if (
        (status === '!!' || status === '??') &&
        (entry === WORKTREE_SESSION_FILE ||
          WORKTREE_SESSION_TMP_PATTERN.test(entry))
      ) {
        waived = 'session-marker';
      } else if (status === '!!' && isDisposableIgnoredEntry(entry)) {
        waived = 'disposable-output';
      } else if (
        (status === '!!' || status === '??') &&
        (await isSymlinkEntry(worktreePath, entry))
      ) {
        waived = 'symlink';
      }
      if (waived === null) return true;
      debugLogger.debug(
        `worktreeHasWork: waiving ${status} ${entry} (${waived}) at ${worktreePath}`,
      );
    }
    return false;
  } catch (error) {
    debugLogger.debug(
      `worktreeHasWork: carried probe at ${worktreePath} failed, treating as work: ${error}`,
    );
    return true;
  }
}

/**
 * Disposable build output at the root (`node_modules/`) or as a workspace
 * package's own ignored directory (`packages/app/node_modules/`). That nested
 * rendering depends on how the ignore rule is spelled rather than holding for
 * every monorepo: git collapses the entry to `!! <dir>/` only when a rule
 * matches the *directory* itself (`node_modules/`, or a bare `node_modules`).
 * A rule matching the directory's *contents* instead (a package-local
 * `node_modules/**`) makes git list them individually
 * (`!! packages/app/node_modules/x/`), whose last segment is not in the set,
 * so such a tree still counts as work (the reaper snapshots it before
 * deleting). The snapshot's exclusion matcher reads the same listing, so it
 * archives exactly this content rather than dropping it (R6-1).
 */
export function isDisposableIgnoredEntry(entry: string): boolean {
  const segments = entry.replace(/\/$/, '').split('/');
  if (DISPOSABLE_IGNORED_ROOTS.has(segments[0] ?? '')) return true;
  return (
    entry.endsWith('/') &&
    DISPOSABLE_IGNORED_ROOTS.has(segments[segments.length - 1] ?? '')
  );
}

/**
 * A symlink holds no data in this checkout: `worktree.symlinkDirectories`
 * links e.g. `node_modules` from the main repo, and git lists such a link as
 * an untracked file when the ignore rule is directory-only
 * (`node_modules/`) or as an ignored one when the rule is bare (`.turbo`).
 * Removing the worktree unlinks it and never touches the target.
 *
 * A *nested* configured value (`tools/cache`) is reported differently:
 * `symlinkConfiguredDirectories` has to `fs.mkdir` the untracked parent
 * because `git worktree add` does not create it, and nothing writes an
 * exclude rule for linked paths, so git collapses the whole subtree to a
 * single `?? tools/` entry that never names the link. Such a collapsed
 * directory is exempt only when it holds at least one entry and every entry
 * inside it is itself a symlink — an empty one is not a link, a real file or
 * directory beside the links is work, and any read error fails closed exactly
 * like the status probe does.
 *
 * Quoted (special-character) paths are not resolved and count as work.
 */
async function isSymlinkEntry(
  worktreePath: string,
  entry: string,
): Promise<boolean> {
  if (entry.startsWith('"')) return false;
  const absolute = path.join(worktreePath, entry.replace(/\/$/, ''));
  try {
    const stats = await fs.lstat(absolute);
    if (stats.isSymbolicLink()) return true;
    if (!stats.isDirectory()) return false;
    // Dirents from `readdir` do not follow links, so a real subdirectory —
    // which may hold work one level down — fails this check. An *empty*
    // directory would satisfy "every child is a link" vacuously, and git does
    // list empty ignored directories (`!! build/`), so require at least one
    // link: waiving such an entry as `symlink` would authorize a removal with
    // a breadcrumb naming an exemption the checkout has nothing to do with.
    let sawLink = false;
    for (const child of await fs.readdir(absolute, { withFileTypes: true })) {
      if (!child.isSymbolicLink()) return false;
      sawLink = true;
    }
    return sawLink;
  } catch {
    return false;
  }
}

/**
 * Diff flags that stop the tree being diffed from choosing the program that
 * renders it.
 *
 * A `.gitattributes` binding a `diff=<name>` driver travels with a tree
 * obtained as files, and the `diff.<name>.textconv` or `diff.external` that
 * goes with it was measured running through these very calls. They also keep
 * the patch appliable, since a converted blob is no longer the pre-image
 * `git apply` expects. `core.fsmonitor` is handled for every client in
 * `loadSimpleGit`.
 */
const NO_EXEC_DIFF_FLAGS = ['--no-ext-diff', '--no-textconv'] as const;

export type StrictWorktreeSessionMarker =
  | { state: 'missing' }
  | {
      state: 'valid';
      sessionId: string;
      /**
       * Owning uid of the marker inode, or null when the process cannot
       * compare uids (no `geteuid`, e.g. Windows). Ownership-transfer
       * flows refuse a foreign-uid marker where the identity is available
       * instead of riding the ownership-preserving in-place write path.
       */
      uid: number | null;
      /** Inode identity pinned across the no-follow read. */
      dev: number;
      ino: number;
    }
  | { state: 'invalid'; reason: string };

export async function ensureWorktreeSessionMarkerExcluded(
  worktreePath: string,
): Promise<void> {
  // The marker lives inside the worktree dir so a subagent running
  // `git add -A` inside it would otherwise add the session id to its
  // first commit. Write a `.git/info/exclude` rule so the marker is
  // ignored without requiring (or modifying) a tracked `.gitignore`.
  // Linked worktrees use a per-worktree git dir, but Git reads the shared
  // repository's info/exclude. Resolve `--git-common-dir` instead of joining
  // `.git` naively.
  try {
    const { simpleGit } = await loadSimpleGit();
    const wtGit = simpleGit(worktreePath).env(gitEnv());
    const gitDir = (await wtGit.revparse(['--git-common-dir'])).trim();
    const excludePath = path.isAbsolute(gitDir)
      ? path.join(gitDir, 'info', 'exclude')
      : path.join(worktreePath, gitDir, 'info', 'exclude');
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    let existing = '';
    try {
      existing = await fs.readFile(excludePath, 'utf8');
    } catch {
      // File missing — fall through to fresh write.
    }
    // The second rule covers the sibling temp file `atomicWriteFile` stages
    // next to the marker during an ownership transfer
    // (`<worktree>/.qwen-session.<hex>.tmp`). Anchor both rules at the
    // worktree root so nested user files with the same name stay visible.
    const rules = [
      `/${WORKTREE_SESSION_FILE}`,
      `/${WORKTREE_SESSION_FILE}.*.tmp`,
    ];
    let next = existing;
    for (const rule of rules) {
      if (!next.split(/\r?\n/).includes(rule)) {
        const sep = next.length === 0 || next.endsWith('\n') ? '' : '\n';
        next = `${next}${sep}${rule}\n`;
      }
    }
    if (next !== existing) {
      await fs.writeFile(excludePath, next, 'utf8');
    }
  } catch {
    // Best-effort: ownership validation remains authoritative even if the
    // ignore rule cannot be written.
  }
}

/**
 * The marker is durably committed — staged, fsync'd, identity-verified and
 * linked into place — but this primitive's own post-commit tail failed. The
 * commit stands: a caller that compensates on failure must classify this as
 * "the flip happened" rather than roll back a transfer the marker already
 * records, and must not clean up a valid marker file. `committedOwner` is the
 * session id the marker now names.
 */
export class WorktreeMarkerCommittedError extends Error {
  readonly committedOwner: string;
  constructor(committedOwner: string, options?: { cause?: unknown }) {
    super(
      `Worktree session marker committed for ${committedOwner}; the post-commit close failed`,
      options,
    );
    this.name = 'WorktreeMarkerCommittedError';
    this.committedOwner = committedOwner;
  }
}

/**
 * Creates the daemon-owned marker without replacing any existing path.
 */
export async function createWorktreeSessionMarkerExclusive(
  worktreePath: string,
  sessionId: string,
): Promise<void> {
  assertValidWorktreeSessionMarkerOwner(sessionId);
  const markerPath = path.join(worktreePath, WORKTREE_SESSION_FILE);
  // Staged beside the marker so the publishing link stays on one device, and
  // named for the `.qwen-session.*.tmp` git-exclude rule.
  const stagedPath = `${markerPath}.${randomBytes(6).toString('hex')}.tmp`;
  const flags =
    nodeFs.constants.O_WRONLY |
    nodeFs.constants.O_CREAT |
    nodeFs.constants.O_EXCL |
    (nodeFs.constants.O_NOFOLLOW ?? 0);
  // `fs.open` with O_EXCL throws before anything is created when a path
  // already exists, so it stays outside the try: only a failure past this
  // point has a file of ours to remove.
  const handle = await fs.open(stagedPath, flags, 0o600);
  // Captured from the opened handle so the cleanup below can verify the path
  // still refers to the file this call created before removing it.
  let stagedDev = 0;
  let stagedIno = 0;
  try {
    const before = await handle.stat();
    stagedDev = before.dev;
    stagedIno = before.ino;
    if (!before.isFile() || before.nlink !== 1 || before.ino === 0) {
      throw new Error('Worktree session marker has an unsafe identity');
    }
    await handle.writeFile(sessionId, 'utf8');
    await handle.sync();
    const [after, pathStats] = await Promise.all([
      handle.stat(),
      fs.lstat(stagedPath),
    ]);
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      after.size > WORKTREE_SESSION_MARKER_MAX_BYTES ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      pathStats.dev !== after.dev ||
      pathStats.ino !== after.ino
    ) {
      throw new Error('Worktree session marker identity changed');
    }
    // Publish with a hard link so the marker path first exists once its inode
    // already holds the owner and is fsync'd. Creating the marker path itself
    // with O_EXCL and filling it afterwards leaves a crash window holding a
    // 0-byte marker, which strict reads report as `invalid` — the one state no
    // recovery path repairs. `link` fails EEXIST when the marker path is
    // taken, so it is the same compare-and-swap O_EXCL was: a concurrent
    // create still loses instead of overwriting.
    await fs.link(stagedPath, markerPath);
  } catch (error) {
    await handle.close().catch(() => {});
    // Remove only the file this call created: on the identity-changed branch
    // the path already refers to someone else's inode, and unlinking it would
    // turn a fail-closed detection into a destructive action against the
    // detected file. Without a captured identity there is nothing to match,
    // so the rare residue is left for operator cleanup instead. This catch is
    // reachable only before the publish, so the marker path is never unlinked.
    if (stagedIno !== 0) {
      try {
        const current = await fs.lstat(stagedPath);
        if (current.dev === stagedDev && current.ino === stagedIno) {
          await fs.unlink(stagedPath);
        }
      } catch {
        // Path already gone — nothing of ours to remove.
      }
    }
    throw error;
  }
  // Post-commit tail: the marker already names `sessionId`, so a failure here
  // must propagate with the marker intact rather than trigger cleanup of a
  // valid file. Classified so a caller that compensates on failure cannot read
  // the committed flip as a pre-flip error and dismantle what the marker now
  // names. Dropping the staged name belongs to the commit — until it lands the
  // marker carries nlink 2 and strict reads reject it.
  try {
    await fs.unlink(stagedPath);
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    throw new WorktreeMarkerCommittedError(sessionId, { cause: error });
  }
  await ensureWorktreeSessionMarkerExcluded(worktreePath);
}

function assertValidWorktreeSessionMarkerOwner(sessionId: string): void {
  if (
    sessionId.length === 0 ||
    Buffer.byteLength(sessionId, 'utf8') > WORKTREE_SESSION_MARKER_MAX_BYTES ||
    sessionId.trim() !== sessionId
  ) {
    throw new Error('Invalid worktree session marker owner');
  }
}

/** Strict daemon-only marker read that never collapses corruption into absence. */
export async function readWorktreeSessionMarkerStrict(
  worktreePath: string,
): Promise<StrictWorktreeSessionMarker> {
  const markerPath = path.join(worktreePath, WORKTREE_SESSION_FILE);
  let handle: fs.FileHandle | undefined;
  let observedMarker = false;
  try {
    const flags =
      fsConstants.O_RDONLY |
      (fsConstants.O_NOFOLLOW ?? 0) |
      (fsConstants.O_NONBLOCK ?? 0);
    const before = await fs.lstat(markerPath);
    observedMarker = true;
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
      return { state: 'invalid', reason: 'unsafe marker file type' };
    }
    if (before.ino === 0 || before.size > WORKTREE_SESSION_MARKER_MAX_BYTES) {
      return { state: 'invalid', reason: 'unsafe marker size or identity' };
    }
    handle = await fs.open(markerPath, flags);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      return {
        state: 'invalid',
        reason: 'marker identity changed before read',
      };
    }
    const markerBuffer = Buffer.alloc(WORKTREE_SESSION_MARKER_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < markerBuffer.length) {
      const chunk = await handle.read(
        markerBuffer,
        bytesRead,
        markerBuffer.length - bytesRead,
        bytesRead,
      );
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > WORKTREE_SESSION_MARKER_MAX_BYTES) {
      return { state: 'invalid', reason: 'unsafe marker size or identity' };
    }
    const raw = markerBuffer.subarray(0, bytesRead).toString('utf8');
    const after = await handle.stat();
    const pathStats = await fs.lstat(markerPath);
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      after.size !== bytesRead ||
      after.size > WORKTREE_SESSION_MARKER_MAX_BYTES ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      !pathStats.isFile() ||
      pathStats.nlink !== 1 ||
      pathStats.dev !== after.dev ||
      pathStats.ino !== after.ino
    ) {
      return {
        state: 'invalid',
        reason: 'marker identity changed during read',
      };
    }
    const sessionId = raw.trim();
    if (
      sessionId.length === 0 ||
      sessionId !== raw ||
      Buffer.byteLength(sessionId, 'utf8') > WORKTREE_SESSION_MARKER_MAX_BYTES
    ) {
      return { state: 'invalid', reason: 'invalid marker owner' };
    }
    return {
      state: 'valid',
      sessionId,
      uid: process.geteuid === undefined ? null : after.uid,
      dev: after.dev,
      ino: after.ino,
    };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return observedMarker
        ? { state: 'invalid', reason: 'marker disappeared during read' }
        : { state: 'missing' };
    }
    return {
      state: 'invalid',
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Writes the owning session id into the worktree's session marker. */
export async function writeWorktreeSessionMarker(
  worktreePath: string,
  sessionId: string,
): Promise<void> {
  assertValidWorktreeSessionMarkerOwner(sessionId);
  const marker = await readWorktreeSessionMarkerStrict(worktreePath);
  if (marker.state === 'valid' && marker.sessionId === sessionId) {
    await ensureWorktreeSessionMarkerExcluded(worktreePath);
    return;
  }
  if (marker.state === 'valid') {
    throw new WorktreeSessionMarkerOwnerChangedError();
  }
  if (marker.state === 'missing') {
    await createWorktreeSessionMarker(worktreePath, sessionId);
    return;
  }
  if (marker.reason !== 'invalid marker owner') {
    throw new Error(`Worktree marker is invalid: ${marker.reason}`);
  }

  const markerPath = path.join(worktreePath, WORKTREE_SESSION_FILE);
  const before = await fs.lstat(markerPath);
  const confirmed = await readWorktreeSessionMarkerStrict(worktreePath);
  const confirmedStat = await fs.lstat(markerPath);
  if (
    !before.isFile() ||
    before.nlink !== 1 ||
    before.ino === 0 ||
    before.size > WORKTREE_SESSION_MARKER_MAX_BYTES ||
    confirmed.state !== 'invalid' ||
    confirmed.reason !== 'invalid marker owner' ||
    confirmedStat.dev !== before.dev ||
    confirmedStat.ino !== before.ino
  ) {
    throw new WorktreeSessionMarkerOwnerChangedError();
  }
  const euid = process.geteuid?.();
  if (euid !== undefined && confirmedStat.uid !== euid) {
    throw new Error('Worktree marker is owned by a different uid');
  }
  await atomicWriteFile(markerPath, sessionId, {
    mode: 0o600,
    noFollow: true,
    assertCanCommit: () => {
      const current = readWorktreeSessionMarkerStrictSync(worktreePath);
      const currentStat = nodeFs.lstatSync(markerPath);
      if (
        current.state !== 'invalid' ||
        current.reason !== 'invalid marker owner' ||
        !currentStat.isFile() ||
        currentStat.nlink !== 1 ||
        currentStat.dev !== confirmedStat.dev ||
        currentStat.ino !== confirmedStat.ino ||
        currentStat.uid !== confirmedStat.uid
      ) {
        throw new WorktreeSessionMarkerOwnerChangedError();
      }
    },
  });
  await ensureWorktreeSessionMarkerExcluded(worktreePath);
}

async function readBoundedMarker(
  handle: fs.FileHandle,
): Promise<string | null> {
  // Looped bounded read: POSIX permits short reads on regular files
  // (FUSE/NFS), and a marker larger than the owner bound still reads as
  // *present* — its bounded content can never equal a validated owner id
  // (writers cap owners at WORKTREE_SESSION_MARKER_MAX_BYTES), so it fails
  // closed as a foreign owner instead of collapsing into "no marker" for
  // exit_worktree's removal guard. Only an empty marker reads as absent.
  const buffer = Buffer.alloc(WORKTREE_SESSION_MARKER_MAX_BYTES + 1);
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    const chunk = await handle.read(
      buffer,
      bytesRead,
      buffer.length - bytesRead,
      bytesRead,
    );
    if (chunk.bytesRead === 0) break;
    bytesRead += chunk.bytesRead;
  }
  return buffer.subarray(0, bytesRead).toString('utf8').trim() || null;
}

/** Creates a fresh marker without following or replacing an existing path. */
export async function createWorktreeSessionMarker(
  worktreePath: string,
  sessionId: string,
): Promise<void> {
  await createWorktreeSessionMarkerExclusive(worktreePath, sessionId);
}

/** Replaces a marker only when its current regular-file owner still matches. */
export async function replaceWorktreeSessionMarker(
  worktreePath: string,
  expectedOwner: string,
  sessionId: string,
): Promise<void> {
  await transferWorktreeSessionMarkerOwner(
    worktreePath,
    expectedOwner,
    sessionId,
  );
}

/**
 * Synchronous twin of {@link readWorktreeSessionMarkerStrict}. Exists for the
 * `atomicWriteFile` assertCanCommit hook, which must re-verify the marker
 * synchronously in the same tick as the rename commit.
 */
export function readWorktreeSessionMarkerStrictSync(
  worktreePath: string,
): StrictWorktreeSessionMarker {
  const markerPath = path.join(worktreePath, WORKTREE_SESSION_FILE);
  let fd: number | undefined;
  let observedMarker = false;
  try {
    const flags =
      nodeFs.constants.O_RDONLY |
      (nodeFs.constants.O_NOFOLLOW ?? 0) |
      (nodeFs.constants.O_NONBLOCK ?? 0);
    const before = nodeFs.lstatSync(markerPath);
    observedMarker = true;
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
      return { state: 'invalid', reason: 'unsafe marker file type' };
    }
    if (before.ino === 0 || before.size > WORKTREE_SESSION_MARKER_MAX_BYTES) {
      return { state: 'invalid', reason: 'unsafe marker size or identity' };
    }
    fd = nodeFs.openSync(markerPath, flags);
    const opened = nodeFs.fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      return {
        state: 'invalid',
        reason: 'marker identity changed before read',
      };
    }
    const markerBuffer = Buffer.alloc(WORKTREE_SESSION_MARKER_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < markerBuffer.length) {
      const chunk = nodeFs.readSync(
        fd,
        markerBuffer,
        bytesRead,
        markerBuffer.length - bytesRead,
        bytesRead,
      );
      if (chunk === 0) break;
      bytesRead += chunk;
    }
    if (bytesRead > WORKTREE_SESSION_MARKER_MAX_BYTES) {
      return { state: 'invalid', reason: 'unsafe marker size or identity' };
    }
    const raw = markerBuffer.subarray(0, bytesRead).toString('utf8');
    const after = nodeFs.fstatSync(fd);
    const pathStats = nodeFs.lstatSync(markerPath);
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      after.size !== bytesRead ||
      after.size > WORKTREE_SESSION_MARKER_MAX_BYTES ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      !pathStats.isFile() ||
      pathStats.nlink !== 1 ||
      pathStats.dev !== after.dev ||
      pathStats.ino !== after.ino
    ) {
      return {
        state: 'invalid',
        reason: 'marker identity changed during read',
      };
    }
    const sessionId = raw.trim();
    if (
      sessionId.length === 0 ||
      sessionId !== raw ||
      Buffer.byteLength(sessionId, 'utf8') > WORKTREE_SESSION_MARKER_MAX_BYTES
    ) {
      return { state: 'invalid', reason: 'invalid marker owner' };
    }
    return {
      state: 'valid',
      sessionId,
      uid: process.geteuid === undefined ? null : after.uid,
      dev: after.dev,
      ino: after.ino,
    };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return observedMarker
        ? { state: 'invalid', reason: 'marker disappeared during read' }
        : { state: 'missing' };
    }
    return {
      state: 'invalid',
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (fd !== undefined) {
      try {
        nodeFs.closeSync(fd);
      } catch {
        // Best-effort close; the read result above stands.
      }
    }
  }
}

/**
 * Transfer the worktree marker's ownership to a replacement session.
 *
 * `expectedOwner` is the session id the opening strict read must find, or
 * `null` for the missing-marker hatch (caller already proved the sidecar
 * valid; the marker is re-created by linking a fully staged file into the
 * path, which fails when a concurrently created marker already occupies it
 * instead of overwriting it).
 *
 * An owned marker is rewritten through `atomicWriteFile` (sibling temp +
 * fsync + rename) with an `assertCanCommit` hook that re-reads the marker
 * synchronously and compares owner, dev/ino, and uid against the opening
 * read — a marker swapped between the read and the commit aborts the write.
 * Where uid identity is available, a foreign-owned marker is refused outright
 * rather than rewritten through the ownership-preserving in-place path.
 *
 * The missing-marker hatch delegates to
 * {@link createWorktreeSessionMarkerExclusive}, so a failure after that
 * create committed surfaces as {@link WorktreeMarkerCommittedError}: the
 * marker already names `newOwner` and must not be compensated backwards.
 */
export async function transferWorktreeSessionMarkerOwner(
  worktreePath: string,
  expectedOwner: string | null,
  newOwner: string,
): Promise<void> {
  assertValidWorktreeSessionMarkerOwner(newOwner);
  if (expectedOwner !== null) {
    assertValidWorktreeSessionMarkerOwner(expectedOwner);
    if (expectedOwner === newOwner) {
      throw new Error('Worktree marker transfer needs a distinct new owner');
    }
  }
  const opening = await readWorktreeSessionMarkerStrict(worktreePath);
  if (opening.state === 'invalid') {
    throw new Error(`Worktree marker is invalid: ${opening.reason}`);
  }
  if (opening.state === 'missing') {
    if (expectedOwner !== null) {
      throw new WorktreeSessionMarkerOwnerChangedError();
    }
    await createWorktreeSessionMarkerExclusive(worktreePath, newOwner);
    return;
  }
  if (opening.sessionId !== expectedOwner) {
    throw new WorktreeSessionMarkerOwnerChangedError();
  }
  const euid = process.geteuid?.();
  if (euid !== undefined && opening.uid !== null && opening.uid !== euid) {
    throw new Error('Worktree marker is owned by a different uid');
  }
  const markerPath = path.join(worktreePath, WORKTREE_SESSION_FILE);
  await atomicWriteFile(markerPath, newOwner, {
    mode: 0o600,
    noFollow: true,
    assertCanCommit: () => {
      const current = readWorktreeSessionMarkerStrictSync(worktreePath);
      if (
        current.state !== 'valid' ||
        current.sessionId !== opening.sessionId ||
        current.dev !== opening.dev ||
        current.ino !== opening.ino ||
        current.uid !== opening.uid
      ) {
        throw new WorktreeSessionMarkerOwnerChangedError();
      }
    },
  });
  await ensureWorktreeSessionMarkerExcluded(worktreePath);
}

/**
 * Three-way outcome of the lenient marker read. Guards that DELETE on
 * absence (exit_worktree) must distinguish "no marker" from "present but
 * not read conclusively" (the inode changed mid-read, or the read failed):
 * collapsing the latter into absence would turn a detected ownership swap
 * into "no marker — allow removal". Callers that only badge or compare
 * owners keep using {@link readWorktreeSessionMarker}, which maps both
 * non-owned states to `null`.
 */
export type WorktreeSessionMarkerOutcome =
  | { state: 'missing' }
  | { state: 'owned'; sessionId: string }
  | { state: 'inconclusive' };

/**
 * Lenient marker read reporting the full three-way outcome. See
 * {@link readWorktreeSessionMarker} for the collapsing variant.
 */
export async function readWorktreeSessionMarkerOutcome(
  worktreePath: string,
): Promise<WorktreeSessionMarkerOutcome> {
  const markerPath = path.join(worktreePath, WORKTREE_SESSION_FILE);
  let handle: fs.FileHandle | undefined;
  try {
    // Deliberately no nlink check (unlike the strict reader):
    // createWorktreeSessionMarkerExclusive publishes by linking the staged
    // sibling onto the marker path and only then unlinking the sibling, so
    // the marker sits at nlink 2 inside every publish window and permanently
    // after a crash — with complete, fsync'd content. exit_worktree treats a
    // missing marker as "no owner; allow removal", so that residue must
    // still read as owned. Reading through a hard link is harmless; writing
    // through one is not, and the strict readers gating writes keep the
    // nlink rejection.
    const pathStat = await fs.lstat(markerPath);
    if (!pathStat.isFile()) return { state: 'inconclusive' };
    handle = await fs.open(
      markerPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.dev !== pathStat.dev ||
      openedStat.ino !== pathStat.ino
    ) {
      return { state: 'inconclusive' };
    }
    const raw = await readBoundedMarker(handle);
    const finalStat = await fs.lstat(markerPath);
    if (
      !finalStat.isFile() ||
      finalStat.dev !== openedStat.dev ||
      finalStat.ino !== openedStat.ino
    ) {
      return { state: 'inconclusive' };
    }
    return raw === null
      ? { state: 'missing' }
      : { state: 'owned', sessionId: raw };
  } catch (error) {
    // Distinguish "marker missing" (legitimate — worktree predates the
    // session-ownership guard) from "marker unreadable" (disk error,
    // permission, corrupt NFS). The unreadable case logs so an operator
    // chasing a "wrong session bypassed the ownership guard" report has a
    // breadcrumb, and reports inconclusive so deleting guards fail closed.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      debugLogger.warn(
        `readWorktreeSessionMarker: cannot read ${markerPath}: ${error}`,
      );
      return { state: 'inconclusive' };
    }
    return { state: 'missing' };
  } finally {
    await handle?.close();
  }
}

/**
 * Reads the owning session id stored at worktree provisioning time.
 * Returns `null` when the marker is missing, empty, or cannot be read
 * conclusively — callers decide whether to treat that as "owner unknown,
 * refuse" or "owner unknown, allow with explicit override". Guards that
 * delete on `null` must use {@link readWorktreeSessionMarkerOutcome}
 * instead so a mid-read identity change fails closed.
 */
export async function readWorktreeSessionMarker(
  worktreePath: string,
): Promise<string | null> {
  const outcome = await readWorktreeSessionMarkerOutcome(worktreePath);
  return outcome.state === 'owned' ? outcome.sessionId : null;
}

/**
 * Commit message used for the baseline snapshot in worktrees.
 * After overlaying the user's dirty state (tracked changes + untracked files),
 * a commit with this message is created so that later diffs only capture the
 * agent's changes — not the pre-existing local edits.
 */
export const BASELINE_COMMIT_MESSAGE = 'baseline (dirty state overlay)';

/**
 * Default directory and branch-prefix name used for worktrees.
 * Changing this value affects the on-disk layout (`~/.qwen/<WORKTREES_DIR>/`)
 * **and** the default git branch prefix (`<WORKTREES_DIR>/<sessionId>/…`).
 */
export const WORKTREES_DIR = 'worktrees';

// ──────────────────────────────────────────────────────────────────────
// Ephemeral agent-worktree slug format. Shared between the producer
// (`AgentTool isolation: 'worktree'`), the consumer
// (`cleanupStaleAgentWorktrees`) and the validator
// (`validateUserWorktreeSlug` reserves the prefix). Changing any of
// these constants must be done in one place so a regex / generator
// mismatch can never silently leak or destroy work.
// ──────────────────────────────────────────────────────────────────────

/** Slug prefix used for worktrees created by `AgentTool isolation:'worktree'`. */
export const AGENT_WORKTREE_PREFIX = 'agent';

/** Number of random hex characters appended after the prefix. */
export const AGENT_WORKTREE_HEX_LENGTH = 7;

/** Regex that matches the exact ephemeral-agent slug shape. */
export const AGENT_WORKTREE_SLUG_PATTERN = new RegExp(
  `^${AGENT_WORKTREE_PREFIX}-[0-9a-f]{${AGENT_WORKTREE_HEX_LENGTH}}$`,
);

/**
 * Generates a fresh ephemeral-agent slug. Centralised so the format
 * stays in lock-step with {@link AGENT_WORKTREE_SLUG_PATTERN}.
 */
export function generateAgentWorktreeSlug(): string {
  const hex = randomBytes(Math.ceil(AGENT_WORKTREE_HEX_LENGTH / 2))
    .toString('hex')
    .slice(0, AGENT_WORKTREE_HEX_LENGTH);
  return `${AGENT_WORKTREE_PREFIX}-${hex}`;
}

/**
 * Attribute lines a `git worktree list --porcelain` record can carry after
 * its `worktree <path>` line. Anything else on those lines means the path
 * above contained a newline and the entry was truncated.
 */
function isWorktreeListPorcelainAttribute(line: string): boolean {
  return (
    line === 'bare' ||
    line === 'detached' ||
    line === 'locked' ||
    line === 'prunable' ||
    line.startsWith('HEAD ') ||
    line.startsWith('branch ') ||
    line.startsWith('locked ') ||
    line.startsWith('prunable ')
  );
}

export interface WorktreeInfo {
  /** Unique identifier for this worktree */
  id: string;
  /** Display name (e.g., model name) */
  name: string;
  /** Absolute path to the worktree directory */
  path: string;
  /** Git branch name for this worktree */
  branch: string;
  /** Whether the worktree is currently active */
  isActive: boolean;
  /** Creation timestamp */
  createdAt: number;
}

export interface WorktreeSetupConfig {
  /** Session identifier */
  sessionId: string;
  /** Source repository path (project root) */
  sourceRepoPath: string;
  /** Names/identifiers for each worktree to create */
  worktreeNames: string[];
  /** Base branch to create worktrees from (defaults to current branch) */
  baseBranch?: string;
  /** Extra metadata to persist alongside the session config */
  metadata?: Record<string, unknown>;
}

export interface CreateWorktreeResult {
  success: boolean;
  worktree?: WorktreeInfo;
  error?: string;
  /**
   * Machine-readable refusal code for a failed creation, when the cause is
   * a state the caller can surface distinctly (e.g.
   * `worktree_merge_in_progress` for an unmerged index). Absent for generic
   * failures, which callers map to a server fault.
   */
  code?: string;
  /**
   * Repo-relative paths the dirty carry applied (tracked + untracked),
   * present when carryDirtyState was requested. A prepared-worktree
   * rollback exempts exactly these from its cleanliness gate.
   */
  carriedPaths?: string[];
  /**
   * The same overlay with carry-time content identities, for the
   * managed-session sidecar. The orphan reaper's gate waives a carried path
   * only while its current state still matches its identity, so a session
   * that stages, deletes, or further edits a carried file is snapshotted
   * rather than deleted (R9-6). Absent when the carry applied nothing or its
   * identities could not be computed — the gate then treats the overlay as
   * work, the conservative direction.
   */
  carriedEntries?: CarriedEntry[];
}

export interface WorktreeSetupResult {
  success: boolean;
  sessionId: string;
  worktrees: WorktreeInfo[];
  worktreesByName: Record<string, WorktreeInfo>;
  errors: Array<{ name: string; error: string }>;
}

/**
 * Minimal session config file written to disk.
 * Callers can extend via the `metadata` field in WorktreeSetupConfig.
 */
interface SessionConfigFile {
  sessionId: string;
  sourceRepoPath: string;
  worktreeNames: string[];
  baseBranch?: string;
  createdAt: number;
  [key: string]: unknown;
}

/**
 * Service for managing git worktrees.
 *
 * Git worktrees allow multiple working directories to share a single repository,
 * enabling isolated environments without copying the entire repo.
 */
export class GitWorktreeService {
  private sourceRepoPath: string;
  private gitPromise: Promise<SimpleGit> | undefined;
  private readonly customBaseDir?: string;

  constructor(sourceRepoPath: string, customBaseDir?: string) {
    this.sourceRepoPath = path.resolve(sourceRepoPath);
    this.customBaseDir = customBaseDir;
  }

  private getGit(): Promise<SimpleGit> {
    this.gitPromise ??= loadSimpleGit().then(({ simpleGit }) =>
      simpleGit(this.sourceRepoPath).env(gitEnv()),
    );
    return this.gitPromise;
  }

  /**
   * Gets the directory where worktrees are stored.
   * @param customDir - Optional custom base directory override
   */
  static getBaseDir(customDir?: string): string {
    if (customDir) {
      return path.resolve(customDir);
    }
    return path.join(Storage.getGlobalQwenDir(), WORKTREES_DIR);
  }

  /**
   * Gets the directory for a specific session.
   * @param customBaseDir - Optional custom base directory override
   */
  static getSessionDir(sessionId: string, customBaseDir?: string): string {
    return path.join(GitWorktreeService.getBaseDir(customBaseDir), sessionId);
  }

  /**
   * Gets the worktrees directory for a specific session.
   * @param customBaseDir - Optional custom base directory override
   */
  static getWorktreesDir(sessionId: string, customBaseDir?: string): string {
    return path.join(
      GitWorktreeService.getSessionDir(sessionId, customBaseDir),
      WORKTREES_DIR,
    );
  }

  /**
   * Instance-level base dir, using the custom dir if provided at construction.
   */
  getBaseDirForInstance(): string {
    return GitWorktreeService.getBaseDir(this.customBaseDir);
  }

  /**
   * Checks if git is available on the system.
   */
  async checkGitAvailable(): Promise<{ available: boolean; error?: string }> {
    const { available } = isCommandAvailable('git');
    if (!available) {
      return {
        available: false,
        error: 'Git is not installed. Please install Git.',
      };
    }
    return { available: true };
  }

  /**
   * Resolves the absolute path of the enclosing git repository's top
   * directory. Used by callers that need to anchor general-purpose
   * worktrees at the *repo* root rather than the cwd they were invoked
   * from — otherwise running `qwen` from a monorepo subdirectory would
   * scatter `.qwen/worktrees/` under each subdirectory instead of
   * gathering them under the repo root.
   *
   * Returns the canonical top-level path on success, or `null` when the
   * cwd is not inside a git repo (caller should error).
   */
  async getRepoTopLevel(): Promise<string | null> {
    try {
      // `raw` rather than `revparse`: the latter trims the output, silently
      // mutating a path that legitimately carries leading/trailing whitespace
      // into a different anchor. Strip only the LF terminator — git's stdout
      // is LF-terminated on every platform, so a trailing CR is path data,
      // not part of the terminator.
      const out = await (
        await this.getGit()
      ).raw(['rev-parse', '--show-toplevel']);
      const top = out.replace(/\n$/, '');
      return top.length > 0 ? top : null;
    } catch (error) {
      // Caller falls back to its cwd via `?? cwd`. Log so a corrupt
      // repo / permission failure leaves a trail — otherwise the
      // worktree creator and startup sweep can disagree silently about
      // where worktrees live, and the sweep would never find them.
      debugLogger.warn(
        `getRepoTopLevel failed at ${this.sourceRepoPath}: ${error}`,
      );
      return null;
    }
  }

  /**
   * Returns the repository's primary working tree path, or `null` when it
   * cannot be determined. Unlike `getRepoTopLevel()` — which answers
   * "which worktree is this cwd in" and so names a linked worktree's OWN
   * root when run inside one — this always resolves the MAIN tree:
   * `git worktree list --porcelain` lists the primary working tree first
   * regardless of where in the repository it runs. Callers anchoring a
   * check at the repository itself (not the current worktree) use this.
   *
   * The porcelain format is newline-delimited, so a main-tree path that
   * itself contains a newline splits across lines and the first entry
   * truncates. The remainder then appears where a record attribute belongs
   * — it is not one, which detects most truncations. Not all: a remainder
   * that is itself attribute-shaped (`detached`, `HEAD …`, …) — or a path
   * ending right at a newline, whose blank remainder ends the record — still
   * parses. The parsed anchor is therefore round-trip-validated below:
   * `rev-parse --git-common-dir` run AT the anchor must agree with this
   * repository's own common dir, otherwise this method returns `null` and
   * callers fall back to `getRepoTopLevel()`, whose single-value
   * `--show-toplevel` answer keeps interior newlines intact. (`--porcelain
   * -z` would be immune but needs Git >= 2.36.) A truncated anchor is not
   * merely wrong: it can resolve inside a DIFFERENT repository whose
   * worktree registry the caller's gate would then consult.
   */
  async getMainWorktreePath(): Promise<string | null> {
    try {
      const out = await (
        await this.getGit()
      ).raw(['worktree', 'list', '--porcelain']);
      const lines = out.split('\n');
      // git preserves a path's leading/trailing whitespace verbatim, and a
      // trim would silently mutate it into a different, wrong anchor. A
      // trailing CR is path data, not a terminator: git's stdout is
      // LF-terminated on every platform.
      const firstLine = lines[0] ?? '';
      if (!firstLine.startsWith('worktree ')) return null;
      for (const line of lines.slice(1)) {
        const attr = line.trim();
        if (attr === '') break; // blank line ends the first record
        if (!isWorktreeListPorcelainAttribute(attr)) return null;
      }
      const mainPath = firstLine.slice('worktree '.length);
      if (mainPath.length === 0) return null;
      // Round-trip validation (see the doc block): `--git-common-dir` answers
      // `.git` (relative) from a main tree and an absolute path from a linked
      // worktree, so resolve both sides. realpath both so a symlinked
      // ancestor on either side (macOS /tmp -> /private/tmp) cannot
      // manufacture a mismatch. A probe failure at the anchor fails closed.
      const realpathOr = async (p: string): Promise<string> => {
        try {
          return await fs.realpath(p);
        } catch {
          return p;
        }
      };
      const { simpleGit } = await loadSimpleGit();
      const [ourRaw, anchorRaw] = await Promise.all([
        (await this.getGit()).raw(['rev-parse', '--git-common-dir']),
        simpleGit(mainPath).raw(['rev-parse', '--git-common-dir']),
      ]);
      const ourCommonDir = await realpathOr(
        path.resolve(this.sourceRepoPath, ourRaw.trim()),
      );
      const anchorCommonDir = await realpathOr(
        path.resolve(mainPath, anchorRaw.trim()),
      );
      return ourCommonDir === anchorCommonDir ? mainPath : null;
    } catch (error) {
      debugLogger.warn(
        `getMainWorktreePath failed at ${this.sourceRepoPath}: ${error}`,
      );
      return null;
    }
  }

  /**
   * Checks if the source path is a git repository.
   */
  async isGitRepository(): Promise<boolean> {
    try {
      const [git, { CheckRepoActions }] = await Promise.all([
        this.getGit(),
        loadSimpleGit(),
      ]);
      try {
        const isRoot = await git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT);
        if (isRoot) {
          return true;
        }
      } catch {
        // IS_REPO_ROOT check failed — fall through to the general check
      }
      // Not the root (or root check threw) — check if we're inside a git repo
      try {
        return await git.checkIsRepo();
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  }

  /**
   * Initializes the source directory as a git repository.
   * Returns true if initialization was performed, false if already a repo.
   */
  async initializeRepository(): Promise<{
    initialized: boolean;
    error?: string;
  }> {
    const isRepo = await this.isGitRepository();
    if (isRepo) {
      return { initialized: false };
    }

    try {
      const git = await this.getGit();
      await initRepositoryWithMainBranch(git);

      // Create initial commit so we can create worktrees
      await git.add('.');
      await git.commit('Initial commit', {
        '--allow-empty': null,
      });

      return { initialized: true };
    } catch (error) {
      return {
        initialized: false,
        error: `Failed to initialize git repository: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Gets the current branch name.
   */
  async getCurrentBranch(): Promise<string> {
    const branch = await (
      await this.getGit()
    ).revparse(['--abbrev-ref', 'HEAD']);
    return branch.trim();
  }

  /**
   * Gets the current commit hash.
   */
  async getCurrentCommitHash(): Promise<string> {
    const hash = await (await this.getGit()).revparse(['HEAD']);
    return hash.trim();
  }

  /**
   * Resolves a git ref name to a 40-char commit SHA. Returns `null` when
   * the ref is unknown / unborn / not a commit.
   *
   * Used by Phase D-3 to lock in `FETCH_HEAD` immediately after
   * `fetchPullRequestRef` succeeds, so the SHA passed to
   * `git worktree add` is immutable against a concurrent `git fetch` from
   * another process sharing the same repo, AND so `WorktreeExitDialog`'s
   * `rev-list <originalHeadCommit>..HEAD` counts only THIS session's new
   * work rather than every commit in the fetched PR.
   */
  async resolveRef(ref: string): Promise<string | null> {
    try {
      const out = (
        await (await this.getGit()).raw(['rev-parse', '--verify', ref])
      ).trim();
      return /^[0-9a-f]{40}$/.test(out) ? out : null;
    } catch {
      return null;
    }
  }

  /**
   * Creates a single worktree.
   */
  async createWorktree(
    sessionId: string,
    name: string,
    baseBranch?: string,
  ): Promise<CreateWorktreeResult> {
    try {
      const worktreesDir = GitWorktreeService.getWorktreesDir(
        sessionId,
        this.customBaseDir,
      );
      await fs.mkdir(worktreesDir, { recursive: true });

      // Sanitize name for use as branch and directory name
      const sanitizedName = this.sanitizeName(name);
      const worktreePath = path.join(worktreesDir, sanitizedName);

      // Check if worktree already exists
      const exists = await this.pathExists(worktreePath);
      if (exists) {
        return {
          success: false,
          error: `Worktree already exists at ${worktreePath}`,
        };
      }

      // Determine base branch
      const base = baseBranch || (await this.getCurrentBranch());
      const shortSession = sessionId.slice(0, 6);
      const branchName = `${base}-${shortSession}-${sanitizedName}`;

      // Create the worktree with a new branch
      await (
        await this.getGit()
      ).raw(['worktree', 'add', '-b', branchName, worktreePath, base]);

      const worktree: WorktreeInfo = {
        id: `${sessionId}/${sanitizedName}`,
        name,
        path: worktreePath,
        branch: branchName,
        isActive: true,
        createdAt: Date.now(),
      };

      return { success: true, worktree };
    } catch (error) {
      return {
        success: false,
        error: `Failed to create worktree for "${name}": ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Snapshot the source checkout's uncommitted state without modifying its
   * working tree or index: `git stash create` for tracked changes (staged +
   * unstaged) plus the untracked file list. The untracked probe fails open
   * (a capture problem degrades to committed-state-only worktrees), but a
   * `stash create` FAILURE is reported via `captureError` rather than
   * swallowed: a caller that relocates a session onto this overlay
   * (`createUserWorktree({ carryDirtyState })`) must refuse rather than
   * present an empty carry as complete. `captureError` is null when the
   * stash succeeded or there was simply nothing to stash (a clean tree).
   */
  private async captureDirtyState(): Promise<{
    stashCommit: string;
    untrackedFiles: string[];
    trackedFiles: string[];
    removedPaths: string[];
    repoTop: string;
    captureError: string | null;
    unmergedIndex: boolean;
  }> {
    // NOTE: `git stash create` does NOT support --include-untracked;
    // untracked files are handled separately via file copy.
    let stashCommit = '';
    let captureError: string | null = null;
    let unmergedIndex = false;
    try {
      // Judge `stash create` by its real exit status, not stderr presence:
      // some git builds (e.g. 2.39.5 with a held index.lock) exit non-zero
      // writing NOTHING to either stream, which simple-git's default
      // detection resolves as an empty "nothing to carry" (R8-6). A dedicated
      // instance with exit-code detection surfaces that silent failure so a
      // carry-requesting caller refuses instead of silently dropping the
      // tracked overlay. It still calls `.stash(['create'])`, so the mocked
      // getGit().stash seam in the unit tests is unchanged.
      const { simpleGit } = await loadSimpleGit();
      const captureGit = simpleGit(this.sourceRepoPath, {
        errors: carryApplyErrorDetection,
      }).env(gitEnv());
      stashCommit = (await captureGit.stash(['create'])).trim();
    } catch (error) {
      // An environment failure (held index.lock, read-only git dir) is NOT
      // "nothing to carry": record it so a carry-requesting caller refuses
      // instead of moving the session without the user's tracked edits.
      captureError = error instanceof Error ? error.message : String(error);
      // `stash create` also fails on an unmerged index (an in-progress merge
      // or rebase). That is a state the user can clear, not a daemon fault:
      // distinguish it so a carry-requesting caller answers a readable 409
      // instead of a 500 (R12-1). ls-files reads the index without locking,
      // so it still answers when index.lock is held; a probe that cannot
      // answer leaves unmergedIndex false and keeps the hard refusal.
      const unmerged = await (await this.getGit())
        .raw(['ls-files', '-u'])
        .catch(() => '');
      unmergedIndex = unmerged.trim().length > 0;
    }
    // The tracked paths the stash carries, so a rollback can exempt
    // exactly the carried overlay from its cleanliness gate.
    let trackedFiles: string[] = [];
    if (stashCommit) {
      try {
        // --no-renames: a detected rename would collapse to its destination,
        // hiding the deletion side from the rollback's exemption set; the
        // applied overlay presents both sides (A new + D old), so the list
        // must name both.
        const raw = await (
          await this.getGit()
        ).raw([
          'stash',
          'show',
          '--name-only',
          '--no-renames',
          '-z',
          stashCommit,
        ]);
        trackedFiles = raw.split('\0').filter(Boolean);
      } catch {
        // Non-fatal: the rollback gate stays conservative.
      }
    }
    // The service may be rooted at a subdirectory of the repository;
    // --full-name keeps untracked paths repository-relative so the overlay
    // lands them at the same offset inside the worktree. When the repo top
    // cannot be resolved, skip the untracked overlay rather than pair
    // repo-relative paths with a subdirectory base (every copy would miss
    // and be swallowed); the tracked stash carry still applies.
    const repoTop = await this.getRepoTopLevel().catch(() => null);
    let untrackedFiles: string[] = [];
    let removedPaths: string[] = [];
    if (repoTop === null) {
      debugLogger.warn(
        'captureDirtyState: repository top unavailable; skipping untracked carry',
      );
    } else {
      untrackedFiles = await this.listUntrackedFiles(repoTop);
      removedPaths = await this.listDeletedToDirectory(repoTop);
    }
    return {
      stashCommit,
      untrackedFiles,
      trackedFiles,
      removedPaths,
      repoTop: repoTop ?? this.sourceRepoPath,
      captureError,
      unmergedIndex,
    };
  }

  /**
   * Repository-relative tracked paths deleted in the working tree whose
   * path is now a DIRECTORY (the user moved a file into a folder of the
   * same name). `git stash create` cannot represent this file→directory
   * replacement — the stash omits the deletion and `stash show --name-only`
   * names nothing — so the carry must remove the target's tracked file
   * explicitly or it resurrects the file and the untracked directory
   * content (which `listUntrackedFiles` does list) cannot land. Detected
   * from `git status --porcelain -z` deletion entries whose path lstats as
   * a directory; fail-open (an unreadable status yields no explicit removals).
   */
  private async listDeletedToDirectory(repoTop: string): Promise<string[]> {
    let raw: string;
    try {
      const { simpleGit } = await loadSimpleGit();
      raw = await simpleGit(repoTop)
        .env(gitEnv())
        .raw(['--no-optional-locks', 'status', '--porcelain', '-z']);
    } catch {
      return [];
    }
    const records = raw.split('\0');
    const removed: string[] = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i]!;
      // `XY <path>`: two status columns, a space, then the path.
      if (record.length < 4 || record[2] !== ' ') continue;
      // A rename/copy record is followed by a BARE paired-origin path
      // record (no status prefix). Skip it structurally: shape-guessing
      // from its characters misreads an origin like `aD sub` as a deleted
      // path `sub` and would delete an unrelated tracked file (R8-5).
      if (record[0] === 'R' || record[0] === 'C') {
        i++;
        continue;
      }
      if (record[0] !== 'D' && record[1] !== 'D') continue;
      const rel = record.slice(3);
      if (rel.length === 0) continue;
      const isDir = await fs
        .lstat(path.join(repoTop, rel))
        .then((st) => st.isDirectory())
        .catch(() => false);
      if (isDir) removed.push(rel);
    }
    return removed;
  }

  /**
   * Raw repository-relative untracked paths. `-z` emits NUL-terminated
   * records: without it git C-quotes non-ASCII (core.quotepath), quotes,
   * and newlines, and the quoted text would reach copyFile as a literal
   * name and be silently dropped. Never trim the records — leading and
   * trailing spaces are legal filename characters. Run at the repository
   * top, not the service root: from a subdirectory `ls-files --others`
   * lists only that subtree, while the tracked half of the overlay
   * (stash show) is repository-wide — the two halves must cover one set.
   */
  private async listUntrackedFiles(repoTop: string): Promise<string[]> {
    try {
      const { simpleGit } = await loadSimpleGit();
      const raw = await simpleGit(repoTop)
        .env(gitEnv())
        .raw([
          'ls-files',
          '--others',
          '--exclude-standard',
          '--full-name',
          '-z',
        ]);
      // Defense in depth: the daemon's own bookkeeping files are normally
      // git-excluded, but if the exclude rule is missing (an upgraded or
      // damaged checkout) they must not be carried as user content — a
      // marker copied into another checkout is daemon residue, not work.
      return raw
        .split('\0')
        .filter(
          (rel) =>
            rel.length > 0 &&
            rel !== WORKTREE_SESSION_FILE &&
            !WORKTREE_SESSION_TMP_PATTERN.test(rel),
        );
    } catch {
      return [];
    }
  }

  /**
   * Copy one overlay entry, preserving symlinks as links. `copyFile`
   * dereferences them: a link to a file would materialize out-of-repo
   * content into the checkout (which a later `git add -A` could commit),
   * and a link to a directory would fail EISDIR and vanish.
   */
  private async copyOverlayEntry(src: string, dst: string): Promise<void> {
    const stat = await fs.lstat(src);
    if (stat.isSymbolicLink()) {
      await fs.symlink(await fs.readlink(src), dst);
    } else {
      await fs.copyFile(src, dst);
    }
  }

  /**
   * Copy one overlay entry into the target checkout with destination
   * containment. Returns true only when the entry was CREATED. Skips (does
   * not throw) when the destination already exists — a pre-existing file
   * (e.g. a git-ignored secret the clean gate cannot see) must survive the
   * carry — or when an ancestor symlink would redirect the write outside
   * the target checkout (a committed `out -> <outside>` link): the deepest
   * existing ancestor's realpath is checked BEFORE mkdir (which follows
   * symlink ancestors), and the parent is re-verified after. Shared by both
   * untracked-copy paths so neither can write outside the checkout.
   */
  private async copyOverlayEntryContained(
    srcTop: string,
    targetTop: string,
    realTargetTop: string,
    rel: string,
  ): Promise<boolean> {
    const dst = path.join(targetTop, rel);
    const exists = await fs
      .lstat(dst)
      .then(() => true)
      .catch(() => false);
    if (exists) return false;
    const parent = path.dirname(dst);
    let ancestor = parent;
    while (
      !(await fs
        .lstat(ancestor)
        .then(() => true)
        .catch(() => false))
    ) {
      const up = path.dirname(ancestor);
      if (up === ancestor) break;
      ancestor = up;
    }
    if (
      !isWithinRoot(
        await fs.realpath(ancestor).catch(() => ancestor),
        realTargetTop,
      )
    ) {
      return false;
    }
    await fs.mkdir(parent, { recursive: true });
    if (
      !isWithinRoot(
        await fs.realpath(parent).catch(() => parent),
        realTargetTop,
      )
    ) {
      return false;
    }
    await this.copyOverlayEntry(path.join(srcTop, rel), dst);
    return true;
  }

  /**
   * Copy this checkout's untracked files into another checkout of the
   * same repository at the same repository-relative offset (the target
   * may be rooted at a subdirectory). Fail-open per file; a pre-existing
   * destination is never overwritten, and an entry whose destination would
   * escape the target checkout through an ancestor symlink is skipped.
   * Returns the paths actually CREATED so a caller can undo the overlay on
   * rollback without deleting files that were already there.
   */
  async carryUntrackedFilesTo(targetCwd: string): Promise<string[]> {
    const repoTop = await this.getRepoTopLevel().catch(() => null);
    if (repoTop === null) {
      debugLogger.warn(
        'carryUntrackedFilesTo: repository top unavailable; skipping',
      );
      return [];
    }
    const files = await this.listUntrackedFiles(repoTop);
    if (files.length === 0) return [];
    const targetTop =
      (await new GitWorktreeService(targetCwd)
        .getRepoTopLevel()
        .catch(() => null)) ?? targetCwd;
    const realTargetTop = await fs.realpath(targetTop).catch(() => targetTop);
    const copied: string[] = [];
    for (const rel of files) {
      try {
        // Only files this call CREATES are recorded for undo: the caller's
        // rollback removes the returned paths, and a pre-existing file must
        // survive the carry. Containment skips escaping ancestor symlinks.
        if (
          await this.copyOverlayEntryContained(
            repoTop,
            targetTop,
            realTargetTop,
            rel,
          )
        ) {
          copied.push(rel);
        }
      } catch {
        // Fail-open: skip files that can't be copied.
      }
    }
    return copied;
  }

  /**
   * Overlay a captured dirty state onto a worktree: apply the tracked
   * changes and copy untracked files. A tracked apply that conflicts or
   * fails for an environment reason restores the worktree to committed
   * state and throws WorktreeDirtyCarryConflictError, so creation is refused
   * rather than relocating the session without the user's work. The
   * untracked half is independent and is carried even when the tracked apply
   * failed, so a fail-open caller (setupWorktrees) still baselines the user's
   * untracked work on top of committed state; the per-file copy stays
   * fail-open and contained (no pre-existing overwrite, no ancestor-symlink
   * escape).
   */
  private async applyDirtyState(
    worktreePath: string,
    dirtyState: {
      stashCommit: string;
      untrackedFiles: string[];
      removedPaths: string[];
      repoTop: string;
    },
  ): Promise<string[]> {
    const { simpleGit } = await loadSimpleGit();
    const wtGit = simpleGit(worktreePath, {
      errors: carryApplyErrorDetection,
    }).env(gitEnv());
    let carryError: WorktreeDirtyCarryConflictError | null = null;
    if (dirtyState.stashCommit) {
      let applyError: unknown;
      try {
        await wtGit.raw(['stash', 'apply', dirtyState.stashCommit]);
      } catch (error) {
        applyError = error;
      }
      // A conflicting 3-way apply writes conflict markers and unmerged
      // index entries — simple-git's raw mode may RESOLVE even on the
      // non-zero exit, so detect by the index state, not the throw. ANY
      // failure (conflict or environment, e.g. an unwritable path that
      // leaves a partially applied overlay) must restore committed state:
      // a fail-open caller baselines whatever is on disk, so a half-applied
      // tracked overlay must never survive into the baseline.
      const unmerged = (
        await wtGit.raw(['ls-files', '-u']).catch(() => '')
      ).trim();
      if (unmerged.length > 0 || applyError) {
        // Do not swallow the restore's own failure: if reset/clean cannot
        // run (locked index, read-only git dir) the worktree keeps a
        // half-applied overlay, and the error must not claim it was restored
        // to committed state — a fail-open caller would baseline that tree.
        let restoreError: unknown;
        try {
          await wtGit.raw(['reset', '--hard', 'HEAD']);
          await wtGit.raw(['clean', '-fd']);
        } catch (error) {
          restoreError = error;
        }
        const restoreNote =
          restoreError !== undefined
            ? ` (restore to committed state also failed: ${
                restoreError instanceof Error
                  ? restoreError.message
                  : String(restoreError)
              })`
            : '';
        carryError = new WorktreeDirtyCarryConflictError(
          (unmerged.length > 0
            ? `Dirty carry conflicted with the worktree base: ${
                applyError instanceof Error
                  ? applyError.message
                  : 'merge conflict'
              }`
            : `Dirty carry failed to apply: ${
                applyError instanceof Error
                  ? applyError.message
                  : String(applyError)
              }`) + restoreNote,
          {
            conflict: unmerged.length > 0,
            restoreFailed: restoreError !== undefined,
          },
        );
      }
    }
    // The untracked half runs even when the tracked apply failed: the
    // reset/clean above restored tracked state, and the carried untracked
    // work is copied on top of it for fail-open callers. Containment and the
    // pre-existing-destination skip apply per file. Only paths actually
    // CREATED are returned, so the caller's carried-overlay record (and its
    // rollback exemption) never names a skipped entry.
    const realTargetTop = await fs
      .realpath(worktreePath)
      .catch(() => worktreePath);
    // A tracked file the source deleted into a directory cannot ride the
    // stash; remove the target's file so the untracked copy below can mkdir
    // the directory at the same path. Only on a clean tracked apply: a
    // conflict restored committed state, and a fail-open caller baselines
    // that committed state (the deletion is part of the conflicted overlay).
    const removed = carryError
      ? []
      : await this.removeOverlayFilesContained(
          worktreePath,
          realTargetTop,
          dirtyState.removedPaths,
        );
    const createdUntracked: string[] = [];
    for (const relPath of dirtyState.untrackedFiles) {
      try {
        if (
          await this.copyOverlayEntryContained(
            dirtyState.repoTop,
            worktreePath,
            realTargetTop,
            relPath,
          )
        ) {
          createdUntracked.push(relPath);
        }
      } catch {
        // Non-fatal: skip files that can't be copied.
      }
    }
    if (carryError) throw carryError;
    return [...removed, ...createdUntracked];
  }

  /**
   * Remove regular files at the given repo-relative paths under `targetTop`,
   * confined to the checkout (a pre-existing directory, a symlink, or an
   * ancestor symlink escaping the checkout is left alone). Fail-open per
   * file; returns only the paths actually removed. Shared by the
   * create-direction carry and the handoff's file→directory removal.
   */
  private async removeOverlayFilesContained(
    targetTop: string,
    realTargetTop: string,
    relPaths: string[],
  ): Promise<string[]> {
    const removed: string[] = [];
    for (const relPath of relPaths) {
      try {
        const dst = path.join(targetTop, relPath);
        const st = await fs.lstat(dst).catch(() => null);
        if (!st || !st.isFile()) continue;
        const parent = path.dirname(dst);
        if (
          !isWithinRoot(
            await fs.realpath(parent).catch(() => parent),
            realTargetTop,
          )
        ) {
          continue;
        }
        await fs.rm(dst);
        removed.push(relPath);
      } catch {
        // Fail-open: a removal that cannot land leaves the file, and the
        // untracked copy skips the entry as it would without the removal.
      }
    }
    return removed;
  }

  /**
   * Handoff (to=local) counterpart of the create-direction file→directory
   * carry (R11-10): the stash omits a tracked deletion whose path became a
   * directory, so without this the local checkout keeps the file and the
   * untracked carry's mkdir hits ENOTDIR and is skipped — the agent's new
   * file stays behind while the route answers 200. Captures the tracked
   * files THIS checkout deleted into directories and removes the matching
   * regular files from `targetCwd` (contained, file-only) before the
   * untracked carry. Returns the repo-relative paths actually removed.
   */
  async removeDeletedToDirectoryFiles(targetCwd: string): Promise<string[]> {
    const repoTop = await this.getRepoTopLevel().catch(() => null);
    if (repoTop === null) return [];
    const removedPaths = await this.listDeletedToDirectory(repoTop);
    if (removedPaths.length === 0) return [];
    const targetTop =
      (await new GitWorktreeService(targetCwd)
        .getRepoTopLevel()
        .catch(() => null)) ?? targetCwd;
    const realTargetTop = await fs.realpath(targetTop).catch(() => targetTop);
    // The stash cannot carry this deletion, so the 3-way apply never sees it
    // and cannot flag a conflict. Enforce the same rule here: if the target
    // file was modified locally (its blob differs from the version this
    // checkout is deleting), removing it would silently drop local work —
    // refuse as a conflict instead (the plain-deletion path answers 409).
    const { simpleGit } = await loadSimpleGit();
    const targetGit = simpleGit(targetTop).env(gitEnv());
    for (const relPath of removedPaths) {
      const dst = path.join(targetTop, relPath);
      const st = await fs.lstat(dst).catch(() => null);
      if (!st || !st.isFile()) continue;
      const srcBlob = await (await this.getGit())
        .revparse([`HEAD:${relPath}`])
        .catch(() => null);
      const dstBlob = await targetGit
        .raw(['hash-object', '--', dst])
        .catch(() => null);
      // Fail closed on every unverifiable shape: an unresolvable HEAD:path
      // (e.g. an AD record) or an unhashable local file (mode 000) must not
      // fall through to the removal — both skips used to leave the path in
      // removedPaths, deleting local work with no comparison (R11-4). Only
      // an exact blob match proves the local file is the version being
      // deleted and is safe to remove.
      if (
        srcBlob === null ||
        dstBlob === null ||
        dstBlob.trim() !== srcBlob.trim()
      ) {
        throw new WorktreeDirtyCarryConflictError(
          `The file-to-directory carry conflicts with local modifications to ${relPath}`,
          { conflict: true },
        );
      }
    }
    return this.removeOverlayFilesContained(
      targetTop,
      realTargetTop,
      removedPaths,
    );
  }

  /**
   * Sets up all worktrees for a session.
   * This is the main entry point for worktree creation.
   */
  async setupWorktrees(
    config: WorktreeSetupConfig,
  ): Promise<WorktreeSetupResult> {
    const result: WorktreeSetupResult = {
      success: false,
      sessionId: config.sessionId,
      worktrees: [],
      worktreesByName: {},
      errors: [],
    };

    // Validate worktree names early (before touching git)
    const sanitizedNames = new Map<string, string>();
    for (const name of config.worktreeNames) {
      const sanitized = this.sanitizeName(name);
      if (!sanitized) {
        result.errors.push({
          name,
          error: 'Worktree name becomes empty after sanitization',
        });
        continue;
      }
      const existing = sanitizedNames.get(sanitized);
      if (existing) {
        result.errors.push({
          name,
          error: `Worktree name collides with "${existing}" after sanitization`,
        });
        continue;
      }
      sanitizedNames.set(sanitized, name);
    }
    if (result.errors.length > 0) {
      return result;
    }

    // Check git availability
    const gitCheck = await this.checkGitAvailable();
    if (!gitCheck.available) {
      result.errors.push({ name: 'system', error: gitCheck.error! });
      return result;
    }

    // Ensure source is a git repository
    const isRepo = await this.isGitRepository();
    if (!isRepo) {
      result.errors.push({
        name: 'repository',
        error: 'Source path is not a git repository.',
      });
      return result;
    }

    // Create session directory
    const sessionDir = GitWorktreeService.getSessionDir(
      config.sessionId,
      this.customBaseDir,
    );
    await fs.mkdir(sessionDir, { recursive: true });

    // Save session config for later reference
    const configPath = path.join(sessionDir, 'config.json');
    const configFile: SessionConfigFile = {
      sessionId: config.sessionId,
      sourceRepoPath: config.sourceRepoPath,
      worktreeNames: config.worktreeNames,
      baseBranch: config.baseBranch,
      createdAt: Date.now(),
      ...config.metadata,
    };
    await fs.writeFile(configPath, JSON.stringify(configFile, null, 2));

    // Capture the current dirty state (tracked: staged + unstaged changes,
    // plus untracked files) once, without modifying the source working tree
    // or index, then overlay it onto each worktree below.
    const dirtyState = await this.captureDirtyState();

    // Create worktrees for each entry
    for (const name of config.worktreeNames) {
      const createResult = await this.createWorktree(
        config.sessionId,
        name,
        config.baseBranch,
      );

      if (createResult.success && createResult.worktree) {
        result.worktrees.push(createResult.worktree);
        result.worktreesByName[name] = createResult.worktree;
      } else {
        result.errors.push({
          name,
          error: createResult.error || 'Unknown error',
        });
      }
    }

    // If any worktree failed, clean up all created resources and fail
    if (result.errors.length > 0) {
      try {
        await this.cleanupSession(config.sessionId);
      } catch (error) {
        result.errors.push({
          name: 'cleanup',
          error: `Failed to cleanup after partial worktree creation: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      }
      result.success = false;
      return result;
    }

    // Success only if all worktrees were created
    result.success = result.worktrees.length === config.worktreeNames.length;

    // Overlay the source repo's dirty state onto each worktree so agents
    // see the same files the user currently has on disk.
    if (result.success) {
      for (const worktree of result.worktrees) {
        // 1. Apply tracked dirty changes and copy untracked files. A
        // conflicting carry restores committed state and throws; the
        // worktree stays usable at committed state, and the baseline
        // commit below must never stage conflict markers. If the restore
        // itself failed the tree may hold a half-applied overlay — refuse
        // to baseline it as pre-existing user state rather than commit it.
        try {
          await this.applyDirtyState(worktree.path, dirtyState);
        } catch (error) {
          if (!(error instanceof WorktreeDirtyCarryConflictError)) throw error;
          if (error.restoreFailed) {
            // A half-applied overlay cannot be baselined as user state. Abort
            // the setup and reap the worktrees already created rather than
            // orphaning them by throwing past the cleanup (R11-4).
            await this.cleanupSession(config.sessionId).catch(() => undefined);
            throw error;
          }
          debugLogger.warn(
            `setupWorktrees: dirty carry conflicted for ${worktree.name}; ` +
              'using committed state',
          );
        }

        // 2. Create a baseline commit capturing the full starting state
        //    (committed + dirty + untracked). This allows us to later diff
        //    only the agent's changes, excluding the pre-existing dirty state.
        const { simpleGit } = await loadSimpleGit();
        const wtGit = simpleGit(worktree.path).env(gitEnv());
        try {
          await wtGit.add(['--all']);
          await wtGit.commit(BASELINE_COMMIT_MESSAGE, {
            '--allow-empty': null,
            '--no-verify': null,
          });
        } catch {
          // Non-fatal: diff will fall back to merge-base if baseline is missing
        }
      }
    }

    return result;
  }

  /**
   * Lists all worktrees for a session.
   */
  async listWorktrees(sessionId: string): Promise<WorktreeInfo[]> {
    const worktreesDir = GitWorktreeService.getWorktreesDir(
      sessionId,
      this.customBaseDir,
    );

    try {
      const entries = await fs.readdir(worktreesDir, { withFileTypes: true });
      const worktrees: WorktreeInfo[] = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const worktreePath = path.join(worktreesDir, entry.name);

          // Read the actual branch from the worktree
          let branchName = '';
          try {
            branchName = execSync('git rev-parse --abbrev-ref HEAD', {
              cwd: worktreePath,
              encoding: 'utf8',
              stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
          } catch {
            // Fallback if git command fails
          }

          // Try to get stats for creation time
          let createdAt = Date.now();
          try {
            const stats = await fs.stat(worktreePath);
            createdAt = stats.birthtimeMs;
          } catch {
            // Ignore stat errors
          }

          worktrees.push({
            id: `${sessionId}/${entry.name}`,
            name: entry.name,
            path: worktreePath,
            branch: branchName,
            isActive: true,
            createdAt,
          });
        }
      }

      return worktrees;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Removes a single worktree.
   */
  async removeWorktree(
    worktreePath: string,
  ): Promise<{ success: boolean; error?: string }> {
    let git: SimpleGit;
    try {
      git = await this.getGit();
    } catch (error) {
      return {
        success: false,
        error: `Failed to remove worktree: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }

    try {
      // Remove the worktree from git
      await git.raw(['worktree', 'remove', worktreePath, '--force']);
      return { success: true };
    } catch (error) {
      // Try to remove the directory manually if git worktree remove fails
      try {
        await fs.rm(worktreePath, { recursive: true, force: true });
        // Prune worktree references
        await git.raw(['worktree', 'prune']);
        return { success: true };
      } catch (_rmError) {
        return {
          success: false,
          error: `Failed to remove worktree: ${error instanceof Error ? error.message : 'Unknown error'}`,
        };
      }
    }
  }

  /**
   * Cleans up all worktrees and branches for a session.
   */
  async cleanupSession(sessionId: string): Promise<{
    success: boolean;
    removedWorktrees: string[];
    removedBranches: string[];
    errors: string[];
  }> {
    const result = {
      success: true,
      removedWorktrees: [] as string[],
      removedBranches: [] as string[],
      errors: [] as string[],
    };

    // Collect actual branch names from worktrees before removing them
    const worktrees = await this.listWorktrees(sessionId);
    const worktreeBranches = new Set(
      worktrees.map((w) => w.branch).filter(Boolean),
    );

    // Remove all worktrees
    for (const worktree of worktrees) {
      const removeResult = await this.removeWorktree(worktree.path);
      if (removeResult.success) {
        result.removedWorktrees.push(worktree.name);
      } else {
        result.errors.push(
          removeResult.error || `Failed to remove ${worktree.name}`,
        );
        result.success = false;
      }
    }

    // Remove session directory
    const sessionDir = GitWorktreeService.getSessionDir(
      sessionId,
      this.customBaseDir,
    );
    try {
      await fs.rm(sessionDir, { recursive: true, force: true });
    } catch (error) {
      result.errors.push(
        `Failed to remove session directory: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }

    // Clean up branches that belonged to the worktrees
    try {
      const git = await this.getGit();
      for (const branchName of worktreeBranches) {
        try {
          await git.branch(['-D', branchName]);
          result.removedBranches.push(branchName);
        } catch {
          // Branch might already be deleted, ignore
        }
      }
      await git.raw(['worktree', 'prune']);
    } catch {
      // Ignore branch deletion, loader, and prune errors
    }

    return result;
  }

  /**
   * Gets the diff between a worktree and its baseline state.
   * Prefers the baseline commit (which includes the dirty state overlay)
   * so the diff only shows the agent's changes. Falls back to the base branch
   * when no baseline commit exists.
   */
  async getWorktreeDiff(
    worktreePath: string,
    baseBranch?: string,
  ): Promise<string> {
    try {
      const { simpleGit } = await loadSimpleGit();
      const worktreeGit = simpleGit(worktreePath);
      const base =
        (await this.resolveBaseline(worktreeGit)) ??
        baseBranch ??
        (await this.getCurrentBranch());
      return await this.withStagedChanges(worktreeGit, () =>
        worktreeGit.diff([...NO_EXEC_DIFF_FLAGS, '--binary', '--cached', base]),
      );
    } catch (error) {
      return `Error getting diff: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  /**
   * Applies raw changes from a worktree back to the target working directory.
   *
   * Diffs from the baseline commit (which already includes the user's
   * dirty state) so the patch only contains the agent's new changes.
   * Falls back to merge-base when no baseline commit exists.
   */
  async applyWorktreeChanges(
    worktreePath: string,
    targetPath?: string,
  ): Promise<{ success: boolean; error?: string }> {
    const target = targetPath || this.sourceRepoPath;

    try {
      const { simpleGit } = await loadSimpleGit();
      const worktreeGit = simpleGit(worktreePath);
      const targetGit = simpleGit(target);
      // Prefer the baseline commit (created during worktree setup after
      // overlaying dirty state) so the patch excludes pre-existing edits.
      let base = await this.resolveBaseline(worktreeGit);
      const hasBaseline = !!base;

      if (!base) {
        // Fallback: diff from merge-base
        const targetHead = (await targetGit.revparse(['HEAD'])).trim();
        base = (
          await worktreeGit.raw(['merge-base', 'HEAD', targetHead])
        ).trim();
      }

      const patch = await this.withStagedChanges(worktreeGit, () =>
        worktreeGit.diff([...NO_EXEC_DIFF_FLAGS, '--binary', '--cached', base]),
      );

      if (!patch.trim()) {
        return { success: true };
      }

      const patchFile = path.join(
        this.getBaseDirForInstance(),
        `.worktree-apply-${Date.now()}-${Math.random().toString(16).slice(2)}.patch`,
      );
      await fs.mkdir(path.dirname(patchFile), { recursive: true });
      await fs.writeFile(patchFile, patch, 'utf-8');

      try {
        // When using the baseline, the target working tree already matches the
        // patch pre-image (both have the dirty state), so a plain apply works.
        // --3way is only needed for the merge-base fallback path where the
        // pre-image may not match the working tree; it falls back to index
        // blob lookup which would fail on baseline-relative patches.
        const applyArgs = hasBaseline
          ? ['apply', '--whitespace=nowarn', patchFile]
          : ['apply', '--3way', '--whitespace=nowarn', patchFile];
        await targetGit.raw(applyArgs);
      } finally {
        await fs.rm(patchFile, { force: true });
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: `Failed to apply worktree changes: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Lists all sessions stored in the worktree base directory.
   */
  static async listSessions(customBaseDir?: string): Promise<
    Array<{
      sessionId: string;
      createdAt: number;
      sourceRepoPath: string;
      worktreeCount: number;
    }>
  > {
    const baseDir = GitWorktreeService.getBaseDir(customBaseDir);
    const sessions: Array<{
      sessionId: string;
      createdAt: number;
      sourceRepoPath: string;
      worktreeCount: number;
    }> = [];

    try {
      const entries = await fs.readdir(baseDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const configPath = path.join(baseDir, entry.name, 'config.json');
          try {
            const configContent = await fs.readFile(configPath, 'utf-8');
            const config = JSON.parse(configContent) as SessionConfigFile;

            const worktreesDir = path.join(baseDir, entry.name, WORKTREES_DIR);
            let worktreeCount = 0;
            try {
              const worktreeEntries = await fs.readdir(worktreesDir);
              worktreeCount = worktreeEntries.length;
            } catch {
              // Ignore if worktrees dir doesn't exist
            }

            sessions.push({
              sessionId: entry.name,
              createdAt: config.createdAt || Date.now(),
              sourceRepoPath: config.sourceRepoPath || '',
              worktreeCount,
            });
          } catch {
            // Ignore sessions without valid config
          }
        }
      }

      return sessions.sort((a, b) => b.createdAt - a.createdAt);
    } catch {
      return [];
    }
  }

  /**
   * Finds the baseline commit in a worktree, if one exists.
   * Returns the commit SHA, or null if not found.
   */
  private async resolveBaseline(
    worktreeGit: SimpleGit,
  ): Promise<string | null> {
    try {
      const sha = (
        await worktreeGit.raw([
          'log',
          '--grep',
          BASELINE_COMMIT_MESSAGE,
          '--format=%H',
          '-1',
        ])
      ).trim();
      return sha || null;
    } catch {
      return null;
    }
  }

  /** Stages all changes, runs a callback, then resets the index. */
  private async withStagedChanges<T>(
    git: SimpleGit,
    fn: () => Promise<T>,
  ): Promise<T> {
    await git.add(['--all']);
    try {
      return await fn();
    } finally {
      try {
        await git.raw(['reset']);
      } catch {
        // Best-effort: ignore reset failures
      }
    }
  }

  private sanitizeName(name: string): string {
    // Replace invalid characters with hyphens
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  private async pathExists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // User-facing worktree APIs (used by EnterWorktree / ExitWorktree tools
  // and AgentTool `isolation: 'worktree'`). These create worktrees under
  // `<projectRoot>/.qwen/worktrees/<slug>` rather than under the
  // session-scoped Arena baseDir.
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Returns the directory holding all general-purpose worktrees for this
   * repo: `<projectRoot>/.qwen/worktrees`.
   */
  getUserWorktreesDir(): string {
    return path.join(this.sourceRepoPath, '.qwen', WORKTREES_DIR);
  }

  /**
   * Returns the absolute worktree path for a given slug.
   */
  getUserWorktreePath(slug: string): string {
    return path.join(this.getUserWorktreesDir(), slug);
  }

  /**
   * Generates an auto-slug `{adj}-{noun}-{6hex}` for an unnamed worktree.
   *
   * Uses `randomInt` for the word-list indices (uniform by construction
   * via rejection sampling — `randomBytes[i] % len` would be biased
   * whenever `len` doesn't divide `2^8`, and CodeQL's
   * `js/biased-cryptographic-random` rule flags it even when it
   * happens to be exact). Uses `randomBytes` for the suffix because
   * hex encoding of raw bytes is unbiased. ~16M combinations × 8 adj
   * × 8 noun ≈ 1B distinct slugs.
   */
  static generateAutoSlug(): string {
    const ADJECTIVES = [
      'swift',
      'bright',
      'calm',
      'keen',
      'bold',
      'eager',
      'kind',
      'quick',
    ];
    const NOUNS = ['fox', 'owl', 'elm', 'oak', 'ray', 'sky', 'leaf', 'pine'];
    const adj = ADJECTIVES[randomInt(0, ADJECTIVES.length)];
    const noun = NOUNS[randomInt(0, NOUNS.length)];
    const suffix = randomBytes(3).toString('hex');
    return `${adj}-${noun}-${suffix}`;
  }

  /**
   * Parses a PR reference from a string. Recognised forms:
   *
   * - `#123` — shorthand PR number
   * - `https://github.com/<owner>/<repo>/pull/123` — full GitHub URL
   *   (any host, any query string, any fragment)
   *
   * Returns the parsed PR number on match, `null` otherwise. The slug for
   * a PR worktree is derived by callers as `pr-<N>` and the branch as
   * `worktree-pr-<N>` (see `createUserWorktree`).
   *
   * Mirrors claude-code's `parsePRReference` (utils/worktree.ts:633) so
   * cross-CLI muscle memory transfers.
   */
  static parsePRReference(input: string): number | null {
    if (typeof input !== 'string') return null;
    const trimmed = input.trim();

    // GitHub-style PR URL: https://<host>/owner/repo/pull/<N>
    // - any host (public github.com or enterprise)
    // - optional trailing slash, query string, or fragment
    // - optional sub-path after `/pull/<N>/` (`/files`, `/commits`,
    //   `/checks`, etc.) — users routinely copy URLs while browsing
    //   files on a PR, and the PR number is still unambiguous
    const urlMatch = trimmed.match(
      /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/(\d+)(?:\/[^?#]*)?(?:[?#].*)?$/i,
    );
    if (urlMatch?.[1]) {
      const n = parseInt(urlMatch[1], 10);
      return Number.isSafeInteger(n) && n > 0 ? n : null;
    }

    // `#N` shorthand. Reject leading zeros (`#0123`) to keep round-trips
    // unambiguous — `gh pr view 0123` errors out anyway.
    const hashMatch = trimmed.match(/^#([1-9]\d*)$/);
    if (hashMatch?.[1]) {
      const n = parseInt(hashMatch[1], 10);
      return Number.isSafeInteger(n) && n > 0 ? n : null;
    }

    return null;
  }

  /**
   * Identifies the registered worktree at `worktreePath` as a member of
   * THIS repository (`sourceRepoPath`). Returns the branch + HEAD commit
   * SHA on success, or `null` when the path is not a worktree of this
   * repo.
   *
   * Used by Phase D-1's re-attach path: when `--worktree foo` is passed
   * and `<repoRoot>/.qwen/worktrees/foo` already exists on disk, we
   * verify it really IS a Qwen-managed worktree of the current repo (not
   * a standalone `git init` someone dropped at that path) before
   * assuming it's safe to chdir into. Returning the HEAD SHA in the
   * same call avoids a second subprocess to recapture it after chdir.
   *
   * Implementation — a single `git rev-parse` returning four lines:
   * 1. `HEAD` → the worktree's HEAD commit SHA (must come BEFORE
   *    `--symbolic-full-name` since the flag sticks for subsequent refs).
   * 2. `--symbolic-full-name HEAD` → the full branch ref
   *    (`refs/heads/<name>`), normalized to the bare name. The full ref is
   *    used instead of `--abbrev-ref` because a same-named tag makes the
   *    short name ambiguous (`heads/<name>`), which would never match the
   *    sidecar's bare record. A detached HEAD produces `HEAD` here, reported
   *    with the empty-string branch convention so callers can re-attach.
   * 3. `--git-common-dir` → the common `.git` directory. For a real
   *    linked worktree of this repo that's `<sourceRepoPath>/.git`;
   *    for a sibling `git init` it resolves to `<worktreePath>/.git`.
   *    We compare against this repo's own common-dir to reject the
   *    latter.
   * 4. `--show-toplevel` → git's idea of the worktree top. For a real
   *    linked worktree this equals `worktreePath`; for a plain
   *    directory living UNDER the main repo (e.g. `mkdir
   *    <repo>/.qwen/worktrees/foo`) git walks up to the outer `.git`
   *    and returns the OUTER repo's root — which would otherwise pass
   *    the common-dir check and let us "re-attach" to a non-worktree
   *    directory. Compare paths to reject this.
   */
  async getRegisteredWorktreeBranch(
    worktreePath: string,
  ): Promise<{ branch: string; headCommit: string } | null> {
    let resolvedWorktreePath: string;
    try {
      const stat = await fs.stat(worktreePath);
      if (!stat.isDirectory()) return null;
      // `realpath` so macOS /var → /private/var canonicalises before
      // the toplevel comparison below — otherwise a real worktree
      // under /var/folders compares unequal to git's `/private/var/…`
      // answer and we'd reject every legitimate re-attach on macOS.
      resolvedWorktreePath = await fs.realpath(worktreePath);
    } catch {
      return null;
    }

    // Run the two probes in parallel: this repo's common-dir comes from
    // the source-repo client, the candidate's HEAD-SHA + branch + common-dir +
    // toplevel come from a fresh simple-git rooted at `worktreePath`
    // via a single combined rev-parse.
    let ourCommonDir: string;
    let headCommit: string;
    let branch: string;
    let probeCommonDir: string;
    let probeToplevel: string;
    try {
      const { simpleGit } = await loadSimpleGit();
      const probeGit = simpleGit(worktreePath);
      const [ourRaw, probeRaw] = await Promise.all([
        (await this.getGit()).raw(['rev-parse', '--git-common-dir']),
        probeGit.raw([
          'rev-parse',
          'HEAD',
          '--symbolic-full-name',
          'HEAD',
          '--git-common-dir',
          '--show-toplevel',
        ]),
      ]);
      ourCommonDir = path.resolve(this.sourceRepoPath, ourRaw.trim());
      const lines = probeRaw
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (lines.length < 4) return null;
      headCommit = lines[0]!;
      branch = lines[1]!;
      probeCommonDir = path.resolve(worktreePath, lines[2]!);
      probeToplevel = path.resolve(lines[3]!);
    } catch (error) {
      debugLogger.debug(
        `getRegisteredWorktreeBranch: probe at ${worktreePath} failed: ${error}`,
      );
      return null;
    }

    if (probeCommonDir !== ourCommonDir) {
      debugLogger.debug(
        `getRegisteredWorktreeBranch: ${worktreePath} belongs to a different repo (common-dir=${probeCommonDir}, expected ${ourCommonDir})`,
      );
      return null;
    }
    if (probeToplevel !== resolvedWorktreePath) {
      // Plain directory under the main repo — git walked up and
      // returned the outer repo's toplevel. Refuse to treat as a
      // worktree.
      debugLogger.debug(
        `getRegisteredWorktreeBranch: ${worktreePath} is not a registered worktree (toplevel=${probeToplevel}, expected ${resolvedWorktreePath})`,
      );
      return null;
    }
    if (!branch) return null;
    // A detached worktree is registered but has no branch ref; report it
    // with the empty-string branch convention so callers can re-attach.
    if (branch === 'HEAD') return { branch: '', headCommit };
    // The probe reports the full ref (`refs/heads/<name>`); drop the fixed
    // namespace so the bare name matches the sidecar record even when a
    // same-named tag would make `--abbrev-ref` qualify it as `heads/<name>`.
    return { branch: bareBranchName(branch), headCommit };
  }

  /**
   * Returns true when `worktreePath` is a REGISTERED linked worktree of this
   * repository — i.e. git's own registry entry for it points back at exactly
   * this path — and it is not the repository's primary working tree.
   *
   * Two complementary checks, because neither alone suffices:
   *
   * 1. **Registry** (repo side): some `<commonDir>/worktrees/<name>/gitdir`
   *    must name this path. Everything read here belongs to the repository, so
   *    a candidate cannot forge it — fabricating `<target>/.git` and the git
   *    dir it points at (with its own `commondir`/`gitdir`) only controls
   *    candidate-side files, which are never consulted. This also rejects the
   *    primary working tree, which has no `worktrees/<name>` entry, along with
   *    other repositories' worktrees and a directory carrying a `.git` file
   *    *copied* from a real worktree (the entry names the original, not the
   *    copy).
   * 2. **Liveness** (inside the path): the path's own `--git-dir` must be that
   *    same entry. A registry record survives `rm -rf` of its directory (git
   *    tags it `prunable` and keeps it for gc.worktreePruneExpire, 3 months by
   *    default); if the path is then recreated as an ordinary directory, git
   *    resolves it into the MAIN checkout. The registry answers "is this path
   *    registered?"; only the probe answers "is it a worktree right now?".
   *
   * A `.git`-is-a-file heuristic would misfire here (the main tree also carries
   * a `.git` file under `git clone --separate-git-dir` and in submodules), and
   * reading the registry directly avoids parsing `git worktree list`, whose
   * porcelain form is newline-delimited — and so injectable by a worktree path
   * that itself contains a newline — unless `-z` is used, which needs
   * Git >= 2.36 and would break older git.
   *
   * Fail-closed: any git or I/O error returns false, so a caller that gates
   * isolation on this check rejects an unverifiable path rather than
   * silently pinning a sub-agent to a possibly-main tree.
   */
  async isRegisteredLinkedWorktree(worktreePath: string): Promise<boolean> {
    const realpathOr = async (p: string): Promise<string> => {
      try {
        return await fs.realpath(p);
      } catch {
        return path.resolve(p);
      }
    };
    try {
      const target = await fs.realpath(worktreePath);

      // ── Registry side, read from THIS repository ──────────────────────
      // `<commonDir>/worktrees/<name>/gitdir` records the path of the worktree
      // that entry belongs to. Everything read here lives on the repo side, so
      // a candidate directory cannot forge an entry: fabricating `<target>/.git`
      // (and the git dir it names, with its own `commondir`/`gitdir`) only
      // controls candidate-side files, which are never consulted.
      const ourCommonDir = path.resolve(
        this.sourceRepoPath,
        (
          await (await this.getGit()).raw(['rev-parse', '--git-common-dir'])
        ).trim(),
      );
      const worktreesDir = path.join(ourCommonDir, 'worktrees');
      let entryNames: string[];
      try {
        entryNames = await fs.readdir(worktreesDir);
      } catch {
        return false; // the repository has no linked worktrees at all
      }

      let entryGitDir: string | null = null;
      for (const name of entryNames) {
        const entry = path.join(worktreesDir, name);
        let pointer: string;
        try {
          pointer = (
            await fs.readFile(path.join(entry, 'gitdir'), 'utf8')
          ).trim();
        } catch {
          continue; // incomplete entry — ignore
        }
        // `gitdir` holds `<registeredPath>/.git`.
        if ((await realpathOr(path.dirname(pointer))) === target) {
          entryGitDir = entry;
          break;
        }
      }
      // No entry names this path. This also rejects the primary working tree,
      // which never has a `worktrees/<name>` entry of its own.
      if (!entryGitDir) return false;

      // ── Liveness probe, inside the path ───────────────────────────────
      // A registry record survives `rm -rf` of its directory (git tags it
      // `prunable` and keeps it for gc.worktreePruneExpire, 3 months by
      // default). If the path is later recreated as an ordinary directory, git
      // resolves it into the MAIN checkout, so its `--git-dir` will not be this
      // entry. The registry answers "is this path registered?"; only a probe
      // inside the path answers "is it a worktree right now?".
      const { simpleGit } = await loadSimpleGit();
      const rawGitDir = (
        await simpleGit(target).raw(['rev-parse', '--git-dir'])
      ).trim();
      const probeGitDir = await realpathOr(path.resolve(target, rawGitDir));
      return probeGitDir === (await realpathOr(entryGitDir));
    } catch (error) {
      debugLogger.debug(
        `isRegisteredLinkedWorktree: probe at ${worktreePath} failed: ${error}`,
      );
      return false;
    }
  }

  /**
   * Fetches the GitHub PR ref `refs/pull/<N>/head` from the `origin` remote
   * so a subsequent `createUserWorktree(..., 'FETCH_HEAD')` call can branch
   * off the PR's tip (Phase D-3). Returns `{ success: true }` on success,
   * or `{ success: false, error }` with a user-facing reason on failure.
   *
   * Implementation notes:
   *
   * - Uses `git fetch origin pull/<N>/head` (no `gh` CLI dependency).
   * - Hard timeout of 30s by default — overridable for tests. A hung git
   *   process on a misconfigured corporate proxy would otherwise stall
   *   the entire startup sequence.
   * - Does NOT create a local branch — leaves the ref accessible only
   *   via `FETCH_HEAD`. Subsequent `git worktree add -b <branch> <wt>
   *   FETCH_HEAD` materialises the worktree branch off it.
   *
   * Error message taxonomy is friendly because this is the user's first
   * impression when their `--worktree=#<N>` fails:
   * - missing `origin` → tell them the remote is required + how to fix
   * - timeout → mention the configured timeout so they can blame the network
   * - generic failure → "PR may not exist or origin is unreachable"
   */
  async fetchPullRequestRef(
    prNumber: number,
    options?: { timeoutMs?: number },
  ): Promise<{ success: true } | { success: false; error: string }> {
    if (
      !Number.isSafeInteger(prNumber) ||
      prNumber <= 0 ||
      prNumber > 1_000_000_000
    ) {
      // Out-of-range PR numbers can't sensibly hit GitHub. Reject locally
      // rather than firing a doomed network call.
      return {
        success: false,
        error: `Invalid PR number: ${prNumber}.`,
      };
    }
    const timeoutMs = options?.timeoutMs ?? 30_000;

    // Two-layer defense for the refspec argv element:
    //
    // 1. Regex digit-only validation at the call site — CodeQL's
    //    `js/second-order-command-line-injection` rule recognises
    //    `/^[1-9][0-9]*$/.test(x)` as a lexical sanitizer, which proves
    //    `prNumber` cannot resemble a `--upload-pack=…` flag. The
    //    entry guard above already establishes this at runtime, but
    //    CodeQL's interprocedural taint tracker doesn't see through
    //    that guard; the regex check IS the pattern its sanitizer
    //    library recognises.
    // 2. `--end-of-options` as a git-runtime marker. Even though
    //    layer 1 makes a flag-shaped refspec impossible, the marker
    //    tells git definitively that every subsequent argv element
    //    is positional — defense-in-depth against a future
    //    regression that loosens the entry guard.
    const prNumberStr = String(prNumber);
    if (!/^[1-9][0-9]*$/.test(prNumberStr)) {
      // Unreachable given the entry guard; here to make the
      // lexical sanitizer visible to static analyzers.
      return {
        success: false,
        error: `Invalid PR number: ${prNumber}.`,
      };
    }
    const refspec = `pull/${prNumberStr}/head`;

    try {
      // Force English git stderr so the error-taxonomy regexes below
      // match. Without this, users with non-English locales fall
      // through to the generic "PR may not exist" branch even for
      // well-known cases like missing-origin. The git binary itself is
      // unaffected by LANG/LC_ALL beyond message strings.
      await execFileAsync(
        'git',
        ['fetch', '--end-of-options', 'origin', refspec],
        {
          cwd: this.sourceRepoPath,
          timeout: timeoutMs,
          env: gitRemoteEnv(),
        },
      );
      return { success: true };
    } catch (error) {
      // execFile reports timeouts via `signal: 'SIGTERM'` on the
      // error object; the stderr text gives us the underlying git error.
      const err = error as NodeJS.ErrnoException & {
        stderr?: string | Buffer;
        signal?: string;
      };
      const stderr =
        typeof err.stderr === 'string'
          ? err.stderr
          : err.stderr instanceof Buffer
            ? err.stderr.toString('utf8')
            : '';
      const lower = stderr.toLowerCase();

      if (err.signal === 'SIGTERM') {
        return {
          success: false,
          error:
            `Failed to fetch PR #${prNumber}: timed out after ${Math.round(timeoutMs / 1000)}s. ` +
            `Check network connectivity and any HTTP(S) proxy settings.`,
        };
      }
      if (
        lower.includes('does not appear to be a git repository') ||
        lower.includes('could not read from remote repository') ||
        lower.includes("'origin' does not appear")
      ) {
        return {
          success: false,
          error:
            `--worktree=#${prNumber} requires an "origin" remote that points at GitHub. ` +
            `Add one with \`git remote add origin <url>\` and retry.`,
        };
      }
      if (
        lower.includes('no such ref') ||
        lower.includes("couldn't find remote ref") ||
        lower.includes("couldn't find remote ref pull/")
      ) {
        return {
          success: false,
          error:
            `Failed to fetch PR #${prNumber}: the PR does not exist on origin, ` +
            `or origin is not a GitHub repository (only GitHub exposes refs/pull/<N>/head).`,
        };
      }
      // Generic fallback. Include the stderr first line so an operator
      // running with --debug can correlate, but keep it terse.
      const firstLine = stderr.split('\n').find((l) => l.trim().length > 0);
      const detail = firstLine ? ` (${firstLine.trim()})` : '';
      debugLogger.warn(
        `fetchPullRequestRef: git fetch pull/${prNumber}/head failed: ${error}`,
      );
      return {
        success: false,
        error: `Failed to fetch PR #${prNumber}: PR may not exist, or origin remote is unreachable${detail}.`,
      };
    }
  }

  /**
   * Validates a worktree slug. Returns null on success, or an error message.
   *
   * Rules (mirrors claude-code's `validateWorktreeSlug`):
   * - Non-empty, ≤ 64 chars
   * - Only `[a-zA-Z0-9._-]` characters; no path separators
   * - No `..` or leading/trailing dots (would resolve outside the worktrees dir)
   * - Must not start with `agent-`: that prefix is reserved for the
   *   ephemeral worktrees `AgentTool isolation:'worktree'` produces.
   *   The startup sweep auto-removes anything matching
   *   {@link AGENT_WORKTREE_SLUG_PATTERN}, so a user-named
   *   `agent-1234567` would be silently deleted after 30 days along
   *   with any work it contained.
   */
  static validateUserWorktreeSlug(
    slug: string,
    options?: { allowPrBackedShape?: boolean },
  ): string | null {
    if (typeof slug !== 'string' || slug.length === 0) {
      return 'Worktree name must be a non-empty string.';
    }
    if (slug.length > 64) {
      return 'Worktree name must be at most 64 characters.';
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(slug)) {
      return 'Worktree name may only contain letters, digits, dots, underscores, and hyphens.';
    }
    if (slug.includes('..') || slug.startsWith('.') || slug.startsWith('-')) {
      return 'Worktree name must not start with "." or "-" or contain "..".';
    }
    if (
      /^pr-[1-9]\d{0,8}$/.test(slug) &&
      options?.allowPrBackedShape !== true
    ) {
      // `--worktree=#<N>` launches own this shape; a user-chosen slug with
      // it would bind the session to PR N (and take the sweep's state
      // stamps) although the session never touched that PR.
      return (
        'Worktree name must not look like "pr-<number>": that shape is ' +
        'reserved for PR-backed worktrees.'
      );
    }
    if (slug.startsWith(`${AGENT_WORKTREE_PREFIX}-`)) {
      // The exact `agent-<7hex>` slugs that `generateAgentWorktreeSlug`
      // produces ARE allowed — those are the legitimate ephemeral
      // shape that the cleanup sweep is built around. Only reject
      // user-chosen names with the same prefix that don't match the
      // canonical pattern (e.g. `agent-feature`, `agent-1234567890`):
      // those would either get swept after 30 days or never (if not
      // matching the regex), confusing the user either way.
      if (!AGENT_WORKTREE_SLUG_PATTERN.test(slug)) {
        return (
          `Worktree name must not start with "${AGENT_WORKTREE_PREFIX}-": that prefix ` +
          `is reserved for ephemeral agent worktrees and is subject to ` +
          `automatic cleanup after 30 days.`
        );
      }
    }
    return null;
  }

  /**
   * Creates a general-purpose worktree at `<projectRoot>/.qwen/worktrees/<slug>`
   * with branch `worktree-<slug>`. Used by `EnterWorktreeTool` and
   * `AgentTool isolation:'worktree'`.
   *
   * Refuses to overwrite an existing branch: if `worktree-<slug>` already
   * exists (e.g., from a manual `git checkout -b worktree-foo` or a
   * teammate's push), the call fails with a clear error rather than
   * silently resetting the branch. The previous `-B` form would have
   * dropped any commits unique to that branch — see review #4073.
   */
  async createUserWorktree(
    slug: string,
    baseBranch?: string,
    options?: {
      symlinkDirectories?: readonly string[];
      /** The caller owns the pr-<N> shape (PR-backed startup). */
      prBacked?: boolean;
      /**
       * Apply the source checkout's uncommitted changes (tracked staged +
       * unstaged, and untracked files) to the new worktree, so a session
       * starts from the same files the user has on disk. Fail-open per
       * step; no baseline commit is created.
       */
      carryDirtyState?: boolean;
      /**
       * Checkout to capture the dirty state from when it differs from
       * this service's root: the worktree is placed under the service
       * root's managed directory, but the session may live in another
       * checkout of the same repository whose HEAD differs from the
       * main checkout's. Defaults to the service root.
       */
      dirtyStateSource?: string;
      /**
       * Upper bound on the serialized carried-path list, for callers that
       * persist it in a size-capped record (the branch-preparation
       * journal). Above the bound the carry is skipped (fail-open to
       * committed state) so the record stays readable. Callers that write
       * no journal (handoff, POST /session) leave this unset and carry
       * any size — silently dropping a large overlay there would move the
       * session without the user's work.
       */
      maxCarriedPathsBytes?: number;
      /**
       * Create the worktree in detached HEAD instead of on a named
       * `worktree-<slug>` branch (Codex-style managed worktrees: several
       * sessions without polluting the branch list). The returned
       * `WorktreeInfo.branch` is `''` while detached.
       */
      detached?: boolean;
    },
  ): Promise<CreateWorktreeResult> {
    const validationError = GitWorktreeService.validateUserWorktreeSlug(
      slug,
      options?.prBacked === true ? { allowPrBackedShape: true } : undefined,
    );
    if (validationError) {
      debugLogger.warn(
        `createUserWorktree: invalid slug ${slug}: ${validationError}`,
      );
      return { success: false, error: validationError };
    }

    try {
      const worktreesDir = this.getUserWorktreesDir();
      await fs.mkdir(worktreesDir, { recursive: true });
      const worktreePath = path.join(worktreesDir, slug);

      if (await fileExists(worktreePath)) {
        const error = `Worktree already exists at ${worktreePath}`;
        debugLogger.warn(`createUserWorktree: ${error}`);
        return { success: false, error };
      }

      // Keep the worktrees directory and its contents out of the parent
      // repo's `git status` and any subsequent glob/grep that walks from
      // the parent root. Only writes when the file is missing — never
      // touches an existing user-managed `.qwen/.gitignore`.
      await this.ensureWorktreesGitignored();

      const base = baseBranch || (await this.getCurrentBranch());
      const detached = options?.detached === true;
      const branchName = detached ? '' : worktreeBranchForSlug(slug);

      if (!detached) {
        // Refuse to clobber a pre-existing branch with the same name. Use
        // `git show-ref --verify --quiet refs/heads/<branch>` (exit 0 →
        // branch exists). The previous `-B` form would have force-reset
        // such a branch and silently dropped unmerged commits.
        const branchExists = await this.localBranchExists(branchName);
        if (branchExists) {
          const error =
            `Cannot create worktree "${slug}": branch ${branchName} already exists. ` +
            `Choose a different name, or delete the branch first ` +
            `(e.g. \`git branch -d ${branchName}\`).`;
          debugLogger.warn(`createUserWorktree: ${error}`);
          return { success: false, error };
        }
      }

      await (
        await this.getGit()
      ).raw(
        detached
          ? ['worktree', 'add', '--detach', worktreePath, base]
          : ['worktree', 'add', '-b', branchName, worktreePath, base],
      );

      // Configure core.hooksPath so commits inside the worktree run the
      // main repo's hooks (the new worktree's .git directory has no hooks
      // of its own). Priority: .husky/ first (common for JS projects),
      // .git/hooks fallback. Mirrors claude-code's performPostCreationSetup.
      // Best-effort: hook failures must not abort worktree creation.
      await this.configureHooksPath(worktreePath).catch((error) => {
        debugLogger.warn(
          `createUserWorktree: failed to configure core.hooksPath for ${slug}: ${error}`,
        );
      });

      // Phase D-2: symlink user-configured directories from the main
      // repo into the new worktree (e.g. node_modules) so the model can
      // run tests / builds without a fresh install. Same fail-open
      // policy as hooksPath — failures log and continue.
      const symlinkPaths = options?.symlinkDirectories ?? [];
      if (symlinkPaths.length > 0) {
        await this.symlinkConfiguredDirectories(
          worktreePath,
          symlinkPaths,
        ).catch((error) => {
          debugLogger.warn(
            `createUserWorktree: symlinkConfiguredDirectories failed for ${slug}: ${error}`,
          );
        });
      }

      let carriedPaths: string[] | undefined;
      let carriedEntries: CarriedEntry[] | undefined;
      if (options?.carryDirtyState === true) {
        const captureService =
          options.dirtyStateSource !== undefined &&
          options.dirtyStateSource !== this.sourceRepoPath
            ? new GitWorktreeService(options.dirtyStateSource)
            : this;
        const dirtyState = await captureService.captureDirtyState();
        if (dirtyState.captureError !== null) {
          // Capturing the tracked overlay failed. An empty carry here is NOT
          // a clean source: refuse and remove the worktree rather than
          // relocate the session without the user's tracked edits. Scoped to
          // carry-requesting callers — setupWorktrees ignores captureError
          // and keeps its fail-open degrade.
          await this.removeWorktree(worktreePath).catch(() => undefined);
          if (dirtyState.unmergedIndex) {
            // An in-progress merge/rebase (unmerged index) is a state the
            // user can clear, not a daemon fault: surface a typed refusal the
            // route maps to a readable 409 instead of a 500 (R12-1).
            return {
              success: false,
              code: 'worktree_merge_in_progress',
              error:
                'The workspace has an in-progress merge or rebase (unmerged files). ' +
                'Resolve or abort it before starting a worktree session.',
            };
          }
          // A genuine environment fault (held index.lock, read-only git dir)
          // keeps the hard refusal so a session is never relocated without
          // the user's tracked edits.
          return {
            success: false,
            error: `Failed to capture the source checkout's dirty state: ${dirtyState.captureError}`,
          };
        }
        const overlay = [
          ...dirtyState.trackedFiles,
          ...dirtyState.removedPaths,
          ...dirtyState.untrackedFiles,
        ];
        // Byte length, not character count: the journal is written as
        // UTF-8 and its cap is in bytes, so non-ASCII paths must be
        // measured the way the reader will refuse them. Only journal-backed
        // callers set a bound; the handoff and POST /session carry any size.
        const bound = options.maxCarriedPathsBytes;
        if (
          bound !== undefined &&
          Buffer.byteLength(JSON.stringify(overlay), 'utf8') > bound
        ) {
          // Too large to persist in the preparation journal: skip the
          // carry rather than create a worktree no rollback can reap.
          debugLogger.warn(
            `createUserWorktree: dirty overlay too large to record for ${slug} ` +
              `(${overlay.length} paths); starting from committed state`,
          );
        } else {
          let createdUntracked: string[];
          try {
            createdUntracked = await this.applyDirtyState(
              worktreePath,
              dirtyState,
            );
          } catch (error) {
            if (error instanceof WorktreeDirtyCarryConflictError) {
              // The worktree was restored to committed state; remove it so
              // a failed carry leaves no checkout behind, and fail closed
              // rather than relocate the session without the user's work.
              await this.removeWorktree(worktreePath).catch(() => undefined);
              return { success: false, error: error.message };
            }
            throw error;
          }
          // Record only what the carry actually applied: every tracked path
          // (the apply succeeded) plus the paths applyDirtyState created or
          // explicitly removed (untracked copies and file→directory deletions).
          // A skipped untracked entry (pre-existing destination or escaping
          // ancestor symlink) is not part of the overlay the rollback exempts.
          carriedPaths = [...dirtyState.trackedFiles, ...createdUntracked];
          // Content identities for the managed-session gate. A failure here
          // leaves carriedEntries absent (the gate then treats the overlay as
          // work and snapshots it) without affecting the prepared rollback,
          // which exempts by path in its never-attached context.
          carriedEntries = await computeCarriedIdentities(
            worktreePath,
            carriedPaths,
          ).catch((error) => {
            debugLogger.warn(
              `createUserWorktree: carried identity computation failed for ${slug}; ` +
                `the reaper will snapshot the overlay: ${error}`,
            );
            return undefined;
          });
        }
      }

      const worktree: WorktreeInfo = {
        id: slug,
        name: slug,
        path: worktreePath,
        branch: branchName,
        isActive: true,
        createdAt: Date.now(),
      };
      return { success: true, worktree, carriedPaths, carriedEntries };
    } catch (error) {
      const message = `Failed to create worktree "${slug}": ${error instanceof Error ? error.message : 'Unknown error'}`;
      debugLogger.warn(`createUserWorktree: ${message}`);
      return { success: false, error: message };
    }
  }

  /**
   * Detaches a checkout at its current HEAD, releasing any branch it holds
   * so another checkout can check that branch out (git forbids the same
   * branch in two worktrees). Uncommitted changes survive the detach.
   */
  async detachCheckout(checkoutPath: string): Promise<void> {
    const { simpleGit } = await loadSimpleGit();
    await simpleGit(checkoutPath).env(gitEnv()).raw(['checkout', '--detach']);
  }

  /**
   * Checks out an existing branch in a checkout (handoff carry). Throws on
   * git's own refusals (dirty tree, branch checked out elsewhere) so the
   * caller can map them to a typed refusal. With `noOverwriteIgnore`, git
   * refuses (atomically, before any mutation) to overwrite a local ignored
   * file the branch tracks — the clean gate uses `git status`, which does not
   * see ignored files, so without this a handoff could silently destroy an
   * ignored file whose content is not in the object store.
   */
  async checkoutBranchInCheckout(
    checkoutPath: string,
    branchName: string,
    options?: { noOverwriteIgnore?: boolean },
  ): Promise<void> {
    const { simpleGit } = await loadSimpleGit();
    const args = ['checkout'];
    if (options?.noOverwriteIgnore === true) {
      args.push('--no-overwrite-ignore');
    }
    args.push(branchName);
    await simpleGit(checkoutPath).env(gitEnv()).raw(args);
  }

  /**
   * Force-checkout a branch, discarding tracked working-tree changes.
   * Rollback-only: the caller must know the checkout's prior state was
   * clean (or a copy it can afford to lose). Judged by exit status, not
   * stderr presence (carryApplyErrorDetection): a silent non-zero exit must
   * reject, so the handoff rollback reports a failed restore truthfully
   * instead of claiming a force-restore that never happened (round-10 S19).
   */
  async forceCheckoutBranch(
    checkoutPath: string,
    branchName: string,
  ): Promise<void> {
    const { simpleGit } = await loadSimpleGit();
    await simpleGit(checkoutPath, { errors: carryApplyErrorDetection })
      .env(gitEnv())
      .raw(['checkout', '-f', branchName]);
  }

  /**
   * Delete a local branch even when it carries unmerged commits.
   * Rollback-only: used to drop a branch this process just created.
   */
  async deleteLocalBranch(branchName: string): Promise<void> {
    await (await this.getGit()).branch(['-D', branchName]);
  }

  /**
   * Captures a checkout's uncommitted tracked changes as a stash commit
   * without touching its working tree or index (`git stash create`).
   * Returns '' when there is nothing to capture (a clean tree exits 0 with no
   * output). Untracked files are not included — callers copy them separately
   * when needed. Judged by exit status, not stderr presence: a silent non-zero
   * exit (git 2.39.5 with a held index.lock writes nothing to either stream)
   * must throw, not resolve as '' — otherwise the handoff would relocate the
   * session without the worktree's tracked edits (R13-1).
   */
  async createStashSnapshot(checkoutPath: string): Promise<string> {
    const { simpleGit } = await loadSimpleGit();
    const git = simpleGit(checkoutPath, {
      errors: carryApplyErrorDetection,
    }).env(gitEnv());
    return (await git.stash(['create'])).trim();
  }

  /**
   * Applies a stash commit snapshot in a checkout (`git stash apply`).
   * Throws WorktreeDirtyCarryConflictError when the 3-way apply conflicts
   * (detected by unmerged index entries — simple-git's raw mode may resolve
   * even on the non-zero exit), restoring the checkout to committed state
   * first so no conflict markers survive; when that restore itself fails
   * the error carries `restoreFailed` and the checkout may still hold the
   * markers, so the caller's rollback must not assume a clean checkout.
   * Any other apply failure (e.g. an unwritable index) also throws: the
   * handoff must never move the session without the user's work, so there
   * is no fail-open here.
   */
  async applyStashSnapshot(
    checkoutPath: string,
    snapshot: string,
  ): Promise<void> {
    const { simpleGit } = await loadSimpleGit();
    const git = simpleGit(checkoutPath, {
      errors: carryApplyErrorDetection,
    }).env(gitEnv());
    // Refuse BEFORE mutating: `git stash apply` silently overwrites a local
    // ignored-untracked file whose content lives in no object store, exits
    // 0, and leaves no unmerged entries — so neither the conflict nor the
    // error branch below would fire (R12-2). The checkout's
    // --no-overwrite-ignore guard does not cover this apply, and in the
    // detached-at-base shape no checkout runs at all. Intersect the
    // snapshot's tracked paths with the target's ignored-untracked set;
    // a hit (or a probe that cannot answer) fails closed as a conflict so
    // the route answers 409 and the file survives.
    let snapshotPathsRaw: string;
    try {
      snapshotPathsRaw = await git.raw([
        'diff',
        '--name-only',
        '--no-renames',
        '-z',
        `${snapshot}^1`,
        snapshot,
      ]);
    } catch (error) {
      throw new WorktreeDirtyCarryConflictError(
        `Cannot determine the stash snapshot's paths to guard ignored files: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { conflict: true },
      );
    }
    const snapshotPaths = snapshotPathsRaw.split('\0').filter(Boolean);
    if (snapshotPaths.length > 0) {
      // The snapshot's paths are repository-relative and `stash apply` writes
      // across the WHOLE repo, but checkoutPath may be a subdirectory: an
      // ls-files run there lists only that subtree, cwd-relative, so the two
      // probes would use different bases and scopes and miss the collision
      // (R15-1). Enumerate the ignored set from the repo root with --full-name
      // so both sides share one repository-relative, repo-wide basis.
      let targetTop: string;
      try {
        targetTop = (await git.raw(['rev-parse', '--show-toplevel'])).replace(
          /\n$/,
          '',
        );
        if (targetTop.length === 0) throw new Error('empty repository root');
      } catch (error) {
        throw new WorktreeDirtyCarryConflictError(
          `Cannot determine the target repository root to guard ignored files: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { conflict: true },
        );
      }
      const targetGit = simpleGit(targetTop).env(gitEnv());
      let ignoredRaw: string;
      try {
        ignoredRaw = await targetGit.raw([
          'ls-files',
          '--others',
          '--ignored',
          '--exclude-standard',
          '--full-name',
          '-z',
        ]);
      } catch (error) {
        throw new WorktreeDirtyCarryConflictError(
          `Cannot determine the checkout's ignored files to guard the stash apply: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { conflict: true },
        );
      }
      const ignoredPaths = ignoredRaw.split('\0').filter(Boolean);
      if (ignoredPaths.length > 0) {
        // On a case-insensitive filesystem a case-aliased snapshot path names
        // the same file as the ignored path (R15-3); fold case when the target
        // does so it is not missed by literal equality.
        const ignoresCase = await this.targetIgnoresCase(targetGit);
        // Normalize Unicode to NFC so canonical-equivalent names (NFC `café`
        // vs NFD `cafe` + combining acute) compare equal: a normalization-
        // insensitive filesystem (macOS) treats them as one file (R16-2).
        // Folding is conservative — on a normalization-sensitive filesystem it
        // can only refuse a rare canonical-equivalent pair, never lose data.
        // Case is folded when the target folds it (R15-3).
        const norm = (p: string) => {
          const n = p.normalize('NFC');
          return ignoresCase ? n.toLowerCase() : n;
        };
        const snapshotSet = new Set(snapshotPaths.map(norm));
        const ignoredSet = new Set(ignoredPaths.map(norm));
        const ancestorsOf = (p: string): string[] => {
          const out: string[] = [];
          let sep = p.lastIndexOf('/');
          while (sep > 0) {
            const a = p.slice(0, sep);
            out.push(a);
            sep = a.lastIndexOf('/');
          }
          return out;
        };
        for (const ignoredPath of ignoredPaths) {
          const target = norm(ignoredPath);
          if (snapshotSet.has(target)) {
            throw new WorktreeDirtyCarryConflictError(
              `Stash snapshot would overwrite the ignored local file ${ignoredPath}`,
              { conflict: true },
            );
          }
          // A snapshot file at an ancestor directory would replace the very
          // directory that holds the ignored content (R15-2): exact-path
          // equality alone misses `secret` clobbering `secret/unique.txt`.
          for (const ancestor of ancestorsOf(target)) {
            if (snapshotSet.has(ancestor)) {
              throw new WorktreeDirtyCarryConflictError(
                `Stash snapshot would replace the directory holding the ignored local file ${ignoredPath}`,
                { conflict: true },
              );
            }
          }
        }
        // The reverse direction (R16-1): an ignored regular FILE sitting at an
        // ancestor of a snapshot path would be replaced by the directory the
        // snapshot creates there — `secret/agent.txt` clobbering the ignored
        // file `secret`. Exact and forward-ancestor checks both miss it.
        for (const snapshotPath of snapshotPaths) {
          for (const ancestor of ancestorsOf(norm(snapshotPath))) {
            if (ignoredSet.has(ancestor)) {
              throw new WorktreeDirtyCarryConflictError(
                `Stash snapshot would replace the ignored local file ${ancestor} with a directory`,
                { conflict: true },
              );
            }
          }
        }
        // Filesystem-identity check (R17-1, R18-1): string folding (NFC + case)
        // cannot replicate every alias a filesystem treats as one path — macOS
        // folds final sigma `ς` to `σ`, which toLowerCase leaves distinct. Ask
        // the target FS directly via device+inode, and cover the ancestor
        // relationships too, since an alias can sit on a parent path rather
        // than the full path. This catches any FS-specific alias the string
        // comparison misses, without maintaining a Unicode fold table.
        const statTarget = (p: string) =>
          fs.stat(path.join(targetTop, p)).catch(() => null);
        const keyOf = (st: { dev: number; ino: number }) =>
          `${st.dev}:${st.ino}`;
        // Inodes of ignored regular files, and of the directories that hold
        // ignored content (so a snapshot file resolving to such a directory is
        // caught even when the alias is on the directory name).
        const ignoredFileIdentity = new Map<string, string>();
        const ignoredDirIdentity = new Set<string>();
        for (const ignoredPath of ignoredPaths) {
          const st = await statTarget(ignoredPath);
          if (st && st.isFile()) {
            ignoredFileIdentity.set(keyOf(st), ignoredPath);
          }
          for (const ancestor of ancestorsOf(ignoredPath)) {
            const ast = await statTarget(ancestor);
            if (ast && ast.isDirectory()) {
              ignoredDirIdentity.add(keyOf(ast));
            }
          }
        }
        for (const snapshotPath of snapshotPaths) {
          const st = await statTarget(snapshotPath);
          if (st) {
            // The snapshot path itself aliases an ignored file (overwrite) or
            // a directory holding ignored content (file replaces directory).
            if (st.isFile()) {
              const hit = ignoredFileIdentity.get(keyOf(st));
              if (hit !== undefined) {
                throw new WorktreeDirtyCarryConflictError(
                  `Stash snapshot would overwrite the ignored local file ${hit}`,
                  { conflict: true },
                );
              }
            } else if (st.isDirectory() && ignoredDirIdentity.has(keyOf(st))) {
              throw new WorktreeDirtyCarryConflictError(
                `Stash snapshot would replace a directory holding ignored local content at ${snapshotPath}`,
                { conflict: true },
              );
            }
          }
          // An ancestor of the snapshot path that aliases an ignored regular
          // file would be replaced by the directory the snapshot creates there
          // (the full snapshot path cannot stat through a file, so check each
          // ancestor's identity directly).
          for (const ancestor of ancestorsOf(snapshotPath)) {
            const ast = await statTarget(ancestor);
            if (ast && ast.isFile()) {
              const hit = ignoredFileIdentity.get(keyOf(ast));
              if (hit !== undefined) {
                throw new WorktreeDirtyCarryConflictError(
                  `Stash snapshot would replace the ignored local file ${hit} with a directory`,
                  { conflict: true },
                );
              }
            }
          }
        }
      }
    }
    let applyError: unknown;
    try {
      await git.raw(['stash', 'apply', snapshot]);
    } catch (error) {
      applyError = error;
    }
    let unmergedRaw: string | null = null;
    try {
      unmergedRaw = await git.raw(['ls-files', '-u']);
    } catch {
      unmergedRaw = null;
    }
    const unmerged = (unmergedRaw ?? '').trim();
    if (unmerged.length > 0) {
      // Do not swallow the restore's own failure: if reset cannot run
      // (locked index, read-only git dir) the checkout keeps the conflict
      // markers, and the error must not claim it was restored — the
      // caller's rollback needs to know the checkout may still be dirty.
      let restoreError: unknown;
      try {
        await git.raw(['reset', '--hard', 'HEAD']);
      } catch (error) {
        restoreError = error;
      }
      const restoreNote =
        restoreError !== undefined
          ? ` (restore to committed state also failed: ${
              restoreError instanceof Error
                ? restoreError.message
                : String(restoreError)
            })`
          : '';
      throw new WorktreeDirtyCarryConflictError(
        `Stash snapshot conflicted with the checkout: ${
          applyError instanceof Error ? applyError.message : 'merge conflict'
        }` + restoreNote,
        { restoreFailed: restoreError !== undefined },
      );
    }
    if (applyError || unmergedRaw === null) {
      // A non-conflict apply failure (e.g. an unwritable index), or an index
      // state that could not be read to confirm a clean apply: the handoff
      // must not move the session without the user's work. Fail closed —
      // unlike the worktree-creation path, there is no fail-open here.
      throw new WorktreeDirtyCarryConflictError(
        applyError
          ? `Stash snapshot failed to apply: ${
              applyError instanceof Error
                ? applyError.message
                : String(applyError)
            }`
          : 'Stash snapshot applied but the index state could not be read to confirm a clean apply',
        { conflict: false },
      );
    }
  }

  /**
   * Whether the target filesystem folds path case, so a case-aliased snapshot
   * path names the same file as an ignored path (R15-3). Reads git's own
   * `core.ignorecase` record first (true on case-insensitive filesystems such
   * as macOS/Windows); when it is unset/false, probes the target FS directly
   * by creating a temp file in the git dir (same filesystem, outside the
   * working tree) and checking whether a case-variant of its name resolves to
   * the same inode. Best-effort: a probe that cannot run answers false, which
   * only skips case-folding on a filesystem that reports itself case-sensitive.
   */
  private async targetIgnoresCase(git: SimpleGit): Promise<boolean> {
    try {
      const configured = (
        await git.raw(['config', '--bool', 'core.ignorecase'])
      ).trim();
      if (configured === 'true') return true;
    } catch {
      // Unset or unreadable: fall through to the filesystem probe.
    }
    try {
      const gitDir = (
        await git.raw(['rev-parse', '--absolute-git-dir'])
      ).trim();
      if (gitDir.length === 0) return false;
      const stamp = `${process.pid}-${Date.now()}`;
      const lower = path.join(gitDir, `qwen-case-probe-${stamp}-a`);
      const upper = path.join(gitDir, `qwen-case-probe-${stamp}-A`);
      await fs.writeFile(lower, '');
      try {
        const a = await fs.stat(lower);
        const b = await fs.stat(upper).catch(() => null);
        return b !== null && a.dev === b.dev && a.ino === b.ino;
      } finally {
        await fs.rm(lower, { force: true }).catch(() => undefined);
      }
    } catch {
      return false;
    }
  }

  /**
   * Turns a detached worktree into a named branch at its current HEAD
   * ("Create branch here", Codex parity). Throws when the checkout is not
   * detached or the branch name is already taken — callers validate first
   * and map the failure to a typed refusal. A post-checkout hook failure
   * after the switch succeeded is NOT a failure: the branch exists and
   * the checkout sits on it, so callers must record it (treating it as
   * "no branch" would leave the sidecar naming a state that no longer
   * exists and wedge every later handoff in worktree_branch_mismatch).
   */
  async createWorktreeBranch(
    worktreePath: string,
    branchName: string,
  ): Promise<void> {
    const { simpleGit } = await loadSimpleGit();
    const wtGit = simpleGit(worktreePath).env(gitEnv());
    const symbolic = (
      await wtGit.revparse(['--symbolic-full-name', 'HEAD'])
    ).trim();
    if (symbolic !== 'HEAD') {
      throw new Error(`Worktree at ${worktreePath} is not detached`);
    }
    if (await this.localBranchExists(branchName)) {
      throw new Error(`Branch ${branchName} already exists`);
    }
    try {
      await wtGit.raw(['switch', '-c', branchName]);
    } catch (error) {
      // `switch -c` moves the checkout BEFORE the post-checkout hook runs.
      // If the checkout now sits on the new branch, the operation's goal
      // is achieved even though the hook threw. Compare on the bare name:
      // a same-named tag would make `--abbrev-ref` report `heads/<name>`,
      // rethrowing after a switch that actually landed.
      const now = bareBranchName(
        (
          await wtGit.revparse(['--symbolic-full-name', 'HEAD']).catch(() => '')
        ).trim(),
      );
      if (now !== branchName) throw error;
    }
  }

  /**
   * Configures `core.hooksPath` inside `worktreePath` to point at the main
   * repository's hooks directory. Prefers `.husky/` over `.git/hooks/` to
   * match the convention most JS projects use (husky's prepare script
   * configures `core.hooksPath=.husky` in the main repo).
   *
   * Skips the `git config` write subprocess when the value already
   * matches the desired one — common when this method runs against a
   * worktree that already inherits the same `core.hooksPath` from a
   * prior creation cycle. The probe read itself is still a subprocess
   * (claude-code's `parseGitConfigValue` reads the config file
   * directly to avoid even that, but the read runs once per worktree
   * creation so the extra ~14ms isn't worth the file-parsing complexity).
   */
  private async configureHooksPath(worktreePath: string): Promise<void> {
    // .husky/ is the convention for JS projects; check it first.
    const huskyPath = path.join(this.sourceRepoPath, '.husky');
    let hooksPath: string | null = null;
    try {
      await fs.stat(huskyPath);
      hooksPath = huskyPath;
    } catch (error) {
      if (!(isNodeError(error) && error.code === 'ENOENT')) {
        debugLogger.warn(
          `configureHooksPath: cannot stat ${huskyPath}: ${error}`,
        );
      }
    }

    // Fall back to the canonical hooks dir. Construct `<sourceRepoPath>/.git/hooks`
    // assumes `.git` is a directory — but when Qwen itself is launched
    // from a linked worktree, `.git` is a FILE pointing at the real
    // gitdir, and the constructed path ENOTDIRs. Use `git rev-parse
    // --git-common-dir` to get the canonical hooks parent regardless
    // of worktree/non-worktree shape. (PR #4174 review #3259975237.)
    if (!hooksPath) {
      try {
        const commonDir = (
          await (await this.getGit()).raw(['rev-parse', '--git-common-dir'])
        ).trim();
        const resolvedCommonDir = path.isAbsolute(commonDir)
          ? commonDir
          : path.resolve(this.sourceRepoPath, commonDir);
        const candidate = path.join(resolvedCommonDir, 'hooks');
        await fs.stat(candidate);
        hooksPath = candidate;
      } catch (error) {
        if (!(isNodeError(error) && error.code === 'ENOENT')) {
          debugLogger.warn(
            `configureHooksPath: cannot resolve git common hooks dir: ${error}`,
          );
        }
      }
    }
    if (!hooksPath) return;

    const { simpleGit } = await loadSimpleGit();
    const worktreeGit = simpleGit(worktreePath, {
      unsafe: { allowUnsafeHooksPath: true },
    });
    let existing = '';
    try {
      // Saves the write subprocess when value already matches. The probe
      // read is also a subprocess — claude-code skips even that via
      // parseGitConfigValue, but the read runs once per worktree
      // creation so the extra ~14ms isn't worth the file-parser tax.
      existing = (
        await worktreeGit.raw(['config', '--local', 'core.hooksPath'])
      ).trim();
    } catch {
      // Key not set — empty string means "proceed with the write".
    }
    // Only write when the key is unset. A non-empty existing value is
    // either inherited (system / global / local config from the user
    // or from a previous Qwen run) or an explicit user policy override
    // — in both cases overwriting silently replaces the user's choice.
    // (PR #4174 review #3259975242.)
    if (existing === '') {
      await worktreeGit.raw(['config', 'core.hooksPath', hooksPath]);
    } else if (existing !== hooksPath) {
      debugLogger.debug(
        `configureHooksPath: preserving existing core.hooksPath=${existing} ` +
          `(Qwen would have set it to ${hooksPath})`,
      );
    }
  }

  /**
   * Phase D-2 symlink loop. For each configured directory under the main
   * repository, creates a symbolic link from the new worktree to the
   * main-repo location (`<worktreePath>/<dir>` → `<repoRoot>/<dir>`).
   *
   * Fail-open semantics — the worktree IS already on disk and usable by
   * the time this runs, so a symlink failure must NOT abort the parent
   * `createUserWorktree` call. Per-entry failures are logged at debug or
   * warn level depending on cause:
   *
   * - **ENOENT on source** (the main repo does not have the directory):
   *   debug log, skip. Typical for users who configure `node_modules`
   *   but launch from a fresh clone where `npm install` hasn't run yet.
   * - **EEXIST on destination** (something already lives at the symlink
   *   target inside the worktree): debug log, skip. No overwrite; the
   *   existing content (whether file, dir, or stale link) wins.
   * - **Absolute path or path traversal in the configured value**:
   *   warn log, skip the entry. Configured values must stay relative to
   *   the repo root to prevent a setting from redirecting writes onto
   *   `/etc`, `~`, or anywhere outside the repo subtree.
   * - **Other I/O errors**: warn log, continue to the next entry.
   *
   * Mirrors claude-code's `symlinkDirectories` helper (utils/worktree.ts).
   */
  private async symlinkConfiguredDirectories(
    worktreePath: string,
    configured: readonly string[],
  ): Promise<void> {
    // Loop-invariant canonical paths, hoisted out of the per-entry loop.
    //
    // We must `fs.realpath` the repo root (rather than `path.resolve`,
    // which is purely lexical) so every containment check below compares
    // canonical paths to canonical paths. The post-stat `realSource =
    // fs.realpath(sourceAbs)` produces a canonical path, and on any
    // system where the repo path contains a symlink component (macOS
    // `/tmp → /private/tmp` is ubiquitous; user-symlinked source trees on
    // Linux/Windows too) the lexical `path.resolve(sourceRepoPath)` does
    // not share a prefix with that canonical realpath. Without this hoist
    // `isWithinRoot(realSource, repoRootAbs)` silently rejects EVERY
    // configured entry — cf. PR #4381 round 8 regression.
    let repoRootAbs: string;
    try {
      repoRootAbs = await fs.realpath(this.sourceRepoPath);
    } catch {
      // realpath of a non-existent / inaccessible repo root is fatal for
      // the symlink loop's containment checks (we can't validate against
      // a path we can't canonicalise). Bail out — the worktree itself is
      // already on disk so this is non-destructive; we just skip the
      // opt-in symlink step.
      debugLogger.warn(
        `symlinkConfiguredDirectories: cannot realpath sourceRepoPath "${this.sourceRepoPath}", skipping all entries`,
      );
      return;
    }
    const gitDirAbs = path.join(repoRootAbs, '.git');
    const qwenDirAbs = path.join(repoRootAbs, '.qwen');
    // Same canonical-vs-canonical requirement for the dest side. The
    // worktree was just created by `git worktree add`, so the path
    // should exist; fall back to the input path on realpath error so a
    // weird-but-extant worktree path doesn't deadlock the whole loop.
    const realWorktreePath = await fs
      .realpath(worktreePath)
      .catch(() => worktreePath);

    for (const raw of configured) {
      if (typeof raw !== 'string' || raw.length === 0) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: skipping non-string / empty entry: ${JSON.stringify(raw)}`,
        );
        continue;
      }

      // Reject absolute paths and any traversal-prone form. Resolve first
      // to catch `./foo/../../etc` style escapes that look relative.
      if (path.isAbsolute(raw)) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing absolute path "${raw}"`,
        );
        continue;
      }
      // Reject any literal `..` segment up front. The post-resolve
      // `isWithinRoot` check below would still accept `foo/../bar`
      // (resolves to `bar`, which is inside the repo), but the public
      // contract — settingsSchema description, docs/users/features/
      // worktree.md, WorktreeSettings JSDoc — promises rejection of
      // any entry containing `..`. Enforce that promise here.
      if (raw.split(/[\\/]/).includes('..')) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing path "${raw}" — contains '..' segment`,
        );
        continue;
      }
      const sourceAbs = path.resolve(repoRootAbs, raw);
      if (sourceAbs === repoRootAbs) {
        // `""` / `"."` / `"./"` etc. — pointless and would alias the
        // entire repo into itself. Reject explicitly so the path-prefix
        // checks below don't have to handle this degenerate case.
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing empty / repo-root path "${raw}"`,
        );
        continue;
      }
      if (!isWithinRoot(sourceAbs, repoRootAbs)) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing path "${raw}" — resolves outside repo root (${sourceAbs} vs ${repoRootAbs})`,
        );
        continue;
      }

      // Refuse to symlink git-internal paths into the worktree. `.git`
      // would silently break commits / status / diff inside the
      // worktree (the worktree's own gitlink file points at the parent
      // common-dir, and a symlink would shadow it). The whole `.qwen`
      // tree is also off-limits: linking `.qwen` (parent) would
      // recursively pull `.qwen/worktrees` into the new worktree,
      // recreating the loop; linking `.qwen/worktrees` directly
      // creates the same loop more obviously; and `.qwen/projects`
      // / `.qwen/tmp` are CLI metadata users have no legitimate
      // reason to share across worktrees.
      // `gitDirAbs` / `qwenDirAbs` are canonical (derived from the
      // realpath'd `repoRootAbs` hoisted above the loop), so these
      // comparisons stay consistent with the post-stat realpath check.
      if (isWithinRoot(sourceAbs, gitDirAbs)) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing git-internal path "${raw}"`,
        );
        continue;
      }
      if (isWithinRoot(sourceAbs, qwenDirAbs)) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing path "${raw}" — ` +
            `the .qwen tree is CLI-managed; symlinking any of it could ` +
            `create a worktrees-inside-worktrees loop or alias CLI metadata.`,
        );
        continue;
      }

      // Confirm the source exists. We don't insist on it being a directory
      // specifically — `node_modules` is canonically a dir, but a user
      // who wants to share a single file (`.env`, `secrets.json`) via
      // `symlinkDirectories` should still get the link.
      let sourceStat: { isDirectory: () => boolean } | null = null;
      try {
        sourceStat = await fs.stat(sourceAbs);
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          debugLogger.debug(
            `symlinkConfiguredDirectories: source missing, skipping: ${sourceAbs}`,
          );
        } else {
          debugLogger.warn(
            `symlinkConfiguredDirectories: cannot stat ${sourceAbs}: ${error}`,
          );
        }
        continue;
      }

      // Resolve through any symlinks in the source path and RE-RUN the
      // containment + blocklist checks against the realpath. The lexical
      // checks above only see `path.resolve(repoRoot, raw)` — they can't
      // tell that `<repo>/node_modules` is actually a symlink chaining
      // into `.git`, an outside dir, or `.qwen`. Without this step a
      // committed-or-out-of-band source symlink bypasses every guard the
      // lexical loop set up. Use the realpath as the symlink target so
      // the new link points canonically rather than preserving the chain.
      let realSource: string;
      try {
        realSource = await fs.realpath(sourceAbs);
      } catch (error) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: cannot realpath source "${sourceAbs}": ${error}`,
        );
        continue;
      }
      if (!isWithinRoot(realSource, repoRootAbs)) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing path "${raw}" — real source ${realSource} escapes repo root ${repoRootAbs}`,
        );
        continue;
      }
      if (isWithinRoot(realSource, gitDirAbs)) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing path "${raw}" — real source ${realSource} resolves inside .git`,
        );
        continue;
      }
      if (isWithinRoot(realSource, qwenDirAbs)) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing path "${raw}" — real source ${realSource} resolves inside .qwen`,
        );
        continue;
      }

      const destAbs = path.join(worktreePath, raw);

      // Ensure the parent directory of `destAbs` exists. For top-level
      // entries (`node_modules`) this is a no-op against the worktree
      // root, but for nested values (`tools/cache`) we may need to
      // create the intermediate dirs first — git worktree add does NOT
      // create them.
      try {
        await fs.mkdir(path.dirname(destAbs), { recursive: true });
      } catch (error) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: cannot mkdir parent of ${destAbs}: ${error}`,
        );
        continue;
      }

      // Sibling-drift defense to the round-7 source-side realpath check:
      // `path.join(worktreePath, raw)` is lexical too. If `git worktree
      // add` materialized a committed symlink under the worktree
      // (e.g. HEAD ships `tools → /etc`), then the OS-side resolution
      // of `<worktree>/tools/cache` traverses through the committed
      // symlink and our `fs.mkdir` / `fs.symlink` write OUTSIDE the
      // worktree. Realpath the dest parent and refuse if it escapes.
      let realDestParent: string;
      try {
        realDestParent = await fs.realpath(path.dirname(destAbs));
      } catch (error) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: cannot realpath dest parent for "${raw}" (${path.dirname(destAbs)}): ${error}`,
        );
        continue;
      }
      if (!isWithinRoot(realDestParent, realWorktreePath)) {
        debugLogger.warn(
          `symlinkConfiguredDirectories: refusing path "${raw}" — dest parent ${realDestParent} escapes worktree root ${realWorktreePath} (committed-symlink chain)`,
        );
        continue;
      }

      // `fs.symlink` rejects with EEXIST when the destination already
      // exists. Treat that as "user already populated this slot, leave
      // it alone" — same as claude-code's behavior.
      try {
        // On Windows, `fs.symlink(..., 'dir')` requires
        // SeCreateSymbolicLinkPrivilege (administrator rights, or
        // Developer Mode + unprivileged-symlink-creation enabled) and
        // EPERMs on default consumer installs. A junction is a reparse
        // point that achieves the same "this path resolves over there"
        // semantics for directories without elevation. `'file'` symlinks
        // on Windows also need the same privilege but there's no
        // junction-equivalent for files, so we leave `'file'` as-is and
        // accept the EPERM fall-through for the rare file-symlink case.
        const symlinkType = sourceStat.isDirectory()
          ? process.platform === 'win32'
            ? 'junction'
            : 'dir'
          : 'file';
        // Point at the canonical realpath rather than the lexical
        // `sourceAbs` so the new link is one-hop and doesn't preserve
        // the chain we just validated.
        await fs.symlink(realSource, destAbs, symlinkType);
        debugLogger.debug(
          `symlinkConfiguredDirectories: linked ${destAbs} → ${realSource} (${symlinkType})`,
        );
      } catch (error) {
        if (isNodeError(error) && error.code === 'EEXIST') {
          debugLogger.debug(
            `symlinkConfiguredDirectories: destination exists, skipping: ${destAbs}`,
          );
        } else {
          debugLogger.warn(
            `symlinkConfiguredDirectories: failed to link ${destAbs} → ${realSource}: ${error}`,
          );
        }
      }
    }
  }

  /**
   * Returns true if a local branch with the given name exists.
   *
   * Uses `for-each-ref` because `simple-git.raw` swallows the non-zero
   * exit of `show-ref --quiet` and always resolves with empty stdout —
   * so the previous `show-ref` form would always return `true` and
   * permanently block worktree creation. `for-each-ref` instead prints
   * the ref name when it exists and prints nothing when it does not,
   * always exiting 0, so we can decide on the output.
   *
   * Conservative on error: returns false so the caller's "not exists"
   * fast path attempts the create (which itself will fail loudly if the
   * branch exists for some reason this check missed).
   */
  async localBranchExists(branchName: string): Promise<boolean> {
    try {
      const out = await (
        await this.getGit()
      ).raw([
        'for-each-ref',
        '--count=1',
        '--format=%(refname)',
        `refs/heads/${branchName}`,
      ]);
      return out.trim().length > 0;
    } catch (error) {
      // Defensive default: if we cannot tell, assume the branch is
      // absent so the create attempt fires. Worst case `git worktree
      // add -b` itself errors out on the duplicate. But log so the
      // root cause (disk full, permission, ref-store corruption) shows
      // up in debug output instead of being invisible.
      debugLogger.warn(`localBranchExists failed for ${branchName}: ${error}`);
      return false;
    }
  }

  /**
   * Ignores the managed worktrees directory through the repository's
   * `info/exclude`, idempotently. The rule must not live in a checkout
   * file: a daemon-written `.qwen/.gitignore` is itself untracked work,
   * which made the handoff's local-clean gate refuse every pristine
   * checkout and the cleanup's has-work gate preserve every clean
   * worktree. `info/exclude` keeps `git status` clean without adding an
   * entry of its own. A pattern containing a slash anchors at the repo
   * root, so the rule is computed relative to the repository top — a
   * service rooted at a subdirectory ignores its own `.qwen/worktrees`.
   */
  private async ensureWorktreesGitignored(): Promise<void> {
    try {
      await this.ensureWorktreesExcludeRule();
      await this.migrateLegacyWorktreeGitignore();
    } catch (error) {
      // Best-effort: if writing the exclude fails (read-only fs, etc.)
      // it is not worth aborting the worktree creation.
      debugLogger.warn(
        `ensureWorktreesGitignored failed (non-fatal): ${error}`,
      );
    }
  }

  /**
   * Writes and verifies the `info/exclude` rule only — no legacy
   * migration. The migration calls this before unlinking the old file so
   * the replacement exists before the old mechanism is removed. Returns
   * true only when the rule is in force; the migration must keep the
   * legacy file when this returns false (unrepresentable path or a rule
   * git does not honor), or the checkout loses its only hiding mechanism.
   */
  private async ensureWorktreesExcludeRule(): Promise<boolean> {
    const git = await this.getGit();
    const excludeRel = (
      await git.raw(['rev-parse', '--git-path', 'info/exclude'])
    ).trim();
    const excludePath = path.resolve(this.sourceRepoPath, excludeRel);
    // Canonicalize both sides: git reports a physical toplevel, and a
    // symlinked service root would otherwise produce a ../-prefixed
    // (malformed) relative rule.
    const realRoot = await fs
      .realpath(this.sourceRepoPath)
      .catch(() => this.sourceRepoPath);
    const repoTop =
      (await this.getRepoTopLevel().catch(() => null)) ?? realRoot;
    const rel = path.relative(
      repoTop,
      path.join(realRoot, '.qwen', WORKTREES_DIR),
    );
    // The rule is a gitignore pattern, not a path: escape the pattern
    // metacharacters per segment (a route directory like app/[id]
    // would otherwise become a character class matching nothing).
    // A line-based pattern cannot represent newline-bearing components
    // or an out-of-root target; skip and log instead of writing garbage.
    // Test for an actual parent segment, not a '..' prefix: an in-root
    // directory named '..cache' is legal and must still get a rule.
    const segments = rel.split(path.sep);
    if (
      rel === '..' ||
      rel.startsWith(`..${path.sep}`) ||
      path.isAbsolute(rel) ||
      segments.some((s) => /[\n\r]/.test(s))
    ) {
      debugLogger.warn(
        `ensureWorktreesGitignored: cannot represent ${rel} as an exclude rule; skipping`,
      );
      return false;
    }
    const escaped = segments
      .map((s) =>
        s
          .replace(/[\\*?[\]#!]/g, '\\$&')
          .replace(/ +$/, (m) => m.replace(/ /g, '\\ ')),
      )
      .join('/');
    const rule = `/${escaped}/`;
    let existing = '';
    try {
      existing = await fs.readFile(excludePath, 'utf8');
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    }
    if (!existing.split('\n').some((line) => line.trim() === rule)) {
      await fs.mkdir(path.dirname(excludePath), { recursive: true });
      const prefix =
        existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
      await fs.appendFile(excludePath, `${prefix}${rule}\n`, 'utf8');
    }
    // Verify against git itself that the rule JUST WRITTEN is the one in
    // force. A bare `check-ignore -q` is vacuous twice over: it exits 1
    // with no output when the path is not ignored (simple-git's default
    // detector resolves that, so a `.then(() => true)` always wins), and it
    // answers whether ANY source ignores the path — a higher-priority
    // per-directory `.gitignore` (e.g. `.qwen/*` + `!.qwen/worktrees/`)
    // would answer for the info/exclude rule and let the migration unlink
    // the only effective hiding mechanism. Use `-v` and accept only a
    // verdict whose source is this exclude file and whose pattern is the
    // rule. Forward slashes: a win32 native path would read as an escaped
    // pathspec. Probe a FILE path, not the directory: a directory-form
    // re-include negation only applies to paths git knows are directories.
    const probe = path
      .join(realRoot, '.qwen', WORKTREES_DIR, 'probe')
      .split(path.sep)
      .join('/');
    // The legacy daemon .qwen/.gitignore outranks info/exclude and is the
    // very file the migration removes, so verify with it temporarily moved
    // aside — otherwise it answers for the rule just written and the probe
    // can never attribute the match to info/exclude. A user-curated
    // .gitignore (any other content) is left in place: if it outranks the
    // rule (e.g. re-includes the worktrees path), the rule is powerless and
    // the migration must keep the legacy file.
    const legacyGitignore = path.join(
      this.sourceRepoPath,
      '.qwen',
      '.gitignore',
    );
    let legacyMoved: string | null = null;
    const legacyContent = await fs
      .readFile(legacyGitignore, 'utf8')
      .catch(() => null);
    if (
      legacyContent === `# Auto-generated by qwen-code.\n${WORKTREES_DIR}/\n`
    ) {
      const moved = `${legacyGitignore}.probe-tmp`;
      try {
        await fs.rename(legacyGitignore, moved);
        legacyMoved = moved;
      } catch {
        // Leave it in place; the probe below will attribute conservatively.
      }
    }
    let verdict = '';
    try {
      verdict = (
        await git.raw(['check-ignore', '-v', '--', probe]).catch(() => '')
      ).trim();
    } finally {
      if (legacyMoved !== null) {
        await fs.rename(legacyMoved, legacyGitignore).catch(() => undefined);
      }
    }
    // Format: "<source>:<linenum>:<pattern>\t<path>". Parse from the right
    // (a win32 drive letter and the pattern itself can contain ':'); the
    // line number is the numeric anchor.
    const match = /^(.*):(\d+):(.*)$/.exec(verdict.split('\t')[0]);
    const realExclude = await fs.realpath(excludePath).catch(() => excludePath);
    // git reports the source relative to its cwd (the repo top), e.g.
    // ".git/info/exclude"; resolve it there before comparing realpaths.
    const reportedSource = match
      ? await fs
          .realpath(path.resolve(repoTop, match[1]))
          .catch(() => path.resolve(repoTop, match[1]))
      : null;
    // Attribute by SOURCE, not by exact pattern: git reports only the first
    // matching pattern, so a broader rule already in this exclude file
    // (e.g. an older `.qwen/`) answers for the probe even though the rule
    // just written also matches. The path is ignored by this file either
    // way, so the migration may complete; requiring pattern equality would
    // strand the legacy file in that shape. A verdict sourced from any
    // OTHER file (a user .gitignore re-include) still fails.
    if (!match || reportedSource !== realExclude) {
      debugLogger.warn(
        `ensureWorktreesGitignored: rule ${rule} does not ignore the worktrees directory`,
      );
      return false;
    }
    return true;
  }

  /**
   * Drop the daemon-generated `.qwen/.gitignore` when it is byte-exactly
   * ours and UNTRACKED, so checkouts provisioned by an earlier build stop
   * reading as dirty. A tracked file (the user committed it) or any other
   * content is the user's and stays. Called at provisioning and on the
   * handoff paths, which an upgraded checkout may reach without creating
   * a new worktree first.
   */
  async migrateLegacyWorktreeGitignore(): Promise<void> {
    try {
      const legacyGitignore = path.join(
        this.sourceRepoPath,
        '.qwen',
        '.gitignore',
      );
      const content = await fs.readFile(legacyGitignore, 'utf8');
      if (content !== `# Auto-generated by qwen-code.\n${WORKTREES_DIR}/\n`) {
        return;
      }
      const git = await this.getGit();
      // A git pathspec, not a filesystem path: path.join would produce
      // backslashes on win32, which git parses as escapes, matching
      // nothing and unlinking a file the user committed.
      const tracked = await git.raw(['ls-files', '--', '.qwen/.gitignore']);
      if (tracked.trim().length === 0) {
        // Establish the info/exclude replacement BEFORE removing the old
        // mechanism: an upgraded checkout whose worktree predates the
        // exclude rule would otherwise read as dirty the moment the
        // legacy file is gone, and the handoff's clean gate would refuse
        // every handoff with local_checkout_dirty. When the rule cannot
        // be established (unrepresentable path, or git does not honor
        // it), keep the legacy file — it is still the only mechanism
        // hiding the managed directory.
        const established = await this.ensureWorktreesExcludeRule();
        if (established) {
          await fs.unlink(legacyGitignore);
        }
      }
    } catch {
      // Absent or unreadable: nothing to migrate.
    }
  }

  /**
   * Removes a user worktree, optionally deleting its branch.
   *
   * Branch deletion uses `-d` by default (refuses to drop branches that
   * have commits not merged into HEAD), so a worktree whose tree was
   * left "clean" because the agent committed its work doesn't lose
   * those commits when the cleanup helper sweeps it. Set
   * `forceDeleteBranch: true` to bypass — callers must have already
   * confirmed there is nothing of value on the branch.
   */
  async removeUserWorktree(
    slug: string,
    options: {
      deleteBranch?: boolean;
      forceDeleteBranch?: boolean;
      /** The slug-derived branch was created by this worktree's named
       * creation (which refuses a pre-existing ref), so it is owned even
       * if the checkout later moved to another branch. Without this,
       * ownership is inferred from the checkout's current branch — safe
       * for detached and in-place-branched session worktrees, which never
       * created the slug ref. */
      branchOwned?: boolean;
      /** The commit the worktree was created at. Lets the detached guard
       * tell "the agent committed here" from "the base itself is
       * unreachable" (a tag checkout, or a branch since moved/deleted). */
      baseCommit?: string;
    } = {},
  ): Promise<{
    success: boolean;
    error?: string;
    branchPreserved?: boolean;
    /** The slug branch was not deleted (the checkout never owned it, or
     * the delete was refused). Distinct from branchPreserved, which means
     * the checkout itself survived. */
    branchSkipped?: boolean;
    /** The branch this call actually deleted, if any. Callers report from
     * this, not from the slug name. */
    deletedBranch?: string;
    /** A branch that survives this call and holds the work (the checkout's
     * own branch, or the slug ref when kept), if any. */
    keptBranch?: string;
  }> {
    const worktreePath = this.getUserWorktreePath(slug);
    const branchName = worktreeBranchForSlug(slug);
    // Refuse to remove a checkout that EXISTS but cannot be verified as a
    // registered worktree of this repo (R11-18). With the `.git` link missing,
    // git's upward discovery answers for the ENCLOSING repo: the detached
    // probe reads false, the unmerged-commits guard is skipped, and the
    // removal's fs.rm fallback would destroy commits only this checkout holds.
    // The registered-worktree probe (common-dir + toplevel) returns null in
    // that state, so fail closed. A directory already gone is a legitimate
    // no-op the removal flow below handles (branchSkipped), not a refusal.
    const checkoutPresent = await fs
      .stat(worktreePath)
      .then(() => true)
      .catch(() => false);
    if (
      checkoutPresent &&
      (await this.getRegisteredWorktreeBranch(worktreePath)) === null
    ) {
      return {
        success: false,
        error: 'Worktree checkout is unverifiable',
      };
    }
    const detached = await this.isDetachedWorktree(worktreePath);
    // Capture the branch the checkout actually sits on BEFORE removal.
    // A session worktree branched in place ("Create branch here") is no
    // longer detached, but it never owned the slug-derived name either —
    // keying the delete off the current detached state alone would let a
    // pre-existing user `worktree-<slug>` be deleted once it merges.
    const actualBranch = detached
      ? ''
      : await this.getWorktreeBranchName(worktreePath);

    // A detached worktree has no branch whose safe-delete refusal would
    // protect committed work: the `git branch -d` below can never fire for
    // it, and removing the checkout would leave the agent's commits
    // unreachable. Refuse the removal itself when HEAD carries commits of
    // its own that no other ref reaches — the detached counterpart of the
    // named-branch protection. An explicit force delete opts out.
    if (
      options.deleteBranch &&
      !options.forceDeleteBranch &&
      detached &&
      (await this.hasUnmergedWorktreeCommits(slug, options.baseCommit))
    ) {
      return {
        success: false,
        error: 'Worktree has unmerged commits',
        branchPreserved: true,
      };
    }

    const removed = await this.removeWorktree(worktreePath);
    if (!removed.success) {
      return removed;
    }

    if (!options.deleteBranch) {
      return { success: true };
    }

    // A named creation provably owns its slug ref (creation refuses a
    // pre-existing branch), even when the checkout later moved away. An
    // explicit `branchOwned: false` (a detached/in-place session worktree,
    // whose sidecar records no slug branch) is authoritative: such a
    // worktree never created the slug ref, so even if it was later switched
    // in place onto a user-created `worktree-<slug>` branch, that ref belongs
    // to its creator and must be kept — the current branch must not override
    // the recorded ownership (6890579653). The current-branch fallback only
    // applies when the caller did not record ownership at all.
    const ownsSlugBranch =
      options.branchOwned === true ||
      (options.branchOwned === undefined && actualBranch === branchName);
    const keptOther =
      actualBranch !== '' && actualBranch !== branchName
        ? actualBranch
        : undefined;
    if (!ownsSlugBranch) {
      const slugRefExists = await this.localBranchExists(branchName);
      const kept = keptOther ?? (slugRefExists ? branchName : undefined);
      return {
        success: true,
        branchSkipped: slugRefExists || keptOther !== undefined,
        ...(kept !== undefined ? { keptBranch: kept } : {}),
      };
    }

    // A detached worktree (Codex-style managed session) has no branch to
    // delete; neither does a named worktree whose branch is already gone.
    if (!(await this.localBranchExists(branchName))) {
      return {
        success: true,
        ...(keptOther !== undefined ? { keptBranch: keptOther } : {}),
      };
    }

    // Try a safe (non-force) delete first. `git branch -d` refuses to
    // remove branches whose tip is not reachable from HEAD or any
    // upstream — preserving any commits the subagent made before
    // ending with a clean working tree.
    const git = await this.getGit();
    try {
      await git.branch(['-d', branchName]);
      return {
        success: true,
        deletedBranch: branchName,
        ...(keptOther !== undefined ? { keptBranch: keptOther } : {}),
      };
    } catch (error) {
      // Refused either because the branch carries unmerged commits
      // (the common case, handled below by surfacing `branchPreserved`)
      // or because of a real failure (locked ref, permissions, disk
      // full). Log so the caller's "branch preserved" message can be
      // cross-referenced with a concrete reason.
      debugLogger.warn(
        `removeUserWorktree: safe branch delete failed for ${branchName}: ${error}`,
      );
    }

    if (options.forceDeleteBranch) {
      try {
        await git.branch(['-D', branchName]);
        return {
          success: true,
          deletedBranch: branchName,
          ...(keptOther !== undefined ? { keptBranch: keptOther } : {}),
        };
      } catch (error) {
        // Best-effort: branch may have been deleted already, or may not
        // exist (a no-op). Still log because a true filesystem error
        // would otherwise be invisible.
        debugLogger.warn(
          `removeUserWorktree: force branch delete failed for ${branchName}: ${error}`,
        );
      }
    }

    // Reached here when the branch had unmerged commits and the caller
    // did not opt into force-delete. Surface this so callers can leave
    // a note for the user.
    return { success: true, branchPreserved: true, keptBranch: branchName };
  }

  /**
   * Remove a prepared (never-attached) worktree. The forced removal is
   * safe only under the caller guarantees enforced here: the marker names
   * `expectedOwner` (or is absent for a null owner), HEAD never left
   * `expectedBaseCommit` (no agent commit exists), and the cleanliness
   * gate exempts ONLY `carriedPaths` — the exact overlay the creation
   * carried, which the source checkout still holds. Any other file
   * refuses the removal. Callers: the branch-worktree route cleanup and
   * the startup journal recovery, both passing the journal's
   * `carriedPaths` and `worktreeBranch !== ''` ownership.
   */
  async removePreparedUserWorktree(
    slug: string,
    expectedOwner: string | null,
    expectedBaseCommit: string,
    onWorktreeRemoved?: () => Promise<void>,
    branchOwned = true,
    carriedPaths?: readonly string[],
  ): Promise<{
    success: boolean;
    error?: string;
    branchPreserved?: boolean;
  }> {
    const expectedPath = this.getUserWorktreePath(slug);
    let worktreePath: string;
    try {
      worktreePath = await fs.realpath(expectedPath);
      const initialPathStat = await fs.lstat(worktreePath);
      const canonicalRepo = await fs.realpath(this.sourceRepoPath);
      const canonicalExpectedPath = path.join(
        canonicalRepo,
        '.qwen',
        WORKTREES_DIR,
        slug,
      );
      if (
        !initialPathStat.isDirectory() ||
        worktreePath !== canonicalExpectedPath
      ) {
        return { success: false, error: 'Worktree path identity changed' };
      }
      const markerPath = path.join(worktreePath, WORKTREE_SESSION_FILE);
      // Complete the interrupted publish's last step before the
      // cleanliness gates: a crash between the marker's link and its
      // post-commit unlink leaves `.qwen-session` (and the staged sibling)
      // untracked with no info/exclude rule, which both `git status` and
      // `git worktree remove` treat as blocking content. The path-identity
      // check above proves this is the daemon-managed worktree, and the
      // anchored rule names only the daemon's own bookkeeping files.
      await ensureWorktreeSessionMarkerExcluded(worktreePath);
      const markerMatches = async () => {
        if (expectedOwner === null) {
          return await fs
            .lstat(markerPath)
            .then(() => false)
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return true;
              throw error;
            });
        }
        // Read-only owner comparison, so no nlink gate (unlike the
        // write paths): the publisher's link-then-unlink leaves the marker
        // at nlink 2 permanently after a crash, with complete fsync'd
        // content. Removal unlinks names and never writes through the
        // inode, so that residue must still match its owner — refusing it
        // would make the crash residue impossible to clean up.
        const markerStat = await fs.lstat(markerPath);
        if (!markerStat.isFile()) return false;
        const owner = await readWorktreeSessionMarker(worktreePath);
        return owner === expectedOwner;
      };
      if (!(await markerMatches())) {
        return { success: false, error: 'Worktree marker owner changed' };
      }
      const { simpleGit } = await loadSimpleGit();
      const worktreeGit = simpleGit(worktreePath).env(gitEnv());
      const trackedMarker = await worktreeGit.raw([
        'ls-files',
        '-z',
        '--',
        WORKTREE_SESSION_FILE,
      ]);
      if (trackedMarker.length > 0) {
        return { success: false, error: 'Worktree marker is tracked' };
      }
      const checkoutMatches = async () => {
        const [head, branch] = await Promise.all([
          worktreeGit.revparse(['HEAD']),
          worktreeGit.revparse(['--abbrev-ref', 'HEAD']),
        ]);
        // A detached managed worktree reports 'HEAD'; a named one must
        // still sit on its own worktree-<slug> branch.
        return (
          head.trim() === expectedBaseCommit &&
          (branch.trim() === 'HEAD' ||
            branch.trim() === worktreeBranchForSlug(slug))
        );
      };
      // The worktree still sits at the base commit: named worktrees are
      // pinned by their branch ref, detached ones by HEAD itself.
      const atBase = async () => {
        const branch = (
          await worktreeGit.revparse(['--abbrev-ref', 'HEAD'])
        ).trim();
        if (branch === 'HEAD') {
          return (
            (await worktreeGit.revparse(['HEAD'])).trim() === expectedBaseCommit
          );
        }
        return (
          (await this.getPreparedUserWorktreeBranchTip(slug)) ===
          expectedBaseCommit
        );
      };
      if (!(await checkoutMatches())) {
        return { success: false, error: 'Worktree checkout changed' };
      }
      const hasPopulatedGitlink = async () => {
        const index = await worktreeGit.raw(['ls-files', '--stage', '-z']);
        for (const entry of index.split('\0')) {
          if (!entry.startsWith('160000 ')) continue;
          const separator = entry.indexOf('\t');
          if (separator < 0) return true;
          const gitlinkPath = path.resolve(
            worktreePath,
            entry.slice(separator + 1),
          );
          if (
            gitlinkPath === worktreePath ||
            !gitlinkPath.startsWith(`${worktreePath}${path.sep}`)
          ) {
            return true;
          }
          const populated = await fs
            .lstat(gitlinkPath)
            .then(async (stat) => {
              if (!stat.isDirectory()) return true;
              return (await fs.readdir(gitlinkPath)).length > 0;
            })
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return false;
              throw error;
            });
          if (populated) return true;
        }
        return false;
      };
      // A prepared worktree is created with carryDirtyState and never
      // attached: its dirty content is the carried overlay, a copy of
      // state the source checkout still holds, and the atBase /
      // checkoutMatches gates below prove no commit was added. A plain
      // cleanliness gate could therefore never pass for a dirty source
      // and would strand the worktree + journal forever. The overlay is
      // exempt — but ONLY the exact carried paths: any other file (a
      // nested marker-like name, a late-arriving ignored file) still
      // refuses the removal.
      const exempt = new Set(carriedPaths ?? []);
      const isClean = async () => {
        // -z keeps raw bytes: line-based output C-quotes non-ASCII,
        // quotes, and newlines (core.quotepath), and the quoted form
        // would never match the raw carried paths in the exemption set.
        const status = await worktreeGit.raw([
          'status',
          '--porcelain',
          '--untracked-files=all',
          '-z',
        ]);
        for (const entry of status.split('\0')) {
          if (entry.length === 0) continue;
          // The carry applies the stash without --index, so the overlay
          // never contains rename/copy records; one means the index was
          // touched inside this never-attached worktree. Refuse.
          if (entry[0] === 'R' || entry[0] === 'C') return false;
          if (!exempt.has(entry.slice(3))) return false;
        }
        if (await hasHiddenIndexBit(worktreePath)) return false;
        if (await hasPopulatedGitlink()) return false;
        // clean -ndx has no -z form and collapses untracked directories
        // to "dir/", which never matches the file-level carried paths.
        // ls-files --others lists raw file-level paths, ignored ones
        // included — a late-arriving ignored file must still refuse.
        const others = await worktreeGit.raw(['ls-files', '--others', '-z']);
        return others
          .split('\0')
          .every(
            (p) =>
              p.length === 0 ||
              exempt.has(p) ||
              p === WORKTREE_SESSION_FILE ||
              WORKTREE_SESSION_TMP_PATTERN.test(p),
          );
      };
      if (!(await isClean())) {
        return { success: false, error: 'Worktree contains changes' };
      }
      if (!(await atBase())) {
        return { success: false, error: 'Worktree branch changed' };
      }
      if (!(await isClean())) {
        return { success: false, error: 'Worktree contains changes' };
      }
      if (!(await atBase())) {
        return { success: false, error: 'Worktree branch changed' };
      }
      const finalPath = await fs.realpath(expectedPath);
      const finalPathStat = await fs.lstat(finalPath);
      if (
        finalPath !== worktreePath ||
        !finalPathStat.isDirectory() ||
        finalPathStat.dev !== initialPathStat.dev ||
        finalPathStat.ino !== initialPathStat.ino
      ) {
        return { success: false, error: 'Worktree path identity changed' };
      }
      if (!(await markerMatches())) {
        return { success: false, error: 'Worktree marker owner changed' };
      }
      if (!(await checkoutMatches())) {
        return { success: false, error: 'Worktree checkout changed' };
      }
      const git = await this.getGit();
      // The gates above proved ownership and that HEAD never left the
      // base; the dirty content is the carried overlay, a copy of state
      // the source checkout still holds. git itself would refuse a dirty
      // tree without --force, stranding the worktree and its journal.
      await git.raw(['worktree', 'remove', worktreePath, '--force']);
      await onWorktreeRemoved?.();
      return await this.finalizePreparedUserWorktreeBranch(
        slug,
        expectedBaseCommit,
        branchOwned,
      );
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async isPreparedUserWorktreeRegistered(slug: string): Promise<boolean> {
    const expectedPath = path.resolve(this.getUserWorktreePath(slug));
    const output = await (
      await this.getGit()
    ).raw(['worktree', 'list', '--porcelain', '-z']);
    return output
      .split('\0')
      .some(
        (record) =>
          record.startsWith('worktree ') &&
          path.resolve(record.slice('worktree '.length)) === expectedPath,
      );
  }

  async getPreparedUserWorktreeBranchTip(slug: string): Promise<string | null> {
    const branchName = worktreeBranchForSlug(slug);
    const output = await (
      await this.getGit()
    ).raw([
      'for-each-ref',
      '--count=1',
      '--format=%(objectname)',
      `refs/heads/${branchName}`,
    ]);
    return output.trim() || null;
  }

  async finalizePreparedUserWorktreeBranch(
    slug: string,
    expectedBaseCommit: string,
    branchOwned = true,
  ): Promise<{
    success: boolean;
    error?: string;
    branchPreserved?: boolean;
  }> {
    try {
      // A detached preparation never created the slug-derived branch: a
      // pre-existing ref of that name belongs to the user, even when its
      // tip happens to sit at the base commit.
      if (!branchOwned) return { success: true };
      const branchTip = await this.getPreparedUserWorktreeBranchTip(slug);
      if (branchTip === null) return { success: true };
      if (branchTip !== expectedBaseCommit) {
        return { success: true, branchPreserved: true };
      }
      try {
        await (await this.getGit()).branch(['-d', worktreeBranchForSlug(slug)]);
        return { success: true };
      } catch {
        return { success: true, branchPreserved: true };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Whether the checkout at `worktreePath` is in detached HEAD. A missing
   * or unreadable checkout reads as not detached: the removal path then
   * fails or proceeds on its own filesystem merits.
   */
  private async isDetachedWorktree(worktreePath: string): Promise<boolean> {
    try {
      const { simpleGit } = await loadSimpleGit();
      const abbrev = (
        await simpleGit(worktreePath)
          .env(gitEnv())
          .revparse(['--abbrev-ref', 'HEAD'])
      ).trim();
      return abbrev === 'HEAD';
    } catch {
      return false;
    }
  }

  /**
   * The branch the checkout sits on ('' when detached or unreadable).
   * An unreadable checkout answers '' so ownership-keyed deletes stay
   * conservative: no branch is deleted on its behalf. Uses the full ref so a
   * same-named tag does not qualify the name as `heads/<name>` and break the
   * ownership comparison against the bare slug branch (same root cause as the
   * handoff trust-gate normalization).
   */
  private async getWorktreeBranchName(worktreePath: string): Promise<string> {
    try {
      const { simpleGit } = await loadSimpleGit();
      const symbolic = (
        await simpleGit(worktreePath)
          .env(gitEnv())
          .revparse(['--symbolic-full-name', 'HEAD'])
      ).trim();
      return symbolic === 'HEAD' ? '' : bareBranchName(symbolic);
    } catch {
      return '';
    }
  }

  /**
   * Reports whether the tip of a user worktree's branch is reachable
   * only from itself — i.e. the branch carries commits that no other
   * local branch or remote ref points at, so dropping the branch would
   * silently destroy them. Used by callers that want to decide whether
   * removing the worktree would lose work the subagent committed but
   * never merged or pushed.
   *
   * With the creation `baseCommit` in hand, a detached HEAD still at (or
   * behind) that base carries no agent commits — even when the base
   * itself is unreachable from any branch (a tag checkout, or a branch
   * since moved/deleted), which the reachability test alone would
   * misread as unmerged work.
   *
   * Fail-closed: returns `true` on any git error so the caller defaults
   * to preserving rather than destroying the worktree.
   */
  async hasUnmergedWorktreeCommits(
    slug: string,
    baseCommit?: string,
  ): Promise<boolean> {
    const branchName = worktreeBranchForSlug(slug);
    try {
      const git = await this.getGit();
      // Judge whether REMOVAL would lose commits. Removal deletes the
      // checkout directory and (when owned) the slug-derived ref
      // worktree-<slug> — never a user branch the checkout was switched to
      // ("Create branch here", `git switch -c`). So the ref to exclude from
      // the reachability test is the slug ref, not the checkout's current
      // branch: a checkout sitting on feat/x keeps feat/x after removal,
      // and feat/x covering the tip means nothing is lost. When the
      // checkout is unreadable (already removed, etc.), fall back to the
      // slug ref below.
      let ownRef: string | null = null;
      let tipSha = '';
      try {
        const { simpleGit } = await loadSimpleGit();
        const wtGit = simpleGit(this.getUserWorktreePath(slug)).env(gitEnv());
        const abbrev = (await wtGit.revparse(['--abbrev-ref', 'HEAD'])).trim();
        tipSha = (await wtGit.revparse(['HEAD'])).trim();
        // The creation-base shortcut applies to EVERY shape: a checkout
        // still at (or behind) its creation base added no commits, even
        // when the base is unreachable from any branch (a tag checkout, or
        // a branch since moved/deleted).
        if (baseCommit && tipSha) {
          if (tipSha === baseCommit) return false;
          const count = (
            await wtGit
              .raw(['rev-list', '--count', `${baseCommit}..HEAD`])
              .catch(() => '')
          ).trim();
          if (count === '0') return false;
        }
        if (abbrev !== 'HEAD') {
          ownRef = `refs/heads/${branchName}`;
        }
      } catch {
        // Fall through to the branch-ref probe.
      }
      if (!tipSha) {
        tipSha = (await git.revparse([branchName])).trim();
        ownRef = `refs/heads/${branchName}`;
      }
      if (!tipSha) return true;
      // List every local branch and remote-tracking ref whose tip is at
      // or above the worktree's tip. If anything other than the slug ref
      // removal may delete appears, the commits are covered. A detached
      // HEAD has no own ref to exclude.
      const refs = (
        await git.raw([
          'for-each-ref',
          '--contains',
          tipSha,
          '--format=%(refname)',
          'refs/heads',
          'refs/remotes',
        ])
      )
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s !== ownRef);
      return refs.length === 0;
    } catch (error) {
      // Fail-closed but log so a corrupted ref store or permission
      // problem can be diagnosed: without this, callers see the
      // conservative "has unmerged commits" reply with no clue about
      // the underlying git failure.
      debugLogger.warn(
        `hasUnmergedWorktreeCommits failed for slug ${slug}: ${error}`,
      );
      return true;
    }
  }

  /**
   * Reports whether a worktree has uncommitted tracked changes (staged or
   * unstaged) or untracked files. Used by `ExitWorktreeTool` to refuse
   * `remove` when the user has work in progress.
   *
   * Fail-closed: returns `true` on any git error so the caller assumes the
   * worktree is dirty rather than risking data loss.
   */
  async hasWorktreeChanges(worktreePath: string): Promise<boolean> {
    try {
      // `--no-optional-locks` keeps the read from refreshing and writing the
      // index, so a tree-shipped `.git/hooks/post-index-change` never runs and
      // the probe stays a pure read. The flag is carried in argv — not via
      // simple-git's `.env('GIT_OPTIONAL_LOCKS', '0')`, whose two-arg form
      // *replaces* the child environment (dropping PATH/HOME and hiding the
      // global `core.excludesFile` / `safe.directory`).
      const { stdout } = await execFileAsync(
        'git',
        [
          ...NO_EXEC_CONFIG,
          '--no-optional-locks',
          'status',
          '--porcelain',
          '--untracked-files=all',
        ],
        {
          cwd: worktreePath,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      // Porcelain v1 emits one line per change (`XY path`); any line — tracked
      // (` M`), untracked (`??`), or conflicted (`UU`) — means the worktree is
      // not clean.
      return stdout.trim().length > 0;
    } catch {
      return true;
    }
  }

  /**
   * Counts uncommitted file changes in a worktree. Returns null if the
   * worktree can't be inspected (which the caller should treat as "dirty").
   */
  async countWorktreeChanges(
    worktreePath: string,
  ): Promise<{ tracked: number; untracked: number } | null> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        [
          ...NO_EXEC_CONFIG,
          '--no-optional-locks',
          'status',
          '--porcelain',
          '--untracked-files=all',
        ],
        {
          cwd: worktreePath,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      let tracked = 0;
      let untracked = 0;
      // Porcelain v1: each change line begins with a two-char status code.
      // `??` is untracked; every other code is a tracked change — staged,
      // unstaged, renamed, or conflicted (`UU` and friends, which porcelain v1
      // emits as ordinary lines, so the mid-merge case the previous simple-git
      // enumeration already covered stays covered).
      for (const line of stdout.split('\n')) {
        if (line.length === 0) continue;
        if (line.startsWith('??')) {
          untracked += 1;
        } else {
          tracked += 1;
        }
      }
      return { tracked, untracked };
    } catch {
      return null;
    }
  }
}
