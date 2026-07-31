/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  brandSecret,
  unsafeRevealSecret,
  DEVICE_FLOW_DEFAULT_INTERVAL_MS,
  DEVICE_FLOW_MAX_CONCURRENT,
  DEVICE_FLOW_MAX_EXPIRES_IN_SEC,
  DEVICE_FLOW_MAX_INTERVAL_MS,
  DEVICE_FLOW_PERSIST_TIMEOUT_MS,
  DEVICE_FLOW_POLL_TIMEOUT_MS,
  DEVICE_FLOW_SLOW_DOWN_BUMP_MS,
  DEVICE_FLOW_START_TIMEOUT_MS,
  DeviceFlowPollTimeoutError,
  DEVICE_FLOW_TERMINAL_GRACE_MS,
  DeviceFlowRegistry,
  TooManyActiveDeviceFlowsError,
  UnsupportedDeviceFlowProviderError,
  type DeviceFlowEventEmission,
  type DeviceFlowEventSink,
  type DeviceFlowPollResult,
  type DeviceFlowProvider,
  type DeviceFlowProviderId,
} from './device-flow.js';

interface FakeClock {
  now: number;
  tick(ms: number): void;
}

interface ScheduledCallback {
  fireAt: number;
  cb: () => void;
  cancelled: boolean;
}

interface FakeScheduler {
  callbacks: ScheduledCallback[];
  intervals: Array<{ ms: number; cb: () => void; cancelled: boolean }>;
  flushDue(now: number): void;
}

function makeClockAndScheduler(): {
  clock: FakeClock;
  scheduler: FakeScheduler;
  schedule: (ms: number, cb: () => void) => unknown;
  scheduleInterval: (ms: number, cb: () => void) => unknown;
  clearScheduled: (handle: unknown) => void;
  clearScheduledInterval: (handle: unknown) => void;
  now: () => number;
} {
  const clock: FakeClock = {
    now: 1_700_000_000_000,
    tick(ms) {
      clock.now += ms;
    },
  };
  const callbacks: ScheduledCallback[] = [];
  const intervals: Array<{ ms: number; cb: () => void; cancelled: boolean }> =
    [];
  return {
    clock,
    scheduler: {
      callbacks,
      intervals,
      flushDue(now) {
        for (const c of callbacks) {
          if (!c.cancelled && c.fireAt <= now) {
            c.cancelled = true;
            c.cb();
          }
        }
      },
    },
    now: () => clock.now,
    schedule: (ms, cb) => {
      const entry: ScheduledCallback = {
        fireAt: clock.now + ms,
        cb,
        cancelled: false,
      };
      callbacks.push(entry);
      return entry;
    },
    scheduleInterval: (ms, cb) => {
      const entry = { ms, cb, cancelled: false };
      intervals.push(entry);
      return entry;
    },
    clearScheduled: (h) => {
      (h as ScheduledCallback).cancelled = true;
    },
    clearScheduledInterval: (h) => {
      (h as { cancelled: boolean }).cancelled = true;
    },
  };
}

class FakeProvider implements DeviceFlowProvider {
  readonly providerId: DeviceFlowProviderId = 'qwen-oauth';
  startCount = 0;
  pollCount = 0;
  pollScript: DeviceFlowPollResult[] = [];
  persistCalls = 0;
  startError: Error | undefined;
  expiresIn = 600; // 10 minutes
  interval: number | undefined = undefined;
  /** Test hook: when `true`, `start()` returns a Promise that NEVER
   *  resolves and ignores the supplied `signal`. Models a misbehaving
   *  / future provider whose underlying I/O isn't abortable —
   *  registry's authoritative timeout (Promise.race) is the only
   *  thing that can rescue the await. PR #4255 fold-in 7 #1. */
  startHangs = false;
  /** Test hook: when set, `poll()` throws this Error on the next call.
   *  Models a non-conforming provider that violates the
   *  `DeviceFlowProvider.poll()` `@remarks` sanitization contract by
   *  throwing raw IdP detail. PR #4255 fold-in 8 #1. */
  pollThrowsWith: Error | undefined;
  /** Test hook: when `true`, `poll()` returns a Promise that NEVER
   *  resolves and ignores the supplied `signal`. Models a misbehaving
   *  provider whose underlying I/O isn't abortable — registry's
   *  authoritative `Promise.race` against `DEVICE_FLOW_POLL_TIMEOUT_MS`
   *  is the only thing that can rescue the await. PR #4255 follow-up
   *  review thread (deepseek-v4-pro). */
  pollHangs = false;
  /** Most recent `opts.signal` observed by `poll`. Test hook for the
   *  abort-mid-poll assertion: after `registry.cancel(...)`, this
   *  signal MUST report `.aborted === true` so the upstream HTTP
   *  socket can be torn down. */
  lastPollSignal: AbortSignal | undefined;

  async start(): Promise<{
    deviceCode: ReturnType<typeof brandSecret>;
    pkceVerifier: ReturnType<typeof brandSecret>;
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
    expiresIn: number;
    interval?: number;
  }> {
    this.startCount += 1;
    if (this.startError) throw this.startError;
    if (this.startHangs) {
      // Never resolves and intentionally ignores `signal` — models a
      // non-cooperative provider. Registry's Promise.race timeout is
      // what must rescue this `await`.
      await new Promise<never>(() => {});
      throw new Error('unreachable');
    }
    return {
      deviceCode: brandSecret(`device-${this.startCount}`),
      pkceVerifier: brandSecret(`pkce-${this.startCount}`),
      userCode: `USER-${this.startCount}`,
      verificationUri: 'https://idp.example/verify',
      verificationUriComplete: 'https://idp.example/verify?user=AB12',
      expiresIn: this.expiresIn,
      ...(this.interval !== undefined ? { interval: this.interval } : {}),
    };
  }

  async poll(
    _state: unknown,
    opts: { signal: AbortSignal },
  ): Promise<DeviceFlowPollResult> {
    this.pollCount += 1;
    this.lastPollSignal = opts.signal;
    if (this.pollThrowsWith !== undefined) {
      const err = this.pollThrowsWith;
      this.pollThrowsWith = undefined;
      throw err;
    }
    if (this.pollHangs) {
      // Never resolves, ignores `signal`. Registry's Promise.race
      // timeout is the only path out.
      await new Promise<never>(() => {});
      throw new Error('unreachable');
    }
    if (opts.signal.aborted) return { kind: 'pending' };
    if (this.pollScript.length === 0) {
      return { kind: 'pending' };
    }
    const next = this.pollScript.shift()!;
    if (next.kind === 'success') {
      const inner = next;
      return {
        kind: 'success',
        persist: async (persistOpts: { signal: AbortSignal }) => {
          this.persistCalls += 1;
          return inner.persist(persistOpts);
        },
      };
    }
    return next;
  }
}

function makeEventSink(): {
  sink: DeviceFlowEventSink;
  emissions: Array<{ emission: DeviceFlowEventEmission; clientId?: string }>;
} {
  const emissions: Array<{
    emission: DeviceFlowEventEmission;
    clientId?: string;
  }> = [];
  return {
    emissions,
    sink: {
      publish(emission, originatorClientId) {
        emissions.push({ emission, clientId: originatorClientId });
      },
    },
  };
}

function buildRegistry(provider: FakeProvider) {
  const env = makeClockAndScheduler();
  const events = makeEventSink();
  const auditLines: Array<Record<string, unknown>> = [];
  const registry = new DeviceFlowRegistry({
    events: events.sink,
    audit: { record: (line) => auditLines.push({ ...line }) },
    resolveProvider: (id) => (id === 'qwen-oauth' ? provider : undefined),
    now: env.now,
    schedule: env.schedule as never,
    scheduleInterval: env.scheduleInterval as never,
    clearScheduled: env.clearScheduled as never,
    clearScheduledInterval: env.clearScheduledInterval as never,
  });
  return { registry, env, events: events.emissions, auditLines };
}

describe('BrandedSecret', () => {
  // The earlier `new String(value)` shape leaked through `+`, template
  // literals, and `valueOf` — coercion via `Symbol.toPrimitive` followed
  // the wrapper's `valueOf` which returned the primitive. The fix uses a
  // frozen plain object + WeakMap; ALL four coercion paths
  // (`String()`, `JSON.stringify`, `+`, template literal) must redact.

  it('JSON.stringify on a secret returns "[redacted]" and preserves siblings', () => {
    const secret = brandSecret('SUPER-SECRET-DEVICE-CODE');
    const wrapped = { deviceCode: secret, label: 'demo' };
    const json = JSON.stringify(wrapped);
    expect(json).not.toContain('SUPER-SECRET-DEVICE-CODE');
    expect(json).toContain('[redacted]');
    expect(json).toContain('"label":"demo"');
  });

  it('String(secret) redacts (toString hook)', () => {
    const secret = brandSecret('LEAK-ME-IF-YOU-DARE');
    expect(String(secret)).toBe('[redacted]');
  });

  it('"prefix" + secret redacts (the path the old String-wrapper LEAKED)', () => {
    const secret = brandSecret('PRIMITIVE-WOULD-LEAK');
    const concatenated = 'device_code=' + secret;
    expect(concatenated).not.toContain('PRIMITIVE-WOULD-LEAK');
    expect(concatenated).toBe('device_code=[redacted]');
  });

  it('template literal `${secret}` redacts', () => {
    const secret = brandSecret('TEMPLATE-LEAK');
    const interpolated = `code=${secret} mode=foo`;
    expect(interpolated).not.toContain('TEMPLATE-LEAK');
    expect(interpolated).toBe('code=[redacted] mode=foo');
  });

  it('`+secret` (numeric coercion) yields NaN — does not expose primitive', () => {
    const secret = brandSecret('NUMERIC-COERCION-LEAK');
    expect(Number.isNaN(+secret)).toBe(true);
  });

  it('unsafeRevealSecret returns the original primitive', () => {
    const secret = brandSecret('THE-REAL-VALUE');
    expect(unsafeRevealSecret(secret)).toBe('THE-REAL-VALUE');
  });

  it('unsafeRevealSecret throws when called on a non-secret object', () => {
    const fake = { toString: () => '[redacted]' } as unknown as ReturnType<
      typeof brandSecret
    >;
    expect(() => unsafeRevealSecret(fake)).toThrowError(/not a BrandedSecret/);
  });

  it('two distinct brands compare unequal even when contents match', () => {
    const a = brandSecret('SAME');
    const b = brandSecret('SAME');
    expect(a).not.toBe(b);
    expect(unsafeRevealSecret(a)).toBe(unsafeRevealSecret(b));
  });
});

