/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage } from 'node:http';
import type { WebTerminalRegistry } from '@qwen-code/qwen-code-core';
import type { WebSocket } from 'ws';
import type { ExtraWsRoute } from '../acp-http/index.js';

const TERMINAL_WS_PATH = '/terminal';
const CONTROL_FRAME_PREFIX = '\x00';
const MAX_PENDING_INPUT_BYTES = 64 * 1024;
const MAX_TERMINAL_DIMENSION = 1000;
const MAX_SOCKET_BUFFERED_BYTES = 8 * 1024 * 1024;
const TERMINAL_HEARTBEAT_MS = 15_000;

export interface WebTerminalWorkspaceContext {
  workspaceCwd: string;
  env: Readonly<NodeJS.ProcessEnv>;
}

type TerminalControl =
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'release' };

function sendOutput(ws: WebSocket, text: string): boolean {
  if (
    ws.readyState !== ws.OPEN ||
    ws.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES
  ) {
    return false;
  }
  ws.send(Buffer.from(text));
  return true;
}

function sendControl(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(CONTROL_FRAME_PREFIX + JSON.stringify(payload));
  }
}

function parseControl(data: string): TerminalControl | null {
  if (!data.startsWith(CONTROL_FRAME_PREFIX)) return null;
  try {
    const parsed = JSON.parse(data.slice(CONTROL_FRAME_PREFIX.length)) as {
      type?: unknown;
      cols?: unknown;
      rows?: unknown;
    };
    if (parsed.type === 'release') return { type: 'release' };
    if (
      parsed.type === 'resize' &&
      Number.isInteger(parsed.cols) &&
      Number.isInteger(parsed.rows) &&
      (parsed.cols as number) > 0 &&
      (parsed.rows as number) > 0 &&
      (parsed.cols as number) <= MAX_TERMINAL_DIMENSION &&
      (parsed.rows as number) <= MAX_TERMINAL_DIMENSION
    ) {
      return {
        type: 'resize',
        cols: parsed.cols as number,
        rows: parsed.rows as number,
      };
    }
  } catch {
    // Malformed control frames are dropped by the caller.
  }
  return null;
}

function toText(data: unknown): string {
  return typeof data === 'string'
    ? data
    : Buffer.isBuffer(data)
      ? data.toString('utf8')
      : Array.isArray(data)
        ? Buffer.concat(data.map((chunk) => Buffer.from(chunk))).toString(
            'utf8',
          )
        : '';
}

