/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SkillDefinition, SkillSource } from '@qwen-code/core';
import path from 'node:path';

type ActiveSkillEvolutionEntry = {
  readonly skill: Pick<
    SkillDefinition,
    'name' | 'location' | 'source'
  >;
};

interface ActiveSkillEvolutionSkill {
  readonly id: string;
  readonly source: SkillSource | undefined;
}

interface ActiveSkillEvolutionRoot {
  readonly id: string;
  readonly dir: string;
}

interface ActiveSkillEvolutionContext {
  readonly skills: readonly ActiveSkillEvolutionSkill[];
  readonly roots: readonly ActiveSkillEvolutionRoot[];
}

export function collectActiveSkillEvolutionContext(
  entries: readonly ActiveSkillEvolutionEntry[],
): ActiveSkillEvolutionContext {
  const skills = entries.map(({ skill }) => ({
    id: skill.name,
    source: skill.source,
  }));
  const rootsByDir = new Map<string, ActiveSkillEvolutionRoot>();
  for (const { skill } of entries) {
    const dir = path.dirname(skill.location);
    if (!rootsByDir.has(dir)) {
      rootsByDir.set(dir, { id: skill.name, dir });
    }
  }
  const roots = [...rootsByDir.values()];
  return { skills, roots };
}
