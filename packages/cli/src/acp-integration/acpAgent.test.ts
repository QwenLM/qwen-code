/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  RequestError: class RequestError extends Error {},
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
  }),
  APPROVAL_MODE_INFO: {},
  APPROVAL_MODES: [],
  AuthType: {},
  clearCachedCredentialFile: vi.fn(),
  QwenOAuth2Event: {},
  qwenOAuth2Events: { on: vi.fn(), off: vi.fn() },
  MCPServerConfig: {},
  SessionService: vi.fn(),
  tokenLimit: vi.fn(),
}));

vi.mock('./authMethods.js', () => ({ buildAuthMethods: vi.fn() }));
vi.mock('./service/filesystem.js', () => ({
  AcpFileSystemService: vi.fn(),
}));
vi.mock('../config/settings.js', () => ({ SettingScope: {} }));
vi.mock('../config/config.js', () => ({ loadCliConfig: vi.fn() }));
vi.mock('./session/Session.js', () => ({ Session: vi.fn() }));
vi.mock('../utils/acpModelUtils.js', () => ({
  formatAcpModelId: vi.fn(),
}));

import { runAcpAgent } from './acpAgent.js';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import type { CliArgs } from '../config/config.js';

describe('runAcpAgent shutdown cleanup', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let processExitSpy: any;
  let sigTermListeners: NodeJS.SignalsListener[];
  let sigIntListeners: NodeJS.SignalsListener[];

  const mockConfig = {} as Config;
  const mockSettings = { merged: {} } as LoadedSettings;
  const mockArgv = {} as CliArgs;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRunExitCleanup.mockResolvedValue(undefined);
    mockConnectionState.reset();
    sigTermListeners = [];
    sigIntListeners = [];

    // Intercept signal handler registration
    vi.spyOn(process, 'on').mockImplementation(((
      event: string,
      listener: (...args: unknown[]) => void,
    ) => {
      if (event === 'SIGTERM')
        sigTermListeners.push(listener as NodeJS.SignalsListener);
      if (event === 'SIGINT')
        sigIntListeners.push(listener as NodeJS.SignalsListener);
      return process;
    }) as typeof process.on);

    vi.spyOn(process, 'off').mockImplementation(
      (() => process) as typeof process.off,
    );

    // Mock process.exit to prevent actually exiting
    processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as unknown as typeof process.exit);

    // Mock stdin/stdout destroy
    vi.spyOn(process.stdin, 'destroy').mockImplementation(() => process.stdin);
    vi.spyOn(process.stdout, 'destroy').mockImplementation(
      () => process.stdout,
    );
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('calls runExitCleanup and process.exit on SIGTERM', async () => {
    // Start runAcpAgent (it will await connection.closed)
    const agentPromise = runAcpAgent(mockConfig, mockSettings, mockArgv);

    // Simulate SIGTERM from IDE
    expect(sigTermListeners.length).toBeGreaterThan(0);
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

    expect(sigIntListeners.length).toBeGreaterThan(0);
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

    sigTermListeners[0]('SIGTERM');

    // process.exit should still be called via .finally()
    await vi.waitFor(() => {
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    mockConnectionState.resolve();
    await agentPromise;
  });
});
