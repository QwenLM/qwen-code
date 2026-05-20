/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initializeWarningHandler,
  resetWarningHandlerForTests,
} from './warningHandler.js';

const ENV_KEYS = ['NODE_ENV', 'DEBUG', 'QWEN_DEBUG'] as const;

describe('initializeWarningHandler', () => {
  const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
  let originalListeners: NodeJS.WarningListener[] = [];
  // Spy on stderr.write; typed loosely because the overloads aren't worth
  // re-stating just to satisfy the strict generic of vi.spyOn's return type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any;

  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    originalListeners = [...process.listeners('warning')];
    process.removeAllListeners('warning');
    resetWarningHandlerForTests();
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    resetWarningHandlerForTests();
    process.removeAllListeners('warning');
    for (const l of originalListeners) process.on('warning', l);
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
    stderrSpy.mockRestore();
  });

  function makeWarning(name: string, message: string): Error {
    const err = new Error(message);
    err.name = name;
    return err;
  }

  function emit(warning: Error): void {
    for (const l of process.listeners('warning')) {
      (l as (w: Error) => void)(warning);
    }
  }

  it('suppresses MaxListenersExceededWarning for AbortSignal in production', () => {
    initializeWarningHandler();
    emit(
      makeWarning(
        'MaxListenersExceededWarning',
        'Possible EventTarget memory leak detected. 1509 abort listeners added to [AbortSignal].',
      ),
    );
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('does NOT suppress generic [EventTarget] warnings — only AbortSignal', () => {
    initializeWarningHandler();
    emit(
      makeWarning(
        'MaxListenersExceededWarning',
        'Possible EventTarget memory leak detected. 11 listeners added to [EventTarget].',
      ),
    );
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it('suppresses AbortSignal warnings with class metadata, e.g. [AbortSignal{aborted: false}]', () => {
    initializeWarningHandler();
    emit(
      makeWarning(
        'MaxListenersExceededWarning',
        'Possible EventTarget memory leak detected. 11 abort listeners added to [AbortSignal{aborted: false}].',
      ),
    );
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('forwards unrelated warnings to stderr', () => {
    initializeWarningHandler();
    emit(makeWarning('DeprecationWarning', 'Some legacy thing'));
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const written = (stderrSpy.mock.calls[0]?.[0] ?? '').toString();
    expect(written).toContain('DeprecationWarning');
    expect(written).toContain('Some legacy thing');
  });

  it('keeps suppressed warnings visible when DEBUG is set', () => {
    process.env['DEBUG'] = '1';
    initializeWarningHandler();
    emit(
      makeWarning(
        'MaxListenersExceededWarning',
        'Possible EventTarget memory leak detected. 1500 abort listeners added to [AbortSignal].',
      ),
    );
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it('treats DEBUG=0 and DEBUG=false as not set', () => {
    process.env['DEBUG'] = '0';
    initializeWarningHandler();
    emit(
      makeWarning(
        'MaxListenersExceededWarning',
        'Possible EventTarget memory leak detected. 1500 abort listeners added to [AbortSignal].',
      ),
    );
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('keeps warnings visible when QWEN_DEBUG is set', () => {
    process.env['QWEN_DEBUG'] = '1';
    initializeWarningHandler();
    emit(
      makeWarning(
        'MaxListenersExceededWarning',
        'Possible EventTarget memory leak detected. 1500 abort listeners added to [AbortSignal].',
      ),
    );
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps warnings visible when NODE_ENV=development', () => {
    process.env['NODE_ENV'] = 'development';
    initializeWarningHandler();
    emit(
      makeWarning(
        'MaxListenersExceededWarning',
        'Possible EventTarget memory leak detected. 1500 abort listeners added to [AbortSignal].',
      ),
    );
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — repeated calls install only one listener', () => {
    initializeWarningHandler();
    initializeWarningHandler();
    initializeWarningHandler();
    expect(process.listeners('warning').length).toBe(1);
  });
});
