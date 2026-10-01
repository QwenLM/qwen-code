/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  convertClaudeToQwenConfig,
  convertClaudeAgentConfig,
  mergeClaudeConfigs,
  isClaudePluginConfig,
  convertClaudePluginPackage,
  convertClaudePluginStandalone,
  normalizeClaudeMcpServer,
  type ClaudePluginConfig,
  type ClaudeMarketplacePluginConfig,
  type ClaudeMarketplaceConfig,
} from './claude-converter.js';
import { cloneFromGit, downloadFromGitHubRelease } from './github.js';
import { HookType } from '../hooks/types.js';
import { performVariableReplacement } from './variables.js';
import {
  SubagentManager,
  loadSubagentFromDir,
} from '../subagents/subagent-manager.js';
import type { SubagentError } from '../subagents/types.js';
import type { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import { loadExtensionWorkflows } from '../agents/runtime/workflow-extension.js';

// The git-subdir source clones a repo; stub the network clone so the security
// guards around the cloned subdirectory can be exercised against a real fs.
// Other tests use local sources and never call these, so the stubs are inert.
vi.mock('./github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./github.js')>();
  return {
    ...actual,
    cloneFromGit: vi.fn(),
    downloadFromGitHubRelease: vi.fn(),
  };
});

/** Write each `files` entry (path relative to `root` → content), creating parent directories. */
function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, 'utf-8');
  }
}

// Every temp dir a test creates (fixtures, converted output, host "secrets")
// is registered here and removed after that test.
const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Await a conversion and register its output dir for cleanup. */
async function converted<T extends { convertedDir: string }>(
  pending: Promise<T>,
): Promise<T> {
  const result = await pending;
  tempDirs.push(result.convertedDir);
  return result;
}
const convertPackage = (
  ...args: Parameters<typeof convertClaudePluginPackage>
) => converted(convertClaudePluginPackage(...args));
const convertStandalone = (dir: string) =>
  converted(convertClaudePluginStandalone(dir));

/** The converted config's MCP server `name`, read as a plain record entry. */
const mcpServer = (
  result: { config: { mcpServers?: unknown } },
  name: string,
) => (result.config.mcpServers as Record<string, unknown> | undefined)?.[name];

const exists = (...segments: string[]) => fs.existsSync(path.join(...segments));

/** Write `body` to `name` in a fresh host directory outside every plugin; returns the file path. */
function makeSecret(name: string, body: string) {
  const secretDir = tempDir('claude-secret-');
  const secretFile = path.join(secretDir, name);
  fs.writeFileSync(secretFile, body, 'utf-8');
  return secretFile;
}

type PluginEntry = Partial<ClaudeMarketplacePluginConfig>;

/**
 * Write .claude-plugin/marketplace.json under `dir` listing one plugin: a
 * non-strict local (`./`) 1.0.0 entry that `entry` overrides.
 */
function writeLocalMarketplace(
  dir: string,
  name: string,
  entry: PluginEntry & { name: string },
) {
  const marketplace: ClaudeMarketplaceConfig = {
    name,
    owner: { name: 'Test Owner', email: 'test@example.com' },
    plugins: [{ version: '1.0.0', source: './', strict: false, ...entry }],
  };
  writeTree(dir, {
    '.claude-plugin/marketplace.json': JSON.stringify(marketplace, null, 2),
  });
}

/** Write a marketplace.json (`m`/`o`/`e`) under `dir` declaring a single plugin `p` from `source`. */
function writeSingleSourceMarketplace(dir: string, source: unknown): void {
  writeTree(dir, {
    '.claude-plugin/marketplace.json': JSON.stringify({
      name: 'm',
      owner: { name: 'o', email: 'e' },
      plugins: [{ name: 'p', version: '1.0.0', source }],
    }),
  });
}

describe('convertClaudeToQwenConfig', () => {
  it('should convert basic Claude config', () => {
    const result = convertClaudeToQwenConfig({
      name: 'claude-plugin',
      version: '1.0.0',
    });

    expect(result.name).toBe('claude-plugin');
    expect(result.version).toBe('1.0.0');
  });

  it('should convert config with basic fields only', () => {
    const result = convertClaudeToQwenConfig({
      name: 'full-plugin',
      version: '1.0.0',
      commands: 'commands',
      agents: ['agents/agent1.md'],
      skills: ['skills/skill1'],
    });

    // Commands, skills, agents are collected as directories, not in config
    expect(result.name).toBe('full-plugin');
    expect(result.version).toBe('1.0.0');
    expect(result.mcpServers).toBeUndefined();
  });

  it('should preserve lspServers configuration', () => {
    const claudeConfig: ClaudePluginConfig = {
      name: 'lsp-plugin',
      version: '1.0.0',
      lspServers: {
        typescript: {
          command: 'typescript-language-server',
          args: ['--stdio'],
          extensionToLanguage: { '.ts': 'typescript' },
        },
      },
    };

    const result = convertClaudeToQwenConfig(claudeConfig);

    expect(result.lspServers).toEqual(claudeConfig.lspServers);
  });

  it('should preserve description field', () => {
    const result = convertClaudeToQwenConfig({
      name: 'desc-plugin',
      version: '1.0.0',
      description: 'A plugin with a description',
    });

    expect(result.description).toBe('A plugin with a description');
  });

  it('should leave description undefined when not provided', () => {
    const result = convertClaudeToQwenConfig({
      name: 'no-desc-plugin',
      version: '1.0.0',
    });

    expect(result.description).toBeUndefined();
  });

  it('should throw error for missing name', () => {
    const invalidConfig = { version: '1.0.0' } as ClaudePluginConfig;

    expect(() => convertClaudeToQwenConfig(invalidConfig)).toThrow();
  });
});

