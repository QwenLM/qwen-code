/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview The trusted ancestor directories a session may discover saved
 * workflows in. From `repo/packages/a` the candidates are `repo/packages` and
 * `repo`: every strict ancestor of the session's target directory up to the
 * nearest Git root (a `.git` directory, or the `.git` file of a linked
 * worktree or submodule — the walk stops at that root, never at an outer
 * checkout). The host decides which candidates are trusted, through the
 * Config's {@link WorkflowAncestorTrustProvider}; the chain stops at the
 * first one it does not trust, so an unknown or denied directory is never
 * skipped over to reach a trusted one above it.
 *
 * Nothing here is cached: every call starts again from the Config's current
 * target directory, so a derived Config, a relocated session, a changed trust
 * rule and a new or removed `.git` all take effect on the next lookup.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../../config/config.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { findProjectRoot } from '../../utils/projectRoot.js';

const debugLogger = createDebugLogger('WORKFLOW_SAVED');

/**
 * Most ancestors one lookup asks the host about. A deeper target only loses
 * the ancestors above the nearest {@link MAX_WORKFLOW_ANCESTOR_DIRS}.
 */
export const MAX_WORKFLOW_ANCESTOR_DIRS = 64;

/** Where one lookup's discovery is anchored. */
export interface WorkflowAncestorScope {
  /** Real path of the target directory, or `null` when it cannot be resolved. */
  canonicalTargetDir: string | null;
  /** The nearest Git root at or above the target, when it is a reliable boundary. */
  repoRoot: string | null;
  /** Trusted strict ancestors, nearest first, each a real path. */
  trustedAncestors: string[];
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/**
 * The nearest Git root of `canonicalDir`, but only when every directory from
 * `canonicalDir` up to it answers the `.git` question unambiguously.
 * `findProjectRoot` walks past a `.git` symlink, an entry of another type and
 * an error reading it; any of those could be the real boundary, so here they
 * mean "no reliable root" and no ancestor is added.
 */
async function findReliableRepoRoot(
  canonicalDir: string,
): Promise<string | null> {
  const root = await findProjectRoot(canonicalDir);
  if (root === null) return null;
  for (let dir = canonicalDir; ; dir = path.dirname(dir)) {
    const gitPath = path.join(dir, '.git');
    try {
      const st = await fs.lstat(gitPath);
      if (!st.isDirectory() && !st.isFile()) {
        debugLogger.warn(`no workflow ancestors: unusual entry at ${gitPath}`);
        return null;
      }
      return dir === root ? root : null;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        debugLogger.warn(`no workflow ancestors: cannot check ${gitPath}`);
        return null;
      }
    }
    if (dir === root || path.dirname(dir) === dir) return null;
  }
}

/**
 * Resolve the target directory's real path, its reliable repository root and
 * the trusted strict ancestors in between. The host is asked once, with the
 * whole candidate chain; only an answer of exactly `true` admits a directory.
 * A missing provider, a throw, or an answer of the wrong shape adds none.
 */
export async function resolveWorkflowAncestorScope(
  config: Config,
): Promise<WorkflowAncestorScope> {
  const targetDir = config.getTargetDir?.();
  const none = (
    canonicalTargetDir: string | null = null,
    repoRoot: string | null = null,
  ): WorkflowAncestorScope => ({
    canonicalTargetDir,
    repoRoot,
    trustedAncestors: [],
  });
  if (typeof targetDir !== 'string' || targetDir.length === 0) return none();
  let canonicalTargetDir: string;
  try {
    canonicalTargetDir = await fs.realpath(targetDir);
  } catch {
    return none();
  }
  const repoRoot = await findReliableRepoRoot(canonicalTargetDir);
  if (repoRoot === null || repoRoot === canonicalTargetDir) {
    return none(canonicalTargetDir, repoRoot);
  }
  const candidates: string[] = [];
  for (
    let dir = path.dirname(canonicalTargetDir);
    candidates.length < MAX_WORKFLOW_ANCESTOR_DIRS;
    dir = path.dirname(dir)
  ) {
    candidates.push(dir);
    if (dir === repoRoot || path.dirname(dir) === dir) break;
  }
  const provider = config.getWorkflowAncestorTrustProvider?.();
  if (!provider) return none(canonicalTargetDir, repoRoot);
  let answers: unknown;
  try {
    answers = await provider(candidates);
  } catch (error) {
    debugLogger.warn(`workflow ancestor trust lookup failed: ${error}`);
    return none(canonicalTargetDir, repoRoot);
  }
  if (!Array.isArray(answers) || answers.length !== candidates.length) {
    debugLogger.warn('workflow ancestor trust lookup returned a bad answer');
    return none(canonicalTargetDir, repoRoot);
  }
  const trustedAncestors: string[] = [];
  for (let i = 0; i < candidates.length && answers[i] === true; i++) {
    trustedAncestors.push(candidates[i]);
  }
  return { canonicalTargetDir, repoRoot, trustedAncestors };
}
