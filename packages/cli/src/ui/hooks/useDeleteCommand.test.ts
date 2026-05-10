/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { useDeleteCommand } from './useDeleteCommand.js';
import type { Config } from '@qwen-code/qwen-code-core';

interface RemoveSessionsResult {
  removed: string[];
  notFound: string[];
  errors: Array<{ sessionId: string; error: Error }>;
}

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

    it('reports an error when the call throws', async () => {
      const removeSessions = vi.fn().mockRejectedValue(new Error('nope'));
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
    });
  });
});
