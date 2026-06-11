/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { validateSkillName } from './types.js';
import { SKILL_FILE_NAME } from './skill-paths.js';

/**
 * Deletes a skill directory (and its contents) from \`skillsDir/<name>/\`.
 *
 * Safety:
 * - Rejects names that fail validateSkillName (blocks path traversal via '..')
 * - Verifies SKILL.md exists before removing so we don't silently delete an
 *   arbitrary directory that happens to live at that path.
 *
 * @param skillsDir  Absolute path to the skills root (e.g. ~/.qwen/skills)
 * @param name       Skill name to remove
 */
export async function removeSkill(
  skillsDir: string,
  name: string,
): Promise<void> {
  validateSkillName(name);

  const skillDir = path.join(skillsDir, name);
  const skillFile = path.join(skillDir, SKILL_FILE_NAME);

  try {
    await fs.access(skillFile);
  } catch {
    throw new Error(
      `Skill "${name}" not found at ${skillDir}. Use /skills to list available skills.`,
    );
  }

  await fs.rm(skillDir, { recursive: true });
}
