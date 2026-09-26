/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Production wiring: the processes, sockets and files the agent touches. */

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import WebSocket, { type RawData } from 'ws';
import {
  AcpRelay,
  type AcpRelayEnd,
  type OpenRelaySocket,
} from './acp-relay.js';
import {
  serveConnection,
  type ConnectRequest,
  type RelayRecord,
  type RelayRecordPhase,
} from './agent.js';
import { askConsent, notify } from './consent.js';
import { DESKTOP_RELAY_PORT } from './constants.js';
import { McpChildRelay, type ChildChannel } from './mcp-child-relay.js';

/** `dist/index.js`: started without arguments it is the plain node_repl server. */
export function nodeReplEntry(): string {
  return fileURLToPath(new URL('../index.js', import.meta.url));
}

export function packageVersion(): string {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Starts node_repl with `cwd` as its cell base, so `@qwen-code/cua-sdk`
 * resolves from the runtime installed next to it.
 */
export function spawnNodeRepl(cwd: string): ChildChannel {
  const child = spawn(process.execPath, [nodeReplEntry()], {
    cwd,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let messageListener: ((message: unknown) => void) | undefined;
  const exitListeners: Array<(reason: string) => void> = [];
  let exited = false;
  const onExit = (reason: string) => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener(reason);
  };
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    try {
      messageListener?.(JSON.parse(line));
    } catch {
      // Not a JSON-RPC line.
    }
  });
  // A write after exit fails with EPIPE; the exit event already reports it.
  child.stdin.on('error', () => undefined);
  child.on('exit', (code, signal) =>
    onExit(signal ? `signal ${signal}` : `exit code ${code}`),
  );
  child.on('error', (error) => onExit(error.message));
  return {
    send: (message) => {
      if (!exited) child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    onMessage: (listener) => {
      messageListener = listener;
    },
    onExit: (listener) => {
      exitListeners.push(listener);
    },
    close: () => {
      child.stdin.end();
      child.kill('SIGTERM');
    },
  };
}

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

export const openWsSocket: OpenRelaySocket = (url, headers, handlers) => {
  // `ws` sends no Origin header unless asked, which keeps the daemon's
  // cross-site check out of the way for this non-browser client.
  const ws = new WebSocket(url, { headers, handshakeTimeout: 15_000 });
  let failure: string | undefined;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  const refreshHeartbeat = () => {
    clearTimeout(heartbeat);
    // The daemon pings every 15 s; allow two intervals plus network latency.
    heartbeat = setTimeout(() => {
      failure = 'The daemon stopped sending heartbeat pings.';
      ws.terminate();
    }, 35_000);
  };
  ws.on('open', () => {
    refreshHeartbeat();
    handlers.open();
  });
  ws.on('ping', refreshHeartbeat);
  ws.on('message', (data) => handlers.message(rawToString(data)));
  ws.on('error', (error) => {
    failure = error.message;
  });
  ws.on('close', (code, reason) => {
    clearTimeout(heartbeat);
    handlers.close(code, reason.toString('utf8') || failure || '');
  });
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
  };
};

export interface RecordStore {
  read(): RelayRecord | undefined;
  write(record: RelayRecord): void;
}

export function createRecordStore(home: string): RecordStore {
  const file = path.join(home, 'active.json');
  return {
    read: () => {
      try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8')) as RelayRecord;
        return typeof value.origin === 'string' &&
          typeof value.sessionId === 'string'
          ? value
          : undefined;
      } catch {
        return undefined;
      }
    },
    write: (record) => {
      fs.mkdirSync(home, { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
        mode: 0o600,
      });
      fs.renameSync(temporary, file);
    },
  };
}

export function ownsRelayProcess(
  pid: number,
  processIdentity: string,
): boolean {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
  });
  return result.status === 0 && result.stdout.trim() === processIdentity;
}

function endMessage(
  end: AcpRelayEnd,
  childExit: string | undefined,
): { phase: RelayRecordPhase; message?: string } {
  if (childExit !== undefined) {
    return { phase: 'failed', message: `node_repl exited (${childExit})` };
  }
  switch (end.reason) {
    case 'failed':
      return { phase: 'failed', message: `${end.code}: ${end.message}` };
    case 'closed':
      return { phase: 'stopped', message: `connection closed (${end.detail})` };
    default:
      return { phase: 'stopped' };
  }
}

async function runRelay(
  request: ConnectRequest,
  home: string,
  store: RecordStore,
): Promise<void> {
  const host = new URL(request.daemonUrl).host;
  // A replacement relay owns the record once it has written its own pid.
  const update = (phase: RelayRecordPhase, message?: string) => {
    const current = store.read();
    if (current?.pid !== process.pid) return;
    store.write({
      pid: phase === 'stopped' || phase === 'failed' ? null : process.pid,
      processIdentity: current.processIdentity,
      origin: current.origin,
      daemonUrl: current.daemonUrl,
      sessionId: current.sessionId,
      phase,
      ...(message === undefined ? {} : { message }),
      updatedAt: new Date().toISOString(),
    });
  };

  const child = spawnNodeRepl(home);
  const mcp = new McpChildRelay(child);
  const relay = new AcpRelay({
    daemonUrl: request.daemonUrl,
    sessionId: request.sessionId,
    ...(request.token === undefined ? {} : { token: request.token }),
    ...(request.workspace === undefined
      ? {}
      : { workspace: request.workspace }),
    clientVersion: packageVersion(),
    rpc: mcp,
    openSocket: openWsSocket,
    onPhase: (phase) => {
      update(phase);
      if (phase === 'connected') {
        void notify(
          `A Qwen Code session on ${host} is now using this computer. Disconnect it from the Web Shell to stop.`,
        );
      }
    },
  });

  let closing = false;
  let childExit: string | undefined;
  child.onExit((reason) => {
    if (closing) return;
    childExit = reason;
    relay.stop();
  });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.once(signal, () => relay.stop());
  }

  const end = await relay.run();
  closing = true;
  mcp.close();
  const { phase, message } = endMessage(end, childExit);
  update(phase, message);
  await notify(`The Qwen Code session on ${host} stopped using this computer.`);
}

/** Serves the connection launchd accepted and handed over as stdin/stdout. */
export async function runAgent(home: string): Promise<void> {
  // Under launchd the accepted connection is stdin and stdout; nothing on
  // this path writes to stdout, so the socket carries only the reply.
  const socket = new net.Socket({ fd: 0, readable: true, writable: true });
  const store = createRecordStore(home);
  const processIdentity = `qwen-desktop-relay-${randomBytes(8).toString('hex')}`;
  process.title = processIdentity;
  await serveConnection(socket, {
    http: {
      port: DESKTOP_RELAY_PORT,
      version: packageVersion(),
      pid: process.pid,
      processIdentity,
      askConsent: (message) => askConsent(message),
      readRecord: store.read,
      writeRecord: store.write,
      ownsProcess: ownsRelayProcess,
      terminate: (pid) => {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // Already gone.
        }
      },
      startRelay: (request) => runRelay(request, home, store),
    },
  });
}