describe('convertClaudeAgentConfig', () => {
  it('should map Claude NotebookEdit to Qwen NotebookEdit', () => {
    const result = convertClaudeAgentConfig({
      name: 'notebook-agent',
      description: 'Works on notebooks',
      tools: ['Read', 'NotebookEdit', 'Edit'],
    });

    expect(result['tools']).toEqual(['ReadFile', 'NotebookEdit', 'Edit']);
  });

  it('should map Claude WebSearch to Qwen WebSearch', () => {
    // WebSearch used to map to 'None' before qwen-code shipped a built-in
    // web_search; reverting the mapping would silently strip search from
    // converted Claude extensions.
    const result = convertClaudeAgentConfig({
      name: 'search-agent',
      description: 'Searches the web',
      tools: ['WebSearch', 'WebFetch'],
    });

    expect(result['tools']).toEqual(['WebSearch', 'WebFetch']);
  });
});

describe('mergeClaudeConfigs', () => {
  it('should merge marketplace and plugin configs', () => {
    const merged = mergeClaudeConfigs(
      {
        name: 'marketplace-name',
        version: '2.0.0',
        source: 'github:org/repo',
        description: 'From marketplace',
      },
      { name: 'plugin-name', version: '1.0.0', commands: 'commands' },
    );

    // Marketplace takes precedence
    expect(merged.name).toBe('marketplace-name');
    expect(merged.version).toBe('2.0.0');
    expect(merged.description).toBe('From marketplace');
    // Plugin fields preserved
    expect(merged.commands).toBe('commands');
  });

  it('should work with strict=false and no plugin config', () => {
    const merged = mergeClaudeConfigs({
      name: 'standalone',
      version: '1.0.0',
      source: 'local',
      strict: false,
      commands: 'commands',
    });

    expect(merged.name).toBe('standalone');
    expect(merged.commands).toBe('commands');
  });

  it('should throw error for strict mode without plugin config', () => {
    const marketplacePlugin: ClaudeMarketplacePluginConfig = {
      name: 'strict-plugin',
      version: '1.0.0',
      source: 'github:org/repo',
      strict: true,
    };

    expect(() => mergeClaudeConfigs(marketplacePlugin)).toThrow();
  });
});

describe('isClaudePluginConfig', () => {
  it('should identify Claude plugin directory', () => {
    const marketplace = {
      extensionSource: 'https://test.com',
      pluginName: 'test-plugin',
    };

    // Would check marketplace.json for the plugin; with no real fs setup here
    // only the result type is asserted.
    expect(
      typeof isClaudePluginConfig('/tmp/test-extension', marketplace),
    ).toBe('boolean');
  });
});

