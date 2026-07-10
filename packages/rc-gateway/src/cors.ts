/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Browser CORS allowlist derived from pairing.
 *
 * Ported from the donor remoteControl/cors.ts.  This module is pure and
 * framework-agnostic — it operates on plain header maps and never imports an
 * HTTP framework.  The gateway supplies the distinct `origin` values recorded
 * in the token store (populated from the `Origin` header at redemption time)
 * plus any owner-configured overrides.
 *
 * Security invariants:
 *   - Origin matching is EXACT string match (scheme+host+port).  No substring,
 *     prefix, or suffix matching.
 *   - We NEVER emit `Access-Control-Allow-Origin: *` together with
 *     `Access-Control-Allow-Credentials: true`.  When credentials are allowed
 *     the reflected origin MUST be the concrete allowlisted origin.
 */

import type { CorsOriginRecord } from './types.js';

/** Marker string the caller writes into a structured `cors_denied` audit event. */
export type CorsAuditSignal = 'cors_denied';

/** Default methods advertised on a preflight when the gateway does not narrow them. */
const DEFAULT_ALLOW_METHODS = ['GET', 'POST', 'DELETE', 'OPTIONS'] as const;

/**
 * Default request headers echoed when the browser does not send
 * `Access-Control-Request-Headers`.  `Authorization` is always included
 * because tokens transit only in the Authorization header.
 */
const DEFAULT_ALLOW_HEADERS = [
  'Authorization',
  'Content-Type',
  'X-RC-Version',
  'Last-Event-ID',
] as const;

/** Preflight cache lifetime advertised via `Access-Control-Max-Age` (seconds). */
const DEFAULT_MAX_AGE_SEC = 600;

/** A plain, framework-agnostic header map. */
export type HeaderMap = Record<string, string>;

/** Minimal shape of an incoming (pre)request the evaluator needs. */
export interface CorsRequest {
  /** HTTP method of the incoming request (e.g. `OPTIONS` for a preflight). */
  method: string;
  /** Value of the `Origin` request header, if present. */
  origin?: string;
  /** Value of `Access-Control-Request-Method` (preflight only). */
  requestMethod?: string;
  /** Value of `Access-Control-Request-Headers` (preflight only). */
  requestHeaders?: string;
}

/** Result of evaluating a CORS preflight. */
export type CorsDecision =
  | {
      allowed: true;
      denied?: false;
      /** Headers to set on the preflight (204) response. */
      headers: HeaderMap;
    }
  | {
      allowed: false;
      denied: true;
      /** No `Access-Control-Allow-Origin` is ever set on a denial. */
      headers: HeaderMap;
      /** Caller writes a structured audit event keyed off this marker. */
      auditSignal: CorsAuditSignal;
      /** The origin that was rejected (may be `null` when absent). */
      origin: string | null;
    };

/** Result of computing CORS headers for a non-preflight (actual) request. */
export interface ActualRequestCors {
  /** Headers to merge onto the actual response.  Empty when origin not allowed. */
  headers: HeaderMap;
  /** True when the origin was not on the allowlist. */
  denied: boolean;
  /** Set only when denied, so the caller can emit a `cors_denied` audit event. */
  auditSignal?: CorsAuditSignal;
  /** The origin that was rejected (may be `null` when absent). */
  origin?: string | null;
}

/**
 * Allowlist of browser origins permitted to make credentialed CORS requests.
 *
 * The effective set is the union of:
 *   - paired origins (distinct `origin` values from the token store), and
 *   - manual owner overrides (`add`/`remove`).
 */
export class CorsAllowlist {
  /** Origins discovered from the token store. */
  private paired = new Set<string>();
  /** Owner-configured manual additions. */
  private overrides = new Set<string>();
  /** Memoized union of `paired` ∪ `overrides`.  Rebuilt on mutation. */
  private effective = new Set<string>();

  /**
   * @param initialOrigins distinct paired `origin` values from the token store.
   * @param overrideOrigins optional owner-configured origins (in-memory only).
   */
  constructor(
    initialOrigins: Iterable<string> = [],
    overrideOrigins: Iterable<string> = [],
  ) {
    for (const o of initialOrigins) {
      const n = normalizeOrigin(o);
      if (n) this.paired.add(n);
    }
    for (const o of overrideOrigins) {
      const n = normalizeOrigin(o);
      if (n) this.overrides.add(n);
    }
    this.recompute();
  }

