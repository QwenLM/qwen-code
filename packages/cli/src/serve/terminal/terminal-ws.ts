/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Daemon `/terminal` WebSocket — attaches the browser to a
 * tmux-backed shell task (created by the core tmux tool) so the Web Shell
 * can render a live interactive terminal.
 *
 * Registered as an `ExtraWsRoute` on the daemon's single WS upgrade
 * listener, so it inherits the loopback / host-allowlist / CSRF /
 * bearer-token checks. The path is static (`/terminal`) because extra
 * routes match exactly; the session and task are query params:
 *   `/terminal?sessionId=<id>&taskId=<bg_xxx>`
 *
 * Protocol — client → server:
 *   - text  `{"type":"hello","cols":N,"rows":N}`  initial size (first frame)
 *   - text  `{"type":"resize","cols":N,"rows":N}` resize the pty
 *   - binary  raw keystroke bytes → pty stdin
 *
 * server → client:
 *   - text  `{"type":"ready"}`    attach established; safe to send input
 *   - binary  raw pty output bytes (render with xterm.js)
 *   - text  `{"type":"error","message":string}`  fatal; socket closes
 *
 * The attach target is validated against the live task registry: only a
 * running shell task carrying `terminal` metadata (i.e. created by the
 * tmux tool) can be attached — never an arbitrary host tmux session.
 */

import type { IncomingMessage } from 'node:http';
import type { RawData, WebSocket } from 'ws';
import { createDebugLogger, getPty } from '@qwen-code/qwen-code-core';
import type { DaemonLogger } from '../daemon-logger.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';

const debugLogger = createDebugLogger('TERMINAL_WS');

/** Concurrent terminal sockets per session. */
const MAX_TERMINAL_SOCKETS_PER_SESSION = 4;
/** Hard lifetime of one terminal connection. */
const MAX_CONNECTION_MS = 60 * 60_000;
/** Backpressure bound on unsent pty output buffered in the socket. */
const MAX_BUFFERED_OUTPUT_BYTES = 16 * 1024 * 1024;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_DIMENSION = 500;

/** Minimal pty surface this handler needs (subset of @lydell/node-pty). */
export interface TerminalAttachProcess {
  onData(callback: (data: string) => void): void;
  onExit(callback: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/** Injection seams for unit tests; production spawns a real pty attach. */
export interface TerminalWsDeps {
  workspaceRegistry: WorkspaceRegistry;
  daemonLog?: DaemonLogger;
  spawnAttach?: (
    socket: string,
    tmuxSession: string,
    cols: number,
    rows: number,
  ) => Promise<TerminalAttachProcess>;
}

function defaultSpawnAttach(
  socket: string,
  tmuxSession: string,
  cols: number,
  rows: number,
): Promise<TerminalAttachProcess> {
  return (async () => {
    const pty = await getPty();
    if (!pty) {
      throw new Error('node-pty is unavailable on this platform.');
    }
    const proc = pty.module.spawn(
      'tmux',
      ['-L', socket, 'attach-session', '-t', tmuxSession],
      {
        name: 'xterm-256color',
        cols,
        rows,
        env: { ...process.env, TERM: 'xterm-256color' },
      },
    ) as TerminalAttachProcess;
    return proc;
  })();
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

interface ControlMessage {
  type: 'hello' | 'resize';
  cols: number;
  rows: number;
}

function clampDimension(value: unknown, fallback: number): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_DIMENSION
    ? value
    : fallback;
}

function parseControl(text: string): ControlMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const type = (parsed as { type?: unknown })?.type;
  if (type !== 'hello' && type !== 'resize') return undefined;
  const cols = clampDimension(
    (parsed as { cols?: unknown }).cols,
    DEFAULT_COLS,
  );
  const rows = clampDimension(
    (parsed as { rows?: unknown }).rows,
    DEFAULT_ROWS,
  );
  return { type, cols, rows };
}

/**
 * Build the per-connection handler for the daemon `/terminal` WebSocket.
 */
export function createTerminalWsConnectionHandler(
  deps: TerminalWsDeps,
): (ws: WebSocket, req: IncomingMessage) => void {
  const spawnAttach = deps.spawnAttach ?? defaultSpawnAttach;
  const activePerSession = new Map<string, number>();

  const resolveRuntime = (sessionId: string): WorkspaceRuntime | undefined => {
    const registry = deps.workspaceRegistry;
    if (registry.listEntries().length === 1) {
      const entry = registry.primaryEntry;
      return entry.state === 'active' ? entry.current?.runtime : undefined;
    }
    const resolution = registry.resolveLiveSessionOwner(sessionId);
    if (resolution.kind !== 'found') return undefined;
    const runtime = resolution.runtime;
    if (!runtime.primary && !runtime.trusted) return undefined;
    return runtime;
  };

  return (ws: WebSocket, req: IncomingMessage) => {
    const sendJson = (obj: unknown): void => {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(JSON.stringify(obj));
        } catch {
          // socket already going away
        }
      }
    };

