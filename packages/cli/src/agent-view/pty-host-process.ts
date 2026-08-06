/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AgentViewLaunchFile } from './protocol.js';
import {
  BoundedOutputRing,
  launchAgentViewPtyHost,
  type AgentViewPtyDisposable,
  type AgentViewPtyHostExit,
  type AgentViewPtyHostHandle,
} from './pty-host.js';
import { getAgentViewSessionPaths } from './supervisor-store.js';
import { bridgeAgentViewTerminal } from './terminal-bridge.js';
import { buildCurrentQwenCliArgv } from './current-cli-argv.js';

export const INTERNAL_AGENT_VIEW_PTY_HOST_ARG =
  '--internal-agent-view-pty-host';

const HOST_READY_RETRIES = 300;
const CONNECT_HOST_READY_RETRIES = 10;
const HOST_READY_DELAY_MS = 50;
const HOST_READY_REQUEST_TIMEOUT_MS = 250;
const REMOTE_HOST_EXIT_POLL_MS = 5000;
const UNIX_SOCKET_PATH_LIMIT = 100;
const MAX_PTY_HOST_REQUEST_LINE_BYTES = 1024 * 1024;
const MAX_PTY_HOST_RESPONSE_LINE_BYTES = 2 * 1024 * 1024;
const PTY_HOST_AUTH_TOKEN_ENV = 'QWEN_AGENT_VIEW_PTY_HOST_TOKEN';
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
  spawnProcess?: (
    args: readonly string[],
    env: Readonly<Record<string, string>>,
  ) => ChildProcess;
}

export interface RunAgentViewPtyHostProcessOptions {
  launchPath: string;
  socketPath: string;
  authToken?: string;
}

export async function launchAgentViewPtyHostProcess(
  launch: AgentViewLaunchFile,
  options: AgentViewPtyHostProcessOptions = {},
): Promise<AgentViewPtyHostHandle> {
  const socketPath = getAgentViewPtyHostSocketPath(launch.sessionId, options);
  // Ephemeral per-host token for local socket control; not a user credential.
  const authToken = randomUUID();
  const launchPath = getAgentViewSessionPaths(launch.sessionId, {
    ...(options.globalDir ? { globalDir: options.globalDir } : {}),
  }).launchPath;
  const child = (options.spawnProcess ?? defaultSpawnPtyHost)(
    [INTERNAL_AGENT_VIEW_PTY_HOST_ARG, launchPath, socketPath],
    { [PTY_HOST_AUTH_TOKEN_ENV]: authToken },
  );
  child.unref?.();

  let status: { pid: number; workerPid: number };
  try {
    status = await waitForSpawnedPtyHost(socketPath, child, authToken);
  } catch (error) {
    child.kill?.('SIGKILL');
    throw error;
  }
  return createRemotePtyHostHandle({
    socketPath,
    launch,
    authToken,
    pid: child.pid ?? status.pid,
    workerPid: status.workerPid,
    child,
  });
}

export async function connectAgentViewPtyHostProcess(
  launch: AgentViewLaunchFile,
  socketPath: string,
  authToken?: string,
): Promise<AgentViewPtyHostHandle> {
  const status = await waitForPtyHost(
    socketPath,
    CONNECT_HOST_READY_RETRIES,
    authToken,
    { requestTimeoutMs: HOST_READY_REQUEST_TIMEOUT_MS },
  );
  return createRemotePtyHostHandle({
    socketPath,
    launch,
    authToken,
    pid: status.pid,
    workerPid: status.workerPid,
  });
}

function createRemotePtyHostHandle({
  socketPath,
  launch,
  authToken,
  pid,
  workerPid,
  child,
}: {
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
      attachSocket?.write(data);
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
      }).catch(() => {});
      child?.kill(allowedSignal);
      if (!child) {
        exitTracker.resolve({ exitCode: 1 });
      }
    },
    shutdown(): void {
      void callAgentViewPtyHost(socketPath, authToken, 'shutdown').catch(() => {
        child?.kill('SIGTERM');
      });
      attachSocket?.destroy();
      if (!child) {
        exitTracker.resolve({ exitCode: 0 });
      }
    },
    dispose(): void {
      void callAgentViewPtyHost(socketPath, authToken, 'shutdown').catch(() => {
        child?.kill('SIGTERM');
      });
      attachSocket?.destroy();
      child?.kill('SIGTERM');
      exitTracker.resolve({ exitCode: 1 });
    },
  };
}