describe('convertClaudePluginPackage', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = tempDir('claude-test-');
    vi.mocked(downloadFromGitHubRelease).mockReset();
    vi.mocked(cloneFromGit).mockReset();
  });

  /** Lay out testDir/`dirName` with `files` and a marketplace listing `entry`. */
  function layoutPlugin(
    dirName: string,
    entry: PluginEntry & { name: string },
    files: Record<string, string> = {},
  ): string {
    const dir = path.join(testDir, dirName);
    writeTree(dir, files);
    writeLocalMarketplace(dir, 'test-marketplace', entry);
    return dir;
  }
  async function layoutAndConvert(...args: Parameters<typeof layoutPlugin>) {
    const dir = layoutPlugin(...args);
    return { dir, result: await convertPackage(dir, args[1].name) };
  }

  it('should only collect specified skills when config provides explicit list', async () => {
    // Six skills on disk; the marketplace entry lists only four.
    const files: Record<string, string> = {};
    for (const skill of ['xlsx', 'docx', 'pptx', 'pdf', 'csv', 'txt']) {
      files[`skills/${skill}/SKILL.md`] = `# ${skill} skill`;
      files[`skills/${skill}/index.js`] = `module.exports = {};`;
    }
    const { result } = await layoutAndConvert(
      'plugin-source',
      {
        name: 'document-skills',
        description: 'Test document skills',
        skills: [
          './skills/xlsx',
          './skills/docx',
          './skills/pptx',
          './skills/pdf',
        ],
      },
      files,
    );

    const convertedSkillsDir = path.join(result.convertedDir, 'skills');
    expect(fs.existsSync(convertedSkillsDir)).toBe(true);

    const installedSkills = fs.readdirSync(convertedSkillsDir);
    expect(installedSkills.sort()).toEqual(['docx', 'pdf', 'pptx', 'xlsx']);

    // Each listed skill keeps its own directory and files.
    for (const skill of ['xlsx', 'docx', 'pptx', 'pdf']) {
      const skillDir = path.join(convertedSkillsDir, skill);
      expect(fs.existsSync(skillDir)).toBe(true);
      expect(exists(skillDir, 'SKILL.md')).toBe(true);
      expect(exists(skillDir, 'index.js')).toBe(true);
    }

    expect(exists(convertedSkillsDir, 'csv')).toBe(false);
    expect(exists(convertedSkillsDir, 'txt')).toBe(false);
  });

  it('skips a symlink inside a collected resource folder that escapes the plugin', async () => {
    const pluginSourceDir = layoutPlugin(
      'plugin-symlink',
      {
        name: 'leaky',
        description: 'Leaky plugin',
        skills: ['./skills/mine'],
      },
      { 'skills/mine/SKILL.md': '# mine' },
    );
    // A host file outside the plugin, reachable via a symlink whose name stays
    // inside the collected folder. collectResources must not copy its content.
    const secretFile = makeSecret('id_rsa', 'TOP SECRET');
    fs.symlinkSync(
      secretFile,
      path.join(pluginSourceDir, 'skills', 'mine', 'leak.txt'),
    );

    const result = await convertPackage(pluginSourceDir, 'leaky');

    const dest = path.join(result.convertedDir, 'skills', 'mine');
    expect(exists(dest, 'SKILL.md')).toBe(true);
    expect(exists(dest, 'leak.txt')).toBe(false);
  });

  it('throws when a marketplace source is a symlink resolving outside the marketplace dir', async () => {
    // A host directory reachable via a symlink whose relative name stays inside
    // the marketplace dir. resolvePluginSource must reject it before copying.
    const secretDir = path.dirname(makeSecret('SKILL.md', 'secret'));
    const pluginSourceDir = layoutPlugin('plugin-evil-source', {
      name: 'evil',
      description: 'Evil plugin',
      source: './evil-link',
    });
    fs.symlinkSync(secretDir, path.join(pluginSourceDir, 'evil-link'));

    await expect(
      convertClaudePluginPackage(pluginSourceDir, 'evil'),
    ).rejects.toThrow(/resolves through a symlink outside the marketplace/);
  });

  it('treats uppercase HTTPS marketplace plugin sources as URLs', async () => {
    vi.mocked(downloadFromGitHubRelease).mockResolvedValue(undefined as never);

    const { result } = await layoutAndConvert('plugin-uppercase-url', {
      name: 'remote',
      source: 'HTTPS://github.com/owner/plugin',
    });

    expect(result.config.name).toBe('remote');
    expect(downloadFromGitHubRelease).toHaveBeenCalledWith(
      {
        source: 'HTTPS://github.com/owner/plugin',
        type: 'git',
        originSource: 'Claude',
      },
      expect.any(String),
      undefined,
    );
    expect(cloneFromGit).not.toHaveBeenCalled();
  });

  it('does not fall back to cloning when conversion is aborted', async () => {
    const pluginSourceDir = layoutPlugin('plugin-abort', {
      name: 'remote',
      source: 'https://github.com/owner/plugin',
    });
    const controller = new AbortController();
    const reason = new Error('conversion expired');
    vi.mocked(downloadFromGitHubRelease).mockImplementationOnce(async () => {
      controller.abort(reason);
      throw new Error('download failed');
    });

    await expect(
      convertClaudePluginPackage(
        pluginSourceDir,
        'remote',
        undefined,
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(cloneFromGit).not.toHaveBeenCalled();
  });

  it('should use all skills from folder when config does not specify skills', async () => {
    // No skills field in the entry: every skill in the folder is used.
    const { result } = await layoutAndConvert(
      'plugin-source-default',
      { name: 'default-skills', description: 'Test default skills behavior' },
      {
        'skills/skill-a/SKILL.md': '# skill-a',
        'skills/skill-b/SKILL.md': '# skill-b',
        'skills/skill-c/SKILL.md': '# skill-c',
      },
    );

    const convertedSkillsDir = path.join(result.convertedDir, 'skills');
    expect(fs.existsSync(convertedSkillsDir)).toBe(true);

    const installedSkills = fs.readdirSync(convertedSkillsDir);
    expect(installedSkills.sort()).toEqual(['skill-a', 'skill-b', 'skill-c']);
  });

  it('should preserve directory structure when collecting skills', async () => {
    const { result } = await layoutAndConvert(
      'plugin-nested',
      {
        name: 'nested-plugin',
        description: 'Test nested structure',
        skills: ['./skills/nested-skill'],
      },
      {
        'skills/nested-skill/SKILL.md': '# Nested Skill',
        'skills/nested-skill/subdir/helper.js': 'module.exports = {};',
      },
    );

    const convertedSkillsDir = path.join(result.convertedDir, 'skills');
    expect(fs.existsSync(convertedSkillsDir)).toBe(true);

    const nestedSkillPath = path.join(convertedSkillsDir, 'nested-skill');
    expect(fs.existsSync(nestedSkillPath)).toBe(true);
    expect(exists(nestedSkillPath, 'SKILL.md')).toBe(true);
    expect(exists(nestedSkillPath, 'subdir', 'helper.js')).toBe(true);
  });

  it('should successfully convert agent files with Windows CRLF endings', async () => {
    // The source folder was once named `src-agents` to dodge a (since fixed)
    // collectResources skip-logic bug that silently dropped file entries like
    // `./agents/foo.md`; the name is now incidental.
    const { result } = await layoutAndConvert(
      'plugin-crlf-agents',
      { name: 'crlf-agents-plugin', agents: ['./src-agents/agent.md'] },
      {
        'src-agents/agent.md': `---\r\nname: cool-agent\r\ndescription: A cool agent\r\n---\r\n\r\nSystem prompt body\r\n`,
      },
    );

    // The agent was parsed and converted into the agents folder.
    const convertedAgentsDir = path.join(result.convertedDir, 'agents');
    expect(fs.existsSync(convertedAgentsDir)).toBe(true);

    const convertedFiles = fs.readdirSync(convertedAgentsDir);
    expect(convertedFiles).toContain('agent.md'); // The filename is preserved from source

    // Parsed, not just copied: the converted content carries the frontmatter.
    const convertedContent = fs.readFileSync(
      path.join(convertedAgentsDir, 'agent.md'),
      'utf-8',
    );
    expect(convertedContent).toContain('name: cool-agent');
  });

  it.each([
    ['executionBackend: container', true],
    ['executionBackend: null', false],
    ['executionBackend: local', false],
    ['executionBackend: container\nexecutionBackend: local', false],
    ['executionBackend: container\nbroken: [', false],
  ] as const)(
    'preserves backend intent through plugin conversion and actual extension loading: %s',
    async (declaration, valid) => {
      const pluginSourceDir = path.join(testDir, 'backend-plugin');
      const source = `---\nname: Explore\ndescription: Review files\n${declaration}\n---\nComplete the requested task.\n`;
      const sourceFile = path.join(pluginSourceDir, 'agents', 'agent.md');
      writeTree(pluginSourceDir, {
        'agents/agent.md': source,
        '.claude-plugin/marketplace.json': JSON.stringify({
          name: 'marketplace',
          owner: { name: 'Test' },
          plugins: [
            {
              name: 'backend-plugin',
              version: '1.0.0',
              source: './',
              strict: false,
              agents: ['./agents/agent.md'],
            },
          ],
        }),
      });
      const result = await convertPackage(pluginSourceDir, 'backend-plugin');
      const homeSpy = vi
        .spyOn(Storage, 'getGlobalQwenDir')
        .mockReturnValue(path.join(testDir, 'global'));
      try {
        const installedDir = path.join(result.convertedDir, 'agents');
        const installed = fs.readFileSync(
          path.join(installedDir, 'agent.md'),
          'utf8',
        );
        expect(fs.readFileSync(sourceFile, 'utf8')).toBe(source);
        if (!valid) expect(installed).toBe(source);
        const refusals = new Map<string, SubagentError>();
        const agents = await loadSubagentFromDir(installedDir, refusals);
        const manager = new SubagentManager({
          getProjectRoot: () => path.join(testDir, 'workspace'),
          getActiveExtensions: () => [
            { agents, agentExecutorRefusals: refusals },
          ],
          getAgentsSettings: () => ({}),
          getSdkMode: () => false,
          isSafeMode: () => false,
        } as unknown as Config);
        if (valid) {
          expect(installed).toContain('executionBackend: container');
          expect(refusals.size).toBe(0);
          expect(await manager.loadSubagent('Explore')).toMatchObject({
            level: 'extension',
            executionBackend: 'container',
          });
        } else {
          expect(agents).toEqual([]);
          expect(refusals.has('explore')).toBe(true);
          await expect(manager.loadSubagent('Explore')).rejects.toThrow(
            'invalid executionBackend declaration',
          );
        }
      } finally {
        homeSpy.mockRestore();
      }
    },
  );

  it('should populate commands/skills/agents when marketplace references the whole folder (deep-wiki shape)', async () => {
    // Regression test for https://github.com/QwenLM/qwen-code/issues/4452.
    //
    // microsoft/skills/.../deep-wiki declares its resources as
    //   commands: ["./commands/"]
    //   skills:   ["./skills/"]
    //   agents:   ["./agents/wiki-architect.md", ...]
    // i.e. references the *whole* resource folder, with file paths sitting
    // directly under `agents/`. An earlier skip-branch in collectResources
    // dropped both shapes silently, leaving empty directories.
    const { result } = await layoutAndConvert(
      'deep-wiki-shape',
      {
        name: 'deep-wiki',
        commands: ['./commands/'],
        skills: ['./skills/'],
        agents: ['./agents/wiki-architect.md', './agents/wiki-writer.md'],
      },
      {
        'commands/wiki.md': '# wiki',
        'commands/index.md': '# index',
        'skills/wiki-skill/SKILL.md': '# wiki-skill',
        'agents/wiki-architect.md':
          '---\nname: wiki-architect\ndescription: Architect\n---\nbody',
        'agents/wiki-writer.md':
          '---\nname: wiki-writer\ndescription: Writer\n---\nbody',
      },
    );

    // commands/ should be populated (flattened, not nested as commands/commands)
    const convertedCommands = path.join(result.convertedDir, 'commands');
    expect(fs.existsSync(convertedCommands)).toBe(true);
    expect(fs.readdirSync(convertedCommands).sort()).toEqual([
      'index.md',
      'wiki.md',
    ]);
    expect(exists(convertedCommands, 'commands')).toBe(false);

    const convertedSkills = path.join(result.convertedDir, 'skills');
    expect(exists(convertedSkills, 'wiki-skill', 'SKILL.md')).toBe(true);
    expect(exists(convertedSkills, 'skills')).toBe(false);

    // agents/ should contain the two referenced files at the root
    const convertedAgents = path.join(result.convertedDir, 'agents');
    expect(fs.readdirSync(convertedAgents).sort()).toEqual([
      'wiki-architect.md',
      'wiki-writer.md',
    ]);
    expect(exists(convertedAgents, 'agents')).toBe(false);
  });

  it('should populate resources when marketplace references whole folder with trailing slash variants', async () => {
    // `./commands/` (with trailing slash) and `./commands` (without) should
    // both resolve identically — the bug fix shouldn't be sensitive to the
    // exact form marketplace authors write.
    const { result } = await layoutAndConvert(
      'trailing-slash',
      { name: 'no-slash', commands: ['./commands'] }, // no trailing slash
      { 'commands/a.md': '# a' },
    );
    const convertedCommands = path.join(result.convertedDir, 'commands');
    expect(exists(convertedCommands, 'a.md')).toBe(true);
  });

  it('should convert hooks from Claude plugin format to Qwen format with variable substitution', async () => {
    // hooks.json in Claude format: HookDefinition (matcher, sequential) holding HookConfig[].
    const hooksJson = {
      hooks: {
        PostToolUse: [
          {
            matcher: 'post-install-matcher',
            sequential: true,
            description: 'Run after installation',
            hooks: [
              {
                type: HookType.Command,
                command: '${CLAUDE_PLUGIN_ROOT}/scripts/post-install.sh',
              },
            ],
          },
        ],
      },
    };
    const { dir: pluginSourceDir, result } = await layoutAndConvert(
      'plugin-with-hooks',
      { name: 'hooks-plugin', hooks: './hooks/hooks.json' },
      { 'hooks/hooks.json': JSON.stringify(hooksJson) },
    );

    expect(result.config.hooks).toBeDefined();
    expect(result.config.hooks!['PostToolUse']).toHaveLength(1);
    // The plugin-root variable is substituted.
    expect(
      (result.config.hooks!['PostToolUse']![0].hooks![0] as { command: string })
        .command,
    ).toBe(`${pluginSourceDir}/scripts/post-install.sh`);
  });

  it('throws when marketplace.json itself is a symlink resolving outside the plugin', async () => {
    // A hostile clone makes the marketplace manifest a symlink to a JSON-shaped
    // host file. The converter must refuse to follow it (realPathWithin guard).
    const secretFile = makeSecret(
      'marketplace.json',
      JSON.stringify({
        name: 'leaked',
        owner: { name: 'x', email: 'x@x' },
        plugins: [{ name: 'evil', version: '1.0.0', source: './' }],
      }),
    );

    const pluginSourceDir = path.join(testDir, 'plugin-mp-symlink');
    const marketplaceDir = path.join(pluginSourceDir, '.claude-plugin');
    fs.mkdirSync(marketplaceDir, { recursive: true });
    fs.symlinkSync(secretFile, path.join(marketplaceDir, 'marketplace.json'));

    await expect(
      convertClaudePluginPackage(pluginSourceDir, 'evil'),
    ).rejects.toThrow(/resolves through a symlink outside the plugin/);
  });

  it('throws in strict mode when plugin.json is a symlink escaping the plugin', async () => {
    // existsSync follows the symlink so the strict-missing check passes, but the
    // target is untrusted — strict mode must fail instead of silently falling
    // back to the marketplace entry.
    const secretFile = makeSecret(
      'plugin.json',
      JSON.stringify({ name: 'leaked', version: '9.9.9' }),
    );
    const pluginSourceDir = layoutPlugin('plugin-strict-symlink', {
      name: 'evil',
      strict: true,
    });
    // plugin.json lives at pluginSource/.claude-plugin/plugin.json (source './'
    // resolves the plugin source to the package root).
    fs.symlinkSync(
      secretFile,
      path.join(pluginSourceDir, '.claude-plugin', 'plugin.json'),
    );

    await expect(
      convertClaudePluginPackage(pluginSourceDir, 'evil'),
    ).rejects.toThrow(/Strict mode requires a trusted plugin\.json/);
  });

  it('ignores a symlinked plugin.json (non-strict) and uses the marketplace entry', async () => {
    const secretFile = makeSecret(
      'plugin.json',
      JSON.stringify({
        name: 'leaked',
        version: '9.9.9',
        mcpServers: { leaked: { command: 'cat', args: ['/etc/passwd'] } },
      }),
    );
    const pluginSourceDir = layoutPlugin('plugin-nonstrict-symlink', {
      name: 'evil',
    });
    fs.symlinkSync(
      secretFile,
      path.join(pluginSourceDir, '.claude-plugin', 'plugin.json'),
    );

    const result = await convertPackage(pluginSourceDir, 'evil');
    // The marketplace entry is used; the symlinked target is never read.
    expect(result.config.name).toBe('evil');
    expect(mcpServer(result, 'leaked')).toBeUndefined();
  });
});

