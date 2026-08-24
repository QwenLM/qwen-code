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
  buildProviderTemplate,
  buildInstallPlan,
  CODING_PLAN_CHINA_BASE_URL,
  CODING_PLAN_ENV_KEY,
  CODING_PLAN_GLOBAL_BASE_URL,
  codingPlanProvider,
  CUSTOM_API_KEY_ENV_PREFIX,
  customProvider,
  generateCustomEnvKey,
  legacyCustomEnvKey,
  legacyCustomEnvKey6Hex,
  KIMI_API_ENV_KEY,
  KIMI_CODE_BASE_URL,
  KIMI_CODE_ENV_KEY,
  kimiProvider,
  ProviderInstallError,
  type ProviderInstallPlan,
  type ProviderSettingsAdapter,
  TOKEN_PLAN_CHINA_BASE_URL,
  TOKEN_PLAN_ENV_KEY,
  TOKEN_PLAN_GLOBAL_BASE_URL,
  tokenPlanProvider,
  xiaomiMimoProvider,
} from '../index.js';

function createAdapter(modelProviders: ModelProvidersConfig = {}) {
  const adapter: ProviderSettingsAdapter & {
    getValue: ReturnType<typeof vi.fn>;
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

  it('replaces owned models at their existing position', async () => {
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [
        { id: 'region-a', envKey: 'A' },
        { id: 'old-region-b', envKey: 'B' },
        { id: 'tail', envKey: 'C' },
      ],
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      modelProviders: [
        {
          authType: AuthType.USE_OPENAI,
          models: [{ id: 'new-region-b', envKey: 'B' }],
          mergeStrategy: 'prepend-and-remove-owned',
          ownsModel: (model) => model.envKey === 'B',
        },
      ],
    };

    await applyProviderInstallPlan(plan, { settings: adapter });

    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      { id: 'region-a', envKey: 'A' },
      { id: 'new-region-b', envKey: 'B' },
      { id: 'tail', envKey: 'C' },
    ]);
  });

  it('normalizes baseUrl identity when ownsModel is omitted', async () => {
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [
        // Same id, different baseUrl → should be preserved (different identity)
        { id: 'gpt-4o', baseUrl: 'https://proxy-a.example/v1' },
        // Same normalized id+baseUrl as incoming → should be removed
        { id: 'gpt-4o', baseUrl: 'https://api.openai.com/v1/' },
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
      { id: 'gpt-4o', baseUrl: 'https://proxy-a.example/v1' },
      { id: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' },
      { id: 'gpt-3.5', baseUrl: 'https://api.openai.com/v1' },
    ]);
  });

  it('replaces only the selected Kimi endpoint when models are omitted', async () => {
    const apiUrl = 'https://api.moonshot.ai/v1';
    const apiModels = buildProviderTemplate(kimiProvider, apiUrl);
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [
        ...buildProviderTemplate(kimiProvider, KIMI_CODE_BASE_URL),
        {
          id: 'coding-custom',
          name: '[Kimi Code] coding-custom',
          baseUrl: KIMI_CODE_BASE_URL,
          envKey: KIMI_CODE_ENV_KEY,
        },
        ...apiModels,
      ],
    });
    const plan = buildInstallPlan(kimiProvider, {
      baseUrl: KIMI_CODE_BASE_URL,
      apiKey: 'not-persisted-by-this-test',
      modelIds: ['k3-256k'],
    });
    delete plan.env;

    await applyProviderInstallPlan(plan, { settings: adapter });

    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      expect.objectContaining({
        id: 'k3-256k',
        baseUrl: KIMI_CODE_BASE_URL,
      }),
      ...apiModels,
    ]);
  });

  it('keeps a same-envKey sibling endpoint untouched when resubmitting one region', async () => {
    // The two API regions share MOONSHOT_API_KEY, the name prefix, and
    // identical model lists; only the endpoint-scoped ownsModel clause keeps
    // resubmitting one region from rewriting or deleting the other's models.
    const chinaUrl = 'https://api.moonshot.cn/v1';
    const intlUrl = 'https://api.moonshot.ai/v1';
    const chinaModels = buildProviderTemplate(kimiProvider, chinaUrl);
    const intlModels = buildProviderTemplate(kimiProvider, intlUrl);
    const chinaCustom = {
      id: 'china-custom',
      name: '[Kimi API] china-custom',
      baseUrl: chinaUrl,
      envKey: KIMI_API_ENV_KEY,
    };
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [...chinaModels, chinaCustom, ...intlModels],
    });
    const plan = buildInstallPlan(kimiProvider, {
      baseUrl: intlUrl,
      apiKey: 'not-persisted-by-this-test',
      modelIds: intlModels.map((model) => model.id),
    });
    delete plan.env;

    await applyProviderInstallPlan(plan, { settings: adapter });

    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      ...chinaModels,
      chinaCustom,
      ...intlModels,
    ]);
  });

  it('selects the installed region when its credential replaces a sibling key', async () => {
    const chinaUrl = 'https://api.moonshot.cn/v1';
    const intlUrl = 'https://api.moonshot.ai/v1';
    const chinaModels = buildProviderTemplate(kimiProvider, chinaUrl);
    const intlModels = buildProviderTemplate(kimiProvider, intlUrl);
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [...chinaModels, ...intlModels],
    });
    adapter.getValue.mockImplementation((key: string) => {
      if (key === 'model.name') return 'kimi-k2.6';
      if (key === 'model.baseUrl') return chinaUrl;
      return '';
    });
    const plan = buildInstallPlan(kimiProvider, {
      baseUrl: intlUrl,
      apiKey: 'intl-key',
      modelIds: intlModels.map((model) => model.id),
    });

    try {
      await applyProviderInstallPlan(plan, {
        settings: adapter,
        doRefreshAuth: false,
      });
    } finally {
      delete process.env[KIMI_API_ENV_KEY];
    }

    expect(adapter.setValue).toHaveBeenCalledWith('model.name', 'kimi-k2.6');
    expect(adapter.setValue).toHaveBeenCalledWith('model.baseUrl', intlUrl);
  });

  it('keeps the active region when a shared persisted credential is unchanged', async () => {
    const chinaUrl = 'https://api.moonshot.cn/v1';
    const intlUrl = 'https://api.moonshot.ai/v1';
    const sharedKey = 'unchanged-shared-key';
    const chinaModels = buildProviderTemplate(kimiProvider, chinaUrl);
    const intlModels = buildProviderTemplate(kimiProvider, intlUrl);
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [...chinaModels, ...intlModels],
    });
    adapter.getValue.mockImplementation((key: string) => {
      if (key === `env.${KIMI_API_ENV_KEY}`) return sharedKey;
      if (key === 'model.name') return 'kimi-k3';
      if (key === 'model.baseUrl') return intlUrl;
      return '';
    });
    const plan = buildInstallPlan(kimiProvider, {
      baseUrl: chinaUrl,
      apiKey: sharedKey,
      modelIds: chinaModels.map((model) => model.id),
    });

    try {
      await applyProviderInstallPlan(plan, {
        settings: adapter,
        doRefreshAuth: false,
      });
    } finally {
      delete process.env[KIMI_API_ENV_KEY];
    }

    expect(adapter.setValue).not.toHaveBeenCalledWith(
      'model.name',
      expect.anything(),
    );
    expect(adapter.setValue).not.toHaveBeenCalledWith(
      'model.baseUrl',
      expect.anything(),
    );
  });

  it('selects the installed region for an id-only shared-key selection', async () => {
    const chinaUrl = 'https://api.moonshot.cn/v1';
    const intlUrl = 'https://api.moonshot.ai/v1';
    const chinaModels = buildProviderTemplate(kimiProvider, chinaUrl);
    const intlModels = buildProviderTemplate(kimiProvider, intlUrl);
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [...chinaModels, ...intlModels],
    });
    adapter.getValue.mockImplementation((key: string) => {
      if (key === 'model.name') return 'kimi-k2.7-code';
      if (key === 'model.baseUrl') return '';
      return '';
    });
    const plan = buildInstallPlan(kimiProvider, {
      baseUrl: intlUrl,
      apiKey: 'intl-key',
      modelIds: intlModels.map((model) => model.id),
    });

    try {
      await applyProviderInstallPlan(plan, {
        settings: adapter,
        doRefreshAuth: false,
      });
    } finally {
      delete process.env[KIMI_API_ENV_KEY];
    }

    expect(adapter.setValue).toHaveBeenCalledWith(
      'model.name',
      'kimi-k2.7-code',
    );
    expect(adapter.setValue).toHaveBeenCalledWith('model.baseUrl', intlUrl);
  });

  it('heals a current selection whose stored baseUrl differs only by a trailing slash (R41-6)', async () => {
    // The normalized identity match retains the user's model, but the
    // runtime registry keys models by EXACT (id, baseUrl): a slash-variant
    // selection would resolve to nothing (phantom duplicate in model lists,
    // switchModel "not found"). The install must rewrite the selection to
    // the offered entry's exact spelling.
    const intlUrl = 'https://api.moonshot.ai/v1';
    const intlModels = buildProviderTemplate(kimiProvider, intlUrl);
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: intlModels,
    });
    adapter.getValue.mockImplementation((key: string) => {
      if (key === 'model.name') return 'kimi-k2.7-code';
      if (key === 'model.baseUrl') return `${intlUrl}/`;
      return '';
    });
    const plan = buildInstallPlan(kimiProvider, {
      baseUrl: intlUrl,
      apiKey: 'not-persisted-by-this-test',
      modelIds: intlModels.map((model) => model.id),
    });
    delete plan.env;

    await applyProviderInstallPlan(plan, {
      settings: adapter,
      doRefreshAuth: false,
    });

    // The model is retained (same id) and its baseUrl is rewritten to the
    // entry's exact spelling so the exact-match registry resolves it.
    expect(adapter.setValue).toHaveBeenCalledWith(
      'model.name',
      'kimi-k2.7-code',
    );
    expect(adapter.setValue).toHaveBeenCalledWith('model.baseUrl', intlUrl);
    expect(adapter.setValue).not.toHaveBeenCalledWith(
      'model.baseUrl',
      `${intlUrl}/`,
    );
  });

  it('heals a slash-variant stored selection on a custom-provider reconnect (R41-6)', async () => {
    const baseUrl = 'https://my.proxy/v1';
    const envKey = generateCustomEnvKey(AuthType.USE_OPENAI, baseUrl);
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [{ id: 'm1', name: 'm1', baseUrl, envKey }],
    });
    adapter.getValue.mockImplementation((key: string) => {
      if (key === 'model.name') return 'm1';
      // Stored selection carries the trailing-slash variant.
      if (key === 'model.baseUrl') return `${baseUrl}/`;
      return '';
    });
    const plan = buildInstallPlan(customProvider, {
      protocol: AuthType.USE_OPENAI,
      baseUrl,
      apiKey: 'sk-proxy',
      modelIds: ['m1'],
    });

    try {
      await applyProviderInstallPlan(plan, {
        settings: adapter,
        doRefreshAuth: false,
      });
    } finally {
      delete process.env[envKey];
    }

    expect(adapter.setValue).toHaveBeenCalledWith('model.baseUrl', baseUrl);
    expect(adapter.setValue).not.toHaveBeenCalledWith(
      'model.baseUrl',
      `${baseUrl}/`,
    );
  });

  it('does not let another provider suppress a new provider selection', async () => {
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [
        {
          id: 'deepseek-chat',
          name: '[DeepSeek] deepseek-chat',
          baseUrl: 'https://api.deepseek.com',
          envKey: 'DEEPSEEK_API_KEY',
        },
      ],
    });
    adapter.getValue.mockImplementation((key: string) =>
      key === 'model.name' ? 'deepseek-chat' : '',
    );
    const plan = buildInstallPlan(kimiProvider, {
      baseUrl: KIMI_CODE_BASE_URL,
      apiKey: 'not-persisted-by-this-test',
      modelIds: ['k3-256k'],
    });
    delete plan.env;

    await applyProviderInstallPlan(plan, {
      settings: adapter,
      doRefreshAuth: false,
    });

    expect(adapter.setValue).toHaveBeenCalledWith('model.name', 'k3-256k');
    expect(adapter.setValue).toHaveBeenCalledWith(
      'model.baseUrl',
      KIMI_CODE_BASE_URL,
    );
  });

  it('switches an id-only selection when another provider owns the same id', async () => {
    const currentModelId = 'qwen3.7-plus';
    const codingModels = buildProviderTemplate(
      codingPlanProvider,
      CODING_PLAN_CHINA_BASE_URL,
    );
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: codingModels,
    });
    adapter.getValue.mockImplementation((key: string) =>
      key === 'model.name' ? currentModelId : '',
    );
    const plan = buildInstallPlan(tokenPlanProvider, {
      baseUrl: TOKEN_PLAN_CHINA_BASE_URL,
      apiKey: 'not-persisted-by-this-test',
      modelIds: [currentModelId],
    });
    delete plan.env;

    await applyProviderInstallPlan(plan, {
      settings: adapter,
      doRefreshAuth: false,
    });

    expect(adapter.setValue).not.toHaveBeenCalledWith(
      'model.name',
      expect.anything(),
    );
    expect(adapter.setValue).not.toHaveBeenCalledWith(
      'model.baseUrl',
      expect.anything(),
    );
    expect(adapter.setValue).toHaveBeenCalledWith(
      'modelProviders.openai',
      expect.arrayContaining([
        expect.objectContaining({
          id: currentModelId,
          baseUrl: TOKEN_PLAN_CHINA_BASE_URL,
          envKey: TOKEN_PLAN_ENV_KEY,
        }),
      ]),
    );
    const writtenModels = adapter.setValue.mock.calls.find(
      ([key]) => key === 'modelProviders.openai',
    )?.[1] as Array<{ id: string; baseUrl?: string; envKey?: string }>;
    expect(
      writtenModels.find((model) => model.id === currentModelId),
    ).toMatchObject({
      baseUrl: TOKEN_PLAN_CHINA_BASE_URL,
      envKey: TOKEN_PLAN_ENV_KEY,
    });
  });

  it('keeps an id-only selection when reinstalling a provider behind a duplicate', async () => {
    const currentModelId = 'kimi-k2.6';
    const kimiUrl = 'https://api.moonshot.ai/v1';
    const kimiModels = buildProviderTemplate(kimiProvider, kimiUrl);
    const tokenModels = buildProviderTemplate(
      tokenPlanProvider,
      TOKEN_PLAN_GLOBAL_BASE_URL,
    );
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [...kimiModels, ...tokenModels],
    });
    adapter.getValue.mockImplementation((key: string) => {
      if (key === 'model.name') return currentModelId;
      if (key === 'model.baseUrl') return '';
      return '';
    });
    const plan = buildInstallPlan(tokenPlanProvider, {
      baseUrl: TOKEN_PLAN_GLOBAL_BASE_URL,
      apiKey: 'rotated-token-plan-key',
      modelIds: tokenModels.map((model) => model.id),
    });

    await applyProviderInstallPlan(plan, {
      settings: adapter,
      doRefreshAuth: false,
    });

    expect(adapter.setValue).not.toHaveBeenCalledWith(
      'model.name',
      expect.anything(),
    );
    expect(adapter.setValue).not.toHaveBeenCalledWith(
      'model.baseUrl',
      expect.anything(),
    );
    const writtenModels = adapter.setValue.mock.calls.find(
      ([key]) => key === 'modelProviders.openai',
    )?.[1] as Array<{ id: string; envKey?: string }>;
    expect(
      writtenModels.find((model) => model.id === currentModelId),
    ).toMatchObject({ envKey: KIMI_API_ENV_KEY });
  });

  it('keeps id-only sibling endpoint resolution stable on first install', async () => {
    const chinaUrl = 'https://api.moonshot.cn/v1';
    const intlUrl = 'https://api.moonshot.ai/v1';
    const chinaModels = buildProviderTemplate(kimiProvider, chinaUrl);
    const intlModels = buildProviderTemplate(kimiProvider, intlUrl);
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: chinaModels,
    });
    adapter.getValue.mockImplementation((key: string) =>
      key === 'model.name' ? 'kimi-k3' : '',
    );
    const plan = buildInstallPlan(kimiProvider, {
      baseUrl: intlUrl,
      apiKey: 'not-persisted-by-this-test',
      modelIds: intlModels.map((model) => model.id),
    });
    delete plan.env;

    await applyProviderInstallPlan(plan, {
      settings: adapter,
      doRefreshAuth: false,
    });

    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      ...chinaModels,
      ...intlModels,
    ]);
    expect(adapter.setValue).not.toHaveBeenCalledWith(
      'model.name',
      expect.anything(),
    );
    expect(adapter.setValue).not.toHaveBeenCalledWith(
      'model.baseUrl',
      expect.anything(),
    );
  });

  it('keeps Xiaomi MiMo sibling endpoint models during install', async () => {
    const payGoUrl = 'https://api.xiaomimimo.com/v1';
    const tokenUrl = 'https://token-plan-cn.xiaomimimo.com/v1';
    const payGoModels = buildProviderTemplate(xiaomiMimoProvider, payGoUrl);
    const tokenModels = buildProviderTemplate(xiaomiMimoProvider, tokenUrl);
    const payGoCustom = {
      id: 'mimo-custom',
      name: '[Xiaomi MiMo] mimo-custom',
      baseUrl: payGoUrl,
      envKey: 'MIMO_API_KEY',
    };
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [...payGoModels, payGoCustom],
    });
    adapter.getValue.mockImplementation((key: string) => {
      if (key === 'model.name') return 'mimo-v2.5-pro';
      if (key === 'model.baseUrl') return payGoUrl;
      return '';
    });
    const plan = buildInstallPlan(xiaomiMimoProvider, {
      baseUrl: tokenUrl,
      apiKey: 'not-persisted-by-this-test',
      modelIds: tokenModels.map((model) => model.id),
    });
    delete plan.env;

    await applyProviderInstallPlan(plan, {
      settings: adapter,
      doRefreshAuth: false,
    });

    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      ...payGoModels,
      payGoCustom,
      ...tokenModels,
    ]);
    expect(adapter.setValue).not.toHaveBeenCalledWith(
      'model.name',
      expect.anything(),
    );
    expect(adapter.setValue).not.toHaveBeenCalledWith(
      'model.baseUrl',
      expect.anything(),
    );
  });

  it.each([
    {
      label: 'Coding Plan',
      provider: codingPlanProvider,
      selectedUrl: CODING_PLAN_CHINA_BASE_URL,
      siblingUrl: CODING_PLAN_GLOBAL_BASE_URL,
      envKey: CODING_PLAN_ENV_KEY,
    },
    {
      label: 'Token Plan',
      provider: tokenPlanProvider,
      selectedUrl: TOKEN_PLAN_CHINA_BASE_URL,
      siblingUrl: TOKEN_PLAN_GLOBAL_BASE_URL,
      envKey: TOKEN_PLAN_ENV_KEY,
    },
  ])(
    'keeps the $label sibling region untouched on resubmit',
    async ({ provider, selectedUrl, siblingUrl, envKey }) => {
      const selectedModels = buildProviderTemplate(provider, selectedUrl);
      const siblingModels = buildProviderTemplate(provider, siblingUrl);
      const siblingCustom = {
        id: 'sibling-custom',
        name: '[ModelStudio] sibling-custom',
        baseUrl: siblingUrl,
        envKey,
      };
      const adapter = createAdapter({
        [AuthType.USE_OPENAI]: [
          ...selectedModels,
          ...siblingModels,
          siblingCustom,
        ],
      });
      const plan = buildInstallPlan(provider, {
        baseUrl: selectedUrl,
        apiKey: 'not-persisted-by-this-test',
        modelIds: selectedModels.map((model) => model.id),
      });
      delete plan.env;

      await applyProviderInstallPlan(plan, { settings: adapter });

      expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
        ...selectedModels,
        ...siblingModels,
        siblingCustom,
      ]);
    },
  );

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

    expect(plan.modelProviders?.[0]?.ownsModel).toBeTypeOf('function');
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
      {
        id: 'model-b',
        name: 'model-b',
        baseUrl: otherBaseUrl,
        envKey: otherEnvKey,
      },
      { id: 'model-b', name: 'model-b', baseUrl, envKey },
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

  it('migrates a requested base-URL-less custom model without duplicating it', async () => {
    const baseUrl = 'https://new.example/v1';
    const siblingBaseUrl = 'https://sibling.example/v1';
    const envKey = generateCustomEnvKey(AuthType.USE_OPENAI, baseUrl);
    const siblingEnvKey = generateCustomEnvKey(
      AuthType.USE_OPENAI,
      siblingBaseUrl,
    );
    const legacyModel = {
      id: 'legacy-model',
      name: 'legacy-model',
      envKey,
      generationConfig: { contextWindowSize: 54321 },
    };
    const siblingModel = {
      id: 'legacy-model',
      name: 'legacy-model sibling',
      baseUrl: siblingBaseUrl,
      envKey: siblingEnvKey,
    };
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [legacyModel, siblingModel],
    });
    const plan = buildInstallPlan(customProvider, {
      protocol: AuthType.USE_OPENAI,
      baseUrl,
      apiKey: 'sk-new',
      modelIds: ['legacy-model'],
      preserveModels: [{ ...legacyModel, baseUrl }],
    });

    try {
      await applyProviderInstallPlan(plan, {
        settings: adapter,
        doRefreshAuth: false,
      });
    } finally {
      delete process.env[envKey];
    }

    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      {
        ...legacyModel,
        baseUrl,
      },
      siblingModel,
    ]);
  });

  it('removes omitted custom models only from the selected endpoint', async () => {
    const baseUrl = 'https://custom.example/v1';
    const siblingBaseUrl = 'https://sibling.example/v1';
    const envKey = generateCustomEnvKey(AuthType.USE_OPENAI, baseUrl);
    const siblingEnvKey = generateCustomEnvKey(
      AuthType.USE_OPENAI,
      siblingBaseUrl,
    );
    const siblingModel = {
      id: 'm',
      name: 'm',
      baseUrl: siblingBaseUrl,
      envKey: siblingEnvKey,
    };
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [
        { id: 'm', name: 'm', baseUrl, envKey },
        { id: 'm', name: 'm', baseUrl: `${baseUrl}/`, envKey },
        siblingModel,
      ],
    });
    const plan = buildInstallPlan(customProvider, {
      protocol: AuthType.USE_OPENAI,
      baseUrl,
      apiKey: 'sk-new',
      modelIds: ['other-model'],
    });

    try {
      await applyProviderInstallPlan(plan, {
        settings: adapter,
        doRefreshAuth: false,
      });
    } finally {
      delete process.env[envKey];
    }

    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      {
        id: 'other-model',
        name: 'other-model',
        baseUrl,
        envKey,
      },
      siblingModel,
    ]);
  });

  it('removes a deselected baseUrl-less legacy custom model', async () => {
    const baseUrl = 'https://new.example/v1';
    const envKey = generateCustomEnvKey(AuthType.USE_OPENAI, baseUrl);
    // Legacy entry predating baseUrl stamping: no baseUrl, but its stored env
    // key already names this endpoint. Ownership of a baseUrl-less entry
    // follows its endpoint key (R38-3), so a deselection at the entry's own
    // endpoint must remove it like any other omitted entry.
    const legacyModel = {
      id: 'legacy-custom',
      name: 'legacy-custom',
      envKey,
    };
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [legacyModel],
    });
    // The wizard seeds legacy-custom, the user deselects it and submits only
    // my-model — the omitted baseUrl-less entry must be removed like any
    // other omitted entry.
    const plan = buildInstallPlan(customProvider, {
      protocol: AuthType.USE_OPENAI,
      baseUrl,
      apiKey: 'sk-new',
      modelIds: ['my-model'],
    });

    try {
      await applyProviderInstallPlan(plan, {
        settings: adapter,
        doRefreshAuth: false,
      });
    } finally {
      delete process.env[envKey];
    }

    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      {
        id: 'my-model',
        name: 'my-model',
        baseUrl,
        envKey,
      },
    ]);
  });

  it("keeps another endpoint's baseUrl-less legacy model when connecting a sibling endpoint", async () => {
    const aBaseUrl = 'https://a.example/v1';
    const bBaseUrl = 'https://b.example/v1';
    const aEnvKey = generateCustomEnvKey(AuthType.USE_OPENAI, aBaseUrl);
    const bEnvKey = generateCustomEnvKey(AuthType.USE_OPENAI, bBaseUrl);
    // Endpoint A's legacy entry predates baseUrl stamping: no baseUrl and an
    // old-shape env key that is not endpoint B's key. Connecting endpoint B
    // must neither delete nor rewrite it (R38-3).
    const legacyModel = {
      id: 'legacy-model',
      name: 'legacy-model',
      envKey: `${CUSTOM_API_KEY_ENV_PREFIX}OPENAI`,
      generationConfig: { contextWindowSize: 54321 },
    };
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [
        { id: 'a-model', name: 'a-model', baseUrl: aBaseUrl, envKey: aEnvKey },
        legacyModel,
        { id: 'b-model', name: 'b-model', baseUrl: bBaseUrl, envKey: bEnvKey },
      ],
    });
    const plan = buildInstallPlan(customProvider, {
      protocol: AuthType.USE_OPENAI,
      baseUrl: bBaseUrl,
      apiKey: 'sk-new',
      modelIds: ['b-model'],
    });

    try {
      await applyProviderInstallPlan(plan, {
        settings: adapter,
        doRefreshAuth: false,
      });
    } finally {
      delete process.env[bEnvKey];
    }

    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      { id: 'a-model', name: 'a-model', baseUrl: aBaseUrl, envKey: aEnvKey },
      legacyModel,
      { id: 'b-model', name: 'b-model', baseUrl: bBaseUrl, envKey: bEnvKey },
    ]);
  });

  it('replaces an attributable baseUrl-less legacy model when its id is requested at its endpoint', async () => {
    const bBaseUrl = 'https://b.example/v1';
    const bEnvKey = generateCustomEnvKey(AuthType.USE_OPENAI, bBaseUrl);
    // The entry's key is endpoint B's 6-hex-suffix shape (hash-bearing, so
    // unambiguous), making the entry attributable to B: requesting its id at
    // B replaces it. (The suffix-less shape is NOT attributable — it is
    // lossy and cannot rule out a colliding endpoint, so it fails closed and
    // survives; see the R40-3 tests.)
    const legacyModel = {
      id: 'legacy-model',
      name: 'legacy-model',
      envKey: legacyCustomEnvKey6Hex(AuthType.USE_OPENAI, bBaseUrl),
      generationConfig: { contextWindowSize: 54321 },
    };
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [legacyModel],
    });
    // The submitted id list is authoritative: requesting the legacy id at
    // this endpoint regenerates it here instead of leaving a duplicate
    // baseUrl-less copy behind.
    const plan = buildInstallPlan(customProvider, {
      protocol: AuthType.USE_OPENAI,
      baseUrl: bBaseUrl,
      apiKey: 'sk-new',
      modelIds: ['legacy-model'],
    });

    try {
      await applyProviderInstallPlan(plan, {
        settings: adapter,
        doRefreshAuth: false,
      });
    } finally {
      delete process.env[bEnvKey];
    }

    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      {
        id: 'legacy-model',
        name: 'legacy-model',
        baseUrl: bBaseUrl,
        envKey: bEnvKey,
      },
    ]);
  });

  it("keeps a sibling endpoint's baseUrl-less legacy model whose id collides with a planned model (R39-2)", async () => {
    const aBaseUrl = 'https://a.example/v1';
    const bBaseUrl = 'https://b.example/v1';
    const aEnvKey = generateCustomEnvKey(AuthType.USE_OPENAI, aBaseUrl);
    // The legacy entry carries endpoint B's key (original suffix-less shape)
    // — no baseUrl. Connecting A with a planned model whose id collides with
    // it must not claim it: ownership follows the entry's endpoint key, not
    // id collisions.
    const legacyModel = {
      id: 'gpt-4o',
      name: 'gpt-4o',
      envKey: legacyCustomEnvKey(AuthType.USE_OPENAI, bBaseUrl),
      generationConfig: { contextWindowSize: 54321 },
    };
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [legacyModel],
    });
    const plan = buildInstallPlan(customProvider, {
      protocol: AuthType.USE_OPENAI,
      baseUrl: aBaseUrl,
      apiKey: 'sk-new',
      modelIds: ['gpt-4o'],
    });

    try {
      await applyProviderInstallPlan(plan, {
        settings: adapter,
        doRefreshAuth: false,
      });
    } finally {
      delete process.env[aEnvKey];
    }

    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      { id: 'gpt-4o', name: 'gpt-4o', baseUrl: aBaseUrl, envKey: aEnvKey },
      legacyModel,
    ]);
  });

  it('removes a deselected baseUrl-less legacy model under the hash-bearing historical key shape, and keeps the ambiguous suffix-less shape (R39-3, R40-3)', async () => {
    const baseUrl = 'https://new.example/v1';
    const envKey = generateCustomEnvKey(AuthType.USE_OPENAI, baseUrl);
    // The 6-hex-suffix shape carries the endpoint hash, so it attributes the
    // entry unambiguously and a deselection at its own endpoint removes it.
    // The suffix-less shape is lossy — it cannot rule out a structurally
    // different endpoint whose URL normalizes identically — so attribution
    // fails closed and the entry survives every connect like the R39-3
    // boundary keys (R40-3).
    const originalShape = {
      id: 'legacy-original',
      name: 'legacy-original',
      envKey: legacyCustomEnvKey(AuthType.USE_OPENAI, baseUrl),
      generationConfig: { contextWindowSize: 11111 },
    };
    const sixHexShape = {
      id: 'legacy-sixhex',
      name: 'legacy-sixhex',
      envKey: legacyCustomEnvKey6Hex(AuthType.USE_OPENAI, baseUrl),
      generationConfig: { contextWindowSize: 22222 },
    };
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [originalShape, sixHexShape],
    });
    // The wizard seeds both, the user deselects them and submits only
    // my-model.
    const plan = buildInstallPlan(customProvider, {
      protocol: AuthType.USE_OPENAI,
      baseUrl,
      apiKey: 'sk-new',
      modelIds: ['my-model'],
    });

    try {
      await applyProviderInstallPlan(plan, {
        settings: adapter,
        doRefreshAuth: false,
      });
    } finally {
      delete process.env[envKey];
    }

    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      originalShape,
      { id: 'my-model', name: 'my-model', baseUrl, envKey },
    ]);
  });

  it('keeps a suffix-less legacy model when connecting an endpoint whose URL normalizes identically (R40-3)', async () => {
    const legacyBaseUrl = 'https://api.example.com/v1';
    const collidingBaseUrl = 'https://api-example.com/v1';
    const legacyKey = legacyCustomEnvKey(AuthType.USE_OPENAI, legacyBaseUrl);
    // Sanity: normalizeEnvSegment collapses '.' and '-' to the same '_', so
    // the two structurally different endpoints share one readable segment —
    // the suffix-less key cannot tell them apart.
    expect(legacyCustomEnvKey(AuthType.USE_OPENAI, collidingBaseUrl)).toBe(
      legacyKey,
    );
    // A user holds a suffix-less legacy entry generated for
    // https://api.example.com/v1. Connecting the DIFFERENT endpoint
    // https://api-example.com/v1 must not own that entry: attribution fails
    // closed on the ambiguous shape, so the entry survives the connect.
    const legacyModel = {
      id: 'm',
      name: 'm',
      envKey: legacyKey,
      generationConfig: { contextWindowSize: 12345 },
    };
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [legacyModel],
    });
    const envKey = generateCustomEnvKey(AuthType.USE_OPENAI, collidingBaseUrl);
    const plan = buildInstallPlan(customProvider, {
      protocol: AuthType.USE_OPENAI,
      baseUrl: collidingBaseUrl,
      apiKey: 'sk-new',
      modelIds: ['other'],
    });

    try {
      await applyProviderInstallPlan(plan, {
        settings: adapter,
        doRefreshAuth: false,
      });
    } finally {
      delete process.env[envKey];
    }

    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      { id: 'other', name: 'other', baseUrl: collidingBaseUrl, envKey },
      legacyModel,
    ]);
  });

  it('keeps a baseUrl-less legacy model whose env key names no endpoint (R39-3 boundary)', async () => {
    const baseUrl = 'https://new.example/v1';
    const envKey = generateCustomEnvKey(AuthType.USE_OPENAI, baseUrl);
    // A hand-written entry whose env key matches no endpoint's key in any
    // historical shape cannot be attributed to the selected endpoint. It
    // survives every connect — the pre-this-PR safe direction — instead of
    // being deleted on an unattributable deselection.
    const legacyModel = {
      id: 'legacy-custom',
      name: 'legacy-custom',
      envKey: `${CUSTOM_API_KEY_ENV_PREFIX}OPENAI`,
      generationConfig: { contextWindowSize: 54321 },
    };
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [legacyModel],
    });
    const plan = buildInstallPlan(customProvider, {
      protocol: AuthType.USE_OPENAI,
      baseUrl,
      apiKey: 'sk-new',
      modelIds: ['my-model'],
    });

    try {
      await applyProviderInstallPlan(plan, {
        settings: adapter,
        doRefreshAuth: false,
      });
    } finally {
      delete process.env[envKey];
    }

    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      { id: 'my-model', name: 'my-model', baseUrl, envKey },
      legacyModel,
    ]);
  });

  it('keeps every baseUrl-less legacy entry when a free-form install resolves an empty baseUrl (R44-1)', async () => {
    // A free-form install whose resolved baseUrl is '' (a serve request with a
    // missing baseUrl resolves to '') must not let the endpoint-match clause
    // claim every baseUrl-less legacy entry: normalizeBaseUrlForMatching of a
    // baseUrl-less entry is '', and '' === selectedEndpoint ('') would claim
    // them all — sibling-endpoint entries, fail-closed suffix-less keys, and
    // floating keys alike — short-circuiting the attribution guard (R44-1).
    const siblingBaseUrl = 'https://sib.example/v1';
    const siblingEntry = {
      id: 'sib-model',
      name: 'sib-model',
      envKey: generateCustomEnvKey(AuthType.USE_OPENAI, siblingBaseUrl),
    };
    const suffixlessEntry = {
      id: 'sfx-model',
      name: 'sfx-model',
      envKey: legacyCustomEnvKey(
        AuthType.USE_OPENAI,
        'https://other.example/v1',
      ),
    };
    const floatingEntry = {
      id: 'flt-model',
      name: 'flt-model',
      envKey: `${CUSTOM_API_KEY_ENV_PREFIX}OPENAI`,
    };
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [siblingEntry, suffixlessEntry, floatingEntry],
    });
    const emptyEnvKey = generateCustomEnvKey(AuthType.USE_OPENAI, '');
    const plan = buildInstallPlan(customProvider, {
      protocol: AuthType.USE_OPENAI,
      baseUrl: '',
      apiKey: 'sk-new',
      modelIds: ['my-model'],
    });

    try {
      await applyProviderInstallPlan(plan, {
        settings: adapter,
        doRefreshAuth: false,
      });
    } finally {
      delete process.env[emptyEnvKey];
    }

    const written = adapter.setValue.mock.calls.find(
      (call: unknown[]) => call[0] === 'modelProviders.openai',
    )?.[1] as Array<Record<string, unknown>> | undefined;
    expect(written).toBeDefined();
    expect(written).toContainEqual(
      expect.objectContaining({ id: 'sib-model' }),
    );
    expect(written).toContainEqual(
      expect.objectContaining({ id: 'sfx-model' }),
    );
    expect(written).toContainEqual(
      expect.objectContaining({ id: 'flt-model' }),
    );
  });

  it('keeps a floating baseUrl-less entry whose id collides with a migrated entry (R44-3)', async () => {
    const e1BaseUrl = 'https://e1.example/v1';
    const e1EnvKey = generateCustomEnvKey(AuthType.USE_OPENAI, e1BaseUrl);
    const floatingKey = `${CUSTOM_API_KEY_ENV_PREFIX}OPENAI`;
    // X is attributable to E1 (its 12-hex key); F is a floating prefix-only
    // key that names NO endpoint. Both share the id 'my-model'. Migrating X
    // emits that id, but the id-collision claim must not reach F: the only
    // defense F has is that its key names no endpoint, so the claim must be
    // gated on attribution — namesSiblingEndpoint does not protect F (R44-3).
    const attributableX = {
      id: 'my-model',
      name: 'my-model',
      envKey: e1EnvKey,
    };
    const floatingF = {
      id: 'my-model',
      name: 'my-model',
      envKey: floatingKey,
    };
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [attributableX, floatingF],
    });
    const plan = buildInstallPlan(customProvider, {
      protocol: AuthType.USE_OPENAI,
      baseUrl: e1BaseUrl,
      apiKey: 'sk-new',
      modelIds: ['my-model'],
      migratedLegacyModelIds: ['my-model'],
    });

    try {
      await applyProviderInstallPlan(plan, {
        settings: adapter,
        doRefreshAuth: false,
      });
    } finally {
      delete process.env[e1EnvKey];
    }

    const written = adapter.setValue.mock.calls.find(
      (call: unknown[]) => call[0] === 'modelProviders.openai',
    )?.[1] as Array<Record<string, unknown>> | undefined;
    expect(written).toBeDefined();
    // The attributable X collapses into the planned my-model@E1...
    expect(written).toContainEqual(
      expect.objectContaining({ id: 'my-model', baseUrl: e1BaseUrl }),
    );
    // ...while the floating F survives (never migrated, names no endpoint).
    expect(written).toContainEqual(
      expect.objectContaining({ id: 'my-model', envKey: floatingKey }),
    );
  });

  it('claims an explicitly adopted floating baseUrl-less entry via adoptedFloatingModelIds (R45-2)', async () => {
    const e1BaseUrl = 'https://e1.example/v1';
    const e1EnvKey = generateCustomEnvKey(AuthType.USE_OPENAI, e1BaseUrl);
    const floatingKey = `${CUSTOM_API_KEY_ENV_PREFIX}OPENAI`;
    // F is a floating prefix-only key naming NO endpoint. An explicit
    // selection adopts it (stamps it at E1); because a floating key can never
    // satisfy the id-collision claim's namesSelectedEndpoint gate, the caller
    // threads it through adoptedFloatingModelIds so the stored original is
    // claimed and the pair collapses to ONE entry instead of a permanent
    // duplicate (R45-2).
    const floatingF = {
      id: 'floaty',
      name: 'floaty',
      envKey: floatingKey,
    };
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [floatingF],
    });
    const plan = buildInstallPlan(customProvider, {
      protocol: AuthType.USE_OPENAI,
      baseUrl: e1BaseUrl,
      apiKey: 'sk-new',
      modelIds: ['floaty'],
      adoptedFloatingModelIds: ['floaty'],
    });

    try {
      await applyProviderInstallPlan(plan, {
        settings: adapter,
        doRefreshAuth: false,
      });
    } finally {
      delete process.env[e1EnvKey];
    }

    const written = adapter.setValue.mock.calls.find(
      (call: unknown[]) => call[0] === 'modelProviders.openai',
    )?.[1] as Array<Record<string, unknown>> | undefined;
    expect(written).toBeDefined();
    // Exactly ONE floaty survives — the stamped copy at E1. The floating
    // original was claimed, so no permanent duplicate pair.
    const floatyEntries = (written ?? []).filter(
      (model) => model['id'] === 'floaty',
    );
    expect(floatyEntries).toHaveLength(1);
    expect(floatyEntries[0]).toEqual(
      expect.objectContaining({ id: 'floaty', baseUrl: e1BaseUrl }),
    );
  });

  it('does NOT claim a floating entry passed only via migratedLegacyModelIds (R45-2 guard)', async () => {
    const e1BaseUrl = 'https://e1.example/v1';
    const e1EnvKey = generateCustomEnvKey(AuthType.USE_OPENAI, e1BaseUrl);
    const floatingKey = `${CUSTOM_API_KEY_ENV_PREFIX}OPENAI`;
    // A floating entry whose id rides in migratedLegacyModelIds — but was not
    // adopted through the dedicated channel — must NOT be claimed; the
    // attribution gate stays the over-claim defense (R44-3 kept intact).
    const floatingF = {
      id: 'floaty',
      name: 'floaty',
      envKey: floatingKey,
    };
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [floatingF],
    });
    const plan = buildInstallPlan(customProvider, {
      protocol: AuthType.USE_OPENAI,
      baseUrl: e1BaseUrl,
      apiKey: 'sk-new',
      modelIds: ['other-model'],
      migratedLegacyModelIds: ['floaty'],
    });

    try {
      await applyProviderInstallPlan(plan, {
        settings: adapter,
        doRefreshAuth: false,
      });
    } finally {
      delete process.env[e1EnvKey];
    }

    const written = adapter.setValue.mock.calls.find(
      (call: unknown[]) => call[0] === 'modelProviders.openai',
    )?.[1] as Array<Record<string, unknown>> | undefined;
    expect(written).toBeDefined();
    // The floating original survives (unclaimed).
    expect(written).toContainEqual(
      expect.objectContaining({ id: 'floaty', envKey: floatingKey }),
    );
  });

  it('protects an unexposed attributable baseUrl-less entry via roundTrippedLegacyModelIds (R44-4)', async () => {
    const bBaseUrl = 'https://b.example/v1';
    const bEnvKey = generateCustomEnvKey(AuthType.USE_OPENAI, bBaseUrl);
    // An attributable baseUrl-less entry the caller never exposed (its id is
    // in neither modelIds nor roundTrippedLegacyModelIds) must not be claimed
    // by the env-key clause: absence is not deselection when the entry was
    // never surfaced (R44-4).
    const hiddenEntry = {
      id: 'my-model',
      name: 'my-model',
      envKey: bEnvKey,
    };
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [hiddenEntry],
    });
    const plan = buildInstallPlan(customProvider, {
      protocol: AuthType.USE_OPENAI,
      baseUrl: bBaseUrl,
      apiKey: 'sk-new',
      modelIds: ['my-new-model'],
      roundTrippedLegacyModelIds: [],
    });

    try {
      await applyProviderInstallPlan(plan, {
        settings: adapter,
        doRefreshAuth: false,
      });
    } finally {
      delete process.env[bEnvKey];
    }

    const written = adapter.setValue.mock.calls.find(
      (call: unknown[]) => call[0] === 'modelProviders.openai',
    )?.[1] as Array<Record<string, unknown>> | undefined;
    expect(written).toBeDefined();
    expect(written).toContainEqual(
      expect.objectContaining({ id: 'my-model', envKey: bEnvKey }),
    );
  });

  it('still removes an exposed attributable entry deselected via roundTrippedLegacyModelIds (R44-4)', async () => {
    const bBaseUrl = 'https://b.example/v1';
    const bEnvKey = generateCustomEnvKey(AuthType.USE_OPENAI, bBaseUrl);
    // The round-trip gate must not over-protect: an entry the caller surfaced
    // (id present in roundTrippedLegacyModelIds) and then deselected is still
    // removed by the env-key clause.
    const exposedEntry = {
      id: 'legacy-custom',
      name: 'legacy-custom',
      envKey: bEnvKey,
    };
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [exposedEntry],
    });
    const plan = buildInstallPlan(customProvider, {
      protocol: AuthType.USE_OPENAI,
      baseUrl: bBaseUrl,
      apiKey: 'sk-new',
      modelIds: ['my-model'],
      roundTrippedLegacyModelIds: ['legacy-custom'],
    });

    try {
      await applyProviderInstallPlan(plan, {
        settings: adapter,
        doRefreshAuth: false,
      });
    } finally {
      delete process.env[bEnvKey];
    }

    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      { id: 'my-model', name: 'my-model', baseUrl: bBaseUrl, envKey: bEnvKey },
    ]);
  });

  it('keeps the selected sibling endpoint model when reconnecting', async () => {
    const codingModels = buildProviderTemplate(
      kimiProvider,
      KIMI_CODE_BASE_URL,
    );
    const apiBaseUrl = 'https://api.moonshot.ai/v1';
    const apiModels = buildProviderTemplate(kimiProvider, apiBaseUrl);
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [...codingModels, ...apiModels],
    });
    adapter.getValue.mockImplementation((key: string) => {
      if (key === 'model.name') return 'kimi-k3';
      if (key === 'model.baseUrl') return apiBaseUrl;
      return undefined;
    });
    const syncAuthState = vi.fn();
    const plan = buildInstallPlan(kimiProvider, {
      baseUrl: KIMI_CODE_BASE_URL,
      apiKey: 'sk-kimi',
      modelIds: codingModels.map((model) => model.id),
    });

    try {
      await applyProviderInstallPlan(plan, {
        settings: adapter,
        syncAuthState,
        doRefreshAuth: false,
      });
    } finally {
      delete process.env[KIMI_CODE_ENV_KEY];
    }

    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      ...codingModels,
      ...apiModels,
    ]);
    expect(adapter.setValue).not.toHaveBeenCalledWith(
      'model.name',
      expect.anything(),
    );
    expect(adapter.setValue).not.toHaveBeenCalledWith(
      'model.baseUrl',
      expect.anything(),
    );
    expect(syncAuthState).not.toHaveBeenCalled();
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
});
