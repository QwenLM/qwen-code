/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useWorkspace } from '@qwen-code/web-shell/daemon-react-sdk';
import '@xterm/xterm/css/xterm.css';
import { useTheme, type WebShellTheme } from '../../themeContext';
import { getDaemonToken } from '../../config/daemon';
import { useI18n } from '../../i18n';

interface TerminalPanelProps {
  /** Stable id shared with the backend PTY session; reconnects reuse it. */
  terminalId: string;
  cwd?: string;
  active?: boolean;
  enabled?: boolean;
}

const CONTROL_FRAME_PREFIX = '\x00';
/** Exponential backoff bounds for automatic WebSocket reconnection. */
const RECONNECT_INITIAL_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const NON_RETRYABLE_CLOSE_CODES = new Set([4000, 4001, 4002, 4004]);
const releaseCallbacks = new Map<string, () => void>();

export function releaseWebTerminal(terminalId: string): void {
  releaseCallbacks.get(terminalId)?.();
}

export function releaseDetachedWebTerminal(
  baseUrl: string,
  terminalId: string,
  cwd?: string,
): void {
  const ws = new WebSocket(
    buildWsUrl(baseUrl, terminalId, cwd, true),
    wsProtocols(),
  );
  ws.onerror = () => ws.close();
}

// Browsers cannot set Authorization on a WebSocket. The daemon decodes this
// bearer subprotocol during the upgrade; keep the prefix in sync with it
// (see packages/cli/src/serve/acp-http/index.ts).
const WS_BEARER_SUBPROTOCOL_PREFIX = 'qwen-bearer.';
const WS_AUTH_SUBPROTOCOL = 'qwen-ws';

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

function wsProtocols(): string[] {
  const token = getDaemonToken();
  return token ? [WS_AUTH_SUBPROTOCOL, bearerSubprotocol(token)] : [];
}

function buildWsUrl(
  baseUrl: string,
  terminalId: string,
  cwd: string | undefined,
  release = false,
): string {
  const base = new URL(baseUrl);
  const url = new URL(
    'terminal',
    `${base.origin}${base.pathname.replace(/\/?$/, '/')}`,
  );
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('terminalId', terminalId);
  url.searchParams.set('replay', '1');
  if (cwd) url.searchParams.set('cwd', cwd);
  if (release) url.searchParams.set('release', '1');
  return url.toString();
}

function xtermTheme(theme: WebShellTheme) {
  return theme === 'light'
    ? {
        background: '#ffffff',
        foreground: '#1a1a1a',
        cursor: '#1a1a1a',
        // An unset selectionBackground defaults to white in xterm and blends
        // into the white terminal background, leaving text selection with no
        // visible highlight in the light theme. Pin the light-theme selection
        // blue instead so selected terminal text stays visible.
        selectionBackground: '#bdd8fe',
      }
    : {
        background: '#0a0a0a',
        foreground: '#e0e6f0',
        cursor: '#e0e6f0',
      };
}

