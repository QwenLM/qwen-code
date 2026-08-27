/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Startup-time worktree setup for the `--worktree` CLI flag (Phase D-1).
 *
 * Runs after argv parsing and before `loadCliConfig()` / `Config` construction
 * so the resulting `process.cwd()` change feeds directly into the Config's
 * `targetDir`. Three entry forms are supported (see {@link setupStartupWorktree}):
 *
 * - Empty string (bare `--worktree`) → auto-generated `{adj}-{noun}-{6hex}` slug
 * - Plain slug (`--worktree my-feature`) → that exact slug
 * - PR reference (`--worktree=#123`, `--worktree https://github.com/o/r/pull/123`)
 *   → slug `pr-<N>`, fetched via `git fetch origin pull/<N>/head` and based
 *   off `FETCH_HEAD` (Phase D-3).
 *
 * Sidecar writing and `--resume` override accounting are NOT handled here —
 * those need a constructed `Config` and live in {@link persistStartupWorktreeSidecar}.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  createDebugLogger,
  GitWorktreeService,
  readWorktreeSession,
  readWorktreeSessionMarker,
  isSessionRuntimeActive,
  worktreeBranchForSlug,
  writeWorktreeSession,
  writeWorktreeSessionMarker,
} from '@qwen-code/qwen-code-core';
import type { Config, WorktreeSession } from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('WORKTREE_STARTUP');
const STARTUP_REATTACH_MARKER = 'qwen-startup-reattach.json';

/**
 * `git rev-parse --abbrev-ref HEAD` returns this literal when the
 * launch cwd has a detached HEAD checked out. Two related uses:
 *
 * 1. As an INPUT filter when normalizing `getCurrentBranch` output:
 *    we treat `'HEAD'` as "no real branch" and collapse to `undefined`
 *    so detached-state propagates uniformly through the slug/baseRef
 *    pipeline.
 * 2. As the FALLBACK metadata string written to the sidecar's
 *    `originalBranch` field when the launch state was detached
 *    (no branch name to record).
 */
const DETACHED_HEAD = 'HEAD';

/**
 * Resolved metadata for a startup worktree. Returned to the caller so the
 * sidecar write (which needs `Config`) can happen after `loadCliConfig`.
 */
export interface StartupWorktreeContext {
  /** Resolved absolute worktree path (where `process.cwd()` now points). */
  worktreePath: string;
  /** Slug, e.g. `my-feature` or `pr-123`. */
  slug: string;
  /** Branch name, e.g. `worktree-my-feature` or `worktree-pr-123`. */
  branch: string;
  /** Repo top level captured before chdir. */
  repoRoot: string;
  /** Branch that was checked out at worktree-creation time. */
  originalBranch: string;
  /** HEAD SHA captured at worktree-creation time (for WorktreeExitDialog). */
  originalHeadCommit: string;
  /** True iff the input was a PR reference. */
  isPullRequest: boolean;
  /**
   * True when the worktree directory already existed at startup and we
   * re-attached to it. PR fetch is skipped
   * on re-attach since the ref was materialized previously, and
   * commit-count semantics in `WorktreeExitDialog` will track only this
   * session's new commits.
   */
  wasReattached: boolean;
  createdSymlinkPaths: string[];
}

export type SetupStartupWorktreeResult =
  | { ok: true; context: StartupWorktreeContext }
  | { ok: false; error: string };

/**
 * Resolves slug, creates the worktree, switches `process.cwd()`, and returns
 * the metadata needed for the post-`loadCliConfig` sidecar write.
 *
 * Returns `null` when `rawInput === undefined` (no `--worktree` flag passed
 * at all). Returns `{ ok: false, error }` for validation / git failures so
 * the caller can print to stderr and exit with a controlled non-zero status.
 *
 * The caller is responsible for chdir-ing back if a later step fails — this
 * helper does not roll back the worktree directory on a downstream error,
 * matching `EnterWorktreeTool`'s "the worktree is yours now" semantics.
 */
