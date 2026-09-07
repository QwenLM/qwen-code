/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { RequestError } from '@agentclientprotocol/sdk';
import type { ContentBlock } from '@agentclientprotocol/sdk';

const spawnMock = vi.hoisted(() => vi.fn());

// AcpConnection imports AcpFileHandler which imports vscode.
// Mock vscode so it can be resolved without the actual VS Code runtime.
vi.mock('vscode', () => ({}));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: spawnMock };
});

import { AcpConnection } from './acpConnection.js';
import { ACP_ERROR_CODES } from '../constants/acpSchema.js';

type AcpConnectionInternal = {
  child: {
    killed: boolean;
    exitCode: number | null;
    signalCode?: string | null;
    pid?: number;
    kill?: () => void;
    stdin?: {
      end: () => void;
      destroyed?: boolean;
      writableEnded?: boolean;
      once?: (event: string, listener: () => void) => unknown;
    } | null;
    once?: (event: string, listener: () => void) => unknown;
  } | null;
  sdkConnection: unknown;
  sessionId: string | null;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  mapReadTextFileError: (error: unknown, filePath: string) => unknown;
  ensureConnection: () => unknown;
};

function createConnection(overrides?: Partial<AcpConnectionInternal>) {
  const conn = new AcpConnection() as unknown as AcpConnectionInternal;
  if (overrides) {
    Object.assign(conn, overrides);
  }
  return conn;
}

function createMockStdin(end = vi.fn()) {
  return { end, destroyed: false, writableEnded: false, once: vi.fn() };
}

function createMockChild(overrides?: Record<string, unknown>) {
  return {
    killed: false,
    exitCode: null,
    signalCode: null,
    pid: 4242,
    kill: vi.fn(),
    stdin: createMockStdin(),
    once: vi.fn(),
    ...overrides,
  } as unknown as AcpConnectionInternal['child'];
}

describe('AcpConnection process spawning', () => {
  it('runs the managed ACP child in Electron Node mode', async () => {
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '');
    vi.stubEnv('QWEN_CODE_SCRUB_ELECTRON_RUN_AS_NODE', '');
    spawnMock.mockReturnValue(createMockChild());
    const conn = new AcpConnection() as unknown as {
      connect: (cliEntryPath: string) => Promise<void>;
      setupChildProcessHandlers: () => Promise<void>;
    };
    conn.setupChildProcessHandlers = vi.fn().mockResolvedValue(undefined);

    try {
      await conn.connect(process.execPath);
      const options = spawnMock.mock.calls[0]?.[2] as {
        env?: NodeJS.ProcessEnv;
      };

      expect(options.env?.['ELECTRON_RUN_AS_NODE']).toBe('1');
      expect(options.env?.['QWEN_CODE_SCRUB_ELECTRON_RUN_AS_NODE']).toBe('1');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

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

  it('disconnect closes the CLI stdin instead of killing it (#11303)', () => {
    // `child.kill()` is TerminateProcess on Windows: the CLI's
    // `process.on('exit')` cleanup never runs, so every PTY, ConPTY host and
    // child process it is tracking is orphaned. Ending stdin closes the ACP
    // stream, which is the CLI's own graceful shutdown path.
    const mockKill = vi.fn();
    const mockEnd = vi.fn();
    const conn = createConnection({
      child: createMockChild({
        kill: mockKill,
        stdin: createMockStdin(mockEnd),
      }),
      sdkConnection: {},
      sessionId: 'test-session',
    });

    (conn as unknown as AcpConnection).disconnect();

    expect(mockEnd).toHaveBeenCalledOnce();
    expect(mockKill).not.toHaveBeenCalled();
  });

  it('disconnect force-kills the CLI only after it fails to exit on its own', () => {
    vi.useFakeTimers();
    try {
      const mockKill = vi.fn();
      const child = createMockChild({ kill: mockKill });
      const conn = createConnection({
        child,
        sdkConnection: {},
        sessionId: 'test-session',
      });

      (conn as unknown as AcpConnection).disconnect();
      expect(mockKill).not.toHaveBeenCalled();

      vi.advanceTimersByTime(10_000);
      // On win32 the escalation is a taskkill /t (the CLI is unresponsive, so
      // nothing else will reap the shells under it); elsewhere it is SIGKILL.
      if (process.platform === 'win32') {
        expect(mockKill).not.toHaveBeenCalled();
      } else {
        expect(mockKill).toHaveBeenCalledWith('SIGKILL');
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('a superseded child exiting does not tear down its replacement', async () => {
    // disconnect() now lets the CLI wind down on its own, so a superseded child
    // can still be exiting after connect() installed its replacement. An exit
    // handler keyed only on `this.child` would null out the live connection.
    let exitHandler:
      | ((code: number | null, signal: string | null) => void)
      | undefined;
    const oldChild = createMockChild({
      on: vi.fn((event: string, listener: unknown) => {
        if (event === 'exit') {
          exitHandler = listener as (
            code: number | null,
            signal: string | null,
          ) => void;
        }
      }),
    });
    const conn = createConnection({ child: oldChild });
    const acpConn = conn as unknown as AcpConnection;
    const onDisconnected = vi.fn();
    acpConn.onDisconnected = onDisconnected;

    // Only the listener wiring matters here; the rest of the setup (its 1s
    // settle, the web-stream conversion) has nothing to assert on these mocks.
    void (conn as unknown as { setupChildProcessHandlers: () => Promise<void> })
      .setupChildProcessHandlers()
      .catch(() => {});

    // connect() has since replaced the child.
    const newChild = createMockChild();
    conn.child = newChild;

    exitHandler?.(0, null);

    expect(conn.child).toBe(newChild);
    expect(onDisconnected).not.toHaveBeenCalled();
    // The exit also rejects the promise initialize() races. Nothing has
    // attached to it at this point, so it must already be marked handled or
    // this is an unhandled rejection in the extension host — vitest reports it
    // as a suite error even with every test green.
    await Promise.resolve();
  });

  it('disconnect does not force-kill a CLI that exited on its own', () => {
    vi.useFakeTimers();
    try {
      const mockKill = vi.fn();
      let exitListener: (() => void) | undefined;
      const child = createMockChild({
        kill: mockKill,
        once: vi.fn((event: string, listener: () => void) => {
          if (event === 'exit') exitListener = listener;
        }),
      });
      const conn = createConnection({
        child,
        sdkConnection: {},
        sessionId: 'test-session',
      });

      (conn as unknown as AcpConnection).disconnect();
      exitListener?.();
      vi.advanceTimersByTime(10_000);

      expect(mockKill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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

describe('AcpConnection extension notifications', () => {
  it('parses end_turn reason and source', () => {
    const conn = new AcpConnection();
    const onEndTurn = vi.fn();
    conn.onEndTurn = onEndTurn;

    conn.handleExtNotification('_qwencode/end_turn', {
      reason: 'end_turn',
      source: 'background_notification',
    });

    expect(onEndTurn).toHaveBeenCalledWith(
      'end_turn',
      'background_notification',
    );
  });
});
