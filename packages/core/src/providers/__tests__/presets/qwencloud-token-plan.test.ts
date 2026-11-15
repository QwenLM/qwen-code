/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '../../../core/contentGenerator.js';
import {
  qwencloudTokenPlanProvider,
  QWENCLOUD_TOKEN_PLAN_CHINA_BASE_URL,
  QWENCLOUD_TOKEN_PLAN_GLOBAL_BASE_URL,
} from '../../presets/qwencloud-token-plan.js';
import { tokenPlanProvider } from '../../presets/alibaba-token-plan.js';
import { ALL_PROVIDERS, QWENCLOUD_PROVIDERS } from '../../all-providers.js';
import {
  buildInstallPlan,
  buildProviderTemplate,
  computeModelListVersion,
  getDefaultModelIds,
  providerMatchesCredentials,
} from '../../provider-config.js';

describe('qwencloudTokenPlanProvider', () => {
  it('has correct provider config', () => {
    expect(qwencloudTokenPlanProvider).toMatchObject({
      id: 'qwencloud-token-plan',
      label: 'Token Plan',
      protocol: AuthType.USE_OPENAI,
      envKey: 'QWENCLOUD_TOKEN_PLAN_API_KEY',
      supportsModelDiscovery: true,
      uiGroup: 'qwencloud',
    });
  });

  it('offers both platform Token Plan endpoints', () => {
    const urls = (
      qwencloudTokenPlanProvider.baseUrl as Array<{ url: string }>
    ).map((o) => o.url);
    expect(urls).toEqual([
      QWENCLOUD_TOKEN_PLAN_CHINA_BASE_URL,
      QWENCLOUD_TOKEN_PLAN_GLOBAL_BASE_URL,
    ]);
    expect(QWENCLOUD_TOKEN_PLAN_CHINA_BASE_URL).toBe(
      'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1',
    );
    expect(QWENCLOUD_TOKEN_PLAN_GLOBAL_BASE_URL).toBe(
      'https://token-plan.maas.qwencloudapi.com/compatible-mode/v1',
    );
  });

  it('keeps callable DeepSeek metadata while excluding the unavailable Kimi default', () => {
    expect(
      (qwencloudTokenPlanProvider.models ?? []).map((model) => model.id),
    ).toEqual([
      'qwen3.8-max',
      'qwen3.7-plus',
      'qwen3.8-flash',
      'deepseek-v4-pro-0813',
      'deepseek-v4.1-flash',
      'glm-5.3',
    ]);
    const plan = buildInstallPlan(qwencloudTokenPlanProvider, {
      baseUrl: QWENCLOUD_TOKEN_PLAN_CHINA_BASE_URL,
      apiKey: 'sk-sp-test',
      modelIds: ['deepseek-v4-pro-0813'],
    });
    expect(plan.modelProviders?.[0].models[0]).toMatchObject({
      id: 'deepseek-v4-pro-0813',
      capabilities: {
        reasoning: { efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
      },
      generationConfig: { contextWindowSize: 1000000 },
    });
  });

  it('requires the dedicated sk-sp- key prefix', () => {
    const validate = qwencloudTokenPlanProvider.validateApiKey!;
    expect(
      validate('sk-sp-abc123', QWENCLOUD_TOKEN_PLAN_CHINA_BASE_URL),
    ).toBeNull();
    // A pay-as-you-go key cannot draw down the subscription quota.
    expect(validate('sk-abc123', QWENCLOUD_TOKEN_PLAN_CHINA_BASE_URL)).toMatch(
      /sk-sp-/,
    );
    expect(
      validate('sk-ws-abc123', QWENCLOUD_TOKEN_PLAN_CHINA_BASE_URL),
    ).toMatch(/sk-sp-/);
  });

  it('names the Global/Intl route distinctly from China', () => {
    expect(
      (qwencloudTokenPlanProvider.modelNamePrefix as (u: string) => string)(
        QWENCLOUD_TOKEN_PLAN_GLOBAL_BASE_URL,
      ),
    ).toBe('QwenCloud Token Plan for Global/Intl');
    expect(
      (qwencloudTokenPlanProvider.modelNamePrefix as (u: string) => string)(
        QWENCLOUD_TOKEN_PLAN_CHINA_BASE_URL,
      ),
    ).toBe('QwenCloud Token Plan');
  });

  it('stamps providerState per platform route', () => {
    const modelIds = getDefaultModelIds(qwencloudTokenPlanProvider);
    const stamped = (url: string) =>
      buildInstallPlan(qwencloudTokenPlanProvider, {
        baseUrl: url,
        apiKey: 'sk-sp-test',
        modelIds,
      }).providerState;

    for (const url of [
      QWENCLOUD_TOKEN_PLAN_CHINA_BASE_URL,
      QWENCLOUD_TOKEN_PLAN_GLOBAL_BASE_URL,
    ]) {
      expect(stamped(url)).toEqual({
        'providerMetadata.qwencloud-token-plan': {
          baseUrl: url,
          version: computeModelListVersion(
            buildProviderTemplate(qwencloudTokenPlanProvider, url),
          ),
        },
      });
    }
  });

  it('keeps its credentials separate from ModelStudio Token Plan', () => {
    expect(qwencloudTokenPlanProvider.envKey).not.toBe(
      tokenPlanProvider.envKey,
    );
    // A saved ModelStudio Token Plan config must keep resolving to ModelStudio.
    expect(
      providerMatchesCredentials(
        qwencloudTokenPlanProvider,
        'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        'BAILIAN_TOKEN_PLAN_API_KEY',
      ),
    ).toBe(false);
    expect(
      providerMatchesCredentials(
        tokenPlanProvider,
        QWENCLOUD_TOKEN_PLAN_CHINA_BASE_URL,
        'QWENCLOUD_TOKEN_PLAN_API_KEY',
      ),
    ).toBe(false);
    // The negatives above differ in both envKey and URL, so they short-circuit
    // on envKey and never exercise the URL gate. These cases pass the correct
    // envKey with a wrong URL, proving the URL check works independently.
    expect(
      providerMatchesCredentials(
        qwencloudTokenPlanProvider,
        'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        'QWENCLOUD_TOKEN_PLAN_API_KEY',
      ),
    ).toBe(false);
    expect(
      providerMatchesCredentials(
        qwencloudTokenPlanProvider,
        'https://maas.qianwenaiapi.com/compatible-mode/v1',
        'QWENCLOUD_TOKEN_PLAN_API_KEY',
      ),
    ).toBe(false);
  });

  it('owns only models installed against its own endpoints', () => {
    const ownsModel = buildInstallPlan(qwencloudTokenPlanProvider, {
      baseUrl: QWENCLOUD_TOKEN_PLAN_CHINA_BASE_URL,
      apiKey: 'sk-sp-test',
      modelIds: ['qwen3.8-max'],
    }).modelProviders?.[0]?.ownsModel;

    expect(
      ownsModel?.({
        id: 'qwen3.8-max',
        envKey: 'QWENCLOUD_TOKEN_PLAN_API_KEY',
        baseUrl: QWENCLOUD_TOKEN_PLAN_CHINA_BASE_URL,
      }),
    ).toBe(true);
    expect(
      ownsModel?.({
        id: 'qwen3.8-max',
        envKey: 'BAILIAN_TOKEN_PLAN_API_KEY',
        baseUrl: QWENCLOUD_TOKEN_PLAN_CHINA_BASE_URL,
      }),
    ).toBe(false);
    expect(
      ownsModel?.({
        id: 'qwen3.8-max',
        envKey: 'QWENCLOUD_TOKEN_PLAN_API_KEY',
        baseUrl: QWENCLOUD_TOKEN_PLAN_GLOBAL_BASE_URL,
      }),
    ).toBe(true);
  });

  it('rejects a model with matching envKey but a foreign baseUrl', () => {
    // Every negative above differs in envKey, so the baseUrl conjunct was
    // never the deciding factor. The pay-as-you-go endpoint shares the host
    // family but not the subscription quota.
    expect(
      qwencloudTokenPlanProvider.ownsModel!({
        id: 'qwen3.8-max',
        envKey: 'QWENCLOUD_TOKEN_PLAN_API_KEY',
        baseUrl: 'https://maas.qianwenaiapi.com/compatible-mode/v1',
      }),
    ).toBe(false);
  });

  it('is registered in the qwencloud access-method group', () => {
    expect(ALL_PROVIDERS).toContain(qwencloudTokenPlanProvider);
    expect(QWENCLOUD_PROVIDERS).toContain(qwencloudTokenPlanProvider);
  });

  it('declares the built-in web search backend', () => {
    expect(qwencloudTokenPlanProvider.webSearch).toEqual({
      backend: 'dashscope',
    });
  });
});
