/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '../../../core/contentGenerator.js';
import {
  qwencloudStandardProvider,
  QWENCLOUD_CHINA_BASE_URL,
  QWENCLOUD_GLOBAL_BASE_URL,
} from '../../presets/qwencloud-standard.js';
import {
  qwencloudTokenPlanProvider,
  QWENCLOUD_TOKEN_PLAN_CHINA_BASE_URL,
} from '../../presets/qwencloud-token-plan.js';
import { tokenPlanProvider } from '../../presets/alibaba-token-plan.js';
import { alibabaStandardProvider } from '../../presets/alibaba-standard.js';
import { codingPlanProvider } from '../../presets/alibaba-coding-plan.js';
import { ALL_PROVIDERS, QWENCLOUD_PROVIDERS } from '../../all-providers.js';
import {
  buildInstallPlan,
  buildProviderTemplate,
  computeModelListVersion,
  getDefaultModelIds,
  providerMatchesCredentials,
} from '../../provider-config.js';

describe('qwencloudStandardProvider', () => {
  it('has correct provider config', () => {
    expect(qwencloudStandardProvider).toMatchObject({
      id: 'qwencloud-standard',
      label: 'Standard API Key',
      protocol: AuthType.USE_OPENAI,
      envKey: 'QWENCLOUD_API_KEY',
      modelsEditable: true,
      uiGroup: 'qwencloud',
    });
  });

  it('offers both platform endpoints with explicit labels', () => {
    const options = qwencloudStandardProvider.baseUrl as Array<{
      id: string;
      label: string;
      url: string;
      apiKeyUrl?: string;
    }>;
    expect(options.map((o) => o.url)).toEqual([
      QWENCLOUD_CHINA_BASE_URL,
      QWENCLOUD_GLOBAL_BASE_URL,
    ]);
    expect(QWENCLOUD_CHINA_BASE_URL).toBe(
      'https://maas.qianwenaiapi.com/compatible-mode/v1',
    );
    expect(QWENCLOUD_GLOBAL_BASE_URL).toBe(
      'https://maas.qwencloudapi.com/compatible-mode/v1',
    );
    // Platform must be an explicit choice, never inferred from UI language,
    // and each option carries its own key-acquisition link.
    expect(options.every((o) => o.apiKeyUrl?.startsWith('https://'))).toBe(
      true,
    );
    expect(options.map((o) => o.label)).toEqual([
      'China — 千问AI平台',
      'International — QwenCloud',
    ]);
  });

  it('is registered, and the qwencloud group excludes Coding Plan', () => {
    expect(ALL_PROVIDERS).toContain(qwencloudStandardProvider);
    expect(QWENCLOUD_PROVIDERS).toContain(qwencloudStandardProvider);
    // Coding Plan is an Alibaba ModelStudio product, never a QwenCloud
    // access method, and the sub-menu is built from this filtered group.
    expect(QWENCLOUD_PROVIDERS).not.toContain(codingPlanProvider);
  });

  it('seeds the platform model catalog', () => {
    expect(getDefaultModelIds(qwencloudStandardProvider)).toEqual([
      'qwen3.8-max',
      'qwen3.7-plus',
      'qwen3.8-flash',
      'deepseek-v4-pro-0813',
      'deepseek-v4.1-flash',
      'kimi-k3',
      'glm-5.3',
    ]);
    expect(
      qwencloudStandardProvider.models?.find(
        (model) => model.id === 'qwen3.7-plus',
      )?.modalities,
    ).toEqual({ image: true, video: true });
  });

  it('accepts pay-as-you-go key prefixes and rejects Token Plan keys', () => {
    const validate = qwencloudStandardProvider.validateApiKey!;
    expect(validate('sk-abc123', QWENCLOUD_CHINA_BASE_URL)).toBeNull();
    expect(validate('sk-ws-abc123', QWENCLOUD_CHINA_BASE_URL)).toBeNull();
    // A Token Plan key cannot draw down pay-as-you-go billing.
    expect(validate('sk-sp-abc123', QWENCLOUD_CHINA_BASE_URL)).toMatch(
      /Token Plan/,
    );
    expect(validate('not-a-key', QWENCLOUD_CHINA_BASE_URL)).not.toBeNull();
  });

  it('stamps the model name prefix and keeps credentials distinct', () => {
    const modelIds = getDefaultModelIds(qwencloudStandardProvider);
    const template = buildProviderTemplate(
      qwencloudStandardProvider,
      QWENCLOUD_CHINA_BASE_URL,
    );
    const version = computeModelListVersion(template);
    const plan = buildInstallPlan(qwencloudStandardProvider, {
      baseUrl: QWENCLOUD_CHINA_BASE_URL,
      apiKey: 'sk-standard',
      modelIds,
    });
    expect(plan.providerId).toBe('qwencloud-standard');
    expect(plan.env).toEqual({ QWENCLOUD_API_KEY: 'sk-standard' });
    expect(plan.modelProviders?.[0]?.models[0]).toMatchObject({
      id: 'qwen3.8-max',
      name: '[QwenCloud Standard] qwen3.8-max',
    });
    expect(plan.providerState).toEqual({
      'providerMetadata.qwencloud-standard': {
        baseUrl: QWENCLOUD_CHINA_BASE_URL,
        version,
      },
    });
  });

  it('never claims ModelStudio models, and ModelStudio never claims its own', () => {
    const qwencloudOwns = buildInstallPlan(qwencloudStandardProvider, {
      baseUrl: QWENCLOUD_CHINA_BASE_URL,
      apiKey: 'sk-standard',
      modelIds: ['qwen3.8-max'],
    }).modelProviders?.[0]?.ownsModel;
    const modelstudioOwns = buildInstallPlan(alibabaStandardProvider, {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk-standard',
      modelIds: ['qwen3.8-max'],
    }).modelProviders?.[0]?.ownsModel;

    const qwencloudModel = {
      id: 'qwen3.8-max',
      envKey: 'QWENCLOUD_API_KEY',
      baseUrl: QWENCLOUD_CHINA_BASE_URL,
      name: '[QwenCloud Standard] qwen3.8-max',
    };
    const modelstudioModel = {
      id: 'qwen3.8-max',
      envKey: 'DASHSCOPE_API_KEY',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      name: '[ModelStudio Standard] qwen3.8-max',
    };

    expect(qwencloudOwns?.(qwencloudModel)).toBe(true);
    expect(qwencloudOwns?.(modelstudioModel)).toBe(false);
    expect(modelstudioOwns?.(modelstudioModel)).toBe(true);
    expect(modelstudioOwns?.(qwencloudModel)).toBe(false);
  });

  it('never claims the QwenCloud Token Plan sibling, nor a foreign key on its own endpoint', () => {
    // Both QwenCloud presets share uiGroup, catalog and protocol bucket, so
    // the ownsModel gate is what keeps applyModelProvidersPatch from dropping
    // a Token Plan install when the Standard wizard re-runs. Its envKey and
    // baseUrl conjuncts each exclude the sibling independently; the baseUrl
    // leg is exercised on its own in the foreign-baseUrl case below.
    const owns = qwencloudStandardProvider.ownsModel!;
    expect(
      owns({
        id: 'qwen3.8-max',
        envKey: 'QWENCLOUD_TOKEN_PLAN_API_KEY',
        baseUrl: QWENCLOUD_TOKEN_PLAN_CHINA_BASE_URL,
      }),
    ).toBe(false);
    expect(
      owns({
        id: 'qwen3.8-max',
        envKey: 'MY_OWN_ENV_KEY',
        baseUrl: QWENCLOUD_CHINA_BASE_URL,
      }),
    ).toBe(false);
    expect(
      qwencloudTokenPlanProvider.ownsModel!({
        id: 'qwen3.8-max',
        envKey: 'QWENCLOUD_API_KEY',
        baseUrl: QWENCLOUD_CHINA_BASE_URL,
      }),
    ).toBe(false);
  });

  it('rejects a model with matching envKey but a foreign baseUrl', () => {
    // The ownsModel gate is a conjunction of envKey AND baseUrl. Existing
    // negatives all differ in envKey, so the baseUrl conjunct was never
    // exercised independently. This case proves the baseUrl check works
    // even when envKey matches.
    const owns = qwencloudStandardProvider.ownsModel!;
    expect(
      owns({
        id: 'qwen3.8-max',
        envKey: 'QWENCLOUD_API_KEY',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      }),
    ).toBe(false);
    expect(
      owns({
        id: 'qwen3.8-max',
        envKey: 'QWENCLOUD_API_KEY',
        baseUrl: QWENCLOUD_TOKEN_PLAN_CHINA_BASE_URL,
      }),
    ).toBe(false);
  });

  it('matches credentials for both platforms but not ModelStudio endpoints', () => {
    for (const url of [QWENCLOUD_CHINA_BASE_URL, QWENCLOUD_GLOBAL_BASE_URL]) {
      expect(
        providerMatchesCredentials(
          qwencloudStandardProvider,
          url,
          'QWENCLOUD_API_KEY',
        ),
      ).toBe(true);
    }
    // A saved ModelStudio config must keep resolving to ModelStudio.
    expect(
      providerMatchesCredentials(
        qwencloudStandardProvider,
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
        'DASHSCOPE_API_KEY',
      ),
    ).toBe(false);
    expect(
      providerMatchesCredentials(
        alibabaStandardProvider,
        QWENCLOUD_CHINA_BASE_URL,
        'QWENCLOUD_API_KEY',
      ),
    ).toBe(false);
    // The existing negatives above differ in both envKey and URL, so they
    // short-circuit on envKey and never exercise the URL gate. These cases
    // pass the correct envKey with a wrong URL, proving the URL check works
    // independently.
    expect(
      providerMatchesCredentials(
        qwencloudStandardProvider,
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
        'QWENCLOUD_API_KEY',
      ),
    ).toBe(false);
    expect(
      providerMatchesCredentials(
        qwencloudStandardProvider,
        QWENCLOUD_TOKEN_PLAN_CHINA_BASE_URL,
        'QWENCLOUD_API_KEY',
      ),
    ).toBe(false);
  });

  it('declares the built-in web search backend', () => {
    expect(qwencloudStandardProvider.webSearch).toEqual({
      backend: 'dashscope',
    });
  });

  it('keeps the Token Plan credential namespace separate', () => {
    expect(qwencloudStandardProvider.envKey).not.toBe(tokenPlanProvider.envKey);
    expect(qwencloudStandardProvider.envKey).not.toBe(
      alibabaStandardProvider.envKey,
    );
  });
});
