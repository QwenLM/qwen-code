/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApnsSender, type ApnsTransport } from './apnsSender.js';
import { ApnsStore } from './apnsStore.js';
import type { PushPayload } from '../webpush/payload.js';

const payload: PushPayload = {
  v: 1,
  kind: 'agent.completed',
  sessionId: 's1',
  summary: 'done',
  url: '/ui/?session=s1',
};

function fakeTransport(statuses: number[]): ApnsTransport & { calls: number } {
  let i = 0;
  return {
    calls: 0,
    async post() {
      this.calls++;
      const status = statuses[Math.min(i, statuses.length - 1)];
      i++;
      return { status };
    },
  };
}

describe('ApnsSender', () => {
  let dir: string;
  let store: ApnsStore;
  let audits: Array<{ action: string; detail?: unknown }>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rc-apnssend-'));
    store = await ApnsStore.open(join(dir, 'apns.json'), () => 1);
    audits = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function sub() {
    return store.register({
      tokenId: 't',
      deviceToken: 'dt',
      bundleId: 'dev.qwen.rc',
      shellVersion: '1',
    });
  }

  function make(transport: ApnsTransport) {
    return new ApnsSender({
      signer: { token: () => 'jwt' },
      transport,
      store,
      bundleId: 'dev.qwen.rc',
      host: 'api.sandbox.push.apple.com',
      audit: { record: async (e) => void audits.push(e) },
      wait: () => Promise.resolve(),
    });
  }

  it('200 → success + push_routed audit', async () => {
    const s = await sub();
    const t = fakeTransport([200]);
    const r = await make(t).send(s, payload);
    expect(r).toEqual({ ok: true });
    expect(audits.map((a) => a.action)).toContain('push_routed');
  });

  it('410 → removes the subscription + apns_subscription_removed audit, no retry', async () => {
    const s = await sub();
    const t = fakeTransport([410]);
    const r = await make(t).send(s, payload);
    expect(r).toEqual({ ok: false, removed: true });
    expect(store.get(s.id)).toBeUndefined();
    expect(audits.map((a) => a.action)).toContain('apns_subscription_removed');
    expect(t.calls).toBe(1); // no retry
  });

  it('400 BadDeviceToken → removes the subscription', async () => {
    const s = await sub();
    const r = await make(fakeTransport([400])).send(s, payload);
    expect(r).toEqual({ ok: false, removed: true });
    expect(store.get(s.id)).toBeUndefined();
  });

  it('429 then 200 → retries and succeeds', async () => {
    const s = await sub();
    const t = fakeTransport([429, 200]);
    const r = await make(t).send(s, payload);
    expect(r).toEqual({ ok: true });
    expect(t.calls).toBe(2);
  });

  it('persistent 5xx → retriesExhausted after maxAttempts (default 5)', async () => {
    const s = await sub();
    const t = fakeTransport([503]);
    const r = await make(t).send(s, payload);
    expect(r).toEqual({ ok: false, retriesExhausted: true });
    expect(t.calls).toBe(5);
    expect(store.get(s.id)).toBeDefined(); // a 5xx never removes the sub
  });

  it('other 4xx (e.g. 403) → rejected, no retry, no removal', async () => {
    const s = await sub();
    const t = fakeTransport([403]);
    const r = await make(t).send(s, payload);
    expect(r).toEqual({ ok: false, rejected: true });
    expect(t.calls).toBe(1);
    expect(store.get(s.id)).toBeDefined();
  });

  it('orphan safety: a dead token is removed without sending', async () => {
    const s = await sub();
    const t = fakeTransport([200]);
    const sender = new ApnsSender({
      signer: { token: () => 'jwt' },
      transport: t,
      store,
      bundleId: 'b',
      host: 'h',
      audit: { record: async (e) => void audits.push(e) },
      wait: () => Promise.resolve(),
      isTokenLive: () => false, // token was revoked
    });
    const r = await sender.send(s, payload);
    expect(r).toEqual({ ok: false, removed: true });
    expect(t.calls).toBe(0); // never hit Apple
    expect(store.get(s.id)).toBeUndefined();
  });
});
