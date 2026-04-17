/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  }, 10000);
});

describe('public i18n exports', () => {
  it('re-exports supported languages and required translation keys', async () => {
    const i18n = await import('./index.js');

    expect(i18n.SUPPORTED_LANGUAGES.length).toBeGreaterThan(0);
    expect(i18n.MUST_TRANSLATE_KEYS.length).toBeGreaterThan(0);
  });
});
