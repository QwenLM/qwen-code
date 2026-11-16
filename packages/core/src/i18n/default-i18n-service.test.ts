/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatApiErrorDisplayMessage } from '../utils/errorParsing.js';
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

  it('localizes paid confirmation errors by UI locale', () => {
    const en = new DefaultI18nService();
    en.configureUi({
      locale: 'en',
      preference: 'en',
      dynamicContentEnabled: true,
    });
    expect(en.get('error.code.145', { message: 'fallback' })).toBe(
      "You've reached today's free usage limit for this model. You can upgrade your plan for more free uses, wait until your free usage resets at midnight (UTC+8), or continue with paid Credits.",
    );
    expect(en.get('error.code.146', { message: 'fallback' })).toBe(
      "You've reached today's free usage limit for this model. Free access will reset tomorrow. You can switch to another model, or continue with paid Credits.",
    );
    expect(en.get('error.code.147', { message: 'fallback' })).toBe(
      'Your exclusive pack for this model is running low. Once it is depleted, continued use will consume your paid Credits.',
    );

    const zh = new DefaultI18nService();
    zh.configureUi({
      locale: 'zh-CN',
      preference: 'zh-CN',
      dynamicContentEnabled: true,
    });
    expect(zh.get('error.code.145', { message: 'fallback' })).toBe(
      '您今日使用该模型的免费次数已用完。您可以升级套餐以获得更多免费使用次数，或等待免费次数于每日 00:00（UTC+8）重置，也可以使用付费 Credits 继续使用该模型。',
    );
    expect(zh.get('error.code.146', { message: 'fallback' })).toBe(
      '您今日使用该模型的免费次数已用尽，明天可继续免费使用。您也可以切换其他模型，或使用付费 Credits 继续使用该模型。',
    );
    expect(zh.get('error.code.147', { message: 'fallback' })).toBe(
      '当前模型的专属资源包即将用尽，用尽后将消耗您的付费 Credits。',
    );
  });

  it('renders paid confirmation copy through the API error formatter', () => {
    initializeI18nService();
    getI18nService().configureUi({
      locale: 'zh-CN',
      preference: 'zh-CN',
      dynamicContentEnabled: true,
    });

    expect(formatApiErrorDisplayMessage('145', 'fallback')).toBe(
      '您今日使用该模型的免费次数已用完。您可以升级套餐以获得更多免费使用次数，或等待免费次数于每日 00:00（UTC+8）重置，也可以使用付费 Credits 继续使用该模型。',
    );
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
