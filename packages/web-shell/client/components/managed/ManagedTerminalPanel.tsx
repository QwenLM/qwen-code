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
  // 401 is a credential refresh, not a refusal: the ticket POST re-derives its
  // headers on every attempt, so an expired short-lived token admits on the
  // next try once the host refreshes — never a terminal condition (the same
  // contract isAuthFailure documents in managed-request-error.ts).
  if (status === 401) return false;
  // 400 is a malformed identity (invalid Session/terminal id) and 403 a
  // permanent role refusal (only a Workspace operator may open a terminal),
  // 404 a gone Session/terminal; all are terminal — retrying cannot fix them.
  if (status === 400 || status === 403 || status === 404) return true;
  // 409 workspace_unavailable is deliberately retryable: it also answers a
  // binding that is not READY yet (bootstrapping or being replaced), which is
  // transient. Any other 409 (e.g. session_operation_active on a closed
  // Session) is a permanent answer, not a hiccup, so it must not retry forever.
  if (status === 409) {
    return (error as { code?: unknown }).code !== 'workspace_unavailable';
  }
  return false;
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
    let releaseRequested = false;
    let releaseDelivered = false;
    let releaseFallbackStarted = false;
    let connectStarted = false;

    function writeNotice(message: string, color: '31' | '33') {
      term.writeln(`\r\n\x1b[${color}m[${message}]\x1b[0m`);
    }

    function writeReconnectNotice() {
      if (noticeWritten) return;
      writeNotice(tRef.current('terminal.notice.reconnecting'), '33');
      noticeWritten = true;
    }

    function writeLostNotice() {
      // The lost notice is the terminal state: it must replace a stale
      // "reconnecting" notice, not be swallowed by the shared latch. It goes
      // to the restoring terminal when one is pending so the post-replay
      // swap keeps it on screen instead of leaving it on the disposed one.
      (restoring?.term ?? term).writeln(
        `\r\n\x1b[31m[${tRef.current('terminal.notice.lost')}]\x1b[0m`,
      );
      noticeWritten = true;
    }

    // The worker releases a PTY only on an explicit release frame (the
    // release=1 upgrade is not forwarded by the relay), so when the live
    // socket cannot carry the frame — never created, still CONNECTING, or
    // already closed — a dedicated short-lived connection must deliver it,
    // or the shell and its durable hold outlive the dialog. Mirrors the
    // daemon panel's releaseTerminal: 4004 confirms the release; any other
    // answer retries, bounded at three attempts.
    function startReleaseFallback() {
      if (releaseFallbackStarted) return;
      releaseFallbackStarted = true;
      let attempts = 0;
      const deliver = async () => {
        attempts += 1;
        let ticket: string;
        try {
          const result = await terminal.ticket(sessionId, terminalId, {
            clientId,
          });
          ticket = result.ticket;
          if (typeof ticket !== 'string' || !ticket) {
            throw new Error('Terminal ticket is missing');
          }
        } catch {
          if (attempts < 3) {
            setTimeout(() => void deliver(), RECONNECT_INITIAL_MS);
          }
          return;
        }
        const ws = new WebSocket(
          terminal.webSocketUrl(sessionId, terminalId),
          managedTerminalProtocols(ticket),
        );
        ws.onopen = () => {
          ws.send(CONTROL_FRAME_PREFIX + JSON.stringify({ type: 'release' }));
        };
        ws.onerror = () => ws.close();
        ws.onclose = (event) => {
          if (event.code === 4004 || attempts >= 3) return;
          setTimeout(() => void deliver(), RECONNECT_INITIAL_MS);
        };
      };
      void deliver();
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
        // A null socket means no successor replaced this one: the close that
        // produced it may be the worker's normal post-replay close (snapshot
        // → replay → exit → 4000), whose replayed screen and exit notice must
        // still reach the container. Only a different live socket rejects.
        if (
          disposed ||
          (wsRef.current !== null && wsRef.current !== ws) ||
          restoring !== next
        ) {
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
          // A delivered snapshot proves the worker is responsive; only now
          // reset the backoff. Resetting on mere socket open would let a peer
          // that accepts and immediately closes reconnect at the initial
          // interval forever.
          reconnectDelay = RECONNECT_INITIAL_MS;
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
      connectStarted = true;
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
        if (releaseRequested) {
          // The dialog closed while this handshake was in flight; deliver
          // the release now that the socket can carry it.
          ws.send(CONTROL_FRAME_PREFIX + JSON.stringify({ type: 'release' }));
          releaseDelivered = true;
          ws.close();
          return;
        }
        if (disposed) {
          ws.close();
          return;
        }
        awaitingSnapshot = true;
        snapshot = undefined;
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
        if (releaseRequested) {
          // A release frame already sent on a live socket is delivered by
          // the closing handshake, so the local close code (1000/1005)
          // that follows it must not start a second release connection.
          // Only when no frame was delivered does the close code decide:
          // 4004 confirms the worker released the PTY, other non-retryable
          // codes mean the terminal is already gone, and anything else
          // means the frame may not have landed — the dedicated connection
          // retries.
          if (!releaseDelivered && !NON_RETRYABLE_CLOSE_CODES.has(event.code)) {
            startReleaseFallback();
          }
          return;
        }
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
      releaseRequested = !ended;
      const ws = wsRef.current;
      if (ended) {
        // The PTY already exited; there is nothing to release. A release
        // connection would re-create a fresh PTY under the reused terminal
        // id only to kill it again.
        ws?.close();
      } else if (ws?.readyState === WebSocket.OPEN) {
        ws.send(CONTROL_FRAME_PREFIX + JSON.stringify({ type: 'release' }));
        releaseDelivered = true;
        ws.close();
      } else if (!ws || ws.readyState !== WebSocket.CONNECTING) {
        // No live socket can carry the release frame (ticket still in
        // flight, reconnect backoff, or an already-closed socket). A plain
        // close only detaches the worker's listeners, so the dedicated
        // connection must deliver the release instead — but only for a
        // terminal that actually began connecting: a StrictMode mount that
        // never connected must not release the id the surviving mount uses.
        if (connectStarted) {
          startReleaseFallback();
        }
      }
      // A CONNECTING socket is deliberately left open: closing it would
      // abort the handshake, and its onopen delivers the release instead.
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
        // A click on the modal backdrop (or any outside interaction) must not
        // dismiss the dialog either: that would unmount the surface and release
        // the running PTY, the same outcome the Escape guard prevents.
        onPointerDownOutside={(event) => {
          event.preventDefault();
        }}
        onInteractOutside={(event) => {
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
