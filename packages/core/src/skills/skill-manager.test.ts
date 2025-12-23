/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SkillManager } from './skill-manager.js';
import type { Config } from '../config/config.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { rimraf } from 'rimraf';

vi.mock('glob', async (importOriginal) => {
  const actual = await importOriginal<typeof import('glob')>();
  return {
    ...actual,
    glob: vi.fn().mockResolvedValue([]),
    globSync: vi.fn().mockReturnValue([]),
  };
});

describe('SkillManager', () => {
  let skillManager: SkillManager;
  let projectRoot: string;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-manager-home-'));
    projectRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'skill-manager-project-'),
    );
    const mockConfig = {
      getProjectRoot: () => projectRoot,
    } as Config;
    skillManager = new SkillManager(mockConfig);

    vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
  });

  afterEach(async () => {
    await rimraf(projectRoot);
    await rimraf(homeDir);
  });

  const createSkillFS = async (
    baseDir: string,
    name: string,
    description: string,
    instructions: string,
  ) => {
    const skillDir = path.join(baseDir, '.qwen', 'skills', name);
    await fs.mkdir(skillDir, { recursive: true });
    const md = `---
name: ${name}
description: ${description}
---
${instructions}`;
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), md);
  };

  it('loads skills from project and global directories', async () => {
    await createSkillFS(
      projectRoot,
      'project-skill',
      'Project Skill',
      'proj inst',
    );
    await createSkillFS(homeDir, 'global-skill', 'Global Skill', 'glob inst');

    const { glob } = await import('glob');
    const mockedGlob = vi.mocked(glob);
    mockedGlob.mockResolvedValue([
      path.join(projectRoot, '.qwen', 'skills', 'project-skill', 'SKILL.md'),
      path.join(homeDir, '.qwen', 'skills', 'global-skill', 'SKILL.md'),
    ]);

    const skills = await skillManager.listSkills({ force: true });

    expect(skills).toHaveLength(2);
    expect(await skillManager.loadSkill('project-skill')).toBeDefined();
    expect(await skillManager.loadSkill('global-skill')).toBeDefined();
  });

  it('supports skill.md (lowercase) files', async () => {
    const skillName = 'lowercase-skill';
    const skillDir = path.join(projectRoot, '.qwen', 'skills', skillName);
    await fs.mkdir(skillDir, { recursive: true });
    const md = `---
name: ${skillName}
description: lowercase
---
instructions`;
    await fs.writeFile(path.join(skillDir, 'skill.md'), md);

    const { glob } = await import('glob');
    const mockedGlob = vi.mocked(glob);
    mockedGlob.mockResolvedValue([path.join(skillDir, 'skill.md')]);

    await skillManager.listSkills({ force: true });
    const skill = await skillManager.loadSkill(skillName);

    expect(skill).toBeDefined();
    expect(skill?.metadata.description).toBe('lowercase');
  });

  it('project skills override global skills with the same name', async () => {
    await createSkillFS(homeDir, 'shared-skill', 'Global Shared', 'global');
    await createSkillFS(
      projectRoot,
      'shared-skill',
      'Project Shared',
      'project',
    );

    const { glob } = await import('glob');
    const mockedGlob = vi.mocked(glob);
    mockedGlob.mockResolvedValue([
      path.join(homeDir, '.qwen', 'skills', 'shared-skill', 'SKILL.md'),
      path.join(projectRoot, '.qwen', 'skills', 'shared-skill', 'SKILL.md'),
    ]);
    await skillManager.listSkills({ force: true });
    const skill = await skillManager.loadSkill('shared-skill');

    expect(skill?.metadata.description).toBe('Project Shared');
  });

  it('isNameAvailable returns true for a new name', async () => {
    expect(await skillManager.isNameAvailable('new-skill')).toBe(true);
  });

  it('isNameAvailable returns false for an existing name', async () => {
    await createSkillFS(projectRoot, 'existing-skill', 'desc', 'inst');
    const { glob } = await import('glob');
    const mockedGlob = vi.mocked(glob);
    mockedGlob.mockResolvedValue([
      path.join(projectRoot, '.qwen', 'skills', 'existing-skill', 'SKILL.md'),
    ]);
    await skillManager.listSkills({ force: true });
    expect(await skillManager.isNameAvailable('existing-skill')).toBe(false);
  });

  it('getSkillPath returns correct path for project level', () => {
    const skillPath = skillManager.getSkillPath(
      'my-skill',
      'project',
      projectRoot,
    );
    expect(skillPath).toBe(
      path.join(projectRoot, '.qwen', 'skills', 'my-skill', 'SKILL.md'),
    );
  });

  it('getSkillPath returns correct path for global level', () => {
    const skillPath = skillManager.getSkillPath(
      'my-skill',
      'user',
      projectRoot,
    );
    expect(skillPath).toBe(
      path.join(homeDir, '.qwen', 'skills', 'my-skill', 'SKILL.md'),
    );
  });

  it('createSkill creates the skill files and directories', async () => {
    await skillManager.createSkill(
      {
        name: 'new-skill',
        description: 'New Skill Desc',
        instructions: 'do stuff',
      },
      { level: 'project', overwrite: false, projectRoot },
    );

    const skillDir = path.join(projectRoot, '.qwen', 'skills', 'new-skill');
    await expect(
      fs.stat(path.join(skillDir, 'SKILL.md')),
    ).resolves.toBeDefined();
  });

  it('throws an error if creating an existing skill without overwrite', async () => {
    await createSkillFS(projectRoot, 'existing-skill', 'desc', 'inst');
    const { glob } = await import('glob');
    const mockedGlob = vi.mocked(glob);
    mockedGlob.mockResolvedValue([
      path.join(projectRoot, '.qwen', 'skills', 'existing-skill', 'SKILL.md'),
    ]);
    await skillManager.listSkills({ force: true });

    await expect(
      skillManager.createSkill(
        { name: 'existing-skill', description: 'desc' },
        { level: 'project', overwrite: false, projectRoot },
      ),
    ).rejects.toThrow(
      'Skill "existing-skill" already exists at project level.',
    );
  });

  describe('deleteSkill', () => {
    it('should delete an existing skill directory and remove it from memory', async () => {
      const skillName = 'to-delete-skill';
      await createSkillFS(projectRoot, skillName, 'desc', 'inst');
      const { glob } = await import('glob');
      const mockedGlob = vi.mocked(glob);
      mockedGlob.mockResolvedValue([
        path.join(projectRoot, '.qwen', 'skills', skillName, 'SKILL.md'),
      ]);
      await skillManager.listSkills({ force: true });

      expect(await skillManager.loadSkill(skillName)).toBeDefined();

      const skillPath = path.join(projectRoot, '.qwen', 'skills', skillName);
      await skillManager.deleteSkill(skillPath);

      await expect(fs.stat(skillPath)).rejects.toThrow();
      expect(await skillManager.loadSkill(skillName)).toBeUndefined();
    });

    it('should do nothing if skill path does not exist', async () => {
      const nonExistentPath = path.join(
        projectRoot,
        '.qwen',
        'skills',
        'non-existent',
      );
      await expect(
        skillManager.deleteSkill(nonExistentPath),
      ).resolves.not.toThrow();
    });
  });

  describe('getSkillFileTree', () => {
    it('should generate a correct file tree string', async () => {
      const skillDir = path.join(projectRoot, '.qwen', 'skills', 'tree-skill');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'file1.txt'), 'content1');
      await fs.mkdir(path.join(skillDir, 'subdir'));
      await fs.writeFile(
        path.join(skillDir, 'subdir', 'file2.txt'),
        'content2',
      );

      const { glob } = await import('glob');
      const mockedGlob = vi.mocked(glob);
      // Mock glob to return the files we just created (simulating nodir: true)
      mockedGlob.mockResolvedValueOnce([
        path.join(skillDir, 'file1.txt'),
        path.join(skillDir, 'subdir', 'file2.txt'),
      ]);

      const treeString = await skillManager.getSkillFileTree(skillDir);

      expect(treeString).toContain('<file_tree>');
      expect(treeString).toContain(skillDir);
      // Simple check for structure, since glob order might vary or exact format
      // depends on implementation details
      expect(treeString).toContain('file1.txt');
      expect(treeString).toContain('subdir/');
      expect(treeString).toContain('file2.txt');
    });

    it('should handle empty directories', async () => {
      const skillDir = path.join(projectRoot, '.qwen', 'skills', 'empty-skill');
      await fs.mkdir(skillDir, { recursive: true });

      const { glob } = await import('glob');
      const mockedGlob = vi.mocked(glob);
      mockedGlob.mockResolvedValueOnce([]);

      const treeString = await skillManager.getSkillFileTree(skillDir);

      expect(treeString).toContain(
        '<file_tree>No files found in skill directory.</file_tree>',
      );
    });
  });
});
