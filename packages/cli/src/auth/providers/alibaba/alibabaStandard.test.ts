/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import { alibabaStandardProvider } from './alibabaStandard.js';
import {
  buildInstallPlan,
  resolveBaseUrl,
  providerMatchesCredentials,
} from '../../providerConfig.js';

describe('alibabaStandardProvider', () => {
  it('has correct provider config', () => {
    expect(alibabaStandardProvider).toMatchObject({
      id: 'alibabaStandard',
      label: 'Standard API Key',
      protocol: AuthType.USE_OPENAI,
      envKey: 'DASHSCOPE_API_KEY',
      modelsEditable: true,
    });
  });

  it('offers multiple region endpoints', () => {
    expect(Array.isArray(alibabaStandardProvider.baseUrl)).toBe(true);
    const urls = (
      alibabaStandardProvider.baseUrl as Array<{ url: string }>
    ).map((o) => o.url);
    expect(urls).toContain('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(urls).toContain(
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    );
  });

  it('resolves baseUrl for known region', () => {
    const url = resolveBaseUrl(
      alibabaStandardProvider,
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    );
    expect(url).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1');
  });

  it('creates an install plan with editable models', () => {
    const plan = buildInstallPlan(alibabaStandardProvider, {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk-standard',
      modelIds: ['qwen3.6-plus', 'custom-model'],
    });

    expect(plan.providerId).toBe('alibabaStandard');
    const models = plan.modelProviders?.[0]?.models;
    expect(models).toHaveLength(2);
    expect(models?.[0]).toMatchObject({
      id: 'qwen3.6-plus',
      name: '[ModelStudio Standard] qwen3.6-plus',
      generationConfig: {
        extra_body: { enable_thinking: true },
        contextWindowSize: 1000000,
      },
    });
    expect(models?.[1]).toMatchObject({
      id: 'custom-model',
      name: '[ModelStudio Standard] custom-model',
    });
    expect(models?.[1]?.generationConfig).toBeUndefined();
  });

  it('auto-derives ownership via envKey + prefix', () => {
    const plan = buildInstallPlan(alibabaStandardProvider, {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk-standard',
      modelIds: ['qwen3.5-plus'],
    });

    const ownsModel = plan.modelProviders?.[0]?.ownsModel;
    expect(ownsModel).toBeDefined();
    expect(
      ownsModel?.({
        id: 'qwen3.5-plus',
        envKey: 'DASHSCOPE_API_KEY',
        name: '[ModelStudio Standard] qwen3.5-plus',
      }),
    ).toBe(true);
    expect(
      ownsModel?.({
        id: 'qwen3.5-plus',
        envKey: 'OTHER_KEY',
        name: '[ModelStudio Standard] qwen3.5-plus',
      }),
    ).toBe(false);
    expect(
      ownsModel?.({
        id: 'qwen3.5-plus',
        envKey: 'DASHSCOPE_API_KEY',
        name: 'Wrong Prefix',
      }),
    ).toBe(false);
  });

  it('matches credentials for all base URL options', () => {
    const urls = (
      alibabaStandardProvider.baseUrl as Array<{ url: string }>
    ).map((o) => o.url);
    for (const url of urls) {
      expect(
        providerMatchesCredentials(
          alibabaStandardProvider,
          url,
          'DASHSCOPE_API_KEY',
        ),
      ).toBe(true);
    }
    expect(
      providerMatchesCredentials(
        alibabaStandardProvider,
        'https://unknown.com',
        'DASHSCOPE_API_KEY',
      ),
    ).toBe(false);
  });
});
