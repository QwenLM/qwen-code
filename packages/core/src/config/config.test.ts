/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import type { ConfigParameters, SandboxConfig } from './config.js';
import { Config, ApprovalMode } from './config.js';
import * as path from 'node:path';
import { setGeminiMdFilename as mockSetGeminiMdFilename } from '../tools/memoryTool.js';
import {
  DEFAULT_TELEMETRY_TARGET,
  DEFAULT_OTLP_ENDPOINT,
  QwenLogger,
} from '../telemetry/index.js';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../core/contentGenerator.js';
import { DEFAULT_DASHSCOPE_BASE_URL } from '../core/openaiContentGenerator/constants.js';
import {
  AuthType,
  createContentGenerator,
  createContentGeneratorConfig,
  resolveContentGeneratorConfigWithSources,
} from '../core/contentGenerator.js';
import { GeminiClient } from '../core/client.js';
import { GitService } from '../services/gitService.js';
import { ShellTool } from '../tools/shell.js';
import { ReadFileTool } from '../tools/read-file.js';
import { GrepTool } from '../tools/grep.js';
import { canUseRipgrep } from '../utils/ripgrepUtils.js';
import { RipGrepTool } from '../tools/ripGrep.js';
import { logRipgrepFallback } from '../telemetry/loggers.js';
import { RipgrepFallbackEvent } from '../telemetry/types.js';
import { ToolRegistry } from '../tools/tool-registry.js';

function createToolMock(toolName: string) {
  const ToolMock = vi.fn();
  Object.defineProperty(ToolMock, 'Name', {
    value: toolName,
    writable: true,
  });
  return ToolMock;
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const mocked = {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    statSync: vi.fn().mockReturnValue({
      isDirectory: vi.fn().mockReturnValue(true),
    }),
    realpathSync: vi.fn((path) => path),
  };
  return {
    ...mocked,
    default: mocked, // Required for ESM default imports (import fs from 'node:fs')
  };
});

// Mock dependencies that might be called during Config construction or createServerConfig
vi.mock('../tools/tool-registry', () => {
  const ToolRegistryMock = vi.fn();
  ToolRegistryMock.prototype.registerTool = vi.fn();
  ToolRegistryMock.prototype.discoverAllTools = vi.fn();
  ToolRegistryMock.prototype.getAllTools = vi.fn(() => []); // Mock methods if needed
  ToolRegistryMock.prototype.getAllToolNames = vi.fn(() => []);
  ToolRegistryMock.prototype.getTool = vi.fn();
  ToolRegistryMock.prototype.getFunctionDeclarations = vi.fn(() => []);
  return { ToolRegistry: ToolRegistryMock };
});

vi.mock('../utils/memoryDiscovery.js', () => ({
  loadServerHierarchicalMemory: vi
    .fn()
    .mockResolvedValue({ memoryContent: '', fileCount: 0 }),
}));

// Mock individual tools if their constructors are complex or have side effects
vi.mock('../tools/ls', () => ({
  LSTool: createToolMock('list_directory'),
}));
vi.mock('../tools/read-file', () => ({
  ReadFileTool: createToolMock('read_file'),
}));
vi.mock('../tools/grep.js', () => ({
  GrepTool: createToolMock('grep_search'),
}));
vi.mock('../tools/ripGrep.js', () => ({
  RipGrepTool: createToolMock('grep_search'),
}));
vi.mock('../utils/ripgrepUtils.js', () => ({
  canUseRipgrep: vi.fn(),
}));
vi.mock('../tools/glob', () => ({
  GlobTool: createToolMock('glob'),
}));
vi.mock('../tools/edit', () => ({
  EditTool: createToolMock('edit'),
}));
vi.mock('../tools/shell', () => ({
  ShellTool: createToolMock('run_shell_command'),
}));
vi.mock('../tools/write-file', () => ({
  WriteFileTool: createToolMock('write_file'),
}));
vi.mock('../tools/web-fetch', () => ({
  WebFetchTool: createToolMock('web_fetch'),
}));
vi.mock('../tools/read-many-files', () => ({
  ReadManyFilesTool: createToolMock('read_many_files'),
}));
vi.mock('../tools/memoryTool', () => ({
  MemoryTool: createToolMock('save_memory'),
  setGeminiMdFilename: vi.fn(),
  getCurrentGeminiMdFilename: vi.fn(() => 'QWEN.md'), // Mock the original filename
  DEFAULT_CONTEXT_FILENAME: 'QWEN.md',
  QWEN_CONFIG_DIR: '.qwen',
}));

vi.mock('../core/contentGenerator.js');

vi.mock('../core/client.js', () => ({
  GeminiClient: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    isInitialized: vi.fn().mockReturnValue(true),
    stripThoughtsFromHistory: vi.fn(),
    setTools: vi.fn(),
  })),
}));

vi.mock('../telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../telemetry/index.js')>();
  return {
    ...actual,
    initializeTelemetry: vi.fn(),
    uiTelemetryService: {
      getLastPromptTokenCount: vi.fn(),
    },
  };
});

vi.mock('../telemetry/loggers.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../telemetry/loggers.js')>();
  return {
    ...actual,
    logRipgrepFallback: vi.fn(),
  };
});

vi.mock('../services/gitService.js', () => {
  const GitServiceMock = vi.fn();
  GitServiceMock.prototype.initialize = vi.fn();
  return { GitService: GitServiceMock };
});

vi.mock('../skills/skill-manager.js', () => {
  const SkillManagerMock = vi.fn();
  SkillManagerMock.prototype.startWatching = vi
    .fn()
    .mockResolvedValue(undefined);
  SkillManagerMock.prototype.stopWatching = vi.fn();
  return { SkillManager: SkillManagerMock };
});

vi.mock('../subagents/subagent-manager.js', () => {
  const SubagentManagerMock = vi.fn();
  SubagentManagerMock.prototype.loadSessionSubagents = vi.fn();
  SubagentManagerMock.prototype.addChangeListener = vi
    .fn()
    .mockReturnValue(() => {});
  SubagentManagerMock.prototype.listSubagents = vi.fn().mockResolvedValue([]);
  return { SubagentManager: SubagentManagerMock };
});

vi.mock('../ide/ide-client.js', () => ({
  IdeClient: {
    getInstance: vi.fn().mockResolvedValue({
      getConnectionStatus: vi.fn(),
      initialize: vi.fn(),
      shutdown: vi.fn(),
    }),
  },
}));

import { BaseLlmClient } from '../core/baseLlmClient.js';

