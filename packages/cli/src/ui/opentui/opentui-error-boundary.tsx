/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render-error safety net for the OpenTUI tree (ink parity).
 *
 * The ink tree wraps `AppContainer` in an `ErrorBoundary` that records the
 * error and, for the fatal top-level boundary, schedules `runExitCleanup()`
 * followed by `process.exit(1)` (`startInteractiveUI.tsx:245-272`). The
 * OpenTUI tree had no boundary, so any throw during render took the whole
 * renderer down without draining the exit chain. This boundary mirrors that:
 * it catches subtree render errors, renders a minimal fallback, and exits
 * through the shared cleanup drain with exit code 1.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { C } from './theme.js';
import { exitSession } from './exit-lifecycle.js';

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export interface OpenTuiErrorBoundaryProps {
  children: ReactNode;
  /**
   * Delay before the fatal exit so the fallback message gets a frame to
   * paint. Injectable for tests.
   */
  exitDelayMs?: number;
  /** Injectable exit for tests (defaults to the shared cleanup drain). */
  onFatalExit?: (code: number) => void;
  /** Injectable scheduler for tests. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
}

interface OpenTuiErrorBoundaryState {
  error: Error | null;
}

export class OpenTuiErrorBoundary extends Component<
  OpenTuiErrorBoundaryProps,
  OpenTuiErrorBoundaryState
> {
  override state: OpenTuiErrorBoundaryState = { error: null };
  private exitScheduled = false;

  static getDerivedStateFromError(error: unknown): OpenTuiErrorBoundaryState {
    return { error: normalizeError(error) };
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    if (this.exitScheduled) return;
    this.exitScheduled = true;
    const normalized = normalizeError(error);
    // The fallback replaces the tree; schedule a graceful exit through the
    // shared cleanup drain so chat recording / MCP / telemetry still flush.
    const delay = this.props.exitDelayMs ?? 1500;
    const schedule = this.props.setTimeoutFn ?? setTimeout;
    schedule(() => {
      if (this.props.onFatalExit) {
        this.props.onFatalExit(1);
        return;
      }
      void exitSession(1).catch(() => {});
    }, delay);
    // Record the message on stderr as a durable record in case the renderer
    // is already too broken to paint the fallback.
    try {
      process.stderr.write(
        `\nRendering error: ${normalized.message}\n${normalized.stack ?? ''}\n`,
      );
    } catch {
      // Best-effort: a broken stderr must not mask the exit path.
    }
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <box flexDirection="column" paddingLeft={1} paddingRight={1}>
          <text fg={C.red} attributes={1}>
            Something went wrong while rendering.
          </text>
          <text fg={C.dim}>{error.message}</text>
          <text fg={C.dim}>Exiting…</text>
        </box>
      );
    }
    return this.props.children;
  }
}
