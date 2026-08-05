/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import {
  createTerminalWsConnectionHandler,
  type TerminalAttachProcess,
} from './terminal-ws.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';

class FakeWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<string | Buffer> = [];
  closeCalls: Array<{ code: number; reason: string }> = [];

  send(data: string | Buffer): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code: code ?? 1005, reason: reason ?? '' });
    this.readyState = 3;
    this.emit('close');
  }

  /** Test helper: simulate an inbound client frame. */
  receive(data: string | Buffer, isBinary: boolean): void {
    this.emit('message', data, isBinary);
  }

  sentJson(): Array<Record<string, unknown>> {
    return this.sent
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as Record<string, unknown>);
  }

  sentBinaryText(): string {
    return this.sent
      .filter((d): d is Buffer => Buffer.isBuffer(d))
      .map((d) => d.toString('utf8'))
      .join('');
  }
}

class FakeAttachProcess implements TerminalAttachProcess {
  dataCb?: (data: string) => void;
  exitCb?: (e: { exitCode: number; signal?: number }) => void;
  written: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  killed = false;

  onData(callback: (data: string) => void): void {
    this.dataCb = callback;
  }

  onExit(callback: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitCb = callback;
  }

  write(data: string): void {
    this.written.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
  }
}

function makeReq(url: string): IncomingMessage {
  return { url, headers: {} } as unknown as IncomingMessage;
}

function makeRegistry(opts: {
  single?: boolean;
  found?: boolean;
  trusted?: boolean;
  tasks?: unknown[];
}) {
  const runtime = {
    primary: true,
    trusted: opts.trusted ?? true,
    workspaceId: 'ws-1',
    workspaceCwd: '/work',
    bridge: {
      getSessionTasksStatus: vi.fn().mockResolvedValue({
        tasks: opts.tasks ?? [],
      }),
    },
  };
  const registry = {
    listEntries: vi
      .fn()
      .mockReturnValue(opts.single === false ? [{}, {}] : [{}]),
    primaryEntry: {
      state: 'active',
      current: { runtime },
    },
    resolveLiveSessionOwner: vi
      .fn()
      .mockReturnValue(
        opts.found === false
          ? { kind: 'not_found' }
          : { kind: 'found', runtime },
      ),
  } as unknown as WorkspaceRegistry;
  return { registry, runtime };
}

const TERMINAL_TASK = {
  kind: 'shell',
  id: 'bg_abc123',
  status: 'running',
  terminal: { socket: 'qwen-serve', tmuxSession: 'qsh-bg_abc123' },
};

