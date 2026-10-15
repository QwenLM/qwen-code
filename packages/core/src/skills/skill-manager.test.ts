/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
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
import { type SkillConfig, type SkillLevel, SkillError } from './types.js';
import type { Config } from '../config/config.js';
import type { Extension } from '../extension/extensionManager.js';
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

// Hoisted yaml-parser mock; hooks and priority fixtures fall through to the
// real parser (see the beforeEach implementation).
const mockParseYaml = vi.hoisted(() => vi.fn());

vi.mock('../utils/yaml-parser.js', () => ({
  parse: mockParseYaml,
  stringify: vi.fn(),
}));

const TEST_HOME = path.resolve('/home/user');
const TEST_PROJECT_ROOT = path.resolve('/test/project');
// path.join so separators match on all platforms.
const PROJECT_QWEN_DIR = path.join(TEST_PROJECT_ROOT, '.qwen', 'skills');
const USER_QWEN_DIR = path.join(TEST_HOME, '.qwen', 'skills');

type Dirents = Awaited<ReturnType<typeof fs.readdir>>;
const dirents = (...entries: unknown[]) => entries as unknown as Dirents;
const dirent = (name: string, kind: 'dir' | 'file' | 'link' = 'dir') => ({
  name,
  isDirectory: () => kind === 'dir',
  isFile: () => kind === 'file',
  isSymbolicLink: () => kind === 'link',
});
/** Entry without `isFile`, as the discovery-completeness cases build it. */
const bareDirent = (name: string, link = false) => ({
  name,
  isDirectory: () => !link,
  isSymbolicLink: () => link,
});
const mockReaddir = (...entries: unknown[]) =>
  vi.mocked(fs.readdir).mockResolvedValue(dirents(...entries));
/** Lists the entries of each exact directory key; every other dir is empty. */
const mockReaddirByDir = (dirs: Record<string, unknown[]>) =>
  vi
    .mocked(fs.readdir)
    .mockImplementation((dirPath) =>
      Promise.resolve(dirents(...(dirs[String(dirPath)] ?? []))),
    );
/** Serves the first file whose key the path contains; rejects otherwise. */
const mockReadFileByPath = (files: Record<string, string>) =>
  vi.mocked(fs.readFile).mockImplementation((filePath) => {
    const key = Object.keys(files).find((k) => String(filePath).includes(k));
    return key
      ? Promise.resolve(files[key])
      : Promise.reject(new Error('File not found'));
  });
/** One skill directory whose SKILL.md reads as `markdown`. */
const mockOneSkill = (
  name: string,
  markdown: string,
  kind: 'dir' | 'link' = 'dir',
) => {
  mockReaddir(dirent(name, kind));
  vi.mocked(fs.access).mockResolvedValue(undefined);
  vi.mocked(fs.readFile).mockResolvedValue(markdown);
};
/** SKILL.md with a blank line after the frontmatter and a trailing newline. */
const fm = (frontmatter: string, body = 'Body.') =>
  `---\n${frontmatter}\n---\n\n${body}\n`;
/** Compact SKILL.md: body right after the fence, no trailing newline. */
const skillFile = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
const TEST_FM = 'name: test-skill\ndescription: A test skill';
const TSX_FM =
  'name: tsx-helper\ndescription: React skill\npaths:\n  - "src/**/*.tsx"';
const fsError = (message: string, code: string) =>
  Object.assign(new Error(message), { code });
const managerWith = (params: Parameters<typeof makeFakeConfig>[0]) => {
  const config = makeFakeConfig(params);
  vi.spyOn(config, 'getProjectRoot').mockReturnValue(TEST_PROJECT_ROOT);
  return new SkillManager(config);
};
const fakeExt = (name: string, fields: Partial<Extension> = {}): Extension => ({
  id: name,
  name,
  version: '1.0.0',
  isActive: true,
  path: `/extensions/${name}`,
  config: { name, version: '1.0.0' },
  contextFiles: [],
  skills: [],
  ...fields,
});
const extSkill = (
  name: string,
  description: string,
  filePath: string,
  fields: Partial<SkillConfig> = {},
): SkillConfig => ({
  name,
  description,
  body: 'Body',
  filePath,
  level: 'extension',
  ...fields,
});

/** Canned parser results; the first needle the YAML contains wins. */
const FIXED_FRONTMATTER: Array<[string, Record<string, string>]> = [
  ['name: skill1', { name: 'skill1', description: 'First skill' }],
  ['name: skill2', { name: 'skill2', description: 'Second skill' }],
  ['name: skill3', { name: 'skill3', description: 'Third skill' }],
  [
    'name: symlink-skill',
    { name: 'symlink-skill', description: 'A skill loaded from symlink' },
  ],
  [
    'A symlinked skill',
    { name: 'symlink-skill', description: 'A symlinked skill' },
  ],
  [
    'name: regular-skill',
    { name: 'regular-skill', description: 'A regular skill' },
  ],
];

