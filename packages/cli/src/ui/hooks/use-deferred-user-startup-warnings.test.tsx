/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { StrictMode, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { DeferredUserStartupWarnings } from '../../utils/userStartupWarnings.js';
import { useDeferredUserStartupWarnings } from './use-deferred-user-startup-warnings.js';

function fixture(config = {} as Config) {
  const controller = new AbortController();
  let resolve!: (warnings: string[]) => void;
  let reject!: (error: unknown) => void;
  const pending: DeferredUserStartupWarnings = {
    config,
    workspaceRoot: process.cwd(),
    signal: controller.signal,
    promise: new Promise<string[]>((yes, no) => {
      resolve = yes;
      reject = no;
    }),
  };
  return { config, pending, controller, resolve, reject };
}

afterEach(() => vi.restoreAllMocks());

describe('useDeferredUserStartupWarnings', () => {
  it('exposes late warnings once and preserves them across unrelated rerenders', async () => {
    const f = fixture();
    const { result, rerender, unmount } = renderHook(() =>
      useDeferredUserStartupWarnings(f.config, f.pending),
    );
    expect(result.current).toEqual([]);
    await act(async () => f.resolve(['late warning', 'late warning']));
    expect(result.current).toEqual(['late warning']);
    rerender();
    expect(result.current).toEqual(['late warning']);
    unmount();
    expect(f.controller.signal.aborted).toBe(false);
  });

  it.each([new Error('failed check'), 'failed check'])(
    'observes a rejected request as a visible warning (%s)',
    async (error) => {
      const f = fixture();
      const { result, unmount } = renderHook(() =>
        useDeferredUserStartupWarnings(f.config, f.pending),
      );
      await act(async () => f.reject(error));
      expect(result.current).toEqual([
        'Could not check startup warnings: failed check',
      ]);
      unmount();
    },
  );

  it('resubscribes in StrictMode without aborting the shared request', async () => {
    const f = fixture();
    const { result, unmount } = renderHook(
      () => useDeferredUserStartupWarnings(f.config, f.pending),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <StrictMode>{children}</StrictMode>
        ),
      },
    );
    expect(f.controller.signal.aborted).toBe(false);
    await act(async () => f.resolve(['late warning']));
    expect(result.current).toEqual(['late warning']);
    unmount();
    expect(f.controller.signal.aborted).toBe(false);
  });

  it('clears an old owner synchronously and ignores its late rejection', async () => {
    const first = fixture();
    const second = fixture();
    const { result, rerender, unmount } = renderHook(
      ({ owner }) =>
        useDeferredUserStartupWarnings(owner.config, owner.pending),
      { initialProps: { owner: first } },
    );
    rerender({ owner: second });
    await act(async () => second.resolve(['second warning']));
    await act(async () => first.reject(new Error('old failure')));
    expect(result.current).toEqual(['second warning']);
    unmount();
  });

  it('does not show the previous selection while a replacement is pending', async () => {
    const first = fixture();
    const second = fixture();
    const { result, rerender, unmount } = renderHook(
      ({ owner }) =>
        useDeferredUserStartupWarnings(owner.config, owner.pending),
      { initialProps: { owner: first } },
    );
    await act(async () => first.resolve(['first warning']));
    expect(result.current).toEqual(['first warning']);
    rerender({ owner: second });
    expect(result.current).toEqual([]);
    unmount();
  });

  it('rejects a foreign Config even when the request has settled', async () => {
    const f = fixture();
    const foreign = {} as Config;
    const { result, unmount } = renderHook(() =>
      useDeferredUserStartupWarnings(foreign, f.pending),
    );
    await act(async () => f.resolve(['foreign warning']));
    expect(result.current).toEqual([]);
    unmount();
  });

  it('rebinds A to B to A without an old subscription overwriting the new one', async () => {
    const first = fixture();
    const second = fixture();
    const successor = fixture(first.config);
    const { result, rerender, unmount } = renderHook(
      ({ owner }) =>
        useDeferredUserStartupWarnings(owner.config, owner.pending),
      { initialProps: { owner: first } },
    );
    rerender({ owner: second });
    rerender({ owner: successor });
    await act(async () => successor.resolve(['new A warning']));
    await act(async () => {
      first.resolve(['old A warning']);
      second.resolve(['old B warning']);
    });
    expect(result.current).toEqual(['new A warning']);
    unmount();
  });

  it('ignores settlement after unmount without aborting its shared request', async () => {
    const f = fixture();
    const { result, unmount } = renderHook(() =>
      useDeferredUserStartupWarnings(f.config, f.pending),
    );
    unmount();
    await act(async () => f.resolve(['late warning']));
    expect(result.current).toEqual([]);
    expect(f.controller.signal.aborted).toBe(false);
  });

  it('clears a displayed result on abort and ignores a pending aborted rejection', async () => {
    const first = fixture();
    const second = fixture();
    const { result, rerender, unmount } = renderHook(
      ({ owner }) =>
        useDeferredUserStartupWarnings(owner.config, owner.pending),
      { initialProps: { owner: first } },
    );
    await act(async () => first.resolve(['first warning']));
    act(() => first.controller.abort());
    expect(result.current).toEqual([]);
    rerender({ owner: second });
    await act(async () => {
      second.controller.abort();
      second.reject(new Error('aborted check'));
    });
    expect(result.current).toEqual([]);
    unmount();
  });

  it('rejects a result when cwd changes before settlement', async () => {
    const f = fixture();
    const cwd = vi
      .spyOn(process, 'cwd')
      .mockReturnValue(f.pending.workspaceRoot);
    const { result, rerender, unmount } = renderHook(() =>
      useDeferredUserStartupWarnings(f.config, f.pending),
    );
    cwd.mockReturnValue(`${f.pending.workspaceRoot}/another-workspace`);
    await act(async () => f.resolve(['old workspace warning']));
    rerender();
    expect(result.current).toEqual([]);
    unmount();
  });
});
