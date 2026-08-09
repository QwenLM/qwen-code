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
import type {
  AgentViewLaunchFile,
  AgentViewPtyHostReceipt,
} from './protocol.js';
import {
  BoundedOutputRing,
  launchAgentViewPtyHost,
  type AgentViewPtyDisposable,
  type AgentViewPtyHostExit,
  type AgentViewPtyHostHandle,
} from './pty-host.js';
import {
  getAgentViewSessionPaths,
  getAgentViewStorePaths,
  readAgentViewPtyHostReceipt,
  removeAgentViewPtyHostReceipt,
  writeAgentViewPtyHostReceipt,
} from './supervisor-store.js';
import { bridgeAgentViewTerminal } from './terminal-bridge.js';
import { buildCurrentQwenCliArgv } from './current-cli-argv.js';
import { QWEN_AGENT_VIEW_GENERATION } from './worker-sideband.js';

export const INTERNAL_AGENT_VIEW_PTY_HOST_ARG =
  '--internal-agent-view-pty-host';

// Wall budget ≈ 15 s once per-probe request timeouts are counted.
const HOST_READY_RETRIES = 50;
const CONNECT_HOST_READY_RETRIES = 10;
const HOST_READY_DELAY_MS = 50;
const HOST_READY_REQUEST_TIMEOUT_MS = 250;
const REMOTE_HOST_EXIT_POLL_MS = 5000;
const REMOTE_HOST_STOP_POLL_MS = 100;
const UNIX_SOCKET_PATH_LIMIT = 100;
const MAX_PTY_HOST_REQUEST_LINE_BYTES = 1024 * 1024;
// JSON escaping inflates control bytes up to 6x, so a full 1 MiB
// retained ring can serialize to ~6 MiB; keep the wire cap above that.
const MAX_PTY_HOST_RESPONSE_LINE_BYTES = 8 * 1024 * 1024;
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

interface AgentViewPtyHostStatus {
  pid: number;
  workerPid: number;
  generation: number;
}

export interface AgentViewPtyHostProcessOptions {
  globalDir?: string;
  workerEnvironment?: Readonly<Record<string, string>>;
  spawnProcess?: (
    args: readonly string[],
    env: Readonly<Record<string, string>>,
  ) => ChildProcess;
}

export interface RunAgentViewPtyHostProcessOptions {
  launchPath: string;
  socketPath: string;
  authToken?: string;
  globalDir?: string;
}

export async function launchAgentViewPtyHostProcess(
  launch: AgentViewLaunchFile,
  options: AgentViewPtyHostProcessOptions = {},
): Promise<AgentViewPtyHostHandle> {
  const socketPath = getAgentViewPtyHostSocketPath(launch.sessionId, options);
  // Ephemeral per-host token for local socket control; not a user credential.
  const authToken = randomUUID();
  const store = {
    globalDir: getAgentViewStorePaths({
      ...(options.globalDir ? { globalDir: options.globalDir } : {}),
    }).globalDir,
  };
  const launchPath = getAgentViewSessionPaths(
    launch.sessionId,
    store,
  ).launchPath;
  await removeAgentViewPtyHostReceipt(launch.sessionId, store);
  const hostArgs = [
    INTERNAL_AGENT_VIEW_PTY_HOST_ARG,
    launchPath,
    socketPath,
    store.globalDir,
  ];
  const hostEnv = {
    ...options.workerEnvironment,
    [PTY_HOST_AUTH_TOKEN_ENV]: authToken,
  };
  const child = options.spawnProcess
    ? options.spawnProcess(hostArgs, hostEnv)
    : defaultSpawnPtyHost(
        hostArgs,
        hostEnv,
        options.workerEnvironment !== undefined,
      );
  child.unref?.();

  let status: AgentViewPtyHostStatus;
  try {
    status = await waitForSpawnedPtyHost(socketPath, child, authToken);
    const receipt = await waitForPtyHostReceipt(launch.sessionId, store);
    requireMatchingPtyHostReceipt(
      receipt,
      launch,
      socketPath,
      authToken,
      child.pid,
      status,
    );
  } catch (error) {
    await terminateFailedPtyHostLaunch(
      launch,
      child,
      socketPath,
      authToken,
      store,
    );
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

export interface AgentViewPtyHostConnectOptions {
  readyRetries?: number;
  requestTimeoutMs?: number;
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
    },
  );
  if (status.generation !== requireLaunchGeneration(launch)) {
    throw new Error('Agent View PTY host generation did not match.');
  }
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
    ? createChildExitTracker(child, workerPid)
    : createRemoteExitTracker(
        socketPath,
        authToken,
        pid,
        workerPid,
        requireLaunchGeneration(launch),
      );

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
      exitTracker.beginExitMonitoring();
      void callAgentViewPtyHost(socketPath, authToken, 'kill', {
        signal: allowedSignal,
      }).catch(() => {
        child?.kill(allowedSignal);
      });
    },
    async shutdown(): Promise<void> {
      exitTracker.beginExitMonitoring();
      await callAgentViewPtyHost(socketPath, authToken, 'shutdown').catch(
        () => {
          child?.kill('SIGTERM');
        },
      );
      attachSocket?.destroy();
    },
    dispose(): void {
      exitTracker.beginExitMonitoring();
      void callAgentViewPtyHost(socketPath, authToken, 'shutdown').catch(() => {
        child?.kill('SIGTERM');
      });
      attachSocket?.destroy();
    },
  };
}

