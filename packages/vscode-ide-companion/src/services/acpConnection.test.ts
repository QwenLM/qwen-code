/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const SHUTDOWN_GRACE_MS = 45_000;

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

  it('spawns the child detached on POSIX but not on Windows', async () => {
    // The POSIX escalation is a process-group SIGKILL (process.kill(-pid,
    // ...)): it reaches the CLI's whole group only because the child is
    // spawned detached and so leads its own group. Windows has no signalable
    // group — its tree kill goes through taskkill, and there `detached` only
    // changes console attachment. Pin both sides so a future refactor of the
    // options object cannot silently turn the group kill into a root-only
    // kill that orphans every descendant (the #11303 leak).
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
    vi.advanceTimersByTime(SHUTDOWN_GRACE_MS);

    expect(execFileMock).not.toHaveBeenCalled();
    expect(mockKill).not.toHaveBeenCalled();
  });

  it('does not end stdin that is already closed', () => {
    // Even when stdin cannot be ended (already closed), the escalation timer
    // must still be armed: an early return here would leave the CLI's process
    // group running forever. Assert the force-kill still fires past the grace.
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
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
  });

  it('disconnect force-kills the CLI process group only after it fails to exit on its own', () => {
    // Pinned so the assertion does not depend on which runner executes it.
    const platform = vi
      .spyOn(process, 'platform', 'get')
      .mockReturnValue('linux');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
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
      expect(killSpy).not.toHaveBeenCalled();

      // The grace has to outlast the CLI's own wind-down (8s MCP pool drain +
      // 30s session drain), so nothing may be signalled one tick before it
      // expires. A grace shorter than that wind-down reds this assertion.
      vi.advanceTimersByTime(SHUTDOWN_GRACE_MS - 1);
      expect(killSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      // The escalation signals the process GROUP (negative pid), not just the
      // CLI root process: it reaps the CLI root and its non-detached children
      // (MCP stdio servers), but not setsid() descendants (detached hook
      // supervisors, monitors, node-pty sessions). Removing the group kill
      // reds this assertion.
      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
      expect(mockKill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      killSpy.mockRestore();
      platform.mockRestore();
    }
  });

  it('escalates through taskkill /t on Windows, not a bare kill', () => {
    // Windows CI is skipped on PRs, so the platform is faked here rather than
    // left to whichever runner happens to execute the suite.
    const platform = vi
      .spyOn(process, 'platform', 'get')
      .mockReturnValue('win32');
    vi.useFakeTimers();
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
      vi.useRealTimers();
      platform.mockRestore();
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
    vi.useFakeTimers();
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
    await newPromise;
    await loadPromise;

    expect(acp.currentSessionId).toBeNull();
  });

  it('disconnect does not force-kill a CLI that exited on its own', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
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
      // Past the deadline the cancelled timer would have fired at, otherwise
      // the cancellation this test pins is never exercised.
      vi.advanceTimersByTime(SHUTDOWN_GRACE_MS);

      expect(mockKill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
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
