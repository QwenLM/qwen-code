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
  type ClaudePluginConfig,
  type ClaudeMarketplacePluginConfig,
  type ClaudeMarketplaceConfig,
} from './claude-converter.js';
import { cloneFromGit } from './github.js';
import { HookType } from '../hooks/types.js';
import { performVariableReplacement } from './variables.js';

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

describe('convertClaudeToQwenConfig', () => {
  it('should convert basic Claude config', () => {
    const claudeConfig: ClaudePluginConfig = {
      name: 'claude-plugin',
      version: '1.0.0',
    };

    const result = convertClaudeToQwenConfig(claudeConfig);

    expect(result.name).toBe('claude-plugin');
    expect(result.version).toBe('1.0.0');
  });

  it('should convert config with basic fields only', () => {
    const claudeConfig: ClaudePluginConfig = {
      name: 'full-plugin',
      version: '1.0.0',
      commands: 'commands',
      agents: ['agents/agent1.md'],
      skills: ['skills/skill1'],
    };

    const result = convertClaudeToQwenConfig(claudeConfig);

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
          extensionToLanguage: {
            '.ts': 'typescript',
          },
        },
      },
    };

    const result = convertClaudeToQwenConfig(claudeConfig);

    expect(result.lspServers).toEqual(claudeConfig.lspServers);
  });

  it('should preserve description field', () => {
    const claudeConfig: ClaudePluginConfig = {
      name: 'desc-plugin',
      version: '1.0.0',
      description: 'A plugin with a description',
    };

    const result = convertClaudeToQwenConfig(claudeConfig);

    expect(result.description).toBe('A plugin with a description');
  });

  it('should leave description undefined when not provided', () => {
    const claudeConfig: ClaudePluginConfig = {
      name: 'no-desc-plugin',
      version: '1.0.0',
    };

    const result = convertClaudeToQwenConfig(claudeConfig);

    expect(result.description).toBeUndefined();
  });

  it('should throw error for missing name', () => {
    const invalidConfig = {
      version: '1.0.0',
    } as ClaudePluginConfig;

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
});

describe('mergeClaudeConfigs', () => {
  it('should merge marketplace and plugin configs', () => {
    const marketplacePlugin: ClaudeMarketplacePluginConfig = {
      name: 'marketplace-name',
      version: '2.0.0',
      source: 'github:org/repo',
      description: 'From marketplace',
    };

    const pluginConfig: ClaudePluginConfig = {
      name: 'plugin-name',
      version: '1.0.0',
      commands: 'commands',
    };

    const merged = mergeClaudeConfigs(marketplacePlugin, pluginConfig);

    // Marketplace takes precedence
    expect(merged.name).toBe('marketplace-name');
    expect(merged.version).toBe('2.0.0');
    expect(merged.description).toBe('From marketplace');
    // Plugin fields preserved
    expect(merged.commands).toBe('commands');
  });

  it('should work with strict=false and no plugin config', () => {
    const marketplacePlugin: ClaudeMarketplacePluginConfig = {
      name: 'standalone',
      version: '1.0.0',
      source: 'local',
      strict: false,
      commands: 'commands',
    };

    const merged = mergeClaudeConfigs(marketplacePlugin);

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
    const extensionDir = '/tmp/test-extension';
    const marketplace = {
      extensionSource: 'https://test.com',
      pluginName: 'test-plugin',
    };

    // This will check if marketplace.json exists and contains the plugin
    // Note: In real usage, this requires actual file system setup
    expect(typeof isClaudePluginConfig(extensionDir, marketplace)).toBe(
      'boolean',
    );
  });
});