vi.mock('../core/baseLlmClient.js');

describe('Server Config (config.ts)', () => {
  const MODEL = 'qwen3-coder-plus';

  // Default mock for canUseRipgrep to return true (tests that care about ripgrep will override this)
  beforeEach(() => {
    vi.mocked(canUseRipgrep).mockResolvedValue(true);
  });
  const SANDBOX: SandboxConfig = {
    command: 'docker',
    image: 'qwen-code-sandbox',
  };
  const TARGET_DIR = '/path/to/target';
  const DEBUG_MODE = false;
  const QUESTION = 'test question';
  const FULL_CONTEXT = false;
  const USER_MEMORY = 'Test User Memory';
  const TELEMETRY_SETTINGS = { enabled: false };
  const EMBEDDING_MODEL = 'gemini-embedding';
  const baseParams: ConfigParameters = {
    cwd: '/tmp',
    embeddingModel: EMBEDDING_MODEL,
    sandbox: SANDBOX,
    targetDir: TARGET_DIR,
    debugMode: DEBUG_MODE,
    question: QUESTION,
    fullContext: FULL_CONTEXT,
    userMemory: USER_MEMORY,
    telemetry: TELEMETRY_SETTINGS,
    model: MODEL,
    usageStatisticsEnabled: false,
    overrideExtensions: [],
  };

  beforeEach(() => {
    // Reset mocks if necessary
    vi.clearAllMocks();
    vi.spyOn(QwenLogger.prototype, 'logStartSessionEvent').mockImplementation(
      async () => undefined,
    );

    // Setup default mock for resolveContentGeneratorConfigWithSources
    vi.mocked(resolveContentGeneratorConfigWithSources).mockImplementation(
      (_config, authType, generationConfig) => ({
        config: {
          ...generationConfig,
          authType,
          model: generationConfig?.model || MODEL,
          apiKey: 'test-key',
        } as ContentGeneratorConfig,
        sources: {},
      }),
    );
  });

  describe('initialize', () => {
    it('should throw an error if checkpointing is enabled and GitService fails', async () => {
      const gitError = new Error('Git is not installed');
      (GitService.prototype.initialize as Mock).mockRejectedValue(gitError);

      const config = new Config({
        ...baseParams,
        checkpointing: true,
      });

      await expect(config.initialize()).rejects.toThrow(gitError);
    });

    it('should not throw an error if checkpointing is disabled and GitService fails', async () => {
      const gitError = new Error('Git is not installed');
      (GitService.prototype.initialize as Mock).mockRejectedValue(gitError);

      const config = new Config({
        ...baseParams,
        checkpointing: false,
      });

      await expect(config.initialize()).resolves.toBeUndefined();
    });

    it('should throw an error if initialized more than once', async () => {
      const config = new Config({
        ...baseParams,
        checkpointing: false,
      });

      await expect(config.initialize()).resolves.toBeUndefined();
      await expect(config.initialize()).rejects.toThrow(
        'Config was already initialized',
      );
    });
  });

  describe('refreshAuth', () => {
    it('should refresh auth and update config', async () => {
      const config = new Config(baseParams);
      const authType = AuthType.USE_GEMINI;
      const mockContentConfig = {
        apiKey: 'test-key',
        model: 'qwen3-coder-plus',
        authType,
      };

      vi.mocked(resolveContentGeneratorConfigWithSources).mockReturnValue({
        config: mockContentConfig as ContentGeneratorConfig,
        sources: {},
      });

      await config.refreshAuth(authType);

      expect(resolveContentGeneratorConfigWithSources).toHaveBeenCalledWith(
        config,
        authType,
        expect.objectContaining({
          model: MODEL,
        }),
        expect.anything(),
        expect.anything(),
      );
      // Verify that contentGeneratorConfig is updated
      expect(config.getContentGeneratorConfig()).toEqual(mockContentConfig);
      expect(GeminiClient).toHaveBeenCalledWith(config);
    });

    it('should not strip thoughts when switching from Vertex to GenAI', async () => {
      const config = new Config(baseParams);

      vi.mocked(createContentGeneratorConfig).mockImplementation(
        (_: Config, authType: AuthType | undefined) =>
          ({ authType }) as unknown as ContentGeneratorConfig,
      );

      await config.refreshAuth(AuthType.USE_VERTEX_AI);

      await config.refreshAuth(AuthType.USE_GEMINI);

      expect(
        config.getGeminiClient().stripThoughtsFromHistory,
      ).not.toHaveBeenCalledWith();
    });
  });

  describe('model switching optimization (QWEN_OAUTH)', () => {
    it('should switch qwen-oauth model in-place without refreshing auth when safe', async () => {
      const config = new Config(baseParams);

      const mockContentConfig: ContentGeneratorConfig = {
        authType: AuthType.QWEN_OAUTH,
        model: 'coder-model',
        apiKey: 'QWEN_OAUTH_DYNAMIC_TOKEN',
        baseUrl: DEFAULT_DASHSCOPE_BASE_URL,
        timeout: 60000,
        maxRetries: 3,
      } as ContentGeneratorConfig;

      vi.mocked(resolveContentGeneratorConfigWithSources).mockImplementation(
        (_config, authType, generationConfig) => ({
          config: {
            ...mockContentConfig,
            authType,
            model: generationConfig?.model ?? mockContentConfig.model,
          } as ContentGeneratorConfig,
          sources: {},
        }),
      );
      vi.mocked(createContentGenerator).mockResolvedValue({
        generateContent: vi.fn(),
        generateContentStream: vi.fn(),
        countTokens: vi.fn(),
        embedContent: vi.fn(),
      } as unknown as ContentGenerator);

      // Establish initial qwen-oauth content generator config/content generator.
      await config.refreshAuth(AuthType.QWEN_OAUTH);

      // Spy after initial refresh to ensure model switch does not re-trigger refreshAuth.
      const refreshSpy = vi.spyOn(config, 'refreshAuth');

      await config.switchModel(AuthType.QWEN_OAUTH, 'vision-model');

      expect(config.getModel()).toBe('vision-model');
      expect(refreshSpy).not.toHaveBeenCalled();
      // Called once during initial refreshAuth + once during handleModelChange diffing.
      expect(
        vi.mocked(resolveContentGeneratorConfigWithSources),
      ).toHaveBeenCalledTimes(2);
      expect(vi.mocked(createContentGenerator)).toHaveBeenCalledTimes(1);
    });
  });

  describe('model switching with different credentials (OpenAI)', () => {
    it('should refresh auth when switching to model with different envKey', async () => {
      // This test verifies the fix for switching between modelProvider models
      // with different envKeys (e.g., deepseek-chat with DEEPSEEK_API_KEY)
      const configWithModelProviders = new Config({
        ...baseParams,
        authType: AuthType.USE_OPENAI,
        modelProvidersConfig: {
          openai: [
            {
              id: 'model-a',
              name: 'Model A',
              baseUrl: 'https://api.example.com/v1',
              envKey: 'API_KEY_A',
            },
            {
              id: 'model-b',
              name: 'Model B',
              baseUrl: 'https://api.example.com/v1',
              envKey: 'API_KEY_B',
            },
          ],
        },
      });

      const mockContentConfigA: ContentGeneratorConfig = {
        authType: AuthType.USE_OPENAI,
        model: 'model-a',
        apiKey: 'key-a',
        baseUrl: 'https://api.example.com/v1',
      } as ContentGeneratorConfig;

      const mockContentConfigB: ContentGeneratorConfig = {
        authType: AuthType.USE_OPENAI,
        model: 'model-b',
        apiKey: 'key-b',
        baseUrl: 'https://api.example.com/v1',
      } as ContentGeneratorConfig;

      vi.mocked(resolveContentGeneratorConfigWithSources).mockImplementation(
        (_config, _authType, generationConfig) => {
          const model = generationConfig?.model;
          return {
            config:
              model === 'model-b' ? mockContentConfigB : mockContentConfigA,
            sources: {},
          };
        },
      );

      vi.mocked(createContentGenerator).mockResolvedValue({
        generateContent: vi.fn(),
        generateContentStream: vi.fn(),
        countTokens: vi.fn(),
        embedContent: vi.fn(),
      } as unknown as ContentGenerator);

      // Initialize with model-a
      await configWithModelProviders.refreshAuth(AuthType.USE_OPENAI);

      // Spy on refreshAuth to verify it's called when switching to model-b
      const refreshSpy = vi.spyOn(configWithModelProviders, 'refreshAuth');

      // Switch to model-b (different envKey)
      await configWithModelProviders.switchModel(
        AuthType.USE_OPENAI,
        'model-b',
      );

      // Should trigger full refresh because envKey changed
      expect(refreshSpy).toHaveBeenCalledWith(AuthType.USE_OPENAI);
      expect(configWithModelProviders.getModel()).toBe('model-b');
    });
  });

  it('Config constructor should store userMemory correctly', () => {
    const config = new Config(baseParams);

    expect(config.getUserMemory()).toBe(USER_MEMORY);
    // Verify other getters if needed
    expect(config.getTargetDir()).toBe(path.resolve(TARGET_DIR)); // Check resolved path
  });

  it('Config constructor should default userMemory to empty string if not provided', () => {
    const paramsWithoutMemory: ConfigParameters = { ...baseParams };
    delete paramsWithoutMemory.userMemory;
    const config = new Config(paramsWithoutMemory);

    expect(config.getUserMemory()).toBe('');
  });

  it('Config constructor should call setGeminiMdFilename with contextFileName if provided', () => {
    const contextFileName = 'CUSTOM_AGENTS.md';
    const paramsWithContextFile: ConfigParameters = {
      ...baseParams,
      contextFileName,
    };
    new Config(paramsWithContextFile);
    expect(mockSetGeminiMdFilename).toHaveBeenCalledWith(contextFileName);
  });

  it('Config constructor should not call setGeminiMdFilename if contextFileName is not provided', () => {
    new Config(baseParams); // baseParams does not have contextFileName
    expect(mockSetGeminiMdFilename).not.toHaveBeenCalled();
  });

  it('should set default file filtering settings when not provided', () => {
    const config = new Config(baseParams);
    expect(config.getFileFilteringRespectGitIgnore()).toBe(true);
  });

  it('should set custom file filtering settings when provided', () => {
    const paramsWithFileFiltering: ConfigParameters = {
      ...baseParams,
      fileFiltering: {
        respectGitIgnore: false,
      },
    };
    const config = new Config(paramsWithFileFiltering);
    expect(config.getFileFilteringRespectGitIgnore()).toBe(false);
  });

  it('should initialize WorkspaceContext with includeDirectories', () => {
    const includeDirectories = ['/path/to/dir1', '/path/to/dir2'];
    const paramsWithIncludeDirs: ConfigParameters = {
      ...baseParams,
      includeDirectories,
    };
    const config = new Config(paramsWithIncludeDirs);
    const workspaceContext = config.getWorkspaceContext();
    const directories = workspaceContext.getDirectories();

    // Should include the target directory plus the included directories
    expect(directories).toHaveLength(3);
    expect(directories).toContain(path.resolve(baseParams.targetDir));
    expect(directories).toContain('/path/to/dir1');
    expect(directories).toContain('/path/to/dir2');
  });

  it('Config constructor should set telemetry to true when provided as true', () => {
    const paramsWithTelemetry: ConfigParameters = {
      ...baseParams,
      telemetry: { enabled: true },
    };
    const config = new Config(paramsWithTelemetry);
    expect(config.getTelemetryEnabled()).toBe(true);
  });

  it('Config constructor should set telemetry to false when provided as false', () => {
    const paramsWithTelemetry: ConfigParameters = {
      ...baseParams,
      telemetry: { enabled: false },
    };
    const config = new Config(paramsWithTelemetry);
    expect(config.getTelemetryEnabled()).toBe(false);
  });

  it('Config constructor should default telemetry to default value if not provided', () => {
    const paramsWithoutTelemetry: ConfigParameters = { ...baseParams };
    delete paramsWithoutTelemetry.telemetry;
    const config = new Config(paramsWithoutTelemetry);
    expect(config.getTelemetryEnabled()).toBe(TELEMETRY_SETTINGS.enabled);
  });

  it('Config constructor should set telemetry useCollector to true when provided', () => {
    const paramsWithTelemetry: ConfigParameters = {
      ...baseParams,
      telemetry: { enabled: true, useCollector: true },
    };
    const config = new Config(paramsWithTelemetry);
    expect(config.getTelemetryUseCollector()).toBe(true);
  });

  it('Config constructor should set telemetry useCollector to false when provided', () => {
    const paramsWithTelemetry: ConfigParameters = {
      ...baseParams,
      telemetry: { enabled: true, useCollector: false },
    };
    const config = new Config(paramsWithTelemetry);
    expect(config.getTelemetryUseCollector()).toBe(false);
  });

  it('Config constructor should default telemetry useCollector to false if not provided', () => {
    const paramsWithTelemetry: ConfigParameters = {
      ...baseParams,
      telemetry: { enabled: true },
    };
    const config = new Config(paramsWithTelemetry);
    expect(config.getTelemetryUseCollector()).toBe(false);
  });

  it('should have a getFileService method that returns FileDiscoveryService', () => {
    const config = new Config(baseParams);
    const fileService = config.getFileService();
    expect(fileService).toBeDefined();
  });

  describe('Usage Statistics', () => {
    it('defaults usage statistics to enabled if not specified', () => {
      const config = new Config({
        ...baseParams,
        usageStatisticsEnabled: undefined,
      });

      expect(config.getUsageStatisticsEnabled()).toBe(true);
    });

    it.each([{ enabled: true }, { enabled: false }])(
      'sets usage statistics based on the provided value (enabled: $enabled)',
      ({ enabled }) => {
        const config = new Config({
          ...baseParams,
          usageStatisticsEnabled: enabled,
        });
        expect(config.getUsageStatisticsEnabled()).toBe(enabled);
      },
    );

    it('logs the session start event', async () => {
      const config = new Config({
        ...baseParams,
        usageStatisticsEnabled: true,
      });
      await config.initialize();

      expect(QwenLogger.prototype.logStartSessionEvent).toHaveBeenCalledOnce();
    });
  });

  describe('Telemetry Settings', () => {
    it('should return default telemetry target if not provided', () => {
      const params: ConfigParameters = {
        ...baseParams,
        telemetry: { enabled: true },
      };
      const config = new Config(params);
      expect(config.getTelemetryTarget()).toBe(DEFAULT_TELEMETRY_TARGET);
    });

    it('should return provided OTLP endpoint', () => {
      const endpoint = 'http://custom.otel.collector:4317';
      const params: ConfigParameters = {
        ...baseParams,
        telemetry: { enabled: true, otlpEndpoint: endpoint },
      };
      const config = new Config(params);
      expect(config.getTelemetryOtlpEndpoint()).toBe(endpoint);
    });

    it('should return default OTLP endpoint if not provided', () => {
      const params: ConfigParameters = {
        ...baseParams,
        telemetry: { enabled: true },
      };
      const config = new Config(params);
      expect(config.getTelemetryOtlpEndpoint()).toBe(DEFAULT_OTLP_ENDPOINT);
    });

    it('should return provided logPrompts setting', () => {
      const params: ConfigParameters = {
        ...baseParams,
        telemetry: { enabled: true, logPrompts: false },
      };
      const config = new Config(params);
      expect(config.getTelemetryLogPromptsEnabled()).toBe(false);
    });

    it('should return default logPrompts setting (true) if not provided', () => {
      const params: ConfigParameters = {
        ...baseParams,
        telemetry: { enabled: true },
      };
      const config = new Config(params);
      expect(config.getTelemetryLogPromptsEnabled()).toBe(true);
    });

    it('should return default logPrompts setting (true) if telemetry object is not provided', () => {
      const paramsWithoutTelemetry: ConfigParameters = { ...baseParams };
      delete paramsWithoutTelemetry.telemetry;
      const config = new Config(paramsWithoutTelemetry);
      expect(config.getTelemetryLogPromptsEnabled()).toBe(true);
    });

    it('should return default telemetry target if telemetry object is not provided', () => {
      const paramsWithoutTelemetry: ConfigParameters = { ...baseParams };
      delete paramsWithoutTelemetry.telemetry;
      const config = new Config(paramsWithoutTelemetry);
      expect(config.getTelemetryTarget()).toBe(DEFAULT_TELEMETRY_TARGET);
    });

    it('should return default OTLP endpoint if telemetry object is not provided', () => {
      const paramsWithoutTelemetry: ConfigParameters = { ...baseParams };
      delete paramsWithoutTelemetry.telemetry;
      const config = new Config(paramsWithoutTelemetry);
      expect(config.getTelemetryOtlpEndpoint()).toBe(DEFAULT_OTLP_ENDPOINT);
    });

    it('should return provided OTLP protocol', () => {
      const params: ConfigParameters = {
        ...baseParams,
        telemetry: { enabled: true, otlpProtocol: 'http' },
      };
      const config = new Config(params);
      expect(config.getTelemetryOtlpProtocol()).toBe('http');
    });

    it('should return default OTLP protocol if not provided', () => {
      const params: ConfigParameters = {
        ...baseParams,
        telemetry: { enabled: true },
      };
      const config = new Config(params);
      expect(config.getTelemetryOtlpProtocol()).toBe('grpc');
    });

    it('should return default OTLP protocol if telemetry object is not provided', () => {
      const paramsWithoutTelemetry: ConfigParameters = { ...baseParams };
      delete paramsWithoutTelemetry.telemetry;
      const config = new Config(paramsWithoutTelemetry);
      expect(config.getTelemetryOtlpProtocol()).toBe('grpc');
    });
  });

  describe('UseRipgrep Configuration', () => {
    it('should default useRipgrep to true when not provided', () => {
      const config = new Config(baseParams);
      expect(config.getUseRipgrep()).toBe(true);
    });

    it('should set useRipgrep to false when provided as false', () => {
      const paramsWithRipgrep: ConfigParameters = {
        ...baseParams,
        useRipgrep: false,
      };
      const config = new Config(paramsWithRipgrep);
      expect(config.getUseRipgrep()).toBe(false);
    });

    it('should set useRipgrep to true when explicitly provided as true', () => {
      const paramsWithRipgrep: ConfigParameters = {
        ...baseParams,
        useRipgrep: true,
      };
      const config = new Config(paramsWithRipgrep);
      expect(config.getUseRipgrep()).toBe(true);
    });

    it('should default useRipgrep to true when undefined', () => {
      const paramsWithUndefinedRipgrep: ConfigParameters = {
        ...baseParams,
        useRipgrep: undefined,
      };
      const config = new Config(paramsWithUndefinedRipgrep);
      expect(config.getUseRipgrep()).toBe(true);
    });
  });

  describe('UseBuiltinRipgrep Configuration', () => {
    it('should default useBuiltinRipgrep to true when not provided', () => {
      const config = new Config(baseParams);
      expect(config.getUseBuiltinRipgrep()).toBe(true);
    });

    it('should set useBuiltinRipgrep to false when provided as false', () => {
      const paramsWithBuiltinRipgrep: ConfigParameters = {
        ...baseParams,
        useBuiltinRipgrep: false,
      };
      const config = new Config(paramsWithBuiltinRipgrep);
      expect(config.getUseBuiltinRipgrep()).toBe(false);
    });

    it('should set useBuiltinRipgrep to true when explicitly provided as true', () => {
      const paramsWithBuiltinRipgrep: ConfigParameters = {
        ...baseParams,
        useBuiltinRipgrep: true,
      };
      const config = new Config(paramsWithBuiltinRipgrep);
      expect(config.getUseBuiltinRipgrep()).toBe(true);
    });

    it('should default useBuiltinRipgrep to true when undefined', () => {
      const paramsWithUndefinedBuiltinRipgrep: ConfigParameters = {
        ...baseParams,
        useBuiltinRipgrep: undefined,
      };
      const config = new Config(paramsWithUndefinedBuiltinRipgrep);
      expect(config.getUseBuiltinRipgrep()).toBe(true);
    });
  });

  describe('createToolRegistry', () => {
    it('should register a tool if coreTools contains an argument-specific pattern', async () => {
      const params: ConfigParameters = {
        ...baseParams,
        coreTools: ['Shell(git status)'], // Use display name instead of class name
      };
      const config = new Config(params);
      await config.initialize();

      // The ToolRegistry class is mocked, so we can inspect its prototype's methods.
      const registerToolMock = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: { prototype: { registerTool: Mock } };
        }
      ).ToolRegistry.prototype.registerTool;

      // Check that registerTool was called for ShellTool
      const wasShellToolRegistered = (registerToolMock as Mock).mock.calls.some(
        (call) => call[0] instanceof vi.mocked(ShellTool),
      );
      expect(wasShellToolRegistered).toBe(true);

      // Check that registerTool was NOT called for ReadFileTool
      const wasReadFileToolRegistered = (
        registerToolMock as Mock
      ).mock.calls.some((call) => call[0] instanceof vi.mocked(ReadFileTool));
      expect(wasReadFileToolRegistered).toBe(false);
    });

    it('should register a tool if coreTools contains the displayName', async () => {
      const params: ConfigParameters = {
        ...baseParams,
        coreTools: ['Shell'],
      };
      const config = new Config(params);
      await config.initialize();

      const registerToolMock = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: { prototype: { registerTool: Mock } };
        }
      ).ToolRegistry.prototype.registerTool;

      const wasShellToolRegistered = (registerToolMock as Mock).mock.calls.some(
        (call) => call[0] instanceof vi.mocked(ShellTool),
      );
      expect(wasShellToolRegistered).toBe(true);
    });

    it('should register a tool if coreTools contains the displayName with argument-specific pattern', async () => {
      const params: ConfigParameters = {
        ...baseParams,
        coreTools: ['Shell(git status)'],
      };
      const config = new Config(params);
      await config.initialize();

      const registerToolMock = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: { prototype: { registerTool: Mock } };
        }
      ).ToolRegistry.prototype.registerTool;

      const wasShellToolRegistered = (registerToolMock as Mock).mock.calls.some(
        (call) => call[0] instanceof vi.mocked(ShellTool),
      );
      expect(wasShellToolRegistered).toBe(true);
    });

    it('should register a tool if coreTools contains a legacy tool name alias', async () => {
      const params: ConfigParameters = {
        ...baseParams,
        useRipgrep: false,
        coreTools: ['search_file_content'],
      };
      const config = new Config(params);
      await config.initialize();

      const registerToolMock = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: { prototype: { registerTool: Mock } };
        }
      ).ToolRegistry.prototype.registerTool;

      const wasGrepToolRegistered = (registerToolMock as Mock).mock.calls.some(
        (call) => call[0] instanceof vi.mocked(GrepTool),
      );
      expect(wasGrepToolRegistered).toBe(true);
    });

    it('should not register a tool if excludeTools contains a legacy display name alias', async () => {
      const params: ConfigParameters = {
        ...baseParams,
        useRipgrep: false,
        coreTools: undefined,
        excludeTools: ['SearchFiles'],
      };
      const config = new Config(params);
      await config.initialize();

      const registerToolMock = (
        (await vi.importMock('../tools/tool-registry')) as {
          ToolRegistry: { prototype: { registerTool: Mock } };
        }
      ).ToolRegistry.prototype.registerTool;

      const wasGrepToolRegistered = (registerToolMock as Mock).mock.calls.some(
        (call) => call[0] instanceof vi.mocked(GrepTool),
      );
      expect(wasGrepToolRegistered).toBe(false);
    });

    describe('with minified tool class names', () => {
      beforeEach(() => {
        Object.defineProperty(
          vi.mocked(ShellTool).prototype.constructor,
          'name',
          {
            value: '_ShellTool',
            configurable: true,
          },
        );
      });

      afterEach(() => {
        Object.defineProperty(
          vi.mocked(ShellTool).prototype.constructor,
          'name',
          {
            value: 'ShellTool',
          },
        );
      });

      it('should register a tool if coreTools contains the non-minified class name', async () => {
        const params: ConfigParameters = {
          ...baseParams,
          coreTools: ['Shell'], // Use display name instead of class name
        };
        const config = new Config(params);
        await config.initialize();

        const registerToolMock = (
          (await vi.importMock('../tools/tool-registry')) as {
            ToolRegistry: { prototype: { registerTool: Mock } };
          }
        ).ToolRegistry.prototype.registerTool;

        const wasShellToolRegistered = (
          registerToolMock as Mock
        ).mock.calls.some((call) => call[0] instanceof vi.mocked(ShellTool));
        expect(wasShellToolRegistered).toBe(true);
      });

      it('should register a tool if coreTools contains the displayName', async () => {
        const params: ConfigParameters = {
          ...baseParams,
          coreTools: ['Shell'],
        };
        const config = new Config(params);
        await config.initialize();

        const registerToolMock = (
          (await vi.importMock('../tools/tool-registry')) as {
            ToolRegistry: { prototype: { registerTool: Mock } };
          }
        ).ToolRegistry.prototype.registerTool;

        const wasShellToolRegistered = (
          registerToolMock as Mock
        ).mock.calls.some((call) => call[0] instanceof vi.mocked(ShellTool));
        expect(wasShellToolRegistered).toBe(true);
      });

      it('should not register a tool if excludeTools contains the non-minified class name', async () => {
        const params: ConfigParameters = {
          ...baseParams,
          coreTools: undefined, // all tools enabled by default
          excludeTools: ['Shell'], // Use display name instead of class name
        };
        const config = new Config(params);
        await config.initialize();

        const registerToolMock = (
          (await vi.importMock('../tools/tool-registry')) as {
            ToolRegistry: { prototype: { registerTool: Mock } };
          }
        ).ToolRegistry.prototype.registerTool;

        const wasShellToolRegistered = (
          registerToolMock as Mock
        ).mock.calls.some((call) => call[0] instanceof vi.mocked(ShellTool));
        expect(wasShellToolRegistered).toBe(false);
      });

      it('should not register a tool if excludeTools contains the displayName', async () => {
        const params: ConfigParameters = {
          ...baseParams,
          coreTools: undefined, // all tools enabled by default
          excludeTools: ['Shell'],
        };
        const config = new Config(params);
        await config.initialize();

        const registerToolMock = (
          (await vi.importMock('../tools/tool-registry')) as {
            ToolRegistry: { prototype: { registerTool: Mock } };
          }
        ).ToolRegistry.prototype.registerTool;

        const wasShellToolRegistered = (
          registerToolMock as Mock
        ).mock.calls.some((call) => call[0] instanceof vi.mocked(ShellTool));
        expect(wasShellToolRegistered).toBe(false);
      });

      it('should register a tool if coreTools contains an argument-specific pattern with the non-minified class name', async () => {
        const params: ConfigParameters = {
          ...baseParams,
          coreTools: ['Shell(git status)'], // Use display name instead of class name
        };
        const config = new Config(params);
        await config.initialize();

        const registerToolMock = (
          (await vi.importMock('../tools/tool-registry')) as {
            ToolRegistry: { prototype: { registerTool: Mock } };
          }
        ).ToolRegistry.prototype.registerTool;

        const wasShellToolRegistered = (
          registerToolMock as Mock
        ).mock.calls.some((call) => call[0] instanceof vi.mocked(ShellTool));
        expect(wasShellToolRegistered).toBe(true);
      });

      it('should register a tool if coreTools contains an argument-specific pattern with the displayName', async () => {
        const params: ConfigParameters = {
          ...baseParams,
          coreTools: ['Shell(git status)'],
        };
        const config = new Config(params);
        await config.initialize();

        const registerToolMock = (
          (await vi.importMock('../tools/tool-registry')) as {
            ToolRegistry: { prototype: { registerTool: Mock } };
          }
        ).ToolRegistry.prototype.registerTool;

        const wasShellToolRegistered = (
          registerToolMock as Mock
        ).mock.calls.some((call) => call[0] instanceof vi.mocked(ShellTool));
        expect(wasShellToolRegistered).toBe(true);
      });
    });
  });

  describe('getTruncateToolOutputThreshold', () => {
    it('should return the default threshold', () => {
      const config = new Config(baseParams);
      expect(config.getTruncateToolOutputThreshold()).toBe(25_000);
    });

    it('should use a custom truncateToolOutputThreshold if provided', () => {
      const customParams = {
        ...baseParams,
        truncateToolOutputThreshold: 50000,
      };
      const config = new Config(customParams);
      expect(config.getTruncateToolOutputThreshold()).toBe(50000);
    });

    it('should return infinity when truncation is disabled', () => {
      const customParams = {
        ...baseParams,
        enableToolOutputTruncation: false,
      };
      const config = new Config(customParams);
      expect(config.getTruncateToolOutputThreshold()).toBe(
        Number.POSITIVE_INFINITY,
      );
    });
  });
});

