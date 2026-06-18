/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  resolveLocalizableString,
  resolveExtensionConfigLocale,
  type RawExtensionConfig,
} from './i18n.js';

describe('resolveLocalizableString', () => {
  it('should return undefined for undefined input', () => {
    expect(resolveLocalizableString(undefined, 'en')).toBeUndefined();
  });

  it('should return plain string unchanged', () => {
    expect(resolveLocalizableString('hello', 'en')).toBe('hello');
    expect(resolveLocalizableString('hello', 'zh')).toBe('hello');
  });

  it('should resolve exact locale match', () => {
    const value = { en: 'Hello', zh: '你好', ja: 'こんにちは' };
    expect(resolveLocalizableString(value, 'zh')).toBe('你好');
    expect(resolveLocalizableString(value, 'ja')).toBe('こんにちは');
  });

  it('should fall back to base language', () => {
    const value = { en: 'Hello', zh: '你好' };
    expect(resolveLocalizableString(value, 'zh-TW')).toBe('你好');
    expect(resolveLocalizableString(value, 'zh-CN')).toBe('你好');
  });

  it('should prefer exact match over base language', () => {
    const value = { en: 'Hello', zh: '你好', 'zh-TW': '你好（繁體）' };
    expect(resolveLocalizableString(value, 'zh-TW')).toBe('你好（繁體）');
    expect(resolveLocalizableString(value, 'zh')).toBe('你好');
  });

  it('should fall back to en when no match', () => {
    const value = { en: 'Hello', zh: '你好' };
    expect(resolveLocalizableString(value, 'ja')).toBe('Hello');
    expect(resolveLocalizableString(value, 'de')).toBe('Hello');
  });

  it('should fall back to first value when no en', () => {
    const value = { zh: '你好', ja: 'こんにちは' };
    expect(resolveLocalizableString(value, 'de')).toBe('你好');
  });

  it('should return undefined for empty record', () => {
    expect(resolveLocalizableString({}, 'en')).toBeUndefined();
  });
});

describe('resolveExtensionConfigLocale', () => {
  const baseConfig: RawExtensionConfig = {
    name: 'test-ext',
    version: '1.0.0',
  };

  it('should pass through config with plain string fields', () => {
    const raw: RawExtensionConfig = {
      ...baseConfig,
      description: 'A test extension',
      displayName: 'Test Extension',
    };
    const resolved = resolveExtensionConfigLocale(raw, 'en');
    expect(resolved.name).toBe('test-ext');
    expect(resolved.description).toBe('A test extension');
    expect(resolved.displayName).toBe('Test Extension');
  });

  it('should resolve locale map description', () => {
    const raw: RawExtensionConfig = {
      ...baseConfig,
      description: { en: 'English desc', zh: '中文描述' },
    };
    expect(resolveExtensionConfigLocale(raw, 'zh').description).toBe(
      '中文描述',
    );
    expect(resolveExtensionConfigLocale(raw, 'en').description).toBe(
      'English desc',
    );
  });

  it('should resolve locale map displayName', () => {
    const raw: RawExtensionConfig = {
      ...baseConfig,
      displayName: { en: 'My Extension', zh: '我的扩展' },
    };
    expect(resolveExtensionConfigLocale(raw, 'zh').displayName).toBe(
      '我的扩展',
    );
    expect(resolveExtensionConfigLocale(raw, 'en').displayName).toBe(
      'My Extension',
    );
  });

  it('should resolve settings descriptions', () => {
    const raw: RawExtensionConfig = {
      ...baseConfig,
      settings: [
        {
          name: 'api-key',
          description: { en: 'API key', zh: 'API 密钥' },
          envVar: 'API_KEY',
        },
        {
          name: 'plain-setting',
          description: 'A plain setting',
          envVar: 'PLAIN',
        },
      ],
    };
    const resolved = resolveExtensionConfigLocale(raw, 'zh');
    expect(resolved.settings![0]!.description).toBe('API 密钥');
    expect(resolved.settings![1]!.description).toBe('A plain setting');
  });

  it('should handle missing optional fields', () => {
    const resolved = resolveExtensionConfigLocale(baseConfig, 'en');
    expect(resolved.description).toBeUndefined();
    expect(resolved.displayName).toBeUndefined();
    expect(resolved.settings).toBeUndefined();
  });

  it('should preserve non-localizable fields', () => {
    const raw: RawExtensionConfig = {
      ...baseConfig,
      contextFileName: 'CUSTOM.md',
      commands: ['commands/'],
    };
    const resolved = resolveExtensionConfigLocale(raw, 'en');
    expect(resolved.contextFileName).toBe('CUSTOM.md');
    expect(resolved.commands).toEqual(['commands/']);
  });
});
