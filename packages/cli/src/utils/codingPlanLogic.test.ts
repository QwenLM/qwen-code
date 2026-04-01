/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import type { Config, ModelProvidersConfig } from '@qwen-code/qwen-code-core';
import { applyCodingPlanAuth } from './codingPlanLogic.js';
import {
  CodingPlanRegion,
  CODING_PLAN_ENV_KEY,
} from '../constants/codingPlan.js';
import type { LoadedSettings } from '../config/settings.js';

vi.mock('../config/modelProvidersScope.js', () => ({
  getPersistScopeForModelSelection: () => 'user',
}));

function createMockSettings(
  existingConfigs: ModelProvidersConfig[keyof ModelProvidersConfig] = [],
): LoadedSettings {
  const merged: Record<string, unknown> = {
    modelProviders: {
      [AuthType.USE_OPENAI]: existingConfigs,
    },
  };
  return {
    merged,
    setValue: vi.fn(),
  } as unknown as LoadedSettings;
}

function createMockConfig(): Config {
  return {
    reloadModelProvidersConfig: vi.fn(),
    refreshAuth: vi.fn().mockResolvedValue(undefined),
  } as unknown as Config;
}

describe('applyCodingPlanAuth', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env[CODING_PLAN_ENV_KEY];
  });

  it('stores apiKey in settings and process.env', async () => {
    const settings = createMockSettings();
    const config = createMockConfig();

    await applyCodingPlanAuth(
      'sk-sp-test123',
      CodingPlanRegion.CHINA,
      settings,
      config,
    );

    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      `env.${CODING_PLAN_ENV_KEY}`,
      'sk-sp-test123',
    );
    expect(process.env[CODING_PLAN_ENV_KEY]).toBe('sk-sp-test123');
  });

  it('sets auth type to USE_OPENAI', async () => {
    const settings = createMockSettings();
    const config = createMockConfig();

    await applyCodingPlanAuth(
      'sk-sp-test123',
      CodingPlanRegion.CHINA,
      settings,
      config,
    );

    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'security.auth.selectedType',
      AuthType.USE_OPENAI,
    );
  });

  it('preserves non-coding-plan configs', async () => {
    const existingConfigs = [
      {
        id: 'custom-model',
        baseUrl: 'https://custom.example.com/v1',
        envKey: 'CUSTOM_KEY',
      },
    ];
    const settings = createMockSettings(existingConfigs);
    const config = createMockConfig();

    await applyCodingPlanAuth(
      'sk-sp-test123',
      CodingPlanRegion.CHINA,
      settings,
      config,
    );

    // The saved config should contain both new coding plan configs and old custom config
    const setValueCalls = (settings.setValue as ReturnType<typeof vi.fn>).mock
      .calls;
    const modelProviderCall = setValueCalls.find(
      (call: unknown[]) => call[1] === `modelProviders.${AuthType.USE_OPENAI}`,
    );
    expect(modelProviderCall).toBeDefined();
    const savedConfigs = modelProviderCall![2] as Array<{ id: string }>;
    expect(savedConfigs.some((c) => c.id === 'custom-model')).toBe(true);
  });

  it('filters out existing coding plan configs before adding new ones', async () => {
    const existingConfigs = [
      {
        id: 'qwen3.5-plus',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
        envKey: CODING_PLAN_ENV_KEY,
      },
    ];
    const settings = createMockSettings(existingConfigs);
    const config = createMockConfig();

    await applyCodingPlanAuth(
      'sk-sp-new',
      CodingPlanRegion.CHINA,
      settings,
      config,
    );

    const setValueCalls = (settings.setValue as ReturnType<typeof vi.fn>).mock
      .calls;
    const modelProviderCall = setValueCalls.find(
      (call: unknown[]) => call[1] === `modelProviders.${AuthType.USE_OPENAI}`,
    );
    const savedConfigs = modelProviderCall![2] as Array<{
      id: string;
      baseUrl: string;
    }>;
    // Should not have duplicates of the same model
    const qwen35Entries = savedConfigs.filter((c) => c.id === 'qwen3.5-plus');
    expect(qwen35Entries).toHaveLength(1);
  });

  it('calls refreshAuth after setting up config', async () => {
    const settings = createMockSettings();
    const config = createMockConfig();

    await applyCodingPlanAuth(
      'sk-sp-test123',
      CodingPlanRegion.GLOBAL,
      settings,
      config,
    );

    expect(config.refreshAuth).toHaveBeenCalledWith(AuthType.USE_OPENAI);
    expect(config.reloadModelProvidersConfig).toHaveBeenCalled();
  });

  it('stores region and version in settings', async () => {
    const settings = createMockSettings();
    const config = createMockConfig();

    await applyCodingPlanAuth(
      'sk-sp-test123',
      CodingPlanRegion.GLOBAL,
      settings,
      config,
    );

    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'codingPlan.region',
      CodingPlanRegion.GLOBAL,
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'codingPlan.version',
      expect.any(String),
    );
  });
});