function createChildExitTracker(
  child: ChildProcess,
  workerPid: number,
): {
  exited: Promise<AgentViewPtyHostExit>;
  beginExitMonitoring(): void;
} {
  const exited = new Promise<AgentViewPtyHostExit>((resolve) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const signalNumber = signal ? os.constants.signals[signal] : undefined;
      const exit = {
        exitCode: typeof code === 'number' ? code : 1,
        ...(signalNumber ? { signal: signalNumber } : {}),
      };
      if (!isProcessRunning(workerPid)) {
        resolve(exit);
        return;
      }
      const interval = setInterval(() => {
        if (isProcessRunning(workerPid)) return;
        clearInterval(interval);
        resolve(exit);
      }, REMOTE_HOST_STOP_POLL_MS);
      interval.unref?.();
    };
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      child.removeListener('exit', onExit);
      onExit(child.exitCode, child.signalCode);
    }
  });
  return { exited, beginExitMonitoring() {} };
}

function createRemoteExitTracker(
  socketPath: string,
  authToken: string | undefined,
  hostPid: number,
  workerPid: number,
  generation: number,
): {
  exited: Promise<AgentViewPtyHostExit>;
  beginExitMonitoring(): void;
} {
  let settled = false;
  let probing = false;
  let stopInterval: NodeJS.Timeout | undefined;
  let resolveExit: (exit: AgentViewPtyHostExit) => void = () => {};
  const exited = new Promise<AgentViewPtyHostExit>((resolve) => {
    resolveExit = resolve;
  });
  const resolveExitOnce = (exit: AgentViewPtyHostExit) => {
    if (settled) return;
    settled = true;
    if (idleInterval) clearInterval(idleInterval);
    if (stopInterval) clearInterval(stopInterval);
    resolveExit(exit);
  };

  const probe = async () => {
    if (settled || probing) return;
    probing = true;
    try {
      const status = await callAgentViewPtyHost(
        socketPath,
        authToken,
        'status',
        undefined,
        HOST_READY_REQUEST_TIMEOUT_MS,
      );
      const identityMatches =
        isRecord(status) &&
        status['pid'] === hostPid &&
        status['workerPid'] === workerPid &&
        status['generation'] === generation;
      if (identityMatches && status['workerExited'] === true) {
        resolveExitOnce({
          exitCode: Number.isInteger(status['workerExitCode'])
            ? Number(status['workerExitCode'])
            : 1,
        });
      } else if (
        !identityMatches &&
        !isProcessRunning(hostPid) &&
        !isProcessRunning(workerPid)
      ) {
        resolveExitOnce({ exitCode: 1 });
      }
    } catch {
      if (!isProcessRunning(hostPid) && !isProcessRunning(workerPid)) {
        resolveExitOnce({ exitCode: 1 });
      }
    } finally {
      probing = false;
    }
  };

  const idleInterval = setInterval(() => {
    void probe();
  }, REMOTE_HOST_EXIT_POLL_MS);
  idleInterval.unref?.();

  return {
    exited,
    beginExitMonitoring() {
      if (settled || stopInterval) return;
      void probe();
      stopInterval = setInterval(() => void probe(), REMOTE_HOST_STOP_POLL_MS);
      stopInterval.unref?.();
    },
  };
}

