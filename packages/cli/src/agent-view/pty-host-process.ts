/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  lstatSync,
  openSync,
  statSync,
} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AgentViewLaunchFile } from './protocol.js';
import { PTY_HOST_AUTH_TOKEN_ENV, PTY_HOST_ID_ENV } from './pty-host-env.js';
import {
  BoundedOutputRing,
  launchAgentViewPtyHost,
  type AgentViewPtyDisposable,
  type AgentViewPtyHostExit,
  type AgentViewPtyHostHandle,
  type AgentViewPtyImplementation,
} from './pty-host.js';
import { getAgentViewSessionPaths } from './supervisor-store.js';
import { bridgeAgentViewTerminal } from './terminal-bridge.js';
import { buildCurrentQwenCliArgv } from './current-cli-argv.js';

export const INTERNAL_AGENT_VIEW_PTY_HOST_ARG =
  '--internal-agent-view-pty-host';

// Wall budget ≈ 15 s once per-probe request timeouts are counted.
const HOST_READY_RETRIES = 50;
const CONNECT_HOST_READY_RETRIES = 10;
const HOST_READY_DELAY_MS = 50;
const HOST_READY_REQUEST_TIMEOUT_MS = 250;
const REMOTE_HOST_EXIT_POLL_MS = 5000;
const SHUTDOWN_GRACE_MS = 2_000;
const UNIX_SOCKET_PATH_LIMIT = 100;
const MAX_PTY_HOST_REQUEST_LINE_BYTES = 1024 * 1024;
// JSON escaping inflates control bytes up to 6x, so a full 1 MiB
// retained ring can serialize to ~6 MiB; keep the wire cap above that.
const MAX_PTY_HOST_RESPONSE_LINE_BYTES = 8 * 1024 * 1024;
const ALLOWED_KILL_SIGNALS = new Set<NodeJS.Signals>([
  'SIGINT',
  'SIGKILL',
  'SIGTERM',
]);

type AgentViewPtyHostOperation =
  | 'status'
  | 'logs'
  | 'resize'
  | 'kill'
  | 'shutdown'
  | 'attachStream';

const HOST_OPERATIONS = [
  'status',
  'logs',
  'resize',
  'kill',
  'shutdown',
  'attachStream',
] as const satisfies readonly AgentViewPtyHostOperation[];

type AgentViewPtyHostResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };

interface AgentViewPtyHostRequest {
  id: string;
  op: AgentViewPtyHostOperation;
  authToken?: string;
  params?: Record<string, unknown>;
}

export interface AgentViewPtyHostProcessOptions {
  globalDir?: string;
  identity?: AgentViewPtyHostIdentity;
  spawnProcess?: (
    args: readonly string[],
    env: Readonly<Record<string, string>>,
    stderrLogPath?: string,
  ) => ChildProcess;
}

export interface RunAgentViewPtyHostProcessOptions {
  launchPath: string;
  socketPath: string;
  authToken?: string;
  hostId?: string;
  loadPty?: () => Promise<AgentViewPtyImplementation | null>;
}

export interface AgentViewPtyHostIdentity {
  hostId: string;
  endpoint: string;
  authToken: string;
}

export function createAgentViewPtyHostIdentity(
  sessionId: string,
  options: { globalDir?: string } = {},
): AgentViewPtyHostIdentity {
  return {
    hostId: randomUUID(),
    endpoint: getAgentViewPtyHostSocketPath(sessionId, options),
    authToken: randomUUID(),
  };
}

export async function launchAgentViewPtyHostProcess(
  launch: AgentViewLaunchFile,
  options: AgentViewPtyHostProcessOptions = {},
): Promise<AgentViewPtyHostHandle> {
  const identity =
    options.identity ??
    createAgentViewPtyHostIdentity(launch.sessionId, options);
  const socketPath = identity.endpoint;
  const authToken = identity.authToken;
  const launchPath = getAgentViewSessionPaths(launch.sessionId, {
    ...(options.globalDir ? { globalDir: options.globalDir } : {}),
  }).launchPath;
  const stderrLogPath = `${launchPath}.host-stderr.log`;
  const child = (options.spawnProcess ?? defaultSpawnPtyHost)(
    [INTERNAL_AGENT_VIEW_PTY_HOST_ARG, launchPath, socketPath],
    {
      [PTY_HOST_AUTH_TOKEN_ENV]: authToken,
      [PTY_HOST_ID_ENV]: identity.hostId,
    },
    stderrLogPath,
  );
  child.unref?.();

  let status: { pid: number; workerPid: number };
  try {
    status = await waitForSpawnedPtyHost(
      socketPath,
      child,
      authToken,
      identity.hostId,
    );
  } catch (error) {
    child.kill?.('SIGKILL');
    throw await withHostStderrTail(error, stderrLogPath);
  }
  return createRemotePtyHostHandle({
    hostId: identity.hostId,
    socketPath,
    launch,
    authToken,
    pid: child.pid ?? status.pid,
    workerPid: status.workerPid,
    child,
  });
}

