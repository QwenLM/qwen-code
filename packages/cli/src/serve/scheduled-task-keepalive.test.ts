/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Storage,
  updateCronTasks,
  type DurableCronTask,
} from '@qwen-code/qwen-code-core';
import {
  startScheduledTaskKeepalive,
  rehydrateScheduledTaskSessions,
} from './scheduled-task-keepalive.js';

function task(over: Partial<DurableCronTask>): DurableCronTask {
  return {
    id: 't',
    cron: '0 9 * * *',
    prompt: 'p',
    recurring: true,
    createdAt: 1_700_000_000_000,
    lastFiredAt: null,
    ...over,
  };
}

describe('scheduled-task keepalive', () => {
  let scratch: string;
  let workspace: string;
  let beats: string[];
  let loads: string[];
  const bridge = {
    recordHeartbeat: (id: string) => {
      beats.push(id);
    },
    loadSession: async (req: { sessionId: string }) => {
      loads.push(req.sessionId);
    },
  };

  beforeEach(async () => {
    scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'sched-keepalive-'));
    workspace = path.join(scratch, 'workspace');
    await fsp.mkdir(workspace, { recursive: true });
    Storage.setRuntimeBaseDir(scratch);
    beats = [];
    loads = [];
  });

  afterEach(async () => {
    Storage.setRuntimeBaseDir(null);
    await fsp.rm(scratch, { recursive: true, force: true });
  });

  it('heartbeats each distinct bound session, skipping unbound tasks', async () => {
    await updateCronTasks(workspace, () => [
      task({ id: 'a', sessionId: 'sess-1' }),
      task({ id: 'b', sessionId: 'sess-2' }),
      task({ id: 'c', sessionId: 'sess-1' }), // same session as 'a'
      task({ id: 'd' }), // unbound — no session to keep alive
    ]);
    const ka = startScheduledTaskKeepalive({
      bridge,
      boundWorkspace: workspace,
      intervalMs: 60_000,
    });
    await ka.tick();
    ka.stop();
    // Deduped to the distinct bound sessions; the unbound task is skipped.
    expect(beats.sort()).toEqual(['sess-1', 'sess-2']);
  });

  it('skips heartbeat and revive for disabled tasks (keeps them reap-able)', async () => {
    // A disabled task's session is intentionally left for the idle reaper — the
    // keepalive must NOT heartbeat it (which would pin it resident) and must NOT
    // revive it. This guards the `enabled === false` filter: covers both a
    // user-disabled task and one disabled by archiving (`disabledByArchive`).
    await updateCronTasks(workspace, () => [
      task({ id: 'on', sessionId: 'sess-live' }),
      task({
        id: 'off',
        sessionId: 'sess-archived',
        enabled: false,
        disabledByArchive: true,
      }),
      task({ id: 'off2', sessionId: 'sess-userdisabled', enabled: false }),
    ]);
    // Tripwire: heartbeating a disabled session would throw here, which the tick
    // then "recovers" from by attempting a revive — so a regression that stopped
    // filtering disabled tasks would surface in BOTH `beats` and `loads`.
    const guarded = {
      recordHeartbeat: (id: string) => {
        if (id !== 'sess-live') {
          throw new Error(`unexpected heartbeat for disabled session ${id}`);
        }
        beats.push(id);
      },
      loadSession: async (req: { sessionId: string }) => {
        loads.push(req.sessionId);
      },
    };
    const ka = startScheduledTaskKeepalive({
      bridge: guarded,
      boundWorkspace: workspace,
      intervalMs: 60_000,
    });
    await ka.tick();
    ka.stop();
    expect(beats).toEqual(['sess-live']); // only the enabled task's session
    expect(loads).toEqual([]); // no revive attempted for any disabled session
  });

  it('heartbeats nothing (and does not throw) when there are no tasks', async () => {
    const ka = startScheduledTaskKeepalive({
      bridge,
      boundWorkspace: workspace,
      intervalMs: 60_000,
    });
    await expect(ka.tick()).resolves.toBeUndefined();
    ka.stop();
    expect(beats).toEqual([]);
  });

  it('revives a non-resident session and keeps heartbeating siblings', async () => {
    await updateCronTasks(workspace, () => [
      task({ id: 'a', sessionId: 'sess-1' }),
      task({ id: 'b', sessionId: 'sess-2' }),
    ]);
    const reviving = {
      recordHeartbeat: (id: string) => {
        if (id === 'sess-1') throw new Error('not resident');
        beats.push(id);
      },
      loadSession: async (req: { sessionId: string }) => {
        loads.push(req.sessionId);
      },
    };
    const ka = startScheduledTaskKeepalive({
      bridge: reviving,
      boundWorkspace: workspace,
      intervalMs: 60_000,
    });
    await ka.tick();
    ka.stop();
    // sess-1's heartbeat failed (reaper let it go) → reloaded to resume its
    // scheduler; sess-2 was resident and still got its heartbeat.
    expect(loads).toEqual(['sess-1']);
    expect(beats).toEqual(['sess-2']);
  });

  it('a failed revive is swallowed and does not block siblings', async () => {
    await updateCronTasks(workspace, () => [
      task({ id: 'a', sessionId: 'sess-1' }),
      task({ id: 'b', sessionId: 'sess-2' }),
    ]);
    const reviving = {
      recordHeartbeat: (id: string) => {
        if (id === 'sess-1') throw new Error('not resident');
        beats.push(id);
      },
      loadSession: async (req: { sessionId: string }) => {
        loads.push(req.sessionId);
        if (req.sessionId === 'sess-1') throw new Error('transcript gone');
      },
    };
    const ka = startScheduledTaskKeepalive({
      bridge: reviving,
      boundWorkspace: workspace,
      intervalMs: 60_000,
    });
    await expect(ka.tick()).resolves.toBeUndefined();
    ka.stop();
    expect(loads).toEqual(['sess-1']); // revive attempted despite failing
    expect(beats).toEqual(['sess-2']); // sibling unaffected
  });

  it('backs off a failing revive instead of retrying it every tick', async () => {
    await updateCronTasks(workspace, () => [
      task({ id: 'a', sessionId: 'sess-1' }),
    ]);
    const reviving = {
      recordHeartbeat: () => {
        throw new Error('not resident');
      },
      loadSession: async (req: { sessionId: string }) => {
        loads.push(req.sessionId);
        throw new Error('transcript gone');
      },
    };
    const ka = startScheduledTaskKeepalive({
      bridge: reviving,
      boundWorkspace: workspace,
      intervalMs: 60_000,
    });
    await ka.tick(); // revive fails → backoff set (~intervalMs)
    await ka.tick(); // still within backoff → revive skipped
    ka.stop();
    expect(loads).toEqual(['sess-1']); // only the first pass tried
  });

  it('does not spawn a duplicate revive while a prior one is still in flight', async () => {
    await updateCronTasks(workspace, () => [
      task({ id: 'a', sessionId: 'sess-1' }),
    ]);
    let releaseLoad: (() => void) | undefined;
    const reviving = {
      recordHeartbeat: () => {
        throw new Error('not resident');
      },
      loadSession: async (req: { sessionId: string }) => {
        loads.push(req.sessionId);
        // Hang: loadSession isn't abortable, so it keeps running past the timeout.
        await new Promise<void>((resolve) => {
          releaseLoad = resolve;
        });
      },
    };
    const ka = startScheduledTaskKeepalive({
      bridge: reviving,
      boundWorkspace: workspace,
      intervalMs: 5, // tiny backoff so it expires quickly
      reviveTimeoutMs: 5, // revive times out fast, but the load keeps hanging
    });
    await ka.tick(); // revive starts + times out at 5ms; load still hanging
    await new Promise((r) => setTimeout(r, 30)); // let the backoff expire
    await ka.tick(); // past backoff, but the load is still in flight → skip
    ka.stop();
    expect(loads).toEqual(['sess-1']); // no duplicate spawn
    releaseLoad?.(); // let the hung load settle (cleanup)
  });

  it('stop() is idempotent', async () => {
    const ka = startScheduledTaskKeepalive({
      bridge,
      boundWorkspace: workspace,
      intervalMs: 60_000,
    });
    ka.stop();
    expect(() => ka.stop()).not.toThrow();
  });

  it('rehydrate loads each distinct bound session, skipping unbound', async () => {
    await updateCronTasks(workspace, () => [
      task({ id: 'a', sessionId: 'sess-1' }),
      task({ id: 'b', sessionId: 'sess-2' }),
      task({ id: 'c', sessionId: 'sess-1' }), // same session as 'a'
      task({ id: 'd' }), // unbound
    ]);
    const loaded: string[] = [];
    const res = await rehydrateScheduledTaskSessions({
      bridge: {
        loadSession: async (req) => {
          loaded.push(req.sessionId);
        },
      },
      boundWorkspace: workspace,
    });
    expect(loaded.sort()).toEqual(['sess-1', 'sess-2']);
    expect(res.loaded.sort()).toEqual(['sess-1', 'sess-2']);
    expect(res.failed).toEqual([]);
  });

  it('rehydrate records a gone session as failed but keeps loading siblings', async () => {
    await updateCronTasks(workspace, () => [
      task({ id: 'a', sessionId: 'gone' }),
      task({ id: 'b', sessionId: 'sess-2' }),
    ]);
    const errors: string[] = [];
    const res = await rehydrateScheduledTaskSessions({
      bridge: {
        loadSession: async (req) => {
          if (req.sessionId === 'gone') throw new Error('missing transcript');
        },
      },
      boundWorkspace: workspace,
      onError: (sid) => errors.push(sid),
    });
    expect(res.loaded).toEqual(['sess-2']);
    expect(res.failed).toEqual(['gone']);
    expect(errors).toEqual(['gone']);
  });

  it('rehydrate is a no-op when there are no tasks', async () => {
    const res = await rehydrateScheduledTaskSessions({
      bridge: {
        loadSession: async () => {
          throw new Error('should not be called');
        },
      },
      boundWorkspace: workspace,
    });
    expect(res).toEqual({ loaded: [], failed: [] });
  });

  it('rehydrates in bounded batches, not all sessions at once', async () => {
    // Each loadSession forks a child; loading all (up to 50) at once would spike
    // the host. Seed more sessions than the concurrency cap and assert the
    // in-flight count never exceeds it.
    const many = Array.from({ length: 12 }, (_, i) =>
      task({ id: `t${i}`, sessionId: `s${i}` }),
    );
    await updateCronTasks(workspace, () => many);
    let inFlight = 0;
    let maxInFlight = 0;
    const res = await rehydrateScheduledTaskSessions({
      bridge: {
        loadSession: async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
        },
      },
      boundWorkspace: workspace,
    });
    expect(res.loaded).toHaveLength(12); // all still loaded
    expect(maxInFlight).toBeLessThanOrEqual(4); // but batched, never all at once
  });

  it('completes the sweep even when loads hang past the timeout (never wedges)', async () => {
    // loadSession isn't abortable. If a worker awaited each hung load until it
    // truly settled, enough never-settling loads would pin every worker and the
    // whole boot sweep would never complete — later task sessions would never
    // rehydrate. The timeout must free the worker to drain the rest of the queue;
    // a hung load is recorded failed and left running in the background. This is
    // the regression guard for that pre-fix deadlock: with the old "await the
    // load after timeout" behavior this test would hang and time out.
    const many = Array.from({ length: 12 }, (_, i) =>
      task({ id: `t${i}`, sessionId: `s${i}` }),
    );
    await updateCronTasks(workspace, () => many);
    let started = 0;
    const res = await rehydrateScheduledTaskSessions({
      bridge: {
        // Never resolves — a genuinely hung, non-abortable load.
        loadSession: () => {
          started++;
          return new Promise<void>(() => {});
        },
      },
      boundWorkspace: workspace,
      loadTimeoutMs: 20,
    });
    expect(res.failed).toHaveLength(12); // every session recorded failed...
    expect(res.loaded).toHaveLength(0);
    expect(started).toBe(12); // ...and every queued session was still attempted
  });
});
