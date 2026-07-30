/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DAEMON_BULK_GLOBAL_ACTIVE_LIMIT,
  DAEMON_BULK_GLOBAL_WAIT_LIMIT,
  DAEMON_BULK_WORKSPACE_WAIT_LIMIT,
  DaemonBulkAdmissionError,
  FairDaemonBulkScheduler,
  FairDaemonProcessScheduler,
  FairDaemonSpawnScheduler,
} from './fair-daemon-bulk-scheduler.js';

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('FairDaemonBulkScheduler', () => {
  it('limits global and per-workspace concurrency while rotating workspaces', async () => {
    const scheduler = new FairDaemonBulkScheduler();
    const gates = Array.from({ length: 6 }, deferred);
    const started: string[] = [];
    const runs = [
      scheduler.run('/a', 'a1', async () => {
        started.push('a1');
        await gates[0].promise;
      }),
      scheduler.run('/a', 'a2', async () => {
        started.push('a2');
        await gates[1].promise;
      }),
      scheduler.run('/b', 'b1', async () => {
        started.push('b1');
        await gates[2].promise;
      }),
      scheduler.run('/c', 'c1', async () => {
        started.push('c1');
        await gates[3].promise;
      }),
      scheduler.run('/d', 'd1', async () => {
        started.push('d1');
        await gates[4].promise;
      }),
      scheduler.run('/e', 'e1', async () => {
        started.push('e1');
        await gates[5].promise;
      }),
    ];

    await vi.waitFor(() => {
      expect(started).toEqual(['a1', 'b1', 'c1', 'd1']);
    });
    expect(scheduler.snapshot().active).toBe(DAEMON_BULK_GLOBAL_ACTIVE_LIMIT);

    gates[0].resolve();
    await vi.waitFor(() => {
      expect(started).toContain('e1');
    });
    expect(started).not.toContain('a2');

    gates[2].resolve();
    await vi.waitFor(() => {
      expect(started).toContain('a2');
    });
    for (const gate of gates) gate.resolve();
    await Promise.all(runs);
    expect(scheduler.snapshot()).toEqual({
      active: 0,
      waiting: 0,
      workspacesWaiting: 0,
      sealed: false,
    });
  });

  it('rejects workspace and global queue overflow', async () => {
    const scheduler = new FairDaemonBulkScheduler();
    const gate = deferred();
    const active = scheduler.run('/a', 'active', () => gate.promise);
    const workspaceWaiters = Array.from(
      { length: DAEMON_BULK_WORKSPACE_WAIT_LIMIT },
      (_, index) => scheduler.run('/a', `wait-${index}`, async () => {}),
    );
    await expect(
      scheduler.run('/a', 'overflow', async () => {}),
    ).rejects.toBeInstanceOf(DaemonBulkAdmissionError);

    const otherGate = deferred();
    const globalScheduler = new FairDaemonBulkScheduler();
    const activeRuns = Array.from(
      { length: DAEMON_BULK_GLOBAL_ACTIVE_LIMIT },
      (_, index) =>
        globalScheduler.run(
          `/active-${index}`,
          'active',
          () => otherGate.promise,
        ),
    );
    const globalWaiters = Array.from(
      { length: DAEMON_BULK_GLOBAL_WAIT_LIMIT },
      (_, index) =>
        globalScheduler.run(`/wait-${index}`, 'wait', async () => {}),
    );
    await expect(
      globalScheduler.run('/overflow', 'overflow', async () => {}),
    ).rejects.toMatchObject({
      data: { errorKind: 'daemon_bulk_queue_full', httpStatus: 503 },
    });

    gate.resolve();
    otherGate.resolve();
    await Promise.all([active, ...workspaceWaiters]);
    await Promise.all([...activeRuns, ...globalWaiters]);
  });

  it('removes aborted waiters and rejects nested heavy operations', async () => {
    const scheduler = new FairDaemonBulkScheduler();
    const gate = deferred();
    const active = scheduler.run('/a', 'active', () => gate.promise);
    const controller = new AbortController();
    const queued = scheduler.run(
      '/a',
      'queued',
      async () => {},
      controller.signal,
    );
    controller.abort(new Error('cancelled'));
    await expect(queued).rejects.toThrow('cancelled');
    expect(scheduler.snapshot().waiting).toBe(0);

    gate.resolve();
    await active;
    await expect(
      scheduler.run('/a', 'outer', () =>
        scheduler.run('/a', 'inner', async () => {}),
      ),
    ).rejects.toMatchObject({
      data: { errorKind: 'nested_daemon_bulk_operation' },
    });
  });

  it('rejects cross-lane acquisition from a running operation', async () => {
    const bulk = new FairDaemonBulkScheduler();
    const spawn = new FairDaemonSpawnScheduler();
    const process = new FairDaemonProcessScheduler();

    await expect(
      bulk.run('/a', 'outer', () =>
        spawn.run('/a', 'spawn', async () => undefined),
      ),
    ).rejects.toMatchObject({
      data: {
        errorKind: 'nested_daemon_bulk_to_daemon_spawn_operation',
      },
    });
    await expect(
      spawn.run('/a', 'outer', () =>
        process.run('/a', 'process', async () => undefined),
      ),
    ).rejects.toMatchObject({
      data: {
        errorKind: 'nested_daemon_spawn_to_daemon_process_operation',
      },
    });
  });

  it('allows inherited async work after the parent operation settles', async () => {
    const bulk = new FairDaemonBulkScheduler();
    const spawn = new FairDaemonSpawnScheduler();
    const detachedGate = deferred();
    let detached: Promise<void> | undefined;

    await bulk.run('/a', 'outer', async () => {
      detached = detachedGate.promise.then(() =>
        spawn.run('/a', 'spawn', async () => undefined),
      );
    });
    detachedGate.resolve();
    await expect(detached).resolves.toBeUndefined();
  });

  it('seals admission and cancels queued work', async () => {
    const scheduler = new FairDaemonBulkScheduler();
    const gate = deferred();
    const active = scheduler.run('/a', 'active', () => gate.promise);
    const queued = scheduler.run('/a', 'queued', async () => {});
    scheduler.seal();

    await expect(queued).rejects.toMatchObject({
      data: { errorKind: 'daemon_bulk_admission_closed' },
    });
    await expect(
      scheduler.run('/b', 'new', async () => {}),
    ).rejects.toBeInstanceOf(DaemonBulkAdmissionError);
    gate.resolve();
    await active;
  });

  it('expires queued work at the bounded wait deadline', async () => {
    vi.useFakeTimers();
    try {
      const scheduler = new FairDaemonBulkScheduler({ waitTimeoutMs: 25 });
      const gate = deferred();
      const active = scheduler.run('/a', 'active', () => gate.promise);
      const queued = scheduler.run('/a', 'queued', async () => {});
      let rejection: unknown;
      const observed = queued.catch((error: unknown) => {
        rejection = error;
      });

      await vi.advanceTimersByTimeAsync(25);
      await observed;
      expect(rejection).toMatchObject({
        data: { errorKind: 'daemon_bulk_queue_timeout', retryable: true },
      });
      expect(scheduler.snapshot().waiting).toBe(0);
      gate.resolve();
      await active;
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows four concurrent spawn operations from one workspace', async () => {
    const scheduler = new FairDaemonSpawnScheduler();
    const gate = deferred();
    const started: number[] = [];
    const runs = Array.from({ length: 5 }, (_, index) =>
      scheduler.run('/a', `spawn-${index}`, async () => {
        started.push(index);
        await gate.promise;
      }),
    );

    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    expect(scheduler.snapshot()).toMatchObject({ active: 4, waiting: 1 });
    gate.resolve();
    await Promise.all(runs);
  });
});
