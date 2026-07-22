/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end integration test for the remote-review control plane (E.3).
 *
 * Every other review route test (`routes/review.test.ts`) injects a FAKE
 * bridge (`{ open: vi.fn(), close: vi.fn() }`) — sufficient for saga-shape
 * assertions, but it never exercises the actual permission bridge's vote/
 * escalate logic or its `onEscalate`/`onResume` wiring in server.ts. This
 * file does NOT set `deps.review.bridge`: with no injected bridge,
 * `createGatewayApp` builds the REAL `ReviewPermissionBridge` over the stub
 * daemon (see server.ts's `deps.review.bridge ?? new ReviewPermissionBridge(...)`),
 * so these tests drive the real subscribe/vote/escalate loop end-to-end
 * against `startStubDaemon`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonClient } from '@qwen-code/sdk';
import { createGatewayApp } from '../server.js';
import { TokenStore } from '../tokenStore.js';
import { PairingService } from '../pairing.js';
import { ReviewRegistry } from './reviewRegistry.js';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import type { OwnerEvent } from '../ownerEvents.js';

let server: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  if (stub) await stub.close();
  server = undefined;
  stub = undefined;
});

/** Poll `cond` every 10ms until it's true or `ms` elapses (no fixed sleeps). */
async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function setup(
  stubOpts: Parameters<typeof startStubDaemon>[0] = {},
): Promise<{
  url: string;
  owner: string;
  registry: ReviewRegistry;
  frames: OwnerEvent[];
}> {
  // promptDelayMs is small by default (fast teardown — `stub.close()` waits
  // for any in-flight keep-alive request, including a pending
  // POST /session/:id/prompt, to settle). The cancel test below overrides it
  // to something large enough that the review is still 'running' — its
  // `/review` prompt still in flight — when the cancel call lands.
  stub = await startStubDaemon({ promptDelayMs: 50, ...stubOpts });
  const dir = await mkdtemp(join(tmpdir(), 'review-e2e-'));
  const store = await TokenStore.open(join(dir, 'tokens.json'));
  const owner = (await store.issue(['owner'], 'e2e-owner')).token;
  const registry = await ReviewRegistry.open(join(dir, 'reviews.json'));

  const gw = createGatewayApp({
    daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
    store,
    pairing: new PairingService(),
    auditPath: join(dir, 'audit.log'),
    // NO `bridge` here — createGatewayApp default-constructs the REAL
    // ReviewPermissionBridge over `deps.daemon` (the stub), which is the
    // whole point of this test file.
    review: {
      registry,
      costFor: () => 4242,
      resolveReport: async () => ({ reportPath: null, summary: null }),
      promptAcceptWindowMs: 25,
    },
  });
  const frames: OwnerEvent[] = [];
  gw.ownerEvents.subscribe((e) => frames.push(e));

  server = await new Promise((resolve) => {
    const s = gw.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server!.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, owner, registry, frames };
}

function post(url: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${url}/rc/reviews`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('remote review end-to-end (real permission bridge)', () => {
  it('trigger → review_started frame → cancel → review_cancelled frame + daemon session end', async () => {
    // A long prompt delay keeps the review 'running' (its `/review` prompt
    // still in flight) well past the cancel call below — otherwise this
    // would race the prompt settling and completing the review first.
    const { url, owner, frames } = await setup({ promptDelayMs: 3000 });

    // Trigger a plain (vote-mode, no autoApprove) local review as OWNER.
    const trigger = await post(url, owner, { target: { local: true } });
    expect(trigger.status).toBe(202);
    const { reviewId, sessionId } = (await trigger.json()) as {
      reviewId: string;
      sessionId: string;
    };
    expect(reviewId).toBeTruthy();
    expect(sessionId).toBe('stub-agent-1');
    expect(stub!.createdSessionCount).toBe(1);

    // Exactly one review_started frame on the owner bus (subscribed before
    // triggering, so no race with the route's synchronous `lifecycle.emit`).
    const started = frames.filter((f) => f.type === 'review_started');
    expect(started).toHaveLength(1);
    expect(
      (started[0] as Extract<OwnerEvent, { type: 'review_started' }>).review,
    ).toMatchObject({ reviewId, sessionId, status: 'running' });

    // Cancel.
    const cancel = await fetch(`${url}/rc/reviews/${reviewId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner}` },
    });
    expect(cancel.status).toBe(200);
    expect(stub!.lastEndedSessionId).toBe(sessionId);

    const cancelled = frames.filter((f) => f.type === 'review_cancelled');
    expect(cancelled).toHaveLength(1);
    expect(
      (cancelled[0] as Extract<OwnerEvent, { type: 'review_cancelled' }>)
        .review,
    ).toMatchObject({ reviewId, status: 'cancelled' });

    // Detail reflects the terminal status.
    const detail = await fetch(`${url}/rc/reviews/${reviewId}`, {
      headers: { Authorization: `Bearer ${owner}` },
    });
    expect(detail.status).toBe(200);
    expect((await detail.json()) as { status: string }).toMatchObject({
      status: 'cancelled',
    });
  });

  it('auto-approve: the real bridge votes a read (allow_once) and escalates an edit (autofix:false)', async () => {
    // The review's daemon session will be the stub's FIRST created session —
    // deterministic because `setup()` starts a brand-new stub per test.
    const reviewSessionId = 'stub-agent-1';
    const { url, owner, registry } = await setup({
      // Clean replay: only the scripted permission frames, none of the
      // stub's default two `session_update` frames (see the option's JSDoc —
      // permissionFrames ids continue after `frames`, so pass `frames: []`).
      frames: [],
      permissionFrames: [
        {
          type: 'permission_request',
          data: {
            requestId: 'q-read',
            sessionId: reviewSessionId,
            toolCall: { kind: 'read', rawInput: {} },
            // allow_always FIRST (index 0), allow_once SECOND: this makes the
            // test discriminate kind-based selection from a regressed
            // positional `options[0]` selector. If selection ever degraded to
            // "pick index 0", this would return 'always' and the assertion
            // below (expecting 'ok') would fail — proving the real
            // `selectAllowOnceOptionId` picks by `kind`, not position.
            options: [
              { optionId: 'always', kind: 'allow_always' },
              { optionId: 'ok', kind: 'allow_once' },
            ],
          },
        },
        {
          type: 'permission_request',
          data: {
            requestId: 'q-edit',
            sessionId: reviewSessionId,
            toolCall: { kind: 'edit', rawInput: { file_path: 'src/a.ts' } },
            options: [{ optionId: 'ok2', kind: 'allow_once' }],
          },
        },
      ],
    });

    // autoApprove requires OWNER (the trigger saga's owner-scope gate).
    // autofix defaults to false → approvalLeg 'auto', but edits still
    // escalate (classifyReviewToolCall only auto-approves edits when
    // `policy.autofix` is true).
    const trigger = await post(url, owner, {
      target: { local: true },
      autoApprove: true,
    });
    expect(trigger.status).toBe(202);
    const { reviewId, sessionId } = (await trigger.json()) as {
      reviewId: string;
      sessionId: string;
    };
    expect(sessionId).toBe(reviewSessionId);

    // The bridge processes the two scripted permission frames IN ORDER off a
    // single subscription (`for await` over one SSE replay) — the read vote
    // completes (an HTTP round-trip to the stub) strictly before the edit is
    // handled. So waiting for the review to become 'blocked' (the
    // onEscalate → lifecycle.setBlocked side effect wired in server.ts) is a
    // reliable synchronization point proving BOTH frames were processed:
    // the read must have already been voted, and the edit escalated (never
    // voted) to reach 'blocked'.
    await waitFor(() => registry.get(reviewId)?.status === 'blocked');
    expect(registry.get(reviewId)?.status).toBe('blocked');

    // The READ was voted with the allow_once option (never allow_always).
    expect(stub!.lastRespondedPermission).toMatchObject({
      requestId: 'q-read',
      response: { outcome: { outcome: 'selected', optionId: 'ok' } },
    });

    // The EDIT was never voted: the stub's `lastRespondedPermission` is the
    // most-recent POST /session/:id/permission/:requestId call it has seen.
    // The stream contained exactly two permission frames and then ended
    // cleanly (no reconnect on a clean end — see the bridge's `run()`
    // comment), so if the edit had been voted `lastRespondedPermission`
    // would now show `q-edit`, not `q-read`. It doesn't: escalation left it
    // pending for a human, matching the "NEVER send cancelled/deny, only
    // escalate" contract.
    expect(stub!.lastRespondedPermission?.requestId).toBe('q-read');
    expect(stub!.lastRespondedPermission?.requestId).not.toBe('q-edit');
  });

  it('review skill unavailable → 502 review_skill_unavailable, nothing registered', async () => {
    const { url, owner } = await setup({ supportedSkills: [] });

    const trigger = await post(url, owner, { target: { local: true } });
    expect(trigger.status).toBe(502);
    expect((await trigger.json()) as { code: string }).toMatchObject({
      code: 'review_skill_unavailable',
    });

    const list = await fetch(`${url}/rc/reviews`, {
      headers: { Authorization: `Bearer ${owner}` },
    });
    expect(list.status).toBe(200);
    expect((await list.json()) as { reviews: unknown[] }).toEqual({
      reviews: [],
    });

    // Best-effort session cleanup: the pre-flight guard ends the (skill-less)
    // session it created before registering anything.
    expect(stub!.lastEndedSessionId).toBe('stub-agent-1');
  });
});
