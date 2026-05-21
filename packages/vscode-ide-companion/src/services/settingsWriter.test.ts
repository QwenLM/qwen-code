/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetGlobalSettingsPath } = vi.hoisted(() => ({
  mockGetGlobalSettingsPath: vi.fn(),
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    Storage: {
      ...actual.Storage,
      getGlobalSettingsPath: mockGetGlobalSettingsPath,
    },
  };
});

import { AuthType, type ProviderInstallPlan } from '@qwen-code/qwen-code-core';
import {
  CODING_PLAN_ENV_KEY,
  TOKEN_PLAN_ENV_KEY,
  getSubscriptionPlanConfig,
} from './subscriptionPlanDefinitions.js';
import {
  applyProviderInstallPlanToFile,
  readQwenSettingsForVSCode,
  writeCodingPlanConfig,
  writeModelProvidersConfig,
  writeTokenPlanConfig,
} from './settingsWriter.js';

describe('settingsWriter', () => {
  let tempDir: string;
  let settingsPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-vscode-settings-'));
    settingsPath = path.join(tempDir, '.qwen', 'settings.json');
    mockGetGlobalSettingsPath.mockReturnValue(settingsPath);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('clears stale coding plan metadata when writing api-key providers', () => {
    writeCodingPlanConfig('china', 'coding-plan-key');

    writeModelProvidersConfig({
      apiKey: 'manual-key',
      modelProviders: {
        'gpt-4o': 'https://api.openai.com/v1',
      },
      activeModel: 'gpt-4o',
    });

    const settings = JSON.parse(
      fs.readFileSync(settingsPath, 'utf-8'),
    ) as Record<string, unknown>;
    const env = settings.env as Record<string, string>;
    const modelProviders = settings.modelProviders as Record<string, unknown>;
    const openaiModels = modelProviders[AuthType.USE_OPENAI] as Array<
      Record<string, string>
    >;

    expect(env.OPENAI_API_KEY).toBe('manual-key');
    expect(env[CODING_PLAN_ENV_KEY]).toBeUndefined();
    expect(settings.codingPlan).toBeUndefined();
    expect(settings.model).toEqual({ name: 'gpt-4o' });
    // The new entry must be present
    expect(openaiModels[0]).toEqual({
      id: 'gpt-4o',
      name: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      envKey: 'OPENAI_API_KEY',
    });
    // Non-target entries (Coding Plan) are preserved, not silently deleted
    const preserved = openaiModels.filter(
      (m) => m.envKey === CODING_PLAN_ENV_KEY,
    );
    expect(preserved.length).toBeGreaterThan(0);
  });

  it('reads an api-key configuration after switching away from coding plan', () => {
    writeCodingPlanConfig('china', 'coding-plan-key');

    writeModelProvidersConfig({
      apiKey: 'manual-key',
      modelProviders: {
        'gpt-4o': 'https://api.openai.com/v1',
      },
      activeModel: 'gpt-4o',
    });

    expect(readQwenSettingsForVSCode()).toEqual({
      provider: 'api-key',
      apiKey: 'manual-key',
    });
  });

  it('writes Token Plan config with the CLI Token Plan model template', () => {
    writeTokenPlanConfig('token-plan-key');

    const settings = JSON.parse(
      fs.readFileSync(settingsPath, 'utf-8'),
    ) as Record<string, unknown>;
    const env = settings.env as Record<string, string>;
    const modelProviders = settings.modelProviders as Record<string, unknown>;
    const openaiModels = modelProviders[AuthType.USE_OPENAI] as Array<
      Record<string, string>
    >;
    const providerMetadata = settings.providerMetadata as Record<
      string,
      Record<string, string>
    >;
    const expectedModelIds = [
      'qwen3.6-plus',
      'deepseek-v3.2',
      'glm-5',
      'MiniMax-M2.5',
    ];

    expect(env[TOKEN_PLAN_ENV_KEY]).toBe('token-plan-key');
    expect(settings.model).toEqual({ name: 'qwen3.6-plus' });
    expect(openaiModels.map((model) => model.id)).toEqual(expectedModelIds);
    expect(
      openaiModels.every((model) => model.envKey === TOKEN_PLAN_ENV_KEY),
    ).toBe(true);
    // qwen3.6-plus must keep the CLI's image/video modalities so the
    // VS Code-configured Token Plan advertises the same multimodal
    // support as the CLI provider entry.
    const qwen36 = openaiModels.find(
      (model) => model.id === 'qwen3.6-plus',
    ) as unknown as { generationConfig?: Record<string, unknown> };
    expect(qwen36.generationConfig?.modalities).toEqual({
      image: true,
      video: true,
    });
    const deepseek = openaiModels.find(
      (model) => model.id === 'deepseek-v3.2',
    ) as unknown as { generationConfig?: Record<string, unknown> };
    expect(deepseek.generationConfig?.modalities).toBeUndefined();
    expect(providerMetadata['token-plan']).toMatchObject({
      baseUrl: getSubscriptionPlanConfig('token').baseUrl,
      version: expect.any(String),
    });
    expect(settings.tokenPlan).toBeUndefined();
  });

  it('reads Token Plan config without overwriting Coding Plan region', () => {
    writeTokenPlanConfig('token-plan-key');

    expect(readQwenSettingsForVSCode()).toEqual({
      provider: 'token-plan',
      apiKey: 'token-plan-key',
    });
  });

  it('preserves api-key credentials and custom models when writing Token Plan', () => {
    writeModelProvidersConfig({
      apiKey: 'manual-key',
      modelProviders: {
        'gpt-4o': 'https://api.openai.com/v1',
      },
      activeModel: 'gpt-4o',
    });

    writeTokenPlanConfig('token-plan-key');

    const settings = JSON.parse(
      fs.readFileSync(settingsPath, 'utf-8'),
    ) as Record<string, unknown>;
    const env = settings.env as Record<string, string>;
    const modelProviders = settings.modelProviders as Record<string, unknown>;
    const openaiModels = modelProviders[AuthType.USE_OPENAI] as Array<
      Record<string, string>
    >;

    // The preserved custom model still references OPENAI_API_KEY, so the
    // key must survive the plan switch (otherwise it breaks silently).
    expect(env.OPENAI_API_KEY).toBe('manual-key');
    expect(env[TOKEN_PLAN_ENV_KEY]).toBe('token-plan-key');
    expect(openaiModels.map((model) => model.id)).toContain('gpt-4o');
    expect(openaiModels.find((model) => model.id === 'gpt-4o')).toMatchObject({
      baseUrl: 'https://api.openai.com/v1',
      envKey: 'OPENAI_API_KEY',
    });
  });

  it('clears stale sibling subscription plan credentials when switching plans', () => {
    writeCodingPlanConfig('global', 'coding-plan-key');
    writeTokenPlanConfig('token-plan-key');

    let settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    let env = settings.env as Record<string, string>;
    let providerMetadata = settings.providerMetadata as Record<string, unknown>;

    expect(env[CODING_PLAN_ENV_KEY]).toBeUndefined();
    expect(env[TOKEN_PLAN_ENV_KEY]).toBe('token-plan-key');
    expect(providerMetadata['coding-plan']).toBeUndefined();
    expect(providerMetadata['token-plan']).toMatchObject({
      baseUrl: getSubscriptionPlanConfig('token').baseUrl,
      version: expect.any(String),
    });

    writeCodingPlanConfig('china', 'new-coding-plan-key');

    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    env = settings.env as Record<string, string>;
    providerMetadata = settings.providerMetadata as Record<string, unknown>;

    expect(env[TOKEN_PLAN_ENV_KEY]).toBeUndefined();
    expect(env[CODING_PLAN_ENV_KEY]).toBe('new-coding-plan-key');
    expect(providerMetadata['token-plan']).toBeUndefined();
    expect(providerMetadata['coding-plan']).toMatchObject({
      baseUrl: getSubscriptionPlanConfig('coding').baseUrl,
      region: 'china',
      version: expect.any(String),
    });
  });

  describe('applyProviderInstallPlanToFile', () => {
    it('writes env, auth selection, and model providers to settings.json', async () => {
      const plan: ProviderInstallPlan = {
        providerId: 'test',
        authType: AuthType.USE_OPENAI,
        env: { TEST_API_KEY: 'sk-test' },
        modelSelection: { modelId: 'gpt-4o' },
        modelProviders: [
          {
            authType: AuthType.USE_OPENAI,
            models: [{ id: 'gpt-4o', envKey: 'TEST_API_KEY' }],
            mergeStrategy: 'prepend-and-remove-owned',
            ownsModel: (m) => m.envKey === 'TEST_API_KEY',
          },
        ],
      };

      await applyProviderInstallPlanToFile(plan);

      const written = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(written.env.TEST_API_KEY).toBe('sk-test');
      expect(written.security.auth.selectedType).toBe(AuthType.USE_OPENAI);
      expect(written.model.name).toBe('gpt-4o');
      expect(written.modelProviders[AuthType.USE_OPENAI]).toEqual([
        { id: 'gpt-4o', envKey: 'TEST_API_KEY' },
      ]);
    });

    it('rejects __proto__ in install-plan env keys (prototype-pollution guard)', async () => {
      const env: Record<string, string> = {};
      Object.defineProperty(env, '__proto__', {
        value: 'polluted',
        enumerable: true,
        writable: true,
        configurable: true,
      });
      const plan: ProviderInstallPlan = {
        providerId: 'evil',
        authType: AuthType.USE_OPENAI,
        env,
      };

      await expect(applyProviderInstallPlanToFile(plan)).rejects.toThrow(
        /reserved segment/,
      );
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('rejects writes that would overwrite an intermediate scalar segment', async () => {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ env: 'legacy-string' }),
        'utf-8',
      );
      const plan: ProviderInstallPlan = {
        providerId: 'test',
        authType: AuthType.USE_OPENAI,
        env: { NEW_KEY: 'value' },
      };

      await expect(applyProviderInstallPlanToFile(plan)).rejects.toThrow(
        /segment "env" is a string/,
      );
      const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(after.env).toBe('legacy-string');
    });

    it('throws on malformed settings file instead of silently overwriting it', async () => {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, '{ "broken": [1, 2', 'utf-8');
      const plan: ProviderInstallPlan = {
        providerId: 'test',
        authType: AuthType.USE_OPENAI,
        env: { K: 'v' },
      };

      await expect(applyProviderInstallPlanToFile(plan)).rejects.toThrow();
      expect(fs.readFileSync(settingsPath, 'utf-8')).toBe('{ "broken": [1, 2');
    });

    it('parses JSONC with trailing commas (and preserves comma inside strings)', async () => {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const jsonc = `{
  // hand-edited
  "preserveMe": ",]",
  "list": [1, 2,],
}`;
      fs.writeFileSync(settingsPath, jsonc, 'utf-8');
      const plan: ProviderInstallPlan = {
        providerId: 'test',
        authType: AuthType.USE_OPENAI,
        env: { K: 'v' },
      };

      await applyProviderInstallPlanToFile(plan);

      const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(after.preserveMe).toBe(',]');
      expect(after.list).toEqual([1, 2]);
      expect(after.env.K).toBe('v');
    });

    it('treats \\uXXXX as a 6-char escape (no parser differential / key injection)', async () => {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const jsonc = `{
  // attempted injection
  "API_KEY": "sk-abc\\u0022,\\n\\"INJECTED\\": \\"pwned",
}`;
      fs.writeFileSync(settingsPath, jsonc, 'utf-8');
      const plan: ProviderInstallPlan = {
        providerId: 'test',
        authType: AuthType.USE_OPENAI,
        env: { K: 'v' },
      };

      await applyProviderInstallPlanToFile(plan);

      const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(after.INJECTED).toBeUndefined();
      expect(after.env.K).toBe('v');
    });
  });
});
