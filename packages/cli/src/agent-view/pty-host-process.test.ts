/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAgentViewPtyHostServer,
  connectAgentViewPtyHostProcess,
  getAgentViewPtyHostSocketPath,
  launchAgentViewPtyHostProcess,
} from './pty-host-process.js';
import { BoundedOutputRing, type AgentViewPtyHostHandle } from './pty-host.js';

describe('Agent View PTY host process server', () => {
  const servers: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it('bridges an attach stream to the PTY handle', async () => {
    const host = fakeHost();
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(host, socketPath);
    servers.push(server);
    await server.listen();

    const socket = net.createConnection(socketPath);
    socket.write(`${JSON.stringify({ id: '1', op: 'attachStream' })}\n`);
    await expect(readLine(socket)).resolves.toMatchObject({
      id: '1',
      ok: true,
    });

    socket.write('hello');
    await waitFor(() => host.input === 'hello');

    host.emitData('world');
    await expect(readChunk(socket)).resolves.toBe('world');

    socket.destroy();
  });

  it('rejects a second attach stream while one is active', async () => {
    const host = fakeHost();
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(host, socketPath);
    servers.push(server);
    await server.listen();

    const firstSocket = net.createConnection(socketPath);
    firstSocket.write(`${JSON.stringify({ id: '1', op: 'attachStream' })}\n`);
    await expect(readLine(firstSocket)).resolves.toMatchObject({
      id: '1',
      ok: true,
    });

    const secondSocket = net.createConnection(socketPath);
    secondSocket.write(`${JSON.stringify({ id: '2', op: 'attachStream' })}\n`);
    await expect(readLine(secondSocket)).resolves.toMatchObject({
      id: '2',
      ok: false,
      error: { code: 'already_attached' },
    });

    firstSocket.destroy();
    secondSocket.destroy();
  });

  it('handles resize, logs, and kill requests', async () => {
    const host = fakeHost();
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(host, socketPath);
    servers.push(server);
    await server.listen();

    host.emitData('0123456789');
    await expect(
      requestHost(socketPath, 'resize', { columns: 120, rows: 40 }),
    ).resolves.toMatchObject({ resized: true });
    await expect(requestHost(socketPath, 'logs')).resolves.toEqual({
      output: '56789',
    });
    await expect(
      requestHost(socketPath, 'kill', { signal: 'SIGTERM' }),
    ).resolves.toMatchObject({ killed: true });

    expect(host.resizes).toEqual([{ columns: 120, rows: 40 }]);
    expect(host.killedWith).toBe('SIGTERM');
  });

  it('rejects unsupported kill signals', async () => {
    const host = fakeHost();
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(host, socketPath);
    servers.push(server);
    await server.listen();

    await expect(
      requestHost(socketPath, 'kill', { signal: 'SIGUSR1' }),
    ).rejects.toThrow('Agent View PTY host signal is not allowed.');

    expect(host.killedWith).toBeUndefined();
  });

  it('requires auth when the host server has a token', async () => {
    const host = fakeHost();
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(host, socketPath, {
      authToken: 'secret',
    });
    servers.push(server);
    await server.listen();

    await expect(requestHost(socketPath, 'status')).rejects.toThrow(
      'Unauthorized PTY host request.',
    );
    await expect(
      requestHost(socketPath, 'status', undefined, 'secret'),
    ).resolves.toMatchObject({
      workerPid: 1234,
    });
  });

  it('closes requests with oversized lines', async () => {
    const host = fakeHost();
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(host, socketPath);
    servers.push(server);
    await server.listen();

    const socket = net.createConnection(socketPath);
    socket.write('x'.repeat(1024 * 1024 + 1));

    await expect(waitForClose(socket)).resolves.toBeUndefined();
  });

  it('restricts Unix socket and parent directory permissions', async () => {
    const socketDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pty-host-'),
    );
    const socketPath = path.join(socketDir, 'nested', 'pty-host.sock');
    const server = createAgentViewPtyHostServer(fakeHost(), socketPath);
    servers.push(server);

    await server.listen();

    const [dirStat, socketStat] = await Promise.all([
      fs.stat(path.dirname(socketPath)),
      fs.stat(socketPath),
    ]);
    expect(dirStat.mode & 0o777).toBe(0o700);
    expect(socketStat.mode & 0o777).toBe(0o600);

    await fs.rm(socketDir, { recursive: true, force: true });
  });

  it('handles shutdown requests', async () => {
    const host = fakeHost();
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(host, socketPath);
    servers.push(server);
    await server.listen();

    await expect(requestHost(socketPath, 'shutdown')).resolves.toEqual({
      shuttingDown: true,
    });

    expect(host.shutdowns).toBe(1);
  });

  it('resolves connected host exit when the remote host is shut down', async () => {
    const host = fakeHost();
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(host, socketPath);
    servers.push(server);
    await server.listen();

    const connected = await connectAgentViewPtyHostProcess(
      createLaunch('session-1'),
      socketPath,
    );

    connected.shutdown?.();

    await expect(connected.exited).resolves.toEqual({ exitCode: 0 });
  });

  it('computes Unix and Windows host socket paths', () => {
    expect(
      getAgentViewPtyHostSocketPath('session-1', {
        globalDir: '/tmp/qwen-agent-view-test',
        platform: 'linux',
      }),
    ).toBe('/tmp/qwen-agent-view-test/jobs/session-1/tmp/pty-host.sock');
    expect(
      getAgentViewPtyHostSocketPath('session-1', {
        globalDir: 'C:\\Users\\test\\.qwen',
        platform: 'win32',
      }),
    ).toMatch(/^\\\\\.\\pipe\\qwen-agent-pty-[a-f0-9]{16}$/);
  });

  it('fails quickly when the spawned PTY host exits before ready', async () => {
    const child = fakeChildProcess(2468);
    const launched = launchAgentViewPtyHostProcess(
      {
        schemaVersion: 1,
        sessionId: 'session-early-exit',
        argv: ['qwen'],
        env: {},
        entrypoint: 'qwen',
        projectCwd: '/workspace/project',
        activeCwd: '/workspace/project',
        includeDirectories: [],
        terminal: { columns: 80, rows: 24 },
      },
      {
        globalDir: '/tmp/qwen-agent-view-test',
        spawnProcess: () => child,
      },
    );
    child.emit('exit', 1, null);

    await expect(launched).rejects.toThrow(
      'Agent View PTY host exited before ready (code 1).',
    );
  });
});

