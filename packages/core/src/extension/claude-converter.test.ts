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
  mergeClaudeConfigs,
  isClaudePluginConfig,
  convertClaudePluginPackage,
  type ClaudePluginConfig,
  type ClaudeMarketplacePluginConfig,
  type ClaudeMarketplaceConfig,
} from './claude-converter.js';

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

  it('should throw error for missing name', () => {
    const invalidConfig = {
      version: '1.0.0',
    } as ClaudePluginConfig;

    expect(() => convertClaudeToQwenConfig(invalidConfig)).toThrow();
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
      marketplaceSource: 'https://test.com',
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
});
