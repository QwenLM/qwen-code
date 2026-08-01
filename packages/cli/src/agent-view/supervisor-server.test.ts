/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachAgentViewSupervisorTerminal,
  callAgentViewSupervisor,
  requestAgentViewSupervisor,
  subscribeAgentViewSupervisor,
} from './supervisor-client.js';
import { createAgentViewSupervisorHandler } from './supervisor-process.js';
import { createAgentViewSupervisorServer } from './supervisor-server.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((entry) => fs.rm(entry, { recursive: true, force: true })),
  );
});

describe('Agent View supervisor server', () => {
  it('serves status/list/shutdown requests through the JSON IPC client', async () => {
    const { dir, socketPath } = await makeSocketPath();
    cleanupPaths.push(dir);
    const handler = {
      status: vi.fn(() => ({ state: 'ok' })),
      list: vi.fn(() => [{ sessionId: 'session-1' }]),
      shutdown: vi.fn(() => ({ shuttingDown: true })),
    };
    const server = createAgentViewSupervisorServer(handler, { socketPath });

    await server.listen();
    try {
      await expect(
        requestAgentViewSupervisor(socketPath, {
          id: 'status-request',
          op: 'status',
          params: { verbose: true },
        }),
      ).resolves.toMatchObject({
        ok: true,
        result: { state: 'ok' },
      });
      expect(handler.status).toHaveBeenCalledWith({ verbose: true });

      await expect(
        callAgentViewSupervisor(socketPath, 'list'),
      ).resolves.toEqual([{ sessionId: 'session-1' }]);
      expect(handler.list).toHaveBeenCalledWith(undefined);

      await expect(
        callAgentViewSupervisor(socketPath, 'shutdown'),
      ).resolves.toEqual({ shuttingDown: true });
      expect(handler.shutdown).toHaveBeenCalledWith(undefined);
    } finally {
      await server.close();
    }
  });

  it('requires the supervisor auth token when configured', async () => {
    const { dir, socketPath } = await makeSocketPath();
    cleanupPaths.push(dir);
    const handler = {
      status: vi.fn(() => ({ state: 'ok' })),
      list: vi.fn(() => []),
      shutdown: vi.fn(() => ({})),
    };
    const server = createAgentViewSupervisorServer(handler, {
      socketPath,
      authToken: 'secret-token',
    });

    await server.listen();
    try {
      await expect(
        callAgentViewSupervisor(socketPath, 'status'),
      ).rejects.toMatchObject({
        code: 'unauthorized',
      });
      await expect(
        callAgentViewSupervisor(socketPath, 'status', undefined, {
          authToken: 'wrong-token',
        }),
      ).rejects.toMatchObject({
        code: 'unauthorized',
      });
      await expect(
        callAgentViewSupervisor(socketPath, 'status', undefined, {
          authToken: 'secret-token',
        }),
      ).resolves.toEqual({ state: 'ok' });
    } finally {
      await server.close();
    }
  });

  it('rejects worker sideband operations when no authorizer is registered', async () => {
    const { dir, socketPath } = await makeSocketPath();
    cleanupPaths.push(dir);
    const handler = {
      status: vi.fn(() => ({})),
      list: vi.fn(() => []),
      shutdown: vi.fn(() => ({})),
      workerEvent: vi.fn(() => ({ received: true })),
    };
    const server = createAgentViewSupervisorServer(handler, {
      socketPath,
      authToken: 'secret-token',
    });

    await server.listen();
    try {
      // Sideband ops carry prompt text and approval outcomes, so they fail
      // closed until a per-session token validator is registered.
      await expect(
        callAgentViewSupervisor(socketPath, 'workerEvent', {
          type: 'heartbeat',
          sessionId: 'session-1',
        }),
      ).rejects.toMatchObject({ code: 'unauthorized' });
      expect(handler.workerEvent).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('delegates worker sideband authorization to the registered validator', async () => {
    const { dir, socketPath } = await makeSocketPath();
    cleanupPaths.push(dir);
    const handler = {
      status: vi.fn(() => ({})),
      list: vi.fn(() => []),
      shutdown: vi.fn(() => ({})),
      workerEvent: vi.fn(() => ({ received: true })),
    };
    const server = createAgentViewSupervisorServer(handler, {
      socketPath,
      authToken: 'secret-token',
      authorizeSideband: (_op, params) => params?.['token'] === 'session-token',
    });

    await server.listen();
    try {
      await expect(
        callAgentViewSupervisor(socketPath, 'workerEvent', {
          type: 'heartbeat',
          sessionId: 'session-1',
          token: 'wrong-token',
        }),
      ).rejects.toMatchObject({ code: 'unauthorized' });
      expect(handler.workerEvent).not.toHaveBeenCalled();

      await expect(
        callAgentViewSupervisor(socketPath, 'workerEvent', {
          type: 'heartbeat',
          sessionId: 'session-1',
          token: 'session-token',
        }),
      ).resolves.toEqual({ received: true });
      expect(handler.workerEvent).toHaveBeenCalledWith({
        type: 'heartbeat',
        sessionId: 'session-1',
        token: 'session-token',
      });
    } finally {
      await server.close();
    }
  });

  it('returns not_implemented for dispatch without a handler', async () => {
    const { dir, socketPath } = await makeSocketPath();
    cleanupPaths.push(dir);
    const server = createAgentViewSupervisorServer(
      {
        status: () => ({}),
        list: () => [],
        shutdown: () => ({}),
      },
      { socketPath },
    );

    await server.listen();
    try {
      await expect(
        requestAgentViewSupervisor(socketPath, {
          id: 'dispatch-request',
          op: 'dispatch',
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'not_implemented' },
      });
    } finally {
      await server.close();
    }
  });

  it('returns internal_error when a request handler throws', async () => {
    const { dir, socketPath } = await makeSocketPath();
    cleanupPaths.push(dir);
    const server = createAgentViewSupervisorServer(
      {
        status: () => {
          throw new Error('status failed');
        },
        list: () => [],
        shutdown: () => ({}),
      },
      { socketPath },
    );

    await server.listen();
    try {
      await expect(
        requestAgentViewSupervisor(socketPath, {
          id: 'status-request',
          op: 'status',
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'internal_error' },
      });
    } finally {
      await server.close();
    }
  });

  it('returns internal_error when a handler result is not serializable', async () => {
    const { dir, socketPath } = await makeSocketPath();
    cleanupPaths.push(dir);
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const server = createAgentViewSupervisorServer(
      {
        status: () => circular,
        list: () => [],
        shutdown: () => ({}),
      },
      { socketPath },
    );

    await server.listen();
    try {
      await expect(
        requestAgentViewSupervisor(socketPath, {
          id: 'status-request',
          op: 'status',
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'internal_error' },
      });
    } finally {
      await server.close();
    }
  });

  it('returns internal_error when a streaming handler throws', async () => {
    const { dir, socketPath } = await makeSocketPath();
    cleanupPaths.push(dir);
    const server = createAgentViewSupervisorServer(
      {
        status: () => ({}),
        list: () => [],
        shutdown: () => ({}),
        attachStream: () => {
          throw new Error('attach failed');
        },
      },
      { socketPath },
    );

    await server.listen();
    try {
      const socket = net.createConnection(socketPath);
      socket.setEncoding('utf8');
      await new Promise<void>((resolve) => socket.once('connect', resolve));
      socket.write(
        `${JSON.stringify({
          id: 'attach-request',
          op: 'attachStream',
          params: { sessionId: 'session-1' },
        })}\n`,
      );

      const line = await readLine(socket);
      expect(JSON.parse(line)).toMatchObject({
        ok: false,
        error: { code: 'internal_error' },
      });
      socket.destroy();
    } finally {
      await server.close();
    }
  });

  it('rejects incompatible protocol versions', async () => {
    const { dir, socketPath } = await makeSocketPath();
    cleanupPaths.push(dir);
    const handler = {
      status: vi.fn(() => ({ state: 'ok' })),
      list: vi.fn(() => []),
      shutdown: vi.fn(() => ({})),
    };
    const server = createAgentViewSupervisorServer(handler, { socketPath });

    await server.listen();
    try {
      await expect(
        requestAgentViewSupervisor(socketPath, {
          id: 'bad-protocol',
          protocolVersion: 999,
          op: 'status',
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'incompatible_protocol' },
      });
      expect(handler.status).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('rejects incompatible protocol versions on streaming ops', async () => {
    const { dir, socketPath } = await makeSocketPath();
    cleanupPaths.push(dir);
    const handler = {
      status: vi.fn(() => ({})),
      list: vi.fn(() => []),
      shutdown: vi.fn(() => ({})),
      subscribe: vi.fn(),
    };
    const server = createAgentViewSupervisorServer(handler, { socketPath });

    await server.listen();
    try {
      const socket = net.createConnection(socketPath);
      socket.setEncoding('utf8');
      await new Promise<void>((resolve) => socket.once('connect', resolve));
      socket.write(
        `${JSON.stringify({
          id: 'bad-protocol-stream',
          protocolVersion: 999,
          op: 'subscribe',
        })}\n`,
      );

      const line = await readLine(socket);
      expect(JSON.parse(line)).toMatchObject({
        ok: false,
        error: { code: 'incompatible_protocol' },
      });
      expect(handler.subscribe).not.toHaveBeenCalled();
      socket.destroy();
    } finally {
      await server.close();
    }
  });

  it('serves peek requests through the JSON IPC client', async () => {
    const { dir, socketPath } = await makeSocketPath();
    cleanupPaths.push(dir);
    const handler = {
      status: vi.fn(() => ({})),
      list: vi.fn(() => []),
      shutdown: vi.fn(() => ({})),
      peek: vi.fn(() => ({ sessionId: 'session-1', live: true })),
    };
    const server = createAgentViewSupervisorServer(handler, { socketPath });

    await server.listen();
    try {
      await expect(
        callAgentViewSupervisor(socketPath, 'peek', {
          sessionId: 'session-1',
        }),
      ).resolves.toEqual({ sessionId: 'session-1', live: true });
      expect(handler.peek).toHaveBeenCalledWith({ sessionId: 'session-1' });
    } finally {
      await server.close();
    }
  });

  it('serves internal pin and rename requests through the JSON IPC client', async () => {
    const { dir, socketPath } = await makeSocketPath();
    cleanupPaths.push(dir);
    const handler = {
      status: vi.fn(() => ({})),
      list: vi.fn(() => []),
      shutdown: vi.fn(() => ({})),
      pin: vi.fn(() => ({ sessionId: 'session-1', pinned: true })),
      rename: vi.fn(() => ({
        sessionId: 'session-1',
        displayName: 'Build Fix',
      })),
    };
    const server = createAgentViewSupervisorServer(handler, { socketPath });

    await server.listen();
    try {
      await expect(
        callAgentViewSupervisor(socketPath, 'pin', {
          sessionId: 'session-1',
          pinned: true,
        }),
      ).resolves.toEqual({ sessionId: 'session-1', pinned: true });
      expect(handler.pin).toHaveBeenCalledWith({
        sessionId: 'session-1',
        pinned: true,
      });

      await expect(
        callAgentViewSupervisor(socketPath, 'rename', {
          sessionId: 'session-1',
          displayName: 'Build Fix',
        }),
      ).resolves.toEqual({
        sessionId: 'session-1',
        displayName: 'Build Fix',
      });
      expect(handler.rename).toHaveBeenCalledWith({
        sessionId: 'session-1',
        displayName: 'Build Fix',
      });
    } finally {
      await server.close();
    }
  });

  it('serves send and answer requests through the JSON IPC client', async () => {
    const { dir, socketPath } = await makeSocketPath();
    cleanupPaths.push(dir);
    const handler = {
      status: vi.fn(() => ({})),
      list: vi.fn(() => []),
      shutdown: vi.fn(() => ({})),
      send: vi.fn(() => ({ sent: true })),
      answer: vi.fn(() => ({ answered: true })),
    };
    const server = createAgentViewSupervisorServer(handler, { socketPath });

    await server.listen();
    try {
      await expect(
        callAgentViewSupervisor(socketPath, 'send', {
          sessionId: 'session-1',
          text: 'next',
        }),
      ).resolves.toEqual({ sent: true });
      expect(handler.send).toHaveBeenCalledWith({
        sessionId: 'session-1',
        text: 'next',
      });

      await expect(
        callAgentViewSupervisor(socketPath, 'answer', {
          sessionId: 'session-1',
          text: 'yes',
        }),
      ).resolves.toEqual({ answered: true });
      expect(handler.answer).toHaveBeenCalledWith({
        sessionId: 'session-1',
        text: 'yes',
      });
    } finally {
      await server.close();
    }
  });

  it('keeps subscribe sockets open and forwards changed events', async () => {
    const { dir, socketPath } = await makeSocketPath();
    cleanupPaths.push(dir);
    const subscribers = new Set<import('node:net').Socket>();
    const handler = {
      status: vi.fn(() => ({})),
      list: vi.fn(() => []),
      shutdown: vi.fn(() => ({})),
      subscribe: vi.fn((_params, socket: import('node:net').Socket) => {
        socket.write(
          `${JSON.stringify({
            id: 'subscribe-request',
            ok: true,
            result: { subscribed: true },
          })}\n`,
        );
        subscribers.add(socket);
      }),
    };
    const server = createAgentViewSupervisorServer(handler, { socketPath });
    await server.listen();
    try {
      const events: unknown[] = [];
      const subscription = subscribeAgentViewSupervisor(socketPath, (event) => {
        events.push(event);
      });
      await waitFor(() => subscribers.size === 1);
      for (const socket of subscribers) {
        socket.write('not-json\n');
        socket.write(`${JSON.stringify({ type: 'changed', at: 'now' })}\n`);
      }
      await waitFor(() => events.length === 1);
      expect(events).toEqual([{ type: 'changed', at: 'now' }]);
      subscription.dispose();
    } finally {
      await server.close();
    }
  });

  it('reports rejected subscribe handshakes to the caller', async () => {
    const { dir, socketPath } = await makeSocketPath();
    cleanupPaths.push(dir);
    const handler = {
      status: vi.fn(() => ({})),
      list: vi.fn(() => []),
      shutdown: vi.fn(() => ({})),
      subscribe: vi.fn(),
    };
    const server = createAgentViewSupervisorServer(handler, {
      socketPath,
      authToken: 'secret-token',
    });
    await server.listen();
    try {
      const errors: unknown[] = [];
      const subscription = subscribeAgentViewSupervisor(socketPath, () => {}, {
        onError: (error) => errors.push(error),
      });

      await waitFor(() => errors.length === 1);
      expect(errors[0]).toMatchObject({ code: 'unauthorized' });
      expect(handler.subscribe).not.toHaveBeenCalled();
      subscription.dispose();
    } finally {
      await server.close();
    }
  });

  it('keeps reading subscription events when a callback throws', async () => {
    const { dir, socketPath } = await makeSocketPath();
    cleanupPaths.push(dir);
    const subscribers = new Set<import('node:net').Socket>();
    const handler = {
      status: vi.fn(() => ({})),
      list: vi.fn(() => []),
      shutdown: vi.fn(() => ({})),
      subscribe: vi.fn((_params, socket: import('node:net').Socket) => {
        socket.write(
          `${JSON.stringify({
            id: 'subscribe-request',
            ok: true,
            result: { subscribed: true },
          })}\n`,
        );
        subscribers.add(socket);
      }),
    };
    const server = createAgentViewSupervisorServer(handler, { socketPath });
    await server.listen();
    try {
      const onEvent = vi.fn(() => {
        throw new Error('subscriber failed');
      });
      const subscription = subscribeAgentViewSupervisor(socketPath, onEvent);
      await waitFor(() => subscribers.size === 1);

      for (const socket of subscribers) {
        socket.write(`${JSON.stringify({ type: 'changed', at: 'one' })}\n`);
        socket.write(`${JSON.stringify({ type: 'changed', at: 'two' })}\n`);
      }

      await waitFor(() => onEvent.mock.calls.length === 2);
      subscription.dispose();
    } finally {
      await server.close();
    }
  });

  it('forwards attach bytes that arrive with the attachStream request', async () => {
    const { dir, socketPath } = await makeSocketPath();
    cleanupPaths.push(dir);
    let attachedBytes = '';
    const handler = {
      status: vi.fn(() => ({})),
      list: vi.fn(() => []),
      shutdown: vi.fn(() => ({})),
      attachStream: vi.fn(
        (_params, socket: import('node:net').Socket, requestId: string) => {
          socket.write(
            `${JSON.stringify({
              id: requestId,
              ok: true,
              result: { attached: true },
            })}\n`,
          );
          socket.on('data', (chunk) => {
            attachedBytes += String(chunk);
          });
          socket.resume();
        },
      ),
    };
    const server = createAgentViewSupervisorServer(handler, { socketPath });
    await server.listen();
    try {
      const socket = net.createConnection(socketPath);
      socket.setEncoding('utf8');
      await new Promise<void>((resolve) => socket.once('connect', resolve));
      socket.write(
        `${JSON.stringify({
          id: 'attach-request',
          op: 'attachStream',
          params: { sessionId: 'session-1' },
        })}\nhello`,
      );
      await waitFor(() => attachedBytes === 'hello');
      socket.destroy();
    } finally {
      await server.close();
    }
  });

  it('preserves coalesced attach bytes for an async streaming handler', async () => {
    const { dir, socketPath } = await makeSocketPath();
    cleanupPaths.push(dir);
    let attachedBytes = '';
    const handler = {
      status: vi.fn(() => ({})),
      list: vi.fn(() => []),
      shutdown: vi.fn(() => ({})),
      attachStream: vi.fn(
        async (
          _params,
          socket: import('node:net').Socket,
          requestId: string,
        ) => {
          socket.write(
            `${JSON.stringify({
              id: requestId,
              ok: true,
              result: { attached: true },
            })}\n`,
          );
          // A real attach handler awaits (read launch.json, reattach the PTY)
          // before it can listen; the socket must stay paused until then.
          await new Promise((resolve) => setTimeout(resolve, 20));
          socket.on('data', (chunk) => {
            attachedBytes += String(chunk);
          });
          socket.resume();
        },
      ),
    };
    const server = createAgentViewSupervisorServer(handler, { socketPath });
    await server.listen();
    try {
      const socket = net.createConnection(socketPath);
      socket.setEncoding('utf8');
      await new Promise<void>((resolve) => socket.once('connect', resolve));
      socket.write(
        `${JSON.stringify({
          id: 'attach-request',
          op: 'attachStream',
          params: { sessionId: 'session-1' },
        })}\nhello`,
      );
      await waitFor(() => attachedBytes === 'hello');
      socket.destroy();
    } finally {
      await server.close();
    }
  });

  it('binds class-based streaming handlers so subscribe succeeds', async () => {
    const { dir, socketPath } = await makeSocketPath();
    cleanupPaths.push(dir);
    const handler = createAgentViewSupervisorHandler({ globalDir: dir });
    const server = createAgentViewSupervisorServer(handler, { socketPath });
    await server.listen();
    try {
      const socket = net.createConnection(socketPath);
      socket.setEncoding('utf8');
      await new Promise<void>((resolve) => socket.once('connect', resolve));
      socket.write(
        `${JSON.stringify({ id: 'subscribe-request', op: 'subscribe' })}\n`,
      );
      const line = await new Promise<string>((resolve) => {
        let buffered = '';
        socket.on('data', (chunk) => {
          buffered += String(chunk);
          const newline = buffered.indexOf('\n');
          if (newline !== -1) resolve(buffered.slice(0, newline));
        });
      });
      // The shipped handler is a class whose subscribe() touches `this`; an
      // unbound invocation throws and answers internal_error instead.
      expect(JSON.parse(line)).toMatchObject({
        ok: true,
        result: { subscribed: true },
      });
      socket.destroy();
    } finally {
      await server.close();
    }
  });

  it('delivers attach stream bytes without utf8 transcoding', async () => {
    const { dir, socketPath } = await makeSocketPath();
    cleanupPaths.push(dir);
    const received: Buffer[] = [];
    const handler = {
      status: vi.fn(() => ({})),
      list: vi.fn(() => []),
      shutdown: vi.fn(() => ({})),
      attachStream: vi.fn(
        (_params, socket: import('node:net').Socket, requestId: string) => {
          socket.write(
            `${JSON.stringify({
              id: requestId,
              ok: true,
              result: { attached: true },
            })}\n`,
          );
          socket.on('data', (chunk) => {
            received.push(
              Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
            );
          });
          socket.resume();
        },
      ),
    };
    const server = createAgentViewSupervisorServer(handler, { socketPath });
    await server.listen();
    try {
      const socket = net.createConnection(socketPath);
      await new Promise<void>((resolve) => socket.once('connect', resolve));
      // 0x80 and 0xff are invalid UTF-8 lead bytes; a utf8-decoded stream
      // would replace each with U+FFFD (ef bf bd).
      const payload = Buffer.from([
        0x41, 0x42, 0xe4, 0xbd, 0xa0, 0x80, 0xff, 0x43,
      ]);
      const requestLine = Buffer.from(
        `${JSON.stringify({
          id: 'attach-request',
          op: 'attachStream',
          params: { sessionId: 'session-1' },
        })}\n`,
        'utf8',
      );
      socket.write(Buffer.concat([requestLine, payload]));
      await waitFor(
        () => Buffer.concat(received).byteLength >= payload.byteLength,
      );
      expect(Buffer.concat(received).subarray(0, payload.byteLength)).toEqual(
        payload,
      );
      socket.destroy();
    } finally {
      await server.close();
    }
  });

  it('closes active subscription sockets when the server closes', async () => {
    const { dir, socketPath } = await makeSocketPath();
    cleanupPaths.push(dir);
    const subscribers = new Set<import('node:net').Socket>();
    const handler = {
      status: vi.fn(() => ({})),
      list: vi.fn(() => []),
      shutdown: vi.fn(() => ({})),
      subscribe: vi.fn((_params, socket: import('node:net').Socket) => {
        subscribers.add(socket);
        socket.write(
          `${JSON.stringify({
            id: 'subscribe-request',
            ok: true,
            result: { subscribed: true },
          })}\n`,
        );
      }),
    };
    const server = createAgentViewSupervisorServer(handler, { socketPath });
    await server.listen();
    try {
      const subscription = subscribeAgentViewSupervisor(socketPath, () => {});
      await waitFor(() => subscribers.size === 1);

      await expect(server.close()).resolves.toBeUndefined();
      subscription.dispose();
    } finally {
      await server.close();
    }
  });

  it('creates local sockets with owner-only permissions', async () => {
    if (process.platform === 'win32') return;
    const { dir } = await makeSocketPath();
    cleanupPaths.push(dir);
    const nestedSocketPath = path.join(dir, 'nested', 'supervisor.sock');
    const server = createAgentViewSupervisorServer(
      {
        status: () => ({}),
        list: () => [],
        shutdown: () => ({}),
      },
      { socketPath: nestedSocketPath },
    );

    await server.listen();
    try {
      const [dirStat, socketStat] = await Promise.all([
        fs.stat(path.dirname(nestedSocketPath)),
        fs.stat(nestedSocketPath),
      ]);
      expect(dirStat.mode & 0o777).toBe(0o700);
      expect(socketStat.mode & 0o777).toBe(0o600);
    } finally {
      await server.close();
    }
  });

  it('destroys sockets that exceed the request line size limit', async () => {
    const { dir, socketPath } = await makeSocketPath();
    cleanupPaths.push(dir);
    const server = createAgentViewSupervisorServer(
      {
        status: () => ({}),
        list: () => [],
        shutdown: () => ({}),
      },
      { socketPath },
    );

    await server.listen();
    try {
      const socket = net.createConnection(socketPath);
      await new Promise<void>((resolve) => socket.once('connect', resolve));
      const closed = new Promise<void>((resolve) =>
        socket.once('close', resolve),
      );
      const oversized = Buffer.alloc(1024 * 1024 + 1, 0x41);
      socket.write(oversized);
      await closed;
    } finally {
      await server.close();
    }
  });

  it('cleans up the local socket path when closed', async () => {
    const { dir, socketPath } = await makeSocketPath();
    cleanupPaths.push(dir);
    const server = createAgentViewSupervisorServer(
      {
        status: () => ({}),
        list: () => [],
        shutdown: () => ({}),
      },
      { socketPath },
    );

    await server.listen();
    await server.close();

    if (process.platform !== 'win32') {
      await expect(fs.access(socketPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  });

  it('rejects with a timeout error when the server accepts but never responds', async () => {
    const { dir, socketPath } = await makeSocketPath();
    cleanupPaths.push(dir);
    const sockets: net.Socket[] = [];
    const silentServer = net.createServer((socket) => {
      sockets.push(socket);
    });
    await new Promise<void>((resolve) =>
      silentServer.listen(socketPath, resolve),
    );
    try {
      await expect(
        requestAgentViewSupervisor(
          socketPath,
          { id: 'timeout-test', op: 'status' },
          { timeoutMs: 50 },
        ),
      ).rejects.toMatchObject({ code: 'timeout' });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => silentServer.close(() => resolve()));
    }
  });

  it('times out a subscription handshake that never acks', async () => {
    const { dir, socketPath } = await makeSocketPath();
    cleanupPaths.push(dir);
    const sockets: net.Socket[] = [];
    const silentServer = net.createServer((socket) => {
      sockets.push(socket);
    });
    await new Promise<void>((resolve) =>
      silentServer.listen(socketPath, resolve),
    );
    try {
      const errors: Error[] = [];
      const subscription = subscribeAgentViewSupervisor(socketPath, () => {}, {
        timeoutMs: 50,
        onError: (error) => errors.push(error),
      });
      await waitFor(() => errors.length === 1);
      expect(errors[0]).toMatchObject({ code: 'timeout' });
      subscription.dispose();
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => silentServer.close(() => resolve()));
    }
  });

  it('flushes coalesced attach bytes to stdout before bridging', async () => {
    const { dir, socketPath } = await makeSocketPath();
    cleanupPaths.push(dir);
    const handler = {
      status: vi.fn(() => ({})),
      list: vi.fn(() => []),
      shutdown: vi.fn(() => ({})),
      attachStream: vi.fn(
        (_params, socket: import('node:net').Socket, requestId: string) => {
          // Handshake response and terminal bytes in a single packet: the
          // client must split the JSON line from the leftover terminal bytes
          // and flush them to stdout without dropping them.
          socket.write(
            `${JSON.stringify({
              id: requestId,
              ok: true,
              result: { attached: true },
            })}\nhello`,
          );
        },
      ),
    };
    const server = createAgentViewSupervisorServer(handler, { socketPath });
    await server.listen();
    try {
      const stdout = new MemoryWritable();
      await attachAgentViewSupervisorTerminal(socketPath, 'session-1', {
        stdin: emptyInput(),
        stdout,
        rawMode: false,
      });
      expect(stdout.text()).toContain('hello');
    } finally {
      await server.close();
    }
  });
});

async function makeSocketPath(): Promise<{ dir: string; socketPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-agent-view-'));
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\qwen-agent-view-test-${process.pid}-${Date.now()}`
      : path.join(dir, 'supervisor.sock');
  return { dir, socketPath };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for supervisor test condition.');
}

async function readLine(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for supervisor response line.'));
    }, 200);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onData = (chunk: Buffer | string) => {
      buffered += String(chunk);
      const newline = buffered.indexOf('\n');
      if (newline === -1) return;
      cleanup();
      resolve(buffered.slice(0, newline));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Socket closed before a supervisor response line.'));
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

class MemoryWritable extends Writable {
  private readonly chunks: Buffer[] = [];

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

async function* emptyInput(): AsyncGenerator<Buffer> {
  // Ends immediately so the bridge returns once the leftover bytes flush.
}
