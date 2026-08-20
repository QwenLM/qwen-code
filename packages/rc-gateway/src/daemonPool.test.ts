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
import type { DaemonClient, DaemonEvent } from '@qwen-code/sdk';

/** Default no-op event stream: yields nothing. */
async function* noEvents(): AsyncGenerator<DaemonEvent> {
  /* empty */
}

function fakeClient(
  tag: string,
  sid?: string,
  events: () => AsyncGenerator<DaemonEvent> = noEvents,
  /** When set, `createOrAttachSession` awaits this before resolving —
   * lets tests hold a create call open mid-flight to reproduce races. */
  createGate?: Promise<void>,
) {
  return {
    tag,
    async createOrAttachSession() {
      if (createGate) await createGate;
      return {
        sessionId: sid ?? `${tag}-s`,
        workspaceCwd: tag,
        attached: false,
      };
    },
    async sessionContext(id: string) {
      return { calledOn: tag, id };
    },
    async closeSession(id: string) {
      return { ended: true, id };
    },
    async prompt(id: string) {
      return { calledOn: tag, id };
    },
    async respondToSessionPermission() {
      return true;
    },
    async rewindSession(id: string, promptId: string) {
      return { calledOn: tag, id, promptId };
    },
    async getRewindSnapshots(id: string) {
      return { calledOn: tag, id, snapshots: [] };
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
    async resumeSession(id: string) {
      return { sessionId: id, workspaceCwd: tag, attached: true };
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
    subscribeEvents: events,
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

  it('resumeSession routes to the workspace daemon and records ownership', async () => {
    const pool = makePool([]); // fake spawn returns fakeClient(cwd) with resumeSession + sessionContext
    const r = await pool.resumeSession('sess-old', { workspaceCwd: '/proj/a' });
    expect(r.sessionId).toBe('sess-old');
    expect(pool.size()).toBe(1); // spawned /proj/a
    const ctx = (await pool.sessionContext('sess-old')) as unknown as {
      calledOn: string;
    };
    expect(ctx.calledOn).toBe('/proj/a'); // now routes to /proj/a
  });

  it('resumeSession on the default workspace cwd routes to the default daemon (no spawn)', async () => {
    const log: string[] = [];
    const pool = makePool(log);
    const r = await pool.resumeSession('sess-old', {
      workspaceCwd: '/home/evan/',
    });
    expect(r.sessionId).toBe('sess-old');
    expect(log).toEqual([]); // never spawned
    const ctx = (await pool.sessionContext('sess-old')) as unknown as {
      calledOn: string;
    };
    expect(ctx.calledOn).toBe('default');
  });

  it('does not evict an entry mid-resumeSession; the pending reservation protects it from a concurrent cap eviction', async () => {
    const t = 0;
    const stopped: string[] = [];
    let releaseResume: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const pool = new DaemonPool({
      now: () => t,
      maxDaemons: 1,
      idleReapMs: 999_999_999,
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => ({
        client: {
          ...fakeClient(cwd, `${cwd}-s`),
          async resumeSession(id: string) {
            if (cwd === '/proj/a') await gate;
            return { sessionId: id, workspaceCwd: cwd, attached: true };
          },
        } as unknown as DaemonClient,
        stop: async () => {
          stopped.push(cwd);
        },
        workspaceCwd: cwd,
      }),
    });

    await pool.getOrSpawn('/proj/a'); // spawns an idle entry (sessions.size === 0)
    // Kick off a resume against /proj/a; its client.resumeSession hangs on
    // `gate`, so this call is stuck mid-registration.
    const resumePromise = pool.resumeSession('sess-old', {
      workspaceCwd: '/proj/a',
    });

    // At cap (maxDaemons=1). /proj/a still LOOKS idle by session count
    // alone, but it's mid-resume (pending > 0) -- must be treated as busy
    // and NOT evicted to make room for a new workspace.
    await expect(pool.getOrSpawn('/proj/b')).rejects.toBeInstanceOf(
      WorkspacePoolFullError,
    );
    expect(stopped).toEqual([]); // never stopped
    expect(pool.workspaces()).toEqual(['/proj/a']); // still present

    releaseResume!();
    const restored = await resumePromise;
    expect(restored.sessionId).toBe('sess-old');
    expect(pool.workspaces()).toEqual(['/proj/a']); // untouched throughout
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

    const rewind = (await pool.rewindSession(id, 'prompt-0')) as unknown as {
      calledOn: string;
      promptId: string;
    };
    expect(rewind.calledOn).toBe('/proj/a');
    expect(rewind.promptId).toBe('prompt-0');

    const snapshots = (await pool.getRewindSnapshots(id)) as unknown as {
      calledOn: string;
    };
    expect(snapshots.calledOn).toBe('/proj/a');

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
    await pool.closeSession(s.sessionId);
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
    await pool.closeSession(s.sessionId);
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
    await pool.closeSession(s.sessionId);
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

  it('prunes a session on a session_died frame observed via subscribeEvents, letting the entry become reapable', async () => {
    let t = 0;
    const stopped: string[] = [];
    async function* diedEvents(): AsyncGenerator<DaemonEvent> {
      yield {
        v: 1,
        type: 'session_died',
        data: { sessionId: 'ignored-by-pool', reason: 'crashed' },
      } as DaemonEvent;
    }
    const pool = new DaemonPool({
      now: () => t,
      idleReapMs: 1000,
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => ({
        client: fakeClient(cwd, `${cwd}-s`, diedEvents),
        stop: async () => {
          stopped.push(cwd);
        },
        workspaceCwd: cwd,
      }),
    });
    const s = await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    expect(pool.size()).toBe(1);

    // Drain the wrapped subscription; the session_died frame passing
    // through should prune the session from the entry's live-sessions set.
    const seenTypes: string[] = [];
    for await (const ev of pool.subscribeEvents(s.sessionId)) {
      seenTypes.push(ev.type);
    }
    expect(seenTypes).toEqual(['session_died']);

    // Entry still exists (only idle-timeout reaps it), but is now idle.
    expect(pool.size()).toBe(1);
    expect(stopped).toEqual([]);
    t = 5000;
    pool.reapIdle();
    expect(pool.size()).toBe(0);
    expect(stopped).toEqual(['/proj/a']);

    // The pruned id no longer resolves at all -- confirms it's out of
    // `ownerOf`, not just out of the (now-deleted) entry's `sessions`.
    await expect(pool.sessionContext(s.sessionId)).rejects.toBeInstanceOf(
      UnknownSessionError,
    );
  });

  it('prunes on a session_closed frame (the other SDK-defined session-lifecycle terminal)', async () => {
    let t = 0;
    const stopped: string[] = [];
    async function* closedEvents(): AsyncGenerator<DaemonEvent> {
      yield {
        v: 1,
        type: 'session_closed',
        data: { sessionId: 'ignored-by-pool', reason: 'client_close' },
      } as DaemonEvent;
    }
    const pool = new DaemonPool({
      now: () => t,
      idleReapMs: 1000,
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => ({
        client: fakeClient(cwd, `${cwd}-s`, closedEvents),
        stop: async () => {
          stopped.push(cwd);
        },
        workspaceCwd: cwd,
      }),
    });
    const s = await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    for await (const _ev of pool.subscribeEvents(s.sessionId)) {
      /* drain */
    }
    t = 5000;
    pool.reapIdle();
    expect(pool.size()).toBe(0);
    expect(stopped).toEqual(['/proj/a']);
    await expect(pool.sessionContext(s.sessionId)).rejects.toBeInstanceOf(
      UnknownSessionError,
    );
  });

  it('does NOT prune on a client_evicted frame -- it describes stream liveness, not session liveness', async () => {
    let t = 0;
    async function* evictedEvents(): AsyncGenerator<DaemonEvent> {
      yield {
        v: 1,
        type: 'client_evicted',
        data: { reason: 'slow_client' },
      } as DaemonEvent;
    }
    const pool = new DaemonPool({
      now: () => t,
      idleReapMs: 1000,
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => ({
        client: fakeClient(cwd, `${cwd}-s`, evictedEvents),
        stop: async () => {},
        workspaceCwd: cwd,
      }),
    });
    const s = await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    for await (const _ev of pool.subscribeEvents(s.sessionId)) {
      /* drain */
    }
    // The session should still be considered live -- client_evicted only
    // means THIS stream got dropped, not that the daemon session ended --
    // so reapIdle must NOT reclaim the entry even past idleReapMs, and the
    // session id must still resolve.
    t = 5000;
    pool.reapIdle();
    expect(pool.size()).toBe(1);
    const ctx = (await pool.sessionContext(s.sessionId)) as unknown as {
      calledOn: string;
    };
    expect(ctx.calledOn).toBe('/proj/a');
  });

  it('does not evict an entry mid-createOrAttachSession; the pending reservation protects it from a concurrent cap eviction', async () => {
    const t = 0;
    const stopped: string[] = [];
    let releaseCreate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const pool = new DaemonPool({
      now: () => t,
      maxDaemons: 1,
      idleReapMs: 999_999_999,
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => ({
        client: fakeClient(
          cwd,
          `${cwd}-s`,
          noEvents,
          cwd === '/proj/a' ? gate : undefined,
        ),
        stop: async () => {
          stopped.push(cwd);
        },
        workspaceCwd: cwd,
      }),
    });

    await pool.getOrSpawn('/proj/a'); // spawns an idle entry (sessions.size === 0)
    // Kick off a create against /proj/a; its client.createOrAttachSession
    // hangs on `gate`, so this call is stuck mid-registration.
    const createPromise = pool.createOrAttachSession({
      workspaceCwd: '/proj/a',
    });

    // At cap (maxDaemons=1). /proj/a still LOOKS idle by session count
    // alone, but it's mid-create (pending > 0) -- must be treated as busy
    // and NOT evicted to make room for a new workspace.
    await expect(pool.getOrSpawn('/proj/b')).rejects.toBeInstanceOf(
      WorkspacePoolFullError,
    );
    expect(stopped).toEqual([]); // never stopped
    expect(pool.workspaces()).toEqual(['/proj/a']); // still present

    releaseCreate!();
    const session = await createPromise;
    expect(session.sessionId).toBe('/proj/a-s');
    expect(pool.workspaces()).toEqual(['/proj/a']); // untouched throughout
  });

  it('stopAll() stops every pooled daemon and empties the pool', async () => {
    const stopped: string[] = [];
    const pool = new DaemonPool({
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => ({
        client: fakeClient(cwd),
        stop: async () => {
          stopped.push(cwd);
        },
        workspaceCwd: cwd,
      }),
    });

    await pool.getOrSpawn('/proj/a');
    await pool.getOrSpawn('/proj/b');
    expect(pool.size()).toBe(2);

    await pool.stopAll();

    expect(stopped.sort()).toEqual(['/proj/a', '/proj/b']);
    expect(pool.size()).toBe(0);
    expect(pool.workspaces()).toEqual([]);
  });

  it('stopAll() tolerates an individual entry stop() rejecting', async () => {
    const stopped: string[] = [];
    const pool = new DaemonPool({
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => ({
        client: fakeClient(cwd),
        stop: async () => {
          if (cwd === '/proj/flaky') throw new Error('stop failed');
          stopped.push(cwd);
        },
        workspaceCwd: cwd,
      }),
    });

    await pool.getOrSpawn('/proj/flaky');
    await pool.getOrSpawn('/proj/ok');

    // One entry's stop() rejects; the other must still be asked to stop, and
    // stopAll() itself must not reject.
    await expect(pool.stopAll()).resolves.toBeUndefined();
    expect(stopped).toEqual(['/proj/ok']);
    expect(pool.size()).toBe(0);
  });

  it('normalizes the workspace cwd: /proj/a and /proj/a/ share one entry (no duplicate spawn)', async () => {
    const log: string[] = [];
    const pool = makePool(log);
    const a1 = await pool.getOrSpawn('/proj/a');
    const a2 = await pool.getOrSpawn('/proj/a/');
    expect(a1).toBe(a2);
    expect(log).toEqual(['/proj/a']); // spawned exactly once
    expect(pool.size()).toBe(1);
    expect(pool.workspaces()).toEqual(['/proj/a']);
  });

  it('routes a create with a trailing-slash default workspace cwd to the default daemon (no spawn)', async () => {
    const log: string[] = [];
    const pool = makePool(log); // defaultWorkspaceCwd: '/home/evan'
    const session = await pool.createOrAttachSession({
      workspaceCwd: '/home/evan/',
    });
    expect(log).toEqual([]); // never spawned -- routed straight to default
    const ctx = (await pool.sessionContext(session.sessionId)) as unknown as {
      calledOn: string;
    };
    expect(ctx.calledOn).toBe('default');
  });

  it('counts in-flight spawns against the cap: concurrent distinct-cwd creates cannot exceed maxDaemons', async () => {
    const gates = new Map<string, () => void>();
    const spawnLog: string[] = [];
    const pool = new DaemonPool({
      maxDaemons: 2,
      idleReapMs: 999_999_999,
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => {
        spawnLog.push(cwd);
        if (cwd === '/proj/new1' || cwd === '/proj/new2') {
          // Hang this spawn open so it stays "in flight" long enough for
          // the second concurrent getOrSpawn's cap check to observe it.
          await new Promise<void>((resolve) => gates.set(cwd, resolve));
        }
        return {
          client: fakeClient(cwd, `${cwd}-s`),
          stop: async () => {},
          workspaceCwd: cwd,
        };
      },
    });

    // Occupy one of the two cap slots with a BUSY entry (has a live
    // session, so it can never be the LRU-idle eviction victim).
    await pool.createOrAttachSession({ workspaceCwd: '/proj/busy' });
    expect(pool.size()).toBe(1);

    // Two concurrent getOrSpawn calls for two DISTINCT NEW cwds. Without
    // counting in-flight spawns, byWorkspace.size() alone (1, still below
    // maxDaemons=2) would let both pass the cap check and both spawn --
    // landing 3 pooled daemons against a cap of 2.
    const p1 = pool.getOrSpawn('/proj/new1');
    await expect(pool.getOrSpawn('/proj/new2')).rejects.toBeInstanceOf(
      WorkspacePoolFullError,
    );
    // The rejected call must never have reached spawn() for /proj/new2.
    expect(spawnLog).toEqual(['/proj/busy', '/proj/new1']);

    gates.get('/proj/new1')!();
    const client1 = await p1;
    expect((client1 as unknown as { tag: string }).tag).toBe('/proj/new1');
    expect(pool.size()).toBe(2); // /proj/busy + /proj/new1 only
  });

  it('stopAll(): a spawn that resolves after stopAll() does not leak into the pool', async () => {
    let releaseSpawn: (() => void) | undefined;
    const stopped: string[] = [];
    const gate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const pool = new DaemonPool({
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => {
        await gate;
        return {
          client: fakeClient(cwd),
          stop: async () => {
            stopped.push(cwd);
          },
          workspaceCwd: cwd,
        };
      },
    });

    const spawnPromise = pool.getOrSpawn('/proj/late');
    // Shut the pool down WHILE the spawn above is still in flight.
    await pool.stopAll();
    // Now let the spawn resolve, after shutdown already ran.
    releaseSpawn!();
    const client = await spawnPromise;

    expect((client as unknown as { tag: string }).tag).toBe('/proj/late');
    expect(stopped).toEqual(['/proj/late']); // stop() was invoked on it
    expect(pool.size()).toBe(0); // never registered into the cleared pool
    expect(pool.workspaces()).toEqual([]);
  });
});
