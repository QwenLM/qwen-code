/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { runLogger, type Config } from '@qwen-code/core';
import { renderHook } from '../../test-utils/render.js';
import {
  buildMcpAuthNotice,
  shouldEnableMcpAuthHeaderNotice,
  useMcpAuthHeaderNotice,
} from './useMcpAuthHeaderNotice.js';

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeConfig(waitPromise: Promise<void>): Config {
  return {
    waitForMcpInit: vi.fn(() => waitPromise),
  } as unknown as Config;
}

async function settleDeferred(resolve: () => void): Promise<void> {
  await act(async () => {
    resolve();
    await Promise.resolve();
  });
}

describe('buildMcpAuthNotice', () => {
  it('formats zero, singular, and plural server counts', () => {
    expect(buildMcpAuthNotice(0)).toBeNull();
    expect(buildMcpAuthNotice(1)).toBe(
      '1 MCP server needs authentication · run /mcp',
    );
    expect(buildMcpAuthNotice(2)).toBe(
      '2 MCP servers need authentication · run /mcp',
    );
  });
});

describe('shouldEnableMcpAuthHeaderNotice', () => {
  it('suppresses the local notice when a session binding is present', () => {
    expect(shouldEnableMcpAuthHeaderNotice(true, true)).toBe(false);
    expect(shouldEnableMcpAuthHeaderNotice(true, false)).toBe(true);
    expect(shouldEnableMcpAuthHeaderNotice(false, false)).toBe(false);
  });
});

describe('useMcpAuthHeaderNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('waits for the complete initial MCP batch before returning a notice', async () => {
    const deferred = createDeferred();
    const config = makeConfig(deferred.promise);
    const { result, unmount } = await renderHook(() =>
      useMcpAuthHeaderNotice(config, true, 1),
    );

    expect(result.current).toBeNull();

    await settleDeferred(deferred.resolve);

    expect(result.current).toBe(
      '1 MCP server needs authentication · run /mcp',
    );
    act(() => unmount());
  });

  it('does not wait before config initialization', async () => {
    const deferred = createDeferred();
    const config = makeConfig(deferred.promise);
    const { result, rerender, unmount } = await renderHook(
      ({ initialized }: { initialized: boolean }) =>
        useMcpAuthHeaderNotice(config, initialized, 1),
      { initialProps: { initialized: false } },
    );

    expect(config.waitForMcpInit).not.toHaveBeenCalled();
    expect(result.current).toBeNull();

    rerender({ initialized: true });
    expect(config.waitForMcpInit).toHaveBeenCalledOnce();

    await settleDeferred(deferred.resolve);
    expect(result.current).toBe(
      '1 MCP server needs authentication · run /mcp',
    );
    act(() => unmount());
  });

  it('keeps the notice reactive after the initial gate opens', async () => {
    const deferred = createDeferred();
    const config = makeConfig(deferred.promise);
    const { result, rerender, unmount } = await renderHook(
      ({ count }: { count: number }) =>
        useMcpAuthHeaderNotice(config, true, count),
      { initialProps: { count: 2 } },
    );

    await settleDeferred(deferred.resolve);
    expect(result.current).toBe(
      '2 MCP servers need authentication · run /mcp',
    );

    rerender({ count: 1 });
    expect(result.current).toBe(
      '1 MCP server needs authentication · run /mcp',
    );

    rerender({ count: 0 });
    expect(result.current).toBeNull();
    expect(config.waitForMcpInit).toHaveBeenCalledOnce();
    act(() => unmount());
  });

  it('does not update after the component unmounts', async () => {
    const deferred = createDeferred();
    const config = makeConfig(deferred.promise);
    const { unmount } = await renderHook(() =>
      useMcpAuthHeaderNotice(config, true, 1),
    );

    act(() => unmount());
    await settleDeferred(deferred.resolve);
  });

  it('logs an unexpected MCP wait failure without showing a notice', async () => {
    const deferred = createDeferred();
    const config = makeConfig(deferred.promise);
    const warnSpy = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
    const { result, unmount } = await renderHook(() =>
      useMcpAuthHeaderNotice(config, true, 1),
    );

    await act(async () => {
      deferred.reject(new Error('wait failed'));
      await Promise.resolve();
    });

    expect(warnSpy).toHaveBeenCalledWith(
      '[MCP] Failed to initialize the authentication notice:',
      'wait failed',
    );
    expect(result.current).toBeNull();
    act(() => unmount());
  });
});
