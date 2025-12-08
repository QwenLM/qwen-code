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

import type { ContentGeneratorConfig } from '../core/contentGenerator.js';
import { DEFAULT_DASHSCOPE_BASE_URL } from '../core/openaiContentGenerator/constants.js';
import {
  AuthType,
  createContentGeneratorConfig,
} from '../core/contentGenerator.js';
import { GeminiClient } from '../core/client.js';
import { GitService } from '../services/gitService.js';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    statSync: vi.fn().mockReturnValue({
      isDirectory: vi.fn().mockReturnValue(true),
    }),
    realpathSync: vi.fn((path) => path),
  };
});

import { ShellTool } from '../tools/shell.js';
import { ReadFileTool } from '../tools/read-file.js';
import { GrepTool } from '../tools/grep.js';
import { canUseRipgrep } from '../utils/ripgrepUtils.js';
import { RipGrepTool } from '../tools/ripGrep.js';

import { ToolRegistry } from '../tools/tool-registry.js';

function createToolMock(toolName: string) {
  const ToolMock = vi.fn();
  Object.defineProperty(ToolMock, 'Name', {
    value: toolName,
    writable: true,
  });
  return ToolMock;
}

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    statSync: vi.fn().mockReturnValue({
      isDirectory: vi.fn().mockReturnValue(true),
    }),
    realpathSync: vi.fn((path) => path),
  };
});

// Mock dependencies that might be called during Config construction or createServerConfig
vi.mock('../tools/tool-registry', () => {
  const ToolRegistryMock = vi.fn();
  ToolRegistryMock.prototype.registerTool = vi.fn();
  ToolRegistryMock.prototype.discoverAllTools = vi.fn();
  ToolRegistryMock.prototype.getAllTools = vi.fn(() => []); // Mock methods if needed
  ToolRegistryMock.prototype.getTool = vi.fn();
  ToolRegistryMock.prototype.getFunctionDeclarations = vi.fn(() => []);
  return { ToolRegistry: ToolRegistryMock };
});

vi.mock('../utils/memoryDiscovery.js', () => ({
  loadServerHierarchicalMemory: vi.fn(),
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

vi.mock('../services/gitService.js', () => {
  const GitServiceMock = vi.fn();
  GitServiceMock.prototype.initialize = vi.fn();
  return { GitService: GitServiceMock };
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
vi.mock('../core/tokenLimits.js', () => ({
  tokenLimit: vi.fn(),
}));

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

  const EMBEDDING_MODEL = 'gemini-embedding';
  const SESSION_ID = 'test-session-id';
  const baseParams: ConfigParameters = {
    cwd: '/tmp',
    embeddingModel: EMBEDDING_MODEL,
    sandbox: SANDBOX,
    targetDir: TARGET_DIR,
    debugMode: DEBUG_MODE,
    question: QUESTION,
    fullContext: FULL_CONTEXT,
    userMemory: USER_MEMORY,

    sessionId: SESSION_ID,
    model: MODEL,
    usageStatisticsEnabled: false,
  };

  beforeEach(() => {
    // Reset mocks if necessary
    vi.clearAllMocks();
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
      };

      vi.mocked(createContentGeneratorConfig).mockReturnValue(
        mockContentConfig,
      );

      // Set fallback mode to true to ensure it gets reset
      config.setFallbackMode(true);
      expect(config.isInFallbackMode()).toBe(true);

      await config.refreshAuth(authType);

      expect(createContentGeneratorConfig).toHaveBeenCalledWith(
        config,
        authType,
        {
          model: MODEL,
          baseUrl: DEFAULT_DASHSCOPE_BASE_URL,
        },
      );
      // Verify that contentGeneratorConfig is updated
      expect(config.getContentGeneratorConfig()).toEqual(mockContentConfig);
      expect(GeminiClient).toHaveBeenCalledWith(config);
      // Verify that fallback mode is reset
      expect(config.isInFallbackMode()).toBe(false);
    });

    it('should strip thoughts when switching from GenAI to Vertex', async () => {
      const config = new Config(baseParams);

      vi.mocked(createContentGeneratorConfig).mockImplementation(
        (_: Config, authType: AuthType | undefined) =>
          ({ authType }) as unknown as ContentGeneratorConfig,
      );

      await config.refreshAuth(AuthType.USE_GEMINI);

      await config.refreshAuth(AuthType.LOGIN_WITH_GOOGLE);

      expect(
        config.getGeminiClient().stripThoughtsFromHistory,
      ).toHaveBeenCalledWith();
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

  it('should have a getFileService method that returns FileDiscoveryService', () => {
    const config = new Config(baseParams);
    const fileService = config.getFileService();
    expect(fileService).toBeDefined();
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
    beforeEach(() => {
      vi.clearAllMocks();
    });
  });
});

describe('setApprovalMode with folder trust', () => {
  const baseParams: ConfigParameters = {
    sessionId: 'test',
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
      sessionId: 'test',
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

  const EMBEDDING_MODEL = 'gemini-embedding';
  const SESSION_ID = 'test-session-id';
  const baseParams: ConfigParameters = {
    cwd: '/tmp',
    embeddingModel: EMBEDDING_MODEL,
    sandbox: SANDBOX,
    targetDir: TARGET_DIR,
    debugMode: DEBUG_MODE,
    question: QUESTION,
    fullContext: FULL_CONTEXT,
    userMemory: USER_MEMORY,

    sessionId: SESSION_ID,
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

    vi.mocked(createContentGeneratorConfig).mockReturnValue(mockContentConfig);

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
