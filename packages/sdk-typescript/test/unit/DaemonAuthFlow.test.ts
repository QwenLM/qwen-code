/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { DaemonAuthFlow } from '../../src/daemon/DaemonAuthFlow.js';
import {
  DaemonHttpError,
  type DaemonClient,
} from '../../src/daemon/DaemonClient.js';
import type {
  DaemonDeviceFlowStartResult,
  DaemonDeviceFlowState,
} from '../../src/daemon/types.js';

// PR #4255 fold-in 10 #2: covers `DaemonAuthFlow`'s `start()` +
// `awaitCompletion()` state machine end-to-end. The class is the
// primary SDK entry point in PR 21's user-facing surface
// (`client.auth.start({providerId}).awaitCompletion()`); this file
// exercises the production paths the round-8 reviewer flagged as
// untested:
//   - happy path polling → `authorized`
//   - `slow_down` interval bumping + `onThrottled` callback
//   - `AbortSignal` propagation through both polling and the GET
//   - `timeoutMs` ceiling (incl. the round-9 #6 `0` honor)
//   - 404 → synthetic `error`/`not_found_or_evicted` (loop AND ceiling)
//   - `sanitizePositiveMs` edge cases (NaN / Infinity fallback)
//   - `cancel()` wrapper forwards to `client.cancelDeviceFlow`

interface FakeClientCalls {
  start: number;
  get: Array<{
    deviceFlowId: string;
    clientId?: string;
    signal?: AbortSignal;
  }>;
  cancel: Array<{ deviceFlowId: string; clientId?: string }>;
}

function makeFakeClient(opts: {
  startResult?: DaemonDeviceFlowStartResult;
  /** Sequenced replies for `getDeviceFlow`. The Nth call returns the
   *  Nth entry; if the list runs out, the LAST entry is repeated.
   *  Either a `DaemonDeviceFlowState` or a thrown error. */
  getReplies: Array<DaemonDeviceFlowState | Error>;
}): { client: DaemonClient; calls: FakeClientCalls } {
  const calls: FakeClientCalls = { start: 0, get: [], cancel: [] };
  const startResult: DaemonDeviceFlowStartResult = opts.startResult ?? {
    deviceFlowId: 'flow-A',
    providerId: 'qwen-oauth',
    status: 'pending',
    userCode: 'USER-1',
    verificationUri: 'https://idp.example/verify',
    expiresAt: Date.now() + 60_000,
    intervalMs: 50, // tests use small intervals so polling is fast
    attached: false,
  };
  const replies = [...opts.getReplies];
  const fake = {
    async startDeviceFlow(_opts: {
      providerId: string;
      clientId?: string;
    }): Promise<DaemonDeviceFlowStartResult> {
      calls.start += 1;
      return startResult;
    },
    async getDeviceFlow(
      deviceFlowId: string,
      callOpts: { clientId?: string; signal?: AbortSignal } = {},
    ): Promise<DaemonDeviceFlowState> {
      calls.get.push({
        deviceFlowId,
        ...(callOpts.clientId !== undefined
          ? { clientId: callOpts.clientId }
          : {}),
        ...(callOpts.signal !== undefined ? { signal: callOpts.signal } : {}),
      });
      const reply = replies.length > 1 ? replies.shift()! : replies[0];
      if (reply instanceof Error) throw reply;
      return reply;
    },
    async cancelDeviceFlow(
      deviceFlowId: string,
      callOpts: { clientId?: string } = {},
    ): Promise<void> {
      calls.cancel.push({
        deviceFlowId,
        ...(callOpts.clientId !== undefined
          ? { clientId: callOpts.clientId }
          : {}),
      });
    },
  };
  return { client: fake as unknown as DaemonClient, calls };
}

describe('DaemonAuthFlow.start (fold-in 10 #2)', () => {
  it('returns a handle pinned to the daemon-supplied start result', async () => {
    const { client } = makeFakeClient({
      getReplies: [
        // Will only be called if awaitCompletion runs; this test only
        // exercises start, so reply shape is irrelevant.
        {
          deviceFlowId: 'flow-A',
          providerId: 'qwen-oauth',
          status: 'pending',
          createdAt: Date.now(),
        },
      ],
    });
    const auth = new DaemonAuthFlow(client);
    const handle = await auth.start({ providerId: 'qwen-oauth' });
    expect(handle.deviceFlowId).toBe('flow-A');
    expect(handle.providerId).toBe('qwen-oauth');
    expect(handle.userCode).toBe('USER-1');
    expect(handle.attached).toBe(false);
    expect(handle.intervalMs).toBe(50);
  });
});

