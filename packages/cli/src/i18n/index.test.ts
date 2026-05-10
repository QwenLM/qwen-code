/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core';

describe('bundled locale fallback', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.restoreAllMocks();
  });

  it('loads bundled builtin translations when locale files are absent on disk', async () => {
    const qwenLocalePathPattern =
      /([\\/]\.qwen|[\\/]i18n)[\\/]locales([\\/]|$)/;

    vi.doMock('node:fs', async (importOriginal) => {
      const actualFs = await importOriginal<typeof import('node:fs')>();
      return {
        ...actualFs,
        existsSync: (target: Parameters<typeof actualFs.existsSync>[0]) => {
          if (qwenLocalePathPattern.test(String(target))) {
            return false;
          }
          return actualFs.existsSync(target);
        },
      };
    });

    const { setLanguageAsync, t } = await import('./index.js');
    const { languageCommand } = await import(
      '../ui/commands/languageCommand.js'
    );

    await setLanguageAsync('zh');

    expect(t('show version info')).toBe('显示版本信息');
    expect(languageCommand.description).not.toBe(
      'View or change the language setting',
    );
  }, 20000);

  it('falls back to bundled translations when a user locale default export is null', async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-i18n-null-locale-'),
    );
    const localesDir = path.join(tempDir, 'locales');
    await fs.mkdir(localesDir, { recursive: true });
    await fs.writeFile(
      path.join(localesDir, 'zh.js'),
      'export default null;\n',
      'utf-8',
    );

    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempDir);

    const { setLanguageAsync, t } = await import('./index.js');
    await setLanguageAsync('zh');

    expect(t('show version info')).toBe('显示版本信息');

    await fs.rm(tempDir, { recursive: true, force: true });
  }, 20000);

  it('falls back to bundled translations when a user locale default export is an array', async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-i18n-array-locale-'),
    );
    const localesDir = path.join(tempDir, 'locales');
    await fs.mkdir(localesDir, { recursive: true });
    await fs.writeFile(
      path.join(localesDir, 'zh.js'),
      "export default ['show version info'];\n",
      'utf-8',
    );

    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempDir);

    const { setLanguageAsync, t } = await import('./index.js');
    await setLanguageAsync('zh');

    expect(t('show version info')).toBe('显示版本信息');

    await fs.rm(tempDir, { recursive: true, force: true });
  }, 20000);
});

describe('public i18n exports', () => {
  it('re-exports supported languages and required translation keys', async () => {
    const i18n = await import('./index.js');

    expect(i18n.SUPPORTED_LANGUAGES.length).toBeGreaterThan(0);
    expect(i18n.MUST_TRANSLATE_KEYS.length).toBeGreaterThan(0);
  });
});

describe('language normalization', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('normalizes explicit locale IDs before loading translations', async () => {
    const { setLanguageAsync, getCurrentLanguage, t } = await import(
      './index.js'
    );

    await setLanguageAsync('zh-CN');

    expect(getCurrentLanguage()).toBe('zh');
    expect(t('show version info')).toBe('显示版本信息');
  });

  it('normalizes explicit POSIX locale strings before loading translations', async () => {
    const { initializeI18n, getCurrentLanguage, t } = await import(
      './index.js'
    );

    await initializeI18n('pt_BR.UTF-8');

    expect(getCurrentLanguage()).toBe('pt');
    expect(t('show version info')).toBe('mostrar informações de versão');
  });
});

describe('supported language resolution', () => {
  it('prefers the longest supported locale match', async () => {
    const { resolveSupportedLanguage } = await import('./languages.js');

    expect(resolveSupportedLanguage('zh-TW')).toBe('zh-TW');
    expect(resolveSupportedLanguage('zh_TW')).toBe('zh-TW');
    expect(resolveSupportedLanguage('zh-TW.UTF-8')).toBe('zh-TW');
  });

  it('keeps existing fallback behavior for generic Chinese locales', async () => {
    const { resolveSupportedLanguage } = await import('./languages.js');

    expect(resolveSupportedLanguage('zh-CN')).toBe('zh');
    expect(resolveSupportedLanguage('zh-HK')).toBe('zh');
  });
});