  /**
   * Exact-match check against the effective allowlist.  A missing or empty
   * origin is never allowed.  No substring/suffix matching is performed.
   */
  isAllowed(origin: string | undefined | null): boolean {
    const n = normalizeOrigin(origin);
    if (!n) return false;
    return this.effective.has(n);
  }

  /** Owner override: add an origin to the allowlist.  Returns the allowlist. */
  add(origin: string): this {
    const n = normalizeOrigin(origin);
    if (n) {
      this.overrides.add(n);
      this.recompute();
    }
    return this;
  }

  /**
   * Owner override: remove an origin.  This removes it from BOTH the manual
   * overrides and the paired set so that an owner-issued removal denies the
   * origin until the next `setPairedOrigins` refresh re-derives it.
   */
  remove(origin: string): this {
    const n = normalizeOrigin(origin);
    if (n) {
      this.overrides.delete(n);
      this.paired.delete(n);
      this.recompute();
    }
    return this;
  }

  /**
   * Refresh the paired-origin set from the token store and recompute the union
   * with the manual overrides.  Manual overrides are preserved across refresh.
   */
  setPairedOrigins(origins: Iterable<string>): this {
    const next = new Set<string>();
    for (const o of origins) {
      const n = normalizeOrigin(o);
      if (n) next.add(n);
    }
    this.paired = next;
    this.recompute();
    return this;
  }

  /** Snapshot of the current effective allowlist. */
  origins(): string[] {
    return [...this.effective];
  }

  private recompute(): void {
    const union = new Set<string>(this.paired);
    for (const o of this.overrides) union.add(o);
    this.effective = union;
  }
}

/**
 * Normalize a candidate origin to a comparable, exact-match key.  We trim
 * surrounding whitespace and reject `null`/empty/`"null"` (the opaque-origin
 * sentinel some browsers send).
 */
function normalizeOrigin(origin: string | undefined | null): string | null {
  if (origin == null) return null;
  const trimmed = origin.trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === '*') return null;
  return trimmed;
}

/**
 * Build the `Access-Control-Allow-Headers` value for a preflight: echo the
 * browser's requested headers when present, otherwise advertise a sane default.
 */
function allowHeadersValue(requestHeaders?: string): string {
  const requested = requestHeaders?.trim();
  if (requested) return requested;
  return DEFAULT_ALLOW_HEADERS.join(', ');
}

// ---------------------------------------------------------------------------
// Origin admission at pairing redemption
// ---------------------------------------------------------------------------

/**
 * Is `origin` a syntactically valid RFC 6454 origin (`scheme://host[:port]`,
 * serialized form — no path, userinfo, query, fragment, or trailing slash)
 * whose scheme is admissible?  The scheme must be `https` (any host), or
 * `http` only when the origin's host is loopback (`127.0.0.0/8`, `::1`, or
 * `localhost`).
 */
export function isValidAdmissibleOrigin(origin: string): boolean {
  if (typeof origin !== 'string' || origin === '') return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  // A serialized RFC 6454 origin is exactly `scheme://host[:port]`.  Anything
  // extra (path, trailing slash, userinfo, query, fragment, whitespace,
  // non-canonical casing) makes the round-trip fail.
  if (url.origin !== origin) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return isLoopbackHost(url.hostname);
  return false;
}

/**
 * True when `hostname` is loopback: `127.0.0.0/8`, `::1`, or `localhost`.
 * Subdomains of localhost are deliberately NOT loopback.
 */