describe('DaemonAuthFlow.awaitCompletion (fold-in 10 #2)', () => {
  it('polls until the daemon reports a terminal state (authorized)', async () => {
    const expiresAt = Date.now() + 5_000;
    const { client, calls } = makeFakeClient({
      getReplies: [
        // First two GETs: still pending.
        {
          deviceFlowId: 'flow-A',
          providerId: 'qwen-oauth',
          status: 'pending',
          createdAt: Date.now(),
        },
        {
          deviceFlowId: 'flow-A',
          providerId: 'qwen-oauth',
          status: 'pending',
          createdAt: Date.now(),
        },
        // Third GET: terminal authorized.
        {
          deviceFlowId: 'flow-A',
          providerId: 'qwen-oauth',
          status: 'authorized',
          expiresAt,
          createdAt: Date.now(),
        },
      ],
    });
    const auth = new DaemonAuthFlow(client);
    const handle = await auth.start({ providerId: 'qwen-oauth' });
    const final = await handle.awaitCompletion({ pollOverrideMs: 1_000 });
    expect(final.status).toBe('authorized');
    expect(final.expiresAt).toBe(expiresAt);
    expect(calls.get.length).toBeGreaterThanOrEqual(3);
  });

  it('honors `slow_down`-driven intervalMs bumps via onThrottled callback', async () => {
    const observedIntervals: number[] = [];
    const { client } = makeFakeClient({
      getReplies: [
        // First GET: daemon reports a bumped interval (slow_down).
        {
          deviceFlowId: 'flow-A',
          providerId: 'qwen-oauth',
          status: 'pending',
          intervalMs: 10_000, // bumped from start's 50
          createdAt: Date.now(),
        },
        // Second GET: terminal so the loop exits.
        {
          deviceFlowId: 'flow-A',
          providerId: 'qwen-oauth',
          status: 'authorized',
          createdAt: Date.now(),
        },
      ],
    });
    const auth = new DaemonAuthFlow(client);
    const handle = await auth.start({ providerId: 'qwen-oauth' });
    await handle.awaitCompletion({
      onThrottled: (ms) => observedIntervals.push(ms),
      pollOverrideMs: 1_000,
    });
    expect(observedIntervals).toContain(10_000);
  });

  it('rejects when opts.signal is aborted mid-poll', async () => {
    // Replies stream forever as `pending` — caller's abort must be the
    // exit path.
    const { client } = makeFakeClient({
      getReplies: [
        {
          deviceFlowId: 'flow-A',
          providerId: 'qwen-oauth',
          status: 'pending',
          createdAt: Date.now(),
        },
      ],
    });
    const auth = new DaemonAuthFlow(client);
    const handle = await auth.start({ providerId: 'qwen-oauth' });
    const ctrl = new AbortController();
    const completion = handle.awaitCompletion({
      signal: ctrl.signal,
      pollOverrideMs: 1_000,
    });
    // Fire abort on the very next microtask so the loop's signal check
    // sees it before issuing another GET.
    queueMicrotask(() => ctrl.abort(new Error('test-cancel')));
    await expect(completion).rejects.toThrowError(/test-cancel/);
  });

  it('forwards opts.signal into client.getDeviceFlow on every GET (fold-in 7 #6)', async () => {
    const { client, calls } = makeFakeClient({
      getReplies: [
        {
          deviceFlowId: 'flow-A',
          providerId: 'qwen-oauth',
          status: 'authorized',
          createdAt: Date.now(),
        },
      ],
    });
    const auth = new DaemonAuthFlow(client);
    const handle = await auth.start({ providerId: 'qwen-oauth' });
    const ctrl = new AbortController();
    await handle.awaitCompletion({ signal: ctrl.signal });
    expect(calls.get.length).toBeGreaterThanOrEqual(1);
    expect(calls.get[0]?.signal).toBe(ctrl.signal);
  });

  it('returns the final GET snapshot at the timeoutMs ceiling', async () => {
    const { client, calls } = makeFakeClient({
      getReplies: [
        // Stays pending forever; timeoutMs ceiling is what exits.
        {
          deviceFlowId: 'flow-A',
          providerId: 'qwen-oauth',
          status: 'pending',
          createdAt: Date.now(),
        },
      ],
    });
    const auth = new DaemonAuthFlow(client);
    const handle = await auth.start({ providerId: 'qwen-oauth' });
    const final = await handle.awaitCompletion({
      timeoutMs: 60, // very short; ceiling fires after a few ticks
      pollOverrideMs: 1_000,
    });
    expect(final.status).toBe('pending');
    expect(calls.get.length).toBeGreaterThanOrEqual(1);
  });

  it('honors timeoutMs:0 — returns the daemon snapshot immediately (round-9 #6)', async () => {
    const { client, calls } = makeFakeClient({
      getReplies: [
        {
          deviceFlowId: 'flow-A',
          providerId: 'qwen-oauth',
          status: 'pending',
          createdAt: Date.now(),
        },
      ],
    });
    const auth = new DaemonAuthFlow(client);
    const handle = await auth.start({ providerId: 'qwen-oauth' });
    const final = await handle.awaitCompletion({ timeoutMs: 0 });
    expect(final.status).toBe('pending');
    // Exactly one GET — the immediate ceiling-read path.
    expect(calls.get.length).toBe(1);
  });

  it('falls back to default ceiling when timeoutMs is NaN (sanitizePositiveMs)', async () => {
    // NaN was the bug fold-in 7 #5 fixed: previously `?? default`
    // accepted NaN and produced `ceiling = NaN`, looping forever
    // (`now >= NaN` is always false). The sanitized form drops NaN
    // to undefined which falls back to `expiresAt + GRACE`.
    //
    // Test pins the contract by using a start result whose
    // `expiresAt` is FAR in the past — `expiresAt + GRACE` is then
    // also in the past, so the ceiling check on iteration 1 fires
    // immediately and the test bails fast. If sanitization broke
    // and NaN slipped through, the loop would never exit.
    const { client } = makeFakeClient({
      startResult: {
        deviceFlowId: 'flow-A',
        providerId: 'qwen-oauth',
        status: 'pending',
        userCode: 'USER-1',
        verificationUri: 'https://idp.example/verify',
        expiresAt: Date.now() - 60_000, // ceiling = -30s ago → bail
        intervalMs: 50,
        attached: false,
      },
      getReplies: [
        {
          deviceFlowId: 'flow-A',
          providerId: 'qwen-oauth',
          status: 'pending',
          createdAt: Date.now(),
        },
      ],
    });
    const auth = new DaemonAuthFlow(client);
    const handle = await auth.start({ providerId: 'qwen-oauth' });
    const final = await handle.awaitCompletion({ timeoutMs: NaN });
    expect(final.status).toBe('pending');
  });

  it('synthesizes error/not_found_or_evicted on a 404 from getDeviceFlow (fold-in 3 #4)', async () => {
    const { client } = makeFakeClient({
      getReplies: [new DaemonHttpError(404, null, 'not found')],
    });
    const auth = new DaemonAuthFlow(client);
    const handle = await auth.start({ providerId: 'qwen-oauth' });
    const final = await handle.awaitCompletion({ pollOverrideMs: 1_000 });
    expect(final.status).toBe('error');
    expect(final.errorKind).toBe('not_found_or_evicted');
    expect(final.providerId).toBe('qwen-oauth');
  });

  it('routes the timeoutMs:0 ceiling read through the same 404 helper (fold-in 7 #4)', async () => {
    // Pre-fold-in-7 #4, the ceiling read called getDeviceFlow
    // directly and a 404 there would reject `awaitCompletion` with
    // `DaemonHttpError(404)` instead of returning the structured
    // synthetic state. With timeoutMs:0 the FIRST read is the
    // ceiling read — verify the 404 still synthesizes.
    const { client } = makeFakeClient({
      getReplies: [new DaemonHttpError(404, null, 'evicted')],
    });
    const auth = new DaemonAuthFlow(client);
    const handle = await auth.start({ providerId: 'qwen-oauth' });
    const final = await handle.awaitCompletion({ timeoutMs: 0 });
    expect(final.status).toBe('error');
    expect(final.errorKind).toBe('not_found_or_evicted');
  });

  it('rethrows non-404 DaemonHttpErrors so the SDK consumer sees the daemon-side failure', async () => {
    const { client } = makeFakeClient({
      getReplies: [new DaemonHttpError(500, null, 'daemon exploded')],
    });
    const auth = new DaemonAuthFlow(client);
    const handle = await auth.start({ providerId: 'qwen-oauth' });
    await expect(
      handle.awaitCompletion({ pollOverrideMs: 1_000 }),
    ).rejects.toBeInstanceOf(DaemonHttpError);
  });
});

