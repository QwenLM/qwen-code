/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { RequestError } from '@agentclientprotocol/sdk';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import { PassThrough } from 'node:stream';
import { logger } from '../utils/logger.js';

const spawnMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());
const sdkClientFactory = vi.hoisted(() => ({
  factory: null as null | ((agent: unknown) => Record<string, unknown>),
}));

// Mirrors the module-private SHUTDOWN_GRACE_MS in acpConnection.ts. Kept as a
// literal here on purpose: the escalation tests step to just before and just
// after the deadline, so a grace that changes without these tests changing
// fails them instead of silently widening or vacating the pin.
const SHUTDOWN_GRACE_MS = 75_000;
// Same pin for the second rung of the POSIX escalation ladder
// (SIGTERM_GRACE_MS): SIGKILL must not land until this long after SIGTERM.
const SIGTERM_GRACE_MS = 75_000;
// Same pin for the refused-close backoff rungs (CLOSE_RETRY_BASE_MS and
// CLOSE_RETRY_CEILING_MS): 60s, doubling, capped at 1h.
const CLOSE_RETRY_BASE_MS = 60_000;
const CLOSE_RETRY_CEILING_MS = 3_600_000;

// AcpConnection imports AcpFileHandler which imports vscode.
// Mock vscode so it can be resolved without the actual VS Code runtime.
vi.mock('vscode', () => ({}));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: spawnMock, execFile: execFileMock };
});
vi.mock('@agentclientprotocol/sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agentclientprotocol/sdk')>();
  return {
    ...actual,
    // Capture the Client factory so tests can drive the inbound callbacks
    // (sessionUpdate / writeTextFile / ...) that guard against a superseded
    // connection. The real SDK would hold this factory internally.
    ClientSideConnection: class {
      constructor(factory: (agent: unknown) => Record<string, unknown>) {
        sdkClientFactory.factory = factory;
      }
      initialize = vi.fn().mockResolvedValue({ protocolVersion: '1.0' });
    },
    ndJsonStream: () => ({}),
  };
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

