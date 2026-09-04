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
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAgentViewPtyHostServer,
  connectAgentViewPtyHostProcess,
  getAgentViewPtyHostSocketPath,
  INTERNAL_AGENT_VIEW_PTY_HOST_ARG,
  launchAgentViewPtyHostProcess,
  runAgentViewPtyHostProcess,
} from './pty-host-process.js';
import { PTY_HOST_AUTH_TOKEN_ENV, PTY_HOST_ID_ENV } from './pty-host-env.js';
import {
  BoundedOutputRing,
  type AgentViewPtyHostExit,
  type AgentViewPtyHostHandle,
} from './pty-host.js';
import { getAgentViewSessionPaths } from './supervisor-store.js';

const socketDirs = new Set<string>();

describe('Agent View PTY host process server', () => {
  const servers: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(
      [...socketDirs].map((dir) =>
        isWindowsPipePath(dir)
          ? Promise.resolve()
          : fs.rm(dir, { recursive: true, force: true }),
      ),
    );
    socketDirs.clear();
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

  it('forwards input coalesced with the attach request', async () => {
    const host = fakeHost();
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(host, socketPath);
    servers.push(server);
    await server.listen();

    const socket = net.createConnection(socketPath);
    socket.write(`${JSON.stringify({ id: '1', op: 'attachStream' })}\nhello`);
    await expect(readLine(socket)).resolves.toMatchObject({
      id: '1',
      ok: true,
    });

    await waitFor(() => host.input === 'hello');
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

  it('closes while an attach stream is active', async () => {
    const host = fakeHost();
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(host, socketPath);
    await server.listen();

    const socket = net.createConnection(socketPath);
    socket.write(`${JSON.stringify({ id: '1', op: 'attachStream' })}\n`);
    await expect(readLine(socket)).resolves.toMatchObject({
      id: '1',
      ok: true,
    });

    await expect(server.close()).resolves.toBeUndefined();
    await expect(waitForClose(socket)).resolves.toBeUndefined();
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

  it('forwards attach input bytes without UTF-8 re-encoding', async () => {
    const host = fakeHost();
    const rawWrites: Buffer[] = [];
    host.write = (data: Buffer) => {
      rawWrites.push(Buffer.from(data));
    };
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(host, socketPath);
    servers.push(server);
    await server.listen();

    const socket = net.createConnection(socketPath);
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    const request = Buffer.from(
      `${JSON.stringify({ id: 'attach-1', op: 'attachStream' })}\n`,
      'utf8',
    );
    // Latin-1 'e-acute' + 'A': invalid UTF-8 that a transparent
    // transport must deliver verbatim.
    const keystrokes = Buffer.from([0xe9, 0x41]);
    socket.write(Buffer.concat([request, keystrokes]));
    await waitFor(() => rawWrites.length > 0);
    socket.write(Buffer.from([0xff, 0x00]));
    await waitFor(() => Buffer.concat(rawWrites).length === 4);

    expect([...Buffer.concat(rawWrites)]).toEqual([0xe9, 0x41, 0xff, 0x00]);

    socket.destroy();
  });

  it.skipIf(process.platform === 'win32')(
    'reclaims a stale socket lock left by a dead process',
    async () => {
      const host = fakeHost();
      const socketPath = shortSocketPath();
      await fs.mkdir(path.dirname(socketPath), { recursive: true });
      await fs.writeFile(`${socketPath}.lock`, '2147483647');
      const server = createAgentViewPtyHostServer(host, socketPath);
      servers.push(server);

      await expect(server.listen()).resolves.toBeUndefined();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'releases the socket lock on close so the path can be reused',
    async () => {
      const host = fakeHost();
      const socketPath = shortSocketPath();
      const first = createAgentViewPtyHostServer(host, socketPath);
      await first.listen();
      const second = createAgentViewPtyHostServer(fakeHost(), socketPath);
      servers.push(second);

      await expect(second.listen()).rejects.toThrow('already in use');
      await first.close();
      await expect(second.listen()).resolves.toBeUndefined();
    },
  );

  it('rejects non-positive or non-integer resize dimensions', async () => {
    const host = fakeHost();
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(host, socketPath);
    servers.push(server);
    await server.listen();

    await expect(
      requestHost(socketPath, 'resize', { columns: 0, rows: 40 }),
    ).rejects.toThrow('columns must be a positive integer');
    await expect(
      requestHost(socketPath, 'resize', { columns: 120, rows: 2.5 }),
    ).rejects.toThrow('rows must be a positive integer');

    expect(host.resizes).toEqual([]);
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

  it('escalates a TERM-resistant worker to SIGKILL after the grace period', async () => {
    const host = fakeHost();
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(host, socketPath, {
      shutdownGraceMs: 20,
    });
    servers.push(server);
    await server.listen();

    await expect(requestHost(socketPath, 'shutdown')).resolves.toEqual({
      shuttingDown: true,
    });
    expect(host.shutdowns).toBe(1);

    await waitFor(() => host.killedWith === 'SIGKILL');
  });

  it('does not escalate when the worker exits within the grace period', async () => {
    const host = fakeHost();
    let resolveExited: (exit: AgentViewPtyHostExit) => void = () => {};
    host.exited = new Promise<AgentViewPtyHostExit>((resolve) => {
      resolveExited = resolve;
    });
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(host, socketPath, {
      shutdownGraceMs: 20,
    });
    servers.push(server);
    await server.listen();

    await expect(requestHost(socketPath, 'shutdown')).resolves.toEqual({
      shuttingDown: true,
    });
    resolveExited({ kind: 'exited', exitCode: 0 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(host.killedWith).toBeUndefined();
  });

  it('falls back to kill(SIGTERM) when the host has no shutdown method', async () => {
    const host = fakeHost();
    delete (host as Partial<typeof host>).shutdown;
    host.exited = Promise.resolve({ kind: 'exited', exitCode: 0 });
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(host, socketPath, {
      shutdownGraceMs: 20,
    });
    servers.push(server);
    await server.listen();

    await expect(requestHost(socketPath, 'shutdown')).resolves.toEqual({
      shuttingDown: true,
    });

    expect(host.killedWith).toBe('SIGTERM');
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

  it('wires the env host token into the entrypoint server', async () => {
    const launchDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pty-entrypoint-'),
    );
    socketDirs.add(launchDir);
    const launchPath = path.join(launchDir, 'launch.json');
    await fs.writeFile(
      launchPath,
      JSON.stringify({
        schemaVersion: 1,
        sessionId: 'session-entry',
        argv: ['qwen', '--agent-view-worker'],
        env: { QWEN_AGENT_VIEW_WORKER: '1' },
        entrypoint: 'qwen',
        projectCwd: '/repo',
        activeCwd: '/repo',
        includeDirectories: [],
        terminal: { columns: 80, rows: 24 },
      }),
    );
    let exitCallback: ((event: { exitCode: number }) => void) | undefined;
    const socketPath = shortSocketPath();
    // The token travels via the host env, mirroring the spawn contract.
    const previousToken = process.env[PTY_HOST_AUTH_TOKEN_ENV];
    process.env[PTY_HOST_AUTH_TOKEN_ENV] = 'entry-token';
    try {
      const runPromise = runAgentViewPtyHostProcess({
        launchPath,
        socketPath,
        loadPty: async () => ({
          name: 'injected',
          module: {
            spawn: () => ({
              pid: 4321,
              write: () => {},
              onData: () => ({ dispose: () => {} }),
              onExit: (callback: (event: { exitCode: number }) => void) => {
                exitCallback = callback;
                return { dispose: () => {} };
              },
              resize: () => {},
              kill: () => {},
            }),
          },
        }),
      });
      try {
        let status: unknown;
        for (let attempt = 0; attempt < 50 && status === undefined; attempt++) {
          try {
            status = await requestHost(
              socketPath,
              'status',
              undefined,
              'entry-token',
            );
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }

        expect(status).toEqual({ pid: process.pid, workerPid: 4321 });
        await expect(requestHost(socketPath, 'status')).rejects.toThrow(
          'Unauthorized PTY host request.',
        );
      } finally {
        exitCallback?.({ exitCode: 0 });
        await runPromise;
      }
    } finally {
      if (previousToken === undefined) {
        delete process.env[PTY_HOST_AUTH_TOKEN_ENV];
      } else {
        process.env[PTY_HOST_AUTH_TOKEN_ENV] = previousToken;
      }
    }
  });

  it('requires auth for attach streams', async () => {
    const host = fakeHost();
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(host, socketPath, {
      authToken: 'secret',
    });
    servers.push(server);
    await server.listen();

    const rejectedSocket = net.createConnection(socketPath);
    rejectedSocket.write(
      `${JSON.stringify({ id: '1', op: 'attachStream' })}\n`,
    );
    await expect(readLine(rejectedSocket)).resolves.toMatchObject({
      id: '1',
      ok: false,
      error: { code: 'unauthorized' },
    });

    const acceptedSocket = net.createConnection(socketPath);
    acceptedSocket.write(
      `${JSON.stringify({
        id: '2',
        op: 'attachStream',
        authToken: 'secret',
      })}\nhello`,
    );
    await expect(readLine(acceptedSocket)).resolves.toMatchObject({
      id: '2',
      ok: true,
    });
    await waitFor(() => host.input === 'hello');

    rejectedSocket.destroy();
    acceptedSocket.destroy();
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

  it('closes while a silent request socket is open', async () => {
    const host = fakeHost();
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(host, socketPath);
    await server.listen();

    const socket = net.createConnection(socketPath);
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    const closed = waitForClose(socket);

    await expect(server.close()).resolves.toBeUndefined();
    await expect(closed).resolves.toBeUndefined();
  });

  it('returns logs near the output retention cap', async () => {
    const host = fakeHost(1024 * 1024);
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(host, socketPath);
    servers.push(server);
    await server.listen();

    host.emitData('x'.repeat(1024 * 1024));

    await expect(requestHost(socketPath, 'logs')).resolves.toEqual({
      output: 'x'.repeat(1024 * 1024),
    });
  });

  it('returns escape-heavy logs near the output retention cap', async () => {
    const host = fakeHost(1024 * 1024);
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(host, socketPath);
    servers.push(server);
    await server.listen();

    const output = '\x1b[0m'.repeat(256 * 1024);
    host.emitData(output);

    await expect(requestHost(socketPath, 'logs')).resolves.toEqual({
      output,
    });
  });

  it('returns control-byte-heavy logs through the connected handle', async () => {
    const host = fakeHost(1024 * 1024);
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(host, socketPath);
    servers.push(server);
    await server.listen();

    const output = '\x01'.repeat(1024 * 1024);
    host.emitData(output);

    const connected = await connectAgentViewPtyHostProcess(
      createLaunch('session-control-byte-logs'),
      socketPath,
      undefined,
      process.env['RUNNER_NAME']?.startsWith('ecs-qwen-')
        ? { requestTimeoutMs: 60_000 }
        : {},
    );

    await expect(connected.getOutput?.()).resolves.toBe(output);
  });

  it.skipIf(process.platform === 'win32')(
    'restricts Unix socket and parent directory permissions',
    async () => {
      const socketPath = shortSocketPath();
      const server = createAgentViewPtyHostServer(fakeHost(), socketPath);
      servers.push(server);

      await server.listen();

      const [dirStat, socketStat] = await Promise.all([
        fs.stat(path.dirname(socketPath)),
        fs.stat(socketPath),
      ]);
      expect(dirStat.mode & 0o777).toBe(0o700);
      expect(socketStat.mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects listening on a socket path owned by a live server',
    async () => {
      const socketPath = shortSocketPath();
      const first = createAgentViewPtyHostServer(fakeHost(), socketPath);
      servers.push(first);
      await first.listen();

      const second = createAgentViewPtyHostServer(fakeHost(), socketPath);

      await expect(second.listen()).rejects.toThrow('already in use');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'replaces a stale socket file when listening',
    async () => {
      const socketPath = shortSocketPath();
      await fs.mkdir(path.dirname(socketPath), { recursive: true });
      await fs.writeFile(socketPath, '');
      const server = createAgentViewPtyHostServer(fakeHost(), socketPath);
      servers.push(server);

      await expect(server.listen()).resolves.toBeUndefined();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not unlink a socket path taken over by another live server',
    async () => {
      const socketPath = shortSocketPath();
      const replacement = net.createServer((socket) => {
        socket.on('error', () => {});
      });
      await listenServer(replacement, socketPath);
      try {
        const displaced = createAgentViewPtyHostServer(fakeHost(), socketPath);

        await displaced.close();

        await expect(fs.stat(socketPath)).resolves.toBeDefined();
        await expect(connectOnce(socketPath)).resolves.toBe(true);
      } finally {
        replacement.close();
        await removeTestSocket(socketPath);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a symlinked socket parent directory',
    async () => {
      const realDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qah-real-'));
      const linkDir = path.join(
        os.tmpdir(),
        `qah-link-${process.pid}-${Date.now()}`,
      );
      await fs.symlink(realDir, linkDir);
      const socketPath = path.join(linkDir, 'pty.sock');
      const server = createAgentViewPtyHostServer(fakeHost(), socketPath);
      try {
        await expect(server.listen()).rejects.toThrow('must not be a symlink');
      } finally {
        await fs.rm(linkDir, { force: true });
        await fs.rm(realDir, { recursive: true, force: true });
      }
    },
  );

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

  it('delivers a connected host shutdown without forging its exit', async () => {
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

    await waitFor(() => host.shutdowns === 1);
    // The RPC only starts the drain. Retirement is confirmed after the
    // endpoint disappears, so a replacement cannot race socket teardown.
    await expect(
      Promise.race([
        connected.exited.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 100),
        ),
      ]),
    ).resolves.toBe(false);

    servers.splice(servers.indexOf(server), 1);
    await server.close();
    await expect(connected.exited).resolves.toEqual({
      kind: 'confirmed-shutdown',
    });
  });

  it('waits for the remote endpoint to close after SIGKILL', async () => {
    const host = fakeHost();
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(host, socketPath);
    servers.push(server);
    await server.listen();

    const connected = await connectAgentViewPtyHostProcess(
      createLaunch('session-1'),
      socketPath,
    );

    connected.kill('SIGKILL');

    await waitFor(() => host.killedWith === 'SIGKILL');
    servers.splice(servers.indexOf(server), 1);
    await server.close();
    await expect(connected.exited).resolves.toEqual({
      kind: 'confirmed-kill',
    });
  });

  it('only resolves exited on SIGKILL for a connected (childless) handle', async () => {
    const host = fakeHost();
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(host, socketPath);
    servers.push(server);
    await server.listen();

    const connected = await connectAgentViewPtyHostProcess(
      createLaunch('session-1'),
      socketPath,
    );

    const notSettledWithin = (ms: number) =>
      Promise.race([
        connected.exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
      ]);

    // SIGINT is trappable — exited must not settle within a grace window.
    connected.kill('SIGINT');
    await waitFor(() => host.killedWith === 'SIGINT');
    expect(await notSettledWithin(100)).toBe(false);

    // SIGTERM is trappable too (server kill has no SIGKILL escalation) —
    // exited must likewise stay pending for the exit poller to observe.
    connected.kill('SIGTERM');
    await waitFor(() => host.killedWith === 'SIGTERM');
    expect(await notSettledWithin(100)).toBe(false);

    // SIGKILL is confirmed only after the authenticated RPC lands and the
    // endpoint disappears; replacement launch must wait for socket teardown.
    connected.kill('SIGKILL');
    await waitFor(() => host.killedWith === 'SIGKILL');
    expect(await notSettledWithin(100)).toBe(false);
    servers.splice(servers.indexOf(server), 1);
    await server.close();
    await expect(connected.exited).resolves.toEqual({
      kind: 'confirmed-kill',
    });
  });

  it('keeps exited pending when the kill or shutdown RPC never lands', async () => {
    const host = fakeHost();
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(host, socketPath);
    await server.listen();

    const connected = await connectAgentViewPtyHostProcess(
      createLaunch('session-1'),
      socketPath,
    );

    const notSettledWithin = (ms: number) =>
      Promise.race([
        connected.exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
      ]);

    await server.close();

    // A lost RPC must not settle the tracker: the host may still be alive
    // holding the socket lock, and only the exit poller may declare it dead.
    connected.kill('SIGKILL');
    expect(await notSettledWithin(100)).toBe(false);
    // shutdown is optional on the handle type; the connected handle always
    // provides it.
    connected.shutdown?.();
    expect(await notSettledWithin(100)).toBe(false);
  });

  it('defaults a signal-less kill to SIGTERM instead of node-pty SIGHUP', async () => {
    const host = fakeHost();
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(host, socketPath);
    servers.push(server);
    await server.listen();

    const connected = await connectAgentViewPtyHostProcess(
      createLaunch('session-1'),
      socketPath,
    );

    connected.kill();
    await waitFor(() => host.killedWith === 'SIGTERM');
  });

  it('resolves connected host exit when status polling fails', async () => {
    vi.useFakeTimers();
    try {
      const host = fakeHost();
      const socketPath = shortSocketPath();
      const server = createAgentViewPtyHostServer(host, socketPath);
      await server.listen();
      const connected = await connectAgentViewPtyHostProcess(
        createLaunch('session-1'),
        socketPath,
      );

      await server.close();
      await vi.advanceTimersByTimeAsync(10000);

      await expect(connected.exited).resolves.toEqual({
        kind: 'unreachable',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails fast when connecting with the wrong host token', async () => {
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(fakeHost(), socketPath, {
      authToken: 'expected-token',
    });
    servers.push(server);
    await server.listen();

    await expect(
      connectAgentViewPtyHostProcess(
        createLaunch('session-1'),
        socketPath,
        'wrong-token',
      ),
    ).rejects.toThrow('Unauthorized PTY host request.');
  });

  it('disposes a connected host by asking the remote host to shut down', async () => {
    const host = fakeHost();
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(host, socketPath);
    servers.push(server);
    await server.listen();

    const connected = await connectAgentViewPtyHostProcess(
      createLaunch('session-1'),
      socketPath,
    );

    connected.dispose();

    await waitFor(() => host.shutdowns === 1);
    await expect(connected.exited).resolves.toEqual({
      kind: 'unreachable',
    });
  });

  it('rejects input written before an attach stream is established', async () => {
    const host = fakeHost();
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(host, socketPath);
    servers.push(server);
    await server.listen();
    const connected = await connectAgentViewPtyHostProcess(
      createLaunch('session-early-write'),
      socketPath,
    );

    expect(() => connected.write(Buffer.from('early'))).toThrow(
      'Agent View PTY host input requires an active attach stream.',
    );
    expect(host.input).toBe('');
  });

  it('bridges data through a connected host handle', async () => {
    const host = fakeHost();
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(host, socketPath);
    servers.push(server);
    await server.listen();
    const connected = await connectAgentViewPtyHostProcess(
      createLaunch('session-1'),
      socketPath,
    );
    const data: string[] = [];

    const disposable = connected.onData((chunk) => data.push(chunk));

    connected.write(Buffer.from('hello'));
    await waitFor(() => host.input === 'hello');
    host.emitData('output');
    await waitFor(() => data.join('') === 'output');

    disposable?.dispose();
  });

  it('passes auth tokens through connected host handle operations', async () => {
    const host = fakeHost(1024 * 1024);
    const socketPath = shortSocketPath();
    const server = createAgentViewPtyHostServer(host, socketPath, {
      authToken: 'secret',
    });
    servers.push(server);
    await server.listen();
    const connected = await connectAgentViewPtyHostProcess(
      createLaunch('session-token-handle'),
      socketPath,
      'secret',
    );
    const data: string[] = [];

    const disposable = connected.onData((chunk) => data.push(chunk));
    connected.write(Buffer.from('hello'));
    await waitFor(() => host.input === 'hello');
    host.emitData('output');
    await waitFor(() => data.join('') === 'output');
    await expect(connected.getOutput?.()).resolves.toBe('output');
    connected.resize({ columns: 120, rows: 40 });
    await waitFor(() => host.resizes.length === 1);
    connected.kill('SIGTERM');
    await waitFor(() => host.killedWith === 'SIGTERM');

    disposable?.dispose();
  });

  it('computes Unix and Windows host socket paths', () => {
    expect(
      getAgentViewPtyHostSocketPath('session-1', {
        globalDir: '/tmp/qwen-agent-view-test',
        platform: 'linux',
      }),
    ).toBe(
      path.join(
        '/tmp/qwen-agent-view-test',
        'jobs',
        'session-1',
        'tmp',
        'pty-host.sock',
      ),
    );
    expect(
      getAgentViewPtyHostSocketPath('session-1', {
        globalDir: 'C:\\Users\\test\\.qwen',
        platform: 'win32',
      }),
    ).toMatch(/^\\\\\.\\pipe\\qwen-agent-pty-[a-f0-9]{12}$/);

    const fallbackPath = getAgentViewPtyHostSocketPath('session-1', {
      globalDir: path.join(os.tmpdir(), 'qwen-agent-view-test'.repeat(10)),
      platform: 'linux',
    });
    const uid =
      typeof process.getuid === 'function' ? process.getuid() : 'user';
    expect([
      path.join(os.tmpdir(), `qwen-avp-${uid}`),
      path.join('/tmp', `qwen-avp-${uid}`),
    ]).toContain(path.dirname(fallbackPath));
    expect(path.basename(fallbackPath)).toMatch(/^[a-f0-9]{12}\.sock$/);
    expect(Buffer.byteLength(fallbackPath)).toBeLessThan(100);
  });

  it('returns a short fallback path when the temp directory is long', () => {
    const fallbackPath = getAgentViewPtyHostSocketPath('session-1', {
      globalDir: path.join('/very-long-path'.repeat(20), '.qwen'),
      platform: 'linux',
    });

    expect(Buffer.byteLength(fallbackPath)).toBeLessThan(100);
  });

  it.skipIf(process.platform === 'win32')(
    'skips an unusable fallback socket directory',
    async () => {
      const tmpRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'qwen-pty-bad-tmp-'),
      );
      const tmpFile = path.join(tmpRoot, 'tmp-file');
      const previousTmpDir = process.env['TMPDIR'];
      await fs.writeFile(tmpFile, 'not a directory');
      process.env['TMPDIR'] = tmpFile;
      try {
        const fallbackPath = getAgentViewPtyHostSocketPath('session-1', {
          globalDir: path.join('/very-long-path'.repeat(20), '.qwen'),
          platform: 'linux',
        });
        const uid =
          typeof process.getuid === 'function' ? process.getuid() : 'user';

        expect(path.dirname(fallbackPath)).toBe(
          path.join('/tmp', `qwen-avp-${uid}`),
        );
      } finally {
        if (previousTmpDir === undefined) {
          delete process.env['TMPDIR'];
        } else {
          process.env['TMPDIR'] = previousTmpDir;
        }
        await fs.rm(tmpRoot, { recursive: true, force: true });
      }
    },
  );

  it('rejects oversized PTY host responses', async () => {
    const socketPath = shortSocketPath();
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.end(`${'x'.repeat(8 * 1024 * 1024 + 1)}\n`);
    });
    await listenServer(server, socketPath);
    try {
      await expect(
        connectAgentViewPtyHostProcess(
          createLaunch('session-oversized-response'),
          socketPath,
          undefined,
          { readyRetries: 3, requestTimeoutMs: 5000 },
        ),
      ).rejects.toThrow('Agent View PTY host response line is too large.');
    } finally {
      server.close();
      await removeTestSocket(socketPath);
    }
  });

  it('fails fast on malformed PTY host responses', async () => {
    const socketPath = shortSocketPath();
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.end('not-json\n');
    });
    await listenServer(server, socketPath);
    try {
      await expect(
        connectAgentViewPtyHostProcess(
          createLaunch('session-malformed-response'),
          socketPath,
        ),
      ).rejects.toMatchObject({
        name: 'AgentViewPtyHostProtocolError',
      });
    } finally {
      server.close();
      await removeTestSocket(socketPath);
    }
  });

  it('rejects promptly when the host closes without a response', async () => {
    const socketPath = shortSocketPath();
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.end();
    });
    await listenServer(server, socketPath);
    try {
      await expect(
        connectAgentViewPtyHostProcess(
          createLaunch('session-closed-response'),
          socketPath,
        ),
      ).rejects.toThrow();
    } finally {
      server.close();
      await removeTestSocket(socketPath);
    }
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
    expect(child.killedWith).toBe('SIGKILL');
  });

  it('fails quickly when the spawned PTY host emits an error before ready', async () => {
    const child = fakeChildProcess(2468);
    const launched = launchAgentViewPtyHostProcess(
      createLaunch('session-spawn-error'),
      {
        globalDir: '/tmp/qwen-agent-view-test',
        spawnProcess: () => child,
      },
    );
    child.emit('error', new Error('spawn failed'));

    await expect(launched).rejects.toThrow('spawn failed');
    expect(child.killedWith).toBe('SIGKILL');
  });

  it('passes the launch file, socket path, and token to spawned PTY hosts', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pty-spawn-'),
    );
    const launch = createLaunch('session-spawn-contract');
    const socketPath = getAgentViewPtyHostSocketPath(launch.sessionId, {
      globalDir,
    });
    socketDirs.add(path.dirname(socketPath));
    const hostId = 'host-spawn-contract';
    const server = await createStatusServer(socketPath, [], hostId);
    const child = fakeChildProcess(2468);
    const spawnProcess = vi.fn(() => child);
    try {
      await launchAgentViewPtyHostProcess(launch, {
        globalDir,
        identity: { hostId, endpoint: socketPath, authToken: 'host-token' },
        spawnProcess,
      });

      expect(spawnProcess).toHaveBeenCalledWith(
        [
          INTERNAL_AGENT_VIEW_PTY_HOST_ARG,
          getAgentViewSessionPaths(launch.sessionId, { globalDir }).launchPath,
          socketPath,
        ],
        expect.objectContaining({
          [PTY_HOST_AUTH_TOKEN_ENV]: 'host-token',
          [PTY_HOST_ID_ENV]: hostId,
        }),
        expect.stringContaining('host-stderr.log'),
      );
    } finally {
      server.close();
      await fs.rm(globalDir, { recursive: true, force: true });
    }
  });

  it('asks a spawned host to shut down when the handle is disposed', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pty-launch-'),
    );
    const launch = createLaunch('session-dispose-child');
    const socketPath = getAgentViewPtyHostSocketPath(launch.sessionId, {
      globalDir,
    });
    socketDirs.add(path.dirname(socketPath));
    const operations: string[] = [];
    const hostId = 'host-dispose-child';
    const server = await createStatusServer(socketPath, operations, hostId);
    const child = fakeChildProcess(2468);
    try {
      const handle = await launchAgentViewPtyHostProcess(launch, {
        globalDir,
        identity: { hostId, endpoint: socketPath, authToken: 'host-token' },
        spawnProcess: () => child,
      });

      handle.dispose();

      await waitFor(() => operations.includes('shutdown'));
      expect(child.killedWith).toBeUndefined();
      await expect(handle.exited).resolves.toEqual({
        kind: 'unreachable',
      });
    } finally {
      server.close();
      await fs.rm(globalDir, { recursive: true, force: true });
    }
  });

  it('asks a spawned host to deliver kill signals before falling back to the child', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pty-kill-'),
    );
    const launch = createLaunch('session-kill-child');
    const socketPath = getAgentViewPtyHostSocketPath(launch.sessionId, {
      globalDir,
    });
    socketDirs.add(path.dirname(socketPath));
    const operations: string[] = [];
    const hostId = 'host-kill-child';
    const server = await createStatusServer(socketPath, operations, hostId);
    const child = fakeChildProcess(2468);
    try {
      const handle = await launchAgentViewPtyHostProcess(launch, {
        globalDir,
        identity: { hostId, endpoint: socketPath, authToken: 'host-token' },
        spawnProcess: () => child,
      });

      handle.kill('SIGTERM');

      await waitFor(() => operations.includes('kill'));
      expect(child.killedWith).toBeUndefined();
    } finally {
      server.close();
      await fs.rm(globalDir, { recursive: true, force: true });
    }
  });

  it('reports child exit signals when they are known', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-pty-signal-'),
    );
    const launch = createLaunch('session-child-signal');
    const socketPath = getAgentViewPtyHostSocketPath(launch.sessionId, {
      globalDir,
    });
    socketDirs.add(path.dirname(socketPath));
    const hostId = 'host-child-signal';
    const server = await createStatusServer(socketPath, [], hostId);
    const child = fakeChildProcess(2468);
    try {
      const handle = await launchAgentViewPtyHostProcess(launch, {
        globalDir,
        identity: { hostId, endpoint: socketPath, authToken: 'host-token' },
        spawnProcess: () => child,
      });

      child.emit('exit', null, 'SIGKILL');

      await expect(handle.exited).resolves.toEqual({
        kind: 'exited',
        exitCode: 1,
        signal: os.constants.signals.SIGKILL,
      });
    } finally {
      server.close();
      await fs.rm(globalDir, { recursive: true, force: true });
    }
  });
});

type FakeChildProcess = ChildProcess & { killedWith?: NodeJS.Signals };

function fakeChildProcess(pid: number): FakeChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperty(child, 'pid', { value: pid });
  child.unref = () => child;
  child.kill = ((signal?: NodeJS.Signals | number) => {
    if (typeof signal === 'string') {
      (child as FakeChildProcess).killedWith = signal;
    }
    return true;
  }) as ChildProcess['kill'];
  return child as FakeChildProcess;
}

function fakeHost(maxOutputBytes = 5): AgentViewPtyHostHandle & {
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
    output: new BoundedOutputRing(maxOutputBytes),
    input: '',
    resizes: [],
    shutdowns: 0,
    exited: new Promise<AgentViewPtyHostExit>(() => {}),
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
  const unique = `qah-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\${unique}`;
  }
  const socketDir = path.join('/tmp', unique);
  socketDirs.add(socketDir);
  return path.join(socketDir, 'pty.sock');
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

async function listenServer(
  server: net.Server,
  socketPath: string,
): Promise<void> {
  if (!isWindowsPipePath(socketPath)) {
    await fs.mkdir(path.dirname(socketPath), { recursive: true });
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function createStatusServer(
  socketPath: string,
  operations: string[] = [],
  hostId?: string,
): Promise<net.Server> {
  if (!isWindowsPipePath(socketPath)) {
    await fs.mkdir(path.dirname(socketPath), { recursive: true });
  }
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline)) as {
        id: string;
        op: string;
        params?: Record<string, unknown>;
      };
      operations.push(request.op);
      socket.end(
        `${JSON.stringify({
          id: request.id,
          ok: true,
          result:
            request.op === 'status'
              ? {
                  ...(hostId ? { hostId } : {}),
                  pid: process.pid,
                  workerPid: 1234,
                }
              : request.op === 'kill'
                ? { killed: true }
                : { shuttingDown: true },
        })}\n`,
      );
    });
  });
  await listenServer(server, socketPath);
  return server;
}

async function waitForClose(socket: net.Socket): Promise<void> {
  if (socket.destroyed) return;
  await new Promise<void>((resolve) => {
    socket.once('close', () => resolve());
    socket.once('error', () => resolve());
  });
}

async function connectOnce(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function readLine(socket: net.Socket): Promise<Record<string, unknown>> {
  const line = await new Promise<string>((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      cleanup();
      resolve(buffer.slice(0, newline));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.once('error', onError);
  });
  return JSON.parse(line) as Record<string, unknown>;
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

function isWindowsPipePath(socketPath: string): boolean {
  return socketPath.startsWith('\\\\.\\pipe\\');
}

async function removeTestSocket(socketPath: string): Promise<void> {
  if (isWindowsPipePath(socketPath)) return;
  await fs.rm(path.dirname(socketPath), { recursive: true, force: true });
}
