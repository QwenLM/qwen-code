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
      const [item] = addItem.mock.calls[0] as [
        { type: string; text: string },
        number,
      ];
      expect(item.type).toBe('info');
      expect(item.text).toContain('2');
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

    it('reports a partial failure when some ids could not be removed', async () => {
      const removeSessions = vi.fn().mockResolvedValue({
        removed: ['a'],
        notFound: ['b'],
        errors: [{ sessionId: 'c', error: new Error('boom') }],
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
        result.current.handleDeleteMany(['a', 'b', 'c']);
        await flushAsync();
      });

      const [item] = addItem.mock.calls[0] as [
        { type: string; text: string },
        number,
      ];
      expect(item.type).toBe('info');
      expect(item.text).toContain('1');
      expect(item.text).toContain('2');
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

      const [item] = addItem.mock.calls[0] as [
        { type: string; text: string },
        number,
      ];
      expect(item.type).toBe('error');
    });
  });
});
