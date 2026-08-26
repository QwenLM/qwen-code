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
      // Collision-driven qualification renames a cached skill to
      // `<extension.name>:<name>` (#9408), so a stale entry can carry
      // either its manifest name or the qualified form.
      refs.add(
        extensionSkillRef(extension.name, `${extension.name}:${skill.name}`),
      );
    }
  }
  return refs;
}

export function inactiveExtensionSkillNames(config: Config): Set<string> {
  const names = new Set<string>();
  for (const extension of config.getExtensions()) {
    if (extension.isActive) continue;
    for (const skill of extension.skills ?? []) {
      names.add(skill.name.toLowerCase());
    }
  }
  return names;
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