describe('convertClaudePluginStandalone', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = tempDir('claude-standalone-');
  });

  /** Write .claude-plugin/plugin.json (serialized `config`) plus `files` into testDir. */
  const writeRepo = (config: object, files: Record<string, string> = {}) =>
    writeTree(testDir, {
      '.claude-plugin/plugin.json': JSON.stringify(config),
      ...files,
    });

  it('converts a repo with root .claude-plugin/plugin.json, .mcp.json and skills', async () => {
    // Mirror the ClickHouse plugin layout: plugin.json metadata only, MCP in
    // a root .mcp.json, and a skills/ folder with no commands/agents.
    // A real git clone carries a .git directory; create one so the assertion
    // below actually exercises the VCS-metadata stripping in the converter.
    writeRepo(
      {
        name: 'clickhouse',
        version: '1.0.0',
        description: 'ClickHouse plugin',
      },
      {
        '.mcp.json': JSON.stringify({
          mcpServers: {
            clickhouse: {
              type: 'http',
              url: 'https://mcp.clickhouse.cloud/mcp',
            },
          },
        }),
        'skills/best-practices/SKILL.md': '# best practices',
        '.git/HEAD': 'ref: refs/heads/main',
      },
    );

    const result = await convertStandalone(testDir);

    // A qwen-extension.json must exist so the installer can load it.
    expect(exists(result.convertedDir, 'qwen-extension.json')).toBe(true);
    expect(result.config.name).toBe('clickhouse');
    expect(result.config.version).toBe('1.0.0');
    // MCP server folded in from .mcp.json and remapped to Qwen's transport
    // shape: Claude `type: 'http'` + `url` becomes `httpUrl` (streamable HTTP).
    const mcp = result.config.mcpServers?.['clickhouse'] as
      | { httpUrl?: string; url?: string; type?: string }
      | undefined;
    expect(mcp?.httpUrl).toBe('https://mcp.clickhouse.cloud/mcp');
    expect(mcp?.url).toBeUndefined();
    expect(mcp?.type).toBeUndefined();
    // Skills folder preserved.
    expect(
      exists(result.convertedDir, 'skills', 'best-practices', 'SKILL.md'),
    ).toBe(true);
    // VCS metadata is not shipped into the installed extension.
    expect(exists(result.convertedDir, '.git')).toBe(false);
  });

  it('throws when there is no .claude-plugin/plugin.json', async () => {
    await expect(convertClaudePluginStandalone(testDir)).rejects.toThrow(
      /Plugin configuration not found/,
    );
  });

  it('ignores an absolute mcpServers path so it cannot read out-of-tree files', async () => {
    // A hostile plugin.json points mcpServers at an absolute file outside the
    // plugin. The converter must NOT read it (path-confinement guard).
    const secretFile = makeSecret(
      'secret-mcp.json',
      JSON.stringify({ leaked: { command: 'cat', args: ['/etc/passwd'] } }),
    );
    writeRepo({ name: 'evil', version: '1.0.0', mcpServers: secretFile });

    const result = await convertStandalone(testDir);
    // The absolute path was not read, so no servers were folded in.
    expect(result.config.mcpServers?.['leaked']).toBeUndefined();
  });

  it('throws when plugin.json is a symlink resolving outside the plugin', async () => {
    // A hostile clone makes the manifest itself a symlink to a JSON-shaped host
    // file. The converter must refuse to follow it rather than read the target.
    const secretFile = makeSecret(
      'config.json',
      JSON.stringify({ name: 'leaked', version: '9.9.9' }),
    );
    const pluginDir = path.join(testDir, '.claude-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.symlinkSync(secretFile, path.join(pluginDir, 'plugin.json'));

    await expect(convertClaudePluginStandalone(testDir)).rejects.toThrow(
      /resolves through a symlink outside/,
    );
  });

  it('does not load mcpServers from a relative path that is a symlink escaping the plugin', async () => {
    // mcpServers is a relative path whose name stays inside the plugin, but the
    // file is a symlink to a host secret. resolvePluginRelativeFile must reject
    // it so the target is never read into the config.
    const secretFile = makeSecret(
      'servers.json',
      JSON.stringify({ leaked: { command: 'cat', args: ['/etc/passwd'] } }),
    );
    writeRepo({ name: 'evil', version: '1.0.0', mcpServers: './servers.json' });
    fs.symlinkSync(secretFile, path.join(testDir, 'servers.json'));

    const result = await convertStandalone(testDir);
    expect(mcpServer(result, 'leaked')).toBeUndefined();
  });

  it('does not copy a symlink whose target escapes the plugin directory', async () => {
    // git preserves symlinks, so a hostile repo can embed one pointing at a
    // host file. The bulk copy dereferences symlinks; without confinement the
    // target's content would be shipped inside the converted extension.
    const secretFile = makeSecret('id_rsa', 'TOP SECRET KEY');
    writeRepo(
      { name: 'evil', version: '1.0.0' },
      { 'skills/SKILL.md': '# ok' },
    );
    // A symlink whose name stays inside the package but points outside it.
    fs.symlinkSync(secretFile, path.join(testDir, 'skills', 'leak.txt'));

    const result = await convertStandalone(testDir);

    // The legitimate file is copied; the escaping symlink is dropped.
    expect(exists(result.convertedDir, 'skills', 'SKILL.md')).toBe(true);
    expect(exists(result.convertedDir, 'skills', 'leak.txt')).toBe(false);
  });

  it('skips a .mcp.json that has no mcpServers object instead of misparsing it', async () => {
    // No `mcpServers` key — the whole object must not be treated as the map.
    writeRepo(
      { name: 'no-servers', version: '1.0.0' },
      { '.mcp.json': JSON.stringify({ name: 'foo', other: 'bar' }) },
    );

    const result = await convertStandalone(testDir);
    expect(result.config.mcpServers).toBeUndefined();
    expect(mcpServer(result, 'name')).toBeUndefined();
  });

  it('does not load a .mcp.json that is a symlink escaping the plugin', async () => {
    // .mcp.json's name stays inside the plugin but it's a symlink to a host
    // file. realPathWithin must reject it so the target servers are never read.
    const secretFile = makeSecret(
      'servers.json',
      JSON.stringify({
        mcpServers: { leaked: { command: 'cat', args: ['/etc/passwd'] } },
      }),
    );
    writeRepo({ name: 'evil', version: '1.0.0' });
    fs.symlinkSync(secretFile, path.join(testDir, '.mcp.json'));

    const result = await convertStandalone(testDir);
    expect(mcpServer(result, 'leaked')).toBeUndefined();
  });

  it('throws a clear error when plugin.json parses to null', async () => {
    // A plugin.json whose body is the JSON literal `null` would otherwise throw
    // an opaque "Cannot read properties of null" on the mcpServers deref.
    writeTree(testDir, { '.claude-plugin/plugin.json': 'null' });

    await expect(convertClaudePluginStandalone(testDir)).rejects.toThrow(
      /Invalid plugin configuration/,
    );
  });
});

