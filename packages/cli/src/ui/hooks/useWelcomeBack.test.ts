/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useWelcomeBack } from './useWelcomeBack.js';
import { type Settings } from '../../config/settingsSchema.js';

const welcomeBackMocks = vi.hoisted(() => {
  const getProjectSummaryInfo = vi.fn();
  const listSessions = vi.fn();

  return {
    getProjectSummaryInfo,
    listSessions,
    sessionServiceCtor: vi.fn(),
  };
});

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();

  class SessionService {
    constructor(cwd: string) {
      welcomeBackMocks.sessionServiceCtor(cwd);
    }
    listSessions(...args: unknown[]) {
      return welcomeBackMocks.listSessions(...args);
    }
  }

  return {
    ...actual,
    SessionService,
    getProjectSummaryInfo: welcomeBackMocks.getProjectSummaryInfo,
  };
});

function makeConfig() {
  return {
    getTargetDir: () => '/tmp/test-project',
    getDebugLogger: () => ({
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  } as unknown as import('@qwen-code/qwen-code-core').Config;
}

function makeBuffer() {
  return { setText: vi.fn() };
}

const summaryWithHistory = {
  hasHistory: true,
  content: '# Project Summary\n\n## Overall Goal\nBuild things',
};

describe('useWelcomeBack', () => {
  beforeEach(() => {
    welcomeBackMocks.getProjectSummaryInfo.mockReset();
    welcomeBackMocks.listSessions.mockReset();
    welcomeBackMocks.sessionServiceCtor.mockReset();
  });

  it('shows the welcome-back dialog when a project summary exists', async () => {
    welcomeBackMocks.getProjectSummaryInfo.mockResolvedValue(
      summaryWithHistory,
    );

    const config = makeConfig();
    const buffer = makeBuffer();
    const submitQuery = vi.fn();
    const settings = {} as Settings;

    const { result } = renderHook(() =>
      useWelcomeBack(config, submitQuery, buffer, settings),
    );

    await waitFor(() => {
      expect(result.current.showWelcomeBackDialog).toBe(true);
    });
    expect(result.current.welcomeBackInfo).toEqual(summaryWithHistory);
  });

  it('does not show the dialog when enableWelcomeBack is false', async () => {
    welcomeBackMocks.getProjectSummaryInfo.mockResolvedValue(
      summaryWithHistory,
    );

    const config = makeConfig();
    const buffer = makeBuffer();
    const submitQuery = vi.fn();
    const settings = { ui: { enableWelcomeBack: false } } as Settings;

    const { result } = renderHook(() =>
      useWelcomeBack(config, submitQuery, buffer, settings),
    );

    // Allow any pending microtasks to flush.
    await act(async () => {
      await Promise.resolve();
    });

    expect(welcomeBackMocks.getProjectSummaryInfo).not.toHaveBeenCalled();
    expect(result.current.showWelcomeBackDialog).toBe(false);
  });

  it('resumes the most recent session when "continue" is selected and a session exists', async () => {
    welcomeBackMocks.getProjectSummaryInfo.mockResolvedValue(
      summaryWithHistory,
    );
    welcomeBackMocks.listSessions.mockResolvedValue({
      items: [{ sessionId: 'session-abc' }],
      hasMore: false,
    });

    const config = makeConfig();
    const buffer = makeBuffer();
    const submitQuery = vi.fn();
    const settings = {} as Settings;
    const handleResume = vi.fn().mockResolvedValue(true);

    const { result } = renderHook(() =>
      useWelcomeBack(config, submitQuery, buffer, settings, handleResume),
    );

    await waitFor(() => {
      expect(result.current.showWelcomeBackDialog).toBe(true);
    });

    await act(async () => {
      await result.current.handleWelcomeBackSelection('continue');
    });

    expect(welcomeBackMocks.sessionServiceCtor).toHaveBeenCalledWith(
      '/tmp/test-project',
    );
    expect(welcomeBackMocks.listSessions).toHaveBeenCalledWith({ size: 1 });
    expect(handleResume).toHaveBeenCalledWith('session-abc');
    // Fallback path must NOT fire when resume succeeds.
    expect(buffer.setText).not.toHaveBeenCalled();
    expect(result.current.shouldFillInput).toBe(false);
    expect(result.current.welcomeBackChoice).toBe('continue');
    expect(result.current.showWelcomeBackDialog).toBe(false);
  });

  it('falls back to input fill when handleResume reports failure (e.g. loadSession returned undefined)', async () => {
    welcomeBackMocks.getProjectSummaryInfo.mockResolvedValue(
      summaryWithHistory,
    );
    welcomeBackMocks.listSessions.mockResolvedValue({
      items: [{ sessionId: 'session-stale' }],
      hasMore: false,
    });

    const config = makeConfig();
    const buffer = makeBuffer();
    const submitQuery = vi.fn();
    const settings = {} as Settings;
    // handleResume short-circuits and returns false (e.g., the listed session
    // file disappeared between listSessions and loadSession, or is malformed).
    const handleResume = vi.fn().mockResolvedValue(false);

    const { result } = renderHook(() =>
      useWelcomeBack(config, submitQuery, buffer, settings, handleResume),
    );

    await waitFor(() => {
      expect(result.current.showWelcomeBackDialog).toBe(true);
    });

    await act(async () => {
      await result.current.handleWelcomeBackSelection('continue');
    });

    expect(handleResume).toHaveBeenCalledWith('session-stale');
    // Fallback should fire because the resume reported failure.
    await waitFor(() => {
      expect(buffer.setText).toHaveBeenCalledWith(
        "@.qwen/PROJECT_SUMMARY.md, Based on our previous conversation,Let's continue?",
      );
    });
  });

  it('falls back to input fill when no session exists for the project', async () => {
    welcomeBackMocks.getProjectSummaryInfo.mockResolvedValue(
      summaryWithHistory,
    );
    welcomeBackMocks.listSessions.mockResolvedValue({
      items: [],
      hasMore: false,
    });

    const config = makeConfig();
    const buffer = makeBuffer();
    const submitQuery = vi.fn();
    const settings = {} as Settings;
    const handleResume = vi.fn();

    const { result } = renderHook(() =>
      useWelcomeBack(config, submitQuery, buffer, settings, handleResume),
    );

    await waitFor(() => {
      expect(result.current.showWelcomeBackDialog).toBe(true);
    });

    await act(async () => {
      await result.current.handleWelcomeBackSelection('continue');
    });

    expect(handleResume).not.toHaveBeenCalled();
    // The effect that flushes inputFillText to the buffer runs on the next
    // render; waitFor lets us observe it deterministically.
    await waitFor(() => {
      expect(buffer.setText).toHaveBeenCalledWith(
        "@.qwen/PROJECT_SUMMARY.md, Based on our previous conversation,Let's continue?",
      );
    });
  });

  it('falls back to input fill when handleResume is not provided', async () => {
    welcomeBackMocks.getProjectSummaryInfo.mockResolvedValue(
      summaryWithHistory,
    );

    const config = makeConfig();
    const buffer = makeBuffer();
    const submitQuery = vi.fn();
    const settings = {} as Settings;

    const { result } = renderHook(() =>
      useWelcomeBack(config, submitQuery, buffer, settings),
    );

    await waitFor(() => {
      expect(result.current.showWelcomeBackDialog).toBe(true);
    });

    await act(async () => {
      await result.current.handleWelcomeBackSelection('continue');
    });

    expect(welcomeBackMocks.listSessions).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(buffer.setText).toHaveBeenCalledWith(
        "@.qwen/PROJECT_SUMMARY.md, Based on our previous conversation,Let's continue?",
      );
    });
  });

  it('falls back to input fill when listSessions throws', async () => {
    welcomeBackMocks.getProjectSummaryInfo.mockResolvedValue(
      summaryWithHistory,
    );
    welcomeBackMocks.listSessions.mockRejectedValue(new Error('disk error'));

    const config = makeConfig();
    const buffer = makeBuffer();
    const submitQuery = vi.fn();
    const settings = {} as Settings;
    const handleResume = vi.fn();

    const { result } = renderHook(() =>
      useWelcomeBack(config, submitQuery, buffer, settings, handleResume),
    );

    await waitFor(() => {
      expect(result.current.showWelcomeBackDialog).toBe(true);
    });

    await act(async () => {
      await result.current.handleWelcomeBackSelection('continue');
    });

    expect(handleResume).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(buffer.setText).toHaveBeenCalledWith(
        "@.qwen/PROJECT_SUMMARY.md, Based on our previous conversation,Let's continue?",
      );
    });
  });

  it('does nothing on "restart" beyond closing the dialog', async () => {
    welcomeBackMocks.getProjectSummaryInfo.mockResolvedValue(
      summaryWithHistory,
    );

    const config = makeConfig();
    const buffer = makeBuffer();
    const submitQuery = vi.fn();
    const settings = {} as Settings;
    const handleResume = vi.fn();

    const { result } = renderHook(() =>
      useWelcomeBack(config, submitQuery, buffer, settings, handleResume),
    );

    await waitFor(() => {
      expect(result.current.showWelcomeBackDialog).toBe(true);
    });

    await act(async () => {
      await result.current.handleWelcomeBackSelection('restart');
    });

    expect(handleResume).not.toHaveBeenCalled();
    expect(welcomeBackMocks.listSessions).not.toHaveBeenCalled();
    expect(buffer.setText).not.toHaveBeenCalled();
    expect(result.current.welcomeBackChoice).toBe('restart');
    expect(result.current.showWelcomeBackDialog).toBe(false);
  });
});