    const reject = (code: number, message: string): void => {
      deps.daemonLog?.warn('terminal websocket rejected', { message });
      sendJson({ type: 'error', message });
      try {
        ws.close(code, message.slice(0, 120));
      } catch {
        // ignore
      }
    };

    const url = new URL(req.url ?? '', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId') ?? '';
    const taskId = url.searchParams.get('taskId') ?? '';
    if (!sessionId || !taskId) {
      reject(4008, 'terminal requires sessionId and taskId query params.');
      return;
    }

    const activeCount = activePerSession.get(sessionId) ?? 0;
    if (activeCount >= MAX_TERMINAL_SOCKETS_PER_SESSION) {
      reject(
        1013,
        `Too many terminal connections for this session (max ${MAX_TERMINAL_SOCKETS_PER_SESSION}).`,
      );
      return;
    }

    const hardTimer = setTimeout(() => {
      sendJson({ type: 'error', message: 'Terminal connection timed out.' });
      try {
        ws.close(1000, 'terminal connection time limit');
      } catch {
        // ignore
      }
    }, MAX_CONNECTION_MS);
    hardTimer.unref?.();

    let closed = false;
    let proc: TerminalAttachProcess | undefined;
    const cleanup = (): void => {
      closed = true;
      clearTimeout(hardTimer);
      const count = (activePerSession.get(sessionId) ?? 1) - 1;
      if (count <= 0) {
        activePerSession.delete(sessionId);
      } else {
        activePerSession.set(sessionId, count);
      }
      if (proc) {
        try {
          proc.kill();
        } catch {
          // best effort
        }
        proc = undefined;
      }
    };

    ws.on('close', cleanup);
    ws.on('error', (error: Error) => {
      debugLogger.debug(`[terminal-ws] socket error: ${error.message}`);
      cleanup();
    });

    void (async () => {
      const runtime = resolveRuntime(sessionId);
      if (!runtime) {
        reject(4004, `No live session with id "${sessionId}".`);
        return;
      }

      let attachTarget: { socket: string; tmuxSession: string } | undefined;
      try {
        const tasksStatus =
          await runtime.bridge.getSessionTasksStatus(sessionId);
        const task = tasksStatus.tasks.find((t) => t.id === taskId);
        if (
          task &&
          task.kind === 'shell' &&
          task.status === 'running' &&
          task.terminal
        ) {
          attachTarget = task.terminal;
        }
      } catch (error) {
        debugLogger.debug(
          `[terminal-ws] task lookup failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (!attachTarget) {
        reject(
          4004,
          `No running terminal task with id "${taskId}" in this session.`,
        );
        return;
      }
      if (closed) return;

      activePerSession.set(sessionId, activeCount + 1);

      try {
        proc = await spawnAttach(
          attachTarget.socket,
          attachTarget.tmuxSession,
          DEFAULT_COLS,
          DEFAULT_ROWS,
        );
      } catch (error) {
        cleanup();
        reject(
          1011,
          `Failed to attach terminal: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }
      if (closed) {
        cleanup();
        return;
      }

      proc.onData((data: string) => {
        if (closed || ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > MAX_BUFFERED_OUTPUT_BYTES) {
          writeStderrLine(
            'qwen serve: terminal websocket closed (output backpressure)',
          );
          cleanup();
          try {
            ws.close(1013, 'output backpressure');
          } catch {
            // ignore
          }
          return;
        }
        try {
          ws.send(Buffer.from(data, 'utf8'));
        } catch {
          // socket going away
        }
      });

      proc.onExit(() => {
        if (closed) return;
        cleanup();
        try {
          ws.close(1000, 'terminal exited');
        } catch {
          // ignore
        }
      });

      ws.on('message', (data: RawData, isBinary: boolean) => {
        if (closed || !proc) return;
        const buf = toBuffer(data);
        if (isBinary) {
          try {
            proc.write(buf.toString('utf8'));
          } catch {
            // pty going away
          }
          return;
        }
        const control = parseControl(buf.toString('utf8'));
        if (!control) return;
        try {
          proc.resize(control.cols, control.rows);
        } catch {
          // pty going away
        }
      });

      sendJson({ type: 'ready' });
      writeStderrLine(
        `qwen serve: terminal websocket attached (session=${sessionId} task=${taskId})`,
      );
    })();
  };
}
