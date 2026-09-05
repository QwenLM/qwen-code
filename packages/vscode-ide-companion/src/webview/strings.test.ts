/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from 'vitest';
import { readLanguage } from './strings.js';

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