describe('createTerminalWsConnectionHandler', () => {
  let proc: FakeAttachProcess;
  let spawnAttach: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    proc = new FakeAttachProcess();
    spawnAttach = vi.fn().mockResolvedValue(proc);
  });

  const flush = async (rounds = 5): Promise<void> => {
    for (let i = 0; i < rounds; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  it('rejects missing query params', () => {
    const { registry } = makeRegistry({ tasks: [TERMINAL_TASK] });
    const handler = createTerminalWsConnectionHandler({
      workspaceRegistry: registry,
      spawnAttach,
    });
    const ws = new FakeWebSocket();
    handler(ws as unknown as WebSocket, makeReq('/terminal'));
    expect(ws.closeCalls[0]?.code).toBe(4008);
    expect(spawnAttach).not.toHaveBeenCalled();
  });

  it('rejects an unknown session', async () => {
    const { registry } = makeRegistry({ single: false, found: false });
    const handler = createTerminalWsConnectionHandler({
      workspaceRegistry: registry,
      spawnAttach,
    });
    const ws = new FakeWebSocket();
    handler(
      ws as unknown as WebSocket,
      makeReq('/terminal?sessionId=nope&taskId=bg_abc123'),
    );
    await flush();
    expect(ws.closeCalls[0]?.code).toBe(4004);
    expect(spawnAttach).not.toHaveBeenCalled();
  });

  it('rejects a task without terminal metadata', async () => {
    const { registry } = makeRegistry({
      tasks: [{ kind: 'shell', id: 'bg_abc123', status: 'running' }],
    });
    const handler = createTerminalWsConnectionHandler({
      workspaceRegistry: registry,
      spawnAttach,
    });
    const ws = new FakeWebSocket();
    handler(
      ws as unknown as WebSocket,
      makeReq('/terminal?sessionId=sess-1&taskId=bg_abc123'),
    );
    await flush();
    expect(ws.closeCalls[0]?.code).toBe(4004);
    expect(ws.sentJson()[0]).toMatchObject({ type: 'error' });
    expect(spawnAttach).not.toHaveBeenCalled();
  });

  it('rejects a settled terminal task', async () => {
    const { registry } = makeRegistry({
      tasks: [{ ...TERMINAL_TASK, status: 'completed' }],
    });
    const handler = createTerminalWsConnectionHandler({
      workspaceRegistry: registry,
      spawnAttach,
    });
    const ws = new FakeWebSocket();
    handler(
      ws as unknown as WebSocket,
      makeReq('/terminal?sessionId=sess-1&taskId=bg_abc123'),
    );
    await flush();
    expect(ws.closeCalls[0]?.code).toBe(4004);
  });

  it('attaches, proxies bytes both ways, and resizes', async () => {
    const { registry } = makeRegistry({ tasks: [TERMINAL_TASK] });
    const handler = createTerminalWsConnectionHandler({
      workspaceRegistry: registry,
      spawnAttach,
    });
    const ws = new FakeWebSocket();
    handler(
      ws as unknown as WebSocket,
      makeReq('/terminal?sessionId=sess-1&taskId=bg_abc123'),
    );
    await flush();

    expect(spawnAttach).toHaveBeenCalledWith(
      'qwen-serve',
      'qsh-bg_abc123',
      80,
      24,
    );
    expect(ws.sentJson()).toContainEqual({ type: 'ready' });

    // pty output → binary frame down
    proc.dataCb!('REPL-READY-1\r\n');
    expect(ws.sentBinaryText()).toContain('REPL-READY-1');

    // binary keystrokes → pty stdin
    ws.receive(Buffer.from('hello\r'), true);
    expect(proc.written).toEqual(['hello\r']);

    // resize control → pty resize
    ws.receive(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }), false);
    expect(proc.resizes).toEqual([{ cols: 120, rows: 40 }]);

    // invalid dimensions are clamped to defaults
    ws.receive(JSON.stringify({ type: 'resize', cols: 99999 }), false);
    expect(proc.resizes[1]).toEqual({ cols: 80, rows: 24 });

    // pty exit → socket closes 1000
    proc.exitCb!({ exitCode: 0 });
    expect(ws.closeCalls[0]?.code).toBe(1000);
  });

  it('kills the pty when the socket closes', async () => {
    const { registry } = makeRegistry({ tasks: [TERMINAL_TASK] });
    const handler = createTerminalWsConnectionHandler({
      workspaceRegistry: registry,
      spawnAttach,
    });
    const ws = new FakeWebSocket();
    handler(
      ws as unknown as WebSocket,
      makeReq('/terminal?sessionId=sess-1&taskId=bg_abc123'),
    );
    await flush();
    ws.emit('close');
    expect(proc.killed).toBe(true);
  });

  it('caps concurrent sockets per session at 4', async () => {
    const { registry } = makeRegistry({ tasks: [TERMINAL_TASK] });
    const handler = createTerminalWsConnectionHandler({
      workspaceRegistry: registry,
      spawnAttach,
    });
    const sockets: FakeWebSocket[] = [];
    for (let i = 0; i < 4; i++) {
      const ws = new FakeWebSocket();
      sockets.push(ws);
      handler(
        ws as unknown as WebSocket,
        makeReq('/terminal?sessionId=sess-1&taskId=bg_abc123'),
      );
      await flush();
      expect(ws.sentJson()).toContainEqual({ type: 'ready' });
    }
    const fifth = new FakeWebSocket();
    handler(
      fifth as unknown as WebSocket,
      makeReq('/terminal?sessionId=sess-1&taskId=bg_abc123'),
    );
    await flush();
    expect(fifth.closeCalls[0]?.code).toBe(1013);

    // A slot frees up when one socket closes.
    sockets[0]!.emit('close');
    const sixth = new FakeWebSocket();
    handler(
      sixth as unknown as WebSocket,
      makeReq('/terminal?sessionId=sess-1&taskId=bg_abc123'),
    );
    await flush();
    expect(sixth.sentJson()).toContainEqual({ type: 'ready' });
  });

  it('rejects an untrusted non-primary runtime', async () => {
    const { registry } = makeRegistry({
      single: false,
      trusted: false,
      tasks: [TERMINAL_TASK],
    });
    // make the runtime non-primary
    const resolution = registry.resolveLiveSessionOwner('sess-1');
    if (resolution.kind === 'found') {
      (resolution.runtime as { primary: boolean }).primary = false;
    }
    const handler = createTerminalWsConnectionHandler({
      workspaceRegistry: registry,
      spawnAttach,
    });
    const ws = new FakeWebSocket();
    handler(
      ws as unknown as WebSocket,
      makeReq('/terminal?sessionId=sess-1&taskId=bg_abc123'),
    );
    await flush();
    expect(ws.closeCalls[0]?.code).toBe(4004);
    expect(spawnAttach).not.toHaveBeenCalled();
  });
});
