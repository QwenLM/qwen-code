/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useConnection, useWorkspace } from '@qwen-code/webui/daemon-react-sdk';
import '@xterm/xterm/css/xterm.css';
import { useI18n } from '../../i18n';
import { useTerminalSocket } from '../../terminal/useTerminalSocket';
import styles from './TerminalPanel.module.css';

export interface TerminalPanelProps {
  /** Shell task id (bg_xxx) of the tmux-backed task to attach to. */
  taskId: string;
  /** Owning session; defaults to the currently connected session. */
  sessionId?: string;
}

/**
 * Live xterm.js view of a tmux-backed shell task, attached through the
 * daemon `/terminal` WebSocket. Rendered as an ArtifactPanel tab.
 */
export function TerminalPanel({ taskId, sessionId }: TerminalPanelProps) {
  const { t } = useI18n();
  const workspace = useWorkspace();
  const connection = useConnection();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);

  const resolvedSessionId = sessionId ?? connection.sessionId ?? '';

  const { status, errorMessage, sendInput, resize, reconnect } =
    useTerminalSocket({
      baseUrl: workspace.baseUrl,
      ...(workspace.token ? { token: workspace.token } : {}),
      sessionId: resolvedSessionId,
      taskId,
      enabled: resolvedSessionId.length > 0,
      onOutput: (chunk) => {
        termRef.current?.write(chunk);
      },
    });

  // Mount xterm once per task.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const term = new Terminal({
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    // xterm captures keystrokes only through its focused hidden textarea.
    term.focus();
    termRef.current = term;

    const inputDisposable = term.onData((data) => {
      sendInputRef.current(data);
    });
    // Binary-encoded input (legacy encodings) arrives on onBinary, not onData.
    const binaryDisposable = term.onBinary((data) => {
      sendInputRef.current(data);
    });

    let lastCols = 0;
    let lastRows = 0;
    const reportSize = (): void => {
      try {
        fitAddon.fit();
        // ResizeObserver fires on sub-cell-width changes too; skip
        // identical dimensions instead of re-resizing the shared pty.
        if (term.cols === lastCols && term.rows === lastRows) return;
        lastCols = term.cols;
        lastRows = term.rows;
        resizeRef.current(term.cols, term.rows);
      } catch {
        // Container hidden or zero-sized; the next observer tick retries.
      }
    };
    reportSize();
    const observer = new ResizeObserver(reportSize);
    observer.observe(container);

    return () => {
      observer.disconnect();
      inputDisposable.dispose();
      binaryDisposable.dispose();
      termRef.current = null;
      term.dispose();
    };
  }, [taskId]);

  // Re-attach redraws the full visible screen; on a reconnect (any ready
  // after the first) reset the buffer so the fresh copy replaces the stale
  // pre-disconnect content instead of stacking below it.
  const readyCountRef = useRef(0);
  useEffect(() => {
    if (status !== 'ready') return;
    readyCountRef.current += 1;
    if (readyCountRef.current > 1) {
      termRef.current?.reset();
    }
  }, [status]);

  // Latest-callback refs keep the one-time xterm wiring stable while the
  // socket hook re-renders.
  const sendInputRef = useRef(sendInput);
  sendInputRef.current = sendInput;
  const resizeRef = useRef(resize);
  resizeRef.current = resize;

  return (
    <div className={styles.terminalPanel}>
      <div ref={containerRef} className={styles.terminalContainer} />
      {status !== 'ready' && (
        <div className={styles.terminalOverlay}>
          {status === 'connecting' && <span>{t('terminal.connecting')}</span>}
          {status === 'closed' && (
            <div className={styles.terminalOverlayColumn}>
              <span>{t('terminal.ended')}</span>
              {errorMessage && (
                <span className={styles.terminalOverlayDetail}>
                  {errorMessage}
                </span>
              )}
              <button
                type="button"
                className={styles.terminalOverlayButton}
                onClick={reconnect}
              >
                {t('terminal.reconnect')}
              </button>
            </div>
          )}
          {status === 'error' && (
            <div className={styles.terminalOverlayColumn}>
              <span>{t('terminal.error')}</span>
              {errorMessage && (
                <span className={styles.terminalOverlayDetail}>
                  {errorMessage}
                </span>
              )}
              <button
                type="button"
                className={styles.terminalOverlayButton}
                onClick={reconnect}
              >
                {t('terminal.reconnect')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
