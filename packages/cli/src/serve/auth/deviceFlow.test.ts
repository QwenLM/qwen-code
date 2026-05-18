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
  DEVICE_FLOW_SLOW_DOWN_BUMP_MS,
  DEVICE_FLOW_START_TIMEOUT_MS,
  DEVICE_FLOW_TERMINAL_GRACE_MS,
  DeviceFlowRegistry,
  TooManyActiveDeviceFlowsError,
  UnsupportedDeviceFlowProviderError,
  type DeviceFlowEventEmission,
  type DeviceFlowEventSink,
  type DeviceFlowPollResult,
  type DeviceFlowProvider,
  type DeviceFlowProviderId,
} from './deviceFlow.js';

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
      fs.readFileSync(path.join(dir, 'deviceFlow.ts'), 'utf8'),
      fs.readFileSync(path.join(dir, 'qwenDeviceFlowProvider.ts'), 'utf8'),
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
