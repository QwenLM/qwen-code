/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonClient } from '@qwen-code/sdk';
import { createGatewayApp } from '../server.js';
import { TokenStore } from '../tokenStore.js';
import { SHARE, SESSION_READ } from '../scopes.js';
import { PairingService } from '../pairing.js';
import { ReviewRegistry } from '../reviews/reviewRegistry.js';
import type { ReviewPermissionBridge } from '../reviews/reviewPermissionBridge.js';
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

/** A spyable stand-in for ReviewPermissionBridge (D.2 only needs open/close). */
function fakeBridge() {
  return {
    open: vi.fn(async () => {}),
    close: vi.fn(() => {}),
  };
}

async function setup(
  stubOpts: Parameters<typeof startStubDaemon>[0] = {},
  promptAcceptWindowMs = 25,
  costFor?: (sessionId: string) => number | undefined,
): Promise<{
  url: string;
  tokens: { owner: string; write: string; read: string };
  registry: ReviewRegistry;
  bridge: ReturnType<typeof fakeBridge>;
  frames: OwnerEvent[];
  store: TokenStore;
}> {
  // Keep the review prompt in-flight past the accept window so the 202-accept
  // path is deterministic (never a race on an instant settle) — this ALSO
  // keeps a triggered review 'running' well past cancel, so cancel-while-
  // running tests never race prompt-settle (see D.3 report).
  stub = await startStubDaemon({ promptDelayMs: 2000, ...stubOpts });
  const dir = await mkdtemp(join(tmpdir(), 'review-route-'));
  const store = await TokenStore.open(join(dir, 'tokens.json'));
  const owner = (await store.issue(['owner'], 'owner')).token;
  const write = (await store.issue(['write'], 'writer')).token;
  const read = (await store.issue(['session:read'], 'reader')).token;
  const registry = await ReviewRegistry.open(join(dir, 'reviews.json'));
  const bridge = fakeBridge();

  const gw = createGatewayApp({
    daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
    store,
    pairing: new PairingService(),
    auditPath: join(dir, 'audit.log'),
    review: {
      registry,
      bridge: bridge as unknown as ReviewPermissionBridge,
      promptAcceptWindowMs,
      ...(costFor ? { costFor } : {}),
    },
  });
  const frames: OwnerEvent[] = [];
  gw.ownerEvents.subscribe((e) => frames.push(e));

  server = await new Promise((resolve) => {
    const s = gw.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server!.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    tokens: { owner, write, read },
    registry,
    bridge,
    frames,
    store,
  };
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

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('POST /rc/reviews (trigger saga)', () => {
  it('owner triggers a local review → 202 + review_started frame + audit row + bridge opened', async () => {
    const { url, tokens, registry, bridge, frames } = await setup();
    const res = await post(url, tokens.owner, { target: { local: true } });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { reviewId: string; sessionId: string };
    expect(body.sessionId).toBe('stub-agent-1');
    expect(body.reviewId).toBeTruthy();

    // Registered as a running vote-leg review (no autoApprove).
    const rec = registry.get(body.reviewId);
    expect(rec?.status).toBe('running');
    expect(rec?.approvalLeg).toBe('vote');

    // Bridge opened BEFORE the prompt, confined to the session's workspaceCwd.
    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(bridge.open).toHaveBeenCalledWith('stub-agent-1', {
      autoApprove: false,
      autofix: false,
      comment: false,
      worktreeRoot: '/stub/workspace',
    });

    // Exactly one review_started frame on the owner stream.
    const started = frames.filter((f) => f.type === 'review_started');
    expect(started).toHaveLength(1);
    expect(
      (started[0] as Extract<OwnerEvent, { type: 'review_started' }>).review,
    ).toMatchObject({ reviewId: body.reviewId, sessionId: 'stub-agent-1' });

    // Audit review_started row (arrives as an `audit` owner frame) carries the
    // approvalLeg and NEVER prompt/diff content.
    await waitFor(() =>
      frames.some(
        (f) =>
          f.type === 'audit' &&
          (f as Extract<OwnerEvent, { type: 'audit' }>).record.action ===
            'review_started',
      ),
    );
    const auditFrame = frames.find(
      (f) =>
        f.type === 'audit' &&
        (f as Extract<OwnerEvent, { type: 'audit' }>).record.action ===
          'review_started',
    ) as Extract<OwnerEvent, { type: 'audit' }>;
    expect(auditFrame.record.detail).toMatchObject({ approvalLeg: 'vote' });
    expect(JSON.stringify(auditFrame.record)).not.toContain('/review');
  });

  it('owner triggers a path review → owner-stream frame and audit detail never carry the raw path', async () => {
    const { url, tokens, frames } = await setup();
    const res = await post(url, tokens.owner, {
      target: { path: '/secret/xyz' },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { reviewId: string };

    const started = frames.find((f) => f.type === 'review_started') as Extract<
      OwnerEvent,
      { type: 'review_started' }
    >;
    expect(started).toBeDefined();
    expect(started.review.target).not.toHaveProperty('path');
    expect(started.review.target.kind).toBe('path');
    expect(JSON.stringify(started)).not.toContain('/secret/xyz');

    await waitFor(() =>
      frames.some(
        (f) =>
          f.type === 'audit' &&
          (f as Extract<OwnerEvent, { type: 'audit' }>).record.action ===
            'review_started',
      ),
    );
    const auditFrame = frames.find(
      (f) =>
        f.type === 'audit' &&
        (f as Extract<OwnerEvent, { type: 'audit' }>).record.action ===
          'review_started' &&
        (f as Extract<OwnerEvent, { type: 'audit' }>).record.target ===
          body.reviewId,
    ) as Extract<OwnerEvent, { type: 'audit' }>;
    expect(auditFrame).toBeDefined();
    expect(JSON.stringify(auditFrame.record)).not.toContain('/secret/xyz');
    const detail = auditFrame.record.detail as {
      target?: { kind?: string; path?: string };
    };
    expect(detail.target).not.toHaveProperty('path');
    expect(detail.target?.kind).toBe('path');
  });

  it('read token → 403 scope_required (mount-level WRITE gate)', async () => {
    const { url, tokens, registry } = await setup();
    const res = await post(url, tokens.read, { target: { local: true } });
    expect(res.status).toBe(403);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: 'scope_required',
    });
    expect(registry.list()).toHaveLength(0);
  });

  it('write token + autofix → 403 owner_scope_required, nothing registered, bridge not opened, scope_denied audited', async () => {
    const { url, tokens, registry, bridge, frames } = await setup();
    const res = await post(url, tokens.write, {
      target: { local: true },
      autofix: true,
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: 'owner_scope_required',
    });
    expect(registry.list()).toHaveLength(0);
    expect(bridge.open).not.toHaveBeenCalled();

    // The owner-gate denial is audited as a scope_denied row (the mount-level
    // scope_denied never fires — a WRITE token passes requireScope(WRITE)).
    await waitFor(() =>
      frames.some(
        (f) =>
          f.type === 'audit' &&
          (f as Extract<OwnerEvent, { type: 'audit' }>).record.action ===
            'scope_denied',
      ),
    );
    const denied = frames.find(
      (f) =>
        f.type === 'audit' &&
        (f as Extract<OwnerEvent, { type: 'audit' }>).record.action ===
          'scope_denied',
    ) as Extract<OwnerEvent, { type: 'audit' }>;
    expect(denied.record.detail).toMatchObject({
      required: 'owner',
      reason: 'privileged_review_flags',
      autofix: true,
    });
  });

  it('write token + comment → 403 owner_scope_required', async () => {
    const { url, tokens } = await setup();
    const res = await post(url, tokens.write, {
      target: { local: true },
      comment: true,
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: 'owner_scope_required',
    });
  });

  it('write token + autoApprove → 403 owner_scope_required', async () => {
    const { url, tokens } = await setup();
    const res = await post(url, tokens.write, {
      target: { local: true },
      autoApprove: true,
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: 'owner_scope_required',
    });
  });

  it('owner + autoApprove → 202 (auto leg) and bridge opened with autoApprove:true', async () => {
    const { url, tokens, registry, bridge } = await setup();
    const res = await post(url, tokens.owner, {
      target: { local: true },
      autoApprove: true,
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { reviewId: string };
    expect(registry.get(body.reviewId)?.approvalLeg).toBe('auto');
    expect(bridge.open).toHaveBeenCalledWith('stub-agent-1', {
      autoApprove: true,
      autofix: false,
      comment: false,
      worktreeRoot: '/stub/workspace',
    });
  });

  it('review skill unavailable → 502 review_skill_unavailable, nothing registered, session ended, bridge not opened', async () => {
    const { url, tokens, registry, bridge } = await setup({
      supportedSkills: [],
    });
    const res = await post(url, tokens.owner, { target: { local: true } });
    expect(res.status).toBe(502);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: 'review_skill_unavailable',
    });
    expect(registry.list()).toHaveLength(0);
    expect(bridge.open).not.toHaveBeenCalled();
    expect(stub!.lastEndedSessionId).toBe('stub-agent-1');
  });

  it('target {pr:42} maps to the /review 42 command', async () => {
    const { url, tokens } = await setup();
    // autofix:true (owner) isolates the pr→command mapping with no suffix.
    const res = await post(url, tokens.owner, {
      target: { pr: 42 },
      autofix: true,
    });
    expect(res.status).toBe(202);
    await waitFor(() => stub!.lastPromptBody !== undefined);
    const promptText = (
      stub!.lastPromptBody as { prompt: Array<{ text: string }> }
    ).prompt[0].text;
    expect(promptText).toBe('/review 42');
  });

  it('target {pr:42} report-only → command starts with /review 42', async () => {
    const { url, tokens } = await setup();
    const res = await post(url, tokens.owner, { target: { pr: 42 } });
    expect(res.status).toBe(202);
    await waitFor(() => stub!.lastPromptBody !== undefined);
    const promptText = (
      stub!.lastPromptBody as { prompt: Array<{ text: string }> }
    ).prompt[0].text;
    expect(promptText.startsWith('/review 42')).toBe(true);
    expect(promptText).toContain('Report only');
  });

  it('autofix:false local → prompt carries the report-only suffix', async () => {
    const { url, tokens } = await setup();
    const res = await post(url, tokens.owner, { target: { local: true } });
    expect(res.status).toBe(202);
    await waitFor(() => stub!.lastPromptBody !== undefined);
    const promptText = (
      stub!.lastPromptBody as { prompt: Array<{ text: string }> }
    ).prompt[0].text;
    expect(promptText).toContain('Report only');
    expect(promptText.startsWith('/review')).toBe(true);
  });

  it('owner + autofix:true → prompt has NO report-only suffix', async () => {
    const { url, tokens } = await setup();
    const res = await post(url, tokens.owner, {
      target: { local: true },
      autofix: true,
    });
    expect(res.status).toBe(202);
    await waitFor(() => stub!.lastPromptBody !== undefined);
    const promptText = (
      stub!.lastPromptBody as { prompt: Array<{ text: string }> }
    ).prompt[0].text;
    expect(promptText).not.toContain('Report only');
  });

  it('comment (owner) → prompt has --comment flag', async () => {
    const { url, tokens } = await setup();
    const res = await post(url, tokens.owner, {
      target: { pr: 7 },
      comment: true,
    });
    expect(res.status).toBe(202);
    await waitFor(() => stub!.lastPromptBody !== undefined);
    const promptText = (
      stub!.lastPromptBody as { prompt: Array<{ text: string }> }
    ).prompt[0].text;
    expect(promptText).toContain('/review 7 --comment');
  });

  it.each([
    [{ pr: -1 }, 'negative pr'],
    [{ pr: 0 }, 'zero pr'],
    [{ pr: 1.5 }, 'non-integer pr'],
    [{ pr: 'x' }, 'non-number pr'],
    [{ path: '' }, 'empty path'],
    [{ path: 42 }, 'non-string path'],
    [{ bogus: true }, 'unknown shape'],
    // SECURITY: a flag-shaped or multi-token path smuggles an owner-gated flag
    // (or arbitrary prompt text) past the owner-scope gate on a WRITE token.
    [{ path: '--comment' }, 'flag-shaped path'],
    [{ path: '42 --comment' }, 'multi-token path'],
    [{ path: 'src/a.ts\n--comment' }, 'newline-injected path'],
    [{ path: '-x' }, 'dash-prefixed path'],
  ])('malformed target %#: 400 invalid_target', async (target) => {
    const { url, tokens, registry } = await setup();
    const res = await post(url, tokens.owner, { target });
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: 'invalid_target',
    });
    expect(registry.list()).toHaveLength(0);
  });

  it('the flag-shaped path bypass is blocked even for a WRITE token (403/400, no comment review)', async () => {
    // The bypass targeted a WRITE token running NO flags but a path of
    // `--comment`. Sanitization rejects it at parse (400) BEFORE the prompt is
    // ever built, so no `/review --comment` reaches the daemon.
    const { url, tokens, registry } = await setup();
    const res = await post(url, tokens.write, {
      target: { path: '--comment' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: 'invalid_target',
    });
    expect(registry.list()).toHaveLength(0);
    expect(stub!.lastPromptBody).toBeUndefined();
  });

  it('a normal in-tree path → 202 with prompt starting /review <path> (discrimination)', async () => {
    const { url, tokens } = await setup();
    const res = await post(url, tokens.owner, {
      target: { path: 'src/foo.ts' },
    });
    expect(res.status).toBe(202);
    await waitFor(() => stub!.lastPromptBody !== undefined);
    const promptText = (
      stub!.lastPromptBody as { prompt: Array<{ text: string }> }
    ).prompt[0].text;
    expect(promptText.startsWith('/review src/foo.ts')).toBe(true);
  });

  it('registry.register throws → 502 review_start_failed: bridge closed, session ended, no hang', async () => {
    // A leg-6 file-persist rejection must NOT leak a live session + open bridge
    // or hang the client. The rollback guard catches it, closes the bridge, and
    // ends the session.
    const { url, tokens, bridge, registry } = await setup();
    // Force register to reject (simulate a disk/persist failure).
    vi.spyOn(registry, 'register').mockRejectedValueOnce(
      new Error('persist failed'),
    );
    const res = await post(url, tokens.owner, { target: { local: true } });
    expect(res.status).toBe(502);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: 'review_start_failed',
    });
    // Bridge was opened (leg 5) then closed by the rollback guard; session ended.
    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(bridge.close).toHaveBeenCalledWith('stub-agent-1');
    expect(stub!.lastEndedSessionId).toBe('stub-agent-1');
  });

  it('prompt send failure → 502 prompt_send_failed: bridge closed, session ended, review failed', async () => {
    // Inverse of the accept-path config: a LARGE accept window (1000ms) + an
    // IMMEDIATE prompt rejection (promptStatus 500, no delay) makes
    // 'send_failed' win the race deterministically — the ~ms rejection beats
    // the window, never a race. This is the ONLY leg that diverges from the
    // agents mirror (it must bridge.close before ending the session).
    const { url, tokens, registry, bridge } = await setup(
      { promptStatus: 500, promptDelayMs: 0 },
      1000,
    );
    const res = await post(url, tokens.owner, { target: { local: true } });
    expect(res.status).toBe(502);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: 'prompt_send_failed',
    });
    // Bridge was opened (leg 5) then CLOSED on rollback (the review-specific leg).
    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(bridge.close).toHaveBeenCalledWith('stub-agent-1');
    // Session ended, record marked failed.
    expect(stub!.lastEndedSessionId).toBe('stub-agent-1');
    const failed = registry.list().find((r) => r.sessionId === 'stub-agent-1');
    expect(failed?.status).toBe('failed');
  });

  it('missing target defaults to a local review → 202', async () => {
    const { url, tokens, registry } = await setup();
    const res = await post(url, tokens.owner, {});
    expect(res.status).toBe(202);
    const body = (await res.json()) as { reviewId: string };
    expect(registry.get(body.reviewId)?.target).toEqual({ kind: 'local' });
  });
});

