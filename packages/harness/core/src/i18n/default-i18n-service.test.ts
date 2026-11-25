/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DefaultI18nService } from './default-i18n-service.js';
import {
  getI18nService,
  getStaticI18nService,
  initializeI18nService,
  installI18nService,
  resetI18nService,
} from './index.js';

afterEach(() => {
  resetI18nService();
  vi.restoreAllMocks();
});

describe('static I18nService and installation', () => {
  it('initializes the Core default without creating a service on access', () => {
    expect(getI18nService()).toBeUndefined();
    initializeI18nService();
    expect(getI18nService()).toBeInstanceOf(DefaultI18nService);
  });

  it('retains the installed instance and releases it on reset', () => {
    const service = new DefaultI18nService();
    const init = vi.spyOn(service, 'initSync');
    const dispose = vi.spyOn(service, 'dispose');
    installI18nService(service);
    installI18nService(service);
    expect(getI18nService()).toBe(service);
    initializeI18nService();
    expect(init).toHaveBeenCalledOnce();
    expect(() => installI18nService(new DefaultI18nService())).toThrow();
    resetI18nService();
    expect(dispose).toHaveBeenCalledOnce();
    expect(getI18nService()).toBeUndefined();
  });

  it('serves existing defaults and missing-key fallbacks without fetching', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const service = getStaticI18nService();
    const listener = vi.fn();
    const unsubscribe = service.subscribe(listener);
    const snapshot = service.getSnapshot();
    service.initSync();
    await service.init();
    await service.ensureLocale('zh-CN');
    expect(service.getModelDescription('auto', 'zh-CN')).toBe(
      'Smartly select the optimal model, balancing performance and cost',
    );
    expect(service.get('quota.package.unknown.title')).toBe('');
    expect(service.hasModelDescription('unknown')).toBe(false);
    expect(service.getErrorCodeMessage(122, 'fallback')).toBe(
      'Your Billing Group has reached its Credits limit for this billing cycle. Please contact admin to continue.',
    );
    expect(service.getErrorCodeMessage(116, 'fallback')).toBe('fallback');
    expect(service.getSnapshot()).toBe(snapshot);
    expect(listener).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    unsubscribe();
  });
});
