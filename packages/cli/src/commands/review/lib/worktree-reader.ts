/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Read a file the PR itself named, from the worktree, without letting the PR
// choose what gets read.
//
// The widening resolves import specifiers, which means it opens files whose
// paths come from the diff under review. Two ways that goes wrong, and only
// the first is obvious:
//
//   1. The path is not a regular file. Opening a fifo blocks the synchronous
//      read forever, and a device like `/dev/zero` grows the buffer until
//      SIGKILL — neither throws, so a `catch` that frees the worktree lease
//      never runs and every later review of the PR hangs the same way.
//
//   2. The path resolves outside the worktree. `lstat` spares only the FINAL
//      component: an INTERMEDIATE one can be a symlink the PR planted, which
//      is ordinary git content a standard checkout materializes. The string
//      stays lexically inside while the kernel resolves it outside. That
//      matters twice over here, because what the reader returns is
//      content-derived and reaches `scope.interaction` in the published
//      report — an arbitrary-file read AND a channel out of the machine.
//
// So containment is by filesystem reality, never by the string. Same class
// and same defence as `script-lint`'s `firstLineOf`.
//
// Every refusal answers `null`, which the widening already reads as "no edge
// from this file". A refused read therefore costs the round its widening for
// that file and nothing else: the unwidened scope is the floor.

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/** Reads repo-relative paths under `root`, refusing anything that escapes. */
export function containedWorktreeReader(
  root: string,
): (repoRelPath: string) => string | null {
  // Resolved ONCE. Null when the root itself will not resolve, which fails
  // every read closed rather than containing against a path that is not
  // there.
  // Absolutised first: callers pass a repo-relative worktree path, and
  // `resolve(root, rel)` below produces an absolute one — comparing the two
  // as given would never match.
  let rootReal: string | null;
  try {
    rootReal = realpathSync(resolve(root));
  } catch {
    rootReal = null;
  }
  return (repoRelPath: string): string | null => {
    if (rootReal === null) return null;
    try {
      const abs = resolve(root, repoRelPath);
      if (!lstatSync(abs).isFile()) return null;
      const real = realpathSync(abs);
      if (real !== rootReal && !real.startsWith(rootReal + sep)) return null;
      return readFileSync(abs, 'utf8');
    } catch {
      return null;
    }
  };
}
