/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Device-flow authorization registry for `qwen serve` (issue #4175 Wave 4
 * PR 21). The registry brokers an OAuth 2.0 Device Authorization Grant
 * (RFC 8628) initiated through `POST /workspace/auth/device-flow` so a
 * remote SDK client can ask the daemon to log in. Tokens land on the
 * **daemon** filesystem, not the client — the client only displays the
 * verification URL + user code.
 *
 * Key contracts (locked in `notes/pr21-design.md` §2):
 *   - per-`providerId` singleton (idempotent take-over for repeat POSTs)
 *   - workspace-wide cap of 4 active flows (abuse defense)
 *   - terminal entries kept for `TERMINAL_GRACE_MS` so SDK reconnects can
 *     still observe the result via GET
 *   - secrets (`device_code`, PKCE verifier) never appear in HTTP bodies,
 *     events, or logs — wrapped in a `BrandedSecret` whose `toJSON` returns
 *     `'[redacted]'`
 *   - polling state is owned by the daemon; SDK liveness is irrelevant
 */

import { randomUUID } from 'node:crypto';

export const DEVICE_FLOW_DEFAULT_INTERVAL_MS = 5_000;
export const DEVICE_FLOW_TERMINAL_GRACE_MS = 5 * 60_000;
export const DEVICE_FLOW_SWEEP_INTERVAL_MS = 30_000;
export const DEVICE_FLOW_MAX_CONCURRENT = 4;
export const DEVICE_FLOW_SLOW_DOWN_BUMP_MS = 5_000;

export type DeviceFlowProviderId = 'qwen-oauth';
export const DEVICE_FLOW_SUPPORTED_PROVIDERS: readonly DeviceFlowProviderId[] =
  ['qwen-oauth'];

export type DeviceFlowStatus =
  | 'pending'
  | 'authorized'
  | 'expired'
  | 'error'
  | 'cancelled';

/**
 * Terminal error classifications surfaced on `auth_device_flow_failed`.
 *
 * RFC 8628 §3.5 defines the upstream error codes for the polling
 * endpoint; the daemon adds one daemon-internal kind (`persist_failed`)
 * for the disk-write phase. Keep these mutually exclusive — a
 * mis-classification (e.g. routing a network error into
 * `invalid_grant`) drives operators toward the wrong remediation.
 */
export type DeviceFlowErrorKind =
  /** RFC 8628: device_code has aged out (`expires_in` elapsed
   *  upstream) before user authorization. Recovery: re-issue
   *  `client.auth.start`; daemon also surfaces this kind on its own
   *  time-based sweep when the entry's `expiresAt` passes. */
  | 'expired_token'
  /** RFC 8628: user explicitly rejected the authorization at the
   *  IdP page. Recovery: re-issue with consent, or surface the
   *  refusal back to the human. */
  | 'access_denied'
  /** RFC 8628: protocol-level violation — `device_code` /
   *  `client_id` / PKCE verifier didn't validate. Treat as a
   *  programmer error in the daemon's flow construction (the user
   *  can't fix this themselves). */
  | 'invalid_grant'
  /** Catch-all for IdP-side failures that don't map to an RFC 8628
   *  code: network errors, malformed JSON, 5xx responses, unknown
   *  error codes. Distinguished from `persist_failed` by the LOCATION
   *  of the failure (upstream HTTP vs daemon-local disk). */
  | 'upstream_error'
  /** Daemon-local: the IdP exchange succeeded, but the daemon could
   *  not durably store the credentials (EACCES, EROFS, ENOSPC, etc.).
   *  Distinct from `upstream_error` so operators can route remediation
   *  to disk / permissions rather than chasing an IdP outage. The
   *  `device_code` was consumed upstream, so the user must
   *  `client.auth.start` again after fixing the underlying disk
   *  condition. */
  | 'persist_failed';

