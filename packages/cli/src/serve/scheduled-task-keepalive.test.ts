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
});
