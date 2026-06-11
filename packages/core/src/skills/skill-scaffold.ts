/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { validateSkillName } from './types.js';
import { SKILL_FILE_NAME } from './skill-paths.js';

function buildTemplate(name: string): string {
  return `---
name: ${name}
description: Describe what this skill does
---

# ${name}

Add your skill instructions here.
`;
}

/**
 * Creates a new skill directory and SKILL.md file under \`skillsDir/<name>/\`.
 *
 * Throws if the skill already exists (uses 'wx' open flag so the create
 * is atomic — no partial state if the directory already contains SKILL.md).
 *
 * @param skillsDir  Absolute path to the skills root (e.g. ~/.qwen/skills)
 * @param name       Skill name — must pass validateSkillName()
 * @returns          Absolute path to the newly created SKILL.md
 */
export async function scaffoldSkill(
  skillsDir: string,
  name: string,
): Promise<string> {
  validateSkillName(name);

  const skillDir = path.join(skillsDir, name);
  const skillFile = path.join(skillDir, SKILL_FILE_NAME);

  await fs.mkdir(skillDir, { recursive: true });

  try {
    await fs.writeFile(skillFile, buildTemplate(name), { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `Skill "${name}" already exists at ${skillFile}. Edit it directly or remove it first.`,
      );
    }
    throw err;
  }

  return skillFile;
}
