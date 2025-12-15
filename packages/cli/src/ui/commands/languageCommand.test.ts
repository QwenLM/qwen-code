/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { type CommandContext, CommandKind } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

// Mock i18n module
vi.mock('../../i18n/index.js', () => ({
  setLanguageAsync: vi.fn().mockResolvedValue(undefined),
  getCurrentLanguage: vi.fn().mockReturnValue('en'),
  t: vi.fn((key: string) => key),
}));

// Mock settings module to avoid Storage side effect
vi.mock('../../config/settings.js', () => ({
  SettingScope: {
    User: 'user',
    Workspace: 'workspace',
    Default: 'default',
  },
}));

// Mock fs module
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    default: {
      ...actual,
      existsSync: vi.fn(),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    },
  };
});

// Mock Storage from core
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    Storage: {
      getGlobalQwenDir: vi.fn().mockReturnValue('/mock/.qwen'),
      getGlobalSettingsPath: vi.fn().mockReturnValue('/mock/.qwen/settings.json'),
    },
  };
});

// Import modules after mocking
import * as i18n from '../../i18n/index.js';
import { languageCommand } from './languageCommand.js';

describe('languageCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockContext = createMockCommandContext({
      services: {
        config: {
          getModel: vi.fn().mockReturnValue('test-model'),
        },
        settings: {
          merged: {},
          setValue: vi.fn(),
        },
      },
    });

    // Reset i18n mocks
    vi.mocked(i18n.getCurrentLanguage).mockReturnValue('en');
    vi.mocked(i18n.t).mockImplementation((key: string) => key);

    // Reset fs mocks
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('command metadata', () => {
    it('should have the correct name', () => {
      expect(languageCommand.name).toBe('language');
    });

    it('should have a description', () => {
      expect(languageCommand.description).toBeDefined();
      expect(typeof languageCommand.description).toBe('string');
    });

    it('should be a built-in command', () => {
      expect(languageCommand.kind).toBe(CommandKind.BUILT_IN);
    });

    it('should have subcommands', () => {
      expect(languageCommand.subCommands).toBeDefined();
      expect(languageCommand.subCommands?.length).toBe(2);
    });

    it('should have ui and output subcommands', () => {
      const subCommandNames = languageCommand.subCommands?.map((c) => c.name);
      expect(subCommandNames).toContain('ui');
      expect(subCommandNames).toContain('output');
    });
  });

  describe('main command action - no arguments', () => {
    it('should show current language settings when no arguments provided', async () => {
      if (!languageCommand.action) {
        throw new Error('The language command must have an action.');
      }

      const result = await languageCommand.action(mockContext, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('Current UI language:'),
      });
    });

    it('should show available subcommands in help', async () => {
      if (!languageCommand.action) {
        throw new Error('The language command must have an action.');
      }

      const result = await languageCommand.action(mockContext, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('/language ui'),
      });
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('/language output'),
      });
    });

    it('should show LLM output language when set', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        '# CRITICAL: Chinese Output Language Rule - HIGHEST PRIORITY',
      );

      // Make t() function handle interpolation for this test
      vi.mocked(i18n.t).mockImplementation(
        (key: string, params?: Record<string, string>) => {
          if (params && key.includes('{{lang}}')) {
            return key.replace('{{lang}}', params['lang'] || '');
          }
          return key;
        },
      );

      if (!languageCommand.action) {
        throw new Error('The language command must have an action.');
      }

      const result = await languageCommand.action(mockContext, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('Current UI language:'),
      });
      // Verify it correctly parses "Chinese" from the template format
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('Chinese'),
      });
    });
  });

  describe('main command action - config not available', () => {
    it('should return error when config is null', async () => {
      mockContext.services.config = null;

      if (!languageCommand.action) {
        throw new Error('The language command must have an action.');
      }

      const result = await languageCommand.action(mockContext, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Configuration not available'),
      });
    });
  });

  describe('/language ui subcommand', () => {
    it('should show help when no language argument provided', async () => {
      if (!languageCommand.action) {
        throw new Error('The language command must have an action.');
      }

      const result = await languageCommand.action(mockContext, 'ui');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('Usage: /language ui'),
      });
    });

    it('should set English with "en"', async () => {
      if (!languageCommand.action) {
        throw new Error('The language command must have an action.');
      }

      const result = await languageCommand.action(mockContext, 'ui en');

      expect(i18n.setLanguageAsync).toHaveBeenCalledWith('en');
      expect(mockContext.services.settings.setValue).toHaveBeenCalled();
      expect(mockContext.ui.reloadCommands).toHaveBeenCalled();
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('UI language changed'),
      });
    });

    it('should set English with "en-US"', async () => {
      if (!languageCommand.action) {
        throw new Error('The language command must have an action.');
      }

      const result = await languageCommand.action(mockContext, 'ui en-US');

      expect(i18n.setLanguageAsync).toHaveBeenCalledWith('en');
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('UI language changed'),
      });
    });

    it('should set English with "english"', async () => {
      if (!languageCommand.action) {
        throw new Error('The language command must have an action.');
      }

      const result = await languageCommand.action(mockContext, 'ui english');

      expect(i18n.setLanguageAsync).toHaveBeenCalledWith('en');
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('UI language changed'),
      });
    });

    it('should set Chinese with "zh"', async () => {
      if (!languageCommand.action) {
        throw new Error('The language command must have an action.');
      }

      const result = await languageCommand.action(mockContext, 'ui zh');

      expect(i18n.setLanguageAsync).toHaveBeenCalledWith('zh');
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('UI language changed'),
      });
    });

    it('should set Chinese with "zh-CN"', async () => {
      if (!languageCommand.action) {
        throw new Error('The language command must have an action.');
      }

      const result = await languageCommand.action(mockContext, 'ui zh-CN');

      expect(i18n.setLanguageAsync).toHaveBeenCalledWith('zh');
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('UI language changed'),
      });
    });

    it('should set Chinese with "chinese"', async () => {
      if (!languageCommand.action) {
        throw new Error('The language command must have an action.');
      }

      const result = await languageCommand.action(mockContext, 'ui chinese');

      expect(i18n.setLanguageAsync).toHaveBeenCalledWith('zh');
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('UI language changed'),
      });
    });

    it('should return error for invalid language', async () => {
      if (!languageCommand.action) {
        throw new Error('The language command must have an action.');
      }

      const result = await languageCommand.action(mockContext, 'ui invalid');

      expect(i18n.setLanguageAsync).not.toHaveBeenCalled();
      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Invalid language'),
      });
    });

    it('should persist setting to user scope', async () => {
      if (!languageCommand.action) {
        throw new Error('The language command must have an action.');
      }

      await languageCommand.action(mockContext, 'ui en');

      expect(mockContext.services.settings.setValue).toHaveBeenCalledWith(
        expect.anything(), // SettingScope.User
        'general.language',
        'en',
      );
    });
  });

  describe('/language output subcommand', () => {
    it('should show help when no language argument provided', async () => {
      if (!languageCommand.action) {
        throw new Error('The language command must have an action.');
      }

      const result = await languageCommand.action(mockContext, 'output');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('Usage: /language output'),
      });
    });

    it('should create LLM output language rule file', async () => {
      if (!languageCommand.action) {
        throw new Error('The language command must have an action.');
      }

      const result = await languageCommand.action(mockContext, 'output Chinese');

      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('output-language.md'),
        expect.stringContaining('Chinese'),
        'utf-8',
      );
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('LLM output language rule file generated'),
      });
    });

    it('should include restart notice in success message', async () => {
      if (!languageCommand.action) {
        throw new Error('The language command must have an action.');
      }

      const result = await languageCommand.action(mockContext, 'output Japanese');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('restart'),
      });
    });

    it('should handle file write errors gracefully', async () => {
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw new Error('Permission denied');
      });

      if (!languageCommand.action) {
        throw new Error('The language command must have an action.');
      }

      const result = await languageCommand.action(mockContext, 'output German');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Failed to generate'),
      });
    });
  });

  describe('backward compatibility - direct language arguments', () => {
    it('should set Chinese with direct "zh" argument', async () => {
      if (!languageCommand.action) {
        throw new Error('The language command must have an action.');
      }

      const result = await languageCommand.action(mockContext, 'zh');

      expect(i18n.setLanguageAsync).toHaveBeenCalledWith('zh');
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('UI language changed'),
      });
    });

    it('should set English with direct "en" argument', async () => {
      if (!languageCommand.action) {
        throw new Error('The language command must have an action.');
      }

      const result = await languageCommand.action(mockContext, 'en');

      expect(i18n.setLanguageAsync).toHaveBeenCalledWith('en');
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('UI language changed'),
      });
    });

    it('should return error for unknown direct argument', async () => {
      if (!languageCommand.action) {
        throw new Error('The language command must have an action.');
      }

      const result = await languageCommand.action(mockContext, 'unknown');

      expect(i18n.setLanguageAsync).not.toHaveBeenCalled();
      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Invalid command'),
      });
    });
  });

  describe('ui subcommand object', () => {
    const uiSubcommand = languageCommand.subCommands?.find(
      (c) => c.name === 'ui',
    );

    it('should have correct metadata', () => {
      expect(uiSubcommand).toBeDefined();
      expect(uiSubcommand?.name).toBe('ui');
      expect(uiSubcommand?.kind).toBe(CommandKind.BUILT_IN);
    });

    it('should have nested language subcommands', () => {
      const nestedNames = uiSubcommand?.subCommands?.map((c) => c.name);
      expect(nestedNames).toContain('zh-CN');
      expect(nestedNames).toContain('en-US');
    });

    it('should have action that sets language', async () => {
      if (!uiSubcommand?.action) {
        throw new Error('UI subcommand must have an action.');
      }

      const result = await uiSubcommand.action(mockContext, 'en');

      expect(i18n.setLanguageAsync).toHaveBeenCalledWith('en');
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('UI language changed'),
      });
    });
  });

  describe('output subcommand object', () => {
    const outputSubcommand = languageCommand.subCommands?.find(
      (c) => c.name === 'output',
    );

    it('should have correct metadata', () => {
      expect(outputSubcommand).toBeDefined();
      expect(outputSubcommand?.name).toBe('output');
      expect(outputSubcommand?.kind).toBe(CommandKind.BUILT_IN);
    });

    it('should have action that generates rule file', async () => {
      if (!outputSubcommand?.action) {
        throw new Error('Output subcommand must have an action.');
      }

      // Ensure mocks are properly set for this test
      vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
      vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);

      const result = await outputSubcommand.action(mockContext, 'French');

      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('LLM output language rule file generated'),
      });
    });
  });

  describe('nested ui language subcommands', () => {
    const uiSubcommand = languageCommand.subCommands?.find(
      (c) => c.name === 'ui',
    );
    const zhCNSubcommand = uiSubcommand?.subCommands?.find(
      (c) => c.name === 'zh-CN',
    );
    const enUSSubcommand = uiSubcommand?.subCommands?.find(
      (c) => c.name === 'en-US',
    );

    it('zh-CN should have aliases', () => {
      expect(zhCNSubcommand?.altNames).toContain('zh');
      expect(zhCNSubcommand?.altNames).toContain('chinese');
    });

    it('en-US should have aliases', () => {
      expect(enUSSubcommand?.altNames).toContain('en');
      expect(enUSSubcommand?.altNames).toContain('english');
    });

    it('zh-CN action should set Chinese', async () => {
      if (!zhCNSubcommand?.action) {
        throw new Error('zh-CN subcommand must have an action.');
      }

      const result = await zhCNSubcommand.action(mockContext, '');

      expect(i18n.setLanguageAsync).toHaveBeenCalledWith('zh');
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('UI language changed'),
      });
    });

    it('en-US action should set English', async () => {
      if (!enUSSubcommand?.action) {
        throw new Error('en-US subcommand must have an action.');
      }

      const result = await enUSSubcommand.action(mockContext, '');

      expect(i18n.setLanguageAsync).toHaveBeenCalledWith('en');
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('UI language changed'),
      });
    });

    it('should reject extra arguments', async () => {
      if (!zhCNSubcommand?.action) {
        throw new Error('zh-CN subcommand must have an action.');
      }

      const result = await zhCNSubcommand.action(mockContext, 'extra args');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('do not accept additional arguments'),
      });
    });
  });
});