/**
 * Phantom-branded opaque container for material that must never escape the
 * registry boundary into HTTP responses, audit logs, or daemon events.
 *
 * **Why a frozen plain object, not `new String(value)`:** an earlier draft
 * used a `String` wrapper with `toJSON` / `toString` overrides. Empirical
 * test (and code-review pass): `"x=" + new String("foo")` evaluates to
 * `"x=foo"` because `+` coerces via `Symbol.toPrimitive` → `valueOf` (which
 * the `String` wrapper inherits and returns the raw primitive), NOT
 * `toString`. Template literals (`${secret}`) take the same path. So a
 * future commit that templated a `BrandedSecret<string>` into a log line
 * would silently leak the upstream device_code into stderr / journald.
 *
 * The current shape is a frozen plain object whose only string-coercion
 * paths (`toString`, `toJSON`, `Symbol.toPrimitive`) all return
 * `'[redacted]'`. The actual primitive is held in a module-level
 * `WeakMap`, retrievable only via `revealSecret`. Brand uses a `unique
 * symbol` so other modules can't structurally satisfy it.
 *
 * Misuse paths and what they produce:
 *   `JSON.stringify({s: secret})` → `'{"s":"[redacted]"}'`
 *   `String(secret)`              → `'[redacted]'`
 *   `'x=' + secret`               → `'x=[redacted]'`
 *   `` `s=${secret}` ``           → `'s=[redacted]'`
 *   `secret.length`               → undefined (no String prototype)
 *   `+secret`                     → NaN
 *   `revealSecret(secret)`        → the original primitive (only path)
 */
const SECRET_BRAND: unique symbol = Symbol('DeviceFlowSecret');

export interface BrandedSecret<T extends string = string> {
  readonly [SECRET_BRAND]: true;
  /** All four string-coercion hooks return `'[redacted]'` so accidental
   *  serialization / interpolation cannot leak the underlying primitive. */
  toString(): '[redacted]';
  toJSON(): '[redacted]';
  [Symbol.toPrimitive](): '[redacted]';
  /** Phantom marker preserving the literal type at the type level so
   *  `BrandedSecret<'qwen-oauth'>` is distinguishable from
   *  `BrandedSecret<string>` when a caller wants a narrower brand. */
  readonly _phantom?: T;
}

const SECRETS = new WeakMap<BrandedSecret<string>, string>();

export function brandSecret<T extends string>(value: T): BrandedSecret<T> {
  const wrapper: BrandedSecret<T> = Object.freeze({
    [SECRET_BRAND]: true as const,
    toString: () => '[redacted]' as const,
    toJSON: () => '[redacted]' as const,
    [Symbol.toPrimitive]: () => '[redacted]' as const,
  });
  SECRETS.set(wrapper, value);
  return wrapper;
}

/**
 * Reveal a branded secret. Callers must NOT pass the result back to event
 * emitters, response bodies, or stderr without explicit redaction. The
 * `unsafeReveal_` naming is intentional: greppable in code review, easy
 * to allowlist in lint rules, hard to invoke by accident.
 */
export function revealSecret<T extends string>(secret: BrandedSecret<T>): T {
  const value = SECRETS.get(secret);
  if (value === undefined) {
    // The earlier message claimed "secret has been GC-evicted", but a
    // `WeakMap` only evicts entries when the KEY object becomes
    // unreachable — and if that happened, the caller couldn't hold a
    // reference to pass in here. So the only path to `undefined` is
    // an argument that was never registered (e.g. forged structural
    // shape, mistakenly serialized + reparsed object that retained
    // the public surface but lost the WeakMap binding).
    throw new Error(
      'revealSecret: argument is not a BrandedSecret (was never registered, or its WeakMap binding was lost via serialization)',
    );
  }
  return value as T;
}

export interface DeviceFlowStartResult {
  deviceCode: BrandedSecret<string>;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  /** RFC 8628 §3.2 `expires_in` (seconds). */
  expiresIn: number;
  /** Initial polling interval in seconds. RFC 8628 default = 5. */
  interval?: number;
  pkceVerifier?: BrandedSecret<string>;
}

export type DeviceFlowPollResult =
  | { kind: 'pending' }
  | { kind: 'slow_down' }
  | {
      kind: 'success';
      /** The provider persists credentials and returns metadata for the
       *  `auth_device_flow_authorized` event. */
      persist(): Promise<{ expiresAt?: number; accountAlias?: string }>;
    }
  | {
      kind: 'error';
      errorKind: DeviceFlowErrorKind;
      hint?: string;
    };

