/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '../../../core/contentGenerator.js';
import { alibabaStandardProvider } from '../../presets/alibaba-standard.js';
import {
  buildInstallPlan,
  getDefaultModelIds,
  resolveBaseUrl,
  providerMatchesCredentials,
} from '../../provider-config.js';

describe('alibabaStandardProvider', () => {
  it('has correct provider config', () => {
    expect(alibabaStandardProvider).toMatchObject({
      id: 'alibabaStandard',
      label: 'Standard API Key',
      protocol: AuthType.USE_OPENAI,
      envKey: 'DASHSCOPE_API_KEY',
      modelsEditable: true,
      supportsModelDiscovery: true,
      uiGroup: 'alibaba',
    });
  });

  it('accepts pay-as-you-go keys and rejects subscription keys', () => {
    const validate = alibabaStandardProvider.validateApiKey!;
    expect(validate('sk-abc', '')).toBeNull();
    expect(validate('sk-ws-abc', '')).toBeNull();
    expect(validate('sk-sp-abc', '')).toMatch(/Token Plan/);
    expect(validate('abc', '')).toMatch(/Invalid API key/);
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

  it('includes qwen3.7 models in default model IDs', () => {
    expect(getDefaultModelIds(alibabaStandardProvider)).toEqual([
      'qwen3.6-plus',
      'qwen3.7-plus',
      'qwen3.7-max',
      'glm-5.3',
      'glm-5.2',
      'glm-5.1',
      'deepseek-v4-pro',
      'deepseek-v4.1-flash',
      'deepseek-v4.1-flash-1017',
      'qwen3.8-max',
      'qwen3.8-max-0902',
      'qwen3.8-flash',
      'deepseek-v4-pro-0813',
      'deepseek-v4-flash-0731',
      'kimi-k3',
      'kimi-k2.7-code',
      'kimi-k2.6',
    ]);
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

  it('marks only DeepSeek V4.1 Flash as multimodal', () => {
    const plan = buildInstallPlan(alibabaStandardProvider, {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk-standard',
      modelIds: ['deepseek-v4-pro', 'deepseek-v4.1-flash'],
    });

    const models = plan.modelProviders?.[0]?.models;
    expect(models?.[0]?.generationConfig).toEqual({
      contextWindowSize: 1000000,
    });
    expect(models?.[1]?.generationConfig).toEqual({
      contextWindowSize: 1000000,
      modalities: { image: true },
    });
  });

  it('declares the GLM thinking switch', () => {
    const models = alibabaStandardProvider.models!;
    // glm-5.2 / glm-5.1 are hybrid; declaring the switch lets Off ship.
    for (const id of ['glm-5.2', 'glm-5.1']) {
      expect(models.find((m) => m.id === id)?.capabilities?.reasoning).toEqual({
        thinking: true,
        toggleOnly: true,
        disableField: 'enable_thinking',
      });
    }
    // glm-5.3 rejects enable_thinking: false.
    const glm53 = models.find((m) => m.id === 'glm-5.3');
    expect(glm53?.thinkingMandatory).toBe(true);
    expect(glm53?.capabilities?.reasoning?.canDisable).toBe(false);
  });

  it('offers the full qwen3.8 effort ladder', () => {
    for (const id of ['qwen3.8-max', 'qwen3.8-max-0902', 'qwen3.8-flash']) {
      expect(
        alibabaStandardProvider.models!.find((m) => m.id === id)?.capabilities
          ?.reasoning,
      ).toMatchObject({ efforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
    }
  });

  it('limits the Alibaba Kimi K3 route to image input', () => {
    const plan = buildInstallPlan(alibabaStandardProvider, {
      baseUrl: resolveBaseUrl(alibabaStandardProvider),
      apiKey: 'test-key',
      modelIds: ['kimi-k3'],
    });
    expect(
      plan.modelProviders?.[0]?.models[0].generationConfig?.modalities,
    ).toEqual({ image: true });
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

  it('declares the built-in web search backend', () => {
    // The Responses API on these endpoints serves the search tools with the
    // same key, so `web_search` registers without extra configuration.
    expect(alibabaStandardProvider.webSearch).toEqual({
      backend: 'dashscope',
    });
  });
});
