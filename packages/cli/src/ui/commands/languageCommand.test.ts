/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { type CommandContext, CommandKind } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { LoadedSettings } from '../../config/settings.js';

// Mock i18n module
vi.mock('../../i18n/index.js', () => ({
  setLanguageAsync: vi.fn().mockResolvedValue(undefined),
  getCurrentLanguage: vi.fn().mockReturnValue('en'),
  detectSystemLanguage: vi.fn().mockReturnValue('en'),
  getLanguageNameFromLocale: vi.fn((locale: string) => {
    const map: Record<string, string> = {
      zh: 'Chinese',
      en: 'English',
      ru: 'Russian',
      de: 'German',
      ja: 'Japanese',
      pt: 'Portuguese',
    };
    return map[locale] || 'English';
  }),
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
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    Storage: {
      getGlobalQwenDir: vi.fn().mockReturnValue('/mock/.qwen'),
      getGlobalSettingsPath: vi
        .fn()
        .mockReturnValue('/mock/.qwen/settings.json'),
    },
  };
});

// Import modules after mocking
import * as i18n from '../../i18n/index.js';
import { SUPPORTED_LANGUAGES } from '../../i18n/languages.js';
import { languageCommand } from './languageCommand.js';
import { initializeLlmOutputLanguage } from '../../utils/languageUtils.js';

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

    it('should show LLM output language when explicitly set', async () => {
      // Set the outputLanguage setting explicitly
      mockContext.services.settings = {
        ...mockContext.services.settings,
        merged: { general: { outputLanguage: 'Chinese' } },
        setValue: vi.fn(),
      } as unknown as LoadedSettings;

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
      // Verify it shows "Chinese" for the explicitly set language
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('Chinese'),
      });
    });

    it('should show auto-detected language when set to auto', async () => {
      // Set the outputLanguage setting to 'auto'
      mockContext.services.settings = {
        ...mockContext.services.settings,
        merged: { general: { outputLanguage: 'auto' } },
        setValue: vi.fn(),
      } as unknown as LoadedSettings;
      vi.mocked(i18n.detectSystemLanguage).mockReturnValue('zh');

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

      // Verify it shows "Auto (detect from system) → Chinese"
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('Auto (detect from system)'),
      });
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

    it('should save LLM output language setting', async () => {
      if (!languageCommand.action) {
        throw new Error('The language command must have an action.');
      }

      const result = await languageCommand.action(
        mockContext,
        'output Chinese',
      );

      // Verify setting was saved (rule file is updated on restart)
      expect(mockContext.services.settings?.setValue).toHaveBeenCalledWith(
        expect.anything(), // SettingScope.User
        'general.outputLanguage',
        'Chinese',
      );
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('LLM output language set to'),
      });
    });

    it('should include restart notice in success message', async () => {
      if (!languageCommand.action) {
        throw new Error('The language command must have an action.');
      }

      const result = await languageCommand.action(
        mockContext,
        'output Japanese',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('restart'),
      });
    });

    it('should normalize locale code "ru" to "Russian"', async () => {
      if (!languageCommand.action) {
        throw new Error('The language command must have an action.');
      }

      await languageCommand.action(mockContext, 'output ru');

      // Verify setting was saved with normalized value
      expect(mockContext.services.settings?.setValue).toHaveBeenCalledWith(
        expect.anything(),
        'general.outputLanguage',
        'Russian',
      );
    });

    it('should normalize locale code "de" to "German"', async () => {
      if (!languageCommand.action) {
        throw new Error('The language command must have an action.');
      }

      await languageCommand.action(mockContext, 'output de');

      // Verify setting was saved with normalized value
      expect(mockContext.services.settings?.setValue).toHaveBeenCalledWith(
        expect.anything(),
        'general.outputLanguage',
        'German',
      );
    });

    it('should save setting without immediate rule file update', async () => {
      // Even though rule file updates happen on restart, the setting should still be saved
      if (!languageCommand.action) {
        throw new Error('The language command must have an action.');
      }

      const result = await languageCommand.action(
        mockContext,
        'output Spanish',
      );

      // Verify setting was saved
      expect(mockContext.services.settings?.setValue).toHaveBeenCalledWith(
        expect.anything(),
        'general.outputLanguage',
        'Spanish',
      );
      // Verify success message (no error about file generation)
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('LLM output language set to'),
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
      for (const lang of SUPPORTED_LANGUAGES) {
        expect(nestedNames).toContain(lang.id);
      }
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

    it('should have action that saves setting', async () => {
      if (!outputSubcommand?.action) {
        throw new Error('Output subcommand must have an action.');
      }

      const result = await outputSubcommand.action(mockContext, 'French');

      // Verify setting was saved (rule file is updated on restart)
      expect(mockContext.services.settings?.setValue).toHaveBeenCalledWith(
        expect.anything(),
        'general.outputLanguage',
        'French',
      );
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('LLM output language set to'),
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
    const deDESubcommand = uiSubcommand?.subCommands?.find(
      (c) => c.name === 'de-DE',
    );

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

    it('de-DE action should set German', async () => {
      if (!deDESubcommand?.action) {
        throw new Error('de-DE subcommand must have an action.');
      }

      const result = await deDESubcommand.action(mockContext, '');

      expect(i18n.setLanguageAsync).toHaveBeenCalledWith('de');
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('UI language changed'),
      });
    });

    const jaJPSubcommand = uiSubcommand?.subCommands?.find(
      (c) => c.name === 'ja-JP',
    );
    it('ja-JP action should set Japanese', async () => {
      if (!jaJPSubcommand?.action) {
        throw new Error('ja-JP subcommand must have an action.');
      }

      const result = await jaJPSubcommand.action(mockContext, '');

      expect(i18n.setLanguageAsync).toHaveBeenCalledWith('ja');
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

  describe('initializeLlmOutputLanguage', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
      vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);
      vi.mocked(fs.readFileSync).mockImplementation(() => '');
    });

    it('should create file when it does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(i18n.detectSystemLanguage).mockReturnValue('en');

      initializeLlmOutputLanguage();

      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('output-language.md'),
        expect.stringContaining('English'),
        'utf-8',
      );
    });

    it('should NOT overwrite existing file when content matches resolved language', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(i18n.detectSystemLanguage).mockReturnValue('en');
      vi.mocked(fs.readFileSync).mockReturnValue(
        `# Output language preference: English
<!-- qwen-code:llm-output-language: English -->
`,
      );

      initializeLlmOutputLanguage();

      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('should overwrite existing file when output language setting differs', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        `# Output language preference: English
<!-- qwen-code:llm-output-language: English -->
`,
      );

      initializeLlmOutputLanguage('Japanese');

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('output-language.md'),
        expect.stringContaining('Japanese'),
        'utf-8',
      );
    });

    it('should resolve auto setting to detected system language', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(i18n.detectSystemLanguage).mockReturnValue('zh');

      initializeLlmOutputLanguage('auto');

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('output-language.md'),
        expect.stringContaining('Chinese'),
        'utf-8',
      );
    });

    it('should detect Chinese locale and create Chinese rule file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(i18n.detectSystemLanguage).mockReturnValue('zh');

      initializeLlmOutputLanguage();

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('output-language.md'),
        expect.stringContaining('Chinese'),
        'utf-8',
      );
    });

    it('should detect Russian locale and create Russian rule file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(i18n.detectSystemLanguage).mockReturnValue('ru');

      initializeLlmOutputLanguage();

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('output-language.md'),
        expect.stringContaining('Russian'),
        'utf-8',
      );
    });

    it('should detect German locale and create German rule file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(i18n.detectSystemLanguage).mockReturnValue('de');

      initializeLlmOutputLanguage();

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('output-language.md'),
        expect.stringContaining('German'),
        'utf-8',
      );
    });

    it('should detect Japanese locale and create Japanese rule file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(i18n.detectSystemLanguage).mockReturnValue('ja');

      initializeLlmOutputLanguage();

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('output-language.md'),
        expect.stringContaining('Japanese'),
        'utf-8',
      );
    });

    it('should detect Portuguese locale and create Portuguese rule file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(i18n.detectSystemLanguage).mockReturnValue('pt');

      initializeLlmOutputLanguage();

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('output-language.md'),
        expect.stringContaining('Portuguese'),
        'utf-8',
      );
    });
  });
});
