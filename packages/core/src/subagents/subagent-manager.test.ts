/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SubagentManager, loadSubagentFromDir } from './subagent-manager.js';
import {
  type SubagentConfig,
  SubagentError,
  SubagentErrorCode,
} from './types.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/approval-mode.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { AuthType } from '../core/contentGenerator.js';
import { ToolNames } from '../tools/tool-names.js';
import type { ExecutionEnvironment } from '../services/execution-environment.js';
import { Storage } from '../config/storage.js';
import { type AgentTool, TOOL_REGISTRY_REBUILT } from '../tools/agent/agent.js';
import { resolveAgentDelegationSurface } from '../skills/agent-delegation-skill.js';
import type { SkillManager } from '../skills/skill-manager.js';

vi.mock('fs/promises');
vi.mock('os');

const mockParseYaml = vi.hoisted(() => vi.fn());
const mockStringifyYaml = vi.hoisted(() => vi.fn());

vi.mock('../utils/yaml-parser.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/yaml-parser.js')>();
  return {
    parse: mockParseYaml,
    stringify: mockStringifyYaml,
    sanitizeValue: actual.sanitizeValue,
  };
});

const mockValidateConfig = vi.hoisted(() => vi.fn());
const mockValidateOrThrow = vi.hoisted(() => vi.fn());

vi.mock('./validation.js', () => ({
  SubagentValidator: class MockSubagentValidator {
    validateConfig = mockValidateConfig;
    validateOrThrow = mockValidateOrThrow;
  },
}));

vi.mock('./subagent.js');

const mockAgentHeadlessCreate = vi.hoisted(() => vi.fn());
vi.mock('../agents/runtime/agent-headless.js', () => ({
  AgentHeadless: { create: mockAgentHeadlessCreate },
  ContextState: class {},
}));

// Names the positional AgentHeadless.create parameters the tests read, so a
// new parameter cannot silently shift assertions onto the wrong slot.
// Defaults to the first call.
function destructureAgentHeadlessCall(
  call: unknown[] = mockAgentHeadlessCreate.mock.calls[0],
) {
  return {
    runtimeContext: call[1],
    toolConfig: call[5],
    runtimeView: call[8] as
      | {
          contentGenerator: unknown;
          contentGeneratorConfig: { authType?: string; model?: string };
        }
      | undefined,
  };
}

const mockCreateContentGenerator = vi.hoisted(() => vi.fn());
vi.mock('../core/contentGenerator.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../core/contentGenerator.js')>();
  return {
    ...original,
    createContentGenerator: mockCreateContentGenerator,
  };
});

// Drives the real shared YAML parser (its sanitizing and lenient parseSimple
// fallback) instead of the content-sniffing stub installed in beforeEach.
const realYaml = () =>
  vi.importActual<typeof import('../utils/yaml-parser.js')>(
    '../utils/yaml-parser.js',
  );
async function useRealYamlParse() {
  mockParseYaml.mockImplementation((await realYaml()).parse);
}

const echoHooks = (matcher = 'Bash') => ({
  PreToolUse: [{ matcher, hooks: [{ type: 'command', command: 'echo' }] }],
});