export interface DeviceFlowProvider {
  readonly providerId: DeviceFlowProviderId;
  start(opts: { signal: AbortSignal }): Promise<DeviceFlowStartResult>;
  /**
   * Poll the upstream IdP for the user's authorization decision. The
   * `signal` lets the registry abort an in-flight poll on `cancel()`
   * or `dispose()` so the daemon doesn't keep consuming `device_code`
   * quota after it's logically given up. Providers that pass `signal`
   * to their `fetch` get cleanest tear-down; those that ignore it
   * still see the post-`await` guard suppress the resolved frame.
   */
  poll(
    state: {
      deviceCode: BrandedSecret<string>;
      pkceVerifier?: BrandedSecret<string>;
    },
    opts: { signal: AbortSignal },
  ): Promise<DeviceFlowPollResult>;
}

/** Public, redacted view of a flow returned by GET /workspace/auth/device-flow/:id. */
export interface DeviceFlowPublicView {
  deviceFlowId: string;
  providerId: DeviceFlowProviderId;
  status: DeviceFlowStatus;
  errorKind?: DeviceFlowErrorKind;
  hint?: string;
  /** Pending only: redisplayed on reconnect so the SDK can re-render the
   *  user_code prompt without persisting it client-side. Terminal entries
   *  drop these. */
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresAt?: number;
  intervalMs?: number;
  lastPolledAt?: number;
  createdAt: number;
  initiatorClientId?: string;
}

/** Outbound event-payload shapes (mirrors SDK `DaemonAuth*` data types). */
export type DeviceFlowEventEmission =
  | {
      type: 'started';
      data: {
        deviceFlowId: string;
        providerId: DeviceFlowProviderId;
        expiresAt: number;
      };
    }
  | { type: 'throttled'; data: { deviceFlowId: string; intervalMs: number } }
  | {
      type: 'authorized';
      data: {
        deviceFlowId: string;
        providerId: DeviceFlowProviderId;
        expiresAt?: number;
        accountAlias?: string;
      };
    }
  | {
      type: 'failed';
      data: {
        deviceFlowId: string;
        errorKind: DeviceFlowErrorKind;
        hint?: string;
      };
    }
  | { type: 'cancelled'; data: { deviceFlowId: string } };

export interface DeviceFlowEventSink {
  /** Best-effort fan-out. The sink swallows its own internal errors so a
   *  misbehaving subscriber can't poison the registry's state machine. */
  publish(emission: DeviceFlowEventEmission, originatorClientId?: string): void;
}

export interface DeviceFlowAuditSink {
  /** Structured stderr audit breadcrumb. `mutate({strict:true})` doesn't
   *  carry an audit hook; PR 21 §8 #9 mandates a parallel log channel. */
  record(line: {
    deviceFlowId: string;
    providerId: DeviceFlowProviderId;
    clientId?: string;
    /**
     * `lost_success` is the audit-only branch: the IdP minted credentials
     * but the entry transitioned (cancel / dispose) while we awaited
     * `provider.persist()`. The `device_code` is now consumed upstream
     * (RFC 8628 single-use), so the operator should expect a follow-up
     * `auth.start` from the same client.
     */
    status:
      | 'started'
      | 'authorized'
      | 'failed'
      | 'cancelled'
      | 'expired'
      | 'lost_success';
    errorKind?: DeviceFlowErrorKind;
    expiresInMs?: number;
  }): void;
}

interface DeviceFlowEntry {
  deviceFlowId: string;
  providerId: DeviceFlowProviderId;
  deviceCode?: BrandedSecret<string>;
  pkceVerifier?: BrandedSecret<string>;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalMs: number;
  expiresAt: number;
  status: DeviceFlowStatus;
  errorKind?: DeviceFlowErrorKind;
  hint?: string;
  initiatorClientId?: string;
  lastPolledAt?: number;
  createdAt: number;
  terminalAt?: number;
  pollHandle?: ReturnType<typeof setTimeout>;
  cancelController: AbortController;
}

