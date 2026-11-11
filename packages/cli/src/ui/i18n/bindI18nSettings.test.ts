/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it } from 'vitest';
import { SettingScope } from '../../config/settings.js';
import { createMockSettings } from '../../test-utils/settings.js';
import { createTestI18nService } from '../../test-utils/i18n.js';
import { bindI18nSettings } from './bindI18nSettings.js';

function chineseSettings() {
  return createMockSettings({
    user: {
      path: '/read-only/settings.json',
      readOnly: true,
      settings: { ui: { language: 'zh-CN' } },
      originalSettings: { ui: { language: 'zh-CN' } },
    },
  });
}
it('configures before first render, follows settings and stops after cleanup', () => {
  const settings = chineseSettings();
  const service = createTestI18nService();
  const stop = bindI18nSettings(service, settings);
  expect(service.get('commands.empty')).toBe('没有可用命令。');
  settings.setValue(SettingScope.User, 'ui.language', 'en');
  expect(service.get('commands.empty')).toBe('No commands available.');
  stop();
  settings.setValue(SettingScope.User, 'ui.language', 'zh-CN');
  expect(service.locale).toBe('en');
});
it('forces bound sessions to English and disables locale completion', () => {
  const service = createTestI18nService();
  const stop = bindI18nSettings(service, chineseSettings(), {
    forcedLocale: 'en',
    dynamicContentEnabled: false,
  });
  expect(service.locale).toBe('en');
  expect(service.preference).toBe('en');
  expect(service.dynamicContentEnabled).toBe(false);
  stop();
});