describe('SubagentManager', () => {
  let manager: SubagentManager;
  let mockToolRegistry: ToolRegistry;
  let mockConfig: Config;

  beforeEach(() => {
    // os.homedir must be mocked before makeFakeConfig: the Config
    // constructor calls Storage.getGlobalQwenDir(), which needs it.
    vi.mocked(os.homedir).mockReturnValue('/home/user');
    vi.mocked(os.tmpdir).mockReturnValue('/tmp');

    mockToolRegistry = {
      warmAll: vi.fn().mockResolvedValue(undefined),
      getAllTools: vi.fn().mockReturnValue([
        { name: 'read_file', displayName: 'Read File' },
        { name: 'write_file', displayName: 'Write File' },
        { name: 'grep', displayName: 'Search Files' },
      ]),
      // `resolveBundledReferenceRoute` reads tool presence through
      // `getAllToolNames()` (it counts lazy factories) and bails out to
      // 'skill' when the answer is not an array — so without this stub every
      // surface assertion below resolves to 'pointer' for that reason alone,
      // whatever the case stubbed. The list carries both bridge halves so a
      // permission-deferred Skill tool can reach 'skill-via-tool-search'.
      getAllToolNames: vi
        .fn()
        .mockReturnValue([
          ToolNames.READ_FILE,
          ToolNames.WRITE_FILE,
          ToolNames.GREP,
          ToolNames.SKILL,
          ToolNames.TOOL_SEARCH,
          ToolNames.TOOL_CALL,
        ]),
      // `isToolDeferredBehindToolSearch` asks the REGISTRY, not the
      // PermissionManager, so the deferred cases have to stub both halves of
      // their own verdict. Default false: nothing is eager-hidden unless a
      // case says so.
      isPermissionDeferred: vi.fn().mockReturnValue(false),
      // `buildSubagentContextOverride` now rebuilds the tool registry on
      // its override and copies discovered tools from this parent
      // registry. Mirror both discovered-tool maps read by that copy.
      tools: new Map(),
      mcpAppTools: new Map(),
    } as unknown as ToolRegistry;

    mockConfig = makeFakeConfig({});
    vi.spyOn(mockConfig, 'getToolRegistry').mockReturnValue(mockToolRegistry);
    vi.spyOn(mockConfig, 'getProjectRoot').mockReturnValue('/test/project');

    vi.clearAllMocks();
    mockValidateConfig.mockReturnValue({
      isValid: true,
      errors: [],
      warnings: [],
    });
    mockValidateOrThrow.mockImplementation(() => {});

    // Content-sniffing YAML stub. disallowedTools is checked before tools to
    // avoid the substring match; an inline value wins over the list default.
    mockParseYaml.mockImplementation((yamlString: string) => {
      const base = { name: 'test-agent', description: 'A test subagent' };
      const listOrInline = (key: string, list: string[]) => {
        const inline = new RegExp(`^${key}:(.*)$`, 'm').exec(yamlString)?.[1];
        return { ...base, [key]: inline?.trim() || list };
      };
      if (yamlString.includes('disallowedTools:'))
        return listOrInline('disallowedTools', ['write_file', 'mcp__slack']);
      if (yamlString.includes('tools:'))
        return listOrInline('tools', ['read_file', 'write_file']);
      if (yamlString.includes('model:'))
        return { ...base, model: 'custom-model' };
      if (yamlString.includes('runConfig:'))
        return { ...base, runConfig: { max_time_minutes: 5, max_turns: 10 } };
      if (
        yamlString.includes('background:') ||
        yamlString.includes('approvalMode:')
      ) {
        const bgMatch = yamlString.match(/background:\s*"?(true|false)"?/);
        const approvalMatch = yamlString.match(/approvalMode:\s*"?([\w-]+)"?/);
        const result: Record<string, unknown> = {
          name: yamlString.match(/name:\s*(\S+)/)?.[1] ?? 'test-agent',
          description:
            yamlString.match(/description:\s*(.+)/)?.[1] ?? 'A test subagent',
        };
        if (bgMatch) result['background'] = bgMatch[1] === 'true';
        if (approvalMatch) result['approvalMode'] = approvalMatch[1];
        return result;
      }
      for (const [needle, result] of [
        ['name: agent1', { name: 'agent1', description: 'First agent' }],
        ['name: agent2', { name: 'agent2', description: 'Second agent' }],
        ['name: agent3', { name: 'agent3', description: 'Third agent' }],
        ['name: 11', { name: 11, description: 333 }], // numeric values
        ['name: true', { name: true, description: false }], // boolean values
      ] as const) {
        if (yamlString.includes(needle)) return { ...result };
      }
      if (!yamlString.includes('name:')) {
        return { description: 'A test subagent' }; // Missing name case
      }
      if (!yamlString.includes('description:')) {
        return { name: 'test-agent' }; // Missing description case
      }
      return base;
    });

    mockStringifyYaml.mockImplementation((obj: Record<string, unknown>) => {
      let yaml = '';
      for (const [key, value] of Object.entries(obj)) {
        if (
          (key === 'tools' || key === 'disallowedTools') &&
          Array.isArray(value)
        ) {
          yaml += `${key}:\n${value.map((t) => `  - ${t}`).join('\n')}\n`;
        } else if (key === 'runConfig' && typeof value === 'object' && value) {
          yaml += `runConfig:\n`;
          for (const [k, v] of Object.entries(value)) yaml += `  ${k}: ${v}\n`;
        } else {
          yaml += `${key}: ${value}\n`;
        }
      }
      return yaml.trim();
    });

    manager = new SubagentManager(mockConfig);
  });

  describe('resolveModelGrade', () => {
    const builtinConfig: SubagentConfig = {
      name: 'Explore',
      description: 'Explore files',
      systemPrompt: 'Explore.',
      level: 'builtin',
      isBuiltin: true,
      model: 'fast',
    };
    const gradeManager = (
      agents: NonNullable<Parameters<typeof makeFakeConfig>[0]>['agents'],
    ) => new SubagentManager(makeFakeConfig({ agents }));

    it('resolves only available grades and preserves custom defaults', () => {
      const mgr = gradeManager({
        modelGrades: { small: 'fast', high: 'qwen-max' },
        allowedGrades: ['high'],
      });
      // With `model`, resolves for a custom project agent declaring it.
      const resolve = (grade: string, model?: string) =>
        mgr.resolveModelGrade(
          grade,
          model
            ? { ...builtinConfig, level: 'project', isBuiltin: false, model }
            : builtinConfig,
        );

      expect(mgr.getAvailableModelGrades()).toEqual(
        new Map([['high', 'qwen-max']]),
      );
      expect(resolve('high')).toBe('qwen-max');
      expect(resolve('small')).toBeUndefined();
      expect(resolve('missing')).toBeUndefined();
      expect(resolve('high', 'custom-model')).toBeUndefined();
      expect(resolve('high', 'inherit')).toBe('qwen-max');
    });

    it('exposes every valid grade without an allowlist', () => {
      expect(
        gradeManager({
          modelGrades: { small: 'fast', high: 'qwen-max' },
        }).getAvailableModelGrades(),
      ).toEqual(
        new Map([
          ['small', 'fast'],
          ['high', 'qwen-max'],
        ]),
      );
    });

    it('trims grade keys before publishing and resolving', () => {
      const mgr = gradeManager({
        modelGrades: { ' small ': 'fast', high: 'qwen-max' },
        allowedGrades: [' small ', 'high'],
      });

      const grades = mgr.getAvailableModelGrades();
      expect([...grades.keys()]).toEqual(['small', 'high']);
      expect(grades.get('small')).toBe('fast');
      expect(mgr.resolveModelGrade('small', builtinConfig)).toBe('fast');
    });

    it('ignores malformed grade settings', () => {
      const mgr = gradeManager({
        modelGrades: {
          valid: 'qwen-max',
          invalid: 42 as unknown as string,
          blank: '  ',
          '  ': 'qwen-max',
        },
        allowedGrades: ['valid', 'invalid', 'blank', '  '],
      });

      expect(mgr.getAvailableModelGrades()).toEqual(
        new Map([['valid', 'qwen-max']]),
      );
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const validConfig: SubagentConfig = {
    name: 'test-agent',
    description: 'A test subagent',
    systemPrompt: 'You are a helpful assistant.',
    level: 'project',
    filePath: '/test/project/.qwen/agents/test-agent.md',
  };

  // `---\n<fm>\n---\n\n<body>\n`, the shape of the hand-written agent files.
  const md = (fm: string, body = 'You are a helpful assistant.') =>
    `---\n${fm}\n---\n\n${body}\n`;
  const TEST_FM = 'name: test-agent\ndescription: A test subagent';
  const validMarkdown = md(TEST_FM);

  const projectAgentsDir = () =>
    path.join(mockConfig.getProjectRoot(), '.qwen', 'agents');
  // Stubs the agents-directory listing and, when given, every file's content.
  function mockAgentFiles(files: string[], content?: string) {
    vi.mocked(fs.readdir).mockResolvedValue(files as never);
    if (content !== undefined)
      vi.mocked(fs.readFile).mockResolvedValue(content);
  }
  const noAgentDirs = () =>
    vi.mocked(fs.readdir).mockRejectedValue(new Error('Directory not found'));
  // The project agents dir is unreadable; the user dir holds test-agent.md.
  const mockUserLevelOnly = () => {
    vi.mocked(fs.readdir)
      .mockRejectedValueOnce(new Error('Project dir not found'))
      .mockResolvedValueOnce(['test-agent.md'] as never);
    vi.mocked(fs.readFile).mockResolvedValue(validMarkdown);
  };
  const parse = (
    content: string,
    filePath = validConfig.filePath!,
    level: 'project' | 'user' = 'project',
  ) => manager.parseSubagentContent(content, filePath, level);
  const ser = (extra: Partial<SubagentConfig> = {}) =>
    manager.serializeSubagent({ ...validConfig, ...extra });
  const expectNotCalled = (...mocks: unknown[]) => {
    for (const mock of mocks) expect(mock).not.toHaveBeenCalled();
  };
  async function expectSubagentError(
    call: () => Promise<unknown>,
    message: RegExp,
  ) {
    await expect(call()).rejects.toThrow(SubagentError);
    await expect(call()).rejects.toThrow(message);
  }

  describe('execution backend definitions', () => {
    beforeEach(async () => {
      const yaml = await realYaml();
      mockParseYaml.mockImplementation(yaml.parse);
      mockStringifyYaml.mockImplementation(yaml.stringify);
    });

    const expectExploreBackendRefused = () =>
      expect(manager.loadSubagent('Explore')).rejects.toThrow(
        'invalid executionBackend declaration',
      );
    const backendRefusal = (subagentName: string) => ({
      subagentName,
      message: expect.stringContaining('invalid executionBackend declaration'),
    });
    // Loads the project agents dir directly: nothing loads, refusals recorded.
    const loadProjectRefusals = async () => {
      const refusals = new Map<string, SubagentError>();
      expect(await loadSubagentFromDir(projectAgentsDir(), refusals)).toEqual(
        [],
      );
      return refusals;
    };
    // Lists `files` (all holding `content`) in the project agents dir only.
    const mockProjectDirOnly = (files: string[], content: string) => {
      const projectDir = projectAgentsDir();
      vi.mocked(fs.readdir).mockImplementation(
        async (directory) => (directory === projectDir ? files : []) as never,
      );
      vi.mocked(fs.readFile).mockResolvedValue(content);
    };

    it.each(
      [
        'executionBackend: container',
        'executor: {kind: invalid, command: runner}',
      ].flatMap((declaration) =>
        [
          ['Reviewer', 'Explore'],
          ['Reviewer', "'Explore'", 'Last'],
          ['First', "'Explore'", '"Plan"', 'Last'],
        ].map((names) => ({ declaration, names })),
      ),
    )(
      'reserves every duplicate name on refusal: $declaration $names',
      async ({ declaration, names }) => {
        const declaredNames = names.map((name) =>
          name.replace(/^["']|["']$/g, ''),
        );
        const content = `---\n${names.map((name) => `name: ${name}`).join('\n')}\ndescription: Project agent\n${declaration}\n---\nReview the project.\n`;
        mockProjectDirOnly(['reviewer.md'], content);
        for (const name of declaredNames) {
          await expect(manager.loadSubagent(name)).rejects.toMatchObject({
            message: expect.stringMatching(
              /invalid (executionBackend declaration|executor block)/,
            ),
          });
        }
        const refusals = await loadProjectRefusals();
        expect([...refusals.keys()].sort()).toEqual(
          declaredNames.map((name) => name.toLowerCase()).sort(),
        );

        vi.mocked(fs.readFile).mockResolvedValue(
          content.replace(`${declaration}\n`, ''),
        );
        const local = await manager.loadSubagent(declaredNames.at(-1)!);
        expect(local).toMatchObject({
          name: declaredNames.at(-1),
          level: 'project',
        });
        expect(local?.executionBackend).toBeUndefined();
      },
    );

    it.each(
      ['|', '>'].flatMap((style) =>
        [
          'executor:\n\tcommand: acp-reviewer',
          'executionBackend: container\nmetadata:\n\tcommand: example',
        ].map((declaration) => ({ style, declaration })),
      ),
    )(
      'does not reserve names from $style prose on refusal: $declaration',
      async ({ style, declaration }) => {
        mockProjectDirOnly(
          ['reviewer.md'],
          `---\nname: reviewer\ndescription: ${style}\n  This agent documents other agents.\n  name: explore\n${declaration}\n---\nReview the project carefully.\n`,
        );

        const refusals = await loadProjectRefusals();
        expect.soft([...refusals.keys()]).toEqual(['reviewer']);
        await expect(manager.loadSubagent('Explore')).resolves.toMatchObject({
          name: 'Explore',
          isBuiltin: true,
        });
        await expect(manager.loadSubagent('reviewer')).rejects.toMatchObject({
          subagentName: 'reviewer',
        });
      },
    );

    it('retains the lenient refusal name when the AST name cannot resolve', async () => {
      mockAgentFiles(
        ['reviewer.md'],
        '---\nname: *missing\ndescription: Project agent\nexecutor: {kind: invalid, command: runner}\n---\nReview the project.\n',
      );

      const refusals = await loadProjectRefusals();
      expect([...refusals.keys()]).toEqual(['*missing']);
      expect(refusals.get('*missing')?.subagentName).toBe('*missing');
    });

    it.each([
      { yamlName: '123', name: '123' },
      { yamlName: 'true', name: 'true' },
      { yamlName: '[Explore]', name: 'Explore' },
      { yamlName: '[true]', name: 'true' },
      { yamlName: '[Explore, null]', name: 'Explore' },
      { yamlName: '*agentName', name: 'Explore' },
      { yamlName: '*agentName', name: 'Explore', anchor: '[Explore, null]' },
    ])(
      'uses the accepted name for refusals and valid controls: $yamlName',
      async ({ yamlName, name, anchor }) => {
        const { SubagentValidator } =
          await vi.importActual<typeof import('./validation.js')>(
            './validation.js',
          );
        const validator = new SubagentValidator();
        mockValidateConfig.mockImplementation((config: SubagentConfig) =>
          validator.validateConfig(config),
        );
        const projectDir = projectAgentsDir();
        const userDir = path.join(Storage.getGlobalQwenDir(), 'agents');
        const frontmatter = `alias: &agentName ${anchor ?? 'Explore'}\nname: ${yamlName}`;
        const described = `${frontmatter}\ndescription: Project agent`;
        let projectFm = `${described}\nexecutionBackend: null`;
        const listings: Record<string, string[]> = {
          [projectDir]: [`${name}.md`],
          [userDir]: ['lower-priority.md'],
        };
        vi.mocked(fs.readdir).mockImplementation(
          async (directory) => (listings[String(directory)] ?? []) as never,
        );
        vi.mocked(fs.readFile).mockImplementation(async (file) => {
          if (file === path.join(projectDir, `${name}.md`))
            return `---\n${projectFm}\n---\nComplete the project task.\n`;
          if (file === path.join(userDir, 'lower-priority.md'))
            return `---\nname: '${name}'\ndescription: User agent\n---\nComplete the user task.\n`;
          throw new Error(`Unexpected file read: ${String(file)}`);
        });
        const userDef = {
          name,
          level: 'user',
          systemPrompt: 'Complete the user task.',
        };

        expect(await manager.loadSubagent(name, 'user')).toMatchObject(userDef);
        // A null backend, an unresolved alias and a missing description.
        for (const refused of [
          projectFm,
          `${described}\nexecutionBackend: *missing`,
          `${frontmatter}\nexecutionBackend: container`,
        ]) {
          projectFm = refused;
          await expect(manager.loadSubagent(name)).rejects.toMatchObject(
            backendRefusal(name),
          );
        }

        projectFm = `${described}\nexecutionBackend: container`;
        expect(await manager.loadSubagent(name)).toMatchObject({
          name,
          level: 'project',
          executionBackend: 'container',
          systemPrompt: 'Complete the project task.',
        });

        projectFm =
          'name: {invalid: name}\ndescription: Project agent\nexecutionBackend: null';
        expect(await manager.loadSubagent(name)).toMatchObject(userDef);
      },
    );

    it.each([
      'name: Explore\ndescription: Test\nexecutionBackend: null',
      'name: Explore\ndescription: Test\nexecutionBackend: local',
      "name: 'Explore'\ndescription: Test\nexecutionBackend: false",
      'name: Explore\ndescription: Test\nexecutionBackend: container\nexecutionBackend: local',
      'name: Explore\ndescription: bad: yaml\nexecutionBackend: container',
      'name: Explore\ndescription: Test\n\texecutionBackend: container',
      'name: Explore\nexecutionBackend: container',
    ])(
      'reserves an invalid higher-priority declaration instead of resolving a builtin: %s',
      async (frontmatter) => {
        mockAgentFiles(
          ['different-filename.md'],
          `---\n${frontmatter}\n---\nComplete the task.`,
        );
        await expect(manager.loadSubagent('explore')).rejects.toMatchObject(
          backendRefusal('Explore'),
        );
        expect(await manager.isNameAvailable('Explore')).toBe(false);
        expect(mockAgentHeadlessCreate).not.toHaveBeenCalled();
      },
    );

    it('records later validation failure and clears a stale backend refusal after removal', async () => {
      mockAgentFiles(
        ['explore.md'],
        '---\nname: Explore\ndescription: Test\nexecutionBackend: container\n---\nPrompt',
      );
      mockValidateConfig.mockReturnValue({
        isValid: false,
        errors: ['Invalid prompt'],
        warnings: [],
      });
      await expectExploreBackendRefused();
      vi.mocked(fs.readdir).mockRejectedValue(new Error('ENOENT'));
      expect((await manager.loadSubagent('Explore'))?.isBuiltin).toBe(true);
    });

    it('carries an actual extension-loader backend refusal through named resolution', async () => {
      mockAgentFiles(
        ['agent.md'],
        '---\nname: Explore\ndescription: Test\nexecutionBackend: null\n---\nPrompt',
      );
      const refusals = new Map<string, SubagentError>();
      const agents = await loadSubagentFromDir('/extension/agents', refusals);
      expect(agents).toEqual([]);
      expect(refusals.has('explore')).toBe(true);
      vi.spyOn(mockConfig, 'getActiveExtensions').mockReturnValue([
        { agents, agentExecutorRefusals: refusals } as never,
      ]);
      mockAgentFiles([]);
      await expectExploreBackendRefused();
    });

    it('round-trips a backend through serialization and unrelated updates', async () => {
      const original = parse(
        '---\nname: test-agent\ndescription: Test\nexecutionBackend: container\n---\nComplete the task.',
      );
      expect(original.executionBackend).toBe('container');
      const serialized = manager.serializeSubagent(original);
      expect(serialized).toContain('executionBackend: container');
      mockAgentFiles(['test-agent.md'], serialized);
      await manager.updateSubagent('test-agent', { description: 'Updated' });
      const saved = vi.mocked(fs.writeFile).mock.calls[0][1];
      expect(typeof saved).toBe('string');
      expect(parse(saved as string)).toMatchObject({
        description: 'Updated',
        executionBackend: 'container',
      });
    });

    it.each([null, 'local', false])(
      'rejects invalid direct serialization %j before writing',
      (executionBackend) => {
        expect(() =>
          ser({ executionBackend } as unknown as SubagentConfig),
        ).toThrow('invalid executionBackend declaration');
        expect(fs.writeFile).not.toHaveBeenCalled();
      },
    );

    it('retains invalid session objects so named dispatch refuses rather than falling through', async () => {
      manager.loadSessionSubagents([
        {
          ...validConfig,
          name: 'Explore',
          executionBackend: null,
        } as unknown as SubagentConfig,
      ]);
      await expectExploreBackendRefused();
      expect(mockAgentHeadlessCreate).not.toHaveBeenCalled();
    });

    it.each(['definition', 'operator'] as const)(
      'refuses %s-required execution without an environment at both consumption points',
      async (source) => {
        vi.spyOn(mockConfig, 'isTrustedFolder').mockReturnValue(true);
        vi.spyOn(mockConfig, 'getAgentExecutionBackend').mockReturnValue(
          source === 'operator' ? 'container' : undefined,
        );
        const config =
          source === 'definition'
            ? { ...validConfig, executionBackend: 'container' as const }
            : validConfig;
        await expect(
          manager.createAgentHeadless(config, mockConfig),
        ).rejects.toThrow('requires a container execution environment');
        await expect(manager.convertToRuntimeConfig(config)).rejects.toThrow(
          'requires a container execution environment',
        );
        expect(mockAgentHeadlessCreate).not.toHaveBeenCalled();
      },
    );

    it('permits definition conversion with an actual environment while retaining the operator floor', async () => {
      vi.spyOn(mockConfig, 'isTrustedFolder').mockReturnValue(true);
      vi.spyOn(mockConfig, 'getAgentExecutionBackend').mockReturnValue(
        'container',
      );
      vi.spyOn(mockConfig, 'getExecutionEnvironment').mockReturnValue(
        {} as ExecutionEnvironment,
      );
      await expect(
        manager.convertToRuntimeConfig({
          ...validConfig,
          executionBackend: 'container',
        }),
      ).resolves.toMatchObject({
        promptConfig: { systemPrompt: validConfig.systemPrompt },
      });
      expect(mockConfig.getAgentExecutionBackend()).toBe('container');
    });
  });

  describe('parseSubagentContent', () => {
    const parseFile = (content: string) => {
      vi.mocked(fs.readFile).mockResolvedValue(content);
      return manager.parseSubagentFile(validConfig.filePath!, 'project');
    };
    async function expectRefused(
      content: string,
      message = /invalid executor block/,
    ) {
      await expect(parseFile(content)).rejects.toThrow(message);
      expect(mockAgentHeadlessCreate).not.toHaveBeenCalled();
    }

    it.each([
      'null',
      'false',
      '0',
      '""',
      '{ kind: ACP, command: npx }',
      '{ kind: acp, command: " " }',
      '{ kind: acp, command: npx, args: [null] }',
    ])('rejects invalid executor frontmatter %s', (executor) =>
      expectRefused(
        `---\nname: test-agent\ndescription: Test\nexecutor: ${executor}\n---\nPrompt`,
      ),
    );

    it('rejects an executor whose null argument the shared parser would sanitize away', async () => {
      // Pins the guard that validates the ORIGINAL YAML node (parseDocument):
      // the shared parser strips null items, turning `args: [null]` into `args:
      // []`, which parseAgentExecutor ACCEPTS, launching with truncated
      // arguments. The real parser does the stripping here; validating the
      // sanitized value turns this red.
      mockParseYaml.mockImplementationOnce((await realYaml()).parse);
      await expectRefused(
        '---\nname: test-agent\ndescription: Test\nexecutor:\n  kind: acp\n  command: npx\n  args:\n    - null\n---\nPrompt',
      );
    });

    it.each<[string, string, RegExp?]>([
      // parseDocument repairs invalid YAML instead of throwing; document.errors
      // is the only signal. Without this guard an unterminated quote yields a
      // repaired executor node that dispatches a command the file never declared.
      [
        'rejects a definition whose frontmatter has a YAML syntax error rather than trusting a repaired executor node',
        "---\nname: test-agent\ndescription: Test\nexecutor:\n  kind: acp\n  command: 'npx\n---\nPrompt",
        /invalid YAML frontmatter|invalid executor block/,
      ],
      // A quoted `"executor":` plus a tolerated YAML error (unquoted colon in
      // description) is missed by parseSimple (keeps the quotes in the key) and
      // by a repaired parseDocument (nests it). Only the column-0 raw-text probe
      // catches it; otherwise the file silently runs in-process, the exact
      // substitution this PR exists to prevent.
      [
        'refuses a quoted top-level "executor" key when the frontmatter YAML is malformed (R7-1 under-refusal leg)',
        '---\nname: worker\ndescription: Reviews code: fast\n"executor":\n  kind: acp\n  command: npx\n---\nPrompt',
      ],
      // R10-1 made the claim probe indentation-tolerant so a TAB- or
      // space-indented top-level `executor:` the AST dropped cannot slip into a
      // silent in-process run. Accepted cost: a nested `executor:` in a file
      // that ALSO has a YAML error is refused, a visible, fixable over-refusal
      // that beats an invisible substitution. Column-0 anchoring turns this
      // red; with NO YAML error it still loads (the guard needs errors.length >
      // 0).
      [
        'refuses a malformed file whose only "executor" token is nested, fail-closed (R10-1 re-scopes the R7-1 over-refusal leg)',
        '---\nname: reviewer\ndescription: Reviews code: fast\nmetadata:\n  executor: legacy-note\n---\nPrompt',
      ],
      // An error on an EARLIER line (unquoted colon in description) makes
      // parseDocument drop the rest, so the executor node is ABSENT: YAML
      // errors are not line-local. Line-based parseSimple rebuilds `command: |`
      // plus indented `npx` as `{command:'|', npx:''}`, spawning an executable
      // literally named `|`. The refusal must key on parseDocument losing the
      // node (!hasExecutor); adding `&& frontmatter.executor === undefined`
      // turns this red while the duplicate-key load test stays green.
      [
        'refuses an executor whose node parseDocument dropped via an earlier error, not trusting the parseSimple fallback (R9-2)',
        '---\nname: explore\ndescription: Reviews code: fast\nexecutor:\n  kind: acp\n  command: |\n    npx\n---\nPrompt',
      ],
      // parseDocument tolerates an unresolved alias (`command: *undef`) with an
      // EMPTY document.errors, so the errors-based guard cannot catch it, but
      // document.toJS() throws resolving it. The try/catch around toJS() turns
      // that into an invalid-executor refusal; without it the raw "Unresolved
      // alias" error escapes and this goes red.
      [
        'refuses an executor whose frontmatter has an unresolved YAML alias instead of throwing a raw parse error (R9 deferred :1968)',
        '---\nname: explore\ndescription: Test\nexecutor:\n  kind: acp\n  command: *undefined_anchor\n---\nPrompt',
      ],
    ])('%s', async (_title, content, message) => {
      await useRealYamlParse();
      await expectRefused(content, message);
    });

    it('still loads a non-executor definition whose frontmatter strict YAML rejects', async () => {
      // R5-1: the document.errors refusal is scoped to executor-bearing files.
      // A colon in description makes strict YAML reject, but parseSimple still
      // loads it; with no executor it must load as at the merge base, or the
      // agent vanishes from /agents (subagent_type: agent-not-found). An
      // unconditional document.errors guard turns this red.
      await useRealYamlParse();
      const config = await parseFile(
        '---\nname: reviewer\ndescription: Reviews code: fast and careful\n---\nPrompt',
      );
      expect(config.name).toBe('reviewer');
      expect(config.description).toBe('Reviews code: fast and careful');
      expect(config.executor).toBeUndefined();
    });

    it('loads a valid executor whose frontmatter has an unrelated tolerated YAML error before it (R7-1 over-refusal, narrowed)', async () => {
      // A duplicate `name:` key (bad merge) is a tolerated error BEFORE the
      // executor line, so `document.toJS().executor` stays byte-faithful. The
      // old `claimsExecutor && document.errors.length > 0` guard deleted this
      // valid external agent from /agents (breaking `subagent_type:`) over a
      // quirk that loads at the merge base. Removing the line-scoping turns
      // this red; refusals for errors at/after the executor line stay green.
      await useRealYamlParse();
      const config = await parseFile(
        '---\nname: a\nname: b\ndescription: Test\nexecutor:\n  kind: acp\n  command: claude-agent-acp\n---\nPrompt',
      );
      expect(config.executor).toEqual({
        kind: 'acp',
        command: 'claude-agent-acp',
      });
    });

    it('loads a block-scalar prose "executor:" as no executor, not a hoisted command (R10-1)', async () => {
      // `description: |` prose with an `executor:` line, plus an unresolved
      // alias so parseSimple runs and hoists the prose into {kind:acp,
      // command:npx}; the old code dispatched that `npx`, a command that exists
      // only as prose. parseDocument sees no top-level executor and no error,
      // so it loads with no executor. Restoring the parseSimple fallback for
      // executorRaw turns this red.
      await useRealYamlParse();
      const config = await parseFile(
        '---\nname: x\ndescription: |\n  executor:\n    kind: acp\n    command: npx\nother: *undefined_anchor\n---\nPrompt',
      );
      expect(config.executor).toBeUndefined();
    });

    it('visibly reports invalid executors while continuing discovery', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockAgentFiles(['bad.md', 'good.md']);
      vi.mocked(fs.readFile).mockImplementation(async (file) =>
        String(file).endsWith('bad.md')
          ? '---\nname: bad\ndescription: Test\nexecutor: { kind: acp, command: " " }\n---\nPrompt'
          : validMarkdown,
      );
      const agents = await manager.listSubagents({
        level: 'project',
        force: true,
      });
      expect(agents.map((agent) => agent.name)).toEqual(['test-agent']);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('invalid executor block'),
      );
    });

    it('should parse valid markdown content', () => {
      const config = parse(validMarkdown);

      expect(config.name).toBe('test-agent');
      expect(config.description).toBe('A test subagent');
      expect(config.systemPrompt).toBe('You are a helpful assistant.');
      expect(config.level).toBe('project');
      expect(config.filePath).toBe(validConfig.filePath);
    });

    it('should parse valid markdown content with CRLF line endings', () => {
      const config = parse(
        `---\r\nname: test-agent\r\ndescription: A test subagent\r\n---\r\n\r\nYou are a helpful assistant.\r\n`,
      );

      expect(config.name).toBe('test-agent');
      expect(config.description).toBe('A test subagent');
      // .trim() removes the trailing \r regardless; the point is that
      // frontmatterRegex does not throw on CRLF.
      expect(config.systemPrompt).toBe('You are a helpful assistant.');
    });

    it.each([
      [
        'should parse content with tools',
        'tools:\n  - read_file\n  - write_file',
        ['read_file', 'write_file'],
      ],
      [
        'should parse comma-separated tools string into array',
        'tools: Read, Bash, Grep, Glob, WebSearch, WebFetch, mcp__context7__*',
        'Read Bash Grep Glob WebSearch WebFetch mcp__context7__*'.split(' '),
      ],
      ['should parse single tool string into array', 'tools: Read', ['Read']],
      [
        'should parse content with disallowedTools array',
        'disallowedTools:\n  - write_file\n  - mcp__slack',
        ['write_file', 'mcp__slack'],
      ],
      [
        'should normalize scalar disallowedTools to array',
        'disallowedTools: write_file',
        ['write_file'],
      ],
      [
        'should parse comma-separated disallowedTools string into array',
        'disallowedTools: write_file, mcp__slack, Bash',
        ['write_file', 'mcp__slack', 'Bash'],
      ],
      [
        'should parse content with model selector',
        'model: custom-model',
        'custom-model',
      ],
      [
        'should parse content with run config',
        'runConfig:\n  max_time_minutes: 5\n  max_turns: 10',
        { max_time_minutes: 5, max_turns: 10 },
      ],
    ])('%s', (_title, extra, expected) => {
      const key = extra.slice(0, extra.indexOf(':')) as keyof SubagentConfig;
      expect(parse(md(`${TEST_FM}\n${extra}`))[key]).toEqual(expected);
    });

    it('should parse legacy modelConfig frontmatter for compatibility', () => {
      mockParseYaml.mockReturnValueOnce({
        name: 'test-agent',
        description: 'A test subagent',
        modelConfig: { model: 'legacy-model' },
      });

      expect(
        parse(md(`${TEST_FM}\nmodelConfig:\n  model: legacy-model`)).model,
      ).toBe('legacy-model');
    });

    it.each([
      ['should handle numeric name and description values', '11', '333'],
      ['should handle boolean name and description values', 'true', 'false'],
    ])('%s', (_title, name, description) => {
      const config = parse(md(`name: ${name}\ndescription: ${description}`));

      expect(config.name).toBe(name);
      expect(config.description).toBe(description);
      expect(typeof config.name).toBe('string');
      expect(typeof config.description).toBe('string');
    });

    it('should determine level from file path', () => {
      for (const [filePath, level] of [
        ['/test/project/.qwen/agents/test-agent.md', 'project'],
        ['/home/user/.qwen/agents/test-agent.md', 'user'],
      ] as const) {
        expect(parse(validMarkdown, filePath, level).level).toBe(level);
      }
    });

    it.each([
      [
        'should throw error for invalid frontmatter format',
        'No frontmatter here\nJust content',
      ],
      [
        'should throw error for missing name',
        md('description: A test subagent'),
      ],
      ['should throw error for missing description', md('name: test-agent')],
    ])('%s', (_title, content) => {
      expect(() => parse(content)).toThrow(SubagentError);
    });

    it('should not warn when filename matches subagent name', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // validConfig.filePath is test-agent.md, matching the name.
      const config = parse(validMarkdown);

      expect(config.name).toBe('test-agent');
      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it.each([
      [
        'should parse background: true from frontmatter',
        'A background monitor\nbackground: true',
        'You are a monitor.',
        true,
      ],
      [
        'should parse background: "true" string from frontmatter',
        'A background monitor\nbackground: "true"',
        'You are a monitor.',
        true,
      ],
      [
        'preserves background: false for foreground agents',
        'A foreground agent\nbackground: false',
        'You are an agent.',
        false,
      ],
    ])('%s', (_title, rest, body, expected) => {
      expect(
        parse(md(`name: monitor\ndescription: ${rest}`, body)).background,
      ).toBe(expected);
    });

    it('should not set background when omitted', () => {
      expect(parse(validMarkdown).background).toBeUndefined();
    });

    it('should parse approvalMode: bubble from frontmatter', () => {
      const config = parse(
        md(
          'name: bubbler\ndescription: A background agent that bubbles approvals\nbackground: true\napprovalMode: bubble',
          'You are a bubbler.',
        ),
      );

      expect(config.approvalMode).toBe('bubble');
    });

    it('should reject an unknown approvalMode value', () => {
      expect(() =>
        parse(
          md(
            'name: weird\ndescription: An agent with a bogus mode\napprovalMode: telepathy',
            'You are weird.',
          ),
        ),
      ).toThrow(/Invalid "approvalMode"/);
    });

    it('should round-trip approvalMode: bubble through serialize', () => {
      const serialized = ser({ approvalMode: 'bubble' });
      expect(serialized).toContain('approvalMode: bubble');
      expect(parse(serialized).approvalMode).toBe('bubble');
    });

    // --- CC 2.1.168 declarative-agent fields (DL7-parity lenient parse) ---

    // Parses `name: a`, `description: d` plus `fm`, the YAML stub returning
    // those two keys plus `fields`.
    const parseAD = (fields: Record<string, unknown>, fm: string) => {
      mockParseYaml.mockReturnValueOnce({
        name: 'a',
        description: 'd',
        ...fields,
      });
      return parse(`---\nname: a\ndescription: d\n${fm}\n---\nx`);
    };

    it('should parse valid permissionMode and bridge to approvalMode', () => {
      const config = parseAD(
        { permissionMode: 'bypassPermissions' },
        'permissionMode: bypassPermissions',
      );
      expect(config.permissionMode).toBe('bypassPermissions');
      expect(config.approvalMode).toBe('yolo');
    });

    it('should prefer explicit approvalMode over permissionMode bridge', () => {
      const config = parseAD(
        { permissionMode: 'bypassPermissions', approvalMode: 'plan' },
        'permissionMode: bypassPermissions\napprovalMode: plan',
      );
      expect(config.approvalMode).toBe('plan');
      expect(config.permissionMode).toBe('bypassPermissions');
    });

    it('should drop invalid permissionMode and not bridge', () => {
      const config = parseAD(
        { permissionMode: 'not-a-mode' },
        'permissionMode: not-a-mode',
      );
      expect(config.permissionMode).toBeUndefined();
      expect(config.approvalMode).toBeUndefined();
    });

    const mcpServers = {
      filesystem: { type: 'stdio', command: 'node' },
      github: { type: 'http', url: 'https://example.com' },
    };
    it.each([
      ['should parse maxTurns as number', { maxTurns: 42 }, 'maxTurns: 42', 42],
      [
        'should parse maxTurns from numeric string',
        { maxTurns: '42' },
        'maxTurns: "42"',
        42,
      ],
      [
        'should drop negative or zero maxTurns',
        { maxTurns: -1 },
        'maxTurns: -1',
        undefined,
      ],
      [
        'should parse nested mcpServers as a record',
        { mcpServers },
        'mcpServers:\n  filesystem:\n    type: stdio\n    command: node',
        mcpServers,
      ],
      [
        'should drop mcpServers of the wrong top-level shape',
        { mcpServers: 'just-a-string' },
        'mcpServers: just-a-string',
        undefined,
      ],
      [
        'should parse nested hooks as a record of arrays',
        { hooks: echoHooks() },
        'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: echo',
        echoHooks(),
      ],
      [
        'should drop hooks with non-array values per event',
        { hooks: { PreToolUse: 'not-an-array' } },
        'hooks:\n  PreToolUse: not-an-array',
        undefined,
      ],
      [
        'should preserve color from allowlist',
        { color: 'cyan' },
        'color: cyan',
        'cyan',
      ],
      [
        'should drop color not in allowlist (matches CC _Y silent drop)',
        { color: 'magenta' },
        'color: magenta',
        undefined,
      ],
    ])('%s', (_title, fields, fm, expected) => {
      const [key] = Object.keys(fields) as Array<keyof SubagentConfig>;
      expect(parseAD(fields, fm)[key]).toEqual(expected);
    });
  });

  describe('serializeSubagent', () => {
    it('preserves the executor through save and reload', async () => {
      const yaml = await realYaml();
      mockStringifyYaml.mockImplementationOnce(yaml.stringify);
      mockParseYaml.mockImplementationOnce(yaml.parse);
      const executor = {
        kind: 'acp' as const,
        command: 'npx',
        args: ['-y', 'adapter'],
      };
      expect(parse(ser({ executor })).executor).toEqual(executor);
    });

    it.each([null, false, 0, '', { kind: 'acp', command: ' ' }])(
      'refuses to save invalid executor %j without writing',
      async (executor) => {
        vi.mocked(fs.access).mockRejectedValue(new Error('File not found'));
        const config = {
          ...validConfig,
          executor,
        } as unknown as SubagentConfig;
        expect(() => manager.serializeSubagent(config)).toThrow(
          /executor block failed validation/,
        );
        await expect(
          manager.createSubagent(config, { level: 'project' }),
        ).rejects.toThrow(/executor block failed validation/);
        expect(fs.writeFile).not.toHaveBeenCalled();
      },
    );

    it('should serialize basic configuration', () => {
      const serialized = ser();

      expect(serialized).toContain('name: test-agent');
      expect(serialized).toContain('description: A test subagent');
      expect(serialized).toContain('You are a helpful assistant.');
      expect(serialized).toMatch(/^---\n[\s\S]*\n---\n\n[\s\S]*\n$/);
    });

    it.each<[string, Partial<SubagentConfig>, string[], string[]?]>([
      [
        'should serialize configuration with tools',
        { tools: ['read_file', 'write_file'] },
        ['tools:', '- read_file', '- write_file'],
      ],
      [
        'should serialize configuration with model selector',
        { model: 'custom-model' },
        ['model: custom-model'],
      ],
      [
        'should not include empty optional fields',
        {},
        [],
        ['tools:', 'model:', 'runConfig:', 'disallowedTools:'],
      ],
      [
        'should serialize configuration with disallowedTools',
        { disallowedTools: ['write_file', 'mcp__slack'] },
        ['disallowedTools:', '- write_file', '- mcp__slack'],
      ],
      [
        'should serialize background: true',
        { background: true },
        ['background: true'],
      ],
      [
        'should not serialize background when undefined',
        {},
        [],
        ['background'],
      ],
      // --- CC 2.1.168 declarative-agent fields serialization ---
      [
        'should serialize permissionMode when set',
        { permissionMode: 'bypassPermissions' },
        ['permissionMode: bypassPermissions'],
      ],
      [
        'should serialize maxTurns when set',
        { maxTurns: 25 },
        ['maxTurns: 25'],
      ],
      // Regression for PR #4842 round-2 review: with both fields serialised,
      // the next parse takes approvalMode (explicit wins over the bridge) and
      // silently ignores user edits to permissionMode in the file.
      [
        'should NOT emit permissionMode when approvalMode is also being emitted (avoid round-trip drift)',
        { permissionMode: 'bypassPermissions', approvalMode: 'yolo' },
        ['approvalMode: yolo'],
        ['permissionMode:'],
      ],
      [
        'should still emit permissionMode when approvalMode is unset (faithful round-trip of the user intent)',
        { permissionMode: 'plan' },
        ['permissionMode: plan'],
        ['approvalMode:'],
      ],
      [
        'should not include new fields when undefined',
        {},
        [],
        ['permissionMode:', 'maxTurns:'],
      ],
    ])('%s', (_title, extra, present, absent = []) => {
      const serialized = ser(extra);
      for (const text of present) expect(serialized).toContain(text);
      for (const text of absent) expect(serialized).not.toContain(text);
    });

    it('should roundtrip disallowedTools through serialize and parse', () => {
      const serialized = ser({ disallowedTools: ['write_file', 'mcp__slack'] });

      expect(serialized).toContain('disallowedTools:');
      expect(serialized).toContain('- write_file');
      expect(serialized).toContain('- mcp__slack');
      expect(parse(serialized).disallowedTools).toEqual([
        'write_file',
        'mcp__slack',
      ]);
    });

    // The frontmatter object the serializer hands to stringifyYaml.
    const frontmatterOf = (extra: Partial<SubagentConfig>) => {
      mockStringifyYaml.mockClear();
      ser(extra);
      return mockStringifyYaml.mock.calls[0][0];
    };

    it('should include mcpServers in the frontmatter object passed to stringifyYaml', () => {
      const mcpServers = { filesystem: { type: 'stdio', command: 'node' } };
      expect(frontmatterOf({ mcpServers }).mcpServers).toEqual(mcpServers);
    });

    it('should include hooks in the frontmatter object passed to stringifyYaml', () => {
      expect(frontmatterOf({ hooks: echoHooks() }).hooks).toEqual(echoHooks());
    });

    it('should omit mcpServers / hooks when the record is empty', () => {
      const frontmatterArg = frontmatterOf({ mcpServers: {}, hooks: {} });
      expect(frontmatterArg.mcpServers).toBeUndefined();
      expect(frontmatterArg.hooks).toBeUndefined();
    });

    it.each([true, false])(
      'roundtrips background=%s through serialize and parse',
      (background) => {
        expect(parse(ser({ background })).background).toBe(background);
      },
    );
  });

  const commitBoundary = () => {
    const commitError = new Error('generation closed');
    return {
      commitError,
      options: {
        assertCanCommit: () => {
          throw commitError;
        },
      },
    };
  };

  describe('createSubagent', () => {
    beforeEach(() => {
      vi.mocked(fs.access).mockRejectedValue(new Error('File not found'));
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    });
    const create = (options = {}) =>
      manager.createSubagent(validConfig, { level: 'project', ...options });

    it('should create subagent successfully', async () => {
      await create();

      expect(fs.mkdir).toHaveBeenCalledWith(
        path.normalize(path.dirname(validConfig.filePath!)),
        { recursive: true },
      );
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('test-agent.md'),
        expect.stringContaining('name: test-agent'),
        'utf8',
      );
    });

    it('rejects creation at the commit boundary without writing', async () => {
      const { commitError, options } = commitBoundary();

      await expect(create(options)).rejects.toBe(commitError);

      expectNotCalled(fs.mkdir, fs.writeFile);
    });

    it('should throw error if file already exists and overwrite is false', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined); // File exists
      await expectSubagentError(create, /already exists/);
    });

    it('should overwrite file when overwrite is true', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined); // File exists
      await create({ overwrite: true });
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('should use custom path when provided', async () => {
      const customPath = '/custom/path/agent.md';
      await create({ customPath });
      expect(fs.writeFile).toHaveBeenCalledWith(
        customPath,
        expect.any(String),
        'utf8',
      );
    });

    it('should throw error on file write failure', async () => {
      vi.mocked(fs.writeFile).mockRejectedValue(new Error('Write failed'));
      await expectSubagentError(create, /Failed to write subagent file/);
    });
  });

  // Queues one file read per agent, each with its matching YAML stub result.
  function queueAgentFiles(
    ...agents: Array<[name: string, description: string, body: string]>
  ) {
    for (const [name, description, body] of agents) {
      vi.mocked(fs.readFile).mockResolvedValueOnce(
        `---\nname: ${name}\ndescription: ${description}\n---\n${body}`,
      );
      mockParseYaml.mockReturnValueOnce({ name, description });
    }
  }

  describe('loadSubagent', () => {
    const exploreManager = (exploreModel: unknown) =>
      new SubagentManager(
        makeFakeConfig({
          agents: { builtin: { exploreModel: exploreModel as string } },
        }),
      );
    const loadBuiltinExplore = (exploreModel: unknown) =>
      exploreManager(exploreModel).loadSubagent('Explore', 'builtin');

    it('applies the configured model only to the built-in Explore agent', async () => {
      noAgentDirs();
      const mgr = exploreManager('fast');

      expect((await mgr.loadSubagent('Explore'))?.model).toBe('fast');
      expect((await mgr.loadSubagent('Explore', 'builtin'))?.model).toBe(
        'fast',
      );

      const builtins = await mgr.listSubagents({
        level: 'builtin',
        force: true,
      });
      expect(builtins.find((a) => a.name === 'Explore')?.model).toBe('fast');
    });

    it('does not apply the built-in Explore model to a same-name session agent', async () => {
      const mgr = exploreManager('fast');
      mgr.loadSessionSubagents([
        {
          name: 'Explore',
          description: 'Session Explore',
          systemPrompt: 'Use the session agent.',
          level: 'session',
        },
      ]);

      const config = await mgr.loadSubagent('Explore');

      expect(config?.level).toBe('session');
      expect(config?.model).toBeUndefined();
    });

    it('ignores a non-string built-in Explore model setting', async () => {
      expect((await loadBuiltinExplore(1))?.model).toBeUndefined();
    });

    it.each([
      { exploreModel: '   ', expectedModel: undefined },
      { exploreModel: 'inherit', expectedModel: 'inherit' },
    ])(
      'resolves the built-in Explore model setting "$exploreModel"',
      async ({ exploreModel, expectedModel }) => {
        expect((await loadBuiltinExplore(exploreModel))?.model).toBe(
          expectedModel,
        );
      },
    );

    it.each([
      [
        'should load subagent from project level first',
        () => mockAgentFiles(['test-agent.md'], validMarkdown),
        '/test/project/.qwen/agents',
      ],
      [
        'should fall back to user level if project level fails',
        mockUserLevelOnly,
        '/home/user/.qwen/agents',
      ],
    ])('%s', async (_title, mockDirs, dir) => {
      mockDirs();

      const config = await manager.loadSubagent('test-agent');

      expect(config).toBeDefined();
      expect(config!.name).toBe('test-agent');
      expect(fs.readdir).toHaveBeenCalledWith(path.normalize(dir));
      expect(fs.readFile).toHaveBeenCalledWith(
        path.normalize(`${dir}/test-agent.md`),
        'utf8',
      );
    });

    it('should return null if not found at either level', async () => {
      noAgentDirs();
      expect(await manager.loadSubagent('nonexistent')).toBeNull();
    });

    it('should load subagent even when filename does not match name', async () => {
      mockAgentFiles(['wrong-filename.md', 'another-file.md']);
      // The first file (wrong-filename.md) is the match.
      queueAgentFiles(
        [
          'correct-agent-name',
          'A test subagent with mismatched filename',
          '\nYou are a helpful assistant.',
        ],
        ['other-agent', 'Some other agent', '\nYou are another assistant.'],
      );

      const config = await manager.loadSubagent('correct-agent-name');

      expect(config).toBeDefined();
      expect(config!.name).toBe('correct-agent-name');
      expect(config!.filePath).toBe(
        path.normalize('/test/project/.qwen/agents/wrong-filename.md'),
      );
      // It scanned the directory instead of using a direct path.
      expect(fs.readdir).toHaveBeenCalledWith(
        path.normalize('/test/project/.qwen/agents'),
      );
    });

    it('should search user level when filename mismatch at project level', async () => {
      vi.mocked(fs.readdir)
        .mockResolvedValueOnce(['other-file.md'] as never) // project level
        .mockResolvedValueOnce(['user-agent.md'] as never); // user level
      queueAgentFiles(
        ['wrong-agent', 'Wrong agent', '\nYou are a wrong assistant.'],
        [
          'target-agent',
          'A test subagent at user level',
          '\nYou are a helpful assistant.',
        ],
      );

      const config = await manager.loadSubagent('target-agent');

      expect(config).toBeDefined();
      expect(config!.name).toBe('target-agent');
      expect(config!.filePath).toBe(
        path.normalize('/home/user/.qwen/agents/user-agent.md'),
      );
      expect(config!.level).toBe('user');
    });

    it('should handle specific level search with filename mismatch', async () => {
      mockAgentFiles(
        ['misnamed-file.md'],
        '---\nname: specific-agent\ndescription: A test subagent for specific level\n---\n\nYou are a helpful assistant.',
      );
      mockParseYaml.mockReturnValue({
        name: 'specific-agent',
        description: 'A test subagent for specific level',
      });

      const config = await manager.loadSubagent('specific-agent', 'project');

      expect(config).toBeDefined();
      expect(config!.name).toBe('specific-agent');
      expect(config!.filePath).toBe(
        path.normalize('/test/project/.qwen/agents/misnamed-file.md'),
      );
    });

    // A project file claiming the builtin name with a typo'd `kind: ACP`.
    const invalidExplore =
      '---\nname: Explore\ndescription: Test\nexecutor:\n  kind: ACP\n  command: npx\n---\nPrompt';
    const expectExploreRefused = () =>
      expect(manager.loadSubagent('Explore')).rejects.toThrow(
        /invalid executor block/,
      );

    it.each([
      // Discovery skips the invalid file with a warning. Without R10-2 the
      // lookup falls through session>project>user>extension>builtin, silently
      // running the in-process BUILTIN Explore in place of the external agent
      // the file asked for, with only a warn as the trace. Skip-and-continue
      // (no recorded refusal) turns this red.
      [
        'refuses a by-name dispatch matching a skipped invalid-executor file instead of falling through to a builtin (R10-2)',
        invalidExplore,
      ],
      // The file omits description, failing required-field validation BEFORE
      // the executor block; without hoisting the claim probe and name above it,
      // nothing is recorded and dispatch falls through to the builtin (what
      // R10-2 prevents). Reverting the catch's conversion to a named refusal
      // turns this red.
      [
        'refuses a by-name dispatch for an executor-claiming file that fails an earlier validation (R11-1)',
        '---\nname: Explore\nexecutor:\n  kind: acp\n  command: npx\n---\nPrompt',
      ],
      // parseSimple strips only double quotes, so `name: 'Explore'` would be
      // keyed "'explore'" and miss the lookup; the key must be the YAML AST's
      // name. The colon in description forces the astLostExecutor path;
      // `declaredName ?? name` -> `name` turns this red.
      [
        'keys the executor refusal by the AST-parsed name, so a quoted name still refuses the dispatch (R11-4)',
        "---\nname: 'Explore'\ndescription: Reviews code: fast and careful\nexecutor:\n  kind: ACP\n  command: npx\n---\nPrompt",
      ],
    ])('%s', async (_title, content) => {
      await useRealYamlParse();
      mockAgentFiles(['explore.md'], content);
      await expectExploreRefused();
    });

    it('clears a stale executor refusal when the directory later becomes unreadable (R12-4)', async () => {
      await useRealYamlParse();
      // First scan records a refusal for 'explore'.
      mockAgentFiles(['explore.md'], invalidExplore);
      await expectExploreRefused();
      // The directory then becomes unreadable (branch checkout, rm -rf).
      // Without resetting the level's refusals on scan failure, the stale
      // refusal for a file that no longer exists keeps the builtin unreachable.
      // Deleting the catch reset turns this red.
      vi.mocked(fs.readdir).mockRejectedValue(
        new Error('ENOENT: no such directory'),
      );
      const resolved = await manager.loadSubagent('Explore');
      expect(resolved?.isBuiltin).toBe(true);
    });

    it('does not refuse an in-process definition whose block-scalar prose mentions executor: (R12-5)', async () => {
      await useRealYamlParse();
      // A `description: |` block scalar documents the executor syntax as prose;
      // the duplicate `name:` is a tolerated quirk (it loads alone) that makes
      // has('executor') false. The raw probe matches the prose line, so without
      // the block-scalar exclusion astLostExecutor refuses; reverting it turns
      // this red.
      mockAgentFiles(
        ['foo.md'],
        '---\nname: foo\nname: foo\ndescription: |\n  Reviews code. To run externally use:\n  executor: acp\n  for details.\n---\nPrompt',
      );
      const config = await manager.loadSubagent('foo');
      expect(config).not.toBeNull();
      expect(config!.name).toBe('foo');
      expect(config!.executor).toBeUndefined();
    });

    it('does not refuse an in-process definition whose folded-block-scalar prose mentions executor: (R12-5)', async () => {
      await useRealYamlParse();
      // Same as above but with a folded block scalar (`description: >`).
      mockAgentFiles(
        ['foo.md'],
        '---\nname: foo\nname: foo\ndescription: >\n  Reviews code. To run externally use:\n  executor: acp\n  for details.\n---\nPrompt',
      );
      const config = await manager.loadSubagent('foo');
      expect(config).not.toBeNull();
      expect(config!.executor).toBeUndefined();
    });

    it('refuses a by-name dispatch for an extension-level executor refusal instead of falling through to a builtin (R10-2 extension leg)', async () => {
      // Extension agents load via loadSubagentFromDir, which skips and warns,
      // so the R10-2 extension leg read an empty map. Refusals now ride on the
      // extension into the 'extension' bucket; dropping that merge turns this
      // red.
      vi.spyOn(mockConfig, 'getActiveExtensions').mockReturnValue([
        {
          agents: [],
          agentExecutorRefusals: new Map([
            [
              'explore',
              new SubagentError(
                'Agent file /ext/agents/explore.md has an invalid executor block: it declares an executor but failed to load.',
                SubagentErrorCode.INVALID_CONFIG,
                'Explore',
              ),
            ],
          ]),
        } as never,
      ]);
      // No project/user file declares 'Explore': only the extension refusal.
      mockAgentFiles([]);
      await expectExploreRefused();
    });
  });

  describe('updateSubagent', () => {
    beforeEach(() => {
      mockAgentFiles(['test-agent.md'], validMarkdown);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    });

    it('should update existing subagent', async () => {
      await manager.updateSubagent('test-agent', {
        description: 'Updated description',
      });

      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('test-agent.md'),
        expect.stringContaining('Updated description'),
        'utf8',
      );
    });

    it('rejects updates at the commit boundary without writing', async () => {
      const { commitError, options } = commitBoundary();

      await expect(
        manager.updateSubagent('test-agent', {}, undefined, options),
      ).rejects.toBe(commitError);

      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it('should throw error if subagent not found', async () => {
      noAgentDirs();
      await expectSubagentError(
        () => manager.updateSubagent('nonexistent', {}),
        /not found/,
      );
    });

    it.each([undefined, 'extension'] as const)(
      'should reject updates to extension-provided subagents when level is %s',
      async (level) => {
        vi.spyOn(mockConfig, 'getActiveExtensions').mockReturnValue([
          {
            id: 'test-extension',
            name: 'test-extension',
            version: '1.0.0',
            isActive: true,
            path: '/extension',
            config: { name: 'test-extension', version: '1.0.0' },
            contextFiles: [],
            agents: [
              {
                name: 'extension-agent',
                description: 'Provided by an extension',
                systemPrompt: 'Review the code.',
                level: 'extension',
                filePath: '/extension/agents/extension-agent.md',
              },
            ],
          },
        ]);

        await expect(
          manager.updateSubagent(
            'extension-agent',
            { description: 'Updated description' },
            level,
          ),
        ).rejects.toMatchObject({
          code: SubagentErrorCode.INVALID_CONFIG,
          subagentName: 'extension-agent',
          message:
            'Cannot update extension-provided subagent "extension-agent"',
        });
        expectNotCalled(mockValidateOrThrow, fs.writeFile);
      },
    );

    it('should throw error on write failure', async () => {
      vi.mocked(fs.writeFile).mockRejectedValue(new Error('Write failed'));
      await expectSubagentError(
        () => manager.updateSubagent('test-agent', {}),
        /Failed to update subagent file/,
      );
    });
  });

  describe('deleteSubagent', () => {
    beforeEach(() => {
      vi.mocked(fs.unlink).mockResolvedValue(undefined);
    });
    // A custom definition that reuses a builtin name.
    const mockCustomNative = (name: string) => {
      mockAgentFiles(
        [`${name}.md`],
        `---\nname: ${name}\ndescription: Custom native agent\n---\nInspect.`,
      );
      mockParseYaml.mockReturnValue({
        name,
        description: 'Custom native agent',
      });
    };
    const PROJECT_FILE = path.normalize(
      '/test/project/.qwen/agents/test-agent.md',
    );

    it.each(
      (['project', 'user', undefined] as const).flatMap((level) =>
        (['codex', 'claude-code'] as const).map(
          (name) => [name, level] as const,
        ),
      ),
    )(
      'deletes a custom %s definition at level %s despite its builtin name',
      async (name, level) => {
        mockCustomNative(name);
        await manager.deleteSubagent(name, level);
        expect(fs.unlink).toHaveBeenCalledTimes(level === undefined ? 2 : 1);
        expect(
          vi
            .mocked(fs.unlink)
            .mock.calls.every(([file]) => String(file).endsWith(`${name}.md`)),
        ).toBe(true);
      },
    );

    it.each(['codex', 'claude-code'])(
      'protects the builtin %s definition from deletion',
      async (name) => {
        mockAgentFiles([]);
        await expect(manager.deleteSubagent(name, 'builtin')).rejects.toThrow(
          /Cannot delete built-in/,
        );
        await expect(manager.deleteSubagent(name)).rejects.toThrow(
          /Cannot delete built-in/,
        );
        await expect(
          manager.deleteSubagent(name, 'project'),
        ).rejects.toMatchObject({ code: SubagentErrorCode.INVALID_CONFIG });
        expect(fs.unlink).not.toHaveBeenCalled();
      },
    );

    it('reports a file error when a custom builtin-name definition cannot be deleted', async () => {
      mockCustomNative('codex');
      vi.mocked(fs.unlink).mockRejectedValue(
        Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      );
      await expect(
        manager.deleteSubagent('codex', 'project'),
      ).rejects.toMatchObject({
        code: SubagentErrorCode.FILE_ERROR,
        message: expect.stringContaining('permission denied'),
      });
    });

    it('should delete subagent from specified level', async () => {
      mockAgentFiles(['test-agent.md'], validMarkdown);

      await manager.deleteSubagent('test-agent', 'project');

      expect(fs.unlink).toHaveBeenCalledWith(PROJECT_FILE);
    });

    it('rejects deletion at the commit boundary without unlinking', async () => {
      mockAgentFiles(['test-agent.md'], validMarkdown);
      const { commitError, options } = commitBoundary();

      await expect(
        manager.deleteSubagent('test-agent', 'project', undefined, options),
      ).rejects.toBe(commitError);

      expect(fs.unlink).not.toHaveBeenCalled();
    });

    it('should delete from both levels if no level specified', async () => {
      vi.mocked(fs.readdir)
        .mockResolvedValueOnce(['test-agent.md'] as never) // project level
        .mockResolvedValueOnce(['test-agent.md'] as never); // user level
      vi.mocked(fs.readFile).mockResolvedValue(validMarkdown);

      await manager.deleteSubagent('test-agent');

      expect(fs.unlink).toHaveBeenCalledTimes(2);
      expect(fs.unlink).toHaveBeenCalledWith(PROJECT_FILE);
      expect(fs.unlink).toHaveBeenCalledWith(
        path.normalize('/home/user/.qwen/agents/test-agent.md'),
      );
    });

    it('should throw error if subagent not found', async () => {
      noAgentDirs();
      await expectSubagentError(
        () => manager.deleteSubagent('nonexistent'),
        /not found/,
      );
    });

    it('should succeed if deleted from at least one level', async () => {
      mockUserLevelOnly();

      await expect(manager.deleteSubagent('test-agent')).resolves.not.toThrow();
    });

    it('should delete subagent with mismatched filename', async () => {
      mockAgentFiles(
        ['wrong-name.md'],
        '---\nname: correct-name\ndescription: A test subagent with mismatched filename\n---\n\nYou are a helpful assistant.',
      );
      mockParseYaml.mockReturnValue({
        name: 'correct-name',
        description: 'A test subagent with mismatched filename',
      });

      await manager.deleteSubagent('correct-name', 'project');

      // Deletes the actual file, not the expected filename.
      expect(fs.unlink).toHaveBeenCalledWith(
        path.normalize('/test/project/.qwen/agents/wrong-name.md'),
      );
    });

    it('should handle deletion when multiple files exist but only one matches', async () => {
      mockAgentFiles(['file1.md', 'file2.md', 'target-file.md']);
      queueAgentFiles(
        ['other-agent-1', 'First other agent', 'Content 1'],
        ['other-agent-2', 'Second other agent', 'Content 2'],
        ['target-agent', 'The target agent', 'Target content'],
      );

      await manager.deleteSubagent('target-agent', 'project');

      expect(fs.unlink).toHaveBeenCalledTimes(1);
      expect(fs.unlink).toHaveBeenCalledWith(
        path.normalize('/test/project/.qwen/agents/target-file.md'),
      );
    });
  });

  const BUILTIN_NAMES = [
    'general-purpose',
    'Explore',
    'statusline-setup',
    'review-agent',
    'claude-code',
    'codex',
  ];

  describe('listSubagents', () => {
    beforeEach(() => {
      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([
          'agent1.md',
          'agent2.md',
          'not-md.txt',
        ] as never)
        .mockResolvedValueOnce(['agent3.md', 'agent1.md'] as never); // user level
      const descriptions = ['First agent', 'Second agent', 'Third agent'];
      vi.mocked(fs.readFile).mockImplementation((filePath) => {
        const n = Number(/agent([123])\.md/.exec(String(filePath))?.[1]);
        return n
          ? Promise.resolve(
              `---\nname: agent${n}\ndescription: ${descriptions[n - 1]}\n---\nSystem prompt ${n}`,
            )
          : Promise.reject(new Error('File not found'));
      });
    });

    it('should list subagents from both levels', async () => {
      const subagents = await manager.listSubagents();

      expect(subagents).toHaveLength(9);
      expect(subagents.map((s) => s.name)).toEqual([
        'agent1',
        'agent2',
        'agent3',
        ...BUILTIN_NAMES,
      ]);
    });

    it('should prioritize project level over user level', async () => {
      const subagents = await manager.listSubagents();
      const agent1 = subagents.find((s) => s.name === 'agent1');

      expect(agent1!.level).toBe('project');
    });

    it('should filter by level', async () => {
      const subagents = await manager.listSubagents({ level: 'project' });

      expect(subagents).toHaveLength(2); // agent1, agent2
      expect(subagents.every((s) => s.level === 'project')).toBe(true);
    });

    it('should sort by name', async () => {
      const subagents = await manager.listSubagents({
        sortBy: 'name',
        sortOrder: 'asc',
      });

      expect(subagents.map((s) => s.name)).toEqual([
        'agent1',
        'agent2',
        'agent3',
        'claude-code',
        'codex',
        'Explore',
        'general-purpose',
        'review-agent',
        'statusline-setup',
      ]);
    });

    it.each([
      ['should handle empty directories', () => mockAgentFiles([])],
      ['should handle directory read errors', noAgentDirs],
    ])('%s', async (_title, mockDirs) => {
      mockDirs();
      vi.mocked(fs.readFile).mockRejectedValue(new Error('No files'));

      const subagents = await manager.listSubagents();

      expect(subagents).toHaveLength(6); // Only built-in agents remain
      expect(subagents.map((s) => s.name)).toEqual(BUILTIN_NAMES);
      expect(subagents.every((s) => s.level === 'builtin')).toBe(true);
    });
  });

  describe('safe mode', () => {
    let safeManager: SubagentManager;

    beforeEach(() => {
      const safeConfig = makeFakeConfig({ safeMode: true });
      vi.spyOn(safeConfig, 'getToolRegistry').mockReturnValue(mockToolRegistry);
      vi.spyOn(safeConfig, 'getProjectRoot').mockReturnValue('/test/project');
      safeManager = new SubagentManager(safeConfig);
    });
    const expectOnlyBuiltins = async (options?: { level: 'project' }) => {
      const subagents = await safeManager.listSubagents(options);
      expect(subagents.every((s) => s.level === 'builtin')).toBe(true);
      return subagents;
    };

    it('listSubagents returns only builtin subagents', async () => {
      // Even if project/user dirs have agents, safe mode must ignore them.
      mockAgentFiles(
        ['evil-agent.md'],
        '---\nname: evil-agent\ndescription: Injected via project\n---\nmalicious prompt',
      );

      const subagents = await expectOnlyBuiltins();
      expect(subagents.find((s) => s.name === 'evil-agent')).toBeUndefined();
    });

    it('listSubagents overrides explicit non-builtin level to builtin', async () => {
      mockAgentFiles([]);
      await expectOnlyBuiltins({ level: 'project' });
    });

    it('refreshCache only populates builtin level', async () => {
      mockAgentFiles(
        ['evil.md'],
        '---\nname: evil\ndescription: bad\n---\nbad',
      );

      await safeManager.refreshCache();

      await expectOnlyBuiltins();
    });
  });

  describe('findSubagentByName', () => {
    it('should find existing subagent', async () => {
      mockAgentFiles(['test-agent.md'], validMarkdown);

      const metadata = await manager.findSubagentByName('test-agent');

      expect(metadata).toBeDefined();
      expect(metadata!.name).toBe('test-agent');
      expect(metadata!.description).toBe('A test subagent');
    });

    it('should return null for non-existent subagent', async () => {
      noAgentDirs();
      expect(await manager.findSubagentByName('nonexistent')).toBeNull();
    });
  });

  describe('isNameAvailable', () => {
    it('should return true for available names', async () => {
      noAgentDirs();
      expect(await manager.isNameAvailable('new-agent')).toBe(true);
    });

    it('should return false for existing names', async () => {
      mockAgentFiles(['test-agent.md'], validMarkdown);
      expect(await manager.isNameAvailable('test-agent')).toBe(false);
    });

    it('should check specific level when provided', async () => {
      // isNameAvailable loads the subagent from any level and reports the name
      // available only when it was found at a different level than asked.
      mockUserLevelOnly();

      // Available at project because it was found at user level.
      expect(await manager.isNameAvailable('test-agent', 'project')).toBe(true);

      // Found at user level again: not available at user level.
      mockAgentFiles(['test-agent.md'], validMarkdown);
      expect(await manager.isNameAvailable('test-agent', 'user')).toBe(false);
    });
  });

  describe('Runtime Configuration Methods', () => {
    describe('convertToRuntimeConfig', () => {
      const convert = (extra: Partial<SubagentConfig> = {}, context?: Config) =>
        manager.convertToRuntimeConfig({ ...validConfig, ...extra }, context);
      const convertFast = (fastModel: string | undefined) => {
        vi.spyOn(mockConfig, 'getFastModel').mockReturnValue(fastModel);
        return convert({ model: 'fast' }, mockConfig);
      };

      it.each([{ kind: 'acp', command: 'npx' }, null, false, 0, ''])(
        'refuses external executor %j before in-process conversion',
        async (executor) => {
          await expect(
            convert({
              tools: ['read_file'],
              executor,
            } as unknown as SubagentConfig),
          ).rejects.toMatchObject({
            code: SubagentErrorCode.INVALID_CONFIG,
            message: expect.stringContaining(
              'cannot be converted to an in-process agent',
            ),
          });
          expectNotCalled(mockToolRegistry.warmAll, mockAgentHeadlessCreate);
        },
      );

      it('should convert basic configuration', async () => {
        const runtimeConfig = await convert();

        expect(runtimeConfig.promptConfig.systemPrompt).toBe(
          validConfig.systemPrompt,
        );
        expect(runtimeConfig.modelConfig).toEqual({});
        expect(runtimeConfig.runConfig).toEqual({});
        expect(runtimeConfig.toolConfig).toBeUndefined();
      });

      it.each([
        [
          'should include tool configuration when tools are specified',
          ['read_file', 'write_file'],
          ['read_file', 'write_file'],
        ],
        [
          'should transform display names to tool names in tool configuration',
          ['Read File', 'write_file', 'Search Files', 'unknown_tool'],
          // Display name, exact name, display name ('Search Files' -> grep),
          // unknown name preserved as-is.
          ['read_file', 'write_file', 'grep', 'unknown_tool'],
        ],
      ])('%s', async (_title, tools, expected) => {
        const { toolConfig } = await convert({ tools });

        expect(toolConfig).toBeDefined();
        expect(toolConfig!.tools).toEqual(expected);
      });

      it.each([
        // The unresolved name stays a dead, restrictive entry: the agent runs
        // tool-less rather than inheriting shell/write. Deliberate: supersedes
        // the earlier inherit-all fallback for converted Claude agents.
        [
          'fails closed when the allow-list is only the unavailable WebSearch',
          'WebSearch',
        ],
        // A typo'd or unavailable tool set must never silently become
        // inherit-all (granting shell/write to an agent configured without
        // them).
        [
          'does not widen an allow-list whose names simply fail to resolve',
          'Sheell',
        ],
      ])('%s', async (_title, tool) => {
        expect((await convert({ tools: [tool] })).toolConfig?.tools).toEqual([
          tool,
        ]);
      });

      it('keeps inherit-all for an empty tools array combined with disallowedTools', async () => {
        // An empty allow-list is the documented "inherit everything" marker
        // for definition files, not a request for a zero-tool agent. `[]` is
        // truthy, so testing only for presence produced `tools: []` here, and
        // AgentCore reads an explicit empty list as deny-all: an agent defined
        // with `tools: []` plus `disallowedTools: [write_file]` declared 16
        // tools on the merge base and 0 on this branch, with no warning.
        const runtimeConfig = await manager.convertToRuntimeConfig({
          ...validConfig,
          tools: [],
          disallowedTools: ['write_file'],
        });

        expect(runtimeConfig.toolConfig?.tools).toEqual(['*']);
        expect(runtimeConfig.toolConfig?.disallowedTools).toEqual([
          'write_file',
        ]);
      });

      it('should transform display names to tool names in tool configuration', async () => {
        const configWithDisplayNames: SubagentConfig = {
          ...validConfig,
          tools: ['Read File', 'write_file', 'Search Files', 'unknown_tool'],
        };

        const runtimeConfig = await manager.convertToRuntimeConfig(
          configWithDisplayNames,
        );

        expect(runtimeConfig.toolConfig).toBeDefined();
        expect(runtimeConfig.toolConfig!.tools).toEqual([
          'read_file', // 'Read File' -> 'read_file' (display name match)
          'write_file', // 'write_file' -> 'write_file' (exact name match)
          'grep', // 'Search Files' -> 'grep' (display name match)
          'unknown_tool', // 'unknown_tool' -> 'unknown_tool' (preserved as-is)
        ]);
      });

      it('fails closed when the allow-list is only the unavailable WebSearch', async () => {
        // The unresolved name stays a dead, restrictive entry: the agent
        // runs tool-less rather than inheriting shell/write it was not
        // configured for. Deliberate — supersedes the earlier inherit-all
        // compatibility fallback for converted Claude agents.
        const configWithUnregistered: SubagentConfig = {
          ...validConfig,
          tools: ['WebSearch'],
        };

        const runtimeConfig = await manager.convertToRuntimeConfig(
          configWithUnregistered,
        );

        expect(runtimeConfig.toolConfig?.tools).toEqual(['WebSearch']);
      });

      it('does not widen an allow-list whose names simply fail to resolve', async () => {
        // A typo'd or temporarily-unavailable tool set must stay a dead,
        // restrictive list — never silently become inherit-all (that would
        // grant shell/write to an agent configured without them).
        const runtimeConfig = await manager.convertToRuntimeConfig({
          ...validConfig,
          tools: ['Sheell'],
        });

        expect(runtimeConfig.toolConfig?.tools).toEqual(['Sheell']);
      });

      it('should set modelConfig.model from model selector and merge run configurations', async () => {
        const runtimeConfig = await convert({
          model: 'custom-model',
          runConfig: { max_time_minutes: 5 },
        });

        expect(runtimeConfig.modelConfig.model).toBe('custom-model');
        expect(runtimeConfig.runConfig.max_time_minutes).toBe(5);
      });

      it('should accept cross-provider model selectors', async () => {
        expect(
          (await convert({ model: 'openai:gpt-4' })).modelConfig.model,
        ).toBe('gpt-4');
      });

      it.each([
        [
          'should resolve "fast" to the configured current-auth fast model',
          'fast-model-id',
        ],
        [
          'should resolve "fast" to authType-qualified fast model selectors',
          'openai:fast-model-id',
        ],
      ])('%s', async (_title, fastModel) => {
        expect((await convertFast(fastModel)).modelConfig.model).toBe(
          'fast-model-id',
        );
      });

      it('should leave modelConfig empty for "fast" when getFastModel returns undefined', async () => {
        // Mirrors the unset / invalid-for-authType cases: AgentCore then falls
        // back to runtimeContext.getModel() (the parent model).
        expect((await convertFast(undefined)).modelConfig).toEqual({});
      });

      it('should leave modelConfig empty for "fast" when no runtimeContext is provided', async () => {
        expect((await convert({ model: 'fast' })).modelConfig).toEqual({});
      });

      // --- CC 2.1.168 maxTurns top-level promotion ---

      it.each<[string, Partial<SubagentConfig>, number | undefined]>([
        [
          'should populate runConfig.max_turns from top-level maxTurns',
          { maxTurns: 42 },
          42,
        ],
        [
          'should prefer top-level maxTurns over nested runConfig.max_turns',
          { maxTurns: 99, runConfig: { max_turns: 5 } },
          99,
        ],
        [
          'should fall back to nested runConfig.max_turns when maxTurns is unset',
          { runConfig: { max_turns: 7 } },
          7,
        ],
        ['should leave max_turns undefined when neither is set', {}, undefined],
      ])('%s', async (_title, extra, maxTurns) => {
        expect((await convert(extra)).runConfig.max_turns).toBe(maxTurns);
      });
    });

    describe('mergeConfigurations', () => {
      it('should merge basic properties', () => {
        const merged = manager.mergeConfigurations(validConfig, {
          description: 'Updated description',
          systemPrompt: 'Updated prompt',
        });

        expect(merged.description).toBe('Updated description');
        expect(merged.systemPrompt).toBe('Updated prompt');
        expect(merged.name).toBe(validConfig.name); // Should keep original
      });

      it('should merge nested configurations', () => {
        const merged = manager.mergeConfigurations(
          {
            ...validConfig,
            model: 'original-model',
            runConfig: { max_time_minutes: 10, max_turns: 20 },
          },
          { model: 'updated-model', runConfig: { max_time_minutes: 5 } },
        );

        expect(merged.model).toBe('updated-model');
        expect(merged.runConfig!.max_time_minutes).toBe(5); // Should update
        expect(merged.runConfig!.max_turns).toBe(20); // Should keep original
      });
    });

    describe('createAgentHeadless — external executor dispatch', () => {
      const executorConfig: SubagentConfig = {
        name: 'external-agent',
        description: 'Runs somewhere else',
        systemPrompt: 'You are external.',
        level: 'session' as const,
        executor: { kind: 'acp', command: 'npx', args: ['-y', 'some-acp'] },
      };
      const stubExecutor = (create = vi.fn()) => {
        vi.spyOn(mockConfig, 'getExternalAgentExecutor').mockReturnValue({
          create,
        });
        return create;
      };
      const dispatch = (
        extra: Partial<SubagentConfig> = {},
        options?: Parameters<SubagentManager['createAgentHeadless']>[2],
      ) =>
        manager.createAgentHeadless(
          { ...executorConfig, ...extra },
          mockConfig,
          options,
        );

      const expectNoSetup = (...others: unknown[]) =>
        expectNotCalled(
          ...others,
          mockToolRegistry.warmAll,
          mockCreateContentGenerator,
          mockAgentHeadlessCreate,
        );

      afterEach(() => {
        mockAgentHeadlessCreate.mockReset();
        vi.restoreAllMocks();
      });

      it.each([
        { executor: executorConfig.executor },
        { mcpServers: { remote: { command: 'node' } } },
        { hooks: { Stop: [] } },
      ])(
        'rejects sandbox child overrides %j before invoking any executor',
        async (overrides) => {
          vi.spyOn(mockConfig, 'getShellExecutionSandbox').mockReturnValue(
            {} as NonNullable<ReturnType<Config['getShellExecutionSandbox']>>,
          );
          const externalCreate = stubExecutor();
          await expect(
            dispatch({ executor: undefined, ...overrides } as SubagentConfig),
          ).rejects.toThrow(
            'does not support agent executors, MCP servers or hooks',
          );
          expectNotCalled(
            externalCreate,
            mockAgentHeadlessCreate,
            mockToolRegistry.warmAll,
          );
        },
      );

      it('refuses to run in-process when no executor is registered', async () => {
        vi.spyOn(mockConfig, 'getExternalAgentExecutor').mockReturnValue(
          undefined,
        );

        await expect(dispatch()).rejects.toThrow(
          /registered no external agent executor/,
        );

        // Load-bearing: it must NOT silently substitute the in-process
        // executor, which would bill the wrong provider and report the wrong
        // agent, with no signal either way.
        expectNoSetup();
      });

      it.each([null, false, 0, '', {}, { kind: 'ACP', command: 'npx' }])(
        'rejects injected executor %j without side effects',
        async (executor) => {
          const create = stubExecutor();
          manager.loadSessionSubagents([
            { ...executorConfig, executor } as unknown as SubagentConfig,
          ]);
          const loaded = await manager.loadSubagent(
            executorConfig.name,
            'session',
          );
          await expect(
            manager.createAgentHeadless(loaded!, mockConfig),
          ).rejects.toThrow(/failed validation/);
          expectNoSetup(create);
        },
      );

      it.each([
        { tools: [] },
        { tools: ['read_file'] },
        { disallowedTools: ['write_file'] },
        { mcpServers: { server: { command: 'node' } } },
        { hooks: { PreToolUse: [] } },
        { model: 'anthropic:claude' },
        { maxTurns: 3 },
        { runConfig: { max_turns: 3 } },
      ])(
        'rejects unsupported definition %j before factory or setup',
        async (extra) => {
          const create = stubExecutor();
          const hooks = vi.spyOn(mockConfig, 'getHookSystem');
          await expect(dispatch(extra)).rejects.toThrow(/does not support/);
          expectNoSetup(create, hooks);
        },
      );

      it.each([
        { toolConfigOverride: { tools: ['structured_output'] } },
        { promptConfigOverrides: { initialMessages: [] } },
        { promptConfigOverrides: { renderedSystemPrompt: 'schema' } },
        { runtimeAuthOverrides: { authType: 'anthropic' } },
        { modelConfigOverrides: { model: 'claude' } },
        {
          modelConfigOverrides: { temperature: 0.5 } as unknown as {
            model?: string;
          },
        },
        { hooks: { onStop: vi.fn() } },
        { runConfigOverrides: { max_turns: 3 } },
      ])('rejects unsupported options %j before factory', async (options) => {
        const create = stubExecutor();
        await expect(
          manager.createAgentHeadless(executorConfig, mockConfig, options),
        ).rejects.toThrow(/does not support/);
        expectNotCalled(create, mockCreateContentGenerator);
      });

      it.each(['project', 'builtin'] as const)(
        'refuses %s executables in an untrusted workspace',
        async (level) => {
          const create = stubExecutor();
          vi.spyOn(mockConfig, 'isTrustedFolder').mockReturnValue(false);
          await expect(dispatch({ level })).rejects.toThrow(
            /untrusted project/,
          );
          expect(create).not.toHaveBeenCalled();
        },
      );

      it('refuses an external executor in safe mode even in a trusted folder (R8-2)', async () => {
        const create = stubExecutor();
        vi.spyOn(mockConfig, 'isTrustedFolder').mockReturnValue(true);
        vi.spyOn(mockConfig, 'isSafeMode').mockReturnValue(true);
        // Safe mode promises only built-in subagents and no repo-supplied
        // execution; discovery filtering does not stop loadSubagent resolving a
        // repo-shipped executor definition from disk, so the dispatch gate
        // refuses it even in a trusted folder.
        await expect(dispatch({ level: 'project' })).rejects.toThrow(
          /safe mode/,
        );
        expectNotCalled(create, mockAgentHeadlessCreate);
      });

      it.each(['executor', 'mcpServers', 'hooks'] as const)(
        'refuses container-incompatible %s for direct manager callers',
        async (field) => {
          mockConfig.getExecutionEnvironment = () =>
            ({}) as ExecutionEnvironment;
          await expect(
            dispatch({
              executor: undefined,
              [field]: field === 'executor' ? executorConfig.executor : {},
            }),
          ).rejects.toThrow('container execution does not support');
          expect(mockAgentHeadlessCreate).not.toHaveBeenCalled();
        },
      );

      it('preserves external factory errors without AgentHeadless labeling', async () => {
        const error = new Error('spawn ENOENT');
        stubExecutor(vi.fn().mockRejectedValue(error));
        await expect(dispatch()).rejects.toBe(error);
      });

      it('composes external disposal and propagates its error', async () => {
        const error = new Error('dispose failed');
        const dispose = vi.fn().mockRejectedValue(error);
        const create = stubExecutor(vi.fn().mockResolvedValue({ dispose }));
        const result = await dispatch(
          { model: 'inherit' },
          {
            modelConfigOverrides: {},
            runConfigOverrides: { max_time_minutes: 2 },
          },
        );
        expect(create.mock.calls[0][0]).toMatchObject({
          modelConfig: {},
          runConfig: { max_time_minutes: 2 },
          toolConfig: { disallowedTools: [ToolNames.ASK_USER_QUESTION] },
        });
        expect(mockCreateContentGenerator).not.toHaveBeenCalled();
        await expect(result.dispose()).rejects.toBe(error);
        expect(dispose).toHaveBeenCalledOnce();
      });

      it('derives the peer permission mode from the host-resolved approval policy, not the raw definition', async () => {
        const create = stubExecutor(vi.fn().mockResolvedValue({}));
        // The definition asks for the most permissive mode; the host clamped
        // the policy to DEFAULT (resolveSubagentApprovalMode stamps it on the
        // runtimeContext). The executor must get the clamped policy, so a
        // definition cannot escalate past the parent session's limit.
        vi.spyOn(mockConfig, 'getApprovalMode').mockReturnValue(
          ApprovalMode.DEFAULT,
        );
        await dispatch({ approvalMode: 'yolo' });
        expect(create.mock.calls[0]![0]).toMatchObject({
          approvalMode: ApprovalMode.DEFAULT,
        });
      });

      it('re-validates the executor block at the consumption point', async () => {
        // Session-level subagents are injected as plain objects and spread
        // verbatim by loadSessionSubagents, bypassing frontmatter parsing, so
        // an arbitrarily shaped executor can reach the dispatch.
        await expect(
          dispatch({
            executor: { kind: 'acp', command: '   ' },
          } as unknown as SubagentConfig),
        ).rejects.toThrow(/failed validation/);
        expect(mockAgentHeadlessCreate).not.toHaveBeenCalled();
      });

      it('dispatches to the registered executor with the validated spec', async () => {
        const externalSubagent = { execute: vi.fn() };
        const create = stubExecutor(
          vi.fn().mockResolvedValue(externalSubagent as never),
        );

        const result = await dispatch();

        expect(result.subagent).toBe(externalSubagent);
        expect(mockAgentHeadlessCreate).not.toHaveBeenCalled();
        expect(create.mock.calls[0][0]).toMatchObject({
          spec: { kind: 'acp', command: 'npx', args: ['-y', 'some-acp'] },
          name: 'external-agent',
        });
      });

      it('leaves the in-process path untouched when no executor is declared', async () => {
        mockAgentHeadlessCreate.mockResolvedValue({
          execute: vi.fn(),
        } as never);
        const create = stubExecutor();

        await dispatch({ executor: undefined });

        expect(mockAgentHeadlessCreate).toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
      });
    });

    describe('createAgentHeadless model override', () => {
      const agentConfig: SubagentConfig = {
        name: 'model-test-agent',
        description: 'Test agent',
        systemPrompt: 'You are a test agent.',
        level: 'session' as const,
      };
      const createAgent = (
        extra: Partial<SubagentConfig> = {},
        options?: Parameters<SubagentManager['createAgentHeadless']>[2],
      ) =>
        manager.createAgentHeadless(
          { ...agentConfig, ...extra },
          mockConfig,
          options,
        );
      const effortOnly = () =>
        createAgent({}, { modelConfigOverrides: { reasoningEffort: 'low' } });
      // The owner is the runtimeContext passed to createAgentHeadless: asserting
      // the exact instance catches a swap to a different Config (the override).
      const expectGeneratorFor = (
        fields: Record<string, unknown>,
        ...rest: unknown[]
      ) =>
        expect(mockCreateContentGenerator).toHaveBeenCalledWith(
          expect.objectContaining(fields),
          mockConfig,
          ...rest,
        );
      const createFast = (fastModel: string | undefined) => {
        vi.spyOn(mockConfig, 'getFastModel').mockReturnValue(fastModel);
        return createAgent({ model: 'fast' });
      };
      const stubParentAuth = (model: string, authType: AuthType) =>
        vi.spyOn(mockConfig, 'getContentGeneratorConfig').mockReturnValue({
          model,
          authType,
          apiKey: 'parent-key',
        });
      const stubResolvedModel = (resolved: unknown) =>
        vi.spyOn(mockConfig, 'getModelsConfig').mockReturnValue({
          getResolvedModel: vi.fn().mockReturnValue(resolved),
          getGenerationConfig: vi.fn().mockReturnValue({}),
        } as unknown as ReturnType<Config['getModelsConfig']>);

      beforeEach(() => {
        mockAgentHeadlessCreate.mockResolvedValue({
          execute: vi.fn(),
          getResult: vi.fn(),
        });
        mockCreateContentGenerator.mockResolvedValue({
          generateContentStream: vi.fn(),
        });
        stubParentAuth('parent-model', AuthType.USE_OPENAI);
        stubResolvedModel(undefined);
      });

      afterEach(() => {
        mockAgentHeadlessCreate.mockReset();
        mockCreateContentGenerator.mockReset();
      });

      it('removes the interactive question tool from regular subagents', async () => {
        await createAgent({
          tools: [ToolNames.READ_FILE, ToolNames.ASK_USER_QUESTION],
          disallowedTools: [ToolNames.EDIT],
        });

        expect(destructureAgentHeadlessCall().toolConfig).toEqual({
          tools: [ToolNames.READ_FILE, ToolNames.ASK_USER_QUESTION],
          disallowedTools: [ToolNames.EDIT, ToolNames.ASK_USER_QUESTION],
        });
      });

      it('should create a new ContentGenerator for bare model IDs', async () => {
        await createAgent({ model: 'custom-model' });
        expectGeneratorFor({ model: 'custom-model' });
      });

      it('should create a new ContentGenerator for cross-provider selectors', async () => {
        await createAgent({ model: 'anthropic:claude-sonnet' });
        expectGeneratorFor({ model: 'claude-sonnet', authType: 'anthropic' });
      });

      it('should NOT create a new ContentGenerator for inherit', async () => {
        await createAgent({ model: 'inherit' });
        expect(mockCreateContentGenerator).not.toHaveBeenCalled();
      });

      it('should snapshot the launch provider when inherit receives a concrete model override', async () => {
        const launch = {
          authType: AuthType.USE_ANTHROPIC,
          baseUrl: 'https://launch-provider.example.com',
        };
        await createAgent(
          { model: 'inherit' },
          {
            modelConfigOverrides: { model: 'launch-model' },
            runtimeAuthOverrides: launch,
          },
        );

        expectGeneratorFor({ model: 'launch-model', ...launch });
      });

      it('should NOT create a new ContentGenerator when model is omitted', async () => {
        await createAgent();
        expect(mockCreateContentGenerator).not.toHaveBeenCalled();
      });

      // A per-agent reasoning effort needs its own content generator even on
      // the parent's model: the tier goes onto the agent's copy of the config;
      // the session config it would otherwise share must never receive it.
      it('should create a ContentGenerator on the parent model for a reasoning effort alone', async () => {
        const parent = mockConfig.getContentGeneratorConfig();

        await effortOnly();

        expectGeneratorFor(
          { model: 'parent-model', reasoning: { effort: 'low' } },
          true,
        );
        expect(destructureAgentHeadlessCall().runtimeView).toBeDefined();
        expect(parent.reasoning).toBeUndefined();
      });

      // A tier the session's model cannot take changes nothing, so it must not
      // cost the agent a ContentGenerator of its own.
      it('should NOT create a ContentGenerator for a tier the model cannot take', async () => {
        stubResolvedModel({
          capabilities: {
            reasoning: {
              thinking: true,
              toggleOnly: true,
              disableField: 'enable_thinking',
            },
          },
        });

        await effortOnly();

        expect(mockCreateContentGenerator).not.toHaveBeenCalled();
        expect(destructureAgentHeadlessCall().runtimeView).toBeUndefined();
      });

      // A tier alone is no reason to log in, and no reason to fail the
      // dispatch: a failed build leaves the agent on the session's generator.
      it('should run an effort-only agent on the session generator when its own cannot be built', async () => {
        mockCreateContentGenerator.mockRejectedValueOnce(
          new Error('Qwen OAuth credentials expired.'),
        );

        await effortOnly();

        expect(mockCreateContentGenerator).toHaveBeenCalledWith(
          expect.anything(),
          mockConfig,
          true,
        );
        expect(destructureAgentHeadlessCall().runtimeView).toBeUndefined();
      });

      it('should carry a reasoning effort alongside a model override', async () => {
        await createAgent(
          { model: 'custom-model' },
          { modelConfigOverrides: { reasoningEffort: 'max' } },
        );

        expectGeneratorFor({
          model: 'custom-model',
          reasoning: { effort: 'max' },
        });
      });

      // A deny that matches nothing silently leaves the agent the tool. Only an
      // entry that is neither an MCP pattern, a built-in tool (registered here
      // or not), nor a registered tool's name or display name comes back.
      it('finds the deny entries that match no tool', async () => {
        await expect(
          manager.findUnmatchedToolNames([
            'Write File',
            'grep',
            'edit',
            'Shell',
            'mcp__github',
            'mcp__github__*',
            'Bash',
            'run_shell',
          ]),
        ).resolves.toEqual(['Bash', 'run_shell']);
      });

      // An allowlist holds exact names, so its caller asks for mcp__ entries
      // to be looked up too rather than waved through as patterns.
      it('looks up mcp__ entries when asked to check MCP names', async () => {
        vi.mocked(mockToolRegistry.getAllTools).mockReturnValue([
          { name: 'read_file', displayName: 'Read File' },
          {
            name: 'mcp__warehouse__query',
            displayName: 'query (warehouse MCP Server)',
          },
        ] as unknown as ReturnType<ToolRegistry['getAllTools']>);

        await expect(
          manager.findUnmatchedToolNames(
            [
              'mcp__warehouse__query',
              'query (warehouse MCP Server)',
              'mcp__warehouse__drop',
              'Shell',
            ],
            { checkMcpNames: true },
          ),
        ).resolves.toEqual(['mcp__warehouse__drop']);
        await expect(
          manager.findUnmatchedToolNames(['mcp__warehouse__drop']),
        ).resolves.toEqual([]);
      });

      // Callers that narrow a pool resolve their lists the way the agent's own
      // config does: tool name first, then display name, anything else as given.
      it('resolves tool and display names to tool names and keeps the rest', async () => {
        await expect(
          manager.resolveToolNames([
            'read_file',
            'Write File',
            'mcp__github__*',
            'Bash',
          ]),
        ).resolves.toEqual([
          'read_file',
          'write_file',
          'mcp__github__*',
          'Bash',
        ]);
        expect(mockToolRegistry.warmAll).toHaveBeenCalled();
      });

      it('should pass the agent runtimeView to AgentHeadless.create', async () => {
        const fakeGenerator = { generateContentStream: vi.fn() };
        mockCreateContentGenerator.mockResolvedValue(fakeGenerator);

        await createAgent({ model: 'custom-model' });

        const { runtimeContext, runtimeView } = destructureAgentHeadlessCall();
        // Subagents always get a derived wrapper for child-local state: a
        // distinct instance whose prototype is the parent.
        expect(runtimeContext).not.toBe(mockConfig);
        expect(Object.getPrototypeOf(runtimeContext)).toBe(mockConfig);
        expect(runtimeView).toBeDefined();
        expect(runtimeView!.contentGenerator).toBe(fakeGenerator);
        expect(runtimeView!.contentGeneratorConfig.model).toBe('custom-model');
      });

      it('should build a ContentGenerator with the resolved fastModel when model is "fast"', async () => {
        await createFast('fast-model-id');

        expectGeneratorFor({
          model: 'fast-model-id',
          authType: AuthType.USE_OPENAI,
        });
      });

      it('should build a cross-auth ContentGenerator when "fast" resolves to an authType-qualified selector', async () => {
        stubParentAuth('parent-model', AuthType.USE_ANTHROPIC);

        await createFast('openai:deepseek-v4-flash');

        expectGeneratorFor({
          model: 'deepseek-v4-flash',
          authType: AuthType.USE_OPENAI,
        });
      });

      it('should resolve bare fast models to their configured auth type when current auth does not own them', async () => {
        stubParentAuth('claude-opus', AuthType.USE_ANTHROPIC);
        vi.spyOn(mockConfig, 'getAllConfiguredModels').mockImplementation(
          (authTypes) =>
            authTypes?.includes(AuthType.USE_ANTHROPIC)
              ? []
              : [
                  {
                    id: 'deepseek-v4-flash',
                    label: 'deepseek-v4-flash',
                    authType: AuthType.USE_OPENAI,
                  },
                ],
        );

        await createFast('deepseek-v4-flash');

        expectGeneratorFor({
          model: 'deepseek-v4-flash',
          authType: AuthType.USE_OPENAI,
        });
      });

      it('should NOT build a new ContentGenerator for "fast" when getFastModel returns undefined', async () => {
        await createFast(undefined);

        // Falls back to inheriting the parent: no override, no runtimeView.
        expect(mockCreateContentGenerator).not.toHaveBeenCalled();
        expect(destructureAgentHeadlessCall().runtimeView).toBeUndefined();
      });
    });

    describe('createAgentHeadless — caller-driven dispose contract', () => {
      // Regression for self-inflicted leaks (review #4996 round 1):
      //   1. `wrapAgentHooksForCleanup` relied on AgentHeadless.execute()'s
      //      inner finally firing `onStop`; early exits (`createChat()` → null,
      //      `prepareTools()` throwing) bypass it, leaking hook entries into
      //      the global registry for the rest of the session.
      //   2. The per-agent `mcpServers` registry rebuild spawned real MCP
      //      clients (stdio children, sockets) that nothing stopped: orphaned
      //      server processes on every invocation.
      // The fix returns `{ subagent, dispose }`; callers run `dispose()` in
      // the `finally` they already own around `subagent.execute()`.

      const baseConfig: SubagentConfig = {
        name: 'cleanup-agent',
        description: 'dispose contract test',
        systemPrompt: 'You are a test agent.',
        level: 'session' as const,
      };
      const stubHookRegistry = (unregister = vi.fn()) => {
        const addAgentHooks = vi.fn().mockReturnValue(unregister);
        vi.spyOn(mockConfig, 'getHookSystem').mockReturnValue({
          getRegistry: () => ({ addAgentHooks }),
        } as unknown as ReturnType<Config['getHookSystem']>);
        return addAgentHooks;
      };
      const createHooked = (matcher: string, extra = {}) =>
        manager.createAgentHeadless(
          { ...baseConfig, ...extra, hooks: echoHooks(matcher) },
          mockConfig,
        );

      beforeEach(() => {
        mockAgentHeadlessCreate.mockResolvedValue({
          execute: vi.fn(),
          getResult: vi.fn(),
          getCore: () => ({ subagentId: 'created-agent-id' }),
        });
      });

      afterEach(() => {
        mockAgentHeadlessCreate.mockReset();
      });

      it('returns { subagent, dispose }; dispose unregisters per-agent hooks', async () => {
        const unregisterSpy = vi.fn();
        const addAgentHooksSpy = stubHookRegistry(unregisterSpy);

        const result = await createHooked('Bash');

        // Callers need an explicit cleanup handle for the outer `finally`. The
        // pre-fix return shape (just `AgentHeadless`) gave them none, and the
        // inner onStop wrap doesn't fire on every execute() exit path.
        expect(result).toHaveProperty('subagent');
        expect(result).toHaveProperty('dispose');
        expect(typeof result.dispose).toBe('function');
        expect(addAgentHooksSpy).toHaveBeenCalledTimes(1);
        expect(addAgentHooksSpy.mock.calls[0][2].owner).toEqual({
          sessionId: mockConfig.getSessionId(),
          agentId: 'created-agent-id',
        });
        expect(unregisterSpy).not.toHaveBeenCalled();

        await result.dispose();

        expect(unregisterSpy).toHaveBeenCalledTimes(1);
      });

      it('assigns distinct explicit identities when the caller omits an id', async () => {
        const addAgentHooks = vi.fn().mockReturnValue(vi.fn());
        vi.spyOn(mockConfig, 'getHookSystem').mockReturnValue({
          getRegistry: () => ({ addAgentHooks }),
        } as unknown as ReturnType<Config['getHookSystem']>);
        mockAgentHeadlessCreate.mockImplementation(
          async (...args: unknown[]) => ({
            getCore: () => ({ subagentId: args[10] }),
          }),
        );
        const config: SubagentConfig = {
          ...baseConfig,
          hooks: {
            PreToolUse: [{ hooks: [{ type: 'command', command: 'echo' }] }],
          },
        };
        const first = await manager.createAgentHeadless(config, mockConfig);
        const second = await manager.createAgentHeadless(config, mockConfig);
        const firstId = mockAgentHeadlessCreate.mock.calls[0][10];
        const secondId = mockAgentHeadlessCreate.mock.calls[1][10];
        expect(firstId).toMatch(/^cleanup-agent-[a-f0-9]{8}$/);
        expect(secondId).not.toBe(firstId);
        expect(addAgentHooks.mock.calls[0][2].owner.agentId).toBe(firstId);
        expect(addAgentHooks.mock.calls[1][2].owner.agentId).toBe(secondId);
        await first.dispose();
        await second.dispose();
      });

      it('keeps the invocation session when construction overlaps a session change', async () => {
        const session = vi
          .spyOn(mockConfig, 'getSessionId')
          .mockReturnValue('before');
        const addAgentHooks = vi.fn().mockReturnValue(vi.fn());
        vi.spyOn(mockConfig, 'getHookSystem').mockReturnValue({
          getRegistry: () => ({ addAgentHooks }),
        } as unknown as ReturnType<Config['getHookSystem']>);
        mockAgentHeadlessCreate.mockImplementationOnce(async () => {
          session.mockReturnValue('after');
          return { getCore: () => ({ subagentId: 'actual-id' }) };
        });
        const result = await manager.createAgentHeadless(
          {
            ...baseConfig,
            hooks: {
              PreToolUse: [{ hooks: [{ type: 'command', command: 'echo' }] }],
            },
          },
          mockConfig,
          { subagentId: 'requested-id' },
        );
        expect(addAgentHooks.mock.calls[0][2]).toEqual({
          owner: { sessionId: 'before', agentId: 'actual-id' },
          isSourceTrusted: undefined,
        });
        await result.dispose();
      });

      it('does not register hooks for a project-level subagent in an untrusted folder', async () => {
        const addAgentHooksSpy = stubHookRegistry();
        vi.spyOn(mockConfig, 'isTrustedFolder').mockReturnValue(false);

        const result = await createHooked('Bash', { level: 'project' });

        expect(addAgentHooksSpy).not.toHaveBeenCalled();
        // The agent itself is still created: only the hooks are gated.
        expect(result).toHaveProperty('subagent');
        await result.dispose();
      });

      it('registers hooks for a project-level subagent in a trusted folder', async () => {
        const addAgentHooksSpy = stubHookRegistry();
        vi.spyOn(mockConfig, 'isTrustedFolder').mockReturnValue(true);

        const result = await createHooked('Bash', { level: 'project' });

        expect(addAgentHooksSpy).toHaveBeenCalledTimes(1);
        const registration = addAgentHooksSpy.mock.calls[0][2];
        expect(registration.isSourceTrusted()).toBe(true);
        vi.mocked(mockConfig.isTrustedFolder).mockReturnValue(false);
        expect(registration.isSourceTrusted()).toBe(false);
        await result.dispose();
      });

      it('binds trust to the source manager even when the runtime has different trust', async () => {
        const addAgentHooks = vi.fn().mockReturnValue(vi.fn());
        const runtime = Object.create(mockConfig) as Config;
        runtime.getHookSystem = () =>
          ({ getRegistry: () => ({ addAgentHooks }) }) as unknown as ReturnType<
            Config['getHookSystem']
          >;
        runtime.isTrustedFolder = () => true;
        const sourceTrust = vi
          .spyOn(mockConfig, 'isTrustedFolder')
          .mockReturnValue(false);
        const config: SubagentConfig = {
          ...baseConfig,
          level: 'project',
          hooks: {
            PreToolUse: [{ hooks: [{ type: 'command', command: 'echo' }] }],
          },
        };
        const untrusted = await manager.createAgentHeadless(config, runtime);
        expect(addAgentHooks).not.toHaveBeenCalled();
        await untrusted.dispose();
        sourceTrust.mockReturnValue(true);
        runtime.isTrustedFolder = () => false;
        const trusted = await manager.createAgentHeadless(config, runtime);
        expect(addAgentHooks).toHaveBeenCalledOnce();
        const registration = addAgentHooks.mock.calls[0][2];
        expect(registration.isSourceTrusted()).toBe(true);
        sourceTrust.mockReturnValue(false);
        expect(registration.isSourceTrusted()).toBe(false);
        await trusted.dispose();
      });

      it('dispose unregisters even when execute() never runs (early-exit leak fix)', async () => {
        // Caller pattern: `try { await subagent.execute() } finally { await
        // dispose() }`. execute() never runs here, as on the
        // createChat-returns-null and prepareTools-throws paths where the old
        // `onStop` wrap never fired.
        const unregisterSpy = vi.fn();
        stubHookRegistry(unregisterSpy);

        const { dispose } = await createHooked('*');

        await dispose();
        expect(unregisterSpy).toHaveBeenCalledTimes(1);
      });

      it('dispose is a safe no-op when neither hooks nor mcpServers are declared', async () => {
        const result = await manager.createAgentHeadless(
          baseConfig,
          mockConfig,
        );
        expect(typeof result.dispose).toBe('function');
        // Must not throw: the caller's `finally` always invokes dispose, even
        // for agents that triggered no cleanup-bearing setup.
        await expect(result.dispose()).resolves.toBeUndefined();
      });

      it('runs cleanup when AgentHeadless.create throws — caller never gets dispose', async () => {
        // The caller never receives `{ subagent, dispose }`, so the inner catch
        // must clean up itself, or a transient create failure (e.g.
        // ContentGenerator init) orphans the hook entries just registered.
        const unregisterSpy = vi.fn();
        stubHookRegistry(unregisterSpy);
        mockAgentHeadlessCreate.mockRejectedValueOnce(
          new Error('synthetic constructor failure'),
        );

        await expect(createHooked('*')).rejects.toThrow(
          /synthetic constructor failure/,
        );
        expect(unregisterSpy).not.toHaveBeenCalled();
      });
    });

    // #12424: a subagent whose tool policy leaves it no Skill tool must not
    // hold a SkillManager, or the nested Agent tool's description points it
    // at the agent-delegation skill it cannot load.
    describe('createAgentHeadless — SkillManager follows the tool policy', () => {
      const baseConfig: SubagentConfig = {
        name: 'skill-policy-agent',
        description: 'skill policy test',
        systemPrompt: 'You are a test agent.',
        level: 'session' as const,
      };
      const sessionManager = {} as SkillManager;

      beforeEach(() => {
        mockAgentHeadlessCreate.mockResolvedValue({
          execute: vi.fn(),
          getResult: vi.fn(),
        });
        vi.spyOn(mockConfig, 'getSkillManager').mockReturnValue(sessionManager);
        // The nested Agent tool subscribes to the subagent manager.
        vi.spyOn(mockConfig, 'getSubagentManager').mockReturnValue(manager);
        // The Agent-tool launch path: the per-launch wrapper already rebuilt
        // its registry, so an unrestricted agent skips its own rebuild.
        (mockConfig as unknown as Record<symbol, unknown>)[
          TOOL_REGISTRY_REBUILT
        ] = true;
      });

      afterEach(() => {
        mockAgentHeadlessCreate.mockReset();
      });

      async function launchHandle(
        config: Partial<SubagentConfig>,
        parent: Config = mockConfig,
      ): Promise<{ context: Config; dispose: () => Promise<void> }> {
        mockAgentHeadlessCreate.mockClear();
        const { dispose } = await manager.createAgentHeadless(
          { ...baseConfig, ...config },
          parent,
        );
        return {
          context: destructureAgentHeadlessCall(
            mockAgentHeadlessCreate.mock.calls[0],
          ).runtimeContext as Config,
          dispose,
        };
      }

      async function launch(
        config: Partial<SubagentConfig>,
        parent: Config = mockConfig,
      ): Promise<Config> {
        return (await launchHandle(config, parent)).context;
      }

      it('keeps the session manager and the wrapper registry for an unrestricted agent', async () => {
        const context = await launch({});
        expect(context.getSkillManager()).toBe(sessionManager);
        expect(context.getToolRegistry()).toBe(mockToolRegistry);
      });

      it.each([
        ['an allowlist without skill', { tools: [ToolNames.READ_FILE] }],
        ['a blocklist naming skill', { disallowedTools: [ToolNames.SKILL] }],
      ])(
        'withholds the manager and inlines the delegation guidance for %s',
        async (_label, config) => {
          const context = await launch(config);
          expect(context.getSkillManager()).toBeNull();
          expect(resolveAgentDelegationSurface(context)).toBe('inline');
          // The nested Agent tool is built lazily by the agent's registry. It
          // must be rebuilt on this Config, or the tool reads the wrapper's
          // manager and still points at the skill.
          expect(context.getToolRegistry()).not.toBe(mockToolRegistry);
          // SkillTool cannot be built without a manager; not registering it
          // keeps every warmAll() from retrying a factory that throws.
          expect(context.getToolRegistry().getAllToolNames()).not.toContain(
            ToolNames.SKILL,
          );
          const agentTool = (await context
            .getToolRegistry()
            .ensureTool(ToolNames.AGENT)) as AgentTool;
          await agentTool.refreshSubagents();
          expect(agentTool.description).toContain(
            'Skills cannot be loaded in this session',
          );
        },
      );

      it('points at the delegation skill when the agent can load it', async () => {
        const context = await launch({
          tools: [ToolNames.READ_FILE, ToolNames.SKILL],
        });
        expect(context.getSkillManager()).toBe(sessionManager);
        // Positive, not `not.toBe('inline')`: 'withheld' also passes that,
        // and it is the one surface where the nested Agent tool's description
        // carries no delegation guidance at all.
        expect(resolveAgentDelegationSurface(context)).toBe('pointer');
      });

      it('restores the session manager for a nested agent that can load skills', async () => {
        const child = await launch({ tools: [ToolNames.READ_FILE] });
        const grandchild = await launch({}, child);
        expect(grandchild.getSkillManager()).toBe(sessionManager);
        expect(grandchild.getToolRegistry()).not.toBe(child.getToolRegistry());
        expect(grandchild.getToolRegistry().getAllToolNames()).toContain(
          ToolNames.SKILL,
        );
      });

      it('leaves a nested agent that also cannot load skills on its parent registry', async () => {
        const child = await launch({ tools: [ToolNames.READ_FILE] });
        const grandchild = await launch(
          { disallowedTools: [ToolNames.SKILL] },
          child,
        );
        expect(grandchild.getSkillManager()).toBeNull();
        expect(grandchild.getToolRegistry()).toBe(child.getToolRegistry());
      });

      // The intermediate also withholds, so it records NO own
      // SESSION_SKILL_MANAGER symbol; the great-grandchild recovers the
      // session manager only because the lookup walks the prototype chain to
      // the child's record. Narrowing that lookup to Object.hasOwn (or
      // deriving Configs without Object.create) turns this red while both
      // two-level tests above stay green.
      it('restores the session manager three levels down, past a non-reanchoring intermediate', async () => {
        const child = await launch({ tools: [ToolNames.READ_FILE] });
        const grandchild = await launch(
          { disallowedTools: [ToolNames.SKILL] },
          child,
        );
        expect(grandchild.getSkillManager()).toBeNull();

        const greatGrandchild = await launch({}, grandchild);
        expect(greatGrandchild.getSkillManager()).toBe(sessionManager);
        expect(greatGrandchild.getToolRegistry().getAllToolNames()).toContain(
          ToolNames.SKILL,
        );
      });

      // Under CodeModeOnly an explicit list naming `exec` inherits every
      // code-mode-callable binding, `skill` included, so the agent can load
      // skills through the exec gateway and must keep its manager. The parent
      // is a real CodeModeOnly Config: dropping the tool-mode argument at the
      // createAgentHeadless call site turns this case red.
      it('keeps the manager for an exec-only agent under CodeModeOnly', async () => {
        const codeModeParent = makeFakeConfig({ codeModeOnly: true });
        vi.spyOn(codeModeParent, 'getSkillManager').mockReturnValue(
          sessionManager,
        );
        vi.spyOn(codeModeParent, 'getSubagentManager').mockReturnValue(manager);
        vi.spyOn(codeModeParent, 'getToolRegistry').mockReturnValue(
          mockToolRegistry,
        );

        const context = await launch(
          { tools: [ToolNames.EXEC] },
          codeModeParent,
        );
        expect(context.getSkillManager()).toBe(sessionManager);
        expect(context.getToolRegistry().getAllToolNames()).toContain(
          ToolNames.SKILL,
        );
      });

      // The rebuilt registry's tools are per-subagent instances: the nested
      // Agent tool subscribes to the *shared session* SubagentManager in its
      // constructor and releases only in dispose(), which is what
      // ToolRegistry.stop() calls. Without the cleanup wiring every
      // skill-withholding launch leaves a listener behind for the rest of the
      // process.
      it.each([
        ['an allowlist without skill', { tools: [ToolNames.READ_FILE] }],
        ['a blocklist naming skill', { disallowedTools: [ToolNames.SKILL] }],
      ])(
        'stops the registry it rebuilt to withhold the manager for %s',
        async (_label, config) => {
          const { context, dispose } = await launchHandle(config);
          expect(context.getToolRegistry()).not.toBe(mockToolRegistry);
          const stop = vi
            .spyOn(context.getToolRegistry(), 'stop')
            .mockResolvedValue(undefined);

          await dispose();

          expect(stop).toHaveBeenCalledTimes(1);
        },
      );

      it('stops the registry it rebuilt to restore a nested agent manager', async () => {
        const child = await launch({ tools: [ToolNames.READ_FILE] });
        const { context: grandchild, dispose } = await launchHandle({}, child);
        expect(grandchild.getToolRegistry()).not.toBe(child.getToolRegistry());
        const stop = vi
          .spyOn(grandchild.getToolRegistry(), 'stop')
          .mockResolvedValue(undefined);

        await dispose();

        expect(stop).toHaveBeenCalledTimes(1);
      });

      it('stops the registry it rebuilt for an unstamped parent whose policy allows skills', async () => {
        // The third cleanup trigger: a runtimeContext with no
        // TOOL_REGISTRY_REBUILT stamp (any caller other than the Agent-tool
        // per-launch wrapper). The policy allows skills, so nothing
        // re-anchors — the rebuild happens only because the parent is
        // unstamped, and that registry is still this launch's to stop (its
        // per-subagent AgentTool subscribes to the shared session
        // SubagentManager and releases only via ToolRegistry.stop()).
        // Narrowing the cleanup condition to `reanchorSkillManager` turns
        // this red while every case above stays green.
        const unstampedParent = makeFakeConfig({});
        vi.spyOn(unstampedParent, 'getSkillManager').mockReturnValue(
          sessionManager,
        );
        vi.spyOn(unstampedParent, 'getSubagentManager').mockReturnValue(
          manager,
        );
        vi.spyOn(unstampedParent, 'getToolRegistry').mockReturnValue(
          mockToolRegistry,
        );

        const { context, dispose } = await launchHandle({}, unstampedParent);
        // hasRebuiltToolRegistry reads the stamp through the prototype
        // chain: assert the rebuild actually happened BEFORE asserting the
        // stop, or an inherited stamp silently degrades this into the
        // no-rebuild control case.
        expect(context.getToolRegistry()).not.toBe(mockToolRegistry);
        expect(context.getSkillManager()).toBe(sessionManager);
        const stop = vi
          .spyOn(context.getToolRegistry(), 'stop')
          .mockResolvedValue(undefined);

        await dispose();

        expect(stop).toHaveBeenCalledTimes(1);
      });

      it('does not stop the parent registry for an unrestricted agent', async () => {
        // The control for the two cases above: nothing was rebuilt, so
        // `getToolRegistry()` still resolves to the session's registry and
        // the cleanup slot must stay empty.
        const parentStop = vi.fn().mockResolvedValue(undefined);
        (mockToolRegistry as unknown as { stop: () => Promise<void> }).stop =
          parentStop;

        const { context, dispose } = await launchHandle({});
        expect(context.getToolRegistry()).toBe(mockToolRegistry);

        await dispose();

        expect(parentStop).not.toHaveBeenCalled();
      });
    });
  });
});