describe('SkillManager', () => {
  let manager: SkillManager;
  let mockConfig: Config;

  beforeEach(() => {
    // Mock os.homedir before makeFakeConfig: the Config constructor calls
    // Storage.getGlobalQwenDir(), which needs os.homedir().
    vi.mocked(os.homedir).mockReturnValue(TEST_HOME);
    vi.mocked(os.tmpdir).mockReturnValue('/tmp');
    mockConfig = makeFakeConfig({});
    vi.spyOn(mockConfig, 'getProjectRoot').mockReturnValue(TEST_PROJECT_ROOT);
    vi.clearAllMocks();

    // Route each fixture's YAML to a result by its content.
    mockParseYaml.mockImplementation((yamlString: string) => {
      if (yamlString.includes('hooks:')) return yaml.parse(yamlString);
      const testSkill = { name: 'test-skill', description: 'A test skill' };
      if (yamlString.includes('allowedTools:')) {
        return { ...testSkill, allowedTools: ['read_file', 'write_file'] };
      }
      if (yamlString.includes('argument-hint:')) {
        return { ...testSkill, 'argument-hint': '[topic]' };
      }
      if (/^priority:/m.test(yamlString)) return yaml.parse(yamlString);
      // Top-level `paths:` key only (start-anchored). Reads the literal YAML to
      // keep array vs scalar vs empty; the name comes from the `name:` line so
      // fixtures can coexist in one test (e.g. cross-level shadowing).
      if (/^paths:/m.test(yamlString)) {
        const nameMatch = yamlString.match(/name:\s*(\S+)/);
        const name = nameMatch ? nameMatch[1] : 'test-skill';
        const description =
          ['React skill', 'Hidden helper'].find((d) =>
            yamlString.includes(d),
          ) ?? 'A test skill';
        // Every quoted `- "..."` bullet (e.g. the oversized glob).
        let paths: unknown = yamlString
          .match(/-\s+"([^"]+)"/g)
          ?.map((m) => m.replace(/^-\s+"|"$/g, ''));
        if (yamlString.includes('paths: []')) paths = [];
        // Invalid scalar: surfaced as a string so the validator rejects it.
        if (yamlString.includes('paths: "src/**/*.tsx"'))
          paths = 'src/**/*.tsx';
        const result: Record<string, unknown> = { name, description, paths };
        if (yamlString.includes('disable-model-invocation: true')) {
          result['disable-model-invocation'] = true;
        }
        return result;
      }
      const fixed = FIXED_FRONTMATTER.find(([needle]) =>
        yamlString.includes(needle),
      );
      if (fixed) return { ...fixed[1] };
      if (yamlString.includes('name: shared-skill')) {
        const desc =
          ['From qwen dir', 'From agent dir'].find((d) =>
            yamlString.includes(d),
          ) ?? 'A shared skill';
        return { name: 'shared-skill', description: desc };
      }
      if (!yamlString.includes('name:')) {
        return { description: 'A test skill' }; // Missing name case
      }
      if (!yamlString.includes('description:')) {
        return { name: 'test-skill' }; // Missing description case
      }
      return testSkill;
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

  const validMarkdown = fm(
    TEST_FM,
    'You are a helpful assistant with this skill.',
  );

  const parse = (
    markdown: string,
    filePath = validSkillConfig.filePath,
    level: SkillLevel = 'project',
  ) => manager.parseSkillContent(markdown, filePath, level);
  /** Parses TEST_FM plus `extra` frontmatter lines. */
  const parseWith = (extra: string, body = 'Skill body.') =>
    parse(fm(`${TEST_FM}\n${extra}`, body));

  describe('parseSkillContent', () => {
    it('should parse valid markdown content', () => {
      const config = parse(validMarkdown);

      expect(config.name).toBe('test-skill');
      expect(config.description).toBe('A test skill');
      expect(config.body).toBe('You are a helpful assistant with this skill.');
      expect(config.level).toBe('project');
      expect(config.filePath).toBe(validSkillConfig.filePath);
    });

    it('should parse markdown with CRLF line endings', () => {
      const config = parse(validMarkdown.replace(/\n/g, '\r\n'));

      expect(config.name).toBe('test-skill');
      expect(config.description).toBe('A test skill');
      expect(config.body).toBe('You are a helpful assistant with this skill.');
    });

    it('should parse markdown with UTF-8 BOM', () => {
      const config = parse(`\uFEFF${validMarkdown}`);

      expect(config.name).toBe('test-skill');
      expect(config.description).toBe('A test skill');
    });

    it('should parse markdown when body is empty and file ends after frontmatter', () => {
      const config = parse(`---\n${TEST_FM}\n---`);

      expect(config.name).toBe('test-skill');
      expect(config.description).toBe('A test skill');
      expect(config.body).toBe('');
    });

    it('should parse content with allowedTools', () => {
      const config = parseWith(
        'allowedTools:\n  - read_file\n  - write_file',
        'You are a helpful assistant with this skill.',
      );
      expect(config.allowedTools).toEqual(['read_file', 'write_file']);
    });

    it('should parse argument-hint from frontmatter', () => {
      const config = parseWith('argument-hint: "[topic]"');
      expect(config.argumentHint).toBe('[topic]');
    });

    it('should parse numeric priority from frontmatter', () => {
      expect(parseWith('priority: 25').priority).toBe(25);
    });

    it('should ignore invalid priority values without dropping the skill', () => {
      expect(parseWith('priority: true').priority).toBeUndefined();
    });

    it('should parse user-invocable from frontmatter', () => {
      mockParseYaml.mockReturnValueOnce({
        name: 'test-skill',
        description: 'A test skill',
        'user-invocable': false,
      });

      expect(parseWith('user-invocable: false').userInvocable).toBe(false);
    });

    it('should parse content with paths (conditional skill)', () => {
      const config = parse(fm(`${TSX_FM}\n  - "test/**/*.tsx"`));
      expect(config.paths).toEqual(['src/**/*.tsx', 'test/**/*.tsx']);
    });

    it('should leave paths undefined when frontmatter omits it', () => {
      expect(parse(fm(TEST_FM)).paths).toBeUndefined();
    });

    it('should treat an empty paths array as undefined (unconditional)', () => {
      expect(parseWith('paths: []', 'Body.').paths).toBeUndefined();
    });

    it('should throw when paths is not an array', () => {
      expect(() => parseWith('paths: "src/**/*.tsx"', 'Body.')).toThrow(
        /"paths" must be an array/,
      );
    });

    it('should determine level from file path', () => {
      const projectConfig = parse(
        validMarkdown,
        '/test/project/.qwen/skills/test-skill/SKILL.md',
      );
      const userConfig = parse(
        validMarkdown,
        '/home/user/.qwen/skills/test-skill/SKILL.md',
        'user',
      );

      expect(projectConfig.level).toBe('project');
      expect(userConfig.level).toBe('user');
    });

    it.each([
      [
        'should throw error for invalid frontmatter format',
        'No frontmatter here\nJust content',
      ],
      [
        'should throw error for missing name',
        fm('description: A test skill', 'You are a helpful assistant.'),
      ],
      [
        'should throw error for missing description',
        fm('name: test-skill', 'You are a helpful assistant.'),
      ],
    ])('%s', (_title, markdown) => {
      expect(() => parse(markdown)).toThrow(SkillError);
    });
  });

  describe('validateConfig', () => {
    it('should validate valid configuration', () => {
      const result = manager.validateConfig(validSkillConfig);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it.each<[string, Partial<SkillConfig>, string]>([
      [
        'should report error for missing name',
        { name: '' },
        '"name" cannot be empty',
      ],
      [
        'should report error for missing description',
        { description: '' },
        '"description" cannot be empty',
      ],
      [
        'should report error for invalid allowedTools type',
        { allowedTools: 'not-an-array' as unknown as string[] },
        '"allowedTools" must be an array',
      ],
      [
        'should report error for invalid priority',
        { priority: 'high' as unknown as number },
        '"priority" must be a finite number',
      ],
    ])('%s', (_title, override, error) => {
      const result = manager.validateConfig({
        ...validSkillConfig,
        ...override,
      });

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain(error);
    });

    it('should warn for empty body', () => {
      const result = manager.validateConfig({ ...validSkillConfig, body: '' });

      expect(result.isValid).toBe(true); // Still valid
      expect(result.warnings).toContain('Skill body is empty');
    });
  });

  describe('loadSkill', () => {
    it('should load skill from project level first', async () => {
      mockOneSkill('test-skill', validMarkdown);

      const config = await manager.loadSkill('test-skill');

      expect(config).toBeDefined();
      expect(config!.name).toBe('test-skill');
    });

    it('should fall back to user level if project level fails', async () => {
      vi.mocked(fs.readdir)
        .mockRejectedValueOnce(new Error('Project dir not found')) // project level fails
        .mockResolvedValueOnce(dirents(dirent('test-skill'))); // user level succeeds
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(validMarkdown);

      const config = await manager.loadSkill('test-skill');

      expect(config).toBeDefined();
      expect(config!.name).toBe('test-skill');
    });

    it('should return null if not found at either level', async () => {
      vi.mocked(fs.readdir).mockRejectedValue(new Error('Directory not found'));

      expect(await manager.loadSkill('nonexistent')).toBeNull();
    });
  });

  describe('loadSkillForRuntime', () => {
    it('should load skill for runtime', async () => {
      vi.mocked(fs.readdir).mockResolvedValueOnce(
        dirents(dirent('test-skill')),
      );
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(validMarkdown); // SKILL.md

      const config = await manager.loadSkillForRuntime('test-skill');

      expect(config).toBeDefined();
      expect(config!.name).toBe('test-skill');
    });

    it('should return null if skill not found', async () => {
      vi.mocked(fs.readdir).mockRejectedValue(new Error('Directory not found'));

      expect(await manager.loadSkillForRuntime('nonexistent')).toBeNull();
    });
  });

  describe('listSkills', () => {
    beforeEach(() => {
      // Other provider dirs (.agents, .cursor, .codex, .claude) list empty.
      mockReaddirByDir({
        [PROJECT_QWEN_DIR]: [
          dirent('skill1'),
          dirent('skill2'),
          dirent('not-a-dir.txt', 'file'),
        ],
        [USER_QWEN_DIR]: [dirent('skill3'), dirent('skill1')],
      });
      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockReadFileByPath({
        skill1: skillFile('skill1', 'First skill', 'Skill 1 content'),
        skill2: skillFile('skill2', 'Second skill', 'Skill 2 content'),
        skill3: skillFile('skill3', 'Third skill', 'Skill 3 content'),
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
      mockReaddirByDir({
        [PROJECT_QWEN_DIR]: [
          'high',
          'unset-beta',
          'unset-alpha',
          'negative',
        ].map((name) => dirent(name)),
      });
      vi.mocked(fs.readFile).mockImplementation((filePath) => {
        const name = path.basename(path.dirname(String(filePath)));
        const priorityLine =
          name === 'high'
            ? 'priority: 100\n'
            : name === 'negative'
              ? 'priority: -1\n'
              : '';
        return Promise.resolve(
          `---\nname: ${name}\ndescription: ${name} skill\n${priorityLine}---\nBody`,
        );
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
        fakeExt('test-extension', {
          path: '/extension',
          skills: [
            extSkill(
              'bad-priority',
              'Bad priority',
              '/extension/bad/SKILL.md',
              { priority: 'high' as unknown as number },
            ),
            extSkill(
              'high-priority',
              'High priority',
              '/extension/high/SKILL.md',
              { priority: 10 },
            ),
          ],
        }),
      ]);

      const skills = await manager.listSkills({
        level: 'extension',
        force: true,
      });

      expect(skills.map((skill) => skill.name)).toEqual([
        'test-extension:bad-priority',
        'test-extension:high-priority',
      ]);
      // The skill itself still carries a normalized priority so downstream
      // consumers (the /skills display sort) see a clean value.
      const badSkill = skills.find(
        (s) => s.name === 'test-extension:bad-priority',
      );
      expect(badSkill?.priority).toBe(0);
    });

    it('uses the canonical extension name for extension-owned skills', async () => {
      vi.spyOn(mockConfig, 'getActiveExtensions').mockReturnValue([
        fakeExt('alibabacloud-database-suite', {
          id: 'database-suite',
          displayName: 'Alibaba Cloud Database Suite',
          path: '/extension',
          skills: [
            extSkill(
              'database-review',
              'Review database changes',
              '/extension/skills/database-review/SKILL.md',
            ),
          ],
        }),
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
      // The same skill name in both the .qwen and .agents project dirs.
      vi.mocked(fs.readdir).mockReset();
      mockReaddirByDir({
        [PROJECT_QWEN_DIR]: [dirent('shared-skill')],
        [path.join(TEST_PROJECT_ROOT, '.agents', 'skills')]: [
          dirent('shared-skill'),
        ],
      });
      mockReadFileByPath({
        '.qwen': skillFile('shared-skill', 'From qwen dir', 'Qwen content'),
        '.agents': skillFile(
          'shared-skill',
          'From agents dir',
          'Agents content',
        ),
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
      mockReaddir();

      expect(await manager.listSkills({ force: true })).toHaveLength(0);
    });

    it('should handle directory read errors', async () => {
      vi.mocked(fs.readdir).mockReset();
      vi.mocked(fs.readdir).mockRejectedValue(new Error('Directory not found'));

      expect(await manager.listSkills({ force: true })).toHaveLength(0);
    });
  });

  describe('extension skill qualified names', () => {
    const bundledDirSegment = path.join('skills', 'bundled');

    const fakeExtension = (name: string, authoredNames: string[]) =>
      fakeExt(name, {
        skills: authoredNames.map((authoredName) =>
          extSkill(
            authoredName,
            `${authoredName} from ${name}`,
            `/extensions/${name}/skills/${authoredName}/SKILL.md`,
          ),
        ),
      });

    /** Names of the user-level skills discoverable on the mocked filesystem. */
    let userSkillNames: string[];

    beforeEach(() => {
      userSkillNames = ['my-user-skill'];

      vi.spyOn(mockConfig, 'getActiveExtensions').mockReturnValue([
        fakeExtension('rust', ['functions', 'pdf']),
        fakeExtension('docs', ['pdf']),
      ]);

      vi.mocked(fs.readdir).mockImplementation((dirPath) => {
        const pathStr = String(dirPath);
        if (pathStr === USER_QWEN_DIR) {
          return Promise.resolve(
            dirents(...userSkillNames.map((name) => dirent(name))),
          );
        }
        if (pathStr.endsWith(bundledDirSegment)) {
          return Promise.resolve(dirents(dirent('my-bundled-skill')));
        }
        return Promise.resolve(dirents());
      });
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockImplementation((filePath) => {
        const name = [...userSkillNames, 'my-bundled-skill'].find((n) =>
          String(filePath).includes(n),
        );
        return name
          ? Promise.resolve(
              skillFile(name, `${name} description`, `${name} body`),
            )
          : Promise.reject(new Error('File not found'));
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
      // Goal B: the naming rule, not precedence, resolves the collision, so
      // neither extension silently loses its skill. Asserted at the extension
      // level because cross-level dedup could let a shadowing fixture hide one.
      const names = (
        await manager.listSkills({ level: 'extension', force: true })
      ).map((s) => s.name);
      expect(names).toEqual(['docs:pdf', 'rust:functions', 'rust:pdf']);
    });

    it('leaves the manifest spellings untouched so the two-view bridge holds', async () => {
      // Only the registry copy carries the prefix: `Config.isSkillEnabled`
      // matches the registry view against the manifest through
      // `extension.skills[].name`, and `inactiveExtensionSkillRefs` builds its
      // set from it, so qualifying the manifest in place would flip
      // `isInactiveExtensionSkill` from fail-closed to fail-open.
      await manager.listSkills({ force: true });

      // Literals, not a pre-refresh snapshot: a before/after comparison only
      // catches in-place mutation while `getActiveExtensions` returns one fixed
      // object graph; a per-call clone would pass it with the mutation intact.
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
    it.each([
      ['project', TEST_PROJECT_ROOT],
      ['user', TEST_HOME],
    ] as const)('should return all %s-level base dirs', (level, root) => {
      const baseDirs = manager.getSkillsBaseDirs(level);

      expect(baseDirs).toHaveLength(2);
      expect(baseDirs).toContain(path.join(root, '.qwen', 'skills'));
      expect(baseDirs).toContain(path.join(root, '.agents', 'skills'));
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
      const baseDirs = managerWith({
        customSkillDirs: ['~/custom-skills', '/abs/skills'],
      }).getSkillsBaseDirs('user');

      expect(baseDirs).toHaveLength(defaultDirs.length + 2);
      expect(baseDirs.slice(0, defaultDirs.length)).toEqual(defaultDirs);
      expect(baseDirs).toContain(
        path.resolve(path.join(os.homedir(), 'custom-skills')),
      );
      expect(baseDirs).toContain(path.resolve('/abs/skills'));
    });

    it('should deduplicate custom dirs against default dirs', () => {
      const defaultDirs = manager.getSkillsBaseDirs('user');
      const baseDirs = managerWith({
        customSkillDirs: [defaultDirs[0], '/unique/dir'],
      }).getSkillsBaseDirs('user');

      expect(baseDirs).toHaveLength(defaultDirs.length + 1);
      expect(baseDirs.filter((d) => d === defaultDirs[0])).toHaveLength(1);
      expect(baseDirs).toContain(path.resolve('/unique/dir'));
    });

    it('should not crash when config lacks getCustomSkillDirs', () => {
      const partialConfig = {
        getProjectRoot: () => TEST_PROJECT_ROOT,
      } as Config;
      const partialManager = new SkillManager(partialConfig);

      expect(partialManager.getSkillsBaseDirs('user')).toHaveLength(2);
    });

    it('should resolve relative custom skill dirs against CWD', () => {
      const baseDirs = managerWith({
        customSkillDirs: ['./relative-skills'],
      }).getSkillsBaseDirs('user');

      expect(baseDirs).toContain(path.resolve('./relative-skills'));
    });
  });

  describe('bundled skills', () => {
    const bundledDirSegment = path.join('skills', 'bundled');
    const qwenDirSegment = path.join('.qwen', 'skills');

    /**
     * Bundled lists review and simplify; each project/user level in `levels`
     * lists review alone. Also mocks both SKILL.md files and their YAML.
     */
    function setupLevels(...levels: string[]) {
      vi.mocked(fs.readdir).mockImplementation((dirPath) => {
        const pathStr = String(dirPath);
        const isQwen = pathStr.includes(qwenDirSegment);
        if (levels.includes('bundled') && pathStr.endsWith(bundledDirSegment)) {
          return Promise.resolve(dirents(dirent('review'), dirent('simplify')));
        }
        if (
          (levels.includes('project') &&
            isQwen &&
            pathStr.startsWith(TEST_PROJECT_ROOT)) ||
          (levels.includes('user') && isQwen && pathStr.startsWith(TEST_HOME))
        ) {
          return Promise.resolve(dirents(dirent('review')));
        }
        return Promise.resolve(dirents());
      });
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockImplementation(async (filePath) =>
        String(filePath).includes(`${path.sep}simplify${path.sep}`)
          ? skillFile('simplify', 'Simplify recent changes', 'Simplify content')
          : skillFile('review', 'Review code changes', 'Review content'),
      );
      mockParseYaml.mockImplementation((yamlString: string) =>
        yamlString.includes('name: simplify')
          ? { name: 'simplify', description: 'Simplify recent changes' }
          : { name: 'review', description: 'Review code changes' },
      );
    }

    it('should load bundled skills in listSkills', async () => {
      setupLevels('bundled');

      const skills = await manager.listSkills({ force: true });

      expect(skills.some((s) => s.name === 'review')).toBe(true);
      expect(skills.some((s) => s.name === 'simplify')).toBe(true);
      const reviewSkill = skills.find((s) => s.name === 'review');
      const simplifySkill = skills.find((s) => s.name === 'simplify');
      expect(reviewSkill!.level).toBe('bundled');
      expect(simplifySkill!.level).toBe('bundled');
    });

    it('should skip disabled skill levels without scanning them', async () => {
      const disabledManager = managerWith({ disabledSkillLevels: ['bundled'] });
      setupLevels('project', 'bundled');

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
      setupLevels('bundled');

      const skills = await partialManager.listSkills({ force: true });

      expect(
        skills
          .filter((skill) => skill.level === 'bundled')
          .map((skill) => skill.name),
      ).toEqual(['review', 'simplify']);
    });

    it.each(['project', 'user'])(
      'should prioritize %s-level over bundled skills with same name',
      async (level) => {
        setupLevels(level, 'bundled');

        const skills = await manager.listSkills({ force: true });

        const reviewSkills = skills.filter((s) => s.name === 'review');
        expect(reviewSkills).toHaveLength(1);
        expect(reviewSkills[0].level).toBe(level);
        // simplify has no name conflict, so it must still survive alongside the deduped review skill
        expect(skills.some((s) => s.name === 'simplify')).toBe(true);
      },
    );

    it('should skip all skills in bare mode', async () => {
      vi.spyOn(mockConfig, 'getBareMode').mockReturnValue(true);
      setupLevels('project', 'user', 'bundled');

      expect(await manager.listSkills({ force: true })).toEqual([]);
    });

    it('should fall back to bundled level in loadSkill', async () => {
      // Project, user, extension all empty; bundled has the skill
      setupLevels('bundled');

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
      mockReaddir();

      await manager.refreshCache();

      expect(listener).toHaveBeenCalled();
    });

    it('should remove listener when cleanup function is called', async () => {
      const listener = vi.fn();
      const removeListener = manager.addChangeListener(listener);

      removeListener();
      mockReaddir();

      await manager.refreshCache();

      expect(listener).not.toHaveBeenCalled();
    });

    it('awaits async listeners before resolving', async () => {
      // Regression: notifyChangeListeners must await listener Promises (e.g.
      // SkillTool.refreshSkills). The <system-reminder> is emitted when
      // matchAndActivateByPath resolves, and announcing a skill before
      // SkillTool.setTools() finishes leaves the model unable to invoke it.
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
      mockReaddir();

      // Without await semantics the refresh would race ahead of the listener.
      const refreshDone = manager.refreshCache();
      // One microtask tick lets the listener's outer Promise enter its
      // `.then` callback (still parked on `listenerSettled`).
      await Promise.resolve();
      expect(listenerObserved).toBe(false);

      resolveListener();
      await refreshDone;
      expect(listenerObserved).toBe(true);
    });

    // Regression: one buggy listener (e.g. a third-party hook throwing during
    // refresh) must neither stop the others nor make refreshCache reject; with
    // Promise.all instead of allSettled every later listener silently dies.
    // The wrapper `Promise.resolve().then(listener)` handles sync throws and
    // rejected Promises alike, but both are pinned because a refactor that
    // special-cases sync throws could regress the async branch.
    it.each([
      [
        'isolates listener throws via allSettled — siblings still run',
        () => {
          throw new Error('listener exploded');
        },
      ],
      [
        'isolates async listener rejections — siblings still run',
        () => Promise.reject(new Error('async fail')),
      ],
    ])('%s', async (_title, failingListener) => {
      const failing = vi.fn(failingListener);
      const sibling = vi.fn();
      manager.addChangeListener(failing);
      manager.addChangeListener(sibling);
      mockReaddir();

      await expect(manager.refreshCache()).resolves.toBeUndefined();
      expect(failing).toHaveBeenCalled();
      expect(sibling).toHaveBeenCalled();
    });

    it.each(['level', 'listener'])(
      'reports %s failures only for strict skill refreshes while still awaiting siblings',
      async (failure) => {
        mockReaddir();
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
      // Regression: the 30s timeout was only `unref`d, leaving a pending timer
      // per fast listener; under high-frequency activation vitest's open-handle
      // diagnostic (and any active-handle snapshot) saw the pile-up.
      // `.finally(clearTimeout)` makes cleanup explicit.
      const setSpy = vi.spyOn(global, 'setTimeout');
      const clearSpy = vi.spyOn(global, 'clearTimeout');

      const fastListener = vi.fn(() => Promise.resolve());
      manager.addChangeListener(fastListener);
      mockReaddir();

      // Only listener timeouts use setTimeout here, but other tests can leak
      // setTimeout calls (chokidar, etc.), so diff before/after.
      const setCallsBefore = setSpy.mock.calls.length;
      const clearCallsBefore = clearSpy.mock.calls.length;

      await manager.refreshCache();

      // At least one timer set (the listener wrapper's) and a matching
      // clear; equal deltas guarantee nothing leaked.
      const setDelta = setSpy.mock.calls.length - setCallsBefore;
      const clearDelta = clearSpy.mock.calls.length - clearCallsBefore;
      expect(setDelta).toBeGreaterThanOrEqual(1);
      expect(clearDelta).toBeGreaterThanOrEqual(setDelta);

      setSpy.mockRestore();
      clearSpy.mockRestore();
    });
  });

  describe('discovery completeness', () => {
    function createReadGate() {
      let resolve!: (value: []) => void;
      const promise = new Promise<[]>((release) => {
        resolve = release;
      });
      return { promise, resolve };
    }

    it.each(['failure-first', 'success-first'] as const)(
      'publishes each overlapping scan with its own completeness (%s)',
      async (order) => {
        const gates = [createReadGate(), createReadGate()];
        let failedRead: Promise<never> | undefined;
        let projectReads = 0;
        let gateReads = 0;
        vi.spyOn(mockConfig, 'getDisabledSkillLevels').mockReturnValue(
          new Set(['user', 'extension', 'bundled']),
        );
        vi.spyOn(manager, 'getSkillsBaseDirs').mockReturnValue([
          '/overlap/project',
          '/overlap/gate',
        ]);
        vi.mocked(fs.access).mockResolvedValue(undefined);
        vi.mocked(fs.readFile).mockResolvedValue(validMarkdown);
        vi.mocked(fs.readdir).mockImplementation((directory) => {
          if (String(directory) === '/overlap/project') {
            if (++projectReads === 1) {
              failedRead = Promise.reject(fsError('unreadable', 'EACCES'));
              return failedRead;
            }
            return Promise.resolve(dirents(bareDirent('test-skill')));
          }
          return gates[gateReads++].promise;
        });
        const snapshots: Array<{ names: string[]; incomplete: boolean }> = [];
        manager.addChangeListener(() => {
          snapshots.push({
            names: (manager.getCachedSkills() ?? []).map((skill) => skill.name),
            incomplete: manager.hasDiscoveryErrors(),
          });
        });
        const failure = manager.refreshCache();
        await expect(failedRead).rejects.toMatchObject({ code: 'EACCES' });
        const success = manager.refreshCache();
        try {
          const first = order === 'failure-first' ? 0 : 1;
          gates[first].resolve([]);
          await (first === 0 ? failure : success);
          gates[1 - first].resolve([]);
          await (first === 0 ? success : failure);
          const failed = { names: [], incomplete: true };
          const succeeded = { names: ['test-skill'], incomplete: false };
          expect(snapshots).toEqual(
            first === 0 ? [failed, succeeded] : [succeeded, failed],
          );
        } finally {
          gates.forEach((gate) => gate.resolve([]));
          await Promise.allSettled([failure, success]);
        }
      },
    );

    it('keeps the committed completeness while a new scan is pending', async () => {
      vi.mocked(fs.readdir).mockRejectedValue(fsError('unreadable', 'EACCES'));
      await manager.refreshCache();
      expect(manager.hasDiscoveryErrors()).toBe(true);
      const gate = createReadGate();
      vi.mocked(fs.readdir).mockReturnValue(gate.promise);
      const refreshing = manager.refreshCache();
      try {
        expect(manager.hasDiscoveryErrors()).toBe(true);
      } finally {
        gate.resolve([]);
        await refreshing;
      }
      expect(manager.hasDiscoveryErrors()).toBe(false);
    });

    it('retains external validation diagnostics without changing scan completeness', async () => {
      vi.mocked(fs.readdir).mockResolvedValue([]);
      await manager.refreshCache();
      expect(() => parse('invalid frontmatter', '/draft/SKILL.md')).toThrow();
      expect(manager.getParseErrors().has('/draft/SKILL.md')).toBe(true);
      expect(manager.getCachedSkills()).toEqual([]);
      expect(manager.hasDiscoveryErrors()).toBe(false);
    });

    it.each(['EACCES', 'ENOENT'] as const)(
      'distinguishes a bundled directory %s error even when existsSync returns false',
      async (code) => {
        const bundledDir = manager.getSkillsBaseDirs('bundled')[0];
        vi.mocked(fsSync.existsSync).mockReturnValue(false);
        vi.mocked(fs.readdir).mockImplementation(async (directory) => {
          if (String(directory) === bundledDir) throw fsError(code, code);
          return [];
        });
        await manager.refreshCache();
        expect(manager.hasDiscoveryErrors()).toBe(code !== 'ENOENT');
        expect(fs.readdir).toHaveBeenCalledWith(bundledDir, {
          withFileTypes: true,
        });
      },
    );

    it('propagates an active extension skill scan failure and clears it after recovery', async () => {
      vi.mocked(fs.readdir).mockResolvedValue([]);
      const extension = fakeExt('suite', {
        id: 'suite-id',
        skillsDiscoveryHasErrors: true,
      });
      vi.spyOn(mockConfig, 'getActiveExtensions').mockReturnValue([extension]);
      await manager.refreshCache();
      expect(manager.hasDiscoveryErrors()).toBe(true);
      extension.skillsDiscoveryHasErrors = false;
      await manager.refreshCache();
      expect(manager.hasDiscoveryErrors()).toBe(false);
    });

    it.each(['EACCES', 'ENOENT'] as const)(
      'distinguishes an unreadable skill symlink from a removed target: %s',
      async (code) => {
        const projectDir = manager.getSkillsBaseDirs('project')[0];
        vi.mocked(fs.readdir).mockImplementation(async (directory) =>
          String(directory) === projectDir
            ? dirents(bareDirent('linked', true))
            : [],
        );
        vi.mocked(fs.realpath).mockRejectedValue(fsError(code, code));
        await manager.refreshCache();
        expect(manager.getCachedSkills()).toEqual([]);
        expect(manager.hasDiscoveryErrors()).toBe(code !== 'ENOENT');
      },
    );

    it('does not treat absent optional directories as discovery errors', async () => {
      vi.mocked(fs.readdir).mockRejectedValue(fsError('missing', 'ENOENT'));
      await manager.refreshCache();
      expect(manager.hasDiscoveryErrors()).toBe(false);
    });

    it('reports directory read errors until a successful refresh', async () => {
      vi.mocked(fs.readdir).mockRejectedValue(fsError('unreadable', 'EACCES'));
      await manager.refreshCache();
      expect(manager.hasDiscoveryErrors()).toBe(true);
      vi.mocked(fs.readdir).mockResolvedValue([]);
      await manager.refreshCache();
      expect(manager.hasDiscoveryErrors()).toBe(false);
    });

    it('reports a failed level even when other levels can be listed', async () => {
      vi.mocked(fs.readdir).mockResolvedValue([]);
      vi.spyOn(mockConfig, 'getActiveExtensions').mockImplementation(() => {
        throw new Error('Unavailable');
      });
      await manager.refreshCache();
      expect(manager.hasDiscoveryErrors()).toBe(true);
    });

    it.each(['EACCES', 'ENOENT'] as const)(
      'distinguishes unreadable skill files from confirmed removal: %s',
      async (code) => {
        mockReaddir(bareDirent('unreadable'));
        vi.mocked(fs.access).mockRejectedValue(fsError(code, code));
        await manager.refreshCache();
        expect(manager.getCachedSkills()).toEqual([]);
        expect(manager.hasDiscoveryErrors()).toBe(code !== 'ENOENT');
      },
    );
  });

  describe('conditional skill activation', () => {
    // One project skill whose `paths` glob matches `src/**/*.tsx`; once loaded,
    // matchAndActivateByPath() should activate it and fire listeners.
    async function loadConditionalFixture() {
      mockOneSkill('tsx-helper', fm(TSX_FM));
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

      // Same pattern touched again — skill already active, no new notification.
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
      // Regression for ultrareview bug_004: a SKILL.md with both `paths:` and
      // `disable-model-invocation: true` entered the activation registry and
      // fired a "now available" reminder on path match, then SkillTool refused
      // to invoke it because the disabled flag hides it everywhere else.
      mockOneSkill(
        'secret-helper',
        fm(
          'name: secret-helper\ndescription: Hidden helper\npaths:\n  - "src/**/*.ts"\ndisable-model-invocation: true',
        ),
      );
      await manager.refreshCache();

      const newly = await manager.matchAndActivateByPath(
        '/test/project/src/foo.ts',
      );
      expect(newly).toEqual([]);
      expect(manager.getActivatedSkillNames().size).toBe(0);
    });

    it('matchAndActivateByPaths fires listeners exactly once across multiple paths', async () => {
      // Regression for /review: a tool call with several candidate paths (e.g.
      // ripGrep `paths: [a, b, c]`) fired listeners per path, causing N
      // SkillTool.refreshSkills / llmClient.setTools() round-trips. The batch
      // API fires them once with the union of activations.
      await loadConditionalFixture();

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
      // Regression for ultrareview bug_001: same-name skills across levels with
      // different `paths:` globs. listSkills() dedupes by precedence (project
      // wins) and the activation registry must too, or the user copy's globs
      // activate the visible project skill for files outside its own paths.
      mockReaddirByDir({
        [PROJECT_QWEN_DIR]: [dirent('foo')],
        [USER_QWEN_DIR]: [dirent('foo')],
      });
      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockReadFileByPath({
        [PROJECT_QWEN_DIR]: fm(
          'name: foo\ndescription: A test skill\npaths:\n  - "src/**"',
          'Project body.',
        ),
        [USER_QWEN_DIR]: fm(
          'name: foo\ndescription: A test skill\npaths:\n  - "lib/**"',
          'User body.',
        ),
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
      mockOneSkill('bad-skill', 'invalid content without frontmatter');

      await manager.listSkills({ force: true });

      expect(manager.getParseErrors().size).toBeGreaterThan(0);
    });

    it('surfaces invalid `paths:` glob patterns through parseErrors', async () => {
      // Regression: bad globs were only logged at debug level, leaving the skill
      // permanently "gated by path-based activation" with no diagnostic. The
      // registry now reports into SkillManager.parseErrors, visible through
      // `getParseErrors()` (and the `/skills` UI). The 70 KB pattern exceeds
      // picomatch's 65,536-char cap, so it throws at compile time.
      const oversizedGlob = 'a'.repeat(70_000);
      mockOneSkill(
        'bad-glob-skill',
        fm(
          `name: bad-glob-skill\ndescription: Has an oversized glob\npaths:\n  - "${oversizedGlob}"`,
        ),
      );

      await manager.refreshCache();

      const entries = Array.from(manager.getParseErrors().entries());
      const oversizedEntry = entries.find(([key]) => key.includes('#paths['));
      expect(oversizedEntry).toBeDefined();
      expect(oversizedEntry![1].message).toMatch(/Invalid glob in "paths"/);
      expect(oversizedEntry![1].skillName).toBe('bad-glob-skill');
      expect(manager.getCachedSkills()?.map((skill) => skill.name)).toContain(
        'bad-glob-skill',
      );
      expect(manager.hasDiscoveryErrors()).toBe(false);
    });
  });

  describe('symlink support', () => {
    const mockStatIsDirectory = (isDirectory: boolean) =>
      vi.mocked(fs.stat).mockResolvedValue({
        isDirectory: () => isDirectory,
      } as Awaited<ReturnType<typeof fs.stat>>);

    it('should load skills from symlinked directories', async () => {
      mockOneSkill(
        'symlink-skill',
        skillFile(
          'symlink-skill',
          'A skill loaded from symlink',
          'Symlink skill content',
        ),
        'link',
      );
      // Out-of-tree symlink targets are the supported user workflow.
      vi.mocked(fs.realpath).mockResolvedValue(
        '/elsewhere/skills-repo/symlink-skill',
      );
      mockStatIsDirectory(true);

      const skills = await manager.listSkills({ force: true });

      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('symlink-skill');
      expect(skills[0].description).toBe('A skill loaded from symlink');
    });

    it('should skip symlinks that point to non-directory targets', async () => {
      mockReaddir(dirent('bad-symlink', 'link'));
      vi.mocked(fs.realpath).mockResolvedValue(
        '/elsewhere/skills-repo/some-file',
      );
      mockStatIsDirectory(false); // file stats, not a directory

      expect(await manager.listSkills({ force: true })).toHaveLength(0);
    });

    it('should skip broken/invalid symlinks', async () => {
      mockReaddir(dirent('broken-symlink', 'link'));
      // realpath on the dangling link throws ENOENT; skipped as `invalid`.
      vi.mocked(fs.realpath).mockRejectedValue(
        new Error('ENOENT: no such file or directory'),
      );

      expect(await manager.listSkills({ force: true })).toHaveLength(0);
    });

    it('should load skills from both regular directories and symlinks', async () => {
      mockReaddir(dirent('regular-skill'), dirent('symlink-skill', 'link'));
      vi.mocked(fs.realpath).mockImplementation((p) =>
        Promise.resolve(String(p)),
      );
      mockStatIsDirectory(true); // the symlink resolves to a directory
      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockReadFileByPath({
        'regular-skill': skillFile(
          'regular-skill',
          'A regular skill',
          'Regular skill content',
        ),
        'symlink-skill': skillFile(
          'symlink-skill',
          'A symlinked skill',
          'Symlinked skill content',
        ),
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
    it('detaches skill events without native close during macOS process exit', async () => {
      vi.resetModules();
      const { SkillManager: FreshSkillManager } = await import(
        './skill-manager.js'
      );
      const { prepareFileWatchersForProcessExit } = await import(
        '../utils/file-watcher-cleanup.js'
      );
      const platform = process.platform;
      vi.mocked(fsSync.existsSync).mockImplementation(
        (p) => String(p) === PROJECT_QWEN_DIR,
      );
      mockReaddir();
      const nativeWatcher = Object.assign(new EventEmitter(), {
        close: vi.fn().mockResolvedValue(undefined),
      });
      mockWatch.mockReturnValueOnce(nativeWatcher);
      const freshManager = new FreshSkillManager(mockConfig);
      try {
        await freshManager.startWatching();
        expect(nativeWatcher.listenerCount('all')).toBe(1);
        expect(nativeWatcher.listenerCount('error')).toBe(1);
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        prepareFileWatchersForProcessExit();

        freshManager.stopWatching();

        expect(nativeWatcher.close).not.toHaveBeenCalled();
        expect(nativeWatcher.listenerCount('all')).toBe(0);
        expect(nativeWatcher.listenerCount('error')).toBe(1);
      } finally {
        freshManager.stopWatching();
        Object.defineProperty(process, 'platform', { value: platform });
        vi.resetModules();
      }
    });

    it('should pass ignored function and shallow depth to chokidar', async () => {
      vi.mocked(fsSync.existsSync).mockImplementation(
        (p) => String(p) === PROJECT_QWEN_DIR,
      );
      mockReaddir();
      mockWatch.mockClear();
      mockWatcher.on.mockClear();

      await manager.startWatching();

      expect(mockWatch).toHaveBeenCalledWith(PROJECT_QWEN_DIR, {
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
      const stats = (isFile: boolean, isDirectory: boolean) =>
        ({
          isFile: () => isFile,
          isDirectory: () => isDirectory,
        }) as fsSync.Stats;

      expect(watcherIgnored('/skills/some.sock', stats(false, false))).toBe(
        true,
      );
      expect(watcherIgnored('/skills/SKILL.md', stats(true, false))).toBe(
        false,
      );
      expect(watcherIgnored('/skills/my-skill', stats(false, true))).toBe(
        false,
      );
    });
  });

  describe('hooks parsing', () => {
    /** `head` frontmatter lines, a `hooks:` block, then a compact body. */
    const parseHooks = (head: string, hooks: string) =>
      parse(
        `---\n${head}\nhooks:\n${hooks}\n---\nSkill content`,
        '/test/skill/SKILL.md',
        'user',
      );

    it('should parse hooks configuration from frontmatter', () => {
      const config = parseHooks(
        'name: hook-skill\ndescription: Skill with hooks',
        `  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: 'echo "checking"'
          timeout: 5`,
      );

      expect(config.hooks).toBeDefined();
      expect(config.hooks?.PreToolUse).toBeDefined();
      expect(config.hooks?.PreToolUse).toHaveLength(1);
      expect(config.hooks?.PreToolUse?.[0]?.matcher).toBe('Bash');
      expect(config.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
    });

    it('should parse multiple hooks for same event', () => {
      const config = parseHooks(
        'name: multi-hook-skill\ndescription: Skill with multiple hooks',
        `  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: 'echo "first"'
        - type: command
          command: 'echo "second"'
    - matcher: "Write"
      hooks:
        - type: http
          url: 'https://example.com/hook'`,
      );

      expect(config.hooks?.PreToolUse).toHaveLength(2);
      expect(config.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(2);
      expect(config.hooks?.PreToolUse?.[1]?.matcher).toBe('Write');
    });

    it('should parse HTTP hooks with headers', () => {
      const config = parseHooks(
        'name: http-hook-skill\ndescription: Skill with HTTP hooks',
        `  PostToolUse:
    - matcher: "*"
      hooks:
        - type: http
          url: 'https://audit.example.com/log'
          headers:
            Authorization: 'Bearer token'
          allowedEnvVars:
            - API_KEY
          timeout: 10`,
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
      const config = parseHooks(
        'name: unknown-event-skill\ndescription: Skill with unknown event',
        `  UnknownEvent:
    - matcher: "*"
      hooks:
        - type: command
          command: 'echo "test"'`,
      );

      // Unknown events are ignored; only valid HookEventNames are kept.
      expect(config.hooks).toBeDefined();
      expect(Object.keys(config.hooks || {})).not.toContain('UnknownEvent');
    });

    it('should set skillRoot from filePath', () => {
      const config = parseHooks(
        'name: skillroot-skill\ndescription: Skill with skillRoot',
        `  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: 'echo $QWEN_SKILL_ROOT'`,
      );

      // skillRoot should be set to the directory containing SKILL.md
      expect(config.skillRoot).toBe('/test/skill');
    });
  });

  describe('safe mode', () => {
    it('refreshCache only loads bundled skills', async () => {
      const safeManager = managerWith({ safeMode: true });

      // Project/user skill files that should be ignored
      mockReaddir('evil-skill.md');
      vi.mocked(fs.readFile).mockResolvedValue(
        skillFile('evil-skill', 'Injected', 'malicious instructions'),
      );

      await safeManager.refreshCache();

      const allSkills = await safeManager.listSkills();
      // Only bundled skills should be present; project/user/extension are skipped
      expect(allSkills.every((s) => s.level === 'bundled')).toBe(true);
      expect(allSkills.find((s) => s.name === 'evil-skill')).toBeUndefined();
    });
  });
});
