/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseSkillContent,
  loadSkillsFromDir,
  validateConfig,
} from './skill-load.js';
import * as fs from 'fs/promises';

// Mock file system operations
vi.mock('fs/promises');

// Mock yaml parser - use vi.hoisted for proper hoisting
const mockParseYaml = vi.hoisted(() => vi.fn());

vi.mock('../utils/yaml-parser.js', () => ({
  parse: mockParseYaml,
  stringify: vi.fn(),
}));

describe('skill-load', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Setup yaml parser mocks with sophisticated behavior
    mockParseYaml.mockImplementation((yamlString: string) => {
      if (yamlString.includes('name: context7-docs')) {
        return {
          name: 'context7-docs',
          description: 'Context7 documentation skill',
        };
      }
      if (yamlString.includes('allowedTools:')) {
        return {
          name: 'test-skill',
          description: 'A test skill',
          allowedTools: ['read_file', 'write_file'],
        };
      }
      // Default case
      return {
        name: 'test-skill',
        description: 'A test skill',
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parseSkillContent', () => {
    const testFilePath = '/test/extension/skills/test-skill/SKILL.md';

    it('should parse valid markdown content', () => {
      const validMarkdown = `---
name: test-skill
description: A test skill
---

You are a helpful assistant with this skill.
`;

      const config = parseSkillContent(validMarkdown, testFilePath);

      expect(config.name).toBe('test-skill');
      expect(config.description).toBe('A test skill');
      expect(config.body).toBe('You are a helpful assistant with this skill.');
      expect(config.level).toBe('extension');
      expect(config.filePath).toBe(testFilePath);
    });

    it('should parse markdown with CRLF line endings (Windows format)', () => {
      const markdownCrlf = `---\r
name: test-skill\r
description: A test skill\r
---\r
\r
You are a helpful assistant with this skill.\r
`;

      const config = parseSkillContent(markdownCrlf, testFilePath);

      expect(config.name).toBe('test-skill');
      expect(config.description).toBe('A test skill');
      expect(config.body).toBe('You are a helpful assistant with this skill.');
    });

    it('should parse markdown with CR only line endings (old Mac format)', () => {
      const markdownCr = `---\rname: test-skill\rdescription: A test skill\r---\r\rYou are a helpful assistant with this skill.\r`;

      const config = parseSkillContent(markdownCr, testFilePath);

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

      const config = parseSkillContent(markdownWithBom, testFilePath);

      expect(config.name).toBe('test-skill');
      expect(config.description).toBe('A test skill');
    });

    it('should parse markdown when body is empty and file ends after frontmatter', () => {
      const frontmatterOnly = `---
name: test-skill
description: A test skill
---`;

      const config = parseSkillContent(frontmatterOnly, testFilePath);

      expect(config.name).toBe('test-skill');
      expect(config.description).toBe('A test skill');
      expect(config.body).toBe('');
    });

    it('should parse markdown with CRLF and no trailing newline after frontmatter (Issue #1666 scenario)', () => {
      // This reproduces the exact issue: Windows-created file without trailing newline
      const windowsContent = `---\r\nname: context7-docs\r\ndescription: Context7 documentation skill\r\n---`;

      const config = parseSkillContent(windowsContent, testFilePath);

      expect(config.name).toBe('context7-docs');
      expect(config.description).toBe('Context7 documentation skill');
      expect(config.body).toBe('');
    });

    it('should parse content with both UTF-8 BOM and CRLF line endings', () => {
      const complexContent = `\uFEFF---\r
name: test-skill\r
description: A test skill\r
---\r
\r
Skill body content.\r
`;

      const config = parseSkillContent(complexContent, testFilePath);

      expect(config.name).toBe('test-skill');
      expect(config.description).toBe('A test skill');
      expect(config.body).toBe('Skill body content.');
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

      const config = parseSkillContent(markdownWithTools, testFilePath);

      expect(config.allowedTools).toEqual(['read_file', 'write_file']);
    });

    it('should throw error for invalid format without frontmatter', () => {
      const invalidMarkdown = `# Just a heading
Some content without frontmatter.
`;

      expect(() => parseSkillContent(invalidMarkdown, testFilePath)).toThrow(
        'Invalid format: missing YAML frontmatter',
      );
    });
  });

  describe('loadSkillsFromDir', () => {
    const testBaseDir = '/test/extension/skills';

    it('should load skills from directory', async () => {
      vi.mocked(fs.readdir).mockResolvedValue([
        { name: 'skill1', isDirectory: () => true, isFile: () => false },
        { name: 'not-a-dir.txt', isDirectory: () => false, isFile: () => true },
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(`---
name: test-skill
description: A test skill
---

Skill body.
`);

      const skills = await loadSkillsFromDir(testBaseDir);

      expect(skills).toHaveLength(1);
      expect(skills[0]?.name).toBe('test-skill');
    });

    it('should return empty array if directory does not exist', async () => {
      vi.mocked(fs.readdir).mockRejectedValue(new Error('Directory not found'));

      const skills = await loadSkillsFromDir(testBaseDir);

      expect(skills).toEqual([]);
    });

    it('should skip skills with invalid YAML and continue loading others', async () => {
      vi.mocked(fs.readdir).mockResolvedValue([
        { name: 'valid-skill', isDirectory: () => true, isFile: () => false },
        { name: 'invalid-skill', isDirectory: () => true, isFile: () => false },
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

      vi.mocked(fs.access).mockResolvedValue(undefined);

      // First call returns valid content, second returns invalid
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(
          `---
name: test-skill
description: A test skill
---

Valid skill.
`,
        )
        .mockResolvedValueOnce('Invalid content without frontmatter');

      const skills = await loadSkillsFromDir(testBaseDir);

      expect(skills).toHaveLength(1);
      expect(skills[0]?.name).toBe('test-skill');
    });
  });

  describe('validateConfig', () => {
    it('should validate valid config', () => {
      const config = {
        name: 'test-skill',
        description: 'A test skill',
        body: 'Skill body',
        level: 'extension' as const,
        filePath: '/path/to/skill',
      };

      const result = validateConfig(config);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should return error for missing name', () => {
      const config = {
        description: 'A test skill',
        body: 'Skill body',
      };

      const result = validateConfig(config);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Missing or invalid "name" field');
    });

    it('should return error for empty name', () => {
      const config = {
        name: '   ',
        description: 'A test skill',
        body: 'Skill body',
      };

      const result = validateConfig(config);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('"name" cannot be empty');
    });

    it('should return warning for empty body', () => {
      const config = {
        name: 'test-skill',
        description: 'A test skill',
        body: '',
        level: 'extension' as const,
        filePath: '/path/to/skill',
      };

      const result = validateConfig(config);

      expect(result.isValid).toBe(true);
      expect(result.warnings).toContain('Skill body is empty');
    });
  });
});