export interface DeviceFlowRegistryDeps {
  events: DeviceFlowEventSink;
  audit?: DeviceFlowAuditSink;
  /** Provider lookup. Tests stub a fake provider; production wires the
   *  Qwen-OAuth implementation. */
  resolveProvider(
    providerId: DeviceFlowProviderId,
  ): DeviceFlowProvider | undefined;
  /** Inject a clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Inject a scheduler. Defaults to `setTimeout`. */
  schedule?: (ms: number, cb: () => void) => ReturnType<typeof setTimeout>;
  /** Inject a sweeper interval. Defaults to `setInterval`. */
  scheduleInterval?: (
    ms: number,
    cb: () => void,
  ) => ReturnType<typeof setInterval>;
  clearScheduled?: (handle: ReturnType<typeof setTimeout>) => void;
  clearScheduledInterval?: (handle: ReturnType<typeof setInterval>) => void;
}

export interface DeviceFlowStartParams {
  providerId: DeviceFlowProviderId;
  initiatorClientId?: string;
}

export class UnsupportedDeviceFlowProviderError extends Error {
  readonly code = 'unsupported_provider';
  constructor(providerId: string) {
    super(`Unsupported device-flow provider: ${providerId}`);
    this.name = 'UnsupportedDeviceFlowProviderError';
  }
}

export class TooManyActiveDeviceFlowsError extends Error {
  readonly code = 'too_many_active_flows';
  constructor() {
    super(
      `Too many active device-flow attempts. Cancel one of the existing ` +
        `flows or wait for them to expire.`,
    );
    this.name = 'TooManyActiveDeviceFlowsError';
  }
}

export class DeviceFlowNotFoundError extends Error {
  readonly code = 'device_flow_not_found';
  constructor(deviceFlowId: string) {
    super(`Device-flow ${deviceFlowId} not found`);
    this.name = 'DeviceFlowNotFoundError';
  }
}

export class UpstreamDeviceFlowError extends Error {
  readonly code = 'upstream_error';
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamDeviceFlowError';
  }
}

/**
 * In-memory device-flow state holder. Single instance per daemon.
 *
 * Lifecycle: `runQwenServe` constructs one, hands it to `createServeApp`,
 * and calls `dispose()` during shutdown drain so every pending poll timer
 * is cancelled before the process exits.
 */
export class DeviceFlowRegistry {
  private readonly byId = new Map<string, DeviceFlowEntry>();
  private readonly byProvider = new Map<
    DeviceFlowProviderId,
    DeviceFlowEntry
  >();
  /**
   * Coalesces concurrent `start()` calls for the same `providerId`. Two
   * SDK clients posting `POST /workspace/auth/device-flow` in parallel
   * would otherwise both pass the "no existing pending entry" check,
   * each call `provider.start()` (a real IdP round-trip), and one's
   * write to `byProvider` would clobber the other — leaving an orphan
   * `byId` entry with a still-running poll timer that consumes IdP
   * quota for nothing. Mirrors `SharedTokenManager`'s in-flight refresh
   * coalescing pattern.
   */
  private readonly inFlightStarts = new Map<
    DeviceFlowProviderId,
    Promise<{ view: DeviceFlowPublicView; attached: boolean }>
  >();
  private sweeperHandle?: ReturnType<typeof setInterval>;
  private disposed = false;
  private readonly now: () => number;
  private readonly schedule: (
    ms: number,
    cb: () => void,
  ) => ReturnType<typeof setTimeout>;
  private readonly scheduleInterval: (
    ms: number,
    cb: () => void,
  ) => ReturnType<typeof setInterval>;
  private readonly clearScheduled: (
    handle: ReturnType<typeof setTimeout>,
  ) => void;
  private readonly clearScheduledInterval: (
    handle: ReturnType<typeof setInterval>,
  ) => void;

