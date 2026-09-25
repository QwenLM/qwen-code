/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import type { ConfigParameters } from './config.js';
import { Config } from './config.js';
import { ExtensionManager } from '../extension/extensionManager.js';
import * as fs from 'node:fs';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    existsSync: vi.fn().mockReturnValue(true),
    readdirSync: vi.fn().mockReturnValue([]),
    statSync: vi.fn().mockReturnValue({
      isDirectory: vi.fn().mockReturnValue(true),
    }),
    realpathSync: vi.fn((p) => p),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    copyFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

vi.mock('../tools/tool-registry', () => {
  const ToolRegistryMock = vi.fn();
  ToolRegistryMock.prototype.registerTool = vi.fn();
  ToolRegistryMock.prototype.registerFactory = vi.fn();
  ToolRegistryMock.prototype.ensureTool = vi.fn();
  ToolRegistryMock.prototype.warmAll = vi.fn();
  ToolRegistryMock.prototype.discoverAllTools = vi.fn();
  ToolRegistryMock.prototype.getAllTools = vi.fn(() => []);
  ToolRegistryMock.prototype.getAllToolNames = vi.fn(() => []);
  ToolRegistryMock.prototype.getTool = vi.fn();
  ToolRegistryMock.prototype.getFunctionDeclarations = vi.fn(() => []);
  ToolRegistryMock.mockImplementation(function (this: {
    __mcpManagerMock: {
      setOnBudgetEvent: Mock;
      discoverAllMcpToolsIncremental: Mock;
    };
  }) {
    this.__mcpManagerMock = {
      setOnBudgetEvent: vi.fn(),
      discoverAllMcpToolsIncremental: vi.fn().mockResolvedValue(undefined),
    };
    return this;
  });
  ToolRegistryMock.prototype.getMcpClientManager = function (this: {
    __mcpManagerMock: { setOnBudgetEvent: Mock };
  }) {
    return this.__mcpManagerMock;
  };
  return { ToolRegistry: ToolRegistryMock };
});

vi.mock('../memory/memoryDiscovery.js', () => ({
  loadServerHierarchicalMemory: vi.fn().mockResolvedValue({
    memoryContent: '',
    fileCount: 0,
    contextFilePaths: [],
    ruleCount: 0,
    conditionalRules: [],
    projectRoot: '/tmp',
  }),
}));

vi.mock('../memory/store.js', () => ({
  readAutoMemoryIndex: vi.fn().mockResolvedValue(null),
  readAutoMemoryIndexWithStats: vi.fn().mockResolvedValue(null),
  readUserAutoMemoryIndex: vi.fn().mockResolvedValue(null),
  readUserAutoMemoryIndexWithStats: vi.fn().mockResolvedValue(null),
}));

vi.mock('../hooks/index.js', () => {
  const HookSystemMock = vi.fn();
  HookSystemMock.prototype.initialize = vi.fn().mockResolvedValue(undefined);
  HookSystemMock.prototype.hasHooksForEvent = vi.fn().mockReturnValue(false);
  HookSystemMock.prototype.getAllHooks = vi.fn().mockReturnValue([]);
  return {
    HookSystem: HookSystemMock,
    createHookOutput: vi.fn(),
    createInstructionsLoadedCallback: () => async () => {},
  };
});

vi.mock('../extension/extensionManager.js', () => {
  const ExtensionManagerMock = vi.fn();
  ExtensionManagerMock.prototype.setConfig = vi.fn();
  ExtensionManagerMock.prototype.refreshCache = vi
    .fn()
    .mockResolvedValue(undefined);
  ExtensionManagerMock.prototype.getLoadedExtensions = vi.fn(() => []);
  ExtensionManagerMock.prototype.getPendingScanRefusals = vi.fn(
    () => new Map(),
  );
  return { ExtensionManager: ExtensionManagerMock };
});

vi.mock('../skills/skill-manager.js', () => {
  const SkillManagerMock = vi.fn();
  SkillManagerMock.prototype.refreshCache = vi
    .fn()
    .mockResolvedValue(undefined);
  SkillManagerMock.prototype.startWatching = vi
    .fn()
    .mockResolvedValue(undefined);
  SkillManagerMock.prototype.stop = vi.fn();
  return { SkillManager: SkillManagerMock };
});

