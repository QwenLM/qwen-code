/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi } from 'vitest';
import { InMemoryToolCallSnapshotStore } from '@qwen-code/core';
import type { Config } from '@qwen-code/core';
import {
  createTestMergedSettings,
  type LoadedSettings,
  type Settings,
} from '../config/settings.js';

/**
 * Creates a mocked Config object with default values and allows overrides.
 */
export const createMockConfig = (overrides: Partial<Config> = {}): Config => {
  const getQuestion =
    overrides.getQuestion ?? vi.fn<() => string | undefined>(() => '');
  const getEffectiveQuestion =
    overrides.getEffectiveQuestion ??
    vi.fn<() => string | undefined>(() => getQuestion());
  const startupRuntime = {
    runOnce: vi.fn(async (_taskId: unknown, task: () => unknown) => task()),
    runOnceWhenReady: vi.fn(
      async (_gate: unknown, _options: unknown, task: () => unknown) => task(),
    ),
    when: vi.fn(async () => undefined),
  };

  return {
    getQuestion,
    getEffectiveQuestion,
    isInteractive: vi.fn(() => false),
    isInitialized: vi.fn(() => true),
    setTerminalBackground: vi.fn(),
    storage: {
      getProjectTempDir: vi.fn().mockReturnValue('/tmp/gemini-test'),
      initialize: vi.fn().mockResolvedValue(undefined),
      getWorkspaceLocalSettingsPath: vi
        .fn()
        .mockReturnValue('/tmp/gemini-test/.qwen/settings.local.json'),
    },
    getDebugMode: vi.fn(() => false),
    getProjectRoot: vi.fn(() => '/'),
    refreshAuth: vi.fn().mockResolvedValue(undefined),
    getStartupRuntime: vi.fn(() => startupRuntime),
    getBuiltinPluginContributions: vi.fn(() => undefined),
    getBuiltinPluginsInitialization: vi.fn(() => undefined),
    initialize: vi.fn().mockResolvedValue(undefined),
    toolCallSnapshots: new InMemoryToolCallSnapshotStore(),
    getHookSystem: vi.fn(() => ({
      fireSessionEndEvent: vi.fn().mockResolvedValue(undefined),
      fireSessionStartEvent: vi.fn().mockResolvedValue(undefined),
    })),
    getEnabledPlugins: vi.fn(() => []),
    setSessionId: vi.fn(),
    getSessionId: vi.fn().mockReturnValue('mock-session-id'),
    getUsageStatisticsEnabled: vi.fn(() => true),
    persistSessionTitle: vi.fn().mockResolvedValue(undefined),
    registerSessionRuntimeBinding: vi.fn(),
    getWorktreeSettings: vi.fn(() => undefined),
    setWorktreeSettings: vi.fn(),
    getContentGeneratorConfig: vi.fn(() => ({ authType: 'google' })),
    getAcpMode: vi.fn(() => false),
    getClientType: vi.fn(() => undefined),
    getClientName: vi.fn(() => undefined),
    isBrowserLaunchSuppressed: vi.fn(() => false),
    isYoloModeDisabled: vi.fn(() => false),
    getPermissionModeRestriction: vi.fn(() => undefined),
    isPlanEnabled: vi.fn(() => false),
    getApprovedPlanPath: vi.fn(() => undefined),
    getCoreTools: vi.fn(() => []),
    getPermissionMode: vi.fn(() => 'default'),
    getFileFilteringRespectGitIgnore: vi.fn(() => true),
    getOutputFormat: vi.fn(() => 'text'),
    getScreenReader: vi.fn(() => false),
    getMemoryMdFileCount: vi.fn(() => 0),
    getDeferredCommand: vi.fn(() => undefined),
    initializeForInteractiveStartup: vi.fn(async () => undefined),
    hydrateAfterFirstRender: vi.fn(async () => undefined),
    setPluginInstallPromise: vi.fn(),
    getPluginInstallPromise: vi.fn(() => null),
    setPluginSyncErrors: vi.fn(),
    getFileSystemService: vi.fn(() => ({})),
    clientVersion: '1.0.0',
    getModel: vi.fn().mockReturnValue('gemini-pro'),
    getWorkingDir: vi.fn().mockReturnValue('/mock/cwd'),
    getTargetDir: vi.fn().mockReturnValue('/mock/cwd'),
    getToolRegistry: vi.fn().mockReturnValue({
      getTools: vi.fn().mockReturnValue([]),
      getAllTools: vi.fn().mockReturnValue([]),
    }),
    getAgentRegistry: vi.fn().mockReturnValue({}),
    getSessionAgentDefinitionLike: vi.fn().mockReturnValue(undefined),
    getSkillManager: vi.fn().mockReturnValue({
      isAdminEnabled: vi.fn().mockReturnValue(false),
    }),
    getFileService: vi.fn().mockReturnValue({}),
    getUserMemory: vi.fn().mockReturnValue(''),
    getSystemInstructionMemory: vi.fn().mockReturnValue(''),
    getSessionMemory: vi.fn().mockReturnValue(''),
    getMemoryMdFilePaths: vi.fn().mockReturnValue([]),
    getPendingIncludeDirectories: vi.fn().mockReturnValue([]),
    getShowMemoryUsage: vi.fn().mockReturnValue(false),
    getAccessibility: vi.fn().mockReturnValue({}),
    enableBuiltinPluginsForHeadless: vi.fn(),
    enableBuiltinPluginsForTui: vi.fn(),
    reloadPlugins: vi.fn().mockResolvedValue(undefined),
    updateSystemInstructionIfInitialized: vi.fn().mockResolvedValue(undefined),
    getModelAvailabilityService: vi.fn().mockReturnValue({}),
    getEnableRecursiveFileSearch: vi.fn().mockReturnValue(true),
    getFileFilteringEnableFuzzySearch: vi.fn().mockReturnValue(true),
    getFileFilteringRespectBrandIgnore: vi.fn().mockReturnValue(true),
    getFileFilteringOptions: vi.fn().mockReturnValue({}),
    getCustomExcludes: vi.fn().mockReturnValue([]),
    getFileCheckpointingEnabled: vi.fn().mockReturnValue(true),
    getProxy: vi.fn().mockReturnValue(undefined),
    getEnableExtensionReloading: vi.fn().mockReturnValue(false),
    getNoBrowser: vi.fn().mockReturnValue(false),
    getAgentsSettings: vi.fn().mockReturnValue({}),
    getSummarizeToolOutputConfig: vi.fn().mockReturnValue(undefined),
    getFolderTrust: vi.fn().mockReturnValue(true),
    isTrustedFolder: vi.fn().mockReturnValue(true),
    isSkillsSupportEnabled: vi.fn().mockReturnValue(false),
    reloadSkills: vi.fn().mockResolvedValue(undefined),
    reloadAgents: vi.fn().mockResolvedValue(undefined),
    getUseRipgrep: vi.fn().mockReturnValue(false),
    getContinueOnFailedApiCall: vi.fn().mockReturnValue(false),
    getRetryFetchErrors: vi.fn().mockReturnValue(true),
    getShellToolInactivityTimeout: vi.fn().mockReturnValue(300000),
    getShellExecutionConfig: vi.fn().mockReturnValue({
      sanitizationConfig: {
        allowedEnvironmentVariables: [],
        blockedEnvironmentVariables: [],
        enableEnvironmentVariableRedaction: false,
      },
    }),
    setShellExecutionConfig: vi.fn(),
    getEnableToolOutputTruncation: vi.fn().mockReturnValue(true),
    getTruncateToolOutputThreshold: vi.fn().mockReturnValue(1000),
    getTruncateToolOutputLines: vi.fn().mockReturnValue(100),
    getNextCompressionTruncationId: vi.fn().mockReturnValue(1),
    getUseWriteTodos: vi.fn().mockReturnValue(false),
    getFileExclusions: vi.fn().mockReturnValue({}),
    getEnableHooks: vi.fn().mockReturnValue(true),
    getMcpClientManager: vi.fn().mockReturnValue({
      getMcpInstructions: vi.fn().mockReturnValue(''),
      getMcpServers: vi.fn().mockReturnValue({}),
      getLastError: vi.fn().mockReturnValue(undefined),
      emitDiagnostic: vi.fn(),
      canUseMcpServer: vi.fn().mockReturnValue(true),
    }),
    getElicitationHost: vi.fn().mockReturnValue({
      setElicitationBridge: vi.fn(),
    }),
    getEnableEventDrivenScheduler: vi.fn().mockReturnValue(false),
    getAdminSkillsEnabled: vi.fn().mockReturnValue(false),
    getDisabledSkills: vi.fn().mockReturnValue([]),
    getExperimentalJitContext: vi.fn().mockReturnValue(false),
    getMemoryBoundaryMarkers: vi.fn().mockReturnValue(['.git']),
    getTerminalBackground: vi.fn().mockReturnValue(undefined),
    getEmbeddingModel: vi.fn().mockReturnValue('embedding-model'),
    getQuotaErrorOccurred: vi.fn().mockReturnValue(false),
    getExcludeTools: vi.fn().mockReturnValue(new Set()),
    getAllowedMcpServers: vi.fn().mockReturnValue([]),
    getBlockedMcpServers: vi.fn().mockReturnValue([]),
    getHasAccessToPreviewModel: vi.fn().mockReturnValue(false),
    validatePathAccess: vi.fn().mockReturnValue(null),
    getUseAlternateBuffer: vi.fn().mockReturnValue(false),
    getUseTerminalBuffer: vi.fn().mockReturnValue(false),
    getUseRenderProcess: vi.fn().mockReturnValue(false),
    topicState: {
      setTopic: vi.fn(),
      getTopic: vi.fn().mockReturnValue(undefined),
      getIntent: vi.fn().mockReturnValue(undefined),
      reset: vi.fn(),
    },
    ...overrides,
  } as unknown as Config;
};

/**
 * Creates a mocked LoadedSettings object for tests.
 */
export function createMockSettings(
  overrides: Record<string, unknown> = {},
): LoadedSettings {
  const merged = createTestMergedSettings(
    (overrides['merged'] as Partial<Settings>) || {},
  );

  return {
    user: { settings: {} },
    project: { settings: {} },
    local: { settings: {} },
    flag: { settings: {} },
    errors: [],
    subscribe: vi.fn().mockReturnValue(() => {}),
    getSnapshot: vi.fn().mockReturnValue({
      user: { settings: {} },
      project: { settings: {} },
      local: { settings: {} },
      flag: { settings: {} },
      isTrusted: true,
      errors: [],
      merged,
    }),
    setValue: vi.fn(),
    ...overrides,
    merged,
  } as unknown as LoadedSettings;
}