function fakeChildProcess(pid: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperty(child, 'pid', { value: pid });
  child.unref = () => child;
  return child;
}

function fakeHost(): AgentViewPtyHostHandle & {
  input: string;
  resizes: Array<{ columns: number; rows: number }>;
  killedWith?: string;
  shutdowns: number;
  emitData(data: string): void;
} {
  let dataCallbacks: Array<(data: string) => void> = [];
  const host: AgentViewPtyHostHandle & {
    input: string;
    resizes: Array<{ columns: number; rows: number }>;
    killedWith?: string;
    shutdowns: number;
    emitData(data: string): void;
  } = {
    pid: process.pid,
    workerPid: 1234,
    command: ['fake'],
    output: new BoundedOutputRing(5),
    input: '',
    resizes: [],
    shutdowns: 0,
    exited: new Promise<{ exitCode: number }>(() => {}),
    write(data: Buffer) {
      host.input += data.toString('utf8');
    },
    onData(callback: (data: string) => void) {
      dataCallbacks.push(callback);
      return {
        dispose() {
          dataCallbacks = dataCallbacks.filter((item) => item !== callback);
        },
      };
    },
    resize(size: { columns: number; rows: number }) {
      host.resizes.push(size);
    },
    kill(signal?: string) {
      host.killedWith = signal;
    },
    shutdown() {
      host.shutdowns += 1;
    },
    dispose() {},
    emitData(data: string) {
      host.output.append(data);
      for (const callback of dataCallbacks) {
        callback(data);
      }
    },
  };
  return host;
}

function shortSocketPath(): string {
  return path.join('/tmp', `qah-${process.pid}-${Date.now()}.sock`);
}

function createLaunch(
  sessionId: string,
): Parameters<typeof connectAgentViewPtyHostProcess>[0] {
  return {
    schemaVersion: 1,
    sessionId,
    argv: ['qwen'],
    env: {},
    entrypoint: 'qwen',
    projectCwd: '/workspace/project',
    activeCwd: '/workspace/project',
    includeDirectories: [],
    terminal: { columns: 80, rows: 24 },
  };
}

async function requestHost(
  socketPath: string,
  op: string,
  params?: Record<string, unknown>,
  authToken?: string,
): Promise<unknown> {
  const socket = net.createConnection(socketPath);
  socket.write(`${JSON.stringify({ id: '1', op, params, authToken })}\n`);
  const response = await readLine(socket);
  socket.end();
  if (response['ok'] !== true) {
    const error = response['error'];
    const message =
      isRecord(error) && typeof error['message'] === 'string'
        ? error['message']
        : 'Agent View PTY host request failed.';
    throw new Error(message);
  }
  return response['result'];
}

async function waitForClose(socket: net.Socket): Promise<void> {
  await new Promise<void>((resolve) => {
    socket.once('close', () => resolve());
    socket.once('error', () => resolve());
  });
}

async function readLine(socket: net.Socket): Promise<Record<string, unknown>> {
  const chunk = await readChunk(socket);
  return JSON.parse(chunk.slice(0, chunk.indexOf('\n'))) as Record<
    string,
    unknown
  >;
}

async function readChunk(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once('data', (chunk) => resolve(chunk.toString('utf8')));
    socket.once('error', reject);
  });
}

async function waitFor(assertion: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index++) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
