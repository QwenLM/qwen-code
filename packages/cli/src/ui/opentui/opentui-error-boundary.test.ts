/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// theme.js (pulled in by the boundary) builds a SyntaxStyle at module load;
// stub the FFI-backed @opentui/core so the test runs without the native lib.
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from 'vitest';
import type { ErrorInfo } from 'react';
import { OpenTuiErrorBoundary } from './opentui-error-boundary.js';

const ERROR_INFO = {} as ErrorInfo;

describe('OpenTuiErrorBoundary', () => {
  let stderrSpy: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    vi.useFakeTimers();
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    vi.useRealTimers();
  });

  it('captures the error into state', () => {
    const state = OpenTuiErrorBoundary.getDerivedStateFromError(
      new Error('render boom'),
    );
    expect(state.error).toBeInstanceOf(Error);
    expect(state.error?.message).toBe('render boom');
  });

  it('normalizes a non-Error throw', () => {
    const state = OpenTuiErrorBoundary.getDerivedStateFromError('plain');
    expect(state.error?.message).toBe('plain');
  });

  it('schedules a fatal exit with code 1 after the delay', () => {
    const onFatalExit = vi.fn();
    const setTimeoutFn = (fn: () => void, ms: number) => setTimeout(fn, ms);
    const boundary = new OpenTuiErrorBoundary({
      children: null,
      exitDelayMs: 10,
      onFatalExit,
      setTimeoutFn,
    });

    boundary.componentDidCatch(new Error('boom'), ERROR_INFO);
    expect(onFatalExit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10);
    expect(onFatalExit).toHaveBeenCalledWith(1);
  });

  it('only schedules the exit once', () => {
    const onFatalExit = vi.fn();
    const setTimeoutFn = (fn: () => void, ms: number) => setTimeout(fn, ms);
    const boundary = new OpenTuiErrorBoundary({
      children: null,
      exitDelayMs: 10,
      onFatalExit,
      setTimeoutFn,
    });

    boundary.componentDidCatch(new Error('a'), ERROR_INFO);
    boundary.componentDidCatch(new Error('b'), ERROR_INFO);
    vi.advanceTimersByTime(100);
    expect(onFatalExit).toHaveBeenCalledTimes(1);
  });

  it('renders children while there is no error', () => {
    const boundary = new OpenTuiErrorBoundary({ children: 'CHILD' });
    boundary.state = { error: null };
    expect(boundary.render()).toBe('CHILD');
  });

  it('logs the error to stderr', () => {
    const onFatalExit = vi.fn();
    const boundary = new OpenTuiErrorBoundary({
      children: null,
      exitDelayMs: 10,
      onFatalExit,
      setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
    });
    boundary.componentDidCatch(new Error('logged'), ERROR_INFO);
    const err = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(err).toContain('logged');
  });
});
