/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, SkillConfig } from '@qwen-code/qwen-code-core';

function extensionSkillRef(extensionName: string, skillName: string): string {
  return `${extensionName}\0${skillName}`;
}

export function inactiveExtensionSkillRefs(config: Config): Set<string> {
  const refs = new Set<string>();
  for (const extension of config.getExtensions()) {
    if (extension.isActive) continue;
    for (const skill of extension.skills ?? []) {
      refs.add(extensionSkillRef(extension.name, skill.name));
      // SkillManager exposes extensionName as displayName ?? name.
      if (extension.displayName) {
        refs.add(extensionSkillRef(extension.displayName, skill.name));
      }
    }
  }
  return refs;
}

export function isInactiveExtensionSkill(
  skill: Pick<SkillConfig, 'extensionName' | 'level' | 'name'>,
  inactiveSkillRefs: Set<string>,
): boolean {
  return (
    skill.level === 'extension' &&
    skill.extensionName !== undefined &&
    inactiveSkillRefs.has(extensionSkillRef(skill.extensionName, skill.name))
  );
}
