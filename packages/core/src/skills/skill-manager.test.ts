/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';
import {
  SkillManager,
  watcherIgnored,
  WATCHER_MAX_DEPTH,
} from './skill-manager.js';
import { type SkillConfig, SkillError } from './types.js';
import type { Config } from '../config/config.js';
import { makeFakeConfig } from '../test-utils/config.js';

// Mock file system operations
vi.mock('fs/promises');
vi.mock('os');

const { mockWatch, mockWatcher } = vi.hoisted(() => {
  const mockWatcher = {
    on: vi.fn().mockReturnThis(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const mockWatch = vi.fn().mockReturnValue(mockWatcher);
  return { mockWatch, mockWatcher };
});

vi.mock('chokidar', () => ({
  watch: mockWatch,
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

// Mock yaml parser - use vi.hoisted for proper hoisting
const mockParseYaml = vi.hoisted(() => vi.fn());

// Only mock yaml-parser for non-hooks tests
// For hooks tests, we'll use the real parser by unmocking selectively
vi.mock('../utils/yaml-parser.js', () => ({
  parse: mockParseYaml,
  stringify: vi.fn(),
}));

describe('SkillManager', () => {
  let manager: SkillManager;
  let mockConfig: Config;

  beforeEach(() => {
    // Mock os.homedir before makeFakeConfig, since Config constructor
    // calls Storage.getGlobalQwenDir() which needs os.homedir()
    vi.mocked(os.homedir).mockReturnValue('/home/user');
    vi.mocked(os.tmpdir).mockReturnValue('/tmp');

    // Create mock Config object using test utility
    mockConfig = makeFakeConfig({});

    // Mock the project root method
    vi.spyOn(mockConfig, 'getProjectRoot').mockReturnValue('/test/project');

    // Reset and setup mocks
    vi.clearAllMocks();

    // Setup yaml parser mocks with sophisticated behavior
    mockParseYaml.mockImplementation((yamlString: string) => {
      // Handle different test cases based on YAML content
      if (yamlString.includes('hooks:')) {
        // For hooks tests, use real YAML parser
        return yaml.parse(yamlString);
      }
      if (yamlString.includes('allowedTools:')) {
        return {
          name: 'test-skill',
          description: 'A test skill',
          allowedTools: ['read_file', 'write_file'],
        };
      }
      if (yamlString.includes('argument-hint:')) {
        return {
          name: 'test-skill',
          description: 'A test skill',
          'argument-hint': '[topic]',
        };
      }
      // Match a frontmatter-level `paths:` field, not any incidental
      // occurrence of "paths:" in the body. Multiline + start-anchor matches
      // a top-level YAML key.
      if (/^paths:/m.test(yamlString)) {
        // Branch handles paths-related tests by reading the literal YAML so
        // the parser-behavior nuance (array vs scalar vs empty) is preserved.
        // Names are inferred from the literal `name: <x>` line so multiple
        // fixtures can coexist in the same test (e.g. cross-level shadowing).
        const nameMatch = yamlString.match(/name:\s*(\S+)/);
        const name = nameMatch ? nameMatch[1] : 'test-skill';
        const description = yamlString.includes('React skill')
          ? 'React skill'
          : yamlString.includes('Hidden helper')
            ? 'Hidden helper'
            : 'A test skill';
        let paths: unknown = undefined;
        if (yamlString.includes('paths: []')) {
          paths = [];
        } else if (yamlString.includes('paths: "src/**/*.tsx"')) {
          // Invalid (scalar) — surface as string so our validator rejects it.
          paths = 'src/**/*.tsx';
        } else if (yamlString.includes('src/**/*.tsx')) {
          paths = yamlString.includes('test/**/*.tsx')
            ? ['src/**/*.tsx', 'test/**/*.tsx']
            : ['src/**/*.tsx'];
        } else if (yamlString.includes('"src/**"')) {
          paths = ['src/**'];
        } else if (yamlString.includes('"lib/**"')) {
          paths = ['lib/**'];
        } else if (yamlString.includes('"src/**/*.ts"')) {
          paths = ['src/**/*.ts'];
        } else {
          // Generic fallback: extract any quoted string under a `- "..."`
          // bullet inside the paths block. Lets the oversized-glob and
          // similar fixtures work without a per-test branch.
          const bulletMatches = yamlString.match(/-\s+"([^"]+)"/g);
          if (bulletMatches) {
            paths = bulletMatches.map((m) => m.replace(/^-\s+"|"$/g, ''));
          }
        }
        const result: Record<string, unknown> = { name, description, paths };
        if (yamlString.includes('disable-model-invocation: true')) {
          result['disable-model-invocation'] = true;
        }
        return result;
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
      if (yamlString.includes('name: symlink-skill')) {
        return {
          name: 'symlink-skill',
          description: 'A skill loaded from symlink',
        };
      }
      if (yamlString.includes('A symlinked skill')) {
        return { name: 'symlink-skill', description: 'A symlinked skill' };
      }
      if (yamlString.includes('name: regular-skill')) {
        return { name: 'regular-skill', description: 'A regular skill' };
      }
      if (yamlString.includes('name: shared-skill')) {
        const desc = yamlString.includes('From qwen dir')
          ? 'From qwen dir'
          : yamlString.includes('From agent dir')
            ? 'From agent dir'
            : 'A shared skill';
        return { name: 'shared-skill', description: desc };
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

    it('should parse markdown with CRLF line endings', () => {
      const markdownCrlf = `---\r
name: test-skill\r
description: A test skill\r
---\r
\r
You are a helpful assistant with this skill.\r
`;

      const config = manager.parseSkillContent(
        markdownCrlf,
        validSkillConfig.filePath,
        'project',
      );

      expect(config.name).toBe('test-skill');
      expect(config.description).toBe('A test skill');
      expect(config.body).toBe('You are a helpful assistant with this skill.');
    });

    it('should parse markdown with UTF-8 BOM', () => {
      const markdownWithBom = `\uFEFF---
name: test-skill
description: A test skill
---

You are a helpful assistant with this skill.
`;

      const config = manager.parseSkillContent(
        markdownWithBom,
        validSkillConfig.filePath,
        'project',
      );

      expect(config.name).toBe('test-skill');
      expect(config.description).toBe('A test skill');
    });

    it('should parse markdown when body is empty and file ends after frontmatter', () => {
      const frontmatterOnly = `---
name: test-skill
description: A test skill
---`;

      const config = manager.parseSkillContent(
        frontmatterOnly,
        validSkillConfig.filePath,
        'project',
      );

      expect(config.name).toBe('test-skill');
      expect(config.description).toBe('A test skill');
      expect(config.body).toBe('');
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

    it('should parse argument-hint from frontmatter', () => {
      const markdownWithArgumentHint = `---
name: test-skill
description: A test skill
argument-hint: "[topic]"
---

Skill body.
`;

      const config = manager.parseSkillContent(
        markdownWithArgumentHint,
        validSkillConfig.filePath,
        'project',
      );

      expect(config.argumentHint).toBe('[topic]');
    });

    it('should parse content with paths (conditional skill)', () => {
      const markdown = `---
name: tsx-helper
description: React skill
paths:
  - "src/**/*.tsx"
  - "test/**/*.tsx"
---

Body.
`;
      const config = manager.parseSkillContent(
        markdown,
        validSkillConfig.filePath,
        'project',
      );
      expect(config.paths).toEqual(['src/**/*.tsx', 'test/**/*.tsx']);
    });

    it('should leave paths undefined when frontmatter omits it', () => {
      const markdown = `---
name: test-skill
description: A test skill
---

Body.
`;
      const config = manager.parseSkillContent(
        markdown,
        validSkillConfig.filePath,
        'project',
      );
      expect(config.paths).toBeUndefined();
    });

    it('should treat an empty paths array as undefined (unconditional)', () => {
      const markdown = `---
name: test-skill
description: A test skill
paths: []
---

Body.
`;
      const config = manager.parseSkillContent(
        markdown,
        validSkillConfig.filePath,
        'project',
      );
      expect(config.paths).toBeUndefined();
    });

    it('should throw when paths is not an array', () => {
      const markdown = `---
name: test-skill
description: A test skill
paths: "src/**/*.tsx"
---

Body.
`;
      expect(() =>
        manager.parseSkillContent(
          markdown,
          validSkillConfig.filePath,
          'project',
        ),
      ).toThrow(/"paths" must be an array/);
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
        {
          name: 'test-skill',
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
        },
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
          {
            name: 'test-skill',
            isDirectory: () => true,
            isFile: () => false,
            isSymbolicLink: () => false,
          },
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
        {
          name: 'test-skill',
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
        },
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
      // Mock directory listing based on path to handle multiple base dirs per level.
      // Use path.join to construct expected paths so separators match on all platforms.
      const projectQwenSkillsDir = path.join(
        '/test/project',
        '.qwen',
        'skills',
      );
      const userQwenSkillsDir = path.join('/home/user', '.qwen', 'skills');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readdir).mockImplementation((dirPath: any) => {
        const pathStr = String(dirPath);
        if (pathStr === projectQwenSkillsDir) {
          return Promise.resolve([
            {
              name: 'skill1',
              isDirectory: () => true,
              isFile: () => false,
              isSymbolicLink: () => false,
            },
            {
              name: 'skill2',
              isDirectory: () => true,
              isFile: () => false,
              isSymbolicLink: () => false,
            },
            {
              name: 'not-a-dir.txt',
              isDirectory: () => false,
              isFile: () => true,
              isSymbolicLink: () => false,
            },
          ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
        }
        if (pathStr === userQwenSkillsDir) {
          return Promise.resolve([
            {
              name: 'skill3',
              isDirectory: () => true,
              isFile: () => false,
              isSymbolicLink: () => false,
            },
            {
              name: 'skill1',
              isDirectory: () => true,
              isFile: () => false,
              isSymbolicLink: () => false,
            },
          ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
        }
        // Other provider dirs (.agents, .cursor, .codex, .claude) return empty
        return Promise.resolve(
          [] as unknown as Awaited<ReturnType<typeof fs.readdir>>,
        );
      });

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

    it('should deduplicate same-name skills across provider dirs within a level', async () => {
      // Override readdir to return the same skill name from both .qwen and .agents dirs
      vi.mocked(fs.readdir).mockReset();
      const projectQwenDir = path.join('/test/project', '.qwen', 'skills');
      const projectAgentDir = path.join('/test/project', '.agents', 'skills');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readdir).mockImplementation((dirPath: any) => {
        const pathStr = String(dirPath);
        if (pathStr === projectQwenDir) {
          return Promise.resolve([
            {
              name: 'shared-skill',
              isDirectory: () => true,
              isFile: () => false,
              isSymbolicLink: () => false,
            },
          ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
        }
        if (pathStr === projectAgentDir) {
          return Promise.resolve([
            {
              name: 'shared-skill',
              isDirectory: () => true,
              isFile: () => false,
              isSymbolicLink: () => false,
            },
          ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
        }
        return Promise.resolve(
          [] as unknown as Awaited<ReturnType<typeof fs.readdir>>,
        );
      });

      vi.mocked(fs.readFile).mockImplementation((filePath) => {
        const pathStr = String(filePath);
        if (pathStr.includes('.qwen') && pathStr.includes('shared-skill')) {
          return Promise.resolve(
            `---\nname: shared-skill\ndescription: From qwen dir\n---\nQwen content`,
          );
        }
        if (pathStr.includes('.agents') && pathStr.includes('shared-skill')) {
          return Promise.resolve(
            `---\nname: shared-skill\ndescription: From agents dir\n---\nAgents content`,
          );
        }
        return Promise.reject(new Error('File not found'));
      });

      const skills = await manager.listSkills({
        level: 'project',
        force: true,
      });

      // Only one instance should remain, from .qwen (first in PROVIDER_CONFIG_DIRS)
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('shared-skill');
      expect(skills[0].description).toBe('From qwen dir');
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

  describe('getSkillsBaseDirs', () => {
    it('should return all project-level base dirs', () => {
      const baseDirs = manager.getSkillsBaseDirs('project');

      expect(baseDirs).toHaveLength(2);
      expect(baseDirs).toContain(path.join('/test/project', '.qwen', 'skills'));
      expect(baseDirs).toContain(
        path.join('/test/project', '.agents', 'skills'),
      );
    });

    it('should return all user-level base dirs', () => {
      const baseDirs = manager.getSkillsBaseDirs('user');

      expect(baseDirs).toHaveLength(2);
      expect(baseDirs).toContain(path.join('/home/user', '.qwen', 'skills'));
      expect(baseDirs).toContain(path.join('/home/user', '.agents', 'skills'));
    });

    it('should return bundled-level base dir', () => {
      const baseDirs = manager.getSkillsBaseDirs('bundled');

      expect(baseDirs[0]).toMatch(/skills[/\\]bundled$/);
    });

    it('should throw for extension level', () => {
      expect(() => manager.getSkillsBaseDirs('extension')).toThrow(
        'Extension skills do not have a base directory',
      );
    });
  });

  describe('bundled skills', () => {
    const bundledDirSegment = path.join('skills', 'bundled');
    const projectDirSegment = path.join('.qwen', 'skills');
    const userDirSegment = path.join('.qwen', 'skills');
    const projectPrefix = path.join('/test/project');
    const userPrefix = path.join('/home/user');

    const reviewDirEntry = {
      name: 'review',
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
    };

    const emptyDir = [] as unknown as Awaited<ReturnType<typeof fs.readdir>>;

    function mockReaddirForLevels(levels: Set<string>) {
      vi.mocked(fs.readdir).mockImplementation((dirPath) => {
        const pathStr = String(dirPath);
        const isBundled =
          pathStr.endsWith(bundledDirSegment) && !pathStr.includes('.qwen');
        const isProject =
          pathStr.includes(projectDirSegment) &&
          pathStr.startsWith(projectPrefix);
        const isUser =
          pathStr.includes(userDirSegment) && pathStr.startsWith(userPrefix);

        if (
          (levels.has('bundled') && isBundled) ||
          (levels.has('project') && isProject) ||
          (levels.has('user') && isUser)
        ) {
          return Promise.resolve([reviewDirEntry] as unknown as Awaited<
            ReturnType<typeof fs.readdir>
          >);
        }
        return Promise.resolve(emptyDir);
      });
    }

    function setupReviewSkillMocks() {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(`---
name: review
description: Review code changes
---
Review content`);

      mockParseYaml.mockReturnValue({
        name: 'review',
        description: 'Review code changes',
      });
    }

    it('should load bundled skills in listSkills', async () => {
      mockReaddirForLevels(new Set(['bundled']));
      setupReviewSkillMocks();

      const skills = await manager.listSkills({ force: true });

      expect(skills.some((s) => s.name === 'review')).toBe(true);
      const reviewSkill = skills.find((s) => s.name === 'review');
      expect(reviewSkill!.level).toBe('bundled');
    });

    it('should prioritize project-level over bundled skills with same name', async () => {
      mockReaddirForLevels(new Set(['project', 'bundled']));
      setupReviewSkillMocks();

      const skills = await manager.listSkills({ force: true });

      const reviewSkills = skills.filter((s) => s.name === 'review');
      expect(reviewSkills).toHaveLength(1);
      expect(reviewSkills[0].level).toBe('project');
    });

    it('should prioritize user-level over bundled skills with same name', async () => {
      mockReaddirForLevels(new Set(['user', 'bundled']));
      setupReviewSkillMocks();

      const skills = await manager.listSkills({ force: true });

      const reviewSkills = skills.filter((s) => s.name === 'review');
      expect(reviewSkills).toHaveLength(1);
      expect(reviewSkills[0].level).toBe('user');
    });

    it('should skip all skills in bare mode', async () => {
      vi.spyOn(mockConfig, 'getBareMode').mockReturnValue(true);
      mockReaddirForLevels(new Set(['project', 'user', 'bundled']));
      setupReviewSkillMocks();

      const skills = await manager.listSkills({ force: true });

      expect(skills).toEqual([]);
    });

    it('should fall back to bundled level in loadSkill', async () => {
      // Project, user, extension all empty; bundled has the skill
      mockReaddirForLevels(new Set(['bundled']));
      setupReviewSkillMocks();

      const skill = await manager.loadSkill('review');

      expect(skill).toBeDefined();
      expect(skill!.name).toBe('review');
      expect(skill!.level).toBe('bundled');
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

    it('awaits async listeners before resolving', async () => {
      // Regression: notifyChangeListeners must await the Promises returned
      // by listeners (e.g. SkillTool.refreshSkills) before resolving — the
      // <system-reminder> envelope is emitted off the resolution of
      // matchAndActivateByPath, and announcing a skill before
      // SkillTool.setTools() finishes leaves the model unable to invoke
      // the just-activated skill.
      let resolveListener: () => void = () => {};
      const listenerSettled = new Promise<void>((resolve) => {
        resolveListener = resolve;
      });
      let listenerObserved = false;
      manager.addChangeListener(() =>
        listenerSettled.then(() => {
          listenerObserved = true;
        }),
      );

      vi.mocked(fs.readdir).mockResolvedValue(
        [] as unknown as Awaited<ReturnType<typeof fs.readdir>>,
      );

      // Refresh kicks off the listener; without await semantics it would
      // race ahead.
      const refreshDone = manager.refreshCache();
      // Give microtasks one tick so the listener's outer Promise enters
      // its `.then` callback (still parked on `listenerSettled`).
      await Promise.resolve();
      expect(listenerObserved).toBe(false);

      resolveListener();
      await refreshDone;
      expect(listenerObserved).toBe(true);
    });

    it('isolates listener throws via allSettled — siblings still run', async () => {
      // Regression: a single buggy listener (e.g. a third-party hook
      // throwing during refresh) must not stop the other listeners or
      // make refreshCache itself reject. allSettled preserves this; if
      // someone swaps it back to Promise.all the throw propagates and
      // every subsequent listener silently dies.
      const throwing = vi.fn(() => {
        throw new Error('listener exploded');
      });
      const sibling = vi.fn();
      manager.addChangeListener(throwing);
      manager.addChangeListener(sibling);

      vi.mocked(fs.readdir).mockResolvedValue(
        [] as unknown as Awaited<ReturnType<typeof fs.readdir>>,
      );

      await expect(manager.refreshCache()).resolves.toBeUndefined();
      expect(throwing).toHaveBeenCalled();
      expect(sibling).toHaveBeenCalled();
    });

    it('isolates async listener rejections — siblings still run', async () => {
      // Same property as the sync-throw case but via a rejected Promise:
      // the wrapper `Promise.resolve().then(listener)` flips both shapes
      // into the same Promise pipeline, but it's worth pinning explicitly
      // because a refactor that special-cases sync throws could
      // accidentally regress the async branch.
      const asyncRejector = vi.fn(() =>
        Promise.reject(new Error('async fail')),
      );
      const sibling = vi.fn();
      manager.addChangeListener(asyncRejector);
      manager.addChangeListener(sibling);

      vi.mocked(fs.readdir).mockResolvedValue(
        [] as unknown as Awaited<ReturnType<typeof fs.readdir>>,
      );

      await expect(manager.refreshCache()).resolves.toBeUndefined();
      expect(asyncRejector).toHaveBeenCalled();
      expect(sibling).toHaveBeenCalled();
    });

    it('clears the per-listener timeout once the race settles', async () => {
      // Regression: the 30s timeout was previously only `unref`d, leaving
      // a pending timer on every fast-resolving listener. Under
      // high-frequency activation, vitest's open-handle diagnostic and
      // any tooling snapshotting the active-handle set saw the pile-up.
      // The `.finally(clearTimeout)` wrapper makes the cleanup explicit.
      const setSpy = vi.spyOn(global, 'setTimeout');
      const clearSpy = vi.spyOn(global, 'clearTimeout');

      const fastListener = vi.fn(() => Promise.resolve());
      manager.addChangeListener(fastListener);

      vi.mocked(fs.readdir).mockResolvedValue(
        [] as unknown as Awaited<ReturnType<typeof fs.readdir>>,
      );

      // Capture timer ids set during the refresh — only the listener
      // timeouts use setTimeout in this code path. Other tests in this
      // file can leak setTimeout calls (chokidar, etc.) so we diff
      // before/after.
      const setCallsBefore = setSpy.mock.calls.length;
      const clearCallsBefore = clearSpy.mock.calls.length;

      await manager.refreshCache();

      const setCallsAfter = setSpy.mock.calls.length;
      const clearCallsAfter = clearSpy.mock.calls.length;
      // We expect at least one timer set (the listener wrapper's) and
      // a matching clear. Equal deltas guarantees nothing was leaked.
      const setDelta = setCallsAfter - setCallsBefore;
      const clearDelta = clearCallsAfter - clearCallsBefore;
      expect(setDelta).toBeGreaterThanOrEqual(1);
      expect(clearDelta).toBeGreaterThanOrEqual(setDelta);

      setSpy.mockRestore();
      clearSpy.mockRestore();
    });
  });

  describe('conditional skill activation', () => {
    // Minimal setup: a project dir containing one conditional skill whose
    // paths glob matches `src/**/*.tsx`. After refreshCache() loads it,
    // matchAndActivateByPath() should activate it and fire listeners.
    async function loadConditionalFixture() {
      vi.mocked(fs.readdir).mockResolvedValue([
        {
          name: 'tsx-helper',
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
        },
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(`---
name: tsx-helper
description: React skill
paths:
  - "src/**/*.tsx"
---

Body.
`);
      await manager.refreshCache();
    }

    it('keeps conditional skills inactive until a matching path is touched', async () => {
      await loadConditionalFixture();

      const all = await manager.listSkills();
      const tsx = all.find((s) => s.name === 'tsx-helper');
      expect(tsx).toBeDefined();
      expect(manager.isSkillActive(tsx!)).toBe(false);
    });

    it('activates a conditional skill when a matching file path is touched', async () => {
      await loadConditionalFixture();

      const newly = await manager.matchAndActivateByPath(
        '/test/project/src/App.tsx',
      );
      expect(newly).toEqual(['tsx-helper']);
      expect(manager.getActivatedSkillNames().has('tsx-helper')).toBe(true);

      const all = await manager.listSkills();
      const tsx = all.find((s) => s.name === 'tsx-helper')!;
      expect(manager.isSkillActive(tsx)).toBe(true);
    });

    it('does not re-notify listeners on subsequent matches of the same skill', async () => {
      await loadConditionalFixture();

      const listener = vi.fn();
      manager.addChangeListener(listener);

      expect(
        await manager.matchAndActivateByPath('/test/project/src/A.tsx'),
      ).toEqual(['tsx-helper']);
      expect(listener).toHaveBeenCalledTimes(1);

      // Same pattern touched again — skill already active, no new
      // notification.
      expect(
        await manager.matchAndActivateByPath('/test/project/src/B.tsx'),
      ).toEqual([]);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('does nothing for paths outside the project root', async () => {
      await loadConditionalFixture();
      expect(
        await manager.matchAndActivateByPath('/other/place/foo.tsx'),
      ).toEqual([]);
      expect(manager.getActivatedSkillNames().size).toBe(0);
    });

    it('does not activate a conditional skill that is also disable-model-invocation', async () => {
      // Regression for ultrareview bug_004: a SKILL.md with both `paths:`
      // and `disable-model-invocation: true` would enter the activation
      // registry, fire a "now available" system-reminder on path match, and
      // then SkillTool would refuse to invoke it because the disabled flag
      // hides it everywhere else.
      vi.mocked(fs.readdir).mockResolvedValue([
        {
          name: 'secret-helper',
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
        },
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(`---
name: secret-helper
description: Hidden helper
paths:
  - "src/**/*.ts"
disable-model-invocation: true
---

Body.
`);
      await manager.refreshCache();

      const newly = await manager.matchAndActivateByPath(
        '/test/project/src/foo.ts',
      );
      expect(newly).toEqual([]);
      expect(manager.getActivatedSkillNames().size).toBe(0);
    });

    it('matchAndActivateByPaths fires listeners exactly once across multiple paths', async () => {
      // Regression for /review: when a single tool call yields multiple
      // candidate paths (e.g. ripGrep `paths: [a, b, c]`), the per-path
      // listener fire was triggering N successive SkillTool.refreshSkills /
      // geminiClient.setTools() round-trips. The batch API should fire
      // listeners once with the union of activations.
      vi.mocked(fs.readdir).mockResolvedValue([
        {
          name: 'tsx-helper',
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
        },
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(`---
name: tsx-helper
description: React skill
paths:
  - "src/**/*.tsx"
---

Body.
`);
      await manager.refreshCache();

      const listener = vi.fn();
      manager.addChangeListener(listener);
      const baselineCalls = listener.mock.calls.length;

      const newly = await manager.matchAndActivateByPaths([
        '/test/project/src/A.tsx',
        '/test/project/src/B.tsx',
        '/test/project/src/C.tsx',
      ]);
      expect(newly).toEqual(['tsx-helper']);
      // One listener call total, not three.
      expect(listener.mock.calls.length - baselineCalls).toBe(1);
    });

    it('matchAndActivateByPaths returns empty (no listener) when no path matches', async () => {
      await loadConditionalFixture();

      const listener = vi.fn();
      manager.addChangeListener(listener);
      const baselineCalls = listener.mock.calls.length;

      const newly = await manager.matchAndActivateByPaths([
        '/test/project/lib/a.ts',
        '/test/project/lib/b.ts',
      ]);
      expect(newly).toEqual([]);
      // No new activations means the listener stays silent.
      expect(listener.mock.calls.length).toBe(baselineCalls);
    });

    it('does not activate a visible skill from a shadowed copy paths', async () => {
      // Regression for ultrareview bug_001: cross-level skills with the
      // same name but different `paths:` globs. listSkills() dedupes by
      // precedence (project wins), so the model only sees the project
      // copy. The activation registry must use the same precedence —
      // otherwise the user copy's globs activate the visible (project)
      // skill, even when the touched file is outside the project skill's
      // declared paths.
      const projectQwenSkillsDir = path.join(
        '/test/project',
        '.qwen',
        'skills',
      );
      const userQwenSkillsDir = path.join('/home/user', '.qwen', 'skills');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readdir).mockImplementation((dirPath: any) => {
        const pathStr = String(dirPath);
        if (pathStr === projectQwenSkillsDir || pathStr === userQwenSkillsDir) {
          return Promise.resolve([
            {
              name: 'foo',
              isDirectory: () => true,
              isFile: () => false,
              isSymbolicLink: () => false,
            },
          ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
        }
        return Promise.resolve(
          [] as unknown as Awaited<ReturnType<typeof fs.readdir>>,
        );
      });
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockImplementation((filePath) => {
        const pathStr = String(filePath);
        if (pathStr.startsWith(projectQwenSkillsDir)) {
          return Promise.resolve(`---
name: foo
description: A test skill
paths:
  - "src/**"
---

Project body.
`);
        }
        if (pathStr.startsWith(userQwenSkillsDir)) {
          return Promise.resolve(`---
name: foo
description: A test skill
paths:
  - "lib/**"
---

User body.
`);
        }
        return Promise.reject(new Error('File not found'));
      });
      await manager.refreshCache();

      // Touching `lib/x.ts` (matches user-foo's paths but project-foo wins
      // in listSkills) must NOT activate the visible project-foo.
      expect(
        await manager.matchAndActivateByPath('/test/project/lib/x.ts'),
      ).toEqual([]);
      expect(manager.getActivatedSkillNames().has('foo')).toBe(false);

      // Touching `src/x.ts` (matches the visible project-foo's paths) does
      // activate it.
      expect(
        await manager.matchAndActivateByPath('/test/project/src/x.ts'),
      ).toEqual(['foo']);
    });
  });

  describe('parse errors', () => {
    it('should track parse errors', async () => {
      vi.mocked(fs.readdir).mockResolvedValue([
        {
          name: 'bad-skill',
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
        },
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(
        'invalid content without frontmatter',
      );

      await manager.listSkills({ force: true });

      const errors = manager.getParseErrors();
      expect(errors.size).toBeGreaterThan(0);
    });

    it('surfaces invalid `paths:` glob patterns through parseErrors', async () => {
      // Regression: bad globs were only logged at debug level, leaving
      // affected skills with a permanent "gated by path-based
      // activation" error and no actionable diagnostic. The registry
      // now calls back into SkillManager.parseErrors so the failure is
      // visible through `getParseErrors()` (and the `/skills` UI).
      vi.mocked(fs.readdir).mockResolvedValue([
        {
          name: 'bad-glob-skill',
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
        },
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      // 70 KB pattern — picomatch's default pattern length cap is 65,536
      // chars, so it throws at compile time.
      const oversizedGlob = 'a'.repeat(70_000);
      vi.mocked(fs.readFile).mockResolvedValue(`---
name: bad-glob-skill
description: Has an oversized glob
paths:
  - "${oversizedGlob}"
---

Body.
`);

      await manager.refreshCache();

      const errors = manager.getParseErrors();
      const entries = Array.from(errors.entries());
      const oversizedEntry = entries.find(([key]) => key.includes('#paths['));
      expect(oversizedEntry).toBeDefined();
      expect(oversizedEntry![1].message).toMatch(/Invalid glob in "paths"/);
      expect(oversizedEntry![1].skillName).toBe('bad-glob-skill');
    });
  });

  describe('symlink support', () => {
    it('should load skills from symlinked directories', async () => {
      vi.mocked(fs.readdir).mockResolvedValue([
        {
          name: 'symlink-skill',
          isDirectory: () => false,
          isSymbolicLink: () => true,
          isFile: () => false,
        },
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

      // Symlink target can point anywhere on disk — out-of-tree
      // targets are the supported user workflow.
      vi.mocked(fs.realpath).mockResolvedValue(
        '/elsewhere/skills-repo/symlink-skill',
      );
      vi.mocked(fs.stat).mockResolvedValue({
        isDirectory: () => true,
      } as Awaited<ReturnType<typeof fs.stat>>);

      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(`---
name: symlink-skill
description: A skill loaded from symlink
---
Symlink skill content`);

      const skills = await manager.listSkills({ force: true });

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('symlink-skill');
      expect(skills[0].description).toBe('A skill loaded from symlink');
    });

    it('should skip symlinks that point to non-directory targets', async () => {
      vi.mocked(fs.readdir).mockResolvedValue([
        {
          name: 'bad-symlink',
          isDirectory: () => false,
          isSymbolicLink: () => true,
          isFile: () => false,
        },
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

      vi.mocked(fs.realpath).mockResolvedValue(
        '/elsewhere/skills-repo/some-file',
      );
      // Mock fs.stat to return file stats (not a directory)
      vi.mocked(fs.stat).mockResolvedValue({
        isDirectory: () => false,
      } as Awaited<ReturnType<typeof fs.stat>>);

      const skills = await manager.listSkills({ force: true });

      expect(skills).toHaveLength(0);
    });

    it('should skip broken/invalid symlinks', async () => {
      vi.mocked(fs.readdir).mockResolvedValue([
        {
          name: 'broken-symlink',
          isDirectory: () => false,
          isSymbolicLink: () => true,
          isFile: () => false,
        },
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

      // realpath on the dangling link throws ENOENT; the entry is
      // skipped with an `invalid` reason.
      vi.mocked(fs.realpath).mockRejectedValue(
        new Error('ENOENT: no such file or directory'),
      );

      const skills = await manager.listSkills({ force: true });

      expect(skills).toHaveLength(0);
    });

    it('should load skills from both regular directories and symlinks', async () => {
      vi.mocked(fs.readdir).mockResolvedValue([
        {
          name: 'regular-skill',
          isDirectory: () => true,
          isSymbolicLink: () => false,
          isFile: () => false,
        },
        {
          name: 'symlink-skill',
          isDirectory: () => false,
          isSymbolicLink: () => true,
          isFile: () => false,
        },
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

      vi.mocked(fs.realpath).mockImplementation((p) =>
        Promise.resolve(String(p)),
      );
      // Mock fs.stat to return directory stats for the symlink
      vi.mocked(fs.stat).mockResolvedValue({
        isDirectory: () => true,
      } as Awaited<ReturnType<typeof fs.stat>>);

      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockImplementation((filePath) => {
        const pathStr = String(filePath);
        if (pathStr.includes('regular-skill')) {
          return Promise.resolve(`---
name: regular-skill
description: A regular skill
---
Regular skill content`);
        } else if (pathStr.includes('symlink-skill')) {
          return Promise.resolve(`---
name: symlink-skill
description: A symlinked skill
---
Symlinked skill content`);
        }
        return Promise.reject(new Error('File not found'));
      });

      const skills = await manager.listSkills({ force: true });

      expect(skills).toHaveLength(2);
      expect(skills.map((s) => s.name).sort()).toEqual([
        'regular-skill',
        'symlink-skill',
      ]);
    });
  });

  describe('file watchers', () => {
    it('should pass ignored function and shallow depth to chokidar', async () => {
      const projectSkillsDir = path.join('/test/project', '.qwen', 'skills');
      vi.mocked(fsSync.existsSync).mockImplementation(
        (p) => String(p) === projectSkillsDir,
      );

      vi.mocked(fs.readdir).mockResolvedValue(
        [] as unknown as Awaited<ReturnType<typeof fs.readdir>>,
      );

      mockWatch.mockClear();
      mockWatcher.on.mockClear();

      await manager.startWatching();

      expect(mockWatch).toHaveBeenCalledWith(projectSkillsDir, {
        ignoreInitial: true,
        ignored: watcherIgnored,
        depth: WATCHER_MAX_DEPTH,
      });
      expect(WATCHER_MAX_DEPTH).toBe(2);
    });

    it('watcherIgnored should reject .git directories', () => {
      expect(watcherIgnored(path.join('/skills', '.git', 'config'))).toBe(true);
      expect(watcherIgnored(path.join('/skills', '.git'))).toBe(true);
      expect(watcherIgnored(path.join('/skills', 'my-skill', 'SKILL.md'))).toBe(
        false,
      );
    });

    it('watcherIgnored should reject special file types', () => {
      const socketStats = {
        isFile: () => false,
        isDirectory: () => false,
      } as fsSync.Stats;
      const fileStats = {
        isFile: () => true,
        isDirectory: () => false,
      } as fsSync.Stats;
      const dirStats = {
        isFile: () => false,
        isDirectory: () => true,
      } as fsSync.Stats;

      expect(watcherIgnored('/skills/some.sock', socketStats)).toBe(true);
      expect(watcherIgnored('/skills/SKILL.md', fileStats)).toBe(false);
      expect(watcherIgnored('/skills/my-skill', dirStats)).toBe(false);
    });
  });

  describe('hooks parsing', () => {
    it('should parse hooks configuration from frontmatter', () => {
      const markdown = `---
name: hook-skill
description: Skill with hooks
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: 'echo "checking"'
          timeout: 5
---
Skill content`;

      const config = manager.parseSkillContent(
        markdown,
        '/test/skill/SKILL.md',
        'user',
      );

      expect(config.hooks).toBeDefined();
      expect(config.hooks?.PreToolUse).toBeDefined();
      expect(config.hooks?.PreToolUse).toHaveLength(1);
      expect(config.hooks?.PreToolUse?.[0]?.matcher).toBe('Bash');
      expect(config.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
    });

    it('should parse multiple hooks for same event', () => {
      const markdown = `---
name: multi-hook-skill
description: Skill with multiple hooks
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: 'echo "first"'
        - type: command
          command: 'echo "second"'
    - matcher: "Write"
      hooks:
        - type: http
          url: 'https://example.com/hook'
---
Skill content`;

      const config = manager.parseSkillContent(
        markdown,
        '/test/skill/SKILL.md',
        'user',
      );

      expect(config.hooks?.PreToolUse).toHaveLength(2);
      expect(config.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(2);
      expect(config.hooks?.PreToolUse?.[1]?.matcher).toBe('Write');
    });

    it('should parse HTTP hooks with headers', () => {
      const markdown = `---
name: http-hook-skill
description: Skill with HTTP hooks
hooks:
  PostToolUse:
    - matcher: "*"
      hooks:
        - type: http
          url: 'https://audit.example.com/log'
          headers:
            Authorization: 'Bearer token'
          allowedEnvVars:
            - API_KEY
          timeout: 10
---
Skill content`;

      const config = manager.parseSkillContent(
        markdown,
        '/test/skill/SKILL.md',
        'user',
      );

      expect(config.hooks?.PostToolUse).toHaveLength(1);
      const hook = config.hooks?.PostToolUse?.[0]?.hooks?.[0];
      expect(hook?.type).toBe('http');
      if (hook?.type === 'http') {
        expect(hook.url).toBe('https://audit.example.com/log');
        expect(hook.headers).toEqual({ Authorization: 'Bearer token' });
        expect(hook.allowedEnvVars).toEqual(['API_KEY']);
        expect(hook.timeout).toBe(10);
      }
    });

    it('should ignore unknown hook events', () => {
      const markdown = `---
name: unknown-event-skill
description: Skill with unknown event
hooks:
  UnknownEvent:
    - matcher: "*"
      hooks:
        - type: command
          command: 'echo "test"'
---
Skill content`;

      const config = manager.parseSkillContent(
        markdown,
        '/test/skill/SKILL.md',
        'user',
      );

      // Unknown events are ignored, only valid HookEventNames are kept
      expect(config.hooks).toBeDefined();
      // UnknownEvent should not be in the parsed hooks
      expect(Object.keys(config.hooks || {})).not.toContain('UnknownEvent');
    });

    it('should set skillRoot from filePath', () => {
      const markdown = `---
name: skillroot-skill
description: Skill with skillRoot
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: 'echo $QWEN_SKILL_ROOT'
---
Skill content`;

      const config = manager.parseSkillContent(
        markdown,
        '/test/skill/SKILL.md',
        'user',
      );

      // skillRoot should be set to the directory containing SKILL.md
      expect(config.skillRoot).toBe('/test/skill');
    });
  });
});
