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
import { CODING_PLAN_ENV_KEY } from './subscriptionPlanDefinitions.js';
import {
  applyProviderInstallPlanToFile,
  readQwenSettingsForVSCode,
  writeCodingPlanConfig,
  writeModelProvidersConfig,
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
      // {__proto__: 'x'} literal sets the object's prototype rather than a
      // real property, so build the env via defineProperty to land an actual
      // "__proto__" own-property that survives Object.entries.
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
      // Ensure prototype was not polluted by the failed call
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('rejects writes that would overwrite an intermediate scalar segment', async () => {
      // Hand-edited settings with `env` as a string (legacy / mistake).
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
      // Original scalar must be untouched
      const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(after.env).toBe('legacy-string');
    });

    it('throws on malformed settings file instead of silently overwriting it', async () => {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      // Note the broken bracket — neither comments nor trailing commas fix it.
      fs.writeFileSync(settingsPath, '{ "broken": [1, 2', 'utf-8');
      const plan: ProviderInstallPlan = {
        providerId: 'test',
        authType: AuthType.USE_OPENAI,
        env: { K: 'v' },
      };

      await expect(applyProviderInstallPlanToFile(plan)).rejects.toThrow();
      // Bad file is preserved, not silently clobbered with {}
      expect(fs.readFileSync(settingsPath, 'utf-8')).toBe('{ "broken": [1, 2');
    });

    it('parses JSONC with trailing commas (and preserves comma inside strings)', async () => {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      // Comments + trailing commas + a string containing a literal ",]".
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
      expect(after.preserveMe).toBe(',]'); // literal preserved, not corrupted
      expect(after.list).toEqual([1, 2]);
      expect(after.env.K).toBe('v');
    });

    it('writes atomically — no .tmp residue on success', async () => {
      const plan: ProviderInstallPlan = {
        providerId: 'test',
        authType: AuthType.USE_OPENAI,
        env: { K: 'v' },
      };
      await applyProviderInstallPlanToFile(plan);
      const dir = path.dirname(settingsPath);
      const leftovers = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith('settings.json.') && f.endsWith('.tmp'));
      expect(leftovers).toEqual([]);
    });
  });
});
