/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from 'vitest';
import { createChromeStrings, readLanguage } from './strings.js';

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
