/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Collision detection for the auto-skill creation path (issue #4437).
 *
 * The skill-review agent is *supposed* to inspect existing skills and pick a
 * non-colliding name before calling `write_file`, but that is advisory only.
 * When the agent gets it wrong, the generic `write_file` tool happily
 * overwrites the existing `SKILL.md`, losing the prior content.
 *
 * This module supplies the safety net applied at the skill-write boundary:
 * given a target path the agent wants to write to, it decides whether the
 * write should proceed as-is, be redirected to a renamed sibling, or be
 * skipped — without touching the generic `write_file` tool itself.
 *
 * Strategies:
 *  - `rename`    (default): if the target file already exists, write to
 *                `<dir>-2/SKILL.md`, `<dir>-3/SKILL.md`, etc. until a free
 *                slot is found. Preserves both the existing skill and the
 *                new one.
 *  - `skip`      : if the target file already exists, skip the write and
 *                report the collision back to the agent.
 *  - `overwrite` : preserve the pre-fix behaviour — the existing file is
 *                clobbered. Provided for users who explicitly opt in.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  getProjectSkillsRoot,
  isProjectSkillPath,
} from '../skills/skill-paths.js';

export type SkillCollisionStrategy = 'rename' | 'skip' | 'overwrite';

export const DEFAULT_SKILL_COLLISION_STRATEGY: SkillCollisionStrategy =
  'rename';

/**
 * Hard cap on the number of `-N` suffixes attempted before giving up.
 * 100 is far beyond any realistic collision count and stops the loop from
 * spinning if something pathological happens (e.g. a filesystem returning
 * EEXIST forever).
 */
const MAX_RENAME_ATTEMPTS = 100;

export interface SkillCollisionWriteAction {
  action: 'write';
  /** Final on-disk path the write should target. */
  filePath: string;
  /** Original path the caller proposed, prior to any rename. */
  originalFilePath: string;
  /** Set when the write was redirected — used for the warning log/result. */
  renamedFrom?: string;
}

export interface SkillCollisionSkipAction {
  action: 'skip';
  /** Path the caller proposed; unchanged. */
  filePath: string;
  originalFilePath: string;
  /** Human-readable reason the write was skipped. */
  reason: string;
}

export type SkillCollisionResolution =
  | SkillCollisionWriteAction
  | SkillCollisionSkipAction;

/**
 * Returns true if the given absolute path looks like a `SKILL.md` under
 * `<projectRoot>/.qwen/skills/<name>/`. The guard only acts on these paths
 * — writes to anything else (auxiliary files, attachments) flow through
 * unchanged.
 */
export function isSkillMdPath(filePath: string, projectRoot: string): boolean {
  if (!isProjectSkillPath(filePath, projectRoot)) return false;
  const skillsRoot = path.resolve(getProjectSkillsRoot(projectRoot));
  const resolved = path.resolve(filePath);
  // Must be under skillsRoot/<dir>/SKILL.md — i.e. relative depth of 2.
  const rel = path.relative(skillsRoot, resolved);
  if (!rel || rel.startsWith('..')) return false;
  const parts = rel.split(path.sep);
  return parts.length === 2 && parts[1] === 'SKILL.md';
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    // EACCES / EPERM / EISDIR — surface as "exists" so we don't blindly overwrite.
    return true;
  }
}

/**
 * Compute the next available skill path by appending `-2`, `-3`, ... to the
 * skill directory name until a non-existing slot is found.
 *
 * Example:
 *   <root>/.qwen/skills/foo/SKILL.md
 *   → <root>/.qwen/skills/foo-2/SKILL.md      (if foo exists)
 *   → <root>/.qwen/skills/foo-3/SKILL.md      (if foo and foo-2 exist)
 */
export async function findNextAvailableSkillPath(
  filePath: string,
): Promise<string> {
  const dir = path.dirname(filePath);
  const fileName = path.basename(filePath);
  const parent = path.dirname(dir);
  const skillName = path.basename(dir);
  for (let i = 2; i <= MAX_RENAME_ATTEMPTS; i++) {
    const candidate = path.join(parent, `${skillName}-${i}`, fileName);
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new Error(
    `Could not find an available skill name after ${MAX_RENAME_ATTEMPTS} ` +
      `attempts for "${filePath}". The skills directory may be in a broken state.`,
  );
}

/**
 * Resolve a potential collision for the given write target.
 *
 * For paths *outside* `<root>/.qwen/skills/<name>/SKILL.md` (e.g. attachments
 * referenced by a skill), the resolution is always `action: 'write'` with
 * the original path — the guard only governs the primary SKILL.md slot.
 */
export async function resolveSkillCollision(
  filePath: string,
  strategy: SkillCollisionStrategy,
  projectRoot: string,
): Promise<SkillCollisionResolution> {
  const original = filePath;
  if (!isSkillMdPath(filePath, projectRoot)) {
    return { action: 'write', filePath, originalFilePath: original };
  }
  const exists = await pathExists(filePath);
  if (!exists) {
    return { action: 'write', filePath, originalFilePath: original };
  }
  switch (strategy) {
    case 'overwrite':
      return { action: 'write', filePath, originalFilePath: original };
    case 'skip':
      return {
        action: 'skip',
        filePath,
        originalFilePath: original,
        reason:
          `Skill already exists at ${filePath}. Skipping write because ` +
          `collision strategy is 'skip'. Choose a different skill name and retry.`,
      };
    case 'rename':
    default: {
      const renamed = await findNextAvailableSkillPath(filePath);
      return {
        action: 'write',
        filePath: renamed,
        originalFilePath: original,
        renamedFrom: original,
      };
    }
  }
}

/**
 * Enumerate existing project skill directory names so the planner prompt
 * can list them. Returns an empty array if the skills root does not exist
 * yet or cannot be read.
 *
 * Names returned are the directory basenames (e.g. `"foo-skill"`), not the
 * frontmatter `name:` field — the directory layout is what governs the
 * write path, so that is what the agent needs to avoid colliding with.
 */
export async function listExistingProjectSkillNames(
  projectRoot: string,
): Promise<string[]> {
  const skillsRoot = getProjectSkillsRoot(projectRoot);
  let entries;
  try {
    entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    // Permission or other read errors — best-effort: return empty.
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Confirm a SKILL.md actually exists so half-built dirs don't pollute.
    const skillFile = path.join(skillsRoot, entry.name, 'SKILL.md');
    if (await pathExists(skillFile)) {
      names.push(entry.name);
    }
  }
  names.sort();
  return names;
}
