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

import { AuthType } from '@qwen-code/qwen-code-core';
import {
  CODING_PLAN_ENV_KEY,
  TOKEN_PLAN_ENV_KEY,
  getSubscriptionPlanConfig,
} from './subscriptionPlanDefinitions.js';
import {
  applyProviderInstallPlanToFile,
  clearPersistedAuth,
  readQwenSettingsForVSCode,
  restoreSettingsSnapshot,
  snapshotSettingsForRollback,
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
      codingPlanRegion: 'china',
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

  it('clears api-key credentials but preserves custom models when writing Token Plan', () => {
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

    expect(env.OPENAI_API_KEY).toBeUndefined();
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
});
