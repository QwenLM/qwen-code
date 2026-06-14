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
  clearPersistedAuth,
  readQwenSettingsForVSCode,
  restoreSettingsSnapshot,
  snapshotSettingsForRollback,
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
    const openaiEntry = modelProviders[AuthType.USE_OPENAI] as Record<
      string,
      unknown
    >;
    const openaiModels = openaiEntry.models as Array<Record<string, string>>;

    expect(env.OPENAI_API_KEY).toBe('manual-key');
    expect(env[CODING_PLAN_ENV_KEY]).toBeUndefined();
    expect(settings.codingPlan).toBeUndefined();
    expect(settings.model).toEqual({ name: 'gpt-4o' });
    expect(openaiEntry.protocol).toBe('openai');
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
      expect(written.modelProviders[AuthType.USE_OPENAI]).toEqual({
        protocol: 'openai',
        models: [{ id: 'gpt-4o', envKey: 'TEST_API_KEY' }],
      });
    });

    it('strips a runtime snapshot prefix before persisting model.name', async () => {
      const plan: ProviderInstallPlan = {
        providerId: 'test',
        authType: AuthType.USE_OPENAI,
        env: { TEST_API_KEY: 'sk-test' },
        // A runtime snapshot id must never reach disk — the adapter's setValue
        // guard strips it back to the bare model id.
        modelSelection: { modelId: '$runtime|openai|gpt-4o' },
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
      expect(written.model.name).toBe('gpt-4o');
    });

    it('collapses stacked runtime snapshot prefixes before persisting model.name', async () => {
      const plan: ProviderInstallPlan = {
        providerId: 'test',
        authType: AuthType.USE_OPENAI,
        env: { TEST_API_KEY: 'sk-test' },
        modelSelection: { modelId: '$runtime|openai|$runtime|openai|gpt-4o' },
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
      expect(written.model.name).toBe('gpt-4o');
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

    it('treats \\uXXXX as a 6-char escape (no parser differential / key injection)', async () => {
      // If the JSONC string scanner stepped past the backslash with j+=2 for
      // every escape, `"` would leave `0022` in the buffer and the next
      // `"` would close the string early — letting an attacker inject extra
      // top-level keys (e.g. env.NODE_OPTIONS) into settings.json.
      // The corrected scanner consumes \uXXXX as 6 chars, so the value stays
      // a single string with a literal `"` in the middle.
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
      // Value is preserved as a single string with the literal quote.
      expect(after.API_KEY).toBe('sk-abc",\n"INJECTED": "pwned');
      // No injected top-level key landed in the file.
      expect(after.INJECTED).toBeUndefined();
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

  describe('clearPersistedAuth', () => {
    it('wipes preset, custom, and subscription-plan env keys without touching unrelated env', () => {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      // Pre-populate a settings file representing a user who has used
      // multiple providers (so each preset's envKey is set) plus a
      // hand-set NODE_OPTIONS the clear must leave alone.
      const initial = {
        env: {
          OPENAI_API_KEY: 'sk-openai',
          DEEPSEEK_API_KEY: 'sk-deepseek',
          MINIMAX_API_KEY: 'sk-minimax',
          ZAI_API_KEY: 'sk-zai',
          IDEALAB_API_KEY: 'sk-idealab',
          MODELSCOPE_API_KEY: 'sk-modelscope',
          OPENROUTER_API_KEY: 'sk-openrouter',
          BAILIAN_CODING_PLAN_API_KEY: 'sk-coding',
          BAILIAN_TOKEN_PLAN_API_KEY: 'sk-token',
          QWEN_CUSTOM_API_KEY_OPENAI_HTTPS_API_FOO_COM_ABC123DEF456:
            'sk-custom-1',
          QWEN_CUSTOM_API_KEY_ANTHROPIC_HTTPS_API_BAR_COM_DEAD0BEEF000:
            'sk-custom-2',
          NODE_OPTIONS: '--max-old-space-size=8192',
        },
        security: { auth: { selectedType: 'openai' } },
        providerMetadata: {
          'coding-plan': { version: '1' },
          deepseek: { version: '1' },
          openrouter: { version: '2' },
        },
      };
      fs.writeFileSync(settingsPath, JSON.stringify(initial, null, 2), 'utf-8');

      clearPersistedAuth();

      const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      // Every preset + subscription + OPENAI + every QWEN_CUSTOM_API_KEY_*
      // is gone; NODE_OPTIONS survives.
      expect(after.env).toEqual({ NODE_OPTIONS: '--max-old-space-size=8192' });
      // selectedType is wiped.
      expect(after.security?.auth?.selectedType).toBeUndefined();
      // providerMetadata is empty (or only holds keys that weren't ours).
      expect(after.providerMetadata['coding-plan']).toBeUndefined();
      expect(after.providerMetadata['deepseek']).toBeUndefined();
      expect(after.providerMetadata['openrouter']).toBeUndefined();
    });

    it('is a no-op when no settings file exists', () => {
      // No settings file written — clear must not throw.
      expect(() => clearPersistedAuth()).not.toThrow();
    });
  });

  describe('snapshotSettingsForRollback / restoreSettingsSnapshot', () => {
    it('round-trips: snapshot → mutate → restore brings the old state back', () => {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const original = {
        env: { OPENAI_API_KEY: 'sk-good' },
        security: { auth: { selectedType: 'openai' } },
      };
      fs.writeFileSync(
        settingsPath,
        JSON.stringify(original, null, 2),
        'utf-8',
      );

      const snapshot = snapshotSettingsForRollback();
      expect(snapshot).not.toBeNull();

      // Simulate a bad-credential install writing over the file.
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ env: { OPENAI_API_KEY: 'sk-bad' } }, null, 2),
        'utf-8',
      );

      restoreSettingsSnapshot(snapshot);

      const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(after).toEqual(original);
    });

    it('snapshot returns null on a malformed file and restore is then a no-op', () => {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, '{ "broken": [1, 2', 'utf-8');

      const snapshot = snapshotSettingsForRollback();
      expect(snapshot).toBeNull();

      // No-op restore must not throw and must not clobber the file.
      expect(() => restoreSettingsSnapshot(snapshot)).not.toThrow();
      expect(fs.readFileSync(settingsPath, 'utf-8')).toBe('{ "broken": [1, 2');
    });

    it('snapshot returns {} (not null) when no settings file exists', () => {
      // ENOENT → readSettings returns {}, so we get a valid empty snapshot
      // that restore can write (creating the file).
      const snapshot = snapshotSettingsForRollback();
      expect(snapshot).toEqual({});
    });
  });
});
