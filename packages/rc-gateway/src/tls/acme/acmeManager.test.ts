/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AcmeManager,
  type AcmeClient,
  type CertBundleStore,
} from './acmeManager.js';
import type { CertBundle } from './certStore.js';
import type { DnsProvider } from './dnsProvider.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-01-01T00:00:00Z').getTime();
const SIX_H = 6 * 60 * 60 * 1000;

const provider: DnsProvider = {
  name: 'fake',
  async present(r) {
    return { ...r };
  },
  async cleanup() {},
};

function fakeStore(initial: CertBundle | null = null) {
  let saved = initial;
  const saves: CertBundle[] = [];
  const store: CertBundleStore & { saves: CertBundle[] } = {
    saves,
    async load() {
      return saved;
    },
    async save(_d, b) {
      saved = b;
      saves.push(b);
    },
  };
  return store;
}

function fakeClient(notAfter: Date) {
  const calls = { n: 0 };
  const client: AcmeClient = {
    async obtainCertificate() {
      calls.n += 1;
      return {
        cert: `cert${calls.n}`,
        chain: 'chain',
        privateKey: 'key',
        notAfter,
      };
    },
  };
  return { client, calls };
}

const throwingClient: AcmeClient = {
  async obtainCertificate() {
    throw new Error('dns token invalid');
  },
};

function fakeTimers() {
  const armed: Array<{ fn: () => void; ms: number }> = [];
  return {
    armed,
    setTimer: (fn: () => void, ms: number) => {
      armed.push({ fn, ms });
      return armed.length - 1;
    },
    clearTimer: () => {},
    async fireLast() {
      await (armed[armed.length - 1].fn() as unknown as Promise<void>);
    },
  };
}

function storedBundle(notAfterMs: number): CertBundle {
  return {
    cert: 'old',
    chain: 'c',
    privateKey: 'k',
    meta: {
      domains: ['qwen.example.com'],
      notAfter: new Date(notAfterMs).toISOString(),
      issuedAt: new Date(NOW).toISOString(),
    },
  };
}

const base = {
  domains: ['qwen.example.com'],
  email: 'me@example.com',
  directoryUrl: 'https://acme-staging.example/dir',
  provider,
  accountKey: async () => 'account-key-pem',
};

describe('AcmeManager', () => {
  it('obtains and persists when nothing is stored', async () => {
    const store = fakeStore(null);
    const { client, calls } = fakeClient(new Date(NOW + 90 * DAY));
    const t = fakeTimers();
    const mgr = new AcmeManager({
      ...base,
      client,
      store,
      now: () => NOW,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    const bundle = await mgr.start();
    expect(calls.n).toBe(1);
    expect(bundle.cert).toBe('cert1');
    expect(store.saves).toHaveLength(1);
  });

  it('caps the renewal timer (60-day cert → ≤ maxTimerMs, NOT a 32-bit-overflowing delay)', async () => {
    // The bug this guards: setTimeout(60 days) clamps to ~1ms and re-issues on
    // every boot. A fresh cert must arm a CAPPED sleep, not the raw 60-day value.
    const store = fakeStore(storedBundle(NOW + 90 * DAY));
    const { client, calls } = fakeClient(new Date(NOW + 90 * DAY));
    const t = fakeTimers();
    const mgr = new AcmeManager({
      ...base,
      client,
      store,
      maxTimerMs: SIX_H,
      now: () => NOW,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    await mgr.start();

    expect(calls.n).toBe(0); // fresh stored cert → did NOT re-issue
    expect(t.armed).toHaveLength(1);
    expect(t.armed[0].ms).toBe(SIX_H); // capped, not 60*DAY
    expect(t.armed[0].ms).toBeLessThan(2_147_483_647); // under setTimeout's limit
  });

  it('renews a stored cert that is already within the renewal window at start', async () => {
    const store = fakeStore(storedBundle(NOW + 10 * DAY)); // 10 < 30 → due
    const { client, calls } = fakeClient(new Date(NOW + 90 * DAY));
    const t = fakeTimers();
    const mgr = new AcmeManager({
      ...base,
      client,
      store,
      now: () => NOW,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    await mgr.start();
    expect(calls.n).toBe(1);
  });

  it('renews on wake once the cert enters the window, firing onChange', async () => {
    let clock = NOW;
    const store = fakeStore(storedBundle(NOW + 90 * DAY));
    const { client, calls } = fakeClient(new Date(clock + 90 * DAY));
    const t = fakeTimers();
    const changed: CertBundle[] = [];
    const mgr = new AcmeManager({
      ...base,
      client,
      store,
      maxTimerMs: SIX_H,
      now: () => clock,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
      onChange: (b) => changed.push(b),
    });
    await mgr.start();
    expect(calls.n).toBe(0);

    clock = NOW + 65 * DAY; // now within 30 days of the 90-day expiry
    await t.fireLast();

    expect(calls.n).toBe(1);
    expect(changed).toHaveLength(1);
    expect(mgr.getCurrent()?.cert).toBe('cert1');
  });

  it('keeps the current cert and re-arms (backoff) when a renewal fails — no throw', async () => {
    let clock = NOW;
    const store = fakeStore(storedBundle(NOW + 90 * DAY));
    const t = fakeTimers();
    const log = vi.fn();
    const mgr = new AcmeManager({
      ...base,
      client: throwingClient,
      store,
      maxTimerMs: SIX_H,
      baseBackoffMs: 5 * 60 * 1000,
      now: () => clock,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
      log,
    });
    await mgr.start(); // fresh stored cert → no obtain
    const before = mgr.getCurrent();

    clock = NOW + 65 * DAY; // due now
    await t.fireLast(); // onWake → obtain throws → keep + re-arm

    expect(mgr.getCurrent()).toBe(before); // unchanged, still serving
    expect(log).toHaveBeenCalled();
    expect(t.armed).toHaveLength(2); // re-armed
    expect(t.armed[1].ms).toBe(5 * 60 * 1000); // backoff delay, capped
  });

  it('throws at start when there is no cert AND the first obtain fails', async () => {
    const store = fakeStore(null);
    const t = fakeTimers();
    const mgr = new AcmeManager({
      ...base,
      client: throwingClient,
      store,
      now: () => NOW,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    await expect(mgr.start()).rejects.toThrow(/could not obtain/);
  });
});
