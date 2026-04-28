/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertProjectSkillPath,
  assertRealProjectSkillPath,
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

describe('assertRealProjectSkillPath – symlink traversal', () => {
  let tmpDir: string;
  let projectRoot: string;
  let skillsDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-symlink-'));
    projectRoot = path.join(tmpDir, 'project');
    skillsDir = path.join(projectRoot, '.qwen', 'skills');
    outsideDir = path.join(tmpDir, 'outside');
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('accepts a legitimate path inside skills dir', async () => {
    const target = path.join(skillsDir, 'my-skill', 'SKILL.md');
    await expect(
      assertRealProjectSkillPath(target, projectRoot),
    ).resolves.toBeUndefined();
  });

  it('rejects a path whose parent is a symlink pointing outside skills dir', async () => {
    // Create a symlink: .qwen/skills/escape -> ../../outside
    const symlinkPath = path.join(skillsDir, 'escape');
    await fs.symlink(outsideDir, symlinkPath);

    const target = path.join(symlinkPath, 'evil.md');
    await expect(
      assertRealProjectSkillPath(target, projectRoot),
    ).rejects.toThrow('symlink traversal detected');
  });

  it('accepts a path where skills root itself is a symlink to a safe dir', async () => {
    // skills dir → realSkills (still inside project)
    const realSkills = path.join(projectRoot, '.qwen', 'real-skills');
    await fs.mkdir(realSkills, { recursive: true });
    await fs.rm(skillsDir, { recursive: true });
    await fs.symlink(realSkills, skillsDir);

    const target = path.join(skillsDir, 'my-skill', 'SKILL.md');
    await expect(
      assertRealProjectSkillPath(target, projectRoot),
    ).resolves.toBeUndefined();
  });
});
