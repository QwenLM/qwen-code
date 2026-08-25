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

export interface WebTerminalWorkspaceContext {
  workspaceCwd: string;
  env: Readonly<NodeJS.ProcessEnv>;
}

type TerminalControl =
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'release' };

function sendOutput(ws: WebSocket, text: string): void {
  if (ws.readyState === ws.OPEN) ws.send(Buffer.from(text));
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
    // Not a valid control frame; preserve it as terminal input.
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
      const url = new URL(req.url ?? '', 'http://localhost');
      const terminalId = url.searchParams.get('terminalId');
      const selector = url.searchParams.get('cwd');
      const workspace = selector ? resolveWorkspace(selector) : undefined;
      if (!terminalId || terminalId.length > 256 || !selector || !workspace) {
        sendControl(ws, {
          type: 'error',
          message: 'Terminal workspace unavailable',
        });
        ws.close(4002, 'Terminal workspace unavailable');
        return;
      }
      const workspaceSelector = selector;

      let closed = false;
      let created = false;
      let inputRejected = false;
      let releaseRequested = false;
      let pendingBytes = 0;
      const pending: Array<{ text: string; isBinary: boolean }> = [];
      const markClosed = () => {
        closed = true;
      };
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
          ws.close(4001, 'Terminal input too large');
          return;
        }
        pending.push({ text, isBinary });
      };
      ws.once('close', markClosed);
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
        detach.output?.();
        detach.exit?.();
        ws.off('message', onMessage);
      };
      const finishExited = (exitCode: number | undefined) => {
        sendControl(ws, { type: 'exit', exitCode });
        cleanup();
        ws.close(4000, 'Terminal exited');
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
          const currentWorkspace = resolveWorkspace(workspaceSelector);
          if (currentWorkspace?.workspaceCwd !== workspace.workspaceCwd) {
            sendControl(ws, {
              type: 'error',
              message: 'Terminal workspace unavailable',
            });
            cleanup();
            registry.release(terminalId, workspace.workspaceCwd);
            ws.close(4002, 'Terminal workspace unavailable');
            return;
          }
          registry.resize(terminalId, control.cols, control.rows);
          return;
        }
        const currentWorkspace = resolveWorkspace(workspaceSelector);
        if (currentWorkspace?.workspaceCwd !== workspace.workspaceCwd) {
          sendControl(ws, {
            type: 'error',
            message: 'Terminal workspace unavailable',
          });
          cleanup();
          registry.release(terminalId, workspace.workspaceCwd);
          ws.close(4002, 'Terminal workspace unavailable');
          return;
        }
        registry.write(terminalId, text);
      };

      detach.output = registry.addOutputListener(terminalId, (data) =>
        sendOutput(ws, data),
      );
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
      ws.on('error', cleanup);
      sendOutput(ws, snapshot.output);
      if (snapshot.exited) {
        finishExited(snapshot.exitCode);
        return;
      }
      for (const message of pending) {
        onMessage(message.text, message.isBinary);
      }
    },
  };
}

export { TERMINAL_WS_PATH };