  constructor(private readonly deps: DeviceFlowRegistryDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.schedule = deps.schedule ?? ((ms, cb) => setTimeout(cb, ms));
    this.scheduleInterval =
      deps.scheduleInterval ?? ((ms, cb) => setInterval(cb, ms));
    this.clearScheduled = deps.clearScheduled ?? ((h) => clearTimeout(h));
    this.clearScheduledInterval =
      deps.clearScheduledInterval ?? ((h) => clearInterval(h));
    // Sweeper is best-effort GC; never block process exit waiting for it.
    this.sweeperHandle = this.scheduleInterval(
      DEVICE_FLOW_SWEEP_INTERVAL_MS,
      () => this.sweep(),
    );
    if (
      this.sweeperHandle &&
      typeof (this.sweeperHandle as { unref?: () => void }).unref === 'function'
    ) {
      (this.sweeperHandle as unknown as { unref(): void }).unref();
    }
  }

  /**
   * Start a new device flow OR — under per-provider singleton semantics —
   * return the existing pending entry (`attached: true`). The take-over
   * branch deliberately does NOT re-call `provider.start()`; making the
   * second POST a no-op (rather than a fresh IdP request) is the property
   * that lets a reconnecting SDK pick up an in-flight login without
   * burning IdP quota.
   */
  async start(
    params: DeviceFlowStartParams,
  ): Promise<{ view: DeviceFlowPublicView; attached: boolean }> {
    if (this.disposed) {
      throw new Error('DeviceFlowRegistry disposed');
    }
    const provider = this.deps.resolveProvider(params.providerId);
    if (!provider) {
      throw new UnsupportedDeviceFlowProviderError(params.providerId);
    }
    // Fast-path: an existing pending entry → idempotent take-over.
    const existing = this.byProvider.get(params.providerId);
    if (existing && existing.status === 'pending') {
      return { view: toPublicView(existing), attached: true };
    }
    // Coalesce concurrent fresh starts for the same providerId.
    const inFlight = this.inFlightStarts.get(params.providerId);
    if (inFlight) {
      const result = await inFlight;
      // The first start created an entry; this caller is a take-over of
      // the just-created flow (NOT a fresh IdP request). Recompute the
      // shape so the second caller's `attached: true` is honest.
      return { view: result.view, attached: true };
    }
    if (this.countActive() >= DEVICE_FLOW_MAX_CONCURRENT) {
      throw new TooManyActiveDeviceFlowsError();
    }
    const promise = this.doStart(params, provider);
    this.inFlightStarts.set(params.providerId, promise);
    try {
      return await promise;
    } finally {
      // Whether `doStart` resolved or rejected, the in-flight slot
      // releases so a follow-up caller observes the freshly-installed
      // entry (or, on reject, can try again from scratch).
      if (this.inFlightStarts.get(params.providerId) === promise) {
        this.inFlightStarts.delete(params.providerId);
      }
    }
  }

  private async doStart(
    params: DeviceFlowStartParams,
    provider: DeviceFlowProvider,
  ): Promise<{ view: DeviceFlowPublicView; attached: boolean }> {
    const cancelController = new AbortController();
    const startResult = await provider.start({
      signal: cancelController.signal,
    });
    const expiresAt = this.now() + Math.max(0, startResult.expiresIn) * 1000;
    const intervalMs = Math.max(
      1_000,
      (startResult.interval ?? DEVICE_FLOW_DEFAULT_INTERVAL_MS / 1000) * 1000,
    );
    const entry: DeviceFlowEntry = {
      deviceFlowId: randomUUID(),
      providerId: params.providerId,
      deviceCode: startResult.deviceCode,
      pkceVerifier: startResult.pkceVerifier,
      userCode: startResult.userCode,
      verificationUri: startResult.verificationUri,
      verificationUriComplete: startResult.verificationUriComplete,
      intervalMs,
      expiresAt,
      status: 'pending',
      initiatorClientId: params.initiatorClientId,
      createdAt: this.now(),
      cancelController,
    };
    this.byId.set(entry.deviceFlowId, entry);
    this.byProvider.set(entry.providerId, entry);
    this.deps.events.publish(
      {
        type: 'started',
        data: {
          deviceFlowId: entry.deviceFlowId,
          providerId: entry.providerId,
          expiresAt: entry.expiresAt,
        },
      },
      entry.initiatorClientId,
    );
    this.deps.audit?.record({
      deviceFlowId: entry.deviceFlowId,
      providerId: entry.providerId,
      clientId: entry.initiatorClientId,
      status: 'started',
      expiresInMs: entry.expiresAt - this.now(),
    });
    this.schedulePoll(entry, provider);
    return { view: toPublicView(entry), attached: false };
  }

