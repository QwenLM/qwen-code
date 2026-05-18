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
/**
 * Hard ceiling on `provider.persist()`. A wedged disk I/O (NFS stall,
 * encrypted-volume contention) without this would leave a flow stuck
 * in `pending` until the sweeper catches the upstream `expires_in` —
 * potentially minutes. 30s is generous for a normal local FS write
 * but short enough that operators see disk problems quickly.
 * PR #4255 review C3.
 */
export const DEVICE_FLOW_PERSIST_TIMEOUT_MS = 30_000;
/**
 * Hard ceiling on `provider.start()`. A hung IdP (network partition,
 * unresponsive `requestDeviceAuthorization` endpoint) without this
 * would leave the per-`providerId` slot in `inFlightStarts` occupied
 * forever, blocking ALL subsequent `POST /workspace/auth/device-flow`
 * requests for the same provider until daemon restart. 30s matches
 * `DEVICE_FLOW_PERSIST_TIMEOUT_MS` and is well over typical IdP
 * round-trip times for `device/code` (sub-second on a healthy IdP).
 * PR #4255 review fold-in 3 (#2).
 */
export const DEVICE_FLOW_START_TIMEOUT_MS = 30_000;
/**
 * Hard ceiling on a single `provider.poll()` tick. Symmetric with
 * `DEVICE_FLOW_START_TIMEOUT_MS` and `DEVICE_FLOW_PERSIST_TIMEOUT_MS`,
 * which already bound their respective phases. PR #4255 follow-up
 * review thread (deepseek-v4-pro): a hung IdP token endpoint (TCP
 * established, no response) without this would block the registry's
 * poll-tick promise indefinitely. The entry's `cancelController.signal`
 * is the cooperative path; this race makes the timeout authoritative
 * regardless of provider cooperation. The sweeper would still evict
 * the entry once `expiresAt` is past, but until then the per-provider
 * singleton stays occupied with no other recovery short of daemon
 * restart. 30s is the same generosity the start/persist phases use
 * and is well over a healthy IdP's polling round-trip.
 */
export const DEVICE_FLOW_POLL_TIMEOUT_MS = 30_000;
/**
 * Operator-safe upper bound on the IdP-provided `expires_in`. RFC
 * 8628 §6.1 calls 5–30 minutes "reasonable"; 1 hour is the practical
 * ceiling for any well-behaved IdP. PR #4255 fold-in 7 review thread
 * #3: `Number.isFinite + > 0` keeps NaN/Infinity out, but a malicious
 * or buggy IdP returning `1e12` still pins the per-provider singleton
 * for years and ties up an entry slot the entire time. Clamping
 * silently bounds the worst case to 1 hour — an IdP that genuinely
 * needs longer is not RFC 8628 compliant.
 */
export const DEVICE_FLOW_MAX_EXPIRES_IN_SEC = 60 * 60;
/**
 * Operator-safe lower bound on the IdP-provided `expires_in`.
 * Symmetric with `DEVICE_FLOW_MAX_EXPIRES_IN_SEC`. PR #4255 round-12
 * #5 (gpt-5.5 review Cy_ZF): a misbehaving / fuzzed IdP returning
 * `expires_in: 0.5` would produce `expiresAt = now() + 500 ms` —
 * the very first poll (clamped at `>=1 s`) would fire AFTER
 * `expiresAt` and the entry would expire before any user could
 * authorize. RFC 8628 §3.2 calls 5–30 minutes "reasonable"; sub-30 s
 * `expires_in` is effectively non-compliant. Floor lifts those
 * pathological values to 30 s so the user gets at least one
 * chance to complete the IdP page.
 */
export const DEVICE_FLOW_MIN_EXPIRES_IN_SEC = 30;
/**
 * Upper bound on the polling interval. RFC 8628's normal `interval`
 * + `slow_down` bumps live in the 5–30 s range; values past 60 s
 * indicate an IdP misbehaving (or, more likely, `1e12` from a
 * fuzzed/buggy response). Capping keeps `setTimeout` from being
 * scheduled with a value that Node's scheduler clamps to
 * `TIMEOUT_MAX` (≈24.8 d) — at which point the poll never fires
 * within the entry's `expiresAt` window. PR #4255 fold-in 7 review
 * thread #3.
 */
export const DEVICE_FLOW_MAX_INTERVAL_MS = 60_000;

