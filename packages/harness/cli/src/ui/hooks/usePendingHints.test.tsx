/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { renderHook } from '../../test-utils/render.js';
import type { Config, InjectionSource } from '@qwen-code/core';
import { usePendingHints } from './usePendingHints.js';

interface FakeInjection {
  emit: (text: string, source: InjectionSource) => void;
  listenerCount: () => number;
}

function makeConfig(): { config: Config; injection: FakeInjection } {
  const listeners = new Set<(text: string, source: InjectionSource) => void>();
  const injection = {
    emit: (text: string, source: InjectionSource) => {
      for (const l of listeners) l(text, source);
    },
    listenerCount: () => listeners.size,
  };
  const config = {
    injectionService: {
      onInjection: (l: (text: string, source: InjectionSource) => void) => {
        listeners.add(l);
      },
      offInjection: (l: (text: string, source: InjectionSource) => void) => {
        listeners.delete(l);
      },
    },
  } as unknown as Config;
  return { config, injection };
}

describe('usePendingHints', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with zero hints and consume returns null', async () => {
    const { config } = makeConfig();
    const { result } = await renderHook(() => usePendingHints(config));
    expect(result.current.pendingHintCount).toBe(0);
    expect(result.current.consumePendingHints()).toBeNull();
  });

  it('buffers user_steering injections and exposes the count', async () => {
    const { config, injection } = makeConfig();
    const { result } = await renderHook(() => usePendingHints(config));

    act(() => {
      injection.emit('first', 'user_steering');
      injection.emit('second', 'user_steering');
    });

    expect(result.current.pendingHintCount).toBe(2);
  });

  it('ignores non-user_steering injections', async () => {
    const { config, injection } = makeConfig();
    const { result } = await renderHook(() => usePendingHints(config));

    act(() => {
      injection.emit('bg', 'background_completion' as InjectionSource);
    });

    expect(result.current.pendingHintCount).toBe(0);
  });

  it('consume returns joined text and resets the buffer', async () => {
    const { config, injection } = makeConfig();
    const { result } = await renderHook(() => usePendingHints(config));

    act(() => {
      injection.emit('one', 'user_steering');
      injection.emit('two', 'user_steering');
    });

    let consumed: string | null = null;
    act(() => {
      consumed = result.current.consumePendingHints();
    });
    expect(consumed).toBe('one\ntwo');
    expect(result.current.pendingHintCount).toBe(0);
    expect(result.current.consumePendingHints()).toBeNull();
  });

  it('detaches the listener on unmount', async () => {
    const { config, injection } = makeConfig();
    const { unmount } = await renderHook(() => usePendingHints(config));
    expect(injection.listenerCount()).toBe(1);
    unmount();
    expect(injection.listenerCount()).toBe(0);
  });
});