  get(deviceFlowId: string): DeviceFlowPublicView | undefined {
    const entry = this.byId.get(deviceFlowId);
    if (!entry) return undefined;
    return toPublicView(entry);
  }

  /**
   * Cancel a pending flow. Idempotent on terminal entries (returns
   * `{ alreadyTerminal: true }` and does NOT re-emit `cancelled` —
   * RFC 7231 §4.3.5: DELETE may still be a 204 even when nothing was
   * removed). Returns `undefined` for unknown ids so the route layer
   * can map it to 404.
   */
  cancel(
    deviceFlowId: string,
    cancellerClientId?: string,
  ): { alreadyTerminal: boolean } | undefined {
    const entry = this.byId.get(deviceFlowId);
    if (!entry) return undefined;
    if (!this.transitionTerminal(entry, 'cancelled')) {
      return { alreadyTerminal: true };
    }
    this.deps.events.publish(
      {
        type: 'cancelled',
        data: { deviceFlowId: entry.deviceFlowId },
      },
      cancellerClientId,
    );
    this.deps.audit?.record({
      deviceFlowId: entry.deviceFlowId,
      providerId: entry.providerId,
      clientId: cancellerClientId,
      status: 'cancelled',
    });
    return { alreadyTerminal: false };
  }

  /** Active = pending; terminal entries in grace don't count toward the cap. */
  private countActive(): number {
    let n = 0;
    for (const entry of this.byProvider.values()) {
      if (entry.status === 'pending') n += 1;
    }
    return n;
  }

  private schedulePoll(entry: DeviceFlowEntry, provider: DeviceFlowProvider) {
    if (entry.status !== 'pending') return;
    if (entry.deviceCode === undefined) return;
    if (this.disposed) return;
    entry.pollHandle = this.schedule(entry.intervalMs, () => {
      // Fire-and-forget; the poll handler does its own error containment.
      void this.runPollTick(entry, provider);
    });
    if (
      entry.pollHandle &&
      typeof (entry.pollHandle as { unref?: () => void }).unref === 'function'
    ) {
      (entry.pollHandle as unknown as { unref(): void }).unref();
    }
  }

