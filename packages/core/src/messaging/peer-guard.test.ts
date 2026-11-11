/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DROP_REPORT_WINDOW_MS,
  MAX_DROP_REPORTS_PER_WINDOW,
  createPeerDropReporter,
} from './peer-guard.js';

const debugMock = vi.hoisted(() => vi.fn());
vi.mock('../utils/runLogger.js', () => ({
  runLogger: { debug: debugMock, warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}));

describe('peer drop reporter', () => {
  beforeEach(() => debugMock.mockClear());

  it('reports the first drop', () => {
    createPeerDropReporter().report(
      { from: 'uds:/tmp/a.sock', reason: 'loop-detected' },
      1_000,
    );
    expect(debugMock).toHaveBeenCalledTimes(1);
  });

  it('suppresses an identical drop inside the window', () => {
    const reporter = createPeerDropReporter();
    reporter.report({ from: 'uds:/tmp/a.sock', reason: 'loop-detected' }, 1_000);
    reporter.report({ from: 'uds:/tmp/a.sock', reason: 'loop-detected' }, 2_000);
    reporter.report({ from: 'uds:/tmp/a.sock', reason: 'loop-detected' }, 3_000);
    expect(debugMock).toHaveBeenCalledTimes(1);
  });

  it('reports the same sender again for a different reason', () => {
    const reporter = createPeerDropReporter();
    reporter.report({ from: 'uds:/tmp/a.sock', reason: 'loop-detected' }, 1_000);
    reporter.report({ from: 'uds:/tmp/a.sock', reason: 'refused' }, 1_000);
    expect(debugMock).toHaveBeenCalledTimes(2);
  });

  it('reports again once the window has passed', () => {
    const reporter = createPeerDropReporter();
    reporter.report({ from: 'uds:/tmp/a.sock', reason: 'loop-detected' }, 1_000);
    reporter.report(
      { from: 'uds:/tmp/a.sock', reason: 'loop-detected' },
      1_000 + DROP_REPORT_WINDOW_MS + 1,
    );
    expect(debugMock).toHaveBeenCalledTimes(2);
  });

  it('caps distinct reports per window', () => {
    const reporter = createPeerDropReporter();
    for (let i = 0; i < MAX_DROP_REPORTS_PER_WINDOW + 10; i++) {
      reporter.report({ from: `uds:/tmp/${i}.sock`, reason: 'refused' }, 1_000);
    }
    expect(debugMock).toHaveBeenCalledTimes(MAX_DROP_REPORTS_PER_WINDOW);
  });

  it('resets its state', () => {
    const reporter = createPeerDropReporter();
    reporter.report({ from: 'uds:/tmp/a.sock', reason: 'refused' }, 1_000);
    reporter.reset();
    reporter.report({ from: 'uds:/tmp/a.sock', reason: 'refused' }, 1_500);
    expect(debugMock).toHaveBeenCalledTimes(2);
  });

  // [RA19] The return value is how a caller hangs its own per-drop work off this
  // suppression — the drop counter does, because a looping peer would otherwise
  // report as fast as it can write to a socket.
  it('[RA19] says whether it actually reported', () => {
    const reporter = createPeerDropReporter();
    const drop = { from: 'uds:/tmp/a.sock', reason: 'loop-detected' } as const;

    expect(reporter.report(drop, 1_000)).toBe(true);
    expect(reporter.report(drop, 2_000)).toBe(false);
    expect(reporter.report(drop, 1_000 + DROP_REPORT_WINDOW_MS + 1)).toBe(true);
  });

  it('[RA19] says nothing was reported once the window cap is reached', () => {
    const reporter = createPeerDropReporter();
    for (let i = 0; i < MAX_DROP_REPORTS_PER_WINDOW; i++) {
      expect(
        reporter.report({ from: `uds:/tmp/${i}.sock`, reason: 'refused' }, 1_000),
      ).toBe(true);
    }
    expect(
      reporter.report({ from: 'uds:/tmp/last.sock', reason: 'refused' }, 1_000),
    ).toBe(false);
  });
});
