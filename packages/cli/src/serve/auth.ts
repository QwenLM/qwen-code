/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { isLoopbackBind } from './loopback-binds.js';

/**
 * Reject any request that carries an `Origin` header. CLI/SDK clients never
 * set Origin; only browsers do. Returning a deterministic 403 JSON keeps
 * the daemon from CSRF-ing itself (and is more useful to clients than the
 * 500 HTML default that the `cors` package's error-callback path produces
 * when no Express error middleware is registered). `Vary: Origin` keeps
 * intermediary caches from mixing browser and CLI/SDK responses.
 */
export const denyBrowserOriginCors: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (req.headers.origin) {
    res.setHeader('Vary', 'Origin');
    res.status(403).json({ error: 'Request denied by CORS policy' });
    return;
  }
  next();
};

/**
 * Parsed shape of `--allow-origin <pattern>...`. The
 * literal `*` collapses into a single boolean flag; explicit origin
 * strings live in a Set keyed by the lowercased origin (RFC 6454 §4
 * scheme/host case-insensitivity, port-sensitive).
 */
export interface ParsedAllowOriginPatterns {
  allowAny: boolean;
  origins: Set<string>;
}

/**
 * Thrown by `parseAllowOriginPatterns` when an entry
 * is neither the `*` literal nor a value that round-trips through
 * `new URL(...).origin`. Caught at boot in `runQwenServe` and converted
 * to a structured stderr message identifying the malformed entry.
 *
 * Rejection is strict by intent: trailing slashes, paths, userinfo, and
 * query strings all fail the equality check. Auto-normalizing would
 * silently accept ambiguous input — operators are better served by an
 * explicit "fix your config" than a silent accept-and-rewrite.
 */
export class InvalidAllowOriginPatternError extends Error {
  readonly pattern: string;
  constructor(pattern: string, reason: string) {
    super(
      `Invalid --allow-origin pattern ${JSON.stringify(pattern)}: ${reason}. ` +
        'Expected `*` or a URL origin of the form `<scheme>://<host>[:<port>]` ' +
        '(no trailing slash, no path, no userinfo, no query).',
    );
    this.name = 'InvalidAllowOriginPatternError';
    this.pattern = pattern;
  }
}

/**
 * Validate the raw `--allow-origin` arg list and fold
 * it into the lookup-friendly `ParsedAllowOriginPatterns` shape. Throws
 * `InvalidAllowOriginPatternError` on the first malformed entry so the
 * operator sees the exact value to fix.
 *
 * Entries are matched origin-style (scheme + host + port). Scheme/host
 * lowercase per RFC 6454 §4; port stays exact (origins don't carry a
 * path, so there's nothing to canonicalize past `.origin`).
 */
export function parseAllowOriginPatterns(
  raw: readonly string[],
): ParsedAllowOriginPatterns {
  const origins = new Set<string>();
  let allowAny = false;
  for (const entry of raw) {
    if (entry === '*') {
      allowAny = true;
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      throw new InvalidAllowOriginPatternError(entry, 'not a parseable URL');
    }
    if (parsed.origin !== entry) {
      throw new InvalidAllowOriginPatternError(
        entry,
        `expected the canonical origin ${JSON.stringify(parsed.origin)} ` +
          'without trailing slash, path, userinfo, or query',
      );
    }
    origins.add(parsed.origin.toLowerCase());
  }
  return { allowAny, origins };
}

/**
 * Build the CORS allowlist middleware. Replaces
 * `denyBrowserOriginCors` when `--allow-origin` is configured — owns both
 * halves of the policy (match → allow with CORS headers, unmatched →
 * 403). When no `Origin` header is present (CLI/SDK clients), passes
 * through with no work.
 *
 * Mirrors the `denyBrowserOriginCors` 403 body verbatim so existing
 * clients that parsed the wall's response don't have to special-case the
 * allowlist deployment shape.
 *
 * OPTIONS preflight short-circuits with 204 when the browser includes a
 * preflight request header. Plain OPTIONS requests keep flowing downstream
 * with CORS headers attached.
 *
 * `Access-Control-Allow-Credentials` is intentionally NOT set: the
 * daemon's auth model is bearer-token-in-`Authorization`, which works
 * cross-origin without `credentials: 'include'`. Adding credentials
 * would require a separate flag plus a "no `*` allowed" boot check
 * (CORS spec forbids `*` with credentials).
 */
