/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

  it('normalizes Arabic locale variants before loading translations', async () => {
    const { initializeI18n, getCurrentLanguage, t } = await import(
      './index.js'
    );
    const { resolveSupportedLanguage } = await import('./languages.js');

    expect(resolveSupportedLanguage('ar')).toBe('ar');
    expect(resolveSupportedLanguage('ar-SA')).toBe('ar');
    expect(resolveSupportedLanguage('ar_EG.UTF-8')).toBe('ar');

    await initializeI18n('ar_EG.UTF-8');

    expect(getCurrentLanguage()).toBe('ar');
    expect(t('show version info')).toBe('عرض معلومات الإصدار');
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

  // Without the registration check-i18n only warns about a missing or extra
  // Arabic key, so the shipped catalog could drift with a green checker.
  it('holds the in-tree Arabic catalog to exact en.js key parity', async () => {
    const { SUPPORTED_LANGUAGES } = await import('./languages.js');

    expect(
      SUPPORTED_LANGUAGES.find((language) => language.code === 'ar')
        ?.strictParity,
    ).toBe(true);
  });

  // A merge can add English keys without touching ar.js, and only check-i18n
  // would notice, so pin the shipped catalog here too.
  it('keeps the shipped Arabic catalog key-for-key with en.js', async () => {
    const localesDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'locales',
    );
    const load = async (code: string): Promise<Record<string, unknown>> => {
      const file = pathToFileURL(path.join(localesDir, `${code}.js`)).href;
      const module = (await import(file)) as {
        default?: Record<string, unknown>;
      };
      return module.default ?? {};
    };

    const en = await load('en');
    const ar = await load('ar');

    expect(Object.keys(ar).filter((key) => !(key in en))).toEqual([]);
    expect(Object.keys(en).filter((key) => !(key in ar))).toEqual([]);
  });
});

describe('localizeToolDisplayName', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('translates tool badges without colliding with generic UI strings', async () => {
    const { setLanguageAsync, localizeToolDisplayName, t } = await import(
      './index.js'
    );
    await setLanguageAsync('zh');

    // The namespaced `toolDisplayName.*` key translates the badge...
    expect(localizeToolDisplayName('Shell')).toBe('运行命令');
    expect(localizeToolDisplayName('TodoList')).toBe('任务清单');
    // Proper tool names / acronyms are intentionally kept in English.
    expect(localizeToolDisplayName('Agent')).toBe('Agent');
    expect(localizeToolDisplayName('Grep')).toBe('Grep');
    expect(localizeToolDisplayName('Glob')).toBe('Glob');
    expect(localizeToolDisplayName('Lsp')).toBe('LSP');
    // ...while a same-spelled standalone UI string keeps its own value.
    expect(t('Shell')).toBe('Shell');
  });

  it('falls back to the English display name for untranslated tools', async () => {
    const { setLanguageAsync, localizeToolDisplayName } = await import(
      './index.js'
    );
    await setLanguageAsync('en');

    expect(localizeToolDisplayName('TodoList')).toBe('TodoList');
    expect(localizeToolDisplayName('Shell')).toBe('Shell');
    // An unknown tool name passes through unchanged.
    expect(localizeToolDisplayName('MysteryTool')).toBe('MysteryTool');
  });

  it('distinguishes the Russian session and team task lists', async () => {
    const { setLanguageAsync, localizeToolDisplayName } = await import(
      './index.js'
    );
    await setLanguageAsync('ru');

    expect(localizeToolDisplayName('TodoList')).toBe('Список задач');
    expect(localizeToolDisplayName('TaskList')).toBe('Список задач команды');
  });

  // Both translating locales, not just zh: `t()` has no cross-locale
  // fallback, so a tool added to zh.js alone renders its raw English badge
  // in a zh-TW session, next to fully-translated siblings.
  it.each(['zh', 'zh-TW', 'ar'] as const)(
    'has a %s translation for every core tool display name',
    async (locale) => {
      const { setLanguageAsync, localizeToolDisplayName } = await import(
        './index.js'
      );
      const { ToolDisplayNames } = await import('@qwen-code/qwen-code-core');
      await setLanguageAsync(locale);

      const KEEP_ENGLISH = new Set(['Agent', 'Grep', 'Glob']);
      const untranslated = Object.values(ToolDisplayNames).filter(
        (name) =>
          !KEEP_ENGLISH.has(name) && localizeToolDisplayName(name) === name,
      );
      expect(untranslated).toEqual([]);

      const badges = Object.values(ToolDisplayNames)
        .filter((name) => !KEEP_ENGLISH.has(name))
        .map((name) => localizeToolDisplayName(name));
      expect(new Set(badges).size).toBe(badges.length);
    },
  );

  it('has a zh translation for every core tool display name', async () => {
    const { setLanguageAsync, localizeToolDisplayName } = await import(
      './index.js'
    );
    const { ToolDisplayNames } = await import('@qwen-code/qwen-code-core');
    await setLanguageAsync('zh');

    // Guards against a new tool landing without a `toolDisplayName.*` entry:
    // every English display name (except the intentionally-English ones below)
    // must resolve to a different (translated) zh string. check-i18n can't catch
    // this because the keys are built dynamically, never as
    // `t('toolDisplayName.X')` string literals.
    const KEEP_ENGLISH = new Set(['Agent', 'Grep', 'Glob']);
    const untranslated = Object.values(ToolDisplayNames).filter(
      (name) =>
        !KEEP_ENGLISH.has(name) && localizeToolDisplayName(name) === name,
    );
    expect(untranslated).toEqual([]);
  });
});

describe('setLanguageAsync', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('keeps the previous language until the new dictionary has loaded', async () => {
    const { setLanguageAsync, getCurrentLanguage } = await import('./index.js');
    await setLanguageAsync('en');
    const pending = setLanguageAsync('zh');
    // A frame landing inside the load window must still see the language its
    // strings are written in, or it reseeds the screen-reader dedupe state
    // against the old dictionary and replays the conversation on the swap.
    expect(getCurrentLanguage()).toBe('en');
    await pending;
    expect(getCurrentLanguage()).toBe('zh');
  });
});