export interface SetupStartupWorktreeOptions {
  /**
   * Mirrors `worktree.symlinkDirectories` (Phase D-2). Forwarded to
   * `createUserWorktree` so the new worktree gets the same opt-in
   * symlinks as `enter_worktree` and agent isolation worktrees do.
   */
  symlinkDirectories?: readonly string[];
}

export async function setupStartupWorktree(
  rawInput: string | undefined,
  options?: SetupStartupWorktreeOptions,
): Promise<SetupStartupWorktreeResult | null> {
  if (rawInput === undefined) return null;

  // yargs delivers bare `--worktree` as an empty string (mirrors --resume).
  // We accept it and fall through to auto-slug below.
  const trimmed = rawInput.trim();

  // Probe service rooted at the launch cwd so we can locate the repo top
  // level before the chdir; the chdir target lives under that top level.
  const launchCwd = process.cwd();
  const probe = new GitWorktreeService(launchCwd);

  const gitCheck = await probe.checkGitAvailable();
  if (!gitCheck.available) {
    return {
      ok: false,
      error: `--worktree: ${gitCheck.error ?? 'git is not available on PATH.'}`,
    };
  }

  // Refuse nested creation: launching with --worktree from inside an existing
  // worktree creates `<otherRepo>/.qwen/worktrees/<slug>/`, which is rarely
  // what the user wants and corrupts ownership tracking.
  if (/[\\/]\.qwen[\\/]worktrees[\\/]/.test(launchCwd)) {
    return {
      ok: false,
      error: `--worktree: cannot start a new worktree from inside another worktree (cwd: ${launchCwd}). Run from the main checkout.`,
    };
  }

  // `getRepoTopLevel()` returns null when cwd is not inside a git repo,
  // so a single subprocess covers both the is-a-repo gate and the
  // top-level resolution we need for the worktree path.
  const rawRepoRoot = await probe.getRepoTopLevel();
  if (rawRepoRoot === null) {
    return {
      ok: false,
      error: `--worktree: ${launchCwd} is not a git repository. Run \`git init\` first or relaunch from inside one.`,
    };
  }
  // git always emits POSIX-style paths (forward slashes) via
  // `--show-toplevel`. Normalize to the platform-native separator
  // before storing or comparing so the sidecar's `originalCwd` and
  // downstream `startsWith` checks don't mix `/` and `\` on Windows.
  const repoRoot = path.resolve(rawRepoRoot);
  const service =
    repoRoot === launchCwd ? probe : new GitWorktreeService(repoRoot);

  // Resolve slug. Branch on PR reference first so `#123` / URLs don't fall
  // through to slug validation (which would reject `#`). For PR refs we
  // DEFER the fetch until we've checked whether the worktree already
  // exists on disk — re-attach skips the fetch since the ref was
  // materialized on the first run.
  const prNumber = GitWorktreeService.parsePRReference(trimmed);
  const isPullRequest = prNumber !== null;
  let slug: string;
  if (prNumber !== null) {
    slug = `pr-${prNumber}`;
  } else if (trimmed.length === 0) {
    slug = GitWorktreeService.generateAutoSlug();
  } else {
    const validation = GitWorktreeService.validateUserWorktreeSlug(trimmed);
    if (validation) {
      return { ok: false, error: `--worktree: ${validation}` };
    }
    slug = trimmed;
  }

  // Capture the launch-time branch and HEAD. These feed the WorktreeSession
  // sidecar's `originalBranch` / `originalHeadCommit` fields when we go
  // through the CREATE path; on re-attach the HEAD baseline is re-captured
  // from inside the worktree itself (see the re-attach branch below) so
  // `WorktreeExitDialog`'s `rev-list <originalHeadCommit>..HEAD` counts
  // only this session's new commits — not every commit the kept worktree
  // accumulated across prior sessions.
  //
  // The two probes are independent — run in parallel to shave one
  // subprocess off the critical path. Each is individually try-wrapped
  // so a failure in one (unborn HEAD, partial init) doesn't poison
  // the other. Detached-HEAD normalization via DETACHED_HEAD const.
  const [originalBranchRaw, originalHeadCommit] = await Promise.all([
    service.getCurrentBranch().catch(() => undefined),
    service.getCurrentCommitHash().catch(() => ''),
  ]);
  const originalBranch =
    originalBranchRaw && originalBranchRaw !== DETACHED_HEAD
      ? originalBranchRaw
      : undefined;

  // Re-attach to an existing worktree instead of erroring out. Common
  // case: user did `qwen --worktree foo` previously, exited with Keep,
  // and now runs `qwen --resume <sid> --worktree foo` to continue. The
  // directory + branch are already on disk; we just chdir into them.
  //
  // `getRegisteredWorktreeBranch` returns the worktree's HEAD commit
  // alongside the branch (single rev-parse). Using THAT as
  // `originalHeadCommit` instead of the launch-cwd capture is critical:
  // `WorktreeExitDialog` later runs `rev-list <head>..HEAD` inside the
  // worktree, so the launch-cwd HEAD would make it count every commit
  // accumulated in the worktree across all prior sessions as "new work
  // this session".
  const expectedWorktreePath = service.getUserWorktreePath(slug);
  const expectedBranch = worktreeBranchForSlug(slug);
  let registered: { branch: string; headCommit: string } | null = null;
  try {
    registered =
      await service.getRegisteredWorktreeBranch(expectedWorktreePath);
  } catch {
    registered = null;
  }
  if (registered !== null) {
    if (registered.branch !== expectedBranch) {
      // SOMETHING ELSE is occupying the path on a different branch —
      // refuse to clobber it.
      return {
        ok: false,
        error:
          `--worktree: ${expectedWorktreePath} is already a git worktree, but its branch ` +
          `is ${registered.branch} (expected ${expectedBranch}). Refusing to re-attach. ` +
          `Resolve the conflict manually (e.g. \`git worktree remove ${expectedWorktreePath}\`).`,
      };
    }
    const worktreePath = path.resolve(expectedWorktreePath);
    const reattachMarker = await writeStartupReattachMarker(worktreePath);
    if (!reattachMarker.ok) {
      return {
        ok: false,
        error: `--worktree: failed to mark re-attach at ${worktreePath} (${reattachMarker.error}).`,
      };
    }
    try {
      process.chdir(worktreePath);
    } catch (error) {
      return {
        ok: false,
        error: `--worktree: failed to chdir into ${worktreePath} (${error instanceof Error ? error.message : String(error)}).`,
      };
    }
    debugLogger.debug(
      `setupStartupWorktree: re-attached to existing worktree at ${worktreePath} (branch=${registered.branch})`,
    );
    return {
      ok: true,
      context: {
        worktreePath,
        slug,
        branch: registered.branch,
        repoRoot,
        originalBranch: originalBranch ?? DETACHED_HEAD,
        originalHeadCommit: registered.headCommit,
        isPullRequest,
        wasReattached: true,
        createdSymlinkPaths: [],
      },
    };
  }

  // Phase D-3: fetch the PR ref BEFORE creating the worktree, so the
  // base ref (FETCH_HEAD) is available to `git worktree add`. Skipped
  // on re-attach above. Fail-close: any fetch error stops startup before
  // we create disk state.
  //
  // Lock FETCH_HEAD to an immutable SHA *immediately* after the fetch:
  //   - closes a TOCTOU window in which a concurrent `git fetch` from
  //     any other process sharing this repo would overwrite FETCH_HEAD
  //     before `git worktree add` reads it, branching the new worktree
  //     off an unrelated commit;
  //   - lets us pass that same SHA back as `originalHeadCommit`, so
  //     `WorktreeExitDialog`'s `rev-list <head>..HEAD` later inside the
  //     worktree counts only the user's own new commits — not the
  //     entire fetched PR's history.
  let pullRequestHeadSha: string | null = null;
  if (prNumber !== null) {
    const fetchRes = await service.fetchPullRequestRef(prNumber);
    if (!fetchRes.success) {
      return { ok: false, error: `--worktree: ${fetchRes.error}` };
    }
    pullRequestHeadSha = await service.resolveRef('FETCH_HEAD');
    if (pullRequestHeadSha === null) {
      return {
        ok: false,
        error: `--worktree: fetched PR #${prNumber} but FETCH_HEAD did not resolve to a commit SHA. Refusing to proceed (the worktree would otherwise branch off an unknown commit).`,
      };
    }
  }

  // For PR worktrees the base ref is the SHA we just locked in (NOT the
  // literal `FETCH_HEAD`, which is mutable); for regular slugs we anchor
  // at the parent session's currently checked-out branch.
  const baseRef = isPullRequest ? pullRequestHeadSha! : originalBranch;
  const result = await service.createUserWorktree(slug, baseRef, {
    symlinkDirectories: options?.symlinkDirectories,
  });
  if (!result.success || !result.worktree) {
    return {
      ok: false,
      error: `--worktree: ${result.error ?? 'failed to create worktree.'}`,
    };
  }

  // Switch the process working directory so loadCliConfig() picks up the
  // worktree as targetDir, and subsequent shell / file operations land
  // inside it. Mirror the convention used elsewhere in the codebase by
  // working with the resolved absolute path.
  const worktreePath = path.resolve(result.worktree.path);
  try {
    process.chdir(worktreePath);
  } catch (error) {
    return {
      ok: false,
      error: `--worktree: created worktree at ${worktreePath} but failed to chdir into it (${error instanceof Error ? error.message : String(error)}). Run \`cd ${worktreePath}\` manually.`,
    };
  }

  return {
    ok: true,
    context: {
      worktreePath,
      slug,
      branch: result.worktree.branch,
      repoRoot,
      originalBranch: originalBranch ?? DETACHED_HEAD,
      // For PR worktrees, the worktree's HEAD starts at the fetched PR
      // tip — not at the parent repo's HEAD. Use the SHA we locked in
      // post-fetch so the exit-dialog rev-list counts only the user's
      // new commits, not the entire PR history.
      originalHeadCommit: isPullRequest
        ? pullRequestHeadSha!
        : originalHeadCommit,
      isPullRequest,
      wasReattached: false,
      createdSymlinkPaths: result.createdSymlinkPaths ?? [],
    },
  };
}

