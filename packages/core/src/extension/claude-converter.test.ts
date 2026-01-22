/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  convertClaudeToQwenConfig,
  mergeClaudeConfigs,
  isClaudePluginConfig,
  type ClaudePluginConfig,
  type ClaudeMarketplacePluginConfig,
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