  private async runPollTick(
    entry: DeviceFlowEntry,
    provider: DeviceFlowProvider,
  ): Promise<void> {
    if (entry.status !== 'pending') return;
    if (this.disposed) return;
    if (entry.deviceCode === undefined) return;
    const now = this.now();
    if (now >= entry.expiresAt) {
      if (this.transitionTerminal(entry, 'expired', 'expired_token')) {
        this.deps.events.publish(
          {
            type: 'failed',
            data: {
              deviceFlowId: entry.deviceFlowId,
              errorKind: 'expired_token',
              hint: 'device-flow expired without authorization',
            },
          },
          entry.initiatorClientId,
        );
        this.deps.audit?.record({
          deviceFlowId: entry.deviceFlowId,
          providerId: entry.providerId,
          clientId: entry.initiatorClientId,
          status: 'expired',
          errorKind: 'expired_token',
        });
      }
      return;
    }
    entry.lastPolledAt = now;
    let result: DeviceFlowPollResult;
    try {
      result = await provider.poll(
        {
          deviceCode: entry.deviceCode,
          pkceVerifier: entry.pkceVerifier,
        },
        { signal: entry.cancelController.signal },
      );
    } catch (err: unknown) {
      result = {
        kind: 'error',
        errorKind: 'upstream_error',
        hint: err instanceof Error ? err.message : String(err),
      };
    }
    if (entry.status !== 'pending') return;
    switch (result.kind) {
      case 'pending':
        this.schedulePoll(entry, provider);
        return;
      case 'slow_down':
        entry.intervalMs += DEVICE_FLOW_SLOW_DOWN_BUMP_MS;
        this.deps.events.publish(
          {
            type: 'throttled',
            data: {
              deviceFlowId: entry.deviceFlowId,
              intervalMs: entry.intervalMs,
            },
          },
          entry.initiatorClientId,
        );
        this.schedulePoll(entry, provider);
        return;
      case 'success': {
        let metadata: { expiresAt?: number; accountAlias?: string } = {};
        try {
          metadata = await result.persist();
        } catch (err: unknown) {
          if (this.transitionTerminal(entry, 'error', 'persist_failed')) {
            this.deps.events.publish(
              {
                type: 'failed',
                data: {
                  deviceFlowId: entry.deviceFlowId,
                  errorKind: 'persist_failed',
                  hint:
                    err instanceof Error
                      ? `persist failed: ${err.message}`
                      : 'persist failed',
                },
              },
              entry.initiatorClientId,
            );
            this.deps.audit?.record({
              deviceFlowId: entry.deviceFlowId,
              providerId: entry.providerId,
              clientId: entry.initiatorClientId,
              status: 'failed',
              errorKind: 'persist_failed',
            });
          }
          return;
        }
        if (this.transitionTerminal(entry, 'authorized')) {
          this.deps.events.publish(
            {
              type: 'authorized',
              data: {
                deviceFlowId: entry.deviceFlowId,
                providerId: entry.providerId,
                expiresAt: metadata.expiresAt,
                accountAlias: metadata.accountAlias,
              },
            },
            entry.initiatorClientId,
          );
          this.deps.audit?.record({
            deviceFlowId: entry.deviceFlowId,
            providerId: entry.providerId,
            clientId: entry.initiatorClientId,
            status: 'authorized',
          });
        } else {
          // Lost-success branch: poll succeeded but the entry transitioned
          // (cancel / dispose) while we awaited persist. The IdP marked
          // `device_code` as consumed (RFC 8628 single-use) — the user
          // must `client.auth.start` again to acquire a fresh one. Audit
          // the loss so the operator can correlate "user re-auth'd
          // immediately after cancel" with this branch.
          this.deps.audit?.record({
            deviceFlowId: entry.deviceFlowId,
            providerId: entry.providerId,
            clientId: entry.initiatorClientId,
            status: 'lost_success',
          });
        }
        return;
      }
      case 'error':
        entry.hint = result.hint;
        if (this.transitionTerminal(entry, 'error', result.errorKind)) {
          this.deps.events.publish(
            {
              type: 'failed',
              data: {
                deviceFlowId: entry.deviceFlowId,
                errorKind: result.errorKind,
                hint: result.hint,
              },
            },
            entry.initiatorClientId,
          );
          this.deps.audit?.record({
            deviceFlowId: entry.deviceFlowId,
            providerId: entry.providerId,
            clientId: entry.initiatorClientId,
            status: 'failed',
            errorKind: result.errorKind,
          });
        }
        return;
      default: {
        const _exhaustive: never = result;
        void _exhaustive;
      }
    }
  }

  /**
   * Move a pending entry to terminal state. Returns **`true` exactly once**
   * — the call site that successfully drove the transition. Subsequent
   * calls (sweeper × poll-tick race, double cancel, etc.) return `false`
   * so the caller can suppress duplicate event publish + audit log.
   *
   * On a successful transition:
   *   1. clears any pending poll timer
   *   2. wipes the secret material from `entry.deviceCode` /
   *      `entry.pkceVerifier`. The PRIMARY guard against secret leaks
   *      is the `entry.status !== 'pending'` check at the top of
   *      `runPollTick` — a stale timer that managed to fire post-clear
   *      bails out before touching the entry. Secret-clearing here is
   *      DEFENSE IN DEPTH: even if a future refactor weakens the
   *      status guard, the registry's in-memory state can no longer
   *      hand out the upstream `device_code` to a late-arriving
   *      logger / serializer.
   *   3. records `terminalAt` for the sweeper to evict after grace
   *   4. removes the per-provider singleton index so a new POST creates
   *      a fresh flow instead of taking over the terminal one
   */
  private transitionTerminal(
    entry: DeviceFlowEntry,
    status: Exclude<DeviceFlowStatus, 'pending'>,
    errorKind?: DeviceFlowErrorKind,
  ): boolean {
    if (entry.status !== 'pending') return false;
    entry.status = status;
    if (errorKind) entry.errorKind = errorKind;
    entry.terminalAt = this.now();
    if (entry.pollHandle) {
      this.clearScheduled(entry.pollHandle);
      entry.pollHandle = undefined;
    }
    entry.deviceCode = undefined;
    entry.pkceVerifier = undefined;
    try {
      entry.cancelController.abort();
    } catch {
      // best-effort
    }
    if (this.byProvider.get(entry.providerId) === entry) {
      this.byProvider.delete(entry.providerId);
    }
    return true;
  }

