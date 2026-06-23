/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  customProvider,
  CUSTOM_API_KEY_ENV_PREFIX,
  buildInstallPlan,
  shouldShowStep,
} from '@qwen-code/qwen-code-core';
// Re-import generateCustomEnvKey from the relative source path so the new
// hash-suffix format is exercised even before dist/ is rebuilt.
import { generateCustomEnvKey } from '../../presets/custom-provider.js';
import { Protocol } from '../../../core/contentGenerator.js';

describe('generateCustomEnvKey', () => {
  it('produces a deterministic URL-based key with a stable hash suffix', () => {
    const key1 = generateCustomEnvKey(
      Protocol.OPENAI,
      'https://api.example.com/v1',
    );
    const key2 = generateCustomEnvKey(
      Protocol.OPENAI,
      'https://api.example.com/v1',
    );
    expect(key1).toBe(key2);
    // Readable prefix + 6-hex-char SHA-256 suffix.
    expect(key1).toMatch(
      new RegExp(
        `^${CUSTOM_API_KEY_ENV_PREFIX}OPENAI_HTTPS_API_EXAMPLE_COM_V1_[0-9A-F]{12}$`,
      ),
    );
  });

  it('produces different keys for different protocols', () => {
    const k1 = generateCustomEnvKey(Protocol.OPENAI, 'https://api.example.com');
    const k2 = generateCustomEnvKey(
      Protocol.ANTHROPIC,
      'https://api.example.com',
    );
    expect(k1).not.toBe(k2);
  });

  it('produces different keys for different base URLs', () => {
    const k1 = generateCustomEnvKey(Protocol.OPENAI, 'https://api.a.com');
    const k2 = generateCustomEnvKey(Protocol.OPENAI, 'https://api.b.com');
    expect(k1).not.toBe(k2);
  });

  it('disambiguates structurally distinct URLs that normalize identically', () => {
    // Pre-fix bug: `api.example.com`, `api-example.com`, `api_example.com`
    // all collapsed to `API_EXAMPLE_COM`, so two different custom providers
    // would overwrite each other's API key. The hash suffix prevents that.
    const dotted = generateCustomEnvKey(
      Protocol.OPENAI,
      'https://api.example.com',
    );
    const dashed = generateCustomEnvKey(
      Protocol.OPENAI,
      'https://api-example.com',
    );
    const underscored = generateCustomEnvKey(
      Protocol.OPENAI,
      'https://api_example.com',
    );
    expect(dotted).not.toBe(dashed);
    expect(dotted).not.toBe(underscored);
    expect(dashed).not.toBe(underscored);
  });

  it('normalizes special characters to underscores in the readable part', () => {
    const k1 = generateCustomEnvKey(Protocol.OPENAI, 'http://api.a-b.com');
    // Readable prefix matches; trailing 6-hex suffix is separate.
    expect(k1).toMatch(
      new RegExp(
        `^${CUSTOM_API_KEY_ENV_PREFIX}OPENAI_HTTP_API_A_B_COM_[0-9A-F]{12}$`,
      ),
    );
  });

  it('handles empty strings', () => {
    const key = generateCustomEnvKey('' as Protocol, '');
    expect(key).toMatch(new RegExp(`^${CUSTOM_API_KEY_ENV_PREFIX}`));
  });
});

describe('customProvider', () => {
  it('has correct config shape', () => {
    expect(customProvider).toMatchObject({
      id: 'custom-openai-compatible',
      protocol: Protocol.OPENAI,
      baseUrl: undefined,
      models: undefined,
      showAdvancedConfig: true,
      uiGroup: 'custom',
    });
  });

  it('offers multiple protocol options', () => {
    expect(customProvider.protocolOptions).toEqual([
      Protocol.OPENAI,
      Protocol.ANTHROPIC,
      Protocol.GEMINI,
    ]);
  });

  it('keeps custom ownership detection but merges installs by model identity', () => {
    expect(customProvider.ownsModel).toBeTypeOf('function');
    expect(
      customProvider.ownsModel?.({
        id: 'whatever',
        envKey: `${CUSTOM_API_KEY_ENV_PREFIX}OPENAI_HTTPS_API_FOO_COM_ABCDEF`,
      }),
    ).toBe(true);
    expect(
      customProvider.ownsModel?.({
        id: 'preset-model',
        envKey: 'DEEPSEEK_API_KEY',
      }),
    ).toBe(false);
    expect(customProvider.mergeModelsByIdentity).toBe(true);

    const plan = buildInstallPlan(customProvider, {
      protocol: Protocol.OPENAI,
      baseUrl: 'https://my-proxy.com/v1',
      apiKey: 'sk-my-key',
      modelIds: ['model-a'],
    });

    expect(plan.modelProviders?.[0]?.ownsModel).toBeUndefined();
    expect(plan.modelSelection).toEqual({
      modelId: 'model-a',
      baseUrl: 'https://my-proxy.com/v1',
    });
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
      protocol: Protocol.ANTHROPIC,
      baseUrl: 'https://my-proxy.com/v1',
      apiKey: 'sk-my-key',
      modelIds: ['claude-3'],
      advancedConfig: { enableThinking: true, maxTokens: 8192 },
    });

    expect(plan.authType).toBe(Protocol.ANTHROPIC);
    const envKey = Object.keys(plan.env ?? {})[0]!;
    expect(envKey).toMatch(new RegExp(`^${CUSTOM_API_KEY_ENV_PREFIX}`));
    expect(plan.env?.[envKey]).toBe('sk-my-key');
    expect(plan.modelProviders?.[0]?.authType).toBe(Protocol.ANTHROPIC);

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
