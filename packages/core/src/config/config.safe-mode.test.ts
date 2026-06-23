/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import type { ConfigParameters } from './config.js';
import { Config } from './config.js';
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

vi.mock('../utils/memoryDiscovery.js', () => ({
  loadServerHierarchicalMemory: vi.fn().mockResolvedValue({
    memoryContent: '',
    fileCount: 0,
    ruleCount: 0,
    conditionalRules: [],
    projectRoot: '/tmp',
  }),
}));

vi.mock('../memory/store.js', () => ({
  readAutoMemoryIndex: vi.fn().mockResolvedValue(null),
  readUserAutoMemoryIndex: vi.fn().mockResolvedValue(null),
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
  AuthType: { QWEN_API_KEY: 'qwen_api_key' },
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
  const GeminiClientMock = vi.fn();
  GeminiClientMock.prototype.initialize = vi.fn().mockResolvedValue(undefined);
  return { GeminiClient: GeminiClientMock };
});

vi.mock('../telemetry/index.js', () => ({
  DEFAULT_TELEMETRY_TARGET: 'local',
  DEFAULT_OTLP_ENDPOINT: 'http://localhost:4317',
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

describe('Config safe mode', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env['QWEN_CODE_SAFE_MODE'];
    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.readdirSync as Mock).mockReturnValue([]);
    vi.mocked(fs.realpathSync).mockImplementation((p) => p.toString());
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('isSafeMode()', () => {
    it('returns false by default', () => {
      const config = new Config(baseParams);
      expect(config.isSafeMode()).toBe(false);
    });

    it('returns true when safeMode param is true', () => {
      const config = new Config({ ...baseParams, safeMode: true });
      expect(config.isSafeMode()).toBe(true);
    });

    it('returns true when QWEN_CODE_SAFE_MODE=true', () => {
      process.env['QWEN_CODE_SAFE_MODE'] = 'true';
      const config = new Config(baseParams);
      expect(config.isSafeMode()).toBe(true);
    });

    it('returns true when QWEN_CODE_SAFE_MODE=1', () => {
      process.env['QWEN_CODE_SAFE_MODE'] = '1';
      const config = new Config(baseParams);
      expect(config.isSafeMode()).toBe(true);
    });

    it('returns false when QWEN_CODE_SAFE_MODE is set to other values', () => {
      process.env['QWEN_CODE_SAFE_MODE'] = 'false';
      const config = new Config(baseParams);
      expect(config.isSafeMode()).toBe(false);
    });

    it('explicit false param overrides env var (--no-safe-mode)', () => {
      process.env['QWEN_CODE_SAFE_MODE'] = 'true';
      const config = new Config({ ...baseParams, safeMode: false });
      expect(config.isSafeMode()).toBe(false);
    });

    it('undefined param falls through to env var', () => {
      process.env['QWEN_CODE_SAFE_MODE'] = 'true';
      const config = new Config({ ...baseParams, safeMode: undefined });
      expect(config.isSafeMode()).toBe(true);
    });
  });

  describe('safe mode disables subsystems', () => {
    it('disables all hooks in safe mode', () => {
      const config = new Config({ ...baseParams, safeMode: true });
      expect(config.getDisableAllHooks()).toBe(true);
    });

    it('disables managed auto memory in safe mode', () => {
      const config = new Config({
        ...baseParams,
        safeMode: true,
        enableManagedAutoMemory: true,
      });
      expect(config.getManagedAutoMemoryEnabled()).toBe(false);
    });

    it('disables managed auto dream in safe mode', () => {
      const config = new Config({
        ...baseParams,
        safeMode: true,
        enableManagedAutoDream: true,
      });
      expect(config.getManagedAutoDreamEnabled()).toBe(false);
    });

    it('disables auto skill in safe mode', () => {
      const config = new Config({
        ...baseParams,
        safeMode: true,
        enableAutoSkill: true,
      });
      expect(config.getAutoSkillEnabled()).toBe(false);
    });

    it('returns empty allowed HTTP hook URLs in safe mode', () => {
      const config = new Config({
        ...baseParams,
        safeMode: true,
        allowedHttpHookUrls: ['http://example.com/hook'],
      });
      expect(config.getAllowedHttpHookUrls()).toEqual([]);
    });
  });

  describe('safe mode blocks MCP servers', () => {
    it('should return empty MCP servers in safe mode', () => {
      const config = new Config({
        ...baseParams,
        safeMode: true,
        mcpServers: { test: { command: 'test', args: [] } },
      });
      expect(config.getMcpServers()).toEqual({});
    });
  });

  describe('safe mode skips context file loading', () => {
    it('sets empty user memory after refreshHierarchicalMemory', async () => {
      const config = new Config({ ...baseParams, safeMode: true });
      await config.initialize();
      expect(config.getUserMemory()).toBe('');
      expect(config.getGeminiMdFileCount()).toBe(0);
    });
  });
});