describe('performVariableReplacement for Claude extensions', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = tempDir('claude-var-test-');
  });

  /** Write `content` to testDir/`dirName`/`file`, run the replacement over the directory, read the file back. */
  function replaceIn(dirName: string, file: string, content: string): string {
    const extDir = path.join(testDir, dirName);
    writeTree(extDir, { [file]: content });
    performVariableReplacement(extDir);
    return fs.readFileSync(path.join(extDir, file), 'utf-8');
  }

  it('should replace .claude with .qwen in shell scripts', () => {
    const result = replaceIn(
      'ext-sh',
      'setup.sh',
      `#!/bin/bash
      CONFIG_DIR="$HOME/.claude/config"
      CACHE_DIR="~/.claude/cache"
      LOCAL_DIR="./.claude/local"`,
    );
    expect(result).toContain('$HOME/.qwen/config');
    expect(result).toContain('~/.qwen/cache');
    expect(result).toContain('./.qwen/local');
    expect(result).not.toContain('.claude');
  });

  it('should replace role with type in shell scripts', () => {
    const result = replaceIn(
      'ext-role',
      'process.sh',
      `#!/bin/bash
      echo '{"role":"assistant","content":"hello"}'`,
    );
    expect(result).toContain('"type":"assistant"');
    expect(result).not.toContain('"role":"assistant"');
  });

  it('should update transcript parsing logic in shell scripts', () => {
    const result = replaceIn(
      'ext-transcript',
      'parse.sh',
      `#!/bin/bash
      echo "$transcript" | jq '.message.content | map(select(.type == "text"))'`,
    );
    expect(result).toContain('.message.parts | map(select(has("text")))');
    expect(result).not.toContain('.message.content');
  });
});

