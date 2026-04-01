/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RequestError } from '@agentclientprotocol/sdk';
import type { ContentBlock } from '@agentclientprotocol/sdk';

// AcpConnection imports AcpFileHandler which imports vscode.
// Mock vscode so it can be resolved without the actual VS Code runtime.
vi.mock('vscode', () => ({}));

import { AcpConnection } from './acpConnection.js';
import { ACP_ERROR_CODES } from '../constants/acpSchema.js';

type AcpConnectionInternal = {
  child: { killed: boolean; exitCode: number | null; kill?: () => void } | null;
  sdkConnection: unknown;
  sessionId: string | null;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  intentionalDisconnect: boolean;
  autoReconnectAttempts: number;
  mapReadTextFileError: (error: unknown, filePath: string) => unknown;
  ensureConnection: () => unknown;
  cleanupForRetry: () => void;
};

function createConnection(overrides?: Partial<AcpConnectionInternal>) {
  const conn = new AcpConnection() as unknown as AcpConnectionInternal;
  if (overrides) {
    Object.assign(conn, overrides);
  }
  return conn;
}

function createMockChild(overrides?: Record<string, unknown>) {
  return {
    killed: false,
    exitCode: null,
    kill: vi.fn(),
    ...overrides,
  } as unknown as AcpConnectionInternal['child'];
}

describe('AcpConnection readTextFile error mapping', () => {
  it('maps ENOENT to RESOURCE_NOT_FOUND RequestError', () => {
    const conn = createConnection();
    const enoent = Object.assign(new Error('missing file'), { code: 'ENOENT' });

    expect(() =>
      conn.mapReadTextFileError(enoent, '/tmp/missing.txt'),
    ).toThrowError(
      expect.objectContaining({
        code: ACP_ERROR_CODES.RESOURCE_NOT_FOUND,
      }),
    );
  });

  it('keeps non-ENOENT RequestError unchanged', () => {
    const conn = createConnection();
    const requestError = new RequestError(
      ACP_ERROR_CODES.INTERNAL_ERROR,
      'Internal error',
    );

    expect(conn.mapReadTextFileError(requestError, '/tmp/file.txt')).toBe(
      requestError,
    );
  });

  it('passes structured ACP prompt blocks through without wrapping them as text', async () => {
    const prompt = vi.fn().mockResolvedValue({});
    const onEndTurn = vi.fn();
    const conn = new AcpConnection() as unknown as {
      sdkConnection: {
        prompt: (params: {
          sessionId: string;
          prompt: ContentBlock[];
        }) => Promise<unknown>;
      };
      sessionId: string | null;
      onEndTurn: (reason?: string) => void;
      sendPrompt: (prompt: string | ContentBlock[]) => Promise<unknown>;
    };
    const promptBlocks: ContentBlock[] = [
      { type: 'text', text: 'Inspect this image' },
      {
        type: 'resource_link',
        name: 'pasted image.png',
        mimeType: 'image/png',
        uri: 'file:///tmp/pasted image.png',
      },
    ];

    conn.sdkConnection = { prompt };
    conn.sessionId = 'session-1';
    conn.onEndTurn = onEndTurn;
    (conn as unknown as AcpConnectionInternal).child = createMockChild();

    await conn.sendPrompt(promptBlocks);

    expect(prompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: promptBlocks,
    });
    expect(onEndTurn).toHaveBeenCalled();
  });
});

describe('AcpConnection.isConnected', () => {
  it('returns true when child is alive', () => {
    const conn = createConnection({
      child: { killed: false, exitCode: null },
    });
    expect((conn as unknown as AcpConnection).isConnected).toBe(true);
  });

  it('returns false when child is null', () => {
    const conn = createConnection({ child: null });
    expect((conn as unknown as AcpConnection).isConnected).toBe(false);
  });

  it('returns false when child was killed', () => {
    const conn = createConnection({
      child: { killed: true, exitCode: null },
    });
    expect((conn as unknown as AcpConnection).isConnected).toBe(false);
  });

  it('returns false when child exited on its own (exitCode set)', () => {
    // 143 = 128 + 15 (SIGTERM)
    const conn = createConnection({
      child: { killed: false, exitCode: 143 },
    });
    expect((conn as unknown as AcpConnection).isConnected).toBe(false);
  });
});

