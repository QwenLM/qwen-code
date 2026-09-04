/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

// The module under test emits a top-level `@opentui/react/jsx-runtime` import
// (via its `@jsxImportSource` pragma); stub it with a plain factory so loading
// it does not initialize the native OpenTUI FFI, which is unavailable in the
// node test env. These tests never exercise the built-in box/text fallback.
vi.mock('@opentui/react/jsx-runtime', () => {
  const jsx = (type: unknown, props: unknown) => ({ type, props });
  return { jsx, jsxs: jsx, Fragment: Symbol.for('fragment') };
});
vi.mock('@opentui/react/jsx-dev-runtime', () => {
  const jsxDEV = (type: unknown, props: unknown) => ({ type, props });
  return { jsx: jsxDEV, jsxs: jsxDEV, Fragment: Symbol.for('fragment') };
});
// theme.ts pulls in @opentui/core (native FFI) to build its syntax theme; stub
// C so the module under test imports cleanly in the node test env.
vi.mock('./theme.js', () => ({
  C: new Proxy(
    {},
    {
      get: () => '#ffffff',
    },
  ),
}));

import {
  OpenTuiErrorBoundary,
  consumeLastRenderError,
} from './opentui-error-boundary.js';

function makeInstance(
  props: Partial<React.ComponentProps<typeof OpenTuiErrorBoundary>> = {},
) {
  return new OpenTuiErrorBoundary({
    children: null,
    ...props,
  } as React.ComponentProps<typeof OpenTuiErrorBoundary>);
}

const info = { componentStack: '' };

describe('OpenTuiErrorBoundary', () => {
  it('normalizes the thrown value and stores it in derived state', () => {
    const thrown = new Error('boom');
    expect(OpenTuiErrorBoundary.getDerivedStateFromError(thrown)).toEqual({
      error: thrown,
    });
    expect(OpenTuiErrorBoundary.getDerivedStateFromError('string')).toEqual({
      error: new Error('string'),
    });
  });

  it('records the error for exit echo only when the flag is set', () => {
    consumeLastRenderError(); // drain any prior value

    const fatal = makeInstance({ recordForExitEcho: true });
    fatal.componentDidCatch(new Error('fatal-boom'), info);
    expect(consumeLastRenderError()?.message).toBe('fatal-boom');
    // consume clears the store.
    expect(consumeLastRenderError()).toBeUndefined();

    const recoverable = makeInstance({ recordForExitEcho: false });
    recoverable.componentDidCatch(new Error('soft-boom'), info);
    expect(consumeLastRenderError()).toBeUndefined();
  });

  it('invokes onError with the normalized error and info', () => {
    const onError = vi.fn();
    const instance = makeInstance({ onError });
    const err = new Error('logged');
    instance.componentDidCatch(err, info);
    expect(onError).toHaveBeenCalledWith(err, info);
  });

  it('renders children while there is no error', () => {
    const instance = makeInstance();
    instance.state = { error: null };
    expect(instance.render()).toBeNull();
  });

  it('calls a custom fallback with the error and a reset callback', () => {
    const fallback = vi.fn((_error: Error, reset: () => void) => reset.name);
    const instance = makeInstance({ fallback });
    instance.state = { error: new Error('shown') };
    const out = instance.render();
    expect(fallback).toHaveBeenCalledTimes(1);
    const [arg0, arg1] = fallback.mock.calls[0];
    expect((arg0 as Error).message).toBe('shown');
    expect(typeof arg1).toBe('function');
    expect(out).toBe('reset');
  });
});
