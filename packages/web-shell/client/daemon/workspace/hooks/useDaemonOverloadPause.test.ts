// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { DaemonStatusReport } from '@qwen-code/sdk/daemon';
import {
  OVERLOAD_POLL_INTERVAL_MS,
  OVERLOAD_REFUSAL_TTL_MS,
  useDaemonOverloadPause,
} from './useDaemonOverloadPause.js';

const statusMock = vi.hoisted(() => ({
  report: undefined as DaemonStatusReport | undefined,
  reload: vi.fn(),
}));

vi.mock('./useDaemonStatusReport.js', () => ({
  useDaemonStatusReport: () => ({
    report: statusMock.report,
    reload: statusMock.reload,
    loading: false,
    error: undefined,
  }),
}));

function reportWith(overloaded: boolean): DaemonStatusReport {
  return {
    runtime: {
      loadAdmission: {
        enabled: true,
        overloaded,
        reason: overloaded ? 'cpu_load' : null,
        loadRatio: overloaded ? 2.5 : 0.3,
        eventLoopLagP99Ms: 20,
        sampledAtMs: 1_000,
      },
    },
  } as unknown as DaemonStatusReport;
}

describe('useDaemonOverloadPause', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    statusMock.report = undefined;
    statusMock.reload.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const renderPause = (
    refusal: { message: string; expiresAt: number } | null = null,
    enabled = true,
  ) => {
    const onRefusalExpired = vi.fn();
    const view = renderHook(() =>
      useDaemonOverloadPause({ enabled, refusal, onRefusalExpired }),
    );
    return { view, onRefusalExpired };
  };

  it('pauses while the poll reports overload', () => {
    statusMock.report = reportWith(true);
    const { view } = renderPause();
    expect(view.result.current.paused).toBe(true);
    expect(view.result.current.pollOverloaded).toBe(true);
    expect(view.result.current.loadAdmission?.loadRatio).toBe(2.5);
  });

  it('stays unpaused with a normal poll and no refusal', () => {
    statusMock.report = reportWith(false);
    const { view } = renderPause();
    expect(view.result.current.paused).toBe(false);
  });

  it('stays unpaused when the daemon omits the field entirely', () => {
    statusMock.report = { runtime: {} } as unknown as DaemonStatusReport;
    const { view } = renderPause();
    expect(view.result.current.paused).toBe(false);
  });

  it('pauses on an unexpired refusal even while the poll looks normal', () => {
    statusMock.report = reportWith(false);
    const { view } = renderPause({
      message: 'System overloaded (cpu_load…)',
      expiresAt: Date.now() + OVERLOAD_REFUSAL_TTL_MS,
    });
    expect(view.result.current.paused).toBe(true);
    expect(view.result.current.pollOverloaded).toBe(false);
    expect(view.result.current.refusalMessage).toBe(
      'System overloaded (cpu_load…)',
    );
  });

  it('expires the refusal hint and notifies the caller', () => {
    statusMock.report = reportWith(false);
    const { view, onRefusalExpired } = renderPause({
      message: 'hint',
      expiresAt: Date.now() + OVERLOAD_REFUSAL_TTL_MS,
    });
    expect(view.result.current.paused).toBe(true);
    vi.advanceTimersByTime(OVERLOAD_REFUSAL_TTL_MS + 1);
    expect(onRefusalExpired).toHaveBeenCalledTimes(1);
    // The caller clears the refusal state; re-render to observe the hook's
    // time-derived verdict without it.
    view.rerender();
    expect(view.result.current.paused).toBe(false);
  });

  it('keeps pausing when the poll confirms overload past the hint expiry', () => {
    statusMock.report = reportWith(true);
    const { view, onRefusalExpired } = renderPause({
      message: 'hint',
      expiresAt: Date.now() + OVERLOAD_REFUSAL_TTL_MS,
    });
    vi.advanceTimersByTime(OVERLOAD_REFUSAL_TTL_MS + 1);
    expect(onRefusalExpired).toHaveBeenCalledTimes(1);
    view.rerender();
    expect(view.result.current.paused).toBe(true);
  });

  it('reloads the status summary on the poll interval while enabled', () => {
    renderPause();
    expect(statusMock.reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(OVERLOAD_POLL_INTERVAL_MS * 3);
    expect(statusMock.reload).toHaveBeenCalledTimes(3);
  });

  it('does not poll while disabled', () => {
    renderPause(null, false);
    vi.advanceTimersByTime(OVERLOAD_POLL_INTERVAL_MS * 3);
    expect(statusMock.reload).not.toHaveBeenCalled();
  });
});