describe('setApprovalMode with folder trust', () => {
  const baseParams: ConfigParameters = {
    targetDir: '.',
    debugMode: false,
    model: 'test-model',
    cwd: '.',
  };

  it('should throw an error when setting YOLO mode in an untrusted folder', () => {
    const config = new Config(baseParams);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(false);
    expect(() => config.setApprovalMode(ApprovalMode.YOLO)).toThrow(
      'Cannot enable privileged approval modes in an untrusted folder.',
    );
  });

  it('should throw an error when setting AUTO_EDIT mode in an untrusted folder', () => {
    const config = new Config(baseParams);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(false);
    expect(() => config.setApprovalMode(ApprovalMode.AUTO_EDIT)).toThrow(
      'Cannot enable privileged approval modes in an untrusted folder.',
    );
  });

  it('should NOT throw an error when setting DEFAULT mode in an untrusted folder', () => {
    const config = new Config(baseParams);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(false);
    expect(() => config.setApprovalMode(ApprovalMode.DEFAULT)).not.toThrow();
  });

  it('should NOT throw an error when setting PLAN mode in an untrusted folder', () => {
    const config = new Config({
      targetDir: '.',
      debugMode: false,
      model: 'test-model',
      cwd: '.',
      trustedFolder: false, // Untrusted
    });
    expect(() => config.setApprovalMode(ApprovalMode.PLAN)).not.toThrow();
  });

  it('should NOT throw an error when setting any mode in a trusted folder', () => {
    const config = new Config(baseParams);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
    expect(() => config.setApprovalMode(ApprovalMode.YOLO)).not.toThrow();
    expect(() => config.setApprovalMode(ApprovalMode.AUTO_EDIT)).not.toThrow();
    expect(() => config.setApprovalMode(ApprovalMode.DEFAULT)).not.toThrow();
    expect(() => config.setApprovalMode(ApprovalMode.PLAN)).not.toThrow();
  });

  it('should NOT throw an error when setting any mode if trustedFolder is undefined', () => {
    const config = new Config(baseParams);
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true); // isTrustedFolder defaults to true
    expect(() => config.setApprovalMode(ApprovalMode.YOLO)).not.toThrow();
    expect(() => config.setApprovalMode(ApprovalMode.AUTO_EDIT)).not.toThrow();
    expect(() => config.setApprovalMode(ApprovalMode.DEFAULT)).not.toThrow();
    expect(() => config.setApprovalMode(ApprovalMode.PLAN)).not.toThrow();
  });

  describe('registerCoreTools', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should register RipGrepTool when useRipgrep is true and it is available', async () => {
      (canUseRipgrep as Mock).mockResolvedValue(true);
      const config = new Config({ ...baseParams, useRipgrep: true });
      await config.initialize();

      const calls = (ToolRegistry.prototype.registerTool as Mock).mock.calls;
      const wasRipGrepRegistered = calls.some(
        (call) => call[0] instanceof vi.mocked(RipGrepTool),
      );
      const wasGrepRegistered = calls.some(
        (call) => call[0] instanceof vi.mocked(GrepTool),
      );

      expect(wasRipGrepRegistered).toBe(true);
      expect(wasGrepRegistered).toBe(false);
      expect(canUseRipgrep).toHaveBeenCalledWith(true);
    });

    it('should register RipGrepTool with system ripgrep when useBuiltinRipgrep is false', async () => {
      (canUseRipgrep as Mock).mockResolvedValue(true);
      const config = new Config({
        ...baseParams,
        useRipgrep: true,
        useBuiltinRipgrep: false,
      });
      await config.initialize();

      const calls = (ToolRegistry.prototype.registerTool as Mock).mock.calls;
      const wasRipGrepRegistered = calls.some(
        (call) => call[0] instanceof vi.mocked(RipGrepTool),
      );
      const wasGrepRegistered = calls.some(
        (call) => call[0] instanceof vi.mocked(GrepTool),
      );

      expect(wasRipGrepRegistered).toBe(true);
      expect(wasGrepRegistered).toBe(false);
      expect(canUseRipgrep).toHaveBeenCalledWith(false);
    });

    it('should fall back to GrepTool and log error when useBuiltinRipgrep is false but system ripgrep is not available', async () => {
      (canUseRipgrep as Mock).mockResolvedValue(false);
      const config = new Config({
        ...baseParams,
        useRipgrep: true,
        useBuiltinRipgrep: false,
      });
      await config.initialize();

      const calls = (ToolRegistry.prototype.registerTool as Mock).mock.calls;
      const wasRipGrepRegistered = calls.some(
        (call) => call[0] instanceof vi.mocked(RipGrepTool),
      );
      const wasGrepRegistered = calls.some(
        (call) => call[0] instanceof vi.mocked(GrepTool),
      );

      expect(wasRipGrepRegistered).toBe(false);
      expect(wasGrepRegistered).toBe(true);
      expect(canUseRipgrep).toHaveBeenCalledWith(false);
      expect(logRipgrepFallback).toHaveBeenCalledWith(
        config,
        expect.any(RipgrepFallbackEvent),
      );
      const event = (logRipgrepFallback as Mock).mock.calls[0][1];
      expect(event.error).toContain('ripgrep is not available');
    });

    it('should fall back to GrepTool and log error when useRipgrep is true and builtin ripgrep is not available', async () => {
      (canUseRipgrep as Mock).mockResolvedValue(false);
      const config = new Config({ ...baseParams, useRipgrep: true });
      await config.initialize();

      const calls = (ToolRegistry.prototype.registerTool as Mock).mock.calls;
      const wasRipGrepRegistered = calls.some(
        (call) => call[0] instanceof vi.mocked(RipGrepTool),
      );
      const wasGrepRegistered = calls.some(
        (call) => call[0] instanceof vi.mocked(GrepTool),
      );

      expect(wasRipGrepRegistered).toBe(false);
      expect(wasGrepRegistered).toBe(true);
      expect(canUseRipgrep).toHaveBeenCalledWith(true);
      expect(logRipgrepFallback).toHaveBeenCalledWith(
        config,
        expect.any(RipgrepFallbackEvent),
      );
      const event = (logRipgrepFallback as Mock).mock.calls[0][1];
      expect(event.error).toContain('ripgrep is not available');
    });

    it('should fall back to GrepTool and log error when canUseRipgrep throws an error', async () => {
      const error = new Error('ripGrep check failed');
      (canUseRipgrep as Mock).mockRejectedValue(error);
      const config = new Config({ ...baseParams, useRipgrep: true });
      await config.initialize();

      const calls = (ToolRegistry.prototype.registerTool as Mock).mock.calls;
      const wasRipGrepRegistered = calls.some(
        (call) => call[0] instanceof vi.mocked(RipGrepTool),
      );
      const wasGrepRegistered = calls.some(
        (call) => call[0] instanceof vi.mocked(GrepTool),
      );

      expect(wasRipGrepRegistered).toBe(false);
      expect(wasGrepRegistered).toBe(true);
      expect(logRipgrepFallback).toHaveBeenCalledWith(
        config,
        expect.any(RipgrepFallbackEvent),
      );
      const event = (logRipgrepFallback as Mock).mock.calls[0][1];
      expect(event.error).toBe(`ripGrep check failed`);
    });

    it('should register GrepTool when useRipgrep is false', async () => {
      const config = new Config({ ...baseParams, useRipgrep: false });
      await config.initialize();

      const calls = (ToolRegistry.prototype.registerTool as Mock).mock.calls;
      const wasRipGrepRegistered = calls.some(
        (call) => call[0] instanceof vi.mocked(RipGrepTool),
      );
      const wasGrepRegistered = calls.some(
        (call) => call[0] instanceof vi.mocked(GrepTool),
      );

      expect(wasRipGrepRegistered).toBe(false);
      expect(wasGrepRegistered).toBe(true);
      expect(canUseRipgrep).not.toHaveBeenCalled();
    });
  });
});

