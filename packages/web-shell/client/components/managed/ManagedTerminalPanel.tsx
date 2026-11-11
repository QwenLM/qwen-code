/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useTheme } from '../../themeContext';
import { useI18n } from '../../i18n';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import {
  CONTROL_FRAME_PREFIX,
  NON_RETRYABLE_CLOSE_CODES,
  RECONNECT_INITIAL_MS,
  RECONNECT_MAX_MS,
  xtermTheme,
} from '../terminal/terminal-protocol';
import { managedTerminalProtocols } from './managed-terminal-protocol';
import type { ManagedAgentTerminalProvider } from './managed-agent-provider';

interface ManagedTerminalPanelProps {
  terminal: ManagedAgentTerminalProvider;
  sessionId: string;
  terminalId: string;
  clientId: string;
  onClose(): void;
  restoreFocus(): void;
}

interface ManagedTerminalSurfaceProps {
  terminal: ManagedAgentTerminalProvider;
  sessionId: string;
  terminalId: string;
  clientId: string;
}

function admissionRefused(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const status = (error as { status?: unknown }).status;
  return status === 401 || status === 403 || status === 404 || status === 409;
}

function ManagedTerminalSurface({
  terminal,
  sessionId,
  terminalId,
  clientId,
}: ManagedTerminalSurfaceProps) {
  const theme = useTheme();
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = xtermTheme(theme);
  }, [theme]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

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
    container.replaceChildren(host);
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

    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectDelay = RECONNECT_INITIAL_MS;
    let resizeTimeout: ReturnType<typeof setTimeout> | undefined;
    let ended = false;
    let noticeWritten = false;
    let awaitingSnapshot = true;
    let snapshot: { replay: boolean; handlesPrimaryDa: boolean } | undefined;
    let restoring: ReturnType<typeof createTerminal> | undefined;
    let ticketRequest: AbortController | undefined;

    function writeNotice(message: string, color: '31' | '33') {
      term.writeln(`\r\n\x1b[${color}m[${message}]\x1b[0m`);
    }

    function writeReconnectNotice() {
      if (noticeWritten) return;
      writeNotice(tRef.current('terminal.notice.reconnecting'), '33');
      noticeWritten = true;
    }

    function writeLostNotice() {
      if (noticeWritten) return;
      writeNotice(tRef.current('terminal.notice.lost'), '31');
      noticeWritten = true;
    }

    function scheduleReconnect() {
      if (disposed || ended) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        void connect();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    }

    function sendInput(data: string) {
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
        term.focus();
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
            `\r\n\x1b[33m[${tRef.current('terminal.notice.exited', { exitCode })}]\x1b[0m`,
          );
          return true;
        } else if (ctrl.type === 'error') {
          const message =
            typeof ctrl.message === 'string'
              ? ctrl.message
              : tRef.current('terminal.notice.unknownError');
          (restoring?.term ?? term).writeln(
            `\r\n\x1b[31m[${tRef.current('terminal.notice.error', { message })}]\x1b[0m`,
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
          ws.send(CONTROL_FRAME_PREFIX + JSON.stringify({ type: 'release' }));
          term.writeln(
            `\r\n${tRef.current('terminal.notice.protocolMismatch')}`,
          );
          ws.close(4002, 'Terminal protocol mismatch');
        } else {
          (restoring?.term ?? term).write(text);
        }
      }
    }

    async function connect() {
      if (disposed || ended) return;
      const ticketRequestController = new AbortController();
      ticketRequest = ticketRequestController;
      let ticket: string;
      try {
        const result = await terminal.ticket(sessionId, terminalId, {
          clientId,
          signal: ticketRequestController.signal,
        });
        ticket = result.ticket;
        if (typeof ticket !== 'string' || !ticket) {
          throw new Error('Terminal ticket is missing');
        }
      } catch (error) {
        if (disposed || ticketRequestController.signal.aborted) return;
        ticketRequest = undefined;
        if (admissionRefused(error)) {
          ended = true;
          writeLostNotice();
          return;
        }
        writeReconnectNotice();
        scheduleReconnect();
        return;
      }
      if (disposed || ticketRequestController.signal.aborted) return;
      ticketRequest = undefined;

      const ws = new WebSocket(
        terminal.webSocketUrl(sessionId, terminalId),
        managedTerminalProtocols(ticket),
      );
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) {
          ws.close();
          return;
        }
        awaitingSnapshot = true;
        snapshot = undefined;
        reconnectDelay = RECONNECT_INITIAL_MS;
        noticeWritten = false;
        ws.send(
          CONTROL_FRAME_PREFIX +
            JSON.stringify({
              type: 'resize',
              cols: term.cols,
              rows: term.rows,
            }),
        );
        term.focus();
      };

      ws.onmessage = (event) => handleMessage(event, ws);

      ws.onerror = () => {
        // Errors surface through close; reconnect is handled there.
      };

      ws.onclose = (event) => {
        if (wsRef.current === ws) wsRef.current = null;
        if (disposed || wsRef.current !== null) return;
        if (ended) return;
        restoring?.term.dispose();
        restoring = undefined;
        if (event.code === 4002) {
          ended = true;
          writeNotice(tRef.current('terminal.notice.protocolMismatch'), '31');
          return;
        }
        if (NON_RETRYABLE_CLOSE_CODES.has(event.code)) {
          ended = true;
          writeLostNotice();
          return;
        }
        writeReconnectNotice();
        scheduleReconnect();
      };
    }

    const connectFrame = requestAnimationFrame(() => {
      try {
        fit.fit();
        sendCurrentResize();
      } catch {
        // The dialog may close before the panel has a measurable size.
      }
      void connect();
    });

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
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      ticketRequest?.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      cancelAnimationFrame(connectFrame);
      clearTimeout(resizeTimeout);
      resizeObserver.disconnect();
      disposable.dispose();
      restoring?.term.dispose();
      const ws = wsRef.current;
      if (ws) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(CONTROL_FRAME_PREFIX + JSON.stringify({ type: 'release' }));
        }
        ws.close();
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal, sessionId, terminalId, clientId]);

  return (
    <div
      ref={containerRef}
      data-managed-terminal
      className="min-h-0 flex-1 overflow-hidden rounded-md"
      style={{
        padding: '0.25rem 0.5rem',
        background: theme === 'light' ? '#ffffff' : '#0a0a0a',
      }}
    />
  );
}

export function ManagedTerminalPanel({
  terminal,
  sessionId,
  terminalId,
  clientId,
  onClose,
  restoreFocus,
}: ManagedTerminalPanelProps) {
  const { t } = useI18n();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="flex h-[85vh] max-w-5xl flex-col sm:max-w-5xl"
        // Escape belongs to the terminal application (e.g. leaving Vim insert
        // mode); Radix would otherwise dismiss the dialog and release the PTY.
        // Close stays available through the explicit dialog close control.
        onEscapeKeyDown={(event) => {
          event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('terminal.title')}</DialogTitle>
        </DialogHeader>
        <ManagedTerminalSurface
          terminal={terminal}
          sessionId={sessionId}
          terminalId={terminalId}
          clientId={clientId}
        />
      </DialogContent>
    </Dialog>
  );
}
