/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';

/**
 * Result of validating a symlink entry inside a skills directory.
 *
 *  - `ok: true`  → target resolves and is a directory.
 *  - `ok: false` → `not-directory` (target exists but is a file/socket/etc.)
 *    or `invalid` (broken link, permission denied, stat race). Callers log
 *    a warn and skip the entry.
 *
 * Symlinks pointing outside the skills directory are intentionally **not**
 * rejected. The original symlink support
 * (`f02225226 feat(core): add symlink support for skill manager`) was
 * designed to let users "organize and share skills more flexibly by using
 * symbolic links" — typical layout is one skills repo on disk, with
 * subsets symlinked into `~/.qwen/skills/`. PR #3604 added a containment
 * check that rejected any out-of-scope target as a code-execution-vector
 * mitigation; the threat model only fits scenarios where an attacker can
 * write a symlink but **not** a regular file (extremely narrow on a
 * single-user `~/.qwen/skills/`, since write access to the dir lets the
 * attacker drop a real `SKILL.md` directly), so the check was net
 * negative — it broke the supported user-managed-symlink workflow without
 * meaningfully reducing the underlying hooks-as-shell-execution risk.
 * If a project-level containment policy is wanted later, scope it to the
 * `project` level only rather than re-enabling it everywhere.
 */
export type SymlinkTargetCheck =
  | { ok: true; realPath: string }
  | {
      ok: false;
      reason: 'not-directory' | 'invalid';
      error?: unknown;
    };

/**
 * Validate that a symlink at `skillDir` (a) resolves and (b) targets a
 * directory. The target is allowed to live anywhere on disk.
 *
 * Used by both `skill-load.ts` (extension parser) and `skill-manager.ts`
 * (project/user/bundled parser) so the two paths stay in sync.
 */
export async function validateSymlinkTarget(
  skillDir: string,
): Promise<SymlinkTargetCheck> {
  let realPath: string;
  try {
    realPath = await fs.realpath(skillDir);
  } catch (error) {
    return { ok: false, reason: 'invalid', error };
  }
  let targetStat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    targetStat = await fs.stat(realPath);
  } catch (error) {
    return { ok: false, reason: 'invalid', error };
  }
  if (!targetStat.isDirectory()) {
    return { ok: false, reason: 'not-directory' };
  }
  return { ok: true, realPath };
}
