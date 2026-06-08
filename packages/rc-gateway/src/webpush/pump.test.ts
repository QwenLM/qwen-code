/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { DaemonClient, type DaemonEvent } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { SessionEventPump } from './pump.js';

interface Dispatched {
  e: { type: string; data: unknown };
  ctx: { sessionId: string; sessionName?: string };
}

/** Fake notifier matching the PushNotifier.notify shape; collects calls. */
function fakeNotifier(collected: Dispatched[]) {
  return {
    notify: async (
      e: { type: string; data: unknown },
      ctx: { sessionId: string; sessionName?: string },
    ): Promise<void> => {
      collected.push({ e, ctx });
    },
  };
}

/** Poll a collected array until predicate holds or a deadline elapses. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
}

let stub: StubDaemon | undefined;
let pump: SessionEventPump | undefined;

afterEach(async () => {
  // Stop the pump BEFORE closing the stub: a live pump with reconnectMs:0 would
  // hot-loop failed connects against a closed stub.
  if (pump) await pump.stop();
  if (stub) await stub.close();
  pump = undefined;
  stub = undefined;
});

describe('SessionEventPump', () => {
  it('dispatches a permission_request for a listed session', async () => {
    const collected: Dispatched[] = [];
    stub = await startStubDaemon({
      workspaceCwd: '/w',
      sessions: [{ sessionId: 's1', workspaceCwd: '/w' }],
      // holdOpenMs parks the loop in `for await` after the single frame so it
      // does not hot-reconnect and re-dispatch.
      holdOpenMs: 2000,
      frames: [
        { id: 7, type: 'permission_request', data: { requestId: 'r1' } },
      ],
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    pump = new SessionEventPump(daemon, fakeNotifier(collected), {
      pollMs: 20,
      reconnectMs: 0,
      sleep: async () => {},
    });
    await pump.start();

    const got = await waitFor(() =>
      collected.some((d) => d.e.type === 'permission_request'),
    );
    expect(got).toBe(true);
    const hit = collected.find((d) => d.e.type === 'permission_request')!;
    expect(hit.ctx.sessionId).toBe('s1');
  });

  it('aborts the loop when a session is removed from the list', async () => {
    const collected: Dispatched[] = [];
    const sessions = [{ sessionId: 's1', workspaceCwd: '/w' }];
    stub = await startStubDaemon({
      workspaceCwd: '/w',
      sessions,
      holdOpenMs: 2000,
      frames: [{ id: 1, type: 'permission_request', data: {} }],
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    pump = new SessionEventPump(daemon, fakeNotifier(collected), {
      pollMs: 20,
      reconnectMs: 0,
      sleep: async () => {},
    });
    await pump.start();

    expect(await waitFor(() => collected.length >= 1)).toBe(true);

    // Remove the session; the next poll tick must abort its loop.
    sessions.length = 0;
    const aborted = await waitFor(
      () => stub!.eventsAbortedByClient === true,
      2000,
    );
    expect(aborted).toBe(true);

    // No additional dispatch after removal/abort (the parked loop emitted once).
    const countAfter = collected.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(collected.length).toBe(countAfter);
  });

  it('start() resolves and dispatches nothing when capabilities fails', async () => {
    const collected: Dispatched[] = [];
    stub = await startStubDaemon({
      capabilitiesStatus: 500,
      sessions: [{ sessionId: 's1', workspaceCwd: '/w' }],
      frames: [{ id: 1, type: 'permission_request', data: {} }],
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    pump = new SessionEventPump(daemon, fakeNotifier(collected), {
      pollMs: 20,
      reconnectMs: 0,
      sleep: async () => {},
    });
    await pump.start(); // must not throw

    await new Promise((r) => setTimeout(r, 150));
    expect(collected.length).toBe(0);
  });

  it('dispatches nothing for an empty session list and stops cleanly', async () => {
    const collected: Dispatched[] = [];
    stub = await startStubDaemon({
      workspaceCwd: '/w',
      sessions: [],
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    pump = new SessionEventPump(daemon, fakeNotifier(collected), {
      pollMs: 20,
      reconnectMs: 0,
      sleep: async () => {},
    });
    await pump.start();

    await new Promise((r) => setTimeout(r, 150));
    expect(collected.length).toBe(0);
    await pump.stop();
  });

  it('stop() aborts loops: no dispatches after stop', async () => {
    const collected: Dispatched[] = [];
    stub = await startStubDaemon({
      workspaceCwd: '/w',
      sessions: [{ sessionId: 's1', workspaceCwd: '/w' }],
      holdOpenMs: 2000,
      frames: [{ id: 1, type: 'permission_request', data: {} }],
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    pump = new SessionEventPump(daemon, fakeNotifier(collected), {
      pollMs: 20,
      reconnectMs: 0,
      sleep: async () => {},
    });
    await pump.start();
    expect(await waitFor(() => collected.length >= 1)).toBe(true);

    await pump.stop();
    const countAfter = collected.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(collected.length).toBe(countAfter);
  });

  it('updates lastEventId from numeric event ids', async () => {
    const collected: Dispatched[] = [];
    const onDispatchSeen: Array<{ id: string; event: DaemonEvent }> = [];
    stub = await startStubDaemon({
      workspaceCwd: '/w',
      sessions: [{ sessionId: 's1', workspaceCwd: '/w' }],
      holdOpenMs: 2000,
      frames: [{ id: 42, type: 'permission_request', data: {} }],
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    pump = new SessionEventPump(daemon, fakeNotifier(collected), {
      pollMs: 20,
      reconnectMs: 0,
      sleep: async () => {},
      onDispatch: (id, event) => onDispatchSeen.push({ id, event }),
    });
    await pump.start();
    expect(await waitFor(() => onDispatchSeen.length >= 1)).toBe(true);
    expect(onDispatchSeen[0].event.id).toBe(42);
    expect(onDispatchSeen[0].id).toBe('s1');
  });
});