describe('BaseLlmClient Lifecycle', () => {
  const MODEL = 'gemini-pro';
  const SANDBOX: SandboxConfig = {
    command: 'docker',
    image: 'gemini-cli-sandbox',
  };
  const TARGET_DIR = '/path/to/target';
  const DEBUG_MODE = false;
  const QUESTION = 'test question';
  const FULL_CONTEXT = false;
  const USER_MEMORY = 'Test User Memory';
  const TELEMETRY_SETTINGS = { enabled: false };
  const EMBEDDING_MODEL = 'gemini-embedding';
  const baseParams: ConfigParameters = {
    cwd: '/tmp',
    embeddingModel: EMBEDDING_MODEL,
    sandbox: SANDBOX,
    targetDir: TARGET_DIR,
    debugMode: DEBUG_MODE,
    question: QUESTION,
    fullContext: FULL_CONTEXT,
    userMemory: USER_MEMORY,
    telemetry: TELEMETRY_SETTINGS,
    model: MODEL,
    usageStatisticsEnabled: false,
  };

  it('should throw an error if getBaseLlmClient is called before refreshAuth', () => {
    const config = new Config(baseParams);
    expect(() => config.getBaseLlmClient()).toThrow(
      'BaseLlmClient not initialized. Ensure authentication has occurred and ContentGenerator is ready.',
    );
  });

  it('should successfully initialize BaseLlmClient after refreshAuth is called', async () => {
    const config = new Config(baseParams);
    const authType = AuthType.USE_GEMINI;
    const mockContentConfig = { model: 'gemini-flash', apiKey: 'test-key' };

    vi.mocked(resolveContentGeneratorConfigWithSources).mockReturnValue({
      config: mockContentConfig,
      sources: {},
    });

    await config.refreshAuth(authType);

    // Should not throw
    const llmService = config.getBaseLlmClient();
    expect(llmService).toBeDefined();
    expect(BaseLlmClient).toHaveBeenCalledWith(
      config.getContentGenerator(),
      config,
    );
  });
});