describe('AcpConnection.ensureConnection', () => {
  it('throws when sdkConnection is null', () => {
    const conn = createConnection({
      sdkConnection: null,
      child: { killed: false, exitCode: null },
    });
    expect(() => conn.ensureConnection()).toThrow('Not connected to ACP agent');
  });

  it('throws when process has exited (exitCode set)', () => {
    const conn = createConnection({
      sdkConnection: {},
      child: { killed: false, exitCode: 1 },
    });
    expect(() => conn.ensureConnection()).toThrow('Not connected to ACP agent');
  });

  it('throws when child is null (process exited and cleaned up)', () => {
    const conn = createConnection({
      sdkConnection: {},
      child: null,
    });
    expect(() => conn.ensureConnection()).toThrow('Not connected to ACP agent');
  });

  it('returns sdkConnection when process is alive', () => {
    const fakeSdk = { send: vi.fn() };
    const conn = createConnection({
      sdkConnection: fakeSdk,
      child: { killed: false, exitCode: null },
    });
    expect(conn.ensureConnection()).toBe(fakeSdk);
  });
});

describe('AcpConnection child exit cleanup', () => {
  it('disconnect clears child, sdkConnection, and sessionId', () => {
    const conn = createConnection({
      child: createMockChild(),
      sdkConnection: {},
      sessionId: 'test-session',
    });

    const acpConn = conn as unknown as AcpConnection;
    acpConn.disconnect();

    expect(acpConn.isConnected).toBe(false);
    expect(acpConn.hasActiveSession).toBe(false);
    expect(acpConn.currentSessionId).toBeNull();
  });

  it('disconnect calls kill on the child process', () => {
    const mockKill = vi.fn();
    const conn = createConnection({
      child: createMockChild({ kill: mockKill }),
      sdkConnection: {},
      sessionId: 'test-session',
    });

    (conn as unknown as AcpConnection).disconnect();
    expect(mockKill).toHaveBeenCalledOnce();
  });
});

describe('AcpConnection onDisconnected callback', () => {
  it('has a default no-op onDisconnected handler', () => {
    const acpConn = new AcpConnection();
    expect(acpConn.onDisconnected).toBeTypeOf('function');
    expect(() => acpConn.onDisconnected(143, 'SIGTERM')).not.toThrow();
  });

  it('allows setting a custom onDisconnected handler', () => {
    const acpConn = new AcpConnection();
    const spy = vi.fn();
    acpConn.onDisconnected = spy;

    acpConn.onDisconnected(1, null);
    expect(spy).toHaveBeenCalledWith(1, null);
  });
});

describe('AcpConnection lastExitCode/lastExitSignal', () => {
  it('initializes exit info as null', () => {
    const conn = createConnection();
    expect(conn.lastExitCode).toBeNull();
    expect(conn.lastExitSignal).toBeNull();
  });
});

