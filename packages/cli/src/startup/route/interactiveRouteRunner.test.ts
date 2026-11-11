/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createTestI18nService } from '../../test-utils/i18n.js';
const service = createTestI18nService();

import { describe, expect, it, vi } from 'vitest';
import { runInteractiveRoute } from './interactiveRouteRunner.js';
import type { ConfiguredStartupContext } from '../startupContext.js';
import type { RuntimeRouteRunnerOptions } from './runtimeRouteTypes.js';
const mocks = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock('../../interactiveCli.js', () => ({ startInteractiveUI: mocks.start }));
vi.mock('../../ink/layout/yoga.js', () => ({ ensureYogaLoaded: vi.fn() }));
function TestAppContainer() {
  return null;
}

describe('Sites local interactive admission', () => {
  it('rejects an invalid -m before rendering the TUI', async () => {
    mocks.start.mockReset();
    const config = {
      enableBuiltinPluginsForTui: vi.fn(),
      reloadPlugins: vi.fn(async () => {}),
      getCliModel: () => 'bogus',
      isInitialized: () => true,
      getModelProviderManager: () => ({
        listModels: async () => [],
        getModel: async () => undefined,
      }),
    };

    await expect(
      runInteractiveRoute(
        {
          config,
          framework: {
            mode: 'tui',
            getI18nService: () => service,
            getAppContainer: () => TestAppContainer,
            whenConfigReady: vi.fn(async () => {}),
          },
          settings: { settings: { merged: {} }, argv: {} },
        } as unknown as ConfiguredStartupContext,
        {
          startupWarnings: [],
          themeError: null,
        } as unknown as RuntimeRouteRunnerOptions,
      ),
    ).rejects.toMatchObject({ name: 'FatalInputError' });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('lets the interactive flow handle non-input -m failures', async () => {
    mocks.start.mockReset();
    const config = {
      enableBuiltinPluginsForTui: vi.fn(),
      reloadPlugins: vi.fn(async () => {}),
      getCliModel: () => 'gateway/model',
      isInitialized: () => true,
      getModelProviderManager: () => ({
        listModels: async () => {
          throw new Error('authentication required');
        },
        getModel: async () => undefined,
      }),
    };

    await runInteractiveRoute(
      {
        config,
        framework: {
          mode: 'tui',
          getI18nService: () => service,
          getAppContainer: () => TestAppContainer,
          whenConfigReady: vi.fn(async () => {}),
        },
        settings: { settings: { merged: {} }, argv: {} },
      } as unknown as ConfiguredStartupContext,
      {
        startupWarnings: [],
        themeError: null,
      } as unknown as RuntimeRouteRunnerOptions,
    );

    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it('applies a valid -m before rendering the TUI', async () => {
    mocks.start.mockReset();
    const model = {
      key: 'gateway/model',
      displayName: 'Gateway',
      enabled: true,
    };
    const reconcile = vi.fn(async () => {});
    const config = {
      enableBuiltinPluginsForTui: vi.fn(),
      reloadPlugins: vi.fn(async () => {}),
      getCliModel: () => 'gateway/model',
      isInitialized: () => true,
      getModelProviderManager: () => ({
        listModels: async () => [model],
        getModel: async () => model,
      }),
      reconcileModelWithListedModels: reconcile,
    };

    await runInteractiveRoute(
      {
        config,
        framework: {
          mode: 'tui',
          getI18nService: () => service,
          getAppContainer: () => TestAppContainer,
          whenConfigReady: vi.fn(async () => {}),
        },
        settings: { settings: { merged: {} }, argv: {} },
      } as unknown as ConfiguredStartupContext,
      {
        startupWarnings: [],
        themeError: null,
      } as unknown as RuntimeRouteRunnerOptions,
    );

    expect(reconcile).toHaveBeenCalledWith({ onInvalidCliModel: 'throw' });
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it.each(['local', 'handle'])(
    'marks the builtin-plugin local session only when remote resume is %s',
    async (entry) => {
      const remote = entry !== 'local';
      const events: string[] = [];
      const config = {
        enableBuiltinPluginsForTui: vi.fn(),
        reloadPlugins: vi.fn(async () => {
          events.push('reload');
        }),
        enableEnterpriseCodeSecurityPolicyForTui: vi.fn(),
      };
      const startInteractiveUI = mocks.start
        .mockReset()
        .mockImplementation(async () => {
          events.push('ui');
        });
      const whenConfigReady = vi.fn(async () => {});
      await runInteractiveRoute(
        {
          config,
          framework: {
            mode: 'tui',
            getI18nService: () => service,
            getAppContainer: () => TestAppContainer,
            whenConfigReady,
          },
          settings: { settings: { merged: {} }, argv: {} },
        } as unknown as ConfiguredStartupContext,
        {
          session: entry === 'handle' ? {} : undefined,
          startupWarnings: [],
          themeError: null,
        } as unknown as RuntimeRouteRunnerOptions,
      );
      expect(config.enableBuiltinPluginsForTui).toHaveBeenCalledWith();
      expect(events).toEqual(remote ? ['ui'] : ['reload', 'ui']);
      expect(startInteractiveUI).toHaveBeenCalledOnce();
      expect(whenConfigReady).toHaveBeenCalledTimes(remote ? 0 : 1);
    },
  );

  it.each([undefined, { resumeTarget: 'previous-session' }])(
    'preserves session startup data with browser options %j',
    async (initialSessionBrowserOptions) => {
      mocks.start.mockReset();
      const config = { enableBuiltinPluginsForTui: vi.fn() };
      const settings = { merged: {} };
      const options = {
        startupWarnings: [],
        themeError: 'theme warning',
        resumedSessionData: { sessionId: 'previous-session' },
        session: {},
        initialSessionTitle: 'Initial title',
        initialSessionBrowserOptions,
        startupCoordinator: {},
        worktreeStartupRequest: { kind: 'create', originalCwd: '/workspace' },
        rebuildProject: vi.fn(),
        sessionUi: {},
      } as unknown as RuntimeRouteRunnerOptions;

      await runInteractiveRoute(
        {
          config,
          framework: {
            mode: 'tui',
            getI18nService: () => service,
            getAppContainer: () => TestAppContainer,
          },
          settings: { settings, argv: {} },
        } as unknown as ConfiguredStartupContext,
        options,
      );

      expect(mocks.start).toHaveBeenCalledExactlyOnceWith(
        TestAppContainer,
        service,
        config,
        settings,
        options.startupWarnings,
        process.cwd(),
        options.resumedSessionData,
        options.themeError,
        initialSessionBrowserOptions ? undefined : options.initialSessionTitle,
        initialSessionBrowserOptions,
        options.startupCoordinator,
        options.worktreeStartupRequest,
        options.rebuildProject,
        expect.objectContaining({
          getCliDisplayName: expect.any(Function),
          getAppPlugins: expect.any(Function),
          bindLocalSession: expect.any(Function),
        }),
        options.sessionUi,
      );
    },
  );
});
