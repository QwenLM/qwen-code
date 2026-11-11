/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  getDialogSettingKeys,
  getDialogSettingOptions,
  getSettingDefinition,
} from '../../utils/settingsUtils.js';
import { SettingScope } from '../../config/settings.js';
import { createMockSettings } from '../../test-utils/settings.js';
import { DefaultI18nService, type UiLocale } from '@qwen-code/core';
import { registerCliUiMessages } from './register.js';
const service = new DefaultI18nService();
registerCliUiMessages(service);
function getMessageTemplate(locale: UiLocale, key: string): string {
  service.configureUi({
    locale,
    preference: locale,
    dynamicContentEnabled: false,
  });
  return service.getTemplate(key);
}
import { formatMessage } from './formatMessage.js';
import {
  getLocalizedScopeMessageForSetting,
  SETTING_OPTION_KEYS,
  SETTING_TEXT_KEYS,
} from './settingText.js';
import type { I18nService } from '@qwen-code/core';
import type { UiMessageKey } from './types.js';

const enT: I18nService['get'] = (key, params) =>
  formatMessage(getMessageTemplate('en', key as UiMessageKey), params);

describe('setting text', () => {
  it('covers every setting and enum option visible in the dialog', () => {
    const visibleKeys = getDialogSettingKeys();
    expect(visibleKeys.filter((key) => !SETTING_TEXT_KEYS[key])).toEqual([]);

    const missingOptions = visibleKeys.flatMap((key) => {
      const definition = getSettingDefinition(key);
      // The unset choice is only a cycle stop; the dialog shows the resolved value instead.
      return getDialogSettingOptions(definition)
        .filter((option) => option.value !== undefined)
        .map((option) => `${key}:${String(option.value)}`)
        .filter((optionKey) => !SETTING_OPTION_KEYS[optionKey]);
    });
    expect(missingOptions).toEqual([]);
  });

  it('describes the override direction and effective display language', () => {
    const settings = createMockSettings({
      user: {
        path: '/user/settings.json',
        settings: { ui: { language: 'zh-CN' } },
        originalSettings: { ui: { language: 'zh-CN' } },
      },
      project: {
        path: '/project/.qwen/settings.json',
        settings: { ui: { language: 'en' } },
        originalSettings: { ui: { language: 'en' } },
      },
    });

    expect(
      getLocalizedScopeMessageForSetting(
        'ui.language',
        SettingScope.User,
        settings,
        enT,
      ),
    ).toBe('(Overridden by Project Settings · Effective: English)');
    expect(
      getLocalizedScopeMessageForSetting(
        'ui.language',
        SettingScope.Project,
        settings,
        enT,
      ),
    ).toBe('(Overrides User Settings: Simplified Chinese)');
  });
});