export interface AgentViewPtyHostConnectOptions {
  readyRetries?: number;
  requestTimeoutMs?: number;
  expectedHostId?: string;
}

export async function connectAgentViewPtyHostProcess(
  launch: AgentViewLaunchFile,
  socketPath: string,
  authToken?: string,
  options: AgentViewPtyHostConnectOptions = {},
): Promise<AgentViewPtyHostHandle> {
  const status = await waitForPtyHost(
    socketPath,
    options.readyRetries ?? CONNECT_HOST_READY_RETRIES,
    authToken,
    {
      requestTimeoutMs:
        options.requestTimeoutMs ?? HOST_READY_REQUEST_TIMEOUT_MS,
      expectedHostId: options.expectedHostId,
    },
  );
  return createRemotePtyHostHandle({
    hostId: status.hostId,
    socketPath,
    launch,
    authToken,
    pid: status.pid,
    workerPid: status.workerPid,
  });
}

function createRemotePtyHostHandle({
  hostId,
  socketPath,
  launch,
  authToken,
  pid,
  workerPid,
  child,
}: {
  hostId?: string;
  socketPath: string;
  launch: AgentViewLaunchFile;
  authToken?: string;
  pid: number;
  workerPid: number;
  child?: ChildProcess;
}): AgentViewPtyHostHandle {
  const output = new BoundedOutputRing();
  let attachSocket: net.Socket | undefined;
  const exitTracker = child
    ? createChildExitTracker(child)
    : createRemoteExitTracker(socketPath, authToken);

  return {
    ...(hostId ? { hostId } : {}),
    pid,
    workerPid,
    command: launch.argv,
    endpoint: socketPath,
    ...(authToken ? { authToken } : {}),
    output,
    exited: exitTracker.exited,
    async getOutput(): Promise<string> {
      const result = await callAgentViewPtyHost(socketPath, authToken, 'logs');
      if (isRecord(result) && typeof result['output'] === 'string') {
        return result['output'];
      }
      return '';
    },
    write(data: Buffer): void {
      if (!attachSocket) {
        throw new Error(
          'Agent View PTY host input requires an active attach stream.',
        );
      }
      attachSocket.write(data);
    },
    onData(callback: (data: string) => void): AgentViewPtyDisposable {
      attachSocket?.destroy();
      const socket = net.createConnection(socketPath);
      attachSocket = socket;
      socket.setEncoding('utf8');
      socket.write(
        `${JSON.stringify({
          id: createRequestId(),
          op: 'attachStream',
          ...(authToken ? { authToken } : {}),
        })}\n`,
      );
      let attached = false;
      let buffer = '';
      const onData = (textChunk: string) => {
        if (attached) {
          output.append(textChunk);
          callback(textChunk);
          return;
        }
        buffer += textChunk;
        if (
          Buffer.byteLength(buffer, 'utf8') > MAX_PTY_HOST_RESPONSE_LINE_BYTES
        ) {
          socket.destroy(
            new AgentViewPtyHostProtocolError(
              'Agent View PTY host response line is too large.',
            ),
          );
          return;
        }
        const newline = buffer.indexOf('\n');
        if (newline === -1) return;
        let response: AgentViewPtyHostResponse;
        try {
          response = parseHostResponse(buffer.slice(0, newline));
        } catch (error) {
          socket.destroy(
            error instanceof Error ? error : new Error(String(error)),
          );
          return;
        }
        if (!response.ok) {
          socket.destroy(new Error(response.error.message));
          return;
        }
        attached = true;
        const leftover = buffer.slice(newline + 1);
        buffer = '';
        if (leftover) {
          output.append(leftover);
          callback(leftover);
        }
      };
      socket.on('data', onData);
      socket.once('error', () => {
        if (attachSocket === socket) {
          attachSocket = undefined;
        }
      });
      socket.once('close', () => {
        if (attachSocket === socket) {
          attachSocket = undefined;
        }
      });
      return {
        dispose() {
          socket.off('data', onData);
          socket.destroy();
        },
      };
    },
    resize(size): void {
      void callAgentViewPtyHost(socketPath, authToken, 'resize', {
        columns: size.columns,
        rows: size.rows,
      }).catch(() => {});
    },
    kill(signal?: string): void {
      const allowedSignal = killSignalValue(signal);
      void callAgentViewPtyHost(socketPath, authToken, 'kill', {
        signal: allowedSignal,
      }).then(
        () => {
          // Only SIGKILL cannot be trapped. Remember that the authenticated
          // RPC landed, but keep polling until the endpoint disappears so a
          // replacement cannot race the old host's socket teardown.
          if (!child && allowedSignal === 'SIGKILL') {
            exitTracker.markKillConfirmed?.();
          }
        },
        () => {
          child?.kill(allowedSignal);
        },
      );
    },
    shutdown(): void {
      void callAgentViewPtyHost(socketPath, authToken, 'shutdown').then(
        () => {
          if (!child) {
            exitTracker.markShutdownConfirmed?.();
          }
        },
        () => {
          child?.kill('SIGTERM');
        },
      );
      attachSocket?.destroy();
    },
    dispose(): void {
      void callAgentViewPtyHost(socketPath, authToken, 'shutdown').catch(() => {
        child?.kill('SIGTERM');
      });
      attachSocket?.destroy();
      exitTracker.resolve({ kind: 'unreachable' });
    },
  };
}