function isLoopbackHost(hostname: string): boolean {
  const host =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
  if (host === 'localhost' || host === '::1') return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  return m.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * Does the `Sec-Fetch-Site` request header permit recording the Origin at
 * redemption?  `same-origin`, `none`, or an absent header (non-browser client)
 * allow recording; `same-site`, `cross-site`, or anything else MUST NOT have
 * the Origin recorded — a sibling subdomain must not self-admit.
 */
export function secFetchSiteAllowsRecording(
  header: string | undefined,
): boolean {
  if (header === undefined) return true;
  return header === 'same-origin' || header === 'none';
}

/**
 * The gateway's own UI origin: the origin of the configured external base URL
 * (`externalUrl`, set when behind a TLS-terminating proxy), or, absent that,
 * the scheme/host/port the gateway's HTTP listener serves the web UI on.
 */
export function resolveOwnUiOrigin(opts: {
  externalUrl?: string;
  listenScheme: string;
  listenHost: string;
  listenPort: number;
}): string {
  if (opts.externalUrl) return new URL(opts.externalUrl).origin;
  const host =
    opts.listenHost.includes(':') && !opts.listenHost.startsWith('[')
      ? `[${opts.listenHost}]`
      : opts.listenHost;
  return new URL(`${opts.listenScheme}://${host}:${opts.listenPort}`).origin;
}

/**
 * Why an origin admission was (or was not) recorded.  `admitted` is the only
 * admitting value; the others name the first failed condition of the gate.
 */
export type AdmissionReason =
  | 'admitted'
  | 'missing_origin'
  | 'invalid_origin'
  | 'origin_not_permitted'
  | 'sec_fetch_site_blocked';

/** Outcome of the three-condition admission gate. */
export interface AdmissionDecision {
  admit: boolean;
  reason: AdmissionReason;
}

/**
 * The three-condition admission gate: the gateway records an Origin into the
 * allowlist at `POST /rc/pair/redeem` only when ALL of the following hold:
 *
 *  1. the `Origin` header is a syntactically valid RFC 6454 origin whose
 *     scheme is `https`, or `http` only for loopback hosts;
 *  2. the redeemed pairing code was minted with `allowOrigin: true`, OR the
 *     origin exactly matches the gateway's own UI origin;
 *  3. `Sec-Fetch-Site` is `same-origin`, `none`, or absent.
 *
 * Failing the gate never fails the redemption itself — the caller still
 * issues the token; it merely skips recording the origin.
 */
export function evaluateAdmission(input: {
  origin: string | undefined;
  secFetchSite: string | undefined;
  codeAllowOrigin: boolean;
  ownUiOrigin: string;
}): AdmissionDecision {
  if (input.origin === undefined || input.origin === '') {
    return { admit: false, reason: 'missing_origin' };
  }
  if (!isValidAdmissibleOrigin(input.origin)) {
    return { admit: false, reason: 'invalid_origin' };
  }
  if (!input.codeAllowOrigin && input.origin !== input.ownUiOrigin) {
    return { admit: false, reason: 'origin_not_permitted' };
  }
  if (!secFetchSiteAllowsRecording(input.secFetchSite)) {
    return { admit: false, reason: 'sec_fetch_site_blocked' };
  }
  return { admit: true, reason: 'admitted' };
}

/**
 * Build the preflight allowlist from origin records — both persisted
 * (`source: 'db'`) and config-sourced (`source: 'config'`) are honored equally.
 */
export function allowlistFromRecords(
  records: readonly CorsOriginRecord[],
): CorsAllowlist {
  return new CorsAllowlist(records.map((r) => r.origin));
}

/**
 * Evaluate a CORS preflight (`OPTIONS` with `Origin` + `Access-Control-Request-*`).
 *
 * Allowed → returns the headers to set on the 204 response, reflecting the
 * concrete origin alongside `Access-Control-Allow-Credentials: true`.
 *
 * Denied → returns NO `Access-Control-Allow-Origin`, `denied: true`, and a
 * `auditSignal: 'cors_denied'` marker so the caller can write the audit event.
 */
export function evaluatePreflight(
  req: CorsRequest,
  allowlist: CorsAllowlist,
): CorsDecision {
  const origin = normalizeOrigin(req.origin);

  if (!origin || !allowlist.isAllowed(origin)) {
    return {
      allowed: false,
      denied: true,
      headers: {},
      auditSignal: 'cors_denied',
      origin: origin ?? null,
    };
  }

  // Credentialed CORS: reflect the concrete origin.  Never `*` with credentials.
  const headers: HeaderMap = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': DEFAULT_ALLOW_METHODS.join(', '),
    'Access-Control-Allow-Headers': allowHeadersValue(req.requestHeaders),
    'Access-Control-Max-Age': String(DEFAULT_MAX_AGE_SEC),
    Vary: 'Origin',
  };

  return { allowed: true, headers };
}

/**
 * Compute CORS headers for a non-preflight (actual) request.
 *
 * Allowed origin → `{ Access-Control-Allow-Origin: <origin>,
 * Access-Control-Allow-Credentials: 'true', Vary: 'Origin' }`.
 * Otherwise → empty headers plus a deny signal.
 */
export function corsHeadersForActualRequest(
  origin: string | undefined | null,
  allowlist: CorsAllowlist,
): ActualRequestCors {
  const n = normalizeOrigin(origin);

  if (!n || !allowlist.isAllowed(n)) {
    return {
      headers: {},
      denied: true,
      auditSignal: 'cors_denied',
      origin: n ?? null,
    };
  }

  return {
    headers: {
      'Access-Control-Allow-Origin': n,
      'Access-Control-Allow-Credentials': 'true',
      Vary: 'Origin',
    },
    denied: false,
  };
}
