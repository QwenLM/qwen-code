/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  DaemonPool,
  UnknownSessionError,
  WorkspacePoolFullError,
} from './daemonPool.js';
import type { DaemonClient } from '@qwen-code/sdk';

function fakeClient(tag: string, sid?: string) {
  return {
    tag,
    async createOrAttachSession() {
      return {
        sessionId: sid ?? `${tag}-s`,
        workspaceCwd: tag,
        attached: false,
      };
    },
    async sessionContext(id: string) {
      return { calledOn: tag, id };
    },
    async endSession(id: string) {
      return { ended: true, id };
    },
    async prompt(id: string) {
      return { calledOn: tag, id };
    },
    async respondToSessionPermission() {
      return true;
    },
    async rewindSession(id: string) {
      return { calledOn: tag, id };
    },
    async sessionSupportedCommands(id: string) {
      return { calledOn: tag, id };
    },
    async setSessionApprovalMode(id: string) {
      return { calledOn: tag, id };
    },
    async loadSession(id: string) {
      return { calledOn: tag, id };
    },
    async health() {
      return { calledOn: tag };
    },
    async capabilities() {
      return { calledOn: tag };
    },
    async listWorkspaceSessions() {
      return [{ calledOn: tag }];
    },
  } as unknown as DaemonClient;
}

function makePool(spawnLog: string[]) {
  return new DaemonPool({
    defaultDaemon: fakeClient('default'),
    defaultWorkspaceCwd: '/home/evan',
    spawn: async (cwd) => {
      spawnLog.push(cwd);
      return {
        client: fakeClient(cwd),
        stop: async () => {},
        workspaceCwd: cwd,
      };
    },
  });
}

