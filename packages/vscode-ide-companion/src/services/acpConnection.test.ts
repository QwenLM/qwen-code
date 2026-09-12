/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestError } from '@agentclientprotocol/sdk';
import type {
  ContentBlock,
  LoadSessionResponse,
  NewSessionResponse,
  PromptResponse,
} from '@agentclientprotocol/sdk';

const spawnMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());

// AcpConnection imports AcpFileHandler which imports vscode.
// Mock vscode so it can be resolved without the actual VS Code runtime.
vi.mock('vscode', () => ({}));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: spawnMock, execFile: execFileMock };
});

import { AcpConnection } from './acpConnection.js';
import { ACP_ERROR_CODES } from '../constants/acpSchema.js';

type MockChild = {
  killed: boolean;
  exitCode: number | null;
  signalCode?: NodeJS.Signals | null;
  pid?: number;
  kill?: (signal?: NodeJS.Signals) => boolean;
  stdin?: {
    destroyed?: boolean;
    writableEnded?: boolean;
    end: () => void;
    once: (event: string, listener: () => void) => unknown;
  } | null;
  stderr?: { on: (event: string, listener: (data: Buffer) => void) => unknown };
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  once?: (event: string, listener: () => void) => unknown;
};

type AcpConnectionInternal = {
  child: MockChild | null;
  sdkConnection: unknown;
  sessionId: string | null;
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

function createMockChild(overrides?: Record<string, unknown>) {
  return {
    killed: false,
    exitCode: null,
    signalCode: null,
    pid: 4242,
    kill: vi.fn().mockReturnValue(true),
    stdin: {
      destroyed: false,
      writableEnded: false,
      end: vi.fn(),
      once: vi.fn(),
    },
    once: vi.fn(),
    ...overrides,
  } as MockChild;
}

describe('AcpConnection process spawning', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it('creates a POSIX process group for shutdown escalation', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    spawnMock.mockReturnValue(createMockChild());
    const conn = new AcpConnection() as unknown as {
      connect: (cliEntryPath: string) => Promise<void>;
      setupChildProcessHandlers: () => Promise<void>;
    };
    conn.setupChildProcessHandlers = vi.fn().mockResolvedValue(undefined);

    await conn.connect(process.execPath);

    const options = spawnMock.mock.calls.at(-1)?.[2] as { detached?: boolean };
    expect(options.detached).toBe(true);
  });

  it('does not detach the ACP child on Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    spawnMock.mockReturnValue(createMockChild());
    const conn = new AcpConnection() as unknown as {
      connect: (cliEntryPath: string) => Promise<void>;
      setupChildProcessHandlers: () => Promise<void>;
    };
    conn.setupChildProcessHandlers = vi.fn().mockResolvedValue(undefined);

    await conn.connect(process.execPath);

    const options = spawnMock.mock.calls.at(-1)?.[2] as { detached?: boolean };
    expect(options.detached).toBe(false);
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
    vi.useFakeTimers();
    execFileMock.mockReset();
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

  it('disconnect closes stdin before escalating', () => {
    const mockKill = vi.fn();
    const end = vi.fn();
    const stdinOnce = vi.fn();
    const conn = createConnection({
      child: createMockChild({
        kill: mockKill,
        stdin: {
          destroyed: false,
          writableEnded: false,
          end,
          once: stdinOnce,
        },
      }),
      sdkConnection: {},
      sessionId: 'test-session',
    });

    (conn as unknown as AcpConnection).disconnect();
    expect(end).toHaveBeenCalledOnce();
    expect(stdinOnce).toHaveBeenCalledWith('error', expect.any(Function));
    expect(mockKill).not.toHaveBeenCalled();
  });

  it('disconnect closes stdin even when the child has no pid', () => {
    const end = vi.fn();
    const conn = createConnection({
      child: createMockChild({
        pid: undefined,
        stdin: {
          destroyed: false,
          writableEnded: false,
          end,
          once: vi.fn(),
        },
      }),
    });

    (conn as unknown as AcpConnection).disconnect();

    expect(end).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('escalates to the POSIX process group after both grace periods', () => {
    if (process.platform === 'win32') return;
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const conn = createConnection({ child: createMockChild() });

    (conn as unknown as AcpConnection).disconnect();
    vi.advanceTimersByTime(75_000);
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
    vi.advanceTimersByTime(75_000);
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
  });

  it('falls back to signalling the child when POSIX group signalling fails', () => {
    if (process.platform === 'win32') return;
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('missing process group');
    });
    const childKill = vi.fn().mockReturnValue(true);
    const conn = createConnection({
      child: createMockChild({ kill: childKill }),
    });

    (conn as unknown as AcpConnection).disconnect();
    vi.advanceTimersByTime(75_000);
    expect(childKill).toHaveBeenCalledWith('SIGTERM');
    vi.advanceTimersByTime(75_000);
    expect(childKill).toHaveBeenCalledWith('SIGKILL');
  });

  it('uses taskkill for an unresponsive Windows process tree', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const childKill = vi.fn();
    const conn = createConnection({
      child: createMockChild({ kill: childKill }),
    });

    (conn as unknown as AcpConnection).disconnect();
    vi.advanceTimersByTime(75_000);

    expect(execFileMock).toHaveBeenCalledWith(
      expect.stringMatching(/\\System32\\taskkill\.exe$/i),
      ['/f', '/t', '/pid', '4242'],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
    expect(childKill).not.toHaveBeenCalled();
  });

  it('degrades to child.kill() when taskkill fails', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const childKill = vi.fn().mockReturnValue(true);
    const conn = createConnection({
      child: createMockChild({ kill: childKill }),
    });
    execFileMock.mockImplementation(
      (
        _file: unknown,
        _args: unknown,
        _options: unknown,
        callback: (error: Error) => void,
      ) => {
        callback(new Error('spawn taskkill.exe ENOENT'));
      },
    );

    (conn as unknown as AcpConnection).disconnect();
    vi.advanceTimersByTime(75_000);

    expect(execFileMock).toHaveBeenCalled();
    expect(childKill).toHaveBeenCalled();
  });

  it('cancels escalation when the child exits normally', () => {
    let onExit: (() => void) | undefined;
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const child = createMockChild({
      once: vi.fn((event: string, listener: () => void) => {
        if (event === 'exit') onExit = listener;
      }),
    });
    const conn = createConnection({ child });

    (conn as unknown as AcpConnection).disconnect();
    onExit?.();
    vi.advanceTimersByTime(150_000);

    expect(kill).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('ignores an exit from a child replaced during graceful shutdown', async () => {
    let exitHandler:
      | ((code: number | null, signal: string | null) => void)
      | undefined;
    const oldChild = createMockChild({
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        if (event === 'exit') {
          exitHandler = listener as typeof exitHandler;
        }
      }),
    });
    const onDisconnected = vi.fn();
    const conn = createConnection({ child: oldChild });
    (conn as unknown as AcpConnection).onDisconnected = onDisconnected;
    const setup = (
      conn as unknown as { setupChildProcessHandlers: () => Promise<void> }
    ).setupChildProcessHandlers();
    void setup.catch(() => {});
    const replacement = createMockChild();
    conn.child = replacement;
    conn.sdkConnection = {};
    conn.sessionId = 'replacement';

    exitHandler?.(3, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(setup).rejects.toThrow(
      'Qwen ACP process failed to start (exit code: 3, signal: SIGTERM)',
    );

    expect(conn.child).toBe(replacement);
    expect(conn.sdkConnection).toEqual({});
    expect(conn.sessionId).toBe('replacement');
    expect(onDisconnected).not.toHaveBeenCalled();
  });

  it('invokes onDisconnected with the exit info when the current child exits', async () => {
    let exitHandler:
      | ((code: number | null, signal: string | null) => void)
      | undefined;
    const child = createMockChild({
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        if (event === 'exit') {
          exitHandler = listener as typeof exitHandler;
        }
      }),
    });
    const onDisconnected = vi.fn();
    const conn = createConnection({ child });
    (conn as unknown as AcpConnection).onDisconnected = onDisconnected;
    const setup = (
      conn as unknown as { setupChildProcessHandlers: () => Promise<void> }
    ).setupChildProcessHandlers();
    void setup.catch(() => {});

    exitHandler?.(1, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onDisconnected).toHaveBeenCalledWith(1, 'SIGTERM');
    expect(conn.child).toBeNull();
    expect(conn.sdkConnection).toBeNull();
    expect(conn.sessionId).toBeNull();
  });
});

