/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { DefaultI18nCatalog } from '@qwen-code/core';

import { afterEach, expect, it, vi } from 'vitest';
import { createTestI18nService } from '../../test-utils/i18n.js';
import {
  bindUiLocale,
  getUiLocale,
  onUiLocaleChange,
  resetUiLocaleForTest,
} from './uiLocaleState.js';
afterEach(resetUiLocaleForTest);
it('follows only language changes of the bound instance and unsubscribes', () => {
  expect(getUiLocale()).toBeUndefined();
  const service = createTestI18nService();
  const listener = vi.fn();
  onUiLocaleChange(listener);
  const stop = bindUiLocale(service);
  service.registerCatalog(new DefaultI18nCatalog({ en: { key: 'value' } }));
  service.configureUi({
    locale: 'zh-CN',
    preference: 'zh-CN',
    dynamicContentEnabled: false,
  });
  expect(getUiLocale()).toBe('zh-CN');
  expect(listener.mock.calls).toEqual([['en'], ['zh-CN']]);
  stop();
  expect(getUiLocale()).toBeUndefined();
  service.configureUi({
    locale: 'en',
    preference: 'en',
    dynamicContentEnabled: false,
  });
  expect(listener).toHaveBeenCalledTimes(2);
});