export function TerminalPanel({
  terminalId,
  cwd,
  active = true,
  enabled = true,
}: TerminalPanelProps) {
  const theme = useTheme();
  const { baseUrl } = useWorkspace();
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  // Follow web-shell theme switches without rebuilding the terminal or
  // dropping the WebSocket connection.
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = xtermTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (!enabled) {
      const release = () =>
        releaseDetachedWebTerminal(baseUrl, terminalId, cwd);
      releaseCallbacks.set(terminalId, release);
      return () => {
        if (releaseCallbacks.get(terminalId) === release) {
          releaseCallbacks.delete(terminalId);
        }
      };
    }
    if (!containerRef.current) return;

    function createTerminal(handlesPrimaryDa = false) {
      const term = new Terminal({
        allowProposedApi: true,
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        theme: termRef.current?.options.theme ?? xtermTheme(theme),
      });
      const fit = new FitAddon();
      const host = document.createElement('div');
      host.style.height = '100%';
      term.loadAddon(fit);
      term.parser.registerCsiHandler({ final: 'c' }, () => handlesPrimaryDa);
      term.open(host);
      return { term, fit, host };
    }

    let { term, fit, host } = createTerminal();
    containerRef.current.replaceChildren(host);
    termRef.current = term;
    fitRef.current = fit;

    const sendCurrentResize = () => {
      const ws = wsRef.current;
      if (ws?.readyState !== WebSocket.OPEN) return;
      ws.send(
        CONTROL_FRAME_PREFIX +
          JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }),
      );
    };

    requestAnimationFrame(() => {
      try {
        fit.fit();
        sendCurrentResize();
      } catch {
        requestAnimationFrame(() => {
          if (termRef.current !== term) return;
          try {
            fit.fit();
            sendCurrentResize();
          } catch {
            // The panel may have been removed before the retry.
          }
        });
      }
    });

    const protocols = wsProtocols();

    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectDelay = RECONNECT_INITIAL_MS;
    let lostNoticeWritten = false;
    let resizeTimeout: ReturnType<typeof setTimeout> | undefined;
    let releaseRequested = false;
    let releaseAttempts = 0;
    let releaseRetryTimer: ReturnType<typeof setTimeout> | undefined;
    let ended = false;
    let awaitingSnapshot = true;
    let snapshot: { replay: boolean; handlesPrimaryDa: boolean } | undefined;
    let restoring: ReturnType<typeof createTerminal> | undefined;

    function sendInput(data: string) {
      if (!activeRef.current) return;
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data));
      }
    }
    let disposable = term.onData(sendInput);

    function restoreSnapshot(text: string, ws: WebSocket) {
      const next = createTerminal(snapshot!.handlesPrimaryDa);
      const replay = snapshot!.replay;
      snapshot = undefined;
      awaitingSnapshot = false;
      restoring = next;
      next.term.resize(term.cols, term.rows);
      // A new PTY's buffered output has never been answered. Reconnect history has.
      const liveInput = replay ? undefined : next.term.onData(sendInput);
      next.term.write(text, () => {
        if (disposed || wsRef.current !== ws || restoring !== next) {
          liveInput?.dispose();
          return;
        }
        const previous = term;
        next.term.options.theme = term.options.theme;
        disposable.dispose();
        ({ term, fit, host } = next);
        termRef.current = term;
        fitRef.current = fit;
        disposable = liveInput ?? term.onData(sendInput);
        restoring = undefined;
        containerRef.current!.replaceChildren(host);
        previous.dispose();
        fit.fit();
        sendCurrentResize();
        if (activeRef.current) term.focus();
      });
    }

    function handleControl(raw: string): boolean {
      try {
        const ctrl = JSON.parse(raw.slice(CONTROL_FRAME_PREFIX.length)) as {
          type?: unknown;
          exitCode?: unknown;
          message?: unknown;
          replay?: unknown;
          handlesPrimaryDa?: unknown;
        };
        if (
          ctrl.type === 'snapshot' &&
          awaitingSnapshot &&
          !snapshot &&
          typeof ctrl.replay === 'boolean' &&
          typeof ctrl.handlesPrimaryDa === 'boolean'
        ) {
          snapshot = {
            replay: ctrl.replay,
            handlesPrimaryDa: ctrl.handlesPrimaryDa,
          };
          return true;
        } else if (ctrl.type === 'exit') {
          ended = true;
          const exitCode =
            typeof ctrl.exitCode === 'number' ? String(ctrl.exitCode) : '?';
          (restoring?.term ?? term).writeln(
            `\r\n\x1b[33m[${t('terminal.notice.exited', { exitCode })}]\x1b[0m`,
          );
          return true;
        } else if (ctrl.type === 'error') {
          const message =
            typeof ctrl.message === 'string'
              ? ctrl.message
              : t('terminal.notice.unknownError');
          (restoring?.term ?? term).writeln(
            `\r\n\x1b[31m[${t('terminal.notice.error', { message })}]\x1b[0m`,
          );
          return true;
        }
      } catch {
        // Preserve malformed NUL-prefixed PTY output below.
      }
      return false;
    }

    function writeMessage(text: string) {
      if (!text.startsWith(CONTROL_FRAME_PREFIX) || !handleControl(text)) {
        term.write(text);
      }
    }

    function handleMessage(event: MessageEvent, ws: WebSocket) {
      if (disposed || wsRef.current !== ws) return;
      if (typeof event.data === 'string') {
        writeMessage(event.data);
      } else {
        const text = new TextDecoder().decode(event.data as ArrayBuffer);
        if (snapshot) {
          restoreSnapshot(text, ws);
        } else if (awaitingSnapshot) {
          ended = true;
          term.writeln(
            '\r\nTerminal protocol changed; restart the daemon and reload this page.',
          );
          ws.close(4002, 'Terminal protocol mismatch');
        } else {
          (restoring?.term ?? term).write(text);
        }
      }
    }

    function connect(releaseOnly = false) {
      if (disposed && !releaseOnly) return;
      if (releaseOnly) releaseAttempts += 1;
      const ws = new WebSocket(
        buildWsUrl(baseUrl, terminalId, cwd, releaseOnly),
        protocols.length > 0 ? protocols : undefined,
      );
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        if (releaseRequested) {
          ws.send(CONTROL_FRAME_PREFIX + JSON.stringify({ type: 'release' }));
          ws.close();
          return;
        }
        if (disposed) {
          ws.close();
          return;
        }
        awaitingSnapshot = true;
        snapshot = undefined;
        reconnectDelay = RECONNECT_INITIAL_MS;
        lostNoticeWritten = false;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            CONTROL_FRAME_PREFIX +
              JSON.stringify({
                type: 'resize',
                cols: term.cols,
                rows: term.rows,
              }),
          );
        }
      };

      ws.onmessage = releaseOnly ? null : (event) => handleMessage(event, ws);

      ws.onerror = () => {
        // Errors surface through close; reconnect is handled there.
      };

      ws.onclose = (event) => {
        if (releaseOnly) {
          if (event.code !== 4004 && releaseAttempts < 3) {
            releaseRetryTimer = setTimeout(
              () => connect(true),
              RECONNECT_INITIAL_MS,
            );
          }
          return;
        }
        if (disposed || releaseRequested) return;
        if (ended || NON_RETRYABLE_CLOSE_CODES.has(event.code)) return;
        restoring?.term.dispose();
        restoring = undefined;
        if (!lostNoticeWritten) {
          term.writeln(
            `\r\n\x1b[33m[${t('terminal.notice.reconnecting')}]\x1b[0m`,
          );
          lostNoticeWritten = true;
        }
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      };
    }

    const connectFrame = requestAnimationFrame(() => connect());

    const release = () => {
      if (releaseRequested) return;
      releaseRequested = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(CONTROL_FRAME_PREFIX + JSON.stringify({ type: 'release' }));
        ws.close();
      } else if (!ws || ws.readyState !== WebSocket.CONNECTING) {
        connect(true);
      }
    };
    releaseCallbacks.set(terminalId, release);

    // Resize observer → send new size
    const resizeObserver = new ResizeObserver(() => {
      if (!fitRef.current || !termRef.current) return;
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        try {
          fitRef.current?.fit();
          sendCurrentResize();
        } catch {
          // Fit can throw if the terminal was disposed.
        }
      }, 100);
    });
    resizeObserver.observe(containerRef.current);

    if (activeRef.current) term.focus();

    return () => {
      disposed = true;
      if (releaseCallbacks.get(terminalId) === release) {
        releaseCallbacks.delete(terminalId);
      }
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (releaseRetryTimer) clearTimeout(releaseRetryTimer);
      cancelAnimationFrame(connectFrame);
      clearTimeout(resizeTimeout);
      resizeObserver.disconnect();
      disposable.dispose();
      restoring?.term.dispose();
      if (
        !releaseRequested ||
        wsRef.current?.readyState !== WebSocket.CONNECTING
      ) {
        wsRef.current?.close();
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useEffect(() => {
    const term = termRef.current;
    if (active) {
      try {
        fitRef.current?.fit();
        if (term) term.refresh(0, term.rows - 1);
        const ws = wsRef.current;
        if (term && ws?.readyState === WebSocket.OPEN) {
          ws.send(
            CONTROL_FRAME_PREFIX +
              JSON.stringify({
                type: 'resize',
                cols: term.cols,
                rows: term.rows,
              }),
          );
        }
      } catch {
        // The panel may be changing visibility while it unmounts.
      }
      term?.focus();
    } else {
      term?.blur();
    }
  }, [active]);

  return (
    <div
      data-web-terminal
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: theme !== 'light' ? '#0a0a0a' : '#ffffff',
      }}
    >
      <div
        ref={containerRef}
        style={{
          flex: 1,
          overflow: 'hidden',
          padding: '0.25rem 0.5rem',
        }}
      />
    </div>
  );
}
