/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';

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
  const resolved = path.resolve(filePath);
  return resolved === skillsRoot || resolved.startsWith(skillsRoot + path.sep);
}

export function assertProjectSkillPath(
  targetPath: string,
  projectRoot: string,
): void {
  if (!isProjectSkillPath(targetPath, projectRoot)) {
    throw new Error(
      `skill_manage can only write to ${getProjectSkillsRoot(projectRoot)}. ` +
        'Use the Skills UI to manage user or bundled skills.',
    );
  }
}

export function sanitizeSkillName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
}