describe('convertClaudePluginPackage', () => {
  let testDir: string;

  beforeEach(() => {
    // Create a temporary directory for test files
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-test-'));
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should only collect specified skills when config provides explicit list', async () => {
    // Setup: Create a plugin source with multiple skills
    const pluginSourceDir = path.join(testDir, 'plugin-source');
    fs.mkdirSync(pluginSourceDir, { recursive: true });

    // Create skills directory with 6 skills
    const skillsDir = path.join(pluginSourceDir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });

    const allSkills = ['xlsx', 'docx', 'pptx', 'pdf', 'csv', 'txt'];
    for (const skill of allSkills) {
      const skillDir = path.join(skillsDir, skill);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `# ${skill} skill`,
        'utf-8',
      );
      fs.writeFileSync(
        path.join(skillDir, 'index.js'),
        `module.exports = {};`,
        'utf-8',
      );
    }

    // Create marketplace.json that only specifies 4 skills
    const marketplaceDir = path.join(pluginSourceDir, '.claude-plugin');
    fs.mkdirSync(marketplaceDir, { recursive: true });

    const marketplaceConfig: ClaudeMarketplaceConfig = {
      name: 'test-marketplace',
      owner: { name: 'Test Owner', email: 'test@example.com' },
      plugins: [
        {
          name: 'document-skills',
          version: '1.0.0',
          description: 'Test document skills',
          source: './',
          strict: false,
          skills: [
            './skills/xlsx',
            './skills/docx',
            './skills/pptx',
            './skills/pdf',
          ],
        },
      ],
    };

    fs.writeFileSync(
      path.join(marketplaceDir, 'marketplace.json'),
      JSON.stringify(marketplaceConfig, null, 2),
      'utf-8',
    );

    // Execute: Convert the plugin
    const result = await convertClaudePluginPackage(
      pluginSourceDir,
      'document-skills',
    );

    // Verify: Only specified skills should be present
    const convertedSkillsDir = path.join(result.convertedDir, 'skills');
    expect(fs.existsSync(convertedSkillsDir)).toBe(true);

    const installedSkills = fs.readdirSync(convertedSkillsDir);
    expect(installedSkills.sort()).toEqual(['docx', 'pdf', 'pptx', 'xlsx']);

    // Verify each skill has its own directory with proper structure
    for (const skill of ['xlsx', 'docx', 'pptx', 'pdf']) {
      const skillDir = path.join(convertedSkillsDir, skill);
      expect(fs.existsSync(skillDir)).toBe(true);
      expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(skillDir, 'index.js'))).toBe(true);
    }

    // Verify csv and txt skills are NOT installed
    expect(fs.existsSync(path.join(convertedSkillsDir, 'csv'))).toBe(false);
    expect(fs.existsSync(path.join(convertedSkillsDir, 'txt'))).toBe(false);

    // Clean up converted directory
    fs.rmSync(result.convertedDir, { recursive: true, force: true });
  });

  it('skips a symlink inside a collected resource folder that escapes the plugin', async () => {
    const pluginSourceDir = path.join(testDir, 'plugin-symlink');
    const skillDir = path.join(pluginSourceDir, 'skills', 'mine');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# mine', 'utf-8');

    // A host file outside the plugin, reachable via a symlink whose name stays
    // inside the collected folder. collectResources must not copy its content.
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-secret-'));
    const secretFile = path.join(secretDir, 'id_rsa');
    fs.writeFileSync(secretFile, 'TOP SECRET', 'utf-8');
    fs.symlinkSync(secretFile, path.join(skillDir, 'leak.txt'));

    const marketplaceDir = path.join(pluginSourceDir, '.claude-plugin');
    fs.mkdirSync(marketplaceDir, { recursive: true });
    const marketplaceConfig: ClaudeMarketplaceConfig = {
      name: 'test-marketplace',
      owner: { name: 'Test Owner', email: 'test@example.com' },
      plugins: [
        {
          name: 'leaky',
          version: '1.0.0',
          description: 'Leaky plugin',
          source: './',
          strict: false,
          skills: ['./skills/mine'],
        },
      ],
    };
    fs.writeFileSync(
      path.join(marketplaceDir, 'marketplace.json'),
      JSON.stringify(marketplaceConfig, null, 2),
      'utf-8',
    );

    const result = await convertClaudePluginPackage(pluginSourceDir, 'leaky');

    const dest = path.join(result.convertedDir, 'skills', 'mine');
    expect(fs.existsSync(path.join(dest, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'leak.txt'))).toBe(false);

    fs.rmSync(result.convertedDir, { recursive: true, force: true });
    fs.rmSync(secretDir, { recursive: true, force: true });
  });

  it('throws when a marketplace source is a symlink resolving outside the marketplace dir', async () => {
    // A host directory reachable via a symlink whose relative name stays inside
    // the marketplace dir. resolvePluginSource must reject it before copying.
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-secret-'));
    fs.writeFileSync(path.join(secretDir, 'SKILL.md'), 'secret', 'utf-8');

    const pluginSourceDir = path.join(testDir, 'plugin-evil-source');
    const marketplaceDir = path.join(pluginSourceDir, '.claude-plugin');
    fs.mkdirSync(marketplaceDir, { recursive: true });
    fs.symlinkSync(secretDir, path.join(pluginSourceDir, 'evil-link'));

    const marketplaceConfig: ClaudeMarketplaceConfig = {
      name: 'test-marketplace',
      owner: { name: 'Test Owner', email: 'test@example.com' },
      plugins: [
        {
          name: 'evil',
          version: '1.0.0',
          description: 'Evil plugin',
          source: './evil-link',
          strict: false,
        },
      ],
    };
    fs.writeFileSync(
      path.join(marketplaceDir, 'marketplace.json'),
      JSON.stringify(marketplaceConfig, null, 2),
      'utf-8',
    );

    await expect(
      convertClaudePluginPackage(pluginSourceDir, 'evil'),
    ).rejects.toThrow(/resolves through a symlink outside the marketplace/);

    fs.rmSync(secretDir, { recursive: true, force: true });
  });

  it('should use all skills from folder when config does not specify skills', async () => {
    // Setup: Create a plugin source with skills but no skills config
    const pluginSourceDir = path.join(testDir, 'plugin-source-default');
    fs.mkdirSync(pluginSourceDir, { recursive: true });

    // Create skills directory with 3 skills
    const skillsDir = path.join(pluginSourceDir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });

    const allSkills = ['skill-a', 'skill-b', 'skill-c'];
    for (const skill of allSkills) {
      const skillDir = path.join(skillsDir, skill);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${skill}`, 'utf-8');
    }

    // Create marketplace.json WITHOUT skills field
    const marketplaceDir = path.join(pluginSourceDir, '.claude-plugin');
    fs.mkdirSync(marketplaceDir, { recursive: true });

    const marketplaceConfig: ClaudeMarketplaceConfig = {
      name: 'test-marketplace',
      owner: { name: 'Test Owner', email: 'test@example.com' },
      plugins: [
        {
          name: 'default-skills',
          version: '1.0.0',
          description: 'Test default skills behavior',
          source: './',
          strict: false,
          // No skills field - should use all skills from folder
        },
      ],
    };

    fs.writeFileSync(
      path.join(marketplaceDir, 'marketplace.json'),
      JSON.stringify(marketplaceConfig, null, 2),
      'utf-8',
    );

    // Execute: Convert the plugin
    const result = await convertClaudePluginPackage(
      pluginSourceDir,
      'default-skills',
    );

    // Verify: All skills should be present
    const convertedSkillsDir = path.join(result.convertedDir, 'skills');
    expect(fs.existsSync(convertedSkillsDir)).toBe(true);

    const installedSkills = fs.readdirSync(convertedSkillsDir);
    expect(installedSkills.sort()).toEqual(['skill-a', 'skill-b', 'skill-c']);

    // Clean up converted directory
    fs.rmSync(result.convertedDir, { recursive: true, force: true });
  });

  it('should preserve directory structure when collecting skills', async () => {
    // Setup: Create a plugin with nested skill structure
    const pluginSourceDir = path.join(testDir, 'plugin-nested');
    fs.mkdirSync(pluginSourceDir, { recursive: true });

    // Create nested skill directory
    const skillsDir = path.join(pluginSourceDir, 'skills');
    const nestedSkillDir = path.join(skillsDir, 'nested-skill', 'subdir');
    fs.mkdirSync(nestedSkillDir, { recursive: true });

    fs.writeFileSync(
      path.join(skillsDir, 'nested-skill', 'SKILL.md'),
      '# Nested Skill',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(nestedSkillDir, 'helper.js'),
      'module.exports = {};',
      'utf-8',
    );

    // Create marketplace.json
    const marketplaceDir = path.join(pluginSourceDir, '.claude-plugin');
    fs.mkdirSync(marketplaceDir, { recursive: true });

    const marketplaceConfig: ClaudeMarketplaceConfig = {
      name: 'test-marketplace',
      owner: { name: 'Test Owner', email: 'test@example.com' },
      plugins: [
        {
          name: 'nested-plugin',
          version: '1.0.0',
          description: 'Test nested structure',
          source: './',
          strict: false,
          skills: ['./skills/nested-skill'],
        },
      ],
    };

    fs.writeFileSync(
      path.join(marketplaceDir, 'marketplace.json'),
      JSON.stringify(marketplaceConfig, null, 2),
      'utf-8',
    );

    // Execute: Convert the plugin
    const result = await convertClaudePluginPackage(
      pluginSourceDir,
      'nested-plugin',
    );

    // Verify: Nested structure should be preserved
    const convertedSkillsDir = path.join(result.convertedDir, 'skills');
    expect(fs.existsSync(convertedSkillsDir)).toBe(true);

    const nestedSkillPath = path.join(convertedSkillsDir, 'nested-skill');
    expect(fs.existsSync(nestedSkillPath)).toBe(true);
    expect(fs.existsSync(path.join(nestedSkillPath, 'SKILL.md'))).toBe(true);
    expect(
      fs.existsSync(path.join(nestedSkillPath, 'subdir', 'helper.js')),
    ).toBe(true);

    // Clean up converted directory
    fs.rmSync(result.convertedDir, { recursive: true, force: true });
  });

  it('should successfully convert agent files with Windows CRLF endings', async () => {
    // Setup: Create a plugin with a source agents folder containing a CRLF agent
    const pluginSourceDir = path.join(testDir, 'plugin-crlf-agents');
    fs.mkdirSync(pluginSourceDir, { recursive: true });

    // Create source agents directory.
    // (Previously named `src-agents` to dodge a skip-logic bug in
    // collectResources where file entries like `./agents/foo.md` would be
    // silently dropped — fixed; the directory name is now incidental.)
    const agentsDir = path.join(pluginSourceDir, 'src-agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    // Write a .md file with CRLF endings
    const crlfAgentContent = `---\r\nname: cool-agent\r\ndescription: A cool agent\r\n---\r\n\r\nSystem prompt body\r\n`;
    fs.writeFileSync(
      path.join(agentsDir, 'agent.md'),
      crlfAgentContent,
      'utf-8',
    );

    // Create marketplace.json specifying to load this agent
    const marketplaceDir = path.join(pluginSourceDir, '.claude-plugin');
    fs.mkdirSync(marketplaceDir, { recursive: true });

    const marketplaceConfig: ClaudeMarketplaceConfig = {
      name: 'test-marketplace',
      owner: { name: 'Test Owner', email: 'test@example.com' },
      plugins: [
        {
          name: 'crlf-agents-plugin',
          version: '1.0.0',
          source: './',
          strict: false,
          agents: ['./src-agents/agent.md'],
        },
      ],
    };

    fs.writeFileSync(
      path.join(marketplaceDir, 'marketplace.json'),
      JSON.stringify(marketplaceConfig, null, 2),
      'utf-8',
    );

    // Act: Convert
    const result = await convertClaudePluginPackage(
      pluginSourceDir,
      'crlf-agents-plugin',
    );

    // Verify: agent file was properly parsed and converted into .qwen/agents folder structure
    const convertedAgentsDir = path.join(result.convertedDir, 'agents');
    expect(fs.existsSync(convertedAgentsDir)).toBe(true);

    const convertedFiles = fs.readdirSync(convertedAgentsDir);
    expect(convertedFiles).toContain('agent.md'); // The filename is preserved from source

    // Verify it was actually parsed by checking the converted content format
    const convertedContent = fs.readFileSync(
      path.join(convertedAgentsDir, 'agent.md'),
      'utf-8',
    );
    expect(convertedContent).toContain('name: cool-agent');

    // Clean up
    fs.rmSync(result.convertedDir, { recursive: true, force: true });
  });

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
    const pluginSourceDir = path.join(testDir, 'deep-wiki-shape');
    fs.mkdirSync(pluginSourceDir, { recursive: true });

    // commands/ with two files
    const commandsDir = path.join(pluginSourceDir, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'wiki.md'), '# wiki', 'utf-8');
    fs.writeFileSync(path.join(commandsDir, 'index.md'), '# index', 'utf-8');

    // skills/ with one sub-skill
    const skillsDir = path.join(pluginSourceDir, 'skills');
    const subSkillDir = path.join(skillsDir, 'wiki-skill');
    fs.mkdirSync(subSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(subSkillDir, 'SKILL.md'),
      '# wiki-skill',
      'utf-8',
    );

    // agents/ with file entries referenced individually
    const agentsDir = path.join(pluginSourceDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, 'wiki-architect.md'),
      '---\nname: wiki-architect\ndescription: Architect\n---\nbody',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(agentsDir, 'wiki-writer.md'),
      '---\nname: wiki-writer\ndescription: Writer\n---\nbody',
      'utf-8',
    );

    // marketplace.json mirroring the microsoft/skills shape
    const marketplaceDir = path.join(pluginSourceDir, '.claude-plugin');
    fs.mkdirSync(marketplaceDir, { recursive: true });
    const marketplaceConfig: ClaudeMarketplaceConfig = {
      name: 'test-marketplace',
      owner: { name: 'Test Owner', email: 'test@example.com' },
      plugins: [
        {
          name: 'deep-wiki',
          version: '1.0.0',
          source: './',
          strict: false,
          commands: ['./commands/'],
          skills: ['./skills/'],
          agents: ['./agents/wiki-architect.md', './agents/wiki-writer.md'],
        },
      ],
    };
    fs.writeFileSync(
      path.join(marketplaceDir, 'marketplace.json'),
      JSON.stringify(marketplaceConfig, null, 2),
      'utf-8',
    );

    const result = await convertClaudePluginPackage(
      pluginSourceDir,
      'deep-wiki',
    );

    // commands/ should be populated (flattened, not nested as commands/commands)
    const convertedCommands = path.join(result.convertedDir, 'commands');
    expect(fs.existsSync(convertedCommands)).toBe(true);
    expect(fs.readdirSync(convertedCommands).sort()).toEqual([
      'index.md',
      'wiki.md',
    ]);
    expect(fs.existsSync(path.join(convertedCommands, 'commands'))).toBe(false);

    // skills/ should contain wiki-skill/SKILL.md
    const convertedSkills = path.join(result.convertedDir, 'skills');
    expect(
      fs.existsSync(path.join(convertedSkills, 'wiki-skill', 'SKILL.md')),
    ).toBe(true);
    expect(fs.existsSync(path.join(convertedSkills, 'skills'))).toBe(false);

    // agents/ should contain the two referenced files at the root
    const convertedAgents = path.join(result.convertedDir, 'agents');
    expect(fs.readdirSync(convertedAgents).sort()).toEqual([
      'wiki-architect.md',
      'wiki-writer.md',
    ]);
    expect(fs.existsSync(path.join(convertedAgents, 'agents'))).toBe(false);

    fs.rmSync(result.convertedDir, { recursive: true, force: true });
  });

  it('should populate resources when marketplace references whole folder with trailing slash variants', async () => {
    // `./commands/` (with trailing slash) and `./commands` (without) should
    // both resolve identically — the bug fix shouldn't be sensitive to the
    // exact form marketplace authors write.
    const pluginSourceDir = path.join(testDir, 'trailing-slash');
    fs.mkdirSync(pluginSourceDir, { recursive: true });
    const commandsDir = path.join(pluginSourceDir, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'a.md'), '# a', 'utf-8');

    const marketplaceDir = path.join(pluginSourceDir, '.claude-plugin');
    fs.mkdirSync(marketplaceDir, { recursive: true });
    const marketplaceConfig: ClaudeMarketplaceConfig = {
      name: 'test-marketplace',
      owner: { name: 'Test Owner', email: 'test@example.com' },
      plugins: [
        {
          name: 'no-slash',
          version: '1.0.0',
          source: './',
          strict: false,
          commands: ['./commands'], // no trailing slash
        },
      ],
    };
    fs.writeFileSync(
      path.join(marketplaceDir, 'marketplace.json'),
      JSON.stringify(marketplaceConfig, null, 2),
      'utf-8',
    );

    const result = await convertClaudePluginPackage(
      pluginSourceDir,
      'no-slash',
    );
    const convertedCommands = path.join(result.convertedDir, 'commands');
    expect(fs.existsSync(path.join(convertedCommands, 'a.md'))).toBe(true);
    fs.rmSync(result.convertedDir, { recursive: true, force: true });
  });

  it('should convert hooks from Claude plugin format to Qwen format with variable substitution', async () => {
    // Setup: Create a plugin with hooks in Claude format
    const pluginSourceDir = path.join(testDir, 'plugin-with-hooks');
    fs.mkdirSync(pluginSourceDir, { recursive: true });

    // Create hooks directory with hooks.json in Claude format
    const hooksDir = path.join(pluginSourceDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });

    const hooksJson = {
      hooks: {
        PostToolUse: [
          {
            matcher: 'post-install-matcher', // Part of HookDefinition
            sequential: true, // Part of HookDefinition
            description: 'Run after installation',
            hooks: [
              // HookConfig[] array inside HookDefinition
              {
                type: HookType.Command,
                command: '${CLAUDE_PLUGIN_ROOT}/scripts/post-install.sh',
              },
            ],
          },
        ],
      },
    };

    fs.writeFileSync(
      path.join(hooksDir, 'hooks.json'),
      JSON.stringify(hooksJson),
      'utf-8',
    );

    // Create marketplace.json
    const marketplaceDir = path.join(pluginSourceDir, '.claude-plugin');
    fs.mkdirSync(marketplaceDir, { recursive: true });

    const marketplaceConfig: ClaudeMarketplaceConfig = {
      name: 'test-marketplace',
      owner: { name: 'Test Owner', email: 'test@example.com' },
      plugins: [
        {
          name: 'hooks-plugin',
          version: '1.0.0',
          source: './',
          strict: false,
          hooks: './hooks/hooks.json', // Reference hooks from file
        },
      ],
    };

    fs.writeFileSync(
      path.join(marketplaceDir, 'marketplace.json'),
      JSON.stringify(marketplaceConfig, null, 2),
      'utf-8',
    );

    // Execute: Convert the plugin
    const result = await convertClaudePluginPackage(
      pluginSourceDir,
      'hooks-plugin',
    );

    // Verify: The converted config should contain processed hooks
    expect(result.config.hooks).toBeDefined();
    expect(result.config.hooks!['PostToolUse']).toHaveLength(1);
    // Check that the variable was substituted
    expect(
      (result.config.hooks!['PostToolUse']![0].hooks![0] as { command: string })
        .command,
    ).toBe(`${pluginSourceDir}/scripts/post-install.sh`);

    // Clean up converted directory
    fs.rmSync(result.convertedDir, { recursive: true, force: true });
  });

  it('throws when marketplace.json itself is a symlink resolving outside the plugin', async () => {
    // A hostile clone makes the marketplace manifest a symlink to a JSON-shaped
    // host file. The converter must refuse to follow it (realPathWithin guard).
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-secret-'));
    const secretFile = path.join(secretDir, 'marketplace.json');
    fs.writeFileSync(
      secretFile,
      JSON.stringify({
        name: 'leaked',
        owner: { name: 'x', email: 'x@x' },
        plugins: [{ name: 'evil', version: '1.0.0', source: './' }],
      }),
      'utf-8',
    );

    const pluginSourceDir = path.join(testDir, 'plugin-mp-symlink');
    const marketplaceDir = path.join(pluginSourceDir, '.claude-plugin');
    fs.mkdirSync(marketplaceDir, { recursive: true });
    fs.symlinkSync(secretFile, path.join(marketplaceDir, 'marketplace.json'));

    await expect(
      convertClaudePluginPackage(pluginSourceDir, 'evil'),
    ).rejects.toThrow(/resolves through a symlink outside the plugin/);

    fs.rmSync(secretDir, { recursive: true, force: true });
  });

  it('throws in strict mode when plugin.json is a symlink escaping the plugin', async () => {
    // existsSync follows the symlink so the strict-missing check passes, but the
    // target is untrusted — strict mode must fail instead of silently falling
    // back to the marketplace entry.
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-secret-'));
    const secretFile = path.join(secretDir, 'plugin.json');
    fs.writeFileSync(
      secretFile,
      JSON.stringify({ name: 'leaked', version: '9.9.9' }),
      'utf-8',
    );

    const pluginSourceDir = path.join(testDir, 'plugin-strict-symlink');
    const marketplaceDir = path.join(pluginSourceDir, '.claude-plugin');
    fs.mkdirSync(marketplaceDir, { recursive: true });
    const marketplaceConfig: ClaudeMarketplaceConfig = {
      name: 'test-marketplace',
      owner: { name: 'Test Owner', email: 'test@example.com' },
      plugins: [{ name: 'evil', version: '1.0.0', source: './', strict: true }],
    };
    fs.writeFileSync(
      path.join(marketplaceDir, 'marketplace.json'),
      JSON.stringify(marketplaceConfig, null, 2),
      'utf-8',
    );
    // plugin.json lives at pluginSource/.claude-plugin/plugin.json (source './'
    // resolves the plugin source to the package root).
    fs.symlinkSync(secretFile, path.join(marketplaceDir, 'plugin.json'));

    await expect(
      convertClaudePluginPackage(pluginSourceDir, 'evil'),
    ).rejects.toThrow(/Strict mode requires a trusted plugin\.json/);

    fs.rmSync(secretDir, { recursive: true, force: true });
  });

  it('ignores a symlinked plugin.json (non-strict) and uses the marketplace entry', async () => {
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-secret-'));
    const secretFile = path.join(secretDir, 'plugin.json');
    fs.writeFileSync(
      secretFile,
      JSON.stringify({
        name: 'leaked',
        version: '9.9.9',
        mcpServers: { leaked: { command: 'cat', args: ['/etc/passwd'] } },
      }),
      'utf-8',
    );

    const pluginSourceDir = path.join(testDir, 'plugin-nonstrict-symlink');
    const marketplaceDir = path.join(pluginSourceDir, '.claude-plugin');
    fs.mkdirSync(marketplaceDir, { recursive: true });
    const marketplaceConfig: ClaudeMarketplaceConfig = {
      name: 'test-marketplace',
      owner: { name: 'Test Owner', email: 'test@example.com' },
      plugins: [
        { name: 'evil', version: '1.0.0', source: './', strict: false },
      ],
    };
    fs.writeFileSync(
      path.join(marketplaceDir, 'marketplace.json'),
      JSON.stringify(marketplaceConfig, null, 2),
      'utf-8',
    );
    fs.symlinkSync(secretFile, path.join(marketplaceDir, 'plugin.json'));

    const result = await convertClaudePluginPackage(pluginSourceDir, 'evil');
    // The marketplace entry is used; the symlinked target is never read.
    expect(result.config.name).toBe('evil');
    expect(
      (result.config.mcpServers as Record<string, unknown> | undefined)?.[
        'leaked'
      ],
    ).toBeUndefined();

    fs.rmSync(result.convertedDir, { recursive: true, force: true });
    fs.rmSync(secretDir, { recursive: true, force: true });
  });
});

describe('convertClaudePluginStandalone', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-standalone-'));
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('converts a repo with root .claude-plugin/plugin.json, .mcp.json and skills', async () => {
    // Mirror the ClickHouse plugin layout: plugin.json metadata only, MCP in
    // a root .mcp.json, and a skills/ folder with no commands/agents.
    const pluginDir = path.join(testDir, '.claude-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'clickhouse',
        version: '1.0.0',
        description: 'ClickHouse plugin',
      }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(testDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          clickhouse: { type: 'http', url: 'https://mcp.clickhouse.cloud/mcp' },
        },
      }),
      'utf-8',
    );
    const skillDir = path.join(testDir, 'skills', 'best-practices');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '# best practices',
      'utf-8',
    );
    // A real git clone carries a .git directory; create one so the assertion
    // below actually exercises the VCS-metadata stripping in the converter.
    const gitDir = path.join(testDir, '.git');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(
      path.join(gitDir, 'HEAD'),
      'ref: refs/heads/main',
      'utf-8',
    );

    const result = await convertClaudePluginStandalone(testDir);

    // A qwen-extension.json must exist so the installer can load it.
    expect(
      fs.existsSync(path.join(result.convertedDir, 'qwen-extension.json')),
    ).toBe(true);
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
      fs.existsSync(
        path.join(result.convertedDir, 'skills', 'best-practices', 'SKILL.md'),
      ),
    ).toBe(true);
    // VCS metadata is not shipped into the installed extension.
    expect(fs.existsSync(path.join(result.convertedDir, '.git'))).toBe(false);

    fs.rmSync(result.convertedDir, { recursive: true, force: true });
  });

  it('throws when there is no .claude-plugin/plugin.json', async () => {
    await expect(convertClaudePluginStandalone(testDir)).rejects.toThrow(
      /Plugin configuration not found/,
    );
  });

  it('ignores an absolute mcpServers path so it cannot read out-of-tree files', async () => {
    // A hostile plugin.json points mcpServers at an absolute file outside the
    // plugin. The converter must NOT read it (path-confinement guard).
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-secret-'));
    const secretFile = path.join(secretDir, 'secret-mcp.json');
    fs.writeFileSync(
      secretFile,
      JSON.stringify({ leaked: { command: 'cat', args: ['/etc/passwd'] } }),
      'utf-8',
    );

    const pluginDir = path.join(testDir, '.claude-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'evil',
        version: '1.0.0',
        mcpServers: secretFile,
      }),
      'utf-8',
    );

    const result = await convertClaudePluginStandalone(testDir);
    // The absolute path was not read, so no servers were folded in.
    expect(result.config.mcpServers?.['leaked']).toBeUndefined();

    fs.rmSync(result.convertedDir, { recursive: true, force: true });
    fs.rmSync(secretDir, { recursive: true, force: true });
  });

  it('throws when plugin.json is a symlink resolving outside the plugin', async () => {
    // A hostile clone makes the manifest itself a symlink to a JSON-shaped host
    // file. The converter must refuse to follow it rather than read the target.
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-secret-'));
    const secretFile = path.join(secretDir, 'config.json');
    fs.writeFileSync(
      secretFile,
      JSON.stringify({ name: 'leaked', version: '9.9.9' }),
      'utf-8',
    );

    const pluginDir = path.join(testDir, '.claude-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.symlinkSync(secretFile, path.join(pluginDir, 'plugin.json'));

    await expect(convertClaudePluginStandalone(testDir)).rejects.toThrow(
      /resolves through a symlink outside/,
    );

    fs.rmSync(secretDir, { recursive: true, force: true });
  });

  it('does not load mcpServers from a relative path that is a symlink escaping the plugin', async () => {
    // mcpServers is a relative path whose name stays inside the plugin, but the
    // file is a symlink to a host secret. resolvePluginRelativeFile must reject
    // it so the target is never read into the config.
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-secret-'));
    const secretFile = path.join(secretDir, 'servers.json');
    fs.writeFileSync(
      secretFile,
      JSON.stringify({ leaked: { command: 'cat', args: ['/etc/passwd'] } }),
      'utf-8',
    );

    const pluginDir = path.join(testDir, '.claude-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'evil',
        version: '1.0.0',
        mcpServers: './servers.json',
      }),
      'utf-8',
    );
    fs.symlinkSync(secretFile, path.join(testDir, 'servers.json'));

    const result = await convertClaudePluginStandalone(testDir);
    const servers = result.config.mcpServers as
      | Record<string, unknown>
      | undefined;
    expect(servers?.['leaked']).toBeUndefined();

    fs.rmSync(result.convertedDir, { recursive: true, force: true });
    fs.rmSync(secretDir, { recursive: true, force: true });
  });

  it('does not copy a symlink whose target escapes the plugin directory', async () => {
    // git preserves symlinks, so a hostile repo can embed one pointing at a
    // host file. The bulk copy dereferences symlinks; without confinement the
    // target's content would be shipped inside the converted extension.
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-secret-'));
    const secretFile = path.join(secretDir, 'id_rsa');
    fs.writeFileSync(secretFile, 'TOP SECRET KEY', 'utf-8');

    const pluginDir = path.join(testDir, '.claude-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({ name: 'evil', version: '1.0.0' }),
      'utf-8',
    );
    const skillsDir = path.join(testDir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), '# ok', 'utf-8');
    // A symlink whose name stays inside the package but points outside it.
    fs.symlinkSync(secretFile, path.join(skillsDir, 'leak.txt'));

    const result = await convertClaudePluginStandalone(testDir);

    // The legitimate file is copied; the escaping symlink is dropped.
    expect(
      fs.existsSync(path.join(result.convertedDir, 'skills', 'SKILL.md')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(result.convertedDir, 'skills', 'leak.txt')),
    ).toBe(false);

    fs.rmSync(result.convertedDir, { recursive: true, force: true });
    fs.rmSync(secretDir, { recursive: true, force: true });
  });

  it('skips a .mcp.json that has no mcpServers object instead of misparsing it', async () => {
    const pluginDir = path.join(testDir, '.claude-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({ name: 'no-servers', version: '1.0.0' }),
      'utf-8',
    );
    // No `mcpServers` key — the whole object must not be treated as the map.
    fs.writeFileSync(
      path.join(testDir, '.mcp.json'),
      JSON.stringify({ name: 'foo', other: 'bar' }),
      'utf-8',
    );

    const result = await convertClaudePluginStandalone(testDir);
    expect(result.config.mcpServers).toBeUndefined();
    expect(
      (result.config.mcpServers as Record<string, unknown> | undefined)?.[
        'name'
      ],
    ).toBeUndefined();

    fs.rmSync(result.convertedDir, { recursive: true, force: true });
  });

  it('does not load a .mcp.json that is a symlink escaping the plugin', async () => {
    // .mcp.json's name stays inside the plugin but it's a symlink to a host
    // file. realPathWithin must reject it so the target servers are never read.
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-secret-'));
    const secretFile = path.join(secretDir, 'servers.json');
    fs.writeFileSync(
      secretFile,
      JSON.stringify({
        mcpServers: { leaked: { command: 'cat', args: ['/etc/passwd'] } },
      }),
      'utf-8',
    );

    const pluginDir = path.join(testDir, '.claude-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({ name: 'evil', version: '1.0.0' }),
      'utf-8',
    );
    fs.symlinkSync(secretFile, path.join(testDir, '.mcp.json'));

    const result = await convertClaudePluginStandalone(testDir);
    expect(
      (result.config.mcpServers as Record<string, unknown> | undefined)?.[
        'leaked'
      ],
    ).toBeUndefined();

    fs.rmSync(result.convertedDir, { recursive: true, force: true });
    fs.rmSync(secretDir, { recursive: true, force: true });
  });

  it('throws a clear error when plugin.json parses to null', async () => {
    // A plugin.json whose body is the JSON literal `null` would otherwise throw
    // an opaque "Cannot read properties of null" on the mcpServers deref.
    const pluginDir = path.join(testDir, '.claude-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), 'null', 'utf-8');

    await expect(convertClaudePluginStandalone(testDir)).rejects.toThrow(
      /Invalid plugin configuration/,
    );
  });
});

describe('performVariableReplacement for Claude extensions', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-var-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should replace .claude with .qwen in shell scripts', () => {
    const extDir = path.join(testDir, 'ext-sh');
    fs.mkdirSync(extDir, { recursive: true });

    const shContent = `#!/bin/bash
      CONFIG_DIR="$HOME/.claude/config"
      CACHE_DIR="~/.claude/cache"
      LOCAL_DIR="./.claude/local"`;
    fs.writeFileSync(path.join(extDir, 'setup.sh'), shContent, 'utf-8');

    performVariableReplacement(extDir);

    const result = fs.readFileSync(path.join(extDir, 'setup.sh'), 'utf-8');
    expect(result).toContain('$HOME/.qwen/config');
    expect(result).toContain('~/.qwen/cache');
    expect(result).toContain('./.qwen/local');
    expect(result).not.toContain('.claude');
  });

  it('should replace role with type in shell scripts', () => {
    const extDir = path.join(testDir, 'ext-role');
    fs.mkdirSync(extDir, { recursive: true });

    const shContent = `#!/bin/bash
      echo '{"role":"assistant","content":"hello"}'`;
    fs.writeFileSync(path.join(extDir, 'process.sh'), shContent, 'utf-8');

    performVariableReplacement(extDir);

    const result = fs.readFileSync(path.join(extDir, 'process.sh'), 'utf-8');
    expect(result).toContain('"type":"assistant"');
    expect(result).not.toContain('"role":"assistant"');
  });

  it('should update transcript parsing logic in shell scripts', () => {
    const extDir = path.join(testDir, 'ext-transcript');
    fs.mkdirSync(extDir, { recursive: true });

    const shContent = `#!/bin/bash
      echo "$transcript" | jq '.message.content | map(select(.type == "text"))'`;
    fs.writeFileSync(path.join(extDir, 'parse.sh'), shContent, 'utf-8');

    performVariableReplacement(extDir);

    const result = fs.readFileSync(path.join(extDir, 'parse.sh'), 'utf-8');
    expect(result).toContain('.message.parts | map(select(has("text")))');
    expect(result).not.toContain('.message.content');
  });
});

describe('convertClaudePluginPackage — git-subdir source', () => {
  let extDir: string;

  beforeEach(() => {
    extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-gitsub-'));
    vi.mocked(cloneFromGit).mockReset();
  });

  afterEach(() => {
    if (fs.existsSync(extDir)) {
      fs.rmSync(extDir, { recursive: true, force: true });
    }
  });

  // Writes a marketplace.json declaring a single git-subdir plugin.
  const writeMarketplace = (source: unknown) => {
    const mp = path.join(extDir, '.claude-plugin');
    fs.mkdirSync(mp, { recursive: true });
    fs.writeFileSync(
      path.join(mp, 'marketplace.json'),
      JSON.stringify({
        name: 'm',
        owner: { name: 'o', email: 'e' },
        plugins: [{ name: 'p', version: '1.0.0', source }],
      }),
      'utf-8',
    );
  };

  it('clones, pins to the sha over the ref, and returns the subdirectory', async () => {
    vi.mocked(cloneFromGit).mockImplementation(async (_meta, dir) => {
      const sub = path.join(dir as string, 'packages', 'plugin');
      fs.mkdirSync(path.join(sub, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(sub, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'p', version: '1.0.0' }),
        'utf-8',
      );
    });

    writeMarketplace({
      source: 'git-subdir',
      url: 'https://example.com/repo.git',
      path: 'packages/plugin',
      ref: 'main',
      sha: 'abc123',
    });

    const result = await convertClaudePluginPackage(extDir, 'p');
    expect(result.config.name).toBe('p');
    // The immutable sha is preferred over the named ref when both are present.
    const meta = vi.mocked(cloneFromGit).mock.calls[0][0] as { ref?: string };
    expect(meta.ref).toBe('abc123');

    fs.rmSync(result.convertedDir, { recursive: true, force: true });
  });

  it('rejects a subdirectory that escapes the repository root', async () => {
    vi.mocked(cloneFromGit).mockResolvedValue(undefined as never);
    writeMarketplace({
      source: 'git-subdir',
      url: 'https://example.com/repo.git',
      path: '../../etc',
    });
    await expect(convertClaudePluginPackage(extDir, 'p')).rejects.toThrow(
      /escapes the repository root/,
    );
  });

  it('rejects an absolute subdirectory path', async () => {
    vi.mocked(cloneFromGit).mockResolvedValue(undefined as never);
    writeMarketplace({
      source: 'git-subdir',
      url: 'https://example.com/repo.git',
      path: path.resolve(path.sep, 'etc'),
    });
    await expect(convertClaudePluginPackage(extDir, 'p')).rejects.toThrow(
      /Invalid plugin subdirectory/,
    );
  });

  it('rejects a missing subdirectory', async () => {
    vi.mocked(cloneFromGit).mockImplementation(async (_meta, dir) => {
      // The clone succeeded but does not contain the requested subdir.
      fs.mkdirSync(path.join(dir as string, 'other'), { recursive: true });
    });
    writeMarketplace({
      source: 'git-subdir',
      url: 'https://example.com/repo.git',
      path: 'packages/missing',
    });
    await expect(convertClaudePluginPackage(extDir, 'p')).rejects.toThrow(
      /not found/,
    );
  });

  it('rejects a subdirectory that is a symlink escaping the clone', async () => {
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-secret-'));
    fs.writeFileSync(path.join(secretDir, 'SKILL.md'), 'secret', 'utf-8');
    vi.mocked(cloneFromGit).mockImplementation(async (_meta, dir) => {
      // A hostile repo commits the subdir as a symlink whose name stays inside
      // the clone but whose target escapes it.
      fs.symlinkSync(secretDir, path.join(dir as string, 'sub'));
    });
    writeMarketplace({
      source: 'git-subdir',
      url: 'https://example.com/repo.git',
      path: 'sub',
    });

    await expect(convertClaudePluginPackage(extDir, 'p')).rejects.toThrow(
      /resolves through a symlink/,
    );

    fs.rmSync(secretDir, { recursive: true, force: true });
  });
});