export function allowOriginCors(
  patterns: ParsedAllowOriginPatterns,
): RequestHandler {
  const allowedMethods = 'GET, POST, PATCH, DELETE, OPTIONS';
  const allowedHeaders =
    'Authorization, Content-Type, X-Qwen-Client-Id, Last-Event-ID';
  const maxAgeSeconds = '86400';
  const exposedHeaders = 'Retry-After';
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (!origin) {
      next();
      return;
    }
    // `Origin: null` is sent by sandboxed iframes, file:// documents,
    // data: URLs, and cross-origin redirects. Echoing it under `*`
    // would let any attacker page mint a sandboxed iframe to read API
    // responses without holding the bearer locally. The CORS spec
    // doesn't forbid `null` echoes but the threat surface is non-
    // obvious. Operators who genuinely need null origins (a rare set
    // — typically only debugging file:// HTML) can ask for an opt-in
    // flag if/when that materializes.
    if (origin === 'null') {
      res.setHeader('Vary', 'Origin');
      res.status(403).json({ error: 'Request denied by CORS policy' });
      return;
    }
    const matched =
      patterns.allowAny || patterns.origins.has(origin.toLowerCase());
    if (matched) {
      // Echo the request's origin verbatim (not literal `*`) even under
      // the any-origin pattern. Browser caches use the echo paired with
      // `Vary: Origin` as the response key, and echoing leaves room to
      // add `Access-Control-Allow-Credentials` in a future flag without
      // a schema change (the CORS spec forbids `*` with credentials).
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', allowedMethods);
      res.setHeader('Access-Control-Allow-Headers', allowedHeaders);
      res.setHeader('Access-Control-Max-Age', maxAgeSeconds);
      res.setHeader('Access-Control-Expose-Headers', exposedHeaders);
      if (
        req.method === 'OPTIONS' &&
        (req.headers['access-control-request-method'] ||
          req.headers['access-control-request-headers'])
      ) {
        res.status(204).end();
        return;
      }
      next();
      return;
    }
    // `Vary: Origin` on the reject path too — the daemon now returns
    // different status codes for the same URL depending on Origin, and
    // an intermediary cache (corporate proxy, CDN) without origin
    // awareness could otherwise serve a stale 403 to a different
    // origin. The match path sets the same header for symmetry.
    res.setHeader('Vary', 'Origin');
    res.status(403).json({ error: 'Request denied by CORS policy' });
  };
}

/**
 * Reject requests whose Host header isn't one of the bound interfaces.
 * Defense against DNS rebinding when the daemon is on loopback.
 *
 * `bind` is the hostname the listener was started with. `getPort` is read
 * lazily on each request because callers commonly request port 0 (ephemeral)
 * and only learn the actual port once `listen()` has resolved.
 */
export function hostAllowlist(
  bind: string,
  getPort: () => number,
): RequestHandler {
  if (!isLoopbackBind(bind)) {
    // For non-loopback binds the operator chose the surface area; trust the
    // bearer token gate to cover Host header spoofing.
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }
  // Cache the allowed-Host Set per port. `getPort()` is invoked
  // lazily because tests bind to ephemeral port 0 — the actual port
  // is only known after `listen()` resolves and tests can call
  // through with a placeholder port that flips later. SSE
  // heartbeats and high-frequency probes go through this middleware,
  // so allocating a fresh Set + 4 interpolated strings per request
  // is wasted work. Rebuild only when the port changes.
  let cachedPort = -1;
  let cachedAllowed: Set<string> = new Set();
  const allowedFor = (port: number): Set<string> => {
    if (port === cachedPort) return cachedAllowed;
    cachedPort = port;
    cachedAllowed = new Set([
      `localhost:${port}`,
      `127.0.0.1:${port}`,
      `[::1]:${port}`,
      `host.docker.internal:${port}`,
    ]);
    // RFC 7230 §5.4: clients may omit the port suffix when it matches
    // the URI scheme's default. http → 80, https → 443. The qwen
    // serve daemon is plain HTTP, so accept the no-port forms when
    // we're listening on port 80 (uncommon but valid for an operator
    // who points at a privileged port for clean URLs).
    if (port === 80) {
      cachedAllowed.add('localhost');
      cachedAllowed.add('127.0.0.1');
      cachedAllowed.add('[::1]');
      cachedAllowed.add('host.docker.internal');
    }
    return cachedAllowed;
  };
  return (req: Request, res: Response, next: NextFunction) => {
    const port = getPort();
    // Per RFC 7230 §5.4, Host is case-insensitive. Express normalizes
    // header *names* to lowercase but NOT values, so a Docker-proxy
    // that capitalizes the hostname (`Host: Localhost:4170`) or a
    // platform with case-preserving DNS (`HOST.docker.internal`) would
    // get 403 with an exact-string compare. Lowercase both sides.
    const host = (req.headers.host || '').toLowerCase();
    if (!allowedFor(port).has(host)) {
      res.status(403).json({ error: 'Invalid Host header' });
      return;
    }
    next();
  };
}