describe('GET /rc/reviews, GET /rc/reviews/:id (list/detail)', () => {
  it('list returns registered reviews with cost rollup; read token can list', async () => {
    const { url, tokens } = await setup({}, 25, (sid) =>
      sid.startsWith('stub-agent') ? 4242 : undefined,
    );
    const trigger = await post(url, tokens.owner, { target: { local: true } });
    expect(trigger.status).toBe(202);
    const { reviewId } = (await trigger.json()) as { reviewId: string };

    const list = await fetch(`${url}/rc/reviews`, {
      headers: { Authorization: `Bearer ${tokens.read}` },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      reviews: Array<{ reviewId: string; costMicrocents?: number }>;
    };
    expect(listBody.reviews).toHaveLength(1);
    expect(listBody.reviews[0].reviewId).toBe(reviewId);
    expect(listBody.reviews[0].costMicrocents).toBe(4242);
  });

  it('read token can fetch detail; unknown id → 404 review_not_found', async () => {
    const { url, tokens } = await setup({}, 25, () => 4242);
    const trigger = await post(url, tokens.owner, { target: { local: true } });
    const { reviewId } = (await trigger.json()) as { reviewId: string };

    const detail = await fetch(`${url}/rc/reviews/${reviewId}`, {
      headers: { Authorization: `Bearer ${tokens.read}` },
    });
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      reviewId: string;
      costMicrocents?: number;
    };
    expect(detailBody.reviewId).toBe(reviewId);
    expect(detailBody.costMicrocents).toBe(4242);

    const missing = await fetch(`${url}/rc/reviews/does-not-exist`, {
      headers: { Authorization: `Bearer ${tokens.read}` },
    });
    expect(missing.status).toBe(404);
    expect((await missing.json()) as { code: string }).toMatchObject({
      code: 'review_not_found',
    });
  });

  it('session-locked share token: list confined to its own session; other sessions (incl. review record) never leak', async () => {
    const { url, registry, store, tokens } = await setup();
    const own = await registry.register({
      sessionId: 'S1',
      target: { kind: 'local' },
      comment: false,
      autofix: false,
      approvalLeg: 'vote',
      triggeredByTokenId: 'owner',
    });
    await registry.register({
      sessionId: 'S2',
      target: { kind: 'path', path: 'SECRET-OTHER-SESSION' },
      comment: false,
      autofix: false,
      approvalLeg: 'vote',
      triggeredByTokenId: 'owner',
    });

    const share = await store.issueShare({
      scopes: [SHARE, SESSION_READ],
      label: 'share',
      sessionLockId: 'S1',
      ttlSec: 300,
      parentId: 'owner',
    });

    const res = await fetch(`${url}/rc/reviews`, {
      headers: { Authorization: `Bearer ${share.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      reviews: Array<{ reviewId: string }>;
    };
    expect(body.reviews.map((r) => r.reviewId)).toEqual([own.reviewId]);
    expect(JSON.stringify(body)).not.toContain('SECRET-OTHER-SESSION');

    // Non-locked owner token still sees the full list.
    const ownerRes = await fetch(`${url}/rc/reviews`, {
      headers: { Authorization: `Bearer ${tokens.owner}` },
    });
    const ownerBody = (await ownerRes.json()) as {
      reviews: Array<{ reviewId: string }>;
    };
    expect(ownerBody.reviews).toHaveLength(2);
  });

  it('list with an invalid status filter → 400 invalid_status', async () => {
    const { url, tokens } = await setup();
    const res = await fetch(`${url}/rc/reviews?status=bogus`, {
      headers: { Authorization: `Bearer ${tokens.read}` },
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: 'invalid_status',
    });
  });

  it("session-locked share token: detail on another session's review → 404 (never the other session's path); own session's review → 200", async () => {
    const { url, registry, store } = await setup();
    const own = await registry.register({
      sessionId: 'S1',
      target: { kind: 'local' },
      comment: false,
      autofix: false,
      approvalLeg: 'vote',
      triggeredByTokenId: 'owner',
    });
    const other = await registry.register({
      sessionId: 'S2',
      target: { kind: 'path', path: 'SECRET-OTHER-SESSION' },
      comment: false,
      autofix: false,
      approvalLeg: 'vote',
      triggeredByTokenId: 'owner',
    });

    const share = await store.issueShare({
      scopes: [SHARE, SESSION_READ],
      label: 'share',
      sessionLockId: 'S1',
      ttlSec: 300,
      parentId: 'owner',
    });

    // Another session's review, by id, must 404 — same shape as unknown id —
    // and must NEVER leak its (raw filesystem) path in the response body.
    const otherRes = await fetch(`${url}/rc/reviews/${other.reviewId}`, {
      headers: { Authorization: `Bearer ${share.token}` },
    });
    expect(otherRes.status).toBe(404);
    const otherBody = (await otherRes.json()) as { code: string };
    expect(otherBody.code).toBe('review_not_found');
    expect(JSON.stringify(otherBody)).not.toContain('SECRET-OTHER-SESSION');

    // Own session's review → 200.
    const ownRes = await fetch(`${url}/rc/reviews/${own.reviewId}`, {
      headers: { Authorization: `Bearer ${share.token}` },
    });
    expect(ownRes.status).toBe(200);
    expect(((await ownRes.json()) as { reviewId: string }).reviewId).toBe(
      own.reviewId,
    );
  });

  it("non-locked owner token: detail on any session's review → 200 (unaffected)", async () => {
    const { url, registry, tokens } = await setup();
    const other = await registry.register({
      sessionId: 'S2',
      target: { kind: 'path', path: '/some/path' },
      comment: false,
      autofix: false,
      approvalLeg: 'vote',
      triggeredByTokenId: 'owner',
    });
    const res = await fetch(`${url}/rc/reviews/${other.reviewId}`, {
      headers: { Authorization: `Bearer ${tokens.owner}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reviewId: string }).reviewId).toBe(
      other.reviewId,
    );
  });
});

