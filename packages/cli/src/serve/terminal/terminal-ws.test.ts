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
  bridgeThrows?: boolean;
  resolveThrows?: boolean;
  primaryState?: string;
}) {
  const runtime = {
    primary: true,
    trusted: opts.trusted ?? true,
    workspaceId: 'ws-1',
    workspaceCwd: '/work',
    bridge: {
      getSessionTasksStatus: vi.fn().mockImplementation(() => {
        if (opts.bridgeThrows) throw new Error('bridge unavailable');
        return Promise.resolve({ tasks: opts.tasks ?? [] });
      }),
    },
  };
  const registry = {
    listEntries: vi
      .fn()
      .mockReturnValue(opts.single === false ? [{}, {}] : [{}]),
    primaryEntry: {
      state: opts.primaryState ?? 'active',
      current: { runtime },
    },
    resolveLiveSessionOwner: vi.fn().mockImplementation(() => {
      if (opts.resolveThrows) throw new Error('registry wedge');
      return opts.found === false
        ? { kind: 'not_found' }
        : { kind: 'found', runtime };
    }),
  } as unknown as WorkspaceRegistry;
  return { registry, runtime };
}

const TERMINAL_TASK = {
  kind: 'shell',
  id: 'bg_abc123',
  status: 'running',
  terminal: {
    socket: 'qwen-serve',
    tmuxSession: 'qsh-bg_abc123',
    paneId: '%1',
  },
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
      undefined,
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

    // oversized dimensions are capped, invalid ones fall back to defaults
    ws.receive(JSON.stringify({ type: 'resize', cols: 99999 }), false);
    expect(proc.resizes[1]).toEqual({ cols: 500, rows: 24 });
    ws.receive(JSON.stringify({ type: 'resize', cols: -5, rows: 0 }), false);
    expect(proc.resizes[2]).toEqual({ cols: 80, rows: 24 });

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

  it('rejects an unknown taskId when the session has several tasks', async () => {
    const { registry } = makeRegistry({
      tasks: [
        { kind: 'shell', id: 'bg_other', status: 'running' },
        TERMINAL_TASK,
      ],
    });
    const handler = createTerminalWsConnectionHandler({
      workspaceRegistry: registry,
      spawnAttach,
    });
    const ws = new FakeWebSocket();
    handler(
      ws as unknown as WebSocket,
      makeReq('/terminal?sessionId=sess-1&taskId=bg_missing'),
    );
    await flush();
    expect(ws.closeCalls[0]?.code).toBe(4004);
    expect(spawnAttach).not.toHaveBeenCalled();
  });

  it('rejects when the bridge task lookup throws', async () => {
    const { registry } = makeRegistry({
      bridgeThrows: true,
      tasks: [TERMINAL_TASK],
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

  it('rejects when session-owner resolution throws', async () => {
    const { registry } = makeRegistry({ single: false, resolveThrows: true });
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
    expect(ws.closeCalls[0]?.code).toBe(1011);
    expect(spawnAttach).not.toHaveBeenCalled();
  });

  it('rejects when the single entry is not active', async () => {
    const { registry } = makeRegistry({
      primaryState: 'draining',
      tasks: [TERMINAL_TASK],
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
    expect(spawnAttach).not.toHaveBeenCalled();
  });

  it('rejects when the attach spawn fails', async () => {
    spawnAttach.mockRejectedValue(new Error('no server running'));
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
    expect(ws.closeCalls[0]?.code).toBe(1011);
    expect(ws.sentJson()[0]).toMatchObject({ type: 'error' });
  });

  it('forwards the sessionId from the URL to session-owner resolution and task lookup', async () => {
    const { registry, runtime } = makeRegistry({
      single: false,
      tasks: [TERMINAL_TASK],
    });
    const handler = createTerminalWsConnectionHandler({
      workspaceRegistry: registry,
      spawnAttach,
    });
    const ws = new FakeWebSocket();
    handler(
      ws as unknown as WebSocket,
      makeReq('/terminal?sessionId=sess-42&taskId=bg_abc123'),
    );
    await flush();
    expect(registry.resolveLiveSessionOwner).toHaveBeenCalledWith('sess-42');
    expect(runtime.bridge.getSessionTasksStatus).toHaveBeenCalledWith(
      'sess-42',
    );
  });

  it('passes the runtime attach env to spawnAttach', async () => {
    const { registry } = makeRegistry({ tasks: [TERMINAL_TASK] });
    const resolveAttachEnv = vi.fn().mockReturnValue({ FOO: 'bar' });
    const handler = createTerminalWsConnectionHandler({
      workspaceRegistry: registry,
      spawnAttach,
      resolveAttachEnv,
    });
    const ws = new FakeWebSocket();
    handler(
      ws as unknown as WebSocket,
      makeReq('/terminal?sessionId=sess-1&taskId=bg_abc123'),
    );
    await flush();
    expect(resolveAttachEnv).toHaveBeenCalled();
    expect(spawnAttach).toHaveBeenCalledWith(
      'qwen-serve',
      'qsh-bg_abc123',
      80,
      24,
      { FOO: 'bar' },
    );
  });

  it('keeps the per-session cap consistent across rejects and errors', async () => {
    const { registry } = makeRegistry({ tasks: [TERMINAL_TASK] });
    const handler = createTerminalWsConnectionHandler({
      workspaceRegistry: registry,
      spawnAttach,
    });
    // Rejected connections (4004 on unknown task) must not leak slots.
    for (let i = 0; i < 5; i++) {
      const ws = new FakeWebSocket();
      handler(
        ws as unknown as WebSocket,
        makeReq('/terminal?sessionId=sess-1&taskId=bg_missing'),
      );
      await flush();
      expect(ws.closeCalls[0]?.code).toBe(4004);
    }
    // A socket that errors after attach frees its slot exactly once.
    const errored = new FakeWebSocket();
    handler(
      errored as unknown as WebSocket,
      makeReq('/terminal?sessionId=sess-1&taskId=bg_abc123'),
    );
    await flush();
    errored.emit('error', new Error('boom'));
    // Four concurrent attaches still fit afterwards.
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
  });

  it('truncates close reasons on a byte boundary without splitting characters', async () => {
    const { registry } = makeRegistry({ tasks: [TERMINAL_TASK] });
    const handler = createTerminalWsConnectionHandler({
      workspaceRegistry: registry,
      spawnAttach,
    });
    const longTaskId = '任'.repeat(200);
    const ws = new FakeWebSocket();
    handler(
      ws as unknown as WebSocket,
      makeReq(`/terminal?sessionId=sess-1&taskId=${longTaskId}`),
    );
    await flush();
    expect(ws.closeCalls[0]?.code).toBe(4004);
    const reason = ws.closeCalls[0]?.reason ?? '';
    expect(Buffer.byteLength(reason, 'utf8')).toBeLessThanOrEqual(120);
    expect(reason).not.toContain('\uFFFD');
  });

  it('closes oversized inbound frames without writing them to the pty', async () => {
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
    ws.receive(Buffer.alloc(1024 * 1024 + 1), true);
    expect(proc.written).toHaveLength(0);
    expect(ws.closeCalls[0]?.code).toBe(1009);
  });

  it('closes with backpressure when the send buffer overflows', async () => {
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
    ws.bufferedAmount = 16 * 1024 * 1024 + 1;
    proc.dataCb!('more output');
    expect(ws.closeCalls[0]?.code).toBe(1013);
  });

  it('resizes the pty when the hello frame arrives', async () => {
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
    ws.receive(JSON.stringify({ type: 'hello', cols: 111, rows: 33 }), false);
    expect(proc.resizes).toContainEqual({ cols: 111, rows: 33 });
  });

  it('kills the attach when the socket closes while spawning', async () => {
    const { registry } = makeRegistry({ tasks: [TERMINAL_TASK] });
    // The attach spawn resolves only after the client went away.
    let release!: (proc: FakeAttachProcess) => void;
    spawnAttach.mockReturnValue(
      new Promise<FakeAttachProcess>((resolve) => {
        release = resolve;
      }),
    );
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
    ws.close(1000, 'user left');
    const lateProc = new FakeAttachProcess();
    release(lateProc);
    await flush();
    expect(lateProc.killed).toBe(true);
    expect(ws.sentJson()).not.toContainEqual({ type: 'ready' });
  });

  it('isolates the pty of one connection from its siblings', async () => {
    const { registry } = makeRegistry({ tasks: [TERMINAL_TASK] });
    const procs: FakeAttachProcess[] = [];
    spawnAttach.mockImplementation(async () => {
      const p = new FakeAttachProcess();
      procs.push(p);
      return p;
    });
    const handler = createTerminalWsConnectionHandler({
      workspaceRegistry: registry,
      spawnAttach,
    });
    const wsA = new FakeWebSocket();
    const wsB = new FakeWebSocket();
    handler(
      wsA as unknown as WebSocket,
      makeReq('/terminal?sessionId=sess-1&taskId=bg_abc123'),
    );
    await flush();
    handler(
      wsB as unknown as WebSocket,
      makeReq('/terminal?sessionId=sess-1&taskId=bg_abc123'),
    );
    await flush();
    const [procA, procB] = procs;
    expect(procA).not.toBe(procB);
    // Detaching one viewer must not kill the other's attach.
    wsA.close(1000, 'bye');
    expect(procA.killed).toBe(true);
    expect(procB.killed).toBe(false);
    expect(wsB.readyState).toBe(1);
  });

  it('surfaces a non-zero attach exit instead of a clean close', async () => {
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
    proc.exitCb!({ exitCode: 1 });
    expect(ws.sentJson()).toContainEqual(
      expect.objectContaining({ type: 'error' }),
    );
    expect(ws.closeCalls[0]?.code).toBe(1011);
  });
});
