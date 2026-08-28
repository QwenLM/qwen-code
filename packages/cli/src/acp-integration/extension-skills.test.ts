/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, SkillConfig } from '@qwen-code/qwen-code-core';
import { describe, expect, it } from 'vitest';

import {
  extensionSkillRef,
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
  it('matches bare and collision-qualified names from inactive extensions', () => {
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
      isInactiveExtensionSkill(
        skill('canonical-ext:audit', 'canonical-ext'),
        refs,
      ),
    ).toBe(true);
    // SkillManager stopped using displayName as the owner (#9408), so a
    // display-prefixed name no longer appears in the registry.
    expect(
      isInactiveExtensionSkill(skill('audit', 'Shared Display'), refs),
    ).toBe(false);
    expect(isInactiveExtensionSkill(skill('audit', 'active-ext'), refs)).toBe(
      false,
    );
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

  // ── Truth matrix: inactiveExtensionSkillRefs / isInactiveExtensionSkill ──
  describe('inactiveExtensionSkillRefs truth matrix', () => {
    it.each<{
      ext: { extName: string; isActive: boolean; skillName: string };
      skillName: string;
      level: SkillConfig['level'];
      expected: boolean;
      label: string;
    }>([
      // ── Both bare and qualified refs exist for inactive extension ──
      {
        ext: { extName: 'canonical-ext', isActive: false, skillName: 'audit' },
        skillName: 'audit',
        level: 'extension',
        expected: true,
        label: 'bare name matches inactive extension',
      },
      {
        ext: { extName: 'canonical-ext', isActive: false, skillName: 'audit' },
        skillName: 'canonical-ext:audit',
        level: 'extension',
        expected: true,
        label: 'qualified name matches inactive extension',
      },

      // ── Active extension: neither bare nor qualified matches ──
      {
        ext: { extName: 'active-ext', isActive: true, skillName: 'audit' },
        skillName: 'audit',
        level: 'extension',
        expected: false,
        label: 'bare name does not match active extension',
      },
      {
        ext: { extName: 'active-ext', isActive: true, skillName: 'audit' },
        skillName: 'active-ext:audit',
        level: 'extension',
        expected: false,
        label: 'qualified name does not match active extension',
      },

      // ── Owner mismatch: skill from different extension ──
      {
        ext: { extName: 'canonical-ext', isActive: false, skillName: 'audit' },
        skillName: 'other-ext:audit',
        level: 'extension',
        expected: false,
        label: 'qualified name with wrong owner does not match',
      },
      {
        ext: { extName: 'other-ext', isActive: false, skillName: 'audit' },
        skillName: 'canonical-ext:audit',
        level: 'extension',
        expected: false,
        label: 'ref to one extension does not match another',
      },

      // ── Non-extension level ──
      {
        ext: { extName: 'inactive-ext', isActive: false, skillName: 'audit' },
        skillName: 'audit',
        level: 'user',
        expected: false,
        label: 'non-extension level skill is not inactive',
      },

      // ── Empty checked name ──
      {
        ext: { extName: 'empty-ext', isActive: false, skillName: 'audit' },
        skillName: '',
        level: 'extension',
        expected: false,
        label: 'empty checked name matches no ref',
      },
    ])('handles $label', ({ ext, skillName, level, expected }) => {
      const refs = inactiveExtensionSkillRefs(
        configWithExtensions([
          extension({
            name: ext.extName,
            isActive: ext.isActive,
            skills: [extensionSkill(ext.skillName)],
          }),
        ]),
      );
      const isInactive = isInactiveExtensionSkill(
        skill(skillName, ext.extName, level),
        refs,
      );
      expect(isInactive).toBe(expected);
    });

    it('collects both bare and qualified refs for each inactive skill', () => {
      const refs = inactiveExtensionSkillRefs(
        configWithExtensions([
          extension({
            name: 'ext-a',
            isActive: false,
            skills: [extensionSkill('chat'), extensionSkill('docs')],
          }),
        ]),
      );

      // Each skill produces two refs: bare and qualified
      expect(refs.size).toBe(4);
      expect(refs.has(`${extensionSkillRef('ext-a', 'chat')}` as string)).toBe(
        true,
      );
      expect(
        refs.has(`${extensionSkillRef('ext-a', 'ext-a:chat')}` as string),
      ).toBe(true);
      expect(refs.has(`${extensionSkillRef('ext-a', 'docs')}` as string)).toBe(
        true,
      );
      expect(
        refs.has(`${extensionSkillRef('ext-a', 'ext-a:docs')}` as string),
      ).toBe(true);
    });

    it('ignores active extensions entirely', () => {
      const refs = inactiveExtensionSkillRefs(
        configWithExtensions([
          extension({
            name: 'active-ext',
            isActive: true,
            skills: [extensionSkill('chat')],
          }),
          extension({
            name: 'inactive-ext',
            isActive: false,
            skills: [extensionSkill('docs')],
          }),
        ]),
      );

      // Only the inactive extension produces refs: 1 skill × 2 spellings = 2.
      expect(refs.size).toBe(2);
    });
  });
});
