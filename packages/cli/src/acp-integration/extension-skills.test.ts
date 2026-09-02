/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, SkillConfig } from '@qwen-code/qwen-code-core';
import { describe, expect, it } from 'vitest';

import {
  inactiveExtensionSkillNames,
  inactiveExtensionSkillRefs,
  isInactiveExtensionSkill,
} from './extension-skills.js';

function configWithExtensions(
  extensions: ReturnType<Config['getExtensions']>,
): Config {
  return {
    getExtensions: () => extensions,
  } as unknown as Config;
}

type TestExtension = ReturnType<Config['getExtensions']>[number];

function extension(
  fields: Pick<TestExtension, 'isActive' | 'name'> &
    Partial<Omit<TestExtension, 'isActive' | 'name'>>,
): TestExtension {
  return {
    id: fields.name,
    version: '1.0.0',
    path: `/extensions/${fields.name}`,
    config: { name: fields.name, version: '1.0.0' },
    contextFiles: [],
    ...fields,
  };
}

function skill(
  name: string,
  extensionName: string,
  level: SkillConfig['level'] = 'extension',
): Pick<SkillConfig, 'extensionName' | 'level' | 'name'> {
  return { name, extensionName, level };
}

function extensionSkill(name: string): SkillConfig {
  return {
    name,
    description: `${name} description`,
    body: `${name} body`,
    filePath: `/skills/${name}/SKILL.md`,
    level: 'extension',
  };
}

describe('extension skill activity helpers', () => {
  it('matches skills from inactive extensions only by canonical name', () => {
    const refs = inactiveExtensionSkillRefs(
      configWithExtensions([
        extension({
          name: 'canonical-ext',
          displayName: 'Shared Display',
          isActive: false,
          skills: [extensionSkill('audit')],
        }),
        extension({
          name: 'active-ext',
          displayName: 'Shared Display',
          isActive: true,
          skills: [extensionSkill('audit')],
        }),
      ]),
    );

    expect(
      isInactiveExtensionSkill(skill('audit', 'canonical-ext'), refs),
    ).toBe(true);
    expect(
      isInactiveExtensionSkill(skill('audit', 'Shared Display'), refs),
    ).toBe(false);
    expect(isInactiveExtensionSkill(skill('audit', 'active-ext'), refs)).toBe(
      false,
    );
  });

  it('matches a registry-qualified skill through its authored name', () => {
    // The registry names an extension skill `ext:audit` while the manifest —
    // what `inactiveExtensionSkillRefs` reads — keeps `audit`. Without the
    // authored-name fallback the lookup misses, which reads as "not inactive"
    // and would expose an inactive extension's skill.
    const refs = inactiveExtensionSkillRefs(
      configWithExtensions([
        extension({
          name: 'ext',
          isActive: false,
          skills: [extensionSkill('audit')],
        }),
      ]),
    );

    expect(
      isInactiveExtensionSkill(
        {
          name: 'ext:audit',
          authoredName: 'audit',
          level: 'extension',
          extensionName: 'ext',
        },
        refs,
      ),
    ).toBe(true);
  });

  it('ignores skills from active extensions', () => {
    const refs = inactiveExtensionSkillRefs(
      configWithExtensions([
        extension({
          name: 'active-ext',
          isActive: true,
          skills: [extensionSkill('audit')],
        }),
      ]),
    );

    expect(isInactiveExtensionSkill(skill('audit', 'active-ext'), refs)).toBe(
      false,
    );
  });

  it('collects inactive extension skill names for commands without extensionName', () => {
    const names = inactiveExtensionSkillNames(
      configWithExtensions([
        extension({
          name: 'inactive-ext',
          isActive: false,
          skills: [extensionSkill('Audit')],
        }),
        extension({
          name: 'active-ext',
          isActive: true,
          skills: [extensionSkill('Review')],
        }),
      ]),
    );

    expect(names).toEqual(new Set(['audit']));
  });

  it('ignores non-extension skills', () => {
    const refs = inactiveExtensionSkillRefs(
      configWithExtensions([
        extension({
          name: 'inactive-ext',
          isActive: false,
          skills: [extensionSkill('audit')],
        }),
      ]),
    );

    expect(
      isInactiveExtensionSkill(skill('audit', 'inactive-ext', 'user'), refs),
    ).toBe(false);
  });
});
