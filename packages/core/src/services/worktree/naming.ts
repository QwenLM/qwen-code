/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { CONFIG_DIR } from '../../utils/paths.js';

const VALID_WORKTREE_SLUG_SEGMENT = /^[a-zA-Z0-9._-]+$/;

export const MAX_WORKTREE_SLUG_LENGTH = 256;

/**
 * Validates a worktree slug to prevent path traversal and directory escape.
 *
 * Forward slashes are allowed for nesting (e.g. `user/feature-foo`); each
 * segment is validated independently, so `.` / `..` segments and drive-spec
 * characters are rejected.
 *
 * Throws synchronously — callers rely on this running before any side effects.
 */
export function validateWorktreeSlug(slug: string): void {
  if (slug.length > MAX_WORKTREE_SLUG_LENGTH) {
    throw new Error(
      `Invalid worktree name: must be ${MAX_WORKTREE_SLUG_LENGTH} characters or fewer (got ${slug.length})`,
    );
  }
  for (const segment of slug.split('/')) {
    if (segment === '.' || segment === '..') {
      throw new Error(
        `Invalid worktree name "${slug}": must not contain "." or ".." path segments`,
      );
    }
    if (!VALID_WORKTREE_SLUG_SEGMENT.test(segment)) {
      throw new Error(
        `Invalid worktree name "${slug}": each "/"-separated segment must be non-empty and contain only letters, digits, dots, underscores, and dashes`,
      );
    }
  }
}

/**
 * Flatten nested slugs (`user/feature` → `user+feature`) for branch names
 * and directory paths. Nesting is unsafe in git refs (D/F conflict) and
 * filesystem (parent `git worktree remove` deletes children).
 */
export function flattenSlug(slug: string): string {
  return slug.replaceAll('/', '+');
}

/** Derive the git branch name for a worktree slug. */
export function worktreeBranchName(slug: string): string {
  return `worktree-${flattenSlug(slug)}`;
}

export function worktreesDir(repoRoot: string): string {
  return path.join(repoRoot, CONFIG_DIR, 'worktrees');
}

/** 创建与预占共用同一套 slug 到实际路径的映射，不作为公开 API 导出。 */
export function worktreePathFor(repoRoot: string, slug: string): string {
  return path.join(worktreesDir(repoRoot), flattenSlug(slug));
}

export function getWorktreePath(projectRoot: string, name: string): string {
  return path.join(projectRoot, CONFIG_DIR, 'worktrees', name);
}

/**
 * Parse a PR reference from a string.
 * Accepts GitHub PR URLs, GitLab MR URLs, or `#N` format.
 * Returns the review number or null.
 */
export function parsePRReference(input: string): number | null {
  const githubMatch = input.match(
    /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/(\d+)\/?(?:[?#].*)?$/i,
  );
  if (githubMatch?.[1]) {
    return parseInt(githubMatch[1], 10);
  }

  // GitLab project paths may contain nested groups.
  const gitlabMatch = input.match(
    /^https?:\/\/[^/]+\/[^?#]+\/-\/merge_requests\/(\d+)\/?(?:[?#].*)?$/i,
  );
  if (gitlabMatch?.[1]) {
    return parseInt(gitlabMatch[1], 10);
  }

  const hashMatch = input.match(/^#(\d+)$/);
  if (hashMatch?.[1]) {
    return parseInt(hashMatch[1], 10);
  }

  return null;
}
