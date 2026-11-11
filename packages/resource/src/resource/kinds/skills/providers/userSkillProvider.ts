/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type SkillDirectorySet,
  type SkillProvider,
  type SkillProviderContribution,
} from './skillProvider.js';
import {
  drainSkillLoadErrors,
  loadSkillsFromCommandsDir,
  loadSkillsFromDir,
  withSkillLoadErrors,
} from '../skillLoader.js';
import { resolve } from 'node:path';
import type { SkillDefinition, SkillLoadError } from '../types.js';

const compatibilitySource = Symbol('user compatibility skills');
type CompatibilityCandidate = { [compatibilitySource]?: true };

export function isUserCompatibilityCandidate(
  candidate: SkillDefinition | SkillLoadError,
): boolean {
  return (candidate as CompatibilityCandidate)[compatibilitySource] === true;
}

export class UserSkillProvider implements SkillProvider {
  readonly id = 'user' as const;

  constructor(private readonly directories: SkillDirectorySet) {}

  async load(): Promise<SkillProviderContribution> {
    const read = (
      load: () => Promise<SkillProviderContribution['skills']>,
      compatibility = false,
    ) =>
      withSkillLoadErrors(async () => {
        const skills = await load();
        const loadErrors = drainSkillLoadErrors();
        return compatibility
          ? {
              skills: skills.map((skill) => ({
                ...skill,
                [compatibilitySource]: true as const,
              })),
              loadErrors: loadErrors.map((error) => ({
                ...error,
                [compatibilitySource]: true as const,
              })),
            }
          : { skills, loadErrors };
      });
    const [commands, compatibility, skills] = await Promise.all([
      read(() => loadSkillsFromCommandsDir(this.directories.commandsDir)),
      this.directories.agentSkillsDir &&
      resolve(this.directories.agentSkillsDir) !== resolve(this.directories.skillsDir)
        ? read(() => loadSkillsFromDir(this.directories.agentSkillsDir!), true)
        : Promise.resolve({ skills: [], loadErrors: [] }),
      read(() => loadSkillsFromDir(this.directories.skillsDir)),
    ]);
    return {
      source: 'user',
      skills: [...commands.skills, ...compatibility.skills, ...skills.skills],
      loadErrors: [
        ...commands.loadErrors,
        ...compatibility.loadErrors,
        ...skills.loadErrors,
      ],
    };
  }
}
