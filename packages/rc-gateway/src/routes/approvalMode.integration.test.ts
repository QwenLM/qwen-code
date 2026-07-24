/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end proof for remote approval-mode control (`add-remote-approval-mode`),
 * in two halves:
 *
 *  1. The route (routes/approvalMode.ts), mounted through the REAL
 *     `createGatewayApp` (real TokenStore/PairingService/requireScope(WRITE)
 *     mount, real stub daemon over HTTP) — an owner token setting `plan` gets
 *     the full `200` result body, and the REQUEST ITSELF produces no
 *     `approval_mode_changed` owner-bus frame (the route deliberately does not
 *     publish/notify; see routes/approvalMode.ts's top-of-file doc comment).
 *
 *  2. The forward (webpush/approvalModeForward.ts) — the single owner-stream
 *     broadcast per change is driven by the gateway's OWN daemon-event pump
 *     (`SessionEventPump`), whose `onEvent` hook cli.ts wires as:
 *       `if (ev.type === 'approval_mode_changed') forwardApprovalModeChange(sid, ev.data, ownerEvents)`
 *     — see cli.ts around the `pump = new SessionEventPump(...)` construction.
 *     The forward publishes the owner-bus frame ONLY; it takes no notifier
 *     and never calls `notify`. The push notification for this same event is
 *     delivered by the pump's OWN universal notify path
 *     (`SessionEventPump.runLoop`'s unconditional
 *     `await this.notifier?.notify(...)`, pump.ts) — identical to every other
 *     event type. This test wires ONE shared notifier to both the pump
 *     constructor and (historically) the forward call, specifically so it
 *     can assert the notifier fires exactly ONCE per event — a regression
 *     guard for a verified double-push bug where the forward ALSO called
 *     `notify`, producing two real pushes for one `approval_mode_changed`
 *     event (no event-level dedup in `notify`, coalescer off by default).
 *     `createGatewayApp` itself does NOT construct or start that pump (it has
 *     no `SessionEventPump` reference at all — confirmed by inspection); the
 *     pump is boot-time wiring that lives only in cli.ts, alongside
 *     usage-ingestion/agent/review `onEvent` consumers. So there is no way to
 *     "feed the stub daemon's SSE stream and see a forwarded owner frame"
 *     through `createGatewayApp` alone — nothing inside the app subscribes to
 *     that stream itself. Asserting otherwise would either hang (nothing ever
 *     forwards) or require silently reintroducing pump wiring into the app,
 *     which is out of scope for a test-only task.
 *
 *     Instead, this test reconstructs the EXACT seam cli.ts builds: a real
 *     `SessionEventPump` (production class, not a fake) is subscribed to the
 *     SAME stub daemon and given an `onEvent` hook that calls the real
 *     `forwardApprovalModeChange` against `gw.ownerEvents` — the SAME bus
 *     `createGatewayApp` returns and that GET /rc/events reads from. This
 *     precisely mirrors the existing precedent in
 *     `cost/ingestPump.integration.test.ts`, which faces the identical gap
 *     (the cost ingester's `onEvent` hook is also only wired in cli.ts) and
 *     resolves it the same way: construct a real `SessionEventPump` directly
 *     in the test rather than asserting through `createGatewayApp`.
 *
 *     A daemon-shaped `approval_mode_changed` frame travels real SSE bytes
 *     (stub daemon -> DaemonClient.subscribeEvents -> pump's per-session loop)
 *     before `forwardApprovalModeChange` ever runs, so this proves the actual
 *     wire path is reachable, not just that the forward function is correct
 *     in isolation (already covered by `webpush/approvalModeForward.test.ts`
 *     with a bare `OwnerEventBus` and hand-fed data — no daemon, no pump).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { DaemonClient, type DaemonEvent } from '@qwen-code/sdk';
import { createGatewayApp } from '../server.js';
import { TokenStore } from '../tokenStore.js';
import { PairingService } from '../pairing.js';
import { SessionEventPump } from '../webpush/pump.js';
import { forwardApprovalModeChange } from '../webpush/approvalModeForward.js';
import type { OwnerEvent } from '../ownerEvents.js';

const SESSION_ID = 's1';
const WORKSPACE_CWD = '/approval-mode-integration/ws';

let server: Server | undefined;
let runtimeBase: string;
let stub: StubDaemon | undefined;
let pump: SessionEventPump | undefined;

interface NotifyCall {
  event: { type: string; data: unknown };
  ctx: { sessionId: string; sessionName?: string };
}

/** Fake notifier matching PumpNotifier/ApprovalNotifySink's structural `notify`; collects calls. */
function fakeNotifier(calls: NotifyCall[]) {
  return {
    notify: async (
      event: { type: string; data: unknown },
      ctx: { sessionId: string; sessionName?: string },
    ): Promise<void> => {
      calls.push({ event, ctx });
    },
  };
}

/** Poll a predicate until it holds or a deadline elapses — never a fixed sleep. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
}

beforeEach(async () => {
  runtimeBase = await mkdtemp(join(tmpdir(), 'rc-approval-mode-integ-'));
});

afterEach(async () => {
  // Stop the pump BEFORE closing the stub (mirrors webpush/pump.test.ts and
  // cost/ingestPump.integration.test.ts): a live pump with reconnectMs:0
  // would hot-loop failed connects against an already-closed stub.
  if (pump) await pump.stop();
  pump = undefined;
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  if (stub) await stub.close();
  stub = undefined;
  await rm(runtimeBase, { recursive: true, force: true });
});

describe('approval-mode integration (route set + pump forward)', () => {
  it('owner sets plan mode via the real route (200, full body, no owner frame from the request); the gateway pump then forwards a daemon approval_mode_changed event as exactly one owner-bus frame', async () => {
    // The stub serves both surfaces used below: the approval-mode POST (for
    // the route half) and a scripted `approval_mode_changed` SSE frame plus a
    // matching workspace-session listing (for the pump half). holdOpenMs
    // parks the pump's per-session loop in `for await` after the single frame
    // so it does not hot-reconnect and re-dispatch — same trick
    // webpush/pump.test.ts uses.
    stub = await startStubDaemon({
      approvalModeResult: {
        mode: 'plan',
        previous: 'default',
        persisted: false,
      },
      workspaceCwd: WORKSPACE_CWD,
      sessions: [{ sessionId: SESSION_ID, workspaceCwd: WORKSPACE_CWD }],
      frames: [
        {
          id: 1,
          type: 'approval_mode_changed',
          data: { previous: 'default', next: 'plan', persisted: false },
        },
      ],
      holdOpenMs: 5000,
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });

    // Real app: real TokenStore, real requireScope(WRITE)/bearerResolve mount
    // (server.ts wires POST /session/:id/approval-mode behind
    // requireScope(WRITE), with the route's own in-handler OWNER escalation
    // for power modes/persist) — no hand-rolled express() app.
    const store = await TokenStore.open(join(runtimeBase, 'tokens.json'));
    const { token: ownerToken } = await store.issue(['owner'], 'o');

    const gw = createGatewayApp({
      daemon,
      store,
      pairing: new PairingService(),
      auditPath: join(runtimeBase, 'audit.log'),
    });

    // Subscribe to the REAL owner-event bus BEFORE the request, so any frame
    // the request itself produces is observed.
    const ownerFrames: OwnerEvent[] = [];
    gw.ownerEvents.subscribe((e) => ownerFrames.push(e));

    server = await new Promise((resolve) => {
      const s = gw.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    // --- Part 1: the route, through the real mount ---------------------
    const res = await fetch(`${baseUrl}/session/${SESSION_ID}/approval-mode`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ mode: 'plan' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      sessionId: SESSION_ID,
      mode: 'plan',
      previous: 'default',
      persisted: false,
      planExitedOutOfBand: false,
    });

    // The request itself must never publish an approval_mode_changed frame —
    // that broadcast is exclusively the pump forward's job (routes/approvalMode.ts's
    // doc comment). The real audit write DOES publish a same-bus `audit`
    // frame (AuditLog's own onRecord -> ownerEvents.publish, unrelated to this
    // feature), so the assertion is scoped to the specific frame type under
    // test rather than an empty-bus assumption.
    const approvalFramesFromRequest = ownerFrames.filter(
      (f) => f.type === 'approval_mode_changed',
    );
    expect(approvalFramesFromRequest).toHaveLength(0);

    // --- Part 2: the forward, through the real pump seam ----------------
    // createGatewayApp does not construct/start a SessionEventPump — that
    // wiring lives only in cli.ts. Reconstruct the identical seam here: a
    // real SessionEventPump (not a fake) subscribed to the same stub daemon,
    // with the same onEvent -> forwardApprovalModeChange call cli.ts makes,
    // against the real `gw.ownerEvents` bus.
    const notifyCalls: NotifyCall[] = [];
    const notifier = fakeNotifier(notifyCalls);
    pump = new SessionEventPump(daemon, notifier, {
      pollMs: 20,
      reconnectMs: 0,
      sleep: async () => {},
      onEvent: (sid: string, ev: DaemonEvent) => {
        if (ev.type === 'approval_mode_changed') {
          forwardApprovalModeChange(sid, ev.data, gw.ownerEvents);
        }
      },
    });
    await pump.start();

    const sawForward = await waitFor(() =>
      ownerFrames.some((f) => f.type === 'approval_mode_changed'),
    );
    expect(sawForward).toBe(true);

    const forwarded = ownerFrames.filter(
      (f) => f.type === 'approval_mode_changed',
    );
    expect(forwarded).toHaveLength(1);
    const frame = forwarded[0];
    if (frame.type !== 'approval_mode_changed') throw new Error('unreachable');
    expect(frame.mode).toEqual({
      sessionId: SESSION_ID,
      previous: 'default',
      next: 'plan',
      persisted: false,
    });

    // Regression guard: the notifier must fire EXACTLY ONCE for this event —
    // from the pump's OWN always-on generic dispatch
    // (`SessionEventPump.runLoop`'s unconditional
    // `await this.notifier?.notify(...)` for every non-suppressed event,
    // pump.ts, independent of `onEvent`). `forwardApprovalModeChange` no
    // longer takes a notifier and never calls `notify` itself — it only
    // publishes the owner-bus frame asserted above. Before that fix, this
    // same `notifier` reference was ALSO passed into the forward, which
    // called `notify` a second time, so this event produced TWO real
    // pushes with no dedup (the coalescer is off by default). Asserting
    // exactly 1 here is what would have caught that double push.
    expect(notifyCalls).toHaveLength(1);
    for (const call of notifyCalls) {
      expect(call.event).toEqual({
        type: 'approval_mode_changed',
        data: { previous: 'default', next: 'plan', persisted: false },
      });
      expect(call.ctx.sessionId).toBe(SESSION_ID);
    }
  });
});