export async function runAgentViewPtyHostProcess({
  launchPath,
  socketPath,
  authToken,
  globalDir,
}: RunAgentViewPtyHostProcessOptions): Promise<void> {
  const launch = JSON.parse(await fs.readFile(launchPath, 'utf8')) as unknown;
  const host = await launchAgentViewPtyHost(launch);
  const validatedLaunch = launch as AgentViewLaunchFile;
  const resolvedAuthToken =
    authToken ?? process.env[PTY_HOST_AUTH_TOKEN_ENV] ?? '';
  const generation = requireLaunchGeneration(validatedLaunch);
  const terminate = () => host.shutdown?.();
  process.once('SIGTERM', terminate);
  process.once('SIGINT', terminate);
  let server: ReturnType<typeof createAgentViewPtyHostServer> | undefined;
  try {
    await writeAgentViewPtyHostReceipt(
      {
        schemaVersion: 1,
        sessionId: validatedLaunch.sessionId,
        hostPid: process.pid,
        workerPid: host.workerPid,
        hostEndpoint: socketPath,
        hostAuthToken: resolvedAuthToken,
        generation,
      },
      { ...(globalDir ? { globalDir } : {}) },
    );
    server = createAgentViewPtyHostServer(host, socketPath, {
      authToken: resolvedAuthToken,
      generation,
    });
    await server.listen();
    await host.exited;
  } finally {
    process.off('SIGTERM', terminate);
    process.off('SIGINT', terminate);
    host.dispose();
    await server?.close().catch(() => {});
  }
}

function requireLaunchGeneration(launch: AgentViewLaunchFile): number {
  const generation = Number(launch.env[QWEN_AGENT_VIEW_GENERATION]);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('Agent View PTY host launch is missing its generation.');
  }
  return generation;
}

async function waitForPtyHostReceipt(
  sessionId: string,
  store: { globalDir: string },
): Promise<AgentViewPtyHostReceipt | undefined> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const receipt = await readAgentViewPtyHostReceipt(sessionId, store);
    if (receipt) return receipt;
    await delay(10);
  }
  return undefined;
}

function requireMatchingPtyHostReceipt(
  receipt: AgentViewPtyHostReceipt | undefined,
  launch: AgentViewLaunchFile,
  socketPath: string,
  authToken: string,
  childPid: number | undefined,
  status: AgentViewPtyHostStatus,
): asserts receipt is AgentViewPtyHostReceipt {
  if (
    !isMatchingPtyHostReceipt(
      receipt,
      launch,
      socketPath,
      authToken,
      childPid,
    ) ||
    receipt.hostPid !== status.pid ||
    receipt.workerPid !== status.workerPid ||
    receipt.generation !== status.generation
  ) {
    throw new Error('Agent View PTY host bootstrap identity did not match.');
  }
}

function isMatchingPtyHostReceipt(
  receipt: AgentViewPtyHostReceipt | undefined,
  launch: AgentViewLaunchFile,
  socketPath: string,
  authToken: string,
  childPid: number | undefined,
): receipt is AgentViewPtyHostReceipt {
  return Boolean(
    receipt &&
      Number.isSafeInteger(childPid) &&
      Number(childPid) > 0 &&
      receipt.sessionId === launch.sessionId &&
      receipt.hostPid === childPid &&
      receipt.hostEndpoint === socketPath &&
      receipt.hostAuthToken === authToken &&
      receipt.generation === requireLaunchGeneration(launch),
  );
}