describe('DaemonPool', () => {
  it('spawns one daemon per workspace and reuses it', async () => {
    const log: string[] = [];
    const pool = makePool(log);
    const a1 = await pool.getOrSpawn('/proj/a');
    const a2 = await pool.getOrSpawn('/proj/a');
    const b1 = await pool.getOrSpawn('/proj/b');
    expect(a1).toBe(a2); // reused
    expect(a1).not.toBe(b1);
    expect(log).toEqual(['/proj/a', '/proj/b']); // spawned once each
    expect(pool.size()).toBe(2);
  });

  it('returns the default daemon when cwd is omitted or the default workspace', async () => {
    const log: string[] = [];
    const pool = makePool(log);
    const d1 = await pool.getOrSpawn();
    const d2 = await pool.getOrSpawn('/home/evan');
    expect((d1 as unknown as { tag: string }).tag).toBe('default');
    expect((d2 as unknown as { tag: string }).tag).toBe('default');
    expect(log).toEqual([]); // never spawned
  });

  it('dedupes concurrent spawns for the same new workspace', async () => {
    const log: string[] = [];
    const pool = makePool(log);
    const [c1, c2] = await Promise.all([
      pool.getOrSpawn('/proj/c'),
      pool.getOrSpawn('/proj/c'),
    ]);
    expect(c1).toBe(c2);
    expect(log).toEqual(['/proj/c']);
    expect(pool.size()).toBe(1);
    expect(pool.workspaces()).toEqual(['/proj/c']);
  });

  it('lets a failed spawn be retried on the next getOrSpawn (no stuck entry)', async () => {
    const log: string[] = [];
    let attempt = 0;
    const pool = new DaemonPool({
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => {
        log.push(cwd);
        attempt++;
        if (attempt === 1) throw new Error('boom: spawn failed');
        return {
          client: fakeClient(cwd),
          stop: async () => {},
          workspaceCwd: cwd,
        };
      },
    });
    await expect(pool.getOrSpawn('/proj/flaky')).rejects.toThrow(/boom/);
    // Retry should actually re-invoke spawn, not hang or return a stale rejection.
    const client = await pool.getOrSpawn('/proj/flaky');
    expect((client as unknown as { tag: string }).tag).toBe('/proj/flaky');
    expect(log).toEqual(['/proj/flaky', '/proj/flaky']);
    expect(pool.size()).toBe(1);
  });

  it('routes a session-keyed call to the daemon that created the session', async () => {
    const pool = makePool([]); // spawn returns fakeClient(cwd)
    const s = await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    const ctx = (await pool.sessionContext(s.sessionId)) as unknown as {
      calledOn: string;
    };
    expect(ctx.calledOn).toBe('/proj/a');
  });

  it('routes every session-keyed method to the owning daemon', async () => {
    const pool = makePool([]);
    const s = await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    const id = s.sessionId;

    const prompt = (await pool.prompt(id, { prompt: [] })) as unknown as {
      calledOn: string;
    };
    expect(prompt.calledOn).toBe('/proj/a');

    const ok = await pool.respondToSessionPermission(id, 'req-1', {
      outcome: 'selected',
      optionId: 'allow',
    } as never);
    expect(ok).toBe(true);

    const rewind = (await pool.rewindSession(id, { toTurn: 0 })) as unknown as {
      calledOn: string;
    };
    expect(rewind.calledOn).toBe('/proj/a');

    const cmds = (await pool.sessionSupportedCommands(id)) as unknown as {
      calledOn: string;
    };
    expect(cmds.calledOn).toBe('/proj/a');

    const mode = (await pool.setSessionApprovalMode(
      id,
      'default' as never,
    )) as unknown as { calledOn: string };
    expect(mode.calledOn).toBe('/proj/a');

    const loaded = (await pool.loadSession(id)) as unknown as {
      calledOn: string;
    };
    expect(loaded.calledOn).toBe('/proj/a');
  });

  it('routes daemon-global calls to the default daemon', async () => {
    const pool = makePool([]);
    const h = (await pool.health()) as unknown as { calledOn: string };
    expect(h.calledOn).toBe('default');
    const c = (await pool.capabilities()) as unknown as { calledOn: string };
    expect(c.calledOn).toBe('default');
    const list = (await pool.listWorkspaceSessions(
      '/proj/a',
    )) as unknown as Array<{ calledOn: string }>;
    expect(list[0].calledOn).toBe('default');
  });

  it('resolves session ids created on the default daemon (never reaped)', async () => {
    const pool = makePool([]);
    const s = await pool.createOrAttachSession({});
    const ctx = (await pool.sessionContext(s.sessionId)) as unknown as {
      calledOn: string;
    };
    expect(ctx.calledOn).toBe('default');
  });

  it('throws UnknownSessionError for an unrecorded id', async () => {
    const pool = makePool([]);
    await expect(pool.sessionContext('nope')).rejects.toThrow(
      /unknown session/i,
    );
    await expect(pool.sessionContext('nope')).rejects.toBeInstanceOf(
      UnknownSessionError,
    );
  });

  it('throws UnknownSessionError once the owning daemon has been reaped', async () => {
    let t = 0;
    const pool = new DaemonPool({
      now: () => t,
      idleReapMs: 1000,
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => ({
        client: fakeClient(cwd, `${cwd}-s`),
        stop: async () => {},
        workspaceCwd: cwd,
      }),
    });
    const s = await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    await pool.endSession(s.sessionId);
    t = 10_000;
    pool.reapIdle();
    expect(pool.size()).toBe(0);
    await expect(pool.sessionContext(s.sessionId)).rejects.toBeInstanceOf(
      UnknownSessionError,
    );
  });

  it('removes the session id from its entry on endSession success', async () => {
    let t = 0;
    const pool = new DaemonPool({
      now: () => t,
      idleReapMs: 1000,
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => ({
        client: fakeClient(cwd, `${cwd}-s`),
        stop: async () => {},
        workspaceCwd: cwd,
      }),
    });
    const s = await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    await pool.endSession(s.sessionId);
    // The entry itself should still exist (not reaped yet) but be idle.
    expect(pool.size()).toBe(1);
    t = 10_000;
    pool.reapIdle();
    expect(pool.size()).toBe(0);
  });

  it('reaps an idle daemon after idleReapMs; never one with live sessions', async () => {
    let t = 0;
    const stopped: string[] = [];
    const pool = new DaemonPool({
      now: () => t,
      idleReapMs: 1000,
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => ({
        client: fakeClient(cwd, `${cwd}-s`),
        stop: async () => {
          stopped.push(cwd);
        },
        workspaceCwd: cwd,
      }),
    });
    const s = await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    t = 5000;
    pool.reapIdle(); // has a live session -> kept
    expect(pool.size()).toBe(1);
    expect(stopped).toEqual([]);
    await pool.endSession(s.sessionId);
    t = 10_000;
    pool.reapIdle(); // now idle -> reaped
    expect(pool.size()).toBe(0);
    expect(stopped).toEqual(['/proj/a']); // stop() was actually invoked
  });

  it('at cap, evicts the LRU idle daemon; throws when all are busy', async () => {
    let t = 0;
    const stopped: string[] = [];
    const pool = new DaemonPool({
      now: () => t,
      maxDaemons: 2,
      idleReapMs: 999_999_999,
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => ({
        client: fakeClient(cwd, `${cwd}-s`),
        stop: async () => {
          stopped.push(cwd);
        },
        workspaceCwd: cwd,
      }),
    });

    t = 1000;
    await pool.getOrSpawn('/proj/a'); // idle, lastUsed=1000
    t = 2000;
    await pool.getOrSpawn('/proj/b'); // idle, lastUsed=2000
    expect(pool.size()).toBe(2);

    // At cap (2). /proj/a is the LRU idle entry -> should be evicted to
    // make room for /proj/c.
    t = 3000;
    await pool.getOrSpawn('/proj/c');
    expect(pool.size()).toBe(2);
    expect(pool.workspaces().sort()).toEqual(['/proj/b', '/proj/c']);
    expect(stopped).toEqual(['/proj/a']);

    // Now occupy both remaining entries with live sessions so neither is
    // idle; a third new workspace must fail with WorkspacePoolFullError.
    const sb = await pool.createOrAttachSession({ workspaceCwd: '/proj/b' });
    const sc = await pool.createOrAttachSession({ workspaceCwd: '/proj/c' });
    expect(sb.sessionId).toBeTruthy();
    expect(sc.sessionId).toBeTruthy();

    await expect(pool.getOrSpawn('/proj/d')).rejects.toBeInstanceOf(
      WorkspacePoolFullError,
    );
  });
});
