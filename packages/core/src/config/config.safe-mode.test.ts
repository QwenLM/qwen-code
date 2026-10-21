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
import { recordStartupEvent } from '../utils/startupEventSink.js';
import { ToolNames } from '../tools/tool-names.js';
import { AuthType } from '../core/contentGenerator.js';

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
  ToolRegistryMock.prototype.unregisterTool = vi.fn();
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

  const safeConfig = (extra: Partial<ConfigParameters> = {}) =>
    new Config({ ...baseParams, safeMode: true, ...extra });

  async function initialized(params: Partial<ConfigParameters>) {
    const config = new Config({ ...baseParams, ...params });
    await config.initialize();
    return config;
  }

  describe('isSafeMode()', () => {
    it('returns false by default', () => {
      expect(new Config(baseParams).isSafeMode()).toBe(false);
    });

    it('returns true when safeMode param is true', () => {
      expect(safeConfig().isSafeMode()).toBe(true);
    });

    it('returns true when QWEN_CODE_SAFE_MODE=true', () => {
      process.env['QWEN_CODE_SAFE_MODE'] = 'true';
      expect(new Config(baseParams).isSafeMode()).toBe(true);
    });

    it('returns true when QWEN_CODE_SAFE_MODE=1', () => {
      process.env['QWEN_CODE_SAFE_MODE'] = '1';
      expect(new Config(baseParams).isSafeMode()).toBe(true);
    });

    it('returns false when QWEN_CODE_SAFE_MODE is set to other values', () => {
      process.env['QWEN_CODE_SAFE_MODE'] = 'false';
      expect(new Config(baseParams).isSafeMode()).toBe(false);
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
    it('does not register web search even when core Config could derive it', async () => {
      process.env['DASHSCOPE_API_KEY'] = 'sk-test';
      const config = await initialized({
        safeMode: true,
        authType: AuthType.USE_OPENAI,
        webSearch: { enabled: true, model: 'test-model' },
        modelProvidersConfig: {
          [AuthType.USE_OPENAI]: [
            {
              id: 'test-model',
              envKey: 'DASHSCOPE_API_KEY',
              baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            },
          ],
        },
      });
      const registry = config.getToolRegistry() as unknown as {
        registerFactory: Mock;
      };
      expect(
        registry.registerFactory.mock.calls.map(([name]) => name),
      ).not.toContain(ToolNames.WEB_SEARCH);
    });

    it('disables all hooks in safe mode', () => {
      expect(safeConfig().getDisableAllHooks()).toBe(true);
    });

    it('disables managed auto memory in safe mode', () => {
      const config = safeConfig({ enableManagedAutoMemory: true });
      expect(config.getManagedAutoMemoryEnabled()).toBe(false);
    });

    it('disables managed auto dream in safe mode', () => {
      const config = safeConfig({ enableManagedAutoDream: true });
      expect(config.getManagedAutoDreamEnabled()).toBe(false);
    });

    it('disables auto skill in safe mode', () => {
      const config = safeConfig({ enableAutoSkill: true });
      expect(config.getAutoSkillEnabled()).toBe(false);
    });

    it('returns empty allowed HTTP hook URLs in safe mode', () => {
      const config = safeConfig({
        allowedHttpHookUrls: ['http://example.com/hook'],
      });
      expect(config.getAllowedHttpHookUrls()).toEqual([]);
    });

    it('disables private network hooks in safe mode', () => {
      const config = safeConfig({ allowPrivateNetworkHooks: true });
      expect(config.getAllowPrivateNetworkHooks()).toBe(false);
    });
  });

  describe('safe mode blocks local/ambient MCP servers, preserves caller-supplied top-tier ones', () => {
    it('should return empty MCP servers in safe mode when nothing was supplied as top-tier', () => {
      const config = safeConfig({
        mcpServers: { test: { command: 'test', args: [] } },
      });
      expect(config.getMcpServers()).toEqual({});
    });

    it('should still return top-tier (ACP session/new / --mcp-config-supplied) MCP servers in safe mode', () => {
      // `mcpServers` stands in for the LOCAL/ambient map `loadCliConfig`
      // assembles from settings.json/.mcp.json — dropped under safe mode.
      // `topTierMcpServers` stands in for the caller's own explicit,
      // per-invocation request (ACP `session/new`, `--mcp-config`) — an
      // explicit argument, not ambient local state, so it survives.
      const config = safeConfig({
        mcpServers: { local: { command: 'local', args: [] } },
        topTierMcpServers: { probe: { command: 'probe', args: [] } },
      });
      expect(config.getMcpServers()).toEqual({
        probe: {
          command: 'probe',
          args: [],
        },
      });
    });

    it('still applies allowedMcpServers to top-tier servers in safe mode (Copilot review, PR #7827)', () => {
      // Safe mode is no exemption from a session's own
      // --allowed-mcp-server-names upper bound: a caller-supplied server
      // outside that allow-list is filtered out, exactly like the
      // non-safe-mode path a few lines below does.
      const config = safeConfig({
        allowedMcpServers: ['probe'],
        topTierMcpServers: {
          probe: { command: 'probe', args: [] },
          notAllowed: { command: 'not-allowed', args: [] },
        },
      });
      expect(config.getMcpServers()).toEqual({
        probe: {
          command: 'probe',
          args: [],
        },
      });
    });
  });

  describe('safe mode MCP discovery — a stranded-server regression (found live-testing PR #7827)', () => {
    // `getMcpServers()` reporting a top-tier server is not enough: something
    // must CONNECT to it and register its tools. That gate in `initialize()`
    // (`startMcpDiscoveryInBackground` behind `!this.isSafeMode()`) dates from
    // when safe mode's `getMcpServers()` was always `{}`, so discovery had
    // nothing to do. Unpatched, a caller-supplied top-tier server survived
    // `getMcpServers()` but was never discovered/connected — confirmed live
    // against a real ACP session (the agent reported the tool as
    // configured-but-absent).
    const discoverMock = (config: Config) =>
      (
        config.getToolRegistry() as unknown as {
          __mcpManagerMock: { discoverAllMcpToolsIncremental: Mock };
        }
      ).__mcpManagerMock.discoverAllMcpToolsIncremental;

    it('still kicks off background MCP discovery in safe mode when a top-tier server is present', async () => {
      const config = await initialized({
        safeMode: true,
        mcpServers: { local: { command: 'local', args: [] } },
        topTierMcpServers: { probe: { command: 'probe', args: [] } },
      });
      expect(discoverMock(config)).toHaveBeenCalledWith(config);
    });

    it('does not kick off background MCP discovery in safe mode when nothing was supplied (no wasted work)', async () => {
      const config = await initialized({
        safeMode: true,
        mcpServers: { local: { command: 'local', args: [] } },
      });
      expect(discoverMock(config)).not.toHaveBeenCalled();
    });

    it('does not kick off background MCP discovery in safe mode when the only top-tier server is filtered out by allowedMcpServers', async () => {
      const config = await initialized({
        safeMode: true,
        allowedMcpServers: ['nope'],
        topTierMcpServers: { probe: { command: 'probe', args: [] } },
      });
      expect(discoverMock(config)).not.toHaveBeenCalled();
    });

    // The safe-mode half of this gate (`!this.isSafeMode() || getMcpServers()
    // non-empty`) shipped first; the bare-mode half (`!this.getBareMode()`,
    // unconditional) was left unfixed although `loadCliConfig` feeds top-tier
    // servers into bare mode's `mcpServers` just as into safe mode's
    // `topTierMcpServers` (packages/cli/src/config/config.ts: `bareMode ||
    // safeMode ? { ...topTierMcpServers } : assembleMcpServers(...)`) — found
    // live-testing `qwen --bare --mcp-config`, same stranded-server symptom.
    // Bare mode has no `getMcpServers()`-level short-circuit: its "local
    // sources dropped" guarantee lives in that CLI assembly, so these tests
    // set `mcpServers` directly (what `loadCliConfig` produces before `Config`
    // is built), not `topTierMcpServers` (read only by the safe-mode branch).
    it('still kicks off background MCP discovery in bare mode when a top-tier server is present', async () => {
      const config = await initialized({
        bareMode: true,
        mcpServers: { probe: { command: 'probe', args: [] } },
      });
      expect(discoverMock(config)).toHaveBeenCalledWith(config);
    });

    it('does not kick off background MCP discovery in bare mode when nothing was supplied (no wasted work)', async () => {
      const config = await initialized({ bareMode: true });
      expect(discoverMock(config)).not.toHaveBeenCalled();
    });

    it('does not kick off background MCP discovery in bare mode when the only supplied server is filtered out by allowedMcpServers', async () => {
      const config = await initialized({
        bareMode: true,
        allowedMcpServers: ['nope'],
        mcpServers: { probe: { command: 'probe', args: [] } },
      });
      expect(discoverMock(config)).not.toHaveBeenCalled();
    });
  });

  describe('safe mode skips context file loading', () => {
    it('sets empty user memory after refreshHierarchicalMemory', async () => {
      const config = await initialized({ safeMode: true });
      expect(config.getUserMemory()).toBe('');
      expect(config.getAutoMemoryPrompt()).toBe('');
      expect(config.getMemoryFileCount()).toBe(0);
    });

    it('records every fixed Config startup phase in order when skipped', async () => {
      await initialized({ safeMode: true });

      const events = vi
        .mocked(recordStartupEvent)
        .mock.calls.map(([name]) => name)
        .filter((name) => name.startsWith('config_initialize_'));
      expect(events).toEqual([
        'config_initialize_extensions_initial_start',
        'config_initialize_extensions_initial_end',
        'config_initialize_hooks_start',
        'config_initialize_hooks_end',
        'config_initialize_skills_start',
        'config_initialize_skills_end',
        'config_initialize_extensions_final_start',
        'config_initialize_extensions_final_end',
        'config_initialize_hierarchical_memory_start',
        'config_initialize_hierarchical_memory_end',
        'config_initialize_tool_registry_start',
        'config_initialize_ripgrep_probe_start',
        'config_initialize_ripgrep_probe_end',
        'config_initialize_tool_registry_end',
        'config_initialize_tool_warmup_start',
        'config_initialize_tool_warmup_end',
      ]);
    });
  });
});
