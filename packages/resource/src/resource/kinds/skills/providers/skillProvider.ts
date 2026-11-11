/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import {
  drainSkillLoadErrors,
  withSkillLoadErrors,
  loadSkillsFromCommandsDir,
  loadSkillsFromDir,
} from '../skillLoader.js';
import type { SkillDefinition, SkillLoadError, SkillSource } from '../types.js';

export interface SkillDirectorySet {
  skillsDir: string;
  commandsDir: string;
  agentSkillsDir?: string;
}

export interface SkillProviderContribution {
  source: Extract<SkillSource, 'user' | 'project'>;
  skills: SkillDefinition[];
  loadErrors: SkillLoadError[];
}

export interface SkillProvider {
  readonly id: 'user' | 'project';
  load(): Promise<SkillProviderContribution>;
}

/**
 * Load one scope in compatibility precedence order:
 * commands < .agents/skills < .qwen/skills.
 */
export async function loadSkillDirectorySet(
  directories: SkillDirectorySet,
): Promise<{ skills: SkillDefinition[]; loadErrors: SkillLoadError[] }> {
  return withSkillLoadErrors(async () => {
    const [commands, agentSkills, configSkills] = await Promise.all([
      loadSkillsFromCommandsDir(directories.commandsDir),
      loadCompatibilitySkillsFromDistinctDir(
        directories.skillsDir,
        directories.agentSkillsDir,
      ),
      loadSkillsFromDir(directories.skillsDir),
    ]);

    return {
      skills: [...commands, ...agentSkills, ...configSkills],
      loadErrors: drainSkillLoadErrors(),
    };
  });
}

async function loadCompatibilitySkillsFromDistinctDir(
  skillsDir: string,
  agentSkillsDir?: string,
): Promise<SkillDefinition[]> {
  if (
    !agentSkillsDir ||
    normalizePath(agentSkillsDir) === normalizePath(skillsDir)
  ) {
    return [];
  }
  return loadSkillsFromDir(agentSkillsDir);
}

function normalizePath(input: string): string {
  return path.resolve(input).replace(/\\/g, '/').replace(/\/+$/, '');
}