// PR #4255 fold-in 6 review thread #2: derive the type from the
// supported-providers tuple so adding/removing a provider id
// requires touching exactly ONE site. The earlier shape (standalone
// union + `readonly DeviceFlowProviderId[]` annotation) let the
// type and the array drift apart silently. Mirrors the codebase's
// `SERVE_ERROR_KINDS` / `ServeErrorKind` pattern in `status.ts`.
export const DEVICE_FLOW_SUPPORTED_PROVIDERS = ['qwen-oauth'] as const;
export type DeviceFlowProviderId =
  (typeof DEVICE_FLOW_SUPPORTED_PROVIDERS)[number];

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
   *  condition.
   *
   *  @remarks
   *  **Lost-success / retry-after-persist-failed UX caveat.** When
   *  the failure originated from `provider.persist()` ignoring the
   *  registry's signal AND the underlying disk write later
   *  succeeded (PR #4255 fold-in 9 #7 — only reachable for
   *  non-conforming future providers; the Qwen provider honors
   *  signal end-to-end), the daemon emits
   *  `auth_device_flow_failed`/`persist_failed` to SSE while the
   *  credentials are silently on disk. A naive SDK retry (\"disk
   *  transient, try again\") will hit the IdP a second time with
   *  a fresh `device_code`, prompting the user a second time —
   *  but the FIRST credential set is already valid. If the second
   *  prompt times out without approval, the user is logged in
   *  (from the first lost-success persist) without realizing they
   *  retried.
   *
   *  Mitigations for SDK consumers writing retry logic:
   *  - Call `client.auth.getStatus()` (`GET /workspace/auth/status`)
   *    before re-prompting on `persist_failed`. If the daemon
   *    reports an active credential for the provider, the previous
   *    persist committed and a retry would be redundant.
   *  - Operators can grep daemon stderr / audit log for
   *    `lost_success_after_timeout` to detect occurrences of the
   *    inconsistency window. */
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
 * `WeakMap`, retrievable only via `unsafeRevealSecret`. Brand uses a `unique
 * symbol` so other modules can't structurally satisfy it.
 *
 * Misuse paths and what they produce:
 *   `JSON.stringify({s: secret})` → `'{"s":"[redacted]"}'`
 *   `String(secret)`              → `'[redacted]'`
 *   `'x=' + secret`               → `'x=[redacted]'`
 *   `` `s=${secret}` ``           → `'s=[redacted]'`
 *   `secret.length`               → undefined (no String prototype)
 *   `+secret`                     → NaN
 *   `unsafeRevealSecret(secret)`        → the original primitive (only path)
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
 * `unsafe`-prefixed name is intentional: greppable in code review, easy
 * to allowlist in lint rules (`no-restricted-imports` /
 * `no-restricted-syntax` keying off the identifier), and hard to
 * invoke by accident or muscle memory. PR #4255 fold-in 5 review
 * thread #2: renamed from `revealSecret` so the JSDoc-promised
 * "greppable" property is actually the case in the codebase.
 */
export function unsafeRevealSecret<T extends string>(
  secret: BrandedSecret<T>,
): T {
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
      'unsafeRevealSecret: argument is not a BrandedSecret (was never registered, or its WeakMap binding was lost via serialization)',
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
       *  `auth_device_flow_authorized` event. The registry passes its
       *  per-entry `cancelController.signal` so a slow disk I/O
       *  (NFS, encrypted volumes) honors `cancel()` / `dispose()`.
       *
       *  PR #4255 review (post-fold-in-2 redirection): the earlier
       *  `unpersist()` companion was removed. When `persist()` succeeds
       *  AND a cancel/dispose transitioned the entry mid-await, the
       *  registry now FORCES the entry to `authorized` and keeps the
       *  on-disk credentials. Rationale: the user already approved on
       *  the IdP page (RFC 8628 device_code is single-use), so the
       *  microsecond cancel race shouldn't waste their approval. The
       *  audit trail records the race for incident response.
       *
       *  @remarks
       *  **Provider-author contract — `signal` MUST be honored.** The
       *  registry races this promise against `DEVICE_FLOW_PERSIST_TIMEOUT_MS`
       *  (currently 30 s). When the timeout fires, the registry
       *  publishes `persist_failed` to SSE subscribers AND aborts
       *  `signal`. A non-cooperative provider that ignores `signal`
       *  and later commits credentials anyway leaves the daemon in a
       *  split-brain state: every SDK consumer sees `persist_failed`
       *  via SSE while the credentials are silently on disk. The
       *  registry detects this and emits a
       *  `lost_success_after_timeout` audit breadcrumb (PR #4255
       *  fold-in 9 #7), but it cannot rescue the SDK consumers'
       *  view. The contract is therefore: every fs / network call
       *  inside `persist` MUST take `signal` as input AND propagate
       *  it down to abortable primitives (`fs.writeFile`, `fetch`,
       *  etc.). `cacheQwenCredentials({signal})` in
       *  `qwenDeviceFlowProvider` is the canonical example. */
      persist(opts: { signal: AbortSignal }): Promise<{
        expiresAt?: number;
        accountAlias?: string;
      }>;
    }
  | {
      kind: 'error';
      errorKind: DeviceFlowErrorKind;
      hint?: string;
    };

export interface DeviceFlowProvider {
  readonly providerId: DeviceFlowProviderId;
  /**
   * Begin a device-authorization grant against the IdP. Same SSE-leak
   * sanitization rule as `poll()` applies to thrown error messages —
   * see `poll()` `@remarks` below.
   */
  start(opts: { signal: AbortSignal }): Promise<DeviceFlowStartResult>;
  /**
   * Poll the upstream IdP for the user's authorization decision. The
   * `signal` lets the registry abort an in-flight poll on `cancel()`
   * or `dispose()` so the daemon doesn't keep consuming `device_code`
   * quota after it's logically given up. Providers that pass `signal`
   * to their `fetch` get cleanest tear-down; those that ignore it
   * still see the post-`await` guard suppress the resolved frame.
   *
   * @remarks
   * **Provider-author contract — sanitize before throwing.** The
   * registry's `runPollTick` catch block forwards `err.message`
   * verbatim into the `auth_device_flow_failed` event's `hint`
   * field, which is workspace-broadcast over SSE to every subscriber
   * (and durably stored in the registry's terminal entry). A naive
   * provider that re-throws a `fetch` failure or upstream payload
   * untouched will leak: (a) full IdP response bodies (HTML error
   * pages from a reverse proxy / WAF can run into hundreds of
   * kilobytes), (b) infrastructure detail (internal hostnames, proxy
   * banners), (c) ANY embedded secret material the upstream
   * accidentally echoed.
   *
   * Two equally-correct paths for new providers:
   *   1. **Resolve to a typed `error` result** — return
   *      `{ kind: 'error', errorKind, hint }` with a *bounded
   *      static-or-pattern hint*. This is the preferred path; it
   *      keeps full structured-error fidelity and drops nothing.
   *   2. **Throw, but only with a sanitized `Error.message`** — if
   *      the implementation finds it more natural to throw,
   *      construct the thrown `Error` with a *short bounded sentence
   *      that contains no IdP body / banner / secret*. Send the raw
   *      detail through `writeStderrLine` for operator audit; the
   *      thrown `message` is the SSE-visible surface.
   *
   * `qwenDeviceFlowProvider` is the canonical example — see PR #4255
   * review S2 + fold-in 3 #9 + fold-in 5 #4 for the historical
   * regressions this contract prevents.
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
    status: 'started' | 'authorized' | 'failed' | 'cancelled' | 'expired';
    errorKind?: DeviceFlowErrorKind;
    expiresInMs?: number;
    /** Free-form audit detail. Used by the C4 lost-success rollback
     *  path to capture rollback failures without polluting the
     *  user-facing event hint. */
    hint?: string;
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
  /**
   * Most-recent client id observed on a take-over POST (per-provider
   * singleton). Initially `undefined`; populated only when a second
   * caller's `initiatorClientId` differs from `entry.initiatorClientId`.
   * Surfaced through the audit trail so incident response can see
   * "client A started this flow, client B took it over at 12:34" —
   * useful when two SDK processes race on the same Qwen account
   * across hosts. Event-routing still uses the original
   * `initiatorClientId` (events are workspace-broadcast; the
   * originator field is metadata, and changing it mid-flow would
   * break SDK reducers that key on it). PR #4255 fold-in 6 review
   * thread #6.
   */
  lastOriginatorClientId?: string;
  lastPolledAt?: number;
  createdAt: number;
  terminalAt?: number;
  pollHandle?: ReturnType<typeof setTimeout>;
  cancelController: AbortController;
  /**
   * `true` while `provider.persist()` is awaiting on disk I/O. While
   * set, `cancel()` and the sweeper SKIP transitioning + emitting —
   * only the persist resolution finalizes the terminal state. This
   * prevents the SDK-event-stream UX trap where direct subscribers
   * would see `auth_device_flow_cancelled` followed by
   * `auth_device_flow_authorized` for the same flow (reducer-state
   * converges correctly via last-write-wins, but imperative event
   * handlers — close-dialog / release-resource / log-telemetry —
   * race onto an unmounted UI). PR #4255 fold-in 5 review thread #1.
   */
  persistInFlight?: boolean;
  /**
   * Set by `cancel()` if it ran while `persistInFlight === true`. The
   * persist resolution branch reads this to decide which terminal
   * event to emit:
   *   - persist succeeded → `authorized` (IdP approval wins; the
   *     cancel-during-persist race resolves toward the user's
   *     completed browser approval per fold-in 3's C4 reversal).
   *   - persist failed (incl. abort fired by `cancel()`) → `cancelled`
   *     (the cancel got its way; no credentials on disk).
   */
  cancelRequestedDuringPersist?: boolean;
  /**
   * Client id of the SDK caller that invoked `cancel()` (via
   * `DELETE /workspace/auth/device-flow/:id`'s
   * `X-Qwen-Client-Id`). Stamped only on the in-flight
   * persist-defer path so the persist resolution branch's deferred
   * event publish + audit can attribute the cancel back to the
   * actual canceller, not the original initiator. PR #4255 fold-in
   * 9 review thread #5.
   */
  cancellerClientId?: string;
  /**
   * First-writer-wins flag. Set the moment ANY `cancel()` call drives
   * this entry into `cancelRequestedDuringPersist` — including the
   * anonymous case where `cancellerClientId` stays `undefined`. The
   * flag is decoupled from `cancellerClientId` because the latter
   * being `undefined` is BOTH "no canceller has driven the transition
   * yet" AND "an anonymous canceller drove the transition" — using it
   * as the gate would let a later identified canceller silently
   * overwrite an earlier anonymous one. PR #4255 follow-up review
   * (Copilot on #4291): closes the anonymous-first canceller bug.
   */
  cancellerRecorded?: boolean;
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

/**
 * Thrown when `DeviceFlowRegistry.start()` cannot resolve a
 * `DeviceFlowProvider` for the supplied `providerId`.
 *
 * **Reachability:** the route layer (`server.ts`) already screens
 * unknown ids against `DEVICE_FLOW_SUPPORTED_PROVIDERS` and returns
 * `400 invalid_request` BEFORE reaching the registry — so this error
 * is reachable only on a daemon-internal invariant violation:
 * `DEVICE_FLOW_SUPPORTED_PROVIDERS` declares an id but the runtime
 * `resolveProvider` map doesn't carry an implementation for it
 * (e.g. forgot to register a provider for a newly-added id, or a
 * test harness omitted it). The `code` field stays
 * `'unsupported_provider'` for backward-compat with any test that
 * may have asserted on it; the route layer maps to `400` for
 * symmetry with the user-input path even though this branch
 * indicates a programmer error rather than user error. PR #4255
 * fold-in 4 review thread E.
 */
export class UnsupportedDeviceFlowProviderError extends Error {
  readonly code = 'unsupported_provider';
  constructor(providerId: string) {
    super(
      `Unsupported device-flow provider (internal: declared but not registered): ${providerId}`,
    );
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

// PR #4255 review S3: `DeviceFlowNotFoundError` was exported but never
// imported anywhere — the route handlers handle the not-found case
// inline with `res.status(404).json(...)`. Removed to avoid dead-code
// rot. Future routes that prefer typed-error flow can re-introduce it.

export class UpstreamDeviceFlowError extends Error {
  readonly code = 'upstream_error';
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamDeviceFlowError';
  }
}

/**
 * Sentinel error raised by `runPollTick`'s own `Promise.race` timer when
 * `provider.poll()` exceeds `DEVICE_FLOW_POLL_TIMEOUT_MS`. PR #4291
 * follow-up review (qwen-latest): the catch block previously routed
 * this through the same `provider.poll() threw (raw): ...` audit path
 * as a real provider throw, mis-leading on-call into investigating
 * provider code when the actual issue is a hung IdP / network
 * partition. The sentinel lets the catch differentiate the two and
 * emit a timeout-specific audit + hint.
 */
export class DeviceFlowPollTimeoutError extends Error {
  readonly code = 'poll_timeout';
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`device-flow poll timeout after ${timeoutMs}ms`);
    this.name = 'DeviceFlowPollTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Typed accessors for parking the `DeviceFlowRegistry` on
 * `express.Application['locals']`. The string key is shared between
 * `createServeApp` (writer) and `runQwenServe`'s shutdown drain
 * (reader); without typed setter/getter, a typo in either site
 * would compile cleanly and the dispose call would silently no-op,
 * leaving polling timers hanging until process `unref()`-driven
 * exit. PR #4255 fold-in 4 review thread D.
 */
const DEVICE_FLOW_REGISTRY_LOCAL = 'deviceFlowRegistry' as const;

interface DeviceFlowAppLocals {
  [DEVICE_FLOW_REGISTRY_LOCAL]?: DeviceFlowRegistry;
}

export function setDeviceFlowRegistry(
  app: { locals: Record<string, unknown> },
  registry: DeviceFlowRegistry,
): void {
  (app.locals as DeviceFlowAppLocals)[DEVICE_FLOW_REGISTRY_LOCAL] = registry;
}

export function getDeviceFlowRegistry(app: {
  locals: Record<string, unknown>;
}): DeviceFlowRegistry | undefined {
  return (app.locals as DeviceFlowAppLocals)[DEVICE_FLOW_REGISTRY_LOCAL];
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
      this.recordTakeover(existing, params.initiatorClientId);
      return { view: toPublicView(existing), attached: true };
    }
    // Coalesce concurrent fresh starts for the same providerId.
    const inFlight = this.inFlightStarts.get(params.providerId);
    if (inFlight) {
      const result = await inFlight;
      // The first start created an entry; this caller is a take-over of
      // the just-created flow (NOT a fresh IdP request). Recompute the
      // shape so the second caller's `attached: true` is honest. PR
      // #4255 fold-in 6 #6: also stamp the second caller's id on the
      // entry's `lastOriginatorClientId` so audit shows the take-over.
      const justCreated = this.byProvider.get(params.providerId);
      if (justCreated) {
        this.recordTakeover(justCreated, params.initiatorClientId);
      }
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
    // PR #4255 fold-in 3 #2 + fold-in 7 #1: bound `provider.start()`
    // with an authoritative registry-side timeout via `Promise.race`.
    // The earlier shape only ABORTED the signal on timeout — but a
    // provider that ignored the signal (non-abortable I/O, future
    // implementer who forgot to thread `signal` to `fetch`) would
    // leave the `await` hanging forever, pinning the `inFlightStarts`
    // slot until daemon restart. Racing against a rejecting timer
    // makes the timeout authoritative regardless of provider
    // cooperation, while the abort still lets cooperative providers
    // tear down their in-flight `fetch` for cleanup.
    let startResult: DeviceFlowStartResult;
    let startTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      startResult = await new Promise<DeviceFlowStartResult>(
        (resolve, reject) => {
          startTimer = this.schedule(DEVICE_FLOW_START_TIMEOUT_MS, () => {
            try {
              cancelController.abort(new Error('device-flow start timeout'));
            } catch {
              // best-effort
            }
            // PR #4255 fold-in 9 review thread #9: reject with the
            // typed `UpstreamDeviceFlowError` so the route layer
            // maps to `502 upstream_error` (the same envelope every
            // other IdP start failure uses). A hung IdP is a
            // textbook upstream-not-responding scenario from the
            // SDK consumer's POV; surfacing it as a generic 500 via
            // `sendBridgeError`'s default fall-through was
            // misleading.
            reject(
              new UpstreamDeviceFlowError(
                'device-flow start timeout (upstream IdP unresponsive)',
              ),
            );
          });
          provider
            .start({ signal: cancelController.signal })
            .then(resolve, reject);
        },
      );
    } finally {
      if (startTimer !== undefined) this.clearScheduled(startTimer);
    }
    // PR #4255 review S6: dispose() may have run while we awaited
    // `provider.start()`. If we proceed past this point the resulting
    // entry would land in `byId` / `byProvider` AFTER `dispose()`
    // already cleared them, leaving an orphan that has no poll
    // scheduled (because `schedulePoll` guards on `this.disposed`)
    // and never transitions. Bail out — the secrets in `startResult`
    // are inaccessible to the caller (we threw), and the IdP-issued
    // device_code is left to expire upstream on its own clock.
    if (this.disposed) {
      throw new Error('DeviceFlowRegistry disposed during start');
    }
    // PR #4255 fold-in 4 (review thread A): Provider's contract types
    // `expiresIn: number`, but a misbehaving / future provider could
    // hand us `undefined` / `NaN` / `Infinity`. `Math.max(0, NaN) *
    // 1000` is `NaN`; `now() + NaN` is `NaN`; `now >= NaN` is always
    // `false`, so the sweeper would NEVER evict the entry — pinning
    // an upstream `device_code` slot until daemon restart. Reject
    // non-finite-positive values and fall back to RFC 8628's
    // suggested ceiling (10 min) so the entry still expires.
    //
    // PR #4255 fold-in 7 review thread #3: also clamp the upper end
    // — an extreme finite value like `1e12` is finite-and-positive
    // but would pin the singleton for ~30,000 years. Cap at
    // `DEVICE_FLOW_MAX_EXPIRES_IN_SEC` so a malformed/malicious IdP
    // can't tie up a per-provider slot beyond an operator-safe
    // bound.
    // PR #4255 round-12 #5 (Cy_ZF): symmetric upper + lower bounds.
    // The `MAX` clamp defends against `1e12` (year-pinning); the
    // new `MIN` floor defends against `0.5` (entry expires before
    // the first poll fires).
    const expiresInSec =
      Number.isFinite(startResult.expiresIn) && startResult.expiresIn > 0
        ? Math.min(
            DEVICE_FLOW_MAX_EXPIRES_IN_SEC,
            Math.max(DEVICE_FLOW_MIN_EXPIRES_IN_SEC, startResult.expiresIn),
          )
        : 600;
    const expiresAt = this.now() + expiresInSec * 1000;
    // Same defense for `interval`: a non-finite-positive value would
    // schedule a `setTimeout(NaN)` (fires immediately) or
    // `setTimeout(Infinity)` (scheduler clamps to TIMEOUT_MAX). RFC
    // 8628 recommends a 5s default when the IdP omits `interval`.
    // PR #4255 fold-in 7 review thread #3: also clamp upper bound —
    // `interval: 1e12` is finite-and-positive but Node's scheduler
    // would either clamp to TIMEOUT_MAX (≈24.8 d, never fires within
    // the entry's expiresAt) or drop. Cap at
    // `DEVICE_FLOW_MAX_INTERVAL_MS` so the poll fires within a
    // reasonable window regardless of upstream input.
    const intervalSec =
      Number.isFinite(startResult.interval) &&
      (startResult.interval as number) > 0
        ? (startResult.interval as number)
        : DEVICE_FLOW_DEFAULT_INTERVAL_MS / 1000;
    const intervalMs = Math.min(
      DEVICE_FLOW_MAX_INTERVAL_MS,
      Math.max(1_000, intervalSec * 1000),
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
    // PR #4255 fold-in 5 review thread #1: if `provider.persist()` is
    // currently in flight, DEFER the transition + event emission to
    // the persist resolution branch. Aborting the signal still gives
    // `fs.writeFile` a chance to short-circuit; the persist resolution
    // looks at `cancelRequestedDuringPersist` to decide whether to
    // emit `cancelled` (persist aborted in time) or `authorized`
    // (persist committed before the abort fired — IdP wins per
    // fold-in 3 C4). This eliminates the cancelled→authorized event
    // sequence that would have raced onto a listener that already
    // closed its dialog.
    if (entry.persistInFlight) {
      entry.cancelRequestedDuringPersist = true;
      // PR #4255 fold-in 9 review thread #5: stash the canceller's
      // client id on the entry so the persist resolution branch
      // (which actually emits the deferred event) can attribute it
      // to the SDK that asked to cancel, not the original
      // initiator. Without this, the cancellation event's
      // `originatorClientId` was always `entry.initiatorClientId`,
      // which broke any SSE consumer that suppresses self-emitted
      // events to avoid double-handling.
      // PR #4255 follow-up review thread (deepseek-v4-pro): first-writer-
      // wins. Two SDK clients racing `cancel()` on the same persist-in-
      // flight entry must NOT silently overwrite attribution — the second
      // caller's `cancel()` is functionally a no-op (the entry is already
      // marked `cancelRequestedDuringPersist`), so the persist-resolution
      // event should be attributed to whoever actually drove the
      // transition first. Subsequent callers stay in the audit trail
      // through their own `audit.record(...)` line below.
      //
      // PR #4291 follow-up review (Copilot): the gate is `cancellerRecorded`
      // (a separate flag), NOT `cancellerClientId === undefined`. The earlier
      // shape silently broke when the first canceller was anonymous: their
      // `cancel(id, undefined)` left `cancellerClientId` undefined, so the
      // next identified `cancel(id, 'sdk-B')` saw the gate as still open
      // and overwrote the attribution. Decoupling the "have we recorded a
      // canceller" question from the "do we have a clientId" question fixes
      // it: an anonymous first canceller still flips the flag, blocking
      // any later writer.
      if (!entry.cancellerRecorded) {
        entry.cancellerRecorded = true;
        if (cancellerClientId) {
          entry.cancellerClientId = cancellerClientId;
        }
      }
      try {
        entry.cancelController.abort(new Error('cancel during persist'));
      } catch {
        // best-effort
      }
      // Audit the deferred cancel so operators can correlate.
      this.deps.audit?.record({
        deviceFlowId: entry.deviceFlowId,
        providerId: entry.providerId,
        clientId: cancellerClientId,
        status: 'cancelled',
        hint: 'deferred (persist in flight; final state decided by persist resolution)',
      });
      return { alreadyTerminal: false };
    }
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

  /**
   * Active = pending entries already installed in `byProvider` PLUS
   * in-flight starts that haven't yet completed `provider.start()`.
   * Terminal entries in grace don't count toward the cap.
   *
   * PR #4255 round-13 #1 (gpt-5.5 review C1gh0): including
   * `inFlightStarts.size` here closes a workspace-wide cap bypass.
   * Concurrent starts for `DEVICE_FLOW_MAX_CONCURRENT + 1` DISTINCT
   * providers all run to their first await synchronously: each
   * checks the cap before any has populated `byProvider`, and each
   * passes (count = 0). All `MAX+1` then `await provider.start()`,
   * eventually installing more than the documented four pending
   * flows. Adding `inFlightStarts.size` makes the accounting
   * include the not-yet-installed reservations — the second
   * concurrent caller sees `count = 1`, the third `count = 2`, and
   * so on. `byProvider` and `inFlightStarts` are disjoint by
   * construction (the existing-pending-entry fast-path catches any
   * provider with both), so simple addition cannot double-count.
   */
  private countActive(): number {
    let n = 0;
    for (const entry of this.byProvider.values()) {
      if (entry.status === 'pending') n += 1;
    }
    return n + this.inFlightStarts.size;
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
      this.expireEntry(entry);
      return;
    }
    entry.lastPolledAt = now;
    let result: DeviceFlowPollResult;
    let rawProviderError: string | undefined;
    let pollTimedOut = false;
    // PR #4255 follow-up review thread (deepseek-v4-pro): bound
    // `provider.poll()` with the same `Promise.race` shape used by
    // `doStart` / persist. The cooperative `entry.cancelController.signal`
    // path covers well-behaved providers; this race makes the timeout
    // authoritative even when a provider ignores `signal`. A hung IdP
    // token endpoint without this would otherwise block the poll-tick
    // promise indefinitely (occupying the per-provider singleton until
    // sweeper / daemon restart). The rejecting timer aborts the signal
    // first so cooperative providers can still tear down cleanly.
    //
    // PR #4291 follow-up review (qwen-latest, #5): keep a reference to
    // the original `provider.poll()` promise so we can detect a LATE
    // success/error after our race timer already settled the wrapper.
    // Without this, a flaky IdP that responds 1s past the 30s timeout
    // would silently no-op (the second `.then(resolve, ...)` lands on
    // an already-settled outer promise) — operator has no signal that
    // the IdP is in fact responsive (just slow). Symmetric with the
    // `lost_success_after_timeout` audit on the persist path (fold-in
    // 9 #7 of #4255).
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let providerPollPromise: Promise<DeviceFlowPollResult> | undefined;
    try {
      result = await new Promise<DeviceFlowPollResult>((resolve, reject) => {
        pollTimer = this.schedule(DEVICE_FLOW_POLL_TIMEOUT_MS, () => {
          pollTimedOut = true;
          try {
            entry.cancelController.abort(
              new DeviceFlowPollTimeoutError(DEVICE_FLOW_POLL_TIMEOUT_MS),
            );
          } catch {
            // best-effort
          }
          reject(new DeviceFlowPollTimeoutError(DEVICE_FLOW_POLL_TIMEOUT_MS));
        });
        providerPollPromise = provider.poll(
          {
            deviceCode: entry.deviceCode!,
            pkceVerifier: entry.pkceVerifier,
          },
          { signal: entry.cancelController.signal },
        );
        providerPollPromise.then(resolve, reject);
      });
    } catch (err: unknown) {
      // PR #4255 fold-in 9 review thread #1 (refines fold-in 8 #1):
      // a non-conforming provider that violates the `@remarks`
      // sanitization contract by throwing raw IdP detail must NOT
      // leak ANY of that detail to SSE subscribers. fold-in 8
      // truncated to 256 chars but still forwarded the prefix; that
      // prefix can still carry secret material (`device_code` if
      // the provider templated it into the message, internal
      // hostnames, etc.). Use a STATIC bounded hint here as the
      // outermost defense layer; the full raw `err.message` flows
      // through the audit channel (whose backing impl writes to
      // stderr) for operator visibility.
      //
      // PR #4291 follow-up review (qwen-latest, #2): the previous
      // shape routed our own race-timer rejection through the same
      // `provider.poll() threw (raw): ...` audit path as a real
      // provider throw — at 3 AM, on-call would mis-triage as
      // "provider bug" and waste time investigating provider code.
      // Branch on `DeviceFlowPollTimeoutError` to use a dedicated
      // hint + suppress the misleading "raw" audit path.
      if (err instanceof DeviceFlowPollTimeoutError) {
        result = {
          kind: 'error',
          errorKind: 'upstream_error',
          hint: `provider.poll() timed out after ${err.timeoutMs}ms; check IdP connectivity`,
        };
        // rawProviderError stays undefined — the audit branch reads
        // that to decide whether to emit the misleading "threw (raw)"
        // line. Timeout is not a provider throw.
      } else {
        rawProviderError = err instanceof Error ? err.message : String(err);
        result = {
          kind: 'error',
          errorKind: 'upstream_error',
          hint: 'provider.poll() failed; see daemon audit log for details',
        };
      }
    } finally {
      if (pollTimer !== undefined) this.clearScheduled(pollTimer);
    }
    // PR #4291 follow-up review (qwen-latest, #5): if our race timer
    // settled the wrapper as a timeout, attach a passive observer on
    // the original `provider.poll()` promise so a late resolution
    // (IdP eventually responded after the 30s ceiling) leaves an
    // operator audit breadcrumb. Without this, a flaky-but-responsive
    // IdP looks identical to a fully unresponsive one. Mirrors the
    // `lost_success_after_timeout` pattern on the persist path.
    if (pollTimedOut && providerPollPromise !== undefined) {
      const tracked = providerPollPromise;
      // Detached on purpose; the catch on the ORIGINAL promise has
      // already happened (via the wrapper) — the observer below
      // sees the eventual settlement of the same promise. Both
      // success and error branches go through audit only.
      void tracked.then(
        (latePollResult) => {
          this.deps.audit?.record({
            deviceFlowId: entry.deviceFlowId,
            providerId: entry.providerId,
            clientId: entry.initiatorClientId,
            status: 'failed',
            errorKind: 'upstream_error',
            // PR #4291 follow-up review (qwen-latest, N1): the late-
            // poll resolve branch fires when `provider.poll()` returns
            // a result AFTER our race timer settled the wrapper. For a
            // cooperative provider whose abort path resolves to
            // `{kind: 'error', errorKind: 'upstream_error'}` (the Qwen
            // implementation does this in response to AbortError), the
            // "response" is just the abort-cooperation path — the IdP
            // could be completely down. Don't assert "responsive but
            // slow" on the error kind: route operators correctly by
            // distinguishing "real late response" (pending / slow_down /
            // success) from "provider's abort cooperation" (error).
            hint:
              latePollResult.kind === 'error'
                ? `lost_late_poll_after_timeout: provider.poll() resolved kind=error after ${DEVICE_FLOW_POLL_TIMEOUT_MS}ms ceiling — likely abort-driven cooperation; IdP responsiveness unknown`
                : `lost_late_poll_after_timeout: provider.poll() resolved kind=${latePollResult.kind} after ${DEVICE_FLOW_POLL_TIMEOUT_MS}ms ceiling — IdP is responsive but slow; consider raising the operator-side IdP latency alert threshold`,
          });
        },
        (lateErr: unknown) => {
          // Late rejection from the same provider promise. Don't
          // double-audit if the wrapper already saw this same error
          // (we'd be double-counting the same I/O failure).
          if (lateErr instanceof DeviceFlowPollTimeoutError) return;
          const detail =
            lateErr instanceof Error ? lateErr.message : String(lateErr);
          this.deps.audit?.record({
            deviceFlowId: entry.deviceFlowId,
            providerId: entry.providerId,
            clientId: entry.initiatorClientId,
            status: 'failed',
            errorKind: 'upstream_error',
            hint: `lost_late_poll_after_timeout: provider.poll() rejected after ${DEVICE_FLOW_POLL_TIMEOUT_MS}ms ceiling: ${detail.length > 256 ? `${detail.slice(0, 256)}…[+${detail.length - 256} bytes]` : detail}`,
          });
        },
      );
    }
    // PR #4255 round-12 #1 (gpt-5.5 review CzSpN): also re-check
    // `this.disposed` after the await. `dispose()` clears
    // `this.byId` / `this.byProvider` and aborts the entry's
    // signal but doesn't mutate the captured `entry.status` (it
    // wipes secrets but leaves the status field untouched). A
    // provider that already resolved or doesn't honor abort can
    // therefore enter the `success` branch below and call
    // `result.persist({...})` — committing credentials on a
    // shutting-down daemon. Same shape as the disposal guard
    // already present at the top of the method (line 948); this
    // closes the post-await window.
    if (this.disposed) return;
    if (entry.status !== 'pending') return;
    switch (result.kind) {
      case 'pending':
        this.schedulePoll(entry, provider);
        return;
      case 'slow_down':
        // PR #4255 round-12 #4 (Cy_Y9): re-clamp against
        // `DEVICE_FLOW_MAX_INTERVAL_MS`. A misbehaving / malicious
        // IdP that keeps returning `slow_down` would otherwise
        // push `intervalMs` past the documented bound — eventually
        // past Node's `TIMEOUT_MAX` (≈24.8 d) at which point the
        // poll never fires within `expiresAt`. Each bump is only
        // 5 s so reaching `TIMEOUT_MAX` is impractical, but the
        // invariant `intervalMs <= MAX_INTERVAL_MS` is documented
        // as load-bearing in `DEVICE_FLOW_MAX_INTERVAL_MS`'s
        // JSDoc. Symmetric with the doStart clamp.
        entry.intervalMs = Math.min(
          DEVICE_FLOW_MAX_INTERVAL_MS,
          entry.intervalMs + DEVICE_FLOW_SLOW_DOWN_BUMP_MS,
        );
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
        // PR #4255 review C3 + fold-in 5 #1 + fold-in 7 #2: bound
        // persist() with both the entry's cancelController signal
        // AND an authoritative registry-side timeout via
        // `Promise.race`. The earlier shape only ABORTED the signal
        // on timeout — but a provider whose `persist()` performs
        // non-abortable I/O (a future provider that does `mkdir` /
        // `chmod` / `mv` outside the abortable `fs.writeFile`
        // pathway) would leave this `await` hanging until process
        // restart, pinning the flow in `pending` and blocking
        // same-provider starts. Racing against a rejecting timer
        // makes the timeout authoritative regardless of provider
        // cooperation; on rejection we fall through to the error
        // branch which maps to `persist_failed`.
        //
        // Set `entry.persistInFlight` for the duration so `cancel()`
        // and the sweeper SKIP transition+emit during this window —
        // they just register intent (or no-op) and let the persist
        // resolution decide the terminal state.
        let metadata: { expiresAt?: number; accountAlias?: string } = {};
        let persistError: unknown;
        let persistTimer: ReturnType<typeof setTimeout> | undefined;
        let persistTimedOut = false;
        entry.persistInFlight = true;
        // PR #4255 fold-in 9 review thread #7: track the original
        // `result.persist(...)` promise INDEPENDENTLY of the race
        // wrapper so a non-cooperative provider that ignores
        // `signal` can't silently commit credentials AFTER the
        // registry already published `persist_failed`. Reachable
        // scenario: provider's persist runs `mkdir`/`chmod`/`mv`
        // outside the abortable `fs.writeFile` pathway and the
        // disk write succeeds 100 ms after the 30 s timeout fires
        // — daemon now has credentials on disk while every SSE
        // subscriber thinks the login failed.
        //
        // The Qwen provider is signal-honoring (see fold-in 3 #10)
        // so this is forward-defense for future providers. We
        // can't pre-commit-rollback (`fs.unlink` would race with
        // provider-internal state) so the contract stays
        // "provider's persist MUST honor signal"; this tracker
        // catches violations and emits a `lost_success_after_timeout`
        // audit breadcrumb so operators see the inconsistency.
        // PR #4255 round-12 #2 (gpt-5.5 review Cy_ZG): defensively
        // wrap the `result.persist({signal})` call in a try/catch.
        // The persist invocation happens BEFORE the surrounding
        // `new Promise` constructor (the tracker is captured by
        // reference inside the constructor), so a synchronous throw
        // from a non-conforming provider — e.g. a top-of-function
        // validation `if (!signal) throw …` — would NOT be caught
        // by the outer try/catch around `await new Promise(...)`.
        // `runPollTick` is invoked via `void this.runPollTick(...)`
        // so the escaped throw becomes an `unhandledRejection`. The
        // try/catch routes it through the same persistError path
        // that handles a rejected-promise return.
        let persistTracker: Promise<{
          expiresAt?: number;
          accountAlias?: string;
        }>;
        try {
          persistTracker = result.persist({
            signal: entry.cancelController.signal,
          });
        } catch (syncErr) {
          persistError = syncErr;
          persistTracker = Promise.reject(syncErr);
          // Suppress the unhandled-rejection warning on the
          // synthetic rejected promise — we own the recovery via
          // `persistError` and the lost_success branch below
          // explicitly catches its rejection too.
          persistTracker.catch(() => {});
        }
        persistTracker.then(
          (lateMeta) => {
            // Only fire when the race was timed out AND the underlying
            // persist later succeeded — that's the inconsistency
            // window. Happy-path resolution (race accepted the value)
            // leaves `persistTimedOut === false`.
            if (!persistTimedOut) return;
            this.deps.audit?.record({
              deviceFlowId: entry.deviceFlowId,
              providerId: entry.providerId,
              clientId: entry.initiatorClientId,
              status: 'authorized',
              hint: `lost_success_after_timeout (provider.persist ignored timeout signal; credentials on disk but registry already published persist_failed; expiresAt=${lateMeta.expiresAt ?? 'unknown'})`,
            });
          },
          () => {
            // Late rejection after the race already drove the
            // terminal — no-op (persistError carries the original
            // failure, the registry already published it).
          },
        );
        if (persistError === undefined) {
          try {
            metadata = await new Promise<{
              expiresAt?: number;
              accountAlias?: string;
            }>((resolve, reject) => {
              persistTimer = this.schedule(
                DEVICE_FLOW_PERSIST_TIMEOUT_MS,
                () => {
                  persistTimedOut = true;
                  try {
                    entry.cancelController.abort(new Error('persist timeout'));
                  } catch {
                    // best-effort
                  }
                  reject(new Error('persist timeout'));
                },
              );
              persistTracker.then(resolve, reject);
            });
          } catch (err: unknown) {
            persistError = err;
          } finally {
            if (persistTimer !== undefined) this.clearScheduled(persistTimer);
            entry.persistInFlight = false;
          }
        } else {
          // Sync-throw branch: skip the race entirely (we already
          // have persistError) but reset persistInFlight so the
          // sweeper / cancel can resume their normal posture.
          entry.persistInFlight = false;
        }
        if (this.disposed) return;
        const cancelDuringPersist = entry.cancelRequestedDuringPersist === true;
        if (persistError) {
          // Persist failed (abort triggered by cancel/timeout, or a
          // genuine fs error). Two terminal mappings:
          //   1. cancelDuringPersist → `cancelled` (user cancel won)
          //   2. otherwise → `error`/`persist_failed` (genuine disk
          //                  fault — even if now >= expiresAt)
          //
          // PR #4255 fold-in 9 review thread #13: previously a
          // persist-fail × past-`expiresAt` path classified as
          // `expired`/`expired_token`, which routed operator
          // remediation toward "user re-authenticates" (RFC 8628
          // expiry semantic) when the actual root cause was a disk
          // I/O failure. `persist_failed` was specifically designed
          // for this scenario (see DeviceFlowErrorKind JSDoc):
          // distinct from `expired_token` so operators see "fix
          // disk" rather than "tell user to retry." The
          // past-expiresAt detail is preserved on the audit hint
          // for incident-response visibility.
          if (cancelDuringPersist) {
            if (this.transitionTerminal(entry, 'cancelled')) {
              // PR #4255 fold-in 9 review thread #5: emit on the
              // canceller's client id (recorded by `cancel()` on
              // the entry), falling back to the initiator only
              // when no canceller id was supplied. SSE consumers
              // that suppress self-emitted events can now
              // attribute the cancel correctly.
              this.deps.events.publish(
                {
                  type: 'cancelled',
                  data: { deviceFlowId: entry.deviceFlowId },
                },
                entry.cancellerClientId ?? entry.initiatorClientId,
              );
            }
          } else if (
            this.transitionTerminal(entry, 'error', 'persist_failed')
          ) {
            // S1 sanitize: full err detail goes through stderr audit
            // (debugLogger inside cacheQwenCredentials); only a
            // bounded sentence flows to SSE subscribers.
            const pastExpiry = this.now() >= entry.expiresAt;
            this.deps.events.publish(
              {
                type: 'failed',
                data: {
                  deviceFlowId: entry.deviceFlowId,
                  errorKind: 'persist_failed',
                  hint: 'credentials could not be written to the daemon filesystem — check disk space and permissions',
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
              ...(pastExpiry
                ? {
                    hint: 'persist_also_failed_past_expiry (root cause is disk I/O; entry was past expiresAt by the time persist resolved)',
                  }
                : {}),
            });
          }
          return;
        }
        // Persist succeeded. Per fold-in 3 C4 (and fold-in 5 #1
        // refinement): IdP approval wins. Whether or not cancel was
        // requested during persist, the disk write committed —
        // honor it.
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
            ...(cancelDuringPersist
              ? {
                  hint: 'lost_success_kept (cancel during persist; credentials kept per IdP approval)',
                }
              : {}),
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
            // PR #4255 fold-in 8 #1: when the catch above fired (a
            // misbehaving provider threw), include the FULL raw
            // err.message in the audit hint so operators can debug
            // the contract violation. The SSE-broadcast hint stays
            // truncated to DEVICE_FLOW_POLL_HINT_MAX_LEN.
            ...(rawProviderError !== undefined
              ? {
                  hint: `provider.poll() threw (raw): ${rawProviderError}`,
                }
              : {}),
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
   * Record a take-over: a second SDK client posted
   * `POST /workspace/auth/device-flow` for a provider that already has
   * a pending entry (or one being created in `inFlightStarts`). When
   * the second caller's `initiatorClientId` differs from the entry's,
   * stamp it on `entry.lastOriginatorClientId` and emit an audit
   * breadcrumb. No event publish — the per-provider singleton's
   * `started` event was already broadcast workspace-wide, and emitting
   * a second `started` would confuse SDK reducers (the `attached:
   * true` HTTP response is the second caller's signal). PR #4255
   * fold-in 6 review thread #6.
   */
  private recordTakeover(
    entry: DeviceFlowEntry,
    takeoverClientId: string | undefined,
  ): void {
    if (!takeoverClientId) return;
    if (takeoverClientId === entry.initiatorClientId) return;
    if (takeoverClientId === entry.lastOriginatorClientId) return;
    entry.lastOriginatorClientId = takeoverClientId;
    this.deps.audit?.record({
      deviceFlowId: entry.deviceFlowId,
      providerId: entry.providerId,
      clientId: takeoverClientId,
      status: 'started',
      hint: `take-over (per-provider singleton; original initiator=${entry.initiatorClientId ?? '(none)'})`,
    });
  }

  /**
   * Drive a pending entry to the time-based `expired` terminal:
   * `transitionTerminal` + emit `failed`/`expired_token` event +
   * audit. PR #4255 fold-in 9 review thread #3: extracted from
   * the two identical sites (poll-tick top-of-loop + sweeper) so
   * the event shape lives in one place. No-op if the entry has
   * already transitioned (the transitionTerminal idempotence guard
   * handles the sweeper × poll-tick race).
   */
  private expireEntry(entry: DeviceFlowEntry): void {
    if (!this.transitionTerminal(entry, 'expired', 'expired_token')) return;
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
      // PR #4255 fold-in 5 review thread #1: skip entries with persist
      // in flight — the persist resolution branch will handle the
      // terminal transition + audit (and emit `expired` if the entry
      // was past `expiresAt` when persist failed). Sweeping here would
      // create the same `expired` → `authorized` event-stream UX trap
      // that the cancel-during-persist case avoids.
      if (entry.persistInFlight) continue;
      if (entry.status === 'pending' && now >= entry.expiresAt) {
        this.expireEntry(entry);
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