describe('DeviceFlowRegistry — start / public view', () => {
  let provider: FakeProvider;
  let registry: DeviceFlowRegistry;
  let events: ReturnType<typeof buildRegistry>['events'];
  let auditLines: ReturnType<typeof buildRegistry>['auditLines'];

  beforeEach(() => {
    provider = new FakeProvider();
    const built = buildRegistry(provider);
    registry = built.registry;
    events = built.events;
    auditLines = built.auditLines;
  });

  afterEach(() => {
    registry.dispose();
  });

  it('emits started + returns redacted public view', async () => {
    const { view, attached } = await registry.start({
      providerId: 'qwen-oauth',
    });
    expect(attached).toBe(false);
    expect(view.status).toBe('pending');
    expect(view.userCode).toBe('USER-1');
    // Critical: public view never carries device_code / pkce_verifier.
    expect(JSON.stringify(view)).not.toContain('device-1');
    expect(JSON.stringify(view)).not.toContain('pkce-1');
    expect(events).toHaveLength(1);
    expect(events[0].emission.type).toBe('started');
    // Started emission MUST NOT include userCode/verificationUri (PR 21 §3).
    expect(JSON.stringify(events[0].emission.data)).not.toContain('USER-1');
    expect(JSON.stringify(events[0].emission.data)).not.toContain(
      'idp.example/verify',
    );
  });

  it('idempotent take-over for the same providerId', async () => {
    const first = await registry.start({ providerId: 'qwen-oauth' });
    expect(first.attached).toBe(false);
    expect(provider.startCount).toBe(1);
    const second = await registry.start({ providerId: 'qwen-oauth' });
    expect(second.attached).toBe(true);
    expect(second.view.deviceFlowId).toBe(first.view.deviceFlowId);
    // Critical: provider.start should NOT have been called a second time.
    expect(provider.startCount).toBe(1);
  });

  it('take-over by a different clientId emits a take-over audit (fold-in 6 #6)', async () => {
    await registry.start({
      providerId: 'qwen-oauth',
      initiatorClientId: 'sdk-client-A',
    });
    auditLines.length = 0;
    await registry.start({
      providerId: 'qwen-oauth',
      initiatorClientId: 'sdk-client-B',
    });
    const takeoverAudit = auditLines.find(
      (line) =>
        line['status'] === 'started' &&
        line['clientId'] === 'sdk-client-B' &&
        typeof line['hint'] === 'string' &&
        (line['hint'] as string).startsWith('take-over'),
    );
    expect(takeoverAudit).toBeDefined();
    expect(takeoverAudit?.['hint']).toContain('sdk-client-A');
  });

  it('take-over by the SAME clientId does not emit a take-over audit', async () => {
    await registry.start({
      providerId: 'qwen-oauth',
      initiatorClientId: 'sdk-client-A',
    });
    auditLines.length = 0;
    await registry.start({
      providerId: 'qwen-oauth',
      initiatorClientId: 'sdk-client-A',
    });
    expect(
      auditLines.some(
        (line) =>
          typeof line['hint'] === 'string' &&
          (line['hint'] as string).startsWith('take-over'),
      ),
    ).toBe(false);
  });

  it('concurrent start() for the same providerId coalesces — provider.start fires once', async () => {
    // Without the in-flight Promise map, both concurrent callers would
    // pass the "no existing pending entry" check, both would call
    // provider.start (two IdP round-trips), and the second's byProvider
    // write would clobber the first — leaking an orphan poll timer.
    const [first, second, third] = await Promise.all([
      registry.start({ providerId: 'qwen-oauth' }),
      registry.start({ providerId: 'qwen-oauth' }),
      registry.start({ providerId: 'qwen-oauth' }),
    ]);
    expect(provider.startCount).toBe(1);
    // All three observers should agree on the same deviceFlowId.
    expect(first.view.deviceFlowId).toBe(second.view.deviceFlowId);
    expect(second.view.deviceFlowId).toBe(third.view.deviceFlowId);
    // Exactly one is the fresh start; the other two are take-overs.
    const attachedCount = [first, second, third].filter(
      (r) => r.attached,
    ).length;
    expect(attachedCount).toBe(2);
  });

  it('rejects unsupported provider', async () => {
    await expect(
      registry.start({ providerId: 'unknown-idp' as DeviceFlowProviderId }),
    ).rejects.toBeInstanceOf(UnsupportedDeviceFlowProviderError);
  });

  it('caps at DEVICE_FLOW_MAX_CONCURRENT', async () => {
    const providers = new Map<DeviceFlowProviderId, FakeProvider>();
    for (let i = 0; i < DEVICE_FLOW_MAX_CONCURRENT + 1; i += 1) {
      providers.set(
        `provider-${i}` as DeviceFlowProviderId,
        new FakeProvider(),
      );
    }
    const env = makeClockAndScheduler();
    const events = makeEventSink();
    const reg = new DeviceFlowRegistry({
      events: events.sink,
      resolveProvider: (id) => providers.get(id),
      now: env.now,
      schedule: env.schedule as never,
      scheduleInterval: env.scheduleInterval as never,
      clearScheduled: env.clearScheduled as never,
      clearScheduledInterval: env.clearScheduledInterval as never,
    });
    try {
      for (let i = 0; i < DEVICE_FLOW_MAX_CONCURRENT; i += 1) {
        await reg.start({
          providerId: `provider-${i}` as DeviceFlowProviderId,
        });
      }
      await expect(
        reg.start({
          providerId:
            `provider-${DEVICE_FLOW_MAX_CONCURRENT}` as DeviceFlowProviderId,
        }),
      ).rejects.toBeInstanceOf(TooManyActiveDeviceFlowsError);
    } finally {
      reg.dispose();
    }
  });

  it('caps at DEVICE_FLOW_MAX_CONCURRENT under CONCURRENT distinct-provider starts (round-13 #1)', async () => {
    // PR #4255 round-13 #1 (gpt-5.5 review C1gh0): the sequential
    // cap test above established the accounting rule, but only the
    // CONCURRENT case exposes the bug fix. Pre-fix:
    // `countActive()` counted only `byProvider`; concurrent
    // `start()` calls for MAX+1 distinct providers all reach the
    // cap check synchronously (before any awaits), all see count=0
    // (no byProvider entries yet), and all pass. Post-fix: the
    // counter includes `inFlightStarts.size`, so the second concurrent
    // caller sees count=1, the third count=2, and the (MAX+1)th
    // caller is rejected.
    const providers = new Map<DeviceFlowProviderId, FakeProvider>();
    for (let i = 0; i < DEVICE_FLOW_MAX_CONCURRENT + 1; i += 1) {
      providers.set(
        `provider-${i}` as DeviceFlowProviderId,
        new FakeProvider(),
      );
    }
    const env = makeClockAndScheduler();
    const events = makeEventSink();
    const reg = new DeviceFlowRegistry({
      events: events.sink,
      resolveProvider: (id) => providers.get(id),
      now: env.now,
      schedule: env.schedule as never,
      scheduleInterval: env.scheduleInterval as never,
      clearScheduled: env.clearScheduled as never,
      clearScheduledInterval: env.clearScheduledInterval as never,
    });
    try {
      const results = await Promise.allSettled(
        Array.from({ length: DEVICE_FLOW_MAX_CONCURRENT + 1 }, (_, i) =>
          reg.start({
            providerId: `provider-${i}` as DeviceFlowProviderId,
          }),
        ),
      );
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(DEVICE_FLOW_MAX_CONCURRENT);
      expect(rejected).toHaveLength(1);
      expect(
        rejected[0]!.status === 'rejected' ? rejected[0]!.reason : null,
      ).toBeInstanceOf(TooManyActiveDeviceFlowsError);
    } finally {
      reg.dispose();
    }
  });
});