describe('convertClaudePluginPackage — git-subdir source', () => {
  let extDir: string;

  beforeEach(() => {
    extDir = tempDir('claude-gitsub-');
    vi.mocked(cloneFromGit).mockReset();
  });

  // Writes a marketplace.json declaring a single git-subdir plugin.
  const writeMarketplace = (source: object) =>
    writeSingleSourceMarketplace(extDir, {
      source: 'git-subdir',
      url: 'https://example.com/repo.git',
      ...source,
    });

  it('clones, pins to the sha over the ref, and returns the subdirectory', async () => {
    vi.mocked(cloneFromGit).mockImplementation(async (_meta, dir) => {
      writeTree(dir as string, {
        'packages/plugin/.claude-plugin/plugin.json': JSON.stringify({
          name: 'p',
          version: '1.0.0',
        }),
      });
      return 'test-commit';
    });

    writeMarketplace({ path: 'packages/plugin', ref: 'main', sha: 'abc123' });

    const result = await convertPackage(extDir, 'p', 'public');
    expect(result.config.name).toBe('p');
    // The immutable sha is preferred over the named ref when both are present.
    const meta = vi.mocked(cloneFromGit).mock.calls[0][0] as {
      ref?: string;
      networkPolicy?: string;
    };
    expect(meta.ref).toBe('abc123');
    expect(meta.networkPolicy).toBe('public');
  });

  it('rejects a subdirectory that escapes the repository root', async () => {
    vi.mocked(cloneFromGit).mockResolvedValue(undefined as never);
    writeMarketplace({ path: '../../etc' });
    await expect(convertClaudePluginPackage(extDir, 'p')).rejects.toThrow(
      /escapes the repository root/,
    );
  });

  it('rejects an absolute subdirectory path', async () => {
    vi.mocked(cloneFromGit).mockResolvedValue(undefined as never);
    writeMarketplace({ path: path.resolve(path.sep, 'etc') });
    await expect(convertClaudePluginPackage(extDir, 'p')).rejects.toThrow(
      /Invalid plugin subdirectory/,
    );
  });

  it('rejects a missing subdirectory', async () => {
    vi.mocked(cloneFromGit).mockImplementation(async (_meta, dir) => {
      // The clone succeeded but does not contain the requested subdir.
      fs.mkdirSync(path.join(dir as string, 'other'), { recursive: true });
      return 'test-commit';
    });
    writeMarketplace({ path: 'packages/missing' });
    await expect(convertClaudePluginPackage(extDir, 'p')).rejects.toThrow(
      /not found/,
    );
  });

  it('rejects a subdirectory that is a symlink escaping the clone', async () => {
    const secretDir = path.dirname(makeSecret('SKILL.md', 'secret'));
    vi.mocked(cloneFromGit).mockImplementation(async (_meta, dir) => {
      // A hostile repo commits the subdir as a symlink whose name stays inside
      // the clone but whose target escapes it.
      fs.symlinkSync(secretDir, path.join(dir as string, 'sub'));
      return 'test-commit';
    });
    writeMarketplace({ path: 'sub' });

    await expect(convertClaudePluginPackage(extDir, 'p')).rejects.toThrow(
      /resolves through a symlink/,
    );
  });
});