function createMockChild(
  overrides?: Record<string, unknown>,
): NonNullable<AcpConnectionInternal['child']> {
  return {
    killed: false,
    exitCode: null,
    signalCode: null,
    pid: 4242,
    kill: vi.fn(),
    stdin: createMockStdin(),
    once: vi.fn(),
    ...overrides,
  } as unknown as NonNullable<AcpConnectionInternal['child']>;
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

  it('spawns the child detached on POSIX but not on Windows', async () => {
    // The POSIX escalation is a process-group signal (process.kill(-pid,
    // ...)): it reaches the CLI's whole group only because the child is
    // spawned detached and so leads its own group. Windows has no signalable
    // group — its tree kill goes through taskkill, and there `detached` only
    // changes console attachment. Pin both sides so a future refactor of the
    // options object cannot silently turn the group signal into a root-only
    // one that orphans every descendant (the #11303 leak).
    spawnMock.mockClear();
    spawnMock.mockReturnValue(createMockChild());
    const makeConn = () => {
      const conn = new AcpConnection() as unknown as {
        connect: (cliEntryPath: string) => Promise<void>;
        setupChildProcessHandlers: () => Promise<void>;
      };
      conn.setupChildProcessHandlers = vi.fn().mockResolvedValue(undefined);
      return conn;
    };
    const platform = vi.spyOn(process, 'platform', 'get');
    try {
      platform.mockReturnValue('linux');
      await makeConn().connect(process.execPath);
      platform.mockReturnValue('win32');
      await makeConn().connect(process.execPath);

      const detachedAt = (i: number) =>
        (spawnMock.mock.calls[i]?.[2] as { detached?: boolean }).detached;
      expect(detachedAt(0)).toBe(true);
      expect(detachedAt(1)).toBe(false);
    } finally {
      platform.mockRestore();
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
  beforeEach(() => {
    execFileMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

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

  it('disconnect is a no-op when there is no child', () => {
    const conn = createConnection({ child: null });
    expect(() => (conn as unknown as AcpConnection).disconnect()).not.toThrow();
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

  it('does not force-kill a child that failed to spawn', () => {
    const mockKill = vi.fn();
    const conn = createConnection({
      child: createMockChild({ kill: mockKill, pid: undefined }),
    });

    (conn as unknown as AcpConnection).disconnect();
    vi.advanceTimersByTime(SHUTDOWN_GRACE_MS + SIGTERM_GRACE_MS);

    expect(execFileMock).not.toHaveBeenCalled();
    expect(mockKill).not.toHaveBeenCalled();
  });

  it('does not end stdin that is already closed', () => {
    // Even when stdin cannot be ended (already closed), the escalation timer
    // must still be armed: an early return here would leave the CLI's process
    // group running forever. Assert the escalation ladder still climbs past
    // the grace.
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    const end = vi.fn();
    const conn = createConnection({
      child: createMockChild({
        stdin: { ...createMockStdin(end), writableEnded: true },
      }),
    });

    (conn as unknown as AcpConnection).disconnect();

    expect(end).not.toHaveBeenCalled();

    vi.advanceTimersByTime(SHUTDOWN_GRACE_MS);
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
    vi.advanceTimersByTime(SIGTERM_GRACE_MS);
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
  });

  it('handles a synchronous stdin close failure', () => {
    // A synchronous stdin.end() failure (e.g. EPIPE) must not short-circuit
    // disconnect(): the escalation timer still has to be armed, or a failing
    // stdin close leaves the CLI's process group running forever.
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    const closeError = new Error('EPIPE');
    const once = vi.fn();
    const logError = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const conn = createConnection({
      child: createMockChild({
        stdin: {
          ...createMockStdin(
            vi.fn(() => {
              throw closeError;
            }),
          ),
          once,
        },
      }),
    });

    expect(() => (conn as unknown as AcpConnection).disconnect()).not.toThrow();
    expect(once).toHaveBeenCalledWith('error', expect.any(Function));
    expect(logError).toHaveBeenCalledWith(
      '[ACP] Failed to close CLI stdin during disconnect:',
      closeError,
    );

    vi.advanceTimersByTime(SHUTDOWN_GRACE_MS);
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
    vi.advanceTimersByTime(SIGTERM_GRACE_MS);
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
  });

  it('disconnect escalates stdin close → SIGTERM → SIGKILL on POSIX', () => {
    // Pinned so the assertion does not depend on which runner executes it.
    const platform = vi
      .spyOn(process, 'platform', 'get')
      .mockReturnValue('linux');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
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
      expect(killSpy).not.toHaveBeenCalled();

      // The grace has to outlast the CLI's own wind-down (8s MCP pool drain +
      // 30s session drain), so nothing may be signalled one tick before it
      // expires. A grace shorter than that wind-down reds this assertion.
      vi.advanceTimersByTime(SHUTDOWN_GRACE_MS - 1);
      expect(killSpy).not.toHaveBeenCalled();

      // First rung: SIGTERM to the process GROUP (negative pid), not a bare
      // kill(). SIGTERM stays catchable, so the CLI's signal cleanup and its
      // exit-time reaper still run before the last rung. Removing the group
      // signal or jumping straight to SIGKILL reds this.
      vi.advanceTimersByTime(1);
      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
      expect(killSpy).not.toHaveBeenCalledWith(-4242, 'SIGKILL');
      expect(mockKill).not.toHaveBeenCalled();

      // Second rung, SIGTERM_GRACE_MS later: SIGKILL to the same group.
      vi.advanceTimersByTime(SIGTERM_GRACE_MS - 1);
      expect(killSpy).not.toHaveBeenCalledWith(-4242, 'SIGKILL');
      vi.advanceTimersByTime(1);
      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
    } finally {
      killSpy.mockRestore();
      platform.mockRestore();
    }
  });

  it('disconnect does not escalate against a CLI that exited on its own', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
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
      // Past both deadlines the cancelled timers would have fired at,
      // otherwise the cancellation this test pins is never exercised.
      vi.advanceTimersByTime(SHUTDOWN_GRACE_MS + SIGTERM_GRACE_MS);

      expect(killSpy).not.toHaveBeenCalled();
      expect(mockKill).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it('does not force-kill a CLI that exits within the SIGTERM grace', () => {
    // The ladder stops once the child exits: SIGTERM landed, and the SIGKILL
    // rung must never fire for a CLI that is already winding down.
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
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
      vi.advanceTimersByTime(SHUTDOWN_GRACE_MS);
      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');

      exitListener?.();
      vi.advanceTimersByTime(SIGTERM_GRACE_MS);

      expect(killSpy).not.toHaveBeenCalledWith(-4242, 'SIGKILL');
      expect(mockKill).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it('does not signal after exitCode or signalCode is observed', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      for (const exitInfo of [
        { exitCode: 0, signalCode: null },
        { exitCode: null, signalCode: 'SIGTERM' },
      ]) {
        const conn = createConnection({
          child: createMockChild(exitInfo),
        });
        (conn as unknown as AcpConnection).disconnect();
        vi.advanceTimersByTime(SHUTDOWN_GRACE_MS + SIGTERM_GRACE_MS);
      }
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it('escalates through taskkill /t on Windows, not a bare kill', () => {
    // Windows CI is skipped on PRs, so the platform is faked here rather than
    // left to whichever runner happens to execute the suite.
    const platform = vi
      .spyOn(process, 'platform', 'get')
      .mockReturnValue('win32');
    try {
      const mockKill = vi.fn();
      const conn = createConnection({
        child: createMockChild({ kill: mockKill, pid: 4242 }),
        sdkConnection: {},
        sessionId: 'test-session',
      });

      (conn as unknown as AcpConnection).disconnect();
      vi.advanceTimersByTime(SHUTDOWN_GRACE_MS);

      // A tree kill: the CLI is unresponsive by now, so nothing else will reap
      // the shells and ConPTY hosts underneath it. See #11303.
      expect(execFileMock).toHaveBeenCalledWith(
        expect.stringMatching(/\\System32\\taskkill\.exe$/i),
        ['/f', '/t', '/pid', '4242'],
        expect.objectContaining({ windowsHide: true, timeout: 2_000 }),
        expect.any(Function),
      );
      expect(mockKill).not.toHaveBeenCalled();
    } finally {
      platform.mockRestore();
    }
  });

  it('falls back when taskkill cannot terminate the CLI tree', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null) => void,
      ) => {
        callback(new Error('ERROR_ACCESS_DENIED'));
      },
    );
    const mockKill = vi.fn();
    const conn = createConnection({
      child: createMockChild({ kill: mockKill }),
    });

    (conn as unknown as AcpConnection).disconnect();
    vi.advanceTimersByTime(SHUTDOWN_GRACE_MS);

    expect(mockKill).toHaveBeenCalledOnce();
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
    conn.sdkConnection = {};
    conn.sessionId = 'replacement-session';

    exitHandler?.(0, null);

    expect(conn.child).toBe(newChild);
    expect(conn.sdkConnection).toEqual({});
    expect(conn.sessionId).toBe('replacement-session');
    expect(onDisconnected).not.toHaveBeenCalled();
    // The exit also rejects the promise initialize() races. Nothing has
    // attached to it at this point, so it must already be marked handled or
    // this is an unhandled rejection in the extension host — vitest reports it
    // as a suite error even with every test green.
    await Promise.resolve();
  });

  it('does not wire replacement streams into a retired startup', async () => {
    vi.useFakeTimers();
    try {
      const oldChild = createMockChild({
        stdout: new PassThrough(),
        stdin: new PassThrough(),
        on: vi.fn(),
      });
      const newChild = createMockChild({
        stdout: new PassThrough(),
        stdin: new PassThrough(),
        on: vi.fn(),
      });
      const conn = createConnection({ child: oldChild });
      const setup = (
        conn as unknown as {
          setupChildProcessHandlers: () => Promise<void>;
        }
      ).setupChildProcessHandlers();
      const setupFailure = await expect(setup).rejects.toThrow(
        /failed to start|superseded/i,
      );

      conn.child = newChild;
      await vi.advanceTimersByTimeAsync(1000);

      await setupFailure;
      expect(conn.sdkConnection).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a live child exiting clears the connection and fires onDisconnected', async () => {
    // The exit-handler teardown is keyed on the connection still being
    // current. For the CURRENT direction (no supersede), a live child exit
    // must clear child/sdkConnection/sessionId and fire onDisconnected, or
    // the teardown silently never runs. A mutant like
    // `if (this.child === ownChild && !ownChild)` (always false) reds this.
    let exitHandler:
      | ((code: number | null, signal: string | null) => void)
      | undefined;
    const child = createMockChild({
      on: vi.fn((event: string, listener: unknown) => {
        if (event === 'exit') {
          exitHandler = listener as (
            code: number | null,
            signal: string | null,
          ) => void;
        }
      }),
    });
    const conn = createConnection({ child });
    const acpConn = conn as unknown as AcpConnection;
    const onDisconnected = vi.fn();
    acpConn.onDisconnected = onDisconnected;
    conn.sdkConnection = { initialize: vi.fn() };
    conn.sessionId = 'test-session';

    // Only the listener wiring matters here; the rest of the setup (its 1s
    // settle, the web-stream conversion) has nothing to assert on these mocks.
    void (conn as unknown as { setupChildProcessHandlers: () => Promise<void> })
      .setupChildProcessHandlers()
      .catch(() => {});

    exitHandler?.(0, null);

    expect(conn.child).toBeNull();
    expect(conn.sdkConnection).toBeNull();
    expect(conn.sessionId).toBeNull();
    expect(onDisconnected).toHaveBeenCalledWith(0, null);
    await Promise.resolve();
  });

  it('a superseded connection stops dispatching inbound callbacks', async () => {
    // The inbound callbacks on the SDK Client object read `this.*` at call
    // time. `disconnect()` ends stdin and nulls sdkConnection but does not
    // close the superseded child's stdout, so its ClientSideConnection stays
    // live. Each callback must gate on the connection it was built for
    // (`this.sdkConnection !== wiredConnection`), or the retired connection
    // keeps dispatching into callbacks bound to the live replacement. This
    // case drives the writeTextFile and sessionUpdate guards specifically;
    // requestPermission, readTextFile and extNotification carry the same gate
    // but are not exercised here. Removing either driven guard fires its spy.
    try {
      const stdout = new PassThrough();
      const stdin = new PassThrough();
      const oldChild = createMockChild({ stdout, stdin, on: vi.fn() });
      const conn = new AcpConnection() as unknown as AcpConnectionInternal & {
        onSessionUpdate: (data: unknown) => void;
        fileHandler: {
          handleWriteTextFile: (request: unknown) => Promise<unknown>;
        };
      };
      conn.child = oldChild;
      conn.onSessionUpdate = vi.fn();
      const writeSpy = vi
        .spyOn(conn.fileHandler, 'handleWriteTextFile')
        .mockResolvedValue({});

      const setup = (
        conn as unknown as {
          setupChildProcessHandlers: () => Promise<void>;
        }
      ).setupChildProcessHandlers();
      await vi.advanceTimersByTimeAsync(1000);
      await setup;

      const client = sdkClientFactory.factory?.(null);
      expect(client).toBeDefined();
      const writeTextFile = (
        client as unknown as {
          writeTextFile: (request: unknown) => Promise<unknown>;
        }
      ).writeTextFile;
      const sessionUpdate = (
        client as unknown as {
          sessionUpdate: (notification: unknown) => Promise<void>;
        }
      ).sessionUpdate;

      // Supersede the connection the way a re-connect() does: disconnect()
      // nulls both child and sdkConnection, while the superseded connection's
      // stdout (still open) keeps its ClientSideConnection dispatching.
      (conn as unknown as AcpConnection).disconnect();

      await expect(
        writeTextFile({ path: '/tmp/x', content: 'x', sessionId: 's' }),
      ).rejects.toBeInstanceOf(RequestError);
      expect(writeSpy).not.toHaveBeenCalled();

      await sessionUpdate({});
      expect(conn.onSessionUpdate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a re-connected replacement keeps the superseded connection muted', async () => {
    // Every other supersede test drives the gate through disconnect(), which
    // nulls this.child and this.sdkConnection together, so the captured
    // identity predicate (`this.sdkConnection !== wiredConnection`) and a
    // weaker `!this.child` always agree. A real re-connect() installs a
    // replacement child and a fresh sdkConnection while the old connection's
    // stdout is still live — this.child is truthy again, so a gate weakened to
    // `!this.child` would resume dispatching the retired connection's
    // callbacks. This case pins the stronger predicate.
    try {
      const oldChild = createMockChild({
        stdout: new PassThrough(),
        stdin: new PassThrough(),
        on: vi.fn(),
      });
      const newChild = createMockChild({
        stdout: new PassThrough(),
        stdin: new PassThrough(),
        on: vi.fn(),
      });
      const oldStdinEnd = vi.spyOn(oldChild.stdin as PassThrough, 'end');
      spawnMock.mockReset();
      spawnMock.mockReturnValueOnce(oldChild).mockReturnValueOnce(newChild);

      const conn = new AcpConnection() as unknown as AcpConnectionInternal & {
        connect: (cliEntryPath: string) => Promise<void>;
        onSessionUpdate: (data: unknown) => void;
        fileHandler: {
          handleWriteTextFile: (request: unknown) => Promise<unknown>;
        };
      };
      conn.onSessionUpdate = vi.fn();
      const writeSpy = vi
        .spyOn(conn.fileHandler, 'handleWriteTextFile')
        .mockResolvedValue({});

      // First connect: capture the old client before it is superseded.
      const first = conn.connect(process.execPath);
      await vi.advanceTimersByTimeAsync(1000);
      await first;
      const oldClient = sdkClientFactory.factory?.(null);

      // Re-connect: disconnect() retires the old child, then a replacement
      // child and a fresh sdkConnection are installed while the old stdout is
      // still dispatching.
      const second = conn.connect(process.execPath);
      await vi.advanceTimersByTimeAsync(1000);
      await second;

      expect(conn.child).toBe(newChild);
      expect(oldStdinEnd).toHaveBeenCalledOnce();

      const writeTextFile = (
        oldClient as unknown as {
          writeTextFile: (request: unknown) => Promise<unknown>;
        }
      ).writeTextFile;
      const sessionUpdate = (
        oldClient as unknown as {
          sessionUpdate: (notification: unknown) => Promise<void>;
        }
      ).sessionUpdate;

      await expect(
        writeTextFile({ path: '/tmp/x', content: 'x', sessionId: 's' }),
      ).rejects.toBeInstanceOf(RequestError);
      expect(writeSpy).not.toHaveBeenCalled();

      await sessionUpdate({});
      expect(conn.onSessionUpdate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not stamp a superseded connection with a stale session id', async () => {
    // newSession/loadSession write this.sessionId only after awaiting the
    // connection they captured. A response from a retired CLI can resolve
    // after disconnect() nulled sessionId; the post-await write must gate on
    // the captured connection, or the dead session's id lands back on the
    // replacement connection's field. Removing either guard reds this test.
    let resolveNewSession!: (value: unknown) => void;
    let resolveLoadSession!: (value: unknown) => void;
    const sdk = {
      newSession: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveNewSession = resolve;
          }),
      ),
      loadSession: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveLoadSession = resolve;
          }),
      ),
    };
    const conn = createConnection({
      child: createMockChild(),
      sdkConnection: sdk,
      sessionId: 'test-session',
    });
    const acp = conn as unknown as AcpConnection;

    const newPromise = acp.newSession();
    const loadPromise = acp.loadSession('stale-session');
    acp.disconnect();

    resolveNewSession({ sessionId: 'stale-from-retired-cli' });
    resolveLoadSession({});
    // The guard must fail the call, not resolve it. Returning the retired
    // CLI's payload lets qwenAgentManager.applySessionStateFromResult write
    // the dead model/mode state into the live webview's baselines, and
    // createNewSession hands that same promise to every concurrent caller via
    // sessionCreateInFlight. Reverting either guard to `return response` reds
    // both assertions below.
    await expect(newPromise).rejects.toMatchObject({
      code: ACP_ERROR_CODES.INTERNAL_ERROR,
      message: expect.stringContaining('connection superseded'),
      data: { details: 'connection superseded' },
    });
    await expect(loadPromise).rejects.toMatchObject({
      code: ACP_ERROR_CODES.INTERNAL_ERROR,
      message: expect.stringContaining('connection superseded'),
      data: { details: 'connection superseded' },
    });

    expect(acp.currentSessionId).toBeNull();
  });

  it('a re-connected replacement does not stamp the retired session id', async () => {
    // Mirrors 'does not stamp a superseded connection with a stale session id'
    // but supersedes by re-connect instead of disconnect(). disconnect() nulls
    // this.child and this.sdkConnection together, so a gate weakened to
    // `!this.child` still bails there. After a re-connect this.child is truthy
    // again (the replacement), so `!this.child` would NOT bail and the retired
    // CLI's session/new + session/load would stamp their ids back onto the
    // live connection. This case pins `this.sdkConnection !== conn` (and its
    // `=== conn` mirror) against that substitution.
    let resolveNewSession!: (value: unknown) => void;
    let resolveLoadSession!: (value: unknown) => void;
    const oldSdk = {
      newSession: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveNewSession = resolve;
          }),
      ),
      loadSession: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveLoadSession = resolve;
          }),
      ),
    };
    const conn = createConnection({
      child: createMockChild(),
      sdkConnection: oldSdk,
      sessionId: 'live-session-1',
    });
    const acp = conn as unknown as AcpConnection;

    const newPromise = acp.newSession();
    const loadPromise = acp.loadSession('stale-session');

    // Re-connect: install a replacement child and a fresh sdkConnection while
    // the retired sdk's promises are still in flight.
    conn.child = createMockChild();
    conn.sdkConnection = { newSession: vi.fn(), loadSession: vi.fn() };
    conn.sessionId = 'live-session-2';

    resolveNewSession({ sessionId: 'stale-from-retired-cli' });
    resolveLoadSession({});
    // Same stale-result pin as the disconnect() case, on the re-connect path:
    // the retired CLI's payload must not reach the caller, or it is applied to
    // the replacement connection's live webview state.
    await expect(newPromise).rejects.toMatchObject({
      code: ACP_ERROR_CODES.INTERNAL_ERROR,
      message: expect.stringContaining('connection superseded'),
      data: { details: 'connection superseded' },
    });
    await expect(loadPromise).rejects.toMatchObject({
      code: ACP_ERROR_CODES.INTERNAL_ERROR,
      message: expect.stringContaining('connection superseded'),
      data: { details: 'connection superseded' },
    });

    expect(acp.currentSessionId).toBe('live-session-2');
  });

  it('a re-connected replacement does not fire onEndTurn for a retired prompt', async () => {
    // sendPrompt gates onEndTurn on the captured connection so a stale prompt
    // resolving after a re-connect does not clear the replacement's streaming
    // state. disconnect() nulls this.child and this.sdkConnection together, so
    // `!this.child` still bails there; only a re-connect (this.child truthy
    // again) can tell the two predicates apart.
    let resolvePrompt!: (value: unknown) => void;
    const oldSdk = {
      prompt: vi.fn(
        () =>
          new Promise((resolve) => {
            resolvePrompt = resolve;
          }),
      ),
    };
    const onEndTurn = vi.fn();
    const conn = createConnection({
      child: createMockChild(),
      sdkConnection: oldSdk,
      sessionId: 'session-1',
    });
    (conn as unknown as AcpConnection).onEndTurn = onEndTurn;
    const acp = conn as unknown as AcpConnection;

    const promptPromise = acp.sendPrompt('hi');

    conn.child = createMockChild();
    conn.sdkConnection = { prompt: vi.fn() };
    conn.sessionId = 'session-2';

    resolvePrompt({ stopReason: 'end_turn' });
    await expect(promptPromise).rejects.toMatchObject({
      code: ACP_ERROR_CODES.INTERNAL_ERROR,
      message: expect.stringContaining('connection superseded'),
      data: { details: 'connection superseded' },
    });

    expect(onEndTurn).not.toHaveBeenCalled();
  });

  it('does not fire onEndTurn when the prompt session is superseded in place', async () => {
    let resolvePrompt!: (value: unknown) => void;
    const sdk = {
      prompt: vi.fn(
        () =>
          new Promise((resolve) => {
            resolvePrompt = resolve;
          }),
      ),
    };
    const onEndTurn = vi.fn();
    const conn = createConnection({
      child: createMockChild(),
      sdkConnection: sdk,
      sessionId: 'session-a',
    });
    (conn as unknown as AcpConnection).onEndTurn = onEndTurn;
    const acp = conn as unknown as AcpConnection;

    const promptPromise = acp.sendPrompt('hi');
    // Session replacement on the same live connection leaves the SDK object
    // unchanged, so the session identity must be part of the stale-result
    // guard as well.
    conn.sessionId = 'session-b';

    resolvePrompt({ stopReason: 'end_turn' });
    await expect(promptPromise).rejects.toMatchObject({
      code: ACP_ERROR_CODES.INTERNAL_ERROR,
      message: expect.stringContaining('connection superseded'),
      data: { details: 'connection superseded' },
    });
    expect(onEndTurn).not.toHaveBeenCalled();
  });
});