  /**
   * Periodic sweeper:
   *   (a) pending entries past `expiresAt` get a synthetic timeout event
   *       (the polling loop also handles this on its next tick, but a
   *       wedged poll path should not block expiry)
   *   (b) terminal entries past their grace window get evicted entirely
   */
  private sweep() {
    if (this.disposed) return;
    const now = this.now();
    for (const entry of [...this.byId.values()]) {
      if (entry.status === 'pending' && now >= entry.expiresAt) {
        if (this.transitionTerminal(entry, 'expired', 'expired_token')) {
          this.deps.events.publish(
            {
              type: 'failed',
              data: {
                deviceFlowId: entry.deviceFlowId,
                errorKind: 'expired_token',
                hint: 'device-flow expired without authorization',
              },
            },
            entry.initiatorClientId,
          );
          this.deps.audit?.record({
            deviceFlowId: entry.deviceFlowId,
            providerId: entry.providerId,
            clientId: entry.initiatorClientId,
            status: 'expired',
            errorKind: 'expired_token',
          });
        }
        continue;
      }
      if (
        entry.status !== 'pending' &&
        entry.terminalAt !== undefined &&
        now - entry.terminalAt >= DEVICE_FLOW_TERMINAL_GRACE_MS
      ) {
        this.byId.delete(entry.deviceFlowId);
        // byProvider was cleared at terminal transition; nothing else to do.
      }
    }
  }

  /**
   * For diagnostics / GET /workspace/auth/status: report only pending
   * flows. Terminal entries are an implementation detail of the SDK
   * reconnect path and shouldn't be enumerated to all bearer-token
   * holders.
   */
  listPending(): DeviceFlowPublicView[] {
    const out: DeviceFlowPublicView[] = [];
    for (const entry of this.byId.values()) {
      if (entry.status === 'pending') out.push(toPublicView(entry));
    }
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sweeperHandle) {
      this.clearScheduledInterval(this.sweeperHandle);
      this.sweeperHandle = undefined;
    }
    for (const entry of this.byId.values()) {
      if (entry.pollHandle) {
        this.clearScheduled(entry.pollHandle);
        entry.pollHandle = undefined;
      }
      try {
        entry.cancelController.abort();
      } catch {
        // best-effort
      }
      entry.deviceCode = undefined;
      entry.pkceVerifier = undefined;
    }
    this.byId.clear();
    this.byProvider.clear();
  }
}

function toPublicView(entry: DeviceFlowEntry): DeviceFlowPublicView {
  const base: DeviceFlowPublicView = {
    deviceFlowId: entry.deviceFlowId,
    providerId: entry.providerId,
    status: entry.status,
    createdAt: entry.createdAt,
    initiatorClientId: entry.initiatorClientId,
  };
  if (entry.errorKind) base.errorKind = entry.errorKind;
  if (entry.hint) base.hint = entry.hint;
  if (entry.lastPolledAt !== undefined) base.lastPolledAt = entry.lastPolledAt;
  if (entry.status === 'pending') {
    base.userCode = entry.userCode;
    base.verificationUri = entry.verificationUri;
    base.verificationUriComplete = entry.verificationUriComplete;
    base.expiresAt = entry.expiresAt;
    base.intervalMs = entry.intervalMs;
  }
  return base;
}