async function terminateFailedPtyHostLaunch(
  launch: AgentViewLaunchFile,
  child: ChildProcess,
  socketPath: string,
  authToken: string,
  store: { globalDir: string },
): Promise<void> {
  const receipt = await readAgentViewPtyHostReceipt(
    launch.sessionId,
    store,
  ).catch(() => undefined);
  if (
    isMatchingPtyHostReceipt(receipt, launch, socketPath, authToken, child.pid)
  ) {
    sendProcessSignal(receipt.workerPid, 'SIGTERM');
  }
  child.kill?.('SIGTERM');
  if (
    await waitForProcessExit(
      child.pid,
      receipt &&
        isMatchingPtyHostReceipt(
          receipt,
          launch,
          socketPath,
          authToken,
          child.pid,
        )
        ? receipt.workerPid
        : undefined,
      1_000,
    )
  ) {
    return;
  }
  if (
    receipt &&
    isMatchingPtyHostReceipt(receipt, launch, socketPath, authToken, child.pid)
  ) {
    sendProcessSignal(receipt.workerPid, 'SIGKILL');
  }
  child.kill?.('SIGKILL');
  await waitForProcessExit(child.pid, receipt?.workerPid, 1_000);
}

function sendProcessSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ESRCH') throw error;
  }
}

async function waitForProcessExit(
  hostPid: number | undefined,
  workerPid: number | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      !isProcessRunning(Number(hostPid)) &&
      !isProcessRunning(Number(workerPid))
    ) {
      return true;
    }
    await delay(25);
  }
  return (
    !isProcessRunning(Number(hostPid)) && !isProcessRunning(Number(workerPid))
  );
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
    socket.on('close', () => {
      finish(undefined, new Error('Agent View PTY host connection closed.'));
    });
  });
}

export function createAgentViewPtyHostServer(
  host: AgentViewPtyHostHandle,
  socketPath: string,
  options: { authToken?: string; generation?: number } = {},
): { listen(): Promise<void>; close(): Promise<void> } {
  let workerExit: AgentViewPtyHostExit | undefined;
  void host.exited.then(
    (exit) => {
      workerExit = exit;
    },
    () => {},
  );
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
        options.generation ?? 1,
        () => workerExit,
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
          server.on('error', () => {});
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
      await removeOwnedSocketPath(socketPath);
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
  generation = 1,
  getWorkerExit: () => AgentViewPtyHostExit | undefined = () => undefined,
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
    const result = await handleHostRequest(
      host,
      request,
      generation,
      getWorkerExit(),
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
  generation: number,
  workerExit?: AgentViewPtyHostExit,
): Promise<unknown> {
  switch (request.op) {
    case 'status':
      return {
        pid: process.pid,
        workerPid: host.workerPid,
        generation,
        workerExited: Boolean(workerExit),
        ...(workerExit ? { workerExitCode: workerExit.exitCode } : {}),
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
): Promise<AgentViewPtyHostStatus> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const abortController = new AbortController();
    const cleanup = () => {
      abortController.abort();
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const finishResolve = (value: AgentViewPtyHostStatus) => {
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
): Promise<AgentViewPtyHostStatus> {
  const requestTimeoutMs = options.requestTimeoutMs ?? 5000;
  // Model the deadline as a wall-clock budget covering each probe's delay
  // and request timeout, so slow probes cannot silently exhaust retries.
  const deadlineMs =
    Date.now() + retries * (HOST_READY_DELAY_MS + requestTimeoutMs);
  while (!options.signal?.aborted && Date.now() < deadlineMs) {
    try {
      const result = await callAgentViewPtyHost(
        socketPath,
        authToken,
        'status',
        undefined,
        requestTimeoutMs,
      );
      if (
        isRecord(result) &&
        Number.isSafeInteger(result['pid']) &&
        Number(result['pid']) > 0 &&
        Number.isSafeInteger(result['workerPid']) &&
        Number(result['workerPid']) > 0 &&
        Number.isSafeInteger(result['generation']) &&
        Number(result['generation']) > 0
      ) {
        return {
          pid: Number(result['pid']),
          workerPid: Number(result['workerPid']),
          generation: Number(result['generation']),
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
  replaceEnvironment = false,
): ChildProcess {
  const argv = buildCurrentQwenCliArgv(args);
  return spawn(argv[0]!, argv.slice(1), {
    detached: true,
    stdio: 'ignore',
    env: {
      ...(replaceEnvironment ? {} : process.env),
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

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EPERM'
    );
  }
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
