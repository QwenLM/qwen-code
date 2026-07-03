/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reproduction and regression tests for persistent 401 after API key change.
 *
 * Issues: #5979, #6129, #3417, #6283
 *
 * Scenarios:
 * 1. `.env` file shadows settings.env new key after restart
 * 2. Model switch changes envKey → apiKey becomes undefined
 * 3. Empty-string env var blocks settings.env (fixed: settings.env now
 *    overrides empty-string values)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ModelsConfig } from './modelsConfig.js';
import { AuthType } from '../core/contentGenerator.js';
import type { ModelProvidersConfig } from './types.js';

describe('Persistent 401 reproduction — issue #5979 / #6129 / #6283', () => {
  const ENV_KEY_DASHSCOPE = 'TEST_DASHSCOPE_API_KEY_REPRO';
  const ENV_KEY_TOKEN_PLAN = 'TEST_TOKEN_PLAN_API_KEY_REPRO';

  beforeEach(() => {
    delete process.env[ENV_KEY_DASHSCOPE];
    delete process.env[ENV_KEY_TOKEN_PLAN];
  });

  afterEach(() => {
    delete process.env[ENV_KEY_DASHSCOPE];
    delete process.env[ENV_KEY_TOKEN_PLAN];
  });

  /**
   * Scenario 1: `.env` file stale key shadows settings.env new key.
   *
   * This scenario is a loadEnvironment-layer issue (tested separately in
   * settings.test.ts). At the ModelsConfig layer, we verify that
   * applyResolvedModelDefaults reads whatever is in process.env — if
   * process.env has the old key, that's what gets used.
   */
  it('uses the value from process.env even when it differs from settings.env', async () => {
    const OLD_KEY = 'sk-old-expired-key';

    // Simulate .env file loading old value into process.env before
    // settings.env had a chance to override it
    process.env[ENV_KEY_DASHSCOPE] = OLD_KEY;

    const modelProvidersConfig: ModelProvidersConfig = {
      openai: [
        {
          id: 'qwen3-coder',
          name: 'Qwen3 Coder',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          envKey: ENV_KEY_DASHSCOPE,
        },
      ],
    };

    const modelsConfig = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      modelProvidersConfig,
    });

    await modelsConfig.switchModel(AuthType.USE_OPENAI, 'qwen3-coder');

    const gc = modelsConfig.getGenerationConfig();
    // ModelsConfig always reads from process.env — if the env var layer
    // let a stale key through, it propagates here.
    expect(gc.apiKey).toBe(OLD_KEY);
  });

  /**
   * Scenario 2: Model switch changes envKey → apiKey becomes undefined.
   *
   * This is by-design behavior (different providers need different keys),
   * but the debug log added in the fix now tells users WHICH envKey is
   * expected.
   */
  it('loses apiKey when switching to model with different envKey', async () => {
    process.env[ENV_KEY_DASHSCOPE] = 'sk-dashscope-valid';

    const modelProvidersConfig: ModelProvidersConfig = {
      openai: [
        {
          id: 'qwen3-coder',
          name: 'Qwen3 Coder (DashScope)',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          envKey: ENV_KEY_DASHSCOPE,
        },
        {
          id: 'qwen3-coder-tp',
          name: 'Qwen3 Coder (Token Plan)',
          baseUrl:
            'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
          envKey: ENV_KEY_TOKEN_PLAN,
        },
      ],
    };

    const modelsConfig = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      modelProvidersConfig,
    });

    await modelsConfig.switchModel(AuthType.USE_OPENAI, 'qwen3-coder');
    expect(modelsConfig.getGenerationConfig().apiKey).toBe(
      'sk-dashscope-valid',
    );

    await modelsConfig.switchModel(AuthType.USE_OPENAI, 'qwen3-coder-tp');

    const gc = modelsConfig.getGenerationConfig();
    expect(gc.apiKey).toBeUndefined();
    expect(gc.model).toBe('qwen3-coder-tp');
  });

  /**
   * Scenario 3 (FIXED): Empty-string env var no longer blocks apiKey.
   *
   * Before fix: empty string in process.env → Object.hasOwn returns true →
   *   settings.env skipped → apiKey undefined → 401.
   * After fix: loadEnvironment treats empty-string as unset → settings.env
   *   fills the gap. At the ModelsConfig layer, empty-string is still
   *   falsy and applyResolvedModelDefaults correctly skips it.
   */
  it('treats empty-string env var as unset (apiKey stays undefined at model layer)', async () => {
    process.env[ENV_KEY_DASHSCOPE] = '';

    const modelProvidersConfig: ModelProvidersConfig = {
      openai: [
        {
          id: 'qwen3-coder',
          name: 'Qwen3 Coder',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          envKey: ENV_KEY_DASHSCOPE,
        },
      ],
    };

    const modelsConfig = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      modelProvidersConfig,
    });

    await modelsConfig.switchModel(AuthType.USE_OPENAI, 'qwen3-coder');

    const gc = modelsConfig.getGenerationConfig();
    // Empty string is falsy → applyResolvedModelDefaults `if (apiKey)` skips it.
    // With the loadEnvironment fix, settings.env would have filled process.env
    // before we get here, but at the ModelsConfig layer this test only sees
    // what process.env contains right now (empty string).
    expect(gc.apiKey).toBeUndefined();
  });
});
