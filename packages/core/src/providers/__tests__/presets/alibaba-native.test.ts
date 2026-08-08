/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '../../../core/contentGenerator.js';
import { alibabaNativeProvider } from '../../presets/alibaba-native.js';
import { alibabaStandardProvider } from '../../presets/alibaba-standard.js';
import {
  buildInstallPlan,
  getDefaultModelIds,
  providerMatchesCredentials,
  resolveBaseUrl,
} from '../../provider-config.js';

describe('alibabaNativeProvider', () => {
  it('has correct provider config', () => {
    expect(alibabaNativeProvider).toMatchObject({
      id: 'alibabaNative',
      label: 'Native DashScope API',
      protocol: AuthType.USE_DASHSCOPE,
      envKey: 'DASHSCOPE_API_KEY',
      modelsEditable: true,
      modelNamePrefix: 'ModelStudio Native',
    });
  });

  it('offers multiple region endpoints', () => {
    expect(Array.isArray(alibabaNativeProvider.baseUrl)).toBe(true);
    const urls = (alibabaNativeProvider.baseUrl as Array<{ url: string }>).map(
      (o) => o.url,
    );
    expect(urls).toContain('https://dashscope-intl.aliyuncs.com/api/v1');
    expect(urls).toContain('https://dashscope.aliyuncs.com/api/v1');
  });

  it('includes the qwen3.8-max default model', () => {
    expect(getDefaultModelIds(alibabaNativeProvider)).toEqual(['qwen3.8-max']);
  });

  it('resolves baseUrl for known region', () => {
    const url = resolveBaseUrl(
      alibabaNativeProvider,
      'https://dashscope-intl.aliyuncs.com/api/v1',
    );
    expect(url).toBe('https://dashscope-intl.aliyuncs.com/api/v1');
  });

  it('creates an install plan with editable models', () => {
    const plan = buildInstallPlan(alibabaNativeProvider, {
      baseUrl: 'https://dashscope-intl.aliyuncs.com/api/v1',
      apiKey: 'sk-native',
      modelIds: ['qwen3.8-max', 'custom-model'],
    });

    expect(plan.providerId).toBe('alibabaNative');
    const models = plan.modelProviders?.[0]?.models;
    expect(models).toHaveLength(2);
    expect(models?.[0]).toMatchObject({
      id: 'qwen3.8-max',
      name: '[ModelStudio Native] qwen3.8-max',
    });
    expect(models?.[1]).toMatchObject({
      id: 'custom-model',
      name: '[ModelStudio Native] custom-model',
    });
  });

  it('matches credentials for all base URL options', () => {
    const urls = (alibabaNativeProvider.baseUrl as Array<{ url: string }>).map(
      (o) => o.url,
    );
    for (const url of urls) {
      expect(
        providerMatchesCredentials(
          alibabaNativeProvider,
          url,
          'DASHSCOPE_API_KEY',
        ),
      ).toBe(true);
    }
    expect(
      providerMatchesCredentials(
        alibabaNativeProvider,
        'https://unknown.com',
        'DASHSCOPE_API_KEY',
      ),
    ).toBe(false);
  });

  /**
   * alibabaNativeProvider and alibabaStandardProvider share
   * `DASHSCOPE_API_KEY` and are disambiguated only by `modelNamePrefix`
   * ('ModelStudio Native' vs 'ModelStudio Standard'). `resolveOwnsModel`
   * relies on this prefix to decide which installed models belong to which
   * provider when merging install plans — a collision here would make
   * installing one provider silently delete the other's models. This test
   * guards that regression directly, since no other test in the suite
   * exercises both presets' `ownsModel` against each other's models.
   */
  it('does not claim ownership of the sibling standard-provider models', () => {
    const nativePlan = buildInstallPlan(alibabaNativeProvider, {
      baseUrl: 'https://dashscope-intl.aliyuncs.com/api/v1',
      apiKey: 'sk-shared',
      modelIds: ['qwen3.8-max'],
    });
    const standardPlan = buildInstallPlan(alibabaStandardProvider, {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk-shared',
      modelIds: ['qwen3.7-max'],
    });

    const nativeOwnsModel = nativePlan.modelProviders?.[0]?.ownsModel;
    const standardOwnsModel = standardPlan.modelProviders?.[0]?.ownsModel;
    expect(nativeOwnsModel).toBeDefined();
    expect(standardOwnsModel).toBeDefined();

    const standardModel = standardPlan.modelProviders?.[0]?.models?.[0];
    const nativeModel = nativePlan.modelProviders?.[0]?.models?.[0];
    expect(standardModel).toBeDefined();
    expect(nativeModel).toBeDefined();

    // The native provider's ownsModel must reject the standard provider's
    // model even though both share envKey === 'DASHSCOPE_API_KEY'.
    expect(nativeOwnsModel?.(standardModel!)).toBe(false);
    // ...and vice versa.
    expect(standardOwnsModel?.(nativeModel!)).toBe(false);

    // Each provider still owns its own model.
    expect(nativeOwnsModel?.(nativeModel!)).toBe(true);
    expect(standardOwnsModel?.(standardModel!)).toBe(true);
  });
});
