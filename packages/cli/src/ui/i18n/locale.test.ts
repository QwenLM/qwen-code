/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  detectSystemUiLocale,
  isUiLanguagePreference,
  normalizeUiLanguagePreference,
  resolveUiLocale,
} from './locale.js';

describe('UI locale resolution', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['zh-CN', 'zh-CN'],
    ['en', 'en'],
  ] as const)('uses the explicit %s preference', (preference, expected) => {
    expect(resolveUiLocale(preference, { LANG: 'en_US.UTF-8' })).toBe(expected);
  });

  it('prefers the system UI language over the terminal locale for auto', () => {
    expect(
      resolveUiLocale(
        'auto',
        { LANG: 'en_US.UTF-8' },
        'zh-Hans-CN',
      ),
    ).toBe('zh-CN');
  });

  it('defaults to English when the setting is omitted', () => {
    expect(resolveUiLocale(undefined, { LANG: 'zh_CN.UTF-8' }, 'zh-CN')).toBe(
      'en',
    );
    expect(normalizeUiLanguagePreference(undefined)).toBe('en');
  });

  it('uses the documented environment precedence when system detection fails', () => {
    expect(
      resolveUiLocale(
        'auto',
        {
          LC_ALL: 'zh_TW.UTF-8',
          LC_MESSAGES: 'en_US.UTF-8',
          LANG: 'en_US.UTF-8',
        },
      ),
    ).toBe('zh-CN');
  });

  it('ignores empty higher-priority environment values', () => {
    expect(
      resolveUiLocale(
        'auto',
        {
          LC_ALL: '',
          LC_MESSAGES: '   ',
          LANG: 'zh_CN.UTF-8',
        },
      ),
    ).toBe('zh-CN');
  });

  it('maps every Chinese locale to Simplified Chinese', () => {
    expect(
      resolveUiLocale('auto', { LANG: 'zh-Hant-HK' }),
    ).toBe('zh-CN');
  });

  it('uses Intl when locale environment variables are absent', () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(
      () =>
        ({
          resolvedOptions: () => ({ locale: 'zh-SG' }),
        }) as Intl.DateTimeFormat,
    );

    expect(resolveUiLocale('auto', {})).toBe('zh-CN');
  });

  it('falls back to English for invalid settings', () => {
    expect(resolveUiLocale('fr', { LANG: 'zh_CN.UTF-8' })).toBe('en');
    expect(normalizeUiLanguagePreference('fr')).toBe('en');
    expect(isUiLanguagePreference('fr')).toBe(false);
  });

  it('reads the first macOS display language and falls back to AppleLocale', () => {
    const readPreferredLanguage = vi.fn(() => '(\n    "zh-Hans-CN",\n    "en-CN"\n)');
    expect(detectSystemUiLocale('darwin', {}, readPreferredLanguage)).toBe(
      'zh-Hans-CN',
    );
    expect(readPreferredLanguage).toHaveBeenCalledOnce();

    const readAppleLocale: Parameters<typeof detectSystemUiLocale>[2] = vi.fn(
      (_executable, args) =>
        args.at(-1) === 'AppleLocale' ? 'zh_CN' : '(\n)',
    );
    expect(detectSystemUiLocale('darwin', {}, readAppleLocale)).toBe('zh_CN');
  });

  it('reads the Windows UI culture from the system PowerShell', () => {
    const runCommand = vi.fn(() => 'zh-CN');

    expect(
      detectSystemUiLocale(
        'win32',
        { SystemRoot: 'C:\\Windows' },
        runCommand,
      ),
    ).toBe('zh-CN');
    expect(runCommand).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-UICulture).Name',
      ],
    );
  });

  it('does not resolve PowerShell from PATH when SystemRoot is unavailable', () => {
    const runCommand = vi.fn();

    expect(detectSystemUiLocale('win32', {}, runCommand)).toBeUndefined();
    expect(runCommand).not.toHaveBeenCalled();
  });
});
