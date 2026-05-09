/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';

export const PROJECT_SKILLS_RELATIVE_DIR = path.join('.qwen', 'skills');
export const SKILL_FILE_NAME = 'SKILL.md';

export function getProjectSkillsRoot(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_SKILLS_RELATIVE_DIR);
}

export function isProjectSkillPath(
  filePath: string,
  projectRoot: string,
): boolean {
  const skillsRoot = path.resolve(getProjectSkillsRoot(projectRoot));
  const resolved = path.resolve(projectRoot, filePath);
  return resolved === skillsRoot || resolved.startsWith(skillsRoot + path.sep);
}

export function assertProjectSkillPath(
  targetPath: string,
  projectRoot: string,
): void {
  if (!isProjectSkillPath(targetPath, projectRoot)) {
    throw new Error(
      `Skills writes are restricted to ${getProjectSkillsRoot(projectRoot)}. ` +
        'Use the Skills UI to manage user or bundled skills.',
    );
  }
}

/**
 * Async variant that also rejects symlink traversal.
 *
 * `path.resolve()` is a purely lexical operation and does not dereference
 * symlinks. If any component of `targetPath` (or its parent chain) is a
 * symlink pointing outside the skills directory, the lexical check passes
 * but `fs.writeFile/readFile/rm` will follow the link and mutate the real
 * target. This function resolves the nearest existing ancestor to its real
 * filesystem path and verifies it still sits under the real skills root.
 */
export async function assertRealProjectSkillPath(
  targetPath: string,
  projectRoot: string,
): Promise<void> {
  // First do the cheap lexical check.
  assertProjectSkillPath(targetPath, projectRoot);

  const skillsRoot = getProjectSkillsRoot(projectRoot);

  // Resolve the real path of the skills root (it may itself be a symlink).
  let realSkillsRoot: string;
  try {
    realSkillsRoot = await fs.realpath(skillsRoot);
  } catch {
    // Skills root does not exist yet — nothing to traverse.
    return;
  }

  // Walk up from targetPath to find the nearest existing ancestor, then
  // resolve it to its real path and verify containment.
  let check = targetPath;
  for (;;) {
    try {
      const real = await fs.realpath(check);
      // Found an existing node — verify it is inside the real skills root.
      if (
        real !== realSkillsRoot &&
        !real.startsWith(realSkillsRoot + path.sep)
      ) {
        throw new Error(
          `Skills write blocked: symlink traversal detected — resolved path "${real}" ` +
            `is outside the project skills directory "${realSkillsRoot}".`,
        );
      }
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Before treating a missing path as safe, check whether the path
        // itself exists as a dangling symlink (lstat succeeds but realpath
        // fails with ENOENT because the link target is missing). A dangling
        // symlink could be used to pre-aim a write at an arbitrary location.
        try {
          const lstatResult = await fs.lstat(check);
          if (lstatResult.isSymbolicLink()) {
            throw new Error(
              `Skills write blocked: dangling symlink detected at "${check}".`,
            );
          }
        } catch (lstatErr) {
          // lstat itself threw — re-throw only if it's not ENOENT (path truly
          // doesn't exist at all, which is safe to walk up from).
          if ((lstatErr as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw lstatErr;
          }
        }
        const parent = path.dirname(check);
        if (parent === check) {
          // Reached filesystem root without finding an existing node.
          return;
        }
        check = parent;
        continue;
      }
      throw err;
    }
  }
}

export function sanitizeSkillName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
}
