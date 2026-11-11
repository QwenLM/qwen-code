/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const loadSettings = vi.hoisted(() => vi.fn());
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BRAND_ENV_PREFIX,
  type Config,
  type SessionResumeData,
} from '@qwen-code/core';
import { rebuildInteractiveProject } from './interactiveProjectRuntime.js';
import { loadCliConfig, type CliArgs } from './config/config.js';
import {
  clearSettingsCache,
  restoreLoadedEnvironment,
} from './config/settings.js';
import { validateTheme } from './core/theme.js';
import { createMockSettings } from './test-utils/settings.js';

vi.mock('./config/config.js', () => ({ loadCliConfig: vi.fn() }));
vi.mock('./config/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config/settings.js')>()),
  loadSettings,
  loadSettingsWithService: (cwd: string) => loadSettings(cwd),
  clearSettingsCache: vi.fn(),
  restoreLoadedEnvironment: vi.fn(),
}));

vi.mock('./core/theme.js', () => ({ validateTheme: vi.fn(() => null) }));

describe('rebuildInteractiveProject', () => {
  const settings = createMockSettings();
  const customProviderManager = { list: vi.fn() };
  const experimentService = { evaluate: vi.fn(), recordEffective: vi.fn() };
  const modelProviderManager = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  const settingsService = {
    resolve: ({ projectPath }: { projectPath: string }) =>
      loadSettings(projectPath),
  };
  const next = {
    storage: { initialize: vi.fn() },
    getModelProviderManager: () => modelProviderManager,
    initializeForInteractiveStartup: vi.fn(),
    enableBuiltinPluginsForTui: vi.fn(),
    reloadPlugins: vi.fn(async () => {
      expect(next.enableBuiltinPluginsForTui).toHaveBeenCalledWith();
    }),
    enableEnterpriseCodeSecurityPolicyForTui: vi.fn(),
    dispose: vi.fn(),
  };
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadSettings).mockReturnValue(settings);
    vi.mocked(loadCliConfig).mockResolvedValue(next as unknown as Config);
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    {
      name: 'replaces old environment defaults',
      source: 'environment',
      target: 'configured',
      permission: 'default',
      model: 'target-model',
      prompt: 'TARGET_PROJECT',
    },
    {
      name: 'drops defaults absent from the target environment',
      source: 'environment',
      target: 'empty',
      permission: undefined,
      model: undefined,
      prompt: undefined,
    },
    {
      name: 'loads newly introduced environment defaults and normalizes aliases',
      source: 'empty',
      target: 'alias',
      permission: 'accept_edits',
      model: 'target-model',
      prompt: 'TARGET_PROJECT',
    },
    {
      name: 'preserves explicit CLI overrides',
      source: 'cli',
      target: 'configured',
      permission: 'bypass_permissions',
      model: 'source-model',
      prompt: 'SOURCE_PROJECT',
    },
  ])(
    '$name when rebuilding a project',
    async ({ source, target, permission, model, prompt }) => {
      const prefix = BRAND_ENV_PREFIX;
      vi.mocked(loadSettings).mockImplementation(() => {
        vi.stubEnv(
          `${prefix}MODEL`,
          target === 'empty' ? undefined : 'target-model',
        );
        vi.stubEnv(
          `${prefix}PERMISSION_MODE`,
          target === 'empty'
            ? undefined
            : target === 'alias'
              ? 'acceptEdits'
              : 'default',
        );
        vi.stubEnv(
          `${prefix}APPEND_SYSTEM_PROMPT`,
          target === 'empty' ? undefined : 'TARGET_PROJECT',
        );
        return settings;
      });
      const keys = ['model', 'permissionMode', 'appendSystemPrompt'];
      const argv = {
        environmentOptionNames: source === 'environment' ? keys : [],
        explicitCliOptionNames: source === 'cli' ? keys : [],
        ...(source !== 'empty'
          ? {
              model: 'source-model',
              permissionMode: 'bypass_permissions',
              appendSystemPrompt: 'SOURCE_PROJECT',
            }
          : {}),
      } as CliArgs;

      await rebuildInteractiveProject(
        {
          dispose: vi.fn(),
          getMcpInitializationWaitStrategy: () => 'budget',
          getResourceService: () => ({}),
          getSettingsService: () => settingsService,
          getPluginManagerFactory: () => undefined,
          getCustomProviderManager: () => customProviderManager,
          getModelProviderFactory: () => () => [],
          getAutoClassifierIntegration: () => undefined,
          getExperimentService: () => experimentService,
          getModelProviderManager: () => ({}),
          getBuiltinPluginContributions: () => undefined,
          getBuiltinPluginsInitialization: () => undefined,
          getScreenReader: () => false,
          getUseAlternateBuffer: () => true,
        } as unknown as Config,
        { sessionId: 'selected', originalCwd: process.cwd(), messages: [] },
        argv,
      );

      expect(vi.mocked(loadCliConfig).mock.lastCall?.[3]?.settingsService).toBe(
        settingsService,
      );

      // Config 接收的是目标项目环境与显式 CLI 的合并结果，不是旧项目参数快照。
      const received = vi.mocked(loadCliConfig).mock.lastCall?.[2];
      expect({
        permissionMode: received?.permissionMode,
        model: received?.model,
        appendSystemPrompt: received?.appendSystemPrompt,
      }).toEqual({
        permissionMode: permission,
        model,
        appendSystemPrompt: prompt,
      });
      expect(argv.environmentOptionNames).toEqual(
        source === 'environment' ? keys : [],
      );
    },
  );
  it('loads settings and all resources at originalCwd after old resources have closed', async () => {
    vi.mocked(validateTheme).mockImplementationOnce(() => {
      // 重建项目必须在初始化前恢复 TUI 的内置插件启用契约。
      expect(next.enableBuiltinPluginsForTui).toHaveBeenCalled();
      expect(next.reloadPlugins).toHaveBeenCalledOnce();
      return null;
    });
    const previous = {
      getMcpInitializationWaitStrategy: () => 'budget',
      getResourceService: () => ({}),
      getPluginManagerFactory: () => undefined,
      getSettingsService: () => settingsService,
      getCustomProviderManager: () => customProviderManager,
      getModelProviderFactory: () => () => [],
      getAutoClassifierIntegration: () => undefined,
      getExperimentService: () => experimentService,
      getModelProviderManager: () => ({}),
      getBuiltinPluginContributions: () => undefined,
      getBuiltinPluginsInitialization: () => undefined,
      getScreenReader: () => false,
      getUseAlternateBuffer: () => true,
      dispose: vi.fn(async () => {
        expect(restoreLoadedEnvironment).not.toHaveBeenCalled();
        expect(loadCliConfig).not.toHaveBeenCalled();
      }),
    };
    const data = {
      sessionId: 'selected',
      originalCwd: process.cwd(),
      sessionPath: '/old-worktree-bucket/selected.jsonl',
      messages: [],
    } satisfies SessionResumeData;
    const argv = {
      worktree: 'old',
      resume: 'old',
      forkSession: true,
    } as CliArgs;
    const prefix = BRAND_ENV_PREFIX;
    vi.stubEnv(`${prefix}WORKING_DIR`, '/unrelated-environment-project');
    vi.stubEnv(`${prefix}SESSION_NAME`, 'Unrelated environment name');
    vi.stubEnv(`${prefix}SESSION_ID`, 'unrelated-environment-session');
    const result = await rebuildInteractiveProject(
      previous as unknown as Config,
      data,
      argv,
    );
    expect(previous.dispose).toHaveBeenCalled();
    expect(restoreLoadedEnvironment).toHaveBeenCalled();
    expect(clearSettingsCache).toHaveBeenCalled();
    expect(loadSettings).toHaveBeenCalledWith(data.originalCwd);
    expect(loadCliConfig).toHaveBeenCalledWith(
      settings,
      'selected',
      expect.objectContaining({
        worktree: undefined,
        resume: undefined,
        forkSession: undefined,
        screenReader: false,
        alternateBuffer: true,
        cwd: data.originalCwd,
        name: undefined,
      }),
      expect.objectContaining({
        cwd: data.originalCwd,
        customProviderManager,
        settingsService,
        experimentService,
      }),
    );
    expect(vi.mocked(loadCliConfig).mock.lastCall?.[0]).toBe(settings);
    expect(vi.mocked(loadCliConfig).mock.lastCall?.[3]).not.toHaveProperty(
      'loadedSettings',
    );
    expect(next.initializeForInteractiveStartup).not.toHaveBeenCalled();
    expect(modelProviderManager.start).not.toHaveBeenCalled();
    expect(modelProviderManager.stop).not.toHaveBeenCalled();
    expect(experimentService.evaluate).not.toHaveBeenCalled();
    const received = vi.mocked(loadCliConfig).mock.lastCall?.[2];
    expect(received?.environmentOptionNames).not.toContain('cwd');
    expect(received?.environmentOptionNames).not.toContain('name');
    expect(received?.environmentOptionNames).not.toContain('sessionId');
    expect(result.config).toBe(next);
  });
  it('disposes a partially initialized replacement and restores its injected environment on failure', async () => {
    vi.mocked(validateTheme).mockImplementationOnce(() => {
      throw new Error('initialization failed');
    });
    await expect(
      rebuildInteractiveProject(
        {
          dispose: vi.fn(),
          getMcpInitializationWaitStrategy: () => 'budget',
          getResourceService: () => ({}),
          getSettingsService: () => settingsService,
          getPluginManagerFactory: () => undefined,
          getCustomProviderManager: () => customProviderManager,
          getModelProviderFactory: () => () => [],
          getAutoClassifierIntegration: () => undefined,
          getExperimentService: () => experimentService,
          getModelProviderManager: () => ({}),
          getBuiltinPluginContributions: () => undefined,
          getBuiltinPluginsInitialization: () => undefined,
          getScreenReader: () => false,
          getUseAlternateBuffer: () => true,
        } as unknown as Config,
        { sessionId: 'selected', originalCwd: process.cwd(), messages: [] },
        {} as CliArgs,
      ),
    ).rejects.toThrow('initialization failed');
    expect(next.dispose).toHaveBeenCalled();
    // 初始化失败后不得保留目标项目注入值。
    expect(restoreLoadedEnvironment).toHaveBeenLastCalledWith();
  });
});
