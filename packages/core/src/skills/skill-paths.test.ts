/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertProjectSkillPath,
  getProjectSkillsRoot,
  isProjectSkillPath,
  sanitizeSkillName,
} from './skill-paths.js';

describe('skill project paths', () => {
  const projectRoot = '/tmp/project';

  it('resolves the project skills root', () => {
    expect(getProjectSkillsRoot(projectRoot)).toBe(
      path.join(projectRoot, '.qwen', 'skills'),
    );
  });

  it('allows paths inside project .qwen/skills', () => {
    const skillPath = path.join(
      projectRoot,
      '.qwen',
      'skills',
      'my-skill',
      'SKILL.md',
    );
    expect(isProjectSkillPath(skillPath, projectRoot)).toBe(true);
    expect(() => assertProjectSkillPath(skillPath, projectRoot)).not.toThrow();
  });

  it('rejects sibling paths that merely share the prefix', () => {
    const sibling = path.join(projectRoot, '.qwen', 'skills-evil', 'SKILL.md');
    expect(isProjectSkillPath(sibling, projectRoot)).toBe(false);
    expect(() => assertProjectSkillPath(sibling, projectRoot)).toThrow(
      'skill_manage can only write to',
    );
  });

  it('normalizes skill names', () => {
    expect(sanitizeSkillName(' My Skill! ')).toBe('my-skill-');
  });
});
