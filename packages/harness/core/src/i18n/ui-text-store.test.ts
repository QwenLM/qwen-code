/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { DefaultI18nCatalog } from './default-i18n-catalog.js';

import { describe, expect, it, vi } from 'vitest';
import { DefaultI18nService } from './default-i18n-service.js';

describe('instance UI text lookup', () => {
  it('accepts independent catalog providers without knowing their storage or role', () => {
    const service = new DefaultI18nService();
    service.registerCatalog({
      getTemplate: (key, locale) =>
        key === 'title' && locale === 'en' ? 'Custom title' : undefined,
    });
    expect(service.get('title')).toBe('Custom title');
    expect(service.get('missing')).toBe('missing');
  });
  it('interpolates static params, preserves missing params and publishes only changes', () => {
    const service = new DefaultI18nService();
    const listener = vi.fn();
    const stop = service.subscribe(listener);
    const entries = { title: '{brand}:{n}:{missing}' };
    const catalog = new DefaultI18nCatalog({ en: entries });
    service.registerCatalog(catalog);
    expect(service.get('title', { brand: 'Qwen', n: 0 })).toBe(
      'Qwen:0:{missing}',
    );
    const snapshot = service.getSnapshot();
    service.registerCatalog(catalog);
    expect(service.getSnapshot()).toBe(snapshot);
    expect(listener).toHaveBeenCalledTimes(1);
    service.registerCatalog(
      new DefaultI18nCatalog({ en: { title: 'Updated' } }),
    );
    expect(service.get('title')).toBe('Updated');
    stop();
    service.configureUi({
      locale: 'zh-CN',
      preference: 'auto',
      dynamicContentEnabled: false,
    });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(service.formatNumber(1234.5)).toBe(
      new Intl.NumberFormat('zh-CN').format(1234.5),
    );
    expect(service.formatDate(0, { timeZone: 'UTC' })).toBe(
      new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC' }).format(0),
    );
  });

  it('keeps dynamic missing values empty and error fallbacks unchanged', () => {
    const service = new DefaultI18nService();
    expect(service.get('modelSelector.item.unknown.markdownDescription')).toBe(
      '',
    );
    expect(service.get('error.code.unknown', { message: 'raw' })).toBe('raw');
    expect(
      service.get('modelSelector.item.auto.markdownDescription'),
    ).toContain('Smartly');
  });
});
