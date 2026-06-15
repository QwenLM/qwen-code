/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { ROOT_CONTEXT, createContextKey } from '@opentelemetry/api';
import {
  getSessionContext,
  setSessionContext,
  getCurrentSessionId,
} from './session-context.js';

describe('session-context', () => {
  afterEach(() => {
    setSessionContext(undefined);
  });

  it('returns the context that was set', () => {
    const key = createContextKey('session-test-key');
    const ctx = ROOT_CONTEXT.setValue(key, 'session-value');

    setSessionContext(ctx);

    expect(getSessionContext()?.getValue(key)).toBe('session-value');
  });

  it('replaces the stored context', () => {
    const key = createContextKey('session-replace-key');
    const firstContext = ROOT_CONTEXT.setValue(key, 'first');
    const secondContext = ROOT_CONTEXT.setValue(key, 'second');

    setSessionContext(firstContext);
    setSessionContext(secondContext);

    expect(getSessionContext()?.getValue(key)).toBe('second');
  });

  it('clears the stored context', () => {
    const key = createContextKey('session-clear-key');
    setSessionContext(ROOT_CONTEXT.setValue(key, 'session-value'));

    setSessionContext(undefined);

    expect(getSessionContext()).toBeUndefined();
  });
});

describe('getCurrentSessionId', () => {
  afterEach(() => {
    setSessionContext(undefined);
  });

  it('returns undefined when no session has been set', () => {
    expect(getCurrentSessionId()).toBeUndefined();
  });

  it('returns the session ID passed to setSessionContext', () => {
    const key = createContextKey('sid-test-key');
    setSessionContext(ROOT_CONTEXT.setValue(key, 'ctx'), 'session-abc');

    expect(getCurrentSessionId()).toBe('session-abc');
  });

  it('updates when setSessionContext is called with a new session ID', () => {
    const key = createContextKey('sid-update-key');
    setSessionContext(ROOT_CONTEXT.setValue(key, 'first'), 'session-1');
    setSessionContext(ROOT_CONTEXT.setValue(key, 'second'), 'session-2');

    expect(getCurrentSessionId()).toBe('session-2');
  });

  it('clears when setSessionContext is called without a session ID', () => {
    const key = createContextKey('sid-clear-key');
    setSessionContext(ROOT_CONTEXT.setValue(key, 'ctx'), 'session-xyz');
    setSessionContext(undefined);

    expect(getCurrentSessionId()).toBeUndefined();
  });
});