describe('AcpConnection superseded session close (#11303)', () => {
  // The agent keeps a session alive until told otherwise, and a retained
  // session still fires autonomous model turns when its background tasks
  // complete. Replacing the current session must therefore tell the agent to
  // close the superseded one, or every New Session / history switch strands
  // one more live session in the CLI process.

  const closeParams = (sessionId: string) => ({
    sessionId,
    requireFlush: true,
    onlyIfUnheld: true,
    drainTimeoutMs: 8_000,
  });

  it('newSession closes the superseded session on the same connection', async () => {
    const extMethod = vi.fn().mockResolvedValue({ closed: true });
    const sdk = {
      newSession: vi.fn().mockResolvedValue({ sessionId: 'session-b' }),
      extMethod,
    };
    const conn = createConnection({
      child: createMockChild(),
      sdkConnection: sdk,
      sessionId: 'session-a',
    });

    await (conn as unknown as AcpConnection).newSession();

    expect(extMethod).toHaveBeenCalledWith(
      'qwen/control/session/close',
      closeParams('session-a'),
    );
    expect(conn.sessionId).toBe('session-b');
  });

  it('newSession does not close anything for the first session', async () => {
    const extMethod = vi.fn().mockResolvedValue({ closed: true });
    const sdk = {
      newSession: vi.fn().mockResolvedValue({ sessionId: 'session-a' }),
      extMethod,
    };
    const conn = createConnection({
      child: createMockChild(),
      sdkConnection: sdk,
      sessionId: null,
    });

    await (conn as unknown as AcpConnection).newSession();

    expect(extMethod).not.toHaveBeenCalled();
  });

  it('loadSession closes the superseded session on the same connection', async () => {
    const extMethod = vi.fn().mockResolvedValue({ closed: true });
    const sdk = {
      loadSession: vi.fn().mockResolvedValue({}),
      extMethod,
    };
    const conn = createConnection({
      child: createMockChild(),
      sdkConnection: sdk,
      sessionId: 'session-a',
    });

    await (conn as unknown as AcpConnection).loadSession('session-c');

    expect(extMethod).toHaveBeenCalledWith(
      'qwen/control/session/close',
      closeParams('session-a'),
    );
    expect(conn.sessionId).toBe('session-c');
  });

  it('loadSession does not close when reloading the current session', async () => {
    // Re-loading the session already on screen (e.g. history hydration after a
    // reconnect) must not close it out from under the live conversation.
    const extMethod = vi.fn().mockResolvedValue({ closed: true });
    const sdk = {
      loadSession: vi.fn().mockResolvedValue({}),
      extMethod,
    };
    const conn = createConnection({
      child: createMockChild(),
      sdkConnection: sdk,
      sessionId: 'session-a',
    });

    await (conn as unknown as AcpConnection).loadSession('session-a');

    expect(extMethod).not.toHaveBeenCalled();
  });

  it('sends the close conditionally so held work is refused, not dropped (#11511)', async () => {
    // Navigation is automatic cleanup, not explicit destruction: a session
    // that still holds active work must be refused ({closed: false, holds})
    // rather than force-closed. Pin the onlyIfUnheld + drain budget the CLI
    // contract keys on; dropping onlyIfUnheld reds this test.
    const extMethod = vi
      .fn()
      .mockResolvedValue({ closed: false, holds: ['running-task'] });
    const sdk = {
      newSession: vi.fn().mockResolvedValue({ sessionId: 'session-b' }),
      extMethod,
    };
    const conn = createConnection({
      child: createMockChild(),
      sdkConnection: sdk,
      sessionId: 'session-a',
    });

    await (conn as unknown as AcpConnection).newSession();

    expect(extMethod).toHaveBeenCalledWith('qwen/control/session/close', {
      sessionId: 'session-a',
      requireFlush: true,
      onlyIfUnheld: true,
      drainTimeoutMs: 8_000,
    });
    expect(conn.sessionId).toBe('session-b');
  });

  describe('superseded close retry (#11511)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const countClosesFor = (extMethod: Mock, sessionId: string) =>
      extMethod.mock.calls.filter(
        ([, params]) =>
          (params as { sessionId?: string }).sessionId === sessionId,
      ).length;

    it('retries a refused superseded close on a backoff until it succeeds', async () => {
      const extMethod = vi
        .fn()
        .mockResolvedValueOnce({ closed: false, holds: ['running-task'] })
        .mockResolvedValueOnce({ closed: true });
      const sdk = {
        newSession: vi.fn().mockResolvedValue({ sessionId: 'session-b' }),
        extMethod,
      };
      const conn = createConnection({
        child: createMockChild(),
        sdkConnection: sdk,
        sessionId: 'session-a',
      });

      await (conn as unknown as AcpConnection).newSession();
      await vi.advanceTimersByTimeAsync(0);
      expect(extMethod).toHaveBeenCalledTimes(1);

      // First retry only once the 60s rung expires.
      await vi.advanceTimersByTimeAsync(CLOSE_RETRY_BASE_MS - 1);
      expect(extMethod).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(extMethod).toHaveBeenCalledTimes(2);
      expect(extMethod).toHaveBeenNthCalledWith(
        2,
        'qwen/control/session/close',
        closeParams('session-a'),
      );

      // Closed for good: no third attempt, ever.
      await vi.advanceTimersByTimeAsync(CLOSE_RETRY_CEILING_MS);
      expect(extMethod).toHaveBeenCalledTimes(2);
    });

    it('backs off exponentially while a superseded close keeps being refused', async () => {
      const extMethod = vi
        .fn()
        .mockResolvedValue({ closed: false, holds: ['running-task'] });
      const sdk = {
        newSession: vi.fn().mockResolvedValue({ sessionId: 'session-b' }),
        extMethod,
      };
      const conn = createConnection({
        child: createMockChild(),
        sdkConnection: sdk,
        sessionId: 'session-a',
      });

      await (conn as unknown as AcpConnection).newSession();
      await vi.advanceTimersByTimeAsync(0);
      expect(extMethod).toHaveBeenCalledTimes(1);

      // First retry after 60s.
      await vi.advanceTimersByTimeAsync(CLOSE_RETRY_BASE_MS);
      expect(extMethod).toHaveBeenCalledTimes(2);

      // A refusal is evidence that the session still has active work, not a
      // transport failure, so each probe stays on the base rung.
      await vi.advanceTimersByTimeAsync(CLOSE_RETRY_BASE_MS);
      expect(extMethod).toHaveBeenCalledTimes(3);
    });

    it('cancels the retry when the superseded session is loaded again', async () => {
      const extMethod = vi
        .fn()
        .mockResolvedValueOnce({ closed: false, holds: ['running-task'] })
        .mockResolvedValue({ closed: true });
      const sdk = {
        newSession: vi.fn().mockResolvedValue({ sessionId: 'session-b' }),
        loadSession: vi.fn().mockResolvedValue({}),
        extMethod,
      };
      const conn = createConnection({
        child: createMockChild(),
        sdkConnection: sdk,
        sessionId: 'session-a',
      });
      const acp = conn as unknown as AcpConnection;

      await acp.newSession();
      await vi.advanceTimersByTimeAsync(0);
      expect(countClosesFor(extMethod, 'session-a')).toBe(1);

      // The superseded session becomes current again: session-b is now the
      // one being closed, and the pending session-a retry must never fire.
      await acp.loadSession('session-a');
      await vi.advanceTimersByTimeAsync(0);
      expect(countClosesFor(extMethod, 'session-b')).toBe(1);

      await vi.advanceTimersByTimeAsync(CLOSE_RETRY_BASE_MS * 4);
      expect(countClosesFor(extMethod, 'session-a')).toBe(1);
    });

    it('waits for an in-flight close before loading that session again', async () => {
      let resolveClose!: (value: unknown) => void;
      const extMethod = vi.fn(
        () =>
          new Promise((resolve) => {
            resolveClose = resolve;
          }),
      );
      const loadSession = vi.fn().mockResolvedValue({});
      const sdk = {
        newSession: vi.fn().mockResolvedValue({ sessionId: 'session-b' }),
        loadSession,
        extMethod,
      };
      const conn = createConnection({
        child: createMockChild(),
        sdkConnection: sdk,
        sessionId: 'session-a',
      });
      const acp = conn as unknown as AcpConnection;

      await acp.newSession();
      await vi.advanceTimersByTimeAsync(0);
      expect(extMethod).toHaveBeenCalledTimes(1);

      const loadPromise = acp.loadSession('session-a');
      await vi.advanceTimersByTimeAsync(0);
      expect(loadSession).not.toHaveBeenCalled();

      resolveClose({ closed: false, holds: ['running-task'] });
      await loadPromise;
      expect(loadSession).toHaveBeenCalledWith({
        sessionId: 'session-a',
        cwd: process.cwd(),
        mcpServers: [],
      });
    });

    it('deduplicates concurrent close attempts for one session', async () => {
      let resolveClose!: (value: unknown) => void;
      const extMethod = vi.fn(
        () =>
          new Promise((resolve) => {
            resolveClose = resolve;
          }),
      );
      const sdk = { extMethod };
      const conn = createConnection({
        child: createMockChild(),
        sdkConnection: sdk,
        sessionId: 'session-b',
      });
      const acp = conn as unknown as AcpConnection;
      const sendClose = (
        acp as unknown as { sendSupersededClose: (id: string) => void }
      ).sendSupersededClose;

      sendClose.call(acp, 'session-a');
      sendClose.call(acp, 'session-a');
      await vi.advanceTimersByTimeAsync(0);
      expect(extMethod).toHaveBeenCalledTimes(1);

      resolveClose({ closed: true });
      await vi.advanceTimersByTimeAsync(0);
    });

    it('caps transient close retry backoff at one hour', () => {
      const conn = createConnection({
        child: createMockChild(),
        sdkConnection: { extMethod: vi.fn() },
        sessionId: 'session-b',
      });
      const acp = conn as unknown as AcpConnection;
      const scheduleRetry = (
        acp as unknown as {
          scheduleSupersededCloseRetry: (id: string) => void;
        }
      ).scheduleSupersededCloseRetry;

      for (let i = 0; i < 10; i += 1) {
        scheduleRetry.call(acp, 'session-a');
      }

      const entry = (
        acp as unknown as {
          supersededCloseRetries: Map<string, { retryAt: number }>;
        }
      ).supersededCloseRetries.get('session-a');
      if (!entry) {
        throw new Error('expected a retry entry');
      }
      expect(entry.retryAt - Date.now()).toBe(CLOSE_RETRY_CEILING_MS);
    });

    it('stops retrying superseded closes after disconnect', async () => {
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
      try {
        const extMethod = vi
          .fn()
          .mockResolvedValue({ closed: false, holds: ['running-task'] });
        const sdk = {
          newSession: vi.fn().mockResolvedValue({ sessionId: 'session-b' }),
          extMethod,
        };
        const conn = createConnection({
          child: createMockChild(),
          sdkConnection: sdk,
          sessionId: 'session-a',
        });
        const acp = conn as unknown as AcpConnection;

        await acp.newSession();
        await vi.advanceTimersByTimeAsync(0);
        expect(extMethod).toHaveBeenCalledTimes(1);

        acp.disconnect();
        await vi.advanceTimersByTimeAsync(CLOSE_RETRY_BASE_MS * 4);
        expect(extMethod).toHaveBeenCalledTimes(1);
      } finally {
        killSpy.mockRestore();
      }
    });

    it('clears and cancels an in-flight close when disconnect retires the connection', async () => {
      let resolveClose!: (value: unknown) => void;
      const extMethod = vi.fn(
        () =>
          new Promise((resolve) => {
            resolveClose = resolve;
          }),
      );
      const sdk = {
        newSession: vi.fn().mockResolvedValue({ sessionId: 'session-b' }),
        extMethod,
      };
      const conn = createConnection({
        child: createMockChild(),
        sdkConnection: sdk,
        sessionId: 'session-a',
      });
      const acp = conn as unknown as AcpConnection;

      await acp.newSession();
      await vi.advanceTimersByTimeAsync(0);
      expect(extMethod).toHaveBeenCalledTimes(1);
      expect(
        (acp as unknown as { supersededCloseInFlight: Set<string> })
          .supersededCloseInFlight.size,
      ).toBe(1);

      acp.disconnect();
      expect(
        (acp as unknown as { supersededCloseInFlight: Set<string> })
          .supersededCloseInFlight.size,
      ).toBe(0);

      resolveClose({ closed: false, holds: ['running-task'] });
      await vi.advanceTimersByTimeAsync(0);
      expect(
        (
          acp as unknown as {
            supersededCloseRetries: Map<string, unknown>;
          }
        ).supersededCloseRetries.size,
      ).toBe(0);
    });

    it('re-drives an expired close retry on the next session replacement', async () => {
      const extMethod = vi
        .fn()
        .mockResolvedValue({ closed: false, holds: ['running-task'] });
      const sdk = {
        newSession: vi
          .fn()
          .mockResolvedValueOnce({ sessionId: 'session-b' })
          .mockResolvedValueOnce({ sessionId: 'session-c' }),
        extMethod,
      };
      const conn = createConnection({
        child: createMockChild(),
        sdkConnection: sdk,
        sessionId: 'session-a',
      });
      const acp = conn as unknown as AcpConnection;

      await acp.newSession();
      await vi.advanceTimersByTimeAsync(0);
      expect(countClosesFor(extMethod, 'session-a')).toBe(1);

      // Move the clock past the 60s rung WITHOUT running timers: the retry is
      // due but the timer thread has not fired. The next replacement must
      // drive it immediately (the daemon equivalent is the next active-work
      // snapshot).
      vi.setSystemTime(Date.now() + CLOSE_RETRY_BASE_MS + 1000);

      await acp.newSession();
      // closeSupersededSession() must drive the expired entry immediately;
      // observe that synchronous catch-up before advancing any timers.
      expect(countClosesFor(extMethod, 'session-a')).toBe(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(countClosesFor(extMethod, 'session-a')).toBe(2);
      expect(countClosesFor(extMethod, 'session-b')).toBe(1);
    });

    it('does not retry an unsupported close method on an older CLI', async () => {
      // Old-CLI compatibility: the ext method rejects, the replacement
      // session still succeeds, and an operation the CLI cannot implement is
      // not retried forever.
      const extMethod = vi
        .fn()
        .mockRejectedValue(new Error('Method not found'));
      const sdk = {
        newSession: vi.fn().mockResolvedValue({ sessionId: 'session-b' }),
        extMethod,
      };
      const conn = createConnection({
        child: createMockChild(),
        sdkConnection: sdk,
        sessionId: 'session-a',
      });
      const acp = conn as unknown as AcpConnection;

      await expect(acp.newSession()).resolves.toMatchObject({
        sessionId: 'session-b',
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(extMethod).toHaveBeenCalledTimes(1);
      expect(conn.sessionId).toBe('session-b');

      await vi.advanceTimersByTimeAsync(CLOSE_RETRY_BASE_MS);
      expect(extMethod).toHaveBeenCalledTimes(1);
    });
  });

  it('a failed close does not fail the new session', async () => {
    // Older CLIs have no session/close ext method; the replacement session
    // must still succeed, and the swallowed rejection must not surface as an
    // unhandled rejection.
    const extMethod = vi.fn().mockRejectedValue(new Error('Method not found'));
    const sdk = {
      newSession: vi.fn().mockResolvedValue({ sessionId: 'session-b' }),
      extMethod,
    };
    const conn = createConnection({
      child: createMockChild(),
      sdkConnection: sdk,
      sessionId: 'session-a',
    });
    const acp = conn as unknown as AcpConnection;

    await expect(acp.newSession()).resolves.toMatchObject({
      sessionId: 'session-b',
    });
    // Let the fire-and-forget rejection settle so an unhandled one would fail
    // the run rather than leak into an unrelated later test.
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(conn.sessionId).toBe('session-b');
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
