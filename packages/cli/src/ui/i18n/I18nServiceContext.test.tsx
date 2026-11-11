/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { DefaultI18nCatalog } from '@qwen-code/core';

import { memo, useMemo } from 'react';
import { act } from 'react';
import { Text } from 'ink';
import { expect, it } from 'vitest';
import { DefaultI18nService } from '@qwen-code/core';
import { render } from '../../test-utils/render.js';
import { I18nServiceProvider, useI18nService } from './I18nServiceContext.js';

it('refreshes memoized text on language and catalog updates with a stable service', async () => {
  const service = new DefaultI18nService();
  service.registerCatalog(
    new DefaultI18nCatalog({
      en: { title: 'English' },
      'zh-CN': { title: '中文' },
    }),
  );
  const Probe = memo(() => {
    const i18n = useI18nService();
    const getUiText = i18n.get;
    const text = useMemo(() => getUiText('title'), [getUiText]);
    expect(i18n).toBe(service);
    return <Text>{text}</Text>;
  });
  Probe.displayName = 'I18nMemoProbe';
  const result = await render(
    <I18nServiceProvider service={service}>
      <Probe />
    </I18nServiceProvider>,
  );
  expect(result.lastFrame()).toContain('English');
  act(() =>
    service.configureUi({
      locale: 'zh-CN',
      preference: 'zh-CN',
      dynamicContentEnabled: true,
    }),
  );
  await result.waitUntilReady();
  expect(result.lastFrame()).toContain('中文');
  act(() =>
    service.registerCatalog(
      new DefaultI18nCatalog({ 'zh-CN': { title: '产品' } }),
    ),
  );
  await result.waitUntilReady();
  expect(result.lastFrame()).toContain('产品');
  result.unmount();
});