describe('DaemonAuthFlow.cancel (fold-in 10 #2)', () => {
  it('forwards to client.cancelDeviceFlow with the captured deviceFlowId + clientId', async () => {
    const { client, calls } = makeFakeClient({
      getReplies: [
        {
          deviceFlowId: 'flow-A',
          providerId: 'qwen-oauth',
          status: 'pending',
          createdAt: Date.now(),
        },
      ],
    });
    const auth = new DaemonAuthFlow(client);
    const handle = await auth.start({
      providerId: 'qwen-oauth',
      clientId: 'sdk-client-X',
    });
    await handle.cancel();
    expect(calls.cancel).toEqual([
      { deviceFlowId: 'flow-A', clientId: 'sdk-client-X' },
    ]);
  });

  it('top-level cancel(deviceFlowId) wrapper also forwards to the client', async () => {
    const { client, calls } = makeFakeClient({
      getReplies: [
        {
          deviceFlowId: 'flow-A',
          providerId: 'qwen-oauth',
          status: 'pending',
          createdAt: Date.now(),
        },
      ],
    });
    const auth = new DaemonAuthFlow(client);
    await auth.cancel('flow-Z', { clientId: 'admin-1' });
    expect(calls.cancel).toEqual([
      { deviceFlowId: 'flow-Z', clientId: 'admin-1' },
    ]);
  });

  it('top-level status(deviceFlowId) wrapper forwards to client.getDeviceFlow', async () => {
    const { client, calls } = makeFakeClient({
      getReplies: [
        {
          deviceFlowId: 'flow-Q',
          providerId: 'qwen-oauth',
          status: 'authorized',
          createdAt: Date.now(),
        },
      ],
    });
    const auth = new DaemonAuthFlow(client);
    const result = await auth.status('flow-Q', { clientId: 'admin-1' });
    expect(result.status).toBe('authorized');
    expect(calls.get).toEqual([
      { deviceFlowId: 'flow-Q', clientId: 'admin-1' },
    ]);
  });
});
