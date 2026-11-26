/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createChromeStrings, readLanguage } from './strings.js';

// Same oracle as web-shell's client/test/zh-tw-glyphs.ts, which this package
// cannot import: the CLI's hand-corrected packs translate one key set, so a Han
// glyph the Simplified pack uses and the Traditional pack never uses is
// Simplified-only. 餐 is valid Traditional (套餐) the CLI pack renders 方案.
const HAN = /[㐀-鿿]/;

async function packCharacters(locale: 'zh' | 'zh-TW'): Promise<Set<string>> {
  const file = resolve(
    import.meta.dirname,
    `../../../cli/src/i18n/locales/${locale}.js`,
  );
  const { default: pack } = (await import(pathToFileURL(file).href)) as {
    default: Record<string, string | string[]>;
  };
  const text = Object.values(pack).flat().join('');
  return new Set([...text].filter((char) => HAN.test(char)));
}

describe('readLanguage', () => {
  afterEach(() => {
    document.documentElement.lang = '';
  });

  it('resolves zh-CN from the webview language', () => {
    document.documentElement.lang = 'zh-cn';
    expect(readLanguage()).toBe('zh-CN');
  });

  it('keeps Traditional Chinese out of the Simplified catalog', () => {
    document.documentElement.lang = 'zh-TW';
    expect(readLanguage()).toBe('zh-TW');
    expect(createChromeStrings('zh-TW')('header.newSession')).toBe('新建會話');
    expect(createChromeStrings('zh-CN')('header.newSession')).toBe('新建会话');
  });

  it.each(['zh-TW', 'zh-tw', 'zh-Hant', 'zh-HK', 'zh-MO'])(
    'resolves %s to the Traditional catalog',
    (lang) => {
      document.documentElement.lang = lang;
      expect(readLanguage()).toBe('zh-TW');
      expect(createChromeStrings(readLanguage())('header.newSession')).toBe(
        '新建會話',
      );
    },
  );

  it('falls back to the navigator language when lang is unset', () => {
    document.documentElement.lang = '';
    expect(readLanguage()).toBe('en');
  });
});

describe('createChromeStrings', () => {
  it('keeps the Chinese untitled-session label localized', () => {
    const strings = createChromeStrings('zh-CN');
    expect(strings('session.untitled')).toBe('未命名');
  });
});

describe('boot.preAuthHostGate', () => {
  // The 403 fires exactly when the client-side forwarded port differs from
  // the daemon's bound port, so its arrival proves the forward destination
  // is already right. The copy must aim at the client-side port — wording
  // that only re-points the forward destination leads nowhere.
  it('names the client-side port lever in every catalog', () => {
    const en = createChromeStrings('en')('boot.preAuthHostGate');
    const zh = createChromeStrings('zh-CN')('boot.preAuthHostGate');
    const tw = createChromeStrings('zh-TW')('boot.preAuthHostGate');
    expect(en).toMatch(/4170:localhost:4170/);
    expect(zh).toMatch(/4170:localhost:4170/);
    expect(tw).toMatch(/4170:localhost:4170/);
    expect(en).toMatch(/same port number|same port the daemon listens on/i);
    expect(zh).toMatch(/一致/);
    expect(tw).toMatch(/一致/);
  });
});

describe('composer.editIdentityUnavailable', () => {
  it('distinguishes missing checkpoint identities in both locales', () => {
    expect(
      createChromeStrings('en')('composer.editIdentityUnavailable'),
    ).toContain('no prompt identity');
    expect(
      createChromeStrings('zh-CN')('composer.editIdentityUnavailable'),
    ).toContain('身份');
  });
});

describe('Traditional chrome table', () => {
  it('carries no Simplified-only glyph', async () => {
    const simplified = await packCharacters('zh');
    const traditional = await packCharacters('zh-TW');
    const glyphs = new RegExp(
      `[${[...simplified]
        .filter((char) => !traditional.has(char) && char !== '餐')
        .join('')}]`,
    );
    const source = readFileSync(
      resolve(import.meta.dirname, 'strings.ts'),
      'utf8',
    );
    const start = source.indexOf(
      'const ZH_TW: Record<ChromeStringKey, string>',
    );
    expect(start).toBeGreaterThan(-1);
    const table = source.slice(start, source.indexOf('\n};', start));
    expect(table).not.toMatch(glyphs);
  });
});
