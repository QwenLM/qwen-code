/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Storage,
  readCronTasks,
  SessionService,
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
    spawnOrAttach: async () => {
      throw new Error('spawnOrAttach not mocked');
    },
    closeSession: async () => {
      throw new Error('closeSession not mocked');
    },
    updateSessionMetadata: () => {
      throw new Error('updateSessionMetadata not mocked');
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
      spawnOrAttach: async () => {
        throw new Error('not mocked');
      },
      closeSession: async () => {},
      updateSessionMetadata: () => {
        throw new Error('not mocked');
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

  it('does not heartbeat or revive a bound legacy `condition` task (never pinned)', async () => {
    // A legacy precondition task fails closed — the scheduler can never fire it,
    // so keepalive must not pin its session resident (no heartbeat) nor revive
    // it. The `condition` field predates the current DurableCronTask shape, so it
    // is attached off-type to model a task written by a pre-removal version.
    await updateCronTasks(workspace, () => [
      task({ id: 'live', sessionId: 'sess-live' }),
      task({
        id: 'legacy',
        sessionId: 'sess-legacy',
        condition: 'files_changed',
      } as unknown as Partial<DurableCronTask>),
    ]);
    const guarded = {
      recordHeartbeat: (id: string) => {
        if (id !== 'sess-live') {
          throw new Error(`unexpected heartbeat for legacy session ${id}`);
        }
        beats.push(id);
      },
      loadSession: async (req: { sessionId: string }) => {
        loads.push(req.sessionId);
      },
      spawnOrAttach: async () => {
        throw new Error('not mocked');
      },
      closeSession: async () => {},
      updateSessionMetadata: () => {
        throw new Error('not mocked');
      },
    };
    const ka = startScheduledTaskKeepalive({
      bridge: guarded,
      boundWorkspace: workspace,
      intervalMs: 60_000,
    });
    await ka.tick();
    ka.stop();
    expect(beats).toEqual(['sess-live']); // only the fireable task's session
    expect(loads).toEqual([]); // no revive attempted for the legacy task
  });

  it('does not bind an unbound legacy `condition` task', async () => {
    await updateCronTasks(workspace, () => [
      task({
        id: 'legacy-unbound',
        prompt: 'guarded',
        condition: 'files_changed',
      } as unknown as Partial<DurableCronTask>),
    ]);
    let spawnCount = 0;
    const noSpawn = {
      ...bridge,
      spawnOrAttach: async () => {
        spawnCount++;
        return { sessionId: 'should-not-spawn' };
      },
    };
    const ka = startScheduledTaskKeepalive({
      bridge: noSpawn,
      boundWorkspace: workspace,
      intervalMs: 60_000,
    });
    await ka.tick();
    ka.stop();
    expect(spawnCount).toBe(0);
    const tasks = await readCronTasks(workspace);
    expect(tasks[0]!.sessionId).toBeUndefined(); // still unbound
  });

  it('does not rename a bound legacy `condition` task', async () => {
    await updateCronTasks(workspace, () => [
      task({
        id: 'legacy-bound',
        sessionId: 'legacy-sess',
        prompt: 'guarded',
        condition: 'files_changed',
      } as unknown as Partial<DurableCronTask>),
    ]);
    const names: Array<[string, { displayName?: string }]> = [];
    const naming = {
      ...bridge,
      recordHeartbeat: () => {
        // Legacy tasks are excluded from the bound set, so no heartbeat should
        // be attempted for this session in the first place.
        throw new Error('unexpected heartbeat for legacy session');
      },
      updateSessionMetadata: (id: string, m: { displayName?: string }) => {
        names.push([id, m]);
      },
    };
    const ka = startScheduledTaskKeepalive({
      bridge: naming,
      boundWorkspace: workspace,
      intervalMs: 60_000,
    });
    await ka.tick();
    ka.stop();
    expect(names).toEqual([]); // legacy task never gets the ⏰ rename
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
      spawnOrAttach: async () => {
        throw new Error('not mocked');
      },
      closeSession: async () => {},
      updateSessionMetadata: () => {
        throw new Error('not mocked');
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
      spawnOrAttach: async () => {
        throw new Error('not mocked');
      },
      closeSession: async () => {},
      updateSessionMetadata: () => {
        throw new Error('not mocked');
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
      spawnOrAttach: async () => {
        throw new Error('not mocked');
      },
      closeSession: async () => {},
      updateSessionMetadata: () => {
        throw new Error('not mocked');
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
      spawnOrAttach: async () => {
        throw new Error('not mocked');
      },
      closeSession: async () => {},
      updateSessionMetadata: () => {
        throw new Error('not mocked');
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

  it('binds an unbound task to a dedicated session and writes sessionId to disk', async () => {
    await updateCronTasks(workspace, () => [
      task({ id: 'unbound-1', prompt: 'check build' }),
    ]);
    const spawns: unknown[] = [];
    const names: Array<[string, { displayName?: string }]> = [];
    const binding = {
      ...bridge,
      spawnOrAttach: async (req: unknown) => {
        spawns.push(req);
        return { sessionId: 'new-sess-1' };
      },
      closeSession: async () => {},
      updateSessionMetadata: (id: string, m: { displayName?: string }) => {
        names.push([id, m]);
      },
    };
    const ka = startScheduledTaskKeepalive({
      bridge: binding,
      boundWorkspace: workspace,
      intervalMs: 60_000,
    });
    await ka.tick();
    ka.stop();
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toEqual({
      workspaceCwd: workspace,
      sessionScope: 'thread',
    });
    expect(names).toHaveLength(1);
    expect(names[0]![0]).toBe('new-sess-1');
    expect(names[0]![1].displayName).toContain('⏰');
    const tasks = await readCronTasks(workspace);
    expect(tasks[0]!.sessionId).toBe('new-sess-1');
  });

  it('renames a bound session without ⏰ prefix exactly once', async () => {
    await updateCronTasks(workspace, () => [
      task({ id: 'bound-1', sessionId: 'existing-sess', prompt: 'lint' }),
    ]);
    const names: Array<[string, { displayName?: string }]> = [];
    const naming = {
      ...bridge,
      updateSessionMetadata: (id: string, m: { displayName?: string }) => {
        names.push([id, m]);
      },
    };
    const ka = startScheduledTaskKeepalive({
      bridge: naming,
      boundWorkspace: workspace,
      intervalMs: 60_000,
    });
    await ka.tick();
    await ka.tick();
    ka.stop();
    expect(names).toHaveLength(1);
    expect(names[0]![0]).toBe('existing-sess');
    expect(names[0]![1].displayName).toContain('⏰');
  });

  it('does not bind disabled unbound tasks', async () => {
    await updateCronTasks(workspace, () => [
      task({ id: 'disabled-unbound', enabled: false }),
    ]);
    let spawnCount = 0;
    const noSpawn = {
      ...bridge,
      spawnOrAttach: async () => {
        spawnCount++;
        return { sessionId: 'should-not-spawn' };
      },
    };
    const ka = startScheduledTaskKeepalive({
      bridge: noSpawn,
      boundWorkspace: workspace,
      intervalMs: 60_000,
    });
    await ka.tick();
    ka.stop();
    expect(spawnCount).toBe(0);
  });

  it('still binds a task when updateSessionMetadata fails', async () => {
    await updateCronTasks(workspace, () => [
      task({ id: 'name-fail', prompt: 'test prompt' }),
    ]);
    const naming = {
      ...bridge,
      spawnOrAttach: async () => ({ sessionId: 'bound-despite-naming-fail' }),
      closeSession: async () => {},
      updateSessionMetadata: () => {
        throw new Error('metadata service down');
      },
    };
    const ka = startScheduledTaskKeepalive({
      bridge: naming,
      boundWorkspace: workspace,
      intervalMs: 60_000,
    });
    await ka.tick();
    ka.stop();
    const tasks = await readCronTasks(workspace);
    expect(tasks[0]!.sessionId).toBe('bound-despite-naming-fail');
  });

  it('rolls back the spawned session when the task vanishes before write', async () => {
    // Seed an unbound task, then replace it with a different task between the
    // keepalive's read and the updateCronTasks callback — simulating a
    // concurrent delete. The spawned session must be closed AND its persisted
    // transcript removed.
    const closed: string[] = [];
    const removeSpy = vi
      .spyOn(SessionService.prototype, 'removeSession')
      .mockResolvedValue(true);
    const rollbackBridge = {
      ...bridge,
      spawnOrAttach: async () => {
        // Simulate concurrent deletion: remove the task from disk right after
        // spawn returns (before updateCronTasks's read-modify-write).
        await updateCronTasks(workspace, () => []);
        return { sessionId: 'orphan-sess' };
      },
      closeSession: async (id: string) => {
        closed.push(id);
      },
      updateSessionMetadata: () => {},
    };
    await updateCronTasks(workspace, () => [
      task({ id: 'will-vanish', prompt: 'doomed' }),
    ]);
    const ka = startScheduledTaskKeepalive({
      bridge: rollbackBridge,
      boundWorkspace: workspace,
      intervalMs: 60_000,
    });
    await ka.tick();
    ka.stop();
    expect(closed).toContain('orphan-sess');
    expect(removeSpy).toHaveBeenCalledWith('orphan-sess');
    removeSpy.mockRestore();
  });

  it('rolls back when another process binds the task before write', async () => {
    // Another keepalive/process binds the same task between our spawn and
    // our updateCronTasks lock. Our spawned session must be rolled back.
    const closed: string[] = [];
    const removeSpy = vi
      .spyOn(SessionService.prototype, 'removeSession')
      .mockResolvedValue(true);
    const raceBridge = {
      ...bridge,
      spawnOrAttach: async () => {
        // Simulate another process binding the task.
        await updateCronTasks(workspace, (list) =>
          list.map((t) =>
            t.id === 'raced' ? { ...t, sessionId: 'other-sess' } : t,
          ),
        );
        return { sessionId: 'our-orphan' };
      },
      closeSession: async (id: string) => {
        closed.push(id);
      },
      updateSessionMetadata: () => {},
    };
    await updateCronTasks(workspace, () => [
      task({ id: 'raced', prompt: 'contested' }),
    ]);
    const ka = startScheduledTaskKeepalive({
      bridge: raceBridge,
      boundWorkspace: workspace,
      intervalMs: 60_000,
    });
    await ka.tick();
    ka.stop();
    expect(closed).toContain('our-orphan');
    // The other process's sessionId is preserved.
    const tasks = await readCronTasks(workspace);
    expect(tasks[0]!.sessionId).toBe('other-sess');
    removeSpy.mockRestore();
  });

  it('a hung spawnOrAttach does not stall subsequent ticks', async () => {
    // spawnOrAttach is not abortable — if it hangs, the keepalive must time
    // out and move on so later ticks can still heartbeat/revive other
    // sessions. Use a tiny interval so the backoff expires fast.
    await updateCronTasks(workspace, () => [
      task({ id: 'hung', prompt: 'will hang' }),
      task({ id: 'ok', sessionId: 'healthy-sess', prompt: 'fine' }),
    ]);
    let releaseSpawn: (() => void) | undefined;
    const hungBridge = {
      ...bridge,
      spawnOrAttach: () =>
        new Promise<{ sessionId: string }>((resolve) => {
          releaseSpawn = () => resolve({ sessionId: 'late-sess' });
        }),
      closeSession: async () => {},
      updateSessionMetadata: () => {},
    };
    const ka = startScheduledTaskKeepalive({
      bridge: hungBridge,
      boundWorkspace: workspace,
      intervalMs: 50,
      spawnTimeoutMs: 50,
    });
    // First tick: spawn hangs → timeout fires → tick completes.
    await ka.tick();
    // healthy-sess should still get heartbeated despite the hung spawn.
    expect(beats).toContain('healthy-sess');
    ka.stop();
    // Clean up the hung spawn.
    releaseSpawn?.();
  });
});
