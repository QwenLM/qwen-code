/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  loadSkillDirectorySet,
  type SkillDirectorySet,
  type SkillProvider,
  type SkillProviderContribution,
} from './skillProvider.js';

/**
 * Project skills include the primary workspace followed by --add-dir roots.
 * Additional roots intentionally remain source=project; they are not a third
 * Skill source or provider type.
 */
export class ProjectSkillProvider implements SkillProvider {
  readonly id = 'project' as const;

  constructor(private readonly directorySets: readonly SkillDirectorySet[]) {}

  async load(): Promise<SkillProviderContribution> {
    const skills: SkillProviderContribution['skills'] = [];
    const loadErrors: SkillProviderContribution['loadErrors'] = [];

    for (const directories of this.directorySets) {
      const result = await loadSkillDirectorySet(directories);
      skills.push(...result.skills);
      loadErrors.push(...result.loadErrors);
    }

    return { source: 'project', skills, loadErrors };
  }
}
