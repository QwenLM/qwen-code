/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthType } from '../../core/contentGenerator.js';
import type { ModelProvidersConfig } from '../../models/types.js';
import {
  applyProviderInstallPlan,
  buildInstallPlan,
  customProvider,
  generateCustomEnvKey,
  ProviderInstallError,
  type ProviderInstallPlan,
  type ProviderSettingsAdapter,
} from '../index.js';

function createAdapter(modelProviders: ModelProvidersConfig = {}) {
  const adapter: ProviderSettingsAdapter & {
    setValue: ReturnType<typeof vi.fn>;
    persist: ReturnType<typeof vi.fn>;
    backup: ReturnType<typeof vi.fn>;
    restore: ReturnType<typeof vi.fn>;
    cleanupBackup: ReturnType<typeof vi.fn>;
  } = {
    getValue: vi.fn(),
    setValue: vi.fn(),
    getModelProviders: vi.fn(() => modelProviders),
    persist: vi.fn(),
    backup: vi.fn(),
    restore: vi.fn(),
    cleanupBackup: vi.fn(),
  };
  return adapter;
}

function getNestedValue(target: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((current, part) => {
    if (typeof current !== 'object' || current === null) return undefined;
    return (current as Record<string, unknown>)[part];
  }, target);
}

function setNestedValue(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  const parts = key.split('.');
  let current = target;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

describe('applyProviderInstallPlan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['TEST_API_KEY'];
    delete process.env['BRAND_NEW_KEY'];
    delete process.env['SHADOW_KEY'];
    delete process.env['EMPTY_SHADOW_KEY'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses an install plan that sets a reserved env var (NODE_OPTIONS)', async () => {
    const adapter = createAdapter();
    // CI sets NODE_OPTIONS (e.g. --max-old-space-size); snapshot whatever it
    // is so we can assert the rejected plan left it UNCHANGED rather than
    // assuming it's unset.
    const originalNodeOptions = process.env['NODE_OPTIONS'];
    const plan: ProviderInstallPlan = {
      providerId: 'evil',
      authType: AuthType.USE_OPENAI,
      env: { NODE_OPTIONS: '--require /tmp/evil.js' },
    };

    await expect(
      applyProviderInstallPlan(plan, { settings: adapter }),
    ).rejects.toThrow(/reserved environment variable: NODE_OPTIONS/);
    // The evil value must not have leaked into the live process; the
    // pre-existing value (if any) is untouched.
    expect(process.env['NODE_OPTIONS']).toBe(originalNodeOptions);
    expect(process.env['NODE_OPTIONS']).not.toBe('--require /tmp/evil.js');
    expect(adapter.setValue).not.toHaveBeenCalledWith(
      'env.NODE_OPTIONS',
      expect.anything(),
    );
  });

  it('does not start or roll back a pre-cancelled install', async () => {
    const adapter = createAdapter();
    const controller = new AbortController();
    controller.abort();
    const plan: ProviderInstallPlan = {
      providerId: 'copilot',
      authType: AuthType.USE_COPILOT,
      env: { TEST_API_KEY: 'copilot-install' },
    };

    await expect(
      applyProviderInstallPlan(plan, {
        settings: adapter,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ step: 'init' });
    expect(adapter.backup).not.toHaveBeenCalled();
    expect(adapter.restore).not.toHaveBeenCalled();
    expect(adapter.setValue).not.toHaveBeenCalled();
    expect(adapter.persist).not.toHaveBeenCalled();
  });

  it('matches the env denylist case-insensitively (Path)', async () => {
    const adapter = createAdapter();
    const plan: ProviderInstallPlan = {
      providerId: 'evil',
      authType: AuthType.USE_OPENAI,
      env: { Path: 'C:\\evil' },
    };

    await expect(
      applyProviderInstallPlan(plan, { settings: adapter }),
    ).rejects.toThrow(/reserved environment variable: Path/);
  });

  it.each(['TMP', 'TEMP', 'tmp'])(
    'rejects the Windows temp-redirect env var %s',
    async (key) => {
      const adapter = createAdapter();
      const plan: ProviderInstallPlan = {
        providerId: 'evil',
        authType: AuthType.USE_OPENAI,
        env: { [key]: 'C:\\evil-temp' },
      };

      await expect(
        applyProviderInstallPlan(plan, { settings: adapter }),
      ).rejects.toThrow(/reserved environment variable/);
    },
  );

  it('persists env, auth selection, selected model, and merged model providers', async () => {
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [
        {
          id: 'old-owned',
          envKey: 'TEST_API_KEY',
          generationConfig: { contextWindowSize: 123 },
        },
        {
          id: 'preserved',
          envKey: 'OTHER_API_KEY',
          generationConfig: { contextWindowSize: 456 },
        },
      ],
    });
    const reloadModelProviders = vi.fn();
    const syncAuthState = vi.fn();
    const refreshAuth = vi.fn(async () => undefined);

    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { TEST_API_KEY: 'sk-test' },
      modelSelection: { modelId: 'new-model' },
      modelProviders: [
        {
          authType: AuthType.USE_OPENAI,
          models: [{ id: 'new-model', envKey: 'TEST_API_KEY' }],
          mergeStrategy: 'prepend-and-remove-owned',
          ownsModel: (model) => model.envKey === 'TEST_API_KEY',
        },
      ],
    };

    await applyProviderInstallPlan(plan, {
      settings: adapter,
      reloadModelProviders,
      syncAuthState,
      refreshAuth,
    });

    expect(adapter.setValue).toHaveBeenCalledWith(
      'env.TEST_API_KEY',
      'sk-test',
    );
    expect(process.env['TEST_API_KEY']).toBe('sk-test');
    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      { id: 'new-model', envKey: 'TEST_API_KEY' },
      {
        id: 'preserved',
        envKey: 'OTHER_API_KEY',
        generationConfig: { contextWindowSize: 456 },
      },
    ]);
    expect(adapter.setValue).toHaveBeenCalledWith(
      'security.auth.selectedType',
      AuthType.USE_OPENAI,
    );
    expect(adapter.setValue).toHaveBeenCalledWith('model.name', 'new-model');
    // Id-only model selection must clear any stale baseUrl disambiguator
    // (empty-string tombstone overrides a lower-scope value on merge).
    expect(adapter.setValue).toHaveBeenCalledWith('model.baseUrl', '');
    expect(adapter.persist).toHaveBeenCalled();
    expect(reloadModelProviders).toHaveBeenCalledWith({
      [AuthType.USE_OPENAI]: [
        { id: 'new-model', envKey: 'TEST_API_KEY' },
        {
          id: 'preserved',
          envKey: 'OTHER_API_KEY',
          generationConfig: { contextWindowSize: 456 },
        },
      ],
    });
    expect(syncAuthState).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'new-model',
      undefined,
    );
    expect(refreshAuth).toHaveBeenCalledWith(AuthType.USE_OPENAI);
    expect(adapter.cleanupBackup).toHaveBeenCalled();
  });

  it('can skip immediate auth refresh', async () => {
    const adapter = createAdapter();
    const refreshAuth = vi.fn(async () => undefined);
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { TEST_API_KEY: 'sk-test' },
    };

    await applyProviderInstallPlan(plan, {
      settings: adapter,
      refreshAuth,
      doRefreshAuth: false,
    });

    expect(adapter.setValue).toHaveBeenCalledWith(
      'env.TEST_API_KEY',
      'sk-test',
    );
    expect(refreshAuth).not.toHaveBeenCalled();
  });

  it('prints a shadowing warning when an env key changes', async () => {
    process.env['SHADOW_KEY'] = 'old-value';
    const adapter = createAdapter();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { SHADOW_KEY: 'new-value' },
    };

    await applyProviderInstallPlan(plan, { settings: adapter });

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('SHADOW_KEY is also set'),
    );
    expect(process.env['SHADOW_KEY']).toBe('new-value');
  });

  it('does not print a shadowing warning for same or empty env values', async () => {
    process.env['SHADOW_KEY'] = 'same-value';
    process.env['EMPTY_SHADOW_KEY'] = '';
    const adapter = createAdapter();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: {
        SHADOW_KEY: 'same-value',
        EMPTY_SHADOW_KEY: 'filled-value',
      },
    };

    await applyProviderInstallPlan(plan, { settings: adapter });

    expect(consoleError).not.toHaveBeenCalled();
    expect(process.env['SHADOW_KEY']).toBe('same-value');
    expect(process.env['EMPTY_SHADOW_KEY']).toBe('filled-value');
  });

  it('uses patch ownsModel for merge filtering', async () => {
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [
        { id: 'old-a', envKey: 'A' },
        { id: 'old-b', envKey: 'B' },
      ],
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      modelProviders: [
        {
          authType: AuthType.USE_OPENAI,
          models: [{ id: 'new-a', envKey: 'A' }],
          mergeStrategy: 'prepend-and-remove-owned',
          ownsModel: (model) => model.envKey === 'A',
        },
      ],
    };

    await applyProviderInstallPlan(plan, { settings: adapter });

    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      { id: 'new-a', envKey: 'A' },
      { id: 'old-b', envKey: 'B' },
    ]);
  });

  it('falls back to id+baseUrl identity when ownsModel is omitted', async () => {
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [
        // Same id, different baseUrl → should be preserved (different identity)
        { id: 'gpt-4o', baseUrl: 'https://proxy-a.example/v1' },
        // Same id+baseUrl as incoming → should be removed
        { id: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' },
        // Different id, same baseUrl as incoming → should be preserved
        { id: 'gpt-3.5', baseUrl: 'https://api.openai.com/v1' },
      ],
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      modelProviders: [
        {
          authType: AuthType.USE_OPENAI,
          models: [{ id: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' }],
          mergeStrategy: 'prepend-and-remove-owned',
          // ownsModel intentionally omitted — exercises isSameModelIdentity path
        },
      ],
    };

    await applyProviderInstallPlan(plan, { settings: adapter });

    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      { id: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' },
      { id: 'gpt-4o', baseUrl: 'https://proxy-a.example/v1' },
      { id: 'gpt-3.5', baseUrl: 'https://api.openai.com/v1' },
    ]);
  });

  it('preserves existing custom provider models and selects the installed endpoint', async () => {
    const baseUrl = 'http://new.example/v1';
    const otherBaseUrl = 'http://192.168.100.100:8000/v1';
    const envKey = generateCustomEnvKey(AuthType.USE_OPENAI, baseUrl);
    const otherEnvKey = generateCustomEnvKey(AuthType.USE_OPENAI, otherBaseUrl);
    const syncAuthState = vi.fn();
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [
        // Same model id, different baseUrl: keep both and select the one just
        // installed.
        {
          id: 'model-b',
          name: 'model-b',
          baseUrl: otherBaseUrl,
          envKey: otherEnvKey,
        },
        { id: 'model-a', name: 'model-a', baseUrl, envKey },
        {
          id: 'shared-model',
          name: 'shared-model',
          baseUrl: otherBaseUrl,
          envKey: otherEnvKey,
        },
      ],
    });
    const plan = buildInstallPlan(customProvider, {
      protocol: AuthType.USE_OPENAI,
      baseUrl,
      apiKey: 'sk-new',
      modelIds: ['model-b'],
    });

    expect(plan.modelProviders?.[0]?.ownsModel).toBeUndefined();
    expect(plan.modelSelection).toEqual({ modelId: 'model-b', baseUrl });

    try {
      await applyProviderInstallPlan(plan, {
        settings: adapter,
        syncAuthState,
        doRefreshAuth: false,
      });
    } finally {
      delete process.env[envKey];
    }

    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      { id: 'model-b', name: 'model-b', baseUrl, envKey },
      {
        id: 'model-b',
        name: 'model-b',
        baseUrl: otherBaseUrl,
        envKey: otherEnvKey,
      },
      { id: 'model-a', name: 'model-a', baseUrl, envKey },
      {
        id: 'shared-model',
        name: 'shared-model',
        baseUrl: otherBaseUrl,
        envKey: otherEnvKey,
      },
    ]);
    expect(adapter.setValue).toHaveBeenCalledWith('model.name', 'model-b');
    expect(adapter.setValue).toHaveBeenCalledWith('model.baseUrl', baseUrl);
    expect(syncAuthState).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'model-b',
      baseUrl,
    );
  });

  it('writes provider state and legacy credentials', async () => {
    const adapter = createAdapter();
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      legacyCredentials: {
        apiKey: 'legacy-key',
        baseUrl: 'https://example.com/v1',
      },
      providerState: {
        codingPlan: {
          baseUrl: 'https://coding.example.com/v1',
          version: 'v1',
        },
      },
    };

    await applyProviderInstallPlan(plan, { settings: adapter });

    expect(adapter.setValue).toHaveBeenCalledWith(
      'security.auth.apiKey',
      'legacy-key',
    );
    expect(adapter.setValue).toHaveBeenCalledWith(
      'security.auth.baseUrl',
      'https://example.com/v1',
    );
    expect(adapter.setValue).toHaveBeenCalledWith(
      'codingPlan.baseUrl',
      'https://coding.example.com/v1',
    );
    expect(adapter.setValue).toHaveBeenCalledWith('codingPlan.version', 'v1');
  });

  it('appends models with append merge strategy', async () => {
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [
        { id: 'existing-1', envKey: 'A' },
        { id: 'existing-2', envKey: 'B' },
      ],
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      modelProviders: [
        {
          authType: AuthType.USE_OPENAI,
          models: [{ id: 'new-model', envKey: 'C' }],
          mergeStrategy: 'append',
        },
      ],
    };

    await applyProviderInstallPlan(plan, { settings: adapter });

    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      { id: 'existing-1', envKey: 'A' },
      { id: 'existing-2', envKey: 'B' },
      { id: 'new-model', envKey: 'C' },
    ]);
  });

  it('replaces owned models with replace-owned strategy (appends new at end)', async () => {
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [
        { id: 'owned-1', envKey: 'A' },
        { id: 'unrelated', envKey: 'B' },
        { id: 'owned-2', envKey: 'A' },
      ],
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      modelProviders: [
        {
          authType: AuthType.USE_OPENAI,
          models: [{ id: 'new-a', envKey: 'A' }],
          mergeStrategy: 'replace-owned',
          ownsModel: (model) => model.envKey === 'A',
        },
      ],
    };

    await applyProviderInstallPlan(plan, { settings: adapter });

    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      { id: 'unrelated', envKey: 'B' },
      { id: 'new-a', envKey: 'A' },
    ]);
  });

  it('rolls back process.env on error', async () => {
    process.env['TEST_API_KEY'] = 'old-value';
    const adapter = createAdapter();
    const refreshAuth = vi.fn(async () => {
      throw new Error('network error');
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { TEST_API_KEY: 'new-value' },
    };

    await expect(
      applyProviderInstallPlan(plan, { settings: adapter, refreshAuth }),
    ).rejects.toThrow('network error');

    expect(process.env['TEST_API_KEY']).toBe('old-value');
    expect(adapter.restore).toHaveBeenCalled();
  });

  it('deletes env var on rollback if it did not exist before', async () => {
    const adapter = createAdapter();
    const refreshAuth = vi.fn(async () => {
      throw new Error('fail');
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { BRAND_NEW_KEY: 'value' },
    };

    await expect(
      applyProviderInstallPlan(plan, { settings: adapter, refreshAuth }),
    ).rejects.toThrow('fail');

    expect(process.env['BRAND_NEW_KEY']).toBeUndefined();
  });

  // -- Rollback safety nets -------------------------------------------------
  // The catch path in applyProviderInstallPlan has three deliberate
  // safety nets that were previously untested. These tests pin them down so
  // a future refactor that "simplifies" the catch can't silently regress.

  it('restores runtime model providers when refreshAuth rejects after reloadModelProviders ran', async () => {
    const previousProviders = {
      [AuthType.USE_OPENAI]: [{ id: 'previous', envKey: 'OLD_KEY' }],
    };
    const adapter = createAdapter(previousProviders);
    const reloadModelProviders = vi.fn();
    const refreshAuth = vi.fn(async () => {
      throw new Error('refreshAuth rejected');
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { TEST_API_KEY: 'sk-new' },
      modelProviders: [
        {
          authType: AuthType.USE_OPENAI,
          models: [{ id: 'new-model', envKey: 'TEST_API_KEY' }],
          mergeStrategy: 'prepend-and-remove-owned',
          ownsModel: (model) => model.envKey === 'TEST_API_KEY',
        },
      ],
    };

    await expect(
      applyProviderInstallPlan(plan, {
        settings: adapter,
        reloadModelProviders,
        refreshAuth,
      }),
    ).rejects.toThrow('refreshAuth rejected');

    // Two reload calls: the success-path one with the patched providers,
    // then a rollback one that hands back the snapshot we took *before*
    // applying any patches.
    expect(reloadModelProviders).toHaveBeenCalledTimes(2);
    expect(reloadModelProviders).toHaveBeenLastCalledWith(previousProviders);
  });

  it('still rolls back env vars when backup() throws before persist', async () => {
    process.env['TEST_API_KEY'] = 'old-value';
    const adapter = createAdapter();
    adapter.backup.mockImplementation(() => {
      throw new Error('backup failed');
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { TEST_API_KEY: 'new-value' },
    };

    await expect(
      applyProviderInstallPlan(plan, { settings: adapter }),
    ).rejects.toThrow('backup failed');

    // backup() throwing inside the try must still hand control to the
    // catch path so env vars are restored. (Before this commit's
    // "backup inside try" fix the throw escaped uncaught and env vars
    // leaked.)
    expect(process.env['TEST_API_KEY']).toBe('old-value');
  });

  it('continues env rollback even when settings.restore itself throws', async () => {
    process.env['TEST_API_KEY'] = 'before-install';
    const adapter = createAdapter();
    adapter.restore.mockImplementation(() => {
      throw new Error('restore failed');
    });
    const refreshAuth = vi.fn(async () => {
      throw new Error('original error');
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { TEST_API_KEY: 'during-install' },
    };

    await expect(
      applyProviderInstallPlan(plan, { settings: adapter, refreshAuth }),
    ).rejects.toThrow('original error');

    // restore() throwing must not mask the original error and must not skip
    // the env-var rollback loop that runs after it.
    expect(adapter.restore).toHaveBeenCalled();
    expect(process.env['TEST_API_KEY']).toBe('before-install');
  });

  it('annotates the rethrown error with the failing step and preserves the original cause', async () => {
    process.env['TEST_API_KEY'] = 'old';
    const adapter = createAdapter();
    const refreshAuth = vi.fn(async () => {
      throw new Error('endpoint unreachable');
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { TEST_API_KEY: 'new' },
    };

    let caught: unknown;
    try {
      await applyProviderInstallPlan(plan, {
        settings: adapter,
        refreshAuth,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    // ProviderInstallError is a class, so instanceof works at runtime.
    expect(caught).toBeInstanceOf(ProviderInstallError);
    const err = caught as ProviderInstallError & { cause?: Error };
    // Step + authType are structured properties (not baked into the
    // user-facing message, which stays the underlying error text).
    expect(err.step).toBe('refreshAuth');
    expect(err.authType).toBe('openai');
    expect(err.message).toBe('endpoint unreachable');
    // Original error preserved via cause so callers matching on err.code
    // (NodeJS.ErrnoException) still work.
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toBe('endpoint unreachable');
  });

  it('continues throw + env rollback when reloadModelProviders rollback itself throws', async () => {
    process.env['TEST_API_KEY'] = 'before';
    const previousProviders = {
      [AuthType.USE_OPENAI]: [{ id: 'previous', envKey: 'OLD' }],
    };
    const adapter = createAdapter(previousProviders);
    let reloadCalls = 0;
    const reloadModelProviders = vi.fn(() => {
      reloadCalls += 1;
      if (reloadCalls === 2) {
        // The rollback-time reload (the second call) explodes.
        throw new Error('reload restore failed');
      }
    });
    const refreshAuth = vi.fn(async () => {
      throw new Error('original error');
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { TEST_API_KEY: 'during' },
    };

    await expect(
      applyProviderInstallPlan(plan, {
        settings: adapter,
        reloadModelProviders,
        refreshAuth,
      }),
    ).rejects.toThrow('original error');

    // The rethrow must still carry the original error, env vars must still
    // be rolled back, and the broken rollback reload must not mask anything.
    expect(reloadModelProviders).toHaveBeenCalledTimes(2);
    expect(process.env['TEST_API_KEY']).toBe('before');
  });

  it('rolls back settings, runtime providers, and env when cancelled during refresh', async () => {
    process.env['TEST_API_KEY'] = 'before-install';
    const previousProviders = {
      [AuthType.USE_OPENAI]: [{ id: 'previous', envKey: 'OLD_KEY' }],
    };
    const adapter = createAdapter(previousProviders);
    let persistedSettings: Record<string, unknown> = {
      'security.auth.selectedType': AuthType.USE_OPENAI,
    };
    let settingsBackup: Record<string, unknown> = {};
    adapter.backup.mockImplementation(() => {
      settingsBackup = structuredClone(persistedSettings);
    });
    adapter.setValue.mockImplementation((key: string, value: unknown) => {
      persistedSettings[key] = value;
    });
    adapter.restore.mockImplementation(() => {
      persistedSettings = settingsBackup;
    });
    const controller = new AbortController();
    let resolveRefresh!: () => void;
    let signalRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      signalRefreshStarted = resolve;
    });
    const refreshAuth = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
          signalRefreshStarted();
        }),
    );
    const reloadModelProviders = vi.fn();
    const rollbackRuntime = vi.fn(async () => undefined);
    const plan: ProviderInstallPlan = {
      providerId: 'copilot',
      authType: AuthType.USE_COPILOT,
      env: { TEST_API_KEY: 'copilot-install' },
      modelProviders: [
        {
          authType: AuthType.USE_OPENAI,
          models: [{ id: 'copilot-model', envKey: 'TEST_API_KEY' }],
          mergeStrategy: 'prepend-and-remove-owned',
        },
      ],
    };

    const install = applyProviderInstallPlan(plan, {
      settings: adapter,
      reloadModelProviders,
      refreshAuth,
      rollbackRuntime,
      signal: controller.signal,
    });
    await refreshStarted;
    controller.abort();
    resolveRefresh();

    await expect(install).rejects.toMatchObject({
      step: 'refreshAuth',
      authType: AuthType.USE_COPILOT,
    });
    expect(adapter.restore).toHaveBeenCalledTimes(1);
    expect(persistedSettings).toEqual({
      'security.auth.selectedType': AuthType.USE_OPENAI,
    });
    expect(process.env['TEST_API_KEY']).toBe('before-install');
    expect(reloadModelProviders).toHaveBeenLastCalledWith(previousProviders);
    expect(rollbackRuntime).toHaveBeenCalledTimes(1);
  });

  it('does not let a stale cancelled transaction roll back a newer install', async () => {
    const originalSettings = {
      env: { TEST_API_KEY: 'before-a' },
      security: { auth: { selectedType: AuthType.USE_OPENAI } },
      model: { name: 'original-model', baseUrl: 'https://original.example/v1' },
      modelProviders: {
        [AuthType.USE_OPENAI]: [
          { id: 'original-model', envKey: 'TEST_API_KEY' },
        ],
      },
    };
    let persistedSettings: Record<string, unknown> =
      structuredClone(originalSettings);
    let settingsBackup: Record<string, unknown> | undefined;
    const adapter = createAdapter();
    vi.mocked(adapter.getValue).mockImplementation((key: string) =>
      getNestedValue(persistedSettings, key),
    );
    vi.mocked(adapter.getModelProviders).mockImplementation(
      () =>
        (getNestedValue(persistedSettings, 'modelProviders') ??
          {}) as ModelProvidersConfig,
    );
    adapter.setValue.mockImplementation((key: string, value: unknown) => {
      setNestedValue(persistedSettings, key, value);
    });
    adapter.backup.mockImplementation(() => {
      settingsBackup = structuredClone(persistedSettings);
    });
    adapter.restore.mockImplementation(() => {
      persistedSettings = structuredClone(settingsBackup!);
    });
    const runtime = {
      authType: AuthType.USE_OPENAI,
      model: 'original-model',
      contentGenerator: 'original-generator',
    };
    let runtimeProviders: ModelProvidersConfig = structuredClone(
      originalSettings.modelProviders,
    );
    const reloadModelProviders = vi.fn((providers: ModelProvidersConfig) => {
      runtimeProviders = providers;
    });
    const syncAuthState = vi.fn((authType: AuthType, modelId: string) => {
      runtime.authType = authType;
      runtime.model = modelId;
    });
    const controllerA = new AbortController();
    let resolveRefreshA!: () => void;
    let signalRefreshAStarted!: () => void;
    const refreshAStarted = new Promise<void>((resolve) => {
      signalRefreshAStarted = resolve;
    });
    const refreshA = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefreshA = resolve;
          signalRefreshAStarted();
        }),
    );
    const rollbackRuntimeA = vi.fn(async () => {
      runtime.authType = AuthType.USE_OPENAI;
      runtime.model = 'original-model';
      runtime.contentGenerator = 'original-generator';
    });
    const planA: ProviderInstallPlan = {
      providerId: 'copilot-a',
      authType: AuthType.USE_COPILOT,
      env: { TEST_API_KEY: 'token-a' },
      modelSelection: { modelId: 'copilot-model-a' },
      modelProviders: [
        {
          authType: AuthType.USE_COPILOT,
          models: [{ id: 'copilot-model-a', envKey: 'TEST_API_KEY' }],
          mergeStrategy: 'prepend-and-remove-owned',
          ownsModel: () => true,
        },
      ],
    };
    const planB: ProviderInstallPlan = {
      providerId: 'copilot-b',
      authType: AuthType.USE_COPILOT,
      env: { TEST_API_KEY: 'token-b' },
      modelSelection: { modelId: 'copilot-model-b' },
      modelProviders: [
        {
          authType: AuthType.USE_COPILOT,
          models: [{ id: 'copilot-model-b', envKey: 'TEST_API_KEY' }],
          mergeStrategy: 'prepend-and-remove-owned',
          ownsModel: () => true,
        },
      ],
    };
    let currentTransaction: 'a' | 'b' = 'a';
    process.env['TEST_API_KEY'] = 'before-a';

    const installA = applyProviderInstallPlan(planA, {
      settings: adapter,
      signal: controllerA.signal,
      isCurrentTransaction: () => currentTransaction === 'a',
      reloadModelProviders,
      syncAuthState,
      refreshAuth: refreshA,
      rollbackRuntime: rollbackRuntimeA,
    });
    await refreshAStarted;
    controllerA.abort();
    currentTransaction = 'b';

    await applyProviderInstallPlan(planB, {
      settings: adapter,
      isCurrentTransaction: () => currentTransaction === 'b',
      reloadModelProviders,
      syncAuthState,
      refreshAuth: async () => {
        runtime.contentGenerator = 'copilot-generator-b';
      },
    });
    resolveRefreshA();

    await expect(installA).rejects.toMatchObject({
      step: 'refreshAuth',
      authType: AuthType.USE_COPILOT,
    });
    expect(persistedSettings).toMatchObject({
      env: { TEST_API_KEY: 'token-b' },
      security: { auth: { selectedType: AuthType.USE_COPILOT } },
      model: { name: 'copilot-model-b' },
      modelProviders: {
        [AuthType.USE_COPILOT]: [
          { id: 'copilot-model-b', envKey: 'TEST_API_KEY' },
        ],
      },
    });
    expect(process.env['TEST_API_KEY']).toBe('token-b');
    expect(runtimeProviders).toMatchObject({
      [AuthType.USE_COPILOT]: [
        { id: 'copilot-model-b', envKey: 'TEST_API_KEY' },
      ],
    });
    expect(runtime).toEqual({
      authType: AuthType.USE_COPILOT,
      model: 'copilot-model-b',
      contentGenerator: 'copilot-generator-b',
    });
    expect(rollbackRuntimeA).not.toHaveBeenCalled();
  });
});
