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

const TEST_HOME = path.resolve('/home/user');
const TEST_PROJECT_ROOT = path.resolve('/test/project');

describe('SkillManager', () => {
  let manager: SkillManager;
  let mockConfig: Config;

  beforeEach(() => {
    // Mock os.homedir before makeFakeConfig, since Config constructor
    // calls Storage.getGlobalQwenDir() which needs os.homedir()
    vi.mocked(os.homedir).mockReturnValue(TEST_HOME);
    vi.mocked(os.tmpdir).mockReturnValue('/tmp');

    // Create mock Config object using test utility
    mockConfig = makeFakeConfig({});

    // Mock the project root method
    vi.spyOn(mockConfig, 'getProjectRoot').mockReturnValue(TEST_PROJECT_ROOT);

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
      if (/^priority:/m.test(yamlString)) {
        return yaml.parse(yamlString);
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

    it('should parse numeric priority from frontmatter', () => {
      const markdownWithPriority = `---
name: test-skill
description: A test skill
priority: 25
---

Skill body.
`;

      const config = manager.parseSkillContent(
        markdownWithPriority,
        validSkillConfig.filePath,
        'project',
      );

      expect(config.priority).toBe(25);
    });

    it('should ignore invalid priority values without dropping the skill', () => {
      const markdownWithInvalidPriority = `---
name: test-skill
description: A test skill
priority: true
---

Skill body.
`;

      const config = manager.parseSkillContent(
        markdownWithInvalidPriority,
        validSkillConfig.filePath,
        'project',
      );

      expect(config.priority).toBeUndefined();
    });

    it('should parse user-invocable from frontmatter', () => {
      mockParseYaml.mockReturnValueOnce({
        name: 'test-skill',
        description: 'A test skill',
        'user-invocable': false,
      });

      const markdown = `---
name: test-skill
description: A test skill
user-invocable: false
---

Skill body.
`;

      const config = manager.parseSkillContent(
        markdown,
        validSkillConfig.filePath,
        'project',
      );

      expect(config.userInvocable).toBe(false);
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

    it('should report error for invalid priority', () => {
      const result = manager.validateConfig({
        ...validSkillConfig,
        priority: 'high' as unknown as number,
      });

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('"priority" must be a finite number');
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
        TEST_PROJECT_ROOT,
        '.qwen',
        'skills',
      );
      const userQwenSkillsDir = path.join(TEST_HOME, '.qwen', 'skills');

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

    it('reads the committed cache without triggering discovery', async () => {
      expect(manager.getCachedSkills()).toBeNull();
      expect(fs.readdir).not.toHaveBeenCalled();

      await manager.listSkills();
      vi.mocked(fs.readdir).mockClear();
      vi.mocked(fs.readFile).mockClear();

      expect(manager.getCachedSkills()?.map((skill) => skill.name)).toEqual([
        'skill1',
        'skill2',
        'skill3',
      ]);
      expect(fs.readdir).not.toHaveBeenCalled();
      expect(fs.readFile).not.toHaveBeenCalled();
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

    it('should return a stable alphabetical order regardless of priority (priority only affects the /skills display layer)', async () => {
      vi.mocked(fs.readdir).mockReset();
      mockParseYaml.mockImplementation((yamlString: string) =>
        yaml.parse(yamlString),
      );
      const projectQwenSkillsDir = path.join(
        TEST_PROJECT_ROOT,
        '.qwen',
        'skills',
      );
      vi.mocked(fs.readdir).mockImplementation((dirPath) => {
        if (String(dirPath) === projectQwenSkillsDir) {
          return Promise.resolve(
            ['high', 'unset-beta', 'unset-alpha', 'negative'].map((name) => ({
              name,
              isDirectory: () => true,
              isFile: () => false,
              isSymbolicLink: () => false,
            })) as unknown as Awaited<ReturnType<typeof fs.readdir>>,
          );
        }
        return Promise.resolve(
          [] as unknown as Awaited<ReturnType<typeof fs.readdir>>,
        );
      });
      vi.mocked(fs.readFile).mockImplementation((filePath) => {
        const name = path.basename(path.dirname(String(filePath)));
        const priorityLine =
          name === 'high'
            ? 'priority: 100\n'
            : name === 'negative'
              ? 'priority: -1\n'
              : '';
        return Promise.resolve(`---
name: ${name}
description: ${name} skill
${priorityLine}---
Body`);
      });

      const skills = await manager.listSkills({
        level: 'project',
        force: true,
      });

      expect(skills.map((skill) => skill.name)).toEqual([
        'high',
        'negative',
        'unset-alpha',
        'unset-beta',
      ]);
    });

    it('should normalize non-number extension priorities and stay alphabetical', async () => {
      vi.spyOn(mockConfig, 'getActiveExtensions').mockReturnValue([
        {
          id: 'test-extension',
          name: 'test-extension',
          version: '1.0.0',
          isActive: true,
          path: '/extension',
          config: { name: 'test-extension', version: '1.0.0' },
          contextFiles: [],
          skills: [
            {
              name: 'bad-priority',
              description: 'Bad priority',
              body: 'Body',
              filePath: '/extension/bad/SKILL.md',
              level: 'extension',
              priority: 'high' as unknown as number,
            },
            {
              name: 'high-priority',
              description: 'High priority',
              body: 'Body',
              filePath: '/extension/high/SKILL.md',
              level: 'extension',
              priority: 10,
            },
          ],
        },
      ]);

      const skills = await manager.listSkills({
        level: 'extension',
        force: true,
      });

      expect(skills.map((skill) => skill.name)).toEqual([
        'test-extension:bad-priority',
        'test-extension:high-priority',
      ]);
      // The non-number priority should still be normalized on the skill
      // itself so downstream consumers (the /skills display sort) see a
      // clean value.
      const badSkill = skills.find(
        (s) => s.name === 'test-extension:bad-priority',
      );
      expect(badSkill?.priority).toBe(0);
    });

    it('uses the canonical extension name for extension-owned skills', async () => {
      vi.spyOn(mockConfig, 'getActiveExtensions').mockReturnValue([
        {
          id: 'database-suite',
          name: 'alibabacloud-database-suite',
          displayName: 'Alibaba Cloud Database Suite',
          version: '1.0.0',
          isActive: true,
          path: '/extension',
          config: {
            name: 'alibabacloud-database-suite',
            version: '1.0.0',
          },
          contextFiles: [],
          skills: [
            {
              name: 'database-review',
              description: 'Review database changes',
              body: 'Body',
              filePath: '/extension/skills/database-review/SKILL.md',
              level: 'extension',
            },
          ],
        },
      ]);

      const skills = await manager.listSkills({
        level: 'extension',
        force: true,
      });

      expect(skills[0]?.extensionName).toBe('alibabacloud-database-suite');
      expect(skills[0]?.extensionDisplayName).toBe(
        'Alibaba Cloud Database Suite',
      );
    });

    it('should deduplicate same-name skills across provider dirs within a level', async () => {
      // Override readdir to return the same skill name from both .qwen and .agents dirs
      vi.mocked(fs.readdir).mockReset();
      const projectQwenDir = path.join(TEST_PROJECT_ROOT, '.qwen', 'skills');
      const projectAgentDir = path.join(TEST_PROJECT_ROOT, '.agents', 'skills');

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

  describe('extension skill qualified names', () => {
    const userQwenSkillsDir = path.join(TEST_HOME, '.qwen', 'skills');
    const bundledDirSegment = path.join('skills', 'bundled');

    type ActiveExtension = ReturnType<Config['getActiveExtensions']>[number];

    function fakeExtension(name: string, authoredNames: string[]) {
      return {
        id: name,
        name,
        version: '1.0.0',
        isActive: true,
        path: `/extensions/${name}`,
        config: { name, version: '1.0.0' },
        contextFiles: [],
        skills: authoredNames.map((authoredName) => ({
          name: authoredName,
          description: `${authoredName} from ${name}`,
          body: 'Body',
          filePath: `/extensions/${name}/skills/${authoredName}/SKILL.md`,
          level: 'extension' as const,
        })),
      } as ActiveExtension;
    }

    const dirEntry = (name: string) => ({
      name,
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
    });

    const emptyDir = [] as unknown as Awaited<ReturnType<typeof fs.readdir>>;

    const workspaceSkillMarkdown = (name: string) =>
      `---\nname: ${name}\ndescription: ${name} description\n---\n${name} body`;

    /** Names of the user-level skills discoverable on the mocked filesystem. */
    let userSkillNames: string[];

    beforeEach(() => {
      userSkillNames = ['my-user-skill'];

      vi.spyOn(mockConfig, 'getActiveExtensions').mockReturnValue([
        fakeExtension('rust', ['functions', 'pdf']),
        fakeExtension('docs', ['pdf']),
      ]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readdir).mockImplementation((dirPath: any) => {
        const pathStr = String(dirPath);
        if (pathStr === userQwenSkillsDir) {
          return Promise.resolve(
            userSkillNames.map(dirEntry) as unknown as Awaited<
              ReturnType<typeof fs.readdir>
            >,
          );
        }
        if (pathStr.endsWith(bundledDirSegment)) {
          return Promise.resolve([
            dirEntry('my-bundled-skill'),
          ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
        }
        return Promise.resolve(emptyDir);
      });

      vi.mocked(fs.access).mockResolvedValue(undefined);

      vi.mocked(fs.readFile).mockImplementation((filePath) => {
        const pathStr = String(filePath);
        const names = [...userSkillNames, 'my-bundled-skill'];
        for (const name of names) {
          if (pathStr.includes(name)) {
            return Promise.resolve(workspaceSkillMarkdown(name));
          }
        }
        return Promise.reject(new Error('File not found'));
      });

      mockParseYaml.mockImplementation((yamlString: string) =>
        yaml.parse(yamlString),
      );
    });

    it('registers every extension skill under its extension name', async () => {
      // Goal A: a 100-skill extension must not contribute 100 unattributable
      // global names.
      const names = (await manager.listSkills()).map((s) => s.name);
      expect(names).toContain('rust:functions');
      expect(names).not.toContain('functions');
    });

    it('keeps the authored name for the manifest-side lookups', async () => {
      const [skill] = (await manager.listSkills()).filter(
        (s) => s.name === 'rust:functions',
      );
      expect(skill?.authoredName).toBe('functions');
      expect(skill?.extensionName).toBe('rust');
    });

    it('registers both skills when two extensions author the same name', async () => {
      // Goal B: the collision is resolved by the naming rule, not by
      // precedence, so neither extension silently loses its skill. Asserted at
      // the extension level: `listSkills()` dedups across levels, so a
      // shadowing fixture elsewhere would hide one of the two.
      const names = (
        await manager.listSkills({ level: 'extension', force: true })
      ).map((s) => s.name);
      expect(names).toEqual(['docs:pdf', 'rust:functions', 'rust:pdf']);
    });

    it('leaves the manifest spellings untouched so the two-view bridge holds', async () => {
      // The registry copy carries the prefix; `extension.skills[].name` must
      // stay authored, because `Config.isSkillEnabled` matches the registry
      // view against the manifest through it and
      // `inactiveExtensionSkillRefs` builds its set from it. Qualifying the
      // manifest in place would flip `isInactiveExtensionSkill` from
      // fail-closed to fail-open.
      await manager.listSkills({ force: true });

      // Literals, not a snapshot taken before the refresh: a before/after
      // comparison only catches in-place mutation while `getActiveExtensions`
      // hands back one fixed object graph. A per-call clone would pass it while
      // the mutation stayed.
      expect(
        mockConfig
          .getActiveExtensions()
          .flatMap((extension) => extension.skills?.map((s) => s.name) ?? []),
      ).toEqual(['functions', 'pdf', 'pdf']);
    });

    it('leaves user, project and bundled skills at their single spelling', async () => {
      const names = (await manager.listSkills()).map((s) => s.name);
      expect(names).toContain('my-user-skill');
      expect(names).toContain('my-bundled-skill');
    });

    it('resolves the qualified name and not the authored one at runtime', async () => {
      await expect(
        manager.loadSkillForRuntime('rust:pdf'),
      ).resolves.toMatchObject({ name: 'rust:pdf' });
      // The bare spelling no longer names an extension skill.
      await expect(manager.loadSkillForRuntime('pdf')).resolves.toBeNull();
    });

    it('lets a user skill named with a colon keep precedence over an extension skill', async () => {
      // Precedence is project > user > extension > bundled and dedup is exact
      // match (`collectCachedSkills`), so a user skill literally named
      // `rust:pdf` wins the name.
      userSkillNames.push('rust:pdf');

      const [skill] = (await manager.listSkills({ force: true })).filter(
        (s) => s.name === 'rust:pdf',
      );
      expect(skill?.level).toBe('user');
    });
  });

  describe('getSkillsBaseDirs', () => {
    it('should return all project-level base dirs', () => {
      const baseDirs = manager.getSkillsBaseDirs('project');

      expect(baseDirs).toHaveLength(2);
      expect(baseDirs).toContain(
        path.join(TEST_PROJECT_ROOT, '.qwen', 'skills'),
      );
      expect(baseDirs).toContain(
        path.join(TEST_PROJECT_ROOT, '.agents', 'skills'),
      );
    });

    it('should return all user-level base dirs', () => {
      const baseDirs = manager.getSkillsBaseDirs('user');

      expect(baseDirs).toHaveLength(2);
      expect(baseDirs).toContain(path.join(TEST_HOME, '.qwen', 'skills'));
      expect(baseDirs).toContain(path.join(TEST_HOME, '.agents', 'skills'));
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

    it('should append custom skill dirs with ~ expansion to user-level dirs', () => {
      const defaultDirs = manager.getSkillsBaseDirs('user');
      const customConfig = makeFakeConfig({
        customSkillDirs: ['~/custom-skills', '/abs/skills'],
      });
      vi.spyOn(customConfig, 'getProjectRoot').mockReturnValue(
        TEST_PROJECT_ROOT,
      );
      const customManager = new SkillManager(customConfig);

      const baseDirs = customManager.getSkillsBaseDirs('user');

      expect(baseDirs).toHaveLength(defaultDirs.length + 2);
      expect(baseDirs.slice(0, defaultDirs.length)).toEqual(defaultDirs);
      expect(baseDirs).toContain(
        path.resolve(path.join(os.homedir(), 'custom-skills')),
      );
      expect(baseDirs).toContain(path.resolve('/abs/skills'));
    });

    it('should deduplicate custom dirs against default dirs', () => {
      const defaultDirs = manager.getSkillsBaseDirs('user');
      const customConfig = makeFakeConfig({
        customSkillDirs: [defaultDirs[0], '/unique/dir'],
      });
      vi.spyOn(customConfig, 'getProjectRoot').mockReturnValue(
        TEST_PROJECT_ROOT,
      );
      const customManager = new SkillManager(customConfig);

      const baseDirs = customManager.getSkillsBaseDirs('user');

      expect(baseDirs).toHaveLength(defaultDirs.length + 1);
      expect(baseDirs.filter((d) => d === defaultDirs[0])).toHaveLength(1);
      expect(baseDirs).toContain(path.resolve('/unique/dir'));
    });

    it('should not crash when config lacks getCustomSkillDirs', () => {
      const partialConfig = {
        getProjectRoot: () => TEST_PROJECT_ROOT,
      } as Config;
      const partialManager = new SkillManager(partialConfig);

      const baseDirs = partialManager.getSkillsBaseDirs('user');

      expect(baseDirs).toHaveLength(2);
    });

    it('should resolve relative custom skill dirs against CWD', () => {
      const customConfig = makeFakeConfig({
        customSkillDirs: ['./relative-skills'],
      });
      vi.spyOn(customConfig, 'getProjectRoot').mockReturnValue(
        TEST_PROJECT_ROOT,
      );
      const customManager = new SkillManager(customConfig);

      const baseDirs = customManager.getSkillsBaseDirs('user');

      expect(baseDirs).toContain(path.resolve('./relative-skills'));
    });
  });

  describe('bundled skills', () => {
    const bundledDirSegment = path.join('skills', 'bundled');
    const projectDirSegment = path.join('.qwen', 'skills');
    const userDirSegment = path.join('.qwen', 'skills');
    const projectPrefix = path.join(TEST_PROJECT_ROOT);
    const userPrefix = path.join(TEST_HOME);

    const reviewDirEntry = {
      name: 'review',
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
    };

    const simplifyDirEntry = {
      name: 'simplify',
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
    };

    const emptyDir = [] as unknown as Awaited<ReturnType<typeof fs.readdir>>;

    function mockReaddirForLevels(levels: Set<string>) {
      vi.mocked(fs.readdir).mockImplementation((dirPath) => {
        const pathStr = String(dirPath);
        const isBundled = pathStr.endsWith(bundledDirSegment);
        const isProject =
          pathStr.includes(projectDirSegment) &&
          pathStr.startsWith(projectPrefix);
        const isUser =
          pathStr.includes(userDirSegment) && pathStr.startsWith(userPrefix);

        if (levels.has('bundled') && isBundled) {
          return Promise.resolve([
            reviewDirEntry,
            simplifyDirEntry,
          ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
        }

        if (
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
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        const pathStr = String(filePath);
        if (pathStr.includes(`${path.sep}simplify${path.sep}`)) {
          return `---
name: simplify
description: Simplify recent changes
---
Simplify content`;
        }

        return `---
name: review
description: Review code changes
---
Review content`;
      });

      mockParseYaml.mockImplementation((yamlString: string) => {
        if (yamlString.includes('name: simplify')) {
          return {
            name: 'simplify',
            description: 'Simplify recent changes',
          };
        }

        return {
          name: 'review',
          description: 'Review code changes',
        };
      });
    }

    it('should load bundled skills in listSkills', async () => {
      mockReaddirForLevels(new Set(['bundled']));
      setupReviewSkillMocks();

      const skills = await manager.listSkills({ force: true });

      expect(skills.some((s) => s.name === 'review')).toBe(true);
      expect(skills.some((s) => s.name === 'simplify')).toBe(true);
      const reviewSkill = skills.find((s) => s.name === 'review');
      const simplifySkill = skills.find((s) => s.name === 'simplify');
      expect(reviewSkill!.level).toBe('bundled');
      expect(simplifySkill!.level).toBe('bundled');
    });

    it('should skip disabled skill levels without scanning them', async () => {
      const disabledConfig = makeFakeConfig({
        disabledSkillLevels: ['bundled'],
      });
      vi.spyOn(disabledConfig, 'getProjectRoot').mockReturnValue(
        TEST_PROJECT_ROOT,
      );
      const disabledManager = new SkillManager(disabledConfig);
      mockReaddirForLevels(new Set(['project', 'bundled']));
      setupReviewSkillMocks();

      const skills = await disabledManager.listSkills({ force: true });

      expect(skills.map((skill) => [skill.name, skill.level])).toEqual([
        ['review', 'project'],
      ]);
      expect(await disabledManager.loadSkill('simplify')).toBeNull();
      expect(
        vi
          .mocked(fs.readdir)
          .mock.calls.some(([dirPath]) =>
            String(dirPath).endsWith(bundledDirSegment),
          ),
      ).toBe(false);
    });

    it('should keep discovery working when config lacks getDisabledSkillLevels', async () => {
      const partialConfig = {
        isSafeMode: () => false,
        getProjectRoot: () => '/test/project',
        getBareMode: () => false,
      } as Config;
      const partialManager = new SkillManager(partialConfig);
      mockReaddirForLevels(new Set(['bundled']));
      setupReviewSkillMocks();

      const skills = await partialManager.listSkills({ force: true });

      expect(
        skills
          .filter((skill) => skill.level === 'bundled')
          .map((skill) => skill.name),
      ).toEqual(['review', 'simplify']);
    });

    it('should prioritize project-level over bundled skills with same name', async () => {
      mockReaddirForLevels(new Set(['project', 'bundled']));
      setupReviewSkillMocks();

      const skills = await manager.listSkills({ force: true });

      const reviewSkills = skills.filter((s) => s.name === 'review');
      expect(reviewSkills).toHaveLength(1);
      expect(reviewSkills[0].level).toBe('project');
      // simplify has no name conflict, so it must still survive alongside the deduped review skill
      expect(skills.some((s) => s.name === 'simplify')).toBe(true);
    });

    it('should prioritize user-level over bundled skills with same name', async () => {
      mockReaddirForLevels(new Set(['user', 'bundled']));
      setupReviewSkillMocks();

      const skills = await manager.listSkills({ force: true });

      const reviewSkills = skills.filter((s) => s.name === 'review');
      expect(reviewSkills).toHaveLength(1);
      expect(reviewSkills[0].level).toBe('user');
      // simplify has no name conflict, so it must still survive alongside the deduped review skill
      expect(skills.some((s) => s.name === 'simplify')).toBe(true);
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

    it.each(['level', 'listener'])(
      'reports %s failures only for strict skill refreshes while still awaiting siblings',
      async (failure) => {
        vi.mocked(fs.readdir).mockResolvedValue(
          [] as unknown as Awaited<ReturnType<typeof fs.readdir>>,
        );
        if (failure === 'level') {
          vi.spyOn(mockConfig, 'getActiveExtensions').mockImplementation(() => {
            throw new Error('extension cache unavailable');
          });
        } else {
          manager.addChangeListener(() =>
            Promise.reject(new Error('listener failed')),
          );
        }
        const sibling = vi.fn();
        manager.addChangeListener(sibling);
        await expect(
          manager.refreshCache({ throwOnError: true }),
        ).rejects.toThrow('Skill cache refresh failed');
        expect(sibling).toHaveBeenCalledExactlyOnceWith({ throwOnError: true });
        await expect(manager.refreshCache()).resolves.toBeUndefined();
        expect(sibling).toHaveBeenLastCalledWith();
      },
    );

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
      // llmClient.setTools() round-trips. The batch API should fire
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
        TEST_PROJECT_ROOT,
        '.qwen',
        'skills',
      );
      const userQwenSkillsDir = path.join(TEST_HOME, '.qwen', 'skills');
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
      const projectSkillsDir = path.join(TEST_PROJECT_ROOT, '.qwen', 'skills');
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

  describe('safe mode', () => {
    it('refreshCache only loads bundled skills', async () => {
      const safeConfig = makeFakeConfig({ safeMode: true });
      vi.spyOn(safeConfig, 'getProjectRoot').mockReturnValue(TEST_PROJECT_ROOT);
      const safeManager = new SkillManager(safeConfig);

      // Mock project/user skill files that should be ignored
      vi.mocked(fs.readdir)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValue(['evil-skill.md'] as any);
      vi.mocked(fs.readFile).mockResolvedValue(`---
name: evil-skill
description: Injected
---
malicious instructions`);

      await safeManager.refreshCache();

      const allSkills = await safeManager.listSkills();
      // Only bundled skills should be present; project/user/extension are skipped
      expect(allSkills.every((s) => s.level === 'bundled')).toBe(true);
      expect(allSkills.find((s) => s.name === 'evil-skill')).toBeUndefined();
    });
  });
});
