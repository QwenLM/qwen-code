/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Mock fs module
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// Mock i18n module
vi.mock('../i18n/index.js', () => ({
  detectSystemLanguage: vi.fn(),
  getLanguageNameFromLocale: vi.fn((locale: string) => {
    const map: Record<string, string> = {
      en: 'English',
      zh: 'Chinese',
      ru: 'Russian',
      de: 'German',
      ja: 'Japanese',
      ko: 'Korean',
      fr: 'French',
      es: 'Spanish',
    };
    return map[locale] || 'English';
  }),
}));

// Mock @qwen-code/qwen-code-core
vi.mock('@qwen-code/qwen-code-core', () => ({
  Storage: {
    getGlobalQwenDir: vi.fn(() => '/mock/home/.qwen'),
  },
}));

import * as i18n from '../i18n/index.js';
import {
  OUTPUT_LANGUAGE_AUTO,
  isAutoLanguage,
  normalizeOutputLanguage,
  resolveOutputLanguage,
  writeOutputLanguageFile,
  updateOutputLanguageFile,
  initializeLlmOutputLanguage,
} from './languageUtils.js';

describe('languageUtils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('OUTPUT_LANGUAGE_AUTO', () => {
    it('should be "auto"', () => {
      expect(OUTPUT_LANGUAGE_AUTO).toBe('auto');
    });
  });

  describe('isAutoLanguage', () => {
    it('should return true for "auto"', () => {
      expect(isAutoLanguage('auto')).toBe(true);
    });

    it('should return true for "AUTO" (case insensitive)', () => {
      expect(isAutoLanguage('AUTO')).toBe(true);
    });

    it('should return true for "Auto" (case insensitive)', () => {
      expect(isAutoLanguage('Auto')).toBe(true);
    });

    it('should return true for undefined', () => {
      expect(isAutoLanguage(undefined)).toBe(true);
    });

    it('should return true for null', () => {
      expect(isAutoLanguage(null)).toBe(true);
    });

    it('should return true for empty string', () => {
      expect(isAutoLanguage('')).toBe(true);
    });

    it('should return false for explicit language', () => {
      expect(isAutoLanguage('Chinese')).toBe(false);
    });

    it('should return false for locale code', () => {
      expect(isAutoLanguage('zh')).toBe(false);
    });
  });

  describe('normalizeOutputLanguage', () => {
    it('should convert "en" to "English"', () => {
      expect(normalizeOutputLanguage('en')).toBe('English');
    });

    it('should convert "zh" to "Chinese"', () => {
      expect(normalizeOutputLanguage('zh')).toBe('Chinese');
    });

    it('should convert "ru" to "Russian"', () => {
      expect(normalizeOutputLanguage('ru')).toBe('Russian');
    });

    it('should convert "de" to "German"', () => {
      expect(normalizeOutputLanguage('de')).toBe('German');
    });

    it('should convert "ja" to "Japanese"', () => {
      expect(normalizeOutputLanguage('ja')).toBe('Japanese');
    });

    it('should be case insensitive for locale codes', () => {
      expect(normalizeOutputLanguage('ZH')).toBe('Chinese');
      expect(normalizeOutputLanguage('Ru')).toBe('Russian');
    });

    it('should preserve explicit language names as-is', () => {
      expect(normalizeOutputLanguage('Japanese')).toBe('Japanese');
      expect(normalizeOutputLanguage('French')).toBe('French');
    });

    it('should preserve unknown language names as-is', () => {
      expect(normalizeOutputLanguage('CustomLanguage')).toBe('CustomLanguage');
      expect(normalizeOutputLanguage('日本語')).toBe('日本語');
    });
  });

  describe('resolveOutputLanguage', () => {
    it('should resolve "auto" to detected system language', () => {
      vi.mocked(i18n.detectSystemLanguage).mockReturnValue('zh');

      expect(resolveOutputLanguage('auto')).toBe('Chinese');
      expect(i18n.detectSystemLanguage).toHaveBeenCalled();
    });

    it('should resolve undefined to detected system language', () => {
      vi.mocked(i18n.detectSystemLanguage).mockReturnValue('ru');

      expect(resolveOutputLanguage(undefined)).toBe('Russian');
    });

    it('should resolve null to detected system language', () => {
      vi.mocked(i18n.detectSystemLanguage).mockReturnValue('de');

      expect(resolveOutputLanguage(null)).toBe('German');
    });

    it('should normalize explicit locale codes', () => {
      expect(resolveOutputLanguage('zh')).toBe('Chinese');
      expect(i18n.detectSystemLanguage).not.toHaveBeenCalled();
    });

    it('should preserve explicit language names', () => {
      expect(resolveOutputLanguage('Japanese')).toBe('Japanese');
    });
  });

  describe('writeOutputLanguageFile', () => {
    beforeEach(() => {
      vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
      vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);
    });

    it('should create directory and write file', () => {
      writeOutputLanguageFile('Chinese');

      const globalDir = '/mock/home/.qwen';
      const expectedDir = path.join(globalDir);
      const expectedFilePath = path.join(globalDir, 'output-language.md');

      expect(fs.mkdirSync).toHaveBeenCalledWith(expectedDir, {
        recursive: true,
      });
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expectedFilePath,
        expect.any(String),
        'utf-8',
      );
    });

    it('should include language in file content', () => {
      writeOutputLanguageFile('Japanese');

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1];
      expect(writtenContent).toContain('Japanese');
      expect(writtenContent).toContain(
        '# Output language preference: Japanese',
      );
    });

    it('should include machine-readable marker', () => {
      writeOutputLanguageFile('Chinese');

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1];
      expect(writtenContent).toContain(
        '<!-- qwen-code:llm-output-language: Chinese -->',
      );
    });

    it('should sanitize language for marker (remove dangerous characters)', () => {
      writeOutputLanguageFile('Test--Language');

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1];
      // The marker should have -- removed, but the heading preserves original
      expect(writtenContent).toContain(
        '# Output language preference: Test--Language',
      );
      expect(writtenContent).toContain(
        '<!-- qwen-code:llm-output-language: TestLanguage -->',
      );
    });
  });

  describe('updateOutputLanguageFile', () => {
    beforeEach(() => {
      vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
      vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);
    });

    it('should resolve "auto" and write resolved language', () => {
      vi.mocked(i18n.detectSystemLanguage).mockReturnValue('zh');

      updateOutputLanguageFile('auto');

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1];
      expect(writtenContent).toContain('Chinese');
    });

    it('should normalize locale codes and write full name', () => {
      updateOutputLanguageFile('ja');

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1];
      expect(writtenContent).toContain('Japanese');
    });

    it('should write explicit language names directly', () => {
      updateOutputLanguageFile('French');

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1];
      expect(writtenContent).toContain('French');
    });
  });

  describe('initializeLlmOutputLanguage', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
      vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);
      vi.mocked(fs.readFileSync).mockReturnValue('');
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

    it('should NOT overwrite file when content matches resolved language', () => {
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

    it('should overwrite file when language setting differs', () => {
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

    it('should resolve "auto" to detected system language', () => {
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

    it('should handle file read errors gracefully', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('Read error');
      });
      vi.mocked(i18n.detectSystemLanguage).mockReturnValue('en');

      // Should not throw, and should create new file
      expect(() => initializeLlmOutputLanguage()).not.toThrow();
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('should parse legacy heading format', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        '# CRITICAL: Chinese Output Language Rule - HIGHEST PRIORITY',
      );
      vi.mocked(i18n.detectSystemLanguage).mockReturnValue('zh');

      initializeLlmOutputLanguage();

      // Should not overwrite since file already has Chinese
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });
});
