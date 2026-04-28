/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  SkillActivationRegistry,
  splitConditionalSkills,
} from './skill-activation.js';
import type { SkillConfig } from './types.js';

function makeSkill(overrides: Partial<SkillConfig>): SkillConfig {
  return {
    name: overrides.name ?? 'test-skill',
    description: overrides.description ?? 'desc',
    body: overrides.body ?? '',
    level: overrides.level ?? 'project',
    filePath: overrides.filePath ?? '/proj/.qwen/skills/test/SKILL.md',
    ...overrides,
  };
}

describe('splitConditionalSkills', () => {
  it('treats skills without paths as unconditional', () => {
    const skills = [makeSkill({ name: 'a' })];
    const { unconditional, conditional } = splitConditionalSkills(skills);
    expect(unconditional).toHaveLength(1);
    expect(conditional).toHaveLength(0);
  });

  it('treats empty paths array as unconditional', () => {
    const skills = [makeSkill({ name: 'a', paths: [] })];
    const { unconditional, conditional } = splitConditionalSkills(skills);
    expect(unconditional).toHaveLength(1);
    expect(conditional).toHaveLength(0);
  });

  it('classifies skills with non-empty paths as conditional', () => {
    const skills = [
      makeSkill({ name: 'a' }),
      makeSkill({ name: 'b', paths: ['src/**/*.tsx'] }),
    ];
    const { unconditional, conditional } = splitConditionalSkills(skills);
    expect(unconditional.map((s) => s.name)).toEqual(['a']);
    expect(conditional.map((s) => s.name)).toEqual(['b']);
  });
});

describe('SkillActivationRegistry', () => {
  const projectRoot = '/project';

  it('returns empty when no conditional skills are registered', () => {
    const reg = new SkillActivationRegistry([], projectRoot);
    expect(reg.matchAndConsume('/project/src/App.tsx')).toEqual([]);
    expect(reg.totalCount).toBe(0);
  });

  it('activates a conditional skill when a matching path is touched', () => {
    const reg = new SkillActivationRegistry(
      [makeSkill({ name: 'tsx-helper', paths: ['src/**/*.tsx'] })],
      projectRoot,
    );
    const newly = reg.matchAndConsume('/project/src/App.tsx');
    expect(newly).toEqual(['tsx-helper']);
    expect(reg.isActivated('tsx-helper')).toBe(true);
    expect(reg.activatedCount).toBe(1);
  });

  it('does not re-activate an already-active skill on subsequent matches', () => {
    const reg = new SkillActivationRegistry(
      [makeSkill({ name: 'tsx-helper', paths: ['src/**/*.tsx'] })],
      projectRoot,
    );
    expect(reg.matchAndConsume('/project/src/A.tsx')).toEqual(['tsx-helper']);
    // Second touch of the same pattern returns nothing new.
    expect(reg.matchAndConsume('/project/src/B.tsx')).toEqual([]);
    expect(reg.activatedCount).toBe(1);
  });

  it('returns empty for paths that do not match any skill', () => {
    const reg = new SkillActivationRegistry(
      [makeSkill({ name: 'tsx-helper', paths: ['src/**/*.tsx'] })],
      projectRoot,
    );
    expect(reg.matchAndConsume('/project/lib/utils.py')).toEqual([]);
  });

  it('activates multiple skills whose globs overlap on a single file', () => {
    const reg = new SkillActivationRegistry(
      [
        makeSkill({ name: 'tsx-helper', paths: ['src/**/*.tsx'] }),
        makeSkill({ name: 'app-helper', paths: ['src/App.tsx'] }),
      ],
      projectRoot,
    );
    const newly = reg.matchAndConsume('/project/src/App.tsx');
    expect(newly.sort()).toEqual(['app-helper', 'tsx-helper']);
  });

  it('accepts relative file paths by resolving against the project root', () => {
    const reg = new SkillActivationRegistry(
      [makeSkill({ name: 'tsx-helper', paths: ['src/**/*.tsx'] })],
      projectRoot,
    );
    expect(reg.matchAndConsume('src/App.tsx')).toEqual(['tsx-helper']);
  });

  it('ignores paths outside the project root', () => {
    const reg = new SkillActivationRegistry(
      [makeSkill({ name: 'tsx-helper', paths: ['src/**/*.tsx'] })],
      projectRoot,
    );
    expect(reg.matchAndConsume('/other/project/src/App.tsx')).toEqual([]);
    expect(reg.activatedCount).toBe(0);
  });

  it('supports multiple glob patterns per skill (OR semantics)', () => {
    const reg = new SkillActivationRegistry(
      [
        makeSkill({
          name: 'multi',
          paths: ['src/**/*.tsx', 'test/**/*.ts'],
        }),
      ],
      projectRoot,
    );
    // Both patterns should activate the same skill, but only once total.
    expect(reg.matchAndConsume('/project/test/foo.ts')).toEqual(['multi']);
    expect(reg.matchAndConsume('/project/src/Bar.tsx')).toEqual([]);
  });
});
