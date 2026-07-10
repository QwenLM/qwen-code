/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { act } from 'react';
import { Text } from 'ink';
import { ErrorBoundary } from './ErrorBoundary.js';

// A child that throws during render to trip the boundary.
const Thrower = ({ message }: { message: string }) => {
  throw new Error(message);
};

describe('ErrorBoundary', () => {
  // React logs caught render errors to console.error; silence it so the test
  // output stays clean (the boundary catching the error is the point).
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('renders children when no error is thrown', () => {
    const { lastFrame } = render(
      <ErrorBoundary>
        <Text>healthy child</Text>
      </ErrorBoundary>,
    );
    expect(lastFrame()).toContain('healthy child');
  });

  it('catches a render error and shows the default fallback with the message', () => {
    const { lastFrame } = render(
      <ErrorBoundary>
        <Thrower message="kaboom" />
      </ErrorBoundary>,
    );
    const output = lastFrame() ?? '';
    expect(output).toContain('Something went wrong while rendering.');
    expect(output).toContain('kaboom');
  });

  it('renders a custom fallback with the caught error', () => {
    const { lastFrame } = render(
      <ErrorBoundary fallback={(error) => <Text>custom: {error.message}</Text>}>
        <Thrower message="boom" />
      </ErrorBoundary>,
    );
    expect(lastFrame()).toContain('custom: boom');
  });

  it('calls onError with the error and component stack', () => {
    const onError = vi.fn();
    render(
      <ErrorBoundary onError={onError}>
        <Thrower message="logged" />
      </ErrorBoundary>,
    );
    expect(onError).toHaveBeenCalledTimes(1);
    const [error, info] = onError.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('logged');
    // React passes an ErrorInfo with a componentStack string.
    expect(typeof (info as { componentStack?: unknown }).componentStack).toBe(
      'string',
    );
  });

  it('reset clears the error state so children can recover', () => {
    let shouldThrow = true;
    let capturedReset: (() => void) | undefined;
    const Maybe = () => {
      if (shouldThrow) {
        throw new Error('transient');
      }
      return <Text>recovered</Text>;
    };
    const tree = (
      <ErrorBoundary
        fallback={(error, reset) => {
          capturedReset = reset;
          return <Text>err: {error.message}</Text>;
        }}
      >
        <Maybe />
      </ErrorBoundary>
    );
    const { lastFrame, rerender } = render(tree);
    expect(lastFrame()).toContain('err: transient');

    // The offending condition clears, then reset() drops the boundary's error
    // state and the subtree re-renders successfully.
    shouldThrow = false;
    act(() => {
      capturedReset?.();
    });
    rerender(tree);
    expect(lastFrame()).toContain('recovered');
  });
});
