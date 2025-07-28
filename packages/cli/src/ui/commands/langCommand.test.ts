/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { langCommand, SUPPORTED_LANGUAGES, getLanguageByCode, getCurrentLanguage } from './langCommand.js';
import { CommandContext } from './types.js';
import { SettingScope } from '../../config/settings.js';

// Mock CommandContext
const createMockContext = (): CommandContext => ({
  services: {
    settings: {
      merged: {},
      setValue: vi.fn(),
    },
  },
}) as any;

describe('langCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = createMockContext();
    vi.clearAllMocks();
    // Clear environment variable for consistent tests
    delete process.env.MINE_AI_LANGUAGE;
  });

  describe('getLanguageByCode', () => {
    it('should return correct language for valid code', () => {
      const result = getLanguageByCode('zh');
      expect(result).toEqual({ code: 'zh', name: 'Chinese', nativeName: '中文' });
    });

    it('should return correct language for valid code with different case', () => {
      const result = getLanguageByCode('ZH-CN');
      expect(result).toEqual({ code: 'zh-CN', name: 'Chinese (Simplified)', nativeName: '简体中文' });
    });

    it('should return undefined for invalid code', () => {
      const result = getLanguageByCode('invalid');
      expect(result).toBeUndefined();
    });
  });

  describe('getCurrentLanguage', () => {
    it('should return English as default when no settings', () => {
      const result = getCurrentLanguage({});
      expect(result).toEqual(SUPPORTED_LANGUAGES[0]); // English
    });

    it('should return language from settings', () => {
      const settings = { merged: { language: 'zh' } };
      const result = getCurrentLanguage(settings);
      expect(result?.code).toBe('zh');
    });

    it('should return language from environment variable', () => {
      process.env.MINE_AI_LANGUAGE = 'ja';
      const result = getCurrentLanguage({});
      expect(result?.code).toBe('ja');
    });

    it('should prioritize settings over environment variable', () => {
      process.env.MINE_AI_LANGUAGE = 'ja';
      const settings = { merged: { language: 'ko' } };
      const result = getCurrentLanguage(settings);
      expect(result?.code).toBe('ko');
    });
  });

  describe('langCommand action', () => {
    it('should display current language and available languages when no args', async () => {
      const result = await langCommand.action!(mockContext, '');
      
      expect(result).toBeDefined();
      expect(result?.type).toBe('message');
      expect(result?.messageType).toBe('info');
      expect(result?.content).toContain('Current Language');
      expect(result?.content).toContain('Available Languages');
      expect(result?.content).toContain('/lang zh');
    });

    it('should set new language successfully', async () => {
      const result = await langCommand.action!(mockContext, 'zh');
      
      expect(mockContext.services.settings.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'language',
        'zh'
      );
      expect(result?.type).toBe('message');
      expect(result?.messageType).toBe('info');
      expect(result?.content).toContain('语言已更改为');
    });

    it('should return error for unsupported language', async () => {
      const result = await langCommand.action!(mockContext, 'invalid');
      
      expect(result?.type).toBe('message');
      expect(result?.messageType).toBe('error');
      expect(result?.content).toContain('Language not supported');
    });

    it('should handle setting save errors gracefully', async () => {
      vi.mocked(mockContext.services.settings.setValue).mockImplementation(() => {
        throw new Error('Save failed');
      });

      const result = await langCommand.action!(mockContext, 'zh');
      
      expect(result?.type).toBe('message');
      expect(result?.messageType).toBe('error');
      expect(result?.content).toContain('Failed to save language setting');
    });
  });

  describe('langCommand completion', () => {
    it('should return all language codes when no partial arg', async () => {
      const result = await langCommand.completion!(mockContext, '');
      
      expect(result).toHaveLength(SUPPORTED_LANGUAGES.length);
      expect(result).toContain('en');
      expect(result).toContain('zh');
    });

    it('should filter language codes by partial arg', async () => {
      const result = await langCommand.completion!(mockContext, 'zh');
      
      expect(result).toEqual(['zh', 'zh-CN', 'zh-TW']);
    });

    it('should be case insensitive', async () => {
      const result = await langCommand.completion!(mockContext, 'ZH');
      
      expect(result).toEqual(['zh', 'zh-CN', 'zh-TW']);
    });
  });
}); 