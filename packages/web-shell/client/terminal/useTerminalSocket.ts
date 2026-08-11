/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * WebSocket client for the daemon `/terminal` endpoint — attaches to a
 * tmux-backed shell task (created by the core tmux tool) and streams raw
 * pty bytes both ways. The bearer subprotocol is verified by the daemon's
 * ACP upgrade listener in `serve/acp-http/index.ts` (same pattern as
 * `useVoiceCapture`).
 *
 * Protocol:
 *   server → client: text `{"type":"ready"}`, binary pty output,
 *                    text `{"type":"error","message"}` (fatal)
 *   client → server: text `{"type":"hello"|"resize","cols":N,"rows":N}`,
 *                    binary keystroke bytes
 */
export type TerminalSocketStatus = 'connecting' | 'ready' | 'closed' | 'error';

export interface UseTerminalSocketOptions {
  baseUrl: string;
  token?: string;
  sessionId: string;
  taskId: string;
  /** Connect only when true (default). */
  enabled?: boolean;
  /** Binary pty output from the daemon. */
  onOutput: (chunk: Uint8Array) => void;
}

export interface UseTerminalSocketReturn {
  status: TerminalSocketStatus;
  errorMessage: string | undefined;
  /** Keystroke bytes → pty stdin. Buffered until the server is ready. */
  sendInput: (data: string) => void;
  /** Report (and remember) the terminal dimensions. */
  resize: (cols: number, rows: number) => void;
  /** Tear down and open a fresh connection. */
  reconnect: () => void;
}

// Keep in sync with the daemon upgrade listener (serve/acp-http/index.ts).
const WS_BEARER_SUBPROTOCOL_PREFIX = 'qwen-bearer.';
const WS_AUTH_SUBPROTOCOL = 'qwen-ws';

/**
 * A stalled handshake (middlebox holding the socket open without returning
 * 101) fires no onerror/onclose; without a timeout the panel would hang on
 * 'Connecting…' until page reload.
 */
const CONNECT_TIMEOUT_MS = 10_000;

function bearerSubprotocol(token: string): string {
  const bytes = new TextEncoder().encode(token);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const b64 = btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${WS_BEARER_SUBPROTOCOL_PREFIX}${b64}`;
}

export function toTerminalWebSocketUrl(
  baseUrl: string,
  sessionId: string,
  taskId: string,
): string {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/?$/, '/');
  const url = new URL('terminal', `${base.origin}${basePath}`);
  url.searchParams.set('sessionId', sessionId);
  url.searchParams.set('taskId', taskId);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function useTerminalSocket({
  baseUrl,
  token,
  sessionId,
  taskId,
  enabled = true,
  onOutput,
}: UseTerminalSocketOptions): UseTerminalSocketReturn {
  const [status, setStatus] = useState<TerminalSocketStatus>('connecting');
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [generation, setGeneration] = useState(0);

  const wsRef = useRef<WebSocket | undefined>(undefined);
  const statusRef = useRef<TerminalSocketStatus>('connecting');
  const sizeRef = useRef<{ cols: number; rows: number }>({
    cols: 80,
    rows: 24,
  });
  const pendingInputRef = useRef<string[]>([]);
  const lastTargetRef = useRef<string | undefined>(undefined);
  const onOutputRef = useRef(onOutput);
  onOutputRef.current = onOutput;

  const applyStatus = useCallback((next: TerminalSocketStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  useEffect(() => {
    if (!enabled || !baseUrl || !sessionId || !taskId) {
      // A previously-established connection was disabled (e.g. the session
      // id cleared on a daemon disconnect); the prior effect's cleanup has
      // already closed the socket. Surface the closed state instead of
      // leaving the panel rendering 'ready', and drop buffered keystrokes
      // plus the target identity so nothing typed while dead is flushed
      // into whatever terminal connects next.
      pendingInputRef.current = [];
      lastTargetRef.current = undefined;
      applyStatus('closed');
      return undefined;
    }

    applyStatus('connecting');
    setErrorMessage(undefined);
    // Drop buffered keystrokes only when the target terminal changed; a
    // reconnect() to the SAME terminal must still deliver them.
    const targetKey = `${baseUrl}\u0000${sessionId}\u0000${taskId}`;
    if (lastTargetRef.current !== targetKey) {
      pendingInputRef.current = [];
    }
    lastTargetRef.current = targetKey;

    const ws = new WebSocket(
      toTerminalWebSocketUrl(baseUrl, sessionId, taskId),
      token ? [WS_AUTH_SUBPROTOCOL, bearerSubprotocol(token)] : undefined,
    );
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    let disposed = false;

    const connectTimer = setTimeout(() => {
      if (disposed || statusRef.current !== 'connecting') return;
      setErrorMessage('Terminal connection timed out.');
      applyStatus('error');
      try {
        ws.close();
      } catch {
        // Best-effort teardown of the stalled handshake.
      }
    }, CONNECT_TIMEOUT_MS);

    const flushPendingInput = (): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const pending = pendingInputRef.current;
      if (pending.length === 0) return;
      pendingInputRef.current = [];
      ws.send(new TextEncoder().encode(pending.join('')));
    };

    ws.onmessage = (event: MessageEvent) => {
      if (disposed) return;
      if (typeof event.data !== 'string') {
        onOutputRef.current(new Uint8Array(event.data as ArrayBuffer));
        return;
      }
      let message: { type?: string; message?: string };
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === 'ready') {
        clearTimeout(connectTimer);
        applyStatus('ready');
        try {
          ws.send(
            JSON.stringify({
              type: 'hello',
              cols: sizeRef.current.cols,
              rows: sizeRef.current.rows,
            }),
          );
        } catch {
          // The socket may have closed between the ready frame and here.
        }
        flushPendingInput();
      } else if (message.type === 'error') {
        setErrorMessage(message.message ?? 'Terminal connection failed.');
        applyStatus('error');
      }
    };

    ws.onerror = () => {
      // The close event carries the useful code and reason.
    };

    ws.onclose = (event: CloseEvent) => {
      if (disposed) return;
      // An error frame already set the terminal state; otherwise a close
      // means the tmux session ended (1000) or the connection dropped.
      if (statusRef.current !== 'error') {
        applyStatus('closed');
        if (event.code !== 1000) {
          setErrorMessage(
            `Terminal connection closed (code=${event.code || 1006}${
              event.reason ? `, reason=${event.reason}` : ''
            }).`,
          );
        }
      }
    };

    return () => {
      disposed = true;
      clearTimeout(connectTimer);
      wsRef.current = undefined;
      try {
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.close();
      } catch {
        // Best-effort browser resource cleanup.
      }
    };
  }, [applyStatus, baseUrl, enabled, generation, sessionId, taskId, token]);

  const sendInput = useCallback((data: string) => {
    if (statusRef.current !== 'ready') {
      pendingInputRef.current.push(data);
      return;
    }
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      pendingInputRef.current.push(data);
      return;
    }
    try {
      ws.send(new TextEncoder().encode(data));
    } catch {
      pendingInputRef.current.push(data);
    }
  }, []);

  const resize = useCallback((cols: number, rows: number) => {
    sizeRef.current = { cols, rows };
    if (statusRef.current !== 'ready') return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    } catch {
      // The socket may have closed between the readyState check and send.
    }
  }, []);

  const reconnect = useCallback(() => {
    setGeneration((value) => value + 1);
  }, []);

  return { status, errorMessage, sendInput, resize, reconnect };
}