describe('Model Switching and Config Updates', () => {
  const baseParams: ConfigParameters = {
    cwd: '/tmp',
    targetDir: '/path/to/target',
    debugMode: false,
    model: 'qwen3-coder-plus',
    usageStatisticsEnabled: false,
    telemetry: { enabled: false },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should update contextWindowSize when switching models with hot-update', async () => {
    const config = new Config(baseParams);

    // Initialize with first model
    const initialConfig: ContentGeneratorConfig = {
      ['model']: 'qwen3-coder-plus',
      ['authType']: AuthType.QWEN_OAUTH,
      ['apiKey']: 'test-key',
      ['contextWindowSize']: 1_000_000,
      ['samplingParams']: { temperature: 0.7 },
      ['disableCacheControl']: false,
    };

    vi.mocked(resolveContentGeneratorConfigWithSources).mockReturnValue({
      config: initialConfig,
      sources: {
        model: { kind: 'settings' },
        contextWindowSize: { kind: 'computed', detail: 'auto' },
      },
    });

    await config.refreshAuth(AuthType.QWEN_OAUTH);

    // Verify initial config
    const contentGenConfig = config.getContentGeneratorConfig();
    expect(contentGenConfig['model']).toBe('qwen3-coder-plus');
    expect(contentGenConfig['contextWindowSize']).toBe(1_000_000);

    // Switch to a different model with different token limits
    const newConfig: ContentGeneratorConfig = {
      ['model']: 'qwen-max',
      ['authType']: AuthType.QWEN_OAUTH,
      ['apiKey']: 'test-key',
      ['contextWindowSize']: 128_000,
      ['samplingParams']: { temperature: 0.8 },
      ['disableCacheControl']: true,
    };

    vi.mocked(resolveContentGeneratorConfigWithSources).mockReturnValue({
      config: newConfig,
      sources: {
        model: { kind: 'programmatic', detail: 'user' },
        contextWindowSize: { kind: 'computed', detail: 'auto' },
        samplingParams: { kind: 'settings' },
        disableCacheControl: { kind: 'settings' },
      },
    });

    // Simulate model switch (this would be called by ModelsConfig.switchModel)
    await (
      config as unknown as {
        handleModelChange: (
          authType: AuthType,
          requiresRefresh: boolean,
        ) => Promise<void>;
      }
    ).handleModelChange(AuthType.QWEN_OAUTH, false);

    // Verify all fields are updated
    const updatedConfig = config.getContentGeneratorConfig();
    expect(updatedConfig['model']).toBe('qwen-max');
    expect(updatedConfig['contextWindowSize']).toBe(128_000);
    expect(updatedConfig['samplingParams']?.temperature).toBe(0.8);
    expect(updatedConfig['disableCacheControl']).toBe(true);

    // Verify sources are also updated
    const sources = config.getContentGeneratorConfigSources();
    expect(sources['model']?.kind).toBe('programmatic');
    expect(sources['model']?.detail).toBe('user');
    expect(sources['contextWindowSize']?.kind).toBe('computed');
    expect(sources['contextWindowSize']?.detail).toBe('auto');
    expect(sources['samplingParams']?.kind).toBe('settings');
    expect(sources['disableCacheControl']?.kind).toBe('settings');
  });

  it('should trigger full refresh when switching to non-qwen-oauth provider', async () => {
    const config = new Config(baseParams);

    // Initialize with qwen-oauth
    const initialConfig: ContentGeneratorConfig = {
      ['model']: 'qwen3-coder-plus',
      ['authType']: AuthType.QWEN_OAUTH,
      ['apiKey']: 'test-key',
      ['contextWindowSize']: 1_000_000,
    };

    vi.mocked(resolveContentGeneratorConfigWithSources).mockReturnValue({
      config: initialConfig,
      sources: {},
    });

    await config.refreshAuth(AuthType.QWEN_OAUTH);

    // Switch to different auth type (should trigger full refresh)
    const newConfig: ContentGeneratorConfig = {
      ['model']: 'gemini-flash',
      ['authType']: AuthType.USE_GEMINI,
      ['apiKey']: 'gemini-key',
      ['contextWindowSize']: 32_000,
    };

    vi.mocked(resolveContentGeneratorConfigWithSources).mockReturnValue({
      config: newConfig,
      sources: {},
    });

    const refreshAuthSpy = vi.spyOn(
      config as unknown as {
        refreshAuth: (authType: AuthType) => Promise<void>;
      },
      'refreshAuth',
    );

    // Simulate model switch with different auth type
    await (
      config as unknown as {
        handleModelChange: (
          authType: AuthType,
          requiresRefresh: boolean,
        ) => Promise<void>;
      }
    ).handleModelChange(AuthType.USE_GEMINI, true);

    // Verify refreshAuth was called (full refresh path)
    expect(refreshAuthSpy).toHaveBeenCalledWith(AuthType.USE_GEMINI);
  });

  it('should handle model switch when contextWindowSize is undefined', async () => {
    const config = new Config(baseParams);

    // Initialize with config that has undefined token limits
    const initialConfig: ContentGeneratorConfig = {
      ['model']: 'qwen3-coder-plus',
      ['authType']: AuthType.QWEN_OAUTH,
      ['apiKey']: 'test-key',
      ['contextWindowSize']: undefined,
    };

    vi.mocked(resolveContentGeneratorConfigWithSources).mockReturnValue({
      config: initialConfig,
      sources: {},
    });

    await config.refreshAuth(AuthType.QWEN_OAUTH);

    // Switch to model with defined limits
    const newConfig: ContentGeneratorConfig = {
      ['model']: 'qwen-max',
      ['authType']: AuthType.QWEN_OAUTH,
      ['apiKey']: 'test-key',
      ['contextWindowSize']: 128_000,
    };

    vi.mocked(resolveContentGeneratorConfigWithSources).mockReturnValue({
      config: newConfig,
      sources: {},
    });

    await (
      config as unknown as {
        handleModelChange: (
          authType: AuthType,
          requiresRefresh: boolean,
        ) => Promise<void>;
      }
    ).handleModelChange(AuthType.QWEN_OAUTH, false);

    // Verify limits are now defined
    const updatedConfig = config.getContentGeneratorConfig();
    expect(updatedConfig['contextWindowSize']).toBe(128_000);
  });
});