function createChildExitTracker(child: ChildProcess): {
  exited: Promise<AgentViewPtyHostExit>;
  resolve(exit: AgentViewPtyHostExit): void;
  markKillConfirmed?: () => void;
  markShutdownConfirmed?: () => void;
} {
  let resolveExit: (exit: AgentViewPtyHostExit) => void = () => {};
  const exited = new Promise<AgentViewPtyHostExit>((resolve) => {
    resolveExit = resolve;
    child.once('exit', (code, signal) => {
      const signalNumber = signal ? os.constants.signals[signal] : undefined;
      resolve({
        kind: 'exited',
        exitCode: typeof code === 'number' ? code : 1,
        ...(signalNumber ? { signal: signalNumber } : {}),
      });
    });
  });
  return { exited, resolve: resolveExit };
}

function createRemoteExitTracker(
  socketPath: string,
  authToken: string | undefined,
): {
  exited: Promise<AgentViewPtyHostExit>;
  resolve(exit: AgentViewPtyHostExit): void;
  markKillConfirmed(): void;
  markShutdownConfirmed(): void;
} {
  let settled = false;
  let pollInFlight = false;
  let resolveExit: (exit: AgentViewPtyHostExit) => void = () => {};
  const exited = new Promise<AgentViewPtyHostExit>((resolve) => {
    resolveExit = resolve;
  });
  let consecutiveFailures = 0;
  let confirmedTermination: 'kill' | 'shutdown' | undefined;
  let confirmedTerminationPoll: NodeJS.Timeout | undefined;
  const scheduleConfirmedPoll = () => {
    if (settled || !confirmedTermination) return;
    clearTimeout(confirmedTerminationPoll);
    confirmedTerminationPoll = setTimeout(poll, 50);
    confirmedTerminationPoll.unref?.();
  };
  const poll = () => {
    if (settled || pollInFlight) return;
    pollInFlight = true;
    void callAgentViewPtyHost(socketPath, authToken, 'status')
      .then(() => {
        if (settled) return;
        consecutiveFailures = 0;
      })
      .catch(() => {
        if (settled) return;
        if (++consecutiveFailures >= 2) {
          resolveExitOnce(
            confirmedTermination === 'kill'
              ? { kind: 'confirmed-kill' }
              : confirmedTermination === 'shutdown'
                ? { kind: 'confirmed-shutdown' }
                : { kind: 'unreachable' },
          );
        }
      })
      .finally(() => {
        pollInFlight = false;
        scheduleConfirmedPoll();
      });
  };
  const interval = setInterval(poll, REMOTE_HOST_EXIT_POLL_MS);
  interval.unref?.();

  const resolveExitOnce = (exit: AgentViewPtyHostExit) => {
    if (settled) return;
    settled = true;
    clearInterval(interval);
    clearTimeout(confirmedTerminationPoll);
    resolveExit(exit);
  };
  return {
    exited,
    resolve: resolveExitOnce,
    markKillConfirmed: () => {
      if (confirmedTermination) return;
      confirmedTermination = 'kill';
      poll();
    },
    markShutdownConfirmed: () => {
      if (confirmedTermination) return;
      confirmedTermination = 'shutdown';
      poll();
    },
  };
}

