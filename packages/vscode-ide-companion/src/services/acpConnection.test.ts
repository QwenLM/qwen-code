/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
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
  mapReadTextFileError: (error: unknown, filePath: string) => unknown;
  ensureConnection: () => unknown;
  handleExtensionNotification: (
    method: string,
    params: Record<string, unknown>,
  ) => void;
  onSessionUpdate: (data: unknown) => void;
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

describe('AcpConnection.getSlashCommandCompletions', () => {
  it('calls ACP extMethod and returns completion items', async () => {
    const extMethod = vi.fn().mockResolvedValue({
      items: [{ value: 'review', description: 'Review code' }],
    });
    const conn = createConnection({
      sdkConnection: { extMethod },
      child: { killed: false, exitCode: null },
      sessionId: 'session-1',
    }) as unknown as AcpConnection;

    const result = await conn.getSlashCommandCompletions('/skills');

    expect(extMethod).toHaveBeenCalledWith(
      '_qwencode/slash_command_completion',
      {
        sessionId: 'session-1',
        query: '/skills',
      },
    );
    expect(result).toEqual([{ value: 'review', description: 'Review code' }]);
  });

  it('returns empty list when there is no active session', async () => {
    const extMethod = vi.fn();
    const conn = createConnection({
      sdkConnection: { extMethod },
      child: { killed: false, exitCode: null },
      sessionId: null,
    }) as unknown as AcpConnection;

    await expect(conn.getSlashCommandCompletions('/skills')).resolves.toEqual(
      [],
    );
    expect(extMethod).not.toHaveBeenCalled();
  });
});

describe('AcpConnection extension notifications', () => {
  it('routes slash command notifications into assistant message chunks', () => {
    const onSessionUpdate = vi.fn();
    const conn = createConnection({
      child: { killed: false, exitCode: null },
      sessionId: 'session-1',
      onSessionUpdate,
    });

    conn.handleExtensionNotification('_qwencode/slash_command', {
      sessionId: 'session-1',
      command: '/skills',
      messageType: 'info',
      message: 'Available skills:\n- review',
    });

    expect(onSessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        update: expect.objectContaining({
          sessionUpdate: 'agent_message_chunk',
          content: { text: 'Available skills:\n- review' },
          _meta: expect.objectContaining({
            slashCommand: '/skills',
            slashCommandMessageType: 'info',
          }),
        }),
      }),
    );
  });
});

describe('AcpConnection lastExitCode/lastExitSignal', () => {
  it('initializes exit info as null', () => {
    const conn = createConnection();
    expect(conn.lastExitCode).toBeNull();
    expect(conn.lastExitSignal).toBeNull();
  });
});