describe('convertClaudePluginPackage — string URL source', () => {
  let extDir: string;

  beforeEach(() => {
    extDir = tempDir('claude-url-');
    vi.mocked(downloadFromGitHubRelease).mockReset();
    vi.mocked(cloneFromGit).mockReset();
  });

  it('treats an uppercase HTTPS:// source as a URL download, not a local path', async () => {
    // The scheme check was case-sensitive, so an uppercase URL fell through to
    // local-path handling and failed with "Plugin source not found".
    vi.mocked(downloadFromGitHubRelease).mockImplementation(
      async (_meta, dir) => {
        writeTree(dir as string, {
          '.claude-plugin/plugin.json': JSON.stringify({
            name: 'p',
            version: '1.0.0',
          }),
        });
        return { tagName: 'v1.0.0', type: 'github-release' };
      },
    );

    writeSingleSourceMarketplace(extDir, 'HTTPS://github.com/owner/repo');

    const result = await convertPackage(extDir, 'p');
    expect(result.config.name).toBe('p');
    expect(vi.mocked(downloadFromGitHubRelease)).toHaveBeenCalled();
  });
});

describe('normalizeClaudeMcpServer', () => {
  // Cast helpers: inputs may carry Claude-only fields (`type:'http'` etc.) that
  // aren't on MCPServerConfig, and outputs are inspected as plain records.
  const norm = (raw: Record<string, unknown>): Record<string, unknown> =>
    normalizeClaudeMcpServer(raw as never) as unknown as Record<
      string,
      unknown
    >;

  it('maps Claude type:http (url) to httpUrl and drops type/url', () => {
    expect(norm({ type: 'http', url: 'https://example.com/mcp' })).toEqual({
      httpUrl: 'https://example.com/mcp',
    });
  });

  it('maps Claude type:sse (url) to url and drops type', () => {
    expect(norm({ type: 'sse', url: 'https://example.com/sse' })).toEqual({
      url: 'https://example.com/sse',
    });
  });

  it('drops type from a Claude stdio server, keeping command', () => {
    expect(norm({ type: 'stdio', command: 'node', args: ['s.js'] })).toEqual({
      command: 'node',
      args: ['s.js'],
    });
  });

  it("preserves type:'sdk' (isSdkMcpServerConfig depends on it)", () => {
    // sdk standalone, and sdk alongside a command — both must keep type:'sdk'.
    expect(norm({ type: 'sdk', description: 'in-process' })).toEqual({
      type: 'sdk',
      description: 'in-process',
    });
    expect(norm({ type: 'sdk', command: 'node' })).toEqual({
      type: 'sdk',
      command: 'node',
    });
  });

  it('drops a bogus non-sdk type from a websocket (tcp) config', () => {
    // qwen reserves `type` for 'sdk' and selects websocket via the `tcp` field;
    // any stray non-sdk `type` is meaningless and is removed.
    expect(norm({ type: 'tcp', tcp: 'localhost:8000' })).toEqual({
      tcp: 'localhost:8000',
    });
  });

  it('preserves non-transport fields (headers, env, timeout)', () => {
    expect(
      norm({
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer x' },
        timeout: 5000,
      }),
    ).toEqual({
      httpUrl: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
      timeout: 5000,
    });
  });

  it('passes through an already-Qwen-shaped config unchanged', () => {
    expect(norm({ httpUrl: 'https://example.com/mcp' })).toEqual({
      httpUrl: 'https://example.com/mcp',
    });
    expect(norm({ command: 'node', args: ['s.js'] })).toEqual({
      command: 'node',
      args: ['s.js'],
    });
  });

  it('leaves a transport-less config untouched', () => {
    expect(norm({ description: 'metadata only' })).toEqual({
      description: 'metadata only',
    });
  });
});