/**
 * Bearer token middleware. When `token` is undefined the gate is open — used
 * for the loopback-only developer default. `runQwenServe` enforces that any
 * non-loopback bind has a token, and that `--require-auth` boots only with a
 * token configured, so this no-token branch is reachable only on loopback
 * developer setups that opted out of `--require-auth`.
 */
export function bearerAuth(token: string | undefined): RequestHandler {
  if (!token) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }
  // Pre-hash the configured token once. Per-request we hash the candidate and
  // constant-time compare; this avoids leaking byte positions through string
  // inequality short-circuiting.
  const expected = createHash('sha256').update(token, 'utf8').digest();
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    // Per RFC 7235 §2.1 / RFC 7230 §3.2.6 the auth scheme token is
    // case-insensitive — `Bearer` / `bearer` / `BEARER` are all valid.
    // Lowercase the scheme before comparing; the token value itself
    // stays case-sensitive (it's user-defined opaque material).
    //
    // Hand-rolled split rather than a regex like `^(\S+)\s+(.+)$`
    // because CodeQL flags the latter as a polynomial-regex risk on
    // user-controlled input (the `\s+` / `.+` overlap can backtrack
    // on adversarial whitespace-heavy headers). Two indexOf calls
    // are O(n) total with no backtracking.
    const schemeEnd = header.indexOf(' ');
    if (schemeEnd <= 0) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const scheme = header.slice(0, schemeEnd).toLowerCase();
    if (scheme !== 'bearer') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    // After the initial SP separator (the scheme→credentials boundary
    // matches RFC 9110 §11.6.2's `1*SP`), skip any extra BWS before
    // the credentials. RFC 7230 §3.2.6 BWS allows both SP (0x20)
    // and HTAB (0x09); accept both so a client emitting
    // `Authorization: Bearer \t<token>` (SP then HTAB) doesn't 401.
    // Pure-HTAB-as-separator (`Bearer\t<token>`) is still rejected
    // because the scheme parse uses `indexOf(' ')` — that's
    // intentional per RFC 9110, not an oversight.
    let credStart = schemeEnd + 1;
    while (
      credStart < header.length &&
      (header.charCodeAt(credStart) === 0x20 ||
        header.charCodeAt(credStart) === 0x09)
    ) {
      credStart++;
    }
    const credentials = header.slice(credStart);
    if (credentials.length === 0) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const candidate = createHash('sha256').update(credentials, 'utf8').digest();
    if (!timingSafeEqual(candidate, expected)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}

/**
 * Per-route mutation gate.
 *
 * A single mutation-gating helper so all state-changing routes share one
 * choke point. Routes opt into `strict: true` to enforce
 * "token required even on loopback" without depending on the operator
 * also passing `--require-auth`.
 *
 * Behavior matrix:
 *
 * | daemon config              | route opts        | result          |
 * | -------------------------- | ----------------- | --------------- |
 * | requireAuth=true           | any               | passthrough (1) |
 * | token configured           | any               | passthrough (2) |
 * | no token (loopback dev)    | strict=false      | passthrough     |
 * | no token (loopback dev)    | strict=true       | 401 + code      |
 *
 * (1) `--require-auth` boots only with a token, so the global
 *     `bearerAuth` middleware already 401'd unauthenticated requests
 *     before they reached this gate.
 * (2) Any token configuration makes the global `bearerAuth` enforce
 *     bearer-required-everywhere; the gate is redundant but harmless.
 *
 * The 401 body uses `code: 'token_required'` (distinct from
 * `bearerAuth`'s plain `Unauthorized` shape) so SDK clients can branch
 * on it: surface a "this route needs the daemon to be configured with
 * a token; restart with --require-auth or --token" hint rather than a
 * generic auth failure. Pre-flight via `/capabilities.features.require_auth`
 * still requires a successful unauthenticated `/capabilities` call,
 * which is only possible when the daemon has not enforced auth — so
 * the gate's own 401 is the discovery surface for routes that opt in
 * to strict mode on otherwise-open daemons.
 */