export async function runAgentViewPtyHostProcess({
  launchPath,
  socketPath,
  authToken,
  hostId,
  loadPty,
}: RunAgentViewPtyHostProcessOptions): Promise<void> {
  const launch = JSON.parse(await fs.readFile(launchPath, 'utf8')) as unknown;
  const host = await launchAgentViewPtyHost(launch, {
    ...(loadPty ? { loadPty } : {}),
  });
  const server = createAgentViewPtyHostServer(host, socketPath, {
    authToken: authToken ?? process.env[PTY_HOST_AUTH_TOKEN_ENV],
    hostId: hostId ?? process.env[PTY_HOST_ID_ENV],
  });
  try {
    await server.listen();
  } catch (error) {
    host.dispose();
    throw error;
  }
  await host.exited.finally(async () => {
    host.dispose();
    await server.close();
  });
}

export function getAgentViewPtyHostSocketPath(
  sessionId: string,
  options: { globalDir?: string; platform?: NodeJS.Platform } = {},
): string {
  const platform = options.platform ?? process.platform;
  const digest = shortHash(`${options.globalDir ?? ''}:${sessionId}:pty-host`);
  if (platform === 'win32') {
    return `\\\\.\\pipe\\qwen-agent-pty-${digest}`;
  }

  const tmpDir = getAgentViewSessionPaths(sessionId, {
    ...(options.globalDir ? { globalDir: options.globalDir } : {}),
  }).tmpDir;
  const candidate = path.join(tmpDir, 'pty-host.sock');
  if (Buffer.byteLength(candidate) < UNIX_SOCKET_PATH_LIMIT) {
    return candidate;
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  const fallbackCandidates = [
    path.join(os.tmpdir(), `qwen-avp-${uid}`, `${digest}.sock`),
    path.join('/tmp', `qwen-avp-${uid}`, `${digest}.sock`),
  ];
  const fallback = fallbackCandidates.find(
    (item) =>
      Buffer.byteLength(item) < UNIX_SOCKET_PATH_LIMIT &&
      canPrepareSocketDirectory(path.dirname(item)),
  );
  const lengthFallback = fallbackCandidates.find(
    (item) => Buffer.byteLength(item) < UNIX_SOCKET_PATH_LIMIT,
  );
  if (fallback) {
    return fallback;
  }
  if (lengthFallback) {
    // Both fallback directories failed the availability check; fail fast
    // instead of spawning a host that can never bind its socket.
    throw new Error(
      'Agent View PTY host socket fallback directories are not writable.',
    );
  }
  throw new Error('Agent View PTY host socket path is too long.');
}

async function callAgentViewPtyHost(
  socketPath: string,
  authToken: string | undefined,
  op: AgentViewPtyHostOperation,
  params?: Record<string, unknown>,
  timeoutMs?: number,
): Promise<unknown> {
  const response = await requestAgentViewPtyHost(
    socketPath,
    {
      id: createRequestId(),
      op,
      ...(authToken ? { authToken } : {}),
      ...(params ? { params } : {}),
    },
    timeoutMs ? { timeoutMs } : {},
  );
  if (response.ok) return response.result;
  throw new AgentViewPtyHostRequestError(
    response.error.code,
    response.error.message,
  );
}

class AgentViewPtyHostRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentViewPtyHostRequestError';
  }
}

class AgentViewPtyHostProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentViewPtyHostProtocolError';
  }
}

async function requestAgentViewPtyHost(
  socketPath: string,
  request: AgentViewPtyHostRequest,
  options: { timeoutMs?: number } = {},
): Promise<AgentViewPtyHostResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    let settled = false;
    const timeout = setTimeout(() => {
      finish(
        undefined,
        new Error('Timed out waiting for Agent View PTY host.'),
      );
      socket.destroy();
    }, options.timeoutMs ?? 5000);
    const finish = (
      response: AgentViewPtyHostResponse | undefined,
      error?: Error,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      if (error) {
        reject(error);
      } else {
        resolve(response as AgentViewPtyHostResponse);
      }
    };
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (
        Buffer.byteLength(buffer, 'utf8') > MAX_PTY_HOST_RESPONSE_LINE_BYTES
      ) {
        finish(
          undefined,
          new AgentViewPtyHostProtocolError(
            'Agent View PTY host response line is too large.',
          ),
        );
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      try {
        finish(parseHostResponse(buffer.slice(0, newline)));
      } catch (error) {
        finish(undefined, error as Error);
      } finally {
        socket.end();
      }
    });
    socket.on('error', (error) => finish(undefined, error));
    socket.on('close', () => {
      finish(undefined, new Error('Agent View PTY host connection closed.'));
    });
  });
}

