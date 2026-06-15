/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import { HookType } from '../hooks/types.js';
import { performVariableReplacement } from './variables.js';

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