vi.mock('../core/contentGenerator.js', () => ({
  AuthType: { USE_OPENAI: 'openai' },
  Protocol: {
    OPENAI: 'openai',
    QWEN_OAUTH: 'qwen-oauth',
    GEMINI: 'gemini',
    ANTHROPIC: 'anthropic',
  },
  createContentGenerator: vi.fn().mockReturnValue({
    getContentGeneratorConfig: () => ({ model: 'test' }),
  }),
  resolveContentGeneratorConfigWithSources: vi
    .fn()
    .mockImplementation((_config, authType, generationConfig) => ({
      config: {
        ...generationConfig,
        authType,
        model: generationConfig?.model || 'test-model',
        apiKey: 'test-key',
      },
      sources: {},
    })),
}));

vi.mock('../core/client.js', () => {
  const LlmClientMock = vi.fn();
  LlmClientMock.prototype.initialize = vi.fn().mockResolvedValue(undefined);
  return { LlmClient: LlmClientMock };
});

vi.mock('../telemetry/index.js', () => ({
  DEFAULT_TELEMETRY_TARGET: 'local',
  DEFAULT_OTLP_ENDPOINT: 'http://localhost:4317',
  DEFAULT_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH: 1024 * 1024,
  isTelemetrySdkInitialized: vi.fn().mockReturnValue(false),
  initializeTelemetry: vi.fn(),
  shutdownTelemetry: vi.fn(),
  refreshSessionContext: vi.fn(),
  logStartSession: vi.fn(),
  logRipgrepFallback: vi.fn(),
  StartSessionEvent: vi.fn(),
  QwenLogger: vi.fn().mockImplementation(() => ({
    logStartSessionEvent: vi.fn(),
  })),
}));

vi.mock('../telemetry/loggers.js', () => ({
  logRipgrepFallback: vi.fn(),
}));

vi.mock('../telemetry/types.js', () => ({
  RipgrepFallbackEvent: vi.fn(),
  StartSessionEvent: vi.fn(),
}));

vi.mock('../core/toolHookTriggers.js', () => ({
  fireNotificationHook: vi.fn(),
}));

vi.mock('../utils/ripgrepUtils.js', () => ({
  canUseRipgrep: vi.fn().mockResolvedValue(true),
}));

vi.mock('../utils/startupEventSink.js', () => ({
  recordStartupEvent: vi.fn(),
}));

vi.mock('../services/worktreeCleanup.js', () => ({
  cleanupStaleAgentWorktrees: vi.fn().mockResolvedValue(undefined),
}));

const baseParams: ConfigParameters = {
  cwd: '/tmp',
  targetDir: '/tmp',
  debugMode: false,
  usageStatisticsEnabled: false,
  overrideExtensions: [],
  model: 'test-model',
};

const emfile = () =>
  Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });

describe('Config startup extension refresh', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.readdirSync as Mock).mockReturnValue([]);
    vi.mocked(fs.realpathSync).mockImplementation((p) => p.toString());
    vi.mocked(ExtensionManager.prototype.refreshCache).mockResolvedValue(
      undefined,
    );
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('retries a transient resource-exhaustion rejection once and finishes startup', async () => {
    // The loaders fail a refresh closed on EMFILE; at startup there is no
    // previous cache to keep and no later refresh to retry, so a single
    // transient failure must not abort initialization.
    vi.mocked(ExtensionManager.prototype.refreshCache)
      .mockRejectedValueOnce(emfile())
      .mockResolvedValue(undefined);

    const config = new Config(baseParams);
    await expect(config.initialize()).resolves.toBeUndefined();

    // initial attempt + its retry + the final refresh
    expect(
      vi.mocked(ExtensionManager.prototype.refreshCache).mock.calls,
    ).toHaveLength(3);
  });

  it('continues without the extension set when resource exhaustion persists', async () => {
    vi.mocked(ExtensionManager.prototype.refreshCache).mockRejectedValue(
      emfile(),
    );

    const config = new Config(baseParams);
    await expect(config.initialize()).resolves.toBeUndefined();

    // Both startup refresh sites give up after one retry each.
    expect(
      vi.mocked(ExtensionManager.prototype.refreshCache).mock.calls,
    ).toHaveLength(4);
    expect(config.getExtensions()).toEqual([]);
  });

  it('does not retry a non-exhaustion rejection', async () => {
    const failure = new Error('corrupt extension store');
    vi.mocked(ExtensionManager.prototype.refreshCache).mockRejectedValue(
      failure,
    );

    const config = new Config(baseParams);
    await expect(config.initialize()).rejects.toBe(failure);

    expect(
      vi.mocked(ExtensionManager.prototype.refreshCache).mock.calls,
    ).toHaveLength(1);
  });
});
