/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useResumeCommand } from './useResumeCommand.js';

const resumeMocks = vi.hoisted(() => {
  let resolveLoadSession:
    | ((value: { conversation: unknown } | undefined) => void)
    | undefined;
  let pendingLoadSession:
    | Promise<{ conversation: unknown } | undefined>
    | undefined;

  return {
    createPendingLoadSession() {
      pendingLoadSession = new Promise((resolve) => {
        resolveLoadSession = resolve;
      });
      return pendingLoadSession;
    },
    resolvePendingLoadSession(value: { conversation: unknown } | undefined) {
      resolveLoadSession?.(value);
    },
    getPendingLoadSession() {
      return pendingLoadSession;
    },
    reset() {
      resolveLoadSession = undefined;
      pendingLoadSession = undefined;
    },
  };
});

vi.mock('../utils/resumeHistoryUtils.js', () => ({
  buildResumedHistoryItems: vi.fn(() => [{ id: 1, type: 'user', text: 'hi' }]),
}));

vi.mock('@qwen-code/qwen-code-core', () => {
  class SessionService {
    constructor(_cwd: string) {}
    async loadSession(_sessionId: string) {
      return (
        resumeMocks.getPendingLoadSession() ??
        Promise.resolve({
          conversation: [{ role: 'user', parts: [{ text: 'hello' }] }],
        })
      );
    }
  }

  return {
    SessionService,
  };
});

describe('useResumeCommand', () => {
  it('should initialize with dialog closed', () => {
    const { result } = renderHook(() => useResumeCommand());

    expect(result.current.isResumeDialogOpen).toBe(false);
  });

  it('should open the dialog when openResumeDialog is called', () => {
    const { result } = renderHook(() => useResumeCommand());

    act(() => {
      result.current.openResumeDialog();
    });

    expect(result.current.isResumeDialogOpen).toBe(true);
  });

  it('should close the dialog when closeResumeDialog is called', () => {
    const { result } = renderHook(() => useResumeCommand());

    // Open the dialog first
    act(() => {
      result.current.openResumeDialog();
    });

    expect(result.current.isResumeDialogOpen).toBe(true);

    // Close the dialog
    act(() => {
      result.current.closeResumeDialog();
    });

    expect(result.current.isResumeDialogOpen).toBe(false);
  });

  it('should maintain stable function references across renders', () => {
    const { result, rerender } = renderHook(() => useResumeCommand());

    const initialOpenFn = result.current.openResumeDialog;
    const initialCloseFn = result.current.closeResumeDialog;
    const initialHandleResume = result.current.handleResume;

    rerender();

    expect(result.current.openResumeDialog).toBe(initialOpenFn);
    expect(result.current.closeResumeDialog).toBe(initialCloseFn);
    expect(result.current.handleResume).toBe(initialHandleResume);
  });

  it('handleResume no-ops when config is null', async () => {
    const historyManager = { clearItems: vi.fn(), loadHistory: vi.fn() };
    const startNewSession = vi.fn();

    const { result } = renderHook(() =>
      useResumeCommand({
        config: null,
        historyManager,
        startNewSession,
      }),
    );

    await act(async () => {
      await result.current.handleResume('session-1');
    });

    expect(startNewSession).not.toHaveBeenCalled();
    expect(historyManager.clearItems).not.toHaveBeenCalled();
    expect(historyManager.loadHistory).not.toHaveBeenCalled();
  });

  it('handleResume closes the dialog immediately and restores session state', async () => {
    resumeMocks.reset();
    resumeMocks.createPendingLoadSession();

    const historyManager = { clearItems: vi.fn(), loadHistory: vi.fn() };
    const startNewSession = vi.fn();
    const geminiClient = {
      initialize: vi.fn(),
    };

    const config = {
      getTargetDir: () => '/tmp',
      getGeminiClient: () => geminiClient,
      startNewSession: vi.fn(),
    } as unknown as import('@qwen-code/qwen-code-core').Config;

    const { result } = renderHook(() =>
      useResumeCommand({
        config,
        historyManager,
        startNewSession,
      }),
    );

    // Open first so we can verify the dialog closes immediately.
    act(() => {
      result.current.openResumeDialog();
    });
    expect(result.current.isResumeDialogOpen).toBe(true);

    let resumePromise: Promise<void> | undefined;
    act(() => {
      // Start resume but do not await it yet — we want to assert the dialog
      // closes immediately before the async session load completes.
      resumePromise = result.current.handleResume('session-2') as unknown as
        | Promise<void>
        | undefined;
    });
    expect(result.current.isResumeDialogOpen).toBe(false);

    // Now finish the async load and let the handler complete.
    resumeMocks.resolvePendingLoadSession({
      conversation: [{ role: 'user', parts: [{ text: 'hello' }] }],
    });
    await act(async () => {
      await resumePromise;
    });

    expect(config.startNewSession).toHaveBeenCalledWith(
      'session-2',
      expect.objectContaining({
        conversation: expect.anything(),
      }),
    );
    expect(startNewSession).toHaveBeenCalledWith('session-2');
    expect(geminiClient.initialize).toHaveBeenCalledTimes(1);
    expect(historyManager.clearItems).toHaveBeenCalledTimes(1);
    expect(historyManager.loadHistory).toHaveBeenCalledTimes(1);
  });
});