function createChildExitTracker(child: ChildProcess): {
  exited: Promise<AgentViewPtyHostExit>;
  resolve(exit: AgentViewPtyHostExit): void;
} {
  let resolveExit: (exit: AgentViewPtyHostExit) => void = () => {};
  const exited = new Promise<AgentViewPtyHostExit>((resolve) => {
    resolveExit = resolve;
    child.once('exit', (code, signal) => {
      const signalNumber = signal ? os.constants.signals[signal] : undefined;
      resolve({
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
} {
  let settled = false;
  let resolveExit: (exit: AgentViewPtyHostExit) => void = () => {};
  const exited = new Promise<AgentViewPtyHostExit>((resolve) => {
    resolveExit = resolve;
  });
  const interval = setInterval(() => {
    void callAgentViewPtyHost(socketPath, authToken, 'status').catch(() => {
      resolveExitOnce({ exitCode: 1 });
    });
  }, REMOTE_HOST_EXIT_POLL_MS);
  interval.unref?.();

  const resolveExitOnce = (exit: AgentViewPtyHostExit) => {
    if (settled) return;
    settled = true;
    clearInterval(interval);
    resolveExit(exit);
  };
  return { exited, resolve: resolveExitOnce };
}

export async function runAgentViewPtyHostProcess({
  launchPath,
  socketPath,
  authToken,
}: RunAgentViewPtyHostProcessOptions): Promise<void> {
  const launch = JSON.parse(await fs.readFile(launchPath, 'utf8')) as unknown;
  const host = await launchAgentViewPtyHost(launch);
  const server = createAgentViewPtyHostServer(host, socketPath, {
    authToken: authToken ?? process.env[PTY_HOST_AUTH_TOKEN_ENV],
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
    (item) => Buffer.byteLength(item) < UNIX_SOCKET_PATH_LIMIT,
  );
  if (!fallback) {
    throw new Error('Agent View PTY host socket path is too long.');
  }
  return fallback;
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
  });
}

export function createAgentViewPtyHostServer(
  host: AgentViewPtyHostHandle,
  socketPath: string,
  options: { authToken?: string } = {},
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
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_PTY_HOST_REQUEST_LINE_BYTES) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      const leftover = buffer.slice(newline + 1);
      buffer = '';
      socket.pause();
      void respondToHostLine(
        host,
        line,
        socket,
        attachState,
        leftover,
        options.authToken,
      ).catch(() => {
        socket.destroy();
      });
    });
  });

  return {
    async listen() {
      await prepareSocketPath(socketPath);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
          server.off('error', reject);
          if (isWindowsPipePath(socketPath)) {
            resolve();
            return;
          }
          fs.chmod(socketPath, 0o600).then(resolve, reject);
        });
      });
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
      await removeSocketPath(socketPath);
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
  leftover = '',
  authToken?: string,
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
      if (leftover) {
        // Forward keystrokes that were coalesced with the attach request.
        host.write(Buffer.from(leftover, 'utf8'));
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
    const result = await handleHostRequest(host, request);
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
): Promise<unknown> {
  switch (request.op) {
    case 'status':
      return {
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
      host.kill(signalParam(request.params));
      return { killed: true };
    case 'shutdown':
      await shutdownHost(host);
      return { shuttingDown: true };
    case 'attachStream':
      throw new Error('attachStream must use the streaming path.');
    default: {
      const unknownOperation: never = request.op;
      throw new Error(`Unsupported PTY host operation: ${unknownOperation}`);
    }
  }
}

async function shutdownHost(host: AgentViewPtyHostHandle): Promise<void> {
  if (host.shutdown) {
    await host.shutdown();
    return;
  }
  host.kill('SIGTERM');
}

async function waitForSpawnedPtyHost(
  socketPath: string,
  child: ChildProcess,
  authToken: string,
): Promise<{ pid: number; workerPid: number }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const abortController = new AbortController();
    const cleanup = () => {
      abortController.abort();
      child.off('exit', onExit);
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
    child.once('exit', onExit);
    void waitForPtyHost(socketPath, HOST_READY_RETRIES, authToken, {
      requestTimeoutMs: HOST_READY_REQUEST_TIMEOUT_MS,
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
  options: { requestTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ pid: number; workerPid: number }> {
  const deadlineMs = Date.now() + retries * HOST_READY_DELAY_MS;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (options.signal?.aborted || Date.now() >= deadlineMs) break;
    try {
      const result = await callAgentViewPtyHost(
        socketPath,
        authToken,
        'status',
        undefined,
        options.requestTimeoutMs,
      );
      if (isRecord(result) && Number.isInteger(result['workerPid'])) {
        return {
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
): ChildProcess {
  const argv = buildCurrentQwenCliArgv(args);
  return spawn(argv[0]!, argv.slice(1), {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ...env,
      QWEN_CODE_NO_RELAUNCH: '1',
    },
  });
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

async function prepareSocketPath(socketPath: string): Promise<void> {
  if (isWindowsPipePath(socketPath)) return;
  const socketDir = path.dirname(socketPath);
  await fs.mkdir(socketDir, { recursive: true, mode: 0o700 });
  await ensurePrivateSocketDirectory(socketDir);
  await removeSocketPath(socketPath);
}

async function ensurePrivateSocketDirectory(socketDir: string): Promise<void> {
  const stat = await fs.stat(socketDir);
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
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
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
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}