describe('AcpConnection.connectWithRetry', () => {
  let acpConn: AcpConnection;

  beforeEach(() => {
    acpConn = new AcpConnection();
  });

  it('succeeds on first attempt without retrying', async () => {
    const connectSpy = vi
      .spyOn(acpConn, 'connect')
      .mockResolvedValueOnce(undefined);

    await acpConn.connectWithRetry('/path/to/cli.js', '/workdir', [], 3);

    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(connectSpy).toHaveBeenCalledWith('/path/to/cli.js', '/workdir', []);
  });

  it('retries on failure and succeeds on second attempt', async () => {
    const connectSpy = vi
      .spyOn(acpConn, 'connect')
      .mockRejectedValueOnce(new Error('SIGTERM'))
      .mockResolvedValueOnce(undefined);

    await acpConn.connectWithRetry('/path/to/cli.js', '/workdir', [], 3);

    expect(connectSpy).toHaveBeenCalledTimes(2);
  });

  it('throws after all retries are exhausted', async () => {
    const error = new Error('persistent failure');
    const connectSpy = vi.spyOn(acpConn, 'connect').mockRejectedValue(error);

    await expect(
      acpConn.connectWithRetry('/path/to/cli.js', '/workdir', [], 2),
    ).rejects.toThrow('persistent failure');

    // 1 initial + 2 retries = 3 total
    expect(connectSpy).toHaveBeenCalledTimes(3);
  });

  it('cleans up state between retry attempts', async () => {
    const internal = acpConn as unknown as AcpConnectionInternal;
    const cleanupSpy = vi.spyOn(internal, 'cleanupForRetry' as never);

    vi.spyOn(acpConn, 'connect')
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockResolvedValueOnce(undefined);

    await acpConn.connectWithRetry('/path/to/cli.js', '/workdir', [], 3);

    // cleanupForRetry called once for the failed attempt
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it('resets autoReconnectAttempts on successful connect', async () => {
    const internal = acpConn as unknown as AcpConnectionInternal;
    internal.autoReconnectAttempts = 5;

    vi.spyOn(acpConn, 'connect').mockResolvedValueOnce(undefined);

    await acpConn.connectWithRetry('/path/to/cli.js', '/workdir', [], 3);

    expect(acpConn.currentAutoReconnectAttempts).toBe(0);
  });
});

describe('AcpConnection.cleanupForRetry', () => {
  it('kills zombie child process and resets state', () => {
    const mockKill = vi.fn();
    const conn = createConnection({
      child: createMockChild({ kill: mockKill, killed: false }),
      sdkConnection: { fake: true },
      sessionId: 'test-session',
      lastExitCode: 1,
      lastExitSignal: 'SIGTERM',
    });

    conn.cleanupForRetry();

    expect(mockKill).toHaveBeenCalledOnce();
    expect(conn.child).toBeNull();
    expect(conn.sdkConnection).toBeNull();
    expect(conn.sessionId).toBeNull();
    expect(conn.lastExitCode).toBeNull();
    expect(conn.lastExitSignal).toBeNull();
  });

  it('handles already-killed child process gracefully', () => {
    const conn = createConnection({
      child: createMockChild({ killed: true }),
      sdkConnection: { fake: true },
      sessionId: 'test',
    });

    expect(() => conn.cleanupForRetry()).not.toThrow();
    expect(conn.child).toBeNull();
  });

  it('handles null child process gracefully', () => {
    const conn = createConnection({
      child: null,
      sdkConnection: { fake: true },
      sessionId: 'test',
    });

    expect(() => conn.cleanupForRetry()).not.toThrow();
  });
});

describe('AcpConnection intentionalDisconnect flag', () => {
  it('defaults to false', () => {
    const acpConn = new AcpConnection();
    expect(acpConn.wasIntentionalDisconnect).toBe(false);
  });

  it('is set to true by disconnect()', () => {
    const conn = createConnection({
      child: createMockChild(),
      sdkConnection: {},
      sessionId: 'test',
    });
    const acpConn = conn as unknown as AcpConnection;

    acpConn.disconnect();

    expect(acpConn.wasIntentionalDisconnect).toBe(true);
  });

  it('is reset to false when connect() is called', async () => {
    const internal = new AcpConnection() as unknown as AcpConnectionInternal;
    internal.intentionalDisconnect = true;

    // connect() will throw because we haven't set up a real subprocess,
    // but the flag should be reset before the error
    try {
      await (internal as unknown as AcpConnection).connect(
        '/nonexistent/cli.js',
        '/workdir',
      );
    } catch {
      // Expected to fail
    }

    expect(internal.intentionalDisconnect).toBe(false);
  });
});

describe('AcpConnection auto-reconnect counter', () => {
  it('defaults to 0', () => {
    const acpConn = new AcpConnection();
    expect(acpConn.currentAutoReconnectAttempts).toBe(0);
  });

  it('increments via incrementAutoReconnectAttempts()', () => {
    const acpConn = new AcpConnection();
    acpConn.incrementAutoReconnectAttempts();
    expect(acpConn.currentAutoReconnectAttempts).toBe(1);
    acpConn.incrementAutoReconnectAttempts();
    expect(acpConn.currentAutoReconnectAttempts).toBe(2);
  });

  it('resets via resetAutoReconnectAttempts()', () => {
    const acpConn = new AcpConnection();
    acpConn.incrementAutoReconnectAttempts();
    acpConn.incrementAutoReconnectAttempts();
    acpConn.resetAutoReconnectAttempts();
    expect(acpConn.currentAutoReconnectAttempts).toBe(0);
  });
});
