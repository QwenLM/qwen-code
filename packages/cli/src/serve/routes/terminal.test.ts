/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { WebTerminalRegistry } from '@qwen-code/qwen-code-core';
import type { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { createTerminalWsHandler } from './terminal.js';

const context = {
  workspaceCwd: '/workspace',
  env: { PATH: '/runtime/bin' },
};
const resolveWorkspace = (selector: string) =>
  selector === '/workspace' ? context : undefined;
const request = {
  url: '/terminal?terminalId=terminal%3Amanual-1&cwd=%2Fworkspace&replay=1',
} as IncomingMessage;

class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly readyState = this.OPEN;
  bufferedAmount = 0;
  readonly sent: unknown[] = [];
  readonly send = vi.fn((data: unknown) => this.sent.push(data));
  readonly close = vi.fn();
  readonly ping = vi.fn();
  readonly terminate = vi.fn(() => this.emit('close'));
}

function sentOutput(ws: FakeWebSocket): string[] {
  return ws.sent
    .filter((data): data is Buffer => Buffer.isBuffer(data))
    .map((data) => data.toString());
}

function registryWithSnapshot(
  snapshot:
    | {
        output: string;
        exited: boolean;
        exitCode?: number;
        workspaceCwd: string;
        handlesPrimaryDa?: boolean;
        failed?: boolean;
        failureMessage?: string;
      }
    | undefined,
) {
  return {
    create: vi.fn(async () => ({ terminalId: 'terminal:manual-1' })),
    readSnapshot: vi.fn(() => snapshot),
    addOutputListener: vi.fn(() => vi.fn()),
    addExitListener: vi.fn(() => vi.fn()),
    addFailureListener: vi.fn(() => vi.fn()),
    resize: vi.fn(() => true),
    write: vi.fn(() => 'written'),
    release: vi.fn(),
    releaseWorkspace: vi.fn(),
  } as unknown as WebTerminalRegistry;
}

