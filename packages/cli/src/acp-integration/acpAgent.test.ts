/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
  type MockInstance,
} from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock cleanup module before importing anything else
const { mockRunExitCleanup } = vi.hoisted(() => ({
  mockRunExitCleanup: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../utils/cleanup.js', () => ({
  runExitCleanup: mockRunExitCleanup,
}));

// Mock the ACP SDK
const { mockConnectionState } = vi.hoisted(() => {
  const state = {
    resolve: () => {},
    promise: null as unknown as Promise<void>,
    reset() {
      state.promise = new Promise<void>((r) => {
        state.resolve = r;
      });
    },
  };
  state.reset();
  return { mockConnectionState: state };
});

vi.mock('@agentclientprotocol/sdk', () => ({
  AgentSideConnection: vi.fn().mockImplementation(() => ({
    get closed() {
      return mockConnectionState.promise;
    },
  })),
  ndJsonStream: vi.fn().mockReturnValue({}),
  RequestError: class RequestError extends Error {
    static authRequired = vi
      .fn()
      .mockImplementation((data: unknown, msg: string) => {
        const err = new Error(msg);
        Object.assign(err, data);
        return err;
      });
    static invalidParams = vi
      .fn()
      .mockImplementation((data: unknown, msg: string) => {
        const err = new Error(msg);
        Object.assign(err, data);
        return err;
      });
    static resourceNotFound = vi.fn().mockImplementation((uri: string) => {
      const err = new Error(`Resource not found: ${uri}`);
      Object.assign(err, { code: -32002, data: { uri } });
      return err;
    });
  },
  PROTOCOL_VERSION: '1.0.0',
}));

// Mock stream conversion
vi.mock('node:stream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:stream')>();
  return {
    ...actual,
    Writable: { ...actual.Writable, toWeb: vi.fn().mockReturnValue({}) },
    Readable: { ...actual.Readable, toWeb: vi.fn().mockReturnValue({}) },
  };
});

// Mock core dependencies
vi.mock('@qwen-code/qwen-code-core', () => ({
  createDebugLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  }),
  APPROVAL_MODE_INFO: {},
  APPROVAL_MODES: [],
  AuthType: {
    QWEN_OAUTH: 'qwen-oauth',
    USE_OPENAI: 'openai',
    USE_ANTHROPIC: 'anthropic',
    USE_GEMINI: 'gemini',
    USE_VERTEX_AI: 'vertex-ai',
  },
  ALL_PROVIDERS: [
    {
      id: 'deepseek',
      label: 'DeepSeek API Key',
      description: 'Quick setup for DeepSeek',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      envKey: 'DEEPSEEK_API_KEY',
      models: [{ id: 'deepseek-chat' }],
      modelsEditable: true,
      modelNamePrefix: 'DeepSeek',
      uiGroup: 'third-party',
    },
  ],
  findProviderById: vi.fn((id: string) =>
    id === 'deepseek'
      ? {
          id: 'deepseek',
          label: 'DeepSeek API Key',
          description: 'Quick setup for DeepSeek',
          protocol: 'openai',
          baseUrl: 'https://api.deepseek.com',
          envKey: 'DEEPSEEK_API_KEY',
          models: [{ id: 'deepseek-chat' }],
          modelsEditable: true,
          modelNamePrefix: 'DeepSeek',
          uiGroup: 'third-party',
        }
      : undefined,
  ),
  getDefaultBaseUrlForProtocol: vi.fn(() => 'https://api.openai.com/v1'),
  getDefaultModelIds: vi.fn(
    (provider: { models?: Array<{ id: string }> }) =>
      provider.models?.map((model) => model.id) ?? [],
  ),
  resolveBaseUrl: vi.fn(
    (
      provider: { baseUrl?: string | Array<{ url: string }> },
      selectedBaseUrl?: string,
    ) =>
      typeof provider.baseUrl === 'string'
        ? provider.baseUrl
        : Array.isArray(provider.baseUrl)
          ? (provider.baseUrl[0]?.url ?? selectedBaseUrl ?? '')
          : (selectedBaseUrl ?? ''),
  ),
  resolveOwnsModel: vi.fn(
    (provider: { envKey: string }) => (model: { envKey?: string }) =>
      model.envKey === provider.envKey,
  ),
  buildInstallPlan: vi.fn((provider, inputs) => ({
    providerId: provider.id,
    authType: inputs.protocol ?? provider.protocol,
    env: { [provider.envKey]: inputs.apiKey },
    modelSelection: { modelId: inputs.modelIds[0] },
  })),
  applyProviderInstallPlan: vi.fn().mockResolvedValue({
    updatedModelProviders: {},
  }),
  clearCachedCredentialFile: vi.fn(),
  getAllGeminiMdFilenames: vi.fn(() => ['QWEN.md', 'AGENTS.md']),
  getAutoMemoryRoot: vi.fn(
    (projectRoot: string) => `${projectRoot}/.qwen/memory`,
  ),
  QwenOAuth2Event: {},
  qwenOAuth2Events: { on: vi.fn(), off: vi.fn() },
  MCPDiscoveryState: {
    NOT_STARTED: 'not_started',
    IN_PROGRESS: 'in_progress',
    COMPLETED: 'completed',
  },
  MCPServerStatus: {
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
  },
  // SkillError is referenced by status.ts's `mapDomainErrorToErrorKind`
  // helper for `instanceof` classification. The mock must surface it as
  // a real class so that `instanceof` works inside the helper.
  SkillError: class SkillError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'SkillError';
      this.code = code;
    }
  },
  getMCPDiscoveryState: vi.fn().mockReturnValue('completed'),
  getMCPServerStatus: vi.fn().mockReturnValue('connected'),
  MCPServerConfig: vi.fn().mockImplementation((...args: unknown[]) => ({
    _args: args,
  })),
  SessionService: vi.fn(),
  Storage: {
    getGlobalQwenDir: vi.fn(() => '/tmp/qwen-global-test'),
  },
  parse: vi.fn((yaml: string) => {
    const record: Record<string, unknown> = {};
    for (const line of yaml.split('\n')) {
      const match = line.match(/^([^:#]+):\s*(.*)$/);
      if (!match) continue;
      const value = match[2].trim();
      record[match[1].trim()] =
        value === 'true' ? true : value === 'false' ? false : value;
    }
    return record;
  }),
  stringify: vi.fn((record: Record<string, unknown>) =>
    Object.entries(record)
      .map(([key, value]) => `${key}: ${String(value)}`)
      .join('\n'),
  ),
  SESSION_TITLE_MAX_LENGTH: 200,
  tokenLimit: vi.fn().mockReturnValue(128_000),
  SessionStartSource: {
    Startup: 'startup',
    Resume: 'resume',
    Branch: 'branch',
    Clear: 'clear',
    Compact: 'compact',
  },
  SessionEndReason: {
    PromptInputExit: 'prompt_input_exit',
    Other: 'other',
  },
}));

vi.mock('./runtimeOutputDirContext.js', () => ({
  runWithAcpRuntimeOutputDir: vi.fn(
    async <T>(
      _settings: unknown,
      _cwd: string,
      fn: () => T | Promise<T>,
    ): Promise<T> => fn(),
  ),
}));

vi.mock('./authMethods.js', () => {
  const buildAuthMethods = vi.fn();
  return {
    buildAuthMethods,
    pickAuthMethodsForAuthRequired: vi.fn((selectedType?: string) => {
      const authMethods = buildAuthMethods();
      if (!selectedType) return authMethods;
      const matched = authMethods.filter(
        (method: { id: string }) => method.id === selectedType,
      );
      return matched.length ? matched : authMethods;
    }),
  };
});
vi.mock('./service/filesystem.js', () => ({
  AcpFileSystemService: vi.fn(),
}));
vi.mock('../config/settings.js', () => ({
  SettingScope: { User: 'User', Workspace: 'Workspace' },
  loadSettings: vi.fn(),
}));
vi.mock('../config/loadedSettingsAdapter.js', () => ({
  createLoadedSettingsAdapter: vi.fn((settings: unknown) => settings),
}));
vi.mock('../config/config.js', () => ({ loadCliConfig: vi.fn() }));
vi.mock('./session/Session.js', () => ({
  Session: vi.fn(),
  buildAvailableCommandsSnapshot: vi.fn().mockResolvedValue({
    availableCommands: [],
    availableSkills: [],
  }),
}));
vi.mock('../utils/acpModelUtils.js', () => ({
  formatAcpModelId: vi.fn(
    (modelId: string, authType: string) => `${modelId}(${authType})`,
  ),
  parseAcpBaseModelId: vi.fn((modelId: string) =>
    modelId.replace(/\([^)]+\)$/, ''),
  ),
}));
vi.mock('../utils/languageUtils.js', () => ({
  updateOutputLanguageFile: vi.fn(),
}));

import {
  runAcpAgent,
  toStdioServer,
  toSseServer,
  toHttpServer,
} from './acpAgent.js';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import type { CliArgs } from '../config/config.js';
import {
  SessionEndReason,
  MCPServerConfig,
  SessionService,
  MCPDiscoveryState,
  MCPServerStatus,
  getMCPDiscoveryState,
  getMCPServerStatus,
  tokenLimit,
  buildInstallPlan,
  applyProviderInstallPlan,
  Storage,
} from '@qwen-code/qwen-code-core';
import type { McpServer } from '@agentclientprotocol/sdk';
import { AgentSideConnection } from '@agentclientprotocol/sdk';
import { loadSettings } from '../config/settings.js';
import { loadCliConfig } from '../config/config.js';
import { Session, buildAvailableCommandsSnapshot } from './session/Session.js';
import { SERVE_STATUS_EXT_METHODS } from '../serve/status.js';
import { updateOutputLanguageFile } from '../utils/languageUtils.js';
import { buildAuthMethods } from './authMethods.js';

