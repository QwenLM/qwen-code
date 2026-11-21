/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AuthType } from '@qwen-code/resource';
import type { Settings } from '@qwen-code/resource';
import type { SettingsService } from '@qwen-code/resource';
import {
  AuthType as CoreAuthType,
  QODER_ENV_ACCOUNT_REGION,
  setDefaultAuthType,
  type ModelTransportManager,
} from '@qwen-code/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPublicProviders } from './resourceInitialization.js';
import { loadCliConfig, type CliArgs } from '../config/config.js';
import type { LoadedSettings } from '../config/settings.js';
import {
  loadEnvironment,
  restoreLoadedEnvironment,
  runWithEffectiveSettingSources,
  setDefaultSettingSourcesForProcess,
} from '../config/settings.js';
import {
  createQoderProviders,
  isQoderAccountConfigured,
} from '../auth/qoderProviders.js';
import { createQwenSubscriptionProviders } from '../auth/subscriptionProviders.js';

vi.mock('../auth/qoderProviders.js', () => ({
  createQoderProviders: vi.fn(() => [{ providerId: 'qoder' }]),
  isQoderAccountConfigured: vi.fn(() => false),
  resolveConfiguredQoderRegion: vi.fn(() => 'global'),
}));

vi.mock('../auth/subscriptionProviders.js', () => ({
  createQwenSubscriptionProviders: vi.fn(() => []),
}));

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    // The real Config invokes this factory synchronously in its constructor.
    Config: class {
      constructor(
        private readonly params: ConstructorParameters<typeof actual.Config>[0],
      ) {
        params.modelProviderFactory?.({} as never, 'disabled');
      }
      getModelProviderFactory() {
        return this.params.modelProviderFactory;
      }
      setSettingsContentValidator() {}
    },
  };
});

const settings = {
  peekUserSettingsSource: () => ({ read: () => undefined }),
} as unknown as SettingsService;
const transports = {} as ModelTransportManager;

