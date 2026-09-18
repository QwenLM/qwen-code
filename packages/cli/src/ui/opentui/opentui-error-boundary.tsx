/* eslint-disable react/no-unknown-property */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
/** @jsxImportSource @opentui/react */

/**
 * OpenTUI error boundary — the renderer-neutral counterpart of the ink
 * `components/shared/ErrorBoundary.tsx`. It catches render-time errors in its
 * subtree so an unexpected history-item shape cannot take the whole CLI down,
 * and mirrors the ink behavior the exit chain relies on: the fatal top-level
 * boundary records the error in a module store so the (Batch 6) teardown can
 * echo it to stderr after the screen is restored.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { C } from './theme.js';
import { sanitizeTerminalText } from '../utils/textUtils.js';

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

/**
 * Module-level store for the last rendering error. The exit chain reads this
 * after the React tree is torn down, so the message survives even when the
 * fallback was drawn on an alternate screen and discarded on teardown.
 */
let lastRenderError: Error | undefined;

export function consumeLastRenderError(): Error | undefined {
  const err = lastRenderError;
  lastRenderError = undefined;
  return err;
}

interface OpenTuiErrorBoundaryProps {
  children: ReactNode;
  /**
   * Custom fallback renderer. Receives the caught error and a `reset` callback
   * that clears the boundary's error state. When omitted, a minimal
   * dependency-free message is shown.
   */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Optional side-effecting hook for logging the error. */
  onError?: (error: Error, info: ErrorInfo) => void;
  /**
   * When true, the caught error is stored so the exit chain can echo it after
   * teardown. Only the fatal top-level boundary should set this.
   */
  recordForExitEcho?: boolean;
}

interface OpenTuiErrorBoundaryState {
  error: Error | null;
}

export class OpenTuiErrorBoundary extends Component<
  OpenTuiErrorBoundaryProps,
  OpenTuiErrorBoundaryState
> {
  override state: OpenTuiErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): OpenTuiErrorBoundaryState {
    return { error: normalizeError(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const normalized = normalizeError(error);
    if (this.props.recordForExitEcho) {
      lastRenderError = normalized;
    }
    this.props.onError?.(normalized, info);
  }

  private readonly reset = () => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) {
        return this.props.fallback(error, this.reset);
      }
      // Intentionally un-translated: a generic last-resort message shown while
      // the subtree is already crashing — pulling in i18n here risks a second
      // failure inside the boundary.
      return (
        <box flexDirection="column">
          <text fg={C.red} attributes={1}>
            {'Something went wrong while rendering.'}
          </text>
          <text fg={C.dim}>{sanitizeTerminalText(error.message)}</text>
        </box>
      );
    }
    return this.props.children;
  }
}