export function createTerminalWsHandler(
  registry: WebTerminalRegistry,
  resolveWorkspace: (
    selector: string,
  ) => WebTerminalWorkspaceContext | undefined,
): ExtraWsRoute {
  return {
    path: TERMINAL_WS_PATH,
    bypassPrimaryDrain: true,
    onConnection: async (ws: WebSocket, req: IncomingMessage) => {
      let closed = false;
      let alive = true;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const onPong = () => {
        alive = true;
      };
      const stopHeartbeat = () => {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = undefined;
        ws.off('pong', onPong);
      };
      const terminate = () => {
        stopHeartbeat();
        try {
          ws.terminate();
        } catch {
          // Socket is already gone.
        }
      };
      const markClosed = () => {
        closed = true;
        stopHeartbeat();
      };
      ws.on('error', markClosed);
      ws.once('close', markClosed);
      ws.on('pong', onPong);
      heartbeat = setInterval(() => {
        if (!alive) {
          terminate();
          return;
        }
        alive = false;
        try {
          ws.ping();
        } catch {
          terminate();
        }
      }, TERMINAL_HEARTBEAT_MS);
      heartbeat.unref();
      const url = new URL(req.url ?? '', 'http://localhost');
      const terminalId = url.searchParams.get('terminalId');
      const selector = url.searchParams.get('cwd');
      const releaseOnly = url.searchParams.get('release') === '1';
      const workspace = selector ? resolveWorkspace(selector) : undefined;
      if (!terminalId || terminalId.length > 256 || !selector || !workspace) {
        sendControl(ws, {
          type: 'error',
          message: 'Terminal workspace unavailable',
        });
        ws.close(4002, 'Terminal workspace unavailable');
        return;
      }
      if (releaseOnly) {
        registry.release(terminalId, workspace.workspaceCwd);
        ws.close(4004, 'Terminal released');
        return;
      }
      const workspaceSelector = selector;

      let created = false;
      let inputRejected = false;
      let releaseRequested = false;
      let pendingBytes = 0;
      const pending: Array<{ text: string; isBinary: boolean }> = [];
      const bufferMessage = (data: unknown, isBinary = false) => {
        const text = toText(data);
        if (!isBinary && parseControl(text)?.type === 'release') {
          releaseRequested = true;
        }
        pendingBytes += Buffer.byteLength(text);
        if (pendingBytes > MAX_PENDING_INPUT_BYTES) {
          inputRejected = true;
          sendControl(ws, {
            type: 'error',
            message: 'Terminal input too large',
          });
          ws.close(1013, 'Terminal input too large');
          return;
        }
        pending.push({ text, isBinary });
      };
      ws.on('message', bufferMessage);

      let snapshot = registry.readSnapshot(terminalId);
      if (snapshot && snapshot.workspaceCwd !== workspace.workspaceCwd) {
        sendControl(ws, {
          type: 'error',
          message: 'Terminal workspace mismatch',
        });
        ws.close(4002, 'Terminal workspace mismatch');
        return;
      }

      if (!snapshot) {
        let result;
        try {
          result = await registry.create({
            terminalId,
            workspaceCwd: workspace.workspaceCwd,
            env: workspace.env,
          });
        } catch {
          result = { error: 'Failed to create terminal' } as const;
        }
        if ('error' in result) {
          if (releaseRequested) {
            registry.release(terminalId, workspace.workspaceCwd);
            ws.close(4004, 'Terminal released');
            return;
          }
          if (result.retryable) {
            ws.close(1013, 'Terminal is being created');
            return;
          }
          sendControl(ws, { type: 'error', message: result.error });
          ws.close(4001, 'Terminal unavailable');
          return;
        }
        created = true;
      }

      if (releaseRequested) {
        registry.release(terminalId, workspace.workspaceCwd);
        ws.close(4004, 'Terminal released');
        return;
      }
      if (closed || inputRejected) {
        if (created && inputRejected) {
          registry.release(terminalId, workspace.workspaceCwd);
        }
        return;
      }

      let cleaned = false;
      const detach: { output?: () => void; exit?: () => void } = {};
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        stopHeartbeat();
        detach.output?.();
        detach.exit?.();
        ws.off('message', onMessage);
      };
      const finishExited = (
        exitCode: number | undefined,
        releaseAfterReplay = false,
      ) => {
        sendControl(ws, { type: 'exit', exitCode });
        cleanup();
        if (releaseAfterReplay)
          registry.release(terminalId, workspace.workspaceCwd);
        ws.close(4000, 'Terminal exited');
      };
      const ensureWorkspaceAvailable = () => {
        if (
          resolveWorkspace(workspaceSelector)?.workspaceCwd ===
          workspace.workspaceCwd
        ) {
          return true;
        }
        sendControl(ws, {
          type: 'error',
          message: 'Terminal workspace unavailable',
        });
        cleanup();
        ws.close(4002, 'Terminal workspace unavailable');
        return false;
      };
      const onMessage = (data: unknown, isBinary = false) => {
        const text = toText(data);
        const control = isBinary ? null : parseControl(text);
        if (!isBinary && text.startsWith(CONTROL_FRAME_PREFIX) && !control) {
          return;
        }
        if (control?.type === 'release') {
          cleanup();
          registry.release(terminalId, workspace.workspaceCwd);
          ws.close(4004, 'Terminal released');
          return;
        }
        if (control?.type === 'resize') {
          if (!ensureWorkspaceAvailable()) return;
          registry.resize(terminalId, control.cols, control.rows);
          return;
        }
        if (!ensureWorkspaceAvailable()) return;
        const writeResult = registry.write(terminalId, text);
        if (writeResult !== 'written') {
          sendControl(ws, {
            type: 'error',
            message:
              writeResult === 'backpressure'
                ? 'Terminal input backpressure'
                : 'Session unavailable',
          });
          cleanup();
          ws.close(
            writeResult === 'backpressure' ? 1013 : 4002,
            writeResult === 'backpressure'
              ? 'Terminal input backpressure'
              : 'Session unavailable',
          );
        }
      };

      detach.output = registry.addOutputListener(terminalId, (data) => {
        if (!ensureWorkspaceAvailable()) return;
        if (!sendOutput(ws, data)) {
          cleanup();
          ws.close(1013, 'Terminal output backpressure');
        }
      });
      if (!detach.output) {
        sendControl(ws, { type: 'error', message: 'Session unavailable' });
        ws.close(4002, 'Session unavailable');
        return;
      }
      detach.exit = registry.addExitListener(terminalId, (event) =>
        finishExited(event.exitCode),
      );
      snapshot = registry.readSnapshot(terminalId);
      if (!snapshot || snapshot.workspaceCwd !== workspace.workspaceCwd) {
        cleanup();
        sendControl(ws, { type: 'error', message: 'Session unavailable' });
        ws.close(4002, 'Session unavailable');
        return;
      }

      ws.off('message', bufferMessage);
      ws.on('message', onMessage);
      ws.on('close', cleanup);
      ws.off('error', markClosed);
      ws.on('error', cleanup);
      if (!ensureWorkspaceAvailable()) return;
      if (!sendOutput(ws, snapshot.output)) {
        cleanup();
        ws.close(1013, 'Terminal output backpressure');
        return;
      }
      if (snapshot.exited) {
        finishExited(snapshot.exitCode, true);
        return;
      }
      for (const message of pending) {
        onMessage(message.text, message.isBinary);
      }
    },
  };
}

export { TERMINAL_WS_PATH };