export function createAgentViewPtyHostServer(
  host: AgentViewPtyHostHandle,
  socketPath: string,
  options: {
    authToken?: string;
    hostId?: string;
    shutdownGraceMs?: number;
  } = {},
): { listen(): Promise<void>; close(): Promise<void> } {
  const attachState: {
    activeAttachSocket: net.Socket | undefined;
  } = {
    activeAttachSocket: undefined,
  };
  const openSockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    openSockets.add(socket);
    socket.once('close', () => {
      openSockets.delete(socket);
    });
    socket.on('error', () => {});
    socket.setTimeout(5000, () => {
      socket.destroy();
    });
    // Byte-transparent framing: only the request line is decoded, so
    // coalesced keystrokes after an attach request reach the worker verbatim.
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_PTY_HOST_REQUEST_LINE_BYTES) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) return;
      const line = buffer.toString('utf8', 0, newline);
      const leftover = Buffer.from(buffer.subarray(newline + 1));
      buffer = Buffer.alloc(0);
      socket.pause();
      void respondToHostLine(
        host,
        line,
        socket,
        attachState,
        leftover,
        options.authToken,
        options.hostId,
        options.shutdownGraceMs,
      ).catch(() => {
        socket.destroy();
      });
    });
  });

  let releaseLock: (() => Promise<void>) | undefined;
  return {
    async listen() {
      if (!isWindowsPipePath(socketPath)) {
        releaseLock = await acquireSocketPathLock(socketPath);
      }
      try {
        await prepareSocketPath(socketPath);
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(socketPath, () => {
            server.off('error', reject);
            server.on('error', () => {});
            if (isWindowsPipePath(socketPath)) {
              resolve();
              return;
            }
            fs.chmod(socketPath, 0o600).then(resolve, (error) => {
              server.close(() => reject(error));
            });
          });
        });
        if (!isWindowsPipePath(socketPath)) {
          // The reclaim path is racy: two processes can both delete a stale
          // lock and proceed, and a rival can reclaim this process's
          // lockfile between its O_EXCL create and the pid write. Re-verify
          // lock ownership now and fail closed when displaced, so at most one
          // host serves the socket.
          const lockContent = await fs
            .readFile(`${socketPath}.lock`, 'utf8')
            .catch(() => '');
          if (lockContent !== String(process.pid)) {
            releaseLock = undefined; // the lock no longer belongs to us
            for (const socket of openSockets) {
              socket.destroy();
            }
            await new Promise<void>((resolve) => server.close(() => resolve()));
            const displaced = new Error(
              `Agent View PTY host socket is already in use: ${socketPath}`,
            ) as NodeJS.ErrnoException;
            displaced.code = 'EADDRINUSE';
            throw displaced;
          }
        }
      } catch (error) {
        await releaseLock?.();
        releaseLock = undefined;
        throw error;
      }
    },
    async close() {
      attachState.activeAttachSocket?.destroy();
      for (const socket of openSockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await removeOwnedSocketPath(socketPath);
      await releaseLock?.();
      releaseLock = undefined;
    },
  };
}

