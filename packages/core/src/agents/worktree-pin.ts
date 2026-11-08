/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Pinning an agent to a caller-owned git worktree.
 *
 * Two launch surfaces ask for the same thing — `AgentTool`'s `working_dir`
 * parameter and a workflow script's `agent({workingDir})` — and both mean:
 * run this agent inside a worktree that ALREADY exists and whose lifetime
 * someone else owns. Neither creates the directory and neither removes it;
 * they only rebind the child Config's cwd surfaces to it.
 *
 * The validation lives here, once, because it is the load-bearing half. The
 * path comes from a model — a tool call's argument, or a line in a workflow
 * script — and pinning replaces the child's `WorkspaceContext` wholesale, so
 * an unvalidated path silently moves the boundary of every file, shell and
 * search tool the agent has.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import { GitWorktreeService } from '../services/gitWorktreeService.js';

/** A validated pin target. `branch` / `slug` are labels, never gates. */
export interface ResolvedWorktreePin {
  path: string;
  branch: string;
  slug: string;
  repoRoot: string;
}

/**
 * Resolve and validate a caller-owned worktree path (e.g. the PR-review
 * worktree `/review`'s `fetch-pr` provisions).
 *
 * Git's worktree registry stops a bad path from aiming the agent somewhere
 * it should not be: the path must be a REGISTERED linked worktree of this
 * repository, enforced by `isRegisteredLinkedWorktree` — git's own registry
 * entry for the path must point back at it, and it must not be the primary
 * working tree. That rejects arbitrary directories, sibling `git init`s,
 * plain sub-directories (including a stale registry record whose directory
 * was recreated), other repositories' worktrees, a directory carrying a
 * copied `.git` file, and the main working tree itself. A registered
 * worktree may live anywhere on disk — the registry entry naming this
 * repository is the boundary, not directory containment.
 *
 * `getRegisteredWorktreeBranch` is consulted only for a best-effort branch
 * label; it is deliberately NOT a gate, since it returns null for a legitimate
 * detached-HEAD worktree.
 *
 * The pin path is resolved ONCE and that single resolution is threaded
 * through the gate and returned as `path`: re-resolving inside the gate —
 * or returning the lexical spelling for the child to bind while the gate saw
 * the canonical one — lets a symlink re-pointed after validation land the
 * child somewhere the gate never checked.
 *
 * @param label how to name the offending parameter in error text — `working_dir`
 *   for the tool, `workingDir` for the workflow opt.
 * @returns the resolved absolute path + labels, or `{ error }` with a
 *   user-facing reason.
 */
export async function resolveExternalWorktreeDir(
  config: Config,
  workingDir: string,
  label = 'working_dir',
): Promise<ResolvedWorktreePin | { error: string }> {
  const parentCwd = config.getTargetDir();
  const resolvedPath = path.resolve(parentCwd, workingDir);

  const probe = new GitWorktreeService(parentCwd);
  const gitCheck = await probe.checkGitAvailable();
  if (!gitCheck.available) {
    return {
      error: `Cannot use ${label}: ${gitCheck.error ?? 'git is not available'}.`,
    };
  }
  // Mirror the isolation:'worktree' preflight. Without it, a non-repo parent
  // dir yields the confusing "not a registered git worktree" error below
  // (getRepoTopLevel() → null, validation then fails) instead of naming the
  // real cause.
  if (!(await probe.isGitRepository())) {
    return {
      error: `Cannot use ${label}: ${parentCwd} is not a git repository.`,
    };
  }
  // Anchor at the repository's MAIN working tree. From inside a linked
  // worktree (the normal state for /review-style pipelines)
  // `--show-toplevel` answers with the worktree's own root, which would
  // mislabel the repository in refusals and scope the branch-label lookup
  // to the wrong tree. The toplevel answer is the fallback when the worktree
  // list cannot be read; either anchor also keeps the common-dir comparison
  // inside getRegisteredWorktreeBranch against the repository, not a monorepo
  // subdirectory the parent launched from.
  const mainTreePath = await probe.getMainWorktreePath();
  const repoRoot = mainTreePath ?? (await probe.getRepoTopLevel()) ?? parentCwd;
  const wtService =
    repoRoot === parentCwd ? probe : new GitWorktreeService(repoRoot);

  // The single authoritative gate: the path must be a REGISTERED linked
  // worktree of this repository — git's own registry entry for it points back
  // at exactly this path, and it is not the primary working tree. That one
  // check rejects the main tree, a plain sub-directory (including a stale
  // registry record whose directory was recreated), a worktree belonging to
  // another repo, and a hand-crafted directory carrying a copied `.git` file.
  // Thread the single resolution (see the doc block): canonicalise so the
  // gate checks — and the child binds — the exact directory object.
  const pinnedPath = await fs.realpath(resolvedPath).catch(() => resolvedPath);
  if (!(await wtService.isRegisteredLinkedWorktree(pinnedPath))) {
    // Fails closed (returns false) on a git error too, so the cause is either
    // "not a registered linked worktree" (main tree / unregistered) or "its
    // git metadata could not be read" — name both rather than assert one.
    return {
      error:
        `${label} "${resolvedPath}" is not a registered linked worktree of ` +
        `this repository (it is the main working tree, is absent from \`git ` +
        `worktree list\`, or its git metadata could not be read) — pinning a ` +
        `sub-agent there would not isolate it. Pass a worktree created via ` +
        `\`git worktree add\`.`,
    };
  }
  // Best-effort branch label only — never a gate. A detached-HEAD worktree
  // (`git worktree add --detach`, or a checkout of a bare commit) is
  // legitimate with no branch, and `getRegisteredWorktreeBranch` returns null
  // for it. `branch` is unused for caller-owned worktrees anyway (cleanup
  // short-circuits on `externallyManaged`); it is carried only for parity
  // with the isolation path.
  const info = await wtService.getRegisteredWorktreeBranch(pinnedPath);
  return {
    path: pinnedPath,
    branch: info?.branch ?? '',
    slug: path.basename(pinnedPath),
    repoRoot,
  };
}
