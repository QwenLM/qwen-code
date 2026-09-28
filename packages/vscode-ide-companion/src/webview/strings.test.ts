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
  it('names the client-side port lever in both catalogs', () => {
    const en = createChromeStrings('en')('boot.preAuthHostGate');
    const zh = createChromeStrings('zh-CN')('boot.preAuthHostGate');
    expect(en).toMatch(/4170:localhost:4170/);
    expect(zh).toMatch(/4170:localhost:4170/);
    expect(en).toMatch(/same port number|same port the daemon listens on/i);
    expect(zh).toMatch(/一致/);
  });
});