export interface DiscardStartupWorktreeResult {
  preserved?: string;
  error?: string;
}

export async function discardCreatedStartupWorktree(
  context: StartupWorktreeContext | null,
): Promise<DiscardStartupWorktreeResult> {
  if (context === null || context.wasReattached) return {};
  try {
    process.chdir(context.repoRoot);
    const service = new GitWorktreeService(context.repoRoot);
    const owner = await readWorktreeSessionMarker(context.worktreePath);
    if (owner !== null) {
      return {
        preserved: `worktree ${context.worktreePath} is owned by session ${owner}`,
      };
    }
    const reattachOwner = await readLiveStartupReattachMarker(
      context.worktreePath,
    );
    if (reattachOwner !== null) {
      return {
        preserved: `worktree ${context.worktreePath} is being re-attached by process ${reattachOwner}`,
      };
    }
    const intactCreatedSymlinkPaths: string[] = [];
    for (const entry of context.createdSymlinkPaths) {
      try {
        const sourcePath = path.join(context.repoRoot, entry);
        const worktreePath = path.join(context.worktreePath, entry);
        const [stat, sourceTarget, worktreeTarget] = await Promise.all([
          fs.lstat(worktreePath),
          fs.realpath(sourcePath),
          fs.realpath(worktreePath),
        ]);
        if (stat.isSymbolicLink() && sourceTarget === worktreeTarget) {
          intactCreatedSymlinkPaths.push(entry);
        }
      } catch {
        // A missing or changed link is user-visible work and must stay dirty.
      }
    }
    if (
      await service.hasWorktreeChanges(
        context.worktreePath,
        intactCreatedSymlinkPaths,
      )
    ) {
      return {
        preserved: `worktree ${context.worktreePath} has uncommitted changes`,
      };
    }
    const branchHead = await service.resolveRef(`refs/heads/${context.branch}`);
    if (branchHead !== context.originalHeadCommit) {
      return {
        preserved: `worktree branch ${context.branch} changed after startup`,
      };
    }
    const result = await service.removeUserWorktree(context.slug, {
      deleteBranch: true,
      forceDeleteBranch: true,
    });
    return result.success
      ? {}
      : {
          error: result.error ?? `failed to remove ${context.worktreePath}`,
        };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Result of the post-`loadCliConfig` sidecar persist step. Callers use the
 * boolean fields to decide whether to surface an INFO line in TUI / a
 * `<system-reminder>` in headless / a `pendingWorktreeNotice` in ACP.
 */
export interface PersistStartupWorktreeResult {
  /** True when a pre-existing sidecar was found and overridden. */
  overrodeResumedWorktree: boolean;
  /**
   * Slug of the worktree that was overridden, when {@link overrodeResumedWorktree}
   * is true. Used in the INFO message so users can re-attach to it if they
   * launched with `--worktree` by mistake.
   */
  overriddenSlug?: string;
  /** Path to the sidecar file just written. */
  sidecarPath: string;
}

/**
 * Writes the `WorktreeSession` sidecar that Phase C's `--resume` restore
 * machinery consumes, and tags the worktree directory with the current
 * session ID so cross-session `exit_worktree action="remove"` is refused.
 *
 * Handles the `--worktree` × `--resume` precedence: when a sidecar already
 * exists (the user resumed a session that previously had a different
 * worktree), the new context wins and the previous slug is reported back
 * so callers can show an INFO line.
 */
export async function persistStartupWorktreeSidecar(
  config: Config,
  context: StartupWorktreeContext,
): Promise<PersistStartupWorktreeResult> {
  const sessionId = config.getSessionId();
  const sidecarPath = config
    .getSessionService()
    .getWorktreeSessionPath(sessionId);

  // Read whatever sidecar exists before we clobber it, so we can detect
  // and report an override. A read failure (corrupt JSON, permission)
  // collapses to "no previous worktree" — the new sidecar still wins.
  // Log the failure with the sidecar path so an operator can recover the
  // previous slug from a backup if they care; silent loss would make
  // "where did my previous worktree binding go?" undebuggable.
  let overrodeResumedWorktree = false;
  let overriddenSlug: string | undefined;
  let previous: WorktreeSession | null = null;
  try {
    previous = await readWorktreeSession(sidecarPath);
  } catch (error) {
    debugLogger.warn(
      `persistStartupWorktreeSidecar: failed to read existing sidecar at ${sidecarPath} — treating as "no previous worktree" and proceeding: ${error}`,
    );
    previous = null;
  }
  if (previous && previous.slug !== context.slug) {
    overrodeResumedWorktree = true;
    overriddenSlug = previous.slug;
  }

  // Best-effort marker write. On re-attach, adopt only when the previous
  // owner is not a live runtime anymore; otherwise keep the old marker so
  // two active sessions cannot both remove the same worktree.
  let shouldWriteMarker = !context.wasReattached;
  if (context.wasReattached) {
    const owner = await readWorktreeSessionMarker(context.worktreePath);
    if (owner === null || owner === sessionId) {
      shouldWriteMarker = true;
    } else {
      const ownerActive = await isSessionRuntimeActive(owner, [
        context.repoRoot,
        context.worktreePath,
      ]).catch((error) => {
        debugLogger.warn(
          `persistStartupWorktreeSidecar: failed to check owner runtime ${owner}: ${error}`,
        );
        return true;
      });
      shouldWriteMarker = !ownerActive;
    }
  }
  if (shouldWriteMarker) {
    await writeWorktreeSessionMarker(context.worktreePath, sessionId).catch(
      () => {},
    );
  }
  await removeStartupReattachMarker(context.worktreePath);

  await writeWorktreeSession(sidecarPath, {
    slug: context.slug,
    worktreePath: context.worktreePath,
    worktreeBranch: context.branch,
    originalCwd: context.repoRoot,
    originalBranch: context.originalBranch,
    originalHeadCommit: context.originalHeadCommit,
  });

  // The previous worktree directory (if any) is intentionally left on
  // disk — the user retains the ability to re-attach by launching again
  // with `--worktree <previous-slug>`. We only swap the sidecar's slug.

  return { overrodeResumedWorktree, overriddenSlug, sidecarPath };
}

async function getStartupReattachMarkerPath(
  worktreePath: string,
): Promise<string> {
  const gitPath = path.join(worktreePath, '.git');
  const stat = await fs.lstat(gitPath);
  if (stat.isDirectory()) {
    return path.join(gitPath, STARTUP_REATTACH_MARKER);
  }
  const raw = await fs.readFile(gitPath, 'utf8');
  const match = /^gitdir:\s*(.+)\s*$/i.exec(raw.trim());
  if (!match) {
    throw new Error('.git file does not contain a gitdir pointer');
  }
  const gitDir = path.isAbsolute(match[1]!)
    ? match[1]!
    : path.resolve(worktreePath, match[1]!);
  return path.join(gitDir, STARTUP_REATTACH_MARKER);
}

async function writeStartupReattachMarker(
  worktreePath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const markerPath = await getStartupReattachMarkerPath(worktreePath);
    await fs.writeFile(
      markerPath,
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
      'utf8',
    );
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readLiveStartupReattachMarker(
  worktreePath: string,
): Promise<number | null> {
  let markerPath: string;
  try {
    markerPath = await getStartupReattachMarkerPath(worktreePath);
  } catch {
    return null;
  }
  let pid: number | undefined;
  try {
    const parsed = JSON.parse(await fs.readFile(markerPath, 'utf8')) as {
      pid?: unknown;
    };
    pid = typeof parsed.pid === 'number' ? parsed.pid : undefined;
  } catch {
    return null;
  }
  if (!pid || !isPidRunning(pid)) {
    await fs.rm(markerPath, { force: true }).catch(() => {});
    return null;
  }
  return pid;
}

async function removeStartupReattachMarker(
  worktreePath: string,
): Promise<void> {
  try {
    await fs.rm(await getStartupReattachMarkerPath(worktreePath), {
      force: true,
    });
  } catch {
    // Best-effort cleanup only; the live-pid check ignores stale markers.
  }
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Builds the one-shot context message that gets injected into the model on
 * the first user prompt (TUI: INFO history item + reminder prefix; headless:
 * `<system-reminder>` prefix + JSON event; ACP currently exits before
 * reaching this code path — see the `--worktree` × `--acp` mutex check
 * in `gemini.tsx`).
 *
 * Mirrors `restoreWorktreeContext`'s contextMessage shape so resumed-with-
 * worktree and started-with-worktree sessions read identically to the model.
 *
 * Differentiates the verb based on whether the worktree was just created
 * or the CLI re-attached to a pre-existing one — same slug + branch but
 * meaningfully different user intent. The override addendum (when
 * `--worktree` clobbered a resumed session's prior worktree) is shown
 * regardless of created/reattached state.
 *
 * Parameter type is `Pick<StartupWorktreeContext, …>` rather than the full
 * context so test fixtures can construct minimal literals without
 * tracking every internal field. Adding fields to {@link
 * StartupWorktreeContext} should NOT force test-fixture churn here.
 */
export function buildStartupWorktreeNotice(
  context: Pick<
    StartupWorktreeContext,
    'slug' | 'worktreePath' | 'branch' | 'wasReattached'
  >,
  override?: PersistStartupWorktreeResult,
): string {
  const verb = context.wasReattached
    ? 'Re-attached to worktree'
    : 'Active worktree';
  const base =
    `[Startup] ${verb}: "${context.slug}" at ${context.worktreePath} ` +
    `(branch: ${context.branch}). Continue using this path for all file operations.`;
  if (override?.overrodeResumedWorktree && override.overriddenSlug) {
    return (
      `${base}\n` +
      `Note: --worktree overrode the resumed session's previous worktree "${override.overriddenSlug}". ` +
      `That worktree directory was left intact; re-attach with \`qwen --worktree ${override.overriddenSlug}\` if needed.`
    );
  }
  return base;
}