describe('runAcpAgent shutdown cleanup', () => {
  let processExitSpy: MockInstance<typeof process.exit>;
  let processOnSpy: MockInstance<typeof process.on>;
  let processOffSpy: MockInstance<typeof process.off>;
  let stdinDestroySpy: MockInstance<typeof process.stdin.destroy>;
  let stdoutDestroySpy: MockInstance<typeof process.stdout.destroy>;
  let sigTermListeners: NodeJS.SignalsListener[];
  let sigIntListeners: NodeJS.SignalsListener[];
  let mockConfig: Config;

  const mockSettings = { merged: {} } as LoadedSettings;
  const mockArgv = {} as CliArgs;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mockConfig after clearAllMocks
    mockConfig = {
      initialize: vi.fn().mockResolvedValue(undefined),
      waitForMcpReady: vi.fn().mockResolvedValue(undefined),
      getHookSystem: vi.fn().mockReturnValue(undefined),
      getDisableAllHooks: vi.fn().mockReturnValue(false),
      hasHooksForEvent: vi.fn().mockReturnValue(false),
      getModel: vi.fn().mockReturnValue('test-model'),
    } as unknown as Config;

    mockRunExitCleanup.mockResolvedValue(undefined);
    mockConnectionState.reset();
    sigTermListeners = [];
    sigIntListeners = [];

    // Intercept signal handler registration
    processOnSpy = vi.spyOn(process, 'on').mockImplementation(((
      event: string,
      listener: (...args: unknown[]) => void,
    ) => {
      if (event === 'SIGTERM')
        sigTermListeners.push(listener as NodeJS.SignalsListener);
      if (event === 'SIGINT')
        sigIntListeners.push(listener as NodeJS.SignalsListener);
      return process;
    }) as typeof process.on);

    processOffSpy = vi.spyOn(process, 'off').mockImplementation(((
      event: string,
      listener: (...args: unknown[]) => void,
    ) => {
      if (event === 'SIGTERM') {
        sigTermListeners = sigTermListeners.filter((l) => l !== listener);
      }
      if (event === 'SIGINT') {
        sigIntListeners = sigIntListeners.filter((l) => l !== listener);
      }
      return process;
    }) as typeof process.off);

    // Mock process.exit to prevent actually exiting
    processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as unknown as typeof process.exit);

    // Mock stdin/stdout destroy
    stdinDestroySpy = vi
      .spyOn(process.stdin, 'destroy')
      .mockImplementation(() => process.stdin);
    stdoutDestroySpy = vi
      .spyOn(process.stdout, 'destroy')
      .mockImplementation(() => process.stdout);
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    stdinDestroySpy.mockRestore();
    stdoutDestroySpy.mockRestore();
    vi.clearAllMocks();
  });

  afterAll(() => {
    processOnSpy.mockRestore();
    processOffSpy.mockRestore();
  });

  it('calls runExitCleanup and process.exit on SIGTERM', async () => {
    // Start runAcpAgent (it will await connection.closed)
    const agentPromise = runAcpAgent(mockConfig, mockSettings, mockArgv);

    // Wait for signal handlers to be registered
    await vi.waitFor(() => {
      expect(sigTermListeners.length).toBeGreaterThan(0);
    });

    // Simulate SIGTERM from IDE
    sigTermListeners[0]('SIGTERM');

    // runExitCleanup is async, wait for it
    await vi.waitFor(() => {
      expect(mockRunExitCleanup).toHaveBeenCalledTimes(1);
    });

    await vi.waitFor(() => {
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    // Resolve connection.closed so the promise settles
    mockConnectionState.resolve();
    await agentPromise;
  });

  it('calls runExitCleanup and process.exit on SIGINT', async () => {
    const agentPromise = runAcpAgent(mockConfig, mockSettings, mockArgv);

    // Wait for signal handlers to be registered
    await vi.waitFor(() => {
      expect(sigIntListeners.length).toBeGreaterThan(0);
    });

    sigIntListeners[0]('SIGINT');

    await vi.waitFor(() => {
      expect(mockRunExitCleanup).toHaveBeenCalledTimes(1);
    });

    await vi.waitFor(() => {
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('only runs shutdown once even if multiple signals arrive', async () => {
    const agentPromise = runAcpAgent(mockConfig, mockSettings, mockArgv);

    // Wait for signal handlers to be registered
    await vi.waitFor(() => {
      expect(sigTermListeners.length).toBeGreaterThan(0);
    });

    // Send SIGTERM twice
    sigTermListeners[0]('SIGTERM');
    sigTermListeners[0]('SIGTERM');

    await vi.waitFor(() => {
      expect(mockRunExitCleanup).toHaveBeenCalledTimes(1);
    });

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('still exits even if runExitCleanup throws', async () => {
    mockRunExitCleanup.mockRejectedValueOnce(new Error('cleanup failed'));

    const agentPromise = runAcpAgent(mockConfig, mockSettings, mockArgv);

    // Wait for signal handlers to be registered
    await vi.waitFor(() => {
      expect(sigTermListeners.length).toBeGreaterThan(0);
    });

    sigTermListeners[0]('SIGTERM');

    // process.exit should still be called via .finally()
    await vi.waitFor(() => {
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    mockConnectionState.resolve();
    await agentPromise;
  });
});

describe('runAcpAgent SessionEnd hooks', () => {
  let processExitSpy: MockInstance<typeof process.exit>;
  let processOnSpy: MockInstance<typeof process.on>;
  let processOffSpy: MockInstance<typeof process.off>;
  let stdinDestroySpy: MockInstance<typeof process.stdin.destroy>;
  let stdoutDestroySpy: MockInstance<typeof process.stdout.destroy>;
  let sigTermListeners: NodeJS.SignalsListener[];
  let sigIntListeners: NodeJS.SignalsListener[];
  let mockConfig: Config;
  let mockHookSystem: {
    fireSessionEndEvent: ReturnType<typeof vi.fn>;
    fireSessionStartEvent: ReturnType<typeof vi.fn>;
  };

  const mockSettings = { merged: {} } as LoadedSettings;
  const mockArgv = {} as CliArgs;

  beforeEach(() => {
    vi.clearAllMocks();
    mockHookSystem = {
      fireSessionEndEvent: vi.fn().mockResolvedValue(undefined),
      fireSessionStartEvent: vi.fn().mockResolvedValue(undefined),
    };
    mockConfig = {
      initialize: vi.fn().mockResolvedValue(undefined),
      waitForMcpReady: vi.fn().mockResolvedValue(undefined),
      getHookSystem: vi.fn().mockReturnValue(mockHookSystem),
      getDisableAllHooks: vi.fn().mockReturnValue(false),
      hasHooksForEvent: vi.fn().mockReturnValue(true),
      getModel: vi.fn().mockReturnValue('test-model'),
    } as unknown as Config;

    mockRunExitCleanup.mockResolvedValue(undefined);
    mockConnectionState.reset();
    sigTermListeners = [];
    sigIntListeners = [];

    processOnSpy = vi.spyOn(process, 'on').mockImplementation(((
      event: string,
      listener: (...args: unknown[]) => void,
    ) => {
      if (event === 'SIGTERM')
        sigTermListeners.push(listener as NodeJS.SignalsListener);
      if (event === 'SIGINT')
        sigIntListeners.push(listener as NodeJS.SignalsListener);
      return process;
    }) as typeof process.on);

    processOffSpy = vi.spyOn(process, 'off').mockImplementation(((
      event: string,
      listener: (...args: unknown[]) => void,
    ) => {
      if (event === 'SIGTERM') {
        sigTermListeners = sigTermListeners.filter((l) => l !== listener);
      }
      if (event === 'SIGINT') {
        sigIntListeners = sigIntListeners.filter((l) => l !== listener);
      }
      return process;
    }) as typeof process.off);

    processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as unknown as typeof process.exit);

    stdinDestroySpy = vi
      .spyOn(process.stdin, 'destroy')
      .mockImplementation(() => process.stdin);
    stdoutDestroySpy = vi
      .spyOn(process.stdout, 'destroy')
      .mockImplementation(() => process.stdout);
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    stdinDestroySpy.mockRestore();
    stdoutDestroySpy.mockRestore();
    vi.clearAllMocks();
  });

  afterAll(() => {
    processOnSpy.mockRestore();
    processOffSpy.mockRestore();
  });

  it('fires SessionEnd hook with Other reason on SIGTERM', async () => {
    const agentPromise = runAcpAgent(mockConfig, mockSettings, mockArgv);

    await vi.waitFor(() => {
      expect(sigTermListeners.length).toBeGreaterThan(0);
    });

    sigTermListeners[0]('SIGTERM');

    await vi.waitFor(() => {
      expect(mockHookSystem.fireSessionEndEvent).toHaveBeenCalledWith(
        SessionEndReason.Other,
      );
    });

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('fires SessionEnd hook with Other reason on SIGINT', async () => {
    const agentPromise = runAcpAgent(mockConfig, mockSettings, mockArgv);

    await vi.waitFor(() => {
      expect(sigIntListeners.length).toBeGreaterThan(0);
    });

    sigIntListeners[0]('SIGINT');

    await vi.waitFor(() => {
      expect(mockHookSystem.fireSessionEndEvent).toHaveBeenCalledWith(
        SessionEndReason.Other,
      );
    });

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('fires SessionEnd hook with PromptInputExit on connection.closed', async () => {
    const agentPromise = runAcpAgent(mockConfig, mockSettings, mockArgv);

    // Resolve connection to simulate IDE disconnect
    mockConnectionState.resolve();

    await vi.waitFor(() => {
      expect(mockHookSystem.fireSessionEndEvent).toHaveBeenCalledWith(
        SessionEndReason.PromptInputExit,
      );
    });

    await agentPromise;
  });

  it('does not fire SessionEnd hook when hooks are disabled', async () => {
    mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);

    const agentPromise = runAcpAgent(mockConfig, mockSettings, mockArgv);

    await vi.waitFor(() => {
      expect(sigTermListeners.length).toBeGreaterThan(0);
    });

    sigTermListeners[0]('SIGTERM');

    await vi.waitFor(() => {
      expect(mockRunExitCleanup).toHaveBeenCalled();
    });

    // SessionEnd hook should NOT be called
    expect(mockHookSystem.fireSessionEndEvent).not.toHaveBeenCalled();

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('does not fire SessionEnd hook when event not registered', async () => {
    mockConfig.hasHooksForEvent = vi.fn().mockReturnValue(false);

    const agentPromise = runAcpAgent(mockConfig, mockSettings, mockArgv);

    await vi.waitFor(() => {
      expect(sigTermListeners.length).toBeGreaterThan(0);
    });

    sigTermListeners[0]('SIGTERM');

    await vi.waitFor(() => {
      expect(mockRunExitCleanup).toHaveBeenCalled();
    });

    // SessionEnd hook should NOT be called
    expect(mockHookSystem.fireSessionEndEvent).not.toHaveBeenCalled();

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('fires SessionEnd hook only once when SIGTERM triggers before connection.closed', async () => {
    const agentPromise = runAcpAgent(mockConfig, mockSettings, mockArgv);

    await vi.waitFor(() => {
      expect(sigTermListeners.length).toBeGreaterThan(0);
    });

    // Trigger SIGTERM first
    sigTermListeners[0]('SIGTERM');

    await vi.waitFor(() => {
      expect(mockHookSystem.fireSessionEndEvent).toHaveBeenCalledWith(
        SessionEndReason.Other,
      );
    });

    // Now resolve connection.closed - this should NOT trigger another SessionEnd
    mockConnectionState.resolve();

    // Wait for the agent to complete
    await agentPromise;

    // SessionEnd should have been called exactly once
    expect(mockHookSystem.fireSessionEndEvent).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Unit tests for toStdioServer / toSseServer / toHttpServer helpers
// ---------------------------------------------------------------------------

describe('toStdioServer', () => {
  const stdioServer = {
    name: 'my-stdio',
    command: 'node',
    args: ['server.js'],
    env: [],
  } as unknown as McpServer;

  const sseServer = {
    type: 'sse',
    name: 'my-sse',
    url: 'http://localhost:3000/sse',
    headers: [],
  } as unknown as McpServer;

  it('returns the server when it is a stdio server', () => {
    expect(toStdioServer(stdioServer)).toBe(stdioServer);
  });

  it('returns undefined for SSE server', () => {
    expect(toStdioServer(sseServer)).toBeUndefined();
  });

  it('returns undefined for HTTP server', () => {
    const httpServer = {
      type: 'http',
      name: 'my-http',
      url: 'http://localhost:3000/mcp',
      headers: [],
    } as unknown as McpServer;
    expect(toStdioServer(httpServer)).toBeUndefined();
  });
});

describe('toSseServer', () => {
  it('returns the server when type is sse', () => {
    const sseServer = {
      type: 'sse',
      name: 'my-sse',
      url: 'http://localhost:3000/sse',
      headers: [],
    } as unknown as McpServer;
    const result = toSseServer(sseServer);
    expect(result).toBe(sseServer);
    expect(result?.type).toBe('sse');
  });

  it('returns undefined for stdio server', () => {
    const stdioServer = {
      name: 'my-stdio',
      command: 'node',
      args: [],
      env: [],
    } as unknown as McpServer;
    expect(toSseServer(stdioServer)).toBeUndefined();
  });

  it('returns undefined for http server', () => {
    const httpServer = {
      type: 'http',
      name: 'my-http',
      url: 'http://localhost:3000/mcp',
      headers: [],
    } as unknown as McpServer;
    expect(toSseServer(httpServer)).toBeUndefined();
  });
});

describe('toHttpServer', () => {
  it('returns the server when type is http', () => {
    const httpServer = {
      type: 'http',
      name: 'my-http',
      url: 'http://localhost:3000/mcp',
      headers: [],
    } as unknown as McpServer;
    const result = toHttpServer(httpServer);
    expect(result).toBe(httpServer);
    expect(result?.type).toBe('http');
  });

  it('returns undefined for stdio server', () => {
    const stdioServer = {
      name: 'my-stdio',
      command: 'node',
      args: [],
      env: [],
    } as unknown as McpServer;
    expect(toHttpServer(stdioServer)).toBeUndefined();
  });

  it('returns undefined for sse server', () => {
    const sseServer = {
      type: 'sse',
      name: 'my-sse',
      url: 'http://localhost:3000/sse',
      headers: [],
    } as unknown as McpServer;
    expect(toHttpServer(sseServer)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests for QwenAgent.initialize() mcpCapabilities + newSession SSE/HTTP
// ---------------------------------------------------------------------------

describe('QwenAgent MCP SSE/HTTP support', () => {
  // We need to capture the agent factory from AgentSideConnection constructor
  let capturedAgentFactory:
    | ((conn: AgentSideConnectionLike) => AgentLike)
    | undefined;

  type AgentSideConnectionLike = { closed: Promise<void> };
  type AgentLike = {
    initialize: (args: Record<string, unknown>) => Promise<unknown>;
    newSession: (args: Record<string, unknown>) => Promise<unknown>;
    extMethod: (
      method: string,
      args: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
  };

  let mockConfig: Config;
  let lastSessionMock:
    | {
        captureHistorySnapshot: ReturnType<typeof vi.fn>;
        restoreHistory: ReturnType<typeof vi.fn>;
        rewindToTurn: ReturnType<typeof vi.fn>;
      }
    | undefined;
  let processExitSpy: MockInstance<typeof process.exit>;
  let stdinDestroySpy: MockInstance<typeof process.stdin.destroy>;
  let stdoutDestroySpy: MockInstance<typeof process.stdout.destroy>;

  const mockArgv = {} as CliArgs;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectionState.reset();
    lastSessionMock = undefined;
    capturedAgentFactory = undefined;

    // Override AgentSideConnection mock to capture factory
    vi.mocked(AgentSideConnection).mockImplementation((factory: unknown) => {
      capturedAgentFactory = factory as typeof capturedAgentFactory;
      return {
        get closed() {
          return mockConnectionState.promise;
        },
      } as unknown as InstanceType<typeof AgentSideConnection>;
    });

    mockConfig = {
      initialize: vi.fn().mockResolvedValue(undefined),
      waitForMcpReady: vi.fn().mockResolvedValue(undefined),
      getHookSystem: vi.fn().mockReturnValue(undefined),
      getDisableAllHooks: vi.fn().mockReturnValue(false),
      hasHooksForEvent: vi.fn().mockReturnValue(false),
      getModel: vi.fn().mockReturnValue('test-model'),
      getModelsConfig: vi.fn().mockReturnValue({
        getCurrentAuthType: vi.fn().mockReturnValue('api-key'),
        syncAfterAuthRefresh: vi.fn(),
      }),
      reloadModelProvidersConfig: vi.fn(),
      refreshAuth: vi.fn().mockResolvedValue(undefined),
    } as unknown as Config;

    processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as unknown as typeof process.exit);
    stdinDestroySpy = vi
      .spyOn(process.stdin, 'destroy')
      .mockImplementation(() => process.stdin);
    stdoutDestroySpy = vi
      .spyOn(process.stdout, 'destroy')
      .mockImplementation(() => process.stdout);
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    stdinDestroySpy.mockRestore();
    stdoutDestroySpy.mockRestore();
  });

  it('initialize response includes mcpCapabilities with sse and http', async () => {
    const mockSettings = {
      merged: { mcpServers: {} },
    } as unknown as LoadedSettings;
    const agentPromise = runAcpAgent(mockConfig, mockSettings, mockArgv);

    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const fakeConn = {
      get closed() {
        return mockConnectionState.promise;
      },
    } as AgentSideConnectionLike;

    const agent = capturedAgentFactory!(fakeConn) as AgentLike;
    const response = await agent.initialize({ clientCapabilities: {} });

    expect(response).toMatchObject({
      agentCapabilities: {
        mcpCapabilities: {
          sse: true,
          http: true,
        },
      },
    });

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('does not return discontinued qwen-oauth as the only ACP auth option', async () => {
    vi.mocked(buildAuthMethods).mockReturnValue([
      {
        id: 'openai',
        name: 'Use OpenAI API key',
        description: 'Requires setting OPENAI_API_KEY',
      },
    ]);

    const innerConfig = makeInnerConfig();
    vi.mocked(innerConfig.getModelsConfig).mockReturnValue({
      getCurrentAuthType: vi.fn().mockReturnValue('qwen-oauth'),
    } as unknown as ReturnType<Config['getModelsConfig']>);
    vi.mocked(innerConfig.refreshAuth).mockRejectedValue(
      new Error('qwen-oauth token expired'),
    );
    vi.mocked(loadSettings).mockReturnValue(makeSessionSettings());
    vi.mocked(loadCliConfig).mockResolvedValue(
      innerConfig as unknown as Config,
    );

    vi.mocked(Session).mockImplementation(
      () =>
        ({
          getId: vi.fn().mockReturnValue('test-session-id'),
          getConfig: vi.fn().mockReturnValue(innerConfig),
          sendAvailableCommandsUpdate: vi.fn().mockResolvedValue(undefined),
          replayHistory: vi.fn().mockResolvedValue(undefined),
          installRewriter: vi.fn(),
        }) as unknown as InstanceType<typeof Session>,
    );

    const agentPromise = runAcpAgent(
      mockConfig,
      makeSessionSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());
    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    await expect(
      agent.newSession({ cwd: '/tmp', mcpServers: [] }),
    ).rejects.toMatchObject({
      authMethods: [
        expect.objectContaining({
          id: 'openai',
        }),
      ],
    });

    mockConnectionState.resolve();
    await agentPromise;
  });

  function makeInnerConfig() {
    return {
      initialize: vi.fn().mockResolvedValue(undefined),
      waitForMcpReady: vi.fn().mockResolvedValue(undefined),
      getModelsConfig: vi.fn().mockReturnValue({
        getCurrentAuthType: vi.fn().mockReturnValue('api-key'),
        syncAfterAuthRefresh: vi.fn(),
      }),
      reloadModelProvidersConfig: vi.fn(),
      refreshAuth: vi.fn().mockResolvedValue(undefined),
      getModel: vi.fn().mockReturnValue('m'),
      getTargetDir: vi.fn().mockReturnValue('/tmp'),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      getAvailableModels: vi.fn().mockReturnValue([]),
      getModes: vi.fn().mockReturnValue([]),
      getApprovalMode: vi.fn().mockReturnValue('default'),
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getAuthType: vi.fn().mockReturnValue('api-key'),
      getAllConfiguredModels: vi.fn().mockReturnValue([]),
      getGeminiClient: vi.fn().mockReturnValue({
        isInitialized: vi.fn().mockReturnValue(true),
        initialize: vi.fn().mockResolvedValue(undefined),
        waitForMcpReady: vi.fn().mockResolvedValue(undefined),
      }),
      getFileSystemService: vi.fn().mockReturnValue(undefined),
      setFileSystemService: vi.fn(),
      getHookSystem: vi.fn().mockReturnValue(undefined),
      getDisableAllHooks: vi.fn().mockReturnValue(true),
      hasHooksForEvent: vi.fn().mockReturnValue(false),
    };
  }

  function makeSessionSettings() {
    return {
      merged: { mcpServers: {} },
      getUserHooks: vi.fn().mockReturnValue({}),
      getProjectHooks: vi.fn().mockReturnValue({}),
    } as unknown as LoadedSettings;
  }

  function makeMemorySettings(memory: Record<string, unknown> = {}) {
    const user = {
      path: '/home/test/.qwen/settings.json',
      settings: { memory },
    };
    const settings = {
      merged: { mcpServers: {} },
      user,
      getUserHooks: vi.fn().mockReturnValue({}),
      getProjectHooks: vi.fn().mockReturnValue({}),
      setValue: vi.fn((_scope: string, key: string, value: unknown) => {
        const [, memoryKey] = key.split('.');
        if (memoryKey) user.settings.memory[memoryKey] = value;
      }),
    };
    return settings as unknown as LoadedSettings;
  }

  function makeCoreSettings(outputLanguage = 'English') {
    const userSettings = { general: { outputLanguage } };
    const workspaceSettings = {};
    const mergedSettings = { general: { outputLanguage } };
    const setValue = vi.fn((_scope: string, key: string, value: unknown) => {
      if (key !== 'general.outputLanguage') return;
      userSettings.general.outputLanguage = value as string;
      mergedSettings.general.outputLanguage = value as string;
    });
    return {
      merged: mergedSettings,
      user: {
        path: '/home/test/.qwen/settings.json',
        settings: userSettings,
      },
      workspace: {
        path: '/work/.qwen/settings.json',
        settings: workspaceSettings,
      },
      isTrusted: true,
      getUserHooks: vi.fn().mockReturnValue({}),
      getProjectHooks: vi.fn().mockReturnValue({}),
      setValue,
    } as unknown as LoadedSettings;
  }

  async function setupSessionMocks(sessionId: string) {
    const innerConfig = makeInnerConfig();
    innerConfig.getSessionId = vi.fn().mockReturnValue(sessionId);
    vi.mocked(loadSettings).mockReturnValue(makeSessionSettings());
    vi.mocked(loadCliConfig).mockResolvedValue(
      innerConfig as unknown as Config,
    );
    vi.mocked(Session).mockImplementation(() => {
      const sessionMock = {
        getId: vi.fn().mockReturnValue(sessionId),
        getConfig: vi.fn().mockReturnValue(innerConfig),
        sendAvailableCommandsUpdate: vi.fn().mockResolvedValue(undefined),
        replayHistory: vi.fn().mockResolvedValue(undefined),
        installRewriter: vi.fn(),
        captureHistorySnapshot: vi
          .fn()
          .mockReturnValue([{ role: 'user', parts: [{ text: 'before' }] }]),
        restoreHistory: vi.fn(),
        rewindToTurn: vi
          .fn()
          .mockReturnValue({ targetTurnIndex: 1, apiTruncateIndex: 2 }),
      };
      lastSessionMock = sessionMock;
      return sessionMock as unknown as InstanceType<typeof Session>;
    });
    return innerConfig;
  }

  it('status ext methods expose workspace snapshots without secrets', async () => {
    vi.mocked(getMCPDiscoveryState).mockReturnValue(
      MCPDiscoveryState.COMPLETED,
    );
    vi.mocked(getMCPServerStatus).mockImplementation((name: string) =>
      name === 'disabled'
        ? MCPServerStatus.DISCONNECTED
        : MCPServerStatus.CONNECTED,
    );
    const listSkills = vi.fn().mockResolvedValue([
      {
        name: 'review',
        description: 'Review code',
        level: 'project',
        argumentHint: '[path]',
        disableModelInvocation: false,
        body: 'secret skill body',
        filePath: '/secret/SKILL.md',
        skillRoot: '/secret',
        hooks: { pre: ['secret-hook'] },
      },
    ]);
    mockConfig = {
      ...mockConfig,
      getTargetDir: vi.fn().mockReturnValue('/work/status'),
      getMcpServers: vi.fn().mockReturnValue({
        docs: {
          command: 'node',
          args: ['server.js'],
          env: { TOKEN: 'secret-token' },
          description: 'Docs server',
          extensionName: 'docs-ext',
        },
        remote: {
          httpUrl: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer secret' },
        },
        disabled: {
          command: 'node',
          args: ['disabled.js'],
        },
        malformed: {
          command: 'node',
          description: 123,
          extensionName: { name: 'bad-ext' },
        },
      }),
      isMcpServerDisabled: vi
        .fn()
        .mockImplementation((name: string) => name === 'disabled'),
      getSkillManager: vi.fn().mockReturnValue({ listSkills }),
      getAuthType: vi.fn().mockReturnValue('qwen'),
      getAllConfiguredModels: vi.fn().mockReturnValue([
        {
          id: 'qwen-plus',
          label: 'Qwen Plus',
          description: 'General coding model',
          authType: 'qwen',
          contextWindowSize: 65_536,
          baseUrl: 'https://secret.example.com',
          envKey: 'DASHSCOPE_API_KEY',
        },
      ]),
      getActiveRuntimeModelSnapshot: vi.fn().mockReturnValue(undefined),
      getModel: vi.fn().mockReturnValue('qwen-plus'),
    } as unknown as Config;

    const agentPromise = runAcpAgent(
      mockConfig,
      makeSessionSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    const mcp = await agent.extMethod(
      SERVE_STATUS_EXT_METHODS.workspaceMcp,
      {},
    );
    const skills = await agent.extMethod(
      SERVE_STATUS_EXT_METHODS.workspaceSkills,
      {},
    );
    const providers = await agent.extMethod(
      SERVE_STATUS_EXT_METHODS.workspaceProviders,
      {},
    );

    expect(mcp).toMatchObject({
      v: 1,
      workspaceCwd: '/work/status',
      initialized: true,
      discoveryState: 'completed',
      servers: [
        {
          kind: 'mcp_server',
          status: 'ok',
          name: 'docs',
          mcpStatus: 'connected',
          transport: 'stdio',
          disabled: false,
          description: 'Docs server',
          extensionName: 'docs-ext',
        },
        {
          kind: 'mcp_server',
          status: 'ok',
          name: 'remote',
          mcpStatus: 'connected',
          transport: 'http',
          disabled: false,
        },
        {
          kind: 'mcp_server',
          status: 'disabled',
          name: 'disabled',
          mcpStatus: 'disconnected',
          transport: 'stdio',
          disabled: true,
        },
        {
          kind: 'mcp_server',
          status: 'ok',
          name: 'malformed',
          mcpStatus: 'connected',
          transport: 'stdio',
          disabled: false,
        },
      ],
    });
    expect(JSON.stringify(mcp)).not.toContain('secret-token');
    expect(JSON.stringify(mcp)).not.toContain('Authorization');
    expect(JSON.stringify(mcp)).not.toContain('bad-ext');

    expect(skills).toMatchObject({
      v: 1,
      workspaceCwd: '/work/status',
      initialized: true,
      skills: [
        {
          kind: 'skill',
          status: 'ok',
          name: 'review',
          description: 'Review code',
          level: 'project',
          argumentHint: '[path]',
          modelInvocable: true,
        },
      ],
    });
    expect(JSON.stringify(skills)).not.toContain('secret skill body');
    expect(JSON.stringify(skills)).not.toContain('/secret');
    expect(JSON.stringify(skills)).not.toContain('secret-hook');

    expect(providers).toMatchObject({
      v: 1,
      workspaceCwd: '/work/status',
      initialized: true,
      current: { authType: 'qwen', modelId: 'qwen-plus(qwen)' },
      providers: [
        {
          kind: 'model_provider',
          status: 'ok',
          authType: 'qwen',
          current: true,
          models: [
            {
              modelId: 'qwen-plus(qwen)',
              baseModelId: 'qwen-plus',
              name: 'Qwen Plus',
              description: 'General coding model',
              contextLimit: 65_536,
              isCurrent: true,
              isRuntime: false,
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(providers)).not.toContain('secret.example.com');
    expect(JSON.stringify(providers)).not.toContain('DASHSCOPE_API_KEY');

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('status ext methods return error cells when workspace snapshots fail', async () => {
    mockConfig = {
      ...mockConfig,
      getTargetDir: vi.fn().mockReturnValue('/work/status'),
      getMcpServers: vi.fn(() => {
        throw new Error('broken mcp config');
      }),
      getAuthType: vi.fn().mockReturnValue('qwen'),
      getActiveRuntimeModelSnapshot: vi.fn().mockReturnValue(undefined),
      getModel: vi.fn().mockReturnValue('qwen-plus'),
      getAllConfiguredModels: vi.fn(() => {
        throw new Error('broken provider config');
      }),
    } as unknown as Config;

    const agentPromise = runAcpAgent(
      mockConfig,
      makeSessionSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    await expect(
      agent.extMethod(SERVE_STATUS_EXT_METHODS.workspaceMcp, {}),
    ).resolves.toMatchObject({
      v: 1,
      workspaceCwd: '/work/status',
      initialized: true,
      servers: [],
      errors: [{ kind: 'mcp', status: 'error', error: 'broken mcp config' }],
    });
    await expect(
      agent.extMethod(SERVE_STATUS_EXT_METHODS.workspaceProviders, {}),
    ).resolves.toMatchObject({
      v: 1,
      workspaceCwd: '/work/status',
      initialized: true,
      providers: [],
      errors: [
        {
          kind: 'providers',
          status: 'error',
          error: 'broken provider config',
        },
      ],
    });

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('extMethod qwen/status/workspace/preflight returns 6 ACP-side cells', async () => {
    mockConfig = {
      ...mockConfig,
      getTargetDir: vi.fn().mockReturnValue('/work/status'),
      getMcpServers: vi.fn().mockReturnValue({}),
      getAuthType: vi.fn().mockReturnValue('qwen'),
      getActiveRuntimeModelSnapshot: vi.fn().mockReturnValue(undefined),
      getModel: vi.fn().mockReturnValue('qwen-plus'),
      getSkillManager: vi.fn().mockReturnValue({
        listSkills: vi.fn().mockResolvedValue([]),
      }),
      getAllConfiguredModels: vi.fn().mockReturnValue([
        {
          id: 'qwen-plus',
          label: 'Qwen Plus',
          authType: 'qwen',
          baseUrl: 'https://api.example.com',
          isRuntimeModel: false,
        },
      ]),
      getToolRegistry: vi
        .fn()
        .mockReturnValue({ getAllTools: () => [{ name: 'rg' }] }),
    } as unknown as Config;

    const agentPromise = runAcpAgent(
      mockConfig,
      makeSessionSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());
    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    const preflight = (await agent.extMethod(
      SERVE_STATUS_EXT_METHODS.workspacePreflight,
      {},
    )) as { cells: Array<{ kind: string; locality: string; status: string }> };

    expect(preflight.cells.map((c) => c.kind)).toEqual([
      'auth',
      'mcp_discovery',
      'skills',
      'providers',
      'tool_registry',
      'egress',
    ]);
    for (const cell of preflight.cells) {
      expect(cell.locality).toBe('acp');
    }
    expect(preflight.cells.find((c) => c.kind === 'egress')?.status).toBe(
      'not_started',
    );
    expect(
      preflight.cells.find((c) => c.kind === 'mcp_discovery')?.status,
    ).toBe('ok');
    expect(
      preflight.cells.find((c) => c.kind === 'tool_registry')?.status,
    ).toBe('ok');

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('extMethod preflight surfaces SkillError as parse_error errorKind', async () => {
    const skillError = new (
      await import('@qwen-code/qwen-code-core')
    ).SkillError('bad frontmatter', 'PARSE_ERROR');
    mockConfig = {
      ...mockConfig,
      getTargetDir: vi.fn().mockReturnValue('/work/status'),
      getMcpServers: vi.fn().mockReturnValue({}),
      getAuthType: vi.fn().mockReturnValue('qwen'),
      getModel: vi.fn().mockReturnValue('qwen-plus'),
      getSkillManager: vi.fn().mockReturnValue({
        listSkills: vi.fn().mockRejectedValue(skillError),
      }),
      getAllConfiguredModels: vi.fn().mockReturnValue([]),
      getToolRegistry: vi.fn().mockReturnValue({ getAllTools: () => [] }),
    } as unknown as Config;

    const agentPromise = runAcpAgent(
      mockConfig,
      makeSessionSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());
    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    const preflight = (await agent.extMethod(
      SERVE_STATUS_EXT_METHODS.workspacePreflight,
      {},
    )) as {
      cells: Array<{
        kind: string;
        status: string;
        errorKind?: string;
      }>;
    };
    const skillsCell = preflight.cells.find((c) => c.kind === 'skills');
    expect(skillsCell?.status).toBe('error');
    expect(skillsCell?.errorKind).toBe('parse_error');

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('extMethod preflight returns 6 cells even when a Config getter throws synchronously', async () => {
    // Regression guard: `getSkillManager()` is invoked by `buildSkillsPreflightCell`.
    // Before the fix it ran OUTSIDE the try block, so a sync throw escaped
    // out of `buildAcpPreflightCells` → the whole envelope 500'd. The
    // wrapped variant should produce a `skills` error cell instead and
    // keep the other five cells intact.
    mockConfig = {
      ...mockConfig,
      getTargetDir: vi.fn().mockReturnValue('/work/status'),
      getMcpServers: vi.fn().mockReturnValue({}),
      getAuthType: vi.fn().mockReturnValue('qwen'),
      getModel: vi.fn().mockReturnValue('qwen-plus'),
      getSkillManager: vi.fn(() => {
        throw new Error('config getter exploded mid-eval');
      }),
      getAllConfiguredModels: vi.fn().mockReturnValue([]),
      getToolRegistry: vi.fn().mockReturnValue({ getAllTools: () => [] }),
    } as unknown as Config;

    const agentPromise = runAcpAgent(
      mockConfig,
      makeSessionSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());
    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    const preflight = (await agent.extMethod(
      SERVE_STATUS_EXT_METHODS.workspacePreflight,
      {},
    )) as { cells: Array<{ kind: string; status: string; error?: string }> };

    expect(preflight.cells.map((c) => c.kind)).toEqual([
      'auth',
      'mcp_discovery',
      'skills',
      'providers',
      'tool_registry',
      'egress',
    ]);
    const skillsCell = preflight.cells.find((c) => c.kind === 'skills');
    expect(skillsCell?.status).toBe('error');
    expect(skillsCell?.error).toContain('config getter exploded');

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('provider status marks current only for matching models', async () => {
    mockConfig = {
      ...mockConfig,
      getTargetDir: vi.fn().mockReturnValue('/work/status'),
      getAuthType: vi.fn().mockReturnValue('qwen'),
      getActiveRuntimeModelSnapshot: vi.fn().mockReturnValue(undefined),
      getModel: vi.fn().mockReturnValue('missing-model'),
      getAllConfiguredModels: vi.fn().mockReturnValue([
        {
          id: 'qwen-plus',
          label: 'Qwen Plus',
          authType: 'qwen',
        },
      ]),
    } as unknown as Config;

    const agentPromise = runAcpAgent(
      mockConfig,
      makeSessionSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    await expect(
      agent.extMethod(SERVE_STATUS_EXT_METHODS.workspaceProviders, {}),
    ).resolves.toMatchObject({
      current: { authType: 'qwen', modelId: 'missing-model(qwen)' },
      providers: [
        {
          authType: 'qwen',
          current: false,
          models: [
            {
              modelId: 'qwen-plus(qwen)',
              baseModelId: 'qwen-plus',
              contextLimit: 128_000,
              isCurrent: false,
            },
          ],
        },
      ],
    });

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('provider status uses runtime model ids for base id and token limit', async () => {
    mockConfig = {
      ...mockConfig,
      getTargetDir: vi.fn().mockReturnValue('/work/status'),
      getAuthType: vi.fn().mockReturnValue('qwen'),
      getActiveRuntimeModelSnapshot: vi.fn().mockReturnValue({
        id: 'runtime-qwen-plus',
        authType: 'qwen',
      }),
      getModel: vi.fn().mockReturnValue('qwen-plus'),
      getAllConfiguredModels: vi.fn().mockReturnValue([
        {
          id: 'qwen-plus',
          runtimeSnapshotId: 'runtime-qwen-plus',
          label: 'Runtime Qwen Plus',
          authType: 'qwen',
          isRuntimeModel: true,
        },
      ]),
    } as unknown as Config;

    const agentPromise = runAcpAgent(
      mockConfig,
      makeSessionSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    await expect(
      agent.extMethod(SERVE_STATUS_EXT_METHODS.workspaceProviders, {}),
    ).resolves.toMatchObject({
      current: { authType: 'qwen', modelId: 'runtime-qwen-plus(qwen)' },
      providers: [
        {
          authType: 'qwen',
          current: true,
          models: [
            {
              modelId: 'runtime-qwen-plus(qwen)',
              baseModelId: 'runtime-qwen-plus',
              contextLimit: 128_000,
              isCurrent: true,
              isRuntime: true,
            },
          ],
        },
      ],
    });
    expect(vi.mocked(tokenLimit)).toHaveBeenCalledWith('runtime-qwen-plus');

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('status ext methods expose live session context and supported commands', async () => {
    const sessionId = '11111111-1111-1111-1111-111111111111';
    const innerConfig = await setupSessionMocks(sessionId);
    vi.mocked(buildAvailableCommandsSnapshot).mockResolvedValueOnce({
      availableCommands: [
        {
          name: 'init',
          description: 'Initialize',
          input: null,
        },
      ],
      availableSkills: ['review'],
    });

    const agentPromise = runAcpAgent(
      mockConfig,
      makeSessionSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    const context = await agent.extMethod(
      SERVE_STATUS_EXT_METHODS.sessionContext,
      { sessionId },
    );
    const supportedCommands = await agent.extMethod(
      SERVE_STATUS_EXT_METHODS.sessionSupportedCommands,
      { sessionId },
    );

    expect(context).toMatchObject({
      v: 1,
      sessionId,
      workspaceCwd: '/tmp',
      state: {
        models: { currentModelId: 'm(api-key)', availableModels: [] },
        modes: { currentModeId: 'default', availableModes: [] },
      },
    });
    expect(supportedCommands).toEqual({
      v: 1,
      sessionId,
      availableCommands: [
        {
          name: 'init',
          description: 'Initialize',
          input: null,
        },
      ],
      availableSkills: ['review'],
    });
    expect(buildAvailableCommandsSnapshot).toHaveBeenCalledWith(innerConfig);

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('newSession with SSE MCP server creates MCPServerConfig with url', async () => {
    await setupSessionMocks('session-sse');

    const agentPromise = runAcpAgent(
      mockConfig,
      makeSessionSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    await agent.newSession({
      cwd: '/tmp',
      mcpServers: [
        {
          type: 'sse',
          name: 'my-sse-server',
          url: 'http://localhost:3001/sse',
          headers: [{ name: 'Authorization', value: 'Bearer token123' }],
        },
      ],
    });

    expect(MCPServerConfig).toHaveBeenCalledWith(
      undefined,
      undefined,
      undefined,
      undefined,
      'http://localhost:3001/sse',
      undefined,
      { Authorization: 'Bearer token123' },
    );

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('qwen/settings extension methods read and update user memory settings', async () => {
    const settings = makeMemorySettings({
      enableManagedAutoMemory: false,
      enableManagedAutoDream: 'invalid',
    });
    vi.mocked(loadSettings).mockReturnValue(settings);
    const agentPromise = runAcpAgent(mockConfig, settings, mockArgv);

    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    await expect(agent.extMethod('qwen/settings/getPath', {})).resolves.toEqual(
      {
        path: '/home/test/.qwen/settings.json',
      },
    );
    await expect(
      agent.extMethod('qwen/settings/getMemory', {}),
    ).resolves.toEqual({
      settings: {
        enableManagedAutoMemory: false,
        enableManagedAutoDream: false,
        enableAutoSkill: false,
      },
    });
    await expect(
      agent.extMethod('qwen/settings/getMemoryPaths', {
        cwd: '/tmp/qwen-memory-cwd-test',
        projectRoot: '/tmp/qwen-memory-root-test',
      }),
    ).resolves.toEqual({
      paths: {
        userMemoryFile: path.join('/tmp/qwen-global-test', 'QWEN.md'),
        projectMemoryFile: path.join('/tmp/qwen-memory-cwd-test', 'QWEN.md'),
        autoMemoryDir: '/tmp/qwen-memory-root-test/.qwen/memory',
      },
    });
    await expect(
      agent.extMethod('qwen/settings/setMemory', {
        updates: {
          enableManagedAutoDream: true,
          enableAutoSkill: true,
        },
      }),
    ).resolves.toEqual({
      settings: {
        enableManagedAutoMemory: false,
        enableManagedAutoDream: true,
        enableAutoSkill: true,
      },
    });

    expect(settings.setValue).toHaveBeenCalledWith(
      'User',
      'memory.enableManagedAutoDream',
      true,
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      'User',
      'memory.enableAutoSkill',
      true,
    );

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('qwen/settings setCoreValue syncs output language rule file', async () => {
    const settings = makeCoreSettings();
    vi.mocked(loadSettings).mockReturnValue(settings);
    const agentPromise = runAcpAgent(mockConfig, settings, mockArgv);

    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    await agent.extMethod('qwen/settings/setCoreValue', {
      scope: 'user',
      key: 'general.outputLanguage',
      value: 'Japanese',
    });

    expect(settings.setValue).toHaveBeenCalledWith(
      'User',
      'general.outputLanguage',
      'Japanese',
    );
    expect(updateOutputLanguageFile).toHaveBeenCalledWith('Japanese');

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('qwen/providers extension methods list and connect model providers', async () => {
    const settings = makeSessionSettings();
    const agentPromise = runAcpAgent(mockConfig, settings, mockArgv);

    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    await expect(agent.extMethod('qwen/providers/list', {})).resolves.toEqual({
      providers: [
        expect.objectContaining({
          id: 'deepseek',
          label: 'DeepSeek API Key',
          defaultModelIds: ['deepseek-chat'],
          uiGroup: 'third-party',
        }),
      ],
    });

    await expect(
      agent.extMethod('qwen/providers/connect', {
        providerId: 'deepseek',
        apiKey: 'sk-test',
        modelIds: ['deepseek-chat'],
      }),
    ).resolves.toEqual({
      success: true,
      providerId: 'deepseek',
      providerLabel: 'DeepSeek API Key',
      authType: 'openai',
      modelId: 'deepseek-chat',
    });

    expect(buildInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'deepseek' }),
      expect.objectContaining({
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-test',
        modelIds: ['deepseek-chat'],
      }),
    );
    expect(applyProviderInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'deepseek' }),
      expect.objectContaining({ settings }),
    );

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('qwen/providers/list includes existing provider settings', async () => {
    const settings = {
      ...makeSessionSettings(),
      merged: {
        mcpServers: {},
        env: { DEEPSEEK_API_KEY: 'sk-existing' },
        modelProviders: {
          openai: [
            {
              id: 'deepseek-chat',
              baseUrl: 'https://api.deepseek.com',
              envKey: 'DEEPSEEK_API_KEY',
            },
            {
              id: 'other-model',
              baseUrl: 'https://api.other.com',
              envKey: 'OTHER_API_KEY',
            },
          ],
        },
      },
    } as unknown as LoadedSettings;
    const agentPromise = runAcpAgent(mockConfig, settings, mockArgv);

    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    await expect(agent.extMethod('qwen/providers/list', {})).resolves.toEqual({
      providers: [
        expect.objectContaining({
          id: 'deepseek',
          existingConfig: {
            protocol: 'openai',
            baseUrl: 'https://api.deepseek.com',
            hasApiKey: true,
            modelIds: ['deepseek-chat'],
          },
        }),
      ],
    });

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('qwen/skills/install installs a GitHub directory skill through ACP', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.mocked(Storage.getGlobalQwenDir).mockReturnValue(tempHome);

    const refreshCache = vi.fn().mockResolvedValue(undefined);
    const parseSkillContent = vi.fn(
      (_content: string, filePath: string, level: string) => ({
        name: 'pptx',
        description: 'Create slide decks',
        level,
        filePath,
        skillRoot: path.dirname(filePath),
        body: 'Create slide decks',
      }),
    );
    mockConfig = {
      ...mockConfig,
      getSkillManager: vi.fn().mockReturnValue({
        parseSkillContent,
        refreshCache,
      }),
    } as unknown as Config;

    const skillContent =
      '---\nname: pptx\ndescription: Create slide decks\n---\nCreate slide decks\n';
    const editingContent = '# Editing guide\n';
    const toArrayBuffer = (buffer: Uint8Array): ArrayBuffer =>
      buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer;
    const directoryUrl =
      'https://api.github.com/repos/anthropics/skills/contents/skills/pptx?ref=main';
    const skillUrl =
      'https://raw.githubusercontent.com/anthropics/skills/main/skills/pptx/SKILL.md';
    const editingUrl =
      'https://raw.githubusercontent.com/anthropics/skills/main/skills/pptx/editing.md';
    const fetchMock = vi.fn(async (url: string) => {
      if (url === directoryUrl) {
        return {
          ok: true,
          status: 200,
          json: vi.fn().mockResolvedValue([
            {
              name: 'SKILL.md',
              path: 'skills/pptx/SKILL.md',
              type: 'file',
              download_url: skillUrl,
            },
            {
              name: 'editing.md',
              path: 'skills/pptx/editing.md',
              type: 'file',
              download_url: editingUrl,
            },
          ]),
        };
      }
      if (url === skillUrl) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: vi
            .fn()
            .mockResolvedValue(toArrayBuffer(Buffer.from(skillContent))),
        };
      }
      if (url === editingUrl) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: vi
            .fn()
            .mockResolvedValue(toArrayBuffer(Buffer.from(editingContent))),
        };
      }
      return {
        ok: false,
        status: 404,
        arrayBuffer: vi.fn().mockResolvedValue(toArrayBuffer(Buffer.alloc(0))),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const settings = makeSessionSettings();
    const agentPromise = runAcpAgent(mockConfig, settings, mockArgv);

    try {
      await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

      const agent = capturedAgentFactory!({
        get closed() {
          return mockConnectionState.promise;
        },
      }) as AgentLike;

      const installedPath = path.join(tempHome, 'skills', 'pptx', 'SKILL.md');
      await expect(
        agent.extMethod('qwen/skills/install', {
          skill: {
            id: 'pptx',
            slug: 'pptx',
            name: 'PPTX',
            sourceUrl:
              'https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md',
          },
        }),
      ).resolves.toMatchObject({
        id: 'pptx',
        slug: 'pptx',
        installed: true,
        installedPath,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        directoryUrl,
        expect.objectContaining({
          headers: expect.objectContaining({
            Accept: 'application/vnd.github+json',
            'User-Agent': 'qwen-code',
          }),
        }),
      );
      expect(
        fetchMock.mock.calls.some(([url]) => {
          const { hostname } = new URL(String(url));
          return hostname === 'codeload.github.com';
        }),
      ).toBe(false);
      expect(parseSkillContent).toHaveBeenCalledWith(
        expect.stringContaining('name: pptx'),
        installedPath,
        'user',
      );
      expect(refreshCache).toHaveBeenCalledTimes(1);
      await expect(fs.readFile(installedPath, 'utf8')).resolves.toContain(
        'name: pptx',
      );
      await expect(
        fs.readFile(
          path.join(tempHome, 'skills', 'pptx', 'editing.md'),
          'utf8',
        ),
      ).resolves.toBe(editingContent);
    } finally {
      mockConnectionState.resolve();
      await agentPromise;
      vi.unstubAllGlobals();
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('qwen/skills setEnabled and delete manage global skills through ACP', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.mocked(Storage.getGlobalQwenDir).mockReturnValue(tempHome);

    const skillDir = path.join(tempHome, 'skills', 'pptx');
    const skillFile = path.join(skillDir, 'SKILL.md');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      skillFile,
      '---\nname: pptx\ndescription: Create slide decks\n---\nBody\n',
      'utf8',
    );

    const refreshCache = vi.fn().mockResolvedValue(undefined);
    const parseSkillContent = vi.fn(
      (_content: string, filePath: string, level: string) => ({
        name: 'pptx',
        description: 'Create slide decks',
        level,
        filePath,
        skillRoot: path.dirname(filePath),
        body: 'Body',
      }),
    );
    mockConfig = {
      ...mockConfig,
      getSkillManager: vi.fn().mockReturnValue({
        parseSkillContent,
        refreshCache,
      }),
    } as unknown as Config;

    const settings = makeSessionSettings();
    const agentPromise = runAcpAgent(mockConfig, settings, mockArgv);

    try {
      await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

      const agent = capturedAgentFactory!({
        get closed() {
          return mockConnectionState.promise;
        },
      }) as AgentLike;

      await expect(
        agent.extMethod('qwen/skills/setEnabled', {
          skill: { slug: 'pptx', enabled: false },
        }),
      ).resolves.toMatchObject({
        slug: 'pptx',
        enabled: false,
        installedPath: skillFile,
      });
      await expect(fs.readFile(skillFile, 'utf8')).resolves.toContain(
        'disable-model-invocation: true',
      );

      await expect(
        agent.extMethod('qwen/skills/setEnabled', {
          skill: { slug: 'pptx', enabled: true },
        }),
      ).resolves.toMatchObject({
        slug: 'pptx',
        enabled: true,
      });
      await expect(fs.readFile(skillFile, 'utf8')).resolves.not.toContain(
        'disable-model-invocation',
      );

      await expect(
        agent.extMethod('qwen/skills/delete', {
          skill: { slug: 'pptx' },
        }),
      ).resolves.toMatchObject({
        slug: 'pptx',
        deleted: true,
      });
      await expect(fs.stat(skillDir)).rejects.toThrow();
      expect(refreshCache).toHaveBeenCalledTimes(3);
    } finally {
      mockConnectionState.resolve();
      await agentPromise;
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('qwen/skills rejects path-traversal slugs without touching the global dir', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.mocked(Storage.getGlobalQwenDir).mockReturnValue(tempHome);
    // A sentinel that a `..` traversal could overwrite (install) or delete.
    const sentinel = path.join(tempHome, 'settings.json');
    await fs.writeFile(sentinel, '{"keep":true}', 'utf8');

    mockConfig = {
      ...mockConfig,
      getSkillManager: vi.fn().mockReturnValue({
        parseSkillContent: vi.fn(),
        refreshCache: vi.fn().mockResolvedValue(undefined),
        listSkills: vi.fn().mockResolvedValue([]),
      }),
    } as unknown as Config;

    const settings = makeSessionSettings();
    const agentPromise = runAcpAgent(mockConfig, settings, mockArgv);

    try {
      await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

      const agent = capturedAgentFactory!({
        get closed() {
          return mockConnectionState.promise;
        },
      }) as AgentLike;

      for (const slug of ['..', '.']) {
        await expect(
          agent.extMethod('qwen/skills/install', {
            skill: {
              slug,
              sourceUrl:
                'https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md',
            },
          }),
        ).rejects.toThrow('Invalid skill.slug');
        await expect(
          agent.extMethod('qwen/skills/delete', { skill: { slug } }),
        ).rejects.toThrow('Invalid skill.slug');
        await expect(
          agent.extMethod('qwen/skills/setEnabled', {
            skill: { slug, enabled: false },
          }),
        ).rejects.toThrow('Invalid skill.slug');
      }

      // The global config dir and its contents are untouched.
      await expect(fs.readFile(sentinel, 'utf8')).resolves.toContain('keep');
    } finally {
      mockConnectionState.resolve();
      await agentPromise;
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('qwen/skills setEnabled preserves comments and nested hooks in frontmatter', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    vi.mocked(Storage.getGlobalQwenDir).mockReturnValue(tempHome);

    const skillDir = path.join(tempHome, 'skills', 'pptx');
    const skillFile = path.join(skillDir, 'SKILL.md');
    await fs.mkdir(skillDir, { recursive: true });
    const original =
      '---\n' +
      '# keep this comment\n' +
      'name: pptx\n' +
      'description: Create slide decks\n' +
      'hooks:\n' +
      '  PreToolUse:\n' +
      '    - matcher: Bash\n' +
      '      command: echo hi\n' +
      '---\n' +
      'Body\n';
    await fs.writeFile(skillFile, original, 'utf8');

    const parseSkillContent = vi.fn(
      (_content: string, filePath: string, level: string) => ({
        name: 'pptx',
        description: 'Create slide decks',
        level,
        filePath,
        skillRoot: path.dirname(filePath),
        body: 'Body',
      }),
    );
    mockConfig = {
      ...mockConfig,
      getSkillManager: vi.fn().mockReturnValue({
        parseSkillContent,
        refreshCache: vi.fn().mockResolvedValue(undefined),
      }),
    } as unknown as Config;

    const settings = makeSessionSettings();
    const agentPromise = runAcpAgent(mockConfig, settings, mockArgv);

    try {
      await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

      const agent = capturedAgentFactory!({
        get closed() {
          return mockConnectionState.promise;
        },
      }) as AgentLike;

      await agent.extMethod('qwen/skills/setEnabled', {
        skill: { slug: 'pptx', enabled: false },
      });
      let content = await fs.readFile(skillFile, 'utf8');
      expect(content).toContain('# keep this comment');
      expect(content).toContain('hooks:');
      expect(content).toContain('matcher: Bash');
      expect(content).toContain('command: echo hi');
      expect(content).toContain('disable-model-invocation: true');

      await agent.extMethod('qwen/skills/setEnabled', {
        skill: { slug: 'pptx', enabled: true },
      });
      content = await fs.readFile(skillFile, 'utf8');
      expect(content).toContain('# keep this comment');
      expect(content).toContain('hooks:');
      expect(content).toContain('matcher: Bash');
      expect(content).toContain('command: echo hi');
      expect(content).not.toContain('disable-model-invocation');
    } finally {
      mockConnectionState.resolve();
      await agentPromise;
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('qwen/settings setCoreValue accepts the auto approval mode', async () => {
    const settings = makeCoreSettings();
    vi.mocked(loadSettings).mockReturnValue(settings);
    const agentPromise = runAcpAgent(mockConfig, settings, mockArgv);

    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    await expect(
      agent.extMethod('qwen/settings/setCoreValue', {
        scope: 'user',
        key: 'tools.approvalMode',
        value: 'auto',
      }),
    ).resolves.toBeDefined();

    expect(settings.setValue).toHaveBeenCalledWith(
      'User',
      'tools.approvalMode',
      'auto',
    );

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('qwen/providers/connect reuses the stored apiKey when the client omits it', async () => {
    const settings = {
      ...makeSessionSettings(),
      merged: {
        mcpServers: {},
        env: { DEEPSEEK_API_KEY: 'sk-existing' },
        modelProviders: {
          openai: [
            {
              id: 'deepseek-chat',
              baseUrl: 'https://api.deepseek.com',
              envKey: 'DEEPSEEK_API_KEY',
            },
          ],
        },
      },
    } as unknown as LoadedSettings;
    const agentPromise = runAcpAgent(mockConfig, settings, mockArgv);

    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    await expect(
      agent.extMethod('qwen/providers/connect', {
        providerId: 'deepseek',
        modelIds: ['deepseek-chat'],
      }),
    ).resolves.toMatchObject({ success: true, providerId: 'deepseek' });

    expect(buildInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'deepseek' }),
      expect.objectContaining({ apiKey: 'sk-existing' }),
    );

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('qwen/skills setEnabled resolves user and project skill files through ACP', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-skill-'));
    const tempProject = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-project-skill-'),
    );
    vi.mocked(Storage.getGlobalQwenDir).mockReturnValue(tempHome);

    async function writeSkill(root: string, relativeDir: string, name: string) {
      const skillDir = path.join(root, relativeDir, name);
      const skillFile = path.join(skillDir, 'SKILL.md');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        skillFile,
        `---\nname: ${name}\ndescription: ${name} skill\n---\nBody\n`,
        'utf8',
      );
      return { skillDir, skillFile };
    }

    const userSkill = await writeSkill(tempHome, '.agents/skills', 'course');
    const projectSkill = await writeSkill(
      tempProject,
      '.qwen/skills',
      'project-course',
    );

    const refreshCache = vi.fn().mockResolvedValue(undefined);
    const listSkills = vi.fn(({ level }: { level: 'user' | 'project' }) =>
      Promise.resolve([
        ...(level === 'user'
          ? [
              {
                name: 'course',
                description: 'course skill',
                level,
                filePath: userSkill.skillFile,
                skillRoot: userSkill.skillDir,
                body: 'Body',
              },
            ]
          : []),
        ...(level === 'project'
          ? [
              {
                name: 'project-course',
                description: 'project-course skill',
                level,
                filePath: projectSkill.skillFile,
                skillRoot: projectSkill.skillDir,
                body: 'Body',
              },
            ]
          : []),
      ]),
    );
    const parseSkillContent = vi.fn(
      (content: string, filePath: string, level: string) => {
        const name =
          content.match(/^name:\s*(.+)$/m)?.[1] ??
          path.basename(path.dirname(filePath));
        return {
          name,
          description: `${name} skill`,
          level,
          filePath,
          skillRoot: path.dirname(filePath),
          body: 'Body',
        };
      },
    );
    mockConfig = {
      ...mockConfig,
      getSkillManager: vi.fn().mockReturnValue({
        listSkills,
        parseSkillContent,
        refreshCache,
      }),
    } as unknown as Config;

    const settings = makeSessionSettings();
    const agentPromise = runAcpAgent(mockConfig, settings, mockArgv);

    try {
      await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

      const agent = capturedAgentFactory!({
        get closed() {
          return mockConnectionState.promise;
        },
      }) as AgentLike;

      await expect(
        agent.extMethod('qwen/skills/setEnabled', {
          skill: { slug: 'course', enabled: false },
        }),
      ).resolves.toMatchObject({
        slug: 'course',
        enabled: false,
        installedPath: userSkill.skillFile,
      });
      await expect(fs.readFile(userSkill.skillFile, 'utf8')).resolves.toContain(
        'disable-model-invocation: true',
      );

      await expect(
        agent.extMethod('qwen/skills/setEnabled', {
          skill: {
            slug: 'project-course',
            enabled: false,
            scope: 'project',
          },
        }),
      ).resolves.toMatchObject({
        slug: 'project-course',
        enabled: false,
        installedPath: projectSkill.skillFile,
      });
      await expect(
        fs.readFile(projectSkill.skillFile, 'utf8'),
      ).resolves.toContain('disable-model-invocation: true');

      await expect(
        agent.extMethod('qwen/skills/delete', {
          skill: { slug: 'course' },
        }),
      ).resolves.toMatchObject({
        slug: 'course',
        deleted: true,
      });
      await expect(fs.stat(userSkill.skillDir)).rejects.toThrow();
      expect(listSkills).toHaveBeenCalledWith({ level: 'user' });
      expect(listSkills).toHaveBeenCalledWith({ level: 'project' });
      expect(parseSkillContent).toHaveBeenCalledWith(
        expect.stringContaining('name: project-course'),
        projectSkill.skillFile,
        'project',
      );
      expect(refreshCache).toHaveBeenCalledTimes(3);
    } finally {
      mockConnectionState.resolve();
      await agentPromise;
      await fs.rm(tempHome, { recursive: true, force: true });
      await fs.rm(tempProject, { recursive: true, force: true });
    }
  });

  it('qwen/skills setEnabled resolves project skills from the ext method cwd', async () => {
    const tempProject = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-project-cwd-skill-'),
    );
    const skillDir = path.join(tempProject, '.qwen', 'skills', 'issue-fixer');
    const skillFile = path.join(skillDir, 'SKILL.md');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      skillFile,
      `---\nname: bugfix\ndescription: Bugfix skill\n---\nBody\n`,
      'utf8',
    );

    const refreshCache = vi.fn().mockResolvedValue(undefined);
    const listSkills = vi.fn().mockResolvedValue([]);
    const parseSkillContent = vi.fn(
      (content: string, filePath: string, level: string) => {
        const name =
          content.match(/^name:\s*(.+)$/m)?.[1] ??
          path.basename(path.dirname(filePath));
        return {
          name,
          description: `${name} skill`,
          level,
          filePath,
          skillRoot: path.dirname(filePath),
          body: 'Body',
        };
      },
    );
    const loadSkillsFromDir = vi.fn(async (baseDir: string, level: string) => {
      const entries = await fs
        .readdir(baseDir, { withFileTypes: true })
        .catch(() => []);
      const skills = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const filePath = path.join(baseDir, entry.name, 'SKILL.md');
        const content = await fs.readFile(filePath, 'utf8').catch(() => null);
        if (!content) continue;
        skills.push(parseSkillContent(content, filePath, level));
      }
      return skills;
    });
    mockConfig = {
      ...mockConfig,
      getSkillManager: vi.fn().mockReturnValue({
        listSkills,
        loadSkillsFromDir,
        parseSkillContent,
        refreshCache,
      }),
    } as unknown as Config;

    const settings = makeSessionSettings();
    const agentPromise = runAcpAgent(mockConfig, settings, mockArgv);

    try {
      await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

      const agent = capturedAgentFactory!({
        get closed() {
          return mockConnectionState.promise;
        },
      }) as AgentLike;

      await expect(
        agent.extMethod('qwen/skills/setEnabled', {
          cwd: tempProject,
          skill: { slug: 'bugfix', enabled: false, scope: 'project' },
        }),
      ).resolves.toMatchObject({
        slug: 'bugfix',
        enabled: false,
        installedPath: skillFile,
      });
      await expect(fs.readFile(skillFile, 'utf8')).resolves.toContain(
        'disable-model-invocation: true',
      );
      expect(loadSkillsFromDir).toHaveBeenCalledWith(
        path.join(tempProject, '.qwen', 'skills'),
        'project',
      );
      expect(listSkills).not.toHaveBeenCalled();
      expect(refreshCache).toHaveBeenCalledTimes(1);
    } finally {
      mockConnectionState.resolve();
      await agentPromise;
      await fs.rm(tempProject, { recursive: true, force: true });
    }
  });

  it('bootstraps ACP config without initializing Gemini chat', async () => {
    await setupSessionMocks('session-bootstrap-skip');

    const agentPromise = runAcpAgent(
      mockConfig,
      makeSessionSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    expect(mockConfig.initialize).toHaveBeenCalledWith({
      skipGeminiInitialization: true,
    });

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('first ACP session fires SessionStart only from the real session initialize path', async () => {
    const innerConfig = await setupSessionMocks(
      'session-no-direct-session-start',
    );
    const fireSessionStartEvent = vi.fn().mockResolvedValue(undefined);
    const initialize = vi.fn().mockImplementation(async () => {
      await fireSessionStartEvent('startup', 'test-model', 'default');
    });
    innerConfig.getHookSystem = vi.fn().mockReturnValue({
      fireSessionStartEvent,
    });
    innerConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
    innerConfig.hasHooksForEvent = vi.fn().mockReturnValue(true);
    innerConfig.getModel = vi.fn().mockReturnValue('test-model');
    innerConfig.getApprovalMode = vi.fn().mockReturnValue('default');
    innerConfig.getGeminiClient = vi.fn().mockReturnValue({
      isInitialized: vi.fn().mockReturnValue(false),
      initialize,
    });

    const agentPromise = runAcpAgent(
      mockConfig,
      makeSessionSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    await agent.newSession({ cwd: '/tmp', mcpServers: [] });

    expect(mockConfig.initialize).toHaveBeenCalledWith({
      skipGeminiInitialization: true,
    });
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(fireSessionStartEvent).toHaveBeenCalledTimes(1);
    expect(fireSessionStartEvent).toHaveBeenCalledWith(
      'startup',
      'test-model',
      'default',
    );

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('qwen/settings setMemory rejects non-boolean values', async () => {
    const settings = makeMemorySettings();
    const agentPromise = runAcpAgent(mockConfig, settings, mockArgv);

    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    await expect(
      agent.extMethod('qwen/settings/setMemory', {
        updates: { enableManagedAutoDream: 'yes' },
      }),
    ).rejects.toThrow("Invalid memory setting 'enableManagedAutoDream'");

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('does not directly re-fire SessionStart for subsequent ACP sessions when GeminiClient is already initialized', async () => {
    const innerConfig = await setupSessionMocks(
      'session-followup-session-start',
    );
    const fireSessionStartEvent = vi.fn().mockResolvedValue(undefined);
    const initialize = vi.fn().mockResolvedValue(undefined);
    innerConfig.getHookSystem = vi.fn().mockReturnValue({
      fireSessionStartEvent,
    });
    innerConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
    innerConfig.hasHooksForEvent = vi.fn().mockReturnValue(true);
    innerConfig.getModel = vi.fn().mockReturnValue('test-model');
    innerConfig.getApprovalMode = vi.fn().mockReturnValue('default');
    innerConfig.getGeminiClient = vi
      .fn()
      .mockReturnValueOnce({
        isInitialized: vi.fn().mockReturnValue(false),
        initialize,
      })
      .mockReturnValueOnce({
        isInitialized: vi.fn().mockReturnValue(true),
        initialize,
      });

    const agentPromise = runAcpAgent(
      mockConfig,
      makeSessionSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.newSession({ cwd: '/tmp', mcpServers: [] });

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(fireSessionStartEvent).not.toHaveBeenCalled();

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('fires SessionEnd for each active ACP session config on connection.closed', async () => {
    const bootstrapHookSystem = {
      fireSessionEndEvent: vi.fn().mockResolvedValue(undefined),
      fireSessionStartEvent: vi.fn().mockResolvedValue(undefined),
    };
    mockConfig.getHookSystem = vi.fn().mockReturnValue(bootstrapHookSystem);
    mockConfig.hasHooksForEvent = vi
      .fn()
      .mockImplementation((event: string) => event === 'SessionEnd');

    const innerConfigA = await setupSessionMocks('session-end-a');
    const sessionHookSystemA = {
      fireSessionEndEvent: vi.fn().mockResolvedValue(undefined),
      fireSessionStartEvent: vi.fn().mockResolvedValue(undefined),
    };
    innerConfigA.getHookSystem = vi.fn().mockReturnValue(sessionHookSystemA);
    innerConfigA.getDisableAllHooks = vi.fn().mockReturnValue(false);
    innerConfigA.hasHooksForEvent = vi
      .fn()
      .mockImplementation((event: string) => event === 'SessionEnd');
    innerConfigA.getGeminiClient = vi.fn().mockReturnValue({
      isInitialized: vi.fn().mockReturnValue(false),
      initialize: vi.fn().mockResolvedValue(undefined),
    });

    const innerConfigB = makeInnerConfig();
    innerConfigB.getSessionId = vi.fn().mockReturnValue('session-end-b');
    const sessionHookSystemB = {
      fireSessionEndEvent: vi.fn().mockResolvedValue(undefined),
      fireSessionStartEvent: vi.fn().mockResolvedValue(undefined),
    };
    innerConfigB.getHookSystem = vi.fn().mockReturnValue(sessionHookSystemB);
    innerConfigB.getDisableAllHooks = vi.fn().mockReturnValue(false);
    innerConfigB.hasHooksForEvent = vi
      .fn()
      .mockImplementation((event: string) => event === 'SessionEnd');
    innerConfigB.getGeminiClient = vi.fn().mockReturnValue({
      isInitialized: vi.fn().mockReturnValue(false),
      initialize: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(loadCliConfig)
      .mockResolvedValueOnce(innerConfigA as unknown as Config)
      .mockResolvedValueOnce(innerConfigB as unknown as Config);
    vi.mocked(Session).mockImplementation((...args: unknown[]) => {
      const sessionId = args[0] as string;
      const cfg = sessionId === 'session-end-a' ? innerConfigA : innerConfigB;
      return {
        getId: vi.fn().mockReturnValue(sessionId),
        getConfig: vi.fn().mockReturnValue(cfg),
        sendAvailableCommandsUpdate: vi.fn().mockResolvedValue(undefined),
        replayHistory: vi.fn().mockResolvedValue(undefined),
        installRewriter: vi.fn(),
      } as unknown as InstanceType<typeof Session>;
    });
    vi.mocked(loadSettings).mockReturnValue(makeSessionSettings());

    const agentPromise = runAcpAgent(
      mockConfig,
      makeSessionSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    await agent.newSession({ cwd: '/tmp', mcpServers: [] });

    mockConnectionState.resolve();
    await agentPromise;

    expect(bootstrapHookSystem.fireSessionEndEvent).toHaveBeenCalledWith(
      SessionEndReason.PromptInputExit,
    );
    expect(sessionHookSystemA.fireSessionEndEvent).toHaveBeenCalledWith(
      SessionEndReason.PromptInputExit,
    );
    expect(sessionHookSystemB.fireSessionEndEvent).toHaveBeenCalledWith(
      SessionEndReason.PromptInputExit,
    );
  });

  it('rewindSession extension method rewinds the active session', async () => {
    const sessionId = '11111111-1111-1111-1111-111111111111';
    await setupSessionMocks(sessionId);

    const agentPromise = runAcpAgent(
      mockConfig,
      makeSessionSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    const response = await agent.extMethod('rewindSession', {
      sessionId,
      targetTurnIndex: 1,
      cwd: '/tmp',
    });

    expect(lastSessionMock?.rewindToTurn).toHaveBeenCalledWith(1);
    expect(response).toEqual({
      success: true,
      historyBeforeRewind: [{ role: 'user', parts: [{ text: 'before' }] }],
      targetTurnIndex: 1,
      apiTruncateIndex: 2,
    });

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('rewindSession rejects invalid session ids', async () => {
    await setupSessionMocks('11111111-1111-1111-1111-111111111111');

    const agentPromise = runAcpAgent(
      mockConfig,
      makeSessionSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    await expect(
      agent.extMethod('rewindSession', {
        sessionId: '../bad',
        targetTurnIndex: 1,
      }),
    ).rejects.toThrow('Invalid or missing sessionId');

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('rewindSession rejects invalid target turn indexes', async () => {
    const sessionId = '11111111-1111-1111-1111-111111111111';
    await setupSessionMocks(sessionId);

    const agentPromise = runAcpAgent(
      mockConfig,
      makeSessionSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    await expect(
      agent.extMethod('rewindSession', {
        sessionId,
        targetTurnIndex: -1,
      }),
    ).rejects.toThrow('Invalid or missing targetTurnIndex');

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('rewindSession rejects missing sessions', async () => {
    const sessionId = '11111111-1111-1111-1111-111111111111';
    await setupSessionMocks(sessionId);

    const agentPromise = runAcpAgent(
      mockConfig,
      makeSessionSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    await expect(
      agent.extMethod('rewindSession', {
        sessionId: '22222222-2222-2222-2222-222222222222',
        targetTurnIndex: 1,
      }),
    ).rejects.toThrow('Session not found');

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('restoreSessionHistory extension method restores the active session history', async () => {
    const sessionId = '11111111-1111-1111-1111-111111111111';
    await setupSessionMocks(sessionId);

    const agentPromise = runAcpAgent(
      mockConfig,
      makeSessionSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    const history = [{ role: 'user', parts: [{ text: 'restored' }] }];
    const response = await agent.extMethod('restoreSessionHistory', {
      sessionId,
      history,
      cwd: '/tmp',
    });

    expect(lastSessionMock?.restoreHistory).toHaveBeenCalledWith(history);
    expect(response).toEqual({ success: true });

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('restoreSessionHistory rejects invalid session ids', async () => {
    await setupSessionMocks('11111111-1111-1111-1111-111111111111');

    const agentPromise = runAcpAgent(
      mockConfig,
      makeSessionSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    await expect(
      agent.extMethod('restoreSessionHistory', {
        sessionId: '../bad',
        history: [],
      }),
    ).rejects.toThrow('Invalid or missing sessionId');

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('restoreSessionHistory rejects non-array history', async () => {
    const sessionId = '11111111-1111-1111-1111-111111111111';
    await setupSessionMocks(sessionId);

    const agentPromise = runAcpAgent(
      mockConfig,
      makeSessionSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    await expect(
      agent.extMethod('restoreSessionHistory', {
        sessionId,
        history: { role: 'user' },
      }),
    ).rejects.toThrow('Invalid or missing history');

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('restoreSessionHistory rejects missing sessions', async () => {
    const sessionId = '11111111-1111-1111-1111-111111111111';
    await setupSessionMocks(sessionId);

    const agentPromise = runAcpAgent(
      mockConfig,
      makeSessionSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    await expect(
      agent.extMethod('restoreSessionHistory', {
        sessionId: '22222222-2222-2222-2222-222222222222',
        history: [],
      }),
    ).rejects.toThrow('Session not found');

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('newSession with HTTP MCP server creates MCPServerConfig with httpUrl', async () => {
    await setupSessionMocks('session-http');

    const agentPromise = runAcpAgent(
      mockConfig,
      makeSessionSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    await agent.newSession({
      cwd: '/tmp',
      mcpServers: [
        {
          type: 'http',
          name: 'my-http-server',
          url: 'http://localhost:3002/mcp',
          headers: [],
        },
      ],
    });

    expect(MCPServerConfig).toHaveBeenCalledWith(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'http://localhost:3002/mcp',
      undefined,
    );

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('per-session newSession surfaces MCP failures to stderr (round-7 fix: was silent before)', async () => {
    // Round-7 regression: `QwenAgent.initializeConfig()` (per-session ACP
    // path) calls `waitForMcpReady()` but the round-4 fix only added the
    // failure warning to the top-level `runAcpAgent` path. Per-session
    // configs with failed MCP servers silently fell back to built-in
    // tools with zero user-visible indication, despite the inline comment
    // claiming "Same reasoning as the top-level runAcpAgent path."
    const innerConfig = await setupSessionMocks('session-failed-mcp');
    (
      innerConfig as unknown as { getFailedMcpServerNames: () => string[] }
    ).getFailedMcpServerNames = vi
      .fn()
      .mockReturnValue(['broken-server-a', 'broken-server-b']);
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    const agentPromise = runAcpAgent(
      mockConfig,
      makeSessionSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    await agent.newSession({ cwd: '/tmp', mcpServers: [] });

    // The warning must list both failed servers and mention "Warning:"
    // exactly like the top-level path and the other non-interactive
    // entry points (`gemini.tsx`, `session.ts`).
    const matchingWrite = stderrWrite.mock.calls.find(
      ([msg]) =>
        typeof msg === 'string' &&
        msg.includes('Warning: MCP server(s) failed to start') &&
        msg.includes('broken-server-a') &&
        msg.includes('broken-server-b'),
    );
    expect(matchingWrite).toBeDefined();

    stderrWrite.mockRestore();
    mockConnectionState.resolve();
    await agentPromise;
  });

  it('per-session newSession is safe when Config lacks getFailedMcpServerNames (defensive typeof check)', async () => {
    // Tests pass stubbed Configs without `getFailedMcpServerNames` — the
    // round-7 fix uses `typeof config.getFailedMcpServerNames ===
    // 'function'` so it must not throw, and must not write to stderr.
    await setupSessionMocks('session-stubbed-config');
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    const agentPromise = runAcpAgent(
      mockConfig,
      makeSessionSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    await expect(
      agent.newSession({ cwd: '/tmp', mcpServers: [] }),
    ).resolves.not.toThrow();
    const surfacedWarning = stderrWrite.mock.calls.find(
      ([msg]) =>
        typeof msg === 'string' &&
        msg.includes('Warning: MCP server(s) failed to start'),
    );
    expect(surfacedWarning).toBeUndefined();

    stderrWrite.mockRestore();
    mockConnectionState.resolve();
    await agentPromise;
  });

  it('newSession with SSE MCP server and empty headers passes undefined for headers', async () => {
    await setupSessionMocks('session-sse-noheaders');

    const agentPromise = runAcpAgent(
      mockConfig,
      makeSessionSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;

    await agent.newSession({
      cwd: '/tmp',
      mcpServers: [
        {
          type: 'sse',
          name: 'no-header-sse',
          url: 'http://localhost:3003/sse',
          headers: [],
        },
      ],
    });

    expect(MCPServerConfig).toHaveBeenCalledWith(
      undefined,
      undefined,
      undefined,
      undefined,
      'http://localhost:3003/sse',
      undefined,
      undefined,
    );

    mockConnectionState.resolve();
    await agentPromise;
  });

  // PR 14b: budget-event push channel. After codex review fix #2, the
  // callback is wired via `Config.setMcpBudgetEventCallback` BEFORE
  // `config.initialize()`, so MCP discovery (which can fire events
  // synchronously in legacy blocking mode and races with background
  // discovery in progressive mode) sees the callback wired from the
  // first pass. The Config-level shim stashes the callback and applies
  // it inside `createToolRegistry` to the freshly-constructed manager.
  it('newSession wires Config.setMcpBudgetEventCallback BEFORE initialize() (codex fix #2)', async () => {
    const sessionId = 'session-budget-events';
    const innerConfig = await setupSessionMocks(sessionId);
    // Stub `setMcpBudgetEventCallback` on the inner Config. The
    // production path delegates the manager apply to Config; the test
    // captures the callback at the Config boundary and verifies the
    // ordering vs `initialize()`.
    let capturedCallback:
      | ((event: Record<string, unknown>) => void)
      | undefined;
    const callOrder: string[] = [];
    (innerConfig as unknown as Record<string, unknown>)[
      'setMcpBudgetEventCallback'
    ] = vi.fn((cb: (event: Record<string, unknown>) => void) => {
      callOrder.push('setMcpBudgetEventCallback');
      capturedCallback = cb;
    });
    // Wrap `initialize` to record its position in `callOrder`. The
    // critical invariant codex review fix #2 enforces: setter runs
    // BEFORE initialize.
    const originalInitialize = innerConfig.initialize;
    innerConfig.initialize = vi.fn().mockImplementation(async () => {
      callOrder.push('initialize');
      return originalInitialize();
    });

    const agentPromise = runAcpAgent(
      mockConfig,
      makeSessionSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    // Spy connection: only `extNotification` is exercised here, but
    // the AgentSideConnection contract is wide. Stubbing only what the
    // PR 14b code path touches keeps the test focused.
    const extNotification = vi.fn().mockResolvedValue(undefined);
    const fakeConn = {
      get closed() {
        return mockConnectionState.promise;
      },
      extNotification,
    };
    const agent = capturedAgentFactory!(
      fakeConn as unknown as AgentSideConnectionLike,
    ) as AgentLike;

    await agent.newSession({ cwd: '/tmp', mcpServers: [] });

    // Strict ordering invariant — codex review fix #2.
    expect(callOrder).toEqual(['setMcpBudgetEventCallback', 'initialize']);
    expect(typeof capturedCallback).toBe('function');

    // Fire a synthetic budget_warning through the captured callback —
    // the wired extNotification must receive the same shape with
    // `sessionId` inserted and `v: 1` envelope.
    const warningEvent = {
      kind: 'budget_warning' as const,
      liveCount: 4,
      reservedCount: 4,
      budget: 4,
      thresholdRatio: 0.75 as const,
      mode: 'warn' as const,
    };
    capturedCallback!(warningEvent);

    expect(extNotification).toHaveBeenCalledTimes(1);
    expect(extNotification).toHaveBeenCalledWith(
      'qwen/notify/session/mcp-budget-event',
      {
        v: 1,
        sessionId,
        ...warningEvent,
      },
    );

    // Fire a refused_batch through the same callback — same routing,
    // discriminated union shape preserved verbatim.
    const refusedEvent = {
      kind: 'refused_batch' as const,
      refusedServers: [
        { name: 'b', transport: 'stdio', reason: 'budget_exhausted' },
      ],
      budget: 1,
      liveCount: 1,
      reservedCount: 1,
      mode: 'enforce' as const,
    };
    capturedCallback!(refusedEvent);

    expect(extNotification).toHaveBeenCalledTimes(2);
    expect(extNotification).toHaveBeenLastCalledWith(
      'qwen/notify/session/mcp-budget-event',
      {
        v: 1,
        sessionId,
        ...refusedEvent,
      },
    );

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('newSession is a no-op for budget wiring when setMcpBudgetEventCallback is absent (defensive)', async () => {
    // Codex review fix #2: the wiring path now goes through
    // `Config.setMcpBudgetEventCallback`, not the manager directly.
    // Older / stubbed `Config` shapes may omit it; the `typeof check`
    // in newSessionConfig keeps the absence silent.
    const innerConfig = await setupSessionMocks('session-no-cb-setter');
    // `setupSessionMocks`/`makeInnerConfig` returns a Config without
    // `setMcpBudgetEventCallback` defined — that's the defensive case.

    const agentPromise = runAcpAgent(
      mockConfig,
      makeSessionSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());

    const extNotification = vi.fn().mockResolvedValue(undefined);
    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
      extNotification,
    } as unknown as AgentSideConnectionLike) as AgentLike;

    await agent.newSession({ cwd: '/tmp', mcpServers: [] });

    // No setter on Config → no wiring → no extNotification fires.
    expect(
      (innerConfig as unknown as Record<string, unknown>)[
        'setMcpBudgetEventCallback'
      ],
    ).toBeUndefined();
    expect(extNotification).not.toHaveBeenCalled();

    mockConnectionState.resolve();
    await agentPromise;
  });
});

// Regression coverage for the MR-review finding that ACP renameSession
// bypassed any live ChatRecordingService. The disk-only path left the
// recording service's in-memory `currentCustomTitle` stale, and the next
// re-anchor (every 32KB) or finalize() silently reverted the rename by
// re-emitting the cached old title at EOF.
describe('QwenAgent extMethod renameSession routing', () => {
  type AgentSideConnectionLike = { closed: Promise<void> };
  type AgentLike = {
    initialize: (args: Record<string, unknown>) => Promise<unknown>;
    newSession: (args: Record<string, unknown>) => Promise<unknown>;
    extMethod: (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
  };

  let capturedAgentFactory:
    | ((conn: AgentSideConnectionLike) => AgentLike)
    | undefined;
  let mockConfig: Config;

  // Live session sessionId is whatever `getSessionId()` on the inner config
  // returns; matches the existing test scaffolding.
  const liveSessionId = '550e8400-e29b-41d4-a716-446655440000';

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectionState.reset();
    capturedAgentFactory = undefined;

    vi.mocked(AgentSideConnection).mockImplementation((factory: unknown) => {
      capturedAgentFactory = factory as typeof capturedAgentFactory;
      return {
        get closed() {
          return mockConnectionState.promise;
        },
      } as unknown as InstanceType<typeof AgentSideConnection>;
    });

    mockConfig = {
      initialize: vi.fn().mockResolvedValue(undefined),
      waitForMcpReady: vi.fn().mockResolvedValue(undefined),
      getHookSystem: vi.fn().mockReturnValue(undefined),
      getDisableAllHooks: vi.fn().mockReturnValue(false),
      hasHooksForEvent: vi.fn().mockReturnValue(false),
      getModel: vi.fn().mockReturnValue('test-model'),
      getModelsConfig: vi.fn().mockReturnValue({
        getCurrentAuthType: vi.fn().mockReturnValue('api-key'),
      }),
      refreshAuth: vi.fn().mockResolvedValue(undefined),
    } as unknown as Config;
  });

  function makeRecordingService() {
    return {
      recordCustomTitle: vi.fn().mockReturnValue(true),
      flush: vi.fn().mockResolvedValue(undefined),
    };
  }

  function makeLiveSessionInnerConfig(
    recording: ReturnType<typeof makeRecordingService> | null,
  ) {
    return {
      initialize: vi.fn().mockResolvedValue(undefined),
      waitForMcpReady: vi.fn().mockResolvedValue(undefined),
      getModelsConfig: vi.fn().mockReturnValue({
        getCurrentAuthType: vi.fn().mockReturnValue('api-key'),
      }),
      refreshAuth: vi.fn().mockResolvedValue(undefined),
      getModel: vi.fn().mockReturnValue('m'),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      getAvailableModels: vi.fn().mockReturnValue([]),
      getModes: vi.fn().mockReturnValue([]),
      getApprovalMode: vi.fn().mockReturnValue('default'),
      getSessionId: vi.fn().mockReturnValue(liveSessionId),
      getAuthType: vi.fn().mockReturnValue('api-key'),
      getAllConfiguredModels: vi.fn().mockReturnValue([]),
      getGeminiClient: vi.fn().mockReturnValue({
        isInitialized: vi.fn().mockReturnValue(true),
        initialize: vi.fn().mockResolvedValue(undefined),
        waitForMcpReady: vi.fn().mockResolvedValue(undefined),
      }),
      getFileSystemService: vi.fn().mockReturnValue(undefined),
      setFileSystemService: vi.fn(),
      getHookSystem: vi.fn().mockReturnValue(undefined),
      getDisableAllHooks: vi.fn().mockReturnValue(true),
      hasHooksForEvent: vi.fn().mockReturnValue(false),
      getChatRecordingService: vi.fn().mockReturnValue(recording),
    };
  }

  function makeAcpSettings() {
    return {
      merged: { mcpServers: {} },
      getUserHooks: vi.fn().mockReturnValue({}),
      getProjectHooks: vi.fn().mockReturnValue({}),
    } as unknown as LoadedSettings;
  }

  async function bootAgent(
    innerConfig: ReturnType<typeof makeLiveSessionInnerConfig>,
  ) {
    vi.mocked(loadSettings).mockReturnValue(makeAcpSettings());
    vi.mocked(loadCliConfig).mockResolvedValue(
      innerConfig as unknown as Config,
    );
    vi.mocked(Session).mockImplementation(
      () =>
        ({
          getId: vi.fn().mockReturnValue(liveSessionId),
          getConfig: vi.fn().mockReturnValue(innerConfig),
          sendAvailableCommandsUpdate: vi.fn().mockResolvedValue(undefined),
          replayHistory: vi.fn().mockResolvedValue(undefined),
          installRewriter: vi.fn(),
        }) as unknown as InstanceType<typeof Session>,
    );

    const agentPromise = runAcpAgent(
      mockConfig,
      makeAcpSettings(),
      {} as CliArgs,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());
    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    }) as AgentLike;
    return { agent, agentPromise };
  }

  it('routes through ChatRecordingService.recordCustomTitle when the target session is live', async () => {
    const recording = makeRecordingService();
    const innerConfig = makeLiveSessionInnerConfig(recording);
    const { agent, agentPromise } = await bootAgent(innerConfig);

    // Populate `this.sessions` so the rename target is "live".
    await agent.newSession({ cwd: '/tmp', mcpServers: [] });

    const result = await agent.extMethod('renameSession', {
      cwd: '/tmp',
      sessionId: liveSessionId,
      title: 'New Title',
    });

    expect(recording.recordCustomTitle).toHaveBeenCalledWith(
      'New Title',
      'manual',
    );
    // Awaited so the rename is durable before the response returns —
    // a follow-up listSessions can't race the queued write.
    expect(recording.flush).toHaveBeenCalledOnce();
    // The disk-only fallback must NOT fire when a live session exists,
    // otherwise we'd double-write (and the second writer would be the
    // SessionService that lacks the in-memory cache update).
    expect(SessionService).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true });

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('falls back to SessionService.renameSession when no live session matches the sessionId', async () => {
    const recording = makeRecordingService();
    const innerConfig = makeLiveSessionInnerConfig(recording);
    const { agent, agentPromise } = await bootAgent(innerConfig);

    await agent.newSession({ cwd: '/tmp', mcpServers: [] });

    const renameSpy = vi.fn().mockResolvedValue(true);
    vi.mocked(SessionService).mockImplementation(
      () =>
        ({
          renameSession: renameSpy,
        }) as unknown as InstanceType<typeof SessionService>,
    );

    const deadSessionId = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    const result = await agent.extMethod('renameSession', {
      cwd: '/tmp',
      sessionId: deadSessionId,
      title: 'Renamed Offline',
    });

    expect(SessionService).toHaveBeenCalledWith('/tmp');
    expect(renameSpy).toHaveBeenCalledWith(deadSessionId, 'Renamed Offline');
    // The live recording belongs to a *different* sessionId; it must
    // be left untouched, otherwise we'd corrupt an unrelated session's
    // title cache.
    expect(recording.recordCustomTitle).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true });

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('returns success=false when the live ChatRecordingService rejects the title (I/O error)', async () => {
    const recording = makeRecordingService();
    recording.recordCustomTitle.mockReturnValue(false);
    const innerConfig = makeLiveSessionInnerConfig(recording);
    const { agent, agentPromise } = await bootAgent(innerConfig);

    await agent.newSession({ cwd: '/tmp', mcpServers: [] });

    const result = await agent.extMethod('renameSession', {
      cwd: '/tmp',
      sessionId: liveSessionId,
      title: 'New Title',
    });

    // Even on failure we still flush so the writeChain settles before
    // responding — keeps subsequent reads consistent and surfaces any
    // queued earlier failure to the caller.
    expect(recording.flush).toHaveBeenCalledOnce();
    expect(result).toEqual({ success: false });

    mockConnectionState.resolve();
    await agentPromise;
  });
});

// Tests for QwenAgent.loadSession() and QwenAgent.unstable_resumeSession()
// — locks the session-existence guard, the resourceNotFound error contract,
// and the resume-vs-load semantic difference (load replays UI history,
// resume does not).
describe('QwenAgent loadSession / unstable_resumeSession', () => {
  let capturedAgentFactory:
    | ((conn: { closed: Promise<void> }) => {
        loadSession: (args: Record<string, unknown>) => Promise<unknown>;
        unstable_resumeSession: (
          args: Record<string, unknown>,
        ) => Promise<unknown>;
      })
    | undefined;

  let mockConfig: Config;
  let lastSessionMock:
    | {
        getId: ReturnType<typeof vi.fn>;
        sendAvailableCommandsUpdate: ReturnType<typeof vi.fn>;
        replayHistory: ReturnType<typeof vi.fn>;
        installRewriter: ReturnType<typeof vi.fn>;
      }
    | undefined;
  let processExitSpy: MockInstance<typeof process.exit>;
  let stdinDestroySpy: MockInstance<typeof process.stdin.destroy>;
  let stdoutDestroySpy: MockInstance<typeof process.stdout.destroy>;

  const mockArgv = {} as CliArgs;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectionState.reset();
    lastSessionMock = undefined;
    capturedAgentFactory = undefined;

    vi.mocked(AgentSideConnection).mockImplementation((factory: unknown) => {
      capturedAgentFactory = factory as typeof capturedAgentFactory;
      return {
        get closed() {
          return mockConnectionState.promise;
        },
      } as unknown as InstanceType<typeof AgentSideConnection>;
    });

    mockConfig = {
      initialize: vi.fn().mockResolvedValue(undefined),
      waitForMcpReady: vi.fn().mockResolvedValue(undefined),
      getHookSystem: vi.fn().mockReturnValue(undefined),
      getDisableAllHooks: vi.fn().mockReturnValue(false),
      hasHooksForEvent: vi.fn().mockReturnValue(false),
      getModel: vi.fn().mockReturnValue('test-model'),
      getModelsConfig: vi.fn().mockReturnValue({
        getCurrentAuthType: vi.fn().mockReturnValue('api-key'),
      }),
      refreshAuth: vi.fn().mockResolvedValue(undefined),
    } as unknown as Config;

    processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as unknown as typeof process.exit);
    stdinDestroySpy = vi
      .spyOn(process.stdin, 'destroy')
      .mockImplementation(() => process.stdin);
    stdoutDestroySpy = vi
      .spyOn(process.stdout, 'destroy')
      .mockImplementation(() => process.stdout);
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    stdinDestroySpy.mockRestore();
    stdoutDestroySpy.mockRestore();
  });

  function makeRestoreInnerConfig(
    opts: {
      resumedConversation?: { messages: unknown[] };
    } = {},
  ) {
    return {
      initialize: vi.fn().mockResolvedValue(undefined),
      waitForMcpReady: vi.fn().mockResolvedValue(undefined),
      getModelsConfig: vi.fn().mockReturnValue({
        getCurrentAuthType: vi.fn().mockReturnValue('api-key'),
      }),
      refreshAuth: vi.fn().mockResolvedValue(undefined),
      getModel: vi.fn().mockReturnValue('m'),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      getAvailableModels: vi.fn().mockReturnValue([]),
      getModes: vi.fn().mockReturnValue([]),
      getApprovalMode: vi.fn().mockReturnValue('default'),
      getSessionId: vi.fn().mockReturnValue('persisted-1'),
      getAuthType: vi.fn().mockReturnValue('api-key'),
      getAllConfiguredModels: vi.fn().mockReturnValue([]),
      getGeminiClient: vi.fn().mockReturnValue({
        isInitialized: vi.fn().mockReturnValue(true),
        initialize: vi.fn().mockResolvedValue(undefined),
        waitForMcpReady: vi.fn().mockResolvedValue(undefined),
      }),
      getFileSystemService: vi.fn().mockReturnValue(undefined),
      setFileSystemService: vi.fn(),
      getHookSystem: vi.fn().mockReturnValue(undefined),
      getDisableAllHooks: vi.fn().mockReturnValue(true),
      hasHooksForEvent: vi.fn().mockReturnValue(false),
      // load path reads back the persisted conversation here and feeds
      // it to `session.replayHistory`. resume path doesn't read this.
      getResumedSessionData: vi
        .fn()
        .mockReturnValue(
          opts.resumedConversation
            ? { conversation: opts.resumedConversation }
            : undefined,
        ),
    };
  }

  function makeRestoreSettings() {
    return {
      merged: { mcpServers: {} },
      getUserHooks: vi.fn().mockReturnValue({}),
      getProjectHooks: vi.fn().mockReturnValue({}),
    } as unknown as LoadedSettings;
  }

  function bindRestoreMocks(opts: {
    sessionExists: boolean;
    resumedConversation?: { messages: unknown[] };
  }) {
    const innerConfig = makeRestoreInnerConfig({
      resumedConversation: opts.resumedConversation,
    });
    vi.mocked(loadSettings).mockReturnValue(makeRestoreSettings());
    vi.mocked(loadCliConfig).mockResolvedValue(
      innerConfig as unknown as Config,
    );
    vi.mocked(SessionService).mockImplementation(
      () =>
        ({
          sessionExists: vi.fn().mockResolvedValue(opts.sessionExists),
        }) as unknown as InstanceType<typeof SessionService>,
    );
    vi.mocked(Session).mockImplementation(() => {
      const sessionMock = {
        getId: vi.fn().mockReturnValue('persisted-1'),
        getConfig: vi.fn().mockReturnValue(innerConfig),
        sendAvailableCommandsUpdate: vi.fn().mockResolvedValue(undefined),
        replayHistory: vi.fn().mockResolvedValue(undefined),
        installRewriter: vi.fn(),
      };
      lastSessionMock = sessionMock;
      return sessionMock as unknown as InstanceType<typeof Session>;
    });
    return innerConfig;
  }

  async function spawnAgent() {
    const agentPromise = runAcpAgent(
      mockConfig,
      makeRestoreSettings(),
      mockArgv,
    );
    await vi.waitFor(() => expect(capturedAgentFactory).toBeDefined());
    const agent = capturedAgentFactory!({
      get closed() {
        return mockConnectionState.promise;
      },
    });
    return { agent, agentPromise };
  }

  it('loadSession throws resourceNotFound when the persisted session is missing', async () => {
    bindRestoreMocks({ sessionExists: false });
    const { agent, agentPromise } = await spawnAgent();

    await expect(
      agent.loadSession({
        cwd: '/tmp',
        sessionId: 'persisted-missing',
        mcpServers: [],
      }),
    ).rejects.toMatchObject({
      code: -32002,
      data: { uri: 'session:persisted-missing' },
    });

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('loadSession returns LoadSessionResponse and replays history on the session', async () => {
    bindRestoreMocks({
      sessionExists: true,
      resumedConversation: {
        messages: [{ role: 'user', parts: [{ text: 'hi' }] }],
      },
    });
    const { agent, agentPromise } = await spawnAgent();

    const response = await agent.loadSession({
      cwd: '/tmp',
      sessionId: 'persisted-1',
      mcpServers: [],
    });

    expect(response).toMatchObject({
      modes: expect.anything(),
      models: expect.anything(),
      configOptions: expect.anything(),
    });
    // load semantic: history MUST be replayed so SSE subscribers see
    // the persisted turns.
    expect(lastSessionMock?.replayHistory).toHaveBeenCalledWith([
      { role: 'user', parts: [{ text: 'hi' }] },
    ]);

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('loadSession skips history replay when getResumedSessionData() returns undefined', async () => {
    // Distinct code path: `createAndStoreSession(config, undefined)`
    // takes the no-conversation branch, so `replayHistory` must
    // NOT be called even though the persisted session existed
    // (covers the case where the on-disk record has a session row
    // but no resumable conversation, e.g. corrupted / partially
    // written history).
    bindRestoreMocks({ sessionExists: true /* no resumedConversation */ });
    const { agent, agentPromise } = await spawnAgent();

    const response = await agent.loadSession({
      cwd: '/tmp',
      sessionId: 'persisted-1',
      mcpServers: [],
    });

    expect(response).toMatchObject({
      modes: expect.anything(),
      models: expect.anything(),
      configOptions: expect.anything(),
    });
    expect(lastSessionMock?.replayHistory).not.toHaveBeenCalled();

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('unstable_resumeSession throws resourceNotFound when the persisted session is missing', async () => {
    bindRestoreMocks({ sessionExists: false });
    const { agent, agentPromise } = await spawnAgent();

    await expect(
      agent.unstable_resumeSession({
        cwd: '/tmp',
        sessionId: 'persisted-missing',
      }),
    ).rejects.toMatchObject({
      code: -32002,
      data: { uri: 'session:persisted-missing' },
    });

    mockConnectionState.resolve();
    await agentPromise;
  });

  it('unstable_resumeSession returns the response without replaying history', async () => {
    bindRestoreMocks({
      sessionExists: true,
      resumedConversation: {
        messages: [{ role: 'user', parts: [{ text: 'hi' }] }],
      },
    });
    const { agent, agentPromise } = await spawnAgent();

    const response = await agent.unstable_resumeSession({
      cwd: '/tmp',
      sessionId: 'persisted-1',
    });

    expect(response).toMatchObject({
      modes: expect.anything(),
      models: expect.anything(),
      configOptions: expect.anything(),
    });
    // resume semantic: model context is restored internally via
    // geminiClient.initialize(), but UI replay is NOT triggered —
    // the SSE stream stays clean for clients that already have the
    // history rendered.
    expect(lastSessionMock?.replayHistory).not.toHaveBeenCalled();

    mockConnectionState.resolve();
    await agentPromise;
  });
});