describe('POST /rc/reviews/:id/cancel', () => {
  it('cancels a running review: 200 + review_cancelled owner frame + session ended + registry cancelled', async () => {
    // Default setup() keeps promptDelayMs at 2000ms, so the triggered review
    // is still 'running' when cancel is called — deterministic, no race
    // against prompt-settle (see D.3 report for why this avoids the flake
    // shape noted in agents.integration.test.ts).
    const { url, tokens, registry, frames } = await setup();
    const trigger = await post(url, tokens.owner, { target: { local: true } });
    expect(trigger.status).toBe(202);
    const { reviewId, sessionId } = (await trigger.json()) as {
      reviewId: string;
      sessionId: string;
    };
    expect(registry.get(reviewId)?.status).toBe('running');

    const cancel = await fetch(`${url}/rc/reviews/${reviewId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.owner}` },
    });
    expect(cancel.status).toBe(200);
    expect(
      (await cancel.json()) as { reviewId: string; status: string },
    ).toEqual({ reviewId, status: 'cancelled' });

    expect(stub!.lastEndedSessionId).toBe(sessionId);
    expect(registry.get(reviewId)?.status).toBe('cancelled');

    const cancelled = frames.find((f) => f.type === 'review_cancelled');
    expect(cancelled).toBeDefined();
    expect(
      (cancelled as Extract<OwnerEvent, { type: 'review_cancelled' }>).review,
    ).toMatchObject({ reviewId, sessionId, status: 'cancelled' });

    await waitFor(() =>
      frames.some(
        (f) =>
          f.type === 'audit' &&
          (f as Extract<OwnerEvent, { type: 'audit' }>).record.action ===
            'review_cancelled',
      ),
    );
    const auditFrame = frames.find(
      (f) =>
        f.type === 'audit' &&
        (f as Extract<OwnerEvent, { type: 'audit' }>).record.action ===
          'review_cancelled',
    ) as Extract<OwnerEvent, { type: 'audit' }>;
    expect(auditFrame.record.detail).toMatchObject({ sessionId });
  });

  it('cancel on an already-terminal review → 409 review_not_running', async () => {
    const { url, tokens, registry } = await setup();
    const trigger = await post(url, tokens.owner, { target: { local: true } });
    const { reviewId } = (await trigger.json()) as { reviewId: string };

    const first = await fetch(`${url}/rc/reviews/${reviewId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.owner}` },
    });
    expect(first.status).toBe(200);
    expect(registry.get(reviewId)?.status).toBe('cancelled');

    const second = await fetch(`${url}/rc/reviews/${reviewId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.owner}` },
    });
    expect(second.status).toBe(409);
    expect((await second.json()) as { code: string }).toMatchObject({
      code: 'review_not_running',
    });
  });

  it('cancel on an unknown review id → 404 review_not_found', async () => {
    const { url, tokens } = await setup();
    const res = await fetch(`${url}/rc/reviews/does-not-exist/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.owner}` },
    });
    expect(res.status).toBe(404);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: 'review_not_found',
    });
  });
});
