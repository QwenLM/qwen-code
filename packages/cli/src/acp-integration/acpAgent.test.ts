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
  AuthType: {},
  clearCachedCredentialFile: vi.fn(),
  QwenOAuth2Event: {},
  qwenOAuth2Events: { on: vi.fn(), off: vi.fn() },
  MCPServerConfig: vi.fn().mockImplementation((...args: unknown[]) => ({
    _args: args,
  })),
  SessionService: vi.fn(),
  SESSION_TITLE_MAX_LENGTH: 200,
  tokenLimit: vi.fn(),
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

vi.mock('./authMethods.js', () => ({ buildAuthMethods: vi.fn() }));
vi.mock('./service/filesystem.js', () => ({
  AcpFileSystemService: vi.fn(),
}));
vi.mock('../config/settings.js', () => ({
  SettingScope: {},
  loadSettings: vi.fn(),
}));
vi.mock('../config/config.js', () => ({ loadCliConfig: vi.fn() }));
vi.mock('./session/Session.js', () => ({ Session: vi.fn() }));
vi.mock('../utils/acpModelUtils.js', () => ({
  formatAcpModelId: vi.fn(),
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
} from '@qwen-code/qwen-code-core';
import type { McpServer } from '@agentclientprotocol/sdk';
import { AgentSideConnection } from '@agentclientprotocol/sdk';
import { loadSettings } from '../config/settings.js';
import { loadCliConfig } from '../config/config.js';
import { Session } from './session/Session.js';

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

  function makeInnerConfig() {
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
