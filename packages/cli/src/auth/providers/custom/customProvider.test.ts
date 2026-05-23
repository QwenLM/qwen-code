/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import {
  customProvider,
  generateCustomEnvKey,
  CUSTOM_API_KEY_ENV_PREFIX,
} from './customProvider.js';
import { buildInstallPlan, shouldShowStep } from '../../providerConfig.js';

describe('generateCustomEnvKey', () => {
  it('produces a deterministic URL-based key', () => {
    const key1 = generateCustomEnvKey(
      AuthType.USE_OPENAI,
      'https://api.example.com/v1',
    );
    const key2 = generateCustomEnvKey(
      AuthType.USE_OPENAI,
      'https://api.example.com/v1',
    );
    expect(key1).toBe(key2);
    expect(key1).toBe(
      `${CUSTOM_API_KEY_ENV_PREFIX}OPENAI_HTTPS_API_EXAMPLE_COM_V1`,
    );
  });

  it('produces different keys for different protocols', () => {
    const k1 = generateCustomEnvKey(
      AuthType.USE_OPENAI,
      'https://api.example.com',
    );
    const k2 = generateCustomEnvKey(
      AuthType.USE_ANTHROPIC,
      'https://api.example.com',
    );
    expect(k1).not.toBe(k2);
  });

  it('produces different keys for different base URLs', () => {
    const k1 = generateCustomEnvKey(AuthType.USE_OPENAI, 'https://api.a.com');
    const k2 = generateCustomEnvKey(AuthType.USE_OPENAI, 'https://api.b.com');
    expect(k1).not.toBe(k2);
  });

  it('normalizes special characters to underscores', () => {
    const k1 = generateCustomEnvKey(AuthType.USE_OPENAI, 'http://api.a-b.com');
    expect(k1).toBe(`${CUSTOM_API_KEY_ENV_PREFIX}OPENAI_HTTP_API_A_B_COM`);
  });

  it('handles empty strings', () => {
    const key = generateCustomEnvKey('' as AuthType, '');
    expect(key).toMatch(new RegExp(`^${CUSTOM_API_KEY_ENV_PREFIX}`));
  });
});

describe('customProvider', () => {
  it('has correct config shape', () => {
    expect(customProvider).toMatchObject({
      id: 'custom-openai-compatible',
      protocol: AuthType.USE_OPENAI,
      baseUrl: undefined,
      models: undefined,
      authMethod: 'input',
      showAdvancedConfig: true,
      uiGroup: 'custom',
    });
  });

  it('offers multiple protocol options', () => {
    expect(customProvider.protocolOptions).toEqual([
      AuthType.USE_OPENAI,
      AuthType.USE_ANTHROPIC,
      AuthType.USE_GEMINI,
    ]);
  });

  it('does not define ownsModel (falls back to id-based filtering)', () => {
    expect(customProvider.ownsModel).toBeUndefined();
  });

  it('shows protocol, baseUrl, models, and advancedConfig steps', () => {
    expect(shouldShowStep(customProvider, 'protocol')).toBe(true);
    expect(shouldShowStep(customProvider, 'baseUrl')).toBe(true);
    expect(shouldShowStep(customProvider, 'apiKey')).toBe(true);
    expect(shouldShowStep(customProvider, 'models')).toBe(true);
    expect(shouldShowStep(customProvider, 'advancedConfig')).toBe(true);
  });

  it('creates an install plan with custom inputs', () => {
    const plan = buildInstallPlan(customProvider, {
      protocol: AuthType.USE_ANTHROPIC,
      baseUrl: 'https://my-proxy.com/v1',
      apiKey: 'sk-my-key',
      modelIds: ['claude-3'],
      advancedConfig: { enableThinking: true, maxTokens: 8192 },
    });

    expect(plan.authType).toBe(AuthType.USE_ANTHROPIC);
    const envKey = Object.keys(plan.env ?? {})[0]!;
    expect(envKey).toMatch(new RegExp(`^${CUSTOM_API_KEY_ENV_PREFIX}`));
    expect(plan.env?.[envKey]).toBe('sk-my-key');
    expect(plan.modelProviders?.[0]?.authType).toBe(AuthType.USE_ANTHROPIC);

    const models = plan.modelProviders?.[0]?.models;
    expect(models?.[0]).toMatchObject({ id: 'claude-3' });
    expect(models?.[0]?.generationConfig?.extra_body).toEqual({
      enable_thinking: true,
    });
    expect(models?.[0]?.generationConfig?.samplingParams).toEqual({
      max_tokens: 8192,
    });
  });
});
