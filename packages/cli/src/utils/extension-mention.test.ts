/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Extension, SkillConfig } from '@qwen-code/qwen-code-core';
import {
  buildExtensionContextText,
  resolveAdvertisedSkillNames,
} from './extension-mention.js';

const skill = (name: string, description = name): SkillConfig => ({
  name,
  description,
  level: 'extension',
  filePath: `/ext/${name}/SKILL.md`,
  body: '',
});

function makeExtension(overrides?: Partial<Extension>): Extension {
  return {
    name: 'demo',
    type: 'v3',
    path: '/ext/demo',
    config: { name: 'demo', version: '1.0.0' },
    contextFiles: [],
    installMetadata: undefined,
    isActive: true,
    extensionDisplayName: 'Demo',
    ...overrides,
  } as Extension;
}

describe('resolveAdvertisedSkillNames', () => {
  it('advertises the collision-qualified registry name for renamed skills', () => {
    const extension = makeExtension({
      skills: [skill('chat')],
    });
    const cachedSkills = [
      { name: 'demo:chat', extensionName: 'demo' },
      { name: 'other:chat', extensionName: 'other' },
    ];

    expect(resolveAdvertisedSkillNames(extension, cachedSkills)).toEqual([
      'demo:chat',
    ]);
  });

  it('keeps bare registry names for skills that never collided', () => {
    const extension = makeExtension({
      skills: [skill('commit')],
    });
    const cachedSkills = [{ name: 'commit', extensionName: 'demo' }];

    expect(resolveAdvertisedSkillNames(extension, cachedSkills)).toEqual([
      'commit',
    ]);
  });

  it('falls back to manifest names when the cache is cold', () => {
    const extension = makeExtension({
      skills: [skill('chat')],
    });

    expect(resolveAdvertisedSkillNames(extension, null)).toEqual(['chat']);
    expect(resolveAdvertisedSkillNames(extension, undefined)).toEqual(['chat']);
    expect(resolveAdvertisedSkillNames(extension, [])).toEqual(['chat']);
  });

  it('ignores cached skills owned by other extensions', () => {
    const extension = makeExtension({
      skills: [skill('chat')],
    });
    const cachedSkills = [
      { name: 'chat', extensionName: 'unrelated' },
      { name: 'unrelated:chat', extensionName: 'unrelated' },
    ];

    expect(resolveAdvertisedSkillNames(extension, cachedSkills)).toEqual([
      'chat',
    ]);
  });
});

describe('buildExtensionContextText capability line', () => {
  it('renders resolved registry names in the capability line', () => {
    const extension = makeExtension({
      skills: [skill('commit'), skill('chat')],
    });
    const cachedSkills = [
      { name: 'commit', extensionName: 'demo' },
      { name: 'demo:chat', extensionName: 'demo' },
    ];

    const text = buildExtensionContextText(extension, cachedSkills);

    expect(text).toContain(
      '- Skills: commit, demo:chat (invoke via /<skill-name>)',
    );
    expect(text).not.toContain('- Skills: commit, chat');
  });

  it('renders manifest names when no cache is supplied', () => {
    const extension = makeExtension({
      skills: [skill('chat')],
    });

    expect(buildExtensionContextText(extension)).toContain(
      '- Skills: chat (invoke via /<skill-name>)',
    );
  });
});

// ── Truth matrix: resolveAdvertisedSkillNames ──
// Every name source × collision state × entry spelling × operation.
describe('resolveAdvertisedSkillNames truth matrix', () => {
  it.each<{
    extension: { skillName: string; extensionName: string };
    cachedSkills:
      | ReadonlyArray<{ name: string; extensionName?: string }>
      | null
      | undefined;
    expected: string[];
    label: string;
  }>([
    // ── Qualified name from cache takes precedence ──
    {
      extension: { skillName: 'chat', extensionName: 'demo' },
      cachedSkills: [{ name: 'demo:chat', extensionName: 'demo' }],
      expected: ['demo:chat'],
      label: 'qualified cache name wins over manifest',
    },

    // ── Bare cache name when no collision ──
    {
      extension: { skillName: 'commit', extensionName: 'demo' },
      cachedSkills: [{ name: 'commit', extensionName: 'demo' }],
      expected: ['commit'],
      label: 'bare cache name passes through when no collision',
    },

    // ── Cold cache falls back to manifest ──
    {
      extension: { skillName: 'chat', extensionName: 'demo' },
      cachedSkills: null,
      expected: ['chat'],
      label: 'null cache falls back to manifest name',
    },
    {
      extension: { skillName: 'chat', extensionName: 'demo' },
      cachedSkills: undefined,
      expected: ['chat'],
      label: 'undefined cache falls back to manifest name',
    },
    {
      extension: { skillName: 'chat', extensionName: 'demo' },
      cachedSkills: [],
      expected: ['chat'],
      label: 'empty cache falls back to manifest name',
    },

    // ── Other-extension cache entries are ignored ──
    {
      extension: { skillName: 'chat', extensionName: 'demo' },
      cachedSkills: [
        { name: 'chat', extensionName: 'unrelated' },
        { name: 'unrelated:chat', extensionName: 'unrelated' },
      ],
      expected: ['chat'],
      label: 'other-extension cache entries are ignored',
    },

    // ── Collision-qualified cache matches manifest ──
    {
      extension: { skillName: 'chat', extensionName: 'demo' },
      cachedSkills: [
        { name: 'demo:chat', extensionName: 'demo' },
        { name: 'chat', extensionName: 'demo' },
      ],
      expected: ['demo:chat'],
      label: 'collision-qualified cache takes precedence over bare',
    },

    // ── Case-insensitive owner matching ──
    {
      extension: { skillName: 'chat', extensionName: 'demo' },
      cachedSkills: [{ name: 'DEMO:CHAT', extensionName: 'demo' }],
      expected: ['DEMO:CHAT'],
      label: 'cache name preserves its original casing',
    },

    // ── Multiple skills ──
    {
      extension: { skillName: 'chat', extensionName: 'demo' },
      cachedSkills: [{ name: 'demo:chat', extensionName: 'demo' }],
      expected: ['demo:chat'],
      label: 'single skill resolved correctly',
    },

    // ── No skills in extension ──
    {
      extension: { skillName: '', extensionName: 'demo' },
      cachedSkills: [],
      expected: [],
      label: 'extension with no skills returns empty',
    },
  ])('handles $label', ({ extension, cachedSkills, expected }) => {
    const ext = makeExtension({
      skills: extension.skillName ? [skill(extension.skillName)] : [],
    });
    const namedExt = {
      ...ext,
      name: extension.extensionName,
    } as unknown as Extension;

    const result = resolveAdvertisedSkillNames(namedExt, cachedSkills);
    expect(result).toEqual(expected);
  });
});
