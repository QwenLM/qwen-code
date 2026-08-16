/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  ACTIVE_WORK_HEARTBEAT_VERSION,
  ACTIVE_WORK_HOLD_CATEGORIES,
  ACTIVE_WORK_NOTIFICATION_METHOD,
  type ActiveWorkHoldV1,
  type ActiveWorkSnapshotV1,
} from '@qwen-code/acp-bridge/bridgeTypes';
import {
  ActiveWorkReporter,
  type ActiveWorkSource,
} from './active-work-reporter.js';

const INTERVAL_MS = 5_000;

function source(
  sessionId: string,
  collect: () => ActiveWorkHoldV1[],
): ActiveWorkSource {
  return { sessionId, collectActiveWorkHolds: collect };
}

function throwingSource(sessionId: string): ActiveWorkSource {
  return {
    sessionId,
    collectActiveWorkHolds: () => {
      throw new Error('registry exploded');
    },
  };
}

describe('ActiveWorkReporter', () => {
  let sent: Array<{ method: string; params: Record<string, unknown> }>;
  let send: (method: string, params: Record<string, unknown>) => Promise<void>;

  beforeEach(() => {
    sent = [];
    send = async (method, params) => {
      sent.push({ method, params });
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function snapshots(): ActiveWorkSnapshotV1[] {
    return sent
      .filter((call) => call.method === ACTIVE_WORK_NOTIFICATION_METHOD)
      .map((call) => call.params as unknown as ActiveWorkSnapshotV1);
  }

  it('publishes a full snapshot of every source immediately', async () => {
    const reporter = new ActiveWorkReporter(
      send,
      () => [
        source('s1', () => [{ category: 'agent', id: 'a1' }]),
        source('s2', () => []),
      ],
      INTERVAL_MS,
      ACTIVE_WORK_HOLD_CATEGORIES,
    );
    await reporter.flush();

    const last = snapshots().at(-1)!;
    expect(last.v).toBe(ACTIVE_WORK_HEARTBEAT_VERSION);
    expect(last.sessions).toEqual([
      { sessionId: 's1', holds: [{ category: 'agent', id: 'a1' }] },
      { sessionId: 's2', holds: [] },
    ]);
    reporter.dispose();
  });

  it('increases seq monotonically across reports', async () => {
    const reporter = new ActiveWorkReporter(
      send,
      () => [],
      INTERVAL_MS,
      ACTIVE_WORK_HOLD_CATEGORIES,
    );
    await reporter.flush();
    await reporter.flush();

    const seqs = snapshots().map((s) => s.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    reporter.dispose();
  });

  it('filters only the wire snapshot to negotiated categories', async () => {
    const collect = vi.fn().mockReturnValue([
      { category: 'agent', id: 'a1' },
      { category: 'shell', id: 'background-shells' },
    ] satisfies ActiveWorkHoldV1[]);
    const reporter = new ActiveWorkReporter(
      send,
      () => [source('s1', collect)],
      INTERVAL_MS,
      ['agent', 'notification'],
    );
    await reporter.flush();

    expect(collect).toHaveBeenCalled();
    expect(snapshots().at(-1)?.sessions).toEqual([
      { sessionId: 's1', holds: [{ category: 'agent', id: 'a1' }] },
    ]);
    reporter.dispose();
  });

  describe('when a source throws while collecting', () => {
    it('does not let the failure escape the interval timer', async () => {
      vi.useFakeTimers();
      const onUncaught = vi.fn();
      process.on('uncaughtException', onUncaught);
      try {
        const reporter = new ActiveWorkReporter(
          send,
          () => [throwingSource('s1')],
          INTERVAL_MS,
          ACTIVE_WORK_HOLD_CATEGORIES,
        );
        // The constructor already published once; drive several more ticks.
        await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
        expect(onUncaught).not.toHaveBeenCalled();
        reporter.dispose();
      } finally {
        process.off('uncaughtException', onUncaught);
      }
    });

    it('does not let the failure escape notifyChanged', async () => {
      const reporter = new ActiveWorkReporter(
        send,
        () => [throwingSource('s1')],
        INTERVAL_MS,
        ACTIVE_WORK_HOLD_CATEGORIES,
      );
      reporter.notifyChanged();
      // The coalesced publish runs in a microtask; if it threw, this await
      // would surface it as an unhandled rejection rather than resolving.
      await Promise.resolve();
      await Promise.resolve();
      reporter.dispose();
    });

    it('does not reject flush, so a prompt never fails over reporting', async () => {
      const reporter = new ActiveWorkReporter(
        send,
        () => [throwingSource('s1')],
        INTERVAL_MS,
        ACTIVE_WORK_HOLD_CATEGORIES,
      );
      await expect(reporter.flush()).resolves.toBeUndefined();
      reporter.dispose();
    });

    it('abandons the whole snapshot rather than sending a partial one', async () => {
      // A session omitted from a report reads as "released" and one reported
      // with no holds reads as "safe to close", so a partial snapshot would
      // invite the daemon to destroy the very work it could not enumerate.
      const reporter = new ActiveWorkReporter(
        send,
        () => [
          source('healthy', () => [{ category: 'agent', id: 'a1' }]),
          throwingSource('broken'),
        ],
        INTERVAL_MS,
        ACTIVE_WORK_HOLD_CATEGORIES,
      );
      await reporter.flush();

      expect(snapshots()).toHaveLength(0);
      reporter.dispose();
    });

    it('resumes reporting once collection recovers', async () => {
      let broken = true;
      const reporter = new ActiveWorkReporter(
        send,
        () => [
          broken
            ? throwingSource('s1')
            : source('s1', () => [{ category: 'agent', id: 'a1' }]),
        ],
        INTERVAL_MS,
        ACTIVE_WORK_HOLD_CATEGORIES,
      );
      await reporter.flush();
      expect(snapshots()).toHaveLength(0);

      broken = false;
      await reporter.flush();

      expect(snapshots()).toHaveLength(1);
      expect(snapshots()[0]?.sessions).toEqual([
        { sessionId: 's1', holds: [{ category: 'agent', id: 'a1' }] },
      ]);
      reporter.dispose();
    });
  });

  it('does not let a failing transport escape either', async () => {
    const reporter = new ActiveWorkReporter(
      async () => {
        throw new Error('stream closed');
      },
      () => [source('s1', () => [])],
      INTERVAL_MS,
      ACTIVE_WORK_HOLD_CATEGORIES,
    );
    await expect(reporter.flush()).resolves.toBeUndefined();
    await expect(reporter.flush()).resolves.toBeUndefined();
    reporter.dispose();
  });

  it('stops publishing after dispose', async () => {
    vi.useFakeTimers();
    const reporter = new ActiveWorkReporter(
      send,
      () => [source('s1', () => [])],
      INTERVAL_MS,
      ACTIVE_WORK_HOLD_CATEGORIES,
    );
    const before = snapshots().length;
    reporter.dispose();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(snapshots()).toHaveLength(before);
  });
});