describe('AcpConnection stale responses', () => {
  it('does not apply session or prompt responses from a retired connection', async () => {
    let resolveNew!: (value: NewSessionResponse) => void;
    let resolveLoad!: (value: LoadSessionResponse) => void;
    let resolvePrompt!: (value: PromptResponse) => void;
    const sdk = {
      newSession: vi.fn(
        () =>
          new Promise<NewSessionResponse>((resolve) => (resolveNew = resolve)),
      ),
      loadSession: vi.fn(
        () =>
          new Promise<LoadSessionResponse>(
            (resolve) => (resolveLoad = resolve),
          ),
      ),
      prompt: vi.fn(
        () =>
          new Promise<PromptResponse>((resolve) => (resolvePrompt = resolve)),
      ),
    };
    const onEndTurn = vi.fn();
    const conn = createConnection({
      child: createMockChild(),
      sdkConnection: sdk,
      sessionId: 'old-session',
    });
    (conn as unknown as AcpConnection).onEndTurn = onEndTurn;
    const acp = conn as unknown as AcpConnection;

    const create = acp.newSession();
    const load = acp.loadSession('loaded-session');
    const prompt = acp.sendPrompt('hello');
    void create.catch(() => {});
    void load.catch(() => {});
    void prompt.catch(() => {});
    conn.sdkConnection = {};
    conn.sessionId = 'old-session';
    resolveNew({ sessionId: 'created-session' });
    resolveLoad({});
    resolvePrompt({ stopReason: 'end_turn' });

    await expect(create).rejects.toThrow('connection superseded');
    await expect(load).rejects.toThrow('connection superseded');
    await expect(prompt).rejects.toThrow('connection superseded');
    expect(conn.sessionId).toBe('old-session');
    expect(onEndTurn).not.toHaveBeenCalled();
  });

  it('delivers a prompt that completes after a session switch on the same connection', async () => {
    let resolvePrompt!: (value: PromptResponse) => void;
    const sdk = {
      prompt: vi.fn(
        () =>
          new Promise<PromptResponse>((resolve) => (resolvePrompt = resolve)),
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

    const prompt = acp.sendPrompt('hello');
    void prompt.catch(() => {});
    // The user switches to another session on the SAME live connection while
    // the prompt is in flight. This must not be reported as a superseded
    // connection: the turn completed, so it resolves and emits end-of-turn.
    conn.sessionId = 'session-b';
    resolvePrompt({ stopReason: 'end_turn' });

    await expect(prompt).resolves.toMatchObject({ stopReason: 'end_turn' });
    expect(onEndTurn).toHaveBeenCalledWith('end_turn');
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