export interface MutationGateOptions {
  /**
   * When true, this route refuses to serve unauthenticated callers
   * even on loopback no-token defaults. Used by mutation routes
   * (memory, file edit, tool enable, MCP restart, device-flow auth)
   * that should never be reachable without explicit operator opt-in.
   * Defaults to false so existing routes can adopt the helper without
   * behavior change.
   */
  strict?: boolean;
}

export interface CreateMutationGateDeps {
  /** Was the daemon configured with a bearer token? */
  tokenConfigured: boolean;
  /** Was `--require-auth` passed at boot? */
  requireAuth: boolean;
}

/**
 * Build a route-scoped mutation gate factory. Returns a function that
 * — given `MutationGateOptions` — yields an Express `RequestHandler`.
 *
 * Callers cache the factory at app construction time and invoke it per
 * route, e.g.:
 *
 *   const mutate = createMutationGate({ tokenConfigured, requireAuth });
 *   app.post('/workspace/memory', mutate({ strict: true }), handler);
 *   app.post('/session', mutate(), handler);
 *
 * The factory is hot-path-friendly: the strict-passthrough decision is
 * made once at construction and the returned handler is a cheap closure.
 */
export function createMutationGate(
  deps: CreateMutationGateDeps,
): (opts?: MutationGateOptions) => RequestHandler {
  // When the global gate is already enforcing bearer auth (token set
  // via --token / env, OR --require-auth boot-checked a token), every
  // request that reaches the route handler has already passed
  // `bearerAuth`. The mutation gate becomes a passthrough — return a
  // pre-built no-op so we don't allocate one closure per route call.
  const passthrough: RequestHandler = (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next();
  if (deps.requireAuth || deps.tokenConfigured) {
    return () => passthrough;
  }
  // No token configured (loopback developer default). Non-strict
  // routes preserve the legacy "open on loopback" behavior; strict
  // routes refuse with a structured 401 the SDK can surface.
  //
  // Body-parser ordering: the strict 401
  // fires AFTER `express.json()` because the gate is per-route
  // middleware, not app-level. On no-token loopback defaults a strict
  // route therefore parses the request body before refusing it —
  // bounded by `express.json({limit: '10mb'})` × `--max-connections`
  // (256 default). Loopback-only attack surface, so the worst case is
  // ~2.5 GB transient on a fully-saturated listener. The strict routes
  // Wave 4 actually adds (memory writes / file edits / device-flow
  // auth) carry small bodies in legitimate use, so the parsing-cost
  // amplification isn't a production hot path. If a future strict
  // route accepts large bodies, lift its gate to app-level (maintain a
  // strict-path Set in `createServeApp` and check it before
  // `express.json()`); tracked as a Wave 4 follow-up rather than
  // re-architecting the helper here.
  //
  // Allocation symmetry: cache the strict
  // denier alongside `passthrough` so a route table with N strict
  // routes doesn't allocate N identical closures. The auth.test.ts
  // identity assertion anchors this — a future change that loses the
  // cache is visible.
  const strictDenier: RequestHandler = (_req: Request, res: Response) => {
    // Only list remediations that work standalone. `--require-auth` is
    // paired-required-with-a-token at boot (`run-qwen-serve.ts` refuses
    // to start with the flag set but no token), so naming it as a
    // third standalone option here would loop the operator into a
    // different boot error. Configuring a token via `QWEN_SERVER_TOKEN`
    // or `--token` IS the fix; the operator can decide separately
    // whether to also harden loopback with `--require-auth`.
    res.status(401).json({
      error:
        'This route requires the daemon to be configured with a bearer ' +
        'token. Set QWEN_SERVER_TOKEN or pass --token to enable bearer ' +
        'auth.',
      code: 'token_required',
    });
  };
  return (opts: MutationGateOptions = {}): RequestHandler =>
    opts.strict ? strictDenier : passthrough;
}