async function respondToHostLine(
  host: AgentViewPtyHostHandle,
  line: string,
  socket: net.Socket,
  attachState: {
    activeAttachSocket: net.Socket | undefined;
  },
  leftover: Buffer = Buffer.alloc(0),
  authToken?: string,
  hostId?: string,
  shutdownGraceMs?: number,
): Promise<void> {
  const request = parseHostRequest(line);
  if (!request) {
    socket.end(
      `${JSON.stringify(errorResponse('', 'invalid_json', 'Invalid JSON.'))}\n`,
    );
    return;
  }
  if (authToken && !isValidAuthToken(request.authToken, authToken)) {
    socket.end(
      `${JSON.stringify(
        errorResponse(
          request.id,
          'unauthorized',
          'Unauthorized PTY host request.',
        ),
      )}\n`,
    );
    return;
  }

  if (request.op === 'attachStream') {
    if (attachState.activeAttachSocket?.destroyed === false) {
      socket.end(
        `${JSON.stringify(
          errorResponse(
            request.id,
            'already_attached',
            'Agent View PTY host already has an attached stream.',
          ),
        )}\n`,
      );
      return;
    }

    attachState.activeAttachSocket = socket;
    host.resetInput?.();
    const clearActiveAttach = () => {
      if (attachState.activeAttachSocket === socket) {
        attachState.activeAttachSocket = undefined;
      }
    };
    socket.once('close', clearActiveAttach);
    socket.removeAllListeners('data');
    socket.setTimeout(0);
    socket.resume();
    try {
      socket.write(
        `${JSON.stringify({
          id: request.id,
          ok: true,
          result: { attached: true },
        })}\n`,
      );
      if (leftover.length > 0) {
        // Forward keystrokes that were coalesced with the attach request.
        host.write(leftover);
      }
      await bridgeAgentViewTerminal({
        stdin: socket,
        stdout: socket,
        pty: host,
      });
    } finally {
      socket.off('close', clearActiveAttach);
      clearActiveAttach();
      socket.end();
    }
    return;
  }

  try {
    const result = await handleHostRequest(
      host,
      request,
      hostId,
      shutdownGraceMs,
    );
    socket.end(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
  } catch (error) {
    socket.end(
      `${JSON.stringify(
        errorResponse(
          request.id,
          'internal_error',
          error instanceof Error ? error.message : 'PTY host request failed.',
        ),
      )}\n`,
    );
  }
}

async function handleHostRequest(
  host: AgentViewPtyHostHandle,
  request: AgentViewPtyHostRequest,
  hostId?: string,
  shutdownGraceMs?: number,
): Promise<unknown> {
  switch (request.op) {
    case 'status':
      return {
        ...(hostId ? { hostId } : {}),
        pid: process.pid,
        workerPid: host.workerPid,
      };
    case 'logs':
      return { output: host.output.toString() };
    case 'resize':
      host.resize({
        columns: positiveIntegerParam(request.params, 'columns'),
        rows: positiveIntegerParam(request.params, 'rows'),
      });
      return { resized: true };
    case 'kill':
      // Default to SIGTERM, not node-pty's POSIX fallback SIGHUP: SIGHUP is
      // outside ALLOWED_KILL_SIGNALS and is commonly ignored (nohup-style
      // workers), so kill and shutdown would disagree on whether the worker
      // dies.
      host.kill(signalParam(request.params) ?? 'SIGTERM');
      return { killed: true };
    case 'shutdown':
      await shutdownHost(host, shutdownGraceMs);
      return { shuttingDown: true };
    case 'attachStream':
      throw new Error('attachStream must use the streaming path.');
    default: {
      const unknownOperation: never = request.op;
      throw new Error(`Unsupported PTY host operation: ${unknownOperation}`);
    }
  }
}

async function shutdownHost(
  host: AgentViewPtyHostHandle,
  graceMs: number = SHUTDOWN_GRACE_MS,
): Promise<void> {
  if (host.shutdown) {
    await host.shutdown();
  } else {
    host.kill('SIGTERM');
  }
  // A TERM-resistant worker (e.g. `trap '' TERM`) would otherwise keep
  // host.exited pending forever: the host process would never exit and its
  // socket lock would block every future launch of the session.
  const timer = setTimeout(() => {
    try {
      host.kill('SIGKILL');
    } catch {
      // The worker exited between the grace deadline and this kill.
    }
  }, graceMs);
  timer.unref?.();
  const cancel = () => clearTimeout(timer);
  void host.exited.then(cancel, cancel);
}

async function waitForSpawnedPtyHost(
  socketPath: string,
  child: ChildProcess,
  authToken: string,
  hostId: string,
): Promise<{ hostId?: string; pid: number; workerPid: number }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const abortController = new AbortController();
    const cleanup = () => {
      abortController.abort();
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const finishResolve = (value: { pid: number; workerPid: number }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const suffix = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      finishReject(
        new Error(`Agent View PTY host exited before ready (${suffix}).`),
      );
    };
    const onError = (error: Error) => {
      finishReject(error);
    };
    child.once('exit', onExit);
    child.once('error', onError);
    void waitForPtyHost(socketPath, HOST_READY_RETRIES, authToken, {
      requestTimeoutMs: HOST_READY_REQUEST_TIMEOUT_MS,
      expectedHostId: hostId,
      signal: abortController.signal,
    }).then(
      (status) => finishResolve(status),
      (error) => {
        if (abortController.signal.aborted && settled) return;
        finishReject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function waitForPtyHost(
  socketPath: string,
  retries = HOST_READY_RETRIES,
  authToken?: string,
  options: {
    requestTimeoutMs?: number;
    signal?: AbortSignal;
    expectedHostId?: string;
  } = {},
): Promise<{ hostId?: string; pid: number; workerPid: number }> {
  const requestTimeoutMs = options.requestTimeoutMs ?? 5000;
  // Model the deadline as a wall-clock budget covering each probe's delay
  // and request timeout, so slow probes cannot silently exhaust retries.
  const deadlineMs =
    Date.now() + retries * (HOST_READY_DELAY_MS + requestTimeoutMs);
  for (let attempt = 0; attempt < retries; attempt++) {
    if (options.signal?.aborted || Date.now() >= deadlineMs) break;
    try {
      const result = await callAgentViewPtyHost(
        socketPath,
        authToken,
        'status',
        undefined,
        requestTimeoutMs,
      );
      if (isRecord(result) && Number.isInteger(result['workerPid'])) {
        const hostId =
          typeof result['hostId'] === 'string' ? result['hostId'] : undefined;
        if (options.expectedHostId && hostId !== options.expectedHostId) {
          throw new AgentViewPtyHostProtocolError(
            'Agent View PTY host identity does not match.',
          );
        }
        return {
          ...(hostId ? { hostId } : {}),
          pid: Number.isInteger(result['pid'])
            ? Number(result['pid'])
            : process.pid,
          workerPid: Number(result['workerPid']),
        };
      }
    } catch (error) {
      if (
        error instanceof AgentViewPtyHostProtocolError ||
        (error instanceof AgentViewPtyHostRequestError &&
          error.code === 'unauthorized')
      ) {
        throw error;
      }
      // Retry until the host socket is ready.
    }
    await delay(HOST_READY_DELAY_MS, options.signal);
  }
  throw new Error('Agent View PTY host did not become ready.');
}

function defaultSpawnPtyHost(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  stderrLogPath?: string,
): ChildProcess {
  const argv = buildCurrentQwenCliArgv(args);
  // Route stderr to a per-session file so fail-closed startup errors stay
  // observable; a pipe would tie the detached host's lifetime to ours.
  let stderrFd: number | undefined;
  if (stderrLogPath) {
    try {
      stderrFd = openSync(stderrLogPath, 'w', 0o600);
    } catch {
      // Fall back to discarding stderr.
    }
  }
  try {
    return spawn(argv[0]!, argv.slice(1), {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'ignore', stderrFd ?? 'ignore'],
      env: {
        ...process.env,
        ...env,
        QWEN_CODE_NO_RELAUNCH: '1',
      },
    });
  } finally {
    if (stderrFd !== undefined) closeSync(stderrFd);
  }
}

async function withHostStderrTail(
  error: unknown,
  stderrLogPath: string,
): Promise<Error> {
  const base = error instanceof Error ? error : new Error(String(error));
  const tail = await fs
    .readFile(stderrLogPath, 'utf8')
    .then((text) => text.trim().slice(-2048))
    .catch(() => '');
  if (!tail) return base;
  return new Error(`${base.message} Host stderr: ${tail}`, { cause: base });
}

function parseHostRequest(line: string): AgentViewPtyHostRequest | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (
      !isRecord(parsed) ||
      typeof parsed['id'] !== 'string' ||
      !isHostOperation(parsed['op'])
    ) {
      return undefined;
    }
    return {
      id: parsed['id'],
      op: parsed['op'],
      ...(typeof parsed['authToken'] === 'string'
        ? { authToken: parsed['authToken'] }
        : {}),
      ...(isRecord(parsed['params']) ? { params: parsed['params'] } : {}),
    };
  } catch {
    return undefined;
  }
}

function parseHostResponse(line: string): AgentViewPtyHostResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error) {
    throw new AgentViewPtyHostProtocolError(
      error instanceof Error ? error.message : 'Invalid PTY host response.',
    );
  }
  if (!isRecord(parsed) || typeof parsed['id'] !== 'string') {
    throw new AgentViewPtyHostProtocolError(
      'Invalid Agent View PTY host response.',
    );
  }
  if (parsed['ok'] === true) {
    return { id: parsed['id'], ok: true, result: parsed['result'] };
  }
  if (
    parsed['ok'] === false &&
    isRecord(parsed['error']) &&
    typeof parsed['error']['code'] === 'string' &&
    typeof parsed['error']['message'] === 'string'
  ) {
    return {
      id: parsed['id'],
      ok: false,
      error: {
        code: parsed['error']['code'],
        message: parsed['error']['message'],
      },
    };
  }
  throw new AgentViewPtyHostProtocolError(
    'Invalid Agent View PTY host response.',
  );
}