describe('DeviceFlowRegistry — polling state machine', () => {
  let provider: FakeProvider;
  let env: ReturnType<typeof buildRegistry>['env'];
  let registry: DeviceFlowRegistry;
  let events: ReturnType<typeof buildRegistry>['events'];

  beforeEach(() => {
    provider = new FakeProvider();
    const built = buildRegistry(provider);
    env = built.env;
    registry = built.registry;
    events = built.events;
  });

  afterEach(() => {
    registry.dispose();
  });

  it('honors slow_down by bumping intervalMs and emits throttled', async () => {
    provider.pollScript = [{ kind: 'slow_down' }];
    const { view: started } = await registry.start({
      providerId: 'qwen-oauth',
    });
    // Advance past one polling interval and flush.
    env.clock.tick(DEVICE_FLOW_DEFAULT_INTERVAL_MS + 1);
    env.scheduler.flushDue(env.clock.now);
    // Wait for the async poll handler to settle.
    await flushAsync();

    const throttled = events.find((e) => e.emission.type === 'throttled');
    expect(throttled).toBeDefined();
    expect(
      (throttled!.emission.data as { intervalMs: number }).intervalMs,
    ).toBe(DEVICE_FLOW_DEFAULT_INTERVAL_MS + DEVICE_FLOW_SLOW_DOWN_BUMP_MS);

    const refreshed = registry.get(started.deviceFlowId);
    expect(refreshed?.intervalMs).toBe(
      DEVICE_FLOW_DEFAULT_INTERVAL_MS + DEVICE_FLOW_SLOW_DOWN_BUMP_MS,
    );
    expect(refreshed?.status).toBe('pending');
  });

  it('persists credentials on success and emits authorized', async () => {
    let persisted = false;
    provider.pollScript = [
      {
        kind: 'success',
        persist: async () => {
          persisted = true;
          return { expiresAt: 9_999, accountAlias: 'demo-user' };
        },
      },
    ];
    const { view: started } = await registry.start({
      providerId: 'qwen-oauth',
    });
    env.clock.tick(DEVICE_FLOW_DEFAULT_INTERVAL_MS + 1);
    env.scheduler.flushDue(env.clock.now);
    await flushAsync();

    expect(persisted).toBe(true);
    expect(provider.persistCalls).toBe(1);
    const authorized = events.find((e) => e.emission.type === 'authorized');
    expect(authorized).toBeDefined();
    const refreshed = registry.get(started.deviceFlowId);
    expect(refreshed?.status).toBe('authorized');
    // Public view of an authorized entry should NOT echo userCode/verificationUri.
    expect(refreshed?.userCode).toBeUndefined();
    expect(refreshed?.verificationUri).toBeUndefined();
  });

  it('emits failed with errorKind on upstream RFC 8628 error', async () => {
    provider.pollScript = [
      { kind: 'error', errorKind: 'access_denied', hint: 'user said no' },
    ];
    const { view: started } = await registry.start({
      providerId: 'qwen-oauth',
    });
    env.clock.tick(DEVICE_FLOW_DEFAULT_INTERVAL_MS + 1);
    env.scheduler.flushDue(env.clock.now);
    await flushAsync();

    const failed = events.find((e) => e.emission.type === 'failed');
    expect(failed).toBeDefined();
    expect((failed!.emission.data as { errorKind: string }).errorKind).toBe(
      'access_denied',
    );
    const refreshed = registry.get(started.deviceFlowId);
    expect(refreshed?.status).toBe('error');
    expect(refreshed?.errorKind).toBe('access_denied');
  });

  it('terminal entries are readable via GET within grace, evicted after', async () => {
    provider.pollScript = [
      // Note: an upstream `expired_token` error puts the entry into
      // `status: 'error'` with `errorKind: 'expired_token'`. The
      // `'expired'` status is reserved for the time-based path
      // (now >= expiresAt) — see PR 21 §2 status machine.
      { kind: 'error', errorKind: 'expired_token' },
    ];
    const { view: started } = await registry.start({
      providerId: 'qwen-oauth',
    });
    // Drive to terminal.
    env.clock.tick(DEVICE_FLOW_DEFAULT_INTERVAL_MS + 1);
    env.scheduler.flushDue(env.clock.now);
    await flushAsync();
    expect(registry.get(started.deviceFlowId)?.status).toBe('error');
    expect(registry.get(started.deviceFlowId)?.errorKind).toBe('expired_token');

    // Advance to just before grace expires — entry still readable.
    env.clock.tick(DEVICE_FLOW_TERMINAL_GRACE_MS - 1);
    runSweepers(env);
    expect(registry.get(started.deviceFlowId)?.status).toBe('error');

    // Push past grace + one sweeper tick.
    env.clock.tick(2);
    runSweepers(env);
    expect(registry.get(started.deviceFlowId)).toBeUndefined();
  });

  it('does NOT import child_process or browser-launch helpers anywhere in the device-flow source path', () => {
    // Static-source check (PR 21 §8 #1 — runtime-locality contract).
    //
    // ESM module-namespace immutability prevents a runtime spawn-spy
    // (`Cannot redefine property: spawn`), so we assert structurally:
    // the source files must not reference any of the spawn / browser-
    // launch primitives that could break the "daemon never opens a
    // browser" property. A future commit that re-introduces one fails
    // here loudly.
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const sources = [
      fs.readFileSync(path.join(dir, 'device-flow.ts'), 'utf8'),
      fs.readFileSync(path.join(dir, 'qwen-device-flow-provider.ts'), 'utf8'),
    ];
    const forbiddenPatterns = [
      // Static imports
      /from\s*['"]node:child_process['"]/,
      /from\s*['"]child_process['"]/,
      /from\s*['"]open['"]/,
      /from\s*['"]execa['"]/,
      /from\s*['"]shelljs['"]/,
      // Dynamic imports / requires
      /import\s*\(\s*['"](node:)?child_process['"]\s*\)/,
      /require\s*\(\s*['"](node:)?child_process['"]\s*\)/,
      /require\s*\(\s*['"]open['"]\s*\)/,
      // Direct API surface
      /\bxdg-open\b/,
      /\bshell\.openExternal\b/,
      /\bprocess\.spawn\b/,
    ];
    for (const src of sources) {
      for (const pattern of forbiddenPatterns) {
        expect(src).not.toMatch(pattern);
      }
    }
  });
});

describe('DeviceFlowRegistry — authoritative timeouts (fold-in 7)', () => {
  it('start() rejects when a non-abortable provider.start() hangs past START_TIMEOUT_MS (#1)', async () => {
    const provider = new FakeProvider();
    provider.startHangs = true;
    const built = buildRegistry(provider);
    const { registry, env } = built;
    try {
      const startPromise = registry.start({ providerId: 'qwen-oauth' });
      // Let the registry register its race timer.
      await flushAsync();
      env.clock.tick(DEVICE_FLOW_START_TIMEOUT_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      await expect(startPromise).rejects.toThrow(/start timeout/);
      // Critical: inFlightStarts slot must be released so a future
      // POST creates a fresh flow rather than re-attaching to the
      // hung promise.
      provider.startHangs = false;
      await expect(
        registry.start({ providerId: 'qwen-oauth' }),
      ).resolves.toMatchObject({ attached: false });
    } finally {
      registry.dispose();
    }
  });

  it('poll() that hangs past POLL_TIMEOUT_MS surfaces as upstream_error and aborts the entry signal (follow-up review)', async () => {
    // PR #4255 follow-up review thread (deepseek-v4-pro): runPollTick
    // now races provider.poll() against DEVICE_FLOW_POLL_TIMEOUT_MS so
    // a non-abortable provider can no longer pin the per-providerId
    // singleton waiting for sweeper-level expiry. Aborts the signal
    // first so cooperative providers tear down cleanly; reject
    // surfaces in the catch as the bounded `upstream_error` hint.
    const provider = new FakeProvider();
    provider.pollHangs = true;
    const built = buildRegistry(provider);
    const { registry, env, events, auditLines } = built;
    try {
      const { view } = await registry.start({ providerId: 'qwen-oauth' });
      // Trigger the first poll tick.
      env.clock.tick(DEVICE_FLOW_DEFAULT_INTERVAL_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      // Let runPollTick reach the await.
      await flushAsync();
      expect(provider.pollCount).toBe(1);
      // Race timer hasn't fired yet — entry is still pending.
      expect(registry.get(view.deviceFlowId)?.status).toBe('pending');
      // Advance clock past POLL_TIMEOUT_MS; race timer fires, aborts
      // the entry signal, and rejects the wrapper promise.
      env.clock.tick(DEVICE_FLOW_POLL_TIMEOUT_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      await flushAsync();
      // Signal must be aborted so cooperative providers can abandon
      // their in-flight fetch.
      expect(provider.lastPollSignal?.aborted).toBe(true);
      // The catch block surfaces a bounded upstream_error to SSE.
      const failed = events.find(
        (e) =>
          e.emission.type === 'failed' &&
          e.emission.data.deviceFlowId === view.deviceFlowId,
      );
      expect(failed).toBeDefined();
      if (failed && failed.emission.type === 'failed') {
        expect(failed.emission.data.errorKind).toBe('upstream_error');
        // PR #4291 follow-up review (qwen-latest, #2): the SSE/HTTP
        // hint must distinguish a registry-side timeout from a
        // provider throw. At 3 AM, on-call reading "provider.poll()
        // threw" would grep the provider source for a non-existent
        // throw site — when the actual issue is a hung IdP.
        expect(failed.emission.data.hint).toContain('timed out after');
        expect(failed.emission.data.hint).toContain('check IdP connectivity');
        // Negative assertion: the misleading provider-throw hint
        // MUST NOT appear on the timeout path.
        expect(failed.emission.data.hint).not.toContain(
          'see daemon audit log for details',
        );
      }
      // Audit captures the timeout for the operator. The hint must
      // NOT route through the misleading `provider.poll() threw (raw)`
      // template (that's reserved for real provider throws), and —
      // PR #4291 follow-up review (qwen-latest, round-4 #5) — the hint
      // MUST be present so operators reading the durable audit trail
      // can distinguish timeout from generic upstream_error. Audit
      // hint must match the SSE hint exactly.
      const auditFailure = auditLines.find(
        (line) =>
          line['status'] === 'failed' && line['errorKind'] === 'upstream_error',
      );
      expect(auditFailure).toBeDefined();
      const auditHint = auditFailure?.['hint'] as string | undefined;
      expect(auditHint).toBeDefined();
      expect(auditHint).not.toContain('provider.poll() threw (raw)');
      expect(auditHint).toContain('timed out after');
      expect(auditHint).toContain('check IdP connectivity');
      // PR #4291 follow-up review (qwen-latest, round-4 #3): the
      // timeout sentinel built ONCE per timer-fire — `signal.reason`
      // and the rejection should be the SAME instance. Pin: the
      // signal we observed is aborted with a DeviceFlowPollTimeoutError
      // reason.
      expect(provider.lastPollSignal?.aborted).toBe(true);
      const reason = provider.lastPollSignal?.reason as unknown;
      expect(reason).toBeInstanceOf(DeviceFlowPollTimeoutError);
      // PR #4291 follow-up review (Qwen Code review summary):
      // poll-tick must NOT reschedule itself after a timeout-driven
      // upstream_error (the entry has already transitioned to error
      // state; another poll would be a `entry.status !== 'pending'`
      // no-op at best, log noise at worst). Pin the invariant.
      expect(provider.pollCount).toBe(1);
    } finally {
      registry.dispose();
    }
  });

  it('records lost_late_poll_after_timeout when provider.poll() resolves AFTER the registry race timeout (follow-up review #5)', async () => {
    // PR #4291 follow-up review (qwen-latest, #5): symmetric with
    // `lost_success_after_timeout` on the persist path. A flaky IdP
    // that responds 1s past the 30s ceiling should leave an audit
    // breadcrumb saying "IdP IS responsive, just slow" — without
    // this, the daemon and the operator get the same observability
    // as a fully unresponsive IdP. The fix attaches a passive
    // observer to the original `provider.poll()` promise.
    const provider = new FakeProvider();
    let resolveLate!: (r: DeviceFlowPollResult) => void;
    const latePollPromise = new Promise<DeviceFlowPollResult>((resolve) => {
      resolveLate = resolve;
    });
    // Custom hook: poll returns the controllable promise, ignoring signal.
    provider.poll = async () => {
      provider.pollCount += 1;
      return latePollPromise;
    };
    const built = buildRegistry(provider);
    const { registry, env, auditLines } = built;
    try {
      const { view } = await registry.start({ providerId: 'qwen-oauth' });
      env.clock.tick(DEVICE_FLOW_DEFAULT_INTERVAL_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      await flushAsync();
      expect(provider.pollCount).toBe(1);
      // Fire the registry race timer.
      env.clock.tick(DEVICE_FLOW_POLL_TIMEOUT_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      await flushAsync();
      // Outer wrapper rejected; entry transitioned to error/upstream_error.
      const snapshot = registry.get(view.deviceFlowId);
      expect(snapshot?.status).toBe('error');
      // No `lost_late_poll_after_timeout` line YET — the original
      // promise hasn't resolved.
      expect(
        auditLines.some((line) =>
          (line['hint'] as string | undefined)?.includes(
            'lost_late_poll_after_timeout',
          ),
        ),
      ).toBe(false);
      // Now the IdP belatedly responds.
      resolveLate({ kind: 'pending' });
      await flushAsync();
      // The passive observer must have recorded an audit line.
      const lateAudit = auditLines.find((line) =>
        (line['hint'] as string | undefined)?.includes(
          'lost_late_poll_after_timeout',
        ),
      );
      expect(lateAudit).toBeDefined();
      expect(lateAudit?.['errorKind']).toBe('upstream_error');
      expect(lateAudit?.['hint']).toContain('kind=pending');
      expect(lateAudit?.['hint']).toContain(
        `${DEVICE_FLOW_POLL_TIMEOUT_MS}ms ceiling`,
      );
      // PR #4291 follow-up review (qwen-latest, N1): kind=pending is a
      // real late response (the IdP eventually responded), so the
      // "responsive but slow" hint is appropriate here. The negative
      // is the kind === 'error' branch (separately tested below).
      expect(lateAudit?.['hint']).toContain('IdP is responsive but slow');
      expect(lateAudit?.['hint']).not.toContain('abort-driven');
    } finally {
      registry.dispose();
    }
  });

  it('records lost_late_poll_after_timeout with abort-driven hint when late resolution is kind=error (qwen-latest review N1)', async () => {
    // PR #4291 follow-up review (qwen-latest, N1): when the registry
    // race timer aborts `entry.cancelController.signal`, a cooperative
    // provider's `pollDeviceToken({signal})` typically throws
    // AbortError; the provider's catch then resolves to
    // `{kind: 'error', errorKind: 'upstream_error'}`. This success
    // handler fires with `latePollResult.kind === 'error'`. Earlier
    // shape would have audited "IdP is responsive but slow" — but the
    // IdP could be totally down; the "response" is just the provider's
    // abort cooperation. Pin the corrected attribution.
    const provider = new FakeProvider();
    let resolveLate!: (r: DeviceFlowPollResult) => void;
    const latePollPromise = new Promise<DeviceFlowPollResult>((resolve) => {
      resolveLate = resolve;
    });
    provider.poll = async () => {
      provider.pollCount += 1;
      return latePollPromise;
    };
    const built = buildRegistry(provider);
    const { registry, env, auditLines } = built;
    try {
      const { view } = await registry.start({ providerId: 'qwen-oauth' });
      env.clock.tick(DEVICE_FLOW_DEFAULT_INTERVAL_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      await flushAsync();
      env.clock.tick(DEVICE_FLOW_POLL_TIMEOUT_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      await flushAsync();
      // Cooperative abort path: provider resolves to error AFTER the
      // race timer fired.
      resolveLate({
        kind: 'error',
        errorKind: 'upstream_error',
        hint: 'aborted by signal',
      });
      await flushAsync();
      const lateAudit = auditLines.find((line) =>
        (line['hint'] as string | undefined)?.includes(
          'lost_late_poll_after_timeout',
        ),
      );
      expect(lateAudit).toBeDefined();
      expect(lateAudit?.['hint']).toContain('kind=error');
      // The corrected hint MUST NOT claim the IdP is responsive.
      expect(lateAudit?.['hint']).not.toContain('IdP is responsive but slow');
      expect(lateAudit?.['hint']).toContain('abort-driven cooperation');
      expect(lateAudit?.['hint']).toContain('IdP responsiveness unknown');
      // dispose the entry to keep the test isolated.
      void view;
    } finally {
      registry.dispose();
    }
  });

  it('records lost_late_poll_after_timeout when provider.poll() REJECTS after the race timeout (qwen-latest review N2)', async () => {
    // PR #4291 follow-up review (qwen-latest, N2): the late observer
    // also has an `onRejected` branch covering three sub-paths that
    // were previously zero-tested:
    //   1. `if (lateErr instanceof DeviceFlowPollTimeoutError) return;`
    //      (don't double-audit our own race-timer rejection)
    //   2. The `detail.length > 256` truncation tail
    //   3. The audit record for the rejection itself
    // Late rejection is realistic: TCP RST or proxy 502 arriving 1s
    // past the 30s ceiling.
    const provider = new FakeProvider();
    let rejectLate!: (e: Error) => void;
    const latePollPromise = new Promise<DeviceFlowPollResult>(
      (_resolve, reject) => {
        rejectLate = reject;
      },
    );
    provider.poll = async () => {
      provider.pollCount += 1;
      return latePollPromise;
    };
    const built = buildRegistry(provider);
    const { registry, env, auditLines } = built;
    try {
      await registry.start({ providerId: 'qwen-oauth' });
      env.clock.tick(DEVICE_FLOW_DEFAULT_INTERVAL_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      await flushAsync();
      env.clock.tick(DEVICE_FLOW_POLL_TIMEOUT_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      await flushAsync();
      // Late upstream failure (NOT our own DeviceFlowPollTimeoutError).
      // Use a long message that, in the pre-round-4 code, would have
      // been truncated to its first 256 bytes — and those 256 bytes
      // can carry a full RFC 8628 `device_code` (≤80 chars) verbatim
      // if the upstream wrapper templates it into the response. The
      // round-4 #7 fix switches to the same `name + length` pattern
      // the provider catch uses, so the raw detail never reaches
      // stderr / audit even when settled late.
      const seededDeviceCode = 'device-code-secret-AAAA1111';
      const longDetail = `connection reset by peer ${seededDeviceCode} ${'x'.repeat(400)}`;
      rejectLate(new Error(longDetail));
      await flushAsync();
      const lateAudit = auditLines.find((line) =>
        (line['hint'] as string | undefined)?.includes(
          'lost_late_poll_after_timeout',
        ),
      );
      expect(lateAudit).toBeDefined();
      expect(lateAudit?.['errorKind']).toBe('upstream_error');
      const auditHint = lateAudit?.['hint'] as string;
      expect(auditHint).toContain('rejected after');
      expect(auditHint).toContain(`${DEVICE_FLOW_POLL_TIMEOUT_MS}ms ceiling`);
      // PR #4291 follow-up review (qwen-latest, round-4 #7): the
      // late-rejection observer must use the `name + length` pattern,
      // NOT the raw message slice. Hard-negate the seeded device_code
      // to pin the security regression — a future change that goes
      // back to slicing `lateErr.message` would fail CI immediately.
      expect(auditHint).toContain('Error (message');
      expect(auditHint).toContain('bytes; raw suppressed)');
      expect(auditHint).not.toContain(seededDeviceCode);
      expect(auditHint).not.toContain('connection reset by peer');
    } finally {
      registry.dispose();
    }
  });

  it('audits a provider-thrown DeviceFlowPollTimeoutError as a real failure (round-6 #4: brand-aware self-filter)', async () => {
    // Round-6 review (qwen-latest, #4): the self-filter guard in the
    // late-rejection observer must check the runtime brand
    // (`_isRegistryTimeout === true`), NOT bare `instanceof`. Reason:
    // `DeviceFlowPollTimeoutError` is `export class` (the test file
    // needs the constructor for fixture purposes), so a non-conforming
    // provider that imported and threw `new DeviceFlowPollTimeoutError(...)`
    // would otherwise spoof "I caused the timeout" — silently swallowed
    // by the filter and never audited. Pin the inverted scenario:
    // brand-false provider throw IS audited as `lost_late_poll_after_timeout`.
    //
    // Note: this test'\''s setup mirrors the natural late-rejection path
    // (registry race timer fires first, then the provider'\''s promise
    // settles late with the rejection). The late-observer'\''s filter is
    // exercised in two ways across this and the next test:
    //   - here: brand-FALSE → late audit DOES appear (this test)
    //   - elsewhere: brand-TRUE registry timeout → no late audit (the
    //     hanging-provider test below covers the natural happy-path
    //     since the registry'\''s real timeout is brand-true and the
    //     promise never settles late)
    const provider = new FakeProvider();
    let rejectLate!: (e: Error) => void;
    const latePollPromise = new Promise<DeviceFlowPollResult>(
      (_resolve, reject) => {
        rejectLate = reject;
      },
    );
    provider.poll = async () => {
      provider.pollCount += 1;
      return latePollPromise;
    };
    const built = buildRegistry(provider);
    const { registry, env, auditLines } = built;
    try {
      await registry.start({ providerId: 'qwen-oauth' });
      env.clock.tick(DEVICE_FLOW_DEFAULT_INTERVAL_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      await flushAsync();
      env.clock.tick(DEVICE_FLOW_POLL_TIMEOUT_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      await flushAsync();
      // Provider throws the EXPORTED class directly (brand-false). The
      // round-5 shape would have silently filtered this; round-6 audits
      // it correctly as a real failure.
      const providerThrown = new DeviceFlowPollTimeoutError(
        DEVICE_FLOW_POLL_TIMEOUT_MS,
      );
      expect(providerThrown._isRegistryTimeout).toBe(false);
      rejectLate(providerThrown);
      await flushAsync();
      const lateAudits = auditLines.filter((line) =>
        (line['hint'] as string | undefined)?.includes(
          'lost_late_poll_after_timeout',
        ),
      );
      // Brand-false → NOT filtered, audited as a real late rejection.
      expect(lateAudits.length).toBeGreaterThanOrEqual(1);
      expect(lateAudits[0]?.['errorKind']).toBe('upstream_error');
      expect(lateAudits[0]?.['hint']).toContain('rejected after');
    } finally {
      registry.dispose();
    }
  });

  // (Round-5 N2's "filter out registry's own timeout" guard is now
  //  brand-aware — see round-6 #4 above. The natural happy-path "no
  //  double-audit when the registry's own race timer settles the
  //  wrapper" is implicitly covered by the hanging-provider test
  //  earlier, which exercises a brand-true `makeRegistryPollTimeoutError`
  //  via the actual race-timer path; the provider's promise never
  //  settles late, so the late-observer's brand-true filter is the only
  //  thing keeping a phantom `lost_late_poll_after_timeout` from
  //  appearing alongside the wrapper-catch audit.)

  it('does NOT attach late-poll observer when the provider beats the timeout (round-5 #1: pollTimedOut race)', async () => {
    // PR #4291 follow-up review (deepseek-v4-pro, round-5 #1): the
    // `pollTimedOut = true` flag was previously set unconditionally
    // inside the timer callback. If the provider settled the wrapper
    // first (e.g., at 29.9s), the timer callback could still fire
    // afterwards in a tight race, mark the flag, and the late-observer
    // would attach to an already-settled promise — emitting a
    // spurious `lost_late_poll_after_timeout` for a flow that
    // completed within the ceiling. Fix: set the flag in the catch
    // block only when `err instanceof DeviceFlowPollTimeoutError`.
    // Pin: provider responds with `pending` BEFORE the race timer
    // fires; assert NO late audit.
    const provider = new FakeProvider();
    provider.pollScript = [{ kind: 'pending' }];
    const built = buildRegistry(provider);
    const { registry, env, auditLines } = built;
    try {
      await registry.start({ providerId: 'qwen-oauth' });
      // Drive the first poll. Provider returns synchronously; wrapper
      // resolves, finally clears the timer.
      env.clock.tick(DEVICE_FLOW_DEFAULT_INTERVAL_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      await flushAsync();
      expect(provider.pollCount).toBe(1);
      // Tick well past POLL_TIMEOUT_MS to confirm the timer was
      // properly cleared. If `pollTimedOut` had been set in the
      // callback, this would attach a late observer + audit line.
      env.clock.tick(DEVICE_FLOW_POLL_TIMEOUT_MS * 2);
      env.scheduler.flushDue(env.clock.now);
      await flushAsync();
      const spuriousLate = auditLines.find((line) =>
        (line['hint'] as string | undefined)?.includes(
          'lost_late_poll_after_timeout',
        ),
      );
      expect(spuriousLate).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });

  it('sanitizes hostile latePollResult.kind in late-observer audit (round-5 #3)', async () => {
    // PR #4291 follow-up review (deepseek-v4-pro, round-5 #3): a
    // non-conforming provider could return `{kind: '<hostile string
    // with newlines/controls>'}`. The audit hint interpolates `kind`
    // directly — without sanitization, that's a log-forging vector
    // even though the typed shape is `'pending' | 'slow_down' | ...`.
    const provider = new FakeProvider();
    let resolveLate!: (r: DeviceFlowPollResult) => void;
    const latePollPromise = new Promise<DeviceFlowPollResult>((resolve) => {
      resolveLate = resolve;
    });
    provider.poll = async () => {
      provider.pollCount += 1;
      return latePollPromise;
    };
    const built = buildRegistry(provider);
    const { registry, env, auditLines } = built;
    try {
      await registry.start({ providerId: 'qwen-oauth' });
      env.clock.tick(DEVICE_FLOW_DEFAULT_INTERVAL_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      await flushAsync();
      env.clock.tick(DEVICE_FLOW_POLL_TIMEOUT_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      await flushAsync();
      // Non-conforming late resolve with hostile `kind`. (Casting
      // to `DeviceFlowPollResult` simulates a provider violating the
      // typed contract at runtime.)
      const hostile = 'pending\n[serve] FORGED LINE\x1b[31m';
      resolveLate({ kind: hostile } as unknown as DeviceFlowPollResult);
      await flushAsync();
      const lateAudit = auditLines.find((line) =>
        (line['hint'] as string | undefined)?.includes(
          'lost_late_poll_after_timeout',
        ),
      );
      expect(lateAudit).toBeDefined();
      const hint = lateAudit?.['hint'] as string;
      // The forged log line text MUST NOT lead a real newline.
      expect(hint.split('\n').length).toBe(1);
      expect(hint).not.toContain('\x1b[31m');
      // Substantive parts preserved (`?`-replaced).
      expect(hint).toContain('FORGED LINE');
    } finally {
      registry.dispose();
    }
  });

  it('sanitizes hostile lateErr.name in late-rejection observer audit (round-5 #2)', async () => {
    // PR #4291 follow-up review (deepseek-v4-pro, round-5 #2): same
    // log-injection vector via `Error.name` (freely assignable). The
    // round-4 fix used name+length but didn't sanitize `name` itself.
    const provider = new FakeProvider();
    let rejectLate!: (e: Error) => void;
    const latePollPromise = new Promise<DeviceFlowPollResult>(
      (_resolve, reject) => {
        rejectLate = reject;
      },
    );
    provider.poll = async () => {
      provider.pollCount += 1;
      return latePollPromise;
    };
    const built = buildRegistry(provider);
    const { registry, env, auditLines } = built;
    try {
      await registry.start({ providerId: 'qwen-oauth' });
      env.clock.tick(DEVICE_FLOW_DEFAULT_INTERVAL_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      await flushAsync();
      env.clock.tick(DEVICE_FLOW_POLL_TIMEOUT_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      await flushAsync();
      const hostileErr = new Error('upstream HTTP 502');
      hostileErr.name = 'Hostile\n[serve] FORGED ERR LINE\x1b[31m';
      rejectLate(hostileErr);
      await flushAsync();
      const lateAudit = auditLines.find((line) =>
        (line['hint'] as string | undefined)?.includes(
          'lost_late_poll_after_timeout',
        ),
      );
      expect(lateAudit).toBeDefined();
      const hint = lateAudit?.['hint'] as string;
      expect(hint.split('\n').length).toBe(1);
      expect(hint).not.toContain('\x1b[31m');
      expect(hint).toContain('FORGED ERR LINE');
    } finally {
      registry.dispose();
    }
  });

  it('survives a throwing audit sink in the late-poll observer (round-6 #2: terminal .catch())', async () => {
    // PR #4291 follow-up review (qwen-latest, round-6 #2): the late-poll
    // `void tracked.then(...)` was missing a terminal `.catch(() => {})`.
    // If `audit.record` throws synchronously inside either handler (a
    // misbehaving sink: throwing on backpressure, on a malformed
    // payload, on out-of-disk for a file sink), the resulting promise
    // rejects unhandled. Node 22's default
    // `--unhandled-rejections=throw` would crash the daemon. Pin the
    // resilience: a poison audit sink in the late-resolve path must
    // NOT throw out of `flushAsync()`.
    const provider = new FakeProvider();
    let resolveLate!: (r: DeviceFlowPollResult) => void;
    const latePollPromise = new Promise<DeviceFlowPollResult>((resolve) => {
      resolveLate = resolve;
    });
    provider.poll = async () => {
      provider.pollCount += 1;
      return latePollPromise;
    };
    const env = makeClockAndScheduler();
    const events = makeEventSink();
    const allRecords: Array<Record<string, unknown>> = [];
    const registry = new DeviceFlowRegistry({
      events: events.sink,
      audit: {
        // Throw ONLY for the late-observer's audit call (identified by
        // its `lost_late_poll_after_timeout` hint). Earlier audit calls
        // (start, in-flight poll-timeout failure) record normally so
        // we exercise the specific code path the round-6 #2 fix targets.
        record: (line) => {
          allRecords.push({ ...line });
          if (
            typeof line.hint === 'string' &&
            line.hint.includes('lost_late_poll_after_timeout')
          ) {
            throw new Error('audit sink crashed during late-observer call');
          }
        },
      },
      resolveProvider: (id) => (id === 'qwen-oauth' ? provider : undefined),
      now: env.now,
      schedule: env.schedule as never,
      scheduleInterval: env.scheduleInterval as never,
      clearScheduled: env.clearScheduled as never,
      clearScheduledInterval: env.clearScheduledInterval as never,
    });
    try {
      await registry.start({ providerId: 'qwen-oauth' });
      env.clock.tick(DEVICE_FLOW_DEFAULT_INTERVAL_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      await flushAsync();
      env.clock.tick(DEVICE_FLOW_POLL_TIMEOUT_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      await flushAsync();
      // Resolve late — the late-resolve handler will call audit.record
      // which throws. The terminal `.catch(() => {})` swallows it.
      resolveLate({ kind: 'pending' });
      // If the chain were unhandled, this `flushAsync()` would surface
      // an unhandled-rejection warning on Node 22. With `.catch()`
      // attached, it completes cleanly.
      await expect(flushAsync()).resolves.toBeUndefined();
    } finally {
      registry.dispose();
    }
  });

  it('sanitizes rawProviderError before interpolating into the audit hint (round-6 #3)', async () => {
    // PR #4291 follow-up review (qwen-latest, round-6 #3): the
    // `case 'error'` audit branch interpolates the captured
    // `rawProviderError` (raw `err.message`) into the hint. Per ES2019+
    // `JSON.stringify` no longer escapes U+2028 / U+2029 (they're
    // valid JSON), so a hostile provider throw with those characters
    // in `err.message` would otherwise forge log lines downstream.
    // Apply `sanitizeForStderr` before interpolation; pin via a
    // hostile message containing U+2028 + ANSI escape.
    const U_2028 = '\u2028';
    const provider = new FakeProvider();
    provider.poll = async () => {
      provider.pollCount += 1;
      throw new Error(
        `upstream${U_2028}[serve] FORGED PROVIDER LINE\x1b[31mRED`,
      );
    };
    const built = buildRegistry(provider);
    const { registry, env, auditLines } = built;
    try {
      await registry.start({ providerId: 'qwen-oauth' });
      env.clock.tick(DEVICE_FLOW_DEFAULT_INTERVAL_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      await flushAsync();
      const auditLine = auditLines.find((line) =>
        (line['hint'] as string | undefined)?.includes(
          'provider.poll() threw (raw)',
        ),
      );
      expect(auditLine).toBeDefined();
      const hint = auditLine?.['hint'] as string;
      // U+2028 is replaced with `?`. ANSI escape replaced too.
      expect(hint).not.toContain(U_2028);
      expect(hint).not.toContain('\x1b[31m');
      // Substantive parts preserved.
      expect(hint).toContain('FORGED PROVIDER LINE');
      expect(hint).toContain('RED');
    } finally {
      registry.dispose();
    }
  });

  it('persist() that hangs past PERSIST_TIMEOUT_MS maps to persist_failed (#2)', async () => {
    const provider = new FakeProvider();
    // Single poll tick returns success whose persist() never resolves.
    provider.pollScript = [
      {
        kind: 'success',
        persist: () =>
          new Promise<{ expiresAt?: number; accountAlias?: string }>(
            () => undefined,
          ),
      },
    ];
    const built = buildRegistry(provider);
    const { registry, env, events } = built;
    try {
      const { view } = await registry.start({ providerId: 'qwen-oauth' });
      // Drive the first poll → success → enters persist race.
      env.clock.tick(DEVICE_FLOW_DEFAULT_INTERVAL_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      await flushAsync();
      // Now advance past the persist timeout.
      env.clock.tick(DEVICE_FLOW_PERSIST_TIMEOUT_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      await flushAsync();
      const snapshot = registry.get(view.deviceFlowId);
      expect(snapshot?.status).toBe('error');
      expect(snapshot?.errorKind).toBe('persist_failed');
      const failed = events.find(
        (e) =>
          e.emission.type === 'failed' &&
          e.emission.data.errorKind === 'persist_failed',
      );
      expect(failed).toBeDefined();
    } finally {
      registry.dispose();
    }
  });

  it('clamps an extreme expiresIn to DEVICE_FLOW_MAX_EXPIRES_IN_SEC (#3)', async () => {
    const provider = new FakeProvider();
    provider.expiresIn = 1e12; // years; would pin singleton without clamp
    const built = buildRegistry(provider);
    const { registry, env } = built;
    try {
      const { view } = await registry.start({ providerId: 'qwen-oauth' });
      const ttlMs = (view.expiresAt ?? 0) - env.clock.now;
      expect(ttlMs).toBeLessThanOrEqual(DEVICE_FLOW_MAX_EXPIRES_IN_SEC * 1000);
      expect(ttlMs).toBeGreaterThan(0);
    } finally {
      registry.dispose();
    }
  });

  it('clamps an extreme interval to DEVICE_FLOW_MAX_INTERVAL_MS (#3)', async () => {
    const provider = new FakeProvider();
    provider.interval = 1e9; // billions of seconds; setTimeout(huge) is dropped
    const built = buildRegistry(provider);
    const { registry } = built;
    try {
      const { view } = await registry.start({ providerId: 'qwen-oauth' });
      expect(view.intervalMs).toBeLessThanOrEqual(DEVICE_FLOW_MAX_INTERVAL_MS);
    } finally {
      registry.dispose();
    }
  });

  it('runPollTick catch uses a static SSE hint and preserves raw on the audit (fold-in 9 #1)', async () => {
    // Models a non-conforming provider that violates the @remarks
    // sanitization contract by throwing a multi-KB raw payload that
    // could include secret material (here, an HTML-error-page-shaped
    // string with a fake-secret marker).
    const provider = new FakeProvider();
    const secretMarker = 'CONFIDENTIAL-DEVICE-CODE-DO-NOT-LEAK';
    const longRaw = `${secretMarker} ${'X'.repeat(4_000)}`;
    provider.pollThrowsWith = new Error(longRaw);
    const built = buildRegistry(provider);
    const { registry, env, events, auditLines } = built;
    try {
      const { view } = await registry.start({ providerId: 'qwen-oauth' });
      env.clock.tick(DEVICE_FLOW_DEFAULT_INTERVAL_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      await flushAsync();
      const failedEvent = events.find(
        (e) =>
          e.emission.type === 'failed' &&
          e.emission.data.deviceFlowId === view.deviceFlowId,
      );
      expect(failedEvent).toBeDefined();
      const sseHint =
        failedEvent && failedEvent.emission.type === 'failed'
          ? failedEvent.emission.data.hint
          : undefined;
      // fold-in 9 strengthens fold-in 8: SSE hint is now a STATIC
      // bounded message — even the truncated prefix could carry
      // secret material if the provider templated it into
      // err.message. Static keeps SSE broadcasters fully isolated
      // from raw provider text.
      expect(sseHint).toBeDefined();
      expect(sseHint).not.toContain(secretMarker);
      expect(sseHint).toBe(
        'provider.poll() failed; see daemon audit log for details',
      );
      // Audit line still retains the FULL raw detail (including the
      // secret marker) for operator incident response.
      const failedAudit = auditLines.find(
        (line) =>
          line['status'] === 'failed' &&
          line['errorKind'] === 'upstream_error' &&
          typeof line['hint'] === 'string',
      );
      expect(failedAudit).toBeDefined();
      expect(failedAudit?.['hint']).toContain(secretMarker);
    } finally {
      registry.dispose();
    }
  });
});

describe('DeviceFlowRegistry — abort propagation to provider.poll', () => {
  it('cancel() aborts the signal observed by the in-flight provider.poll', async () => {
    const provider = new FakeProvider();
    const built = buildRegistry(provider);
    const { registry, env } = built;
    try {
      const { view: started } = await registry.start({
        providerId: 'qwen-oauth',
      });
      // Drive one polling tick so the provider records its signal.
      env.clock.tick(DEVICE_FLOW_DEFAULT_INTERVAL_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      // Two microtask flushes so the poll handler resolves and
      // `lastPollSignal` is populated.
      await Promise.resolve();
      await Promise.resolve();
      expect(provider.lastPollSignal).toBeDefined();
      expect(provider.lastPollSignal!.aborted).toBe(false);

      // Cancel the flow — registry should abort the entry's
      // cancelController, which is the SAME signal the provider's
      // `poll` saw. A real Qwen provider passes this to `fetch`, so
      // an in-flight HTTP socket gets torn down immediately.
      registry.cancel(started.deviceFlowId);
      expect(provider.lastPollSignal!.aborted).toBe(true);
    } finally {
      registry.dispose();
    }
  });

  it('dispose() also aborts the signal observed by every active flow', async () => {
    const provider = new FakeProvider();
    const built = buildRegistry(provider);
    const { registry, env } = built;
    await registry.start({ providerId: 'qwen-oauth' });
    env.clock.tick(DEVICE_FLOW_DEFAULT_INTERVAL_MS + 1);
    env.scheduler.flushDue(env.clock.now);
    await Promise.resolve();
    await Promise.resolve();
    expect(provider.lastPollSignal!.aborted).toBe(false);
    registry.dispose();
    expect(provider.lastPollSignal!.aborted).toBe(true);
  });
});

describe('DeviceFlowRegistry — persist failure paths (fold-in 10 #1)', () => {
  // Round-8 thread Cvho9 (Critical): persist failure branches are the
  // most consequential code paths in the success arm — `persist_failed`
  // was specifically introduced for disk-write failures (EACCES,
  // EROFS, ENOSPC) and the cancel-during-persist + past-expiresAt
  // branches were added by fold-in 5/9 to handle race conditions.
  // Every prior test used a persist that always succeeded; this
  // block exercises the three terminal mappings.

  it('persist throws → entry transitions to error/persist_failed + failed event emitted', async () => {
    const provider = new FakeProvider();
    const persistError = new Error('EACCES: permission denied');
    provider.pollScript = [
      {
        kind: 'success',
        persist: async () => {
          throw persistError;
        },
      },
    ];
    const built = buildRegistry(provider);
    const { registry, env, events, auditLines } = built;
    try {
      const { view } = await registry.start({ providerId: 'qwen-oauth' });
      env.clock.tick(DEVICE_FLOW_DEFAULT_INTERVAL_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      await flushAsync();
      const snapshot = registry.get(view.deviceFlowId);
      expect(snapshot?.status).toBe('error');
      expect(snapshot?.errorKind).toBe('persist_failed');
      const failedEvent = events.find(
        (e) =>
          e.emission.type === 'failed' &&
          e.emission.data.deviceFlowId === view.deviceFlowId,
      );
      expect(failedEvent).toBeDefined();
      if (failedEvent && failedEvent.emission.type === 'failed') {
        expect(failedEvent.emission.data.errorKind).toBe('persist_failed');
        // SSE hint is the static bounded string; no raw EACCES text.
        expect(failedEvent.emission.data.hint).toContain(
          'credentials could not be written',
        );
      }
      const failedAudit = auditLines.find(
        (line) =>
          line['status'] === 'failed' && line['errorKind'] === 'persist_failed',
      );
      expect(failedAudit).toBeDefined();
    } finally {
      registry.dispose();
    }
  });

  it('persist throws after cancel() → entry transitions to cancelled (not authorized; not persist_failed)', async () => {
    const provider = new FakeProvider();
    // Persist takes a controllable promise so the test can fire cancel
    // mid-await and then resolve persist (with rejection) afterward.
    let rejectPersist!: (err: Error) => void;
    const persistPromise = new Promise<{ expiresAt?: number }>(
      (_resolve, reject) => {
        rejectPersist = reject;
      },
    );
    provider.pollScript = [
      {
        kind: 'success',
        persist: () => persistPromise,
      },
    ];
    const built = buildRegistry(provider);
    const { registry, env, events } = built;
    try {
      const { view } = await registry.start({ providerId: 'qwen-oauth' });
      // First poll tick: enters success → persist starts.
      env.clock.tick(DEVICE_FLOW_DEFAULT_INTERVAL_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      await flushAsync();
      // While persist is in flight, request cancel via the route
      // surface (cancellerClientId differs from the initiator).
      const cancelResult = registry.cancel(view.deviceFlowId, 'sdk-canceller');
      expect(cancelResult).toEqual({ alreadyTerminal: false });
      // Persist now fails (signal-aborted by cancel). Resolve with
      // an abort-shaped error. The registry's persistError branch
      // routes through `cancelDuringPersist` → `cancelled`.
      rejectPersist(new Error('aborted: cancel during persist'));
      await flushAsync();
      const snapshot = registry.get(view.deviceFlowId);
      expect(snapshot?.status).toBe('cancelled');
      expect(snapshot?.errorKind).toBeUndefined();
      // Event emission is on the canceller's id (fold-in 9 #5).
      const cancelledEvent = events.find(
        (e) =>
          e.emission.type === 'cancelled' &&
          e.emission.data.deviceFlowId === view.deviceFlowId,
      );
      expect(cancelledEvent).toBeDefined();
      expect(cancelledEvent?.clientId).toBe('sdk-canceller');
      // No `failed`/`persist_failed` event leaked through.
      expect(
        events.some(
          (e) =>
            e.emission.type === 'failed' &&
            e.emission.data.errorKind === 'persist_failed',
        ),
      ).toBe(false);
    } finally {
      registry.dispose();
    }
  });

  it('cancellerClientId is first-writer-wins across concurrent cancel() calls during persist', async () => {
    // PR #4255 follow-up review thread (deepseek-v4-pro): two SDK
    // clients racing `cancel()` on the same persist-in-flight entry
    // must NOT silently overwrite attribution. The first cancel that
    // observes `persistInFlight` is the one that drove the transition;
    // the persist-resolution event should be attributed to it. The
    // second cancel is functionally a no-op on the entry (it's already
    // marked `cancelRequestedDuringPersist`); its caller still appears
    // in the audit trail through the `audit.record(...)` path but
    // does not overwrite the SSE event's `originatorClientId`.
    const provider = new FakeProvider();
    let rejectPersist!: (err: Error) => void;
    const persistPromise = new Promise<{ expiresAt?: number }>(
      (_resolve, reject) => {
        rejectPersist = reject;
      },
    );
    provider.pollScript = [
      {
        kind: 'success',
        persist: () => persistPromise,
      },
    ];
    const built = buildRegistry(provider);
    const { registry, env, events } = built;
    try {
      const { view } = await registry.start({ providerId: 'qwen-oauth' });
      env.clock.tick(DEVICE_FLOW_DEFAULT_INTERVAL_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      await flushAsync();
      // First canceller wins.
      const first = registry.cancel(view.deviceFlowId, 'sdk-A');
      expect(first).toEqual({ alreadyTerminal: false });
      // Second canceller observes `persistInFlight` already set; the
      // entry is still marked `cancelRequestedDuringPersist`. Its id
      // MUST NOT overwrite the first-writer's attribution.
      const second = registry.cancel(view.deviceFlowId, 'sdk-B');
      expect(second).toEqual({ alreadyTerminal: false });
      // Persist now fails — the registry emits `cancelled` with
      // `originatorClientId = entry.cancellerClientId` (sdk-A).
      rejectPersist(new Error('aborted: cancel during persist'));
      await flushAsync();
      const snapshot = registry.get(view.deviceFlowId);
      expect(snapshot?.status).toBe('cancelled');
      const cancelledEvent = events.find(
        (e) =>
          e.emission.type === 'cancelled' &&
          e.emission.data.deviceFlowId === view.deviceFlowId,
      );
      expect(cancelledEvent).toBeDefined();
      // First-writer-wins: sdk-A drove the transition.
      expect(cancelledEvent?.clientId).toBe('sdk-A');
    } finally {
      registry.dispose();
    }
  });

  it('cancellerClientId is first-writer-wins even when the first canceller is anonymous (no clientId)', async () => {
    // PR #4291 follow-up review (Copilot): the first version of the
    // first-writer-wins guard used `entry.cancellerClientId === undefined`
    // as the gate, which silently broke when the first canceller was
    // anonymous: `cancel(id, undefined)` left the field undefined, and
    // a later `cancel(id, 'sdk-B')` saw the gate as still open and
    // overwrote attribution. The fix decouples the "have we recorded a
    // canceller" question (`cancellerRecorded` flag) from the "do we
    // have a clientId" question. An anonymous first canceller still
    // flips the flag, blocking any later writer.
    const provider = new FakeProvider();
    let rejectPersist!: (err: Error) => void;
    const persistPromise = new Promise<{ expiresAt?: number }>(
      (_resolve, reject) => {
        rejectPersist = reject;
      },
    );
    provider.pollScript = [
      {
        kind: 'success',
        persist: () => persistPromise,
      },
    ];
    const built = buildRegistry(provider);
    const { registry, env, events } = built;
    try {
      const { view } = await registry.start({ providerId: 'qwen-oauth' });
      env.clock.tick(DEVICE_FLOW_DEFAULT_INTERVAL_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      await flushAsync();
      // First (anonymous) canceller wins. cancellerClientId stays
      // undefined; cancellerRecorded is now true.
      const first = registry.cancel(view.deviceFlowId);
      expect(first).toEqual({ alreadyTerminal: false });
      // Second canceller IS identified — but the first-writer-wins
      // gate must reject the overwrite.
      const second = registry.cancel(view.deviceFlowId, 'sdk-B');
      expect(second).toEqual({ alreadyTerminal: false });
      rejectPersist(new Error('aborted: cancel during persist'));
      await flushAsync();
      const snapshot = registry.get(view.deviceFlowId);
      expect(snapshot?.status).toBe('cancelled');
      const cancelledEvent = events.find(
        (e) =>
          e.emission.type === 'cancelled' &&
          e.emission.data.deviceFlowId === view.deviceFlowId,
      );
      expect(cancelledEvent).toBeDefined();
      // The deferred SSE event must NOT carry sdk-B as originator —
      // the anonymous first writer wins, so `entry.cancellerClientId`
      // stays undefined, and the runPollTick deferred-cancel branch
      // falls back to `entry.initiatorClientId` (which is also
      // undefined here because `start()` itself was anonymous). The
      // critical assertion: sdk-B did NOT silently take credit.
      expect(cancelledEvent?.clientId).not.toBe('sdk-B');
    } finally {
      registry.dispose();
    }
  });

  it('records lost_success_after_timeout when persist resolves AFTER the registry timeout (round-12 #8)', async () => {
    // PR #4255 round-12 #8 (Cy_ZH): pins the split-brain detector
    // for non-conforming providers. fold-in 9 #7 added an
    // independent tracker on the original `result.persist(...)`
    // promise: if the race timed out (`persistTimedOut === true`)
    // AND the underlying persist later resolved successfully,
    // emit a `lost_success_after_timeout` audit breadcrumb.
    // Reachable scenario: provider's persist runs non-abortable
    // I/O (mkdir/chmod/mv outside the `fs.writeFile` signal
    // path) and the disk write succeeds 100ms after the 30s
    // timeout fires.
    const provider = new FakeProvider();
    let resolveLate!: (m: { expiresAt?: number }) => void;
    const latePersist = new Promise<{ expiresAt?: number }>((resolve) => {
      resolveLate = resolve;
    });
    provider.pollScript = [
      {
        kind: 'success',
        // Persist intentionally ignores signal — models a
        // non-conforming provider. Resolves only when the test
        // fires it.
        persist: () => latePersist,
      },
    ];
    const built = buildRegistry(provider);
    const { registry, env, auditLines } = built;
    try {
      await registry.start({ providerId: 'qwen-oauth' });
      // Drive first poll → success → enter persist race.
      env.clock.tick(DEVICE_FLOW_DEFAULT_INTERVAL_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      await flushAsync();
      // Advance past PERSIST_TIMEOUT_MS so the race fires its timer.
      env.clock.tick(DEVICE_FLOW_PERSIST_TIMEOUT_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      await flushAsync();
      // Registry already published persist_failed and transitioned.
      // Now the non-cooperative provider "silently" commits anyway.
      resolveLate({ expiresAt: 1_700_000_999_000 });
      await flushAsync();
      const lostSuccessAudit = auditLines.find(
        (line) =>
          typeof line['hint'] === 'string' &&
          (line['hint'] as string).startsWith('lost_success_after_timeout'),
      );
      expect(lostSuccessAudit).toBeDefined();
      // The audit line records `status: 'authorized'` so operators
      // can grep "tokens are on disk despite persist_failed event."
      expect(lostSuccessAudit?.['status']).toBe('authorized');
      expect(lostSuccessAudit?.['hint']).toContain('1700000999000');
    } finally {
      registry.dispose();
    }
  });

  it('persist throws past expiresAt → persist_failed (NOT expired_token; fold-in 9 #13)', async () => {
    // Round-8 #13: previously the registry classified this branch as
    // `expired_token`, routing operator remediation to "tell user to
    // retry" (RFC 8628 expiry) when the actual root cause is disk
    // I/O. fold-in 9 #13 reclassified to `persist_failed` with a
    // `persist_also_failed_past_expiry` audit hint preserving the
    // timing detail.
    const provider = new FakeProvider();
    provider.expiresIn = 60; // 60s flow window
    let rejectPersist!: (err: Error) => void;
    const persistPromise = new Promise<{ expiresAt?: number }>(
      (_resolve, reject) => {
        rejectPersist = reject;
      },
    );
    provider.pollScript = [
      {
        kind: 'success',
        persist: () => persistPromise,
      },
    ];
    const built = buildRegistry(provider);
    const { registry, env, events, auditLines } = built;
    try {
      const { view } = await registry.start({ providerId: 'qwen-oauth' });
      // Drive first poll → success → persist begins.
      env.clock.tick(DEVICE_FLOW_DEFAULT_INTERVAL_MS + 1);
      env.scheduler.flushDue(env.clock.now);
      await flushAsync();
      // Advance past `expiresAt` (60s) WHILE persist is still pending.
      env.clock.tick(120_000);
      // Now resolve persist with rejection — non-cancel disk error.
      rejectPersist(new Error('ENOSPC: no space left'));
      await flushAsync();
      const snapshot = registry.get(view.deviceFlowId);
      expect(snapshot?.status).toBe('error');
      expect(snapshot?.errorKind).toBe('persist_failed');
      // Audit hint preserves the past-expiry timing detail for
      // operator visibility (per fold-in 9 #13).
      const failedAudit = auditLines.find(
        (line) =>
          line['status'] === 'failed' &&
          line['errorKind'] === 'persist_failed' &&
          typeof line['hint'] === 'string' &&
          (line['hint'] as string).startsWith(
            'persist_also_failed_past_expiry',
          ),
      );
      expect(failedAudit).toBeDefined();
      // Critical: no `expired_token` classification anywhere.
      expect(
        events.some(
          (e) =>
            e.emission.type === 'failed' &&
            e.emission.data.errorKind === 'expired_token',
        ),
      ).toBe(false);
    } finally {
      registry.dispose();
    }
  });
});

describe('DeviceFlowRegistry — cancel', () => {
  it('cancels a pending flow, emits cancelled, idempotent on terminal', async () => {
    const provider = new FakeProvider();
    const built = buildRegistry(provider);
    const { registry, events } = built;
    try {
      const { view: started } = await registry.start({
        providerId: 'qwen-oauth',
      });

      const result = registry.cancel(started.deviceFlowId, 'client-X');
      expect(result).toEqual({ alreadyTerminal: false });
      const cancelled = events.find((e) => e.emission.type === 'cancelled');
      expect(cancelled?.clientId).toBe('client-X');

      // Second cancel is a no-op (no second event).
      const second = registry.cancel(started.deviceFlowId, 'client-Y');
      expect(second).toEqual({ alreadyTerminal: true });
      expect(
        events.filter((e) => e.emission.type === 'cancelled'),
      ).toHaveLength(1);
    } finally {
      registry.dispose();
    }
  });

  it('returns undefined for unknown id', async () => {
    const provider = new FakeProvider();
    const built = buildRegistry(provider);
    try {
      expect(built.registry.cancel('nonexistent', 'client-X')).toBeUndefined();
    } finally {
      built.registry.dispose();
    }
  });
});

describe('DeviceFlowRegistry — dispose', () => {
  it('clears all pending poll handles and the sweeper interval', async () => {
    const provider = new FakeProvider();
    const built = buildRegistry(provider);
    const { registry, env } = built;
    await registry.start({ providerId: 'qwen-oauth' });
    expect(env.scheduler.callbacks.some((c) => !c.cancelled)).toBe(true);
    expect(env.scheduler.intervals.some((i) => !i.cancelled)).toBe(true);
    registry.dispose();
    expect(env.scheduler.callbacks.every((c) => c.cancelled)).toBe(true);
    expect(env.scheduler.intervals.every((i) => i.cancelled)).toBe(true);
    expect(registry.listPending()).toHaveLength(0);
  });
});

function runSweepers(env: {
  clock: FakeClock;
  scheduler: FakeScheduler;
}): void {
  for (const interval of env.scheduler.intervals) {
    if (!interval.cancelled) interval.cb();
  }
}

async function flushAsync(): Promise<void> {
  // Five microtask flushes cover the longest synchronous chain inside
  // `runPollTick`: `await provider.poll` → `await result.persist` →
  // a few intermediate state-transition + publish microtasks. Five is
  // enough headroom while still finishing in <1ms wall-clock.
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}
