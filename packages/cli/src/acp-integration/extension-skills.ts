/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  authoredSkillName,
  qualifySkillName,
  type Config,
  type SkillConfig,
} from '@qwen-code/qwen-code-core';

function extensionSkillRef(extensionName: string, skillName: string): string {
  return `${extensionName}\0${skillName}`;
}

export function inactiveExtensionSkillRefs(config: Config): Set<string> {
  const refs = new Set<string>();
  for (const extension of config.getExtensions()) {
    if (extension.isActive) continue;
    for (const skill of extension.skills ?? []) {
      refs.add(extensionSkillRef(extension.name, skill.name));
    }
  }
  return refs;
}

export function inactiveExtensionSkillNames(config: Config): Set<string> {
  const names = new Set<string>();
  for (const extension of config.getExtensions()) {
    if (extension.isActive) continue;
    for (const skill of extension.skills ?? []) {
      // Registry spelling, matching the live registry rows: callers compare
      // these against registry identities, where the authored spelling would
      // read as "not inactive" for a renamed skill (fail-open).
      names.add(qualifySkillName(extension.name, skill.name).toLowerCase());
    }
  }
  return names;
}

export function isInactiveExtensionSkill(
  skill: Pick<SkillConfig, 'extensionName' | 'level' | 'name' | 'authoredName'>,
  inactiveSkillRefs: Set<string>,
): boolean {
  return (
    skill.level === 'extension' &&
    skill.extensionName !== undefined &&
    // The ref set holds authored names because it is built from the manifest,
    // while the registry name carries the owner prefix.
    inactiveSkillRefs.has(
      extensionSkillRef(skill.extensionName, authoredSkillName(skill)),
    )
  );
}