describe('convertClaudePluginPackage — workflows', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = tempDir('claude-wf-');
    vi.mocked(downloadFromGitHubRelease).mockReset();
    vi.mocked(cloneFromGit).mockReset();
  });

  const convert = (source: string) => convertPackage(source, 'wf-plugin');
  // Two workflows sharing the basename `same.js` in different directories.
  const childOne =
    "export const meta = { name: 'child-one', description: 'First' };\nreturn 1;\n";
  const childTwo =
    "export const meta = { name: 'child-two', description: 'Second' };\nreturn 2;\n";

  function writePlugin(entry: PluginEntry = {}): string {
    const source = path.join(testDir, 'plugin-source');
    writeLocalMarketplace(source, 'wf-marketplace', {
      name: 'wf-plugin',
      ...entry,
    });
    return source;
  }

  function writeFile(
    root: string,
    rel: string,
    body = `export const meta = { name: '${path.basename(rel, '.js')}', description: 'Test workflow' };\nreturn 1;\n`,
  ): void {
    writeTree(root, { [rel]: body });
  }

  async function convertedWorkflows(result: {
    convertedDir: string;
    config: { name: string; workflows?: string | string[] };
  }): Promise<string[]> {
    const workflows = await loadExtensionWorkflows(
      result.convertedDir,
      result.config,
      result.config.workflows,
    );
    return workflows.map((workflow) => workflow.name);
  }

  it('keeps the plugin workflows directory when none are declared', async () => {
    const source = writePlugin();
    writeFile(source, 'workflows/audit.js');

    const result = await convert(source);

    expect(await convertedWorkflows(result)).toEqual(['wf-plugin:audit']);
  });

  it('collects one directory level and declares its preserved paths instead of the default', async () => {
    const source = writePlugin({ workflows: ['./flows'] });
    writeFile(source, 'workflows/default.js');
    writeFile(source, 'flows/deploy.js');
    writeFile(source, 'flows/nested/deeper.js');
    writeFile(source, 'flows/readme.md');

    const result = await convert(source);

    expect(result.config.workflows).toEqual(['flows/deploy.js']);
    expect(await convertedWorkflows(result)).toEqual(['wf-plugin:deploy']);
  });

  it('collects a declared single .js file', async () => {
    const source = writePlugin({ workflows: './extra/one.js' });
    writeFile(source, 'extra/one.js');

    const result = await convert(source);

    expect(result.config.workflows).toEqual(['extra/one.js']);
    expect(await convertedWorkflows(result)).toEqual(['wf-plugin:one']);
  });

  it('ignores declared paths that escape the plugin', async () => {
    const source = writePlugin({ workflows: ['../outside'] });
    writeFile(testDir, 'outside/leak.js');

    const result = await convert(source);

    expect(result.config.workflows).toEqual([]);
    expect(await convertedWorkflows(result)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'skips symlinked files inside a declared directory',
    async () => {
      const source = writePlugin({ workflows: ['./flows'] });
      writeFile(source, 'flows/real.js');
      writeFile(testDir, 'outside/leak.js');
      fs.symlinkSync(
        path.join(testDir, 'outside', 'leak.js'),
        path.join(source, 'flows', 'leak.js'),
      );

      const result = await convert(source);

      expect(await convertedWorkflows(result)).toEqual(['wf-plugin:real']);
    },
  );

  it.each([
    {
      workflows: ['./first', './second'],
      expected: ['wf-plugin:child-one', 'wf-plugin:child-two'],
    },
    { workflows: './first', expected: ['wf-plugin:child-one'] },
    { workflows: [], expected: [] },
    { workflows: undefined, expected: ['wf-plugin:from-plugin'] },
    // `null` reads as undeclared, so the plugin's own declaration stands.
    {
      workflows: null as unknown as undefined,
      expected: ['wf-plugin:from-plugin'],
    },
  ])(
    'merges marketplace workflows $workflows with plugin.json',
    async ({ workflows, expected }) => {
      const source = writePlugin({ workflows });
      writeFile(
        source,
        '.claude-plugin/plugin.json',
        JSON.stringify({
          name: 'wf-plugin',
          version: '1.0.0',
          workflows: './plugin-flows',
        }),
      );
      writeFile(source, 'plugin-flows/from-plugin.js');
      writeFile(source, 'workflows/default.js');
      writeFile(source, 'first/same.js', childOne);
      writeFile(source, 'second/same.js', childTwo);

      const result = await convert(source);

      expect(await convertedWorkflows(result)).toEqual(expected);
    },
  );

  it('preserves distinct workflows with the same basename through conversion and discovery', async () => {
    const source = writePlugin({ workflows: ['./first', './second'] });
    writeFile(source, 'first/same.js', childOne);
    writeFile(source, 'second/same.js', childTwo);

    const result = await convert(source);

    expect(result.config.workflows).toEqual([
      'first/same.js',
      'second/same.js',
    ]);
    expect(await convertedWorkflows(result)).toEqual([
      'wf-plugin:child-one',
      'wf-plugin:child-two',
    ]);
    expect(
      fs.readFileSync(path.join(result.convertedDir, 'first/same.js'), 'utf8'),
    ).toBe(childOne);
    expect(
      fs.readFileSync(path.join(result.convertedDir, 'second/same.js'), 'utf8'),
    ).toBe(childTwo);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(result.convertedDir, 'qwen-extension.json'),
          'utf8',
        ),
      ).workflows,
    ).toEqual(result.config.workflows);
  });

  it('restores declared workflow files inside a remapped resource directory', async () => {
    const source = writePlugin({
      commands: './other',
      workflows: './commands/child.js',
    });
    writeFile(source, 'commands/child.js');
    writeFile(source, 'other/command.md', 'A command');

    const result = await convert(source);

    expect(await convertedWorkflows(result)).toEqual(['wf-plugin:child']);
  });

  it('keeps an explicit empty declaration from enabling the default directory', async () => {
    const source = writePlugin({ workflows: [] });
    writeFile(source, 'workflows/default.js');

    const result = await convert(source);

    expect(result.config.workflows).toEqual([]);
    expect(await convertedWorkflows(result)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'copies an in-plugin symlink in a declared directory as a regular file',
    async () => {
      const source = writePlugin({ workflows: ['./flows'] });
      writeFile(source, 'shared/linked.js');
      fs.mkdirSync(path.join(source, 'flows'), { recursive: true });
      fs.symlinkSync(
        path.join(source, 'shared', 'linked.js'),
        path.join(source, 'flows', 'linked.js'),
      );

      const result = await convert(source);

      expect(result.config.workflows).toEqual(['flows/linked.js']);
      expect(
        fs
          .lstatSync(path.join(result.convertedDir, 'flows', 'linked.js'))
          .isSymbolicLink(),
      ).toBe(false);
      expect(await convertedWorkflows(result)).toEqual(['wf-plugin:linked']);
    },
  );

  it('treats a null workflows declaration as undeclared', async () => {
    const source = writePlugin({ workflows: null as unknown as string[] });
    writeFile(source, 'workflows/default.js');

    const result = await convert(source);

    expect(result.config.workflows).toBeUndefined();
    expect(await convertedWorkflows(result)).toEqual(['wf-plugin:default']);
  });
});
