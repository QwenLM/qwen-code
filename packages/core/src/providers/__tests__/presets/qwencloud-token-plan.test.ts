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
import {
  buildInstallPlan,
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

  it('declares the built-in web search backend', () => {
    expect(qwencloudTokenPlanProvider.webSearch).toEqual({
      backend: 'dashscope',
    });
  });
});
