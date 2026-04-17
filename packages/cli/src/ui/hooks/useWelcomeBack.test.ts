/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWelcomeBack } from './useWelcomeBack.js';

const coreMocks = vi.hoisted(() => ({
  getProjectSummaryInfo: vi.fn(),
  getWelcomeBackState: vi.fn(),
  saveWelcomeBackRestartChoice: vi.fn().mockResolvedValue(undefined),
  clearWelcomeBackState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();

  return {
    ...actual,
    getProjectSummaryInfo: coreMocks.getProjectSummaryInfo,
    getWelcomeBackState: coreMocks.getWelcomeBackState,
    saveWelcomeBackRestartChoice: coreMocks.saveWelcomeBackRestartChoice,
    clearWelcomeBackState: coreMocks.clearWelcomeBackState,
  };
});

describe('useWelcomeBack', () => {
  const buffer = {
    setText: vi.fn(),
  };
  const config = {
    getDebugLogger: () => ({
      debug: vi.fn(),
    }),
  };
  const settings = {
    ui: {},
  };

  beforeEach(() => {
    vi.clearAllMocks();
    coreMocks.getProjectSummaryInfo.mockResolvedValue({
      hasHistory: true,
      content: 'summary',
      summaryFingerprint: 'summary-v1',
    });
    coreMocks.getWelcomeBackState.mockResolvedValue(null);
  });

  it('suppresses the dialog when restart was already chosen for the same summary', async () => {
    coreMocks.getWelcomeBackState.mockResolvedValue({
      lastChoice: 'restart',
      summaryFingerprint: 'summary-v1',
    });

    const { result } = renderHook(() =>
      useWelcomeBack(config as never, vi.fn(), buffer, settings as never),
    );

    await waitFor(() => {
      expect(coreMocks.getProjectSummaryInfo).toHaveBeenCalled();
    });

    expect(result.current.showWelcomeBackDialog).toBe(false);
    expect(result.current.welcomeBackInfo).toBeNull();
  });

  it('shows the dialog when the summary fingerprint changed', async () => {
    coreMocks.getWelcomeBackState.mockResolvedValue({
      lastChoice: 'restart',
      summaryFingerprint: 'summary-v0',
    });

    const { result } = renderHook(() =>
      useWelcomeBack(config as never, vi.fn(), buffer, settings as never),
    );

    await waitFor(() => {
      expect(result.current.showWelcomeBackDialog).toBe(true);
    });

    expect(result.current.welcomeBackInfo?.summaryFingerprint).toBe(
      'summary-v1',
    );
  });

  it('persists the restart choice for the current summary fingerprint', async () => {
    const { result } = renderHook(() =>
      useWelcomeBack(config as never, vi.fn(), buffer, settings as never),
    );

    await waitFor(() => {
      expect(result.current.showWelcomeBackDialog).toBe(true);
    });

    act(() => {
      result.current.handleWelcomeBackSelection('restart');
    });

    expect(coreMocks.saveWelcomeBackRestartChoice).toHaveBeenCalledWith(
      'summary-v1',
    );
    expect(result.current.showWelcomeBackDialog).toBe(false);
  });

  it('clears persisted state and fills the continue prompt when resuming', async () => {
    const { result } = renderHook(() =>
      useWelcomeBack(config as never, vi.fn(), buffer, settings as never),
    );

    await waitFor(() => {
      expect(result.current.showWelcomeBackDialog).toBe(true);
    });

    act(() => {
      result.current.handleWelcomeBackSelection('continue');
    });

    await waitFor(() => {
      expect(buffer.setText).toHaveBeenCalledWith(
        "@.qwen/PROJECT_SUMMARY.md, Based on our previous conversation,Let's continue?",
      );
    });

    expect(coreMocks.clearWelcomeBackState).toHaveBeenCalled();
  });
});