describe('terminal WebSocket route', () => {
  it('passes the selected SSH launch command through to the terminal registry', async () => {
    const registry = registryWithSnapshot(undefined);
    const ws = new FakeWebSocket();
    const command = {
      file: 'ssh',
      args: ['-tt', 'host', 'cd /srv/project && exec sh -l'],
    };
    await createTerminalWsHandler(registry, () => ({
      ...context,
      command,
    })).onConnection(ws as unknown as WebSocket, request);
    expect(registry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceCwd: context.workspaceCwd,
        env: context.env,
        command,
      }),
    );
    ws.emit('close');
  });

  it('rejects legacy replay clients before creating a PTY', async () => {
    const registry = registryWithSnapshot(undefined);
    const ws = new FakeWebSocket();
    await createTerminalWsHandler(registry, resolveWorkspace).onConnection(
      ws as unknown as WebSocket,
      { url: request.url!.replace('&replay=1', '') } as IncomingMessage,
    );
    expect(ws.close).toHaveBeenCalledWith(4002, 'Terminal protocol mismatch');
    expect(registry.create).not.toHaveBeenCalled();
    expect(registry.addOutputListener).not.toHaveBeenCalled();
  });

  it('rejects invalid workspaces and terminal ids before creating a PTY', async () => {
    const registry = registryWithSnapshot(undefined);
    const unknown = new FakeWebSocket();
    await createTerminalWsHandler(registry, resolveWorkspace).onConnection(
      unknown as unknown as WebSocket,
      {
        url: '/terminal?terminalId=terminal%3Amanual-1&cwd=%2Funknown',
      } as IncomingMessage,
    );
    expect(unknown.close).toHaveBeenCalledWith(
      4002,
      'Terminal workspace unavailable',
    );

    const oversizedId = new FakeWebSocket();
    await createTerminalWsHandler(registry, resolveWorkspace).onConnection(
      oversizedId as unknown as WebSocket,
      {
        url: `/terminal?terminalId=${'x'.repeat(257)}&cwd=%2Fworkspace`,
      } as IncomingMessage,
    );
    expect(oversizedId.close).toHaveBeenCalledWith(
      4002,
      'Terminal workspace unavailable',
    );
    expect(registry.create).not.toHaveBeenCalled();
  });

  it('creates with the resolved runtime context and flushes buffered input', async () => {
    let resolveCreate: ((value: { terminalId: string }) => void) | undefined;
    const registry = registryWithSnapshot(undefined);
    vi.mocked(registry.create).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    vi.mocked(registry.readSnapshot)
      .mockReturnValueOnce(undefined)
      .mockReturnValue({
        output: 'prompt $ ',
        exited: false,
        workspaceCwd: '/workspace',
      });
    const ws = new FakeWebSocket();
    const connected = createTerminalWsHandler(
      registry,
      resolveWorkspace,
    ).onConnection(ws as unknown as WebSocket, request);
    ws.emit('message', 'echo ready\r');
    resolveCreate?.({ terminalId: 'terminal:manual-1' });
    await connected;

    expect(registry.create).toHaveBeenCalledWith({
      terminalId: 'terminal:manual-1',
      workspaceCwd: '/workspace',
      env: { PATH: '/runtime/bin' },
    });
    expect(sentOutput(ws)).toContain('prompt $ ');
    expect(ws.sent[0]).toBe(
      '\x00{"type":"snapshot","replay":false,"handlesPrimaryDa":false}',
    );
    expect(registry.write).toHaveBeenCalledWith(
      'terminal:manual-1',
      'echo ready\r',
    );
  });

  it('handles socket errors while terminal creation is pending', async () => {
    let resolveCreate: ((value: { terminalId: string }) => void) | undefined;
    const registry = registryWithSnapshot(undefined);
    vi.mocked(registry.create).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const ws = new FakeWebSocket();
    const connected = createTerminalWsHandler(
      registry,
      resolveWorkspace,
    ).onConnection(ws as unknown as WebSocket, request);

    expect(() => ws.emit('error', new Error('socket failed'))).not.toThrow();
    resolveCreate?.({ terminalId: 'terminal:manual-1' });
    await connected;

    expect(registry.addOutputListener).not.toHaveBeenCalled();
  });

  it('terminates a terminal socket that misses a heartbeat', async () => {
    vi.useFakeTimers();
    const registry = registryWithSnapshot({
      output: '',
      exited: false,
      workspaceCwd: '/workspace',
    });
    const detachOutput = vi.fn();
    vi.mocked(registry.addOutputListener).mockReturnValueOnce(detachOutput);
    const ws = new FakeWebSocket();

    await createTerminalWsHandler(registry, resolveWorkspace).onConnection(
      ws as unknown as WebSocket,
      request,
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(ws.ping).toHaveBeenCalledOnce();
    ws.emit('pong');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(ws.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(ws.terminate).toHaveBeenCalledOnce();
    expect(detachOutput).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('releases an exited session from the connection handshake', async () => {
    const registry = registryWithSnapshot({
      output: 'done',
      exited: true,
      exitCode: 0,
      workspaceCwd: '/workspace',
    });
    const ws = new FakeWebSocket();

    await createTerminalWsHandler(registry, resolveWorkspace).onConnection(
      ws as unknown as WebSocket,
      {
        url: `${request.url}&release=1`,
      } as IncomingMessage,
    );

    expect(registry.release).toHaveBeenCalledWith(
      'terminal:manual-1',
      '/workspace',
    );
    expect(registry.addOutputListener).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalledWith(4004, 'Terminal released');
  });

  it('replays the exit state and closes instead of swallowing input', async () => {
    const registry = registryWithSnapshot({
      output: 'done\r\n',
      exited: true,
      exitCode: 7,
      workspaceCwd: '/workspace',
    });
    const detachFailure = vi.fn();
    vi.mocked(registry.addFailureListener).mockReturnValueOnce(detachFailure);
    const ws = new FakeWebSocket();

    await createTerminalWsHandler(registry, resolveWorkspace).onConnection(
      ws as unknown as WebSocket,
      request,
    );

    expect(sentOutput(ws)).toEqual(['done\r\n']);
    expect(ws.sent).toContain('\x00{"type":"exit","exitCode":7}');
    expect(ws.close).toHaveBeenCalledWith(4000, 'Terminal exited');
    expect(registry.release).toHaveBeenCalledWith(
      'terminal:manual-1',
      '/workspace',
    );
    expect(registry.write).not.toHaveBeenCalled();
    expect(detachFailure).toHaveBeenCalledOnce();
    ws.emit('close');
    expect(detachFailure).toHaveBeenCalledOnce();
  });

  it('surfaces a backend resource failure as an error frame and a non-retryable close', async () => {
    const registry = registryWithSnapshot(undefined);
    // First read misses (the create path); the second lands on the live
    // session, so the failure below is delivered to an attached socket
    // instead of racing a 'Session unavailable' teardown.
    vi.mocked(registry.readSnapshot)
      .mockReturnValueOnce(undefined)
      .mockReturnValue({
        output: '',
        exited: false,
        workspaceCwd: '/workspace',
      });
    let failure: ((message: string) => void) | undefined;
    const detachFailure = vi.fn(() => {
      failure = undefined;
    });
    vi.mocked(registry.addFailureListener).mockImplementationOnce(
      (_terminalId, listener) => {
        failure = listener;
        // The real disposer unregisters the listener, so a route that
        // detaches before delivery can no longer be driven by this test.
        return detachFailure;
      },
    );
    const ws = new FakeWebSocket();
    await createTerminalWsHandler(registry, resolveWorkspace).onConnection(
      ws as unknown as WebSocket,
      request,
    );

    failure!('qwen-bun-pty resource limit reached');

    expect(ws.sent).toContain(
      '\x00{"type":"error","message":"qwen-bun-pty resource limit reached"}',
    );
    expect(ws.sent).not.toContain(
      '\x00{"type":"error","message":"Session unavailable"}',
    );
    // Delivery runs cleanup: the listener is detached and the socket closes
    // exactly once, with the non-retryable code.
    expect(detachFailure).toHaveBeenCalledOnce();
    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(ws.close).toHaveBeenCalledWith(4001, 'Terminal failed');
    // The backend already killed the child: the session is not released by
    // signalling it again — detach only, like the exit path.
    expect(registry.release).not.toHaveBeenCalled();
  });

  it.each(['held\r\n', ''])(
    'handshakes before replaying failed output %j and releases once',
    async (output) => {
      const registry = registryWithSnapshot({
        output,
        exited: false,
        workspaceCwd: '/workspace',
        failed: true,
        failureMessage: 'resource limit reached',
      });
      const detachFailure = vi.fn();
      vi.mocked(registry.addFailureListener).mockReturnValueOnce(detachFailure);
      const ws = new FakeWebSocket();

      await createTerminalWsHandler(registry, resolveWorkspace).onConnection(
        ws as unknown as WebSocket,
        request,
      );

      expect(ws.sent).toEqual([
        '\x00{"type":"snapshot","replay":true,"handlesPrimaryDa":false}',
        Buffer.from(output),
        '\x00{"type":"error","message":"resource limit reached"}',
      ]);
      expect(ws.send.mock.invocationCallOrder[0]!).toBeLessThan(
        detachFailure.mock.invocationCallOrder[0]!,
      );
      expect(detachFailure).toHaveBeenCalledOnce();
      expect(registry.release).toHaveBeenCalledExactlyOnceWith(
        'terminal:manual-1',
        '/workspace',
      );
      expect(ws.close).toHaveBeenCalledOnce();
      expect(ws.close).toHaveBeenCalledWith(4001, 'Terminal failed');
    },
  );

  it('releases a failed replay when its binary output is backpressured', async () => {
    const registry = registryWithSnapshot({
      output: 'held\r\n',
      exited: false,
      workspaceCwd: '/workspace',
      failed: true,
      failureMessage: 'resource limit reached',
    });
    const ws = new FakeWebSocket();
    ws.bufferedAmount = 8 * 1024 * 1024 + 1;
    await createTerminalWsHandler(registry, resolveWorkspace).onConnection(
      ws as unknown as WebSocket,
      request,
    );
    expect(ws.sent).toEqual([
      '\x00{"type":"snapshot","replay":true,"handlesPrimaryDa":false}',
    ]);
    expect(registry.release).toHaveBeenCalledExactlyOnceWith(
      'terminal:manual-1',
      '/workspace',
    );
    expect(ws.close).toHaveBeenCalledExactlyOnceWith(
      1013,
      'Terminal output backpressure',
    );
  });

  it.each([1, 2, 3])(
    'detaches and releases when failed replay send %i throws',
    async (throwAt) => {
      const registry = registryWithSnapshot({
        output: 'held\r\n',
        exited: false,
        workspaceCwd: '/workspace',
        failed: true,
        failureMessage: 'resource limit reached',
      });
      const subscriptions = new EventEmitter();
      const detachOutput = vi.fn();
      const detachExit = vi.fn();
      const detachFailure = vi.fn();
      vi.mocked(registry.addOutputListener).mockImplementationOnce(
        (_id, listener) => {
          subscriptions.on('output', listener);
          detachOutput.mockImplementation(() => {
            subscriptions.off('output', listener);
          });
          return detachOutput;
        },
      );
      vi.mocked(registry.addExitListener).mockImplementationOnce(
        (_id, listener) => {
          subscriptions.on('exit', listener);
          detachExit.mockImplementation(() => {
            subscriptions.off('exit', listener);
          });
          return detachExit;
        },
      );
      vi.mocked(registry.addFailureListener).mockImplementationOnce(
        (_id, listener) => {
          subscriptions.on('failure', listener);
          detachFailure.mockImplementation(() => {
            subscriptions.off('failure', listener);
          });
          return detachFailure;
        },
      );
      const ws = new FakeWebSocket();
      const sendError = new Error('injected send failure');
      ws.send.mockImplementation((data) => {
        if (ws.send.mock.calls.length === throwAt) throw sendError;
        return ws.sent.push(data);
      });

      await expect(
        createTerminalWsHandler(registry, resolveWorkspace).onConnection(
          ws as unknown as WebSocket,
          request,
        ),
      ).rejects.toBe(sendError);

      const frames = [
        '\x00{"type":"snapshot","replay":true,"handlesPrimaryDa":false}',
        Buffer.from('held\r\n'),
        '\x00{"type":"error","message":"resource limit reached"}',
      ];
      expect(ws.sent).toEqual(frames.slice(0, throwAt - 1));
      expect(ws.send.mock.calls).toEqual(
        frames.slice(0, throwAt).map((frame) => [frame]),
      );
      expect(detachOutput).toHaveBeenCalledOnce();
      expect(detachExit).toHaveBeenCalledOnce();
      expect(detachFailure).toHaveBeenCalledOnce();
      for (const event of ['output', 'exit', 'failure']) {
        expect(subscriptions.listenerCount(event)).toBe(0);
      }
      expect(registry.release).toHaveBeenCalledExactlyOnceWith(
        'terminal:manual-1',
        '/workspace',
      );
      subscriptions.emit('output', 'late output');
      subscriptions.emit('exit', { exitCode: 7 });
      subscriptions.emit('failure', 'late failure');
      ws.emit('close');
      expect(ws.send).toHaveBeenCalledTimes(throwAt);
      expect(registry.release).toHaveBeenCalledOnce();
      expect(ws.close).not.toHaveBeenCalled();
    },
  );

  it('still releases a failed replay when cleanup throws', async () => {
    const registry = registryWithSnapshot({
      output: 'held\r\n',
      exited: false,
      workspaceCwd: '/workspace',
      failed: true,
    });
    const cleanupError = new Error('injected detach failure');
    const detachFailure = vi.fn(() => {
      throw cleanupError;
    });
    vi.mocked(registry.addFailureListener).mockReturnValueOnce(detachFailure);
    const ws = new FakeWebSocket();

    await expect(
      createTerminalWsHandler(registry, resolveWorkspace).onConnection(
        ws as unknown as WebSocket,
        request,
      ),
    ).rejects.toBe(cleanupError);

    expect(detachFailure).toHaveBeenCalledOnce();
    expect(registry.release).toHaveBeenCalledExactlyOnceWith(
      'terminal:manual-1',
      '/workspace',
    );
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('closes cleanly when the session disappears before replay', async () => {
    const snapshot = {
      output: '',
      exited: false,
      workspaceCwd: '/workspace',
    };
    const registry = registryWithSnapshot(snapshot);
    const detachOutput = vi.fn();
    vi.mocked(registry.readSnapshot)
      .mockReturnValueOnce(snapshot)
      .mockReturnValueOnce(undefined);
    vi.mocked(registry.addOutputListener).mockReturnValueOnce(detachOutput);
    const ws = new FakeWebSocket();

    await createTerminalWsHandler(registry, resolveWorkspace).onConnection(
      ws as unknown as WebSocket,
      request,
    );

    expect(detachOutput).toHaveBeenCalledOnce();
    expect(ws.sent).toContain(
      '\x00{"type":"error","message":"Session unavailable"}',
    );
    expect(ws.close).toHaveBeenCalledWith(4002, 'Session unavailable');
  });

  it('preserves a live PTY exit until a reconnect replays it', async () => {
    let exit: ((event: { exitCode: number }) => void) | undefined;
    const snapshot = {
      output: '',
      exited: false,
      workspaceCwd: '/workspace',
      exitCode: undefined as number | undefined,
    };
    const registry = registryWithSnapshot(snapshot);
    vi.mocked(registry.addExitListener).mockImplementationOnce(
      (_terminalId, listener) => {
        exit = listener;
        return vi.fn();
      },
    );
    const ws = new FakeWebSocket();
    const handler = createTerminalWsHandler(registry, resolveWorkspace);
    await handler.onConnection(ws as unknown as WebSocket, request);

    snapshot.output = 'done\r\n';
    snapshot.exited = true;
    snapshot.exitCode = 9;
    Object.defineProperty(ws, 'readyState', { value: 3 });
    exit?.({ exitCode: 9 });

    expect(ws.close).toHaveBeenCalledWith(4000, 'Terminal exited');
    expect(registry.release).not.toHaveBeenCalled();

    const reconnect = new FakeWebSocket();
    await handler.onConnection(reconnect as unknown as WebSocket, request);

    expect(sentOutput(reconnect)).toEqual(['done\r\n']);
    expect(reconnect.sent).toContain('\x00{"type":"exit","exitCode":9}');
    expect(registry.release).toHaveBeenCalledWith(
      'terminal:manual-1',
      '/workspace',
    );
  });

  it('closes an active WebSocket when its workspace is released', async () => {
    let exit: ((event: { exitCode: number }) => void) | undefined;
    const registry = registryWithSnapshot({
      output: '',
      exited: false,
      workspaceCwd: '/workspace',
    });
    vi.mocked(registry.addExitListener).mockImplementationOnce(
      (_terminalId, listener) => {
        exit = listener;
        return vi.fn();
      },
    );
    vi.mocked(registry.releaseWorkspace).mockImplementationOnce(() => {
      exit?.({ exitCode: 143 });
    });
    const ws = new FakeWebSocket();
    await createTerminalWsHandler(registry, resolveWorkspace).onConnection(
      ws as unknown as WebSocket,
      request,
    );

    registry.releaseWorkspace('/workspace');

    expect(ws.sent).toContain('\x00{"type":"exit","exitCode":143}');
    expect(ws.close).toHaveBeenCalledWith(4000, 'Terminal exited');
  });

  it('sends live PTY output as binary and allows reconnect overlap', async () => {
    const listeners: Array<(data: string) => void> = [];
    const registry = registryWithSnapshot({
      output: '',
      exited: false,
      workspaceCwd: '/workspace',
      handlesPrimaryDa: true,
    });
    vi.mocked(registry.addOutputListener).mockImplementation(
      (_terminalId, listener) => {
        listeners.push(listener);
        return vi.fn();
      },
    );
    const first = new FakeWebSocket();
    const second = new FakeWebSocket();

    await createTerminalWsHandler(registry, resolveWorkspace).onConnection(
      first as unknown as WebSocket,
      request,
    );
    await createTerminalWsHandler(registry, resolveWorkspace).onConnection(
      second as unknown as WebSocket,
      request,
    );
    listeners[0]?.('live');
    listeners[1]?.('live');

    expect(sentOutput(first)).toContain('live');
    expect(sentOutput(second)).toContain('live');
    expect(first.sent.slice(0, 2)).toEqual([
      '\x00{"type":"snapshot","replay":true,"handlesPrimaryDa":true}',
      Buffer.from(''),
    ]);
    expect(registry.create).not.toHaveBeenCalled();
  });

  it('keeps a session created after its socket closed for reconnect', async () => {
    let resolveCreate: ((value: { terminalId: string }) => void) | undefined;
    const registry = registryWithSnapshot(undefined);
    vi.mocked(registry.create).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const ws = new FakeWebSocket();
    const connected = createTerminalWsHandler(
      registry,
      resolveWorkspace,
    ).onConnection(ws as unknown as WebSocket, request);

    ws.emit('close');
    resolveCreate?.({ terminalId: 'terminal:manual-1' });
    await connected;

    expect(registry.release).not.toHaveBeenCalled();
    expect(registry.addOutputListener).not.toHaveBeenCalled();
  });

  it('releases a session explicitly closed while creation is pending', async () => {
    let resolveCreate: ((value: { terminalId: string }) => void) | undefined;
    const registry = registryWithSnapshot(undefined);
    vi.mocked(registry.create).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const ws = new FakeWebSocket();
    const connected = createTerminalWsHandler(
      registry,
      resolveWorkspace,
    ).onConnection(ws as unknown as WebSocket, request);

    ws.emit('message', '\x00{"type":"release"}');
    ws.emit('close');
    resolveCreate?.({ terminalId: 'terminal:manual-1' });
    await connected;

    expect(registry.release).toHaveBeenCalledWith(
      'terminal:manual-1',
      '/workspace',
    );
    expect(ws.close).toHaveBeenCalledWith(4004, 'Terminal released');
    expect(registry.addOutputListener).not.toHaveBeenCalled();
  });

  it('retries while another connection is creating the terminal', async () => {
    const registry = registryWithSnapshot(undefined);
    vi.mocked(registry.create).mockResolvedValueOnce({
      error: 'Web terminal terminal:manual-1 is being created',
      retryable: true,
    });
    const ws = new FakeWebSocket();

    await createTerminalWsHandler(registry, resolveWorkspace).onConnection(
      ws as unknown as WebSocket,
      request,
    );

    expect(ws.close).toHaveBeenCalledWith(1013, 'Terminal is being created');
    expect(ws.sent).toEqual([]);
  });

  it('uses a bounded close reason for a long terminal id', async () => {
    const terminalId = 'x'.repeat(256);
    const registry = registryWithSnapshot(undefined);
    vi.mocked(registry.create).mockResolvedValueOnce({
      error: `Web terminal ${terminalId} is being created`,
      retryable: true,
    });
    const ws = new FakeWebSocket();
    ws.close.mockImplementation((_code, reason) => {
      if (Buffer.byteLength(String(reason)) > 123) {
        throw new RangeError('close reason too large');
      }
    });

    await createTerminalWsHandler(registry, resolveWorkspace).onConnection(
      ws as unknown as WebSocket,
      {
        url: `/terminal?terminalId=${terminalId}&cwd=%2Fworkspace&replay=1`,
      } as IncomingMessage,
    );

    expect(ws.close).toHaveBeenCalledWith(1013, 'Terminal is being created');
  });

  it('caps input buffered while PTY creation is pending', async () => {
    let resolveCreate: ((value: { terminalId: string }) => void) | undefined;
    const registry = registryWithSnapshot(undefined);
    vi.mocked(registry.create).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const ws = new FakeWebSocket();
    const connected = createTerminalWsHandler(
      registry,
      resolveWorkspace,
    ).onConnection(ws as unknown as WebSocket, request);

    ws.emit('message', 'x'.repeat(64 * 1024 + 1));
    resolveCreate?.({ terminalId: 'terminal:manual-1' });
    await connected;

    expect(ws.close).toHaveBeenCalledWith(1013, 'Terminal input too large');
    expect(registry.release).toHaveBeenCalledWith(
      'terminal:manual-1',
      '/workspace',
    );
    expect(registry.addOutputListener).not.toHaveBeenCalled();
  });

  it('flushes a resize buffered while PTY creation is pending', async () => {
    let resolveCreate: ((value: { terminalId: string }) => void) | undefined;
    const registry = registryWithSnapshot(undefined);
    vi.mocked(registry.create).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    vi.mocked(registry.readSnapshot)
      .mockReturnValueOnce(undefined)
      .mockReturnValue({
        output: '',
        exited: false,
        workspaceCwd: '/workspace',
      });
    const ws = new FakeWebSocket();
    const connected = createTerminalWsHandler(
      registry,
      resolveWorkspace,
    ).onConnection(ws as unknown as WebSocket, request);

    ws.emit('message', '\x00{"type":"resize","cols":120,"rows":40}');
    resolveCreate?.({ terminalId: 'terminal:manual-1' });
    await connected;

    expect(registry.resize).toHaveBeenCalledWith('terminal:manual-1', 120, 40);
  });

  it('reconnects without releasing on PTY input backpressure', async () => {
    const registry = registryWithSnapshot({
      output: '',
      exited: false,
      workspaceCwd: '/workspace',
    });
    vi.mocked(registry.write).mockReturnValueOnce('backpressure');
    const ws = new FakeWebSocket();
    await createTerminalWsHandler(registry, resolveWorkspace).onConnection(
      ws as unknown as WebSocket,
      request,
    );

    ws.emit('message', Buffer.from('large paste'), true);

    expect(registry.release).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalledWith(1013, 'Terminal input backpressure');
  });

  it('closes without retry when the terminal session is unavailable', async () => {
    const registry = registryWithSnapshot({
      output: '',
      exited: false,
      workspaceCwd: '/workspace',
    });
    vi.mocked(registry.write).mockReturnValueOnce('unavailable');
    const ws = new FakeWebSocket();
    await createTerminalWsHandler(registry, resolveWorkspace).onConnection(
      ws as unknown as WebSocket,
      request,
    );

    ws.emit('message', Buffer.from('input'), true);

    expect(registry.release).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalledWith(4002, 'Session unavailable');
  });

  it('allows live output while a maximum-size replay is buffered', async () => {
    let output: ((data: string) => void) | undefined;
    const registry = registryWithSnapshot({
      output: 'x'.repeat(4 * 1024 * 1024),
      exited: false,
      workspaceCwd: '/workspace',
    });
    vi.mocked(registry.addOutputListener).mockImplementationOnce(
      (_terminalId, listener) => {
        output = listener;
        return vi.fn();
      },
    );
    const ws = new FakeWebSocket();
    await createTerminalWsHandler(registry, resolveWorkspace).onConnection(
      ws as unknown as WebSocket,
      request,
    );
    ws.bufferedAmount = 4 * 1024 * 1024;

    output?.('live');

    expect(ws.close).not.toHaveBeenCalledWith(
      1013,
      'Terminal output backpressure',
    );
    expect(sentOutput(ws)).toContain('live');
  });

  it('detaches and closes a stalled output connection', async () => {
    let output: ((data: string) => void) | undefined;
    const detachOutput = vi.fn();
    const registry = registryWithSnapshot({
      output: '',
      exited: false,
      workspaceCwd: '/workspace',
    });
    vi.mocked(registry.addOutputListener).mockImplementationOnce(
      (_terminalId, listener) => {
        output = listener;
        return detachOutput;
      },
    );
    const ws = new FakeWebSocket();
    await createTerminalWsHandler(registry, resolveWorkspace).onConnection(
      ws as unknown as WebSocket,
      request,
    );
    ws.bufferedAmount = 8 * 1024 * 1024 + 1;

    output?.('more output');

    expect(detachOutput).toHaveBeenCalledOnce();
    expect(ws.close).toHaveBeenCalledWith(1013, 'Terminal output backpressure');
  });

  it('detaches listeners after an attached socket closes', async () => {
    const detachOutput = vi.fn();
    const detachExit = vi.fn();
    const registry = registryWithSnapshot({
      output: '',
      exited: false,
      workspaceCwd: '/workspace',
    });
    vi.mocked(registry.addOutputListener).mockReturnValueOnce(detachOutput);
    vi.mocked(registry.addExitListener).mockReturnValueOnce(detachExit);
    const ws = new FakeWebSocket();
    await createTerminalWsHandler(registry, resolveWorkspace).onConnection(
      ws as unknown as WebSocket,
      request,
    );

    ws.emit('close');

    expect(detachOutput).toHaveBeenCalledOnce();
    expect(detachExit).toHaveBeenCalledOnce();
  });

  it('prevents a terminal id from being claimed by another workspace', async () => {
    const registry = registryWithSnapshot({
      output: 'secret',
      exited: false,
      workspaceCwd: '/other',
    });
    const ws = new FakeWebSocket();

    await createTerminalWsHandler(registry, resolveWorkspace).onConnection(
      ws as unknown as WebSocket,
      request,
    );

    expect(ws.close).toHaveBeenCalledWith(4002, 'Terminal workspace mismatch');
    expect(registry.addOutputListener).not.toHaveBeenCalled();
  });

  it('handles release and resize controls while dropping invalid text controls', async () => {
    const registry = registryWithSnapshot({
      output: '',
      exited: false,
      workspaceCwd: '/workspace',
    });
    const ws = new FakeWebSocket();
    await createTerminalWsHandler(registry, resolveWorkspace).onConnection(
      ws as unknown as WebSocket,
      request,
    );

    ws.emit('message', '\x00not-json');
    ws.emit('message', Buffer.from('\x00{"type":"release"}'), true);
    ws.emit('message', '\x00{"type":"resize","cols":1001,"rows":40}');
    ws.emit('message', '\x00{"type":"resize","cols":120,"rows":40}');
    ws.emit('message', '\x00{"type":"release"}');

    expect(registry.write).not.toHaveBeenCalledWith(
      'terminal:manual-1',
      '\x00not-json',
    );
    expect(registry.write).not.toHaveBeenCalledWith(
      'terminal:manual-1',
      '\x00{"type":"resize","cols":1001,"rows":40}',
    );
    expect(registry.write).toHaveBeenCalledWith(
      'terminal:manual-1',
      '\x00{"type":"release"}',
    );
    expect(registry.resize).toHaveBeenCalledWith('terminal:manual-1', 120, 40);
    expect(registry.release).toHaveBeenCalledWith(
      'terminal:manual-1',
      '/workspace',
    );
    expect(ws.close).toHaveBeenCalledWith(4004, 'Terminal released');
  });

  it.each([
    { name: 'input', data: Buffer.from('pwd\r'), isBinary: true },
    {
      name: 'resize',
      data: '\x00{"type":"resize","cols":80,"rows":24}',
      isBinary: false,
    },
  ])(
    'reports an error when the workspace becomes unavailable during $name',
    async ({ data, isBinary }) => {
      let available = true;
      const registry = registryWithSnapshot({
        output: '',
        exited: false,
        workspaceCwd: '/workspace',
      });
      const ws = new FakeWebSocket();
      await createTerminalWsHandler(registry, () =>
        available ? context : undefined,
      ).onConnection(ws as unknown as WebSocket, request);

      available = false;
      ws.emit('message', data, isBinary);

      expect(ws.sent).toContain(
        '\x00{"type":"error","message":"Terminal workspace unavailable"}',
      );
      expect(registry.release).not.toHaveBeenCalled();
      expect(ws.close).toHaveBeenCalledWith(
        4002,
        'Terminal workspace unavailable',
      );
      expect(registry.write).not.toHaveBeenCalled();
      expect(registry.resize).not.toHaveBeenCalled();

      available = true;
      await createTerminalWsHandler(registry, () => context).onConnection(
        new FakeWebSocket() as unknown as WebSocket,
        request,
      );
      expect(registry.addOutputListener).toHaveBeenCalledTimes(2);
    },
  );

  it('stops output when the workspace becomes unavailable', async () => {
    let available = true;
    let output: ((data: string) => void) | undefined;
    const registry = registryWithSnapshot({
      output: '',
      exited: false,
      workspaceCwd: '/workspace',
    });
    vi.mocked(registry.addOutputListener).mockImplementationOnce(
      (_terminalId, listener) => {
        output = listener;
        return vi.fn();
      },
    );
    const ws = new FakeWebSocket();
    await createTerminalWsHandler(registry, () =>
      available ? context : undefined,
    ).onConnection(ws as unknown as WebSocket, request);

    available = false;
    output?.('secret output');

    expect(sentOutput(ws)).not.toContain('secret output');
    expect(ws.sent).toContain(
      '\x00{"type":"error","message":"Terminal workspace unavailable"}',
    );
    expect(ws.close).toHaveBeenCalledWith(
      4002,
      'Terminal workspace unavailable',
    );
  });

  it('rejects create failures with a non-retryable close code', async () => {
    const registry = registryWithSnapshot(undefined);
    vi.mocked(registry.create).mockResolvedValueOnce({
      error: 'PTY unavailable',
    });
    const ws = new FakeWebSocket();

    await createTerminalWsHandler(registry, resolveWorkspace).onConnection(
      ws as unknown as WebSocket,
      request,
    );

    expect(ws.close).toHaveBeenCalledWith(4001, 'Terminal unavailable');
  });
});