describe('createPublicProviders', () => {
  beforeEach(() => {
    vi.mocked(createQoderProviders).mockClear();
    vi.mocked(createQwenSubscriptionProviders).mockClear();
    vi.mocked(createQwenSubscriptionProviders).mockReturnValue([]);
    vi.mocked(isQoderAccountConfigured).mockReset().mockReturnValue(false);
    setDefaultAuthType(CoreAuthType.QODER_BROWSER);
  });

  afterEach(() => {
    setDefaultAuthType(CoreAuthType.QODER_BROWSER);
    setDefaultSettingSourcesForProcess(undefined);
  });

  it('adds the Qoder OAuth provider only for qoder-oauth', () => {
    const providers = createPublicProviders(
      settings,
      transports,
      AuthType.QODER_OAUTH,
    );

    expect(createQoderProviders).toHaveBeenCalledTimes(1);
    expect(providers.map((provider) => provider.providerId)).toContain('qoder');
  });

  it('does not construct the Qoder OAuth provider for other Qoder auth types', () => {
    const providers = createPublicProviders(
      settings,
      transports,
      AuthType.QODER_BROWSER,
    );

    expect(createQoderProviders).not.toHaveBeenCalled();
    expect(providers.map((provider) => provider.providerId)).not.toContain(
      'qoder',
    );
  });

  it('follows the product default when no type is selected', () => {
    setDefaultAuthType(CoreAuthType.QODER_OAUTH);

    const providers = createPublicProviders(settings, transports);

    expect(createQoderProviders).toHaveBeenCalledTimes(1);
    expect(providers.map((provider) => provider.providerId)).toContain('qoder');
  });

  it('adds the Qwen subscription provider when the account is signed in', () => {
    vi.mocked(createQwenSubscriptionProviders).mockReturnValue([
      { providerId: 'qwen-subscription' } as never,
    ]);

    const providers = createPublicProviders(settings, transports);

    expect(createQwenSubscriptionProviders).toHaveBeenCalledWith(
      settings,
      transports,
    );
    expect(providers.map((provider) => provider.providerId)).toContain(
      'qwen-subscription',
    );
  });

  it('keeps the built-in default when no type is selected', () => {
    createPublicProviders(settings, transports);

    expect(createQoderProviders).not.toHaveBeenCalled();
  });

  it('adds the Qoder provider for an existing account under another auth type', () => {
    setDefaultAuthType(CoreAuthType.QODER_OAUTH);
    vi.mocked(isQoderAccountConfigured).mockReturnValue(true);

    const providers = createPublicProviders(
      settings,
      transports,
      AuthType.USE_OPENAI,
    );

    expect(createQoderProviders).toHaveBeenCalledTimes(1);
    expect(providers.map((provider) => provider.providerId)).toContain('qoder');
  });

  it('passes the saved qoder region to provider composition', () => {
    setDefaultAuthType(CoreAuthType.QODER_OAUTH);

    createPublicProviders(settings, transports, undefined, 'cn');

    expect(createQoderProviders).toHaveBeenCalledWith(
      settings,
      transports,
      'cn',
    );
  });

  it('lets QWEN_QODER_REGION override the saved region', () => {
    setDefaultAuthType(CoreAuthType.QODER_OAUTH);
    vi.stubEnv(QODER_ENV_ACCOUNT_REGION, 'global');

    try {
      createPublicProviders(settings, transports, undefined, 'cn');

      expect(createQoderProviders).toHaveBeenCalledWith(
        settings,
        transports,
        'global',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('ignores existing accounts when the default is not qoder-oauth', () => {
    vi.mocked(isQoderAccountConfigured).mockReturnValue(true);

    const providers = createPublicProviders(
      settings,
      transports,
      AuthType.USE_OPENAI,
    );

    expect(createQoderProviders).not.toHaveBeenCalled();
    expect(providers.map((provider) => provider.providerId)).not.toContain(
      'qoder',
    );
  });

  it('lists the resolved user provider without admitting an unresolved sibling', async () => {
    const userSettings = {
      peekUserSettingsSource: () => ({
        read: () =>
          JSON.stringify({
            providers: {
              gw: {
                baseUrl: 'https://gw.example/v1',
                apiKey: '${QWEN_FRAMEWORK_TEST_KEY}',
                model: 'm1',
              },
              unresolved: {
                baseUrl: 'https://gw.example/v1',
                apiKey: '${QWEN_FRAMEWORK_TEST_KEY_UNSET}',
                model: 'm1',
              },
            },
          }),
      }),
    } as unknown as SettingsService;
    const localTransports = {
      resolve: () => ({}),
    } as unknown as ModelTransportManager;

    try {
      vi.stubEnv('QWEN_FRAMEWORK_TEST_KEY', 'resolved-secret');
      vi.stubEnv('QWEN_FRAMEWORK_TEST_KEY_UNSET', undefined);
      const providers = createPublicProviders(userSettings, localTransports);

      expect(providers.map((provider) => provider.providerId)).toEqual(['gw']);
      const gw = providers[0]!;
      expect((await gw.listModels()).map(({ key }) => key)).toEqual(['gw/m1']);
      expect(
        (gw as unknown as { config: { apiKey: string } }).config.apiKey,
      ).toBe('resolved-secret');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reads the user settings source under the default selection', () => {
    setDefaultSettingSourcesForProcess(undefined);
    const read = vi.fn(() =>
      JSON.stringify({
        providers: {
          gw: {
            baseUrl: 'https://gw.example/v1',
            apiKey: '${QWEN_FRAMEWORK_TEST_KEY}',
            model: 'm1',
          },
        },
      }),
    );
    const peek = vi.fn(() => ({ read }));
    const userSettings = {
      peekUserSettingsSource: peek,
    } as unknown as SettingsService;

    try {
      vi.stubEnv('QWEN_FRAMEWORK_TEST_KEY', 'resolved-secret');
      const providers = createPublicProviders(userSettings, {
        resolve: () => ({}),
      } as unknown as ModelTransportManager);

      expect(peek).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledTimes(1);
      expect(providers.map((provider) => provider.providerId)).toContain('gw');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('skips the user settings source when the selection excludes user', () => {
    setDefaultSettingSourcesForProcess(['project']);
    const read = vi.fn(() =>
      JSON.stringify({
        providers: {
          gw: {
            baseUrl: 'https://gw.example/v1',
            apiKey: '${QWEN_FRAMEWORK_TEST_KEY}',
            model: 'm1',
          },
        },
      }),
    );
    const peek = vi.fn(() => ({ read }));
    const userSettings = {
      peekUserSettingsSource: peek,
    } as unknown as SettingsService;

    try {
      vi.stubEnv('QWEN_FRAMEWORK_TEST_KEY', 'resolved-secret');
      const providers = createPublicProviders(userSettings, {
        resolve: () => ({}),
      } as unknown as ModelTransportManager);

      expect(peek).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(providers.map((provider) => provider.providerId)).not.toContain(
        'gw',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    {
      processSources: ['user'],
      sessionSources: ['project'],
      expectedReads: 0,
    },
    {
      processSources: ['project'],
      sessionSources: ['user'],
      expectedReads: 1,
    },
  ] as const)(
    'applies a session source selection during provider construction',
    async ({ processSources, sessionSources, expectedReads }) => {
      setDefaultSettingSourcesForProcess([...processSources]);
      const read = vi.fn(() =>
        JSON.stringify({
          providers: {
            gw: {
              baseUrl: 'https://gw.example/v1',
              apiKey: 'literal-key',
              model: 'm1',
            },
          },
        }),
      );
      const peek = vi.fn(() => ({ read }));
      const userSettings = {
        isInitialized: true,
        getDefinition: () => ({ validation: {} }),
        peekUserSettingsSource: peek,
      } as unknown as SettingsService;
      const loadedSettings = {
        getSettingsService: () => userSettings,
        refreshSettingsRules: () => {},
        attachSettingsService: () => {},
        merged: { advanced: { useProxyFromEnvironment: false } },
        user: { settings: {}, originalSettings: {} },
        project: { settings: {} },
        local: { settings: {} },
        flag: { settings: {}, originalSettings: {} },
      } as unknown as LoadedSettings;

      const options = {
        scope: 'host' as const,
        settingsService: userSettings,
        modelProviderFactory: () =>
          createPublicProviders(userSettings, {
            resolve: () => ({}),
          } as unknown as ModelTransportManager),
      };
      const first = await loadCliConfig(
        loadedSettings,
        'session-source-selection',
        { settingSources: [...sessionSources] } as CliArgs,
        options,
      );

      expect(peek).toHaveBeenCalledTimes(expectedReads);
      expect(read).toHaveBeenCalledTimes(expectedReads);
      read.mockClear();
      peek.mockClear();

      await loadCliConfig(
        loadedSettings,
        'rebuilt-session-source-selection',
        { settingSources: [...processSources] } as CliArgs,
        { ...options, modelProviderFactory: first.getModelProviderFactory() },
      );
      expect(peek).toHaveBeenCalledTimes(1 - expectedReads);
      expect(read).toHaveBeenCalledTimes(1 - expectedReads);

      loadedSettings.user.readOnly = true;
      read.mockClear();
      peek.mockClear();
      await loadCliConfig(
        loadedSettings,
        'projection-excludes-user',
        { settingSources: ['user'] } as CliArgs,
        options,
      );
      expect(peek).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    },
  );

  it('keeps startup provider trust resolution from throwing on malformed raw trust rules', async () => {
    // The settings loader rejects or sanitizes invalid trust-directory data
    // before the loaded projection, but the raw user layer keeps the
    // original text. The provider admission recompute reads that raw text
    // and must treat the invalid rules as ineligible, not crash startup.
    const read = vi.fn(() => '{}');
    const peek = vi.fn(() => ({ read }));
    const userSettings = {
      isInitialized: true,
      getDefinition: () => ({ validation: {} }),
      peekUserSettingsSource: peek,
    } as unknown as SettingsService;
    const loadedSettings = {
      getSettingsService: () => userSettings,
      refreshSettingsRules: () => {},
      attachSettingsService: () => {},
      merged: { advanced: { useProxyFromEnvironment: false } },
      // The sanitized projection carries no rules; the raw layer carries the
      // malformed rule the loader rejected.
      user: {
        settings: {},
        originalSettings: { permissions: { trustDirectories: 42 } },
      },
      project: { settings: {} },
      local: { settings: {} },
      flag: { settings: {}, originalSettings: {} },
    } as unknown as LoadedSettings;

    // The malformed raw rule must be ineligible, not a startup crash.
    await expect(
      loadCliConfig(
        loadedSettings,
        'malformed-raw-trust-rules',
        {} as CliArgs,
        { scope: 'host' as const, settingsService: userSettings },
      ),
    ).resolves.toBeDefined();
  });

  it('restores the process selection after session provider construction', () => {
    setDefaultSettingSourcesForProcess(['project']);
    const read = vi.fn(() =>
      JSON.stringify({
        providers: {
          gw: {
            baseUrl: 'https://gw.example/v1',
            apiKey: 'literal-key',
            model: 'm1',
          },
        },
      }),
    );
    const peek = vi.fn(() => ({ read }));
    const userSettings = {
      peekUserSettingsSource: peek,
    } as unknown as SettingsService;
    const localTransports = {
      resolve: () => ({}),
    } as unknown as ModelTransportManager;

    const sessionProviders = runWithEffectiveSettingSources(['user'], () =>
      createPublicProviders(userSettings, localTransports),
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(sessionProviders.map((provider) => provider.providerId)).toContain(
      'gw',
    );

    expect(() =>
      runWithEffectiveSettingSources(['user'], () => {
        throw new Error('construction failed');
      }),
    ).toThrow('construction failed');

    const processProviders = createPublicProviders(
      userSettings,
      localTransports,
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(
      processProviders.map((provider) => provider.providerId),
    ).not.toContain('gw');
  });

  it('skips the user settings source for an empty selection', () => {
    setDefaultSettingSourcesForProcess([]);
    const read = vi.fn(() =>
      JSON.stringify({
        providers: {
          gw: {
            baseUrl: 'https://gw.example/v1',
            apiKey: '${QWEN_FRAMEWORK_TEST_KEY}',
            model: 'm1',
          },
        },
      }),
    );
    const peek = vi.fn(() => ({ read }));
    const userSettings = {
      peekUserSettingsSource: peek,
    } as unknown as SettingsService;

    try {
      vi.stubEnv('QWEN_FRAMEWORK_TEST_KEY', 'resolved-secret');
      const providers = createPublicProviders(userSettings, {
        resolve: () => ({}),
      } as unknown as ModelTransportManager);

      expect(peek).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(providers.map((provider) => provider.providerId)).not.toContain(
        'gw',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  describe('workspace .env values and user provider interpolation', () => {
    let workspaceDir: string;

    const envTransports = {
      resolve: () => ({}),
    } as unknown as ModelTransportManager;

    beforeEach(() => {
      workspaceDir = mkdtempSync(join(tmpdir(), 'qwen-ws-env-'));
      delete process.env['QWEN_R7_BASE'];
      delete process.env['QWEN_R7_KEY'];
    });

    afterEach(() => {
      restoreLoadedEnvironment();
      delete process.env['QWEN_R7_BASE'];
      delete process.env['QWEN_R7_KEY'];
      setDefaultSettingSourcesForProcess(undefined);
      rmSync(workspaceDir, { recursive: true, force: true });
    });

    function writeWorkspaceEnv(content: string) {
      const configDir = join(workspaceDir, '.qwen');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, '.env'), content);
    }

    function userSettingsForEnvRefs(baseUrlRef: string) {
      return {
        peekUserSettingsSource: () => ({
          read: () =>
            JSON.stringify({
              providers: {
                gw: {
                  baseUrl: baseUrlRef,
                  apiKey: '${QWEN_R7_KEY}',
                  model: 'm1',
                },
              },
            }),
        }),
      } as unknown as SettingsService;
    }

    function loadWorkspaceEnv(trusted: boolean) {
      loadEnvironment({} as Settings, workspaceDir, () => ({
        isTrusted: trusted,
        source: undefined,
      }));
    }

    it('rejects a workspace .env value when the workspace is untrusted and only user settings are selected', () => {
      writeWorkspaceEnv('QWEN_R7_BASE=https://workspace.example/v1\n');
      process.env['QWEN_R7_KEY'] = 'resolved-secret';
      loadWorkspaceEnv(false);
      setDefaultSettingSourcesForProcess(['user']);

      const providers = createPublicProviders(
        userSettingsForEnvRefs('${QWEN_R7_BASE}'),
        envTransports,
      );

      expect(providers.map((provider) => provider.providerId)).not.toContain(
        'gw',
      );
      // The dotenv injection itself and the process environment stay intact.
      expect(process.env['QWEN_R7_BASE']).toBe('https://workspace.example/v1');
    });

    it('rejects a workspace .env value from an untrusted workspace even when project sources are selected', () => {
      writeWorkspaceEnv('QWEN_R7_BASE=https://workspace.example/v1\n');
      process.env['QWEN_R7_KEY'] = 'resolved-secret';
      loadWorkspaceEnv(false);
      setDefaultSettingSourcesForProcess(['user', 'project']);

      const providers = createPublicProviders(
        userSettingsForEnvRefs('${QWEN_R7_BASE}'),
        envTransports,
      );

      expect(providers.map((provider) => provider.providerId)).not.toContain(
        'gw',
      );
    });

    it('rejects a workspace .env value from a trusted workspace when only user settings are selected', () => {
      writeWorkspaceEnv('QWEN_R7_BASE=https://workspace.example/v1\n');
      process.env['QWEN_R7_KEY'] = 'resolved-secret';
      loadWorkspaceEnv(true);
      setDefaultSettingSourcesForProcess(['user']);

      const providers = createPublicProviders(
        userSettingsForEnvRefs('${QWEN_R7_BASE}'),
        envTransports,
      );

      expect(providers.map((provider) => provider.providerId)).not.toContain(
        'gw',
      );
    });

    it('keeps a trusted workspace .env value when project sources are selected', () => {
      writeWorkspaceEnv('QWEN_R7_BASE=https://workspace.example/v1\n');
      process.env['QWEN_R7_KEY'] = 'resolved-secret';
      loadWorkspaceEnv(true);
      setDefaultSettingSourcesForProcess(['user', 'project']);

      const providers = createPublicProviders(
        userSettingsForEnvRefs('${QWEN_R7_BASE}'),
        envTransports,
      );

      const gw = providers.find((provider) => provider.providerId === 'gw');
      expect(gw).toBeDefined();
      expect(
        (gw as unknown as { config?: { baseUrl?: string } }).config?.baseUrl,
      ).toBe('https://workspace.example/v1');
    });

    it.each([true, false])(
      'uses the workspace of the current provider construction (same workspace: %s)',
      (sameWorkspace) => {
        writeWorkspaceEnv('QWEN_R7_BASE=https://workspace.example/v1\n');
        process.env['QWEN_R7_KEY'] = 'resolved-key';
        loadWorkspaceEnv(true);

        const providers = runWithEffectiveSettingSources(
          ['user', 'local'],
          () =>
            createPublicProviders(
              userSettingsForEnvRefs(
                '${QWEN_R7_BASE:-https://fallback.example/v1}',
              ),
              envTransports,
            ),
          {
            cwd: sameWorkspace ? workspaceDir : join(workspaceDir, 'other'),
            isTrusted: true,
          },
        );
        const gw = providers.find((provider) => provider.providerId === 'gw');
        expect(gw).toBeDefined();
        expect(
          (gw as unknown as { config?: { baseUrl?: string } }).config?.baseUrl,
        ).toBe(
          sameWorkspace
            ? 'https://workspace.example/v1'
            : 'https://fallback.example/v1',
        );
        expect(process.env['QWEN_R7_BASE']).toBe(
          'https://workspace.example/v1',
        );
      },
    );

    it('keeps a shell-exported value over the workspace .env file under the strictest boundary', () => {
      writeWorkspaceEnv('QWEN_R7_BASE=https://workspace.example/v1\n');
      process.env['QWEN_R7_BASE'] = 'https://shell.example/v1';
      process.env['QWEN_R7_KEY'] = 'resolved-secret';
      loadWorkspaceEnv(false);
      setDefaultSettingSourcesForProcess(['user']);

      const providers = createPublicProviders(
        userSettingsForEnvRefs('${QWEN_R7_BASE}'),
        envTransports,
      );

      const gw = providers.find((provider) => provider.providerId === 'gw');
      expect(gw).toBeDefined();
      expect(
        (gw as unknown as { config?: { baseUrl?: string } }).config?.baseUrl,
      ).toBe('https://shell.example/v1');
    });

    it('resolves the default value of a rejected workspace reference', () => {
      writeWorkspaceEnv('QWEN_R7_BASE=https://workspace.example/v1\n');
      process.env['QWEN_R7_KEY'] = 'resolved-secret';
      loadWorkspaceEnv(false);
      setDefaultSettingSourcesForProcess(['user']);

      const providers = createPublicProviders(
        userSettingsForEnvRefs('${QWEN_R7_BASE:-https://fallback.example/v1}'),
        envTransports,
      );

      const gw = providers.find((provider) => provider.providerId === 'gw');
      expect(gw).toBeDefined();
      expect(
        (gw as unknown as { config?: { baseUrl?: string } }).config?.baseUrl,
      ).toBe('https://fallback.example/v1');
    });
  });
});
