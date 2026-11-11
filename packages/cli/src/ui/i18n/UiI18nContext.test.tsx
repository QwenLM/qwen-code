/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Text } from 'ink';
import type React from 'react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { SettingScope } from '../../config/settings.js';
import { renderWithProviders } from '../../test-utils/render.js';
import { createMockSettings } from '../../test-utils/settings.js';
import { T } from './RichMessage.js';
import { useI18nService } from './I18nServiceContext.js';
import { I18nTestProvider as UiI18nProvider } from '../../test-utils/I18nTestProvider.js';

function LocaleProbe(): React.JSX.Element {
  const {
    locale,
    preference,
    dynamicContentEnabled,
    get: t,
  } = useI18nService();
  return (
    <Text>
      {locale}|{preference}|{String(dynamicContentEnabled)}|
      {t('settings.language.label')}|{t('commands.empty')}
    </Text>
  );
}

describe('UiI18nProvider', () => {
  it('uses English when ui.language is not configured', async () => {
    const settings = createMockSettings({});
    const result = await renderWithProviders(
      <UiI18nProvider systemLocale="zh-CN">
        <LocaleProbe />
      </UiI18nProvider>,
      { settings },
    );

    expect(result.lastFrame()).toContain('en|en|true|Display Language');
    expect(result.lastFrame()).toContain('No commands available.');
    result.unmount();
  });

  it('reacts to a persisted setting change without remounting', async () => {
    const settings = createMockSettings({
      user: {
        path: '/read-only/settings.json',
        settings: { ui: { language: 'en' } },
        originalSettings: { ui: { language: 'en' } },
        readOnly: true,
      },
    });
    const result = await renderWithProviders(<LocaleProbe />, { settings });

    expect(result.lastFrame()).toContain('en|en|true|Display Language');
    expect(result.lastFrame()).toContain('No commands available.');

    act(() => {
      settings.setValue(SettingScope.User, 'ui.language', 'zh-CN');
    });
    await result.waitUntilReady();
    expect(result.lastFrame()).toContain('zh-CN|zh-CN|true|界面语言');
    expect(result.lastFrame()).toContain('没有可用命令。');

    act(() => {
      settings.setValue(SettingScope.User, 'ui.language', 'en');
    });
    await result.waitUntilReady();
    expect(result.lastFrame()).toContain('en|en|true|Display Language');
    expect(result.lastFrame()).toContain('No commands available.');
    result.unmount();
  });

  it('uses workspace scope over user scope', async () => {
    const settings = createMockSettings({
      user: {
        path: '/read-only/user.json',
        settings: { ui: { language: 'en' } },
        originalSettings: { ui: { language: 'en' } },
        readOnly: true,
      },
      project: {
        path: '/read-only/workspace.json',
        settings: { ui: { language: 'zh-CN' } },
        originalSettings: { ui: { language: 'zh-CN' } },
        readOnly: true,
      },
    });
    const result = await renderWithProviders(<LocaleProbe />, { settings });

    expect(result.lastFrame()).toContain('zh-CN|zh-CN|true|界面语言');
    expect(result.lastFrame()).toContain('没有可用命令。');
    result.unmount();
  });

  it('renders rich slots without translating their content', async () => {
    const settings = createMockSettings({
      user: {
        path: '/read-only/settings.json',
        settings: { ui: { language: 'zh-CN' } },
        originalSettings: { ui: { language: 'zh-CN' } },
        readOnly: true,
      },
    });
    const result = await renderWithProviders(
      <Text>
        <T
          id="settings.scope.savedTo"
          slots={{ path: <Text color="cyan">/work/settings.json</Text> }}
        />
      </Text>,
      { settings },
    );

    expect(result.lastFrame()).toContain('设置将保存到 /work/settings.json');
    result.unmount();
  });

  it('forces remote-control UI to English and disables dynamic content', async () => {
    const settings = createMockSettings({ ui: { language: 'zh-CN' } });
    const result = await renderWithProviders(
      <UiI18nProvider forcedLocale="en" dynamicContentEnabled={false}>
        <LocaleProbe />
      </UiI18nProvider>,
      { settings },
    );

    expect(result.lastFrame()).toContain('en|en|false|Display Language');
    result.unmount();
  });
});