function isHostOperation(value: unknown): value is AgentViewPtyHostOperation {
  return HOST_OPERATIONS.includes(value as AgentViewPtyHostOperation);
}

function errorResponse(
  id: string,
  code: string,
  message: string,
): AgentViewPtyHostResponse {
  return { id, ok: false, error: { code, message } };
}

// A pid lockfile makes the prepare->listen sequence mutually exclusive:
// canConnect alone is a false-negative-prone liveness oracle, so two
// concurrent launches could both unlink and bind the same session path.
async function acquireSocketPathLock(
  socketPath: string,
): Promise<() => Promise<void>> {
  const lockPath = `${socketPath}.lock`;
  await fs.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  // Loop until the O_EXCL create wins or a confirmed-live holder is found:
  // every iteration that continues has just removed a stale lock, so a
  // successful reclaim always earns another create attempt.
  while (true) {
    try {
      await fs.writeFile(lockPath, String(process.pid), { flag: 'wx' });
      return async () => {
        // Only remove a lock that still belongs to this process: a rival
        // reclaim may have replaced it, and removing the replacement would
        // strip the new owner's lock.
        const current = await fs.readFile(lockPath, 'utf8').catch(() => '');
        if (current === String(process.pid)) {
          await fs.rm(lockPath, { force: true });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const raw = await fs.readFile(lockPath, 'utf8').catch(() => '');
      const holderPid = Number.parseInt(raw, 10);
      // An empty/non-numeric lock means the writer died before recording its
      // pid; reclaim it the same as a confirmed-dead holder.
      if (!Number.isInteger(holderPid) || !isProcessAlive(holderPid)) {
        // Re-read right before removing: a concurrent reclaim may have
        // already replaced the stale lock, and removing the replacement
        // would delete the new owner's lock.
        const current = await fs.readFile(lockPath, 'utf8').catch(() => '');
        if (current === raw) {
          await fs.rm(lockPath, { force: true });
        }
        continue;
      }
      break;
    }
  }
  const busy = new Error(
    `Agent View PTY host socket is already in use: ${socketPath}`,
  ) as NodeJS.ErrnoException;
  busy.code = 'EADDRINUSE';
  throw busy;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  if (isWindowsPipePath(socketPath)) return;
  const socketDir = path.dirname(socketPath);
  await fs.mkdir(socketDir, { recursive: true, mode: 0o700 });
  await ensurePrivateSocketDirectory(socketDir);
  if (!(await socketPathExists(socketPath))) return;
  // Fail closed instead of unlinking a live socket: the listening host is
  // detached and untracked, so replacing it would orphan it irrecoverably.
  if (await canConnect(socketPath)) {
    const error = new Error(
      `Agent View PTY host socket is already in use: ${socketPath}`,
    ) as NodeJS.ErrnoException;
    error.code = 'EADDRINUSE';
    throw error;
  }
  await removeSocketPath(socketPath);
}

async function ensurePrivateSocketDirectory(socketDir: string): Promise<void> {
  // lstat (not stat) so a planted symlink at the predictable fallback
  // location cannot redirect the ownership check, chmod, or socket bind.
  const stat = await fs.lstat(socketDir);
  if (stat.isSymbolicLink()) {
    throw new Error('Agent View PTY host socket parent must not be a symlink.');
  }
  if (!stat.isDirectory()) {
    throw new Error('Agent View PTY host socket parent is not a directory.');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('Agent View PTY host socket parent is not owned by you.');
  }
  if ((stat.mode & 0o077) !== 0) {
    await fs.chmod(socketDir, 0o700);
  }
}

function canPrepareSocketDirectory(socketDir: string): boolean {
  try {
    const stat = lstatSync(socketDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      return false;
    }
    accessSync(socketDir, fsConstants.W_OK | fsConstants.X_OK);
    return true;
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') return false;
  }

  const parentDir = path.dirname(socketDir);
  try {
    const parentStat = statSync(parentDir);
    if (!parentStat.isDirectory()) return false;
    accessSync(parentDir, fsConstants.W_OK | fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function removeSocketPath(socketPath: string): Promise<void> {
  if (isWindowsPipePath(socketPath)) return;
  try {
    await fs.unlink(socketPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function removeOwnedSocketPath(socketPath: string): Promise<void> {
  if (isWindowsPipePath(socketPath)) return;
  if (!(await socketPathExists(socketPath))) return;
  // A live listener means a replacement host took over the path while this
  // server was shutting down; unlinking would orphan its socket.
  if (await canConnect(socketPath)) return;
  await removeSocketPath(socketPath);
}

async function socketPathExists(socketPath: string): Promise<boolean> {
  try {
    await fs.lstat(socketPath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    function finish(result: boolean) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    }

    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    const timeout = setTimeout(() => finish(false), 250);
  });
}

function positiveIntegerParam(
  params: Record<string, unknown> | undefined,
  key: string,
): number {
  const value = params?.[key];
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`Agent View PTY host ${key} must be a positive integer.`);
  }
  return Number(value);
}

function signalParam(
  params: Record<string, unknown> | undefined,
): NodeJS.Signals | undefined {
  return killSignalValue(params?.['signal']);
}

function killSignalValue(value: unknown): NodeJS.Signals | undefined {
  if (value === undefined || value === '') return undefined;
  if (
    typeof value === 'string' &&
    ALLOWED_KILL_SIGNALS.has(value as NodeJS.Signals)
  ) {
    return value as NodeJS.Signals;
  }
  throw new Error('Agent View PTY host signal is not allowed.');
}

function isValidAuthToken(
  provided: string | undefined,
  expected: string,
): boolean {
  if (!provided) return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isWindowsPipePath(socketPath: string): boolean {
  return socketPath.startsWith('\\\\.\\pipe\\');
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function createRequestId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
