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
): Promise<{
  url: string;
  tokens: { owner: string; write: string; read: string };
  registry: ReviewRegistry;
  bridge: ReturnType<typeof fakeBridge>;
  frames: OwnerEvent[];
}> {
  // Keep the review prompt in-flight past the accept window so the 202-accept
  // path is deterministic (never a race on an instant settle).
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

  it('read token → 403 scope_required (mount-level WRITE gate)', async () => {
    const { url, tokens, registry } = await setup();
    const res = await post(url, tokens.read, { target: { local: true } });
    expect(res.status).toBe(403);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: 'scope_required',
    });
    expect(registry.list()).toHaveLength(0);
  });

  it('write token + autofix → 403 owner_scope_required, nothing registered, bridge not opened', async () => {
    const { url, tokens, registry, bridge } = await setup();
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
  ])('malformed target %#: 400 invalid_target', async (target) => {
    const { url, tokens, registry } = await setup();
    const res = await post(url, tokens.owner, { target });
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: 'invalid_target',
    });
    expect(registry.list()).toHaveLength(0);
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
