/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { useDeleteCommand } from './useDeleteCommand.js';
import type { Config, RemoveSessionsResult } from '@qwen-code/qwen-code-core';

function createConfig(opts: {
  currentSessionId: string;
  removeSessions?: (ids: string[]) => Promise<RemoveSessionsResult>;
  removeSession?: (id: string) => Promise<boolean>;
}) {
  const sessionService = {
    removeSession: opts.removeSession ?? vi.fn().mockResolvedValue(true),
    removeSessions:
      opts.removeSessions ??
      vi.fn().mockResolvedValue({ removed: [], notFound: [], errors: [] }),
  };
  return {
    config: {
      getSessionId: () => opts.currentSessionId,
      getSessionService: () => sessionService,
    } as unknown as Config,
    sessionService,
  };
}

const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.clearAllMocks();
});

describe('useDeleteCommand', () => {
  it('opens and closes the dialog', () => {
    const { result } = renderHook(() => useDeleteCommand());

    expect(result.current.isDeleteDialogOpen).toBe(false);

    act(() => {
      result.current.openDeleteDialog();
    });
    expect(result.current.isDeleteDialogOpen).toBe(true);

    act(() => {
      result.current.closeDeleteDialog();
    });
    expect(result.current.isDeleteDialogOpen).toBe(false);
  });

  describe('handleDeleteMany', () => {
    it('removes sessions and reports the count on success', async () => {
      const removeSessions = vi.fn().mockResolvedValue({
        removed: ['a', 'b'],
        notFound: [],
        errors: [],
      });
      const { config } = createConfig({
        currentSessionId: 'current',
        removeSessions,
      });
      const addItem = vi.fn();
      const { result } = renderHook(() =>
        useDeleteCommand({ config, addItem }),
      );

      act(() => {
        result.current.openDeleteDialog();
      });

      await act(async () => {
        result.current.handleDeleteMany(['a', 'b']);
        await flushAsync();
      });

      expect(removeSessions).toHaveBeenCalledWith(['a', 'b']);
      expect(result.current.isDeleteDialogOpen).toBe(false);
      // Read the last call — the progress toast occupies [0].
      const [item] = addItem.mock.calls.at(-1) as [
        { type: string; text: string },
        number,
      ];
      expect(item.type).toBe('info');
      expect(item.text).toContain('2');
    });

    it('emits a progress toast before awaiting the batch', async () => {
      // Block removeSessions so we can observe the toast that lands
      // *before* it resolves — without this, a refactor that drops the
      // pre-await toast (or moves it after the await) would still look
      // green by reading the final addItem state.
      let resolveRemove: (value: RemoveSessionsResult) => void = () => {};
      const removeSessions = vi.fn(
        () =>
          new Promise<RemoveSessionsResult>((resolve) => {
            resolveRemove = resolve;
          }),
      );
      const { config } = createConfig({
        currentSessionId: 'current',
        removeSessions,
      });
      const addItem = vi.fn();
      const { result } = renderHook(() =>
        useDeleteCommand({ config, addItem }),
      );

      await act(async () => {
        result.current.handleDeleteMany(['a', 'b', 'c']);
        await flushAsync();
      });

      // Progress toast must already be in place while the batch is in
      // flight, so a slow filesystem doesn't leave the user staring at
      // a closed dialog with no feedback.
      expect(addItem).toHaveBeenCalledTimes(1);
      const [progress] = addItem.mock.calls[0] as [
        { type: string; text: string },
        number,
      ];
      expect(progress.type).toBe('info');
      expect(progress.text).toContain('3');

      await act(async () => {
        resolveRemove({ removed: ['a', 'b', 'c'], notFound: [], errors: [] });
        await flushAsync();
      });

      // Result toast lands on top of the progress toast.
      expect(addItem).toHaveBeenCalledTimes(2);
    });

    it('strips the active session id before deleting', async () => {
      const removeSessions = vi.fn().mockResolvedValue({
        removed: ['a'],
        notFound: [],
        errors: [],
      });
      const { config } = createConfig({
        currentSessionId: 'current',
        removeSessions,
      });
      const addItem = vi.fn();
      const { result } = renderHook(() =>
        useDeleteCommand({ config, addItem }),
      );

      await act(async () => {
        result.current.handleDeleteMany(['a', 'current']);
        await flushAsync();
      });

      expect(removeSessions).toHaveBeenCalledWith(['a']);
    });

    it('surfaces an info toast when the active session is stripped', async () => {
      // Without this toast the progress message ("Deleting 1 session(s)...")
      // contradicts the input the user submitted (2 ids) and they're left
      // unsure whether the current session was just refused, retried, or
      // silently absorbed by the batch.
      const removeSessions = vi.fn().mockResolvedValue({
        removed: ['a'],
        notFound: [],
        errors: [],
      });
      const { config } = createConfig({
        currentSessionId: 'current',
        removeSessions,
      });
      const addItem = vi.fn();
      const { result } = renderHook(() =>
        useDeleteCommand({ config, addItem }),
      );

      await act(async () => {
        result.current.handleDeleteMany(['a', 'current']);
        await flushAsync();
      });

      const texts = addItem.mock.calls.map(
        (c) => (c[0] as { text: string }).text,
      );
      expect(texts.some((t) => /current active session skipped/i.test(t))).toBe(
        true,
      );
    });

    it('shows an info message when only the current session was selected', async () => {
      const removeSessions = vi.fn();
      const { config } = createConfig({
        currentSessionId: 'current',
        removeSessions,
      });
      const addItem = vi.fn();
      const { result } = renderHook(() =>
        useDeleteCommand({ config, addItem }),
      );

      await act(async () => {
        result.current.handleDeleteMany(['current']);
        await flushAsync();
      });

      expect(removeSessions).not.toHaveBeenCalled();
      const [item] = addItem.mock.calls[0] as [
        { type: string; text: string },
        number,
      ];
      expect(item.type).toBe('info');
      expect(item.text).toContain('current active');
    });

    it('reports a partial failure with type=error and surfaces failing ids + reason', async () => {
      // Use long, distinguishable ids so we can assert they were truncated
      // to the 8-char prefix the toast is supposed to show.
      const removeSessions = vi.fn().mockResolvedValue({
        removed: ['aaaaaaaa-removed'],
        notFound: ['bbbbbbbb-missing'],
        errors: [
          { sessionId: 'cccccccc-failed', error: new Error('disk full') },
        ],
      });
      const { config } = createConfig({
        currentSessionId: 'current',
        removeSessions,
      });
      const addItem = vi.fn();
      const { result } = renderHook(() =>
        useDeleteCommand({ config, addItem }),
      );

      await act(async () => {
        result.current.handleDeleteMany([
          'aaaaaaaa-removed',
          'bbbbbbbb-missing',
          'cccccccc-failed',
        ]);
        await flushAsync();
      });

      // First call is the "Deleting N session(s)..." progress toast;
      // the result toast lands afterwards.
      const [item] = addItem.mock.calls.at(-1) as [
        { type: string; text: string },
        number,
      ];
      // Partial failure must look distinct from a clean delete.
      expect(item.type).toBe('error');
      expect(item.text).toContain('1');
      expect(item.text).toContain('2');
      // Failing ids (truncated to 8 chars) must be visible so the user can
      // identify them.
      expect(item.text).toContain('bbbbbbbb');
      expect(item.text).toContain('cccccccc');
      // First underlying error message should be surfaced.
      expect(item.text).toContain('disk full');
    });

    it('reports a full failure with type=error and surfaces failing ids + reason', async () => {
      const removeSessions = vi.fn().mockResolvedValue({
        removed: [],
        notFound: ['xxxxxxxx-missing'],
        errors: [
          {
            sessionId: 'yyyyyyyy-failed',
            error: new Error('permission denied'),
          },
        ],
      });
      const { config } = createConfig({
        currentSessionId: 'current',
        removeSessions,
      });
      const addItem = vi.fn();
      const { result } = renderHook(() =>
        useDeleteCommand({ config, addItem }),
      );

      await act(async () => {
        result.current.handleDeleteMany([
          'xxxxxxxx-missing',
          'yyyyyyyy-failed',
        ]);
        await flushAsync();
      });

      const [item] = addItem.mock.calls.at(-1) as [
        { type: string; text: string },
        number,
      ];
      expect(item.type).toBe('error');
      expect(item.text).toContain('Failed to delete');
      expect(item.text).toContain('2');
      expect(item.text).toContain('xxxxxxxx');
      expect(item.text).toContain('yyyyyyyy');
      expect(item.text).toContain('permission denied');
    });

    it('truncates failing-id list to 3 with overflow indicator', async () => {
      const removeSessions = vi.fn().mockResolvedValue({
        removed: ['ok'],
        notFound: ['n1', 'n2', 'n3', 'n4', 'n5'],
        errors: [],
      });
      const { config } = createConfig({
        currentSessionId: 'current',
        removeSessions,
      });
      const addItem = vi.fn();
      const { result } = renderHook(() =>
        useDeleteCommand({ config, addItem }),
      );

      await act(async () => {
        result.current.handleDeleteMany(['ok', 'n1', 'n2', 'n3', 'n4', 'n5']);
        await flushAsync();
      });

      const [item] = addItem.mock.calls.at(-1) as [
        { type: string; text: string },
        number,
      ];
      // Three samples shown, the rest collapsed into "+2 more".
      expect(item.text).toContain('n1');
      expect(item.text).toContain('n2');
      expect(item.text).toContain('n3');
      expect(item.text).toContain('+2 more');
    });

    it('drops a re-entrant call while a batch is in flight and tells the user', async () => {
      // closeDeleteDialog() runs synchronously before removeSessions
      // resolves, so the user can re-open /delete and trigger a second
      // batch. Without the in-flight guard, two batches race on
      // potentially overlapping ids — guard must drop the second call
      // and explain why it was ignored.
      let resolveRemove: (value: RemoveSessionsResult) => void = () => {};
      const removeSessions = vi.fn(
        () =>
          new Promise<RemoveSessionsResult>((resolve) => {
            resolveRemove = resolve;
          }),
      );
      const { config } = createConfig({
        currentSessionId: 'current',
        removeSessions,
      });
      const addItem = vi.fn();
      const { result } = renderHook(() =>
        useDeleteCommand({ config, addItem }),
      );

      // Kick off the first batch — it stays pending on removeSessions.
      await act(async () => {
        result.current.handleDeleteMany(['a']);
        await flushAsync();
      });
      expect(removeSessions).toHaveBeenCalledTimes(1);

      // Second invocation while the first is still in flight — must
      // be dropped with feedback, but no extra removeSessions call.
      await act(async () => {
        result.current.handleDeleteMany(['b']);
        await flushAsync();
      });
      expect(removeSessions).toHaveBeenCalledTimes(1);
      const [busyItem] = addItem.mock.calls.at(-1) as [
        { type: string; text: string },
        number,
      ];
      expect(busyItem.type).toBe('info');
      expect(busyItem.text).toContain('already in progress');

      // Resolve the first batch and verify the guard releases so a
      // subsequent /delete works normally.
      await act(async () => {
        resolveRemove({ removed: ['a'], notFound: [], errors: [] });
        await flushAsync();
      });
      await act(async () => {
        result.current.handleDeleteMany(['b']);
        await flushAsync();
      });
      expect(removeSessions).toHaveBeenCalledTimes(2);
      expect(removeSessions).toHaveBeenLastCalledWith(['b']);
    });

    it('blocks single-delete while a batch delete is in flight', async () => {
      let resolveRemove: (value: RemoveSessionsResult) => void = () => {};
      const removeSessions = vi.fn(
        () =>
          new Promise<RemoveSessionsResult>((resolve) => {
            resolveRemove = resolve;
          }),
      );
      const removeSession = vi.fn().mockResolvedValue(true);
      const { config } = createConfig({
        currentSessionId: 'current',
        removeSessions,
        removeSession,
      });
      const addItem = vi.fn();
      const { result } = renderHook(() =>
        useDeleteCommand({ config, addItem }),
      );

      await act(async () => {
        result.current.handleDeleteMany(['a']);
        await flushAsync();
      });

      await act(async () => {
        result.current.handleDelete('a');
        await flushAsync();
      });

      expect(removeSession).not.toHaveBeenCalled();
      const [busyItem] = addItem.mock.calls.at(-1) as [
        { type: string; text: string },
        number,
      ];
      expect(busyItem.type).toBe('info');
      expect(busyItem.text).toContain('already in progress');

      await act(async () => {
        resolveRemove({ removed: ['a'], notFound: [], errors: [] });
        await flushAsync();
      });
    });

    it('releases the in-flight guard even when only the current session was selected', async () => {
      // Early-return path (filtered.length === 0) must still release
      // the guard — otherwise the next /delete invocation gets dropped
      // for the rest of the session.
      const { config, sessionService } = createConfig({
        currentSessionId: 'current',
      });
      const addItem = vi.fn();
      const { result } = renderHook(() =>
        useDeleteCommand({ config, addItem }),
      );

      await act(async () => {
        result.current.handleDeleteMany(['current']);
        await flushAsync();
      });

      // Subsequent normal batch should go through.
      await act(async () => {
        result.current.handleDeleteMany(['x']);
        await flushAsync();
      });
      expect(sessionService.removeSessions).toHaveBeenCalledWith(['x']);
    });

    it('reports an error when the call throws and releases the in-flight guard', async () => {
      const removeSessions = vi
        .fn()
        .mockRejectedValueOnce(new Error('nope'))
        .mockResolvedValueOnce({ removed: ['b'], notFound: [], errors: [] });
      const { config } = createConfig({
        currentSessionId: 'current',
        removeSessions,
      });
      const addItem = vi.fn();
      const { result } = renderHook(() =>
        useDeleteCommand({ config, addItem }),
      );

      await act(async () => {
        result.current.handleDeleteMany(['a']);
        await flushAsync();
      });

      const [item] = addItem.mock.calls.at(-1) as [
        { type: string; text: string },
        number,
      ];
      expect(item.type).toBe('error');
      // The original error message must surface for diagnostics — bare
      // "Failed to delete sessions." would hide the root cause.
      expect(item.text).toContain('nope');

      await act(async () => {
        result.current.handleDeleteMany(['b']);
        await flushAsync();
      });

      expect(removeSessions).toHaveBeenCalledTimes(2);
      expect(removeSessions).toHaveBeenLastCalledWith(['b']);
    });

    it('reports non-Error thrown values from batch deletion', async () => {
      const removeSessions = vi.fn().mockRejectedValueOnce('raw failure');
      const { config } = createConfig({
        currentSessionId: 'current',
        removeSessions,
      });
      const addItem = vi.fn();
      const { result } = renderHook(() =>
        useDeleteCommand({ config, addItem }),
      );

      await act(async () => {
        result.current.handleDeleteMany(['a']);
        await flushAsync();
      });

      const [item] = addItem.mock.calls.at(-1) as [
        { type: string; text: string },
        number,
      ];
      expect(item.type).toBe('error');
      expect(item.text).toContain('raw failure');
    });
  });
});
