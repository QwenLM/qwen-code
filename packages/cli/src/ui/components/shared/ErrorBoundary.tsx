/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Custom fallback renderer. Receives the caught error and a `reset` callback
   * that clears the boundary's error state (e.g. to retry after the offending
   * data has changed). When omitted, a minimal default message is shown.
   */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Optional side-effecting hook for logging the error. */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * React error boundary for the Ink tree. Catches render-time errors in its
 * subtree and shows a fallback instead of letting the exception propagate and
 * crash the whole CLI. The CLI UI otherwise has no error boundary, so any
 * unexpected history-item shape in a full-detail render path (transcript) would
 * take the process down.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
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
      return (
        <Box flexDirection="column">
          <Text color={theme.status.error} bold>
            Something went wrong while rendering.
          </Text>
          <Text color={theme.text.secondary}>{error.message}</Text>
        </Box>
      );
    }
    return this.props.children;
  }
}
