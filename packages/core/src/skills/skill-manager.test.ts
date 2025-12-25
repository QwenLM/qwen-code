/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SkillManager } from './skill-manager.js';
import { type SkillConfig, SkillError } from './types.js';
import type { Config } from '../config/config.js';
import { makeFakeConfig } from '../test-utils/config.js';

// Mock file system operations
vi.mock('fs/promises');
vi.mock('os');

// Mock yaml parser - use vi.hoisted for proper hoisting
const mockParseYaml = vi.hoisted(() => vi.fn());

vi.mock('../utils/yaml-parser.js', () => ({
  parse: mockParseYaml,
  stringify: vi.fn(),
}));

describe('SkillManager', () => {
  let manager: SkillManager;
  let mockConfig: Config;

  beforeEach(() => {
    // Create mock Config object using test utility
    mockConfig = makeFakeConfig({});

    // Mock the project root method
    vi.spyOn(mockConfig, 'getProjectRoot').mockReturnValue('/test/project');

    // Mock os.homedir
    vi.mocked(os.homedir).mockReturnValue('/home/user');

    // Reset and setup mocks
    vi.clearAllMocks();

    // Setup yaml parser mocks with sophisticated behavior
    mockParseYaml.mockImplementation((yamlString: string) => {
      // Handle different test cases based on YAML content
      if (yamlString.includes('allowedTools:')) {
        return {
          name: 'test-skill',
          description: 'A test skill',
          allowedTools: ['read_file', 'write_file'],
        };
      }
      if (yamlString.includes('name: skill1')) {
        return { name: 'skill1', description: 'First skill' };
      }
      if (yamlString.includes('name: skill2')) {
        return { name: 'skill2', description: 'Second skill' };
      }
      if (yamlString.includes('name: skill3')) {
        return { name: 'skill3', description: 'Third skill' };
      }
      if (!yamlString.includes('name:')) {
        return { description: 'A test skill' }; // Missing name case
      }
      if (!yamlString.includes('description:')) {
        return { name: 'test-skill' }; // Missing description case
      }
      // Default case
      return {
        name: 'test-skill',
        description: 'A test skill',
      };
    });

    manager = new SkillManager(mockConfig);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const validSkillConfig: SkillConfig = {
    name: 'test-skill',
    description: 'A test skill',
    level: 'project',
    filePath: '/test/project/.qwen/skills/test-skill/SKILL.md',
    body: 'You are a helpful assistant with this skill.',
  };

  const validMarkdown = `---
name: test-skill
description: A test skill
---

You are a helpful assistant with this skill.
`;

  describe('parseSkillContent', () => {
    it('should parse valid markdown content', () => {
      const config = manager.parseSkillContent(
        validMarkdown,
        validSkillConfig.filePath,
        'project',
      );

      expect(config.name).toBe('test-skill');
      expect(config.description).toBe('A test skill');
      expect(config.body).toBe('You are a helpful assistant with this skill.');
      expect(config.level).toBe('project');
      expect(config.filePath).toBe(validSkillConfig.filePath);
    });

    it('should parse content with allowedTools', () => {
      const markdownWithTools = `---
name: test-skill
description: A test skill
allowedTools:
  - read_file
  - write_file
---

You are a helpful assistant with this skill.
`;

      const config = manager.parseSkillContent(
        markdownWithTools,
        validSkillConfig.filePath,
        'project',
      );

      expect(config.allowedTools).toEqual(['read_file', 'write_file']);
    });

    it('should determine level from file path', () => {
      const projectPath = '/test/project/.qwen/skills/test-skill/SKILL.md';
      const userPath = '/home/user/.qwen/skills/test-skill/SKILL.md';

      const projectConfig = manager.parseSkillContent(
        validMarkdown,
        projectPath,
        'project',
      );
      const userConfig = manager.parseSkillContent(
        validMarkdown,
        userPath,
        'user',
      );

      expect(projectConfig.level).toBe('project');
      expect(userConfig.level).toBe('user');
    });

    it('should throw error for invalid frontmatter format', () => {
      const invalidMarkdown = `No frontmatter here
Just content`;

      expect(() =>
        manager.parseSkillContent(
          invalidMarkdown,
          validSkillConfig.filePath,
          'project',
        ),
      ).toThrow(SkillError);
    });

    it('should throw error for missing name', () => {
      const markdownWithoutName = `---
description: A test skill
---

You are a helpful assistant.
`;

      expect(() =>
        manager.parseSkillContent(
          markdownWithoutName,
          validSkillConfig.filePath,
          'project',
        ),
      ).toThrow(SkillError);
    });

    it('should throw error for missing description', () => {
      const markdownWithoutDescription = `---
name: test-skill
---

You are a helpful assistant.
`;

      expect(() =>
        manager.parseSkillContent(
          markdownWithoutDescription,
          validSkillConfig.filePath,
          'project',
        ),
      ).toThrow(SkillError);
    });
  });

  describe('validateConfig', () => {
    it('should validate valid configuration', () => {
      const result = manager.validateConfig(validSkillConfig);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should report error for missing name', () => {
      const invalidConfig = { ...validSkillConfig, name: '' };
      const result = manager.validateConfig(invalidConfig);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('"name" cannot be empty');
    });

    it('should report error for missing description', () => {
      const invalidConfig = { ...validSkillConfig, description: '' };
      const result = manager.validateConfig(invalidConfig);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('"description" cannot be empty');
    });

    it('should report error for invalid allowedTools type', () => {
      const invalidConfig = {
        ...validSkillConfig,
        allowedTools: 'not-an-array' as unknown as string[],
      };
      const result = manager.validateConfig(invalidConfig);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('"allowedTools" must be an array');
    });

    it('should warn for empty body', () => {
      const configWithEmptyBody = { ...validSkillConfig, body: '' };
      const result = manager.validateConfig(configWithEmptyBody);

      expect(result.isValid).toBe(true); // Still valid
      expect(result.warnings).toContain('Skill body is empty');
    });
  });

  describe('loadSkill', () => {
    it('should load skill from project level first', async () => {
      vi.mocked(fs.readdir).mockResolvedValue([
        { name: 'test-skill', isDirectory: () => true, isFile: () => false },
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(validMarkdown);

      const config = await manager.loadSkill('test-skill');

      expect(config).toBeDefined();
      expect(config!.name).toBe('test-skill');
    });

    it('should fall back to user level if project level fails', async () => {
      vi.mocked(fs.readdir)
        .mockRejectedValueOnce(new Error('Project dir not found')) // project level fails
        .mockResolvedValueOnce([
          { name: 'test-skill', isDirectory: () => true, isFile: () => false },
        ] as unknown as Awaited<ReturnType<typeof fs.readdir>>); // user level succeeds
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(validMarkdown);

      const config = await manager.loadSkill('test-skill');

      expect(config).toBeDefined();
      expect(config!.name).toBe('test-skill');
    });

    it('should return null if not found at either level', async () => {
      vi.mocked(fs.readdir).mockRejectedValue(new Error('Directory not found'));

      const config = await manager.loadSkill('nonexistent');

      expect(config).toBeNull();
    });
  });

  describe('loadSkillForRuntime', () => {
    it('should load skill for runtime', async () => {
      vi.mocked(fs.readdir).mockResolvedValueOnce([
        { name: 'test-skill', isDirectory: () => true, isFile: () => false },
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(validMarkdown); // SKILL.md

      const config = await manager.loadSkillForRuntime('test-skill');

      expect(config).toBeDefined();
      expect(config!.name).toBe('test-skill');
    });

    it('should return null if skill not found', async () => {
      vi.mocked(fs.readdir).mockRejectedValue(new Error('Directory not found'));

      const config = await manager.loadSkillForRuntime('nonexistent');

      expect(config).toBeNull();
    });
  });

  describe('listSkills', () => {
    beforeEach(() => {
      // Mock directory listing for skills directories (with Dirent objects)
      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([
          { name: 'skill1', isDirectory: () => true, isFile: () => false },
          { name: 'skill2', isDirectory: () => true, isFile: () => false },
          {
            name: 'not-a-dir.txt',
            isDirectory: () => false,
            isFile: () => true,
          },
        ] as unknown as Awaited<ReturnType<typeof fs.readdir>>)
        .mockResolvedValueOnce([
          { name: 'skill3', isDirectory: () => true, isFile: () => false },
          { name: 'skill1', isDirectory: () => true, isFile: () => false },
        ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

      vi.mocked(fs.access).mockResolvedValue(undefined);

      // Mock file reading for valid skills
      vi.mocked(fs.readFile).mockImplementation((filePath) => {
        const pathStr = String(filePath);
        if (pathStr.includes('skill1')) {
          return Promise.resolve(`---
name: skill1
description: First skill
---
Skill 1 content`);
        } else if (pathStr.includes('skill2')) {
          return Promise.resolve(`---
name: skill2
description: Second skill
---
Skill 2 content`);
        } else if (pathStr.includes('skill3')) {
          return Promise.resolve(`---
name: skill3
description: Third skill
---
Skill 3 content`);
        }
        return Promise.reject(new Error('File not found'));
      });
    });

    it('should list skills from both levels', async () => {
      const skills = await manager.listSkills();

      expect(skills).toHaveLength(3); // skill1 (project takes precedence), skill2, skill3
      expect(skills.map((s) => s.name).sort()).toEqual([
        'skill1',
        'skill2',
        'skill3',
      ]);
    });

    it('should prioritize project level over user level', async () => {
      const skills = await manager.listSkills();
      const skill1 = skills.find((s) => s.name === 'skill1');

      expect(skill1!.level).toBe('project');
    });

    it('should filter by level', async () => {
      const projectSkills = await manager.listSkills({
        level: 'project',
      });

      expect(projectSkills).toHaveLength(2); // skill1, skill2
      expect(projectSkills.every((s) => s.level === 'project')).toBe(true);
    });

    it('should handle empty directories', async () => {
      vi.mocked(fs.readdir).mockReset();
      vi.mocked(fs.readdir).mockResolvedValue(
        [] as unknown as Awaited<ReturnType<typeof fs.readdir>>,
      );

      const skills = await manager.listSkills({ force: true });

      expect(skills).toHaveLength(0);
    });

    it('should handle directory read errors', async () => {
      vi.mocked(fs.readdir).mockReset();
      vi.mocked(fs.readdir).mockRejectedValue(new Error('Directory not found'));

      const skills = await manager.listSkills({ force: true });

      expect(skills).toHaveLength(0);
    });
  });

  describe('getSkillsBaseDir', () => {
    it('should return project-level base dir', () => {
      const baseDir = manager.getSkillsBaseDir('project');

      expect(baseDir).toBe(path.join('/test/project', '.qwen', 'skills'));
    });

    it('should return user-level base dir', () => {
      const baseDir = manager.getSkillsBaseDir('user');

      expect(baseDir).toBe(path.join('/home/user', '.qwen', 'skills'));
    });
  });

  describe('change listeners', () => {
    it('should notify listeners when cache is refreshed', async () => {
      const listener = vi.fn();
      manager.addChangeListener(listener);

      vi.mocked(fs.readdir).mockResolvedValue(
        [] as unknown as Awaited<ReturnType<typeof fs.readdir>>,
      );

      await manager.refreshCache();

      expect(listener).toHaveBeenCalled();
    });

    it('should remove listener when cleanup function is called', async () => {
      const listener = vi.fn();
      const removeListener = manager.addChangeListener(listener);

      removeListener();

      vi.mocked(fs.readdir).mockResolvedValue(
        [] as unknown as Awaited<ReturnType<typeof fs.readdir>>,
      );

      await manager.refreshCache();

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('parse errors', () => {
    it('should track parse errors', async () => {
      vi.mocked(fs.readdir).mockResolvedValue([
        { name: 'bad-skill', isDirectory: () => true, isFile: () => false },
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(
        'invalid content without frontmatter',
      );

      await manager.listSkills({ force: true });

      const errors = manager.getParseErrors();
      expect(errors.size).toBeGreaterThan(0);
    });
  });
});
