// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { renderHook } from '@testing-library/react';
import type { DaemonStatusReport } from '@qwen-code/sdk/daemon';
import {
  OVERLOAD_POLL_INTERVAL_MS,
  OVERLOAD_REFUSAL_TTL_MS,
  useDaemonOverloadPause,
} from './useDaemonOverloadPause.js';

const providerMock = vi.hoisted(() => ({
  workspace: undefined as
    | { actions: { loadDaemonStatus: ReturnType<typeof vi.fn> } }
    | undefined,
}));

vi.mock('../DaemonWorkspaceProvider.js', () => ({
  useOptionalDaemonWorkspace: () => providerMock.workspace,
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

function deferredReport() {
  let resolve!: (report: DaemonStatusReport) => void;
  const promise = new Promise<DaemonStatusReport>((executor) => {
    resolve = executor;
  });
  return { promise, resolve };
}

describe('useDaemonOverloadPause', () => {
  let loadDaemonStatus: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    loadDaemonStatus = vi.fn().mockResolvedValue(reportWith(false));
    providerMock.workspace = { actions: { loadDaemonStatus } };
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, 'hidden', {
      value: false,
      configurable: true,
    });
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

  const flush = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  };

  it('fetches the summary once on mount, before any interval tick', async () => {
    renderPause();
    await flush();
    expect(loadDaemonStatus).toHaveBeenCalledTimes(1);
    expect(loadDaemonStatus).toHaveBeenCalledWith('summary');
  });

  it('pauses while the poll reports overload', async () => {
    loadDaemonStatus.mockResolvedValue(reportWith(true));
    const { view } = renderPause();
    await flush();
    expect(view.result.current.paused).toBe(true);
    expect(view.result.current.pollOverloaded).toBe(true);
    expect(view.result.current.loadAdmission?.loadRatio).toBe(2.5);
  });

  it('stays unpaused with a normal poll and no refusal', async () => {
    const { view } = renderPause();
    await flush();
    expect(view.result.current.paused).toBe(false);
  });

  it('stays unpaused when the daemon omits the field entirely', async () => {
    loadDaemonStatus.mockResolvedValue({
      runtime: {},
    } as unknown as DaemonStatusReport);
    const { view } = renderPause();
    await flush();
    expect(view.result.current.paused).toBe(false);
  });

  it('tolerates a missing workspace provider without throwing', async () => {
    providerMock.workspace = undefined;
    const { view } = renderPause();
    await flush();
    expect(view.result.current.paused).toBe(false);
    expect(loadDaemonStatus).not.toHaveBeenCalled();
  });

  it('pauses on an unexpired refusal even while the poll looks normal', async () => {
    const { view } = renderPause({
      message: 'System overloaded (cpu_load…)',
      expiresAt: Date.now() + OVERLOAD_REFUSAL_TTL_MS,
    });
    await flush();
    expect(view.result.current.paused).toBe(true);
    expect(view.result.current.pollOverloaded).toBe(false);
    expect(view.result.current.refusalMessage).toBe(
      'System overloaded (cpu_load…)',
    );
  });

  it('expires the refusal hint and notifies the caller', async () => {
    const { view, onRefusalExpired } = renderPause({
      message: 'hint',
      expiresAt: Date.now() + OVERLOAD_REFUSAL_TTL_MS,
    });
    await flush();
    expect(view.result.current.paused).toBe(true);
    await vi.advanceTimersByTimeAsync(OVERLOAD_REFUSAL_TTL_MS + 1);
    expect(onRefusalExpired).toHaveBeenCalledTimes(1);
    view.rerender();
    expect(view.result.current.paused).toBe(false);
  });

  it('keeps pausing when the poll confirms overload past the hint expiry', async () => {
    loadDaemonStatus.mockResolvedValue(reportWith(true));
    const { view, onRefusalExpired } = renderPause({
      message: 'hint',
      expiresAt: Date.now() + OVERLOAD_REFUSAL_TTL_MS,
    });
    await flush();
    await vi.advanceTimersByTimeAsync(OVERLOAD_REFUSAL_TTL_MS + 1);
    expect(onRefusalExpired).toHaveBeenCalledTimes(1);
    view.rerender();
    expect(view.result.current.paused).toBe(true);
  });

  it('reloads on the poll interval while enabled', async () => {
    renderPause();
    await flush();
    loadDaemonStatus.mockClear();
    await vi.advanceTimersByTimeAsync(OVERLOAD_POLL_INTERVAL_MS * 3);
    expect(loadDaemonStatus).toHaveBeenCalledTimes(3);
  });

  it('does not stack requests while one summary is still in flight', async () => {
    renderPause();
    await flush();
    loadDaemonStatus.mockClear();
    loadDaemonStatus.mockImplementationOnce(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(OVERLOAD_POLL_INTERVAL_MS * 3);
    expect(loadDaemonStatus).toHaveBeenCalledTimes(1);
  });

  it('does not poll while the tab is hidden', async () => {
    renderPause();
    await flush();
    loadDaemonStatus.mockClear();
    Object.defineProperty(document, 'hidden', {
      value: true,
      configurable: true,
    });
    await vi.advanceTimersByTimeAsync(OVERLOAD_POLL_INTERVAL_MS * 3);
    expect(loadDaemonStatus).not.toHaveBeenCalled();
  });

  it('does not poll while disabled', async () => {
    renderPause(null, false);
    await flush();
    await vi.advanceTimersByTimeAsync(OVERLOAD_POLL_INTERVAL_MS * 3);
    expect(loadDaemonStatus).not.toHaveBeenCalled();
  });

  it('drops a stale overloaded verdict once status polls keep failing', async () => {
    loadDaemonStatus.mockResolvedValueOnce(reportWith(true));
    const { view } = renderPause();
    await flush();
    expect(view.result.current.paused).toBe(true);
    loadDaemonStatus.mockRejectedValue(new Error('502 from proxy'));
    await vi.advanceTimersByTimeAsync(OVERLOAD_POLL_INTERVAL_MS * 3);
    await flush();
    expect(view.result.current.paused).toBe(false);
  });

  it.each([true, false])(
    'does not revive an old pause while the next retry is pending (overload=%o)',
    async (initiallyOverloaded) => {
      loadDaemonStatus.mockResolvedValueOnce(reportWith(initiallyOverloaded));
      const { view } = renderPause();
      await flush();
      expect(view.result.current.paused).toBe(initiallyOverloaded);

      loadDaemonStatus.mockRejectedValueOnce(new Error('502 from proxy'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(OVERLOAD_POLL_INTERVAL_MS);
      });
      await flush();
      expect(loadDaemonStatus).toHaveBeenCalledTimes(2);
      expect(view.result.current.paused).toBe(false);

      const recovery = deferredReport();
      loadDaemonStatus.mockImplementationOnce(() => recovery.promise);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(OVERLOAD_POLL_INTERVAL_MS);
      });
      expect(loadDaemonStatus).toHaveBeenCalledTimes(3);
      expect(view.result.current.paused).toBe(false);
      expect(view.result.current.pollOverloaded).toBe(false);

      recovery.resolve(reportWith(initiallyOverloaded));
      await flush();
      expect(view.result.current.paused).toBe(initiallyOverloaded);
    },
  );

  it('preserves an old pause while a healthy refresh is pending', async () => {
    loadDaemonStatus.mockResolvedValue(reportWith(true));
    const { view } = renderPause();
    await flush();
    expect(view.result.current.paused).toBe(true);

    const refresh = deferredReport();
    loadDaemonStatus.mockImplementationOnce(() => refresh.promise);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OVERLOAD_POLL_INTERVAL_MS);
    });
    expect(loadDaemonStatus).toHaveBeenCalledTimes(2);
    expect(view.result.current.paused).toBe(true);

    refresh.resolve(reportWith(false));
    await flush();
    expect(view.result.current.paused).toBe(false);
  });

  it('does not stack an interval request on a pending mount request', async () => {
    loadDaemonStatus.mockImplementationOnce(() => new Promise(() => {}));
    renderPause();
    await flush();
    expect(loadDaemonStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(OVERLOAD_POLL_INTERVAL_MS * 3);
    expect(loadDaemonStatus).toHaveBeenCalledTimes(1);
  });

  it('issues no mount request while hidden and loads once visible', async () => {
    Object.defineProperty(document, 'hidden', {
      value: true,
      configurable: true,
    });
    renderPause();
    await flush();
    expect(loadDaemonStatus).not.toHaveBeenCalled();
    Object.defineProperty(document, 'hidden', {
      value: false,
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(loadDaemonStatus).toHaveBeenCalledTimes(1);
  });

  it('drops the poll pause when enabled flips false (daemon offline)', async () => {
    loadDaemonStatus.mockResolvedValue(reportWith(true));
    let enabled = true;
    const onRefusalExpired = vi.fn();
    const view = renderHook(() =>
      useDaemonOverloadPause({ enabled, refusal: null, onRefusalExpired }),
    );
    await flush();
    expect(view.result.current.paused).toBe(true);
    expect(view.result.current.pollOverloaded).toBe(true);

    // useDaemonResource retains the last payload with error unset when
    // disabled; the hook must not keep creation paused across an outage.
    enabled = false;
    view.rerender();
    expect(view.result.current.paused).toBe(false);
    expect(view.result.current.pollOverloaded).toBe(false);
  });
});
